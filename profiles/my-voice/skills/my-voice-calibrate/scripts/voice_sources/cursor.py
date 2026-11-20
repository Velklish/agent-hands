from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3

from .common import Report, readonly_db, timestamp


def varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError("Truncated protobuf varint")
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, offset
    raise ValueError("Oversized protobuf varint")


def fields(data):
    result = {}
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if not number:
            raise ValueError("Invalid protobuf field")
        if wire == 0:
            value, offset = varint(data, offset)
        elif wire in (1, 2, 5):
            length = 8 if wire == 1 else 4
            if wire == 2:
                length, offset = varint(data, offset)
            end = offset + length
            if end > len(data):
                raise ValueError("Truncated protobuf field")
            value, offset = data[offset:end], end
        else:
            raise ValueError("Unsupported protobuf wire type")
        result.setdefault(number, []).append(value)
    return result


def first(message, number, default=None):
    return message.get(number, [default])[0]


def blob(connection, reference):
    if isinstance(reference, bytes):
        reference = reference.hex()
    row = connection.execute("SELECT data FROM blobs WHERE id=?", (reference,)).fetchone()
    if row is None:
        raise ValueError("Missing reachable blob")
    return bytes(row[0])


def read_ide(path, report):
    report.found = True
    report.stats["ide_databases"] += 1
    try:
        with closing(readonly_db(path)) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "cursorDiskKV" not in tables:
                report.issue("unsupported_ide_database_schema")
                return
            for row in connection.execute("SELECT key,value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"):
                try:
                    if row["value"] is None:
                        report.stats["empty_composers"] += 1
                        continue
                    composer = json.loads(row["value"])
                    if not isinstance(composer, dict):
                        raise ValueError("Invalid composer data")
                    if composer.get("subagentInfo") or composer.get("isDraft") or composer.get("isEphemeral"):
                        report.stats["excluded_threads"] += 1
                        continue
                    conversation = composer.get("composerId", row["key"].split(":", 1)[1])
                    headers = composer.get("fullConversationHeadersOnly")
                    legacy = composer.get("conversation")
                    if isinstance(headers, list) and isinstance(composer.get("_v"), int) and composer["_v"] >= 2:
                        report.formats.add("cursor-ide-composer-v2/3.22.12")
                    elif isinstance(legacy, list) and composer.get("_v", 0) in (0, 1):
                        headers = legacy
                        report.formats.add("cursor-ide-inline-v0-v1")
                    else:
                        report.issue("unsupported_ide_composer_version")
                        continue
                    for header in headers:
                        if header.get("type") != 1:
                            continue
                        if headers is legacy:
                            body = header
                        else:
                            key = f"bubbleId:{conversation}:{header['bubbleId']}"
                            bubble = connection.execute("SELECT value FROM cursorDiskKV WHERE key=?", (key,)).fetchone()
                            if bubble is None or bubble[0] is None:
                                report.issue("missing_ide_bubble")
                                continue
                            body = json.loads(bubble[0])
                        if body.get("type") != 1 or any(body.get(flag) for flag in (
                                "skipRendering", "isDisplayOnly", "isSimulatedMsg", "isPlanExecution",
                                "sentByAgentId", "subagentSpawnTaskToolCallId")):
                            report.stats["excluded_origin"] += 1
                            continue
                        if not isinstance(body.get("text"), str):
                            report.issue("unsupported_ide_user_content")
                            continue
                        if not header.get("bubbleId"):
                            report.issue("missing_ide_message_id")
                            continue
                        when = body.get("createdAt") or body.get("startedAtMs")
                        report.add(header.get("bubbleId"), conversation, when, body["text"],
                                   {"path": str(path), "kind": "cursor_ide_human_bubble",
                                    "timestamp_scope": "message" if when else "unknown",
                                    "coverage": "composer_retained_headers",
                                    "conversation_created_at": timestamp(composer.get("createdAt"))})
                except (ValueError, TypeError, KeyError, AttributeError):
                    report.issue("invalid_ide_composer_or_bubble")
    except (sqlite3.Error, OSError):
        report.issue("ide_database_unreadable", unavailable=True)


def collect_cursor(since=None, until=None, home=None, root=None, ide_roots=None):
    home = Path(home or Path.home())
    root = Path(root or home / ".cursor/chats")
    report = Report("cursor", since, until)
    for path in sorted(root.glob("**/store.db")):
        report.found = True
        report.stats["databases"] += 1
        try:
            with closing(readonly_db(path)) as connection:
                row = connection.execute("SELECT value FROM meta WHERE key='0'").fetchone()
                if row is None:
                    raise ValueError("Missing conversation metadata")
                metadata = json.loads(bytes.fromhex(row[0]))
                report.formats.add("cursor-agent-protobuf/2026.09.26-dd393fe")
                if metadata.get("subagentInfo"):
                    report.stats["excluded_threads"] += 1
                    continue
                conversation = metadata.get("agentId", path.parent.name)
                current = fields(blob(connection, metadata["latestRootBlobId"]))
                for reference in current.get(8, []):
                    turn = fields(blob(connection, reference))
                    if 1 not in turn:
                        report.stats["excluded_shell_turns"] += 1
                        continue
                    agent_turn = fields(first(turn, 1))
                    user_ref = first(agent_turn, 1)
                    if user_ref is None:
                        raise ValueError("Missing turn user reference")
                    user = fields(blob(connection, user_ref))
                    if first(user, 5, 0) or first(user, 9, 0) or 14 in user or first(user, 27):
                        report.stats["excluded_origin"] += 1
                        continue
                    text = first(user, 1, b"").decode("utf-8")
                    if not text and first(user, 18):
                        text = blob(connection, first(user, 18)).decode("utf-8")
                    identifier = first(user, 2, b"").decode("utf-8") or user_ref.hex()
                    when = first(user, 25)
                    report.add(identifier, conversation, when, text,
                               {"path": str(path), "kind": "cursor_agent_user_message",
                                "coverage": "current_root_retained_turns",
                                "timestamp_scope": "message_started" if when else "unknown",
                                "conversation_created_at": timestamp(metadata.get("createdAt"))})
        except (sqlite3.Error, OSError):
            report.issue("cli_database_unreadable", unavailable=True)
        except (ValueError, TypeError, KeyError, AttributeError):
            report.issue("unsupported_cli_blob_or_metadata")
    if ide_roots is None:
        ide_roots = [home / "Library/Application Support/Cursor/User/globalStorage",
                     Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "Cursor/User/globalStorage",
                     Path(os.environ.get("APPDATA", home / "AppData/Roaming")) / "Cursor/User/globalStorage"]
        if os.environ.get("VSCODE_PORTABLE"):
            ide_roots.append(Path(os.environ["VSCODE_PORTABLE"]) / "user-data/User/globalStorage")
        if os.environ.get("VSCODE_APPDATA"):
            ide_roots.append(Path(os.environ["VSCODE_APPDATA"]) / "Cursor/User/globalStorage")
    visited = set()
    for directory in ide_roots:
        path = (Path(directory) / "state.vscdb").resolve()
        if path not in visited and path.exists():
            visited.add(path)
            read_ide(path, report)
    return report.result()
