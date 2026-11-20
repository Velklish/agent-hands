from collections import defaultdict, deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import threading

from .bb import collect_bb
from .claude import collect_claude
from .codex import collect_codex
from .common import Report
from .cursor import collect_cursor
from .opencode import collect_opencode

LOCAL_SOURCES = ('claude', 'codex', 'bb', 'cursor', 'opencode')


def collect_sources(selected, since=None, until=None, home=None, workers=3, progress=None):
    if workers not in range(1, 6):
        raise ValueError("workers must be between 1 and 5")
    readers = {"claude": collect_claude, "codex": collect_codex, "bb": collect_bb,
               "cursor": collect_cursor, "opencode": collect_opencode}
    if set(selected) - readers.keys():
        raise ValueError("Unknown local source")
    sources = [(name, readers[name], (since, until) if name == 'bb' else (since, until, home))
               for name in LOCAL_SOURCES if name in selected]
    progress_lock = threading.Lock()

    def emit(message):
        if progress:
            with progress_lock:
                progress(message)

    def run(name, reader, arguments):
        emit(f"{name} started")
        try:
            return reader(*arguments)
        except Exception:
            # Error messages can include local paths, SQL values, or private prose.
            report = Report(name)
            report.issue("collector_failed", unavailable=True)
            return report.result()

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(run, *source): source[0] for source in sources}
        pending = set(futures)
        while pending:
            done, pending = wait(pending, timeout=10, return_when=FIRST_COMPLETED)
            if not done:
                emit("waiting: " + ", ".join(sorted(futures[future] for future in pending)))
            for future in done:
                report = future.result()
                emit(f"{futures[future]} finished status={report['status']} messages={len(report['messages'])}")
        reports = [future.result() for future in futures]
    reconcile_bb_codex(reports)
    return reports


def reconcile_bb_codex(reports):
    bb_messages = {message["id"]: message for report in reports if report["source"] == "bb"
                   for message in report["messages"] if message["origin"].get("provider_id") == "codex"}
    for report in reports:
        if report["source"] != "codex":
            continue
        original = report["messages"]
        consumed = set()
        matched = set()
        direct = 0
        for message in original:
            request_id = message["origin"].get("client_id")
            bb = bb_messages.get(request_id)
            if (bb is not None and request_id not in consumed and message["text"] == bb["text"]
                    and bb["origin"].get("provider_thread_id") in (None, message["conversation_id"])):
                consumed.add(request_id)
                matched.add(message["id"])
                direct += 1
        by_turn = defaultdict(deque)
        by_conversation_text = defaultdict(list)
        for identifier, bb in bb_messages.items():
            origin = bb["origin"]
            conversation = origin.get("provider_thread_id")
            if not conversation:
                continue
            by_conversation_text[(conversation, bb["text"])].append(bb)
            if identifier not in consumed and origin.get("provider_turn_id"):
                by_turn[(conversation, origin["provider_turn_id"], bb["text"])].append(identifier)
        for message in original:
            if message["id"] in matched:
                continue
            key = (message["conversation_id"], message["origin"].get("turn_id"), message["text"])
            if by_turn[key]:
                consumed.add(by_turn[key].popleft())
                matched.add(message["id"])
        remaining = [message for message in original if message["id"] not in matched]
        unresolved = 0
        for message in remaining:
            turn = message["origin"].get("turn_id")
            candidates = by_conversation_text[(message["conversation_id"], message["text"])]
            direct_candidate = bb_messages.get(message["origin"].get("client_id"))
            if ((direct_candidate is not None and direct_candidate["origin"].get("provider_thread_id")
                 in (None, message["conversation_id"]))
                    or any(not turn or not bb["origin"].get("provider_turn_id")
                           or bb["origin"]["provider_turn_id"] == turn for bb in candidates)):
                unresolved += 1
        report["messages"] = remaining
        stats = report["stats"]
        stats["bb_duplicates"] = stats.get("bb_duplicates", 0) + len(matched)
        stats["bb_client_id_duplicates"] = stats.get("bb_client_id_duplicates", 0) + direct
        stats["bb_provider_turn_duplicates"] = stats.get("bb_provider_turn_duplicates", 0) + len(matched) - direct
        if unresolved:
            report["issues"]["bb_overlap_unresolved"] = unresolved
            report["status"] = "partial"
            report["reason"] = "; ".join(sorted(report["issues"]))
