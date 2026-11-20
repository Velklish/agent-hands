import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time

from .common import Report, json_lines, timestamp

READ_ERRORS = (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, RuntimeError, queue.Empty)


class ReadOnlyAppServer:
    METHODS = {"initialize", "thread/list", "thread/turns/list", "thread/items/list"}

    def __init__(self, root, timeout=30):
        self.timeout = timeout
        self.next_id = 0
        self.lines = queue.Queue()
        environment = dict(os.environ, CODEX_HOME=str(root))
        self.process = subprocess.Popen(
            ["codex", "app-server", "--stdio"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            encoding="utf-8", env=environment, bufsize=1)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            self.call("initialize", {"clientInfo": {"name": "my_voice_history", "version": "0.1.0"},
                                     "capabilities": {"experimentalApi": True}})
            self.process.stdin.write('{"method":"initialized"}\n')
            self.process.stdin.flush()
        except Exception:
            self.close()
            raise

    def _read(self):
        try:
            for line in self.process.stdout:
                self.lines.put(line)
        finally:
            self.lines.put(None)

    def call(self, method, params):
        if method not in self.METHODS:
            raise ValueError("Only history read methods are allowed")
        self.next_id += 1
        self.process.stdin.write(json.dumps({"id": self.next_id, "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + self.timeout
        while True:
            line = self.lines.get(timeout=max(0, deadline - time.monotonic()))
            if line is None:
                raise RuntimeError("app_server_closed")
            response = json.loads(line)
            if response.get("id") != self.next_id:
                continue
            if "error" in response:
                raise RuntimeError("app_server_read_failed")
            return response["result"]

    def close(self):
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except BrokenPipeError:
                pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.reader.join(timeout=5)
        self.process.stdout.close()


def pages(client, method, params):
    seen = set()
    while True:
        response = client.call(method, params)
        if not isinstance(response.get("data"), list):
            raise ValueError("Invalid history page")
        yield from response["data"]
        cursor = response.get("nextCursor")
        if not cursor:
            return
        if cursor in seen:
            raise ValueError("History cursor did not advance")
        seen.add(cursor)
        params = dict(params, cursor=cursor)


def interactive_thread(thread):
    source = thread.get("source")
    automation_markers = ("automation", "subagent", "scheduled")
    origin = f'{thread.get("threadSource")} {thread.get("originator")}'.lower()
    return (source in ("cli", "vscode", "appServer")
            and not thread.get("parentThreadId")
            and not any(word in origin for word in automation_markers))


def read_thread(client, root, report, thread, indexed):
    version = thread.get("cliVersion", "unknown")
    report.formats.add(f"codex-app-server/{version}")
    turns = 0
    for turn in pages(client, "thread/turns/list", {
            "threadId": thread["id"], "limit": 100, "itemsView": "full"}):
        turns += 1
        items = turn.get("items", [])
        if turn.get("itemsView", "full") != "full":
            items = [entry["item"] for entry in pages(client, "thread/items/list", {
                "threadId": thread["id"], "turnId": turn["id"], "limit": 100})]
        for item in items:
            if item.get("type") != "userMessage":
                continue
            report.add(item["id"], thread["id"], turn.get("startedAt"), item.get("content"),
                       {"kind": "interactive_user_candidate", "storage": str(root),
                        "method": "thread/turns/list", "version": version,
                        "timestamp_scope": "turn_started", "turn_id": turn["id"],
                        "client_id": item.get("clientId"),
                        "conversation_created_at": timestamp(thread.get("createdAt"))})
            if (report.source, str(item["id"])) in report.seen:
                indexed.add(thread["id"])
    return turns


def read_server(root, report, factory, indexed):
    client = factory(root)
    try:
        for archived in (False, True):
            for thread in pages(client, "thread/list", {
                    "limit": 100, "archived": archived, "modelProviders": [], "useStateDbOnly": True}):
                report.found = True
                if not interactive_thread(thread):
                    indexed.add(thread["id"])
                    report.stats["excluded_threads"] += 1
                    continue
                report.stats["threads"] += 1
                try:
                    read_thread(client, root, report, thread, indexed)
                    indexed.add(thread["id"])
                except READ_ERRORS:
                    report.issue("app_server_thread_read_failed", unavailable=True)
        read_rollouts(root, report, skip_ids=indexed, client=client)
    finally:
        client.close()


def read_rollouts(root, report, skip_ids=None, client=None):
    skip_ids = set() if skip_ids is None else skip_ids
    for directory in (root / "sessions", root / "archived_sessions"):
        for path in sorted(directory.rglob("*.jsonl")):
            report.found = True
            records = json_lines(path, report)
            metadata = None
            for number, record in records:
                payload = record.get("payload", {})
                if not isinstance(payload, dict):
                    report.issue("invalid_rollout_payload")
                    continue
                if record.get("type") == "session_meta":
                    metadata = payload
                    break
            if metadata is None:
                report.issue("missing_session_metadata")
                continue
            if metadata.get("id") in skip_ids:
                records.close()
                continue
            thread = {"source": metadata.get("source"), "parentThreadId": metadata.get("parent_thread_id"),
                      "threadSource": metadata.get("thread_source"), "originator": metadata.get("originator")}
            if not interactive_thread(thread):
                report.stats["excluded_threads"] += 1
                continue
            conversation = metadata.get("id", path.stem)
            version = metadata.get("cli_version", "unknown")
            paginated = metadata.get("history_mode") == "paginated"
            report.formats.add(f"codex-jsonl/{version}/{metadata.get('history_mode', 'legacy')}")
            if paginated:
                if client is not None:
                    try:
                        turns = read_thread(client, root, report,
                                            {"id": conversation, "cliVersion": version,
                                             "createdAt": metadata.get("timestamp")}, skip_ids)
                        if turns:
                            skip_ids.add(conversation)
                            report.stats["unlisted_paginated_threads_recovered"] += 1
                            records.close()
                            continue
                    except READ_ERRORS:
                        report.issue("unlisted_paginated_thread_read_failed", unavailable=True)
                        if conversation in skip_ids:
                            # Keep partial API messages; old JSONL IDs may describe the same input.
                            records.close()
                            continue
                report.issue("paginated_rollout_is_not_complete_history")
            for number, record in records:
                payload = record.get("payload", {})
                if not isinstance(payload, dict):
                    report.issue("invalid_rollout_payload")
                    continue
                text = None
                when = record.get("timestamp")
                identifier = None
                if record.get("type") == "event_msg" and payload.get("type") == "user_message":
                    text = payload.get("message")
                    identifier = payload.get("id")
                elif paginated and record.get("type") == "response_item" and payload.get("role") == "user":
                    retained = (record.get("metadata") or {}).get("retained_source") or {}
                    if ((record.get("metadata") or {}).get("inherited_user_message")
                            or not retained.get("complete")):
                        report.stats["excluded_origin"] += 1
                        continue
                    text = payload.get("content")
                    identifier = (retained.get("id") or {}).get("message_id") or payload.get("id")
                    when = (payload.get("internal_chat_message_metadata_passthrough") or {}).get("create_time")
                if text is not None:
                    report.add(identifier, conversation, when, text,
                               {"path": str(path), "line": number, "version": version,
                                "kind": "interactive_user_candidate", "timestamp_scope": "message"})


def collect_codex(since=None, until=None, home=None, roots=None, rpc_factory=None):
    home = Path(home or Path.home())
    if roots is None:
        roots = [home / ".codex"]
        if os.environ.get("CODEX_HOME"):
            roots.insert(0, Path(os.environ["CODEX_HOME"]))
    report = Report("codex", since, until)
    available = shutil.which("codex") or rpc_factory is not None
    visited = set()
    for root in roots:
        root = Path(root).resolve()
        if root in visited or not root.exists():
            continue
        visited.add(root)
        indexed = set()
        try:
            if not available:
                raise FileNotFoundError("codex executable unavailable")
            read_server(root, report, rpc_factory or ReadOnlyAppServer, indexed)
        except READ_ERRORS:
            report.issue("app_server_unavailable_using_local_rollouts", unavailable=True)
            read_rollouts(root, report, skip_ids=indexed)
    return report.result()
