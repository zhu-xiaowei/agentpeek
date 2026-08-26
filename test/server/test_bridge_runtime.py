import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
import sys
import threading
from contextlib import contextmanager
from types import SimpleNamespace

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"),
)

import bridge_sync
import bridge_read
import bridge_ws


class FakeBatch:
    def __init__(self, table):
        self.table = table

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def put_item(self, Item):
        self.table.items.append(Item)

    def delete_item(self, Key):
        self.table.deleted.append(Key)


class FakeTable:
    def __init__(self):
        self.items = []
        self.deleted = []
        self.updates = []

    def batch_writer(self):
        return FakeBatch(self)

    def put_item(self, Item, **_):
        self.items.append(Item)

    def get_item(self, Key, **_):
        item = next((
            item for item in reversed(self.items)
            if item.get("accountId") == Key["accountId"] and item.get("sk") == Key["sk"]
        ), None)
        return {"Item": item} if item else {}

    def update_item(self, **kwargs):
        self.updates.append(kwargs)

    def query(self, **_kwargs):
        return {"Items": []}


class FakeRequest:
    headers = {"x-api-key": "test-key"}


class FakeMessageTable:
    def __init__(self, items):
        self.items = sorted(items, key=lambda item: item["sk"])

    def query(self, Limit=None, ScanIndexForward=True, ExclusiveStartKey=None, **kwargs):
        items = self.items
        condition = kwargs.get("KeyConditionExpression")
        expression = condition.get_expression() if condition else {}
        if expression.get("operator") == "AND":
            sort_expression = expression["values"][1].get_expression()
            if sort_expression.get("operator") == "<":
                cursor = sort_expression["values"][1]
                items = [item for item in items if item["sk"] < cursor]
        items = list(reversed(items)) if not ScanIndexForward else list(items)
        start = 0
        if ExclusiveStartKey:
            start = next(i for i, item in enumerate(items) if item["sk"] == ExclusiveStartKey["sk"]) + 1
        limit = Limit or len(items)
        page = items[start:start + limit]
        response = {"Items": page}
        if start + limit < len(items):
            response["LastEvaluatedKey"] = {"sessionId": "session", "sk": page[-1]["sk"]}
        return response


def test_session_id_compatibility():
    assert bridge_sync._session_ids("claude", "abc") == ("claude", "abc", "abc")
    assert bridge_sync._session_ids("", "abc") == ("claude", "abc", "abc")
    assert bridge_sync._session_ids("codex", "abc") == ("codex", "abc", "codex:abc")
    assert bridge_sync._session_ids("codex", "codex:abc") == ("codex", "abc", "codex:abc")


def test_old_session_payload_defaults_to_claude():
    item = bridge_sync.SessionItem(
        id="old-id",
        project="-tmp-project",
        lastActive="2026-08-06T00:00:00.000Z",
    )
    assert item.runtime == "claude"
    assert item.nativeSessionId == ""


def test_runtime_fields_default_old_items_to_claude():
    assert bridge_read._runtime_fields({"sessionId": "old-id"}) == {
        "runtime": "claude",
        "nativeSessionId": "old-id",
    }
    assert bridge_read._runtime_fields({"sessionId": "codex:new-id", "runtime": "codex"}) == {
        "runtime": "codex",
        "nativeSessionId": "new-id",
    }


def test_old_device_gets_claude_capability():
    capabilities = bridge_read._runtime_capabilities({})
    assert list(capabilities) == ["claude"]
    assert capabilities["claude"]["canCreate"] is True


def test_device_name_validation():
    devices = [
        {"deviceName": "Mac", "deviceDisplayName": "Office-Mac"},
        {"deviceName": "Linux"},
    ]
    assert bridge_read._check_device_name(devices, "dev-01", "identity") == ("dev-01", "")
    assert bridge_read._check_device_name(devices, "bad name", "identity")[1] == bridge_read.INVALID_INTERNAL_NAME
    assert bridge_read._check_device_name(devices, "office-mac", "identity")[1] == bridge_read.DUPLICATE_DEVICE_NAME
    assert bridge_read._check_device_name(devices, " 小伟的 Mac ", "display", "Mac") == ("小伟的 Mac", "")
    assert bridge_read._check_device_name(devices, "Linux", "display", "Mac")[1] == bridge_read.DUPLICATE_DEVICE_NAME
    assert bridge_read._check_device_name(devices, "x" * 33, "display")[1] == bridge_read.INVALID_DISPLAY_NAME


def test_active_session_visibility_filters_offline_and_stale_needs_input():
    now = datetime(2026, 8, 19, 12, 0, tzinfo=timezone.utc)
    online = {"Mac"}

    assert bridge_read._active_session_visible({
        "deviceName": "Mac",
        "status": "running",
        "lastActive": (now - timedelta(days=30)).isoformat(),
    }, online, now)
    assert not bridge_read._active_session_visible({
        "deviceName": "OfflineMac",
        "status": "running",
        "lastActive": now.isoformat(),
    }, online, now)
    assert bridge_read._active_session_visible({
        "deviceName": "Mac",
        "status": "needs_input",
        "lastActive": (now - timedelta(days=7)).isoformat(),
    }, online, now)
    assert not bridge_read._active_session_visible({
        "deviceName": "Mac",
        "status": "needs_input",
        "lastActive": (now - timedelta(days=7, seconds=1)).isoformat(),
    }, online, now)


def test_active_session_visibility_falls_back_to_last_active_and_keeps_unknown_time():
    now = datetime(2026, 8, 19, 12, 0, tzinfo=timezone.utc)

    assert not bridge_read._active_session_visible({
        "deviceName": "Mac",
        "status": "needs_input",
        "lastActive": "2026-08-01T00:00:00.000Z",
    }, {"Mac"}, now)
    assert bridge_read._active_session_visible({
        "deviceName": "Mac",
        "status": "needs_input",
        "lastActive": "not-a-time",
    }, {"Mac"}, now)
    assert bridge_read._active_session_visible({
        "deviceName": "Mac",
        "status": "running",
    }, None, now)


def test_ws_sync_payload_decodes_storage_id():
    assert bridge_ws._runtime_session_fields("old-id") == {
        "runtime": "claude",
        "nativeSessionId": "old-id",
    }
    assert bridge_ws._runtime_session_fields("codex:new-id") == {
        "runtime": "codex",
        "nativeSessionId": "new-id",
    }


def test_sync_sessions_writes_separate_runtime_keys(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Mac",
        sessions=[
            bridge_sync.SessionItem(
                id="same-id",
                runtime="claude",
                project="-repo",
                lastActive="2026-08-06T00:00:00.000Z",
                status="needs_input",
                agentDetail="Allow writing the test file?",
            ),
            bridge_sync.SessionItem(
                id="same-id",
                runtime="codex",
                project="-repo",
                lastActive="2026-08-06T00:00:00.000Z",
                modelProvider="openai",
                clientSource="codex-tui",
            ),
        ],
    )
    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))
    by_runtime = {item["runtime"]: item for item in sessions.items}
    assert by_runtime["claude"]["sk"].endswith("#same-id")
    assert by_runtime["claude"]["agentDetail"] == "Allow writing the test file?"
    assert by_runtime["codex"]["sk"].endswith("#codex:same-id")
    assert by_runtime["codex"]["sessionId"] == "codex:same-id"
    assert by_runtime["codex"]["nativeSessionId"] == "same-id"
    assert by_runtime["codex"]["modelProvider"] == "openai"


def test_sync_sessions_persists_subagent_relationship(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Linux",
        sessions=[bridge_sync.SessionItem(
            id="codex:child",
            nativeSessionId="child",
            runtime="codex",
            project="-repo",
            lastActive="2026-08-21T00:00:00.000Z",
            isAgent=True,
            agentName="Worker",
            agentRole="explorer",
            threadKind="subagent",
            parentSessionId="codex:parent",
            agentPath="/root/worker",
            agentDepth=1,
            canSend=True,
            threadRootId="codex:parent",
        )],
    )
    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))
    child = sessions.items[0]
    assert child["parentSessionId"] == "codex:parent"
    assert child["threadKind"] == "subagent"
    assert child["agentName"] == "Worker"
    assert child["agentRole"] == "explorer"
    assert child["agentPath"] == "/root/worker"
    assert child["agentDepth"] == 1
    assert child["canSend"] is True
    assert child["threadRootId"] == "codex:parent"
    assert child["threadRootPk"].endswith("#THREAD#Linux#-repo#codex:parent")
    assert child["threadRootSk"] == "codex:child"
    assert "listPk" not in child
    assert "listSk" not in child
    assert "activeStatus" not in child


def test_collect_session_tree_sks_handles_standalone_and_nested_sessions():
    rows = [{
        "sk": "SESS#Linux#-repo#standalone",
        "sessionId": "standalone",
    }, {
        "sk": "SESS#Linux#-repo#root",
        "sessionId": "root",
    }, {
        "sk": "SESS#Linux#-repo#child-a",
        "sessionId": "child-a",
        "parentSessionId": "root",
    }, {
        "sk": "SESS#Linux#-repo#grandchild",
        "sessionId": "grandchild",
        "parentSessionId": "child-a",
    }, {
        "sk": "SESS#Linux#-repo#other",
        "sessionId": "other",
    }]

    assert bridge_sync._collect_session_tree_sks(rows, ["standalone"]) == {
        "SESS#Linux#-repo#standalone",
    }
    assert bridge_sync._collect_session_tree_sks(rows, ["root"]) == {
        "SESS#Linux#-repo#root",
        "SESS#Linux#-repo#child-a",
        "SESS#Linux#-repo#grandchild",
    }


def test_delete_session_deletes_all_nested_children_only(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    rows = [{
        "sk": "SESS#Linux#-repo#root",
        "sessionId": "root",
    }, {
        "sk": "SESS#Linux#-repo#child-a",
        "sessionId": "child-a",
        "parentSessionId": "root",
    }, {
        "sk": "SESS#Linux#-repo#grandchild",
        "sessionId": "grandchild",
        "parentSessionId": "child-a",
    }, {
        "sk": "SESS#Linux#-repo#other",
        "sessionId": "other",
    }]
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    monkeypatch.setattr(bridge_sync, "_query_all", lambda *_args, **_kwargs: rows)
    monkeypatch.setattr(
        bridge_sync,
        "_reconcile_device",
        lambda *_args, **_kwargs: {"sessionCount": 1, "projectCount": 1},
    )

    result = asyncio.run(bridge_sync.delete_sessions(
        bridge_sync.DeleteRequest(deviceName="Linux", sessionIds=["root"]),
        FakeRequest(),
    ))

    assert {item["sk"] for item in sessions.deleted} == {
        "SESS#Linux#-repo#root",
        "SESS#Linux#-repo#child-a",
        "SESS#Linux#-repo#grandchild",
    }
    assert result["deletedSessions"] == 3


def test_sync_sessions_persists_preserves_and_exactly_updates_agent_count(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    root = dict(
        id="codex:parent",
        nativeSessionId="parent",
        runtime="codex",
        project="-repo",
        lastActive="2026-08-21T00:00:00.000Z",
    )

    asyncio.run(bridge_sync.sync_sessions(
        bridge_sync.SyncSessionsRequest(
            deviceName="Linux",
            sessions=[bridge_sync.SessionItem(
                **root,
                agentCount=2,
                runningAgentCount=1,
                needsInputAgentCount=0,
                threadRootId="codex:parent",
            )],
        ),
        FakeRequest(),
    ))
    assert sessions.items[-1]["agentCount"] == 2
    assert sessions.items[-1]["runningAgentCount"] == 1
    assert sessions.items[-1]["activeStatus"] == "running"
    assert sessions.items[-1]["threadRootId"] == "codex:parent"

    asyncio.run(bridge_sync.sync_sessions(
        bridge_sync.SyncSessionsRequest(
            deviceName="Linux",
            sessions=[bridge_sync.SessionItem(**root, status="needs_input")],
            statusDeltas=[bridge_sync.StatusDelta(
                deviceName="Linux",
                projectHash="-repo",
                from_="completed",
                to="needs_input",
                lastActive=root["lastActive"],
            )],
        ),
        FakeRequest(),
    ))
    assert sessions.items[-1]["agentCount"] == 2
    assert sessions.items[-1]["runningAgentCount"] == 1
    assert sessions.items[-1]["needsInputAgentCount"] == 0
    assert sessions.items[-1]["status"] == "needs_input"
    assert sessions.items[-1]["activeStatus"] == "needs_input"
    assert sessions.items[-1]["threadRootId"] == "codex:parent"
    assert sessions.items[-1]["threadRootSk"] == "codex:parent"
    counter_updates = [
        update for update in sessions.updates
        if update["UpdateExpression"].startswith("ADD runningCount")
    ]
    assert counter_updates
    assert counter_updates[0]["ExpressionAttributeValues"][":dr"] == -1
    assert counter_updates[0]["ExpressionAttributeValues"][":di"] == 1


def test_child_status_summary_updates_root_active_status_and_counters(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    notifications = []
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    monkeypatch.setattr(
        bridge_sync,
        "_broadcast_session_thread_changes",
        lambda account_id, device_name, roots: notifications.append(
            (account_id, device_name, roots)
        ),
    )
    account_id = bridge_sync._hash_key("test-key")
    sessions.items.append({
        "accountId": account_id,
        "sk": "SESS#Linux#-repo#codex:parent",
        "entityType": "session",
        "deviceName": "Linux",
        "projectHash": "-repo",
        "projectName": "repo",
        "sessionId": "codex:parent",
        "status": "completed",
        "activeStatus": "done#2026-08-21T00:00:00.000Z",
        "lastActive": "2026-08-21T00:00:00.000Z",
        "agentCount": 0,
        "runningAgentCount": 0,
        "needsInputAgentCount": 0,
    })

    asyncio.run(bridge_sync.sync_sessions(
        bridge_sync.SyncSessionsRequest(
            deviceName="Linux",
            sessions=[],
            agentCountUpdates=[bridge_sync.AgentCountUpdate(
                sessionId="codex:parent",
                project="-repo",
                agentCount=1,
                runningAgentCount=1,
                needsInputAgentCount=0,
            )],
        ),
        FakeRequest(),
    ))

    root_update = next(
        update for update in sessions.updates
        if update["Key"]["sk"] == "SESS#Linux#-repo#codex:parent"
    )
    values = root_update["ExpressionAttributeValues"]
    assert values[":count"] == 1
    assert values[":running"] == 1
    assert values[":needs"] == 0
    assert values[":active"] == "running"
    counter_updates = [
        update for update in sessions.updates
        if update["UpdateExpression"].startswith("ADD runningCount")
    ]
    assert counter_updates[0]["ExpressionAttributeValues"][":dr"] == 1
    assert notifications == [(
        account_id,
        "Linux",
        [{
            "projectHash": "-repo",
            "rootSessionId": "codex:parent",
            "agentCount": 1,
            "runningAgentCount": 1,
            "needsInputAgentCount": 0,
        }],
    )]


def test_session_thread_notification_targets_root_subscribers(monkeypatch):
    delivered = []

    class SubscriptionTable:
        def query(self, **kwargs):
            expression = kwargs["KeyConditionExpression"].get_expression()
            root_key = expression["values"][1]
            assert root_key == "ROOT#codex:parent"
            return {"Items": [
                {"connectionId": "app-1", "accountId": "account"},
                {"connectionId": "other-account", "accountId": "other"},
                {"connectionId": "app-2", "accountId": "account"},
            ]}

    monkeypatch.setattr(bridge_ws, "_init", lambda: None)
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, payload: delivered.append(
            (endpoint, connection_id, payload)
        ) or True,
    )

    roots = [{
        "projectHash": "-repo",
        "rootSessionId": "codex:parent",
        "agentCount": 2,
        "runningAgentCount": 1,
        "needsInputAgentCount": 1,
    }]
    count = bridge_ws.notify_session_threads_changed(
        "account",
        "https://ws.example/v1",
        "Linux",
        roots,
    )

    assert count == 2
    assert delivered == [
        ("https://ws.example/v1", "app-1", {
            "action": "session_threads_changed",
            "deviceName": "Linux",
            "roots": roots,
        }),
        ("https://ws.example/v1", "app-2", {
            "action": "session_threads_changed",
            "deviceName": "Linux",
            "roots": roots,
        }),
    ]


def test_effective_status_prioritizes_needs_input_across_main_and_children():
    assert bridge_sync._effective_status("completed", 0, 0) == "completed"
    assert bridge_sync._effective_status("completed", 2, 0) == "running"
    assert bridge_sync._effective_status("completed", 2, 1) == "needs_input"
    assert bridge_sync._effective_status("running", 0, 1) == "needs_input"
    assert bridge_sync._effective_status("needs_input", 3, 0) == "needs_input"


def test_new_root_session_updates_device_and_project_once(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))

    asyncio.run(bridge_sync.sync_sessions(
        bridge_sync.SyncSessionsRequest(
            deviceName="Linux",
            sessions=[bridge_sync.SessionItem(
                id="codex:new-root",
                nativeSessionId="new-root",
                runtime="codex",
                project="-repo",
                projectName="repo",
                lastActive="2026-08-21T00:00:00.000Z",
                status="running",
                agentCount=0,
                runningAgentCount=0,
                needsInputAgentCount=0,
                threadRootId="codex:new-root",
            )],
            statusDeltas=[bridge_sync.StatusDelta(
                deviceName="Linux",
                projectHash="-repo",
                projectName="repo",
                from_="new",
                to="running",
                lastActive="2026-08-21T00:00:00.000Z",
            )],
        ),
        FakeRequest(),
    ))

    root = sessions.items[-1]
    assert root["status"] == "running"
    assert root["activeStatus"] == "running"
    counter_updates = [
        update for update in sessions.updates
        if update["UpdateExpression"].startswith("ADD runningCount")
    ]
    assert len(counter_updates) == 2
    assert all(update["ExpressionAttributeValues"][":dr"] == 1 for update in counter_updates)
    assert all(update["ExpressionAttributeValues"][":ds"] == 1 for update in counter_updates)


def test_live_counts_use_root_effective_status_and_ignore_children(monkeypatch):
    rows = [{
        "deviceName": "Linux",
        "projectHash": "-repo",
        "status": "completed",
        "activeStatus": "running",
    }, {
        "deviceName": "Linux",
        "projectHash": "-repo",
        "status": "running",
        "activeStatus": "needs_input",
    }, {
        "deviceName": "Linux",
        "projectHash": "-repo",
        "status": "running",
        "activeStatus": "running",
        "parentSessionId": "root",
    }]
    monkeypatch.setattr(bridge_read, "_query_all", lambda *_args, **_kwargs: rows)

    device_counts, project_counts = bridge_read._live_active_counts(object(), "account")

    assert device_counts["Linux"] == {"running": 1, "needs_input": 1}
    assert project_counts[("Linux", "-repo")] == {"running": 1, "needs_input": 1}


def test_reconcile_counts_only_root_effective_statuses(monkeypatch):
    sessions = FakeTable()
    account_id = bridge_sync._hash_key("test-key")
    rows = [{
        "accountId": account_id,
        "sk": "SESS#Linux#-repo#root-running",
        "sessionId": "root-running",
        "projectHash": "-repo",
        "projectName": "repo",
        "lastActive": "2026-08-21T00:00:00.000Z",
        "status": "completed",
        "activeStatus": "running",
    }, {
        "accountId": account_id,
        "sk": "SESS#Linux#-repo#root-needs",
        "sessionId": "root-needs",
        "projectHash": "-repo",
        "projectName": "repo",
        "lastActive": "2026-08-21T00:00:01.000Z",
        "status": "needs_input",
        "activeStatus": "needs_input",
    }, {
        "accountId": account_id,
        "sk": "SESS#Linux#-repo#child",
        "sessionId": "child",
        "projectHash": "-repo",
        "lastActive": "2026-08-21T00:00:02.000Z",
        "status": "running",
        "parentSessionId": "root-running",
        "activeStatus": "running",
    }]
    monkeypatch.setattr(bridge_sync, "_query_all", lambda *_args, **_kwargs: rows)

    result = bridge_sync._reconcile_device(
        sessions, account_id, "Linux", "linux", prune=True
    )

    project = next(item for item in sessions.items if item.get("entityType") == "project")
    assert project["sessionCount"] == 2
    assert project["runningCount"] == 1
    assert project["idleCount"] == 1
    assert result["sessionCount"] == 2
    assert result["runningCount"] == 1
    assert result["idleCount"] == 1


def test_session_threads_returns_root_and_children(monkeypatch):
    items = [{
        "accountId": "account",
        "sessionId": "codex:root",
        "nativeSessionId": "root",
        "runtime": "codex",
        "preview": "Root",
        "status": "running",
        "lastActive": "2026-08-21T00:00:00.000Z",
        "size": 2048,
        "agentCount": 3,
    }, {
        "accountId": "account",
        "sessionId": "codex:child",
        "nativeSessionId": "child",
        "runtime": "codex",
        "preview": "Child",
        "status": "completed",
        "lastActive": "2026-08-21T00:00:01.000Z",
        "threadKind": "subagent",
        "parentSessionId": "codex:root",
        "agentName": "Worker",
        "agentRole": "explorer",
        "agentPath": "/root/worker",
        "agentDepth": 1,
        "canSend": True,
    }, {
        "accountId": "account",
        "sessionId": "codex:recent-child",
        "nativeSessionId": "recent-child",
        "runtime": "codex",
        "preview": "Recent child",
        "status": "completed",
        "lastActive": "2026-08-21T00:00:02.000Z",
        "threadKind": "subagent",
        "parentSessionId": "codex:root",
        "agentName": "Recent worker",
        "agentDepth": 1,
        "canSend": True,
    }, {
        "accountId": "account",
        "sessionId": "codex:grandchild",
        "nativeSessionId": "grandchild",
        "runtime": "codex",
        "preview": "Grandchild",
        "status": "running",
        "lastActive": "2026-08-21T00:00:03.000Z",
        "threadKind": "subagent",
        "parentSessionId": "codex:child",
        "agentName": "Nested worker",
        "agentDepth": 2,
        "canSend": True,
    }, {
        "accountId": "account",
        "sessionId": "codex:guardian",
        "nativeSessionId": "guardian",
        "runtime": "codex",
        "preview": "Internal review",
        "status": "completed",
        "lastActive": "2026-08-21T00:00:02.000Z",
        "threadKind": "internal",
        "parentSessionId": "codex:root",
        "canSend": False,
    }]
    query_calls = []

    def query_all(*_args, **kwargs):
        query_calls.append(kwargs)
        return items

    monkeypatch.setattr(bridge_read, "_tables", lambda: (FakeTable(), FakeTable()))
    monkeypatch.setattr(bridge_read, "_query_all", query_all)

    result = asyncio.run(bridge_read.get_session_threads(
        FakeRequest(),
        device="Linux",
        project="-repo",
        session="codex:root",
    ))
    assert [thread["sessionId"] for thread in result["threads"]] == [
        "codex:root",
        "codex:recent-child",
        "codex:child",
        "codex:grandchild",
    ]
    assert result["threads"][0]["size"] == 2048
    assert result["threads"][1]["parentSessionId"] == "codex:root"
    assert result["threads"][2]["parentSessionId"] == "codex:root"
    assert result["threads"][2]["agentRole"] == "explorer"
    assert result["threads"][2]["canSend"] is True
    assert result["threads"][3]["parentSessionId"] == "codex:child"
    assert result["threads"][3]["agentDepth"] == 2
    assert len(query_calls) == 1
    assert query_calls[0]["IndexName"] == bridge_read.THREAD_ROOT_INDEX_NAME


def test_session_threads_falls_back_while_root_index_is_incomplete(monkeypatch):
    root = {
        "accountId": "account",
        "sessionId": "codex:root",
        "nativeSessionId": "root",
        "runtime": "codex",
        "preview": "Root",
        "status": "completed",
        "lastActive": "2026-08-21T00:00:00.000Z",
        "agentCount": 1,
    }
    child = {
        "accountId": "account",
        "sessionId": "codex:child",
        "nativeSessionId": "child",
        "runtime": "codex",
        "preview": "Child",
        "status": "completed",
        "lastActive": "2026-08-21T00:00:01.000Z",
        "threadKind": "subagent",
        "parentSessionId": "codex:root",
        "agentDepth": 1,
    }
    query_calls = []

    def query_all(*_args, **kwargs):
        query_calls.append(kwargs)
        return [root] if kwargs.get("IndexName") else [root, child]

    monkeypatch.setattr(bridge_read, "_tables", lambda: (FakeTable(), FakeTable()))
    monkeypatch.setattr(bridge_read, "_query_all", query_all)

    result = asyncio.run(bridge_read.get_session_threads(
        FakeRequest(),
        device="Linux",
        project="-repo",
        session="codex:root",
    ))

    assert [item["sessionId"] for item in result["threads"]] == [
        "codex:root",
        "codex:child",
    ]
    assert len(query_calls) == 2
    assert query_calls[0]["IndexName"] == bridge_read.THREAD_ROOT_INDEX_NAME
    assert "IndexName" not in query_calls[1]


def test_sync_messages_persists_only_message_fields(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncMessagesRequest(
        sessionId="native-id",
        runtime="codex",
        messages=[{
            "uuid": "m1",
            "nativeId": "codex:user:client-1",
            "type": "user",
            "content": "hello",
            "timestamp": "2026-08-06T00:00:00.000Z",
            "transient": "not-persisted",
        }],
    )
    asyncio.run(bridge_sync.sync_messages(request, FakeRequest()))
    assert messages.items[0]["sessionId"] == "codex:native-id"
    assert messages.items[0]["runtime"] == "codex"
    assert messages.items[0]["nativeId"] == "codex:user:client-1"
    assert "transient" not in messages.items[0]


def test_message_reads_return_only_message_fields():
    parsed = bridge_read._parse_messages([{
        "uuid": "m1",
        "nativeId": "codex:user:client-1",
        "type": "user",
        "content": json.dumps("hello"),
        "timestamp": "2026-08-06T00:00:00.000Z",
        "transient": "not-returned",
    }])
    assert parsed[0]["nativeId"] == "codex:user:client-1"
    assert "transient" not in parsed[0]


def test_sync_sessions_persists_device_runtime_capabilities(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Mac",
        deviceDisplayName="Office Mac",
        sessions=[],
        device=bridge_sync.DeviceAggregate(
            runtimeCapabilities={
                "claude": bridge_sync.RuntimeCapability(
                    installed=True, historyAvailable=True, canRead=True,
                    canCreate=True, canSend=True, version="2.0.0",
                ),
                "codex": bridge_sync.RuntimeCapability(
                    installed=True, historyAvailable=True, canRead=True,
                    canCreate=False, canSend=False, version="1.0.0",
                ),
            },
        ),
        projects=[],
    )
    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))
    devices = [item for item in sessions.items if item["entityType"] == "device"]
    assert len(devices) == 1
    device = devices[0]
    assert device["sk"] == "DEV#Mac"
    assert device["deviceDisplayName"] == "Office Mac"
    assert device["runtimeCapabilities"]["claude"]["canCreate"] is True
    assert device["runtimeCapabilities"]["codex"]["canRead"] is True
    assert device["runtimeCapabilities"]["codex"]["canCreate"] is False


def test_incomplete_first_catalog_bootstraps_device_and_projects(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Windows",
        os="win32",
        catalogComplete=False,
        sessions=[bridge_sync.SessionItem(
            id="session-1",
            project="C--repo",
            projectName="repo",
            lastActive="2026-08-16T00:00:00.000Z",
        )],
        device=bridge_sync.DeviceAggregate(
            sessionCount=1,
            projectCount=1,
            lastActive="2026-08-16T00:00:00.000Z",
        ),
        projects=[bridge_sync.ProjectAggregate(
            projectHash="C--repo",
            projectName="repo",
            sessionCount=1,
            lastActive="2026-08-16T00:00:00.000Z",
        )],
    )

    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))

    assert any(item["sk"] == "DEV#Windows" for item in sessions.items)
    assert any(item["sk"] == "PROJ#Windows#C--repo" for item in sessions.items)


def test_incomplete_catalog_preserves_existing_device_aggregates(monkeypatch):
    account_id = bridge_sync._hash_key("test-key")
    existing_device = {
        "accountId": account_id,
        "sk": "DEV#Windows",
        "entityType": "device",
        "deviceName": "Windows",
        "sessionCount": 99,
        "projectCount": 12,
    }
    sessions = FakeTable()
    sessions.items.append(existing_device)
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Windows",
        deviceDisplayName="Office Windows",
        os="win32",
        catalogComplete=False,
        sessions=[],
        device=bridge_sync.DeviceAggregate(sessionCount=1, projectCount=1),
        projects=[bridge_sync.ProjectAggregate(
            projectHash="partial",
            sessionCount=1,
        )],
    )

    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))

    devices = [item for item in sessions.items if item.get("sk") == "DEV#Windows"]
    assert devices == [existing_device]
    assert sessions.updates[0]["ExpressionAttributeValues"][":name"] == "Office Windows"
    assert not any(item.get("sk") == "PROJ#Windows#partial" for item in sessions.items)


def test_message_cursor_preserves_equal_timestamp_rows(monkeypatch):
    timestamp = "2026-08-06T00:00:00.000Z"
    messages = FakeMessageTable([
        {
            "sessionId": "session",
            "sk": f"{timestamp}#{uuid}",
            "uuid": uuid,
            "type": "user",
            "content": json.dumps(uuid),
            "timestamp": timestamp,
        }
        for uuid in ("a", "b", "c")
    ])
    monkeypatch.setattr(bridge_read, "_tables", lambda: (FakeTable(), messages))

    first = asyncio.run(
        bridge_read.get_messages(
            FakeRequest(),
            "session",
            after=None,
            before=None,
            device=None,
            limit=2,
        )
    )
    second = asyncio.run(
        bridge_read.get_messages(
            FakeRequest(),
            "session",
            after=None,
            before=first["oldestTimestamp"],
            device=None,
            limit=2,
        )
    )

    assert first["oldestTimestamp"] == f"{timestamp}#b"
    assert [item["uuid"] for item in first["messages"]] == ["b", "c"]
    assert [item["uuid"] for item in second["messages"]] == ["a"]


def test_messages_include_strong_session_status(monkeypatch):
    status_started = threading.Event()

    class StatusTable(FakeTable):
        def get_item(self, Key, ConsistentRead=False, **kwargs):
            assert ConsistentRead is True
            status_started.set()
            return super().get_item(Key, **kwargs)

    class ConcurrentMessageTable(FakeMessageTable):
        def query(self, **kwargs):
            assert status_started.wait(1)
            return super().query(**kwargs)

    sessions = StatusTable()
    sessions.items.append({
        "accountId": bridge_read._account_id(FakeRequest()),
        "sk": "SESS#MacBook-Pro#-workspace#session",
        "status": "needs_input",
    })
    messages = ConcurrentMessageTable([])
    monkeypatch.setattr(bridge_read, "_tables", lambda: (sessions, messages))

    result = asyncio.run(
        bridge_read.get_messages(
            FakeRequest(),
            "session",
            after="2026-08-19T00:00:00.000Z",
            before=None,
            device="MacBook-Pro",
            limit=None,
            project="-workspace",
        )
    )

    assert result["status"] == "needs_input"


def test_windows_installer_prefers_s4u_with_interactive_fallback():
    script = bridge_read._windows_install_script(
        "https://example.com/bridge.tar.gz",
        "https://example.com/v1",
        "test-key",
        "Windows",
    )
    assert "-LogonType S4U" in script
    assert "$env:Path = (Split-Path $nodePath) + ';' + $env:Path" in script
    assert "ci --omit=dev --include=optional --silent --no-audit --no-fund" in script
    assert "verify-dependencies.mjs" in script
    assert "[version]'20.9.0'" in script
    assert "-LogonType ServiceAccount" in script
    assert "Administrator privileges are required" in script
    assert "Run as administrator" in script
    assert ".IsInRole" in script
    assert "-LogonType Interactive" in script
    assert "foreach ($attempt in 1..10)" in script
    assert "$runningChecks -ge 4" in script
    assert "Start-BatonTask" in script
    assert "did not start with S4U" in script
    assert "0x00041303" in script
    assert "Task Scheduler operational event" in script
    assert "failed to start within 10 seconds" in script
    assert "Task state: $taskState" in script
    assert "Start error: $taskError" in script
    assert "AppData\\Local\\Programs\\nodejs\\node.exe" in script
    assert "'C:\\nodejs'" in script
    assert "Node.js 20.9+ was not found or could not run" in script
    assert "Get-CimInstance Win32_UserProfile" in script
    assert "$useSystemTask = $isSystemContext -or ($currentIdentity -match" in script
    assert "bridge.log" in script
    assert "installed and running" in script


def test_windows_installer_prompts_for_device_name():
    script = bridge_read._windows_install_script(
        "https://example.com/bridge.tar.gz",
        "https://example.com/v1",
        "test-key",
        None,
    )
    assert 'Read-Host "Device name [$defaultName]"' in script
    assert "/api/bridge/device-name/validate" in script
    assert "deviceDisplayName = $deviceDisplayName" in script
    assert "Write-Host $result.error" in script


def test_unix_installer_validates_runtime_dependencies(monkeypatch):
    class S3:
        def generate_presigned_url(self, *_args, **_kwargs):
            return "https://example.com/bridge.tar.gz"

    request = FakeRequest()
    request.url = SimpleNamespace(scheme="https")
    monkeypatch.setenv("BRIDGE_IMAGES_BUCKET", "bridge-bucket")
    monkeypatch.setattr("boto3.client", lambda *_args, **_kwargs: S3())

    response = asyncio.run(bridge_read.get_install(request, name=None, platform=""))
    script = response.body.decode()

    assert "if tty -s 2>/dev/null < /dev/tty; then" in script
    assert 'printf "Device name [%s]: " "$DEFAULT_NAME" > /dev/tty' in script
    assert "/api/bridge/device-name/validate" in script
    assert "deviceDisplayName:process.env.BATON_DEVICE_DISPLAY_NAME" in script
    assert "Requires >= 20.9" in script
    assert "npm ci --omit=dev --include=optional --silent --no-audit --no-fund" in script
    assert "node verify-dependencies.mjs" in script
    assert 'NODE_DIR=$(dirname "$NODE")' in script
    assert (
        "<key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:"
        "/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
    ) in script


def test_bridge_connection_persists_running_version(monkeypatch):
    connections = FakeTable()
    monkeypatch.setattr(bridge_ws, "_connections_table", connections)
    response = bridge_ws._handle_connect(
        {
            "queryStringParameters": {
                "apiKey": "test-key",
                "role": "bridge",
                "device": "Mac",
                "version": "0.2.0-test",
            },
        },
        "connection-1",
    )
    assert response == {"statusCode": 200}
    assert connections.items[0]["deviceName"] == "Mac"
    assert connections.items[0]["bridgeVersion"] == "0.2.0-test"


def test_bridge_recovery_complete_broadcasts_to_apps(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "bridge",
                    "accountId": "account-1",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: [
            {"connectionId": "app-1"},
            {"connectionId": "app-2"},
        ] if account_id == "account-1" and role == "app" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((endpoint, connection_id, data)),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "bridge_recovery_complete",
                "deviceName": "Mac",
                "count": 3,
            }),
        },
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [
        (
            "https://example.test/v1",
            "app-1",
            {
                "action": "bridge_recovery_complete",
                "deviceName": "Mac",
                "count": 3,
            },
        ),
        (
            "https://example.test/v1",
            "app-2",
            {
                "action": "bridge_recovery_complete",
                "deviceName": "Mac",
                "count": 3,
            },
        ),
    ]


def test_send_result_includes_the_responding_bridge_device(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "bridge",
                    "accountId": "account-1",
                    "deviceName": "Mac",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: [{"connectionId": "app-1"}]
        if account_id == "account-1" and role == "app" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "send_message_result",
                "turnId": "turn-1",
                "ok": False,
                "error": "already has an active writer",
                "errorCode": "codex_active_writer",
                "writer": {
                    "pid": 123,
                    "label": "Codex terminal",
                    "canTerminate": True,
                },
            }),
        },
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [(
        "app-1",
        {
            "action": "send_message_result",
            "turnId": "turn-1",
            "ok": False,
            "error": "already has an active writer",
            "errorCode": "codex_active_writer",
            "writer": {
                "pid": 123,
                "label": "Codex terminal",
                "canTerminate": True,
            },
            "deviceName": "Mac",
        },
    )]


def test_new_session_send_carries_the_origin_connection_to_the_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "app",
                    "accountId": "account-1",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: [{
            "connectionId": "bridge-1",
            "deviceName": "Mac",
        }] if account_id == "account-1" and role == "bridge" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "send_message",
                "projectHash": "-repo",
                "requestId": "request-1",
                "turnId": "turn-1",
                "text": "hello",
                "device": "Mac",
                "runtime": "codex",
            }),
        },
        "app-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [
        (
            "app-1",
            {
                "action": "send_message_received",
                "requestId": "request-1",
                "turnId": "turn-1",
            },
        ),
        (
            "bridge-1",
            {
            "action": "send_message",
            "projectHash": "-repo",
            "requestId": "request-1",
            "turnId": "turn-1",
            "text": "hello",
            "runtime": "codex",
            "replyConnectionId": "app-1",
            },
        ),
    ]

    sent.clear()
    monkeypatch.setattr(bridge_ws, "_query_connections", lambda *_: [])
    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "send_message",
                "projectHash": "-repo",
                "requestId": "request-2",
                "turnId": "turn-2",
                "text": "retry later",
                "runtime": "codex",
            }),
        },
        "app-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert [message["action"] for _, message in sent] == [
        "send_message_received",
        "send_message_result",
    ]
    assert sent[-1][1]["errorCode"] == "bridge_offline"


def test_new_session_result_subscribes_origin_before_reply(monkeypatch):
    events = []

    class ConnectionTable:
        def get_item(self, Key):
            connection_id = Key["connectionId"]
            role = "bridge" if connection_id == "bridge-1" else "app"
            return {
                "Item": {
                    "connectionId": connection_id,
                    "role": role,
                    "accountId": "account-1",
                    **({"deviceName": "Mac"} if role == "bridge" else {}),
                },
            }

    class SubscriptionTable:
        def put_item(self, Item):
            events.append(("subscribe", Item))

    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: events.append(
            ("send", connection_id, data),
        ),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "send_message_result",
                "sessionId": "codex:thread-1",
                "requestId": "request-1",
                "turnId": "turn-1",
                "replyConnectionId": "app-1",
                "ok": True,
            }),
        },
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert events[0][0] == "subscribe"
    assert events[0][1]["sessionId"] == "codex:thread-1"
    assert events[0][1]["connectionId"] == "app-1"
    assert events[0][1]["accountId"] == "account-1"
    assert events[1] == (
        "send",
        "app-1",
        {
            "action": "send_message_result",
            "sessionId": "codex:thread-1",
            "requestId": "request-1",
            "turnId": "turn-1",
            "ok": True,
            "deviceName": "Mac",
        },
    )


def test_subscribe_only_persists_the_connection(monkeypatch):
    events = []

    class SubscriptionTable:
        def put_item(self, Item):
            events.append(("put", Item))

    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: events.append(("send", connection_id, data)),
    )
    response = bridge_ws._handle_subscribe(
        {
            "sessionId": "codex:thread-1",
        },
        "app-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert len(events) == 1
    assert events[0][0] == "put"
    assert events[0][1]["sessionId"] == "codex:thread-1"
    assert events[0][1]["connectionId"] == "app-1"
    assert events[0][1]["accountId"] == "account-1"
    assert "requestId" not in events[0][1]


def test_subscribe_and_unsubscribe_track_the_root_session(monkeypatch):
    events = []

    class SubscriptionTable:
        def put_item(self, Item):
            events.append(("put", Item["sessionId"], Item["connectionId"]))

        def delete_item(self, Key):
            events.append(("delete", Key["sessionId"], Key["connectionId"]))

    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    body = {
        "sessionId": "codex:child",
        "rootSessionId": "codex:root",
    }

    assert bridge_ws._handle_subscribe(
        body,
        "app-1",
        "account-1",
        "https://example.test/v1",
    ) == {"statusCode": 200}
    assert bridge_ws._handle_unsubscribe(body, "app-1") == {"statusCode": 200}
    assert events == [
        ("put", "codex:child", "app-1"),
        ("put", "ROOT#codex:root", "app-1"),
        ("delete", "codex:child", "app-1"),
        ("delete", "ROOT#codex:root", "app-1"),
    ]


def test_subscribe_write_failure_propagates(monkeypatch):
    class SubscriptionTable:
        def put_item(self, Item):
            raise RuntimeError("write failed")

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    try:
        bridge_ws._handle_subscribe(
            {
                "sessionId": "codex:thread-1",
            },
            "app-1",
            "account-1",
            "https://example.test/v1",
        )
        assert False, "subscription write failure must propagate"
    except RuntimeError as error:
        assert str(error) == "write failed"
    assert sent == []


def test_bridge_relay_reaches_origin_before_subscription(monkeypatch):
    query_args = []

    class SubscriptionTable:
        def query(self, **kwargs):
            query_args.append(kwargs)
            return {"Items": []}

    class ConnectionTable:
        def get_item(self, Key, ConsistentRead=False):
            assert Key == {"connectionId": "app-1"}
            assert ConsistentRead is True
            return {"Item": {
                "connectionId": "app-1",
                "role": "app",
                "accountId": "account-1",
            }}

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_bridge_relay(
        {
            "action": "stream_delta",
            "sessionId": "codex:thread-1",
            "turnId": "turn-1",
            "seq": 2,
            "replyConnectionId": "app-1",
        },
        "account-1",
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert query_args[0]["ConsistentRead"] is True
    assert sent == [("app-1", {
        "action": "stream_delta",
        "sessionId": "codex:thread-1",
        "turnId": "turn-1",
        "seq": 2,
    })]


def test_turn_event_validation_requires_turn_id_and_seq():
    for action in (
        "stream_turn_start",
        "stream_block_start",
        "stream_delta",
        "stream_tool_input",
        "stream_block_stop",
        "stream_end",
        "messages",
        "permission_request",
        "permission_resolved",
    ):
        valid = {
            "action": action,
            "sessionId": "codex:thread-1",
            "turnId": "turn-1",
            "seq": 0,
        }
        assert bridge_ws._requires_turn_sequence(valid)
        assert bridge_ws._has_valid_turn_sequence(valid)
        assert bridge_ws._requires_turn_sequence({**valid, "turnId": ""})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "turnId": ""})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": None})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": -1})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": True})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": 1.5})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": "1"})

    for action in (
        "send_message_result",
        "messages_ack",
        "heartbeat",
    ):
        assert not bridge_ws._requires_turn_sequence({"action": action})


def test_permission_resolved_uses_the_shared_turn_relay(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "bridge",
                    "accountId": "account-1",
                },
            }

    relayed = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_handle_bridge_relay",
        lambda body, account_id, connection_id, endpoint: (
            relayed.append((body, account_id, connection_id, endpoint))
            or {"statusCode": 200}
        ),
    )
    body = {
        "action": "permission_resolved",
        "sessionId": "codex:thread-1",
        "turnId": "turn-1",
        "seq": 4,
        "requestId": "permission-1",
    }

    response = bridge_ws._handle_message(
        {"body": json.dumps(body)},
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert relayed == [(
        body,
        "account-1",
        "bridge-1",
        "https://example.test/v1",
    )]


def test_reveal_permission_subscribes_before_forwarding_to_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "app",
                    "accountId": "account-1",
                },
            }

    calls = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_persist_subscription",
        lambda session_id, connection_id, account_id: calls.append(
            ("subscribe", session_id, connection_id, account_id)
        ),
    )
    monkeypatch.setattr(
        bridge_ws,
        "_handle_send_to_bridge",
        lambda body, account_id, endpoint, action: (
            calls.append(("forward", body, account_id, endpoint, action))
            or {"statusCode": 200}
        ),
    )
    body = {
        "action": "reveal_permission",
        "sessionId": "codex:thread-1",
        "device": "test-ec2-ap",
    }

    response = bridge_ws._handle_message(
        {"body": json.dumps(body)},
        "app-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert calls == [
        ("subscribe", "codex:thread-1", "app-1", "account-1"),
        (
            "forward",
            body,
            "account-1",
            "https://example.test/v1",
            "reveal_permission",
        ),
    ]


def test_list_commands_keeps_device_after_routing_to_the_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "app",
                    "accountId": "account-1",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: [
            {"connectionId": "bridge-mac", "deviceName": "Mac"},
            {"connectionId": "bridge-linux", "deviceName": "Linux"},
        ] if account_id == "account-1" and role == "bridge" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "list_commands",
                "requestId": "commands-1",
                "runtime": "codex",
                "projectHash": "-workspace-project",
                "sessionId": "codex:thread-1",
                "device": "Mac",
                "knownRevision": "revision-1",
            }),
        },
        "app-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [(
        "bridge-mac",
        {
            "action": "list_commands",
            "requestId": "commands-1",
            "runtime": "codex",
            "projectHash": "-workspace-project",
            "sessionId": "codex:thread-1",
            "device": "Mac",
            "knownRevision": "revision-1",
        },
    )]


def test_command_options_route_between_app_and_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            role = "bridge" if Key["connectionId"] == "bridge-mac" else "app"
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": role,
                    "accountId": "account-1",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: (
            [{"connectionId": "bridge-mac", "deviceName": "Mac"}]
            if role == "bridge"
            else [{"connectionId": "app-1"}, {"connectionId": "app-2"}]
        ),
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    request = {
        "action": "list_command_options",
        "requestId": "options-1",
        "runtime": "codex",
        "projectHash": "-workspace-project",
        "sessionId": "codex:thread-1",
        "commandName": "agent",
        "device": "Mac",
    }
    response = bridge_ws._handle_message(
        {"body": json.dumps(request)},
        "app-1",
        "https://example.test/v1",
    )
    assert response == {"statusCode": 200}
    assert sent == [("bridge-mac", request)]

    sent.clear()
    result = {
        "action": "command_options",
        "requestId": "options-1",
        "runtime": "codex",
        "commandName": "agent",
        "options": [{"name": "thread-2"}],
    }
    response = bridge_ws._handle_message(
        {"body": json.dumps(result)},
        "bridge-mac",
        "https://example.test/v1",
    )
    assert response == {"statusCode": 200}
    assert sent == [("app-1", result), ("app-2", result)]


def test_bridge_messages_do_not_ack_unavailable_or_failed_ddb_writes(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": []}

    class FailingMessagesTable:
        def batch_writer(self):
            raise RuntimeError("ddb unavailable")

    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    sent = []
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((endpoint, connection_id, data)),
    )

    body = {
        "sessionId": "codex:test",
        "messages": [{
            "uuid": "m1",
            "type": "assistant",
            "content": "hello",
            "timestamp": "2026-08-10T00:00:00.000Z",
        }],
    }
    for table in (None, FailingMessagesTable()):
        monkeypatch.setattr(bridge_ws, "_messages_table", table)
        response = bridge_ws._handle_bridge_messages(
            body,
            "bridge-1",
            "account-1",
            "https://example.test/v1",
        )
        assert response == {"statusCode": 500}
        assert sent == []


def test_bridge_messages_preserve_turn_sequence(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": [{"connectionId": "app-1"}]}

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    message = {
        "uuid": "m1",
        "type": "assistant",
        "content": "answer",
        "timestamp": "2026-08-15T11:16:22.458Z",
    }
    response = bridge_ws._handle_bridge_messages(
        {
            "sessionId": "codex:test",
            "turnId": "turn-1",
            "seq": 3,
            "messages": [message],
            "noCache": True,
        },
        "bridge-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [
        ("app-1", {
                "action": "messages",
                "sessionId": "codex:test",
                "turnId": "turn-1",
                "seq": 3,
                "messages": [message],
        }),
        ("bridge-1", {
            "action": "messages_ack",
            "sessionId": "codex:test",
        }),
    ]


def test_bridge_message_cache_persists_only_message_fields(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": []}

    messages = FakeTable()
    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(bridge_ws, "_messages_table", messages)
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_bridge_messages(
        {
            "sessionId": "codex:test",
            "messages": [{
                "uuid": "m1",
                "nativeId": "codex:user:client-1",
                "type": "user",
                "content": "hello",
                "timestamp": "2026-08-12T00:00:00.000Z",
                "transient": "not-persisted",
            }],
        },
        "bridge-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert messages.items[0]["nativeId"] == "codex:user:client-1"
    assert "transient" not in messages.items[0]
    assert sent == [(
        "bridge-1",
        {"action": "messages_ack", "sessionId": "codex:test"},
    )]


def test_bridge_messages_echoes_delivery_id_only_to_bridge_ack(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": [{"connectionId": "app-1"}]}

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(bridge_ws, "_messages_table", FakeTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_bridge_messages(
        {
            "sessionId": "codex:test",
            "deliveryId": "delivery-1",
            "messages": [{
                "uuid": "m1",
                "type": "assistant",
                "content": "hello",
                "timestamp": "2026-08-12T00:00:00.000Z",
            }],
        },
        "bridge-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [
        ("app-1", {
            "action": "messages",
            "sessionId": "codex:test",
            "messages": [{
                "uuid": "m1",
                "type": "assistant",
                "content": "hello",
                "timestamp": "2026-08-12T00:00:00.000Z",
            }],
        }),
        ("bridge-1", {
            "action": "messages_ack",
            "sessionId": "codex:test",
            "deliveryId": "delivery-1",
        }),
    ]


def test_post_to_connection_uses_compact_utf8_json(monkeypatch):
    sent = []

    class Client:
        exceptions = SimpleNamespace(GoneException=RuntimeError)

        def post_to_connection(self, ConnectionId, Data):
            sent.append((ConnectionId, Data))

    monkeypatch.setattr(bridge_ws, "_apigw", Client())

    assert bridge_ws._post_to_connection(
        "https://example.test/v1",
        "app-1",
        {"action": "stream_delta", "chunk": "中文"},
    ) is True
    assert sent == [(
        "app-1",
        '{"action":"stream_delta","chunk":"中文"}'.encode(),
    )]


def test_compact_messages_placeholder_keeps_turn_sequence(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": [{"connectionId": "app-1"}]}

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_bridge_messages(
        {
            "action": "messages",
            "sessionId": "codex:test",
            "turnId": "turn-1",
            "seq": 12,
            "messages": [],
            "truncated": True,
            "noCache": True,
        },
        "bridge-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [
        ("app-1", {
            "action": "messages",
            "sessionId": "codex:test",
            "turnId": "turn-1",
            "seq": 12,
            "messages": [],
            "truncated": True,
        }),
        ("bridge-1", {
            "action": "messages_ack",
            "sessionId": "codex:test",
        }),
    ]
