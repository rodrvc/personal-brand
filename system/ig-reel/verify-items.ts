/**
 * The pre-render guard for reel items.
 *
 * Mirrors the carousel's `verify-slides.ts` in structure and in severity
 * policy, because the failure it prevents is the same one: a reel was rendered
 * with items from a different week, and both facts existed in prose that
 * nobody crossed. The difference here is that a reel item also carries a
 * coordinate, so "is this item renderable" additionally means "does its pin
 * land inside the declared map".
 *
 * `verifyOrThrow` is the only place that mints `VerifiedReelItem`, and the
 * render entry point accepts nothing else.
 */

import { isInsideBBox, type BBox } from "./geo.js";
import type { ReelInput, ReelItem, VerifiedReelItem } from "./types.js";

export interface Period {
  /** Inclusive, `YYYY-MM-DD`. */
  start: string;
  end: string;
}

/**
 * Parses `YYYY-MM-DD` as a *local* date.
 *
 * `new Date("2026-08-17")` is parsed as UTC and lands on the 16th in any
 * negative offset, which silently drops the first item of every week. The
 * month check catches `2026-02-31` rolling over into March rather than
 * accepting it as a date.
 */
function parseDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

/** Why an item cannot be rendered, or `undefined` if it can. */
function rejectionReason(
  item: ReelItem,
  period: Period | undefined,
  allowedHosts: string[] | undefined,
  bbox: BBox,
): string | undefined {
  if (period) {
    const date = parseDate(item.date ?? "");
    if (!date) {
      return `date ${JSON.stringify(item.date)} is not a valid YYYY-MM-DD`;
    }
    const start = parseDate(period.start)!;
    const end = parseDate(period.end)!;
    if (date < start || date > end) {
      return `date ${item.date} falls outside the period ${period.start}..${period.end}`;
    }
  }

  if (typeof item.lat !== "number" || typeof item.lng !== "number" || !Number.isFinite(item.lat) || !Number.isFinite(item.lng)) {
    return `has no usable coordinate (lat=${String(item.lat)}, lng=${String(item.lng)})`;
  }
  if (!isInsideBBox(bbox, item.lat, item.lng)) {
    return `coordinate (${item.lat}, ${item.lng}) falls outside map.bbox`;
  }

  // The host check applies to remote images only. A local path under the
  // profile has no host to check, and it is not an unverified origin either:
  // it is a file the profile owner put there, already inside the trust
  // boundary the allowlist exists to draw around *fetched* URLs.
  if (allowedHosts && item.image && /^[a-z][\w+.-]*:\/\//i.test(item.image)) {
    const host = hostOf(item.image);
    if (!host) {
      return `image is not a valid URL: ${JSON.stringify(item.image)}`;
    }
    if (!allowedHosts.some((allowed) => allowed.toLowerCase().replace(/\.$/, "") === host)) {
      return `image host ${host} is not among the declared source image hosts`;
    }
  }

  return undefined;
}

export interface VerifyOptions {
  input: ReelInput;
  inputPath: string;
  bbox: BBox;
  period?: Period;
}

/**
 * Verifies every item and returns the ones that can be rendered.
 *
 * Severity policy, centralised here so it cannot drift between callers:
 *
 *   - Nothing verifiable at all (a period was given but no item carries a
 *     usable date) → throw. "Everything passed" and "nothing was checked" must
 *     not read the same; 0-of-N dated items is the exact state the original
 *     defect shipped in.
 *   - A single bad item → dropped, with its reason printed.
 *   - Nothing left → throw, naming what was asked for. Never render empty.
 */
export function verifyOrThrow({ input, inputPath, bbox, period }: VerifyOptions): VerifiedReelItem[] {
  const items = input.items ?? [];
  if (items.length === 0) {
    throw new Error(`${inputPath} declares no items.`);
  }

  const hosts = input.sourceImageHosts;
  if (hosts !== undefined) {
    if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((h) => typeof h !== "string" || !h)) {
      throw new Error(
        `${inputPath}: "sourceImageHosts" must be a non-empty array of host strings. ` +
          `An empty array reads as an active check that permits nothing — to allow any host, omit the key.`,
      );
    }
    if (hosts.some((host) => /[*]/.test(host))) {
      throw new Error(
        `${inputPath}: "sourceImageHosts" takes literal hosts, not wildcards. ` +
          `A wildcard would leave the file looking like the check is on while permitting everything. ` +
          `To allow any host, omit the key.`,
      );
    }
  }

  if (period && !items.some((item) => parseDate(item.date ?? ""))) {
    throw new Error(
      `Cannot verify that these items belong to ${period.start}..${period.end}: not one of the ` +
        `${items.length} items in ${inputPath} carries a valid "date". Rendering would claim a period ` +
        `nothing was checked against.`,
    );
  }

  const kept: ReelItem[] = [];
  for (const item of items) {
    const reason = rejectionReason(item, period, hosts, bbox);
    if (reason) {
      console.warn(`  dropped ${JSON.stringify(item.title)}: ${reason}`);
    } else {
      kept.push(item);
    }
  }

  if (kept.length === 0) {
    throw new Error(
      `No item in ${inputPath} survived verification` +
        (period ? ` for the period ${period.start}..${period.end}` : "") +
        `. Nothing was rendered.`,
    );
  }

  return kept as VerifiedReelItem[];
}
