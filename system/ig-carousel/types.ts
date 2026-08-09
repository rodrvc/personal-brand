import type { BrandTokens, DeclaresBrandFeatures } from "./brand-schema.js";

/**
 * Data shape the render engine accepts. The engine is fully agnostic of where
 * this data comes from (a public events API, hand-authored copy, anything) —
 * it only ever consumes this JSON contract.
 */
export interface Slide {
  // Optional: text-led templates (e.g. a brand-message carousel with no
  // event photography available) render without an image entirely.
  image?: string;
  title: string;
  subtitle: string;
  meta: string;
  category?: string;
  /**
   * Start time as the publisher wants it displayed (e.g. "20:00"). Optional
   * because not all content is time-bound: an all-day event, or a slide that
   * isn't an event at all, simply omits it and templates render no time.
   *
   * This exists so the engine never has to infer structure from prose. It
   * previously regex-scraped an HH:MM out of `subtitle` and, failing that,
   * guessed at a comma-separated fragment — which silently put whatever it
   * found into a clock-labelled chip. Whether a piece of content has a time
   * is the caller's fact to state, not the renderer's to deduce.
   */
  time?: string;
  /**
   * The item's own date, as `YYYY-MM-DD`. Never rendered — templates show
   * `meta`/`subtitle`, which are the publisher's wording. This exists so a
   * date-scoped script can *verify* the item belongs in the period it is
   * building, instead of trusting that whoever wrote the input got it right.
   *
   * A carousel once shipped with events from one week under a header naming a
   * different one: both facts were present (the header came from `--date`, the
   * dates lived in `meta` prose) and nothing compared them. The mismatch was
   * only visible by opening the PNG. Stating the date as data is what makes
   * that check possible at all — parsing it back out of `meta` would be the
   * same prose-guessing this contract exists to avoid (see `time` above).
   *
   * Optional: content that isn't date-bound omits it, and a script that
   * doesn't scope by date ignores it.
   */
  date?: string;
}

declare const verified: unique symbol;

/**
 * A `Slide` that has been through `verifyOrThrow`. Nominal, not structural: the
 * brand is a `declare`d `unique symbol`, never exported and with no runtime
 * existence, so it cannot be *constructed* — an object literal or a plain
 * `Slide[]` will not satisfy this type.
 *
 * This exists because the guard was, until now, a *convention*: all three entry
 * points called `verifyOrThrow`, and `renderBatch<T>` accepted any `T`. A
 * 24-line file inside this folder that imported `renderBatch` directly rendered
 * an invented image URL to a PNG — exit 0, file on disk, no guard run. The three
 * call sites were correct; nothing made a fourth one be.
 *
 * ## What this does NOT prevent, stated plainly
 *
 * `slides as VerifiedSlide[]` compiles, from anywhere, in a single step —
 * `VerifiedSlide` is a *subtype* of `Slide`, and a downcast to a subtype is the
 * canonical thing `as` exists to express. TypeScript cannot refuse it.
 *
 * That matters more than the usual "a determined caller can always use `as
 * unknown as`", because this cast needs no bad faith: it is what someone writes
 * in good faith when the compiler says "Slide[] is not assignable to
 * VerifiedSlide[]" — read the type name, infer "I must mark these as verified",
 * add the cast, ship an unverified PNG. An earlier version of this comment
 * claimed no caller outside `verify-slides.ts` could write this type. That was
 * false, and a review demonstrated it by rendering an invented image URL.
 *
 * So the honest description of the guarantee is two-layered:
 *
 *  - **The compiler** rejects every route that does not involve an explicit
 *    assertion: direct `Slide[]`, groups, spreads, maps, widened or unioned item
 *    types, generic wrappers, containers at the non-slide door. That is the
 *    class of accident that actually happened, seven times.
 *  - **The commit gate** (`scripts/validate_commit_guardian.py`) rejects `as
 *    VerifiedSlide` outside `verify-slides.ts`, because the one remaining route
 *    is textual and a text check closes what a type cannot.
 *
 * Neither layer stops `as unknown as`, nor a module driving Playwright itself.
 * Those are outside what a structural type system can express, and pretending
 * otherwise is how the false promise above got written in the first place.
 *
 * Deliberately not exported as a constructible thing: there is no
 * `asVerified()`, because a public mint is the same hole with extra steps.
 */
export type VerifiedSlide = Slide & { readonly [verified]: true };

export interface CarouselInput {
  /**
   * The city this batch of content belongs to. Lives with the content rather
   * than with the brand so one brand can cover several cities without
   * duplicating its tokens. Templates that reference a location interpolate
   * it; batches with no geography simply omit it.
   */
  city?: string;
  /**
   * The wider region/country shown next to the city. Same kind of data as
   * `city` — geography of *this content*, not of the brand — so it travels
   * with the input for the same reason: a brand that expands across regions
   * shouldn't have to fork its brand tokens to say so.
   */
  region?: string;
  /**
   * Hosts the `image` URLs in this batch legitimately come from — normally the
   * host of the source the items were fetched from. When present, a script may
   * reject a slide whose image points anywhere else: the case being caught is
   * an image URL that was *composed* rather than copied, which renders a card
   * pointing at a file that doesn't exist.
   *
   * This lives with the content, not with the brand, and not on the command
   * line. It is an assertion about *where this data came from* — the same
   * lineage as the recipe's `source.url` and `source.field_map.image` — whereas
   * brand.json holds presentation tokens (colors, type, copy, radii). It
   * previously sat in brand.json, where a profile that changed data source had
   * to edit its palette file to say so.
   *
   * Reaching the engine through this file rather than a flag is deliberate: the
   * same step that writes the `image` URLs writes the hosts they must match, so
   * the claim and the data it constrains cannot drift apart, and a forgotten
   * declaration is visible in the input instead of missing from a command
   * nobody re-reads.
   *
   * Optional and non-restrictive: content whose imagery is hand-authored or
   * hosted anywhere omits it and no host check runs.
   */
  sourceImageHosts?: string[];
  slides: Slide[];
}

/**
 * A template renders a single slide to a full HTML document string.
 * Keeping this as a plain function type (rather than a class hierarchy)
 * keeps each variant trivially testable in isolation: given a brand and a
 * Slide, assert on the returned markup. `options` is optional and
 * variant-specific (e.g. `brand-message.ts` uses `index`/`total` for
 * "N/total" page numbering) — templates that don't need it ignore it.
 */
export type SlideTemplate = ((
  brand: BrandTokens,
  slide: Slide,
  options?: { index?: number; total?: number },
) => string) &
  // Each template states the brand data it reads, so callers derive the
  // validation set from the templates they invoke instead of retyping it.
  DeclaresBrandFeatures;

/**
 * A group template renders several slides (grouped for the "list-format"
 * variant) to a single full HTML document string. Distinct from
 * SlideTemplate because this variant's unit of rendering is a group of
 * events, not a single event.
 */
export type SlideGroupTemplate = ((
  brand: BrandTokens,
  slides: Slide[],
  options?: { headerLabel?: string; city?: string; region?: string },
) => string) &
  DeclaresBrandFeatures;
