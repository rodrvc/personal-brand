import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readRecipeImageHosts, type RecipeImagePolicy } from "./recipe.js";
import type { CarouselInput, Slide, VerifiedSlide } from "./types.js";

/**
 * Pre-render checks that drop unusable slides instead of rendering them.
 *
 * Both rules here come from real defects that reached a finished PNG:
 *
 *  - A carousel rendered events from one week under a header naming another.
 *    The header and the dates were both present; nothing compared them.
 *  - An image URL was invented rather than copied from the source, so a card
 *    pointed at a file that does not exist.
 *
 * Neither was caught by reading the input — both looked fine as JSON. So the
 * check belongs in the engine, before the render, where it cannot be skipped
 * or forgotten.
 *
 * The policy is *drop and continue*, not *fail the run*: a single bad item
 * shouldn't cost the whole carousel when the curated list has more candidates
 * behind it. But nothing is dropped silently — every removal is reported with
 * the reason, and the caller decides whether what is left is still enough.
 *
 * That policy has one exception, and it comes from the same first defect: a
 * batch where *no* item is dated cannot be dropped item by item, because every
 * item passes. It is reported as an `unverified` finding instead — see
 * `VerifyOptions.requireDates`.
 */

export interface Rejection {
  slide: Slide;
  reason: string;
}

export interface VerifyResult {
  kept: Slide[];
  rejected: Rejection[];
  /**
   * Findings about the batch as a whole rather than about any single slide —
   * today, only "a period was given but no slide carries a date". Kept separate
   * from `rejected` because dropping slides is the wrong remedy: the input isn't
   * *partly* unverifiable, it is *entirely* unverifiable, and silently rendering
   * whatever it contains is precisely the original defect. Reported rather than
   * thrown so the library stays a pure classifier and the caller chooses the
   * severity — see `requireDates` for the caller that chooses "fatal".
   */
  unverified: string[];
}

export interface VerifyOptions {
  /** Inclusive period the slides must fall within. Omit to skip the date check. */
  period?: { start: Date; end: Date };
  /**
   * Hosts an image may be served from (e.g. the source API's host). An image on
   * any other host is treated as invented rather than copied. Omit to skip.
   */
  allowedImageHosts?: string[];
  /**
   * Whether `period` may be checked against *nothing*.
   *
   * The per-slide rule below deliberately lets a slide with no `date` pass:
   * this library serves date-bound and non-date-bound content alike, and it
   * cannot tell "not applicable" from "the caller forgot". But that tolerance
   * composes into a hole. If *no* slide in the batch carries a date, the period
   * check runs zero comparisons and the whole verification passes in silence —
   * which is the exact state the shipped defect was in: real dates existed only
   * as prose inside `meta`, `date` was absent everywhere, and a header naming
   * one week went out over another week's events.
   *
   * `true` (the default, whenever a `period` is given) records that as an
   * `unverified` finding. A caller rendering non-dated content under a date
   * range on purpose passes `false` to say so explicitly — an opt-out that is
   * written down, rather than a gap nobody noticed.
   */
  requireDates?: boolean;
}

/** `YYYY-MM-DD` as local midnight — `new Date("2026-08-17")` is UTC and can land a day earlier. */
function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Rejects impossible dates that the regex accepts, e.g. 2026-02-31 rolling
  // over into March — a silent month shift is exactly the class of bug here.
  return date.getMonth() === Number(match[2]) - 1 ? date : null;
}

function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Splits slides into those safe to render and those to drop, and reports
 * whether the period check had any data to work with at all.
 *
 * A slide with no `date` passes the period check: content that isn't
 * date-bound is legitimate, and this function cannot tell the difference
 * between "not applicable" and "the caller forgot" — that is the caller's
 * fact to state. A slide whose `date` is *present but unparseable* is
 * rejected, because that is a real mistake rather than an omission.
 *
 * What that per-slide tolerance cannot express is the batch-level case: 0 of N
 * slides dated, so the period was never actually checked. That lands in
 * `unverified` (see `requireDates`), because "every slide passed" and "nothing
 * was tested" are different results and must not read the same.
 */
export function verifySlides(slides: Slide[], options: VerifyOptions = {}): VerifyResult {
  const { period, allowedImageHosts, requireDates = true } = options;
  const kept: Slide[] = [];
  const rejected: Rejection[] = [];

  for (const slide of slides) {
    const reason = rejectionReason(slide, period, allowedImageHosts);
    if (reason) {
      rejected.push({ slide, reason });
    } else {
      kept.push(slide);
    }
  }

  const unverified: string[] = [];
  // Counted over the input, not over `kept`: a batch whose only dated slides
  // were just dropped for falling outside the period was still verified.
  if (period && requireDates && slides.length > 0 && !slides.some((s) => s.date !== undefined)) {
    unverified.push(
      `none of the ${slides.length} slide(s) carries a "date", so the period ` +
        `${isoDay(period.start)}..${isoDay(period.end)} was never checked against anything. ` +
        `Add "date": "YYYY-MM-DD" to each item (copied from the source, not read off the prose ` +
        `in "meta"), or pass requireDates: false if this content is deliberately not date-bound.`,
    );
  }

  return { kept, rejected, unverified };
}

function rejectionReason(
  slide: Slide,
  period: VerifyOptions["period"],
  allowedImageHosts: string[] | undefined,
): string | null {
  if (period && slide.date !== undefined) {
    const date = parseDate(slide.date);
    if (!date) {
      return `date "${slide.date}" is not a valid YYYY-MM-DD`;
    }
    if (date < period.start || date > period.end) {
      return `date ${slide.date} is outside ${isoDay(period.start)}..${isoDay(period.end)}`;
    }
  }

  if (allowedImageHosts?.length && slide.image !== undefined) {
    let host: string;
    try {
      host = new URL(slide.image).host;
    } catch {
      return `image is not a valid URL: ${slide.image}`;
    }
    if (!allowedImageHosts.includes(host)) {
      return `image host "${host}" is not one of the source hosts (${allowedImageHosts.join(", ")})`;
    }
  }

  return null;
}

/**
 * Reads `sourceImageHosts` off a carousel input, refusing a declaration that
 * would disarm the host check instead of running it.
 *
 * Validated eagerly and unconditionally, unlike the value-shaped fields around
 * it: this key guards a *check*, so a malformed one fails **open**, not loudly.
 * A singular `sourceImageHost`, or a bare string where an array belongs, would
 * leave `allowedImageHosts` undefined or char-indexed and the check would
 * quietly never run — an opt-in protection that silently disarms itself is
 * worse than none at all, because the file reads as covered.
 *
 * Omitting the key entirely stays valid: that is a deliberate "my imagery can
 * live anywhere", and it reads as such.
 */
export function readSourceImageHosts(input: CarouselInput, inputPath: string): string[] | undefined {
  const fail = (problem: string): never => {
    throw new Error(`Invalid ${inputPath}: ${problem}`);
  };

  const near = Object.keys(input).find(
    (key) =>
      key !== "sourceImageHosts" && key.toLowerCase().replace(/s$/, "") === "sourceimagehost",
  );
  if (near) {
    fail(
      `"${near}" is not a known key — did you mean "sourceImageHosts"? ` +
        `Misspelt, the image-host check silently never runs.`,
    );
  }

  const hosts = input.sourceImageHosts;
  if (hosts === undefined) {
    return undefined;
  }
  if (!Array.isArray(hosts) || hosts.length === 0) {
    fail("sourceImageHosts must be a non-empty array of host strings");
  }
  hosts.forEach((host, index) => {
    if (typeof host !== "string" || host.length === 0) {
      fail(`sourceImageHosts[${index}] must be a non-empty string`);
    }
  });
  return hosts;
}

/**
 * Compares what the recipe *declared* about image provenance against what the
 * input actually carries, and reports the gap.
 *
 * This closes the hole that moving `sourceImageHosts` out of `brand.json` and
 * into the recipe opened. The field found its correct conceptual home, but
 * nothing verified it arrived: the recipe is prose the agent reads, so an input
 * missing the key left `allowedImageHosts` undefined and the host check simply
 * did not run — exit 0, no output, an invented URL rendered into a PNG.
 *
 * The asymmetry that makes this a finding and not a default: for dates, absence
 * of the assertion is treated as unverifiable and refused. Absence here was
 * treated as consent. Same class of gap, opposite doctrine — and the omission is
 * *likelier* here, because the step that copies the hosts across is the same
 * step that can invent the URL. A guard whose installation is left to the actor
 * it guards is not a guard.
 *
 * Returns findings for the `unverified` channel rather than throwing, keeping
 * severity the caller's choice — the same split `verifySlides` already uses.
 */
export function verifyImagePolicy(
  slides: Slide[],
  policy: RecipeImagePolicy,
  inputHosts: string[] | undefined,
  inputPath: string,
): string[] {
  const { declaredHosts } = policy;

  const withImages = slides.filter((slide) => slide.image !== undefined).length;
  if (withImages === 0) {
    return []; // nothing to check hosts on
  }

  // No recipe file at all, but the input carries images and no hosts either:
  // nothing anywhere states where these images may come from, so nothing was
  // checked. Reported rather than approved — "no recipe" was a way to evade the
  // check by pointing --input at another profile's data, and an absent
  // assertion is the same unverifiable state that dates already refuse.
  //
  // A recipe that exists and deliberately omits `image_hosts` is the written
  // opt-out ("my imagery can live anywhere"); so is an input that declares its
  // own hosts. Both are statements. Silence from both files is not.
  if (!policy.exists) {
    // Reported whether or not the input declares hosts of its own. An input
    // that names its own allowlist is the floor writing itself a ceiling — the
    // same self-authorization rejected below for the superset case, and worth
    // spelling out because it was written here once as "the input states its
    // own policy": with no recipe there is nothing that policy answers to, so
    // the state is unverifiable rather than consented to.
    const declared = inputHosts
      ? `${inputPath} declares its own sourceImageHosts (${inputHosts.join(", ")}), but with no ` +
        `recipe there is nothing to check that claim against — an input cannot be its own ` +
        `source of truth.`
      : `${inputPath} carries no "sourceImageHosts" either.`;
    return [
      `no recipe at ${policy.path}, so the ${withImages} slide(s) with images were checked ` +
        `against nothing. ${declared} Declare source.image_hosts in the profile's recipe ` +
        `(the profile's stated intent, which the render does not rewrite) — an invented image ` +
        `URL renders as a card with no photo.`,
    ];
  }

  if (!declaredHosts) {
    // Recipe present and silent on hosts: a deliberate "anywhere". Honoured.
    return [];
  }

  if (!inputHosts) {
    return [
      `the recipe declares source.image_hosts (${declaredHosts.join(", ")}) but ` +
        `${inputPath} carries no "sourceImageHosts", so the ${withImages} slide(s) with ` +
        `images were never checked against it. Copy the hosts into the input alongside ` +
        `"city" — an invented image URL renders as a card with no photo. ` +
        `(recipe: ${policy.path})`,
    ];
  }

  // Checked in BOTH directions, and the *extra* direction is the one that
  // matters more. A host in the input that the recipe never declared is not
  // drift, it is self-authorization: the step writing the image URLs also writes
  // the list those URLs must satisfy, so widening the list is an easier way to
  // land an invented URL than omitting the list altogether. Verifying only that
  // the declared hosts are present leaves exactly that open — the guard would
  // again be installed by the actor it guards.
  //
  // The recipe is a ceiling, not a floor: `inputHosts ⊆ declaredHosts`.
  //
  // Compared case-insensitively (and ignoring a trailing dot) because hostnames
  // are: `API.Example.COM` and `api.example.com` are the same host, and the
  // WHATWG URL parser already lowercases what `rejectionReason` compares. Left
  // literal, this accused the author of declaring a host the recipe "never
  // declared" when the recipe declared it in different case — a check that
  // fails closed but lies about why is still a check nobody trusts.
  const normalize = (host: string): string => host.trim().toLowerCase().replace(/\.$/, "");
  const declaredNormalized = declaredHosts.map(normalize);
  const extra = inputHosts.filter((host) => !declaredNormalized.includes(normalize(host)));
  if (extra.length > 0) {
    return [
      `${inputPath} allows image host(s) the recipe never declared: ${extra.join(", ")}. ` +
        `The recipe is the source of truth (it declares ${declaredHosts.join(", ")}); an input ` +
        `cannot widen its own allowlist. Remove them, or declare them in the recipe if they ` +
        `are genuinely part of the source. (recipe: ${policy.path})`,
    ];
  }

  // Narrower than declared is legitimate — an input may use a subset of the
  // source's hosts — so it is not reported. Only widening is a finding.
  return [];
}

/** `system/`, the engine's own tree — derived from this module's location, not configured. */
const SYSTEM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Refuses `selfDeclaredProvenance` for an input that is not part of the engine.
 *
 * The exemption's whole argument is *where the file lives*: a fixture under
 * `system/` is tracked, reviewed in the diff, and covered by the commit gate, so
 * its self-declaration answers to a human. Nothing checked that, though — the
 * option was accepted from any caller with any `inputPath`, so the tracked-file
 * premise was documentation rather than a fact. A caller passing a profile's
 * `week-input.json` (written by an agent on every run — the same actor that can
 * invent an image URL) got the fixture's authority for free, which is exactly
 * the self-authorization `verifyImagePolicy` refuses one function below.
 *
 * Path-prefix, not "is it tracked by git": the render path must not shell out to
 * git, and containment under `system/` is the property the argument actually
 * rests on. `resolve` first so `system/ig-carousel/../../profiles/x/in.json`
 * cannot walk out and still match the prefix, and the separator is appended so a
 * sibling directory named `system-scratch/` is not read as being inside.
 */
function assertEngineOwnedInput(inputPath: string): void {
  const resolved = resolve(inputPath);
  if (resolved === SYSTEM_DIR || resolved.startsWith(SYSTEM_DIR + sep)) {
    return;
  }
  throw new Error(
    `Refusing selfDeclaredProvenance for ${resolved} — it is outside ${SYSTEM_DIR}.\n` +
      `  That option lets an input vouch for its own image hosts, and the only reason that is ` +
      `safe is that an engine fixture is tracked, diff-reviewed and covered by the commit gate. ` +
      `A profile's input is written by an agent on every run, so its self-declaration proves ` +
      `nothing. Declare source.image_hosts in the profile's recipe instead.`,
  );
}

/**
 * The whole pre-render guard, as one call every entry point makes.
 *
 * Extracted rather than repeated: the guard was written into one script, then
 * copied into a second, and a third entry point (`render.ts` — the only one in
 * `package.json`) went on rendering `slide.image` with no verification at all.
 * Three copies of a check is how a fourth caller ends up without it. A guard
 * that depends on which script you invoke is not a guard on the engine, so
 * there is now exactly one place to call and nothing to remember to copy.
 *
 * Throws on anything unverifiable, warns about what it dropped, and returns the
 * slides that are safe to render — as `VerifiedSlide[]`, the branded type
 * `renderBatch` demands. That return type is what upgraded this from convention
 * to guarantee: all three entry points already called this function, but nothing
 * stopped a fourth caller from skipping it, and one that imported `renderBatch`
 * directly rendered an invented image URL to a PNG. This is the *only* place in
 * the engine that mints the brand, and it mints it strictly after every check
 * above has either passed or thrown.
 *
 * The severity choices live here so they cannot drift between callers:
 *
 *  - unverifiable (no dates under a period, no stated image provenance) → throw,
 *    because the defects this guards against were invisible in the output and a
 *    warning next to finished PNGs gets skimmed past
 *  - individual bad slides → dropped and reported, since the curated list has
 *    candidates behind them
 *  - nothing left → throw, naming what was asked for
 */
export function verifyOrThrow(options: {
  slides: Slide[];
  input: CarouselInput;
  inputPath: string;
  profileDir: string;
  /** Recipe basename under `<profileDir>/recipes/` that declares the source. */
  recipe: string;
  /** Omit for content that is not date-bound (states the opt-out in writing). */
  period?: { start: Date; end: Date };
  /** Named in error messages, e.g. the week label being rendered. */
  label?: string;
  /**
   * Set only for a fixture that ships with the engine rather than coming from a
   * profile, where the input file *is* the authority on its own provenance.
   *
   * The rule it opts out of — an input cannot declare its own image hosts —
   * exists because a profile's input is written by an agent, the same actor that
   * can invent an image URL, so its self-declaration proves nothing. A fixture
   * under `system/` is tracked, reviewed in the diff, and covered by the commit
   * gate; the authority is real there. Narrowly scoped and named rather than
   * loosening the rule, because the rule is right for every profile input.
   *
   * `inputPath` must resolve inside `system/`, and that is enforced rather than
   * trusted — see `assertEngineOwnedInput`.
   */
  selfDeclaredProvenance?: boolean;
}): VerifiedSlide[] {
  const { slides, input, inputPath, profileDir, recipe, period, label } = options;
  const subject = label ? `"${label}"` : inputPath;

  const inputHosts = readSourceImageHosts(input, inputPath);
  const { kept, rejected, unverified } = verifySlides(slides, {
    period,
    allowedImageHosts: inputHosts,
    // Only meaningful with a period; passing it explicitly keeps the "this
    // content is not date-bound" decision visible at the call site.
    requireDates: period !== undefined,
  });

  // Checked before the option is honoured *and* before it is discarded: the
  // claim "this input is engine-owned" is either true or a mistake worth naming,
  // and a caller that passes it for a profile input while forgetting
  // `sourceImageHosts` would otherwise fall through to the ordinary recipe
  // finding and never learn the option was wrong.
  if (options.selfDeclaredProvenance) {
    assertEngineOwnedInput(inputPath);
  }

  // Skipped only for an engine fixture that declares its own hosts (see
  // `selfDeclaredProvenance`); a fixture with no declaration still gets checked.
  if (!(options.selfDeclaredProvenance && inputHosts)) {
    unverified.push(
      ...verifyImagePolicy(slides, readRecipeImageHosts(profileDir, recipe), inputHosts, inputPath),
    );
  }

  if (unverified.length > 0) {
    throw new Error(
      `Refusing to render ${subject} — cannot be verified:\n` +
        unverified.map((finding) => `  · ${finding}`).join("\n") +
        `\n  (input: ${inputPath})`,
    );
  }

  if (rejected.length > 0) {
    console.warn(
      `Dropped ${rejected.length} of ${slides.length} slide(s) for ${subject}:\n` +
        describeRejections(rejected),
    );
  }

  if (kept.length === 0) {
    throw new Error(
      `No slides left to render for ${subject} — all ${slides.length} were dropped. ` +
        `Check what you asked for against the data in ${inputPath}.`,
    );
  }

  // The brand is phantom — a `declare`d symbol with no runtime existence — so
  // this is a re-label of the same objects, not a copy. Reached only past every
  // throw above, which is the whole point: the cast is the assertion "these
  // survived the guard", and it is unwriteable anywhere else because the symbol
  // `VerifiedSlide` is branded with is not exported.
  return kept as VerifiedSlide[];
}

/**
 * Human-readable summary of what was dropped. Printed by the caller so a
 * removal is always visible in the run's output — the failure mode being
 * avoided is a slide vanishing quietly and the carousel coming out short
 * without anyone noticing why.
 */
export function describeRejections(rejected: Rejection[]): string {
  return rejected
    .map(({ slide, reason }) => `  · dropped "${slide.title}": ${reason}`)
    .join("\n");
}
