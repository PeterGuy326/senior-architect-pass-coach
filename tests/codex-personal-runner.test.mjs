import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_PERSONAL_AUDITED_VERSIONS,
  CODEX_DISABLED_FEATURES,
  CODEX_PERSONAL_MODE,
  SUBMIT_COACHING_PLAN_SCHEMA,
  CodexPersonalRunner,
  attestCodexModelPreferences,
  parseCodexJsonl,
  probeCodexPersonalMode,
  runBoundedProcess,
} from "../service/codex-personal-runner.mjs";

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

function jsonlValue(value) {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: JSON.stringify(value) },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 8 } }),
    "",
  ].join("\n");
}

function jsonl(coachingText = "先复盘可用性故障模式，再做一道异题复测。") {
  return jsonlValue({ coaching_text: coachingText });
}

function planJsonl(plan = {
  focus: "failure_mode_mapping",
  method: "contrast_table",
  next_step: "same_topic_retest",
}) {
  return jsonlValue({ coaching_plan: plan });
}

function readyProbe() {
  return {
    mode: CODEX_PERSONAL_MODE,
    engine: "codex",
    status: "ready",
    available: true,
    selectable: true,
    version: "0.146.0",
    authentication: "existing_local_codex_login",
    adapter_status: "experimental_personal",
    qualified_adapter: false,
    reason_codes: ["digital_employee_adapter_unqualified", "personal_saved_login_reused"],
    model_preferences: JSON.parse(MODEL_CATALOG).models.map((model, index) => ({
      id: ["lite", "fast", "balanced", "deep"][index],
      label: ["轻量", "快速", "均衡", "深入"][index],
      model: model.slug,
      reasoning_effort: model.supported_reasoning_levels[0].effort,
      selectable: true,
    })),
  };
}

const MODEL_CATALOG = JSON.stringify({ models: [
  { slug: "gpt-5.4-mini", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
  { slug: "gpt-5.6-luna", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
  { slug: "gpt-5.6-terra", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }] },
  { slug: "gpt-5.6-sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
] });

test("model preferences are attested only from a bounded visible Codex catalog", () => {
  assert.deepEqual(attestCodexModelPreferences(MODEL_CATALOG).map(({ id }) => id), ["lite", "fast", "balanced", "deep"]);
  assert.deepEqual(attestCodexModelPreferences(JSON.stringify({ models: [
    { slug: "gpt-5.4-mini", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "attacker-model", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
  ] })), []);
});

async function authFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-personal-test-"));
  const authFile = path.join(root, "auth.json");
  await writeFile(authFile, "AUTH_CONTENT_MUST_NOT_ENTER_PROMPT", { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, authFile };
}

test("probe reports only an audited saved-login personal mode without claiming adapter qualification", async (t) => {
  const { root, authFile } = await authFixture(t);
  const calls = [];
  const processRunner = async (request) => {
    calls.push(request);
    if (request.args[0] === "--version") {
      return { exitCode: 0, signal: null, stdout: "codex-cli 0.146.0\n", stderr: "" };
    }
    if (request.args[0] === "exec") {
      return {
        exitCode: 0,
        signal: null,
        stdout: "--disable --ephemeral --ignore-rules --ignore-user-config --json --output-schema --skip-git-repo-check --strict-config",
        stderr: "",
      };
    }
    if (request.args[0] === "debug") return { exitCode: 0, signal: null, stdout: MODEL_CATALOG, stderr: "" };
    return { exitCode: 0, signal: null, stdout: "Logged in using ChatGPT\n", stderr: "" };
  };

  const result = await probeCodexPersonalMode({
    processRunner,
    environment: { HOME: root, PATH: "/bin" },
    userCodexHome: root,
    authFile,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.available, true);
  assert.equal(result.version, "0.146.0");
  assert.equal(result.qualified_adapter, false);
  assert.equal(result.adapter_status, "experimental_personal");
  assert.ok(result.reason_codes.includes("digital_employee_adapter_unqualified"));
  assert.deepEqual(CODEX_PERSONAL_AUDITED_VERSIONS, ["0.146.0", "0.147.0"]);
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["exec", "--help"], ["debug", "models"], ["login", "status"]]);
  assert.deepEqual(result.model_preferences.map(({ id }) => id), ["lite", "fast", "balanced", "deep"]);
  assert.equal(result.default_model_preference, "fast");
  assert.doesNotMatch(JSON.stringify(result), /Logged in|ChatGPT/u);
});

test("probe distinguishes missing login from a missing executable", async (t) => {
  const { root, authFile } = await authFixture(t);
  const needsLogin = await probeCodexPersonalMode({
    userCodexHome: root,
    authFile,
    processRunner: async ({ args }) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "codex-cli 0.146.0", stderr: "" };
      }
      if (args[0] === "exec") {
        return {
          exitCode: 0,
          stdout: "--disable --ephemeral --ignore-rules --ignore-user-config --json --output-schema --skip-git-repo-check --strict-config",
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "not logged in" };
    },
  });
  assert.equal(needsLogin.status, "needs_login");
  assert.ok(needsLogin.reason_codes.includes("codex_login_required"));

  const missing = await probeCodexPersonalMode({
    processRunner: async () => {
      throw Object.assign(new Error("missing"), { details: { reason_code: "codex_not_found" } });
    },
  });
  assert.equal(missing.status, "unavailable");
  assert.ok(missing.reason_codes.includes("codex_not_found"));
});

test("probe rejects unaudited versions, unsafe auth, and missing command flags", async (t) => {
  const { root, authFile } = await authFixture(t);
  const unaudited = await probeCodexPersonalMode({
    userCodexHome: root,
    authFile,
    processRunner: async () => ({ exitCode: 0, stdout: "codex-cli 0.148.0", stderr: "" }),
  });
  assert.equal(unaudited.status, "incompatible");
  assert.ok(unaudited.reason_codes.includes("codex_version_not_audited"));

  await chmod(authFile, 0o644);
  const unsafe = await probeCodexPersonalMode({
    userCodexHome: root,
    authFile,
    processRunner: async () => ({ exitCode: 0, stdout: "codex-cli 0.146.0", stderr: "" }),
  });
  assert.equal(unsafe.status, "incompatible");
  assert.ok(unsafe.reason_codes.includes("codex_auth_file_unsafe"));

  await chmod(authFile, 0o600);
  const missingFlag = await probeCodexPersonalMode({
    userCodexHome: root,
    authFile,
    processRunner: async ({ args }) => args[0] === "--version"
      ? { exitCode: 0, stdout: "codex-cli 0.146.0", stderr: "" }
      : { exitCode: 0, stdout: "--json only", stderr: "" },
  });
  assert.equal(missingFlag.status, "incompatible");
  assert.ok(missingFlag.reason_codes.includes("codex_command_surface_unsupported"));
});

test("personal runner isolates HOME, reuses auth by symlink, and treats the model as text-only", async (t) => {
  const { authFile } = await authFixture(t);
  let isolatedRoot;
  const processRunner = async (request) => {
    assert.equal(request.args.at(-1), "-");
    assert.ok(request.args.includes("exec"));
    assert.ok(request.args.includes("--json"));
    assert.ok(request.args.includes("--ephemeral"));
    assert.ok(request.args.includes("--ignore-user-config"));
    assert.ok(request.args.includes("--ignore-rules"));
    assert.ok(request.args.includes("--strict-config"));
    assert.ok(request.args.includes("--output-schema"));
    assert.ok(request.args.includes("--skip-git-repo-check"));
    assert.ok(request.args.includes("permissions.employee-context-only.network.enabled=false"));
    for (const feature of CODEX_DISABLED_FEATURES) {
      const index = request.args.findIndex((entry, candidate) => (
        entry === "--disable" && request.args[candidate + 1] === feature
      ));
      assert.notEqual(index, -1, `missing --disable ${feature}`);
    }
    assert.equal(request.args.includes("-p"), false, "Codex -p is a profile flag, not prompt input");
    assert.notEqual(request.env.HOME, process.env.HOME);
    assert.equal(request.env.OPENAI_API_KEY, undefined);
    assert.equal(request.env.CODEX_API_KEY, undefined);
    assert.equal(request.cwd, request.args[request.args.indexOf("--cd") + 1]);
    isolatedRoot = path.dirname(request.env.HOME);
    const linkedAuth = path.join(request.env.CODEX_HOME, "auth.json");
    assert.equal((await lstat(linkedAuth)).isSymbolicLink(), true);
    assert.equal(await readlink(linkedAuth), authFile);
    const schemaPath = request.args[request.args.indexOf("--output-schema") + 1];
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    assert.deepEqual(schema.required, ["coaching_text"]);
    assert.equal(schema.additionalProperties, false);
    assert.doesNotMatch(request.stdin, /AUTH_CONTENT_MUST_NOT_ENTER_PROMPT/u);
    assert.match(request.stdin, /不要调用任何工具/u);
    return { exitCode: 0, signal: null, stdout: jsonl(), stderr: "" };
  };
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    processRunner,
    probe: async () => readyProbe(),
    personalAuthConsent: true,
    environment: { ...process.env, OPENAI_API_KEY: "must-be-filtered" },
  });

  const output = await runner.run(reviewInput(), { runId: "turn-1" });

  assert.equal(output.teaching_result.summary, "先复盘可用性故障模式，再做一道异题复测。");
  assert.deepEqual(output.teaching_result.learning_items, []);
  assert.deepEqual(output.teaching_result.assessments, []);
  assert.deepEqual(output.proposed_progress_events, []);
  await assert.rejects(lstat(isolatedRoot), (error) => error.code === "ENOENT");
});

test("an attested preference is passed as model plus bounded reasoning config", async (t) => {
  const { authFile } = await authFixture(t);
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    processRunner: async (request) => {
      assert.equal(request.args[request.args.indexOf("--model") + 1], "gpt-5.4-mini");
      const reasoningIndex = request.args.findIndex((entry) => entry === "model_reasoning_effort=\"low\"");
      assert.ok(reasoningIndex > 0);
      assert.equal(request.args[reasoningIndex - 1], "-c");
      return { exitCode: 0, signal: null, stdout: jsonl(), stderr: "" };
    },
    probe: async () => readyProbe(),
    personalAuthConsent: true,
  });
  await runner.run(reviewInput());
});

test("submit output copies grade, feedback, and progress facts only from trusted input", async (t) => {
  const { authFile } = await authFixture(t);
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    processRunner: async (request) => {
      const schemaPath = request.args[request.args.indexOf("--output-schema") + 1];
      const schema = JSON.parse(await readFile(schemaPath, "utf8"));
      assert.deepEqual(schema, SUBMIT_COACHING_PLAN_SCHEMA);
      assert.match(request.stdin, /"topic_id":"availability"/u);
      assert.match(request.stdin, /"result":"not_mastered"/u);
      assert.doesNotMatch(request.stdin, /Which tactic|Tactic A|Tactic B/u);
      assert.doesNotMatch(request.stdin, /reference_answer|explanation|active_item|submission|learner_message/u);
      assert.doesNotMatch(request.stdin, /Availability tactics must match|"response":"A"/u);
      return {
        exitCode: 0,
        signal: null,
        stdout: planJsonl(),
        stderr: "",
      };
    },
    probe: async () => readyProbe(),
    personalAuthConsent: true,
  });

  const output = await runner.run(submitInput());

  assert.deepEqual(output.teaching_result.feedback[0], {
    item_id: TRUSTED_GRADE.item_id,
    result: TRUSTED_GRADE.result,
    reference_answer: TRUSTED_GRADE.reference_answer,
    explanation: TRUSTED_GRADE.explanation,
    source_refs: [...TRUSTED_GRADE.source_refs],
  });
  assert.equal(output.teaching_result.assessments[0].result, TRUSTED_GRADE.result);
  assert.equal(output.proposed_progress_events[0].result, TRUSTED_GRADE.result);
  assert.equal(output.proposed_progress_events[0].event_type, "practice_result");
  assert.equal(output.teaching_result.state_write_performed, false);
  assert.equal(
    output.teaching_result.summary,
    "本题已进入优先补强队列。针对 availability：先把失效模式映射到对应战术，再做一张两列对照表，最后做一道同考点异题复测。",
  );
});

test("personal auth use is opt-in even when Codex is installed and logged in", async (t) => {
  const { authFile } = await authFixture(t);
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    probe: async () => readyProbe(),
  });
  const preflight = await runner.preflight();
  assert.equal(preflight.consent_required, true);
  await assert.rejects(
    runner.run(reviewInput()),
    (error) => error.code === "CODEX_PERSONAL_CONSENT_REQUIRED",
  );
});

test("personal runner rejects pre-answer practice and submit free text", async (t) => {
  const { authFile } = await authFixture(t);
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    processRunner: async () => ({
      exitCode: 0,
      signal: null,
      stdout: jsonlValue({
        coaching_plan: {
          focus: "failure_mode_mapping",
          method: "contrast_table",
          next_step: "same_topic_retest",
        },
        coaching_text: "A 才符合该故障模式。",
      }),
      stderr: "",
    }),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
  });
  await assert.rejects(
    runner.run(practiceInput()),
    (error) => error.code === "CODEX_PERSONAL_ACTION_UNSUPPORTED",
  );
  await assert.rejects(
    runner.run(submitInput()),
    (error) => error.code === "CODEX_PERSONAL_OUTPUT_INVALID",
  );
});

test("JSONL parser rejects malformed, unknown, tool, nonterminal, and extra-shape output", () => {
  const cases = [
    "{not-json}\n",
    [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "mystery.event" }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n"),
    [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pwd" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n"),
    [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify({ coaching_text: "继续练习。" }) },
      }),
    ].join("\n"),
    [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({ coaching_text: "继续练习。", invented_grade: "mastered" }),
        },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n"),
  ];
  for (const value of cases) assert.throws(() => parseCodexJsonl(value), CoachErrorLike);
  assert.throws(
    () => parseCodexJsonl(planJsonl({
      focus: "invented_focus",
      method: "contrast_table",
      next_step: "same_topic_retest",
    }), { action: "submit" }),
    CoachErrorLike,
  );
});

function CoachErrorLike(error) {
  return typeof error?.code === "string" && error.code.startsWith("CODEX_PERSONAL_");
}

test("successful exit with stderr is rejected and never returned to the caller", async (t) => {
  const { authFile } = await authFixture(t);
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    processRunner: async () => ({
      exitCode: 0,
      signal: null,
      stdout: jsonl(),
      stderr: "sensitive diagnostic must not escape",
    }),
    probe: async () => readyProbe(),
    personalAuthConsent: true,
  });
  await assert.rejects(
    runner.run(reviewInput()),
    (error) => (
      error.code === "CODEX_PERSONAL_UNEXPECTED_STDERR"
      && !error.message.includes("sensitive diagnostic")
    ),
  );
});

test("runner fails closed when an exact model preference is not attested", async (t) => {
  const { authFile } = await authFixture(t);
  let runs = 0;
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    processRunner: async () => {
      runs += 1;
      return { exitCode: 0, signal: null, stdout: jsonl(), stderr: "" };
    },
    probe: async () => ({ ...readyProbe(), model_preferences: [] }),
    personalAuthConsent: true,
  });
  await assert.rejects(
    runner.run(reviewInput()),
    (error) => error.code === "CODEX_PERSONAL_MODEL_NOT_ATTESTED",
  );
  assert.equal(runs, 0);
});

test("lite never falls back to Luna when the live catalog drops Mini", async (t) => {
  const { authFile } = await authFixture(t);
  let runs = 0;
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    processRunner: async () => {
      runs += 1;
      return { exitCode: 0, signal: null, stdout: jsonl(), stderr: "" };
    },
    probe: async () => ({
      ...readyProbe(),
      model_preferences: readyProbe().model_preferences.filter(({ id }) => id === "fast"),
      default_model_preference: "fast",
    }),
    personalAuthConsent: true,
  });
  await assert.rejects(
    runner.run(reviewInput()),
    (error) => error.code === "CODEX_PERSONAL_MODEL_NOT_ATTESTED",
  );
  assert.equal(runs, 0);
});

test("every turn reattests the Codex command surface before model execution", async (t) => {
  const { root, authFile } = await authFixture(t);
  let commandSurfaceSupported = true;
  let modelExecutions = 0;
  const processRunner = async ({ args }) => {
    if (args[0] === "--version") {
      return { exitCode: 0, signal: null, stdout: "codex-cli 0.146.0\n", stderr: "" };
    }
    if (args[0] === "exec" && args[1] === "--help") {
      return {
        exitCode: 0,
        signal: null,
        stdout: commandSurfaceSupported
          ? "--disable --ephemeral --ignore-rules --ignore-user-config --json --output-schema --skip-git-repo-check --strict-config"
          : "--disable --ephemeral --ignore-rules --ignore-user-config --json --output-schema --skip-git-repo-check",
        stderr: "",
      };
    }
    if (args[0] === "debug") {
      return { exitCode: 0, signal: null, stdout: MODEL_CATALOG, stderr: "" };
    }
    if (args[0] === "login") {
      return { exitCode: 0, signal: null, stdout: "logged in", stderr: "" };
    }
    modelExecutions += 1;
    return { exitCode: 0, signal: null, stdout: jsonl(), stderr: "" };
  };

  const inspected = await probeCodexPersonalMode({
    processRunner,
    environment: { HOME: root, PATH: "/bin" },
    userCodexHome: root,
    authFile,
  });
  assert.equal(inspected.status, "ready");

  commandSurfaceSupported = false;
  const runner = new CodexPersonalRunner({
    authFile,
    modelPreference: "lite",
    processRunner,
    environment: { HOME: root, PATH: "/bin" },
    userCodexHome: root,
    personalAuthConsent: true,
  });
  await assert.rejects(
    runner.run(reviewInput()),
    (error) => error.code === "CODEX_PERSONAL_UNAVAILABLE",
  );
  assert.equal(modelExecutions, 0);
});

test("bounded process terminates output overflow, timeout, and external cancellation", async () => {
  await assert.rejects(
    runBoundedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      timeoutMs: 30_000,
      maxStdoutBytes: 64,
      maxStderrBytes: 64,
    }),
    (error) => error.code === "CODEX_PERSONAL_STDOUT_LIMIT",
  );

  await assert.rejects(
    runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
      maxStdoutBytes: 64,
      maxStderrBytes: 64,
    }),
    (error) => error.code === "CODEX_PERSONAL_TIMEOUT",
  );

  const controller = new AbortController();
  const pending = runBoundedProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 5_000,
    maxStdoutBytes: 64,
    maxStderrBytes: 64,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "CODEX_PERSONAL_CANCELLED");

  if (process.platform !== "win32") {
    await assert.rejects(
      runBoundedProcess({
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        timeoutMs: 100,
        killGraceMs: 20,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
        processKill: () => { throw new Error("force child.kill fallback"); },
      }),
      (error) => error.code === "CODEX_PERSONAL_TIMEOUT",
    );
  }
});
