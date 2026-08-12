#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformIndex = process.argv.indexOf("--platform");
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : process.platform;
const port = 43_139;

const bundle = platform === "darwin"
  ? {
      node: path.join(repositoryRoot, "dist", "Senior Architect Pass Coach.app", "Contents", "Resources", "node"),
      cli: path.join(repositoryRoot, "dist", "Senior Architect Pass Coach.app", "Contents", "Resources", "app", "service", "runtime-cli.mjs"),
    }
  : platform === "linux"
    ? {
        node: path.join(repositoryRoot, "dist", `senior-architect-pass-coach-linux-${process.arch}`, "node"),
        cli: path.join(repositoryRoot, "dist", `senior-architect-pass-coach-linux-${process.arch}`, "app", "service", "runtime-cli.mjs"),
      }
    : null;

if (!bundle) throw new Error(`unsupported_platform:${platform}`);

let diagnostic = "";
const child = spawn(bundle.node, [bundle.cli, "--port", String(port)], {
  cwd: repositoryRoot,
  env: process.env,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    if (diagnostic.length < 8_192) diagnostic += chunk.toString("utf8").slice(0, 8_192 - diagnostic.length);
  });
}

async function stop() {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        cache: "no-store",
        redirect: "error",
      });
      const body = await response.json();
      if (
        response.ok
        && body?.protocol === "coach-loopback.v3"
        && body?.status === "ready"
        && body?.workspace_status === "ready"
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`packaged_runtime_health_failed:${diagnostic.trim()}`);
  process.stdout.write("packaged runtime health: ready\n");
} finally {
  await stop();
}
