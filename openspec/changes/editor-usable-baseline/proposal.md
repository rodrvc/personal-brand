## Why

The carousel editor is feature-complete on paper but not usable in practice. Entering a new carousel immediately spends money composing a whole piece from a prompt, which is the opposite of the control the editor exists to provide; the brand's assets are only reachable from inside an already-open document; no template is listable at all, so the one thing that is supposed to ground a composition cannot be chosen; and the brand signature — the one element that must never move — is an ordinary editable object.

This change delivers the smallest slice that a human can actually drive end to end, and nothing more.

## What Changes

- **BREAKING** Creating a carousel no longer composes it. A new carousel opens an empty canvas. The prompt-to-full-carousel entry path is removed, along with the background text-drafting job it started on entry. Composition becomes something the user asks for explicitly, per piece.
- The editor's right-hand panel lists what the resolved brand actually has: its assets and its templates. Both were already on disk and readable; neither had a surface outside an open document's properties panel.
- A list-templates endpoint is added. None exists today — templates can only be fetched by an id the caller already knows, which makes selection impossible.
- Template selection becomes explicit and swappable: a carousel is not born with a template, the user picks one, may pick a different one later, and may pick none — in which case the brand's palette and fonts still apply but no structure is imposed.
- The render engine paints a fixed signature line in the footer zone. Zones are painted directly from the template and are unreachable from document objects, which makes the signature structurally non-editable rather than merely conventionally so.
- UI strings move to a locale JSON file instead of living inline in components.

Explicitly **not** in this change: drag-and-drop of assets onto the canvas or onto the AI panel; text auto-fit; a conversational AI panel; template generation; a brand-level library screen; and enforcement of per-slot constraints beyond what zones already guarantee.

## Capabilities

### New Capabilities
- `editor-i18n`: UI copy is resolved from a locale resource rather than embedded in components, so the interface language is data.

### Modified Capabilities
- `editor-ui`: a new carousel opens empty; the side panel gains asset and template listings; template selection is an explicit, changeable choice including "none".
- `editor-api`: gains a template listing endpoint; carousel creation no longer enqueues a compose job.
- `layout-template`: a template is a selectable reference on a document rather than a value fixed at creation; the footer zone gains a signature.
- `carousel-render`: the footer zone renders a signature line from brand copy, using a brand font and colour role.

## Impact

- `editor/web/src/routes/` — creation flow and the editor route; `editor/web/src/editor/panels/` — side panel tabs.
- `editor/server/src/routes/` — profile and compose routes; the compose job is no longer triggered on create.
- `system/ig-carousel/templates/free-layout.ts` — footer zone rendering; `system/ig-carousel/layout-template.ts` — footer zone schema.
- `system/config/brand.schema.md` and the carousel document doc, if the footer signature changes their contracts.
- Existing carousels created under the old flow keep working; they simply carry a template reference that is now explicit.
