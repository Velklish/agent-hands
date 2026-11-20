"""Shared message normalization; storage readers keep their own format rules."""

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3


def timestamp(value):
    if value is None:
        return None
    try:
        if isinstance(value, (float, int)) and not isinstance(value, bool):
            value = datetime.fromtimestamp(value / 1000 if value > 1e11 else value, timezone.utc)
        elif isinstance(value, str):
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if not isinstance(value, datetime) or value.tzinfo is None:
            return None
        return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def text_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            item["text"] for item in content
            if isinstance(item, dict) and item.get("type") in ("text", "input_text")
            and isinstance(item.get("text"), str) and item.get("visibility") != "hidden"
        )
    return ""


MACHINE_PREFIXES = (
    "# AGENTS.md instructions", "<environment_context>", "<user_instructions>",
    "<system-reminder>", "<task-notification>", "<teammate-message",
    "[bb message from thread:", "Your earlier AskUserQuestion tool call has finished.",
    "You are running a scheduled automation", "This session is being continued from",
    "A new goal has been set for this thread", "[Request interrupted by user",
)


def candidate_text(value):
    value = text_content(value).strip()
    if not value or value.startswith(MACHINE_PREFIXES):
        return ""
    # These wrappers describe tool setup, command output, or delegated messages.
    if re.match(r"^<(?:command-name|local-command|tool_result|automated|subagent)[\s>\-]", value):
        return ""
    return value


def json_lines(path, report):
    try:
        with path.open(encoding="utf-8") as stream:
            for number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError("Expected object")
                    yield number, value
                except (ValueError, TypeError):
                    report.issue("invalid_jsonl_record")
    except (OSError, UnicodeError):
        report.issue("history_file_unreadable", unavailable=True)


def readonly_db(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


class Report:
    def __init__(self, source, since=None, until=None):
        self.source = source
        self.since = timestamp(since)
        self.until = timestamp(until)
        if since is not None and self.since is None or until is not None and self.until is None:
            raise ValueError("Date boundaries must include a timezone")
        self.messages = []
        self.stats = Counter()
        self.issues = Counter()
        self.formats = set()
        self.seen = set()
        self.unavailable = False
        self.found = False

    def issue(self, reason, unavailable=False):
        self.issues[reason] += 1
        self.unavailable |= unavailable

    def add(self, identifier, conversation, when, text, origin):
        text = text_content(text)
        for tag, counter in (("send_user_message_question_reply", "excluded_question_reply_envelope"),
                             ("in-app-browser-context", "excluded_browser_context_envelope")):
            if re.search(r"(?m)^\s*<" + tag + r"(?:\s[^>]*)?>", text):
                self.stats[counter] += 1
                self.stats["excluded_content"] += 1
                return
        text = candidate_text(text)
        if not text:
            self.stats["excluded_content"] += 1
            return
        date = timestamp(when)
        if date is None and (self.since or self.until):
            self.issue("undated_message_outside_filter")
            return
        if date and (self.since and date < self.since or self.until and date >= self.until):
            self.stats["outside_period"] += 1
            return
        identifier = str(identifier or hashlib.sha256(
            f"{conversation}\0{date}\0{text}".encode()).hexdigest())
        key = (self.source, identifier)
        if key in self.seen:
            self.stats["duplicates"] += 1
            return
        self.seen.add(key)
        if date is None:
            self.stats["undated_messages"] += 1
        self.messages.append({"source": self.source, "id": identifier,
                              "timestamp": date, "text": text,
                              "conversation_id": str(conversation), "origin": origin})

    def result(self):
        if self.issues:
            status = "partial" if self.messages else "unavailable" if self.unavailable else "unsupported"
        else:
            status = "ready" if self.found else "absent"
        self.messages.sort(key=lambda item: (item["timestamp"] or "", item["id"]))
        return {"source": self.source, "status": status,
                "reason": "; ".join(sorted(self.issues)) or ("no_local_history" if not self.found else None),
                "messages": self.messages, "stats": dict(self.stats),
                "issues": dict(self.issues), "formats": sorted(self.formats)}
