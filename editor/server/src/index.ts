import express from "express";

import { loadRepoRootEnv } from "./env.js";

loadRepoRootEnv();

import { checkChromiumAvailable, closeSharedBrowser } from "./browser.js";
import { listProfiles } from "./profile-store.js";
import { profilesRouter } from "./routes/profiles.js";
import { assetsRouter } from "./routes/assets.js";
import { renderRouter } from "./routes/render.js";
import { composeRouter } from "./routes/compose.js";
import { exportRouter } from "./routes/export.js";
import { NonePieceGenerator } from "./ai/none.js";
import { OpenAiPieceGenerator } from "./ai/openai.js";
import type { PieceGenerator } from "./ai/piece-generator.js";

/**
 * Entry point (design.md D13, editor-api spec "Local server on top of
 * profiles/"). Binds to `127.0.0.1` by default; `EDITOR_BIND` can move
 * that, but only together with `EDITOR_AUTH` — auth itself isn't
 * implemented yet, so exposing the editor with no auth is refused outright
 * rather than silently serving an unauthenticated API on a public
 * interface.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const bind = process.env.EDITOR_BIND?.trim() || "127.0.0.1";
const port = Number(process.env.EDITOR_PORT) || 4310;
const auth = process.env.EDITOR_AUTH?.trim();

if (!LOOPBACK_HOSTS.has(bind) && !auth) {
  console.error(
    `Refusing to start: EDITOR_BIND is set to "${bind}" (not loopback) but EDITOR_AUTH is not set.\n` +
      "Authentication is not implemented yet (see editor/ESTADO.md) — exposing the editor's API " +
      "on a non-loopback interface with no auth is not supported. Either unset EDITOR_BIND to keep " +
      "the default 127.0.0.1, or set EDITOR_AUTH once auth support lands.",
  );
  process.exit(1);
}

const apiKey = process.env.OPENAI_API_KEY?.trim();
// Never logged, never returned — only its presence is reported.
console.log(apiKey ? "AI: configured" : "AI: not configured (set OPENAI_API_KEY in .env to enable generation)");

function getGenerator(_slug: string): PieceGenerator {
  // One instance is enough today (no per-profile provider config exists),
  // but routes ask by slug so a future per-brand override has a seam to
  // land in without changing every call site.
  return apiKey ? new OpenAiPieceGenerator(apiKey) : new NonePieceGenerator();
}

const app = express();
app.use(express.json({ limit: "5mb" }));

app.use(profilesRouter());
app.use(assetsRouter());
app.use(renderRouter());
app.use(composeRouter(getGenerator));
app.use(exportRouter());

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const server = app.listen(port, bind, async () => {
  console.log(`editor-server listening on http://${bind}:${port}`);

  const profiles = listProfiles();
  console.log(
    profiles.length > 0
      ? `Profiles found: ${profiles.map((p) => (p.hasBrand ? p.slug : `${p.slug} (no brand.json)`)).join(", ")}`
      : "No profiles found under the resolved profiles root (see BRAND_PROFILES_DIR).",
  );

  const chromiumProblem = await checkChromiumAvailable();
  console.log(chromiumProblem ? `Chromium check: ${chromiumProblem}` : "Chromium check: ok");
});

async function shutdown(): Promise<void> {
  await closeSharedBrowser();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
