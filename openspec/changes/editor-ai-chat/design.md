# Design — AI chat in the carousel editor

> Every file:line below is against `main` at `9fd4b0a`, verified there. PR 1 moves some of them, so
> re-check a line before trusting it; the symbols, signatures and behaviors hold.

## Context

The editor exposes AI per piece today ("Generar imagen…", "Regenerar no fijados"). This change adds a
conversation panel under the stage where the owner asks for content and the AI proposes it, grounded in
the brand's material. Two owner decisions reshape the module: a new carousel opens with **zero slides**,
and the **scope of every edit is the canvas/filmstrip selection** — the chat never guesses what it may
touch.

The principle underneath all of it: the brand's assets, backgrounds and templates exist to give the AI a
**design frame**. The more material a request carries, the less latitude the AI takes.

## Decisions

### D1. Message schema — `profiles/<slug>/carousels/<id>/chat.jsonl`

Append-only JSONL, one record per line, **never rewritten** (repo rule 5: nothing is deleted or
overwritten). State is derived by folding the log, not stored.

```jsonc
{"id":"msg-…","at":"<ISO>","role":"user","text":"…",
 "scope":{"slideIds":["slide-1"],"slots":["title"]},        // resolved by the client from the selection
 "referenceAssetIds":["<assetId>"],                          // optional, see D3
 "resolves":{"proposalId":"prop-…","decision":"accept"|"refine"|"discard",
             "actionIds":["act-1"]}}                         // optional; actionIds ⇒ partial accept ("solo la primera")

{"id":"msg-…","at":"<ISO>","role":"assistant","text":"…",
 "proposal":{"id":"prop-…","estimatedCostCents":12,
             "actions":[{"id":"act-1","type":"generate_visual","rung":"generate_constrained","why":"…","…":"…"}]}}

{"id":"evt-…","at":"<ISO>","role":"event","kind":"applied","proposalId":"prop-…",
 "costCents":12,"documentVersion":"carousels/<id>/versions/<stamp>.json",
 "results":[{"actionId":"act-1","assetIds":["<assetId>"],"slideIds":["slide-3"]}]}
{"id":"evt-…","…":"…","kind":"failed","proposalId":"prop-…","actionId":"act-2","error":"…"}
```

A proposal is **pending** when no later record resolves it; a new proposal implicitly discards the
previous pending one. `documentVersion` is the relative version path `snapshotDocument` returns for the
snapshot taken *before* the write — the undo handle for anything the AI did, deletions included.
**Nothing spends money without an `accept` record**: apply refuses a `proposalId` the folded log does not
show as pending.

### D2. Grounding payload — assembled server-side, one builder

`buildChatContext(store, carouselId, scope, referenceAssetIds)` in `editor/server/src/compose/` assembles,
per request:

| piece | source |
|---|---|
| brand style, palette in words, tone, image direction, logo rules | `loadBrandStyle(profileDir)` (`system/ig-carousel/brand-style.ts:158`) |
| template constraints: zones, per-kind slots with roles and geometry, margins, signature | `loadLayoutTemplate(profileDir, doc.template.id, brand)` (`system/ig-carousel/layout-template.ts:198`) — `brand` is a required argument, not optional |
| selection + its plan fragment: only those slides' objects (`slot`, `kind`, `text`, `assetId`, `source`, `pinned`) | the persisted document |
| pinned pieces inside scope, listed as immutable | same, filtered on `pinned: true` |
| library index projected to `{id, kind, tags, w, h, derivedFrom}` — ids only, never bytes | `assets/index.json`, `status:"approved"` only (the eligibility `buildCompositionPlan` already uses, `planner.ts:200`) |
| references for this message | D3 |
| brand taste rules | `profiles/<slug>/skills/*/SKILL.md`, read at request time |

**The browser never assembles grounding.** It sends `{ text, scope, referenceAssetIds }` and nothing else.
The client has no profile root (`ProfileStore` is the only door to disk), and a client-assembled context
would be forgeable and coupled to whichever tab is open. It also keeps the headless front (ESTADO "Front
1") on the same code path.

### D3. References

A dropped file or URL is registered with `registerFile(profileDir, bytes, { kind:"unclassified",
origin:"reference", status:"candidate", destRelPath:"assets/references/<hash>.<ext>" })`; a URL is fetched
server-side and stored identically, with the source URL in the sidecar `assets/references/<id>.json`. This
requires adding `"reference"` to `ASSET_ORIGINS` in `system/assets/index.ts:40` (today `["manual","ai"]`) — a
generic engine change, no brand literal.

A reference has one of two roles, chosen when it is attached (default: `layout` for a PNG in slide
proportions, `content` otherwise):

- **`layout`** — the reference *is* the poster. `compose_from_reference` measures its text lines locally (OCR)
  and finds its framed picture. The text model maps every line outside the picture to a zone and reads the new
  event's data off the `content` reference; the wordmark stays as it is and a field label keeps its caption,
  with the new value on the line below. By default the background is the layout itself, at the slide's size,
  with every one of those texts erased locally (a chip's pill grows when its new text needs it); the `content`
  image goes in the frame as a movable object, and every text goes on top as an editable object in the brand's
  typography, in the ink that reads on what is behind it. `EDITOR_POSTER_BACKGROUND=provider` repaints the
  background with the provider's image edit instead, registered to the slide from the texts it keeps.
- **`content`** — it brings the new event. When the provider does not accept it as an image, it is described
  in words through those replacements, and the proposal says so.

Pinned and locked pieces on the target slide are kept. A reference, placed or not, stays out of the library, the Bucket and the
catalog the model sees; for image
generation it is passed to the provider as an input image when the provider accepts it, and described in
words otherwise, which the proposal states.

### D4. Chat action → plan mutation (closed set, v1)

| action | maps onto |
|---|---|
| `add_slide {afterIndex, kind}` | the insert `mutations.ts` `addSlideWithColor` already does |
| `delete_slide {slideId}` | new; `snapshotDocument` → splice → `writeDocument` (versioned, never destructive) |
| `set_text {slideId, objectId\|slot, text}` | `setTextContent` (client) + `assignTextColorKeys` — the latter is **already server-side**, `planner.ts:301`, and does not move |
| `set_visual_from_library {slideId, slot, assetId}` | `setBackgroundAsset` / `addLibraryAssetObject` |
| `generate_visual {slideId, slot, prompt, kind}` | `generateForSlot` → `attachGeneratedAsset` (`routes/compose.ts`) |
| `reset_to_slot {slideId, objectId}` | `resetObjectToSlot` / `object-reset.ts` rules |

**No second generation pipeline is introduced** — every image goes through `generateForSlot`, every price
through `estimateImageCostCents`, every write through `ProfileStore`.

Most of these live only in `editor/web/src/editor/mutations.ts` today, and they must run server-side for
the chat and for the headless front, so the pure document functions move to
`system/ig-carousel/carousel-document-mutations.ts` and both sides import them. They are not forked.

Two corrections to "client-only", both in this change's favour: `assignTextColorKeys` is already server
-side (`planner.ts:301`) and `resetObjectToSlot` (`mutations.ts:224`) already wraps the engine's
`object-reset.ts:30`, which #49 moved there for this reason. The move continues work already begun.

### D5. The freedom ladder

Which action the planner emits for a visual is not a free choice. **The planner descends these rungs in
order and takes the first that fits**, and the proposal must state the rung it landed on and why, in one
phrase the owner can argue with.

1. **Reuse** — an approved asset in the library fits the slot. This is the default and the correct answer
   *even if generation were free*: a background the owner already used is a brand decision already made,
   and re-making it discards that decision. Cost is a consequence of this rule, never its motive.
2. **Derive** — an existing asset is nearly right: vary it, crop it to the slot's geometry, recolor it to
   the palette. See below; not fully available in v1.
3. **Generate constrained** — nothing in the library fits, so generate, tightly bound by brand style,
   the template slot's geometry and the owner's references for this message.
4. **Generate free** — no reference material exists for this subject, so the AI proposes with latitude.
   "No reference" is operational, not a judgement call: the message carried no `referenceAssetIds`, **and**
   the library search returned no candidate of the requested `kind` matching the request's tags. Both
   conditions, or the planner is on rung 3.

**Plural selection, singular request.** "Una imagen" over a multi-slide selection means one image applied
to every selected slot, not one per slot; distinct-per-slot only on an explicit request. The proposal
states it as "1 imagen generada, aplicada a N láminas" so a wrong reading costs a sentence, not money.

**Rung 2, honestly.** It does not exist and is not a small addition. `GenerateImageSpec`
(`editor/server/src/ai/piece-generator.ts:68`) carries `prompt`, `kind`, `canvas`, `brand` — **no
input-image field** — and `openai.ts` posts JSON to `https://api.openai.com/v1/images/generations` with
`IMAGE_MODEL` (`gpt-image-1-mini`, defined in `editor/server/src/ai/pricing.ts:16`). The provider
family does expose an image-edit endpoint that accepts an input image, so img2img is reachable, but it
costs a new field on the spec, a multipart branch in the one file allowed to know the provider, a second
pricing entry and a `none.ts` path. **Rung 2 is a named follow-up, not v1.** One sub-case is worth
splitting out early because it needs no model at all: cropping/reframing an existing asset to a slot's
geometry is deterministic and belongs to the render path, not the AI path. Until rung 2 lands, the planner
skips it and says so, rather than silently pretending the ladder has three rungs.

### D6. The library loop

Everything the AI generates must return to the library as reusable material, recording what it came from,
so the frame grows on its own. Two findings, one against the assumption:

- **Promotion already exists**, contrary to "nothing closes the loop": `approveNewlyPinnedAssets`
  (defined `editor/server/src/routes/profiles.ts:279`, called from the PUT handler at `:226`) promotes a
  piece to `approved` when its `pinned` flips true on save, and `export-queue.ts:251` does the same on
  export. Those are the two triggers the asset-library
  spec names.
- **The hole is a third trigger and provenance.** A visual the owner accepts in the chat but never pins
  nor exports stays `candidate` forever, and `buildCompositionPlan` (`planner.ts:188`) only considers
  `approved` (`planner.ts:200`) — so the chat's own output is invisible to rung 1 next week. And
  `generatedSidecarSchema` (`system/assets/index.ts:68`) records `prompt`, `model`, `costCents`,
  `createdAt`, `carouselId`, `slot` and **nothing about what the piece came from**.

This change therefore extends `system/assets/` — no new store:

- `generatedSidecarSchema` gains `derivedFrom?: string[]` (parent asset ids, empty for a rung-3/4
  generation, populated by rung 2) and `referenceIds?: string[]` (the references that grounded it).
  `assetEntrySchema` (`system/assets/index.ts:46`) surfaces `derivedFrom` so the index can be filtered on it without opening sidecars.
- Accepting a proposal promotes every asset it produced to `approved` — a third trigger alongside pinning
  and export, written in the same `updateEntry` call the other two use. Acceptance is the owner's explicit
  confirm, which is exactly the signal the other two triggers stand for.

### D7. Transport — request/response, no SSE in v1

`POST …/chat/messages` returns the assistant message with its proposal; `POST
…/chat/proposals/:id/apply` performs the work and returns the new document plus the event records. A
proposal is one small JSON object from one model call, not a prose stream — streaming would buy a second
of perceived latency in exchange for a transport, reconnect logic and partial-state handling this module
has nowhere today. The real wait is *applying*, and that has a proven shape: the per-slot loop in
`plan/apply` persists after each slot and answers `202 partial` on failure. Revisit SSE only if a single
proposal call routinely exceeds a few seconds.

## PR split (dependency order, each ≤600 lines including tests)

1. **Empty deck + entry screen** — `buildEmptyDocument` returns `slides: []`, the empty branch becomes the
   real entry screen rendered below the chrome, and the filmstrip gains a manual delete-slide button. The
   snapshot behind that button is the PUT route's own (structural change computed at
   `routes/profiles.ts:213-216`, snapshot written at `:228-230`), plus an explicit `?snapshot=true` from
   the client so the version survives a later edit restoring the count. It holds the last *saved*
   document, and no UI reads versions yet — in-session, undo is the real way back. The screen is
   not yet chat-first — there is no chat until PR 3; it is the same screen the panel will hang on.
2. **Selection as scope** — `Selection` (`geometry.ts:4`) grows from one `{slideId, objectId}` to a scope
   with slide and slot sets; filmstrip checkboxes; overlay handles multi. No AI.
3. **Chat transport + persistence + panel shell** — `chat.jsonl` append store, fold-to-state reader,
   `POST /chat/messages`, panel under the stage, pending-proposal card. Nothing spends yet.
4. **Grounding builder + cost preview** — `buildChatContext`, and the proposal's rung + cost line.
5. **References** — `"reference"` origin, upload/URL endpoint, `assets/references/`, exclusion rules.
6. **Actions + apply + the ladder** — mutations moved to the engine, the six actions, rungs 1/3/4 in the
   planner, `proposals/:id/apply`.
7. **The library loop** — `derivedFrom` / `referenceIds` on the sidecar and the index, and promotion on
   acceptance as the third trigger.

This refines the brief's four. Scope (2) and the empty deck (1) are prerequisites the brief folded into
other slices, and the loop (7) is new. Rung 2 (derive / img2img) is a named follow-up after these.

## Risks / open questions

- Rung 2 needs a provider capability the `PieceGenerator` interface does not model; widening it is the one
  place this change could leak a provider detail outside `openai.ts`, so it stays out of v1 deliberately.
- `origin: "reference"` widens an engine union the reel module also consumes; confirm no consumer switches
  exhaustively on `AssetOrigin`.
- Promotion-on-acceptance makes the library grow faster than the owner reviews it; if approved-but-unloved
  pieces start winning rung 1, the fix is a review affordance, not a narrower trigger.
- ~~`editor/web/src/i18n/es.ts` does not exist~~ — **corrected: it exists on `main`** (PRs #33–#35), with
  `t()` and an extraction guard that is not advisory: `i18n/index.test.ts` fails on a Spanish literal
  anywhere under `editor/web/src` outside `i18n/`, reading the whole Latin-1 block as Spanish — so even a
  `×` glyph is a failure (use `✕`). Nothing here waits on `editor-usable-baseline` for i18n.
