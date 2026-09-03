#!/usr/bin/env node
// `pnpm setup` — make a fresh clone safe to work in before anyone writes a line.
//
// Everything this script does is something a developer would otherwise have to
// discover by reading the source: that git hooks live in `.githooks/` and are
// not installed by cloning, that a local denylist file exists at all, and that
// the engine/brand boundary is enforced, not merely documented.
//
// Idempotent by construction: every step reports "already done" instead of
// redoing work, and nothing here overwrites a file that already has content.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_PATH = '.githooks';
const LOCAL_DENYLIST = join(ROOT, 'scripts', 'brand-denylist.local.txt');
const LOCAL_DENYLIST_REL = 'scripts/brand-denylist.local.txt';

const ok = (msg) => console.log(`  ok    ${msg}`);
const did = (msg) => console.log(`  done  ${msg}`);
const warn = (msg) => console.log(`  WARN  ${msg}`);

/** Run git, returning trimmed stdout, or null when the command fails. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function installHooks() {
  if (git(['rev-parse', '--git-dir']) === null) {
    warn('not a git repository — hooks not installed, and the gate will not run.');
    return false;
  }
  const current = git(['config', '--get', 'core.hooksPath']);
  if (current === HOOKS_PATH) {
    ok(`git hooks already point at ${HOOKS_PATH}/`);
    return true;
  }
  git(['config', 'core.hooksPath', HOOKS_PATH]);
  const applied = git(['config', '--get', 'core.hooksPath']);
  if (applied !== HOOKS_PATH) {
    warn(`could not set core.hooksPath to ${HOOKS_PATH} (it reads "${applied ?? 'unset'}").`);
    return false;
  }
  did(current ? `git hooks repointed from ${current} to ${HOOKS_PATH}/` : `git hooks installed (core.hooksPath = ${HOOKS_PATH}/)`);
  return true;
}

// Header written into a freshly created local denylist. It explains, in the
// file itself, why this twin exists: the tracked list can only hold terms that
// are safe to publish, because to forbid a word you have to write it down.
const LOCAL_DENYLIST_HEADER = `# Watched brand terms that must NOT travel to the public repo.
#
# This file is in .gitignore and is never committed. It is the private twin of
# scripts/brand-denylist.txt: both are read by the commit gate and their terms
# are summed.
#
# Why two files: to forbid a word you have to write it, so a published denylist
# is a literal list of everything you meant to keep out of sight. The tracked
# file therefore holds only terms that are harmless in public; anything whose
# mere presence would give the game away belongs here.
#
# You usually do not need to edit this by hand. Most terms of a brand — its
# slug, wordmark, domain, hashtags, city and @handle — are derived automatically
# from profiles/<slug>/ on disk. Add here only what derivation cannot see:
#
#   - private repo, product or service names
#   - retired aliases whose profile is no longer on disk
#   - terms shorter than 4 characters (derivation drops them)
#   - words derivation deliberately treats as generic but that this brand
#     really does need watched, accepting the false positives
#
# One term per line, case-insensitive. '#' starts a comment.
# See docs/commit-gate.md.
`;

function ensureLocalDenylist() {
  if (existsSync(LOCAL_DENYLIST)) {
    ok(`${LOCAL_DENYLIST_REL} already exists (left untouched)`);
    return;
  }
  writeFileSync(LOCAL_DENYLIST, LOCAL_DENYLIST_HEADER, 'utf8');
  did(`${LOCAL_DENYLIST_REL} created`);
}

/**
 * The whole point of the local denylist is that it never reaches a remote.
 * If it is not ignored, the file that lists everything you want hidden is one
 * `git add -A` away from being published — so this failure is loud.
 */
function verifyIgnored() {
  const ignored = git(['check-ignore', '-q', LOCAL_DENYLIST_REL]) !== null;
  if (ignored) {
    ok(`${LOCAL_DENYLIST_REL} is ignored by git`);
    return true;
  }
  console.log('');
  warn(`${LOCAL_DENYLIST_REL} is NOT ignored by git.`);
  console.log('        This file is meant to stay local. Add this line to .gitignore');
  console.log(`        before committing anything:  ${LOCAL_DENYLIST_REL}`);
  console.log('');
  return false;
}

function checkGuardianRunnable() {
  const validator = join(ROOT, 'scripts', 'validate_commit_guardian.py');
  if (!existsSync(validator)) {
    warn('scripts/validate_commit_guardian.py is missing — the gate cannot run.');
    return;
  }
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    ok('python3 available — the commit gate can run');
  } catch {
    warn('python3 not found. The pre-commit hook needs it; install it or commits will fail.');
  }
}

function printBoundary() {
  console.log(`
The engine / brand boundary
---------------------------
  system/, .claude/, app/ and core/ are the GENERIC ENGINE. They must
  never contain a real brand's literals — no name, city, domain, @handle or
  hashtag, not even in a comment or an example. Generic layers write those as
  <brand>, <city>, <slug>, profiles/<slug>/.

  Brands live in profiles/<slug>/, which git ignores. Only the fictional
  profiles/example* are tracked. A profile carries its own tokens, config,
  recipes and business skills, so it is transportable on its own.

  This is checked, not merely agreed: a pre-commit gate refuses any commit that
  puts brand literals in the engine, tracks a real profile, or negates the
  profiles/ ignore rule. Audit the whole tree with
  \`python3 scripts/validate_commit_guardian.py --scan\`.

Next
----
  pnpm init:profile     register a brand and its watched terms
  pnpm check            typecheck + tests
`);
}

console.log('\nSetting up this clone\n---------------------');
const hooksOk = installHooks();
ensureLocalDenylist();
const ignoredOk = verifyIgnored();
checkGuardianRunnable();
printBoundary();

if (!hooksOk || !ignoredOk) {
  console.log('Setup finished with warnings above. Fix them before committing.\n');
  process.exit(1);
}
