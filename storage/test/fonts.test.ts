import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeObjectStore } from "../src/blob/index.ts";
import { runCli } from "../src/cli/brand.ts";
import { extractFontFaces, MAX_FONT_BYTES } from "../src/cli/fonts.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

const work = mkdtempSync(join(tmpdir(), "brand-fonts-"));
const HREF = "https://fonts.googleapis.com/css2?family=Example+Sans";
const woff2 = (seed: string) => Buffer.concat([Buffer.from("wOF2"), Buffer.from(seed)]);
const css = (...urls: string[]) => urls.map((u, i) => `@font-face { font-family: 'Example Sans'; font-weight: ${400 + i * 100}; src: url(${u}) format('woff2'); }`).join("\n");

/** A fake network: `routes` maps a URL to a Response factory; every requested URL is recorded and nothing leaves the process. */
function network(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push(String(url));
    assert.equal(init?.redirect, "manual", "redirects are always handled by hand");
    assert.ok(init?.signal instanceof AbortSignal && !init.signal.aborted, "every request carries the run deadline and its own timeout");
    const route = routes[String(url)];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { seen, doFetch };
}

try {
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const env = { USER: "tester", HOME: home, INIT_CWD: home };
  const repos = createMemoryRepositories();
  const blobs = new FakeObjectStore();
  const run = (hooks: { fetch: typeof fetch }, ...argv: string[]) => runCli(argv, env, repos, blobs, hooks);
  const setup = async (slug: string, href?: string) => {
    assert.equal((await runCli(["create", slug, "--name", "Example"], env, repos, blobs)).exitCode, 0);
    writeFileSync(join(home, `${slug}.json`), JSON.stringify(href ? { googleFontsHref: href } : {}));
    assert.equal((await runCli(["doc", "put", slug, "tokens", "--file", `${slug}.json`], env, repos, blobs)).exitCode, 0);
    return (await repos.brands.getBySlug(slug)).id;
  };
  const fonts = (slug: string, doFetch: typeof fetch) => run({ fetch: doFetch }, "fonts", "fetch", slug);

  // Happy path: the stylesheet and each font come from allowed hosts; fonts land as candidate assets of that family.
  const ok = await setup("example-ok", HREF);
  const a = "https://fonts.gstatic.com/s/examplesans/v1/a.woff2";
  const b = "https://fonts.gstatic.com/s/examplesans/v1/b.woff2";
  const good = network({ [HREF]: () => new Response(css(a, b)), [a]: () => new Response(woff2("a")), [b]: () => new Response(woff2("b")) });
  const done = await fonts("example-ok", good.doFetch);
  assert.deepEqual([done.exitCode, good.seen], [0, [HREF, a, b]], done.lines.join("\n"));
  const stored = (await repos.assets.list(ok)).map((x) => [x.value.kind, x.value.status, x.value.origin, x.value.family, x.value.mime]);
  assert.deepEqual(stored, [["font", "candidate", "manual", "Example Sans", "font/woff2"], ["font", "candidate", "manual", "Example Sans", "font/woff2"]]);
  const again = await fonts("example-ok", good.doFetch);
  assert.deepEqual([again.exitCode, (await repos.assets.list(ok)).length, /2 ya estaban/.test(again.lines.join("\n"))], [0, 2, true], "re-running registers nothing new");

  // A redirect inside the allowed hosts is followed; one off them is refused before any font is fetched or stored.
  const hop = "https://fonts.googleapis.com/css2-moved";
  const inside = network({ [HREF]: () => new Response(null, { status: 302, headers: { location: hop } }), [hop]: () => new Response(css(a)), [a]: () => new Response(woff2("a")) });
  const okRedirect = await setup("example-hop", HREF);
  assert.deepEqual([(await fonts("example-hop", inside.doFetch)).exitCode, (await repos.assets.list(okRedirect)).length], [0, 1]);
  for (const target of ["https://evil.example.com/x.css", "http://fonts.googleapis.com/x.css", "https://fonts.googleapis.com:8443/x.css"]) {
    const id = await setup(`example-r${Math.abs(target.length)}`, HREF);
    const off = network({ [HREF]: () => new Response(null, { status: 301, headers: { location: target } }), [target]: () => new Response(css(a)) });
    const refused = await fonts(`example-r${Math.abs(target.length)}`, off.doFetch);
    assert.deepEqual([refused.exitCode, off.seen, (await repos.assets.list(id)).length], [6, [HREF], 0], `${target}: never requested, nothing stored`);
  }

  // A host off the list is refused in the tokens' URL and in the stylesheet's font URLs; the first font is not stored either.
  const offHref = await setup("example-href", "https://cdn.example.com/css");
  const none = network({});
  assert.deepEqual([(await fonts("example-href", none.doFetch)).exitCode, none.seen, (await repos.assets.list(offHref)).length], [6, [], 0]);
  const plain = await setup("example-http", "http://fonts.googleapis.com/css2");
  assert.deepEqual([(await fonts("example-http", none.doFetch)).exitCode, none.seen, (await repos.assets.list(plain)).length], [6, [], 0], "https only");
  const evil = "https://evil.example.com/e.woff2";
  const mixed = await setup("example-mixed", HREF);
  const sheet = network({ [HREF]: () => new Response(css(a, evil)), [a]: () => new Response(woff2("a")), [evil]: () => new Response(woff2("e")) });
  const bad = await fonts("example-mixed", sheet.doFetch);
  assert.deepEqual([bad.exitCode, /evil\.example\.com/.test(bad.lines[0]), sheet.seen.includes(evil), (await repos.assets.list(mixed)).length], [6, true, false, 0]);

  // Size caps: an oversized font (declared or streamed) aborts the whole run with nothing stored.
  const big = await setup("example-big", HREF);
  const declared = network({ [HREF]: () => new Response(css(a, b)), [a]: () => new Response(woff2("a")), [b]: () => new Response(woff2("b"), { headers: { "content-length": String(MAX_FONT_BYTES + 1) } }) });
  assert.deepEqual([(await fonts("example-big", declared.doFetch)).exitCode, (await repos.assets.list(big)).length], [6, 0], "declared size");
  const streamed = network({ [HREF]: () => new Response(css(a)), [a]: () => new Response(Buffer.concat([woff2("a"), Buffer.alloc(MAX_FONT_BYTES)])) });
  assert.deepEqual([(await fonts("example-big", streamed.doFetch)).exitCode, (await repos.assets.list(big)).length], [6, 0], "streamed size");
  const hugeCss = network({ [HREF]: () => new Response("x".repeat(300 * 1024)) });
  assert.equal((await fonts("example-big", hugeCss.doFetch)).exitCode, 6, "stylesheet cap");

  // The asset-add checks apply: a file that is not a woff2 is refused, and an archived brand takes no fonts.
  const fake = network({ [HREF]: () => new Response(css(a)), [a]: () => new Response("<html>not a font</html>") });
  assert.equal((await fonts("example-big", fake.doFetch)).exitCode, 6);
  assert.equal((await repos.assets.list(big)).length, 0);
  assert.equal((await runCli(["archive", "example-big"], env, repos, blobs)).exitCode, 0);
  assert.equal((await fonts("example-big", good.doFetch)).exitCode, 6, "archived brand");
  // Judge-all-first: a bad second font leaves zero assets, even though the first one is fine.
  const two = await setup("example-two", HREF);
  const half = network({ [HREF]: () => new Response(css(a, b)), [a]: () => new Response(woff2("a")), [b]: () => new Response("<html>not a font</html>") });
  const halfRun = await fonts("example-two", half.doFetch);
  assert.deepEqual([halfRun.exitCode, /No se subió nada/.test(halfRun.lines[0]), (await repos.assets.list(two)).length], [6, true, 0]);

  // A font URL that does not end in .woff2 (a query string, a fragment) is refused before any download.
  const query = await setup("example-query", HREF);
  for (const url of [`${a}?v=1`, `${a}#frag`, `${a}?x=.woff2`, `${a}#.woff2`]) {
    const q = network({ [HREF]: () => new Response(css(a, url)), [a]: () => new Response(woff2("a")) });
    assert.deepEqual([(await fonts("example-query", q.doFetch)).exitCode, q.seen, (await repos.assets.list(query)).length], [6, [HREF], 0], url);
  }

  // The stylesheet parser is linear: a pathological sheet is read (and refused or skipped) in well under a second.
  const t0 = Date.now();
  extractFontFaces(`@font-face { font-family: x; src: ${"url(".repeat(60000)} }`);
  assert.ok(Date.now() - t0 < 1000, "60000 unclosed url( parse in linear time");

  // Duplicate URLs are one font, and identical bytes behind two URLs register once: the counts say so.
  const dup = await setup("example-dup", HREF);
  const same = network({ [HREF]: () => new Response(css(a, a, b)), [a]: () => new Response(woff2("same")), [b]: () => new Response(woff2("same")) });
  const dupRun = await fonts("example-dup", same.doFetch);
  assert.deepEqual([dupRun.exitCode, same.seen.filter((u) => u === a).length, (await repos.assets.list(dup)).length, /1 registradas \(candidatas\), 0 ya estaban/.test(dupRun.lines.join("\n"))], [0, 1, 1, true], dupRun.lines.join("\n"));
  assert.match((await fonts("example-dup", same.doFetch)).lines.join("\n"), /0 registradas \(candidatas\), 1 ya estaban/);

  // Quoted url() and quoted family names (with an apostrophe inside double quotes) are read as written.
  const quoted = await setup("example-quoted", HREF);
  const sheetQ = `@font-face { font-family: "Example's Sans"; src: url("${a}") format("woff2"); }\n@font-face { font-family: 'Example Serif'; src: url( '${b}' ) format('woff2'); }`;
  const q2 = network({ [HREF]: () => new Response(sheetQ), [a]: () => new Response(woff2("a")), [b]: () => new Response(woff2("b")) });
  assert.equal((await fonts("example-quoted", q2.doFetch)).exitCode, 0);
  assert.deepEqual((await repos.assets.list(quoted)).map((x) => x.value.family).sort(), ["Example Serif", "Example's Sans"]);
  const long = network({ [HREF]: () => new Response(`@font-face { font-family: '${"x".repeat(101)}'; src: url(${a}); }`) });
  const longRun = await fonts("example-quoted", long.doFetch);
  assert.deepEqual([longRun.exitCode, /familia/.test(longRun.lines[0]), long.seen], [6, true, [HREF]], "an over-long family is a policy refusal, not a --family error");

  const noHref = await setup("example-plain");
  assert.deepEqual([(await fonts("example-plain", none.doFetch)).exitCode, none.seen, (await repos.assets.list(noHref)).length], [0, [], 0], "no googleFontsHref: nothing to fetch");
  assert.equal((await run({ fetch: none.doFetch }, "fonts", "frob", "example-ok")).exitCode, 2);
  console.log("fonts fetch: ok");
} finally {
  rmSync(work, { recursive: true, force: true });
}
