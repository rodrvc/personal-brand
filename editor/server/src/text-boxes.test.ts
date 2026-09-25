import assert from "node:assert/strict";

import { chromium } from "playwright";

import { readTextLines } from "./text-boxes.js";

if (process.platform !== "darwin") {
  console.log("skip - local OCR needs macOS");
} else {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
    await page.setContent(
      `<body style="margin:0;background:#fff;font-family:sans-serif">
        <div style="position:absolute;left:80px;top:100px;font-size:64px">Concierto 21:30</div>
        <div style="position:absolute;left:400px;top:800px;font-size:32px">Entrada liberada</div>
      </body>`,
    );
    const lines = readTextLines(await page.screenshot());
    assert.ok(lines, "OCR ran");
    const title = lines.find((l) => l.text.includes("Concierto"));
    assert.ok(title, `found the title in ${JSON.stringify(lines.map((l) => l.text))}`);
    assert.ok(Math.abs(title.box.x - 0.1) < 0.02 && Math.abs(title.box.y - 0.1) < 0.03, `measured where it was drawn: ${JSON.stringify(title.box)}`);
    const entry = lines.find((l) => l.text.includes("Entrada"));
    assert.ok(entry && entry.box.y > 0.75 && entry.box.x > 0.45, "the second line sits lower and to the right");
    console.log("ok - text-boxes");
  } finally {
    await browser.close();
  }
}
