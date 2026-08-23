#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static int _baton_swizzle_attempts = 0;
static int _baton_cancel_swizzle_attempts = 0;
static char _baton_skeleton_installed_key;
static char _baton_skeleton_controller_key;
static char _baton_safe_area_script_installed_key;

// Find the barcode-scanner Swift class. Its runtime name is mangled with the module
// prefix (e.g. "tauri_plugin_barcode_scanner.BarcodeScannerPlugin"), so iterate the
// runtime class list to locate it by suffix.
static Class baton_find_class_by_suffix(const char *suffix) {
    int count = objc_getClassList(NULL, 0);
    if (count <= 0) return NULL;
    Class *classes = (Class *)malloc(sizeof(Class) * count);
    objc_getClassList(classes, count);
    Class found = NULL;
    for (int i = 0; i < count; i++) {
        const char *name = class_getName(classes[i]);
        if (name && strstr(name, suffix)) { found = classes[i]; break; }
    }
    free(classes);
    return found;
}

// Plugin's cancel(_:) is called from a background dispatch queue (Tauri IPC) but
// internally calls UIView.removeFromSuperview, which requires the main thread.
// On iOS 17+, UIKit asserts on this and crashes (NSAssertion / SIGABRT).
// Fix by swizzling cancel(_:) to dispatch to main thread first.
static void baton_install_scanner_cancel_swizzle(void) {
    Class plugin = baton_find_class_by_suffix("BarcodeScannerPlugin");
    if (!plugin) {
        if (_baton_cancel_swizzle_attempts++ < 30) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ baton_install_scanner_cancel_swizzle(); });
        }
        return;
    }
    SEL sel = @selector(cancel:);
    Method m = class_getInstanceMethod(plugin, sel);
    if (!m) return;
    IMP origImp = method_getImplementation(m);
    IMP newImp = imp_implementationWithBlock(^(id self_, id invoke) {
        if ([NSThread isMainThread]) {
            ((void (*)(id, SEL, id))origImp)(self_, sel, invoke);
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                ((void (*)(id, SEL, id))origImp)(self_, sel, invoke);
            });
        }
    });
    method_setImplementation(m, newImp);
}

// Inject a native close (×) button when the barcode scanner shows its CameraView.
// We attach the button to the keyWindow (full-screen frame, immune to whatever frame
// CameraView's superview has) and pin it to the window's safeAreaLayoutGuide so it
// reliably appears at the top-right under the Dynamic Island / notch. We then poll
// every 200ms; once the CameraView is gone (scan finished or cancelled), we remove
// the button. Tapping the button evaluates window.__cancelScan() in the webview.
static void baton_install_scan_close_swizzle(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        SEL sel = @selector(didAddSubview:);
        Method orig = class_getInstanceMethod([UIView class], sel);
        IMP origImp = method_getImplementation(orig);
        IMP newImp = imp_implementationWithBlock(^(UIView *self, UIView *subview) {
            ((void (*)(id, SEL, UIView *))origImp)(self, sel, subview);

            // WKWebView is added after the root controller is installed. Keep the
            // startup skeleton above any newly inserted root-view child.
            UIView *startupSkeleton = nil;
            for (UIView *sibling in self.subviews) {
                if (sibling.tag == 0x5EE1) {
                    startupSkeleton = sibling;
                    break;
                }
            }
            if (startupSkeleton && startupSkeleton != subview) {
                [self bringSubviewToFront:startupSkeleton];
            }

            const char *clsName = object_getClassName(subview);
            if (!clsName || strstr(clsName, "CameraView") == NULL) return;

            // Find webview anywhere in the scene to evaluate JS on.
            __block WKWebView *webView = nil;
            for (UIView *sib in self.subviews) {
                if ([sib isKindOfClass:[WKWebView class]]) { webView = (WKWebView *)sib; break; }
            }
            if (!webView) {
                UIView *parent = self.superview;
                while (parent && !webView) {
                    for (UIView *sib in parent.subviews) {
                        if ([sib isKindOfClass:[WKWebView class]]) { webView = (WKWebView *)sib; break; }
                    }
                    parent = parent.superview;
                }
            }
            if (!webView) return;

            // Find the key window (button host).
            __block UIWindow *kw = nil;
            for (UIScene *s in [UIApplication sharedApplication].connectedScenes) {
                if ([s isKindOfClass:[UIWindowScene class]]) {
                    for (UIWindow *w in ((UIWindowScene *)s).windows) {
                        if (w.isKeyWindow) { kw = w; break; }
                    }
                }
                if (kw) break;
            }
            if (!kw) return;

            // Remove any leftover button from previous scan.
            for (UIView *v in [kw.subviews copy]) {
                if (v.tag == 0xC10E) [v removeFromSuperview];
            }

            UIButton *btn = [UIButton buttonWithType:UIButtonTypeSystem];
            btn.tag = 0xC10E;
            btn.translatesAutoresizingMaskIntoConstraints = NO;
            btn.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5];
            btn.tintColor = [UIColor whiteColor];
            // SF Symbol "xmark" is centered by design — avoids the baseline offset
            // that the "×" Unicode glyph (U+00D7) has inside a UIButton.
            UIImageSymbolConfiguration *cfg = [UIImageSymbolConfiguration
                configurationWithPointSize:14 weight:UIImageSymbolWeightSemibold];
            UIImage *icon = [UIImage systemImageNamed:@"xmark" withConfiguration:cfg];
            [btn setImage:icon forState:UIControlStateNormal];
            btn.layer.cornerRadius = 22;

            __weak WKWebView *weakWeb = webView;
            __weak UIView *weakCam = subview;
            __weak UIButton *weakBtn = btn;
            [btn addAction:[UIAction actionWithTitle:@"" image:nil identifier:nil
                                             handler:^(UIAction *action) {
                [weakWeb evaluateJavaScript:@"window.__cancelScan && window.__cancelScan()" completionHandler:nil];
            }] forControlEvents:UIControlEventTouchUpInside];

            [kw addSubview:btn];
            [kw bringSubviewToFront:btn];

            UILayoutGuide *safe = kw.safeAreaLayoutGuide;
            [NSLayoutConstraint activateConstraints:@[
                [btn.topAnchor constraintEqualToAnchor:safe.topAnchor constant:8],
                [btn.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-12],
                [btn.widthAnchor constraintEqualToConstant:44],
                [btn.heightAnchor constraintEqualToConstant:44],
            ]];

            // Poll for cameraView removal — remove button when camera is gone.
            // Intentional retain cycle: tick holds itself via __block; broken by tick=nil on exit.
            __block void (^tick)(void) = nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-retain-cycles"
            tick = ^{
                UIView *cam = weakCam;
                UIButton *b = weakBtn;
                if (!b || b.window == nil) { tick = nil; return; }
                if (!cam || cam.superview == nil) {
                    [b removeFromSuperview];
                    tick = nil;
                    return;
                }
                [b.superview bringSubviewToFront:b];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)),
                               dispatch_get_main_queue(), tick);
            };
#pragma clang diagnostic pop
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), tick);
        });
        method_setImplementation(orig, newImp);
    });
}

// Disable iOS keyboard accessory toolbar (the prev/next/done bar above keyboard).
// WKContentView is a private class, so retry until WebKit registers it.
static void baton_install_kb_swizzle(void) {
    _baton_swizzle_attempts++;
    Class WKContentView = NSClassFromString(@"WKContentView");
    if (!WKContentView) {
        if (_baton_swizzle_attempts < 30) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ baton_install_kb_swizzle(); });
        }
        return;
    }

    IMP assistantImp = imp_implementationWithBlock(^UITextInputAssistantItem *(id _self) {
        UITextInputAssistantItem *item = [[UITextInputAssistantItem alloc] init];
        item.leadingBarButtonGroups = @[];
        item.trailingBarButtonGroups = @[];
        return item;
    });
    SEL assistantSel = @selector(inputAssistantItem);
    Method assistantM = class_getInstanceMethod(WKContentView, assistantSel);
    if (assistantM) {
        method_setImplementation(assistantM, assistantImp);
    } else {
        class_addMethod(WKContentView, assistantSel, assistantImp, "@@:");
    }

    IMP accessoryImp = imp_implementationWithBlock(^UIView *(id _self) { return nil; });
    SEL accessorySel = @selector(inputAccessoryView);
    Method accessoryM = class_getInstanceMethod(WKContentView, accessorySel);
    if (accessoryM) {
        method_setImplementation(accessoryM, accessoryImp);
    } else {
        class_addMethod(WKContentView, accessorySel, accessoryImp, "@@:");
    }
}

// WebKit bug (Bug 306465, 254868): viewport-fit=cover doesn't extend CSS viewport
// past safe area on some iOS versions. Workaround: negate safeAreaInsets via
// additionalSafeAreaInsets so WebKit calculates viewport = full screen. Then inject
// real inset values as CSS custom properties (--sat/--sab/--sal/--sar) since
// env() becomes 0.
// Only applies when WKContentView height < window height (bug is present).
static void baton_inject_safe_area(WKWebView *wv, UIEdgeInsets sa) {
    if (!wv) return;

    // Install one reload-safe bootstrap. The immediate update below stores the
    // latest orientation's values, and future page loads restore them before
    // first paint without accumulating one WKUserScript per rotation.
    if (!objc_getAssociatedObject(wv, &_baton_safe_area_script_installed_key)) {
        NSString *bootstrap =
            @"(function(){try{"
             "var v=localStorage.getItem('__baton_safe_area');"
             "if(!v)return;"
             "var a=v.split(',');"
             "var s=document.documentElement.style;"
             "s.setProperty('--sat',a[0]+'px');"
             "s.setProperty('--sab',a[1]+'px');"
             "s.setProperty('--sal',a[2]+'px');"
             "s.setProperty('--sar',a[3]+'px');"
             "}catch(e){}})()";
        WKUserScript *script = [[WKUserScript alloc]
            initWithSource:bootstrap
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
            forMainFrameOnly:YES];
        [wv.configuration.userContentController addUserScript:script];
        objc_setAssociatedObject(
            wv, &_baton_safe_area_script_installed_key, @YES,
            OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }

    NSString *js = [NSString stringWithFormat:
        @"(function(){"
         "var v='%.0f,%.0f,%.0f,%.0f';"
         "try{localStorage.setItem('__baton_safe_area',v);}catch(e){}"
         "var a=v.split(',');"
         "var s=document.documentElement.style;"
         "s.setProperty('--sat',a[0]+'px');"
         "s.setProperty('--sab',a[1]+'px');"
         "s.setProperty('--sal',a[2]+'px');"
         "s.setProperty('--sar',a[3]+'px');"
         "})()",
        sa.top, sa.bottom, sa.left, sa.right];
    [wv evaluateJavaScript:js completionHandler:nil];
}

static void baton_fix_viewport(void) {

    UIWindow *kw = nil;
    for (UIScene *s in [UIApplication sharedApplication].connectedScenes) {
        if ([s isKindOfClass:[UIWindowScene class]]) {
            for (UIWindow *w in ((UIWindowScene *)s).windows) {
                if (w.isKeyWindow) { kw = w; break; }
            }
        }
        if (kw) break;
    }
    if (!kw || !kw.rootViewController) {
        static int retries = 0;
        if (retries++ < 60) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ baton_fix_viewport(); });
        }
        return;
    }

    UIEdgeInsets sa = kw.safeAreaInsets;
    // Check if bug is present: find WKWebView scrollView contentSize < window height.
    WKWebView *checkWv = nil;
    for (UIView *sub in kw.rootViewController.view.subviews) {
        if ([sub isKindOfClass:[WKWebView class]]) { checkWv = (WKWebView *)sub; break; }
    }
    if (!checkWv) {
        static int retries2 = 0;
        if (retries2++ < 60) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ baton_fix_viewport(); });
        }
        return;
    }
    // Keep the WKWebView root fixed; scrolling belongs to CSS overflow containers.
    checkWv.allowsBackForwardNavigationGestures = NO;
    checkWv.scrollView.scrollEnabled = NO;
    checkWv.scrollView.bounces = NO;
    checkWv.scrollView.alwaysBounceVertical = NO;

    CGFloat contentH = checkWv.scrollView.contentSize.height;
    CGFloat windowH = kw.bounds.size.height;
    UIEdgeInsets current = kw.rootViewController.additionalSafeAreaInsets;
    BOOL fixAlreadyActive =
        current.top < 0 || current.left < 0 ||
        current.bottom < 0 || current.right < 0;
    BOOL hasSafeArea =
        sa.top > 0 || sa.left > 0 || sa.bottom > 0 || sa.right > 0;

    // Once the workaround is active, refresh all four edges on every rotation.
    // Otherwise landscape keeps the portrait negative top/bottom values and
    // WebKit can push the title/breadcrumb outside the visible viewport.
    if (fixAlreadyActive || (hasSafeArea && contentH < windowH - 1)) {
        kw.rootViewController.additionalSafeAreaInsets = hasSafeArea
            ? UIEdgeInsetsMake(-sa.top, -sa.left, -sa.bottom, -sa.right)
            : UIEdgeInsetsZero;
    }

    baton_inject_safe_area(checkWv, sa);
}

static void baton_schedule_viewport_refresh(void) {
    // UIKit posts orientation notifications before every safe-area consumer has
    // settled. Refresh immediately and twice after layout to cover both paths.
    baton_fix_viewport();
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.12 * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{ baton_fix_viewport(); });
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{ baton_fix_viewport(); });
}

static void baton_install_viewport_refresh_observers(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        [[UIDevice currentDevice] beginGeneratingDeviceOrientationNotifications];
        NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
        void (^refresh)(__unused NSNotification *) = ^(__unused NSNotification *note) {
            baton_schedule_viewport_refresh();
        };
        [center addObserverForName:UIDeviceOrientationDidChangeNotification
                           object:nil
                            queue:[NSOperationQueue mainQueue]
                       usingBlock:refresh];
        [center addObserverForName:UIApplicationDidBecomeActiveNotification
                           object:nil
                            queue:[NSOperationQueue mainQueue]
                       usingBlock:refresh];
    });
}

// Native skeleton overlay: keep the LaunchScreen view above the app's root view
// until the Web skeleton or cached content has completed layout.
static WKWebView *baton_find_webview_in_view(UIView *view) {
    if (!view) return nil;
    if ([view isKindOfClass:[WKWebView class]]) return (WKWebView *)view;
    for (UIView *subview in view.subviews) {
        WKWebView *found = baton_find_webview_in_view(subview);
        if (found) return found;
    }
    return nil;
}

static void baton_find_webview(UIWindow *kw, void (^cb)(WKWebView *)) {
    cb(kw.rootViewController
        ? baton_find_webview_in_view(kw.rootViewController.view)
        : nil);
}

static CGFloat baton_window_top_inset(UIWindow *window) {
    CGFloat top = window.safeAreaInsets.top;
    if (top <= 0 && window.rootViewController) {
        top = window.rootViewController.view.safeAreaInsets.top;
    }
    if (top <= 0 && window.windowScene.statusBarManager) {
        top = CGRectGetHeight(window.windowScene.statusBarManager.statusBarFrame);
    }
    return MAX(0, top);
}

static void baton_layout_skeleton_content(
    UIWindow *window, UIViewController *containerController) {
    UIView *container = containerController.view;
    UIViewController *launchController =
        containerController.childViewControllers.firstObject;
    if (!container || !launchController) return;

    CGFloat top = baton_window_top_inset(window);
    CGRect bounds = container.bounds;
    launchController.view.frame = CGRectMake(
        0, top, CGRectGetWidth(bounds), MAX(0, CGRectGetHeight(bounds) - top));
}

static void baton_attach_skeleton_overlay(UIWindow *kw) {
    if (!kw || !kw.rootViewController) return;
    UIViewController *hostController = kw.rootViewController;
    UIView *hostView = hostController.view;
    UIViewController *existing = objc_getAssociatedObject(
        kw, &_baton_skeleton_controller_key);
    if (existing) {
        UIView *existingView = existing.view;
        if (existing.parentViewController != hostController) {
            [existing willMoveToParentViewController:nil];
            [existingView removeFromSuperview];
            [existing removeFromParentViewController];
            [hostController addChildViewController:existing];
            [hostView addSubview:existingView];
            [existing didMoveToParentViewController:hostController];
        }
        existingView.frame = hostView.bounds;
        baton_layout_skeleton_content(kw, existing);
        [hostView bringSubviewToFront:existingView];
        return;
    }
    if (objc_getAssociatedObject(kw, &_baton_skeleton_installed_key)) {
        return;
    }

    // Reuse the LaunchScreen storyboard so the system launch snapshot and the
    // first app-owned frame have identical geometry.
    UIViewController *launchController = nil;
    @try {
        UIStoryboard *sb = [UIStoryboard storyboardWithName:@"LaunchScreen" bundle:nil];
        launchController = [sb instantiateInitialViewController];
    } @catch (__unused NSException *e) {}
    if (!launchController || !launchController.view) return;

    UIViewController *skeletonController = [UIViewController new];
    UIView *skel = [[UIView alloc] initWithFrame:hostView.bounds];
    skel.backgroundColor = [UIColor colorWithRed:22.0 / 255.0
                                           green:27.0 / 255.0
                                            blue:34.0 / 255.0
                                           alpha:1.0];
    skel.autoresizingMask =
        UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    skeletonController.view = skel;

    UIView *launchView = launchController.view;
    launchView.autoresizingMask =
        UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [skeletonController addChildViewController:launchController];
    [skel addSubview:launchView];
    [launchController didMoveToParentViewController:skeletonController];
    baton_layout_skeleton_content(kw, skeletonController);

    [hostController addChildViewController:skeletonController];
    [hostView addSubview:skel];
    [skeletonController didMoveToParentViewController:hostController];
    [hostView bringSubviewToFront:skel];

    objc_setAssociatedObject(kw, &_baton_skeleton_installed_key, @YES,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(kw, &_baton_skeleton_controller_key,
                             skeletonController,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    skel.tag = 0x5EE1;

    // Keep the overlay even before WKWebView exists. This is the cold-start gap
    // that otherwise exposes the root controller's plain background.
    __weak UIViewController *weakSkeletonController = skeletonController;
    __weak UIWindow *weakKw = kw;
    __block int ticks = 0;
    __block void (^poll)(void) = nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-retain-cycles"
    poll = ^{
        UIViewController *controller = weakSkeletonController;
        UIView *cover = controller.view;
        if (!controller || !cover.superview) { poll = nil; return; }
        ticks++;
        BOOL timedOut = ticks > 750; // ~15s hard cap (20ms * 750)
        baton_find_webview(weakKw, ^(WKWebView *wv) {
            void (^removeOverlay)(void) = ^{
                // The native and Web skeletons are pixel-aligned. A direct
                // removal avoids cross-fading two different shimmer phases.
                [controller willMoveToParentViewController:nil];
                [cover removeFromSuperview];
                [controller removeFromParentViewController];
                objc_setAssociatedObject(weakKw, &_baton_skeleton_controller_key,
                                         nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                poll = nil;
            };
            if (timedOut) { removeOverlay(); return; }
            if (!wv) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.02 * NSEC_PER_SEC)),
                               dispatch_get_main_queue(), ^{ if (poll) poll(); });
                return;
            }
            [wv evaluateJavaScript:@"window.__skelReady?1:0" completionHandler:^(id result, __unused NSError *err) {
                if ([result respondsToSelector:@selector(intValue)] && [result intValue] == 1) {
                    removeOverlay();
                } else {
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.02 * NSEC_PER_SEC)),
                                   dispatch_get_main_queue(), ^{ if (poll) poll(); });
                }
            }];
        });
    };
#pragma clang diagnostic pop
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.02 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), poll);
}

static BOOL baton_is_main_window(UIWindow *window) {
    return window && window.windowLevel == UIWindowLevelNormal;
}

// Install the app-owned skeleton through every UIWindow visibility path used by
// Tao. Tao resets rootViewController during startup, so each reset must also
// bring an existing overlay back above the new root view.
static void baton_install_window_skeleton_swizzle(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        SEL visibleSel = @selector(makeKeyAndVisible);
        Method visibleMethod = class_getInstanceMethod([UIWindow class], visibleSel);
        IMP visibleOriginal = method_getImplementation(visibleMethod);
        IMP visibleReplacement = imp_implementationWithBlock(^(UIWindow *window) {
            if (baton_is_main_window(window)) {
                baton_attach_skeleton_overlay(window);
            }
            ((void (*)(id, SEL))visibleOriginal)(window, visibleSel);
            if (baton_is_main_window(window)) {
                baton_attach_skeleton_overlay(window);
            }
        });
        method_setImplementation(visibleMethod, visibleReplacement);

        SEL hiddenSel = @selector(setHidden:);
        Method hiddenMethod = class_getInstanceMethod([UIWindow class], hiddenSel);
        IMP hiddenOriginal = method_getImplementation(hiddenMethod);
        IMP hiddenReplacement = imp_implementationWithBlock(^(UIWindow *window, BOOL hidden) {
            if (!hidden && baton_is_main_window(window)) {
                baton_attach_skeleton_overlay(window);
            }
            ((void (*)(id, SEL, BOOL))hiddenOriginal)(window, hiddenSel, hidden);
            if (!hidden && baton_is_main_window(window)) {
                baton_attach_skeleton_overlay(window);
            }
        });
        method_setImplementation(hiddenMethod, hiddenReplacement);

        SEL rootSel = @selector(setRootViewController:);
        Method rootMethod = class_getInstanceMethod([UIWindow class], rootSel);
        IMP rootOriginal = method_getImplementation(rootMethod);
        IMP rootReplacement = imp_implementationWithBlock(
            ^(UIWindow *window, UIViewController *controller) {
                ((void (*)(id, SEL, UIViewController *))rootOriginal)(
                    window, rootSel, controller);
                if (baton_is_main_window(window)) {
                    baton_attach_skeleton_overlay(window);
                }
            });
        method_setImplementation(rootMethod, rootReplacement);

        [[NSNotificationCenter defaultCenter]
            addObserverForName:UIWindowDidBecomeVisibleNotification
                        object:nil
                         queue:[NSOperationQueue mainQueue]
                    usingBlock:^(NSNotification *note) {
                        UIWindow *window = [note.object isKindOfClass:[UIWindow class]]
                            ? (UIWindow *)note.object
                            : nil;
                        if (baton_is_main_window(window)) {
                            baton_attach_skeleton_overlay(window);
                        }
                    }];
    });
}

static UIWindow *baton_find_key_window(void) {
    UIApplication *app = [UIApplication sharedApplication];
    for (UIScene *scene in app.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows) {
            if (window.isKeyWindow) return window;
        }
    }
    for (UIWindow *window in app.windows) {
        if (window.isKeyWindow) return window;
    }
    for (UIWindow *window in app.windows) {
        if (baton_is_main_window(window) && !window.hidden) return window;
    }
    return nil;
}

static void baton_install_skeleton_overlay(void) {
    UIWindow *kw = baton_find_key_window();
    if (!kw) {
        static int retries = 0;
        if (retries++ < 750) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.02 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ baton_install_skeleton_overlay(); });
        }
        return;
    }
    baton_attach_skeleton_overlay(kw);
}

int main(int argc, char * argv[]) {
	[WKWebView class]; // force-load WebKit framework
	baton_install_window_skeleton_swizzle();
	baton_install_scan_close_swizzle();
	dispatch_async(dispatch_get_main_queue(), ^{ baton_install_skeleton_overlay(); });
	dispatch_async(dispatch_get_main_queue(), ^{ baton_install_kb_swizzle(); });
	dispatch_async(dispatch_get_main_queue(), ^{ baton_install_scanner_cancel_swizzle(); });
	dispatch_async(dispatch_get_main_queue(), ^{ baton_install_viewport_refresh_observers(); });
	dispatch_async(dispatch_get_main_queue(), ^{ baton_fix_viewport(); });
	ffi::start_app();
	return 0;
}
