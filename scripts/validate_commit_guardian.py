#!/usr/bin/env python3
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PROFILES_DIR = ROOT / 'profiles'

# Paths that must remain free of brand literals: the engine and
# orchestrators are generic by contract (see CLAUDE.md).
# Layers that must be generic: none can carry literals of a real brand.
# `app/` and `core/` are included because `docs/ARQUITECTURA.md` promises
# to check all four, and historically the validator covered only two: the
# written promise and what the code checked had diverged, which is exactly
# how a guarantee becomes a habit (ignored).
GENERIC_PREFIXES = ('system/', '.claude/', 'app/', 'core/')

# Only example profiles (fictional onboarding brands) are publishable.
# A real profile lives outside the repo tree.
PUBLIC_PROFILE_PREFIX = 'profiles/example'

# Manual terms, which are ADDED to those derived from profiles on disk.
# Still exists because there are literals that don't come from any profile:
# a private repo name, an internal product, an old alias.
BRAND_DENYLIST = ROOT / 'scripts' / 'brand-denylist.txt'
# Local twin ignored by git: where terms that cannot travel to the public
# repo go. See manual_terms().
BRAND_DENYLIST_LOCAL = ROOT / 'scripts' / 'brand-denylist.local.txt'

# --- automatic derivation from profiles on disk --------------------------------
#
# The manual file protected against brand #1 and DIDN'T EXIST for brand #2
# until someone remembered to register it. A manual step that nothing enforces
# is not a guarantee; it's a remembered procedure — the same failure mode that
# let the original leak slip through (the rule was already written in prose).
#
# So terms are read from the REAL profiles on disk. A real profile is a folder
# under profiles/ that isn't `example*`: the `example*` are fictional brands,
# publishable and tracked, and if they contributed terms the gate would block
# itself with its own onboarding content.

# Minimum length of a derived term.
#
# 4 characters. It's the lowest threshold that doesn't generate massive false
# positives: at 3 you get acronyms and fragments ("AI", "cl", "Rol") that
# appear constantly in generic prose, and a `re.search` without word boundary
# would find them inside other words. At 4 the shortest plausible brand term
# ("Nike", "Uber") still fits. A 2–3-letter slug exists, but that's exactly
# when you must declare it by hand in brand-denylist.txt with the context
# that makes it unique, not derive it blindly.
MIN_TERM_LENGTH = 4

# Note printed when PR checking couldn't complete (no network, no remote,
# or commits the clone doesn't have). Filled by `_commits_published_via_pr`
# and printed in the report.
PR_CHECK_NOTE: str | None = None

# Words too common to block on their own.
#
# False-positive mitigation: if a profile declares a city "Santiago" or
# a wordmark that's a common word ("Norte", "Plaza", "Studio"), the derived
# term would block legitimate engine commits — and worse, push people to
# disable the gate. These are excluded from derivation; if you really need
# to watch them for a specific brand, declare them by hand in brand-denylist.txt,
# where a human can assume the cost with context.
GENERIC_WORDS = {
    # cities/regions frequent in documentation and examples
    'santiago', 'chile', 'madrid', 'barcelona', 'lima', 'bogota', 'bogotá',
    'mexico', 'méxico', 'buenos aires', 'london', 'berlin', 'paris',
    'new york', 'ciudad', 'city', 'region', 'región',
    # words a wordmark can be and the engine uses as vocabulary
    'brand', 'marca', 'studio', 'design', 'content', 'media', 'group',
    'digital', 'agency', 'personal', 'norte', 'sur', 'este', 'oeste',
    'plaza', 'centro', 'local', 'example', 'demo', 'test', 'default',
    'profile', 'perfil', 'system', 'carousel', 'carrusel', 'week',
    'semana', 'events', 'eventos', 'panoramas',
}

# Third-party platforms. A profile whose `copy.site` points here isn't
# declaring an owned domain: it's saying "my presence lives in someone else's
# house". Deriving "linkedin" from that URL would watch a foreign platform's
# name — which the engine has every right to name, because it renders for it
# (`core/src/linkedin.js` calculates where LinkedIn cuts a post). A brand's
# owned domain is derived; the social network it publishes to, is not.
THIRD_PARTY_HOSTS = {
    'linkedin.com', 'instagram.com', 'facebook.com', 'twitter.com', 'x.com',
    'threads.net', 'tiktok.com', 'youtube.com', 'github.com', 'medium.com',
    'substack.com', 'notion.so', 'behance.net', 'dribbble.com', 'bsky.app',
}

# TLDs that are stripped when deriving the base name from a domain.
KNOWN_TLDS = (
    '.com', '.cl', '.net', '.org', '.io', '.dev', '.app', '.co', '.ai',
    '.es', '.mx', '.ar', '.pe', '.me', '.xyz', '.cl.com',
)

HANDLE = re.compile(r'@([A-Za-z0-9._]{3,30})\b')

# Field names of the profile schema. Written after an at sign they are the
# citation of the concept ("the brand's @handle"), never anyone's real
# handle. They only suppress the extractor's capture: a brand actually
# named one of these is still derived from its slug, wordmark, domain or
# profile.name, and can be declared by hand in the denylist.
SCHEMA_FIELD_NAMES = {
    'handle', 'handles', 'usuario', 'user', 'username', 'slug', 'wordmark',
    'site', 'hashtag', 'hashtags', 'nombre', 'name',
}


def _is_public_profile(name: str) -> bool:
    return name == 'example' or name.startswith('example-')


def real_profile_dirs() -> list[Path]:
    """Real profiles on disk. Empty on a fresh clone — doesn't crash."""
    if not PROFILES_DIR.is_dir():
        return []
    return sorted(
        path for path in PROFILES_DIR.iterdir()
        if path.is_dir() and not _is_public_profile(path.name)
    )


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _yaml_scalar(text: str, key: str) -> list[str]:
    """Extract `key: value` from YAML without external dependencies.

    Deliberately not using PyYAML: the gate runs in a pre-commit hook and
    can't depend on a package being installed. If missing, derivation would
    degrade to silence — the failure this eliminates.
    """
    pattern = re.compile(rf'^\s*{re.escape(key)}\s*:\s*(.+?)\s*$', re.MULTILINE)
    out = []
    for raw in pattern.findall(text):
        value = raw.split('#')[0].strip().strip('\'"')
        if value:
            out.append(value)
    return out


def _yaml_list(text: str, key: str) -> list[str]:
    """Extract list items `- x` from the block following `key:`."""
    out = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not re.match(rf'^\s*{re.escape(key)}\s*:\s*$', line):
            continue
        indent = len(line) - len(line.lstrip())
        for candidate in lines[index + 1:]:
            if not candidate.strip():
                continue
            candidate_indent = len(candidate) - len(candidate.lstrip())
            item = candidate.strip()
            if candidate_indent <= indent or not item.startswith('- '):
                break
            value = item[2:].split('#')[0].strip().strip('\'"')
            if value:
                out.append(value)
    return out


def _domain_terms(domain: str) -> list[str]:
    """`example.cl` → the full domain and its base name.

    Base name matters because in prose the brand appears without the TLD; the
    full domain matters because an API URL carries it whole.
    """
    domain = domain.strip().strip('/').lower()
    domain = re.sub(r'^[a-z]+://', '', domain).split('/')[0]
    if not domain or '.' not in domain:
        return [domain] if domain else []
    # A third-party platform doesn't contribute a term: neither the host nor
    # its base name belong to the brand. We check the registrable domain, so
    # `www.linkedin.com` and `open.substack.com` are treated the same as naked.
    if domain in THIRD_PARTY_HOSTS or any(
        domain.endswith('.' + host) for host in THIRD_PARTY_HOSTS
    ):
        return []
    terms = [domain]
    # Base name: the label before the TLD, not the subdomain. For a two-level
    # TLD (`.cl.com`, `.co.uk`) you need to go back one more label, or the
    # "name" would be the public suffix itself.
    labels = domain.split('.')
    stripped = domain
    for tld in sorted(KNOWN_TLDS, key=len, reverse=True):
        if stripped.endswith(tld):
            stripped = stripped[: -len(tld)]
            break
    base = stripped.split('.')[-1] if stripped else (labels[-2] if len(labels) > 1 else labels[0])
    if base:
        terms.append(base)
    return terms


def _identifying_hashtag(tag: str) -> bool:
    """Is this hashtag a brand identifier or generic category vocabulary?

    `#Agents` or `#Marketing` are the topic being discussed, and the engine
    uses them as regular words — watching them turns every mention into an alarm.
    What does identify is a compound hashtag (`#PanoramasNorth`,
    `#Studio_X`): nobody writes it by accident. Heuristic: requires more than
    one component, detected by CamelCase, digit, or separator.

    Known limitation: a single lowercase word hashtag (`#nike`) is filtered out
    silently. Currently it's not a gap because such a hashtag usually repeats
    the slug or wordmark, which are derived anyway. A brand whose only trace is
    that hashtag must be declared by hand in the denylist.
    """
    body = tag.strip().lstrip('#')
    if not body:
        return False
    if any(ch.isdigit() or ch in '-_.' for ch in body):
        return True
    # CamelCase: an uppercase letter that isn't the first marks a second component.
    return any(ch.isupper() for ch in body[1:])


def _commits_published_via_pr(shas: set[str]) -> set[str]:
    """From `shas`, those the remote serves even though no branch contains them.

    A pull request leaves its commit in `refs/pull/N/head`, a hidden ref that
    survives closing the PR and deleting the branch, which `git branch -r` never
    sees. We query the remote for those refs and check membership against
    objects already in the clone.

    Silent and non-blocking: without network, remote, or permissions returns
    an empty set. Network failure can't become a noisy false "all clean" or
    an error blocking commits — but the report warns when the check couldn't
    run (see PR_CHECK_NOTE).
    """
    global PR_CHECK_NOTE
    if not shas:
        return set()
    try:
        raw = subprocess.run(
            ['git', 'ls-remote', 'origin', 'refs/pull/*/head'],
            cwd=ROOT, capture_output=True, text=True, timeout=25,
        )
    except (subprocess.TimeoutExpired, OSError):
        PR_CHECK_NOTE = 'could not query remote (network or timeout)'
        return set()
    if raw.returncode != 0:
        PR_CHECK_NOTE = 'could not query the remote (no access to origin)'
        return set()

    pr_heads = [ln.split()[0] for ln in raw.stdout.splitlines() if ln.strip()]
    if not pr_heads:
        return set()

    found: set[str] = set()
    for sha in shas:
        # `--contains` needs the object in the clone. If the PR carries
        # history that was never fetched, its head is unknown and gets
        # skipped: better to say nothing than to overstate.
        for head in pr_heads:
            try:
                r = subprocess.run(
                    ['git', 'merge-base', '--is-ancestor', sha, head],
                    cwd=ROOT, capture_output=True, timeout=10,
                )
            except (subprocess.TimeoutExpired, OSError):
                continue
            if r.returncode == 0:
                found.add(sha)
                break
    if not found and pr_heads:
        PR_CHECK_NOTE = (
            f'{len(pr_heads)} PR(s) on the remote; commits not fetched '
            'into this clone cannot be checked (git fetch origin '
            '"refs/pull/*/head:refs/remotes/pr/*" to include them)'
        )
    return found


def derive_terms() -> dict[str, set[str]]:
    """{term: {origin, …}} derived from real profiles on disk.

    Returns {} if no real profile exists (fresh clone): derivation contributes
    zero terms and the manual file continues to govern.
    """
    derived: dict[str, set[str]] = {}

    def add(value, origin: str) -> None:
        if not isinstance(value, str):
            return
        term = value.strip()
        if len(term) < MIN_TERM_LENGTH or term.lower() in GENERIC_WORDS:
            return
        derived.setdefault(term, set()).add(origin)

    for profile in real_profile_dirs():
        slug = profile.name
        where = f'profiles/{slug}/'
        add(slug, f'{where} (slug)')

        brand = _load_json(profile / 'brand.json')
        if isinstance(brand, dict):
            copy = brand.get('copy')
            if isinstance(copy, dict):
                add(copy.get('wordmark'), f'{where}brand.json copy.wordmark')
                site = copy.get('site')
                if isinstance(site, str):
                    for term in _domain_terms(site):
                        add(term, f'{where}brand.json copy.site')
            hosts = brand.get('sourceImageHosts')
            if isinstance(hosts, list):
                for host in hosts:
                    if isinstance(host, str):
                        for term in _domain_terms(host):
                            add(term, f'{where}brand.json sourceImageHosts')

        config = profile / 'config.yaml'
        if config.is_file():
            try:
                text = config.read_text(encoding='utf-8')
            except OSError:
                text = ''
            for tag in _yaml_list(text, 'default_hashtags'):
                if _identifying_hashtag(tag):
                    add(tag.lstrip('#'), f'{where}config.yaml default_hashtags')
            for value in _yaml_scalar(text, 'name'):
                add(value, f'{where}config.yaml profile.name')

        for recipe in sorted(profile.glob('recipes/*.yaml')):
            try:
                text = recipe.read_text(encoding='utf-8')
            except OSError:
                continue
            rel = f'{where}recipes/{recipe.name}'
            for value in _yaml_scalar(text, 'city'):
                add(value, f'{rel} defaults.city')
            for value in _yaml_scalar(text, 'url'):
                for term in _domain_terms(value):
                    add(term, f'{rel} source.url')

        for carousel in sorted(profile.glob('carousels/*.json')):
            data = _load_json(carousel)
            if isinstance(data, dict):
                add(data.get('city'), f'{where}carousels/{carousel.name} city')

        # @handle: can appear in any profile text (skills, spec, config).
        # Searched in text files, not a fixed field, because the schema has no
        # declared place for it.
        for path in sorted(profile.rglob('*')):
            if not path.is_file() or path.suffix not in {'.md', '.yaml', '.yml', '.json'}:
                continue
            try:
                text = path.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            for handle in HANDLE.findall(text):
                if '.' in handle or handle.lower() in GENERIC_WORDS:
                    continue  # emails, font versions, @400;600
                if handle.lower() in SCHEMA_FIELD_NAMES:
                    # A profile's own prose (a spec, a handoff) names the
                    # fields that describe it, and "@handle" cited as a
                    # concept is nobody's handle. Taking it for one made
                    # "handle" a watched term and produced 47 false
                    # positives against `delayRender(handle)` and friends.
                    continue
                add(handle, f'{where}… (@handle)')

    return derived


def manual_terms() -> dict[str, set[str]]:
    """Terms declared by hand, from both manual files.

    Two and not one for a reason that only surfaces at publish time: to
    forbid a word you must write it, so the denylist *is* the literal list
    of everything intended to be hidden. Publishing it delivers exactly
    that — a private repo name inside once said "must not appear in the
    public repo" while living in the public repo.

    So the tracked file (`brand-denylist.txt`) carries only what's publishable,
    and sensitive terms go local (`brand-denylist.local.txt`), which is in
    .gitignore. The two lists sum, and absence of either is not an error: a
    fresh clone works with derivation from `profiles/<slug>/` and the public list.
    """
    out: dict[str, set[str]] = {}
    for path in (BRAND_DENYLIST, BRAND_DENYLIST_LOCAL):
        if not path.exists():
            continue
        label = path.relative_to(ROOT)
        for line in path.read_text(encoding='utf-8').splitlines():
            term = line.strip()
            if term and not term.startswith('#'):
                out.setdefault(term, set()).add(f'{label} (manual)')
    return out


def denylist_with_origins() -> dict[str, set[str]]:
    """Manual + derived. A term can have multiple origins.

    Collapsed by lowercase because search is case-insensitive: keeping
    "Brand" and "brand" as separate entries would duplicate every finding
    and make the origin report unreadable without gaining anything.
    """
    combined: dict[str, set[str]] = {}
    index: dict[str, str] = {}
    for source in (manual_terms(), derive_terms()):
        for term, origins in source.items():
            key = term.lower()
            canonical = index.setdefault(key, term)
            combined.setdefault(canonical, set()).update(origins)
    return combined

# `as VerifiedSlide` asserts the verification mark without passing through the guard.
# TypeScript allows the cast in one step because VerifiedSlide is a subtype of
# Slide, so the compiler CAN'T prevent it — and bad faith isn't required: it's
# what you write when the compiler says "Slide[] is not assignable to VerifiedSlide[]".
# Only verify-slides.ts should mint it.
VERIFIED_CAST = re.compile(r'\bas\s+(?:unknown\s+as\s+)?VerifiedSlide\b')
VERIFIED_CAST_HOME = 'system/ig-carousel/verify-slides.ts'
# The types test file asserts the cast deliberately, so the boundary stays
# asserted, not just described. A check that penalizes documenting the problem
# pushes people to delete the documentation, the opposite of what we want.
VERIFIED_CAST_DOCS = 'system/ig-carousel/render-batch.types.test.ts'

# A negation in .gitignore is how real profiles snuck into the repo:
# silently wins over any rule written in prose.
#
# `/?` because `!/profiles/<brand>/` is valid gitignore with the same effect, and
# `(?![^/]*)` anchors the exception to the whole segment: `!profiles/exampleEVIL/`
# isn't the example profile and shouldn't pass just by starting the same.
GITIGNORE_NEGATION = re.compile(r'^\s*!\s*/?profiles/(?!example(?:-personal)?/)')


def git(*args: str) -> str:
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def denylist() -> list[str]:
    return sorted(denylist_with_origins(), key=str.lower)


def staged_blob(path: str) -> str | None:
    """Content as it would be committed, not from the working tree."""
    try:
        return subprocess.check_output(
            ['git', 'show', f':{path}'], cwd=ROOT, text=True, errors='replace',
            stderr=subprocess.DEVNULL,  # a deletion is normal, not an error
        )
    except subprocess.CalledProcessError:
        return None  # deleted from index


def check_brand_leaks(staged_files: list[str]) -> list[str]:
    """Brand literals in the generic layer.

    Deterministic on purpose: the gate existed when this repo's leaks happened
    and didn't stop them, because all judgment about what was safe was delegated
    to agent review. This doesn't depend on judgment.
    """
    origins = denylist_with_origins()
    if not origins:
        return []
    pattern = re.compile(
        '|'.join(re.escape(t) for t in sorted(origins, key=len, reverse=True)),
        re.IGNORECASE,
    )
    leaks = []
    for path in staged_files:
        if not path.startswith(GENERIC_PREFIXES):
            continue
        blob = staged_blob(path)
        if blob is None:
            continue
        for number, line in enumerate(blob.splitlines(), 1):
            hit = pattern.search(line)
            if hit:
                # Name both the term AND its origin: without this, a block on a
                # derived term is indistinguishable from a gate bug and nobody
                # knows which profile file spawned it.
                leaks.append(
                    f'{path}:{number}: {line.strip()[:80]}\n'
                    f'      ↳ term "{hit.group(0)}" — '
                    f'{describe_origin(hit.group(0), origins)}'
                )
    return leaks


def describe_origin(matched: str, origins: dict[str, set[str]]) -> str:
    """Where the matched term came from (case-insensitive)."""
    for term, where in origins.items():
        if term.lower() == matched.lower():
            return '; '.join(sorted(where))
    return 'unknown origin'


def check_private_profiles(staged_files: list[str], *, tracked: bool = False) -> list[str]:
    """Files from a real profile that would enter the repo.

    A deletion is NOT a violation: removing a real profile from the tree is
    exactly the operation this check wants to encourage. Without this distinction
    the gate blocks itself at the exact moment someone does the right thing.
    """
    candidates = [
        path for path in staged_files
        if path.startswith('profiles/')
        and not path.startswith(PUBLIC_PROFILE_PREFIX)
    ]
    if tracked:
        # Scan mode: the list comes from `git ls-files -co`, so it includes
        # untracked files not in the index. Checked on disk.
        return [path for path in candidates if (ROOT / path).exists()]
    return [path for path in candidates if staged_blob(path) is not None]


def check_verified_casts(staged_files: list[str]) -> list[str]:
    """Casts that fabricate the verification mark outside its sole owner.

    The pre-render guard is a compiler guarantee, and this is the hole the
    compiler can't close alone. A textual check can.
    """
    findings = []
    for path in staged_files:
        if path in (VERIFIED_CAST_HOME, VERIFIED_CAST_DOCS) or not path.endswith('.ts'):
            continue
        blob = staged_blob(path)
        if blob is None:
            continue
        for number, line in enumerate(blob.splitlines(), 1):
            # Code only: a comment line that *mentions* the cast is explaining
            # why the check exists, not fabricating the mark.
            if line.lstrip().startswith(('*', '//', '/*')):
                continue
            if VERIFIED_CAST.search(line):
                findings.append(f'{path}:{number}: {line.strip()[:80]}')
    return findings


def check_gitignore_negations(staged_files: list[str]) -> list[str]:
    """Attack the root cause in its general form.

    Without this, a `!profiles/<brand>/` makes a real profile trackable again
    and the other two checks lose effect for files that profile adds after.
    """
    if '.gitignore' not in staged_files:
        return []
    blob = staged_blob('.gitignore') or ''
    return [
        f'.gitignore:{number}: {line.strip()}'
        for number, line in enumerate(blob.splitlines(), 1)
        if GITIGNORE_NEGATION.match(line)
    ]


# Asked of git rather than hardcoded as `ROOT/.git`, because in a linked
# worktree `.git` is a *file* pointing at the real gitdir
# (…/.git/worktrees/<name>), not a directory — so the hardcoded path would
# never exist and the gate rejected every commit from a worktree, no matter
# how well it had been reviewed. post-commit already resolves it this way;
# this keeps both halves of the gate agreeing on one location.
#
# `--absolute-git-dir`, not `--git-dir`: the latter returns a bare relative
# ".git" in an ordinary clone, which `Path` would then resolve against the
# process's cwd instead of the repository — letting a stray `.git/` in some
# subdirectory supply approval. Anchoring it absolutely keeps the lookup
# tied to this repository wherever the script is invoked from.
APPROVAL = Path(git('rev-parse', '--absolute-git-dir')) / 'commit-guardian-approval.json'


def fail(message: str) -> int:
    print(f'commit-gate: {message}', file=sys.stderr)
    return 1


def scan_tree() -> int:
    """`--scan`: audit the current tree AND local history.

    The gate only sees what's being committed. This answers the other two
    questions, which are distinct and must be reported separately:

      1. Is TODAY's tree clean? → what would be published on push
      2. Is local HISTORY clean? → a clean tree with dirty commits behind
         still publishes the brand if history is pushed wholesale

    Auditing only (1) is worse than not auditing: it prints "publishable"
    while commits stay in place.
    """
    origins = denylist_with_origins()
    terms = sorted(origins, key=str.lower)
    if not terms:
        print(
            'commit-gate: no terms to search for — scripts/brand-denylist.txt '
            'is empty or missing and no real profiles exist in profiles/',
            file=sys.stderr,
        )
        return 1
    pattern = re.compile(
        '|'.join(re.escape(t) for t in sorted(terms, key=len, reverse=True)),
        re.IGNORECASE,
    )

    # --- (0) where each term comes from ---
    # Printed BEFORE findings: without this, a block on a derived term is opaque
    # and the human can't decide if it's a real leak or a false positive to mitigate.
    print('WATCHED TERMS (and where they come from)')
    for term in terms:
        print(f'  {term}')
        for origin in sorted(origins[term]):
            print(f'      ← {origin}')
    profiles = real_profile_dirs()
    print(
        f'  {len(terms)} term(s): derived from {len(profiles)} real profile(s) '
        f'on disk + manual terms from scripts/brand-denylist.txt'
    )
    if not profiles:
        print('  (no real profiles in profiles/ — only manual terms govern)')
    print()

    # --- (1) current tree ---
    # `-co --exclude-standard`: tracked PLUS untracked files not ignored.
    # With just `ls-files` the scan didn't see work in progress and reported
    # "ok" with a live leak on disk — the same false green this script exists
    # to eliminate, one level up. Ignored files are intentionally outside: that's
    # where real profiles live.
    tracked = sorted(filter(None, git('ls-files', '-co', '--exclude-standard').splitlines()))
    leaks = []
    for path in tracked:
        if not path.startswith(GENERIC_PREFIXES):
            continue
        try:
            blob = (ROOT / path).read_text(encoding='utf-8', errors='replace')
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(blob.splitlines(), 1):
            hit = pattern.search(line)
            if hit:
                leaks.append(
                    f'{path}:{number}: {line.strip()[:100]}\n'
                    f'          ↳ term "{hit.group(0)}" — '
                    f'{describe_origin(hit.group(0), origins)}'
                )

    tree_findings = [
        ('brand literals in the generic layers (%s)' % ', '.join(GENERIC_PREFIXES), leaks),
        ('real profile files tracked', check_private_profiles(tracked, tracked=True)),
        ('.gitignore negations', [
            f'.gitignore:{number}: {line.strip()}'
            for number, line in enumerate(
                (ROOT / '.gitignore').read_text(encoding='utf-8').splitlines(), 1)
            if GITIGNORE_NEGATION.match(line)
        ] if (ROOT / '.gitignore').exists() else []),
    ]

    print('CURRENT TREE (what would be published on push)')
    for title, items in tree_findings:
        print(f'  {"FAIL" if items else "ok  "}  {title} ({len(items)})')
        for item in items:
            print(f'          {item}')
    tree_total = sum(len(items) for _, items in tree_findings)

    # --- (2) local history ---
    # `git log -S<term>` traverses all refs and finds commits that introduced
    # or removed the term. A clean tree says nothing about this: commits stay
    # and a push publishes them.
    print()
    print('LOCAL HISTORY (commits that contain the brand)')
    history: dict[str, list[str]] = {}
    for term in terms:
        try:
            found = git('log', '--all', '--oneline', '-i', f'-S{term}').splitlines()
        except subprocess.CalledProcessError:
            found = []
        for line in filter(None, found):
            history.setdefault(line, []).append(term)

    pushed = set()
    via_pr = set()
    for line in history:
        sha = line.split()[0]
        try:
            if git('branch', '-r', '--contains', sha).strip():
                pushed.add(sha)
        except subprocess.CalledProcessError:
            pass
# A branch isn't the only publication channel. Opening a pull request on
    # GitHub leaves the commit in `refs/pull/N/head` on the remote FOREVER:
    # closing the PR and deleting the branch doesn't remove it, and
    # `git branch -r` doesn't see it because that ref is hidden and doesn't
    # replicate to the clone. This gap let a real leak through: the tree was
    # clean, no branch held the commit, and the report said "NO published leak"
    # while the commit was served anonymously from a closed PR. We query the
    if history:
        via_pr = _commits_published_via_pr({line.split()[0] for line in history})
        pushed |= via_pr

    if history:
        print(f'  FAIL  {len(history)} commit(s) contain denylist terms')
        for line, hits in sorted(history.items()):
            sha = line.split()[0]
            if sha in via_pr:
                mark = ' [PUBLISHED IN A PULL REQUEST]'
            elif sha in pushed:
                mark = ' [ALREADY IN A REMOTE]'
            else:
                mark = ''
            print(f'          {line[:80]}  ({", ".join(sorted(set(hits)))}){mark}')
        print()
        if pushed:
            print(f'  {len(pushed)} of those commits are ALREADY in a remote — that IS a leak,')
            print('  and permanent; removing them from the tree won\'t remove them from there.')
            if via_pr:
                print()
                print(f'  {len(via_pr)} are published via PULL REQUEST, not by a branch.')
                print('  Closing the PR and deleting the branch doesn\'t remove them: they live in refs/pull/N/head')
                print('  on the remote and are served anonymously. No push or history rewrite removes')
                print('  them — the ref is read-only server-side.')
                print('  Real options: request it from GitHub Support, or make the repo private')
                print('  then public again. If the repo has FORKS, objects are shared with')
                print('  them and must be resolved first or none of the above suffices.')
        else:
            print('  None are in a remote yet: NO published leak. This is hygiene before push.')
            print('  Publishing via squash onto a clean base avoids dragging them along.')
        if PR_CHECK_NOTE:
            print()
            print(f'  note: {PR_CHECK_NOTE}')
    else:
        print('  ok    no local commits contain denylist terms')

    # --- scope ---
    print()
    print('SCOPE OF THIS AUDIT — what it DOES NOT cover:')
    print(f'  · Only searches the {len(terms)} term(s) listed above. Derived ones appear')
    print('    automatically when a profile lands in profiles/<slug>/ — registering a')
    print('    brand no longer requires hand-editing the denylist. Terms the derivation')
    print('    doesn\'t see must be declared there: old aliases, private repo names, or')
    print('    a slug shorter than')
    print(f'    {MIN_TERM_LENGTH} chars (filtered to prevent false positives).')
    print('  · Generic terms (common cities, wordmarks that are everyday words) are')
    print('    filtered on purpose to avoid blocking the engine; if a specific brand')
    print('    needs them, add by hand to the denylist.')
    print('  · Doesn\'t detect business logic without naming the brand (editorial')
    print('    criteria, copy, color palette) — that requires human reading.')
    print('  · Doesn\'t audit binary files (untracked files are audited).')
    print('  · Publishing is checked against remote branches AND the pull')
    print('    requests (refs/pull/*/head) that survive closing the PR.')
    print('    Doesn\'t cover external forks: they share objects and serve the commit too.')

    total = tree_total + len(history)
    print()
    if total == 0:
        print('tree and history clean for known terms')
    else:
        print(f'{tree_total} in tree + {len(history)} commit(s) in history — review before publishing')
    return 1 if total else 0


def main() -> int:
    if '--scan' in sys.argv[1:]:
        return scan_tree()

    if not APPROVAL.exists():
        return fail(f'missing {APPROVAL}; run commit-guardian review first')

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

    # An approval is single-use. After a commit lands, the index still equals
    # the tree that was just committed, so `staged_tree` keeps matching and
    # `git diff --cached` goes empty — an empty commit or an amend would then
    # satisfy every check above on a review nobody re-issued. post-commit
    # deletes the approval, but that hook can be skipped or fail, so refuse
    # here too rather than depending on it.
    if not staged_files:
        return fail('nothing staged; this approval was already used — re-run commit-guardian review')

    # The three checks below are deterministic and commit-guardian CANNOT
    # approve them: they're exactly the kind of leak that criterion-based
    # review let slip ten times in this repo.
    negations = check_gitignore_negations(staged_files)
    if negations:
        return fail(
            'a .gitignore negation would make a real profile trackable; only '
            'profiles/example* is public (see CLAUDE.md):\n  '
            + '\n  '.join(negations)
        )

    private = check_private_profiles(staged_files)
    if private:
        return fail(
            'real profile files staged; a real profile lives outside the repo '
            'tree, only profiles/example* is public:\n  ' + '\n  '.join(private)
        )

    casts = check_verified_casts(staged_files)
    if casts:
        return fail(
            'a cast fabricates the VerifiedSlide mark outside verify-slides.ts — call '
            'verifyOrThrow() instead; the mark exists so unverified slides cannot be '
            'rendered:\n  ' + '\n  '.join(casts)
        )

    leaks = check_brand_leaks(staged_files)
    if leaks:
        return fail(
            'brand literals in the generic layers — parameterize them as '
            '<marca>/<ciudad>/<slug> (see CLAUDE.md):\n  ' + '\n  '.join(leaks)
        )

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
