/**
 * Draws the map SVG from OSM data.
 *
 * The colors come from the profile's brand tokens, so two profiles in the same
 * city still get maps that look like their own brand.
 */

import { color, type BrandTokens } from "../ig-carousel/brand-schema.js";
import { MAP_HEIGHT, MAP_WIDTH, project, type BBox } from "./geo.js";
import type { Landmark, OsmWay } from "./osm.js";

/** Label geometry. Sized for the reel's zoom level, not for full-map viewing. */
const LABEL_MARGIN = 60;
const LABEL_FONT_SIZE = 34;
const LABEL_HEIGHT = 46;

/**
 * How many landmarks the map draws, at most.
 *
 * OSM answers a multi-type query for a city with dozens of features, and
 * drawing all of them buries the map under overlapping text — the pin stops
 * being findable, which is the one job the map has. The prototype avoided this
 * by hand-picking ten places, which is exactly the per-city content this
 * engine must not carry, so the cap replaces the curation.
 *
 * Selection is by spread rather than by whatever order Overpass returned:
 * twelve labels clustered in one district orient nobody.
 */
const MAX_LANDMARKS = 12;

/** Minimum gap between two drawn landmarks, in map units. */
const MIN_LANDMARK_DISTANCE = 260;

type Point = { x: number; y: number };

/** Two endpoints closer than this, in map units, are treated as the same node. */
const JOIN_TOLERANCE = 2;

/**
 * Joins coastline ways into continuous chains by matching their endpoints.
 *
 * OSM splits a shore into ways wherever tagging changes, and consecutive ways
 * share an exact endpoint — that adjacency, not geography, is what says which
 * pieces belong together. Each chain grows from both ends, absorbing whichever
 * unused segment touches it (reversed if that is the end that matches), until
 * nothing else connects.
 *
 * The tolerance exists because projection rounds; endpoints that were equal in
 * lat/lon can land a fraction of a pixel apart.
 */
export function chainSegments(segments: Point[][]): Point[][] {
  const used = new Array<boolean>(segments.length).fill(false);
  const near = (a: Point, b: Point): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= JOIN_TOLERANCE;
  const chains: Point[][] = [];

  for (let i = 0; i < segments.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const chain = [...segments[i]!];

    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < segments.length; j += 1) {
        if (used[j]) continue;
        const candidate = segments[j]!;
        const head = chain[0]!;
        const tail = chain[chain.length - 1]!;
        const first = candidate[0]!;
        const last = candidate[candidate.length - 1]!;

        if (near(tail, first)) {
          chain.push(...candidate.slice(1));
        } else if (near(tail, last)) {
          chain.push(...[...candidate].reverse().slice(1));
        } else if (near(head, last)) {
          chain.unshift(...candidate.slice(0, -1));
        } else if (near(head, first)) {
          chain.unshift(...[...candidate].reverse().slice(0, -1));
        } else {
          continue;
        }
        used[j] = true;
        extended = true;
      }
    }

    chains.push(chain);
  }

  // Longest first: a stray fragment drawn over the main shore would otherwise
  // paint sea across land.
  return chains.sort((a, b) => b.length - a.length);
}

/**
 * Side of the sampling grid used to work out where the water is, in cells.
 *
 * Sized against the reel's zoom rather than the whole map: the composition
 * magnifies a corner of this SVG 2.4×, so a grid that looks smooth on the full
 * image reads as a staircase in the video.
 */
const SEA_GRID = 640;

/**
 * Marks which grid cells are water.
 *
 * Three approaches were tried before this one and each failed on a real map,
 * which is why the shape here is worth its bulk:
 *
 *   1. Closing the shore against the left edge assumes the sea lies west.
 *      True of one coastline, false of the next bay along.
 *   2. Offsetting the shore along its seaward normal into a band gets the
 *      direction right but self-intersects wherever the coast curves; no fill
 *      rule recovers the interior. It painted sea over a town centre.
 *   3. Closing the shore into a polygon at the canvas border. Fine on a
 *      continuous coast, wrong in a bay, where the shore's ends point back at
 *      each other and no border walk encloses only water.
 *
 * A polygon must answer "where does the shore close?", which has no stable
 * answer when the coast enters and leaves the frame repeatedly. Sampling asks
 * "is this cell water?", which the shore answers locally and reliably.
 *
 * The catch, and the reason for the flood fill: the nearest-segment normal is
 * only meaningful *near* the shore. Far inland it is decided by some distant
 * segment's direction and scatters blocks of sea across dry land. So the
 * normal is trusted only within a band around the coast, and everywhere else
 * is filled by flooding from whichever cells that band already settled.
 */
function seaMask(chains: Point[][]): boolean[] {
  const cellWidth = MAP_WIDTH / SEA_GRID;
  const cellHeight = MAP_HEIGHT / SEA_GRID;
  const index = (col: number, row: number): number => row * SEA_GRID + col;

  // UNKNOWN until decided; the band around the shore seeds the rest.
  const UNKNOWN = 0;
  const SEA = 1;
  const LAND = 2;
  const state = new Uint8Array(SEA_GRID * SEA_GRID);

  const near = Math.max(cellWidth, cellHeight) * 6;
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i += 1) {
      const a = chain[i - 1]!;
      const b = chain[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (Math.min(cellWidth, cellHeight) / 2)));
      for (let step = 0; step <= steps; step += 1) {
        const px = a.x + (dx * step) / steps;
        const py = a.y + (dy * step) / steps;
        // Mark cells on both sides of this segment, out to the band's width.
        for (let ox = -near; ox <= near; ox += Math.min(cellWidth, cellHeight)) {
          for (let oy = -near; oy <= near; oy += Math.min(cellWidth, cellHeight)) {
            const col = Math.floor((px + ox) / cellWidth);
            const row = Math.floor((py + oy) / cellHeight);
            if (col < 0 || col >= SEA_GRID || row < 0 || row >= SEA_GRID) continue;
            const cx = (col + 0.5) * cellWidth;
            const cy = (row + 0.5) * cellHeight;
            // Right-hand side of this segment is water.
            const side = dx * (cy - a.y) - dy * (cx - a.x);
            const slot = index(col, row);
            if (state[slot] === UNKNOWN) state[slot] = side > 0 ? SEA : LAND;
          }
        }
      }
    }
  }

  // Flood the undecided cells from their settled neighbours, so open water far
  // from any shore stays water and the interior stays land.
  const queue: number[] = [];
  for (let i = 0; i < state.length; i += 1) {
    if (state[i] !== UNKNOWN) queue.push(i);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const slot = queue[head]!;
    const col = slot % SEA_GRID;
    const row = (slot - col) / SEA_GRID;
    const value = state[slot]!;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nc >= SEA_GRID || nr < 0 || nr >= SEA_GRID) continue;
      const neighbour = index(nc, nr);
      if (state[neighbour] === UNKNOWN) {
        state[neighbour] = value;
        queue.push(neighbour);
      }
    }
  }

  const mask = new Array<boolean>(state.length);
  for (let i = 0; i < state.length; i += 1) mask[i] = state[i] === SEA;
  return mask;
}

/** Turns the sea mask into merged rects, plus a smoothing stroke on the shore. */
function seaShapes(chains: Point[][], water: string): string {
  const mask = seaMask(chains);
  const cellWidth = MAP_WIDTH / SEA_GRID;
  const cellHeight = MAP_HEIGHT / SEA_GRID;
  const rects: string[] = [];

  for (let row = 0; row < SEA_GRID; row += 1) {
    // Runs of adjacent sea cells merge into one rect, keeping the SVG to a few
    // thousand elements rather than four hundred thousand.
    let runStart: number | undefined;
    for (let col = 0; col <= SEA_GRID; col += 1) {
      const wet = col < SEA_GRID && mask[row * SEA_GRID + col] === true;
      if (wet && runStart === undefined) {
        runStart = col;
      } else if (!wet && runStart !== undefined) {
        rects.push(
          `<rect x="${(runStart * cellWidth).toFixed(1)}" y="${(row * cellHeight).toFixed(1)}" ` +
            `width="${((col - runStart) * cellWidth).toFixed(1)}" height="${(cellHeight + 0.6).toFixed(1)}"/>`,
        );
        runStart = undefined;
      }
    }
  }

  // The cell edges are steps, and the reel magnifies them. Stroking the real
  // shoreline over them in the same color hides the staircase behind the true
  // geometry.
  const strokeWidth = Math.hypot(cellWidth, cellHeight) * 1.1;
  const strokes = chains
    .map(
      (chain) =>
        `<path d="${path(chain)}" fill="none" stroke="${water}" stroke-width="${strokeWidth.toFixed(1)}" stroke-linejoin="round" stroke-linecap="round"/>`,
    )
    .join("");

  return `<g fill="${water}" shape-rendering="crispEdges">${rects.join("")}</g>${strokes}`;
}

function path(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[char]!;
  });
}

export interface MapSvgResult {
  svg: string;
  /** How many landmarks actually made it onto the map. */
  landmarksDrawn: number;
}

export function buildMapSvg(
  bbox: BBox,
  coastline: OsmWay[],
  roads: OsmWay[],
  landmarks: Landmark[],
  brand: BrandTokens,
): MapSvgResult {
  // Water takes the wordmark role, not the accent one. The accent is the pin's
  // color, and a sea painted in it makes the whole frame read as one flat mass
  // with the marker lost inside it — the pin has to be the only thing on the
  // map wearing that color.
  const land = color(brand, "surface");
  const water = color(brand, "wordmark");
  const ink = color(brand, "onSurfaceMuted");

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}">`,
    `<rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" fill="${land}"/>`,
  ];

  // The coastline arrives as disconnected ways in arbitrary order, so they
  // have to be joined before the sea can be filled as one shape.
  //
  // They are chained by *matching endpoints*, not sorted by latitude: OSM
  // splits the shore where tagging changes, and consecutive ways share an
  // exact endpoint. Sorting by northmost point happens to work for a shore
  // that runs cleanly north-to-south and produces a torn, zigzagging coast
  // anywhere else — a bay, a peninsula, or any shore the bbox cuts across.
  // Overpass returns whole ways, not the part inside the box, so about a
  // quarter of the points project outside the canvas. They are kept as-is and
  // left for the SVG to clip: clamping them onto the border was tried first
  // and made things worse, piling dozens of points onto the same edge, which
  // flattened the shore's direction there and broke the sea fill that depends
  // on it.
  const segments = coastline
    .map((way) => (way.geometry ?? []).map((point) => project(bbox, point.lat, point.lon)))
    .filter((segment) => segment.length >= 2);

  const chains = chainSegments(segments);

  // Filling the sea means closing each open shore into a polygon, and *which
  // way* to close it is the whole problem: closing against the left edge
  // assumes the sea lies west, which is true of one coastline and false of the
  // next bay along. Guessing from the geometry is no better — a bbox that cuts
  // across a peninsula has water on both sides.
  //
  // OSM settles it by convention instead: a `natural=coastline` way is drawn
  // with **land on the left and sea on the right** of its direction. So the
  // sea side is found by walking the shore and closing the polygon around the
  // canvas corners that lie on the right-hand side. That holds for any shore
  // in any hemisphere, which is what this engine needs.
  // The sea is filled per chain, as a polygon closed on the water side.
  //
  // A grid-sampling version of this shipped briefly and had to be pulled: the
  // nearest-segment test it relied on is trustworthy near the shore and
  // meaningless far from it, where the normal of some distant segment decides
  // the answer. On a straight coast that scattered blocks of sea across the
  // land several kilometres inland. Sampling also renders as steps, which the
  // composition's 2.4× zoom turns into a staircase.
  //
  // The polygon needs the sea side named once per chain rather than per point,
  // and `seaSideOf` answers that from the shore's own overall direction —
  // which is what OSM's land-on-the-left convention actually guarantees.
  if (chains.length > 0) {
    parts.push(seaShapes(chains, water));
  }

  // Drawn thinnest first so the bigger roads sit on top at intersections.
  const byClass: Record<string, string[]> = { secondary: [], primary: [], trunk: [], motorway: [] };
  for (const way of roads) {
    const geometry = way.geometry ?? [];
    const highway = way.tags?.highway;
    if (geometry.length >= 2 && highway && highway in byClass) {
      byClass[highway]!.push(path(geometry.map((point) => project(bbox, point.lat, point.lon))));
    }
  }
  const roadStyles: [string, number, number][] = [
    ["secondary", 3, 0.55],
    ["primary", 5, 0.7],
    ["trunk", 7, 0.85],
    ["motorway", 7, 0.85],
  ];
  for (const [className, width, opacity] of roadStyles) {
    for (const d of byClass[className] ?? []) {
      parts.push(`<path d="${d}" fill="none" stroke="${ink}" stroke-width="${width}" opacity="${opacity}"/>`);
    }
  }

  // Project once, drop anything outside the drawable area, and prefer shorter
  // names: at this zoom a long official name overruns the frame, and the short
  // form is what people navigate by anyway.
  const candidates = landmarks
    .map((landmark) => ({ ...landmark, ...project(bbox, landmark.lat, landmark.lon) }))
    .filter(
      ({ x, y }) =>
        x > LABEL_MARGIN && x < MAP_WIDTH - LABEL_MARGIN && y > LABEL_MARGIN && y < MAP_HEIGHT - LABEL_MARGIN,
    )
    .sort((a, b) => a.name.length - b.name.length);

  // Farthest-point selection: take a candidate only when it is far enough from
  // everything already taken, so the labels spread across the map instead of
  // stacking wherever OSM happens to be dense.
  const chosen: typeof candidates = [];
  for (const candidate of candidates) {
    if (chosen.length >= MAX_LANDMARKS) break;
    const tooClose = chosen.some(
      (other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) < MIN_LANDMARK_DISTANCE,
    );
    if (!tooClose) chosen.push(candidate);
  }

  // Landmark labels carry a halo in the land color (paint-order: stroke) so
  // they stay legible over both land and water without needing a box.
  // Collision is checked against the box the label is actually *drawn* in, not
  // against its anchor point. Comparing anchors was the bug that let two names
  // print on top of each other: the text is offset from its dot and anchored
  // to one side, so a box centred on the dot is not the box on screen.
  interface PlacedLabel {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }
  const placed: PlacedLabel[] = [];
  const overlaps = (a: PlacedLabel, b: PlacedLabel): boolean =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  let landmarksDrawn = 0;
  for (const landmark of chosen) {
    const { x, y } = landmark;

    // Width estimated from the name's length: at one fixed threshold a short
    // name and a long one collide differently, and it is the long one that
    // overruns.
    const width = landmark.name.length * LABEL_FONT_SIZE * 0.58;
    // A landmark far east would push its label off the edge, so it anchors on
    // the other side instead.
    const anchor = x > MAP_WIDTH * 0.72 ? "end" : "start";
    const dx = anchor === "end" ? -24 : 24;
    const textX = x + dx;

    let labelY = y;
    let box: PlacedLabel | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate: PlacedLabel = {
        left: (anchor === "end" ? textX - width : textX) - 12,
        right: (anchor === "end" ? textX : textX + width) + 12,
        top: labelY - LABEL_HEIGHT / 2,
        bottom: labelY + LABEL_HEIGHT / 2,
      };
      if (!placed.some((other) => overlaps(candidate, other))) {
        box = candidate;
        break;
      }
      labelY += LABEL_HEIGHT;
    }
    // Still overlapping after eight nudges means this part of the map is full.
    // Dropping the label beats stacking unreadable text over the frame the pin
    // has to be found in.
    if (!box) continue;

    placed.push(box);
    landmarksDrawn += 1;

    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="${ink}" opacity="0.9"/>`,
      `<text x="${textX.toFixed(1)}" y="${(labelY + 11).toFixed(1)}" text-anchor="${anchor}" ` +
        `font-family="${escapeXml(brand.fonts.body)}, sans-serif" font-size="${LABEL_FONT_SIZE}" ` +
        `font-weight="600" fill="${ink}" stroke="${land}" stroke-width="7" ` +
        `paint-order="stroke" opacity="0.95">${escapeXml(landmark.name)}</text>`,
    );
  }

  parts.push("</svg>");
  return { svg: parts.join("\n"), landmarksDrawn };
}
