import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates one AI background image per brand-message slide via OpenAI's
 * gpt-image-1, saved to system/ig-carousel/backgrounds/slide-N.png so
 * `templates/brand-message.ts` can composite Adondepo's real type/logo on
 * top. Requires OPENAI_API_KEY in the environment (see `.env`, git-ignored).
 *
 * Each prompt is written for this specific slide's content — not a generic
 * "colorful background" — and reserves a safe zone (bottom third, or the
 * relevant half) for the text overlay so nothing critical gets covered.
 * Adondepo's brand palette is passed as art direction, not literal hex
 * instructions the model would render as flat color blocks.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "backgrounds");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY not set — see .env.example / copy from city-activities-api/.env");
}

const STYLE_DIRECTION =
  "Warm, hand-illustrated editorial poster style — gouache-and-ink texture, " +
  "visible brushwork, NOT flat vector, NOT corporate clip art, NOT 3D render. " +
  "Palette restricted to: deep petrol blue (#1a5f7a), warm terracotta " +
  "(#e05a47), gold (#f5b742), coral (#ff7a6b), cream paper white (#f8f6f3). " +
  "Portrait 4:5 composition, 1080x1350. Leave the bottom third of the frame " +
  "visually calm/uncluttered (soft gradient or open sky/wall) so white or " +
  "dark text can sit on top and stay legible — no text, letters, or numbers " +
  "in the image itself.";

const SLIDE_PROMPTS: string[] = [
  // 1 — hook: the problem (finding out about plans too late)
  `${STYLE_DIRECTION} Scene: a lone illustrated figure looking at a phone ` +
    `on a city street at dusk, other people in the background already ` +
    `walking toward a lit-up plaza with string lights and music notes in ` +
    `the air — the figure is a beat behind everyone else. Moody, wistful, ` +
    `slightly funny, not sad.`,
  // 2 — how it works: one map, everything on it
  `${STYLE_DIRECTION} Scene: an illustrated hand-drawn city map unrolled ` +
    `like a treasure map, with small illustrated icons scattered across it — ` +
    `a music note, a soccer ball, a theater mask, a picnic basket — each ` +
    `pinned with a small dot, connected by a dotted route line. Top two ` +
    `thirds busy with the map detail, bottom third fading to open cream space.`,
  // 3 — community: built together
  `${STYLE_DIRECTION} Scene: an illustrated overhead view of a small crowd ` +
    `of diverse people from above, each holding up or pointing to a small ` +
    `paper marker/flag as if contributing a pin to a shared map beneath them ` +
    `— collaborative, warm, plaza-like open space.`,
  // 4 — CTA: tag your plans partner
  `${STYLE_DIRECTION} Scene: two illustrated friends side by side looking ` +
    `at the same phone screen together, laughing, city lights and a route ` +
    `line motif glowing softly behind them like a shared path.`,
  // 5 — CTA: join the route
  `${STYLE_DIRECTION} Scene: a wide illustrated city skyline at golden hour ` +
    `with a single glowing dotted route line arcing across the sky like a ` +
    `shooting star trail, inviting and celebratory, open cream sky in the ` +
    `lower third for text.`,
];

async function generateImage(prompt: string, outPath: string): Promise<void> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size: "1024x1536",
      quality: "medium",
      n: 1,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI image generation failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as { data: Array<{ b64_json: string }> };
  const b64 = data.data[0]?.b64_json;
  if (!b64) {
    throw new Error("No image data returned from OpenAI.");
  }
  writeFileSync(outPath, Buffer.from(b64, "base64"));
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  for (const [index, prompt] of SLIDE_PROMPTS.entries()) {
    const outPath = join(OUT_DIR, `slide-${index + 1}.png`);
    console.log(`Generating background ${index + 1}/${SLIDE_PROMPTS.length}...`);
    await generateImage(prompt, outPath);
    console.log(`  -> ${outPath}`);
  }

  console.log("\nAll backgrounds generated.");
}

main().catch((error) => {
  console.error("Background generation failed:", error);
  process.exitCode = 1;
});
