/**
 * Compile-time tests for the pre-render guard. `tsc --noEmit` is the whole test
 * run — there is nothing to execute.
 *
 * `@ts-expect-error` is the assertion: the build fails if a line *stops*
 * erroring, which is the regression to catch — a change that quietly starts
 * accepting unverified slides.
 *
 * These exist because the guard shipped three times with holes that 68 passing
 * runtime tests could not see, and the third one got past a previous version of
 * *this file*: every case here used to pass a fully-resolved concrete type, and
 * the hole was in a call from inside a generic function, where a conditional
 * type defers and its reject branch is skipped. A type-level guarantee needs
 * type-level tests, and they have to include the unresolved case.
 */
import { renderDocuments, renderSlides } from "./render-batch.js";
import type { Slide, SlideTemplate, VerifiedSlide } from "./types.js";

declare const verified: VerifiedSlide[];
declare const verifiedGroups: VerifiedSlide[][];
declare const unverified: Slide[];
declare const variantEntries: [string, SlideTemplate][];

const toHtml = (): string => "<html></html>";
const outputDir = "/tmp/does-not-run";

// --- accepted: the shapes real callers pass ---

void renderSlides({ items: verified, toHtml, outputDir });
void renderSlides({ items: verifiedGroups, toHtml, outputDir });
// Not slide data at all (one template per layout variant). Its own door.
void renderDocuments({ items: variantEntries, toHtml, outputDir });

// `toHtml`'s parameter must stay inferable — a union parameter instead of
// overloads made every call site annotate it by hand.
void renderSlides({ items: verified, toHtml: (s) => s.title, outputDir });
void renderSlides({ items: verifiedGroups, toHtml: (g) => g[0]!.title, outputDir });

// --- rejected: unverified slides, however they are dressed up ---

// @ts-expect-error plain Slide[] — the original hole
void renderSlides({ items: unverified, toHtml, outputDir });

// @ts-expect-error grouped, the shape render-week passes after chunking
void renderSlides({ items: [unverified], toHtml, outputDir });

// @ts-expect-error spread into a fresh array launders nothing
void renderSlides({ items: [...unverified], toHtml, outputDir });

// @ts-expect-error mapped through an identity function
void renderSlides({ items: unverified.map((s) => s), toHtml, outputDir });

// @ts-expect-error an inline literal with no named type anywhere
void renderSlides({
  items: [{ image: "https://api.example.com/x.jpg", title: "t", subtitle: "s", meta: "m" }],
  toHtml,
  outputDir,
});

// A *wider* type than Slide: fewer fields, so proving "is a Slide" fails.
type WidenedSlide = { image?: string; title: string };
declare const widened: WidenedSlide[];
// @ts-expect-error slide data narrowed to "just the fields my template reads"
void renderSlides({ items: widened, toHtml, outputDir });

// A union where only one member is a Slide.
type MixedUnion = Slide | { zzz: number };
declare const mixed: MixedUnion[];
// @ts-expect-error a union containing unverified slide data
void renderSlides({ items: mixed, toHtml, outputDir });

// A subtype: extra fields on top of Slide. Still unverified.
declare const annotated: (Slide & { note: string })[];
// @ts-expect-error extra fields verify nothing
void renderSlides({ items: annotated, toHtml, outputDir });

// --- the escape the previous version of this file could not see ---
//
// Inside a generic body `S` is unresolved, so any conditional over it defers.
// The old gate asked "can I prove this IS slide data?" and skipped its reject
// branch when it could not, i.e. it failed OPEN. A helper generic over "some
// kind of slide" is exactly what a fourth entry point would write.

async function viaGenericSlide<S extends Slide>(items: S[]): Promise<string[]> {
  // @ts-expect-error a generic constrained to Slide is still unverified
  return renderSlides({ items, toHtml, outputDir });
}
void viaGenericSlide;

// The same shape on the non-slide door must also be refused: `renderDocuments`
// is unconstrained, so this is where an unresolved slide-ish parameter would
// otherwise slip in.
async function viaGenericDocuments<S extends Slide>(items: S[]): Promise<string[]> {
  // @ts-expect-error slide data does not belong at the documents door
  return renderDocuments({ items, toHtml, outputDir });
}
void viaGenericDocuments;

// A generic constrained to the *verified* form is accepted, and that is correct
// rather than a leak: `S extends VerifiedSlide` can only be instantiated with a
// type carrying the brand, which only `verifyOrThrow` mints. Concrete parameter
// types resolve this at the boundary instead of deferring a conditional, which
// is exactly why the split fixed the escape.
async function viaGenericVerified<S extends VerifiedSlide>(items: S[]): Promise<string[]> {
  return renderSlides({ items, toHtml, outputDir });
}
void viaGenericVerified;

// --- containers of slides: the sixth escape, and why both doors are concrete ---
//
// The previous gate asked "is T slide-shaped?" and never "does T *contain*
// slides", so every wrapper walked through the documents door. `Slide[][]` is not
// a contrived shape — it is what `chunkSlides` produces and what this file passes
// around, so a caller picking the wrong door by name got a PNG of an invented
// image URL with the compiler's blessing. A concrete parameter has no container
// to recurse through, which is why `renderDocuments` no longer takes a generic.

// @ts-expect-error groups of unverified slides
void renderDocuments({ items: [unverified], toHtml, outputDir });

// @ts-expect-error groups of groups
void renderDocuments({ items: [[unverified]], toHtml, outputDir });

declare const roGroups: (readonly Slide[])[];
// @ts-expect-error readonly groups are still groups of slides
void renderDocuments({ items: roGroups, toHtml, outputDir });

declare const tupleGroups: [Slide, Slide][];
// @ts-expect-error a tuple of slides is a container of slides
void renderDocuments({ items: tupleGroups, toHtml, outputDir });

declare const carried: { slides: Slide[] }[];
// @ts-expect-error slides nested inside a carrier object
void renderDocuments({ items: carried, toHtml, outputDir });

// @ts-expect-error and verified slides belong at the other door, by name
void renderDocuments({ items: verified, toHtml, outputDir });

// --- positive identity assertions ---
//
// Nothing above would catch the guard degenerating into an unconditional pass
// on the documents door, so state the intent directly.

type Expect<T extends true> = T;

/**
 * Non-slide data reaches the documents door unchanged, not collapsed.
 *
 * The `: false` branch is the point — an earlier version returned `true` on both
 * sides, so it could never fail and certified nothing. Every dead assertion in
 * this file is a hole waiting to be found by a reviewer instead of a test.
 */
type _VariantsPassThrough = Expect<
  [[string, SlideTemplate][]] extends [Parameters<typeof renderDocuments>[0]["items"]]
    ? true
    : false
>;
void 0 as unknown as _VariantsPassThrough;

/**
 * The limit of the compile-time guarantee, asserted rather than described: a
 * single-step `as VerifiedSlide[]` compiles, because `VerifiedSlide` is a subtype
 * of `Slide`. No `@ts-expect-error` here — this line is *supposed* to compile,
 * and if it ever stops, the brand changed shape and this file should say so.
 *
 * The commit gate refuses this cast outside `verify-slides.ts`. That split —
 * compiler for the accidental routes, text check for the asserted one — is the
 * whole guarantee, and `types.ts` documents why neither half is sufficient alone.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const castCompiles = unverified as VerifiedSlide[];
void castCompiles;
