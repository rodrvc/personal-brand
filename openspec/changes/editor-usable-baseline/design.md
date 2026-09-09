## Context

The editor module is complete against its original change (`editor-carruseles`) but has never been driven end to end by its owner. Four things block that, and an investigation established which of them are defects and which are missing surfaces:

- **Composition on entry.** Creating a carousel enqueues a background job that drafts every text. No code path generates on mere page load — verified — but the create action itself is enough to make entering the product feel like it spends money before the user has decided anything.
- **Assets appear absent.** They are not. The profile store resolves symlinked profile roots correctly (it realpaths the root before comparing, so a profile pointing outside the repo is still inside its own allowed root), the index is read, and the endpoints return correct data. What is missing is a surface: assets are reachable only from the properties panel of an already-open document.
- **Templates appear absent.** They genuinely are. One engine layout exists, no profile declares an override, and there is no endpoint that lists templates — only one that fetches a template by an id the caller must already know. Selection is therefore impossible.
- **The signature is editable.** The one element the owner requires to be immovable is modelled as an ordinary slot, which any document — or any AI writing one — can reposition or reword.

The owner's framing, which this design takes as given: a template is grounding, not a starting point. It fixes the *frame* — shape, logo, borders, typography, signature, margins. It deliberately does not fix content assets; images, icons and 3D pieces stay free.

## Goals / Non-Goals

**Goals:**
- Entering the editor is inert: nothing is drafted, generated or charged until asked.
- The brand's assets and templates are visible and selectable without opening a document first.
- The signature is unreachable from any composition, by construction rather than by convention.
- UI copy lives in a locale resource.
- Each piece ships as a small, independently reviewable pull request.

**Non-Goals:**
- Drag-and-drop of assets onto the canvas or onto the AI panel.
- Text auto-fit (shrink-to-fit). It exists nowhere today and is net-new work.
- A conversational AI panel.
- AI generation of templates.
- A brand-level library screen, separate from an open carousel.
- Per-slot `locked` enforcement. Zones already guarantee everything the owner needs fixed; slot-level locking would be machinery without a customer.

## Decisions

**Delete the compose-on-create path rather than gate it behind a flag.** A flag would preserve a code path nobody wants and leave the "is it spending money?" question alive in the UI. The background job machinery (`compose-job.ts`, its polling endpoint, the progress/cost header, the "Ver plan" drawer) goes with it. Per-piece generation is untouched and remains the way composition happens. *Alternative considered:* keep the prompt as an opt-in checkbox on the create screen. Rejected: it reintroduces the same surprise for anyone who leaves it ticked, and the owner asked for an empty canvas, not a quieter default.

**The signature becomes a footer zone property, not a slot.** Zones are painted by the engine directly from the resolved template and are never document objects, which is exactly the property the signature needs. Modelling it as a slot with a `locked` flag would require a new enforcement point in document validation and would still be a slot — something a document can carry an object for. Making it a zone means there is nothing to enforce: no document object can address it. *Alternative considered:* add `locked: boolean` to `LayoutSlot` and reject violating documents at validate time. Rejected for this change — it is a larger surface (schema, resolve, validate, UI affordance) whose only customer today is the signature, which zones already solve.

**The signature's text is a copy key, not a literal.** The template names a key; the brand supplies the string. This keeps templates free of brand literals — a hard repo rule for anything under `system/` — and means the same template works for a second brand. A missing key fails validation loudly rather than rendering an empty band, because a silently absent signature is indistinguishable from a correct one on a rendered PNG.

**The template reference on a document becomes optional and mutable.** "No template" is a first-class choice, not an error state: the brand's palette and fonts still apply, no zones are painted, no slots are imposed. Making it mutable means swapping a template re-resolves zones and geometry while keeping content held in slots common to both. *Alternative considered:* require a template always, with a built-in "blank" template as the escape hatch. Rejected: a blank template that declares nothing is a null object pretending to be a value, and it would still paint a footer band the user did not ask for.

**Template listing merges engine defaults with profile overrides, override wins by id.** This mirrors how the resolved template is already looked up, so listing and resolution cannot disagree. Each entry carries its origin so the UI can say whether a brand has templates of its own — the difference between "this brand has none" and "nothing exists" was precisely what the empty panel failed to communicate.

**Locale resource as a plain keyed JSON module, no i18n framework.** The product ships one language and needs no pluralisation rules, no date/number locale machinery and no lazy bundle splitting. A dependency would buy nothing here and would have to be configured, upgraded and reasoned about. Missing keys fall back to the default locale and warn in the console. *Alternative considered:* adopt a standard i18n library now to avoid a migration later. Rejected as speculative; the keyed-lookup shape this establishes is what such a library would consume anyway.

**Four pull requests, in dependency order.** (A) empty canvas — mostly deletion, reviewable in minutes; (B) template listing endpoint plus the side-panel listings, which is the slice that answers "I can't see my assets or templates"; (C) the footer signature, which touches the render engine and so travels alone; (D) the locale extraction, which is broad but mechanical and would drown any of the others in noise. B depends on nothing in A; C and D are independent of both.

## Risks / Trade-offs

**Removing compose-on-create leaves the editor with no fast path to a full carousel.** → Accepted deliberately: that fast path is what the owner rejected. The messaging/agent front, which is where "give me a whole carousel" belongs, is a separate track and will drive composition headlessly rather than through this screen.

**Deleting the compose job removes code that per-piece generation partly shares.** → The shared pieces (planner, per-piece generation, cost accounting) stay; only the orchestration that fans them out on create is removed. Any test covering the fan-out goes with it, and the per-piece tests must be confirmed still meaningful rather than silently thinned.

**Existing carousels were created under the old flow.** → They remain valid: their template reference simply becomes explicit where it was implicit. No migration script is needed, but the resolve path must tolerate a document lacking the reference entirely, which is the same code path "no template" uses.

**A footer signature changes rendered output for any brand whose template declares one.** → Only templates that declare a signature paint one, so no existing render changes unless a template is edited. The seed template used for testing lives in a profile folder outside the repo and cannot affect anyone else.

**Locale extraction touches nearly every component.** → Kept in its own pull request precisely so the diff is large but boring, and so a regression in it cannot be confused with a regression in behaviour.

## Migration Plan

No data migration. Documents created before this change validate unchanged; those carrying a template id keep it, and the field simply becomes optional. Rollback is per-pull-request: A and D are pure reversals; B adds an endpoint and two listings, whose removal restores the prior surface; C is inert for any template that does not declare a signature.

## Open Questions

- Whether the create screen keeps a free-text title field or derives the title from the first slide once one exists. Not blocking: a title is required to list carousels, so it stays for now.
- Where template selection lives after creation — the side panel's template tab is the obvious home, but the "Lámina" panel already owns template parameters, and the two should not disagree about who owns template state.
