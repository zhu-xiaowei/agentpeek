import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('file source and previews reuse the shared native edge-back layer', () => {
  const edgeBack = readFileSync(new URL('../../web/js/edge-back.js', import.meta.url), 'utf8');
  const viewer = readFileSync(
    new URL('../../web/js/components/fileviewer.js', import.meta.url),
    'utf8',
  );

  assert.match(edgeBack, /export function registerEdgeBackLayer\(options\)/);
  assert.match(edgeBack, /gestureLayer\.foregroundSelectors/);
  assert.match(edgeBack, /gestureLayer\.navigateBack/);
  assert.match(viewer, /registerEdgeBackLayer\(\{[\s\S]*navigateBack: closeFileViewer,[\s\S]*'#fileOverlay'/);
  assert.match(viewer, /function openFile[\s\S]*_edgeBack\.activate\(\)/);
  assert.match(viewer, /function closeFileViewer\(\) \{\s*_edgeBack\.deactivate\(\)/);
  assert.match(viewer, /function setFileViewMode\(mode\)/);
  assert.doesNotMatch(viewer, /_edgeBack\.deactivate\(\)[\s\S]*function setFileViewMode/);
});

test('Mermaid fullscreen reuses the shared native edge-back layer', () => {
  const mermaid = readFileSync(
    new URL('../../web/js/components/mermaid.js', import.meta.url),
    'utf8',
  );

  assert.match(mermaid, /window\.registerEdgeBackLayer/);
  assert.match(
    mermaid,
    /window\.registerEdgeBackLayer\(\{[\s\S]*navigateBack: closeMermaidFullscreen,[\s\S]*'\.mermaid-fs-overlay'[\s\S]*guardZIndex: 2002/,
  );
  assert.match(mermaid, /function closeMermaidFullscreen\(\) \{\s*_fsEdgeBack\.deactivate\(\)/);
  assert.match(mermaid, /document\.body\.appendChild\(overlay\);\s*_fsEdgeBack\.activate\(\)/);
});
