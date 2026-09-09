# Asset library schema

Every profile that produces visual pieces (carousels today, reels later) has
a library of image and font files under `profiles/<slug>/assets/`. This
document is the contract for its index, its per-file sidecars, and the
classification vocabulary. The code that implements it lives in
`system/assets/`, not in any single module — `system/ig-carousel/` and
`system/ig-reel/` are both expected to read it, and so is `editor/` once it
exists (see `openspec/changes/editor-carruseles/design.md`, decision D8).

## Where files live

```
profiles/<slug>/assets/
  index.json          the cache described below
  fonts/*.woff2        downloaded webfont files
  fonts/*.meta.json     one sidecar per font file (family, etc.)
  generated/<hash>.<ext>   AI-generated pieces
  generated/<hash>.json    one sidecar per generated piece
  <anything else>      manually placed files (backgrounds, photos, logos, ...)
```

Nothing under `assets/` is ever deleted by the library code. A piece that
should stop showing up gets `status: "hidden"` in the index; the file stays
on disk and anything that already references it keeps working.

## `index.json`

A rebuildable cache. If it is deleted, the next read of the library walks
`assets/` again, hashes every file, re-reads every sidecar, and reconstructs
an equivalent index — including any manual reclassification a user made,
because that classification is stored in the sidecar next to the file, not
only in `index.json` (see "Where classification lives" below). Identity is
the file's content hash, not its path: two files with the same bytes are the
same asset, no matter what they are named or where they sit.

Shape:

```jsonc
{
  "entries": [
    {
      "id": "3f2a9c1b7e4d5061",           // first 16 hex chars of sha256(content)
      "path": "assets/backgrounds/sky.png", // relative to the profile root
      "kind": "background",
      "mime": "image/png",
      "w": 1080,
      "h": 1350,
      "bytes": 482913,
      "origin": "manual",
      "status": "approved",
      "tags": ["ink:dark"],
      "createdAt": "2026-08-01T12:00:00.000Z",
      "family": "Inter"                    // fonts only; omitted otherwise
    }
  ]
}
```

Field reference:

| Field | Type | Notes |
|---|---|---|
| `id` | string | First 16 hex characters of `sha256(file bytes)`. The library's identity. |
| `path` | string | Relative to the profile directory (`profiles/<slug>/`), forward slashes. |
| `kind` | enum | See "Kinds" below. |
| `mime` | string | Detected from the file's own bytes (PNG/JPEG/WebP magic bytes), never from the extension alone. |
| `w`, `h` | integer | Pixel dimensions. Omitted for non-image kinds (fonts). |
| `bytes` | integer | File size in bytes. |
| `origin` | `manual` \| `ai` | How the file entered the library. |
| `status` | `candidate` \| `approved` \| `hidden` | See "Status" below. |
| `tags` | string[] | Free-form; the only tags the engine itself reads are `ink:dark` / `ink:light` on `kind: logo` entries. |
| `createdAt` | ISO date string | First time this hash was seen, not the file's mtime — copying a file must not change its history. |
| `family` | string (optional) | `kind: font` entries only: the font family name, from the sidecar or inferred from the file name. |

### Kinds

`background` \| `character` \| `photo` \| `logo` \| `decoration` \| `font` \| `unclassified`

A file that appears in `assets/` without going through the library (an agent
or a human copying it in by hand) is indexed as `unclassified` on the next
read — never an error, never skipped. The API/UI can reclassify any entry's
`kind` and `tags` without moving the underlying file.

### Status

- `candidate` — an AI-generated piece not yet used or fixed by a user (see
  the sidecar section below). Candidates are visible in the library only
  under their own filter; they never mix into the default view.
- `approved` — a manually placed file, or a candidate that got fixed to a
  slide or exported inside a carousel.
- `hidden` — a piece the user asked to stop seeing. The file is untouched
  and existing references to it keep rendering; it just drops out of the
  default library view.

### `ink:*` tags

Only meaningful on `kind: logo` entries: `ink:dark` (the logo's own ink is
dark — use it on a light background) or `ink:light` (the logo's ink is
light — use it on a dark background). `system/assets/logo.ts` reads these
against the slide's real background color via `pickLogoVariant()` from
`@personal-brand/core/color`.

## Sidecars

Two kinds of sidecar files, both plain JSON, both optional (their absence
just means "no extra metadata yet" — never an error):

**Generated pieces** — `assets/generated/<hash>.json`, one per AI-generated
image, matching the `<hash>.<ext>` file:

```jsonc
{
  "prompt": "a flat illustration of ...",
  "model": "gpt-image-1-mini",
  "costCents": 4,
  "createdAt": "2026-08-01T12:00:00.000Z",
  "carouselId": "2026-08-w32",
  "slot": "cover.background"
}
```

**Fonts** — `assets/fonts/<name>.meta.json`, one per `.woff2` file:

```jsonc
{ "family": "Inter" }
```

## Where user-set classification lives

`index.json` is a cache and gets rebuilt wholesale on demand. Something has
to survive that rebuild besides the raw file: the `kind`, `tags` and
`status` a user set by hand on an `unclassified` or AI-generated file.

**Decision: a sidecar per asset, keyed by hash — `assets/meta/<id>.json`.**

```jsonc
{ "kind": "character", "tags": ["ink:light"], "status": "approved" }
```

Why a sidecar over a `meta` section inside `index.json` keyed by hash: the
whole point of `index.json` being a cache is that deleting it must be a safe,
information-preserving operation. A `meta` block living inside the same file
that gets thrown away and rebuilt is one `rm index.json` away from silently
discarding every reclassification a user ever made — the file itself doesn't
distinguish "derived cache data" from "the only place this fact is written."
A separate `assets/meta/<id>.json` file is written once when a user changes
`kind`/`tags`/`status`, is never touched by the rebuild except to be *read*,
and its presence or absence is visible in a plain `ls` the same way a
sidecar for a generated piece is. Rebuilding merges, in this order: file scan
(gets `path`/`mime`/`w`/`h`/`bytes`), generated sidecar if present (gets
`origin: "ai"`, and seeds `createdAt` from it), then `assets/meta/<id>.json`
if present (overrides `kind`/`tags`/`status` with the user's choice). A fresh
`unclassified` `manual`/`candidate` file that nobody has touched yet has no
`assets/meta/<id>.json`, which is exactly correct: nobody made a choice.

## The reel engine and this schema

`system/ig-reel/render-reel-week.ts` already stages `assets/fonts/*.woff2`
into its Remotion project by picking the first `.woff2` it finds in that
directory (see the "A local logo font" block). This schema does not change
that behavior; it documents the same folder so that, when the reel engine
wants to read the index instead of `readdirSync`-ing the folder itself, it
finds the same `system/assets/` code and the same `index.json` shape that
`system/ig-carousel/` and `editor/` use — one library per profile, read by
however many engines need it.

## Usage counts are derived, never stored

How many carousels reference a given asset id is *not* a field in
`index.json`. It is computed on demand by `system/assets/usage.ts`, which
reads every `profiles/<slug>/carousels/*/carousel.json` and counts
occurrences of each asset's `id` in any `assetId`-named field. Storing a
count inside the index would go stale the moment a carousel is edited
outside of whatever last wrote that count; deriving it keeps the index
honest as a pure function of the files on disk.
