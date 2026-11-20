#!/usr/bin/env python3
"""Review exact profile edits and apply only an approved, current revision."""

import argparse
from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
from tempfile import NamedTemporaryFile

from collect import write_output


TEMPLATE = Path(__file__).resolve().parent.parent / 'assets' / 'my-voice-template.md'


def digest(data):
    return sha256(data).hexdigest()


def read_profile(path):
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError('The profile must be a regular file, not a directory or link')
    return path.read_bytes()


def edit_profile(text, edits):
    if not isinstance(edits, list) or not edits:
        raise ValueError('Provide a nonempty array of exact edits')
    for edit in edits:
        if (not isinstance(edit, dict) or set(edit) != {'before', 'after'}
                or not isinstance(edit['before'], str) or not edit['before']
                or not isinstance(edit['after'], str) or edit['before'] == edit['after']):
            raise ValueError('Each edit needs distinct before and after strings')
        if text.count(edit['before']) != 1:
            raise ValueError('An edit does not identify exactly one match; review the current profile')
        text = text.replace(edit['before'], edit['after'], 1)
    if not text.strip():
        raise ValueError('The edited profile cannot be empty')
    return text


def profile_content(existing):
    return (TEMPLATE.read_bytes() if existing is None else existing).decode('utf-8')


def review(path, edits, output):
    existing = read_profile(path)
    base = profile_content(existing)
    result = edit_profile(base, edits)
    if result == base:
        raise ValueError('The proposal has no net changes')
    proposal = {'schema_version': 1, 'profile': str(path), 'existing': existing is not None,
                'base_sha256': digest(base.encode()), 'result_sha256': digest(result.encode()), 'edits': edits}
    write_output(output, proposal)
    return digest(output.read_bytes())


@contextmanager
def profile_lock(path):
    lock = path.with_name(f'.{path.name}.edit-lock')
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError('A profile edit is already in progress') from None
    try:
        os.close(descriptor)
        yield
    finally:
        lock.unlink()


def apply(path, proposal_path, approved):
    payload = proposal_path.read_bytes()
    if digest(payload) != approved:
        raise ValueError('The proposal does not match the approved revision')
    proposal = json.loads(payload)
    if (not isinstance(proposal, dict) or proposal.get('schema_version') != 1
            or proposal.get('profile') != str(path)):
        raise ValueError('The proposal is not for this profile')
    with profile_lock(path):
        existing = read_profile(path)
        base = profile_content(existing)
        if (proposal.get('existing') is not (existing is not None)
                or proposal.get('base_sha256') != digest(base.encode())):
            raise ValueError('The profile changed since review; prepare a new proposal')
        result = edit_profile(base, proposal.get('edits')).encode()
        if proposal.get('result_sha256') != digest(result):
            raise ValueError('The proposal does not produce the reviewed profile')
        with NamedTemporaryFile(dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            try:
                output.write(result)
                output.close()
                if existing is None:
                    os.link(temporary, path)
                else:
                    if read_profile(path) != existing:
                        raise ValueError('The profile was edited during apply; prepare a new proposal')
                    os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest='command', required=True)
    draft = subcommands.add_parser('review', help='Prepare a private revision for review without changing the profile')
    draft.add_argument('--edits', type=Path, required=True, help='JSON array of exact before/after edits')
    draft.add_argument('--output', type=Path, required=True, help='New private proposal file')
    save = subcommands.add_parser('apply', help='Write a reviewed profile after explicit approval')
    save.add_argument('--proposal', type=Path, required=True, help='Private proposal created by review')
    save.add_argument('--approved', required=True, help='SHA-256 of the exact proposal the user approved')
    for subcommand in (draft, save):
        subcommand.add_argument('--profile', type=Path, required=True, help='Explicit local profile file to create or update')
    args = parser.parse_args(argv)
    path = args.profile.parent.resolve() / args.profile.name
    try:
        if args.command == 'review':
            revision = review(path, json.loads(args.edits.read_bytes()), args.output)
            print(json.dumps({'proposal_revision': revision}))
        else:
            apply(path, args.proposal, args.approved)
            print(json.dumps({'status': 'applied'}))
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError):
        parser.error('could not read or write the profile inputs')
    except ValueError as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
