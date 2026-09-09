## 1. PR A — New carousel opens empty

- [ ] 1.1 Remove the compose job enqueue from carousel creation in `editor/server/src/routes/compose.ts`, so `POST /api/profiles/:slug/carousels` creates the document and returns it with no job id
- [ ] 1.2 Remove the compose job module and its polling endpoint (`editor/server/src/compose/compose-job.ts`, `GET .../compose/:jobId`), keeping the planner and per-piece generation intact
- [ ] 1.3 Reduce the new-carousel dialog to title, brand and optional template; remove the prompt field and its cost/progress affordances
- [ ] 1.4 Remove the compose-job polling effect, the progress/cost header and the "Ver plan" drawer from `editor/web/src/editor/Editor.tsx` and its panels
- [ ] 1.5 Delete tests covering the removed fan-out; confirm the per-piece generation tests still exercise real behaviour rather than silently thinning
- [ ] 1.6 Verify manually: creating a carousel lands on an empty canvas, no piece is `pending`, no provider request is made, and a reload keeps it empty
- [ ] 1.7 Run `pnpm test`, `pnpm typecheck` and `python3 scripts/validate_commit_guardian.py --scan`; open the PR

## 2. PR B — Template listing and side-panel listings

- [ ] 2.1 Add a template listing function to the layout-template module that merges engine defaults with a profile's overrides, override winning by id, each entry carrying id, display name and origin
- [ ] 2.2 Expose it as `GET /api/profiles/:slug/templates` in `editor/server/src/routes/profiles.ts`, responding 404 for an unresolvable slug without reading outside the profiles root
- [ ] 2.3 Add a test for the merge rule (override replaces default of the same id) and for the 404 path
- [ ] 2.4 Add an assets tab to the side panel listing every non-hidden asset of the profile grouped by kind, including `unclassified`, reusing the existing grouping logic outside the properties panel
- [ ] 2.5 Add a templates tab listing the brand's available templates, marking which one the open carousel uses and distinguishing "this brand has none of its own" from "none exist"
- [ ] 2.6 Give both tabs explicit empty states naming the profile, never a silent blank
- [ ] 2.7 Verify manually against a profile with assets on disk and against one with no assets directory
- [ ] 2.8 Run the full check suite; open the PR

## 3. PR C — Footer signature as a zone

- [ ] 3.1 Extend the footer zone schema in `system/ig-carousel/layout-template.ts` with an optional signature carrying a brand copy key, a font key and a colour role
- [ ] 3.2 Make validation fail naming the missing key's path when a template declares a signature the brand does not define
- [ ] 3.3 Paint the signature in `renderFooterZone` in `system/ig-carousel/templates/free-layout.ts`, on every slide, from the resolved template and brand
- [ ] 3.4 Confirm no brand literal enters `system/` — the key is named by the template, the string comes from the brand
- [ ] 3.5 Add a render test proving a document object cannot displace or replace the signature
- [ ] 3.6 Verify a template declaring no signature paints none, so existing renders are unchanged
- [ ] 3.7 Run the full check suite; open the PR

## 4. PR C2 — Optional, swappable template reference

- [ ] 4.1 Make the document's template reference optional in the carousel document schema and its resolve path
- [ ] 4.2 Render and export a document with no template reference: brand palette and fonts apply, no zones painted, no slots imposed
- [ ] 4.3 Support changing the reference on an existing document, keeping content in slots common to both templates and demoting the rest to free objects
- [ ] 4.4 Surface template selection in the UI at creation and on an open carousel, including "sin template", showing which is active
- [ ] 4.5 Resolve the ownership overlap flagged in the design: the side panel's template tab versus the "Lámina" panel's template parameters
- [ ] 4.6 Add tests for the no-template render path and for the swap-preserves-common-slots rule
- [ ] 4.7 Run the full check suite; open the PR

## 5. PR D — Locale extraction

- [ ] 5.1 Add a keyed locale module with a default locale file and a lookup that falls back to the default and warns on a missing key
- [ ] 5.2 Move every user-facing string in `editor/web/src/` into the locale resource, leaving field paths and developer-facing detail untranslated
- [ ] 5.3 Confirm no component needs editing to change displayed copy
- [ ] 5.4 Convert remaining technical prose (comments, docs) touched by this change to English per repo convention
- [ ] 5.5 Run the full check suite; open the PR

## 6. Close-out

- [ ] 6.1 Reconcile `editor/ESTADO.md` with what shipped, removing the superseded slot-level `locked` model
- [ ] 6.2 Demonstrate the flow to the owner with the seed template: empty canvas, assets and templates listed, template selected, signature fixed
- [ ] 6.3 Run `openspec validate editor-usable-baseline` and archive the change once merged
