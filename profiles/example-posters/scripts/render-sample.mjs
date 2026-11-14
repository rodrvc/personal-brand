// Fictional sample tool: renders one poster to a PNG in the folder it is given.
// Portable by design: libraries come in by name (never by an absolute path) and the output folder is an argument.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

const args = process.argv.slice(2);
if (args.includes("--check")) {
  // Proves the library resolves on this machine; no browser is launched.
  console.log(typeof chromium.launch === "function" ? "ok" : "fallo");
  process.exit(0);
}

const out = args.find((a) => !a.startsWith("--"));
if (!out) {
  console.error("Falta la carpeta de salida. Uso: node render-sample.mjs <carpeta-de-salida> [--check]");
  process.exit(2);
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 540, height: 675 } });
await page.setContent("<body style='margin:0;display:grid;place-items:center;font:48px sans-serif'>Sample poster</body>");
const file = join(out, "sample.png");
await page.screenshot({ path: file });
await browser.close();
console.log(`Listo: ${file}`);
