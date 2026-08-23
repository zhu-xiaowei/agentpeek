"""
WebSocket handler for Baton — manages connections, subscriptions, and message relay.
Deployed as a standalone Lambda (not in Docker), invoked by WebSocket API Gateway.
"""

import json
import os
import time
import hashlib
import boto3

_ddb = None
_connections_table = None
_subscriptions_table = None
_messages_table = None
_apigw = None

_STRICT_STREAM_ACTIONS = {
    "stream_turn_start",
    "stream_block_start",
    "stream_delta",
    "stream_tool_input",
    "stream_block_stop",
    "stream_end",
}

_ROOT_SUBSCRIPTION_PREFIX = "ROOT#"


def _root_subscription_id(root_session_id):
    return f"{_ROOT_SUBSCRIPTION_PREFIX}{root_session_id}"


def _requires_turn_sequence(body):
    action = body.get("action", "")
    return action in _STRICT_STREAM_ACTIONS or (
        action in ("messages", "permission_request", "permission_resolved")
        and "turnId" in body
    )


def _has_valid_turn_sequence(body):
    return (
        bool(body.get("sessionId"))
        and bool(body.get("turnId"))
        and isinstance(body.get("seq"), int)
        and not isinstance(body.get("seq"), bool)
        and body["seq"] >= 0
    )


def _init():
    global _ddb, _connections_table, _subscriptions_table, _messages_table
    if _ddb is None:
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-2"))
        _connections_table = _ddb.Table(os.environ["CONNECTIONS_TABLE"])
        _subscriptions_table = _ddb.Table(os.environ["SUBSCRIPTIONS_TABLE"])
        _messages_table = _ddb.Table(os.environ.get("BRIDGE_MESSAGES_TABLE", ""))


def _apigw_client(endpoint):
    global _apigw
    if _apigw is None:
        _apigw = boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)
    return _apigw


def _account_id(api_key):
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


def _runtime_session_fields(session_id):
    if session_id.startswith("codex:"):
        return {"runtime": "codex", "nativeSessionId": session_id[len("codex:"):]}
    return {"runtime": "claude", "nativeSessionId": session_id}


def _query_connections(account_id, role):
    """Query ConnectionsTable.accountId-role-index for active connections.
    Auto-paginates. Returns list of items with deviceName + connectionId."""
    from boto3.dynamodb.conditions import Key
    items = []
    kwargs = {
        "IndexName": "accountId-role-index",
        "KeyConditionExpression": Key("accountId").eq(account_id) & Key("role").eq(role),
    }
    resp = _connections_table.query(**kwargs)
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = _connections_table.query(ExclusiveStartKey=resp["LastEvaluatedKey"], **kwargs)
        items.extend(resp.get("Items", []))
    return items


def _post_to_connection(endpoint, connection_id, data):
    """Send data to a WebSocket connection. Returns False if connection is gone."""
    client = _apigw_client(endpoint)
    try:
        client.post_to_connection(ConnectionId=connection_id, Data=json.dumps(data).encode())
        return True
    except client.exceptions.GoneException:
        # Connection no longer exists — clean up
        _init()
        try:
            _connections_table.delete_item(Key={"connectionId": connection_id})
        except Exception:
            pass
        return False


def _log_turn_delivery(event, body, **fields):
    print("[turn-delivery] " + json.dumps({
        "event": event,
        "sessionId": body.get("sessionId", ""),
        "turnId": body.get("turnId", ""),
        "seq": body.get("seq"),
        "action": body.get("action", ""),
        **fields,
    }, separators=(",", ":")))


def _turn_event_targets(body, account_id, bridge_connection_id):
    session_id = body.get("sessionId", "")
    targets = set()
    subs = _subscriptions_table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("sessionId").eq(session_id),
        ConsistentRead=True,
    ).get("Items", [])
    for sub in subs:
        connection_id = sub.get("connectionId", "")
        if connection_id and connection_id != bridge_connection_id:
            targets.add(connection_id)

    reply_connection_id = body.get("replyConnectionId", "")
    if reply_connection_id \
            and reply_connection_id != bridge_connection_id \
            and reply_connection_id not in targets:
        reply_connection = _connections_table.get_item(
            Key={"connectionId": reply_connection_id},
            ConsistentRead=True,
        ).get("Item")
        if reply_connection \
                and reply_connection.get("role") == "app" \
                and reply_connection.get("accountId") == account_id:
            targets.add(reply_connection_id)
    return targets


def _relay_turn_event(body, account_id, bridge_connection_id, endpoint):
    payload = {
        key: value for key, value in body.items()
        if key not in ("replyConnectionId", "deliveryId", "noCache")
    }
    targets = _turn_event_targets(body, account_id, bridge_connection_id)
    gone = 0
    for connection_id in targets:
        if _post_to_connection(endpoint, connection_id, payload) is False:
            gone += 1

    if gone or body.get("action") == "stream_end":
        _log_turn_delivery(
            "relayed",
            body,
            targets=len(targets),
            gone=gone,
        )
    return payload


def handler(event, context):
    _init()
    route = event.get("requestContext", {}).get("routeKey", "")
    connection_id = event.get("requestContext", {}).get("connectionId", "")
    domain = event.get("requestContext", {}).get("domainName", "")
    stage = event.get("requestContext", {}).get("stage", "")
    endpoint = f"https://{domain}/{stage}"

    if route == "$connect":
        return _handle_connect(event, connection_id)
    elif route == "$disconnect":
        return _handle_disconnect(connection_id)
    elif route == "$default":
        return _handle_message(event, connection_id, endpoint)

    return {"statusCode": 400}


def _handle_connect(event, connection_id):
    """Store connection in DDB."""
    qs = event.get("queryStringParameters") or {}
    api_key = qs.get("apiKey", "")
    role = qs.get("role", "app")  # "app" or "bridge"
    device = qs.get("device", "")
    version = qs.get("version", "")

    if not api_key:
        return {"statusCode": 401}

    account_id = _account_id(api_key)
    ttl = int(time.time()) + 86400  # 24h

    item = {
        "connectionId": connection_id,
        "accountId": account_id,
        "role": role,
        "connectedAt": int(time.time()),
        "ttl": ttl,
    }
    if device:
        item["deviceName"] = device
    if role == "bridge" and version:
        item["bridgeVersion"] = version
    _connections_table.put_item(Item=item)

    return {"statusCode": 200}


def _handle_disconnect(connection_id):
    """Remove connection + any subscriptions."""
    try:
        _connections_table.delete_item(Key={"connectionId": connection_id})
    except Exception:
        pass

    # Clean up subscriptions via connectionId-index GSI (vs Scan over the whole table).
    try:
        from boto3.dynamodb.conditions import Key
        kwargs = {
            "IndexName": "connectionId-index",
            "KeyConditionExpression": Key("connectionId").eq(connection_id),
        }
        resp = _subscriptions_table.query(**kwargs)
        items = resp.get("Items", [])
        while "LastEvaluatedKey" in resp:
            resp = _subscriptions_table.query(ExclusiveStartKey=resp["LastEvaluatedKey"], **kwargs)
            items.extend(resp.get("Items", []))
        for item in items:
            _subscriptions_table.delete_item(Key={
                "sessionId": item["sessionId"],
                "connectionId": connection_id,
            })
    except Exception:
        pass

    return {"statusCode": 200}


def _handle_message(event, connection_id, endpoint):
    """Route messages by action."""
    try:
        body = json.loads(event.get("body", "{}"))
    except json.JSONDecodeError:
        return {"statusCode": 400}

    action = body.get("action", "")

    # Get connection info — if missing (e.g. DDB cleared), force reconnect.
    # Client's onclose handler will auto-reconnect → $connect rewrites the record.
    conn = _connections_table.get_item(Key={"connectionId": connection_id}).get("Item")
    if not conn:
        try:
            _apigw_client(endpoint).delete_connection(ConnectionId=connection_id)
        except Exception:
            pass
        return {"statusCode": 200}

    role = conn.get("role", "app")
    account_id = conn.get("accountId", "")
    if role == "bridge" and _requires_turn_sequence(body) \
            and not _has_valid_turn_sequence(body):
        return {"statusCode": 400}

    if action == "subscribe":
        return _handle_subscribe(body, connection_id, account_id, endpoint)
    elif action == "reveal_permission":
        if role == "app":
            session_id = body.get("sessionId", "")
            if not session_id:
                return {"statusCode": 400}
            _persist_subscription(session_id, connection_id, account_id)
            return _handle_send_to_bridge(
                body,
                account_id,
                endpoint,
                "reveal_permission",
            )
    elif action == "unsubscribe":
        return _handle_unsubscribe(body, connection_id)
    elif action == "messages":
        if role == "bridge":
            return _handle_bridge_messages(body, connection_id, account_id, endpoint)
    elif action == "sync_complete":
        if role == "bridge":
            return _handle_sync_complete(body, account_id, endpoint)
    elif action == "bridge_recovery_complete":
        if role == "bridge":
            return _handle_bridge_broadcast(body, account_id, connection_id, endpoint)
    elif action in ("permission_request", "permission_resolved"):
        if role == "bridge":
            return _handle_bridge_relay(
                body,
                account_id,
                connection_id,
                endpoint,
            )
    elif action == "send_message_result":
        if role == "bridge":
            return _handle_send_message_result(
                body,
                conn,
                account_id,
                connection_id,
                endpoint,
            )
    elif action == "send_message":
        if role == "app":
            return _handle_send_message(
                body,
                account_id,
                endpoint,
                connection_id,
            )
    elif action == "permission_reply":
        if role == "app":
            return _handle_send_to_bridge(body, account_id, endpoint, "permission_reply")
    elif action == "interrupt":
        if role == "app":
            return _handle_send_to_bridge(body, account_id, endpoint, "interrupt")
    elif action == "request_file":
        if role == "app":
            return _handle_send_to_bridge(body, account_id, endpoint, "request_file")
    elif action == "delete_files":
        if role == "app":
            return _handle_send_to_bridge(body, account_id, endpoint, "delete_files")
    elif action == "delete_files_result":
        if role == "bridge":
            return _handle_bridge_broadcast(body, account_id, connection_id, endpoint)
    elif action in ("file_ready", "file_progress"):
        if role == "bridge":
            return _handle_bridge_relay(
                body,
                account_id,
                connection_id,
                endpoint,
            )
    elif action == "list_commands":
        if role == "app":
            return _handle_send_to_bridge(
                body,
                account_id,
                endpoint,
                "list_commands",
                preserve_device=True,
            )
    elif action == "list_command_options":
        if role == "app":
            return _handle_send_to_bridge(
                body,
                account_id,
                endpoint,
                "list_command_options",
                preserve_device=True,
            )
    elif action == "commands_list":
        if role == "bridge":
            return _handle_bridge_broadcast(body, account_id, connection_id, endpoint)
    elif action == "command_options":
        if role == "bridge":
            return _handle_bridge_broadcast(body, account_id, connection_id, endpoint)
    elif action in (
        "stream_turn_start",
        "stream_delta",
        "stream_tool_input",
        "stream_block_start",
        "stream_block_stop",
        "stream_end",
    ):
        # Headless streaming preview — relay to subscribed apps, never write DDB
        # (authoritative message still lands via the `messages` action).
        if role == "bridge":
            return _handle_bridge_relay(
                body,
                account_id,
                connection_id,
                endpoint,
            )
    elif action == "create_project":
        if role == "app":
            if not body.get("projectPath"):
                return {"statusCode": 400}
            return _handle_send_to_bridge(body, account_id, endpoint, "create_project")
    elif action == "create_project_result":
        if role == "bridge":
            return _handle_bridge_broadcast(body, account_id, connection_id, endpoint)
    elif action == "heartbeat":
        # Update TTL
        _connections_table.update_item(
            Key={"connectionId": connection_id},
            UpdateExpression="SET #t = :ttl",
            ExpressionAttributeNames={"#t": "ttl"},
            ExpressionAttributeValues={":ttl": int(time.time()) + 86400},
        )
        _post_to_connection(endpoint, connection_id, {"action": "heartbeat", "ts": int(time.time())})
        return {"statusCode": 200}

    return {"statusCode": 200}


def _handle_subscribe(body, connection_id, account_id, endpoint):
    """App subscribes to a session."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    _persist_subscription(session_id, connection_id, account_id)
    root_session_id = body.get("rootSessionId", "")
    if root_session_id:
        _persist_subscription(
            _root_subscription_id(root_session_id),
            connection_id,
            account_id,
        )

    return {"statusCode": 200}


def _persist_subscription(session_id, connection_id, account_id):
    item = {
        "sessionId": session_id,
        "connectionId": connection_id,
        "accountId": account_id,
        "subscribedAt": int(time.time()),
        "ttl": int(time.time()) + 86400,
    }
    _subscriptions_table.put_item(Item=item)


def _handle_unsubscribe(body, connection_id):
    """App unsubscribes from a session."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    _subscriptions_table.delete_item(Key={
        "sessionId": session_id,
        "connectionId": connection_id,
    })
    root_session_id = body.get("rootSessionId", "")
    if root_session_id:
        _subscriptions_table.delete_item(Key={
            "sessionId": _root_subscription_id(root_session_id),
            "connectionId": connection_id,
        })

    return {"statusCode": 200}


def _handle_bridge_messages(body, bridge_connection_id, account_id, endpoint):
    """Bridge pushes new messages — relay to subscribed apps + write DDB."""
    session_id = body.get("sessionId", "")
    messages = body.get("messages", [])
    if not session_id or not messages:
        return {"statusCode": 400}

    # 1. Relay to subscribed apps (priority — low latency).
    if body.get("turnId") and body.get("seq") is not None:
        _relay_turn_event(
            {**body, "action": "messages"},
            account_id,
            bridge_connection_id,
            endpoint,
        )
    else:
        subs = _subscriptions_table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("sessionId").eq(session_id),
            ConsistentRead=True,
        ).get("Items", [])
        for sub in subs:
            cid = sub.get("connectionId", "")
            if cid and cid != bridge_connection_id:
                _post_to_connection(endpoint, cid, {
                    "action": "messages",
                    "sessionId": session_id,
                    "messages": messages,
                })

    # 2. Write to DDB (cache) with one retry.
    # Skip when the bridge flags noCache: it sent a truncated copy over WS (to fit
    # the 32KB frame cap) and is writing the full copy to DDB itself via HTTP, so
    # caching the truncated version here would clobber it.
    if not body.get("noCache"):
        if not _messages_table:
            return {"statusCode": 500}
        persisted = False
        for attempt in range(2):
            try:
                from datetime import datetime
                with _messages_table.batch_writer() as batch:
                    for msg in messages:
                        uuid = msg.get("uuid", "")
                        if not uuid:
                            continue
                        timestamp = msg.get("timestamp", datetime.utcnow().isoformat())
                        item = {
                            "sessionId": session_id,
                            "sk": f"{timestamp}#{uuid}",
                            "uuid": uuid,
                            "type": msg.get("type", ""),
                            "content": json.dumps(
                                msg.get("content", ""),
                                ensure_ascii=False,
                            ),
                            "timestamp": timestamp,
                            "ttl": int(time.time()) + 90 * 86400,  # 90-day expiry (matches sync_messages)
                        }
                        if msg.get("nativeId"):
                            item["nativeId"] = msg["nativeId"]
                        if msg.get("stopReason"):
                            item["stopReason"] = msg["stopReason"]
                        if msg.get("toolUseResult"):
                            item["toolUseResult"] = json.dumps(msg["toolUseResult"], ensure_ascii=False)
                        batch.put_item(Item=item)
                persisted = True
                break
            except Exception as e:
                if attempt == 0:
                    print(f"DDB write error (retrying): {e}")
                else:
                    print(f"DDB write error (gave up): {e}")
        if not persisted:
            # Do not ack: the Bridge will time out and persist the same
            # deterministic rows through the HTTP fallback before advancing.
            return {"statusCode": 500}

    # 3. Ack back to bridge so it can advance synced position
    ack = {
        "action": "messages_ack",
        "sessionId": session_id,
    }
    if body.get("deliveryId"):
        ack["deliveryId"] = body["deliveryId"]
    _post_to_connection(endpoint, bridge_connection_id, ack)

    return {"statusCode": 200}


def _handle_sync_complete(body, account_id, endpoint):
    """Bridge completed on-demand sync — broadcast to account apps.
    Not subscription-based: the app's subscribe may not have landed in DDB yet
    (sync_complete can return within the WS handshake window), which would drop
    the message and leave the app on the skeleton forever."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    for item in _query_connections(account_id, "app"):
        _post_to_connection(endpoint, item["connectionId"], {
            "action": "sync_complete",
            "sessionId": session_id,
            "status": body.get("status", "ok"),
            "count": body.get("count", 0),
        })

    return {"statusCode": 200}


def _handle_bridge_relay(body, account_id, bridge_connection_id, endpoint):
    """Bridge pushes a notification (e.g. permission_request) — relay to subscribed apps."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    _relay_turn_event(body, account_id, bridge_connection_id, endpoint)

    return {"statusCode": 200}


def _handle_bridge_broadcast(body, account_id, bridge_connection_id, endpoint):
    """Bridge sends a result — broadcast to all app connections for this account."""
    for item in _query_connections(account_id, "app"):
        _post_to_connection(endpoint, item["connectionId"], body)
    return {"statusCode": 200}


def notify_session_threads_changed(account_id, endpoint, device_name, roots):
    """Push an authoritative thread-cache invalidation after REST persistence."""
    if not endpoint or not roots:
        return 0
    _init()
    from boto3.dynamodb.conditions import Key
    roots_by_connection = {}
    for root in roots:
        root_session_id = root.get("rootSessionId", "")
        if not root_session_id:
            continue
        kwargs = {
            "KeyConditionExpression": Key("sessionId").eq(
                _root_subscription_id(root_session_id)
            ),
            "ConsistentRead": True,
        }
        response = _subscriptions_table.query(**kwargs)
        subscriptions = response.get("Items", [])
        while "LastEvaluatedKey" in response:
            response = _subscriptions_table.query(
                ExclusiveStartKey=response["LastEvaluatedKey"],
                **kwargs,
            )
            subscriptions.extend(response.get("Items", []))
        for subscription in subscriptions:
            if subscription.get("accountId") != account_id:
                continue
            connection_id = subscription.get("connectionId", "")
            if connection_id:
                roots_by_connection.setdefault(connection_id, []).append(root)

    delivered = 0
    for connection_id, subscribed_roots in roots_by_connection.items():
        payload = {
            "action": "session_threads_changed",
            "deviceName": device_name,
            "roots": subscribed_roots,
        }
        if _post_to_connection(endpoint, connection_id, payload):
            delivered += 1
    return delivered


def _handle_send_message_result(
    body,
    bridge_connection,
    account_id,
    bridge_connection_id,
    endpoint,
):
    """Subscribe and reply directly to the app that created a new session."""
    payload = dict(body)
    reply_connection_id = payload.pop("replyConnectionId", "")
    if bridge_connection.get("deviceName"):
        payload["deviceName"] = bridge_connection["deviceName"]

    if not reply_connection_id:
        return _handle_bridge_broadcast(
            payload,
            account_id,
            bridge_connection_id,
            endpoint,
        )

    reply_connection = _connections_table.get_item(
        Key={"connectionId": reply_connection_id},
    ).get("Item")
    if not reply_connection \
            or reply_connection.get("role") != "app" \
            or reply_connection.get("accountId") != account_id:
        return {"statusCode": 200}

    session_id = payload.get("sessionId", "")
    if payload.get("ok") and session_id:
        _persist_subscription(session_id, reply_connection_id, account_id)
    _post_to_connection(endpoint, reply_connection_id, payload)
    return {"statusCode": 200}


def _handle_send_message(body, account_id, endpoint, connection_id=""):
    """App sends a message to Claude Code via bridge — forward to bridge connection."""
    session_id = body.get("sessionId", "")
    project_hash = body.get("projectHash", "")
    text = body.get("text", "")
    if (not session_id and not project_hash) or not text:
        return {"statusCode": 400}
    payload = dict(body)
    if connection_id:
        payload["replyConnectionId"] = connection_id
        _post_to_connection(endpoint, connection_id, {
            "action": "send_message_received",
            "turnId": payload.get("turnId", ""),
            "requestId": payload.get("requestId", ""),
        })
    return _handle_send_to_bridge(
        payload,
        account_id,
        endpoint,
        "send_message",
    )


def _handle_send_to_bridge(
    body,
    account_id,
    endpoint,
    action,
    preserve_device=False,
):
    """Forward an action to bridge connection(s) for this account. If device is specified, only forward to that device's bridge."""
    device = body.get("device", "")
    payload = {k: v for k, v in body.items() if k != "device"}
    payload["action"] = action
    if preserve_device and device:
        payload["device"] = device
    delivered = 0
    for item in _query_connections(account_id, "bridge"):
        if device and item.get("deviceName", "") != device:
            continue
        if _post_to_connection(endpoint, item["connectionId"], payload) is not False:
            delivered += 1
    if action == "send_message" and delivered == 0:
        reply_connection_id = payload.get("replyConnectionId", "")
        if reply_connection_id:
            _post_to_connection(endpoint, reply_connection_id, {
                "action": "send_message_result",
                "ok": False,
                "turnId": payload.get("turnId", ""),
                "requestId": payload.get("requestId", ""),
                "error": "Bridge offline — retry when the device reconnects",
                "errorCode": "bridge_offline",
            })
    return {"statusCode": 200}


def notify_bridge_sync(session_id, account_id, endpoint, device=None):
    """Called by REST API to trigger bridge sync via WS. Sends sync_session only to
    the matching device's bridge (if device given), else all bridges."""
    _init()
    for item in _query_connections(account_id, "bridge"):
        if device and item.get("deviceName", "") != device:
            continue
        _post_to_connection(endpoint, item["connectionId"], {
            "action": "sync_session",
            "sessionId": session_id,
            **_runtime_session_fields(session_id),
        })
