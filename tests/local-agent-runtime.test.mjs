import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalAgentRuntime,
  LOOPBACK_HOST,
  LOOPBACK_PROTOCOL,
} from "../service/local-agent-runtime.mjs";
import { openRuntimeUrl } from "../service/runtime-cli.mjs";
import { LocalAgentClient } from "../docs/src/local-agent-client.mjs";

const TOKEN = "a".repeat(43);
const QUESTION = Object.freeze({
  item_id: "ssa-review:q1:abcdef0123456789",
  kind: "multiple_choice",
  subject: "comprehensive",
  topic_id: "availability",
  prompt: "Which tactic best supports the stated availability requirement?",
  options: Object.freeze([
    Object.freeze({ label: "A", text: "Tactic A" }),
    Object.freeze({ label: "B", text: "Tactic B" }),
  ]),
  source_refs: Object.freeze(["senior-software-architect-review"]),
});
const GRADE = Object.freeze({
  schema_version: "web-trusted-objective-grade.v1",
  item_id: QUESTION.item_id,
  topic_id: QUESTION.topic_id,
  subject: QUESTION.subject,
  selected_answer: "A",
  reference_answer: "B",
  correct: false,
  result: "not_mastered",
  score: 0,
  max_score: 1,
  explanation: "Availability tactics must be mapped to the actual failure mode.",
  source_refs: Object.freeze([...QUESTION.source_refs]),
});
const PROGRESS = Object.freeze({
  schema_version: "deidentified-progress.v1",
  subjects: Object.freeze(Object.fromEntries(
    ["comprehensive", "case", "essay"].map((subject) => [subject, Object.freeze({
      status: "unmeasured",
      latest_mock_score: null,
      lower_bound_score: null,
      evidence_level: "cold_start",
      evidence_count: 0,
    })]),
  )),
  target_subject: "comprehensive",
  maintenance_subject: null,
  crunch_mode: false,
  days_to_exam: null,
  recommendations: Object.freeze([]),
});

function completedSubmitOutput(summary = "Review this gap, then take a different retest item.") {
  return {
    teaching_result: {
      schema_version: "architect-pass-coach-teaching-result.v1",
      action: "submit",
      status: "completed",
      scope: "personalized",
      summary,
      score_goal: { pass_line: 45, safety_target: 52 },
      answer_visibility: "revealed_after_submission",
      state_write_performed: false,
      assessments: [{
        subject: GRADE.subject,
        topic_id: GRADE.topic_id,
        result: GRADE.result,
        evidence: "The deterministic local grade is not mastered.",
      }],
      learning_items: [],
      feedback: [{
        item_id: GRADE.item_id,
        result: GRADE.result,
        reference_answer: GRADE.reference_answer,
        explanation: GRADE.explanation,
        source_refs: [...GRADE.source_refs],
      }],
      recommendations: [],
      source_refs: [...GRADE.source_refs],
    },
    proposed_progress_events: [{
      schema_version: "progress-event-proposal.v1",
      event_type: "practice_result",
      subject: GRADE.subject,
      topic_id: GRADE.topic_id,
      result: GRADE.result,
      evidence: { item_id: GRADE.item_id, summary: "Proposal only." },
      proposal_only: true,
      requires_authenticated_context: true,
    }],
  };
}

function completedQuestionOutput(summary = "Keep working independently before checking feedback.") {
  return {
    teaching_result: {
      schema_version: "architect-pass-coach-teaching-result.v1",
      action: "practice",
      status: "completed",
      scope: "personalized",
      summary,
      score_goal: { pass_line: 45, safety_target: 52 },
      answer_visibility: "hidden",
      state_write_performed: false,
      assessments: [],
      learning_items: [structuredClone(QUESTION)],
      feedback: [],
      recommendations: [],
      source_refs: [...QUESTION.source_refs],
    },
    proposed_progress_events: [],
  };
}

function completedReviewOutput(summary = "先把问题按质量属性、约束和取舍拆成三栏。") {
  return {
    teaching_result: {
      schema_version: "architect-pass-coach-teaching-result.v1",
      action: "review",
      status: "completed",
      scope: "personalized",
      summary,
      score_goal: { pass_line: 45, safety_target: 52 },
      answer_visibility: "hidden",
      state_write_performed: false,
      assessments: [],
      learning_items: [],
      feedback: [],
      recommendations: [],
      source_refs: [],
    },
    proposed_progress_events: [],
  };
}

function readyInspection(overrides = {}) {
  return {
    host: {
      status: "ready",
      available: true,
      adapterStatus: "runnable",
      issues: [],
      ...overrides.host,
    },
    compatibility: {
      compatible: true,
      missing: [],
      unknown: [],
      issues: [],
      ...overrides.compatibility,
    },
  };
}

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coach-loopback-test-"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Local Coach</title>", "utf8");
  await writeFile(path.join(directory, "app.mjs"), "export const local = true;", "utf8");
  const calls = { inspections: [], preflights: 0, runs: [] };
  const inspectAdapter = options.inspectAdapter || (async ({ engine, directory: packageDirectory }) => {
    calls.inspections.push({ engine, packageDirectory });
    return readyInspection();
  });
  const runnerFactory = options.runnerFactory || (() => ({
    async preflight() { calls.preflights += 1; },
    async run(input) {
      calls.runs.push(input);
      return completedSubmitOutput();
    },
  }));
  const runtime = createLocalAgentRuntime({
    docsRoot: directory,
    port: 0,
    inspectAdapter,
    runnerFactory,
    tokenFactory: () => TOKEN,
  });
  await runtime.start();
  return {
    directory,
    runtime,
    calls,
    async close() {
      await runtime.stop();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

async function json(response) {
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function baseHeaders(runtime, token = TOKEN) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: runtime.origin,
    "X-Coach-Protocol": LOOPBACK_PROTOCOL,
  };
}

async function bootstrap(runtime, origin = runtime.origin) {
  return json(await fetch(`${runtime.origin}/v1/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Coach-Protocol": LOOPBACK_PROTOCOL,
    },
    body: JSON.stringify({ protocol: LOOPBACK_PROTOCOL }),
  }));
}

function submitBody(overrides = {}) {
  return {
    phase: "submit",
    engine: "qwen-code",
    public_question: structuredClone(QUESTION),
    trusted_grade: structuredClone(GRADE),
    deidentified_progress: structuredClone(PROGRESS),
    ...overrides,
  };
}

function rawRequest(runtime, { path: requestPath, host = runtime.exactHost }) {
  const port = Number(runtime.exactHost.split(":")[1]);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: LOOPBACK_HOST,
      port,
      method: "GET",
      path: requestPath,
      headers: { Host: host },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("runtime binds IPv4 loopback, serves docs, and exposes a non-sensitive health check", async (t) => {
  const environment = await fixture();
  t.after(() => environment.close());

  const address = environment.runtime.server.address();
  assert.equal(address.address, LOOPBACK_HOST);
  assert.equal(environment.runtime.url, `${environment.runtime.origin}/`);

  const page = await fetch(environment.runtime.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Local Coach/u);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const health = await json(await fetch(`${environment.runtime.origin}/v1/health`));
  assert.equal(health.body.protocol, LOOPBACK_PROTOCOL);
  assert.equal(health.body.status, "ready");
  assert.equal(health.body.authentication, "bootstrap_required");
  assert.equal(health.body.agent_run_busy, false);
  assert.match(health.body.instance_id, /^[0-9a-f-]{36}$/u);
  assert.doesNotMatch(JSON.stringify(health.body), /tmp|token|employee|directory/iu);
});

test("strict Host, Origin, traversal, and symlink checks fail closed", async (t) => {
  const environment = await fixture();
  t.after(() => environment.close());
  const outside = path.join(os.tmpdir(), `coach-outside-${Date.now()}.txt`);
  await writeFile(outside, "secret", "utf8");
  await symlink(outside, path.join(environment.directory, "escape.txt"));
  t.after(() => rm(outside, { force: true }));

  const wrongOrigin = await bootstrap(environment.runtime, "https://peterguy326.github.io");
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.body.reason_code, "origin_not_allowed");

  const wrongHost = await rawRequest(environment.runtime, {
    path: "/v1/health",
    host: `localhost:${environment.runtime.server.address().port}`,
  });
  assert.equal(wrongHost.status, 421);
  assert.doesNotMatch(wrongHost.body, /localhost|127\.0\.0\.1/u);

  const traversal = await rawRequest(environment.runtime, { path: "/%2e%2e/package.json" });
  assert.equal(traversal.status, 403);
  assert.doesNotMatch(traversal.body, /package\.json|tmp/u);

  const escaped = await fetch(`${environment.runtime.origin}/escape.txt`);
  assert.equal(escaped.status, 403);
  assert.doesNotMatch(await escaped.text(), /secret|outside|tmp/u);
});

test("bootstrap keeps only bearer hashes and protected endpoints require the protocol", async (t) => {
  const environment = await fixture();
  t.after(() => environment.close());

  const created = await bootstrap(environment.runtime);
  assert.equal(created.status, 200);
  assert.equal(created.body.access_token, TOKEN);
  assert.equal(environment.runtime.bearerHashes.length, 1);
  assert.ok(Buffer.isBuffer(environment.runtime.bearerHashes[0]));
  assert.notEqual(environment.runtime.bearerHashes[0].toString("utf8"), TOKEN);

  const missingProtocol = await json(await fetch(`${environment.runtime.origin}/v1/adapters`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Origin: environment.runtime.origin },
  }));
  assert.equal(missingProtocol.status, 400);
  assert.equal(missingProtocol.body.reason_code, "protocol_header_required");

  const badToken = await json(await fetch(`${environment.runtime.origin}/v1/adapters`, {
    headers: baseHeaders(environment.runtime, "b".repeat(43)),
  }));
  assert.equal(badToken.status, 401);
  assert.equal(badToken.body.reason_code, "authentication_required");
});

test("adapter discovery is package-aware and never selects Codex probe-only or Qoder without structured output", async (t) => {
  const environment = await fixture({
    inspectAdapter: async ({ engine }) => {
      if (engine === "codex") {
        return readyInspection({
          host: { adapterStatus: "probe_only", status: "installed" },
          compatibility: {
            compatible: false,
            issues: [{ code: "host_adapter_not_runnable", message: "/private/path", blocking: true }],
          },
        });
      }
      if (engine === "qoder") {
        return readyInspection({
          compatibility: {
            compatible: false,
            missing: ["structured_output"],
            issues: [{ code: "required_capability_unsupported", message: "secret", blocking: true }],
          },
        });
      }
      if (engine === "qwen-code") return readyInspection();
      if (engine === "codebuddy") {
        return readyInspection({
          host: { status: "not_ready", available: false },
          compatibility: { compatible: true },
        });
      }
      throw new Error("local path must not escape");
    },
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);

  const response = await json(await fetch(`${environment.runtime.origin}/v1/adapters`, {
    headers: baseHeaders(environment.runtime),
  }));
  assert.equal(response.status, 200);
  const byId = Object.fromEntries(response.body.adapters.map((adapter) => [adapter.id, adapter]));
  assert.equal(byId.codex.state, "probe_only");
  assert.equal(byId.codex.selectable, false);
  assert.equal(byId.qoder.state, "incompatible");
  assert.equal(byId.qoder.selectable, false);
  assert.equal(byId["qwen-code"].state, "ready");
  assert.equal(byId["qwen-code"].selectable, true);
  assert.equal(byId.codebuddy.state, "needs_configuration");
  assert.equal(byId.codebuddy.selectable, false);
  assert.equal(byId["claude-code"].state, "unavailable");
  assert.doesNotMatch(JSON.stringify(response.body), /private|secret|directory|path must/u);

  const preflight = await json(await fetch(`${environment.runtime.origin}/v1/adapters/qoder/preflight`, {
    method: "POST",
    headers: { ...baseHeaders(environment.runtime), "Content-Type": "application/json" },
    body: "{}",
  }));
  assert.equal(preflight.body.adapter.selectable, false);
});

test("submit runs one schema-valid employee turn, sanitizes coaching, ignores events, and replays idempotently", async (t) => {
  const output = completedSubmitOutput("\u001b[31m补 availability\u001b[0m\u202e，再做一道异题复测。\u0007");
  const environment = await fixture({
    runnerFactory: () => ({
      async preflight() { environment.calls.preflights += 1; },
      async run(input) {
        environment.calls.runs.push(input);
        return output;
      },
    }),
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);
  const headers = {
    ...baseHeaders(environment.runtime),
    "Content-Type": "application/json",
    "Idempotency-Key": "turn-submit-1",
  };
  const body = JSON.stringify(submitBody());

  const first = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST", headers, body,
  }));
  const second = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST", headers, body,
  }));

  assert.equal(first.status, 200);
  assert.equal(first.body.coaching_text, "补 availability，再做一道异题复测。");
  assert.equal(first.body.progress_write, "not_performed");
  assert.equal(first.body.engine, "qwen-code");
  assert.equal(second.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(second.body, first.body);
  assert.equal(environment.calls.preflights, 1);
  assert.equal(environment.calls.runs.length, 1);

  const employeeInput = environment.calls.runs[0];
  assert.deepEqual(employeeInput.context, { authenticated: true });
  assert.equal(employeeInput.action, "submit");
  assert.equal(employeeInput.request.approved_materials[0].locator, `question:${QUESTION.item_id}`);
  assert.equal(employeeInput.request.progress_snapshot.schema_version, "deidentified-progress.v1");
  assert.doesNotMatch(JSON.stringify(employeeInput), /user_id|source_path|data_directory|api_key/iu);
});

test("chat is unavailable before an active objective answer is submitted", async (t) => {
  const environment = await fixture({
    runnerFactory: () => ({
      async preflight() {},
      async run(input) {
        environment.calls.runs.push(input);
        return completedQuestionOutput("This must never be invoked.");
      },
    }),
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);
  const response = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST",
    headers: {
      ...baseHeaders(environment.runtime),
      "Content-Type": "application/json",
      "Idempotency-Key": "turn-chat-1",
    },
    body: JSON.stringify({
      phase: "chat",
      engine: "qwen-code",
      public_question: structuredClone(QUESTION),
      deidentified_progress: structuredClone(PROGRESS),
      message: "我应该从哪个质量属性角度思考？",
    }),
  }));
  assert.equal(response.status, 400);
  assert.equal(response.body.reason_code, "invalid_request");
  assert.equal(environment.calls.runs.length, 0);
});

test("chat without an active question uses review context and returns no progress effect", async (t) => {
  const environment = await fixture({
    runnerFactory: () => ({
      async preflight() {},
      async run(input) {
        environment.calls.runs.push(input);
        return completedReviewOutput();
      },
    }),
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);
  const response = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST",
    headers: {
      ...baseHeaders(environment.runtime),
      "Content-Type": "application/json",
      "Idempotency-Key": "turn-chat-general-1",
    },
    body: JSON.stringify({
      phase: "chat",
      engine: "qwen-code",
      public_question: null,
      trusted_grade: null,
      deidentified_progress: structuredClone(PROGRESS),
      message: "案例题遇到质量属性冲突时，我该怎么组织思路？",
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.coaching_text, "先把问题按质量属性、约束和取舍拆成三栏。");
  assert.equal(response.body.progress_write, "not_performed");
  const input = environment.calls.runs[0];
  assert.equal(input.action, "review");
  assert.equal(input.request.message, "案例题遇到质量属性冲突时，我该怎么组织思路？");
  assert.equal(Object.hasOwn(input.request, "active_item"), false);
  assert.equal(Object.hasOwn(input.request, "approved_materials"), false);
});

test("post-submission chat re-injects the trusted grade but never commits its event", async (t) => {
  const environment = await fixture({
    runnerFactory: () => ({
      async preflight() {},
      async run(input) {
        environment.calls.runs.push(input);
        return completedSubmitOutput("关键是先识别失效模式，再选择可用性策略。");
      },
    }),
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);
  const response = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST",
    headers: {
      ...baseHeaders(environment.runtime),
      "Content-Type": "application/json",
      "Idempotency-Key": "turn-chat-grade-1",
    },
    body: JSON.stringify(submitBody({
      phase: "chat",
      message: "为什么我选的策略不匹配？",
    })),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.phase, "chat");
  assert.equal(response.body.answer_visibility, "revealed_after_submission");
  assert.equal(response.body.progress_write, "not_performed");
  assert.equal(environment.calls.runs[0].action, "submit");
  assert.equal(environment.calls.runs[0].request.message, "为什么我选的策略不匹配？");
});

test("chat rejects controls, secrets, and local paths before a model run", async (t) => {
  const output = completedReviewOutput();
  const environment = await fixture({
    runnerFactory: () => ({
      async preflight() {},
      async run() {
        environment.calls.runs.push(true);
        return output;
      },
    }),
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);
  const headers = (key) => ({
    ...baseHeaders(environment.runtime),
    "Content-Type": "application/json",
    "Idempotency-Key": key,
  });
  for (const [key, message] of [
    ["unsafe-control", "解释一下\u001b[31m这个考点"],
    ["unsafe-key", "我的 key 是 sk-abcdefgh12345678"],
    ["unsafe-path", "读取 /Users/alice/private/notes.md"],
    ["unsafe-fullwidth-path", "读取：/tmp/secret.txt"],
    ["unsafe-ascii-colon-path", "路径:/tmp/secret.txt"],
    ["unsafe-backtick-path", "读取 `/var/folders/private.txt`"],
    ["unsafe-no-space-path", "https://example.com/a，读取/tmp/secret.txt"],
    ["unsafe-home-path", "路径：~/private/secret.txt"],
    ["unsafe-fullwidth-key", "OPENAI_API_KEY：abcdefgh12345678"],
    ["unsafe-natural-key", "ANTHROPIC_API_KEY 是 abcdefgh12345678"],
    ["unsafe-windows-path", "路径：C:\\Users\\alice\\secret.txt"],
  ]) {
    const rejected = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({
        phase: "chat",
        engine: "qwen-code",
        public_question: null,
        deidentified_progress: structuredClone(PROGRESS),
        message,
      }),
    }));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.reason_code, "invalid_request");
  }

  for (const [key, body] of [
    ["unsafe-question-path", {
      phase: "chat",
      engine: "qwen-code",
      public_question: null,
      deidentified_progress: {
        ...structuredClone(PROGRESS),
        recommendations: [{
          topic_id: "availability",
          subject: "comprehensive",
          skill: "recognition",
          priority_score: null,
          mastery: null,
          review_due: true,
          estimated_minutes: 10,
          reason_code: "/tmp/private/plan.json",
        }],
      },
      message: "帮我安排复习。",
    }],
    ["unsafe-grade-secret", submitBody({
      trusted_grade: {
        ...structuredClone(GRADE),
        explanation: "CODEBUDDY_API_KEY=abcdefgh12345678",
      },
    })],
  ]) {
    const rejected = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify(body),
    }));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.reason_code, "invalid_request");
  }
  assert.equal(environment.calls.runs.length, 0);
});

test("model output containing credentials or absolute local paths is never returned", async (t) => {
  let output = completedReviewOutput("OPENAI_API_KEY=sk-abcdefgh12345678");
  const environment = await fixture({
    runnerFactory: () => ({
      async preflight() {},
      async run() {
        environment.calls.runs.push(true);
        return output;
      },
    }),
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);

  for (const [key, summary] of [
    ["unsafe-agent-secret", "OPENAI_API_KEY=sk-abcdefgh12345678"],
    ["unsafe-agent-path", "请读取 /tmp/private/answer-key.json"],
    ["unsafe-agent-markdown-path", "请读取 `/Library/Keychains/private.keychain-db`"],
    ["unsafe-agent-natural-secret", "CODEBUDDY_API_KEY 为 abcdefgh12345678"],
  ]) {
    output = completedReviewOutput(summary);
    const rejected = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
      method: "POST",
      headers: {
        ...baseHeaders(environment.runtime),
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        phase: "chat",
        engine: "qwen-code",
        public_question: null,
        deidentified_progress: structuredClone(PROGRESS),
        message: "帮我安排今天的复习。",
      }),
    }));
    assert.equal(rejected.status, 502);
    assert.equal(rejected.body.reason_code, "agent_output_rejected");
    assert.doesNotMatch(JSON.stringify(rejected.body), /OPENAI|tmp|private|answer-key/iu);
  }
  assert.equal(environment.calls.runs.length, 4);
});

test("strict request fields, idempotency conflicts, and one-run concurrency fail safely", async (t) => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const runPromise = new Promise((resolve) => { release = resolve; });
  const environment = await fixture({
    runnerFactory: () => ({
      async preflight() {},
      async run() {
        environment.calls.runs.push(true);
        started();
        await runPromise;
        return completedSubmitOutput();
      },
    }),
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);
  const headers = (key) => ({
    ...baseHeaders(environment.runtime),
    "Content-Type": "application/json",
    "Idempotency-Key": key,
  });

  const rejected = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST",
    headers: headers("invalid-extra"),
    body: JSON.stringify(submitBody({ api_key: "must-not-pass" })),
  }));
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.reason_code, "invalid_request");
  assert.equal(environment.calls.runs.length, 0);

  const nestedProgress = structuredClone(PROGRESS);
  nestedProgress.subjects.comprehensive.source_path = "/Users/alice/private/progress.json";
  const rejectedNested = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST",
    headers: headers("invalid-nested"),
    body: JSON.stringify(submitBody({ deidentified_progress: nestedProgress })),
  }));
  assert.equal(rejectedNested.status, 400);
  assert.equal(rejectedNested.body.reason_code, "invalid_request");
  assert.equal(environment.calls.inspections.length, 0);

  const firstPromise = fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST",
    headers: headers("concurrent-1"),
    body: JSON.stringify(submitBody()),
  });
  await startedPromise;
  const busy = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST",
    headers: headers("concurrent-2"),
    body: JSON.stringify(submitBody()),
  }));
  assert.equal(busy.status, 409);
  assert.equal(busy.body.reason_code, "agent_busy");
  release();
  assert.equal((await firstPromise).status, 200);

  const conflict = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST",
    headers: headers("concurrent-1"),
    body: JSON.stringify(submitBody({ phase: "chat", trusted_grade: undefined, message: "Explain." })),
  }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.reason_code, "idempotency_key_conflict");
  assert.equal(environment.calls.runs.length, 1);
});

test("agent fact mismatches return only a stable reason code and are cached", async (t) => {
  const mismatched = completedSubmitOutput();
  mismatched.teaching_result.feedback[0].reference_answer = "LOCAL_SECRET_PATH";
  const environment = await fixture({
    runnerFactory: () => ({
      async preflight() {},
      async run() {
        environment.calls.runs.push(true);
        return mismatched;
      },
    }),
  });
  t.after(() => environment.close());
  await bootstrap(environment.runtime);
  const headers = {
    ...baseHeaders(environment.runtime),
    "Content-Type": "application/json",
    "Idempotency-Key": "bad-output-1",
  };
  const body = JSON.stringify(submitBody());
  const first = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST", headers, body,
  }));
  const replay = await json(await fetch(`${environment.runtime.origin}/v1/coach`, {
    method: "POST", headers, body,
  }));
  assert.equal(first.status, 502);
  assert.deepEqual(first.body, {
    protocol: LOOPBACK_PROTOCOL,
    status: "error",
    reason_code: "agent_output_rejected",
  });
  assert.doesNotMatch(JSON.stringify(first.body), /LOCAL_SECRET_PATH|reference_answer/u);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(environment.calls.runs.length, 1);
});

test("the real Web LocalAgentClient bootstraps with access_token and lists adapters", async (t) => {
  const environment = await fixture();
  t.after(() => environment.close());
  const browserFetch = (url, options = {}) => fetch(url, {
    ...options,
    headers: {
      ...Object.fromEntries(new Headers(options.headers || {}).entries()),
      Origin: environment.runtime.origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });
  const client = new LocalAgentClient({
    origin: environment.runtime.origin,
    fetchImpl: browserFetch,
    idFactory: () => "browser-contract-1",
  });
  const connected = await client.connect();
  assert.equal(connected.connected, true);
  assert.equal(connected.protocol, LOOPBACK_PROTOCOL);
  assert.equal(connected.instance_id, environment.runtime.instanceId);
  assert.equal(connected.adapters.length, 5);
  assert.equal(connected.adapters.find(({ id }) => id === "qwen-code").state, "ready");
  const coaching = await client.coach({
    phase: "submission",
    engine: "qwen-code",
    publicQuestion: structuredClone(QUESTION),
    trustedGrade: structuredClone(GRADE),
    deidentifiedProgress: structuredClone(PROGRESS),
  });
  assert.equal(coaching.engine, "qwen-code");
  assert.match(coaching.coaching_text, /different retest/u);
});

test("--open uses an argument array with shell disabled and only loopback URLs", () => {
  const calls = [];
  const child = { once() {}, unref() {} };
  const opened = openRuntimeUrl("http://127.0.0.1:43127/", {
    platform: "darwin",
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.equal(opened, true);
  assert.deepEqual(calls, [{
    command: "/usr/bin/open",
    args: ["http://127.0.0.1:43127/"],
    options: { detached: true, shell: false, stdio: "ignore" },
  }]);
  assert.equal(openRuntimeUrl("https://example.com/", { spawnImpl: () => child }), false);
  assert.equal(openRuntimeUrl("http://127.0.0.1:80/", { spawnImpl: () => child }), false);
});
