#!/usr/bin/env python3
"""Collect only selected sources into a private calibration corpus."""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import sys

from voice_sources import LOCAL_SOURCES, collect_sources
from voice_sources.common import Report, timestamp


STATUSES = ('ready', 'absent', 'partial', 'unavailable', 'unsupported')
PURPOSES = ('authored', 'agent-interaction')


def language_tag(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*', value):
        raise ValueError('Expected a language tag, such as en or pt-BR')
    return value.lower()


def source_report(name, path, since, until, *, samples):
    report = Report(name, since, until)
    report.found = True
    upstream_status, upstream_reason = 'ready', None
    try:
        with path.open(encoding='utf-8') as stream:
            data = json.load(stream)
    except OSError:
        report.issue('input_unreadable', unavailable=True)
        return report.result()
    except (ValueError, UnicodeError, RecursionError):
        report.issue('invalid_input_json')
        return report.result()

    if not samples:
        if (not isinstance(data, dict) or type(data.get('schema_version')) is not int
                or data['schema_version'] != 1 or data.get('source') != name
                or data.get('status') not in STATUSES
                or not (data.get('reason') is None or isinstance(data['reason'], str))
                or not isinstance(data.get('messages'), list)
                or (data['status'] in ('absent', 'unavailable', 'unsupported') and data['messages'])):
            report.issue('invalid_source_report')
            return report.result()
        upstream_status, upstream_reason = data['status'], data.get('reason')
        data = data['messages']

    if not isinstance(data, list):
        report.issue('expected_sample_array')
        return report.result()

    for row in data:
        try:
            identifier, text = row['id'], row['text']
            origin = row.get('origin', {} if samples else None)
            conversation = row.get('conversation_id', identifier if samples else None)
            date, language, genre = row.get('timestamp'), row.get('language'), row.get('genre')
            purpose = row.get('purpose', 'authored' if samples else None)
            if (not all(isinstance(item, str) and item.strip() for item in (identifier, text, conversation))
                    or not isinstance(origin, dict) or (not samples and not origin)
                    or (date is not None and timestamp(date) is None)
                    or (genre is not None and (not isinstance(genre, str) or not genre.strip()))
                    or (purpose is not None and purpose not in PURPOSES)
                    or (row.get('source') is not None and row['source'] != name)):
                raise ValueError('Invalid message')
            language = language_tag(language) if language is not None else None
        except (KeyError, TypeError, ValueError):
            report.issue('invalid_input_message')
            continue
        before = len(report.messages)
        report.add(identifier, conversation, date, text,
                   dict(origin, input_kind='provided-sample' if samples else 'imported-report'))
        if len(report.messages) > before:
            report.messages[-1].update(language=language, genre=genre, purpose=purpose)

    result = report.result()
    if upstream_status != 'ready':
        result.update(status=upstream_status, upstream_reason=upstream_reason)
        result['reason'] = '; '.join(filter(None, ('upstream_' + upstream_status, result['reason'])))
    return result


def collect(*, selected, samples=None, reports=(), since=None, until=None, languages, workers=3, progress=None,
            excluded_codex_originators=()):
    sources = []
    if selected:
        sources = collect_sources(selected, since=since, until=until, workers=workers, progress=progress,
                                  excluded_codex_originators=excluded_codex_originators)
    for source in sources:
        for message in source['messages']:
            message.update(language=None, genre=None, purpose='agent-interaction')
    if samples is not None:
        sources.append(source_report('samples', samples, since, until, samples=True))
    for name, path in reports:
        sources.append(source_report(name, path, since, until, samples=False))

    for source in sources:
        messages = source['messages']
        source['messages'] = [row for row in messages if row['language'] is None or row['language'] in languages]
        source.setdefault('stats', {})['outside_languages'] = len(messages) - len(source['messages'])
        source['language_counts'] = dict(Counter(row['language'] or 'unknown' for row in source['messages']))
        source['genre_counts'] = dict(Counter(row['genre'] or 'unknown' for row in source['messages']))

    corpus = {'schema_version': 1, 'period': {'since': since, 'until': until},
              'languages': languages, 'sources': sources}
    incomplete = any(source['status'] != 'ready' for source in sources)
    return corpus, 3 if incomplete or not any(source['messages'] for source in sources) else 0


def write_output(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write('\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local', choices=LOCAL_SOURCES, action='append', default=[], help='Local source to read; repeat to select several')
    parser.add_argument('--exclude-codex-originator', action='append', default=[], metavar='MARKER',
                        help='Exclude a known automated Codex originator by case-insensitive substring; repeatable')
    parser.add_argument('--samples', type=Path, help='JSON array of provided samples')
    parser.add_argument('--report', action='append', default=[], metavar='NAME=PATH', help='Import a selected source report; repeatable')
    parser.add_argument('--since', help='Inclusive ISO 8601 start with timezone; requires --until')
    parser.add_argument('--until', help='Exclusive ISO 8601 end with timezone; requires --since')
    parser.add_argument('--all-available', action='store_true', help='Do not restrict the period')
    parser.add_argument('--language', action='append', required=True, help='Evidence language tag; repeat for separate languages')
    parser.add_argument('--output', type=Path, required=True, help='New temporary JSON file (mode 0600 on POSIX)')
    parser.add_argument('--workers', type=int, choices=range(1, 6), default=3, help='Maximum concurrent local sources (default: 3)')
    args = parser.parse_args(argv)
    if not (args.local or args.samples or args.report):
        parser.error('select at least one source: --local, --samples, or --report')
    excluded = tuple(value.strip().lower() for value in args.exclude_codex_originator)
    if excluded and ('codex' not in args.local or not all(excluded)):
        parser.error('--exclude-codex-originator needs --local codex and a nonempty marker')
    since, until = timestamp(args.since), timestamp(args.until)
    if args.all_available:
        if args.since is not None or args.until is not None:
            parser.error('--all-available cannot be combined with date boundaries')
    elif since is None or until is None or since >= until:
        parser.error('choose --all-available or supply an increasing --since / --until pair with timezones')
    try:
        languages = list(dict.fromkeys(language_tag(value) for value in args.language))
    except ValueError as error:
        parser.error(str(error))
    reports = []
    names = set(LOCAL_SOURCES) | {'samples'}
    for entry in args.report:
        name, _, path = entry.partition('=')
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name) or name in names or not path:
            parser.error('--report needs a unique non-reserved name and a path: NAME=PATH')
        reports.append((name, Path(path)))
        names.add(name)
    output = args.output
    if os.path.lexists(output):
        parser.error('--output already exists; select a new temporary file')
    corpus, code = collect(selected=args.local, samples=args.samples, reports=reports,
                           since=since, until=until, languages=languages, workers=args.workers,
                           progress=lambda line: print(line, file=sys.stderr, flush=True),
                           excluded_codex_originators=excluded)
    try:
        write_output(output, corpus)
    except OSError:
        parser.error('could not create the private corpus file')
    summary = [{'source': source['source'], 'status': source['status'], 'messages': len(source['messages'])}
               for source in corpus['sources']]
    print(json.dumps({'sources': summary}))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
