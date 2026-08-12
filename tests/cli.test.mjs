import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("help lists the complete local conversation slice", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  for (const command of ["setup", "status", "today", "doctor", "validate-package", "eval-package", "session", "run"]) {
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

test("content-only session completes a real CLI question and trusted progress write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-coach-cli-e2e-"));
  const dataDirectory = path.join(root, "private-data");
  const contentDirectory = path.join(root, "review-clone");
  const papers = path.join(contentDirectory, "past-papers", "comprehensive-by-year");
  await mkdir(papers, { recursive: true });
  await writeFile(path.join(papers, "2099.md"), `### 1. 【题干】
哪一种合成过程模型显式包含风险分析（ ）。
A. 合成瀑布  B. 合成螺旋  C. 合成增量  D. 合成原型
**答案：B**  |  **考点**：§4.1 合成过程模型
**解析**：合成螺旋模型显式包含风险分析。
`, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const common = ["--data-dir", dataDirectory, "--content-dir", contentDirectory, "--json"];
  const setup = await runCli(["setup", "--daily-minutes", "45", ...common]);
  assert.equal(setup.code, 0, setup.stderr);

  const started = await runCli(["session", "start", "--mode", "content-only", ...common]);
  assert.equal(started.code, 0, started.stderr);
  const session = JSON.parse(started.stdout);
  assert.equal(session.state, "ready");

  const listed = await runCli(["session", "list", ...common]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(
    JSON.parse(listed.stdout).sessions.map((item) => item.session_id),
    [session.session_id],
  );

  const next = await runCli([
    "session", "turn", "--session-id", session.session_id,
    "--turn-id", "cli-next-1", "--expected-revision", String(session.revision),
    "--intent", "next", ...common,
  ]);
  assert.equal(next.code, 0, next.stderr);
  const question = JSON.parse(next.stdout);
  assert.equal(question.state, "awaiting_answer");
  assert.equal(question.task.action, "diagnose");
  assert.doesNotMatch(JSON.stringify(question.question), /答案|解析|reference_answer/u);

  const answer = await runCli([
    "session", "turn", "--session-id", session.session_id,
    "--turn-id", "cli-answer-1", "--expected-revision", String(question.revision),
    "--expected-item-id", question.question.item_id,
    "--intent", "answer", "--answer", "B", "--confidence", "unsure", ...common,
  ]);
  assert.equal(answer.code, 0, answer.stderr);
  const feedback = JSON.parse(answer.stdout);
  assert.equal(feedback.state, "feedback");
  assert.equal(feedback.feedback.result, "needs_retest");
  assert.equal(feedback.progress_commit.status, "committed");

  const retried = await runCli([
    "session", "turn", "--session-id", session.session_id,
    "--turn-id", "cli-answer-1", "--expected-revision", String(question.revision),
    "--expected-item-id", question.question.item_id,
    "--intent", "answer", "--answer", "B", "--confidence", "unsure", ...common,
  ]);
  assert.equal(retried.code, 0, retried.stderr);
  assert.deepEqual(JSON.parse(retried.stdout), feedback);

  const status = await runCli(["status", ...common]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).subjects.comprehensive.evidence_count, 1);
});
