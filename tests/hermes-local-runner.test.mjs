import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import {
  HERMES_LOCAL_MODE,
  HermesLocalRunner,
  assertHermesCoachingText,
  probeHermesLocalMode,
  publicHermesLocalAdapter,
  runHermesProcess,
} from "../service/hermes-local-runner.mjs";

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

const TRUSTED_GRADE = Object.freeze({
  item_id: QUESTION.item_id,
  subject: QUESTION.subject,
  topic_id: QUESTION.topic_id,
  result: "not_mastered",
  reference_answer: "B",
  explanation: "Availability tactics must match the actual failure mode.",
  source_refs: Object.freeze([...QUESTION.source_refs]),
});

function practiceInput() {
  return {
    schema_version: "architect-pass-coach-input.v1",
    action: "practice",
    context: { authenticated: true },
    request: {
      mode: "generate",
      subject: QUESTION.subject,
      topic_ids: [QUESTION.topic_id],
      question_ids: [QUESTION.item_id],
      progress_snapshot: structuredClone(PROGRESS),
      active_item: structuredClone(QUESTION),
      approved_materials: [{
        source_id: "senior-software-architect-review",
        locator: `question:${QUESTION.item_id}`,
        excerpt: "The public question is bound in request.active_item.",
      }],
    },
  };
}

function reviewInput() {
  return {
    schema_version: "architect-pass-coach-input.v1",
    action: "review",
    context: { authenticated: true },
    request: {
      mode: "generate",
      message: "如何复习可用性战术？",
      progress_snapshot: structuredClone(PROGRESS),
    },
  };
}

function submitInput() {
  const input = practiceInput();
  input.action = "submit";
  input.request.mode = "evaluate";
  input.request.submission = { item_id: QUESTION.item_id, response: "A" };
  input.request.approved_materials[0].excerpt = JSON.stringify({ trusted_grade: TRUSTED_GRADE });
  return input;
}

// Hermes -z prints the model text directly, with no envelope.
function coachingText(text = "先复盘可用性故障模式，再做一道异题复测。") {
  return JSON.stringify({ coaching_text: text });
}

function planText(plan = {
  focus: "failure_mode_mapping",
  method: "contrast_table",
  next_step: "same_topic_retest",
}) {
  return JSON.stringify({ coaching_plan: plan });
}

const STATUS_TEXT = [
  "┌─────────────────────────────────────────────────────────┐",
  "│                 ⚕ Hermes Agent Status                  │",
  "└─────────────────────────────────────────────────────────┘",
  "",
  "◆ Environment",
  "  Project:      /Users/tester/.hermes/hermes-agent",
  "  Python:       3.11.14",
  "  .env file:    ✓ exists",
  "  Model:        qwen3-max",
  "  Provider:     custom:idealab",
  "",
  "◆ API Keys",
  "  OpenRouter    ✗ (not set)",
  "  Z.AI / GLM    ✓ 35e5...9Duf",
  "  GitHub        ✗ (not set)",
  "",
  "◆ API-Key Providers",
  "  Z.AI / GLM       ✓ configured",
  "  Kimi / Moonshot  ✗ not configured (run: hermes model)",
  "",
].join("\n");

function readyProbe() {
  return {
    mode: HERMES_LOCAL_MODE,
    engine: "hermes",
    status: "ready",
    available: true,
    selectable: true,
    version: "0.20.1",
    authentication: "existing_local_hermes_login",
    adapter_status: "experimental_personal",
    qualified_adapter: false,
    reason_codes: ["digital_employee_adapter_unqualified", "hermes_local_login_reused"],
  };
}

function recordingRunner(requests, stdout, overrides = {}) {
  return async (request) => {
    requests.push(request);
    return { exitCode: 0, signal: null, stdout, stderr: "", ...overrides };
  };
}

test("probe reports the saved Hermes login without claiming adapter qualification", async () => {
  const calls = [];
  const result = await probeHermesLocalMode({
    processRunner: async (request) => {
      calls.push(request);
      if (request.args[0] === "--version") {
        return {
          exitCode: 0,
          signal: null,
          stdout: "Hermes Agent v0.20.1 (2026.8.13)\nInstall directory: /Users/tester/.hermes/hermes-agent",
          stderr: "",
        };
      }
      return { exitCode: 0, signal: null, stdout: STATUS_TEXT, stderr: "" };
    },
    environment: { HOME: "/home/tester", PATH: "/bin" },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.available, true);
  assert.equal(result.selectable, true);
  assert.equal(result.version, "0.20.1");
  assert.equal(result.engine, "hermes");
  assert.equal(result.qualified_adapter, false);
  assert.equal(result.adapter_status, "experimental_personal");
  assert.ok(result.reason_codes.includes("digital_employee_adapter_unqualified"));
  assert.ok(result.reason_codes.includes("hermes_local_login_reused"));
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["status"]]);
  assert.equal(calls[0].env.HOME, "/home/tester");
  assert.doesNotMatch(JSON.stringify(result), /35e5/u, "credential fragments must never leak");
});

test("probe distinguishes missing login from a missing executable", async () => {
  const needsLogin = await probeHermesLocalMode({
    processRunner: async (request) => ({
      exitCode: 0,
      signal: null,
      stdout: request.args[0] === "--version"
        ? "Hermes Agent v0.20.1 (2026.8.13)"
        : STATUS_TEXT.replace(/✓ 35e5\.\.\.9Duf/u, "✗ (not set)").replace(/✓ configured/u, "✗ not configured"),
      stderr: "",
    }),
  });
  assert.equal(needsLogin.status, "needs_login");
  assert.ok(needsLogin.reason_codes.includes("hermes_login_required"));
  assert.equal(needsLogin.available, false);

  const missing = await probeHermesLocalMode({
    processRunner: async () => {
      throw Object.assign(new Error("missing"), { details: { reason_code: "hermes_not_found" } });
    },
  });
  assert.equal(missing.status, "unavailable");
  assert.ok(missing.reason_codes.includes("hermes_not_found"));

  const versionFailed = await probeHermesLocalMode({
    processRunner: async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "boom" }),
  });
  assert.equal(versionFailed.status, "unavailable");
  assert.ok(versionFailed.reason_codes.includes("hermes_version_probe_failed"));

  const invalid = await probeHermesLocalMode({
    processRunner: async (request) => ({
      exitCode: 0,
      signal: null,
      stdout: request.args[0] === "--version" ? "Hermes Agent v0.20.1 (2026.8.13)" : "garbage output",
      stderr: "",
    }),
  });
  assert.equal(invalid.status, "unavailable");
  assert.ok(invalid.reason_codes.includes("hermes_status_invalid"));
});

test("public adapter maps probe states to the consent-gated personal adapter", () => {
  const entry = { id: "hermes", label: "Hermes Agent" };
  const unconsented = publicHermesLocalAdapter(entry, readyProbe(), { consented: false });
  assert.equal(unconsented.state, "consent_required");
  assert.equal(unconsented.selectable, false);
  assert.equal(unconsented.execution_mode, "personal_experimental");
  assert.equal(unconsented.framework_adapter_status, "probe_only");
  assert.equal(unconsented.adapter_status, "experimental_personal");
  assert.ok(unconsented.reason_codes.includes("hermes_local_consent_required"));

  const consented = publicHermesLocalAdapter(entry, readyProbe(), { consented: true });
  assert.equal(consented.state, "experimental_personal");
  assert.equal(consented.selectable, true);

  const loggedOut = publicHermesLocalAdapter(entry, {
    ...readyProbe(),
    status: "needs_login",
    available: false,
    selectable: false,
    reason_codes: ["digital_employee_adapter_unqualified", "hermes_login_required"],
  }, { consented: true });
  assert.equal(loggedOut.state, "needs_login");
  assert.equal(loggedOut.selectable, false);
  assert.equal(loggedOut.host_status, "not_ready");
});

test("runner reuses the machine login, filters env, and parses the raw model text", async (t) => {
  const requests = [];
  const runner = new HermesLocalRunner({
    processRunner: recordingRunner(requests, coachingText()),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
    environment: {
      ...process.env,
      OPENAI_API_KEY: "must-be-filtered",
      XAI_API_KEY: "must-be-filtered",
      HERMES_LANGFUSE_PUBLIC_KEY: "must-be-filtered",
    },
  });
  const output = await runner.run(reviewInput(), { runId: "turn-1" });
  assert.equal(output.teaching_result.summary, "先复盘可用性故障模式，再做一道异题复测。");
  assert.equal(output.teaching_result.answer_visibility, "hidden");
  assert.equal(output.teaching_result.state_write_performed, false);
  assert.deepEqual(output.proposed_progress_events, []);

  assert.deepEqual(requests.length, 1);
  const request = requests[0];
  assert.deepEqual(request.args.slice(0, 6), [
    "--ignore-user-config",
    "--ignore-rules",
    "--safe-mode",
    "-t",
    "x_search",
    "-z",
  ]);
  assert.equal(request.args.length, 7);
  assert.equal(request.env.HOME, process.env.HOME, "the real Hermes login must be inherited");
  assert.equal(request.env.USERPROFILE, process.env.HOME);
  assert.equal(request.env.OPENAI_API_KEY, undefined);
  assert.equal(request.env.XAI_API_KEY, undefined);
  assert.equal(request.env.HERMES_LANGFUSE_PUBLIC_KEY, undefined);
  assert.equal(request.env.NO_COLOR, "1");
  assert.equal(request.env.TERM, "dumb");
  assert.match(request.args.at(-1), /只回答复习方法与下一步行动/u);
  assert.match(request.args.at(-1), /不要调用任何工具/u);
  assert.doesNotMatch(request.args.at(-1), /active_item/u);
  assert.equal(typeof request.cwd, "string");
  assert.ok(request.cwd.startsWith(os.tmpdir()), "scratch dir lives under the system temp dir");
  assert.ok(request.cwd.includes("architect-pass-coach-hermes-"));
  assert.notEqual(request.cwd, process.env.HOME);
});

test("practice mode binds the public question but keeps the answer secret", async () => {
  const requests = [];
  const runner = new HermesLocalRunner({
    processRunner: recordingRunner(requests, coachingText("先按故障场景分类这题的考点。")),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  const output = await runner.run(practiceInput(), { runId: "turn-2" });
  assert.equal(output.teaching_result.summary, "先按故障场景分类这题的考点。");
  assert.equal(output.teaching_result.answer_visibility, "hidden");
  assert.deepEqual(output.teaching_result.learning_items, [QUESTION]);
  const prompt = requests[0].args.at(-1);
  assert.match(prompt, /当前题目/u);
  assert.match(prompt, /Which tactic best supports/u);
  assert.match(prompt, /Tactic A/u, "the public question options are bound for guidance");
  assert.doesNotMatch(prompt, /reference_answer|trusted_grade/u);
});

test("submit mode renders a local plan and never leaks the answer into the prompt", async () => {
  const requests = [];
  const runner = new HermesLocalRunner({
    processRunner: recordingRunner(requests, planText()),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  const output = await runner.run(submitInput(), { runId: "turn-3" });
  assert.equal(
    output.teaching_result.summary,
    "本题已进入优先补强队列。针对 availability：先把失效模式映射到对应战术，再做一张两列对照表，最后做一道同考点异题复测。",
  );
  assert.equal(output.teaching_result.answer_visibility, "revealed_after_submission");
  assert.deepEqual(output.teaching_result.feedback, [{
    item_id: TRUSTED_GRADE.item_id,
    result: TRUSTED_GRADE.result,
    reference_answer: TRUSTED_GRADE.reference_answer,
    explanation: TRUSTED_GRADE.explanation,
    source_refs: [...TRUSTED_GRADE.source_refs],
  }]);
  assert.deepEqual(output.teaching_result.assessments, [{
    subject: TRUSTED_GRADE.subject,
    topic_id: TRUSTED_GRADE.topic_id,
    result: TRUSTED_GRADE.result,
    evidence: "本地可信答案键与答题行为判定：尚未掌握。",
  }]);
  assert.deepEqual(output.proposed_progress_events, [{
    schema_version: "progress-event-proposal.v1",
    event_type: "practice_result",
    subject: TRUSTED_GRADE.subject,
    topic_id: TRUSTED_GRADE.topic_id,
    result: TRUSTED_GRADE.result,
    evidence: { item_id: TRUSTED_GRADE.item_id, summary: "本地可信判定：尚未掌握" },
    proposal_only: true,
    requires_authenticated_context: true,
  }]);
  const prompt = requests[0].args.at(-1);
  assert.match(prompt, /coaching_plan/u);
  assert.match(prompt, /"focus".*"method".*"next_step"/su, "the plan schema enums must be inlined, hermes -z has no schema flag");
  assert.match(prompt, /failure_mode_mapping|concept_boundary|scenario_transfer|tradeoff_comparison/u);
  assert.match(prompt, /contrast_table|micro_drill|one_page_map|teach_back/u);
  assert.match(prompt, /same_topic_retest|review_tomorrow|mixed_topic_retest/u);
  assert.doesNotMatch(prompt, /reference_answer|explanation|trusted_grade|Which tactic/u);
  assert.doesNotMatch(prompt, /["']B["']/u, "the reference answer letter must never enter the prompt");
});

test("runner strips markdown fences and rejects malformed model text", async () => {
  const fenced = new HermesLocalRunner({
    processRunner: recordingRunner([], "```json\n{\"coaching_text\":\"先做一张对照表。\"}\n```"),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  const output = await fenced.run(reviewInput(), { runId: "turn-4" });
  assert.equal(output.teaching_result.summary, "先做一张对照表。");

  const prose = new HermesLocalRunner({
    processRunner: recordingRunner([], "好的，我建议你先复习一下。"),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  await assert.rejects(prose.run(reviewInput(), { runId: "turn-5" }), (error) => (
    error?.code === "HERMES_LOCAL_OUTPUT_INVALID"
  ));
});

test("answer assertions reject any restatement of the answer in model text", () => {
  assert.equal(assertHermesCoachingText("先按故障树逐层排查。"), "先按故障树逐层排查。");
  for (const text of ["正确答案是 B", "这道题应该选 A", "解析：", "排除 C", "选项 D 更合适", "The answer is B"]) {
    assert.throws(() => assertHermesCoachingText(text), (error) => error?.code === "HERMES_LOCAL_ANSWER_ASSERTION_REJECTED");
  }
});

test("runner refuses runs without explicit consent and fails closed on probe errors", async () => {
  const requests = [];
  const unconsented = new HermesLocalRunner({
    processRunner: recordingRunner(requests, coachingText()),
    probe: async () => readyProbe(),
    personalAuthConsent: false,
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  await assert.rejects(unconsented.run(reviewInput(), { runId: "turn-6" }), (error) => (
    error?.code === "HERMES_LOCAL_CONSENT_REQUIRED"
  ));
  assert.equal(requests.length, 0);

  const notLoggedIn = new HermesLocalRunner({
    processRunner: recordingRunner(requests, coachingText()),
    probe: async () => ({ ...readyProbe(), status: "needs_login", available: false }),
    personalAuthConsent: true,
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  await assert.rejects(notLoggedIn.run(reviewInput(), { runId: "turn-7" }), (error) => (
    error?.code === "HERMES_LOCAL_LOGIN_REQUIRED"
  ));

  const processFailed = new HermesLocalRunner({
    processRunner: async () => ({ exitCode: 2, signal: null, stdout: "", stderr: "boom" }),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  await assert.rejects(processFailed.run(reviewInput(), { runId: "turn-8" }), (error) => (
    error?.code === "HERMES_LOCAL_PROCESS_FAILED"
  ));

  const stderrNoise = new HermesLocalRunner({
    processRunner: async () => ({ exitCode: 0, signal: null, stdout: coachingText(), stderr: "notice" }),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  await assert.rejects(stderrNoise.run(reviewInput(), { runId: "turn-9" }), (error) => (
    error?.code === "HERMES_LOCAL_UNEXPECTED_STDERR"
  ));
});

test("runHermesProcess enforces byte bounds and cancellation", async (t) => {
  const { spawn } = await import("node:child_process");
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = spawn(command, args, options);
    return child;
  };
  const result = await runHermesProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    env: { HOME: os.homedir(), PATH: process.env.PATH },
    spawnImpl,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");

  const big = await runHermesProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(2000))"],
    env: { HOME: os.homedir(), PATH: process.env.PATH },
    maxStdoutBytes: 100,
    spawnImpl,
  }).then(() => null, (error) => error);
  assert.equal(big?.code, "HERMES_LOCAL_STDOUT_LIMIT");
});
