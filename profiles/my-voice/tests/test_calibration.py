from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / 'skills' / 'my-voice-calibrate'
SCRIPTS = SKILL / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from collect import collect
from voice_profile import TEMPLATE, apply, review


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.profile = self.root / 'SKILL.md'
        self.proposal = self.root / 'proposal.json'

    def input(self, name, data):
        path = self.root / name
        path.write_text(json.dumps(data), encoding='utf-8')
        return path

    def cli(self, script, *args):
        env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR') if key in os.environ}
        for key in ('HOME', 'USERPROFILE', 'PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME',
                    'XDG_CONFIG_HOME', 'APPDATA', 'VSCODE_PORTABLE', 'VSCODE_APPDATA'):
            env[key] = str(self.root / key.lower())
        env['PYTHONUTF8'] = '1'
        return subprocess.run([sys.executable, '-B', str(SCRIPTS / script), *map(str, args)],
                              cwd=self.root, encoding='utf-8', capture_output=True, env=env)

    def test_samples_only_cli_works_outside_a_project_and_keeps_language_and_genre(self):
        samples = self.input('samples.json', [
            {'id': 'one', 'text': 'O céu está limpo.', 'language': 'pt-BR', 'genre': 'note'},
            {'id': 'two', 'text': 'Clear skies.', 'language': 'en', 'genre': 'letter'},
            {'id': 'three', 'text': 'Cielo despejado.', 'language': 'es'},
            {'id': 'four', 'text': 'SOURCE ONLY MARKER', 'purpose': 'agent-interaction'},
        ])
        output = self.root / 'corpus.json'
        result = self.cli('collect.py', '--samples', samples, '--all-available', '--language', 'en',
                          '--language', 'pt-br', '--output', output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('SOURCE ONLY MARKER', result.stdout + result.stderr)
        self.assertEqual(result.stderr, '')
        source, = json.loads(output.read_text(encoding='utf-8'))['sources']
        self.assertEqual(source['language_counts'], {'en': 1, 'pt-br': 1, 'unknown': 1})
        self.assertEqual(source['genre_counts'], {'note': 1, 'letter': 1, 'unknown': 1})
        self.assertEqual(source['stats']['outside_languages'], 1)
        rows = {row['id']: row for row in source['messages']}
        self.assertEqual(rows['one']['text'], 'O céu está limpo.')
        self.assertEqual(rows['one']['origin']['input_kind'], 'provided-sample')
        self.assertEqual(rows['four']['purpose'], 'agent-interaction')

    def test_local_selection_reads_only_selected_reader_and_filters_period(self):
        record = {'type': 'user', 'userType': 'external', 'sessionId': 'sample',
                  'message': {'role': 'user', 'content': 'Write a short note'}}
        history = self.root / 'projects' / 'sample' / 'session.jsonl'
        history.parent.mkdir(parents=True)
        dates = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', None]
        history.write_text('\n'.join(json.dumps(dict(record, uuid=str(i), timestamp=date))
                                     for i, date in enumerate(dates)), encoding='utf-8')
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(self.root)}, clear=True))
            excluded = [stack.enter_context(patch(f'voice_sources.collect_{name}'))
                        for name in ('bb', 'codex', 'cursor', 'opencode')]
            value, code = collect(selected=['claude'], since=dates[0], until=dates[1], languages=['en'])
        for reader in excluded:
            reader.assert_not_called()
        source, = value['sources']
        message, = source['messages']
        self.assertEqual((code, source['status'], message['id']), (3, 'partial', '0'))
        self.assertEqual(source['issues'], {'undated_message_outside_filter': 1})
        self.assertEqual(message['purpose'], 'agent-interaction')
        self.assertIsNone(message['language'])
        self.assertEqual(message['origin']['line'], 1)

    def test_import_retains_partial_provenance_and_unavailable_selection(self):
        report = self.input('external.json', {'schema_version': 1, 'source': 'journal', 'status': 'partial',
                            'reason': 'SOURCE ONLY MARKER', 'messages': [
                                {'id': 'one', 'text': 'Synthetic note.', 'language': 'en', 'purpose': 'authored',
                                 'conversation_id': 'notebook', 'origin': {'line': 4}},
                            ]})
        output = self.root / 'corpus.json'
        result = self.cli('collect.py', '--report', f'journal={report}', '--report', 'missing=missing.json',
                          '--all-available', '--language', 'en', '--output', output)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertNotIn('SOURCE ONLY MARKER', result.stdout + result.stderr)
        partial, failed = json.loads(output.read_text())['sources']
        self.assertEqual(partial['status'], 'partial')
        self.assertEqual(partial['upstream_reason'], 'SOURCE ONLY MARKER')
        self.assertEqual(partial['messages'][0]['origin'], {'line': 4, 'input_kind': 'imported-report'})
        self.assertEqual((failed['status'], failed['messages']), ('unavailable', []))

    def test_import_retains_ready_reason_only_in_private_output(self):
        marker = 'FICTIONAL COVERAGE NOTE'
        report = self.input('external.json', {'schema_version': 1, 'source': 'journal', 'status': 'ready',
                            'reason': marker, 'messages': [
                                {'id': 'one', 'text': 'Synthetic note.', 'language': 'en',
                                 'conversation_id': 'notebook', 'origin': {'line': 1}},
                            ]})
        output = self.root / 'corpus.json'
        result = self.cli('collect.py', '--report', f'journal={report}', '--all-available', '--language', 'en',
                          '--output', output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(marker, result.stdout + result.stderr)
        source, = json.loads(output.read_text())['sources']
        self.assertEqual((source['status'], source.get('upstream_reason')), ('ready', marker))

    def test_empty_sample_selection_is_not_ready_evidence(self):
        value, code = collect(selected=[], samples=self.input('empty.json', []), languages=['en'])
        self.assertEqual(code, 3)
        self.assertEqual(value['sources'][0]['messages'], [])

    def test_invalid_request_does_not_start_readers_or_create_a_corpus(self):
        output = self.root / 'corpus.json'
        result = self.cli('collect.py', '--all-available', '--language', 'en', '--output', output)
        self.assertEqual(result.returncode, 2)
        self.assertIn('select at least one source', result.stderr)
        result = self.cli('collect.py', '--local', 'bb', '--language', 'en', '--output', output,
                          '--since', '2026-01-01T00:00:00Z', '--until', '2026-01-01T00:00:00Z')
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('bb started', result.stderr)
        self.assertFalse(output.exists())

    def test_bad_source_rows_do_not_discard_good_evidence(self):
        path = self.input('samples.json', [None, {'id': 'bad', 'text': 'sample', 'language': {}},
                                          {'id': 'good', 'text': 'sample', 'language': 'en'}])
        value, code = collect(selected=[], samples=path, languages=['en'])
        self.assertEqual(code, 3)
        source, = value['sources']
        self.assertEqual(source['status'], 'partial')
        self.assertEqual(source['issues'], {'invalid_input_message': 2})
        self.assertEqual([row['id'] for row in source['messages']], ['good'])

    def test_first_profile_cli_retains_two_modes_and_saves_only_reviewed_preferences(self):
        raw = self.input('samples.json', [{'id': 'note', 'text': 'SOURCE ONLY MARKER'}])
        edits = self.input('edits.json', [
            {'before': 'Form of address: not specified.', 'after': 'Tratamento: use você.'},
            {'before': 'Question grouping: not specified.', 'after': 'Agrupe perguntas sobre a mesma decisão.'},
            {'before': 'Draft tone and vocabulary: not specified.', 'after': 'Prefira palavras simples no rascunho.'},
            {'before': 'Profile languages: not specified.', 'after': 'Idiomas: português.'},
        ])
        result = self.cli('voice_profile.py', 'review', '--profile', self.profile, '--edits', edits, '--output', self.proposal)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.profile.exists())
        result = self.cli('voice_profile.py', 'apply', '--profile', self.profile, '--proposal', self.proposal,
                          '--approved', json.loads(result.stdout)['proposal_revision'])
        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.profile.read_text(encoding='utf-8')
        for expected in ('Assistant communication (default)', "Writing in the user's voice (only on request)",
                         'use você', 'Agrupe perguntas', 'palavras simples', 'Idiomas: português', 'permissions'):
            self.assertIn(expected, text)
        self.assertNotIn('SOURCE ONLY MARKER', text)
        self.assertIn('SOURCE ONLY MARKER', raw.read_text())

    def test_manual_edits_during_review_refuse_write_until_reapproved(self):
        self.profile.write_text('Original preference.\n\nManual note.\n', encoding='utf-8')
        edits = [{'before': 'Original preference.', 'after': 'New preference.'}]
        approved = review(self.profile, edits, self.proposal)
        user_content = b'Original preference.\n\nUpdated manual note.\n'
        self.profile.write_bytes(user_content)
        with self.assertRaisesRegex(ValueError, 'changed since review'):
            apply(self.profile, self.proposal, approved)
        self.assertEqual(self.profile.read_bytes(), user_content)
        current_proposal = self.root / 'new-proposal.json'
        apply(self.profile, current_proposal, review(self.profile, edits, current_proposal))
        self.assertEqual(self.profile.read_bytes(), b'New preference.\n\nUpdated manual note.\n')

    def test_apply_refuses_tampering_and_profile_switch(self):
        approved = review(self.profile, [{'before': 'Form of address: not specified.', 'after': 'Use first names.'}],
                          self.proposal)
        other = self.root / 'other.md'
        with self.assertRaisesRegex(ValueError, 'not for this profile'):
            apply(other, self.proposal, approved)
        self.proposal.write_bytes(self.proposal.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            apply(self.profile, self.proposal, approved)
        self.assertFalse(self.profile.exists() or other.exists())

    def test_review_rejects_profile_path_as_output_even_through_an_alias(self):
        edits = self.input('edits.json', [
            {'before': 'Form of address: not specified.', 'after': 'Use first names.'},
        ])
        for label, relative in (('direct', 'SKILL.md'), ('relative', 'nested/../SKILL.md'), ('case', 'skill.md')):
            with self.subTest(spelling=label):
                parent = self.root / label
                (parent / 'nested').mkdir(parents=True)
                profile = parent / 'SKILL.md'
                output = parent / relative
                result = self.cli('voice_profile.py', 'review', '--profile', profile, '--edits', edits,
                                  '--output', output)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('proposal output must be separate', result.stderr)
                self.assertFalse(profile.exists() or output.exists())

    def test_review_rejects_a_raw_corpus_as_edits(self):
        samples = self.input('samples.json', [{'id': 'only', 'text': 'SOURCE ONLY MARKER'}])
        corpus, code = collect(selected=[], samples=samples, languages=['en'])
        self.assertEqual(code, 0)
        raw = self.input('corpus.json', corpus)
        result = self.cli('voice_profile.py', 'review', '--profile', self.profile, '--edits', raw,
                          '--output', self.proposal)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('SOURCE ONLY MARKER', result.stdout + result.stderr)
        self.assertFalse(self.profile.exists() or self.proposal.exists())

    def test_documented_entry_points_and_neutral_template(self):
        readme = (ROOT.parents[1] / 'README.md').read_text()
        self.assertIn('(profiles/my-voice/README.md)', readme)
        self.assertIn('Python 3.10 or newer', readme)
        docs = (SKILL / 'references' / 'calibration.md').read_text()
        for flag in ('--samples', '--local', '--report', '--language', '--all-available', '--approved'):
            script = 'voice_profile.py' if flag == '--approved' else 'collect.py'
            subcommand = ['apply'] if script == 'voice_profile.py' else []
            help_text = self.cli(script, *subcommand, '--help')
            self.assertEqual(help_text.returncode, 0)
            self.assertIn(flag, help_text.stdout)
            self.assertIn(flag, docs)
        template = TEMPLATE.read_text()
        self.assertTrue(template.isascii())
        for field in ('Form of address', 'Reply tone', 'Level of detail', 'Reply structure',
                      'Question grouping', 'Question phrasing', 'Options', 'Language and evidence'):
            self.assertIn(field, template)
