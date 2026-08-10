import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repositoryRoot } from "../service/paths.mjs";

function runCli(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repositoryRoot, "service", "cli.mjs"), ...argumentsList], {
      cwd: repositoryRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("help lists the complete local vertical slice", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  for (const command of ["setup", "status", "today", "doctor", "validate-package", "eval-package", "run"]) {
    assert.match(result.stdout, new RegExp(command));
  }
});

test("run is an explicit future entry and never silently invokes a model", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-coach-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runCli(["run", "--data-dir", directory, "--json"]);
  assert.equal(result.code, 3);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "RUN_NOT_ENABLED");
});

test("status without setup does not invent progress", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-coach-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runCli(["status", "--data-dir", directory, "--json"]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "AUTHENTICATION_REQUIRED");
});
