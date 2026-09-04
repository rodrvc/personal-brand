#!/usr/bin/env node
// Runs editor/server and editor/web dev servers together, tagging each
// line of output with its source so a single terminal shows both
// processes. A tiny in-repo script rather than pulling in `concurrently`
// (tasks.md 6's "prefer a tiny node script in editor/ if simpler").

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const editorDir = dirname(fileURLToPath(import.meta.url));

function run(name, cwd, args) {
  const child = spawn("pnpm", args, { cwd, stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
  const prefix = `[${name}] `;
  function pipe(stream, out) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  }
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}exited with code ${code}`);
  });
  return child;
}

const server = run("server", join(editorDir, "server"), ["run", "dev"]);
const web = run("web", join(editorDir, "web"), ["run", "dev"]);

function shutdown() {
  server.kill();
  web.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
