#!/usr/bin/env node
// `pnpm init:profile` — register a brand without having to know how the gate works.
//
// Creating a profile by hand means copying profiles/example/, remembering that
// the folder has to stay out of git, and remembering that some of its terms have
// to be declared so the engine layers can be checked against them. Each of those
// is a step nothing enforces. This walks through all of them and refuses to
// finish if the result is not actually ignored by git.
//
// Terminal only, on purpose: a brand is registered once, on the machine that
// will hold it, and the answers include terms that should not travel anywhere.

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = join(ROOT, 'profiles');
const TEMPLATE = join(PROFILES_DIR, 'example');
const LOCAL_DENYLIST_REL = 'scripts/brand-denylist.local.txt';
const LOCAL_DENYLIST = join(ROOT, LOCAL_DENYLIST_REL);

// Lowercase letters, digits and single hyphens. It becomes a folder name, a
// --profile argument and a derived denylist term, so anything else (spaces,
// uppercase, dots) breaks one of the three.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const HELP = `pnpm init:profile — register a brand profile in this clone.

Interactive. Asks for a slug and the terms that must never appear in the
generic layers, copies profiles/example/ as the starting point, and verifies
the new folder is ignored by git before finishing.

Usage:
  pnpm init:profile
  pnpm init:profile --help

What it creates:
  profiles/<slug>/            copied from profiles/example/ (git-ignored)
  entries appended to ${LOCAL_DENYLIST_REL}

Nothing is overwritten: it refuses to run if profiles/<slug>/ already exists,
and it only ever appends to the denylist.
`;

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function fail(msg) {
  console.error(`\nerror: ${msg}\n`);
  process.exit(1);
}

function validateSlug(slug) {
  if (!slug) return 'a slug is required.';
  if (!SLUG_RE.test(slug)) {
    return 'use lowercase letters, digits and single hyphens only (no spaces, no uppercase, no dots).';
  }
  // `example` and `example-*` are the fictional, publishable, TRACKED profiles.
  // A real brand taking that name would be committed by the .gitignore
  // allow-list and would also be skipped by the gate's derivation, which
  // treats example* as fictional. Both failures are silent.
  if (slug === 'example' || slug.startsWith('example')) {
    return '"example" and any slug starting with it are reserved for the fictional public profiles.';
  }
  if (existsSync(join(PROFILES_DIR, slug))) {
    return `profiles/${slug}/ already exists. Pick another slug or edit that profile directly.`;
  }
  return null;
}

async function main() {
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    console.log(HELP);
    return;
  }

  // Without a TTY every prompt would resolve to EOF and the script would
  // silently create a profile from empty answers. Better to say so.
  if (!process.stdin.isTTY) {
    fail(
      'this command is interactive and stdin is not a terminal.\n' +
      '       Run it directly in a terminal: pnpm init:profile'
    );
  }

  if (!existsSync(TEMPLATE)) {
    fail(`the template profiles/example/ is missing; cannot scaffold a new profile.`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, fallback = '') => (await rl.question(q)).trim() || fallback;

  try {
    console.log(`
Register a brand profile
------------------------
The profile folder stays out of git. Only the fictional profiles/example*
are tracked, so nothing you type here is published by committing.
`);

    let slug = '';
    for (;;) {
      slug = (await ask('Slug (lowercase, hyphens, e.g. "northwind-tools"): ')).toLowerCase();
      const problem = validateSlug(slug);
      if (!problem) break;
      console.log(`  -> ${problem}`);
    }

    console.log(`
Watched terms
-------------
The generic layers (system/, .claude/, app/, core/) must not contain this
brand's literals. The commit gate checks that, and it needs to know which
words to look for.

These go to ${LOCAL_DENYLIST_REL}, which git ignores, and NOT to
the tracked list: to forbid a word you have to write it down, so a published
denylist would be a plain list of everything you meant to keep out of sight.

Leave any of them blank to skip it.
`);

    const wordmark = await ask('  Wordmark (the brand name as written): ');
    const domain = await ask('  Domain (e.g. northwind.example): ');
    const city = await ask('  City, if the brand is tied to one: ');
    const handleRaw = await ask('  Social @handle: ');
    const handle = handleRaw.replace(/^@+/, '');

    const extra = [];
    console.log('\n  Any other term to watch (private repo, product, old alias).');
    console.log('  One per line, empty line to finish.');
    for (;;) {
      const term = await ask('  > ');
      if (!term) break;
      extra.push(term);
    }

    const labelled = [
      ['slug', slug],
      ['wordmark', wordmark],
      ['domain', domain],
      ['city', city],
      ['handle', handle ? `@${handle}` : ''],
      ...extra.map((t) => ['extra', t]),
    ].filter(([, value]) => value);

    console.log('\nAbout to create:');
    console.log(`  profiles/${slug}/   (copy of profiles/example/)`);
    console.log(`  ${labelled.length} term(s) appended to ${LOCAL_DENYLIST_REL}:`);
    for (const [kind, value] of labelled) console.log(`    ${value}   (${kind})`);

    const go = (await ask('\nProceed? [y/N] ')).toLowerCase();
    if (go !== 'y' && go !== 'yes') {
      console.log('\nAborted. Nothing was written.\n');
      return;
    }

    const dest = join(PROFILES_DIR, slug);
    cpSync(TEMPLATE, dest, { recursive: true, errorOnExist: true, force: false });

    // Verify BEFORE reporting success. If the folder is somehow tracked — an
    // allow-list negation in .gitignore, a stray rule — everything inside it
    // is one `git add -A` from being published, and the copy has already
    // landed on disk. Undo it and say so loudly rather than leave it there.
    const ignored = git(['check-ignore', '-q', `profiles/${slug}/`]) !== null;
    if (!ignored) {
      rmSync(dest, { recursive: true, force: true });
      fail(
        `profiles/${slug}/ would NOT be ignored by git.\n` +
        '       The copy was removed again, because a tracked brand profile is a\n' +
        '       publication waiting for the next `git add -A`.\n' +
        '       Check .gitignore for a negation such as `!profiles/<slug>/` and\n' +
        '       remove it, then run this again.'
      );
    }

    // Appended, never rewritten: this file is the owner's, and may already
    // hold terms that came from somewhere other than this command. The
    // per-profile comment says where a block came from, so terms can be
    // retired later along with the profile that needed them.
    if (labelled.length) {
      if (!existsSync(LOCAL_DENYLIST)) {
        writeFileSync(LOCAL_DENYLIST, '# Watched terms that must not travel to the public repo.\n', 'utf8');
      }
      const existing = readFileSync(LOCAL_DENYLIST, 'utf8');
      const already = new Set(
        existing.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'))
      );
      const fresh = labelled.map(([, v]) => v).filter((v) => !already.has(v.toLowerCase()));
      if (fresh.length) {
        const block = `\n# added by init:profile for profiles/${slug}/\n${fresh.join('\n')}\n`;
        appendFileSync(LOCAL_DENYLIST, block, 'utf8');
      }
      console.log(`\n  ${fresh.length} term(s) added to ${LOCAL_DENYLIST_REL} (${labelled.length - fresh.length} already present).`);
    }

    const localIgnored = git(['check-ignore', '-q', LOCAL_DENYLIST_REL]) !== null;
    if (!localIgnored) {
      console.log(`\n  WARNING: ${LOCAL_DENYLIST_REL} is NOT ignored by git.`);
      console.log('  Add it to .gitignore before committing anything.');
    }

    console.log(`
Done. profiles/${slug}/ is on disk and ignored by git.

Edit it in this order:
  1. profiles/${slug}/profile.md     identity, positioning, tone
  2. profiles/${slug}/brand.json     colours, fonts, copy.wordmark, copy.site
  3. profiles/${slug}/config.yaml    hashtags, output paths, profile.name
  4. profiles/${slug}/recipes/       parameters for the flows in system/recipes/
  5. profiles/${slug}/carousels/, reels/   the inputs each render reads

Business rules that belong to this brand — what content qualifies, its tone,
its data source — go in profiles/${slug}/skills/, never in .claude/skills/.

Then:
  python3 scripts/validate_commit_guardian.py --scan    audit the tree
  pnpm check                                            typecheck + tests
`);
  } finally {
    rl.close();
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
