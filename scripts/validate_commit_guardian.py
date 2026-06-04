#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APPROVAL = ROOT / '.git' / 'commit-guardian-approval.json'


def git(*args: str) -> str:
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def fail(message: str) -> int:
    print(f'commit-gate: {message}', file=sys.stderr)
    return 1


def main() -> int:
    if not APPROVAL.exists():
        return fail('missing .git/commit-guardian-approval.json; run commit-guardian review first')

    try:
        approval = json.loads(APPROVAL.read_text())
    except Exception as exc:
        return fail(f'invalid approval file: {exc}')

    required = ['version', 'reviewer', 'safe_to_commit', 'staged_tree', 'allowed_files', 'forbidden_files']
    missing = [key for key in required if key not in approval]
    if missing:
        return fail(f'approval file missing keys: {", ".join(missing)}')

    if approval['reviewer'] != 'commit-guardian':
        return fail('approval reviewer must be commit-guardian')

    if approval['version'] != 1:
        return fail('unsupported approval version')

    if approval['safe_to_commit'] is not True:
        return fail('commit-guardian did not approve this commit')

    current_tree = git('write-tree')
    if current_tree != approval['staged_tree']:
        return fail('staged files changed after approval; re-run commit-guardian review')

    staged_files = sorted(filter(None, git('diff', '--cached', '--name-only').splitlines()))
    allowed_files = sorted(approval['allowed_files'])
    forbidden_files = approval['forbidden_files']

    if forbidden_files:
        return fail(f'approval still contains forbidden files: {", ".join(forbidden_files)}')

    if staged_files != allowed_files:
        return fail('staged files do not exactly match approved allowed_files set')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
