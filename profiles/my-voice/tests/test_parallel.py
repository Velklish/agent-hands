from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import ExitStack
import queue
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/my-voice-calibrate/scripts'))
from voice_sources import LOCAL_SOURCES, collect_sources
from voice_sources.common import Report


class ParallelTests(unittest.TestCase):
    def test_sources_overlap_with_bound_and_keep_final_order(self):
        names = ('claude', 'codex', 'bb', 'cursor', 'opencode')
        started = queue.Queue()
        release = {name: threading.Event() for name in names}
        progress = []

        def collector(name):
            def run(*_):
                started.put(name)
                if not release[name].wait(5):
                    raise AssertionError('Test did not release source')
                report = Report(name)
                report.found = True
                report.add(name, name, None, 'Synthetic author text', {})
                return report.result()
            return run

        with ExitStack() as stack:
            for name in names:
                stack.enter_context(patch('voice_sources.collect_' + name, collector(name)))
            with ThreadPoolExecutor(max_workers=1) as executor:
                pending = executor.submit(collect_sources, LOCAL_SOURCES, workers=2, progress=progress.append)
                try:
                    first = started.get(timeout=5)
                    second = started.get(timeout=5)
                    self.assertEqual({'claude', 'codex'}, {first, second})
                    self.assertTrue(started.empty())
                    self.assertFalse(pending.done())
                    # Complete in a different order; only one new task can take each slot.
                    release[second].set()
                    self.assertEqual('bb', started.get(timeout=5))
                    self.assertTrue(started.empty())
                finally:
                    for event in release.values():
                        event.set()
                reports = pending.result(timeout=5)
        self.assertEqual(list(names), [report['source'] for report in reports])
        self.assertEqual(5, sum(' started' in line for line in progress))
        self.assertEqual(5, sum(' finished' in line for line in progress))
        self.assertFalse(any('Synthetic author text' in line for line in progress))

    def test_one_failed_collector_preserves_other_sources_without_error_text(self):
        with ExitStack() as stack:
            for name in ('claude', 'bb', 'cursor', 'opencode'):
                stack.enter_context(patch('voice_sources.collect_' + name, return_value=Report(name).result()))
            stack.enter_context(patch('voice_sources.collect_codex', side_effect=RuntimeError('PRIVATE TOKEN')))
            progress = []
            reports = collect_sources(LOCAL_SOURCES, workers=3, progress=progress.append)
        self.assertEqual(['absent', 'unavailable', 'absent', 'absent', 'absent'],
                         [report['status'] for report in reports])
        self.assertEqual({'collector_failed': 1}, reports[1]['issues'])
        self.assertNotIn('PRIVATE TOKEN', str(reports) + str(progress))

    def test_worker_limit_rejects_invalid_values(self):
        for workers in (0, 6, -1):
            with self.subTest(workers=workers), self.assertRaises(ValueError):
                collect_sources(LOCAL_SOURCES, workers=workers)

    def test_waiting_sources_emit_heartbeat_without_private_content(self):
        release = threading.Event()
        progress = []
        first_wait = True

        def delayed(name):
            def run(*_):
                if not release.wait(5):
                    raise AssertionError('Test did not release source')
                return Report(name).result()
            return run

        def controlled_wait(pending, **arguments):
            nonlocal first_wait
            if first_wait:
                first_wait = False
                release.set()
                return set(), pending
            return wait(pending, **arguments)

        with ExitStack() as stack:
            for name in ('claude', 'codex', 'bb', 'cursor', 'opencode'):
                stack.enter_context(patch('voice_sources.collect_' + name, delayed(name)))
            stack.enter_context(patch('voice_sources.wait', side_effect=controlled_wait))
            collect_sources(LOCAL_SOURCES, workers=2, progress=progress.append)
        self.assertIn('waiting: bb, claude, codex, cursor, opencode', progress)

    def test_bb_codex_reconciliation_runs_after_collectors_join(self):
        reports = {}
        for name in ('claude', 'codex', 'bb', 'cursor', 'opencode'):
            reports[name] = Report(name)
        reports['bb'].add('request', 'bb-thread', None, 'Synthetic answer',
                          {'provider_id': 'codex', 'provider_thread_id': 'native-thread',
                           'provider_turn_id': 'native-turn'})
        reports['codex'].add('native-input', 'native-thread', None, 'Synthetic answer',
                             {'turn_id': 'native-turn'})
        with ExitStack() as stack:
            for name, report in reports.items():
                stack.enter_context(patch('voice_sources.collect_' + name, return_value=report.result()))
            results = collect_sources(LOCAL_SOURCES, workers=3)
        self.assertEqual([], results[1]['messages'])
        self.assertEqual(1, results[1]['stats']['bb_duplicates'])
        self.assertEqual(1, len(results[2]['messages']))
