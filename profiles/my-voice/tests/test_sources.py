import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skills/my-voice-calibrate/scripts'
sys.path.insert(0, str(SCRIPTS))
from voice_sources.common import Report, timestamp
from voice_sources.claude import collect_claude
from voice_sources.codex import ReadOnlyAppServer, collect_codex, pages
from voice_sources.bb import collect_bb
from voice_sources.cursor import collect_cursor, fields
from voice_sources.opencode import collect_opencode
from voice_sources import reconcile_bb_codex


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(item) + '\n' for item in records))


def vint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def field(number, value):
    if isinstance(value, int):
        return vint(number << 3) + vint(value)
    if isinstance(value, str):
        value = value.encode()
    return vint(number << 3 | 2) + vint(len(value)) + value


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='my-voice-sources-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)

    def test_timestamp_and_period_are_utc_and_half_open(self):
        report = Report('test', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')
        report.add('yes', 's', '2026-01-01T03:00:00.5+03:00', 'Synthetic user prose', {})
        report.add('before', 's', '2025-12-31T23:59:59Z', 'Before', {})
        report.add('end', 's', '2026-01-02T00:00:00Z', 'After', {})
        self.assertEqual(['yes'], [m['id'] for m in report.messages])
        self.assertEqual('2026-01-01T00:00:00.500000Z', report.messages[0]['timestamp'])
        self.assertIsNone(timestamp('2026-01-01T12:00:00'))

    def test_duplicates_use_identity_not_text_only(self):
        report = Report('test')
        for identifier in ('a', 'a', 'b'):
            report.add(identifier, 's', None, 'Same short reply', {'timestamp_scope': 'unknown'})
        self.assertEqual(2, len(report.messages))
        self.assertIsNone(report.messages[0]['timestamp'])
        self.assertEqual(1, report.stats['duplicates'])

    def test_codex_mixed_envelopes_do_not_become_author_samples(self):
        fixtures = Path(__file__).parent / 'fixtures'
        report = Report('codex')
        for name in ('mixed-question-reply', 'mixed-browser-context'):
            report.add(name, 'thread', None, (fixtures / (name + '.txt')).read_text(),
                       {'kind': 'interactive_user_candidate'})
        report.add('human', 'thread', None, 'A normal user mentions in-app-browser-context inline', {})
        self.assertEqual(['human'], [message['id'] for message in report.messages])
        self.assertEqual(1, report.stats['excluded_question_reply_envelope'])
        self.assertEqual(1, report.stats['excluded_browser_context_envelope'])

    def test_claude_excludes_tools_sidechains_and_system_origins(self):
        base = {'type': 'user', 'message': {'role': 'user', 'content': 'Synthetic original prose'},
                'sessionId': 'session', 'version': '2.1.286', 'userType': 'external',
                'timestamp': '2026-05-01T10:00:00Z'}
        rows = [dict(base, uuid='human', turnOrigin='human'), dict(base, uuid='meta', isMeta=True),
                dict(base, uuid='peer', turnOrigin='peer'), dict(base, uuid='job', promptSource='system'),
                dict(base, uuid='agent', isSidechain=True),
                dict(base, uuid='tool', message={'role': 'user', 'content': [{'type': 'tool_result', 'content': 'Not prose'}]}),
                dict(base, uuid='wrap', message={'role': 'user', 'content': '# AGENTS.md instructions for a fixture'})]
        path = self.home / '.claude/projects/project/session.jsonl'
        write_jsonl(path, rows)
        report = collect_claude(home=self.home, root=path.parents[1])
        self.assertEqual('ready', report['status'])
        self.assertEqual(['human'], [m['id'] for m in report['messages']])
        self.assertEqual(4, report['stats']['excluded_origin'])

    def test_claude_invalid_json_is_partial_not_silent_success(self):
        path = self.home / 'claude/project/session.jsonl'
        write_jsonl(path, [{'type': 'user', 'uuid': 'u', 'message': {'role': 'user', 'content': 'A human sentence'}}])
        with path.open('a') as stream:
            stream.write('{broken\n')
        report = collect_claude(root=path.parents[1])
        self.assertEqual('partial', report['status'])
        self.assertEqual(1, report['issues']['invalid_jsonl_record'])

    def test_codex_legacy_uses_event_messages_and_skips_subagents(self):
        root = self.home / '.codex'
        meta = {'type': 'session_meta', 'payload': {'id': 'root', 'source': 'cli', 'cli_version': '0.156.1'}}
        event = {'type': 'event_msg', 'timestamp': '2026-04-05T12:00:00Z',
                 'payload': {'type': 'user_message', 'message': 'Original user sentence'}}
        duplicate = {'type': 'response_item', 'timestamp': event['timestamp'],
                     'payload': {'role': 'user', 'content': [{'type': 'input_text', 'text': 'Original user sentence'}]}}
        write_jsonl(root / 'sessions/root.jsonl', [meta, event, duplicate])
        write_jsonl(root / 'sessions/child.jsonl', [dict(meta, payload={'source': {'subagent': {}}, 'id': 'child'}), event])
        def failing(_):
            raise OSError('Unavailable runtime')
        report = collect_codex(roots=[root], rpc_factory=failing)
        self.assertEqual(1, len(report['messages']))
        self.assertEqual('partial', report['status'])
        self.assertEqual(1, report['stats']['excluded_threads'])

    def test_codex_custom_originator_exclusion_covers_api_and_fallback(self):
        root = self.home / '.codex'
        secret_event = {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Generated text'}}
        for name, originator in [('from-file', 'ExampleDriver:v1'), ('human', 'interactive')]:
            write_jsonl(root / 'sessions' / f'{name}.jsonl', [
                {'type': 'session_meta', 'payload': {'id': name, 'source': 'cli', 'originator': originator}},
                secret_event if name == 'from-file' else dict(secret_event, payload={'type': 'user_message', 'message': 'Human text'}),
            ])

        class Client:
            def call(self, method, params):
                if method == 'thread/list':
                    return {'data': [] if params['archived'] else [
                        {'id': 'from-api', 'source': 'appServer', 'originator': 'EXAMPLEDRIVER:v2'}]}
                raise AssertionError('Excluded API thread was read')

            def close(self):
                pass

        report = collect_codex(roots=[root], rpc_factory=lambda _: Client(), excluded_originators=('exampledriver',))
        self.assertEqual('ready', report['status'])
        self.assertEqual(2, report['stats']['excluded_threads'])
        self.assertEqual(['Human text'], [message['text'] for message in report['messages']])

    def test_codex_paginated_rollout_requires_complete_retained_source(self):
        root = self.home / '.codex'
        meta = {'type': 'session_meta', 'payload': {'id': 'root', 'source': 'vscode',
                'history_mode': 'paginated', 'cli_version': '0.162.1'}}
        user = {'type': 'response_item', 'metadata': {'retained_source': {'complete': True, 'id': {'message_id': 'm'}}},
                'payload': {'role': 'user', 'content': [{'type': 'input_text', 'text': 'Actual local text'}],
                            'internal_chat_message_metadata_passthrough': {'create_time': '2026-01-01T00:00:00Z'}}}
        inherited = dict(user, metadata={'inherited_user_message': True, 'retained_source': {'complete': True}})
        incomplete = dict(user, metadata={'retained_source': {'complete': False}})
        write_jsonl(root / 'sessions/root.jsonl', [meta, user, inherited, incomplete])
        def failing(_):
            raise OSError('Unavailable runtime')
        report = collect_codex(roots=[root], rpc_factory=failing)
        self.assertEqual(['m'], [m['id'] for m in report['messages']])
        self.assertIn('paginated_rollout_is_not_complete_history', report['issues'])

    def test_codex_pages_turns_items_and_archives_without_starting_turns(self):
        root = self.home / '.codex'
        root.mkdir()
        class Client:
            closed = False
            calls = []
            def call(self, method, params):
                self.calls.append((method, params))
                if method == 'thread/list':
                    if params.get('archived'):
                        return {'data': [], 'nextCursor': None}
                    if params.get('cursor'):
                        return {'data': [{'id': 'child', 'source': {'subAgent': {}}, 'parentThreadId': 't'}]}
                    return {'data': [{'id': 't', 'source': 'cli', 'cliVersion': '0.162.1'}], 'nextCursor': 'threads2'}
                if method == 'thread/turns/list':
                    return {'data': [{'id': 'turn', 'startedAt': 1767225600, 'itemsView': 'summary', 'items': []}]}
                if method == 'thread/items/list':
                    if params.get('cursor'):
                        return {'data': [{'item': {'id': 'a', 'type': 'agentMessage', 'text': 'Not human'}}]}
                    return {'data': [{'item': {'id': 'u', 'type': 'userMessage', 'clientId': 'request',
                            'content': [{'type': 'text', 'text': 'Synthetic user text'}]}}], 'nextCursor': 'items2'}
                raise AssertionError(method)
            def close(self):
                self.closed = True
        client = Client()
        report = collect_codex(roots=[root], rpc_factory=lambda _: client)
        self.assertEqual('ready', report['status'])
        self.assertEqual(1, len(report['messages']))
        self.assertEqual('turn_started', report['messages'][0]['origin']['timestamp_scope'])
        self.assertEqual('2026-01-01T00:00:00.000000Z', report['messages'][0]['timestamp'])
        self.assertTrue(client.closed)
        self.assertTrue(all(method in ReadOnlyAppServer.METHODS for method, _ in client.calls))
        self.assertTrue(any(params.get('cursor') == 'items2' for _, params in client.calls))

    def test_codex_cursor_loop_is_rejected(self):
        class Client:
            def call(self, *_):
                return {'data': [], 'nextCursor': 'same'}
        with self.assertRaisesRegex(ValueError, 'did not advance'):
            list(pages(Client(), 'thread/list', {}))

    def test_codex_includes_unindexed_legacy_rollout_after_reading_state_database(self):
        root = self.home / '.codex'
        write_jsonl(root / 'archived_sessions/old.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'old', 'source': 'cli', 'cli_version': '0.156.1'}},
            {'type': 'event_msg', 'timestamp': '2026-01-01T00:00:00Z',
             'payload': {'type': 'user_message', 'message': 'A historical user message'}}])
        class Client:
            def call(self, *_):
                return {'data': []}
            def close(self):
                pass
        report = collect_codex(roots=[root], rpc_factory=lambda _: Client())
        self.assertEqual('ready', report['status'])
        self.assertEqual(['old'], [message['conversation_id'] for message in report['messages']])

    def test_codex_recovers_unlisted_paginated_thread_through_read_api(self):
        root = self.home / '.codex'
        write_jsonl(root / 'sessions/unlisted.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'unlisted', 'source': 'vscode',
                                               'history_mode': 'paginated'}},
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Only the retained portion'}}])

        class Client:
            def call(self, method, params):
                if method == 'thread/list':
                    return {'data': []}
                if params.get('cursor'):
                    return {'data': [{'id': 'older', 'startedAt': 1767225600, 'items': [
                        {'type': 'userMessage', 'id': 'older-user', 'content': 'Older API text'}]}]}
                return {'data': [{'id': 'current', 'startedAt': 1767225600, 'items': [
                    {'type': 'userMessage', 'id': 'current-user', 'content': 'Only the retained portion'}]}],
                    'nextCursor': 'older-page'}
            def close(self):
                pass

        report = collect_codex(roots=[root], rpc_factory=lambda _: Client())
        self.assertEqual('ready', report['status'])
        self.assertEqual(['current-user', 'older-user'], [message['id'] for message in report['messages']])
        self.assertEqual(1, report['stats']['unlisted_paginated_threads_recovered'])

    def test_codex_empty_api_does_not_certify_unlisted_paginated_rollout(self):
        root = self.home / '.codex'
        write_jsonl(root / 'sessions/unlisted.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'unlisted', 'source': 'vscode',
                                               'history_mode': 'paginated'}},
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Retained portion'}}])

        class Client:
            def call(self, *_):
                return {'data': []}
            def close(self):
                pass

        report = collect_codex(roots=[root], rpc_factory=lambda _: Client())
        self.assertEqual('partial', report['status'])
        self.assertEqual(['Retained portion'], [message['text'] for message in report['messages']])
        self.assertEqual(1, report['issues']['paginated_rollout_is_not_complete_history'])

    def test_codex_recovered_thread_is_not_duplicated_when_server_close_fails(self):
        root = self.home / '.codex'
        write_jsonl(root / 'sessions/unlisted.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'unlisted', 'source': 'vscode',
                                               'history_mode': 'paginated'}},
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Retained portion'}}])

        class Client:
            def call(self, method, params):
                if method == 'thread/list':
                    return {'data': []}
                return {'data': [{'id': 'turn', 'items': [
                    {'type': 'userMessage', 'id': 'api-id', 'content': 'Retained portion'}]}]}
            def close(self):
                raise RuntimeError('Synthetic failure on close')

        report = collect_codex(roots=[root], rpc_factory=lambda _: Client())
        self.assertEqual(['api-id'], [message['id'] for message in report['messages']])

    def test_codex_unlisted_recovery_page_failure_preserves_api_messages_once(self):
        root = self.home / '.codex'
        write_jsonl(root / 'sessions/unlisted.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'unlisted', 'source': 'vscode',
                                               'history_mode': 'paginated'}},
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Retained portion'}}])

        class Client:
            def call(self, method, params):
                if method == 'thread/list':
                    return {'data': []}
                if params.get('cursor'):
                    raise RuntimeError('Synthetic page failure')
                return {'data': [{'id': 'turn', 'items': [
                    {'type': 'userMessage', 'id': 'api-id', 'content': 'Retained portion'},
                    {'type': 'userMessage', 'id': 'api-only', 'content': 'API only portion'}]}],
                    'nextCursor': 'next'}
            def close(self):
                pass

        report = collect_codex(roots=[root], rpc_factory=lambda _: Client())
        self.assertEqual('partial', report['status'])
        self.assertEqual(['api-id', 'api-only'], [message['id'] for message in report['messages']])
        self.assertEqual(1, report['issues']['unlisted_paginated_thread_read_failed'])

    def test_codex_failed_thread_does_not_block_next_thread(self):
        root = self.home / '.codex'
        root.mkdir()

        class Client:
            def call(self, method, params):
                if method == 'thread/list':
                    return {'data': [] if params['archived'] else [
                        {'id': 'failed', 'source': 'cli'}, {'id': 'good', 'source': 'cli'}]}
                if params['threadId'] == 'failed':
                    raise RuntimeError('Synthetic first thread failure')
                return {'data': [{'id': 'turn', 'items': [
                    {'type': 'userMessage', 'id': 'saved', 'content': 'Second thread text'}]}]}
            def close(self):
                pass

        report = collect_codex(roots=[root], rpc_factory=lambda _: Client())
        self.assertEqual('partial', report['status'])
        self.assertEqual(['saved'], [message['id'] for message in report['messages']])
        self.assertEqual(1, report['issues']['app_server_thread_read_failed'])

    def test_codex_fallback_preserves_api_only_messages_without_readding_rollouts(self):
        root = self.home / '.codex'
        for identifier, text in [('read', 'Original user message'), ('failed', 'Recovered from local history')]:
            write_jsonl(root / f'sessions/{identifier}.jsonl', [
                {'type': 'session_meta', 'payload': {'id': identifier, 'source': 'cli'}},
                {'type': 'event_msg', 'timestamp': '2026-01-01T00:00:00Z',
                 'payload': {'type': 'user_message', 'message': text}}])
        class Client:
            def call(self, method, params):
                if method == 'thread/list':
                    return {'data': [{'id': 'read', 'source': 'cli'}, {'id': 'failed', 'source': 'cli'}]}
                if params['threadId'] == 'failed':
                    raise RuntimeError('Synthetic failure after one successful thread')
                return {'data': [{'id': 'turn', 'startedAt': 1767225600, 'items': [
                    {'id': 'api-id', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'Original user message'}]},
                    {'id': 'api-only', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'Stored only by API'}]}]}]}
            def close(self):
                pass
        report = collect_codex(roots=[root], rpc_factory=lambda _: Client())
        self.assertEqual('partial', report['status'])
        self.assertEqual(['Original user message', 'Recovered from local history', 'Stored only by API'],
                         sorted(message['text'] for message in report['messages']))

    def test_codex_turn_page_failure_keeps_partial_thread_once(self):
        root = self.home / '.codex'
        write_jsonl(root / 'sessions/thread.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'thread', 'source': 'cli'}},
            {'type': 'event_msg', 'timestamp': '2026-01-01T00:00:00Z',
             'payload': {'type': 'user_message', 'message': 'First visible message'}}])
        class Client:
            def call(self, method, params):
                if method == 'thread/list':
                    return {'data': [{'id': 'thread', 'source': 'cli'}]}
                if params.get('cursor'):
                    raise RuntimeError('Synthetic second page failure')
                return {'data': [{'id': 'turn', 'startedAt': 1767225600, 'items': [
                    {'id': 'api-id', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'First visible message'}]},
                    {'id': 'api-only', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'API only message'}]}]}],
                    'nextCursor': 'second-page'}
            def close(self):
                pass
        report = collect_codex(roots=[root], rpc_factory=lambda _: Client())
        self.assertEqual('partial', report['status'])
        self.assertEqual(['api-id', 'api-only'], sorted(message['id'] for message in report['messages']))

    def test_bb_requires_user_origin_and_acceptance_across_pages(self):
        calls = []
        def runner(args):
            calls.append(args)
            if args[2] == 'list':
                return [] if '--archived' in args else [{'id': 't'}]
            if '--after-seq' not in args:
                events = []
                for number, (initiator, sender) in enumerate([('user', None), ('system', None), ('user', 'other')], 1):
                    events.append({'id': str(number), 'seq': number, 'createdAt': '2026-01-01T00:00:00Z',
                        'type': 'client/turn/requested', 'data': {'requestId': str(number), 'source': 'tell',
                        'initiator': initiator, 'senderThreadId': sender, 'systemMessageKind': 'unlabeled',
                        'input': [{'type': 'text', 'text': 'Synthetic request'}]}})
                return events
            if args[-1] == '3':
                return [{'seq': 4, 'type': 'turn/input/accepted', 'data': {'clientRequestId': '1'}}]
            return []
        report = collect_bb(runner=runner)
        self.assertEqual('ready', report['status'])
        self.assertEqual(['1'], [m['id'] for m in report['messages']])
        self.assertEqual(2, report['stats']['excluded_origin'])
        self.assertTrue(any('--archived' in call for call in calls))

    def test_bb_child_thread_keeps_human_followup_and_excludes_agent_request(self):
        def runner(args):
            if args[2] == 'list':
                return [] if '--archived' in args else [{'id': 'child', 'parentThreadId': 'parent'}]
            if '--after-seq' in args:
                return []
            events = []
            for number, initiator in enumerate(('agent', 'user'), 1):
                events.append({'id': str(number), 'seq': number, 'createdAt': '2026-01-01T00:00:00Z',
                    'type': 'client/turn/requested', 'data': {'requestId': str(number), 'source': 'tell',
                    'initiator': initiator, 'senderThreadId': 'parent' if initiator == 'agent' else None,
                    'systemMessageKind': 'unlabeled', 'input': [{'type': 'text', 'text': initiator + ' message'}]}})
                events.append({'id': 'accepted-' + str(number), 'seq': number + 2,
                               'type': 'turn/input/accepted', 'data': {'clientRequestId': str(number)}})
            return events
        report = collect_bb(runner=runner)
        self.assertEqual(['user message'], [message['text'] for message in report['messages']])
        self.assertEqual(1, report['stats']['excluded_origin'])

    def test_bb_retains_provider_identity_from_accepted_and_completed_events(self):
        def runner(args):
            if args[2] == 'list':
                return [] if '--archived' in args else [{'id': 'bb-thread', 'providerId': 'codex'}]
            if '--after-seq' in args:
                if args[-1] == '2':
                    return [{'id': 'done', 'seq': 3, 'type': 'turn/completed',
                             'scope': {'turnId': 'bb-turn'}, 'data': {'providerCheckpointId': 'codex-turn'}}]
                return []
            return [
                {'id': 'request-event', 'seq': 1, 'type': 'client/turn/requested',
                 'createdAt': '2026-01-01T00:00:00Z', 'data': {'requestId': 'request', 'initiator': 'user',
                 'source': 'tell', 'input': [{'type': 'text', 'text': 'Human message'}]}},
                {'id': 'accepted-event', 'seq': 2, 'type': 'turn/input/accepted',
                 'scope': {'turnId': 'bb-turn'}, 'data': {'clientRequestId': 'request', 'providerThreadId': 'codex-thread'}}]
        report = collect_bb(runner=runner)
        origin = report['messages'][0]['origin']
        self.assertEqual('codex', origin['provider_id'])
        self.assertEqual('codex-thread', origin['provider_thread_id'])
        self.assertEqual('codex-turn', origin['provider_turn_id'])

    def overlap_reports(self, bb_specs, codex_specs):
        reports = [Report('bb'), Report('codex')]
        for report, specs in zip(reports, (bb_specs, codex_specs)):
            report.found = True
            for identifier, conversation, text, origin in specs:
                report.add(identifier, conversation, '2026-01-01T00:00:00Z', text, origin)
        return [report.result() for report in reports]

    def test_bb_codex_exact_identity_dedup_preserves_real_repeated_text(self):
        identity = {'provider_id': 'codex', 'provider_thread_id': 'provider-thread', 'provider_turn_id': 'turn'}
        reports = self.overlap_reports([
            ('request1', 'bb-thread', 'Yes', identity), ('request2', 'bb-thread', 'Yes', identity)], [
            ('native1', 'provider-thread', 'Yes', {'turn_id': 'turn'}),
            ('native2', 'provider-thread', 'Yes', {'turn_id': 'turn', 'client_id': 'request2'}),
            ('another-turn', 'provider-thread', 'Yes', {'turn_id': 'another'}),
            ('another-thread', 'other-thread', 'Yes', {'turn_id': 'turn'})])
        reconcile_bb_codex(reports)
        self.assertEqual(2, len(reports[0]['messages']))
        self.assertEqual(['another-thread', 'another-turn'], sorted(m['id'] for m in reports[1]['messages']))
        self.assertEqual(2, reports[1]['stats']['bb_duplicates'])
        self.assertEqual('ready', reports[1]['status'])

    def test_bb_codex_missing_checkpoint_marks_only_possible_codex_overlap(self):
        reports = self.overlap_reports([
            ('request', 'bb-thread', 'Same text', {'provider_id': 'codex', 'provider_thread_id': 'provider-thread'}),
            ('claude', 'bb-thread2', 'Other provider', {'provider_id': 'claude-code', 'provider_thread_id': 'provider-thread'})], [
            ('native', 'provider-thread', 'Same text', {'turn_id': 'turn'}),
            ('other', 'provider-thread', 'Other provider', {'turn_id': 'turn'})])
        reconcile_bb_codex(reports)
        self.assertEqual(2, len(reports[1]['messages']))
        self.assertEqual('partial', reports[1]['status'])
        self.assertEqual(1, reports[1]['issues']['bb_overlap_unresolved'])
        self.assertEqual(0, reports[1]['stats']['bb_duplicates'])

    def test_bb_codex_one_request_does_not_consume_two_native_messages(self):
        identity = {'provider_id': 'codex', 'provider_thread_id': 'provider-thread', 'provider_turn_id': 'turn'}
        reports = self.overlap_reports([('request', 'bb-thread', 'Repeat', identity)], [
            ('native1', 'provider-thread', 'Repeat', {'turn_id': 'turn', 'client_id': 'request'}),
            ('native2', 'provider-thread', 'Repeat', {'turn_id': 'turn'})])
        reconcile_bb_codex(reports)
        self.assertEqual(['native2'], [m['id'] for m in reports[1]['messages']])
        self.assertEqual(1, reports[1]['stats']['bb_duplicates'])
        self.assertEqual('partial', reports[1]['status'])

    def test_bb_codex_same_client_id_with_different_text_remains_unresolved(self):
        identity = {'provider_id': 'codex', 'provider_thread_id': 'provider-thread', 'provider_turn_id': 'turn'}
        reports = self.overlap_reports([('request', 'bb-thread', 'Original message', identity)], [
            ('native', 'provider-thread', 'Provider-transformed message', {'turn_id': 'turn', 'client_id': 'request'})])
        reconcile_bb_codex(reports)
        self.assertEqual(1, len(reports[1]['messages']))
        self.assertEqual('partial', reports[1]['status'])
        self.assertEqual(1, reports[1]['issues']['bb_overlap_unresolved'])

    def cursor_database(self, users, metadata=None, extra_unreachable=False):
        path = self.home / '.cursor/chats/project/chat/store.db'
        path.parent.mkdir(parents=True)
        con = sqlite3.connect(path)
        con.execute('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
        con.execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
        def put(data):
            digest = hashlib.sha256(data).digest()
            con.execute('INSERT OR IGNORE INTO blobs VALUES (?,?)', (digest.hex(), data))
            return digest
        root = b''
        for user in users:
            if isinstance(user, tuple):
                content, user = user
                user += field(18, put(content))
            user_ref = put(user)
            turn_ref = put(field(1, field(1, user_ref)))
            root += field(8, turn_ref)
        if extra_unreachable:
            put(json.dumps({'role': 'user', 'content': 'Stale unrelated blob'}).encode())
        root_ref = put(root)
        meta = {'agentId': 'chat', 'latestRootBlobId': root_ref.hex(), 'createdAt': 1767225600000}
        meta.update(metadata or {})
        con.execute('INSERT INTO meta VALUES (?,?)', ('0', json.dumps(meta).encode().hex()))
        con.commit()
        con.close()
        return path

    def test_cursor_traverses_current_root_and_excludes_simulated_agent_messages(self):
        ordinary = field(1, 'Ordinary user paragraph') + field(2, 'human') + field(25, 1767225600000)
        simulated = field(1, 'Generated content') + field(2, 'simulation') + field(5, 1)
        agent = field(1, 'Worker instruction') + field(2, 'agent') + field(27, 'worker')
        plan = field(1, 'Generated plan execution') + field(2, 'plan') + field(14, b'')
        self.cursor_database([ordinary, simulated, agent, plan], extra_unreachable=True)
        report = collect_cursor(home=self.home)
        self.assertEqual('ready', report['status'])
        self.assertEqual(['human'], [m['id'] for m in report['messages']])
        self.assertEqual('2026-01-01T00:00:00.000000Z', report['messages'][0]['timestamp'])
        self.assertEqual(3, report['stats']['excluded_origin'])

    def test_cursor_text_blob_is_utf8_and_missing_date_stays_unknown(self):
        self.cursor_database([(b'Synthetic long text', field(2, 'user'))])
        report = collect_cursor(home=self.home)
        self.assertEqual('Synthetic long text', report['messages'][0]['text'])
        self.assertIsNone(report['messages'][0]['timestamp'])
        self.assertEqual('unknown', report['messages'][0]['origin']['timestamp_scope'])
        self.assertIsNotNone(report['messages'][0]['origin']['conversation_created_at'])

    def test_cursor_skips_subagent_conversation(self):
        self.cursor_database([field(1, 'Delegated task')], {'subagentInfo': {'parentAgentId': 'parent'}})
        report = collect_cursor(home=self.home)
        self.assertEqual([], report['messages'])
        self.assertEqual(1, report['stats']['excluded_threads'])

    def test_cursor_truncated_blob_is_unsupported(self):
        with self.assertRaisesRegex(ValueError, 'Truncated'):
            fields(b'\x0a\x05a')
        self.cursor_database([b'\x0a\x05a'])
        report = collect_cursor(home=self.home)
        self.assertEqual('unsupported', report['status'])
        self.assertEqual([], report['messages'])

    def cursor_ide_database(self, composers, bubbles):
        root = self.home / 'Library/Application Support/Cursor/User/globalStorage'
        root.mkdir(parents=True)
        with closing(sqlite3.connect(root / 'state.vscdb')) as connection:
            connection.execute('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY,value TEXT)')
            for identifier, data in composers.items():
                connection.execute('INSERT INTO cursorDiskKV VALUES (?,?)',
                                   ('composerData:' + identifier, json.dumps(data)))
            for identifier, data in bubbles.items():
                connection.execute('INSERT INTO cursorDiskKV VALUES (?,?)',
                                   ('bubbleId:' + identifier, json.dumps(data)))
            connection.commit()
        return root

    def test_cursor_ide_uses_referenced_human_bubbles_and_never_drafts(self):
        headers = [{'bubbleId': identifier, 'type': typ} for identifier, typ in (
            ('u', 1), ('assistant', 2), ('simulation', 1), ('hidden', 1), ('plan', 1), ('agent', 1))]
        composer = {'_v': 2, 'composerId': 'root', 'fullConversationHeadersOnly': headers,
                    'text': 'This draft must never be treated as sent text'}
        body = {'type': 1, 'text': 'Human authored fixture', 'createdAt': '2026-04-01T09:00:00Z'}
        self.cursor_ide_database({'root': composer,
            'child': dict(composer, composerId='child', subagentInfo={'parentAgentId': 'root'})}, {
            'root:u': body, 'root:assistant': {'type': 2, 'text': 'Assistant'},
            'root:simulation': dict(body, isSimulatedMsg=True), 'root:hidden': dict(body, skipRendering=True),
            'root:plan': dict(body, isPlanExecution=True), 'root:agent': dict(body, sentByAgentId='worker'),
            'root:unreachable': dict(body, text='Detached stale bubble')})
        report = collect_cursor(home=self.home)
        self.assertEqual('ready', report['status'])
        self.assertEqual(['u'], [m['id'] for m in report['messages']])
        self.assertEqual('cursor_ide_human_bubble', report['messages'][0]['origin']['kind'])
        self.assertEqual('2026-04-01T09:00:00.000000Z', report['messages'][0]['timestamp'])
        self.assertEqual(4, report['stats']['excluded_origin'])

    def test_cursor_ide_missing_bubble_is_partial(self):
        composer = {'_v': 2, 'composerId': 'root', 'fullConversationHeadersOnly': [
            {'bubbleId': 'u', 'type': 1}, {'bubbleId': 'missing', 'type': 1}]}
        self.cursor_ide_database({'root': composer}, {'root:u': {'type': 1, 'text': 'Readable message'}})
        report = collect_cursor(home=self.home)
        self.assertEqual('partial', report['status'])
        self.assertEqual(1, report['issues']['missing_ide_bubble'])
        self.assertEqual(1, len(report['messages']))

    def test_cursor_ide_unknown_root_format_is_unsupported(self):
        self.cursor_ide_database({'future': {'_v': 'unknown', 'fullConversationHeadersOnly': []}}, {})
        report = collect_cursor(home=self.home)
        self.assertEqual('unsupported', report['status'])
        self.assertEqual([], report['messages'])

    def test_cursor_ide_legacy_inline_preserves_unknown_dates(self):
        self.cursor_ide_database({'old': {'_v': 1, 'conversation': [
            {'type': 1, 'bubbleId': 'old-user', 'text': 'An older message'},
            {'type': 2, 'bubbleId': 'old-agent', 'text': 'An assistant response'}]}}, {})
        report = collect_cursor(home=self.home)
        self.assertEqual('ready', report['status'])
        self.assertEqual(['old-user'], [m['id'] for m in report['messages']])
        self.assertIsNone(report['messages'][0]['timestamp'])
        self.assertEqual('unknown', report['messages'][0]['origin']['timestamp_scope'])

    def test_opencode_v2_excludes_synthetic_and_child_sessions(self):
        root = self.home / '.local/share/opencode'
        root.mkdir(parents=True)
        con = sqlite3.connect(root / 'opencode.db')
        con.executescript('CREATE TABLE session_v2(id TEXT,parent_id TEXT,version TEXT,metadata TEXT);'
                          'CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);')
        con.executemany('INSERT INTO session_v2 VALUES (?,?,?,?)', [('root', None, '2.0.20', None), ('child', 'root', '2.0.20', None)])
        for num, (typ, session) in enumerate([('user', 'root'), ('synthetic', 'root'), ('user', 'child')]):
            con.execute('INSERT INTO session_message VALUES (?,?,?,?,?,?)',
                        (str(num), session, typ, num, 1767225600000, json.dumps({'text': 'A synthetic fixture paragraph'})))
        con.commit()
        con.close()
        before = (root / 'opencode.db').read_bytes()
        report = collect_opencode(root=root)
        self.assertEqual('ready', report['status'])
        self.assertEqual(['0'], [m['id'] for m in report['messages']])
        self.assertEqual(before, (root / 'opencode.db').read_bytes())
        self.assertEqual(1, report['stats']['excluded_origin'])

    def test_unknown_opencode_database_is_not_empty_success(self):
        root = self.home / 'opencode'
        root.mkdir()
        sqlite3.connect(root / 'opencode.db').close()
        report = collect_opencode(root=root)
        self.assertEqual('unsupported', report['status'])
        self.assertEqual([], report['messages'])

    def test_database_permission_denial_is_reported_without_copy_or_retry(self):
        self.cursor_database([field(1, 'Synthetic data')])
        with patch('voice_sources.cursor.readonly_db', side_effect=sqlite3.OperationalError('permission denied')) as reader:
            report = collect_cursor(home=self.home)
        self.assertEqual('unavailable', report['status'])
        self.assertEqual(1, reader.call_count)
        self.assertEqual([], report['messages'])


if __name__ == '__main__':
    unittest.main()
