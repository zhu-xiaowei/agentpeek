"""
Bridge sync routes — receives session metadata and messages from bridge client.
Usage: app.include_router(bridge_router) in main.py
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from typing import Dict, List, Optional
from boto3.dynamodb.conditions import Key
import boto3
import os
import json
import hashlib
from datetime import datetime
import time

MESSAGE_TTL_DAYS = 90  # message rows are a rebuildable cache (jsonl is truth); expire after 90d


def _msg_ttl():
    return int(time.time()) + MESSAGE_TTL_DAYS * 86400

bridge_router = APIRouter(prefix="/api/bridge")

_ddb = None
_sessions_table = None
_messages_table = None


def _tables():
    global _ddb, _sessions_table, _messages_table
    if _ddb is None:
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        _sessions_table = _ddb.Table(os.environ["BRIDGE_SESSIONS_TABLE"])
        _messages_table = _ddb.Table(os.environ["BRIDGE_MESSAGES_TABLE"])
    return _sessions_table, _messages_table


def _hash_key(api_key: str) -> str:
    """SHA256 hash of API key — never store the raw key in DynamoDB."""
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


class SessionItem(BaseModel):
    id: str
    nativeSessionId: str = ""
    runtime: str = "claude"
    project: str
    projectName: str = ""
    lastActive: str
    size: int = 0
    preview: str = ""
    model: str = ""
    modelProvider: str = ""
    clientSource: str = ""
    cliVersion: str = ""
    status: str = "completed"  # "running" | "needs_input" | "completed"
    isAgent: bool = False
    agentName: str = ""
    agentRole: str = ""
    agentDetail: str = ""
    threadKind: str = "main"
    parentSessionId: str = ""
    agentPath: str = ""
    agentDepth: int = 0
    canSend: bool = True
    agentCount: Optional[int] = None
    runningAgentCount: Optional[int] = None
    needsInputAgentCount: Optional[int] = None
    threadRootId: Optional[str] = None


class AgentCountUpdate(BaseModel):
    sessionId: str
    project: str
    agentCount: int = 0
    runningAgentCount: Optional[int] = None
    needsInputAgentCount: Optional[int] = None


class RuntimeCapability(BaseModel):
    installed: bool = False
    historyAvailable: bool = False
    canRead: bool = False
    canCreate: bool = False
    canSend: bool = False
    version: str = ""


class DeviceAggregate(BaseModel):
    sessionCount: int = 0
    projectCount: int = 0
    runningCount: int = 0
    idleCount: int = 0
    lastActive: str = ""
    runtimeCapabilities: Dict[str, RuntimeCapability] = Field(default_factory=dict)


class ProjectAggregate(BaseModel):
    projectHash: str
    projectName: str = ""
    sessionCount: int = 0
    runningCount: int = 0
    idleCount: int = 0
    lastActive: str = ""


class StatusDelta(BaseModel):
    deviceName: str
    projectHash: str
    projectName: str = ""
    # 'from' is reserved in Python, use alias
    from_: str = "completed"   # populated via Field alias below
    to: str = "completed"
    lastActive: str = ""

    class Config:
        populate_by_name = True

    def __init__(self, **data):
        # Accept both "from" (from JSON) and "from_" (from Python).
        if "from" in data:
            data["from_"] = data.pop("from")
        super().__init__(**data)


class SyncSessionsRequest(BaseModel):
    deviceName: str
    deviceDisplayName: str = ""
    os: str = ""
    sessions: List[SessionItem]
    # Complete catalogs overwrite aggregates. Incomplete catalogs only bootstrap
    # a device that does not have an aggregate yet.
    catalogComplete: bool = True
    device: Optional[DeviceAggregate] = None
    projects: Optional[List[ProjectAggregate]] = None
    # Incremental path: counter delta from a single session's status change.
    statusDelta: Optional[StatusDelta] = None
    # Bulk incremental (checkStopped): multiple status changes at once.
    statusDeltas: Optional[List[StatusDelta]] = None
    agentCountUpdates: Optional[List[AgentCountUpdate]] = None


class SyncMessagesRequest(BaseModel):
    sessionId: str
    runtime: str = "claude"
    nativeSessionId: str = ""
    messages: List[dict]


def _normalize_runtime(runtime: str) -> str:
    return "codex" if runtime == "codex" else "claude"


def _session_ids(runtime: str, session_id: str, native_session_id: str = ""):
    """Normalize old and new payloads to runtime, native id, and storage id."""
    runtime = _normalize_runtime(runtime)
    native_id = native_session_id or session_id
    if runtime == "codex" and native_id.startswith("codex:"):
        native_id = native_id[len("codex:"):]
    storage_id = native_id if runtime == "claude" else f"codex:{native_id}"
    return runtime, native_id, storage_id


def _project_list_pk(account_id: str, device: str) -> str:
    return f"{account_id}#PROJ#{device}"


def _session_list_pk(account_id: str, device: str, project: str) -> str:
    return f"{account_id}#SESS#{device}#{project}"


def _thread_root_pk(account_id: str, device: str, project: str, root_session_id: str) -> str:
    return f"{account_id}#THREAD#{device}#{project}#{root_session_id}"


def _list_sk(last_active: str, stable_id: str) -> str:
    return f"{last_active or '0000'}#{stable_id}"


def _effective_status(main_status: str, running_agents: int = 0, needs_input_agents: int = 0) -> str:
    if main_status == "needs_input" or needs_input_agents > 0:
        return "needs_input"
    if main_status == "running" or running_agents > 0:
        return "running"
    return "completed"


def _active_status_value(status: str, last_active: str) -> str:
    return status if status in ("running", "needs_input") else f"done#{last_active}"


def _status_from_active_value(value: str) -> str:
    return value if value in ("running", "needs_input") else "completed"


def _effective_status_from_item(item: dict) -> str:
    value = item.get("activeStatus", "")
    if value:
        return _status_from_active_value(value)
    return _effective_status(
        item.get("status", "completed"),
        int(item.get("runningAgentCount", 0) or 0),
        int(item.get("needsInputAgentCount", 0) or 0),
    )


def _counter_delta(from_: str, to: str):
    """Map a status transition to (running_delta, idle_delta, session_delta).
    'new' from-state means this is a brand-new session (sessionCount += 1).
    idleCount now tracks needs_input; legacy 'idle' still counts inbound so old
    counters drain correctly on a migrating session's next transition."""
    def w(s):
        return (1 if s == "running" else 0, 1 if s in ("needs_input", "idle") else 0)
    f_run, f_idle = (0, 0) if from_ == "new" else w(from_)
    t_run, t_idle = w(to)
    return (t_run - f_run, t_idle - f_idle, 1 if from_ == "new" else 0)


def _apply_status_delta(account_id: str, delta: StatusDelta):
    """ADD counters on PROJ#/DEV# items. DDB ADD auto-creates the item with delta values
    if it doesn't exist yet (zero base + delta)."""
    sessions_table, _ = _tables()
    dr, di, ds = _counter_delta(delta.from_, delta.to)
    if dr == 0 and di == 0 and ds == 0:
        return
    targets = [
        (f"PROJ#{delta.deviceName}#{delta.projectHash}", "project", delta.deviceName),
        (f"DEV#{delta.deviceName}", "device", delta.deviceName),
    ]
    for sk, entity_type, device in targets:
        sessions_table.update_item(
            Key={"accountId": account_id, "sk": sk},
            UpdateExpression=(
                "ADD runningCount :dr, idleCount :di, sessionCount :ds "
                "SET entityType = if_not_exists(entityType, :et), "
                "deviceName = if_not_exists(deviceName, :dn)"
            ),
            ExpressionAttributeValues={
                ":dr": dr, ":di": di, ":ds": ds,
                ":et": entity_type, ":dn": device,
            },
        )
    # PROJ# also needs projectHash/projectName seeded on first write
    if delta.from_ == "new":
        sessions_table.update_item(
            Key={"accountId": account_id, "sk": f"PROJ#{delta.deviceName}#{delta.projectHash}"},
            UpdateExpression="SET projectHash = if_not_exists(projectHash, :ph), projectName = if_not_exists(projectName, :pn)",
            ExpressionAttributeValues={":ph": delta.projectHash, ":pn": delta.projectName or delta.projectHash},
        )


def _bump_last_active(account_id: str, sk: str, ts: str, list_pk: str = "", list_id: str = ""):
    """Conditionally update lastActive only if the incoming ts is newer."""
    if not ts:
        return
    sessions_table, _ = _tables()
    update = "SET lastActive = :ts"
    values = {":ts": ts}
    if list_pk and list_id:
        update += ", listPk = :list_pk, listSk = :list_sk"
        values.update({":list_pk": list_pk, ":list_sk": _list_sk(ts, list_id)})
    try:
        sessions_table.update_item(
            Key={"accountId": account_id, "sk": sk},
            UpdateExpression=update,
            ConditionExpression="attribute_not_exists(lastActive) OR lastActive < :ts",
            ExpressionAttributeValues=values,
        )
    except Exception:
        pass


def _broadcast_session_thread_changes(account_id: str, device_name: str, roots: List[dict]):
    endpoint = os.environ.get("WS_API_ENDPOINT", "")
    if not endpoint or not roots:
        return
    try:
        from bridge_ws import notify_session_threads_changed
        notify_session_threads_changed(account_id, endpoint, device_name, roots)
    except Exception as e:
        print(f"session thread notification failed: {e}")


@bridge_router.post("/sync-sessions")
async def sync_sessions(req: SyncSessionsRequest, raw: Request):
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    now = datetime.utcnow().isoformat()

    incoming_status_deltas = []
    if req.statusDelta is not None:
        incoming_status_deltas.append(req.statusDelta)
    if req.statusDeltas:
        incoming_status_deltas.extend(req.statusDeltas)
    has_status_deltas = bool(incoming_status_deltas)

    preserved_session_fields = {}
    for s in req.sessions:
        needs_agent_summary = not s.parentSessionId and (
            s.agentCount is None
            or s.runningAgentCount is None
            or s.needsInputAgentCount is None
        )
        needs_thread_root = s.threadRootId is None
        needs_previous_status = not s.parentSessionId and has_status_deltas
        if not needs_agent_summary and not needs_thread_root and not needs_previous_status:
            continue
        _, _, storage_id = _session_ids(s.runtime, s.id, s.nativeSessionId)
        existing = sessions_table.get_item(Key={
            "accountId": key_hash,
            "sk": f"SESS#{req.deviceName}#{s.project}#{storage_id}",
        }).get("Item", {})
        preserved_session_fields[(s.project, storage_id)] = existing

    effective_status_deltas = []

    # 1. Write SESS# items (always).
    with sessions_table.batch_writer() as batch:
        for s in req.sessions:
            runtime, native_id, storage_id = _session_ids(s.runtime, s.id, s.nativeSessionId)
            item = {
                "accountId": key_hash,
                "sk": f"SESS#{req.deviceName}#{s.project}#{storage_id}",
                "entityType": "session",
                "deviceName": req.deviceName,
                "os": req.os,
                "projectHash": s.project,
                "projectName": s.projectName or s.project,
                "sessionId": storage_id,
                "nativeSessionId": native_id,
                "runtime": runtime,
                "lastActive": s.lastActive,
                "preview": s.preview,
                "model": s.model,
                "status": s.status,
                "size": s.size,
                "updatedAt": now,
            }
            if s.modelProvider:
                item["modelProvider"] = s.modelProvider
            if s.clientSource:
                item["clientSource"] = s.clientSource
            if s.cliVersion:
                item["cliVersion"] = s.cliVersion
            # Only root sessions belong in outer list/active indexes. Child
            # threads stay queryable through the base-table project prefix.
            if not s.parentSessionId:
                item["listPk"] = _session_list_pk(key_hash, req.deviceName, s.project)
                item["listSk"] = _list_sk(s.lastActive, storage_id)
            # Agent metadata (sparse — only written when isAgent=True)
            if s.isAgent:
                item["isAgent"] = True
                item["agentName"] = s.agentName
                item["agentRole"] = s.agentRole
            if s.agentDetail:
                item["agentDetail"] = s.agentDetail
            if s.parentSessionId:
                item["threadKind"] = s.threadKind or "subagent"
                item["parentSessionId"] = s.parentSessionId
                item["agentPath"] = s.agentPath
                item["agentDepth"] = s.agentDepth
                item["canSend"] = s.canSend
            if not s.parentSessionId:
                existing = preserved_session_fields.get((s.project, storage_id), {})
                agent_count = s.agentCount
                if agent_count is None:
                    agent_count = existing.get("agentCount", 0)
                running_agent_count = s.runningAgentCount
                if running_agent_count is None:
                    running_agent_count = existing.get("runningAgentCount", 0)
                needs_input_agent_count = s.needsInputAgentCount
                if needs_input_agent_count is None:
                    needs_input_agent_count = existing.get("needsInputAgentCount", 0)
                agent_count = max(0, int(agent_count or 0))
                running_agent_count = max(0, int(running_agent_count or 0))
                needs_input_agent_count = max(0, int(needs_input_agent_count or 0))
                item["agentCount"] = agent_count
                item["runningAgentCount"] = running_agent_count
                item["needsInputAgentCount"] = needs_input_agent_count
                effective_status = _effective_status(
                    s.status,
                    running_agent_count,
                    needs_input_agent_count,
                )
                item["activeStatus"] = _active_status_value(effective_status, s.lastActive)
                if has_status_deltas:
                    old_status = (
                        _effective_status_from_item(existing)
                        if existing else "new"
                    )
                    effective_status_deltas.append(StatusDelta(
                        deviceName=req.deviceName,
                        projectHash=s.project,
                        projectName=s.projectName or s.project,
                        from_=old_status,
                        to=effective_status,
                        lastActive=s.lastActive,
                    ))
            thread_root_id = s.threadRootId
            if thread_root_id is None:
                thread_root_id = preserved_session_fields.get(
                    (s.project, storage_id), {}
                ).get("threadRootId")
            if thread_root_id:
                item["threadRootId"] = thread_root_id
                item["threadRootPk"] = _thread_root_pk(
                    key_hash, req.deviceName, s.project, thread_root_id
                )
                item["threadRootSk"] = storage_id
            batch.put_item(Item=item)

    thread_changes = {}
    for update in req.agentCountUpdates or []:
        root_key = {
            "accountId": key_hash,
            "sk": f"SESS#{req.deviceName}#{update.project}#{update.sessionId}",
        }
        root = sessions_table.get_item(Key=root_key, ConsistentRead=True).get("Item")
        if not root:
            continue
        old_effective_status = _effective_status_from_item(root)
        running_agent_count = (
            update.runningAgentCount
            if update.runningAgentCount is not None
            else root.get("runningAgentCount", 0)
        )
        needs_input_agent_count = (
            update.needsInputAgentCount
            if update.needsInputAgentCount is not None
            else root.get("needsInputAgentCount", 0)
        )
        running_agent_count = max(0, int(running_agent_count or 0))
        needs_input_agent_count = max(0, int(needs_input_agent_count or 0))
        new_effective_status = _effective_status(
            root.get("status", "completed"),
            running_agent_count,
            needs_input_agent_count,
        )
        sessions_table.update_item(
            Key=root_key,
            UpdateExpression=(
                "SET agentCount = :count, runningAgentCount = :running, "
                "needsInputAgentCount = :needs, activeStatus = :active, updatedAt = :now"
            ),
            ExpressionAttributeValues={
                ":count": max(0, update.agentCount),
                ":running": running_agent_count,
                ":needs": needs_input_agent_count,
                ":active": _active_status_value(
                    new_effective_status, root.get("lastActive", "")
                ),
                ":now": now,
            },
        )
        if old_effective_status != new_effective_status:
            _apply_status_delta(key_hash, StatusDelta(
                deviceName=req.deviceName,
                projectHash=update.project,
                projectName=root.get("projectName", update.project),
                from_=old_effective_status,
                to=new_effective_status,
                lastActive=root.get("lastActive", ""),
            ))
        thread_changes[(update.project, update.sessionId)] = {
            "projectHash": update.project,
            "rootSessionId": update.sessionId,
            "agentCount": max(0, update.agentCount),
            "runningAgentCount": running_agent_count,
            "needsInputAgentCount": needs_input_agent_count,
        }

    # 2a. Complete catalogs authoritatively overwrite aggregates. An incomplete
    # first scan may bootstrap a missing device, but never clobbers an existing one.
    write_aggregates = req.device is not None and req.projects is not None
    if write_aggregates and not req.catalogComplete:
        existing = sessions_table.get_item(
            Key={"accountId": key_hash, "sk": f"DEV#{req.deviceName}"},
            ConsistentRead=True,
        ).get("Item")
        write_aggregates = existing is None

    if write_aggregates:
        device_item = {
            "accountId": key_hash,
            "sk": f"DEV#{req.deviceName}",
            "entityType": "device",
            "deviceName": req.deviceName,
            "deviceDisplayName": req.deviceDisplayName or req.deviceName,
            "os": req.os,
            "sessionCount": req.device.sessionCount,
            "projectCount": req.device.projectCount,
            "runningCount": req.device.runningCount,
            "idleCount": req.device.idleCount,
            "lastActive": req.device.lastActive,
            "updatedAt": now,
        }
        if req.device.runtimeCapabilities:
            device_item["runtimeCapabilities"] = {
                runtime: capability.model_dump(exclude_none=True)
                for runtime, capability in req.device.runtimeCapabilities.items()
            }
        sessions_table.put_item(Item=device_item)
        with sessions_table.batch_writer() as batch:
            for p in req.projects:
                batch.put_item(Item={
                    "accountId": key_hash,
                    "sk": f"PROJ#{req.deviceName}#{p.projectHash}",
                    "entityType": "project",
                    "deviceName": req.deviceName,
                    "projectHash": p.projectHash,
                    "projectName": p.projectName or p.projectHash,
                    "sessionCount": p.sessionCount,
                    "runningCount": p.runningCount,
                    "idleCount": p.idleCount,
                    "lastActive": p.lastActive,
                    "listPk": _project_list_pk(key_hash, req.deviceName),
                    "listSk": _list_sk(p.lastActive, p.projectHash),
                    "updatedAt": now,
                })
    elif req.deviceDisplayName:
        sessions_table.update_item(
            Key={"accountId": key_hash, "sk": f"DEV#{req.deviceName}"},
            UpdateExpression="SET deviceDisplayName = :name, updatedAt = :now",
            ExpressionAttributeValues={":name": req.deviceDisplayName, ":now": now},
        )

    # 2b. Incremental path: root counters follow the effective Main+agents
    # status. Fall back to legacy deltas only when no root session was included.
    deltas = effective_status_deltas or incoming_status_deltas
    for d in deltas:
        try:
            _apply_status_delta(key_hash, d)
            _bump_last_active(
                key_hash,
                f"PROJ#{d.deviceName}#{d.projectHash}",
                d.lastActive,
                _project_list_pk(key_hash, d.deviceName),
                d.projectHash,
            )
            _bump_last_active(key_hash, f"DEV#{d.deviceName}", d.lastActive)
        except Exception as e:
            print(f"statusDelta apply failed: {e}")

    if thread_changes:
        _broadcast_session_thread_changes(
            key_hash,
            req.deviceName,
            list(thread_changes.values()),
        )

    return {"synced": len(req.sessions)}


class ReconcileRequest(BaseModel):
    deviceName: str
    os: str = ""


def _query_all(sessions_table, **kw):
    resp = sessions_table.query(**kw)
    items = resp.get("Items", [])
    while "LastEvaluatedKey" in resp:
        resp = sessions_table.query(ExclusiveStartKey=resp["LastEvaluatedKey"], **kw)
        items.extend(resp.get("Items", []))
    return items


def _reconcile_device(sessions_table, key_hash, device, os_, prune=True):
    """Recount DEV#/PROJ# aggregates from the device's SESS# rows.
    prune=True (boot/new-project): delete orphan PROJ# rows (stale worktree hashes gone
    from disk). prune=False (session delete): keep an emptied PROJ# so the project stays
    in the list (user can still open it / add sessions); it just shows 0 sessions."""
    now = datetime.utcnow().isoformat()
    sess = _query_all(sessions_table, KeyConditionExpression=Key("accountId").eq(key_hash)
                      & Key("sk").begins_with(f"SESS#{device}#"))
    roots = [session for session in sess if not session.get("parentSessionId")]
    proj = {}  # projectHash -> {count, name, lastActive}
    device_last = ""
    device_running = 0
    device_needs_input = 0
    for s in roots:
        ph = s.get("projectHash", "")
        if not ph:
            continue
        p = proj.setdefault(ph, {
            "count": 0,
            "running": 0,
            "needs_input": 0,
            "name": s.get("projectName", ph),
            "lastActive": "",
        })
        p["count"] += 1
        active_status = _effective_status_from_item(s)
        if active_status == "running":
            p["running"] += 1
            device_running += 1
        elif active_status == "needs_input":
            p["needs_input"] += 1
            device_needs_input += 1
        la = s.get("lastActive", "")
        if la > p["lastActive"]:
            p["lastActive"] = la
        if la > device_last:
            device_last = la

    existing = sessions_table.query(
        KeyConditionExpression=Key("accountId").eq(key_hash) & Key("sk").begins_with(f"PROJ#{device}#"))
    empty = [it for it in existing.get("Items", []) if it["sk"].split("#", 2)[-1] not in proj]
    # prune deletes orphan PROJ# rows (stale worktree hashes with no SESS#), but a
    # user-created empty project (userCreated) must survive — it's intentional, not an orphan.
    to_delete = [it for it in empty if prune and not it.get("userCreated")]
    to_keep = [it for it in empty if not (prune and not it.get("userCreated"))]

    with sessions_table.batch_writer() as batch:
        for ph, p in proj.items():
            batch.put_item(Item={
                "accountId": key_hash, "sk": f"PROJ#{device}#{ph}",
                "entityType": "project", "deviceName": device,
                "projectHash": ph, "projectName": p["name"],
                "sessionCount": p["count"],
                "runningCount": p["running"],
                "idleCount": p["needs_input"],
                "lastActive": p["lastActive"], "updatedAt": now,
                "listPk": _project_list_pk(key_hash, device),
                "listSk": _list_sk(p["lastActive"], ph),
            })
        for it in to_delete:
            batch.delete_item(Key={"accountId": key_hash, "sk": it["sk"]})
        for it in to_keep:
            it["sessionCount"] = 0  # keep the project in the list, now empty
            it["runningCount"] = 0
            it["idleCount"] = 0
            it["updatedAt"] = now
            it["listPk"] = _project_list_pk(key_hash, device)
            it["listSk"] = _list_sk(it.get("lastActive", ""), it["projectHash"])
            batch.put_item(Item=it)

    # projectCount must equal the projects-list length: kept-empty PROJ# rows still show.
    project_count = len(proj) + len(to_keep)
    sessions_table.update_item(
        Key={"accountId": key_hash, "sk": f"DEV#{device}"},
        UpdateExpression=("SET sessionCount = :sc, projectCount = :pc, "
                          "runningCount = :rc, idleCount = :ic, entityType = :et, "
                          "deviceName = :dn, os = if_not_exists(os, :os), lastActive = :la"),
        ExpressionAttributeValues={
            ":sc": len(roots), ":pc": project_count,
            ":rc": device_running, ":ic": device_needs_input, ":et": "device",
            ":dn": device, ":os": os_, ":la": device_last,
        },
    )
    return {
        "sessionCount": len(roots),
        "projectCount": project_count,
        "runningCount": device_running,
        "idleCount": device_needs_input,
    }


@bridge_router.post("/reconcile")
async def reconcile(req: ReconcileRequest, raw: Request):
    """Recount a device's DEV#/PROJ# aggregates so stored counts stay DDB-self-consistent.
    Called by the bridge on first boot, after a version upgrade, and on a new project."""
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    return _reconcile_device(sessions_table, key_hash, req.deviceName, req.os)


class CreateProjectRequest(BaseModel):
    deviceName: str
    projectHash: str
    projectName: str = ""
    os: str = ""


@bridge_router.post("/create-project")
async def create_project(req: CreateProjectRequest, raw: Request):
    """Seed an empty PROJ# row so a just-created project shows in the list immediately,
    before its first session exists. userCreated=True marks it intentional so reconcile's
    prune never treats it as a stale orphan. Idempotent — never clobbers an existing row."""
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    now = datetime.utcnow().isoformat()
    try:
        sessions_table.put_item(
            Item={
                "accountId": key_hash, "sk": f"PROJ#{req.deviceName}#{req.projectHash}",
                "entityType": "project", "deviceName": req.deviceName,
                "projectHash": req.projectHash, "projectName": req.projectName or req.projectHash,
                "sessionCount": 0, "userCreated": True, "lastActive": now, "updatedAt": now,
                "listPk": _project_list_pk(key_hash, req.deviceName),
                "listSk": _list_sk(now, req.projectHash),
            },
            ConditionExpression="attribute_not_exists(sk)",
        )
    except sessions_table.meta.client.exceptions.ConditionalCheckFailedException:
        pass  # already exists (real sessions or a prior create) — leave it
    # Recount so DEV#.projectCount includes this row (prune keeps userCreated rows).
    return _reconcile_device(sessions_table, key_hash, req.deviceName, req.os)


class DeleteRequest(BaseModel):
    deviceName: str
    sessionIds: List[str] = []
    projectHashes: List[str] = []  # delete a project = its PROJ# + all its SESS# rows


def _collect_session_tree_sks(rows, session_ids):
    """Return the requested sessions' SESS# keys plus every nested descendant."""
    sks_by_session = {}
    children_by_parent = {}
    for row in rows:
        session_id = row.get("sessionId", "")
        if not session_id:
            continue
        if row.get("sk"):
            sks_by_session.setdefault(session_id, set()).add(row["sk"])
        parent_id = row.get("parentSessionId", "")
        if parent_id:
            children_by_parent.setdefault(parent_id, set()).add(session_id)

    pending = list(session_ids)
    visited = set()
    session_sks = set()
    while pending:
        session_id = pending.pop()
        if not session_id or session_id in visited:
            continue
        visited.add(session_id)
        session_sks.update(sks_by_session.get(session_id, ()))
        pending.extend(children_by_parent.get(session_id, ()))
    return session_sks


@bridge_router.post("/delete")
async def delete_sessions(req: DeleteRequest, raw: Request):
    """Delete sessions/projects from DDB (SESS#/PROJ# rows only), then reconcile the
    device aggregates. Message rows are left to expire via their TTL — deleting them
    inline would loop per-session and risk the API GW 29s timeout on big projects, and
    they're unreachable once the SESS# row is gone. Disk jsonl is deleted separately by
    the bridge (WS delete_files) only when the user opts in."""
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    dev = req.deviceName

    sess_sks = set()   # SESS# sks to delete

    # Expand each project → all its SESS# rows.
    for ph in req.projectHashes:
        for it in _query_all(sessions_table, KeyConditionExpression=Key("accountId").eq(key_hash)
                             & Key("sk").begins_with(f"SESS#{dev}#{ph}#"), ProjectionExpression="sk"):
            sess_sks.add(it["sk"])

    # Resolve explicit sessionIds and every nested child from one device-wide query.
    if req.sessionIds:
        rows = _query_all(
            sessions_table,
            KeyConditionExpression=Key("accountId").eq(key_hash)
            & Key("sk").begins_with(f"SESS#{dev}#"),
            ProjectionExpression="sk, sessionId, parentSessionId",
        )
        sess_sks.update(_collect_session_tree_sks(rows, req.sessionIds))

    with sessions_table.batch_writer() as batch:
        for sk in sess_sks:
            batch.delete_item(Key={"accountId": key_hash, "sk": sk})
        for ph in req.projectHashes:
            batch.delete_item(Key={"accountId": key_hash, "sk": f"PROJ#{dev}#{ph}"})

    # prune=False: keep a project that just lost its last session (user can still open it).
    counts = _reconcile_device(sessions_table, key_hash, dev, "", prune=False)
    return {"deletedSessions": len(sess_sks), "deletedProjects": len(req.projectHashes), **counts}


@bridge_router.post("/sync-messages")
async def sync_messages(req: SyncMessagesRequest, raw: Request):
    _, messages_table = _tables()
    written = 0
    runtime, _, storage_id = _session_ids(req.runtime, req.sessionId, req.nativeSessionId)

    with messages_table.batch_writer() as batch:
        for msg in req.messages:
            uuid = msg.get("uuid", "")
            if not uuid:
                continue
            content = json.dumps(msg.get("content", ""), ensure_ascii=False)
            timestamp = msg.get("timestamp", datetime.utcnow().isoformat())
            item = {
                "sessionId": storage_id,
                "sk": f"{timestamp}#{uuid}",
                "uuid": uuid,
                "type": msg.get("type", ""),
                "content": content,
                "timestamp": timestamp,
                "ttl": _msg_ttl(),
            }
            if runtime != "claude":
                item["runtime"] = runtime
            if msg.get("nativeId"):
                item["nativeId"] = msg["nativeId"]
            if msg.get("stopReason"):
                item["stopReason"] = msg["stopReason"]
            if msg.get("toolUseResult"):
                item["toolUseResult"] = json.dumps(msg["toolUseResult"], ensure_ascii=False)
            batch.put_item(Item=item)
            written += 1

    return {"written": written}


class UploadImageRequest(BaseModel):
    key: str       # e.g. "903158ab6d09b5657c3529f3e4c9e5f8.jpg"
    data: str      # base64 encoded compressed JPEG


_s3 = None


def _s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return _s3


@bridge_router.post("/upload-image")
async def upload_image(req: UploadImageRequest):
    import base64
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "BRIDGE_IMAGES_BUCKET not configured"}
    s3 = _s3_client()
    body = base64.b64decode(req.data)
    s3.put_object(Bucket=bucket, Key=f"images/{req.key}", Body=body, ContentType="image/jpeg")
    return {"key": req.key, "size": len(body)}


class UploadFileRequest(BaseModel):
    key: str
    data: str      # base64 encoded file content


@bridge_router.post("/upload-file")
async def upload_file(req: UploadFileRequest):
    import base64
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "BRIDGE_IMAGES_BUCKET not configured"}
    s3 = _s3_client()
    body = base64.b64decode(req.data)
    s3.put_object(Bucket=bucket, Key=f"files/{req.key}", Body=body)
    return {"key": req.key, "size": len(body)}


# Videos are too large to base64 through Lambda (API GW 6MB limit), so the bridge
# streams them straight to S3 via a presigned PUT URL. Deterministic content-hash
# keys mean an already-uploaded video is detected via HEAD and never re-sent.
_VIDEO_CONTENT_TYPES = {
    "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime",
    "webm": "video/webm", "mkv": "video/x-matroska", "avi": "video/x-msvideo",
}


def _video_content_type(key: str) -> str:
    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return _VIDEO_CONTENT_TYPES.get(ext, "video/mp4")


class VideoPrepareRequest(BaseModel):
    key: str       # content-hash key, e.g. "1a2b3c4d5e6f7a8b.mp4"


@bridge_router.post("/video-prepare")
async def video_prepare(req: VideoPrepareRequest):
    """If videos/{key} already exists in S3, tell the bridge to skip the upload.
    Otherwise return a short-lived presigned PUT URL for a direct S3 stream."""
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "BRIDGE_IMAGES_BUCKET not configured"}
    s3 = _s3_client()
    s3_key = f"videos/{req.key}"
    try:
        s3.head_object(Bucket=bucket, Key=s3_key)
        return {"exists": True, "key": req.key}
    except Exception:
        pass  # not found (or transient) — issue a fresh upload URL
    content_type = _video_content_type(req.key)
    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket, "Key": s3_key, "ContentType": content_type},
        ExpiresIn=900,
    )
    return {"exists": False, "key": req.key, "url": url, "contentType": content_type}
