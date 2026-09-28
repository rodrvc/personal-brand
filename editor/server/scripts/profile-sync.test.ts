import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeObjectStore } from "../src/storage/fake-object-store.js";
import type { S3StorageConfig } from "../src/storage/config.js";
import { resolveMirrorRoots } from "../src/storage/mirror.js";
import { computeStatus, parseArgs, resolveCliCacheDir, runCli, runEnv, runFetch, runPull, runPush, runStatus } from "./profile-sync.js";

function s3Config(): S3StorageConfig {
  return {
    bucket: "brand-profiles",
    region: "us-east-1",
    accessKeyId: "id",
    secretAccessKey: "secret",
    prefix: "profiles/",
    forcePathStyle: true,
  };
}

/** Runs `fn` against a throwaway cache dir, cleaning it up afterwards either way. */
async function withCache(fn: (cacheDir: string) => Promise<void> | void): Promise<void> {
  const cacheDir = mkdtempSync(join(tmpdir(), "profile-sync-test-"));
  try {
    await fn(cacheDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

const tests: Array<[string, () => Promise<void> | void]> = [
  [
    "parseArgs requires --profile for pull/push/status/fetch, not for env",
    () => {
      assert.throws(() => parseArgs(["pull"]));
      assert.deepEqual(parseArgs(["pull", "--profile", "acme"]), { kind: "pull", profile: "acme" });
      assert.deepEqual(parseArgs(["push", "--profile", "acme"]), { kind: "push", profile: "acme" });
      assert.deepEqual(parseArgs(["status", "--profile", "acme"]), { kind: "status", profile: "acme", remote: false });
      assert.deepEqual(parseArgs(["status", "--profile", "acme", "--remote"]), { kind: "status", profile: "acme", remote: true });
      assert.deepEqual(parseArgs(["fetch", "--profile", "acme", "--path", "outputs/x.png"]), {
        kind: "fetch",
        profile: "acme",
        area: "profile",
        path: "outputs/x.png",
      });
      assert.deepEqual(parseArgs(["fetch", "--profile", "acme", "--path", "x.png", "--area", "outputs"]), {
        kind: "fetch",
        profile: "acme",
        area: "outputs",
        path: "x.png",
      });
      assert.deepEqual(parseArgs(["env"]), { kind: "env" });
      assert.throws(() => parseArgs(["fetch", "--profile", "acme"]));
      assert.throws(() => parseArgs(["bogus", "--profile", "acme"]));
    },
  ],
  [
    "parseArgs rejects an unknown flag and a flag missing its value, instead of silently swallowing it",
    () => {
      assert.throws(() => parseArgs(["pull", "--profile", "acme", "--bogus"]), /Unknown flag/);
      assert.throws(() => parseArgs(["pull", "--profile"]), /missing a value/);
      assert.throws(() => parseArgs(["pull", "acme"]), /Unexpected argument/);
    },
  ],
  [
    "parseArgs ignores a leading bare `--` (or several), the passthrough separator pnpm forwards through nested `run` scripts",
    () => {
      assert.deepEqual(parseArgs(["--", "pull", "--profile", "acme"]), { kind: "pull", profile: "acme" });
      assert.deepEqual(parseArgs(["--", "--", "status", "--profile", "acme"]), { kind: "status", profile: "acme", remote: false });
    },
  ],
  [
    "fs backend: every command is a no-op that exits 0",
    async () => {
      const env = { STORAGE_BACKEND: "fs" };
      for (const argv of [["pull", "--profile", "acme"], ["push", "--profile", "acme"], ["status", "--profile", "acme"]]) {
        const result = await runCli(argv, env);
        assert.equal(result.exitCode, 0);
        assert.match(result.lines[0], /storage backend is "fs"/);
      }
    },
  ],
  [
    "env: fs backend prints an explanatory no-op line, s3 backend prints export lines matching resolveMirrorRoots",
    () => {
      const fsResult = runEnv({ backend: "fs", cacheDir: "/tmp/x" });
      assert.equal(fsResult.exitCode, 0);
      assert.match(fsResult.lines[0], /storage backend is "fs"/);

      const cacheDir = "/tmp/cache-dir";
      const config = s3Config();
      const s3Result = runEnv({ backend: "s3", cacheDir, s3: config });
      const roots = resolveMirrorRoots(config, cacheDir, "any-slug");
      assert.equal(s3Result.lines[0], `export BRAND_PROFILES_DIR='${roots.profileMirrorRoot}'`);
      assert.equal(s3Result.lines[1], `export BRAND_OUTPUTS_ROOT='${roots.outputsMirrorRoot}'`);
    },
  ],
  [
    "env: a cache dir containing a space and a single quote is quoted safely for eval",
    () => {
      const cacheDir = "/tmp/weird cache 'dir'";
      const config = s3Config();
      const s3Result = runEnv({ backend: "s3", cacheDir, s3: config });
      const roots = resolveMirrorRoots(config, cacheDir, "any-slug");
      assert.match(s3Result.lines[0], /^export BRAND_PROFILES_DIR='.*'$/);
      // The quoted line must actually `eval` safely and yield the exact path,
      // proving the space and embedded quote survived intact.
      const output = execFileSync("sh", ["-c", `${s3Result.lines[0]} && printf '%s' "$BRAND_PROFILES_DIR"`]).toString();
      assert.equal(output, roots.profileMirrorRoot);
    },
  ],
  [
    "pull materializes an eager object and leaves a lazy one for fetch to pull on demand",
    async () =>
      withCache(async (cacheDir) => {
        const config = s3Config();
        const store = new FakeObjectStore();
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"Acme"}'));
        await store.put("profiles/acme/outputs/reel-01.mp4", Buffer.from("VIDEO"));

        assert.equal((await runPull(store, config, cacheDir, "acme")).exitCode, 0);
        const roots = resolveMirrorRoots(config, cacheDir, "acme");
        assert.ok(existsSync(join(roots.profileDir, "brand.json")));
        assert.ok(!existsSync(join(roots.profileDir, "outputs/reel-01.mp4")));

        const fetched = await runFetch(store, config, cacheDir, "acme", "profile", "outputs/reel-01.mp4");
        assert.equal(fetched.exitCode, 0);
        assert.equal(readFileSync(join(roots.profileDir, "outputs/reel-01.mp4"), "utf-8"), "VIDEO");
      }),
  ],
  [
    "push uploads a local edit with a conditional write",
    async () =>
      withCache(async (cacheDir) => {
        const config = s3Config();
        const store = new FakeObjectStore();
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"Acme"}'));
        await runPull(store, config, cacheDir, "acme");

        const roots = resolveMirrorRoots(config, cacheDir, "acme");
        writeFileSync(join(roots.profileDir, "brand.json"), '{"name":"Acme Updated"}');

        const result = await runPush(store, config, cacheDir, "acme");
        assert.equal(result.exitCode, 0);
        assert.equal((await store.get("profiles/acme/brand.json")).body.toString(), '{"name":"Acme Updated"}');
      }),
  ],
  [
    "push reports a conflict and exits non-zero when the bucket changed since the last sync; the bucket is left untouched",
    async () =>
      withCache(async (cacheDir) => {
        const config = s3Config();
        const store = new FakeObjectStore();
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"Acme"}'));
        await runPull(store, config, cacheDir, "acme");

        const roots = resolveMirrorRoots(config, cacheDir, "acme");
        writeFileSync(join(roots.profileDir, "brand.json"), '{"name":"local edit"}');
        // Someone else pushed a different version to the bucket in between.
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"someone else\'s edit"}'));

        const result = await runPush(store, config, cacheDir, "acme");
        assert.equal(result.exitCode, 1);
        assert.match(result.lines.join("\n"), /Run "pull" first/);
        assert.equal((await store.get("profiles/acme/brand.json")).body.toString(), '{"name":"someone else\'s edit"}');
      }),
  ],
  [
    "status reports a local edit, an untracked file, and (with --remote) an object the bucket moved past locally",
    async () =>
      withCache(async (cacheDir) => {
        const config = s3Config();
        const store = new FakeObjectStore();
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"Acme"}'));
        await runPull(store, config, cacheDir, "acme");

        const roots = resolveMirrorRoots(config, cacheDir, "acme");
        writeFileSync(join(roots.profileDir, "brand.json"), '{"name":"edited locally"}');
        writeFileSync(join(roots.profileDir, "notes.md"), "never synced");
        // The bucket also gets a write this mirror never saw.
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"newer remote"}'));

        const local = await computeStatus(store, config, cacheDir, "acme", false);
        assert.deepEqual(local.unsynced, ["profile:brand.json"]);
        assert.deepEqual(local.untracked, ["profile:notes.md"]);
        assert.deepEqual(local.remoteNewer, []);

        const withRemote = await computeStatus(store, config, cacheDir, "acme", true);
        assert.deepEqual(withRemote.remoteNewer, ["profiles/acme/brand.json"]);

        const result = await runStatus(store, config, cacheDir, "acme", false);
        assert.equal(result.exitCode, 0);
        assert.match(result.lines.join("\n"), /1 unsynced edit\(s\), 1 untracked file\(s\)\./);
      }),
  ],
  [
    "status reports a corrupt manifest clearly instead of silently treating it as empty",
    async () =>
      withCache(async (cacheDir) => {
        const config = s3Config();
        const store = new FakeObjectStore();
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"Acme"}'));
        await runPull(store, config, cacheDir, "acme");

        const roots = resolveMirrorRoots(config, cacheDir, "acme");
        writeFileSync(roots.manifestPath, "{not valid json");

        const report = await computeStatus(store, config, cacheDir, "acme", false);
        assert.equal(report.manifestCorrupt, true);
        assert.deepEqual(report.untracked, ["profile:brand.json"]);

        const result = await runStatus(store, config, cacheDir, "acme", false);
        assert.equal(result.exitCode, 1);
      }),
  ],
  [
    "resolveCliCacheDir defaults to a CLI-specific dir distinct from the server default, but honors PROFILE_CACHE_DIR when set",
    () => {
      const cliDefault = resolveCliCacheDir({});
      assert.match(cliDefault, /personal-brand-profile-cache-terminal$/);
      assert.equal(resolveCliCacheDir({ PROFILE_CACHE_DIR: "/tmp/explicit-dir" }), "/tmp/explicit-dir");
    },
  ],
  [
    "pull never clobbers an unsynced local edit, even when the bucket also changed",
    async () =>
      withCache(async (cacheDir) => {
        const config = s3Config();
        const store = new FakeObjectStore();
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"Acme"}'));
        await runPull(store, config, cacheDir, "acme");

        const roots = resolveMirrorRoots(config, cacheDir, "acme");
        writeFileSync(join(roots.profileDir, "brand.json"), '{"name":"unsynced local edit"}');
        await store.put("profiles/acme/brand.json", Buffer.from('{"name":"remote changed too"}'));

        await runPull(store, config, cacheDir, "acme");
        assert.equal(readFileSync(join(roots.profileDir, "brand.json"), "utf-8"), '{"name":"unsynced local edit"}');
      }),
  ],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
