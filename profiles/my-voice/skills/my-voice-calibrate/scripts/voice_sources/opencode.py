import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3

from .common import Report, readonly_db


def collect_opencode(since=None, until=None, home=None, root=None):
    home = Path(home or Path.home())
    data_home = Path(os.environ.get("XDG_DATA_HOME", home / ".local/share"))
    root = Path(root or data_home / "opencode")
    report = Report("opencode", since, until)
    path = root / "opencode.db"
    if not path.exists():
        if (root / "storage").exists():
            report.issue("legacy_json_storage_not_supported")
        return report.result()
    report.found = True
    try:
        with closing(readonly_db(path)) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"session_v2", "session_message"}.issubset(tables):
                report.issue("unsupported_opencode_schema")
                return report.result()
            sessions = {row["id"]: dict(row) for row in connection.execute(
                "SELECT id,parent_id,version,metadata FROM session_v2")}
            for row in connection.execute(
                    "SELECT id,session_id,time_created,data FROM session_message WHERE type='user' ORDER BY seq"):
                session = sessions.get(row["session_id"])
                if not session:
                    report.issue("orphan_user_message")
                    continue
                if session["parent_id"]:
                    report.stats["excluded_origin"] += 1
                    continue
                try:
                    data = json.loads(row["data"])
                    if not isinstance(data, dict) or not isinstance(data.get("text"), str):
                        raise ValueError("Unknown user data")
                except (ValueError, TypeError):
                    report.issue("invalid_user_data")
                    continue
                report.formats.add(f"opencode-session-v2/{session['version']}")
                report.add(row["id"], row["session_id"], row["time_created"], data["text"],
                           {"path": str(path), "version": session["version"],
                            "kind": "session_message_user", "timestamp_scope": "message"})
    except (sqlite3.Error, OSError):
        report.issue("database_unreadable", unavailable=True)
    return report.result()
