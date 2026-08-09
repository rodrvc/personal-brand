/**
 * Builds the HyperFrames composition for a reel.
 *
 * Every color, font, and string is read from brand tokens or the input. The
 * structure, the timing and the motion are the engine's, and a profile cannot
 * reach them — see `system/recipes/reel-week.md` stage 7.
 *
 * Design decisions that are not obvious, kept from the prototype this ports:
 *
 *   - The map layer must cover the canvas for any coordinate in the bbox.
 *     `geo.placeItem` asserts it per item.
 *   - The pin travels *inside* the element that scales, anchored to the same
 *     `transform-origin`, with a `1/zoom` counter-scale so it keeps its size.
 *     Pinned to the canvas centre instead, the zoom walks it off its street.
 *   - Maps and items live on separate tracks. HyperFrames rejects overlapping
 *     clips on one track, and the cross-fade needs the overlap.
 *   - The scene fill is a full-bleed child, never the root's own background:
 *     the producer's frame compositing can drop a root background and render
 *     the frame black while preview looks correct.
 */

import {
  categoryStyle,
  color,
  interpolate,
  templateCopy,
  withAlpha,
  type BrandTokens,
} from "../ig-carousel/brand-schema.js";
import type { ItemPlacement } from "./types.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH, MAP_ZOOM, TIMING, type VerifiedReelItem } from "./types.js";

export interface CompositionOptions {
  brand: BrandTokens;
  city: string;
  items: VerifiedReelItem[];
  placements: ItemPlacement[];
  /** Path of the generated map SVG, relative to the composition. */
  mapSrc: string;
  /** Item image paths, relative to the composition, in item order. */
  imageSrcs: string[];
  /** Font file to embed for the logo face, relative to the composition. */
  logoFontSrc?: string;
}

interface SceneTimes {
  map: number;
  item: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => {
    const entities: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" };
    return entities[char]!;
  });
}

/** Rounds to 2dp so the emitted times stay readable and stable. */
function t(seconds: number): number {
  return Number(seconds.toFixed(2));
}

function sceneTimes(count: number): { scenes: SceneTimes[]; closing: number; total: number } {
  const scenes: SceneTimes[] = [];
  let cursor = TIMING.cover;
  for (let i = 0; i < count; i += 1) {
    scenes.push({ map: t(cursor), item: t(cursor + TIMING.map) });
    cursor += TIMING.map + TIMING.item;
  }
  return { scenes, closing: t(cursor), total: t(cursor + TIMING.closing) };
}

export function buildComposition(options: CompositionOptions): string {
  const { brand, city, items, placements, mapSrc, imageSrcs, logoFontSrc } = options;
  const copy = templateCopy(brand, "reel");
  const { scenes, closing, total } = sceneTimes(items.length);

  const accent = color(brand, "accent");
  const surface = color(brand, "surface");
  const onSurface = color(brand, "onSurface");
  const onSurfaceMuted = color(brand, "onSurfaceMuted");
  const wordmarkColor = color(brand, "wordmark");
  const coverGradient = brand.gradients!.cover!;

  const vars = { city, count: String(items.length) };
  const logoFamily = logoFontSrc ? "ReelLogo" : brand.fonts.logo;

  const fontFace = logoFontSrc
    ? `@font-face { font-family: "ReelLogo"; font-style: normal; font-weight: 400; src: url("${logoFontSrc}") format("woff2"); }`
    : "";

  const styles = `
      ${fontFace}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${CANVAS_WIDTH}px; height: ${CANVAS_HEIGHT}px; overflow: hidden; }
      body { font-family: ${brand.fonts.body}, sans-serif; }

      /* The fill goes on a full-bleed child, never on the root. */
      .fondo { position: absolute; inset: 0; background: ${surface}; }
      .escena { position: absolute; inset: 0; width: ${CANVAS_WIDTH}px; height: ${CANVAS_HEIGHT}px; }

      /* ---------- cover ---------- */
      /* Taller than the canvas so it can drift: a cover that finishes its
         entrances and then sits still reads as a frozen video. */
      .portada-fill {
        position: absolute; left: 0; top: -260px;
        width: ${CANVAS_WIDTH}px; height: ${CANVAS_HEIGHT + 520}px;
        background: ${coverGradient};
      }
      .p-orbe { position: absolute; display: block; border-radius: 50%; filter: blur(70px); }
      .p-orbe-a { width: 620px; height: 620px; left: -160px; top: 250px; background: ${withAlpha(color(brand, "highlight"), 0.5)}; }
      .p-orbe-b { width: 520px; height: 520px; right: -140px; top: 1180px; background: ${withAlpha(accent, 0.45)}; }
      .portada-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
      /* A script face usually ships in one weight and clips its tails at a
         tight line-height, so this stays generous and never asks for 900. */
      .p-titulo {
        display: block; font-family: "${logoFamily}", cursive; font-size: 150px; font-weight: 400;
        line-height: 1.24; padding-bottom: 12px; color: #fff; text-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
      }
      .p-sub { display: block; margin-top: 8px; font-size: 80px; font-weight: 900; color: #fff; text-shadow: 0 3px 14px rgba(0, 0, 0, 0.32); }
      .p-barra { display: block; width: 300px; height: 14px; margin: 52px 0 44px 0; border-radius: 7px; background: #fff; }
      .p-conteo { display: block; font-size: 50px; font-weight: 700; color: #fff; text-shadow: 0 3px 12px rgba(0, 0, 0, 0.3); }
      .p-word {
        position: absolute; left: 0; right: 0; bottom: 150px; text-align: center;
        font-family: "${logoFamily}", cursive; font-size: 56px; font-weight: 400; line-height: 1.3;
        color: #fff; text-shadow: 0 3px 12px rgba(0, 0, 0, 0.32);
      }

      /* ---------- item cards ---------- */
      .afiche-zona { position: absolute; top: 0; left: 0; width: ${CANVAS_WIDTH}px; height: 1290px; overflow: hidden; }
      .afiche { display: block; width: ${CANVAS_WIDTH}px; height: 1290px; object-fit: cover; object-position: center 42%; transform-origin: center center; }
      .afiche-fade { position: absolute; left: 0; bottom: 0; width: ${CANVAS_WIDTH}px; height: 260px; background: linear-gradient(180deg, ${withAlpha(surface, 0)}, ${surface}); }
      .chip { position: absolute; top: 62px; left: 56px; display: block; padding: 14px 28px; border-radius: 22px; color: #fff; font-size: 34px; font-weight: 900; letter-spacing: 0.04em; }
      .banda { position: absolute; top: 1290px; left: 0; width: ${CANVAS_WIDTH}px; height: 630px; padding: 46px 56px 0 56px; }
      .nombre { display: block; max-width: 920px; font-size: 54px; font-weight: 900; line-height: 1.16; color: ${onSurface}; }
      .barra { display: block; width: 120px; height: 10px; margin: 24px 0 30px 0; border-radius: 5px; background: ${accent}; }
      .cuando { display: block; font-size: 40px; font-weight: 700; color: ${accent}; }
      .donde { display: block; margin-top: 12px; font-size: 34px; font-weight: 600; color: ${onSurfaceMuted}; }
      .wordmark { position: absolute; right: 56px; bottom: 44px; display: block; font-size: 38px; font-weight: 900; color: ${wordmarkColor}; }

      /* ---------- map transition ---------- */
      .mapa-zona { position: absolute; inset: 0; overflow: hidden; background: ${surface}; }
      .mapa-img-inner { display: block; width: 100%; height: 100%; }
      /* left/top/size/transform-origin are set per item, from its coordinate. */
      .mapa-escala { position: absolute; }
      .pin-wrap { position: absolute; width: 0; height: 0; }
      /* Counter-scale: the pin keeps its real size while the map grows. */
      .pin-contra { position: absolute; width: 0; height: 0; transform-origin: center bottom; }
      .pin { position: absolute; left: -102px; top: -270px; width: 205px; height: 270px; filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.35)); }
      .pin-pulso { position: absolute; left: -215px; top: -215px; width: 430px; height: 430px; border-radius: 50%; border: 22px solid ${withAlpha(accent, 0.75)}; }
      /* The item's own label sits on a solid plate rather than relying on a
         text-shadow. It has to stay readable over whatever the generated map
         puts behind it, and a landmark name landing in the same band was
         enough to make both unreadable — a halo does not survive text on
         text. The plate is the profile's surface color, so it reads as part
         of the map rather than as a sticker. */
      .mapa-rotulo {
        position: absolute; left: 50%; bottom: 260px; transform: translateX(-50%);
        max-width: 900px; padding: 14px 34px 18px 34px; border-radius: 18px;
        background: ${withAlpha(surface, 0.92)};
        text-align: center; font-size: 52px; font-weight: 900; color: ${onSurface};
      }
      /* Required by the ODbL terms the map data is used under. */
      .mapa-credito { position: absolute; right: 24px; bottom: 24px; font-size: 20px; font-weight: 600; color: ${withAlpha(onSurface, 0.55)}; }

      /* ---------- closing ---------- */
      .cierre-fill { position: absolute; inset: 0; background: ${coverGradient}; }
      .cierre-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
      .c-word { display: block; font-family: "${logoFamily}", cursive; font-size: 124px; font-weight: 400; line-height: 1.26; padding-bottom: 10px; color: #fff; text-shadow: 0 4px 18px rgba(0, 0, 0, 0.35); }
      .c-cta { display: block; margin-top: 18px; font-size: 46px; font-weight: 700; color: #fff; text-shadow: 0 3px 12px rgba(0, 0, 0, 0.32); }
      .c-site { display: block; margin-top: 44px; padding: 30px 70px 38px 70px; border-radius: 54px; background: #fff; color: ${accent}; font-family: "${logoFamily}", cursive; font-size: 62px; font-weight: 400; line-height: 1.2; }`;

  const scenesMarkup = items
    .map((item, index) => {
      const id = `i${index + 1}`;
      const place = placements[index]!;
      const times = scenes[index]!;
      const style = categoryStyle(brand, item.category);
      return `
      <!-- ===== map ${id} ===== -->
      <div id="s-mapa-${id}" class="clip escena" data-start="${times.map}" data-duration="${t(TIMING.map + TIMING.overlap)}" data-track-index="1">
        <div class="mapa-zona">
          <div id="mapa-esc-${id}" class="mapa-escala"
               style="left: ${place.left}px; top: ${place.top}px; width: ${place.width}px; height: ${place.height}px; transform-origin: ${place.pctX}% ${place.pctY}%;"
               data-layout-allow-overflow>
            <img class="mapa-img-inner" src="${escapeHtml(mapSrc)}" alt="" />
            <div class="pin-wrap" style="left: ${place.pctX}%; top: ${place.pctY}%;">
              <div id="pinc-${id}" class="pin-contra">
                <span id="pulso-${id}" class="pin-pulso"></span>
                <svg id="pin-${id}" class="pin" viewBox="0 0 52 68">
                  <path d="M26 0C11.6 0 0 11.6 0 26c0 19.5 26 42 26 42s26-22.5 26-42C52 11.6 40.4 0 26 0z" fill="${accent}" />
                  <circle cx="26" cy="25" r="10" fill="#fff" />
                </svg>
              </div>
            </div>
          </div>
          <span id="rot-${id}" class="mapa-rotulo">${escapeHtml(item.mapLabel)}</span>
          <span class="mapa-credito">© OpenStreetMap</span>
        </div>
      </div>

      <!-- ===== item ${id} ===== -->
      <div id="s-${id}" class="clip escena" data-start="${times.item}" data-duration="${t(TIMING.item + TIMING.overlap)}" data-track-index="2">
        <div class="afiche-zona">
          <img id="${id}-img" class="afiche" src="${escapeHtml(imageSrcs[index]!)}" alt="" data-layout-allow-overflow />
          <div class="afiche-fade"></div>
          <span id="${id}-chip" class="chip" style="background: ${style.gradient ?? style.solid};">${escapeHtml((item.category ?? "").toUpperCase())}</span>
        </div>
        <div class="banda">
          <span id="${id}-nombre" class="nombre">${escapeHtml(item.title)}</span>
          <span id="${id}-barra" class="barra"></span>
          <span id="${id}-cuando" class="cuando">${escapeHtml(item.when)}</span>
          <span id="${id}-donde" class="donde">${escapeHtml(item.where)}</span>
          <span id="${id}-word" class="wordmark">${escapeHtml(brand.copy.wordmark)}</span>
        </div>
      </div>`;
    })
    .join("\n");

  const timeline = items
    .map((_, index) => {
      const id = `i${index + 1}`;
      const { map: tm, item: te } = scenes[index]!;
      const counter = (1 / MAP_ZOOM).toFixed(4);
      // Ken Burns alternates direction so consecutive cards do not drift the
      // same way, which reads as one long push instead of separate scenes.
      const [from, to] = index % 2 === 0 ? [1, 1.16] : [1.16, 1];
      const end = t(te + TIMING.item);
      return `
      // --- map ${id} (${tm}s) ---
      tl.fromTo("#mapa-esc-${id}", { scale: 1 }, { scale: ${MAP_ZOOM}, duration: ${TIMING.map}, ease: "power2.inOut" }, ${tm});
      tl.fromTo("#pinc-${id}", { scale: ${counter} }, { scale: ${counter}, duration: ${TIMING.map}, ease: "none" }, ${tm});
      tl.set("#pin-${id}", { autoAlpha: 0 }, ${tm});
      tl.set("#pulso-${id}", { autoAlpha: 0 }, ${tm});
      tl.fromTo("#pin-${id}", { autoAlpha: 0, y: -220, scale: 0.7 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(2.2)" }, ${t(tm + 1.0)});
      tl.fromTo("#pulso-${id}", { autoAlpha: 0.8, scale: 0.25 }, { autoAlpha: 0, scale: 1.5, duration: 0.7, ease: "power2.out" }, ${t(tm + 1.2)});
      tl.fromTo("#rot-${id}", { autoAlpha: 0, y: 22 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: "power2.out" }, ${t(tm + 1.25)});
      // cross-fade: the map leaves while the card arrives
      tl.to("#s-mapa-${id}", { autoAlpha: 0, duration: ${TIMING.overlap}, ease: "power1.inOut" }, ${te});
      tl.set("#pulso-${id}", { autoAlpha: 0 }, ${t(te + TIMING.overlap - 0.05)});

      // --- item ${id} (${te}s) ---
      tl.fromTo("#s-${id}", { autoAlpha: 0 }, { autoAlpha: 1, duration: ${TIMING.overlap}, ease: "power1.inOut" }, ${te});
      tl.fromTo("#${id}-img", { scale: ${from} }, { scale: ${to}, duration: ${TIMING.item}, ease: "none" }, ${te});
      tl.fromTo("#${id}-chip", { autoAlpha: 0, y: -20 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: "power2.out" }, ${t(te + 0.2)});
      tl.fromTo("#${id}-nombre", { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.55, ease: "power3.out" }, ${t(te + 0.32)});
      tl.fromTo("#${id}-barra", { autoAlpha: 0, scaleX: 0 }, { autoAlpha: 1, scaleX: 1, duration: 0.45, ease: "power2.out", transformOrigin: "left center" }, ${t(te + 0.52)});
      tl.fromTo("#${id}-cuando", { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: "power2.out" }, ${t(te + 0.64)});
      tl.fromTo("#${id}-donde", { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: "power2.out" }, ${t(te + 0.74)});
      tl.fromTo("#${id}-word", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4, ease: "power1.out" }, ${t(te + 0.9)});
      tl.to("#s-${id}", { autoAlpha: 0, duration: ${TIMING.overlap}, ease: "power1.inOut" }, ${end});`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${brand.locale ?? "en"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${CANVAS_WIDTH}, height=${CANVAS_HEIGHT}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>${styles}
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${total}"
      data-width="${CANVAS_WIDTH}"
      data-height="${CANVAS_HEIGHT}"
      style="position: relative; width: ${CANVAS_WIDTH}px; height: ${CANVAS_HEIGHT}px"
    >
      <div class="fondo"></div>

      <!-- ===== cover ===== -->
      <div id="s-portada" class="clip escena" data-start="0" data-duration="${TIMING.cover}" data-track-index="1">
        <div id="p-fill" class="portada-fill"></div>
        <span id="p-orbe-a" class="p-orbe p-orbe-a"></span>
        <span id="p-orbe-b" class="p-orbe p-orbe-b"></span>
        <div class="portada-wrap">
          <span id="p-titulo" class="p-titulo">${escapeHtml(interpolate(copy.coverTitle, vars))}</span>
          <span id="p-sub" class="p-sub">${escapeHtml(interpolate(copy.coverSubtitle, vars))}</span>
          <span id="p-barra" class="p-barra"></span>
          <span id="p-conteo" class="p-conteo">${escapeHtml(interpolate(copy.coverCount, vars))}</span>
        </div>
        <span id="p-word" class="p-word">${escapeHtml(brand.copy.wordmark)}</span>
      </div>
${scenesMarkup}

      <!-- ===== closing ===== -->
      <div id="s-cierre" class="clip escena" data-start="${closing}" data-duration="${TIMING.closing}" data-track-index="1">
        <div class="cierre-fill"></div>
        <div class="cierre-wrap">
          <span id="c-word" class="c-word">${escapeHtml(brand.copy.wordmark)}</span>
          <span id="c-cta" class="c-cta">${escapeHtml(interpolate(copy.closingCta, vars))}</span>
          <span id="c-site" class="c-site">${escapeHtml(brand.copy.site)}</span>
        </div>
      </div>
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });

      // ---- cover ----
      // Continuous motion for the full duration: entrances that finish early
      // leave the cover frozen, which reads as a stalled video.
      tl.fromTo("#p-fill", { y: 0 }, { y: -230, duration: ${TIMING.cover}, ease: "none" }, 0);
      tl.fromTo("#p-orbe-a", { x: 0, y: 0 }, { x: 90, y: -120, duration: ${TIMING.cover}, ease: "sine.inOut" }, 0);
      tl.fromTo("#p-orbe-b", { x: 0, y: 0 }, { x: -80, y: -150, duration: ${TIMING.cover}, ease: "sine.inOut" }, 0);

      tl.fromTo("#p-titulo", { autoAlpha: 0, y: 40, scale: 0.94 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.8, ease: "back.out(1.4)" }, 0.1);
      tl.fromTo("#p-sub", { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.6, ease: "power3.out" }, 0.32);
      tl.fromTo("#p-barra", { autoAlpha: 0, scaleX: 0 }, { autoAlpha: 1, scaleX: 1, duration: 0.5, ease: "power2.out", transformOrigin: "center center" }, 0.55);
      tl.fromTo("#p-conteo", { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.75);
      tl.fromTo("#p-word", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5, ease: "power1.out" }, 0.95);

      // slow drift so the text block never fully settles
      tl.fromTo("#p-titulo", { x: 0 }, { x: 14, duration: 1.3, ease: "sine.inOut" }, 0.9);
      tl.fromTo("#p-sub", { x: 0 }, { x: 10, duration: 1.3, ease: "sine.inOut" }, 0.95);
      tl.fromTo("#p-conteo", { x: 0 }, { x: 8, duration: 1.2, ease: "sine.inOut" }, 1.0);
      // starts at 1.06 — exactly when its entrance tween ends — so the two
      // scaleX tweens never overlap on the same property.
      tl.fromTo("#p-barra", { scaleX: 1 }, { scaleX: 1.35, duration: 1.1, ease: "sine.inOut", transformOrigin: "center center" }, 1.06);

      // ---- maps + items ----
${timeline}

      // ---- closing ----
      tl.fromTo("#c-word", { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.6, ease: "back.out(1.6)" }, ${t(closing + 0.1)});
      tl.fromTo("#c-cta", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4, ease: "power1.out" }, ${t(closing + 0.4)});
      tl.fromTo("#c-site", { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${t(closing + 0.6)});
      tl.fromTo("#c-site", { scale: 1 }, { scale: 1.05, duration: 1.0, ease: "sine.inOut" }, ${t(closing + 1.0)});

      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

/** Features this engine reads from a profile's brand.json. */
buildComposition.features = ["categories", "reel"] as const;
