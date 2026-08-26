"""
Bridge read routes — app reads session metadata and messages from DDB.
Usage: app.include_router(read_router) in main.py
"""

from fastapi import APIRouter, HTTPException, Request, Query, Response
from boto3.dynamodb.conditions import Key
import asyncio
import base64
import binascii
from datetime import datetime, timedelta, timezone
import json
import os
import re

read_router = APIRouter(prefix="/api/bridge")

_ddb = None
_sessions_table = None
_messages_table = None
_connections_table = None
LIST_INDEX_NAME = "listPk-listSk-index"
THREAD_ROOT_INDEX_NAME = "threadRootPk-threadRootSk-index"
NEEDS_INPUT_ACTIVE_WINDOW = timedelta(days=7)


def _tables():
    global _ddb, _sessions_table, _messages_table, _connections_table
    if _ddb is None:
        import boto3
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        _sessions_table = _ddb.Table(os.environ["BRIDGE_SESSIONS_TABLE"])
        _messages_table = _ddb.Table(os.environ["BRIDGE_MESSAGES_TABLE"])
        conn_name = os.environ.get("CONNECTIONS_TABLE")
        if conn_name:
            _connections_table = _ddb.Table(conn_name)
    return _sessions_table, _messages_table


def _account_id(request: Request) -> str:
    import hashlib
    api_key = request.headers.get("x-api-key", "")
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


def _runtime_fields(item):
    runtime = "codex" if item.get("runtime") == "codex" else "claude"
    session_id = item.get("sessionId", "")
    native_id = item.get("nativeSessionId", "")
    if not native_id:
        native_id = session_id[len("codex:"):] if runtime == "codex" and session_id.startswith("codex:") else session_id
    return {
        "runtime": runtime,
        "nativeSessionId": native_id,
    }


def _thread_fields(item):
    fields = {
        "threadKind": item.get("threadKind", "main"),
        "canSend": item.get("canSend", True),
    }
    if item.get("parentSessionId"):
        fields.update({
            "parentSessionId": item["parentSessionId"],
            "agentRole": item.get("agentRole", ""),
            "agentPath": item.get("agentPath", ""),
            "agentDepth": item.get("agentDepth", 1),
        })
    return fields


def _runtime_capabilities(item):
    capabilities = item.get("runtimeCapabilities")
    if isinstance(capabilities, dict) and capabilities:
        return capabilities
    # Devices written by older bridges only supported Claude.
    return {
        "claude": {
            "installed": True,
            "historyAvailable": True,
            "canRead": True,
            "canCreate": True,
            "canSend": True,
            "version": "",
        }
    }


def _query_all(table, **kwargs):
    """Query DDB with automatic pagination."""
    items = []
    response = table.query(**kwargs)
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table.query(ExclusiveStartKey=response["LastEvaluatedKey"], **kwargs)
        items.extend(response.get("Items", []))
    return items


def _parse_timestamp(value):
    if not value:
        return None
    try:
        text = str(value)
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _public_active_status(item):
    value = item.get("activeStatus", "")
    if value in ("running", "needs_input"):
        return value
    if str(value).startswith("done#"):
        return "completed"
    if item.get("status") == "needs_input" or int(item.get("needsInputAgentCount", 0) or 0) > 0:
        return "needs_input"
    if item.get("status") == "running" or int(item.get("runningAgentCount", 0) or 0) > 0:
        return "running"
    return "completed"


def _active_session_visible(item, online_devices, now=None):
    status = _public_active_status(item)
    if status not in ("running", "needs_input"):
        return False
    if online_devices is not None and item.get("deviceName", "") not in online_devices:
        return False
    if status != "needs_input":
        return True

    status_time = _parse_timestamp(item.get("lastActive"))
    if status_time is None:
        return True
    current_time = now or datetime.now(timezone.utc)
    return status_time >= current_time - NEEDS_INPUT_ACTIVE_WINDOW


def _online_bridge_devices(account_id):
    if _connections_table is None:
        return None
    try:
        rows = _query_all(
            _connections_table,
            IndexName="accountId-role-index",
            KeyConditionExpression=Key("accountId").eq(account_id) & Key("role").eq("bridge"),
            ProjectionExpression="deviceName",
        )
        return {row.get("deviceName", "") for row in rows if row.get("deviceName")}
    except Exception:
        return None


def _project_list_pk(account_id, device):
    return f"{account_id}#PROJ#{device}"


def _session_list_pk(account_id, device, project):
    return f"{account_id}#SESS#{device}#{project}"


def _thread_root_pk(account_id, device, project, root_session_id):
    return f"{account_id}#THREAD#{device}#{project}#{root_session_id}"


def _ordered_thread_items(items, root_session_id):
    roots = [item for item in items if item.get("sessionId") == root_session_id]
    children_by_parent = {}
    for item in items:
        if item.get("threadKind", "main") != "subagent":
            continue
        parent_id = item.get("parentSessionId", "")
        if parent_id:
            children_by_parent.setdefault(parent_id, []).append(item)

    descendants = []
    seen = {root_session_id}

    def append_children(parent_id):
        children = sorted(
            children_by_parent.get(parent_id, []),
            key=lambda item: (item.get("lastActive", ""), item.get("sessionId", "")),
            reverse=True,
        )
        for child in children:
            child_id = child.get("sessionId", "")
            if not child_id or child_id in seen:
                continue
            seen.add(child_id)
            descendants.append(child)
            append_children(child_id)

    append_children(root_session_id)
    return roots + descendants


def _encode_list_cursor(key):
    raw = json.dumps(key, separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_list_cursor(cursor, account_id, list_pk):
    try:
        raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        key = json.loads(raw.decode())
        required = ("accountId", "sk", "listPk", "listSk")
        if not isinstance(key, dict) or any(not isinstance(key.get(name), str) for name in required):
            raise ValueError
        if key["accountId"] != account_id or key["listPk"] != list_pk:
            raise ValueError
        return {name: key[name] for name in required}
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid pagination cursor")


def _query_list_page(table, account_id, list_pk, limit, cursor):
    kwargs = {
        "IndexName": LIST_INDEX_NAME,
        "KeyConditionExpression": Key("listPk").eq(list_pk),
        "ScanIndexForward": False,
        "Limit": limit,
    }
    if cursor:
        kwargs["ExclusiveStartKey"] = _decode_list_cursor(cursor, account_id, list_pk)
    response = table.query(**kwargs)
    next_key = response.get("LastEvaluatedKey")
    return response.get("Items", []), _encode_list_cursor(next_key) if next_key else None


@read_router.get("/config")
async def get_config():
    """Return server configuration (WS URL etc.) for bridge/app auto-discovery."""
    ws_endpoint = os.environ.get("WS_API_ENDPOINT", "")
    ws_url = ws_endpoint.replace("https://", "wss://") if ws_endpoint else ""
    return {"wsUrl": ws_url}


@read_router.get("/active-sessions")
async def get_active_sessions(request: Request):
    """Return active sessions + the 20 most recently completed sessions (any type).
    Two GSI queries: running/needs_input (between) + done# (begins_with, limit 20 desc)."""
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    import asyncio

    loop = asyncio.get_running_loop()
    active_items, done_items, online_devices = await asyncio.gather(
        loop.run_in_executor(None, lambda: _query_all(sessions_table, IndexName="accountId-activeStatus-index",
            KeyConditionExpression=Key("accountId").eq(account_id) & Key("activeStatus").between("needs_input", "running"))),
        loop.run_in_executor(None, lambda: sessions_table.query(IndexName="accountId-activeStatus-index",
            KeyConditionExpression=Key("accountId").eq(account_id) & Key("activeStatus").begins_with("done#"),
            ScanIndexForward=False, Limit=100).get("Items", [])),
        loop.run_in_executor(None, lambda: _online_bridge_devices(account_id)),
    )

    def _to_session(item):
        pn = item.get("projectName", "")
        s = {
            "sessionId": item.get("sessionId", ""),
            "preview": item.get("preview", ""),
            "status": item.get("status", "completed"),
            "activeStatus": _public_active_status(item),
            "deviceName": item.get("deviceName", ""),
            "projectHash": item.get("projectHash", ""),
            "projectName": pn.rsplit("/", 1)[-1] if "/" in pn else pn,
            "lastActive": item.get("lastActive", ""),
            "agentCount": item.get("agentCount", 0),
            **_runtime_fields(item),
            **_thread_fields(item),
        }
        if item.get("isAgent"):
            s["isAgent"] = True
            s["agentName"] = item.get("agentName", "")
            s["agentRole"] = item.get("agentRole", "")
        if item.get("agentDetail"):
            s["agentDetail"] = item.get("agentDetail", "")
        return s

    sessions = [
        _to_session(item)
        for item in active_items
        if not item.get("parentSessionId")
        and _active_session_visible(item, online_devices)
    ]
    sessions.sort(key=lambda x: x["lastActive"], reverse=True)

    recent_sessions = [
        _to_session(item)
        for item in done_items
        if not item.get("parentSessionId")
    ][:20]

    return {"sessions": sessions, "recentSessions": recent_sessions}


def _live_active_counts(sessions_table, account_id):
    """Live count of running/needs_input per device and per device#project, from the
    sparse active GSI (a few rows). Avoids drift-prone stored counters."""
    rows = _query_all(sessions_table, IndexName="accountId-activeStatus-index",
        KeyConditionExpression=Key("accountId").eq(account_id) & Key("activeStatus").between("needs_input", "running"))
    dev = {}   # deviceName -> {running, needs_input}
    proj = {}  # (deviceName, projectHash) -> {running, needs_input}
    for r in rows:
        if r.get("parentSessionId"):
            continue
        st = _public_active_status(r)
        if st not in ("running", "needs_input"):
            continue
        dn, ph = r.get("deviceName", ""), r.get("projectHash", "")
        d = dev.setdefault(dn, {"running": 0, "needs_input": 0}); d[st] += 1
        p = proj.setdefault((dn, ph), {"running": 0, "needs_input": 0}); p[st] += 1
    return dev, proj


@read_router.get("/devices")
async def get_devices(request: Request):
    """DEV# items for sessionCount/projectCount (reconciled); running/needs_input live."""
    sessions_table, _ = _tables()
    account_id = _account_id(request)
    live_dev, _ = _live_active_counts(sessions_table, account_id)

    items = _query_all(
        sessions_table,
        KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with("DEV#"),
    )

    # Check which devices have active bridge WS connections.
    online_devices = set()
    if _connections_table is not None:
        try:
            resp = _connections_table.query(
                IndexName="accountId-role-index",
                KeyConditionExpression=Key("accountId").eq(account_id) & Key("role").eq("bridge"),
                ProjectionExpression="deviceName",
            )
            for c in resp.get("Items", []):
                dn = c.get("deviceName", "")
                if dn:
                    online_devices.add(dn)
        except Exception:
            pass

    devices = []
    for item in items:
        name = item.get("deviceName", "")
        if not name:
            continue
        lc = live_dev.get(name, {})
        devices.append({
            "deviceName": name,
            "deviceDisplayName": item.get("deviceDisplayName") or name,
            "os": item.get("os", ""),
            "projectCount": int(item.get("projectCount", 0)),
            "sessionCount": int(item.get("sessionCount", 0)),
            "runningCount": lc.get("running", 0),
            "needsInputCount": lc.get("needs_input", 0),
            "lastActive": item.get("lastActive", ""),
            "online": name in online_devices,
            "runtimeCapabilities": _runtime_capabilities(item),
        })
    devices.sort(key=lambda x: x["lastActive"], reverse=True)
    return {"devices": devices}


@read_router.get("/projects")
async def get_projects(
    request: Request,
    device: str = Query(...),
    limit: int = Query(None, ge=1, le=100),
    cursor: str = Query(None),
):
    """PROJ# items for sessionCount; running/needs_input counted live."""
    sessions_table, _ = _tables()
    account_id = _account_id(request)
    _, live_proj = _live_active_counts(sessions_table, account_id)

    if cursor and limit is None:
        raise HTTPException(status_code=400, detail="limit is required with cursor")
    next_cursor = None
    if limit is None:
        items = _query_all(
            sessions_table,
            KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with(f"PROJ#{device}#"),
        )
    else:
        items, next_cursor = _query_list_page(
            sessions_table, account_id, _project_list_pk(account_id, device), limit, cursor
        )

    projects = []
    for item in items:
        ph = item.get("projectHash", "")
        if not ph:
            continue
        pn = item.get("projectName", ph)
        lc = live_proj.get((device, ph), {})
        projects.append({
            "projectHash": ph,
            "projectName": pn.rsplit("/", 1)[-1] if "/" in pn else pn,
            "projectPath": pn,
            "sessionCount": int(item.get("sessionCount", 0)),
            "runningCount": lc.get("running", 0),
            "needsInputCount": lc.get("needs_input", 0),
            "lastActive": item.get("lastActive", ""),
        })
    projects.sort(key=lambda x: (x["lastActive"], x["projectHash"]), reverse=True)
    result = {"projects": projects}
    if limit is not None:
        result.update({"hasMore": next_cursor is not None, "nextCursor": next_cursor})
    return result


@read_router.get("/sessions")
async def get_sessions(
    request: Request,
    device: str = Query(...),
    project: str = Query(...),
    limit: int = Query(None, ge=1, le=100),
    cursor: str = Query(None),
):
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    if cursor and limit is None:
        raise HTTPException(status_code=400, detail="limit is required with cursor")
    next_cursor = None
    if limit is None:
        items = _query_all(
            sessions_table,
            KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with(f"SESS#{device}#{project}#"),
        )
    else:
        items, next_cursor = _query_list_page(
            sessions_table, account_id, _session_list_pk(account_id, device, project), limit, cursor
        )
    items = [item for item in items if not item.get("parentSessionId")]

    sessions = []
    for item in items:
        s = {
            "sessionId": item.get("sessionId", ""),
            "preview": item.get("preview", ""),
            "lastActive": item.get("lastActive", ""),
            "size": item.get("size", 0),
            "model": item.get("model", ""),
            "status": item.get("status", "completed"),
            "activeStatus": _public_active_status(item),
            "agentCount": item.get("agentCount", 0),
            **_runtime_fields(item),
            **_thread_fields(item),
        }
        if item.get("modelProvider"):
            s["modelProvider"] = item["modelProvider"]
        if item.get("clientSource"):
            s["clientSource"] = item["clientSource"]
        if item.get("cliVersion"):
            s["cliVersion"] = item["cliVersion"]
        if item.get("isAgent"):
            s["isAgent"] = True
            s["agentName"] = item.get("agentName", "")
        if item.get("agentDetail"):
            s["agentDetail"] = item.get("agentDetail", "")
        sessions.append(s)
    sessions.sort(key=lambda x: (x["lastActive"], x["sessionId"]), reverse=True)
    result = {"sessions": sessions}
    if limit is not None:
        result.update({"hasMore": next_cursor is not None, "nextCursor": next_cursor})
    return result


@read_router.get("/session-threads")
async def get_session_threads(
    request: Request,
    device: str = Query(...),
    project: str = Query(...),
    session: str = Query(...),
):
    sessions_table, _ = _tables()
    account_id = _account_id(request)
    items = []
    try:
        items = _query_all(
            sessions_table,
            IndexName=THREAD_ROOT_INDEX_NAME,
            KeyConditionExpression=Key("threadRootPk").eq(
                _thread_root_pk(account_id, device, project, session)
            ),
        )
    except Exception:
        items = []

    ordered_items = _ordered_thread_items(items, session)
    root_item = ordered_items[0] if ordered_items else None
    expected_count = int(root_item.get("agentCount", 0)) if root_item else 0
    if not root_item or len(ordered_items) - 1 < expected_count:
        project_items = _query_all(
            sessions_table,
            KeyConditionExpression=Key("accountId").eq(account_id)
            & Key("sk").begins_with(f"SESS#{device}#{project}#"),
        )
        ordered_items = _ordered_thread_items(project_items, session)

    def to_thread(item):
        thread = {
            "sessionId": item.get("sessionId", ""),
            "preview": item.get("preview", ""),
            "status": item.get("status", "completed"),
            "lastActive": item.get("lastActive", ""),
            "size": item.get("size", 0),
            "agentName": item.get("agentName", ""),
            "agentRole": item.get("agentRole", ""),
            **_runtime_fields(item),
            **_thread_fields(item),
        }
        return thread

    threads = [to_thread(item) for item in ordered_items]
    return {"rootSessionId": session, "threads": threads}


def _parse_messages(items):
    """Convert DDB items to message dicts."""
    messages = []
    for item in items:
        content = item.get("content", "")
        try:
            content = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            pass
        msg = {
            "uuid": item.get("uuid", ""),
            "type": item.get("type", ""),
            "content": content,
            "timestamp": item.get("timestamp", ""),
        }
        if item.get("nativeId"):
            msg["nativeId"] = item["nativeId"]
        if item.get("stopReason"):
            msg["stopReason"] = item["stopReason"]
        tur = item.get("toolUseResult", "")
        if tur:
            try:
                msg["toolUseResult"] = json.loads(tur)
            except (json.JSONDecodeError, TypeError):
                pass
        messages.append(msg)
    return messages


def _message_session_status(request, sessions_table, session, device, project):
    if not device or not project:
        return ""
    try:
        item = sessions_table.get_item(
            Key={
                "accountId": _account_id(request),
                "sk": f"SESS#{device}#{project}#{session}",
            },
            ConsistentRead=True,
        ).get("Item", {})
    except Exception as error:
        print(f"message status read error: {error}")
        return ""
    status = item.get("status", "")
    return status if status in ("running", "needs_input", "completed") else ""


# Lambda invoke-response hard limit is 6MB (measured on the base64-encoded body
# the Lambda Web Adapter produces). base64 inflates ~33% and gzip barely helps
# image-heavy pages, so we cap the *uncompressed* JSON well under that: 4MB of
# JSON → ~5.3MB after base64, safely below 6MB even if gzip does nothing.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def _trim_to_budget(messages):
    """Keep the newest messages within the Lambda response budget."""
    total, kept = 0, []
    for m in messages:
        size = len(str(m.get("content", ""))) + len(str(m.get("toolUseResult", "")))
        if kept and total + size > MAX_RESPONSE_BYTES:
            return kept, True
        kept.append(m)
        total += size
    return kept, False


def _query_page(table, limit, **kwargs):
    """Query DDB with a limit, returning (items, has_more)."""
    items = []
    response = table.query(Limit=limit, **kwargs)
    items.extend(response.get("Items", []))
    has_more = "LastEvaluatedKey" in response
    if len(items) >= limit:
        return items[:limit], True
    while "LastEvaluatedKey" in response and len(items) < limit:
        remaining = limit - len(items)
        response = table.query(Limit=remaining, ExclusiveStartKey=response["LastEvaluatedKey"], **kwargs)
        items.extend(response.get("Items", []))
    return items[:limit], "LastEvaluatedKey" in response or len(items) > limit


@read_router.get("/messages")
async def get_messages(
    request: Request,
    session: str = Query(...),
    after: str = Query(None),
    before: str = Query(None),
    device: str = Query(None),
    limit: int = Query(None),
    project: str = Query(None),
):
    sessions_table, messages_table = _tables()
    status_future = None
    if device and project:
        status_future = asyncio.get_running_loop().run_in_executor(
            None,
            _message_session_status,
            request,
            sessions_table,
            session,
            device,
            project,
        )

    async def with_status(payload):
        status = await status_future if status_future else ""
        if status:
            payload["status"] = status
        return payload

    if after:
        # Forward query: used by WS reconnect recovery
        items = _query_all(
            messages_table,
            KeyConditionExpression=Key("sessionId").eq(session) & Key("sk").gt(f"{after}#\xff"),
        )
        messages = _parse_messages(items)
        return await with_status({
            "messages": messages,
            "hasMore": False,
            "needSync": False,
        })

    page_limit = min(limit, 500) if limit else 100

    if before:
        # Reverse query: fetch messages before the opaque DDB sort-key cursor.
        items, has_more = _query_page(
            messages_table,
            page_limit,
            KeyConditionExpression=Key("sessionId").eq(session) & Key("sk").lt(f"{before}"),
            ScanIndexForward=False,
        )
        # items are newest-first; trim the older tail that overflows the 6MB
        # response cap, keeping the newest messages closest to `before`.
        messages = _parse_messages(items)
        messages, trimmed = _trim_to_budget(messages)
        oldest_cursor = items[len(messages) - 1].get("sk", "") if messages else ""
        messages.reverse()
        return await with_status({
            "messages": messages,
            "hasMore": has_more or trimmed,
            "oldestTimestamp": oldest_cursor,
            "needSync": False,
        })

    # Default: fetch latest N messages (reverse scan, then flip).
    # ConsistentRead=True closes the eventual-consistency window after a bridge
    # sync write — without it, the second /messages call after sync_complete
    # can briefly miss rows that the bridge just wrote.
    items, has_more = _query_page(
        messages_table,
        page_limit,
        KeyConditionExpression=Key("sessionId").eq(session),
        ScanIndexForward=False,
        ConsistentRead=True,
    )
    # items are newest-first; trim the older tail that overflows the 6MB cap.
    messages = _parse_messages(items)
    messages, trimmed = _trim_to_budget(messages)
    has_more = has_more or trimmed
    oldest_cursor = items[len(messages) - 1].get("sk", "") if messages else ""
    messages.reverse()

    need_sync = len(messages) == 0
    if need_sync:
        try:
            account_id = _account_id(request)
            ws_endpoint = os.environ.get("WS_API_ENDPOINT", "")
            if ws_endpoint:
                from bridge_ws import notify_bridge_sync
                notify_bridge_sync(session, account_id, ws_endpoint, device)
        except Exception as e:
            print(f"needSync trigger error: {e}")

    return await with_status({
        "messages": messages,
        "hasMore": has_more,
        "oldestTimestamp": oldest_cursor,
        "needSync": need_sync,
    })


def _powershell_literal(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def _shell_literal(value):
    return "'" + str(value or "").replace("'", "'\"'\"'") + "'"


INVALID_INTERNAL_NAME = (
    "Invalid device name. Use 1-32 characters: letters, numbers, '.', '_' or '-', "
    "starting with a letter or number."
)
INVALID_DISPLAY_NAME = "Invalid device name. Use 1-32 visible characters with no line breaks."
DUPLICATE_DEVICE_NAME = "That device name is already in use. Choose another."
DEVICE_NAME_CHECK_FAILED = "Could not validate device name. Check your connection and try again."


def _check_device_name(items, name, mode, current=""):
    name = str(name or "").strip()
    if mode == "identity":
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,31}", name):
            return "", INVALID_INTERNAL_NAME
    elif mode == "display":
        if not 1 <= len(name) <= 32 or not all(char.isprintable() for char in name):
            return "", INVALID_DISPLAY_NAME
    else:
        return "", "Invalid validation mode."

    candidate = name.casefold()
    current = str(current or "").casefold()
    for item in items:
        identity = str(item.get("deviceName", ""))
        if current and identity.casefold() == current:
            continue
        display = str(item.get("deviceDisplayName") or identity)
        values = (identity, display) if mode == "identity" else (display,)
        if any(value.strip().casefold() == candidate for value in values):
            return "", DUPLICATE_DEVICE_NAME
    return name, ""


@read_router.get("/device-name/validate")
async def validate_device_name(
    request: Request,
    name: str = Query(...),
    mode: str = Query("identity"),
    current: str = Query(""),
):
    sessions_table, _ = _tables()
    items = _query_all(
        sessions_table,
        KeyConditionExpression=Key("accountId").eq(_account_id(request)) & Key("sk").begins_with("DEV#"),
        ProjectionExpression="deviceName, deviceDisplayName",
    )
    normalized, error = _check_device_name(items, name, mode, current)
    return {"ok": not error, "name": normalized, "error": error}


def _unix_device_name_block(server, api_key, name):
    return f"""# Preserve the original deviceName as the stable identity; only the display name changes.
REQUESTED_NAME={_shell_literal(name)}
EXISTING_NAME=""
EXISTING_DISPLAY_NAME=""
if [ -f "$DIR/config.json" ]; then
  EXISTING_NAME=$(python3 -c "import json; print(json.load(open('$DIR/config.json')).get('deviceName',''))" 2>/dev/null || true)
  EXISTING_DISPLAY_NAME=$(python3 -c "import json; print(json.load(open('$DIR/config.json')).get('deviceDisplayName',''))" 2>/dev/null || true)
fi
VALIDATION_URL={_shell_literal(f"{server}/api/bridge/device-name/validate")}
VALIDATION_KEY={_shell_literal(api_key)}
validate_name() {{
  VALIDATION_URL="$VALIDATION_URL" VALIDATION_KEY="$VALIDATION_KEY" node -e '
    const [name, mode, current] = process.argv.slice(1);
    const url = new URL(process.env.VALIDATION_URL);
    url.searchParams.set("name", name);
    url.searchParams.set("mode", mode);
    if (current) url.searchParams.set("current", current);
    fetch(url, {{headers: {{"x-api-key": process.env.VALIDATION_KEY}}}})
      .then(async response => {{
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (!result.ok) {{ console.error(result.error); process.exitCode = 1; return; }}
        process.stdout.write(result.name);
      }})
      .catch(() => {{ console.error("{DEVICE_NAME_CHECK_FAILED}"); process.exitCode = 2; }});
  ' -- "$1" "$2" "$3"
}}
if [ -n "$EXISTING_NAME" ]; then
  NAME="$EXISTING_NAME"
  DEFAULT_NAME="${{EXISTING_DISPLAY_NAME:-$EXISTING_NAME}}"
  if tty -s 2>/dev/null < /dev/tty; then
    while true; do
      printf "Device name [%s]: " "$DEFAULT_NAME" > /dev/tty
      read -r ENTERED_NAME < /dev/tty
      if DEVICE_DISPLAY_NAME=$(validate_name "${{ENTERED_NAME:-$DEFAULT_NAME}}" display "$NAME"); then
        break
      else
        [ $? -eq 2 ] && exit 1
      fi
    done
  else
    DEVICE_DISPLAY_NAME="$DEFAULT_NAME"
  fi
else
  DEFAULT_NAME="${{REQUESTED_NAME:-$(hostname)}}"
  if tty -s 2>/dev/null < /dev/tty; then
    while true; do
      printf "Device name [%s]: " "$DEFAULT_NAME" > /dev/tty
      read -r ENTERED_NAME < /dev/tty
      if NAME=$(validate_name "${{ENTERED_NAME:-$DEFAULT_NAME}}" identity ""); then
        break
      else
        [ $? -eq 2 ] && exit 1
      fi
    done
  else
    NAME=$(validate_name "$DEFAULT_NAME" identity "") || exit 1
  fi
  DEVICE_DISPLAY_NAME="$NAME"
fi"""


def _windows_install_script(url, server, api_key, name):
    package = _powershell_literal(url)
    server_value = _powershell_literal(server)
    key_value = _powershell_literal(api_key)
    name_value = _powershell_literal(name)
    validation_uri = _powershell_literal(f"{server}/api/bridge/device-name/validate")
    return "\n".join([
        "$ErrorActionPreference = 'Stop'",
        "$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
        "$isSystemContext = $currentIdentity -match '(^|\\\\)SYSTEM$'",
        "$isAdministrator = (New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)",
        "if (-not $isSystemContext -and -not $isAdministrator) {",
        "  Write-Host 'ERROR: Administrator privileges are required to install Baton Bridge on Windows.' -ForegroundColor Red",
        "  Write-Host 'Open PowerShell using \"Run as administrator\", then run the install command again.' -ForegroundColor Yellow",
        "  return",
        "}",
        "$task = Get-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
        "$useSystemTask = $isSystemContext -or ($currentIdentity -match '(^|\\\\)ssm-user$')",
        "$targetHome = $HOME",
        "if ($useSystemTask) {",
        "  $profiles = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { -not $_.Special -and $_.LocalPath -and (Test-Path $_.LocalPath) }",
        "  $targetProfile = $profiles | Where-Object {",
        "    (Test-Path (Join-Path $_.LocalPath '.claude')) -or (Test-Path (Join-Path $_.LocalPath '.codex'))",
        "  } | Sort-Object LastUseTime -Descending | Select-Object -First 1",
        "  if (-not $targetProfile) {",
        "    $targetProfile = $profiles | Where-Object { $_.LocalPath -notmatch '\\\\(Public|Default|defaultuser0|ssm-user)$' } | Sort-Object LastUseTime -Descending | Select-Object -First 1",
        "  }",
        "  if ($targetProfile) { $targetHome = $targetProfile.LocalPath }",
        "}",
        "$node = Get-Command node.exe -ErrorAction SilentlyContinue",
        "if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }",
        "$nodeCandidates = @($node.Source)",
        "if ($task) {",
        "  $nodeCandidates += $task.Actions | ForEach-Object { $_.Execute } | Where-Object { $_ -and ([IO.Path]::GetFileName($_) -ieq 'node.exe') }",
        "}",
        "$nodeCandidates += @(",
        "  (Join-Path $env:ProgramFiles 'nodejs\\node.exe'),",
        "  (Join-Path $targetHome 'AppData\\Local\\Programs\\nodejs\\node.exe')",
        ")",
        "foreach ($root in @(",
        "  'C:\\nodejs',",
        "  (Join-Path $targetHome 'AppData\\Roaming\\nvm'),",
        "  (Join-Path $targetHome 'AppData\\Local\\fnm'),",
        "  (Join-Path $targetHome 'AppData\\Local\\Volta\\tools\\image\\node')",
        ")) {",
        "  if (-not $root -or -not (Test-Path $root)) { continue }",
        "  $nodeCandidates += Get-ChildItem $root -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }",
        "}",
        "$nodePath = ''",
        "$nodeVersion = $null",
        "$nodeErrors = @()",
        "foreach ($candidate in $nodeCandidates | Select-Object -Unique) {",
        "  if (-not $candidate -or -not (Test-Path $candidate)) { continue }",
        "  try {",
        "    $candidateVersion = [version](& $candidate -p \"process.versions.node\" 2>&1)",
        "    if ($candidateVersion -ge [version]'20.9.0') {",
        "      $nodePath = $candidate",
        "      $nodeVersion = $candidateVersion",
        "      break",
        "    }",
        "    $nodeErrors += \"${candidate}: version $candidateVersion is below 20.9.0\"",
        "  } catch {",
        "    $nodeErrors += \"${candidate}: $($_.Exception.Message)\"",
        "  }",
        "}",
        "if (-not $nodePath) {",
        "  $checked = ($nodeCandidates | Select-Object -Unique) -join ', '",
        "  $details = $nodeErrors -join '; '",
        "  throw \"Node.js 20.9+ was not found or could not run. Checked: $checked. Details: $details. Install Node.js 20.9+ and retry.\"",
        "}",
        "$env:Path = (Split-Path $nodePath) + ';' + $env:Path",
        "$dir = Join-Path $targetHome '.baton-bridge'",
        "$configPath = Join-Path $dir 'config.json'",
        "$existingName = ''",
        "$existingDisplayName = ''",
        "if (Test-Path $configPath) {",
        "  try {",
        "    $existingConfig = Get-Content $configPath -Raw | ConvertFrom-Json",
        "    $existingName = [string]$existingConfig.deviceName",
        "    $existingDisplayName = [string]$existingConfig.deviceDisplayName",
        "  } catch {}",
        "}",
        f"$requestedName = {name_value}",
        f"$validationUri = {validation_uri}",
        f"$headers = @{{ 'x-api-key' = {key_value} }}",
        "function Test-DeviceName([string]$candidate, [string]$mode, [string]$current = '') {",
        "  $uri = $validationUri + '?name=' + [uri]::EscapeDataString($candidate) + '&mode=' + $mode",
        "  if ($current) { $uri += '&current=' + [uri]::EscapeDataString($current) }",
        "  try { return Invoke-RestMethod -UseBasicParsing -Uri $uri -Headers $headers } catch {",
        f"    throw { _powershell_literal(DEVICE_NAME_CHECK_FAILED) }",
        "  }",
        "}",
        "if ([string]::IsNullOrWhiteSpace($existingName)) {",
        "  $defaultName = if ([string]::IsNullOrWhiteSpace($requestedName)) { $env:COMPUTERNAME } else { $requestedName }",
        "  while ($true) {",
        "    if ($isSystemContext) { $candidate = $defaultName } else {",
        "      $enteredName = Read-Host \"Device name [$defaultName]\"",
        "      $candidate = if ([string]::IsNullOrWhiteSpace($enteredName)) { $defaultName } else { $enteredName }",
        "    }",
        "    $result = Test-DeviceName $candidate 'identity'",
        "    if ($result.ok) { $deviceName = [string]$result.name; break }",
        "    if ($isSystemContext) { throw $result.error }",
        "    Write-Host $result.error",
        "  }",
        "  $deviceDisplayName = $deviceName",
        "} else {",
        "  $deviceName = $existingName",
        "  $defaultName = if ([string]::IsNullOrWhiteSpace($existingDisplayName)) { $existingName } else { $existingDisplayName }",
        "  if ($isSystemContext) {",
        "    $deviceDisplayName = $defaultName",
        "  } else {",
        "    while ($true) {",
        "      $enteredName = Read-Host \"Device name [$defaultName]\"",
        "      $candidate = if ([string]::IsNullOrWhiteSpace($enteredName)) { $defaultName } else { $enteredName }",
        "      $result = Test-DeviceName $candidate 'display' $deviceName",
        "      if ($result.ok) { $deviceDisplayName = [string]$result.name; break }",
        "      Write-Host $result.error",
        "    }",
        "  }",
        "}",
        "if ($task) { Stop-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue }",
        "$legacy = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine -match '(?i)\\\\\\.baton-bridge\\\\.*bridge(-launcher)?\\.mjs' }",
        "$legacy | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        "if ($legacy) { Start-Sleep -Milliseconds 500 }",
        "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
        "$archive = Join-Path $env:TEMP 'baton-bridge.tar.gz'",
        f"Invoke-WebRequest -UseBasicParsing -Uri {package} -OutFile $archive",
        "$tar = Get-Command tar.exe -ErrorAction SilentlyContinue",
        "if (-not $tar) { throw 'tar.exe is required.' }",
        "& $tar.Source -xzf $archive -C $dir",
        "if ($LASTEXITCODE -ne 0) { throw 'Bridge package extraction failed.' }",
        "Remove-Item $archive -Force -ErrorAction SilentlyContinue",
        "$npm = Join-Path (Split-Path $nodePath) 'npm.cmd'",
        "if (-not (Test-Path $npm)) {",
        "  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue",
        "  if (-not $npmCommand) { throw 'npm is required.' }",
        "  $npm = $npmCommand.Source",
        "}",
        "Push-Location $dir",
        "try {",
        "  $npmExit = 1",
        "  foreach ($attempt in 1..2) {",
        "    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }",
        "    & $npm ci --omit=dev --include=optional --silent --no-audit --no-fund",
        "    $npmExit = $LASTEXITCODE",
        "    if ($npmExit -eq 0) { & $nodePath (Join-Path $dir 'verify-dependencies.mjs'); $npmExit = $LASTEXITCODE }",
        "    if ($npmExit -eq 0) { break }",
        "  }",
        "} finally { Pop-Location }",
        "if ($npmExit -ne 0) { throw 'Bridge dependency installation failed.' }",
        f"$config = @{{ server = {server_value}; apiKey = {key_value}; deviceName = $deviceName; deviceDisplayName = $deviceDisplayName }}",
        "$utf8 = New-Object System.Text.UTF8Encoding($false)",
        "[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8)",
        "$bridge = Join-Path $dir 'bridge-launcher.mjs'",
        "$logPath = Join-Path $dir 'bridge.log'",
        "Remove-Item $logPath -Force -ErrorAction SilentlyContinue",
        "$wrapper = Join-Path $dir 'run-bridge.cmd'",
        "$wrapperLines = @(",
        "  '@echo off',",
        "  ('set \"USERPROFILE=' + $targetHome + '\"'),",
        "  ('set \"HOME=' + $targetHome + '\"'),",
        "  ('set \"PATH=' + (Split-Path $nodePath) + ';%PATH%\"'),",
        "  ('\"' + $nodePath + '\" \"' + $bridge + '\" >> \"' + $logPath + '\" 2>&1')",
        ")",
        "[System.IO.File]::WriteAllLines($wrapper, $wrapperLines, [System.Text.Encoding]::ASCII)",
        "$action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/d /c \"' + $wrapper + '\"') -WorkingDirectory $dir",
        "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)",
        "if ($useSystemTask) {",
        "  $trigger = New-ScheduledTaskTrigger -AtStartup",
        "  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
        "} else {",
        "  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity",
        "  $principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType S4U -RunLevel Highest",
        "}",
        "function Wait-BatonBridge {",
        "  $runningChecks = 0",
        "  foreach ($attempt in 1..10) {",
        "    $currentTask = Get-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
        "    if ($currentTask -and $currentTask.State -eq 'Running') {",
        "      $runningChecks++",
        "      if ($runningChecks -ge 4) { return $true }",
        "    } else {",
        "      $runningChecks = 0",
        "    }",
        "    Start-Sleep -Seconds 1",
        "  }",
        "  return $false",
        "}",
        "function Start-BatonTask($taskPrincipal) {",
        "  Register-ScheduledTask -TaskName 'Baton Bridge' -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null",
        "  Start-ScheduledTask -TaskName 'Baton Bridge'",
        "  return (Wait-BatonBridge)",
        "}",
        "$taskStarted = $false",
        "$taskError = ''",
        "try {",
        "  $taskStarted = Start-BatonTask $principal",
        "} catch {",
        "  $taskError = $_.Exception.Message",
        "}",
        "if (-not $taskStarted -and -not $useSystemTask -and -not (Test-Path $logPath)) {",
        "  Write-Host 'Baton Bridge did not start with S4U; retrying with the current logged-on user...' -ForegroundColor Yellow",
        "  Stop-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
        "  $principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Highest",
        "  $taskError = ''",
        "  try {",
        "    $taskStarted = Start-BatonTask $principal",
        "  } catch {",
        "    $taskError = $_.Exception.Message",
        "  }",
        "}",
        "if (-not $taskStarted) {",
        "  $failedTask = Get-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
        "  $taskInfo = Get-ScheduledTaskInfo -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
        "  $taskResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }",
        "  $taskResultText = if ($null -ne $taskResult) { \"$taskResult / $('0x{0:X8}' -f ([uint32]$taskResult))\" } else { 'unavailable' }",
        "  $taskState = if ($failedTask) { [string]$failedTask.State } else { 'NotFound' }",
        "  $taskHint = if ($null -ne $taskResult -and [uint32]$taskResult -eq 0x00041303) { 'The task action has not run.' } else { 'The Bridge did not remain running for 3 seconds.' }",
        "  $logTail = if (Test-Path $logPath) { (Get-Content $logPath -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine } else { 'No bridge log was created.' }",
        "  $taskEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TaskScheduler/Operational'; StartTime = (Get-Date).AddMinutes(-5) } -ErrorAction SilentlyContinue |",
        "    Where-Object { $_.Message -like '*Baton Bridge*' } | Select-Object -First 4 | ForEach-Object {",
        "      'Event ' + $_.Id + ': ' + (($_.Message -replace '\\s+', ' ').Trim())",
        "    })",
        "  $eventSummary = if ($taskEvents.Count -gt 0) { $taskEvents -join [Environment]::NewLine } else { 'No Task Scheduler operational event was available.' }",
        "  throw \"Baton Bridge failed to start within 10 seconds. $taskHint`nTask state: $taskState`nTask result: $taskResultText`nStart error: $taskError`nTask Scheduler: $eventSummary`nLog ($logPath):`n$logTail\"",
        "}",
        "Write-Output \"Baton Bridge installed and running for $deviceName.\"",
        "Write-Output \"  Node:    $nodePath ($nodeVersion)\"",
        "Write-Output \"  Profile: $targetHome\"",
        "Write-Output \"  Logs:    $logPath\"",
        "",
    ])


@read_router.get("/install")
async def get_install(
    request: Request,
    name: str = Query(None),
    platform: str = Query(""),
):
    """Return a shell script that downloads and runs bridge."""
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "bucket not configured"}
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    url = s3.generate_presigned_url("get_object",
        Params={"Bucket": bucket, "Key": "install/bridge.tar.gz"}, ExpiresIn=3600)
    api_key = request.headers.get("x-api-key", "")
    ws_endpoint = os.environ.get("WS_API_ENDPOINT", "")
    ws_url = ws_endpoint.replace("https://", "wss://") if ws_endpoint else ""
    # Use x-forwarded headers from API GW if available
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", "")
    server = f"{proto}://{host}/v1" if host else request.url.scheme + "://" + request.headers.get("host", "") + "/v1"
    if platform.lower() == "windows":
        return Response(
            content=_windows_install_script(url, server, api_key, name),
            media_type="text/plain",
        )
    name_block = _unix_device_name_block(server, api_key, name)
    script = (
        '#!/bin/bash\n'
        'set -e\n'
        '\n'
        '# Require Node.js >= 20.9\n'
        'if ! command -v node &>/dev/null; then\n'
        '  echo "\\033[0;31mError: Node.js is not installed.\\033[0m" >&2\n'
        '  echo "Install Node.js 20.9+ from https://nodejs.org/ and try again." >&2\n'
        '  exit 1\n'
        'fi\n'
        'NODE_VER=$(node -p "process.versions.node")\n'
        'if ! node -e "const [major, minor] = process.versions.node.split(\'.\').map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)"; then\n'
        '  echo "\\033[0;31mError: Node.js $NODE_VER is too old. Requires >= 20.9.\\033[0m" >&2\n'
        '  echo "Current: $(node --version)  —  upgrade from https://nodejs.org/" >&2\n'
        '  exit 1\n'
        'fi\n'
        '\n'
        'DIR="$HOME/.baton-bridge"\n'
        f'{name_block}\n'
        'NODE=$(which node)\n'
        'NODE_DIR=$(dirname "$NODE")\n'
        'mkdir -p "$DIR" && cd "$DIR"\n'
        f'curl -sL "{url}" | tar xz 2>/dev/null\n'
        'install_bridge_dependencies() {\n'
        '  npm ci --omit=dev --include=optional --silent --no-audit --no-fund 2>/dev/null &&\n'
        '    node verify-dependencies.mjs\n'
        '}\n'
        'install_bridge_dependencies || { sleep 2; install_bridge_dependencies; }\n'
        f'BATON_SERVER={_shell_literal(server)} BATON_API_KEY={_shell_literal(api_key)} '
        'BATON_DEVICE_NAME="$NAME" BATON_DEVICE_DISPLAY_NAME="$DEVICE_DISPLAY_NAME" '
        'node -e \'const fs=require("fs");const p=process.argv[1];'
        'const config={server:process.env.BATON_SERVER,apiKey:process.env.BATON_API_KEY,'
        'deviceName:process.env.BATON_DEVICE_NAME,deviceDisplayName:process.env.BATON_DEVICE_DISPLAY_NAME};'
        'fs.writeFileSync(p,JSON.stringify(config,null,2));\' "$DIR/config.json"\n'
        '\n'
        '# WSL: symlink Windows .claude directory so bridge can monitor Windows CC sessions\n'
        'if [ -n "$WSL_DISTRO_NAME" ]; then\n'
        '  WIN_USER=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d "\\r\\n")\n'
        '  if [ -n "$WIN_USER" ]; then\n'
        '    WIN_CLAUDE="/mnt/c/Users/${WIN_USER}/.claude"\n'
        '    if [ -d "$WIN_CLAUDE" ] && [ ! -e "$HOME/.claude" ]; then\n'
        '      ln -sf "$WIN_CLAUDE" "$HOME/.claude"\n'
        '      printf "  Linked Windows .claude → %s\\n" "$WIN_CLAUDE"\n'
        '    elif [ -d "$WIN_CLAUDE" ] && [ -L "$HOME/.claude" ]; then\n'
        '      printf "  Symlink already exists: %s\\n" "$(readlink $HOME/.claude)"\n'
        '    fi\n'
        '  fi\n'
        'fi\n'
        '\n'
        '# Setup auto-start service\n'
        'if [ "$(uname)" = "Darwin" ]; then\n'
        '  # macOS: launchd\n'
        '  PLIST="$HOME/Library/LaunchAgents/com.baton.bridge.plist"\n'
        '  mkdir -p "$HOME/Library/LaunchAgents"\n'
        '  cat > "$PLIST" << PLIST_EOF\n'
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><dict>\n'
        '  <key>Label</key><string>com.baton.bridge</string>\n'
        '  <key>ProgramArguments</key><array>\n'
        '    <string>$NODE</string>\n'
        '    <string>$DIR/bridge.mjs</string>\n'
        f'    <string>--server</string><string>{server}</string>\n'
        f'    <string>--key</string><string>{api_key}</string>\n'
        '    <string>--name</string><string>$NAME</string>\n'
        '  </array>\n'
        '  <key>EnvironmentVariables</key>\n'
        '  <dict>\n'
        '    <key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n'
        '  </dict>\n'
        '  <key>RunAtLoad</key><true/>\n'
        '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n'
        '  <key>StandardOutPath</key><string>$DIR/bridge.log</string>\n'
        '  <key>StandardErrorPath</key><string>$DIR/bridge.log</string>\n'
        '</dict></plist>\n'
        'PLIST_EOF\n'
        '  launchctl unload "$PLIST" 2>/dev/null || true\n'
        '  launchctl load "$PLIST"\n'
        '  echo ""\n'
        '  echo "================================================================"\n'
        '  printf "  \\033[0;32mBridge installed and running successfully! (launchd)\\033[0m\\n"\n'
        '  echo "  Device: $NAME"\n'
        '  echo "  Logs:   $DIR/bridge.log"\n'
        '  echo "================================================================"\n'
        '  echo ""\n'
        '  echo "  Stop:    launchctl unload $PLIST"\n'
        '  echo "  Start:   launchctl load $PLIST"\n'
        '  echo "  Logs:    tail -f $DIR/bridge.log"\n'
        'else\n'
        '  # Linux: systemd\n'
        '  SERVICE_DIR="$HOME/.config/systemd/user"\n'
        '  mkdir -p "$SERVICE_DIR"\n'
        '  cat > "$SERVICE_DIR/baton-bridge.service" << SVC_EOF\n'
        '[Unit]\n'
        'Description=Baton Bridge\n'
        'After=network.target\n'
        '[Service]\n'
        'ExecStart=$NODE $DIR/bridge.mjs --server '
        f'{server} --key {api_key} --name $NAME\n'
        'Restart=on-failure\n'
        'RestartSec=5\n'
        'KillMode=process\n'
        '[Install]\n'
        'WantedBy=default.target\n'
        'SVC_EOF\n'
        '  sudo loginctl enable-linger $(whoami) 2>/dev/null || loginctl enable-linger $(whoami) 2>/dev/null || true\n'
        '  export XDG_RUNTIME_DIR=/run/user/$(id -u)\n'
        '  systemctl --user daemon-reload\n'
        '  systemctl --user enable baton-bridge\n'
        '  systemctl --user restart baton-bridge\n'
        '  echo ""\n'
        '  echo "================================================================"\n'
        '  printf "  \\033[0;32mBridge installed and running successfully! (systemd)\\033[0m\\n"\n'
        '  echo "  Device: $NAME"\n'
        '  echo "================================================================"\n'
        '  echo ""\n'
        '  echo "  Stop:    systemctl --user stop baton-bridge"\n'
        '  echo "  Start:   systemctl --user start baton-bridge"\n'
        '  echo "  Logs:    journalctl --user -u baton-bridge -f"\n'
        'fi\n'
    )
    return Response(content=script, media_type="text/plain")


@read_router.get("/image/{key}")
async def get_image(key: str):
    """Return JPEG as base64-encoded text (text/plain).
    The frontend (loadOneImage) reads it via res.text() and assembles a data: URL.
    Returning text avoids API Gateway binary-encoding pitfalls and is compatible with GZip middleware.
    """
    import base64
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return Response(status_code=500, content="BRIDGE_IMAGES_BUCKET not configured")
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    try:
        obj = s3.get_object(Bucket=bucket, Key=f"images/{key}")
        body = obj["Body"].read()
        return Response(content=base64.b64encode(body).decode("ascii"), media_type="text/plain")
    except s3.exceptions.NoSuchKey:
        return Response(status_code=404, content="Not found")
    except Exception as e:
        return Response(status_code=404, content=f"Not found: {e}")


@read_router.get("/file/{key}")
async def get_file(key: str):
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return Response(status_code=500, content="BRIDGE_IMAGES_BUCKET not configured")
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    try:
        obj = s3.get_object(Bucket=bucket, Key=f"files/{key}")
        body = obj["Body"].read()
        return Response(content=body, media_type="text/plain; charset=utf-8")
    except s3.exceptions.NoSuchKey:
        return Response(status_code=404, content="Not found")
    except Exception as e:
        return Response(status_code=404, content=f"Not found: {e}")


@read_router.get("/video-url/{key}")
async def get_video_url(key: str):
    """Return a short-lived presigned GET URL so the browser <video> element streams
    videos/{key} directly from S3 (with Range/seek), bypassing the Lambda 6MB limit."""
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return Response(status_code=500, content="BRIDGE_IMAGES_BUCKET not configured")
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    try:
        s3.head_object(Bucket=bucket, Key=f"videos/{key}")
    except Exception:
        return Response(status_code=404, content="Not found")
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": f"videos/{key}"},
        ExpiresIn=3600,
    )
    # Must NOT be cached by CloudFront — the presigned URL expires in 1h, but the
    # CDN's default GET cache is 1 day, which would serve a stale/expired signature.
    return Response(content=json.dumps({"url": url}), media_type="application/json",
                    headers={"Cache-Control": "no-store"})
