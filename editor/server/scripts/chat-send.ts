/**
 * Sends one chat message with reference files to a running editor server:
 *
 *   pnpm exec tsx scripts/chat-send.ts --profile <slug> --carousel <id> \
 *     --ref layout=/path/poster.png --ref content=/path/event.jpg [--active <slideId>] [--apply] "text"
 *
 * Prints the assistant's reply, then waits for the proposal's done/failed
 * record (applied here with --apply, or from the editor). EDITOR_PORT picks
 * the server, 4310 by default.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};
const WAIT_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const refs: Array<{ role: string; path: string }> = [];
let profile = "";
let carousel = "";
let active: string | undefined;
let apply = false;
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--profile") profile = args[++i]!;
  else if (arg === "--carousel") carousel = args[++i]!;
  else if (arg === "--active") active = args[++i]!;
  else if (arg === "--apply") apply = true;
  else if (arg === "--ref") {
    const [role, ...rest] = args[++i]!.split("=");
    refs.push({ role: role!, path: rest.join("=") });
  } else words.push(arg);
}
const text = words.join(" ");
if (!profile || !carousel || !text || refs.some((r) => r.role !== "layout" && r.role !== "content")) {
  console.error('Usage: chat-send --profile <slug> --carousel <id> [--ref layout|content=<file>]... [--active <slideId>] [--apply] "text"');
  process.exit(2);
}

const base = `http://127.0.0.1:${process.env.EDITOR_PORT ?? 4310}/api/profiles/${profile}/carousels/${carousel}/chat`;

async function call(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error ?? res.statusText}`);
  return json;
}

const references = [];
for (const ref of refs) {
  const mime = MIMES[extname(ref.path).toLowerCase()];
  if (!mime) throw new Error(`Unsupported file type: ${ref.path}`);
  const { reference } = await call("/references", {
    name: basename(ref.path),
    mime,
    dataBase64: readFileSync(ref.path).toString("base64"),
  });
  references.push({ id: reference.id, name: reference.name, role: ref.role });
  console.log(`reference ${ref.role}: ${reference.name} -> ${reference.id}`);
}

const { records } = await call("/messages", { text, references, ...(active ? { activeSlideId: active } : {}) });
const assistant = records[1];
console.log(`\nassistant: ${assistant.text}`);
if (!assistant.proposal) process.exit(0);
console.log(JSON.stringify(assistant.proposal, null, 2));

if (apply) await call(`/proposals/${assistant.proposal.id}/apply`, {});
else console.log("\nWaiting for the proposal to be applied from the editor...");

const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  const log = await call("");
  const end = log.records.find((r: any) => r.proposalId === assistant.proposal.id && (r.kind === "done" || r.kind === "failed"));
  const discarded = log.records.find((r: any) => r.resolves?.proposalId === assistant.proposal.id);
  if (end || discarded) {
    console.log(`\n${JSON.stringify(end ?? discarded, null, 2)}`);
    process.exit(end?.kind === "done" ? 0 : 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
console.error("Timed out waiting for done/failed.");
process.exit(1);
