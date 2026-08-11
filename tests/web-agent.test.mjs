import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMemoryCoachStore } from "../docs/src/indexeddb-store.mjs";
import { createBrowserCoach } from "../docs/src/harness.mjs";
import {
  LOOPBACK_PROTOCOL,
  createLocalAgentClient,
  isLocalAgentRuntimeOrigin,
} from "../docs/src/local-agent-client.mjs";
import { objectiveResult } from "../docs/src/progress-rules.mjs";

const curriculumUrl = new URL("../docs/data/curriculum.json", import.meta.url);

function idFactory() {
  let count = 0;
  return () => `agent-fixture-${String(++count).padStart(8, "0")}`;
}

function fixtureWorker(events = []) {
  const issued = new Map();
  return async (request) => {
    if (request.type === "issue") {
      const itemId = `agent-fixture:${request.payload.task.topic_id}`;
      const contentRef = {
        schema_version: "web-objective-content-ref.v1",
        relative_path: "private/path-must-not-reach-agent.md",
        question_number: 1,
        topic_id: request.payload.task.topic_id,
        subject: "comprehensive",
        item_id: itemId,
        content_revision: "sha256:agent-fixture",
      };
      const publicQuestion = {
        item_id: itemId,
        kind: "multiple_choice",
        subject: "comprehensive",
        topic_id: request.payload.task.topic_id,
        prompt: "以下哪一项符合题意？",
        options: [
          { label: "A", text: "选项甲" },
          { label: "B", text: "选项乙" },
        ],
        source_refs: ["senior-software-architect-review"],
      };
      issued.set(itemId, { contentRef, publicQuestion });
      return { id: request.id, ok: true, result: { contentRef, publicQuestion } };
    }
    if (request.type === "rehydrate") {
      return { id: request.id, ok: true, result: issued.get(request.payload.contentRef.item_id) };
    }
    if (request.type === "grade") {
      events.push("grade");
      const contentRef = request.payload.contentRef;
      const selected = String(request.payload.response).toUpperCase();
      const correct = selected === "B";
      return {
        id: request.id,
        ok: true,
        result: {
          grade: {
            schema_version: "web-trusted-objective-grade.v1",
            item_id: contentRef.item_id,
            topic_id: contentRef.topic_id,
            subject: "comprehensive",
            selected_answer: selected,
            reference_answer: "B",
            correct,
            result: objectiveResult({ correct, confidence: request.payload.confidence }),
            score: correct ? 1 : 0,
            max_score: 1,
            explanation: "固定答案解析。",
            source_refs: ["senior-software-architect-review"],
          },
        },
      };
    }
    throw new Error(`unexpected worker request: ${request.type}`);
  };
}

async function createCoach({ store = createMemoryCoachStore(), agentClient = null, agentEngine = "content-only", events = [] } = {}) {
  const curriculum = JSON.parse(await readFile(curriculumUrl, "utf8"));
  return {
    store,
    coach: createBrowserCoach({
      store,
      worker: fixtureWorker(events),
      curriculum,
      agentClient,
      agentEngine,
      clock: () => "2026-08-11T08:00:00.000Z",
      idFactory: idFactory(),
    }),
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("only an exact 127.0.0.1 HTTP origin is eligible for the Agent Runtime", () => {
  assert.equal(isLocalAgentRuntimeOrigin("http://127.0.0.1:4317"), true);
  for (const origin of [
    "https://127.0.0.1:4317",
    "http://localhost:4317",
    "http://0.0.0.0:4317",
    "http://127.0.0.1",
    "https://peterguy326.github.io",
    "http://127.0.0.1:99999",
  ]) assert.equal(isLocalAgentRuntimeOrigin(origin), false, origin);
  assert.throws(() => createLocalAgentClient({ origin: "https://peterguy326.github.io", fetchImpl: () => {} }), {
    code: "LOOPBACK_RUNTIME_REQUIRED",
  });
});

test("the client binds browser-native fetch to the global receiver", async () => {
  const receivers = [];
  const fetchImpl = async function (url) {
    receivers.push(this);
    if (url.endsWith("/v1/bootstrap")) {
      return jsonResponse({ protocol: LOOPBACK_PROTOCOL, access_token: "a".repeat(43), instance_id: "receiver-test" });
    }
    return jsonResponse({ protocol: LOOPBACK_PROTOCOL, adapters: [] });
  };
  const client = createLocalAgentClient({
    origin: "http://127.0.0.1:4317",
    fetchImpl,
  });
  await client.connect();
  assert.deepEqual(receivers, [globalThis, globalThis]);
});

test("Runtime bearer stays inside client memory and is absent from URLs, bodies, connection results and serialization", async () => {
  const token = "runtime-secret-".padEnd(64, "s");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/v1/bootstrap")) {
      return jsonResponse({ protocol: LOOPBACK_PROTOCOL, access_token: token, instance_id: "fixture-runtime" });
    }
    if (url.endsWith("/v1/adapters")) {
      return jsonResponse({
        protocol: LOOPBACK_PROTOCOL,
        adapters: [{ id: "qwen-code", label: "Qwen Code", state: "ready", selectable: true, reason_codes: [] }],
      });
    }
    return jsonResponse({ protocol: LOOPBACK_PROTOCOL, engine: "qwen-code", coaching_text: "专项补强建议。" });
  };
  const client = createLocalAgentClient({
    origin: "http://127.0.0.1:4317",
    fetchImpl,
    idFactory: () => "idempotency-fixture",
  });
  const connected = await client.connect();
  assert.equal(connected.connected, true);
  assert.equal(Object.hasOwn(connected, "access_token"), false);
  assert.equal(Object.hasOwn(connected, "token"), false);
  assert.equal(JSON.stringify(client).includes(token), false);
  assert.equal(Object.keys(client).length, 0);
  assert.equal(connected.adapters[0].detail, "");
  const clientSource = await readFile(new URL("../docs/src/local-agent-client.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(clientSource, /localStorage|sessionStorage|indexedDB|\.setItem\s*\(/u);

  await client.coach({
    phase: "chat",
    engine: "qwen-code",
    message: "帮我安排下一步",
    deidentifiedProgress: {
      schema_version: "deidentified-progress.v1",
      score_goal: { pass_line: 45, safety_target: 52 },
      knows_progress: false,
      evidence_count: 0,
      subjects: {},
    },
  });
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[2].options.headers.Authorization, `Bearer ${token}`);
  for (const call of calls) {
    assert.equal(call.url.includes(token), false);
    assert.equal(String(call.options.body || "").includes(token), false);
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.headers["X-Coach-Protocol"], LOOPBACK_PROTOCOL);
  }
  const wireBody = JSON.parse(calls[2].options.body);
  assert.equal(wireBody.phase, "chat");
  assert.equal(Object.hasOwn(wireBody, "protocol"), false);
  assert.deepEqual(Object.keys(wireBody.deidentified_progress).sort(), [
    "crunch_mode",
    "days_to_exam",
    "maintenance_subject",
    "recommendations",
    "schema_version",
    "subjects",
    "target_subject",
  ]);
});

test("Runtime failures expose only a stable reason code and local message, never server text", async () => {
  let call = 0;
  const client = createLocalAgentClient({
    origin: "http://127.0.0.1:4317",
    idFactory: () => "stable-request-key",
    fetchImpl: async (url) => {
      call += 1;
      if (url.endsWith("/v1/bootstrap")) {
        return jsonResponse({ protocol: LOOPBACK_PROTOCOL, access_token: "a".repeat(43) });
      }
      if (url.endsWith("/v1/adapters")) {
        return jsonResponse({
          protocol: LOOPBACK_PROTOCOL,
          adapters: [{ id: "qwen-code", label: "Qwen Code", state: "ready", selectable: true }],
        });
      }
      return jsonResponse({
        reason_code: "agent_run_failed",
        message: "OPENAI_API_KEY=/secret and /Users/example/private/path",
      }, 502);
    },
  });
  await client.connect();
  await assert.rejects(client.coach({
    phase: "chat",
    engine: "qwen-code",
    message: "帮我复盘",
    deidentifiedProgress: {
      schema_version: "deidentified-progress.v1",
      subjects: {},
      target_subject: "comprehensive",
      maintenance_subject: null,
      crunch_mode: false,
      days_to_exam: null,
      recommendations: [],
    },
  }), (error) => {
    assert.equal(error.code, "agent_run_failed");
    assert.match(error.message, /本机 Agent/u);
    assert.doesNotMatch(error.message, /OPENAI|Users|secret/u);
    return true;
  });
  assert.equal(call, 3);
});

test("switching Agent execution preference changes no profile, progress, attempt, session, question or revision", async () => {
  const client = { connected: true, coach: async () => ({ coaching_text: "unused", engine: "qwen-code" }) };
  const { coach } = await createCoach({ agentClient: client });
  await coach.initialize();
  const issued = await coach.start();
  const before = await coach.exportData();
  coach.setAgentPreference("qwen-code");
  coach.setAgentPreference("claude-code");
  const afterView = coach.getView();
  const after = await coach.exportData();
  assert.deepEqual(after, before);
  assert.equal(afterView.state, issued.state);
  assert.equal(afterView.revision, issued.revision);
  assert.deepEqual(afterView.question, issued.question);
  assert.equal(afterView.agent.preference, "claude-code");
});

test("trusted grade and atomic progress commit happen before Agent coaching", async () => {
  const events = [];
  const store = createMemoryCoachStore();
  const originalCommit = store.commitAttempt.bind(store);
  store.commitAttempt = async (...args) => {
    events.push("commit:start");
    const result = await originalCommit(...args);
    events.push("commit:done");
    return result;
  };
  let agentPayload;
  const agentClient = {
    connected: true,
    coach: async (payload) => {
      events.push("agent");
      agentPayload = payload;
      assert.equal((await store.exportData({ now: "2026-08-11T08:00:00.000Z" })).attempts.length, 1);
      return { coaching_text: "只针对薄弱点再练一题。", engine: "qwen-code" };
    },
  };
  const { coach } = await createCoach({ store, agentClient, agentEngine: "qwen-code", events });
  await coach.initialize();
  const question = await coach.start();
  const feedback = await coach.answer({
    response: "B",
    confidence: "sure",
    expectedRevision: question.revision,
    expectedItemId: question.question.item_id,
  });
  assert.deepEqual(events.slice(-4), ["grade", "commit:start", "commit:done", "agent"]);
  assert.equal(feedback.feedback.grade.reference_answer, "B");
  assert.equal(feedback.agent.coaching.coaching_text, "只针对薄弱点再练一题。");
  assert.equal(feedback.agent.coaching.engine, "qwen-code");
  const serialized = JSON.stringify(agentPayload);
  assert.equal(serialized.includes("principal_id"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("private/path"), false);
  assert.equal(agentPayload.deidentifiedProgress.schema_version, "deidentified-progress.v1");
  assert.equal(agentPayload.trustedGrade.reference_answer, "B");
  assert.equal(JSON.stringify(await coach.exportData()).includes("只针对薄弱点再练一题"), false);
});

test("Agent failure is an explicit transient fallback and never rolls back trusted progress", async () => {
  const agentClient = {
    connected: true,
    coach: async () => {
      const error = new Error("本机模型暂时离线");
      error.code = "ENGINE_OFFLINE";
      throw error;
    },
  };
  const { coach } = await createCoach({ agentClient, agentEngine: "qwen-code" });
  await coach.initialize();
  const question = await coach.start();
  const feedback = await coach.answer({
    response: "A",
    confidence: "sure",
    expectedRevision: question.revision,
    expectedItemId: question.question.item_id,
  });
  assert.equal(feedback.state, "feedback");
  assert.equal(feedback.feedback.grade.correct, false);
  assert.equal(feedback.agent.coaching, null);
  assert.equal(feedback.agent.failure.code, "ENGINE_OFFLINE");
  const exported = await coach.exportData();
  assert.equal(exported.attempts.length, 1);
  assert.equal(exported.progress.subjects.comprehensive.evidence_count, 1);
  assert.equal(JSON.stringify(exported).includes("本机模型暂时离线"), false);
});

test("content-only remains a full regression path and never invokes Agent", async () => {
  let calls = 0;
  const agentClient = {
    connected: true,
    coach: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  };
  const { coach } = await createCoach({ agentClient, agentEngine: "content-only" });
  await coach.initialize();
  const question = await coach.start();
  const feedback = await coach.answer({
    response: "B",
    confidence: "unsure",
    expectedRevision: question.revision,
    expectedItemId: question.question.item_id,
  });
  assert.equal(calls, 0);
  assert.equal(feedback.state, "feedback");
  assert.equal(feedback.feedback.grade.result, "needs_retest");
  assert.equal(feedback.agent.coaching, null);
  assert.equal((await coach.exportData()).attempts.length, 1);
});

test("free-form Agent chat is bounded and does not write learner progress", async () => {
  let payload;
  const agentClient = {
    connected: true,
    coach: async (value) => {
      payload = value;
      return { coaching_text: `先复盘软件过程模型。${"长".repeat(3_000)}`, engine: "claude-code" };
    },
  };
  const { coach } = await createCoach({ agentClient, agentEngine: "claude-code" });
  await coach.initialize();
  const before = await coach.exportData();
  const reply = await coach.askAgent("今天先补哪块？");
  const after = await coach.exportData();
  assert.deepEqual(after, before);
  assert.equal(payload.phase, "chat");
  assert.equal(payload.message, "今天先补哪块？");
  assert.equal(reply.coaching_text.length, 2_000);
  assert.equal(JSON.stringify(payload).includes("principal_id"), false);
});
