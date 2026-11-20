import os
from pathlib import Path

from .common import Report, json_lines


def collect_claude(since=None, until=None, home=None, root=None):
    home = Path(home or Path.home())
    config = Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude"))
    root = Path(root or config / "projects")
    report = Report("claude", since, until)
    try:
        files = sorted(root.glob("*/*.jsonl"))
    except OSError:
        report.issue("history_directory_unreadable", unavailable=True)
        return report.result()
    report.found = bool(files)
    for path in files:
        report.stats["files"] += 1
        for number, record in json_lines(path, report):
            if record.get("type") != "user":
                continue
            message = record.get("message", {})
            if not isinstance(message, dict) or message.get("role") != "user":
                report.issue("unknown_user_record")
                continue
            if (record.get("isMeta") or record.get("isSidechain")
                    or record.get("promptSource") == "system"
                    or record.get("turnOrigin") not in (None, "human")
                    or record.get("userType") not in (None, "external")):
                report.stats["excluded_origin"] += 1
                continue
            version = str(record.get("version", "unknown"))
            report.formats.add(f"claude-jsonl/{version}")
            report.add(record.get("uuid"), record.get("sessionId", path.stem),
                       record.get("timestamp"), message.get("content"),
                       {"path": str(path), "line": number, "version": version,
                        "kind": "interactive_user_candidate", "timestamp_scope": "message",
                        "prompt_source": record.get("promptSource"),
                        "turn_origin": record.get("turnOrigin")})
    return report.result()
