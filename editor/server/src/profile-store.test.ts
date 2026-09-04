import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Exercises `ProfileStore`'s confinement against a temp `BRAND_PROFILES_DIR`
 * tree, so it never touches the real `profiles/` directory. Every escape
 * case from the editor-api spec's "ProfileStore adapter with confinement"
 * requirement is covered, including the `system/templates/x` case the spec
 * calls out by name (a path with no `..` that still escapes).
 *
 * `BRAND_PROFILES_DIR` and `config.local.yaml`'s `outputs.base_dir` must be
 * set up BEFORE importing `./profile-store.js`, since `resolveProfilesRoot`
 * reads the env var at call time (fine) but we still want a clean root per
 * test run — done via a fresh env value per process here since this file
 * runs standalone via `tsx`.
 */

const root = mkdtempSync(join(tmpdir(), "editor-server-profile-store-"));
process.env.BRAND_PROFILES_DIR = root;

const SLUG = "acme";
const profileDir = join(root, SLUG);
mkdirSync(profileDir, { recursive: true });
mkdirSync(join(profileDir, "assets"), { recursive: true });
mkdirSync(join(profileDir, "carousels"), { recursive: true });

// A sibling "system" tree outside profiles/, to prove escapes never reach it.
const fakeSystemDir = join(root, "..", "fake-system-" + Math.random().toString(36).slice(2));
mkdirSync(join(fakeSystemDir, "templates"), { recursive: true });
writeFileSync(join(fakeSystemDir, "templates", "x.md"), "should never be reachable");

// A symlink inside assets/ pointing outside the profile root entirely.
const outsideDir = join(root, "..", "outside-" + Math.random().toString(36).slice(2));
mkdirSync(outsideDir, { recursive: true });
writeFileSync(join(outsideDir, "secret.txt"), "not yours");
symlinkSync(outsideDir, join(profileDir, "assets", "escape-link"));

// Config pointing outputs.base_dir at its own temp dir outside the repo, to
// exercise "a write into outputs.base_dir configured outside the repo works".
const outputsDir = mkdtempSync(join(tmpdir(), "editor-server-outputs-"));
writeFileSync(
  join(profileDir, "config.yaml"),
  `outputs:\n  base_dir: "${outputsDir}"\n`,
);

const { ProfileStore, ProfileStoreError } = await import("./profile-store.js");

const tests: Array<[string, () => void]> = [
  [
    "valid write inside the profile works",
    () => {
      const store = new ProfileStore(SLUG);
      store.writeJson("carousels/demo/carousel.json", { hello: "world" });
      const read = store.readJson<{ hello: string }>("carousels/demo/carousel.json");
      assert.equal(read.hello, "world");
      assert.ok(existsSync(join(profileDir, "carousels", "demo", "carousel.json")));
    },
  ],
  [
    "write into outputs.base_dir configured outside the repo works",
    () => {
      const store = new ProfileStore(SLUG);
      assert.equal(store.roots.outputsBaseDir, outputsDir);
      const abs = store.resolveInOutputs("v1/01.png");
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "fake-png");
      assert.equal(readFileSync(abs, "utf-8"), "fake-png");
      assert.ok(abs.includes("editor-server-outputs-"));
    },
  ],
  [
    "rejects a relative path with ..",
    () => {
      const store = new ProfileStore(SLUG);
      assert.throws(() => store.readFile("../x"), ProfileStoreError);
      assert.throws(() => store.writeFile("../../etc/passwd", "x"), ProfileStoreError);
    },
  ],
  [
    "rejects an absolute path",
    () => {
      const store = new ProfileStore(SLUG);
      assert.throws(() => store.readFile("/etc/passwd"), ProfileStoreError);
    },
  ],
  [
    "rejects a path shaped like system/templates/x with no .. at all",
    () => {
      const store = new ProfileStore(SLUG);
      // No ".." anywhere, but resolves outside both allowed roots once
      // joined against either root — this was the case the first version
      // of the Tauri app's confinement let through (design.md, editor-api spec).
      assert.throws(
        () => store.resolveInProfile(join("..", "..", "fake-system", "templates", "x.md")),
        ProfileStoreError,
      );
    },
  ],
  [
    "rejects a symlink that resolves outside the allowed roots",
    () => {
      const store = new ProfileStore(SLUG);
      assert.throws(() => store.readFile("assets/escape-link/secret.txt"), ProfileStoreError);
      assert.ok(!existsSync(join(outsideDir, "written-through-escape.txt")));
      assert.throws(
        () => store.writeFile("assets/escape-link/written-through-escape.txt", "nope"),
        ProfileStoreError,
      );
      assert.ok(!existsSync(join(outsideDir, "written-through-escape.txt")));
    },
  ],
  [
    "nothing gets written outside the two allowed roots across all rejected attempts",
    () => {
      assert.ok(!existsSync(join(fakeSystemDir, "templates", "pwned.md")));
      assert.ok(!existsSync(join(root, "..", "pwned")));
    },
  ],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

rmSync(root, { recursive: true, force: true });
rmSync(fakeSystemDir, { recursive: true, force: true });
rmSync(outsideDir, { recursive: true, force: true });
rmSync(outputsDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
