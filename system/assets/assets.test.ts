import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadIndex, registerFile, scanAssets, updateEntry } from "./index.js";
import { pickLogo } from "./logo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const EXAMPLE_PROFILE = join(REPO_ROOT, "profiles", "example");

/** A temp copy of profiles/example so tests never touch the real fixture. */
function withTempProfile<T>(fn: (profileDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "assets-test-"));
  try {
    cpSync(EXAMPLE_PROFILE, dir, { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A minimal valid 1x1 PNG, used as a stand-in "manual" image asset.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// A second, distinct 1x1 PNG (different bytes -> different hash) for tests
// that need two independent assets.
const OTHER_TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const tests: Array<[string, () => void]> = [
  [
    "full rebuild after deleting index.json preserves classification",
    () => {
      withTempProfile((profileDir) => {
        const entry = registerFile(profileDir, TINY_PNG, {
          kind: "unclassified",
          destRelPath: "assets/hand-copied.png",
        });
        updateEntry(profileDir, entry.id, { kind: "character", tags: ["ink:light"] });

        // Delete the index — the rebuildable-cache contract.
        rmSync(join(profileDir, "assets", "index.json"));
        assert.equal(existsSync(join(profileDir, "assets", "index.json")), false);

        const rebuilt = scanAssets(profileDir);
        const found = rebuilt.entries.find((e) => e.id === entry.id);
        assert.ok(found, "asset survives a full rebuild");
        assert.equal(found!.kind, "character");
        assert.deepEqual(found!.tags, ["ink:light"]);
      });
    },
  ],

  [
    "same bytes registered twice produces exactly one entry",
    () => {
      withTempProfile((profileDir) => {
        const first = registerFile(profileDir, TINY_PNG, { destRelPath: "assets/a.png" });
        const second = registerFile(profileDir, TINY_PNG, { destRelPath: "assets/b.png" });
        assert.equal(first.id, second.id);

        const index = loadIndex(profileDir);
        const matches = index.entries.filter((e) => e.id === first.id);
        assert.equal(matches.length, 1);
        // The second write must not have happened — the existing file wins.
        assert.equal(existsSync(join(profileDir, "assets", "b.png")), false);
      });
    },
  ],

  [
    "a file copied in by hand appears as unclassified",
    () => {
      withTempProfile((profileDir) => {
        writeFileSync(join(profileDir, "assets", "hand-copy.png"), TINY_PNG);
        const index = scanAssets(profileDir);
        const found = index.entries.find((e) => e.path === "assets/hand-copy.png");
        assert.ok(found, "hand-copied file is indexed");
        assert.equal(found!.kind, "unclassified");
        assert.equal(found!.origin, "manual");
      });
    },
  ],

  [
    "registerFile does not drop a file copied in by hand (C1: stale index must trigger a rescan)",
    () => {
      withTempProfile((profileDir) => {
        // Simulate an agent copying a file straight into assets/, bypassing
        // registerFile entirely — index.json on disk knows nothing about it.
        writeFileSync(join(profileDir, "assets", "hand-copied.png"), TINY_PNG);

        // registerFile of a second, distinct buffer must not silently drop
        // the hand-copied file when it rewrites the index.
        const registered = registerFile(profileDir, OTHER_TINY_PNG, {
          destRelPath: "assets/registered.png",
        });

        const index = loadIndex(profileDir);
        const handCopied = index.entries.find((e) => e.path === "assets/hand-copied.png");
        const viaRegister = index.entries.find((e) => e.id === registered.id);
        assert.ok(handCopied, "hand-copied file survives registerFile's index write");
        assert.ok(viaRegister, "registerFile's own entry is present too");
      });
    },
  ],

  [
    "registerFile without destRelPath derives the extension from the detected mime (C2)",
    () => {
      withTempProfile((profileDir) => {
        const entry = registerFile(profileDir, TINY_PNG);
        assert.ok(entry.path.endsWith(".png"), `expected a .png path, got "${entry.path}"`);
        assert.equal(existsSync(join(profileDir, entry.path)), true);
      });
    },
  ],

  [
    "registerFile without destRelPath throws for undetectable content (C2)",
    () => {
      withTempProfile((profileDir) => {
        const opaque = Buffer.from("not a known image or font format");
        assert.throws(() => registerFile(profileDir, opaque), /destRelPath/);
      });
    },
  ],

  [
    "hiding a piece keeps the file on disk",
    () => {
      withTempProfile((profileDir) => {
        const entry = registerFile(profileDir, TINY_PNG, { destRelPath: "assets/to-hide.png" });
        updateEntry(profileDir, entry.id, { status: "hidden" });

        const absPath = join(profileDir, "assets", "to-hide.png");
        assert.equal(existsSync(absPath), true, "file is not deleted when hidden");
        assert.equal(readFileSync(absPath).equals(TINY_PNG), true);

        const rebuilt = scanAssets(profileDir);
        const found = rebuilt.entries.find((e) => e.id === entry.id);
        assert.equal(found!.status, "hidden", "hidden status survives a rebuild");
      });
    },
  ],

  // --- logo.ts ---

  [
    "pickLogo chooses ink:light on a dark background",
    () => {
      const index = {
        entries: [
          {
            id: "1111111111111111",
            path: "assets/logo-dark.png",
            kind: "logo" as const,
            mime: "image/png",
            bytes: 10,
            origin: "manual" as const,
            status: "approved" as const,
            tags: ["ink:dark"],
            createdAt: new Date().toISOString(),
          },
          {
            id: "2222222222222222",
            path: "assets/logo-light.png",
            kind: "logo" as const,
            mime: "image/png",
            bytes: 10,
            origin: "manual" as const,
            status: "approved" as const,
            tags: ["ink:light"],
            createdAt: new Date().toISOString(),
          },
        ],
      };
      const picked = pickLogo(index, "#0a0a0a"); // near-black background
      assert.equal(picked?.entry.id, "2222222222222222", "light-ink logo wins on a dark background");
      assert.equal(picked?.exact, true);
    },
  ],

  [
    "pickLogo chooses ink:dark on a light background",
    () => {
      const index = {
        entries: [
          {
            id: "1111111111111111",
            path: "assets/logo-dark.png",
            kind: "logo" as const,
            mime: "image/png",
            bytes: 10,
            origin: "manual" as const,
            status: "approved" as const,
            tags: ["ink:dark"],
            createdAt: new Date().toISOString(),
          },
          {
            id: "2222222222222222",
            path: "assets/logo-light.png",
            kind: "logo" as const,
            mime: "image/png",
            bytes: 10,
            origin: "manual" as const,
            status: "approved" as const,
            tags: ["ink:light"],
            createdAt: new Date().toISOString(),
          },
        ],
      };
      const picked = pickLogo(index, "#fafafa"); // near-white background
      assert.equal(picked?.entry.id, "1111111111111111", "dark-ink logo wins on a light background");
      assert.equal(picked?.exact, true);
    },
  ],

  [
    "pickLogo flags exact: false when no logo carries the wanted ink tag",
    () => {
      const index = {
        entries: [
          {
            id: "4444444444444444",
            path: "assets/logo-untagged.png",
            kind: "logo" as const,
            mime: "image/png",
            bytes: 10,
            origin: "manual" as const,
            status: "approved" as const,
            tags: [],
            createdAt: new Date().toISOString(),
          },
        ],
      };
      const picked = pickLogo(index, "#0a0a0a");
      assert.equal(picked?.entry.id, "4444444444444444", "falls back to the only logo present");
      assert.equal(picked?.exact, false, "unverified variant must be flagged, not presented as correct");
    },
  ],

  [
    "pickLogo returns undefined with no logo asset in the library",
    () => {
      const index = {
        entries: [
          {
            id: "3333333333333333",
            path: "assets/background.png",
            kind: "background" as const,
            mime: "image/png",
            bytes: 10,
            origin: "manual" as const,
            status: "approved" as const,
            tags: [],
            createdAt: new Date().toISOString(),
          },
        ],
      };
      assert.equal(pickLogo(index, "#ffffff"), undefined);
    },
  ],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
  process.exitCode = 1;
}
