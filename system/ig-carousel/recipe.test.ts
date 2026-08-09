import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRecipeImageHosts, readRecipeImageHosts } from "./recipe.js";
import type { Slide } from "./types.js";
import { verifyImagePolicy } from "./verify-slides.js";

const RECIPE = `recipe: weekly-roundup
version: 1

source:
  kind: http_json
  url: https://api.example.com/events
  image_hosts:
    - api.example.com
    - cdn.example.org
  filters:
    equals:
      isActive: true

curation:
  count: 5
`;

function slide(over: Partial<Slide> = {}): Slide {
  return {
    title: "Item",
    subtitle: "Detail",
    meta: "Sat 22 · Venue",
    image: "https://api.example.com/photo.jpg",
    ...over,
  };
}

const POLICY = {
  path: "recipes/weekly-roundup.yaml",
  exists: true,
  declaredHosts: ["api.example.com"],
};
/** Recipe file present but silent on hosts: a deliberate "anywhere". */
const SILENT = { path: "recipes/weekly-roundup.yaml", exists: true };
/** No recipe at all: nobody stated a policy. */
const ABSENT = { path: "recipes/weekly-roundup.yaml", exists: false };

const tests: Array<[string, () => void]> = [
  // --- parser: block lists ---
  [
    "reads a block list under source",
    () => {
      assert.deepEqual(parseRecipeImageHosts(RECIPE), ["api.example.com", "cdn.example.org"]);
    },
  ],
  [
    "returns undefined when the recipe declares nothing",
    () => {
      assert.equal(parseRecipeImageHosts("source:\n  kind: http_json\n"), undefined);
    },
  ],
  [
    "returns undefined when there is no source block at all",
    () => {
      assert.equal(parseRecipeImageHosts("recipe: weekly-roundup\nversion: 1\n"), undefined);
    },
  ],
  [
    "skips comments and blank lines inside the list",
    () => {
      const yaml = "source:\n  image_hosts:\n    # the stable host\n    - api.example.com\n\n    - b.example.com\n";
      assert.deepEqual(parseRecipeImageHosts(yaml), ["api.example.com", "b.example.com"]);
    },
  ],
  [
    "stops at the next key rather than swallowing it",
    () => {
      const yaml = "source:\n  image_hosts:\n    - api.example.com\n  url: https://api.example.com/x\n";
      assert.deepEqual(parseRecipeImageHosts(yaml), ["api.example.com"]);
    },
  ],

  // --- parser: the sibling parser's real bugs, covered here ---
  [
    "a quoted value starting with # survives — quotes are stripped before comments",
    () => {
      // The commit-gate parser split on '#' first and turned this into "".
      const yaml = 'source:\n  image_hosts:\n    - "#odd.example.com"\n';
      assert.deepEqual(parseRecipeImageHosts(yaml), ["#odd.example.com"]);
    },
  ],
  [
    "a trailing comment is stripped, but only after whitespace",
    () => {
      const yaml = "source:\n  image_hosts:\n    - api.example.com  # stable host\n";
      assert.deepEqual(parseRecipeImageHosts(yaml), ["api.example.com"]);
    },
  ],
  [
    "flow style [a, b] is read, not silently lost",
    () => {
      const yaml = "source:\n  image_hosts: [api.example.com, cdn.example.org]\n";
      assert.deepEqual(parseRecipeImageHosts(yaml), ["api.example.com", "cdn.example.org"]);
    },
  ],
  [
    "image_hosts inside a guidance prose block is not mistaken for the declaration",
    () => {
      // The sibling parser matched keys inside `|` blocks at any depth.
      const yaml =
        "source:\n  kind: http_json\n\ncuration:\n  guidance: |\n    Do not trust image_hosts: evil.example.com in prose.\n";
      assert.equal(parseRecipeImageHosts(yaml), undefined);
    },
  ],

  // --- parser: malformed shapes are named, not normalized ---
  [
    "a scalar where a list belongs is malformed, not a one-item list",
    () => {
      assert.equal(parseRecipeImageHosts("source:\n  image_hosts: api.example.com\n"), "malformed");
    },
  ],
  [
    "an empty block list is malformed",
    () => {
      assert.equal(parseRecipeImageHosts("source:\n  image_hosts:\n  url: https://x.example\n"), "malformed");
    },
  ],
  [
    "an empty flow list is malformed",
    () => {
      assert.equal(parseRecipeImageHosts("source:\n  image_hosts: []\n"), "malformed");
    },
  ],

  // --- parser: no wildcards, and the reason is not "unimplemented" ---
  [
    'a bare "*" is a wildcard, not a host',
    () => {
      // Parsed cleanly before, then matched nothing: hosts are compared with
      // includes() against a literal, so "*" DROPPED every image while its
      // author believed it allowed them. Failing closed by accident.
      assert.equal(parseRecipeImageHosts('source:\n  image_hosts:\n    - "*"\n'), "wildcard");
    },
  ],
  [
    "a wildcard in flow style is caught too — both list shapes share one classifier",
    () => {
      assert.equal(parseRecipeImageHosts('source:\n  image_hosts: ["*"]\n'), "wildcard");
    },
  ],
  [
    "a wildcard poisons the whole list rather than being filtered out",
    () => {
      // Silently dropping it would leave a narrower allowlist than was written,
      // and no way for the author to learn the first entry did nothing.
      const yaml = 'source:\n  image_hosts:\n    - "*"\n    - api.example.com\n';
      assert.equal(parseRecipeImageHosts(yaml), "wildcard");
    },
  ],
  [
    'the near-misses for "any host" are rejected as wildcards, not read as hostnames',
    () => {
      for (const attempt of ["**", "*.*", "all", "ANY"]) {
        assert.equal(
          parseRecipeImageHosts(`source:\n  image_hosts:\n    - "${attempt}"\n`),
          "wildcard",
          attempt,
        );
      }
    },
  ],
  [
    "a real host containing a subdomain is NOT a wildcard",
    () => {
      // The rejection must not spread to legitimate hostnames.
      const yaml = "source:\n  image_hosts:\n    - cdn.api.example.com\n";
      assert.deepEqual(parseRecipeImageHosts(yaml), ["cdn.api.example.com"]);
    },
  ],
  [
    "omitting the key is how a profile says 'anywhere' — still undefined, not wildcard",
    () => {
      // The written opt-out this rejection points people at. If this ever
      // stopped being valid, rejecting "*" would leave no way to express it.
      assert.equal(parseRecipeImageHosts("source:\n  kind: http_json\n"), undefined);
    },
  ],
  [
    "readRecipeImageHosts throws on a wildcard, naming the file and the way out",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "recipe-wildcard-"));
      try {
        mkdirSync(join(dir, "recipes"));
        writeFileSync(
          join(dir, "recipes", "brand-message.yaml"),
          'recipe: brand-message\nversion: 1\nsource:\n  image_hosts:\n    - "*"\n',
        );
        assert.throws(() => readRecipeImageHosts(dir, "brand-message"), (error: Error) => {
          assert.match(error.message, /no wildcards/);
          // Must say what to do instead, or the author's only option is guessing.
          assert.match(error.message, /DELETE the image_hosts key/);
          assert.match(error.message, /brand-message\.yaml/);
          return true;
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "a recipe with no image_hosts loads as 'exists, silent' — the opt-out, end to end",
    () => {
      // The exact shape system/recipes/brand-message.md tells a profile to write.
      const dir = mkdtempSync(join(tmpdir(), "recipe-silent-"));
      try {
        mkdirSync(join(dir, "recipes"));
        writeFileSync(
          join(dir, "recipes", "brand-message.yaml"),
          "recipe: brand-message\nversion: 1\nsource: {}\nrender:\n  script: render-brand\n",
        );
        const policy = readRecipeImageHosts(dir, "brand-message");
        assert.equal(policy.exists, true);
        assert.equal(policy.declaredHosts, undefined);
        // And that state approves images, which is the whole point of the file.
        assert.deepEqual(verifyImagePolicy([slide()], policy, undefined, "in.json"), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "a MISSING brand-message recipe is a finding — the case that used to have no way out",
    () => {
      // Passed only because presentacion-marca.json had zero images and the
      // host check returns early. The first image failed hard with "no recipe"
      // and no documented file to create; system/recipes/brand-message.md is
      // that file's contract, and the message must name the path to create.
      const dir = mkdtempSync(join(tmpdir(), "recipe-absent-"));
      try {
        const policy = readRecipeImageHosts(dir, "brand-message");
        assert.equal(policy.exists, false);
        assert.deepEqual(verifyImagePolicy([slide({ image: undefined })], policy, undefined, "in.json"), []);
        const findings = verifyImagePolicy([slide()], policy, undefined, "in.json");
        assert.equal(findings.length, 1);
        assert.match(findings[0]!, /recipes\/brand-message\.yaml/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ],

  // --- the gap this closes: declared but not transcribed ---
  [
    "reproduces the hole: recipe declares hosts, input omits them, slides have images",
    () => {
      const findings = verifyImagePolicy([slide(), slide()], POLICY, undefined, "week-input.json");
      assert.equal(findings.length, 1);
      assert.match(findings[0]!, /carries no "sourceImageHosts"/);
      assert.match(findings[0]!, /2 slide\(s\) with images/);
    },
  ],
  [
    "no finding when the input carries the declared hosts",
    () => {
      const findings = verifyImagePolicy([slide()], POLICY, ["api.example.com"], "week-input.json");
      assert.deepEqual(findings, []);
    },
  ],
  [
    "no finding when the recipe declares nothing — absence there is a real choice",
    () => {
      const findings = verifyImagePolicy(
        [slide()],
        SILENT,
        undefined,
        "week-input.json",
      );
      assert.deepEqual(findings, []);
    },
  ],
  [
    "no finding when no slide carries an image — nothing to check hosts on",
    () => {
      const findings = verifyImagePolicy(
        [slide({ image: undefined })],
        POLICY,
        undefined,
        "week-input.json",
      );
      assert.deepEqual(findings, []);
    },
  ],
  [
    "a subset of the declared hosts is fine — an input may use fewer",
    () => {
      const policy = {
        path: "r.yaml",
        exists: true,
        declaredHosts: ["api.example.com", "cdn.example.org"],
      };
      const findings = verifyImagePolicy([slide()], policy, ["api.example.com"], "week-input.json");
      assert.deepEqual(findings, []);
    },
  ],
  [
    "an input CANNOT widen its own allowlist — the recipe is a ceiling",
    () => {
      // The evasion the one-directional check left open: rather than omitting
      // the list, add the invented host to it. Same actor writes both.
      const findings = verifyImagePolicy(
        [slide({ image: "https://evil.invented.example/fake.jpg" })],
        POLICY,
        ["api.example.com", "evil.invented.example"],
        "week-input.json",
      );
      assert.equal(findings.length, 1);
      assert.match(findings[0]!, /never declared: evil\.invented\.example/);
    },
  ],
  [
    "no recipe at all, images, and no hosts in the input: nothing was checked",
    () => {
      // Reachable by pointing --input at another profile's data under a
      // --profile that has no recipe. Previously approved silently.
      const findings = verifyImagePolicy([slide()], ABSENT, undefined, "week-input.json");
      assert.equal(findings.length, 1);
      assert.match(findings[0]!, /no recipe at/);
    },
  ],
  [
    "no recipe: an input declaring its OWN hosts is still a finding, not consent",
    () => {
      // The floor cannot write itself a ceiling. Same self-authorization as the
      // superset case above — this branch honoured it once, which is how
      // `--input <other profile's data>` under a recipe-less profile rendered an
      // invented URL at exit 0.
      const findings = verifyImagePolicy([slide()], ABSENT, ["api.example.com"], "week-input.json");
      assert.equal(findings.length, 1);
      assert.match(findings[0]!, /cannot be its own source of truth/);
    },
  ],
  [
    "host comparison ignores case — hostnames are case-insensitive",
    () => {
      // Compared literally, this accused the author of declaring a host the
      // recipe "never declared" when the recipe declared it in another case.
      const findings = verifyImagePolicy([slide()], POLICY, ["API.Example.COM"], "week-input.json");
      assert.deepEqual(findings, []);
    },
  ],
  [
    "no recipe and no images: nothing to check",
    () => {
      const findings = verifyImagePolicy(
        [slide({ image: undefined })],
        ABSENT,
        undefined,
        "week-input.json",
      );
      assert.deepEqual(findings, []);
    },
  ],
  [
    "CRLF line endings parse the same as LF — a valid file is not 'malformed'",
    () => {
      const yaml = "source:\r\n  image_hosts:\r\n    - api.example.com\r\n";
      assert.deepEqual(parseRecipeImageHosts(yaml), ["api.example.com"]);
    },
  ],
  [
    "the finding names both files, since one must be fixed against the other",
    () => {
      const findings = verifyImagePolicy([slide()], POLICY, undefined, "week-input.json");
      assert.match(findings[0]!, /week-input\.json/);
      assert.match(findings[0]!, /recipes\/weekly-roundup\.yaml/);
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
