import { readFileSync } from "node:fs";
import { join } from "node:path";

import { featuresOf, interpolate, loadBrand, type BrandTokens } from "./brand-schema.js";
import { resolveOutputBaseDir, resolveProfileDir } from "./profile.js";
import { chunkSlides, renderSlides } from "./render-batch.js";
import { renderListFormat } from "./templates/list-format.js";
import type { CarouselInput } from "./types.js";
import { verifyOrThrow } from "./verify-slides.js";

/** Events per slide — what fits cleanly in 1080x1350 with this template. */
const EVENTS_PER_SLIDE = 2;

/**
 * `dates` is optional on BrandTokens (only week-based scripts need it), but
 * inside this file it is always present: `main` asks `loadBrand` for the
 * "dates" feature, which validates it. Naming the non-optional form keeps
 * that guarantee in the type system.
 */
type BrandDates = NonNullable<BrandTokens["dates"]>;

/**
 * Returns "del D al D de <mes>" (or "del D de <mesA> al D de <mesB>" when the
 * week spans two months) for the calendar week (Monday-Sunday) containing
 * `reference`. Computed from a real date rather than hand-typed so the
 * header always matches the actual week being published. Pass a date inside
 * next week (or any other week) to generate for a week other than the
 * current one — the calculation is always "the Mon-Sun week containing this
 * date," not hardcoded to "today."
 */
function weekLabel(
  reference: Date,
  dates: BrandDates,
): { label: string; monday: Date; sunday: Date } {
  const day = reference.getDay(); // 0 = Sunday
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(reference);
  monday.setDate(reference.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startDay = monday.getDate();
  const endDay = sunday.getDate();
  const startMonth = dates.monthAbbr[monday.getMonth()]!;
  const endMonth = dates.monthAbbr[sunday.getMonth()]!;

  const vars = {
    startDay: String(startDay),
    endDay: String(endDay),
    startMonth,
    endMonth,
  };
  const label = interpolate(
    startMonth === endMonth ? dates.weekRangeSameMonth : dates.weekRangeCrossMonth,
    vars,
  );

  // `sunday` travels with the label so callers can check that the items they
  // are about to render actually fall inside the week the header announces.
  return { label, monday, sunday };
}

/** "jul-06" — month abbreviation + the day the week's Monday falls on. */
function weekFolderName(monday: Date, dates: BrandDates): string {
  return `${dates.monthAbbr[monday.getMonth()]}-${String(monday.getDate()).padStart(2, "0")}`;
}

function parseArgs(argv: string[]): {
  profile: string;
  city?: string;
  input?: string;
  reference: Date;
  eventsPerSlide: number;
} {
  const profileIndex = argv.indexOf("--profile");
  const cityIndex = argv.indexOf("--city");
  const inputIndex = argv.indexOf("--input");
  const eventsPerSlideIndex = argv.indexOf("--events-per-slide");
  // `--date YYYY-MM-DD` renders the calendar week containing that date, so a
  // week other than the current one (e.g. "la próxima semana") can be built
  // without waiting for it to arrive. Parsed as local time — a bare
  // `new Date("2026-07-27")` is UTC midnight, which lands on the previous day
  // in Chile and would shift the whole week back.
  const dateIndex = argv.indexOf("--date");
  let reference = new Date();
  if (dateIndex !== -1) {
    const raw = argv[dateIndex + 1];
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw ?? "");
    if (!match) {
      throw new Error(`--date expects YYYY-MM-DD, got: ${raw}`);
    }
    reference = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const profile = profileIndex !== -1 ? argv[profileIndex + 1] : undefined;
  if (!profile) {
    throw new Error("--profile <slug> is required (which profile's brand and data to render).");
  }

  return {
    profile,
    // Both optional: city falls back to the input file's own `city` field,
    // and input falls back to the profile's default carousel input.
    city: cityIndex !== -1 ? argv[cityIndex + 1] : undefined,
    input: inputIndex !== -1 ? argv[inputIndex + 1] : undefined,
    reference,
    eventsPerSlide:
      eventsPerSlideIndex !== -1
        ? Number(argv[eventsPerSlideIndex + 1])
        : EVENTS_PER_SLIDE,
  };
}

async function main(): Promise<void> {
  const { profile, city: cityOverride, input, reference, eventsPerSlide } = parseArgs(
    process.argv.slice(2),
  );
  if (!Number.isInteger(eventsPerSlide) || eventsPerSlide < 1) {
    throw new Error(`--events-per-slide must be a positive integer, got: ${eventsPerSlide}`);
  }

  const profileDir = resolveProfileDir(profile);
  // Whatever the list-format template declares it reads, plus "dates": this
  // script builds the week label itself (weekLabel below), so that one is the
  // script's own requirement rather than the template's.
  const brand = loadBrand(profileDir, featuresOf([renderListFormat], "dates"));

  const inputPath = input ?? join(profileDir, "carousels", "week-input.json");
  const parsed = JSON.parse(readFileSync(inputPath, "utf-8")) as CarouselInput;
  const { slides } = parsed;
  if (slides.length === 0) {
    throw new Error(`${inputPath} has no slides to render.`);
  }
  // The city belongs to the content, not the brand — one brand can cover
  // several cities. --city overrides it for a one-off run.
  const city = cityOverride ?? parsed.city;
  const region = parsed.region;

  const baseDir = resolveOutputBaseDir(profileDir);
  const { label: headerLabel, monday, sunday } = weekLabel(reference, brand.dates!);
  const outputDir = join(
    baseDir,
    String(monday.getFullYear()),
    weekFolderName(monday, brand.dates!),
  );

  // Drop anything that would contradict the header before spending a render on
  // it: an event outside this week, or an image from a host the source doesn't
  // serve. Whatever survives still fills the carousel, so one bad item costs a
  // card rather than the whole run — but every drop is printed, because a slide
  // disappearing quietly is how a short carousel gets published unnoticed.
  //
  // `requireDates` is left at its default (on) rather than opted out of: this
  // script's whole output is stamped with a week — the header label, the output
  // folder — so every item it renders is, by construction, a claim about that
  // week. An input where nothing is dated makes that claim unverifiable, and
  // that is not a lesser version of passing; it is the state the shipped defect
  // was in. See the throw below.
  const kept = verifyOrThrow({
    slides,
    input: parsed,
    inputPath,
    profileDir,
    recipe: "weekly-roundup",
    period: { start: monday, end: sunday },
    label: headerLabel,
  });

  // "Magazine card" list-format mixes categories freely per slide (matching
  // the reference mockup, which shows several categories together under one
  // "this week" cover) — plain chunking, no per-category grouping. This
  // layout is also more spacious than the old design (bigger cards, more
  // air) — 3 cards no longer fit within the 1080x1350 canvas without
  // clipping the last one. 2 per slide is what actually fits cleanly.
  const groups = chunkSlides(kept, eventsPerSlide);
  await renderSlides({
    items: groups,
    toHtml: (group) => renderListFormat(brand, group, { headerLabel, city, region }),
    outputDir,
    manifest: true,
  });
}

main().catch((error) => {
  console.error("Week carousel render failed:", error);
  process.exitCode = 1;
});
