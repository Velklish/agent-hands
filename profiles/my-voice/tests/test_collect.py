import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/my-voice-calibrate/scripts'))
from collect import collect, main, write_output


class CollectTests(unittest.TestCase):
    def args(self, output):
        return ['--local', 'claude', '--all-available', '--language', 'en', '--output', str(output)]

    def test_corpus_file_is_private_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'sessions.json'
            write_output(path, {'text': 'author text'})
            if os.name == 'posix':
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                write_output(path, {'text': 'replacement'})
            self.assertEqual(json.loads(path.read_text()), {'text': 'author text'})

    def test_partial_sessions_preserve_payload_and_return_nonzero(self):
        report = {'source': 'cursor', 'status': 'partial', 'reason': 'missing_bubble', 'messages': [{'text': 'own'}]}
        with patch('collect.collect_sources', return_value=[report]):
            corpus, code = collect(selected=['cursor'], languages=['en'])
        self.assertEqual(code, 3)
        self.assertEqual(corpus['sources'], [report])
        self.assertEqual(corpus['period'], {'since': None, 'until': None})

    def test_absent_tool_is_a_supported_outcome(self):
        with patch('collect.collect_sources', return_value=[{'source': 'claude', 'status': 'absent', 'messages': []}]):
            corpus, code = collect(selected=['claude'], languages=['en'])
        self.assertEqual(corpus['sources'][0]['status'], 'absent')
        self.assertEqual(code, 3)

    def test_cli_reports_counts_without_printing_private_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'sessions.json'
            report = {'source': 'claude', 'status': 'ready', 'messages': [{'text': 'PRIVATE TEXT'}]}
            stdout = io.StringIO()
            with patch('collect.collect_sources', return_value=[report]), contextlib.redirect_stdout(stdout):
                self.assertEqual(main(self.args(output)), 0)
            self.assertNotIn('PRIVATE TEXT', stdout.getvalue())
            self.assertEqual(json.loads(stdout.getvalue())['sources'][0]['messages'], 1)
            self.assertEqual(json.loads(output.read_text())['sources'][0]['messages'][0]['text'], 'PRIVATE TEXT')

    def test_cli_rejects_existing_output_before_collecting(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'sessions.json'
            output.write_text('existing')
            with patch('collect.collect_sources') as collector, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    main(self.args(output))
            self.assertEqual(error.exception.code, 2)
            collector.assert_not_called()
            self.assertEqual(output.read_text(), 'existing')

    def test_cli_worker_limit_and_progress_use_stderr_without_breaking_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'sessions.json'
            stdout, stderr = io.StringIO(), io.StringIO()

            def sessions(selected, *, since, until, workers, progress, excluded_codex_originators):
                self.assertEqual(['claude'], selected)
                self.assertEqual(2, workers)
                progress('claude started')
                progress('claude finished status=ready messages=1')
                return [{'source': 'claude', 'status': 'ready', 'messages': [{'text': 'PRIVATE TEXT'}]}]

            with patch('collect.collect_sources', side_effect=sessions):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(main(self.args(output) + ['--workers', '2']), 0)
            self.assertEqual(1, json.loads(stdout.getvalue())['sources'][0]['messages'])
            self.assertEqual('claude started\nclaude finished status=ready messages=1\n', stderr.getvalue())
            self.assertNotIn('PRIVATE TEXT', stdout.getvalue() + stderr.getvalue())

    def test_cli_normalizes_explicit_codex_originators(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'sessions.json'
            report = {'source': 'codex', 'status': 'absent', 'messages': []}
            with patch('collect.collect_sources', return_value=[report]) as reader, contextlib.redirect_stdout(io.StringIO()):
                result = main(['--local', 'codex', '--all-available', '--language', 'en', '--output', str(output),
                               '--exclude-codex-originator', ' ExampleDriver '])
            self.assertEqual(result, 3)
            self.assertEqual(reader.call_args.kwargs['excluded_codex_originators'], ('exampledriver',))
