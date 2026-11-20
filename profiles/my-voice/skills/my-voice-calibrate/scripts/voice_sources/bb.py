import json
import shutil
import subprocess

from .common import Report


def run_json(args):
    process = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if process.returncode:
        raise RuntimeError("bb_command_failed")
    data = json.loads(process.stdout)
    if not isinstance(data, list):
        raise ValueError("bb_response_not_array")
    return data


def collect_bb(since=None, until=None, runner=None):
    report = Report("bb", since, until)
    if runner is None and not shutil.which("bb"):
        return report.result()
    runner = runner or run_json
    report.formats.add("bb-client-turn-requested/0.46")
    try:
        threads = {}
        for archived in (False, True):
            args = ["bb", "thread", "list", "--json", "--include-hidden"]
            if archived:
                args.append("--archived")
            for thread in runner(args):
                threads[thread["id"]] = thread
        report.found = bool(threads)
        for thread in threads.values():
            report.stats["threads"] += 1
            after = None
            pending = {}
            accepted = {}
            checkpoints = {}
            while True:
                args = ["bb", "thread", "messages", thread["id"], "--json", "--limit", "500"]
                if after is not None:
                    args += ["--after-seq", str(after)]
                page = runner(args)
                if not page:
                    break
                next_after = max(event["seq"] for event in page)
                if after is not None and next_after <= after:
                    raise ValueError("bb_pagination_did_not_advance")
                after = next_after
                for event in page:
                    data = event.get("data", {})
                    bb_turn = (event.get("scope") or {}).get("turnId")
                    if event.get("type") == "turn/input/accepted":
                        accepted[data.get("clientRequestId")] = (data.get("providerThreadId"), bb_turn)
                    if event.get("type") == "turn/completed" and bb_turn and data.get("providerCheckpointId"):
                        checkpoints[bb_turn] = data["providerCheckpointId"]
                    if event.get("type") != "client/turn/requested":
                        continue
                    if (data.get("initiator") != "user" or data.get("senderThreadId")
                            or data.get("systemMessageKind") not in (None, "unlabeled")
                            or data.get("source") not in ("spawn", "tell")):
                        report.stats["excluded_origin"] += 1
                        continue
                    pending[data.get("requestId", event["id"])] = event
            for request_id, event in pending.items():
                if request_id not in accepted:
                    report.stats["unaccepted_requests"] += 1
                    continue
                provider_thread, bb_turn = accepted[request_id]
                report.add(request_id, thread["id"], event.get("createdAt"), event["data"].get("input"),
                           {"kind": "bb_user_initiated_request", "event_seq": event["seq"],
                            "timestamp_scope": "request", "source": event["data"].get("source"),
                            "provider_id": thread.get("providerId"),
                            "provider_thread_id": provider_thread,
                            "provider_turn_id": checkpoints.get(bb_turn),
                            "authorship": "candidate_not_verified_human"})
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, RuntimeError):
        report.issue("bb_history_unavailable_or_schema_changed", unavailable=True)
    return report.result()
