import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMemoryCoachStore } from "../docs/src/indexeddb-store.mjs";
import { buildTimingReceipt } from "../docs/src/chat-view.mjs";
import { createBrowserCoach } from "../docs/src/harness.mjs";
import {
  DEFAULT_RUNTIME_ORIGIN,
  LOOPBACK_PROTOCOL,
  RUNTIME_LAUNCH_URL,
  createLocalAgentClient,
  isLocalAgentRuntimeOrigin,
} from "../docs/src/local-agent-client.mjs";
import { objectiveResult } from "../docs/src/progress-rules.mjs";

const curriculumUrl = new URL("../docs/data/curriculum.json", import.meta.url);
const TEST_WORKSPACE = Object.freeze({
  schema_version: "coach-local-workspace.v1",
  state: "ready",
  employee: Object.freeze({
    name: "senior-architect-pass-coach",
    version: "0.3.0",
    digest: `sha256:${"a".repeat(64)}`,
  }),
  memory_owner: "browser_harness",
  agent_role: "replaceable_brain",
});

test("timing receipt makes the automatic time calculation explicit", () => {
  const base = {
    timing_source: "live",
    timing_quality: "clean",
    expected_duration_seconds: 24,
    duration_seconds: 12,
    question_load: "standard",
    baseline_source: "population",
    timing_band: "fast",
    reason_code: "fast_correct_ambiguous",
    signal: "insufficient_signal",
    effective_confidence: "unsure",
  };
  assert.deepEqual(buildTimingReceipt(base, { correct: true }), {
    reference: "约 24 秒",
    referenceBasis: "标准题 · 按题目长度估算",
    actual: "12 秒",
    comparison: "实际约为参考的 50%",
    judgement: "明显偏快 · 需要复测",
  });
  assert.equal(buildTimingReceipt({
    ...base,
    timing_quality: "interrupted",
    duration_seconds: null,
  }, { correct: true }).judgement, "计时不完整 · 本题不按用时判断");
  assert.equal(buildTimingReceipt({
    ...base,
    duration_seconds: null,
  }, { correct: true }).actual, "计时不完整");
  assert.equal(buildTimingReceipt({
    ...base,
    timing_band: "steady",
    duration_seconds: 23,
    baseline_source: "personal",
    reason_code: "clean_inferred_correct",
    signal: "fluent",
    effective_confidence: "sure",
  }, { correct: true }).judgement, "节奏正常 · 可形成掌握证据");
  assert.equal(buildTimingReceipt({
    ...base,
    timing_band: "early_choice",
    duration_seconds: 24,
    reason_code: "early_choice_ambiguous",
  }, { correct: true }).judgement, "首次选择过早 · 暂不能排除猜测");
  assert.equal(buildTimingReceipt({
    ...base,
    timing_band: "unknown",
    duration_seconds: 24,
    reason_code: "timing_unavailable",
    signal: "insufficient_signal",
    effective_confidence: "unsure",
  }, { correct: true }).judgement, "计时或证据不完整 · 需要复测");
  assert.equal(buildTimingReceipt({
    ...base,
    timing_band: "steady",
    duration_seconds: 24,
    reason_code: "explicit_unsure",
    signal: "hesitant",
    effective_confidence: "unsure",
  }, { correct: true }).judgement, "节奏正常 · 但行为证据不足，需复测");
});

function catalogResponse(adapters = [], overrides = {}) {
  return {
    schema_version: "coach-agent-catalog.v1",
    protocol: LOOPBACK_PROTOCOL,
    workspace: TEST_WORKSPACE,
    adapters,
    ...overrides,
  };
}

function healthResponse(instanceId) {
  return {
    protocol: LOOPBACK_PROTOCOL,
    status: "ready",
    workspace_status: "ready",
    instance_id: instanceId,
  };
}

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

function pairingWindow() {
  const listeners = new Set();
  const opened = [];
  const navigated = [];
  const popup = {
    closed: false,
    close() { this.closed = true; },
    location: {
      href: "about:blank",
      replace(url) {
        this.href = url;
        navigated.push(url);
      },
    },
    document: {
      title: "",
      documentElement: { lang: "" },
      body: { textContent: "" },
    },
  };
  const windowRef = {
    addEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.delete(listener);
    },
    open(url, name, features) {
      opened.push({ url, name, features });
      return popup;
    },
  };
  return {
    listeners,
    opened,
    navigated,
    popup,
    windowRef,
    dispatch(data, { origin = DEFAULT_RUNTIME_ORIGIN, source = popup } = {}) {
      for (const listener of [...listeners]) listener({ data, origin, source });
    },
  };
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition_not_reached");
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
    return jsonResponse(catalogResponse());
  };
  const client = createLocalAgentClient({
    origin: "http://127.0.0.1:4317",
    fetchImpl,
  });
  await client.connect();
  assert.deepEqual(receivers, [globalThis, globalThis]);
});

test("a v3 Runtime catalog without the immutable employee workspace fails closed", async () => {
  const client = createLocalAgentClient({
    origin: "http://127.0.0.1:4317",
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/bootstrap")) {
        return jsonResponse({ protocol: LOOPBACK_PROTOCOL, access_token: "a".repeat(43), instance_id: "old-runtime" });
      }
      return jsonResponse({
        schema_version: "coach-agent-catalog.v1",
        protocol: LOOPBACK_PROTOCOL,
        adapters: [],
      });
    },
  });
  await assert.rejects(client.connect(), { code: "RUNTIME_UPDATE_REQUIRED" });
  assert.equal(client.connected, false);
});

test("workspace binding rejects wrong identity, digest type, extra path data, and old protocol", async (t) => {
  const cases = [
    ["wrong employee", { ...TEST_WORKSPACE, employee: { ...TEST_WORKSPACE.employee, name: "different-employee" } }, LOOPBACK_PROTOCOL, "RUNTIME_UPDATE_REQUIRED"],
    ["bad digest type", { ...TEST_WORKSPACE, employee: { ...TEST_WORKSPACE.employee, digest: 42 } }, LOOPBACK_PROTOCOL, "RUNTIME_UPDATE_REQUIRED"],
    ["path field", { ...TEST_WORKSPACE, directory: "/Users/example/private" }, LOOPBACK_PROTOCOL, "INVALID_WORKSPACE_BINDING"],
    ["old protocol", TEST_WORKSPACE, "coach-loopback.v2", "PROTOCOL_MISMATCH"],
  ];
  for (const [name, workspace, protocol, code] of cases) {
    await t.test(name, async () => {
      const client = createLocalAgentClient({
        origin: "http://127.0.0.1:4317",
        fetchImpl: async (url) => {
          if (url.endsWith("/v1/bootstrap")) {
            return jsonResponse({ protocol: LOOPBACK_PROTOCOL, access_token: "a".repeat(43), instance_id: "strict-runtime" });
          }
          return jsonResponse(catalogResponse([], { protocol, workspace }));
        },
      });
      await assert.rejects(client.connect(), { code });
      assert.equal(client.connected, false);
    });
  }
});

test("health probing rejects an older Runtime that has no prepared employee workspace", async () => {
  const client = createLocalAgentClient({
    fetchImpl: async () => jsonResponse({
      protocol: LOOPBACK_PROTOCOL,
      status: "ready",
      instance_id: "runtime-without-workspace",
    }),
  });
  await assert.rejects(client.probe(), { code: "RUNTIME_IDENTITY_MISMATCH" });
});

test("public-page pairing makes no Runtime fetch until an exact popup grant is accepted", async () => {
  const token = "p".repeat(43);
  const calls = [];
  const browser = pairingWindow();
  const client = createLocalAgentClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(catalogResponse([
        { id: "claude-code", label: "Claude Code", state: "ready", selectable: true },
      ]));
    },
    idFactory: () => "pairing-state-1234567890-abcdefgh",
  });

  assert.equal(calls.length, 0);
  const pending = client.pair({ windowRef: browser.windowRef, timeoutMs: 1_000 });
  assert.equal(calls.length, 0);
  assert.equal(browser.opened.length, 1);
  const pairUrl = new URL(browser.opened[0].url);
  const state = pairUrl.searchParams.get("state");
  assert.equal(pairUrl.origin, DEFAULT_RUNTIME_ORIGIN);
  assert.equal(pairUrl.pathname, "/pair.html");
  assert.match(state, /^[A-Za-z0-9_-]{32,128}$/u);
  assert.equal(pairUrl.href.includes(token), false);

  const grant = {
    type: "coach.runtime.grant",
    protocol: LOOPBACK_PROTOCOL,
    state,
    access_token: token,
    instance_id: "paired-runtime",
  };
  browser.dispatch(grant, { source: {} });
  browser.dispatch(grant, { origin: "http://127.0.0.1:43128" });
  await Promise.resolve();
  assert.equal(calls.length, 0);
  assert.equal(client.connected, false);

  browser.dispatch(grant);
  const connected = await pending;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_RUNTIME_ORIGIN}/v1/adapters`);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.mode, "cors");
  assert.equal(Object.hasOwn(calls[0].options, "targetAddressSpace"), false);
  assert.equal(connected.connected, true);
  assert.equal(connected.instance_id, "paired-runtime");
  assert.deepEqual(connected.workspace, TEST_WORKSPACE);
  assert.equal(connected.adapters[0].id, "claude-code");
  assert.equal(Object.hasOwn(connected, "access_token"), false);
  assert.equal(Object.hasOwn(connected, "token"), false);
  assert.equal(browser.listeners.size, 0);
  assert.equal(browser.popup.closed, true);
});

test("closing the Runtime confirmation window fails fast and releases the pairing listener", async () => {
  const browser = pairingWindow();
  const client = createLocalAgentClient({
    fetchImpl: async () => {
      throw new Error("no Runtime request should be made without a grant");
    },
    idFactory: () => "closed-popup-state-1234567890-abcdef",
  });

  const pending = client.pair({ windowRef: browser.windowRef, timeoutMs: 5_000 });
  assert.equal(browser.listeners.size, 1);
  browser.popup.closed = true;
  await assert.rejects(pending, { code: "PAIRING_POPUP_CLOSED" });
  assert.equal(browser.listeners.size, 0);
  assert.equal(client.connected, false);
});

test("a running Runtime is probed and paired without invoking the launch scheme", async () => {
  const browser = pairingWindow();
  const token = "r".repeat(43);
  const calls = [];
  const stages = [];
  const client = createLocalAgentClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/v1/health")) {
        return jsonResponse(healthResponse("running-runtime"));
      }
      return jsonResponse(catalogResponse([
        { id: "codex", label: "Codex CLI", state: "consent_required", selectable: false },
      ]));
    },
    idFactory: () => "wake-running-state-1234567890-abcdef",
  });

  const pending = client.wakeAndPair({ windowRef: browser.windowRef, onStage: (stage) => stages.push(stage) });
  await waitFor(() => browser.navigated.some((url) => url.startsWith(`${DEFAULT_RUNTIME_ORIGIN}/pair.html?`)));
  assert.equal(browser.opened.length, 1);
  assert.equal(browser.opened[0].url, "about:blank");
  assert.equal(browser.navigated.includes(RUNTIME_LAUNCH_URL), false);
  const pairUrl = new URL(browser.navigated.at(-1));
  browser.dispatch({
    type: "coach.runtime.grant",
    protocol: LOOPBACK_PROTOCOL,
    state: pairUrl.searchParams.get("state"),
    access_token: token,
    instance_id: "running-runtime",
  });
  const connected = await pending;
  assert.equal(connected.connected, true);
  assert.deepEqual(stages, ["checking", "pairing"]);
  assert.equal(calls[0].url, `${DEFAULT_RUNTIME_ORIGIN}/v1/health`);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers["X-Coach-Protocol"], undefined);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[1].url, `${DEFAULT_RUNTIME_ORIGIN}/v1/adapters`);
});

test("an installed Runtime is launched by a fixed data-free scheme and paired only after health is ready", async () => {
  const browser = pairingWindow();
  const stages = [];
  let healthCalls = 0;
  const client = createLocalAgentClient({
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/health")) {
        healthCalls += 1;
        if (healthCalls === 1) throw new TypeError("connection refused");
        return jsonResponse(healthResponse("launched-runtime"));
      }
      return jsonResponse(catalogResponse());
    },
    idFactory: () => "wake-launched-state-1234567890-abcde",
  });

  const pending = client.wakeAndPair({
    windowRef: browser.windowRef,
    onStage: (stage) => stages.push(stage),
    pollIntervalMs: 10,
    startupTimeoutMs: 500,
  });
  await waitFor(() => browser.navigated.some((url) => url.startsWith(`${DEFAULT_RUNTIME_ORIGIN}/pair.html?`)));
  assert.equal(browser.navigated[0], RUNTIME_LAUNCH_URL);
  assert.equal(new URL(browser.navigated[0]).search, "");
  assert.equal(new URL(browser.navigated[0]).hash, "");
  const pairUrl = new URL(browser.navigated.at(-1));
  browser.dispatch({
    type: "coach.runtime.grant",
    protocol: LOOPBACK_PROTOCOL,
    state: pairUrl.searchParams.get("state"),
    access_token: "l".repeat(43),
    instance_id: "launched-runtime",
  });
  await pending;
  assert.deepEqual(stages, ["checking", "launching", "waiting", "pairing"]);
});

test("a missing Runtime fails on the Page without opening a dead loopback error page", async () => {
  const browser = pairingWindow();
  const client = createLocalAgentClient({
    fetchImpl: async () => { throw new TypeError("connection refused"); },
    idFactory: () => "wake-missing-state-1234567890-abcdef",
  });
  await assert.rejects(client.wakeAndPair({
    windowRef: browser.windowRef,
    initialProbeTimeoutMs: 50,
    pollIntervalMs: 10,
    startupTimeoutMs: 100,
  }), (error) => {
    assert.equal(error.code, "RUNTIME_START_TIMEOUT");
    assert.match(error.message, /未能启动.*安装最新 Runtime/u);
    return true;
  });
  assert.deepEqual(browser.navigated, [RUNTIME_LAUNCH_URL]);
  assert.equal(browser.navigated.some((url) => url.startsWith(DEFAULT_RUNTIME_ORIGIN)), false);
  assert.equal(browser.popup.closed, true);
});

test("a different service on the Runtime port is diagnosed and never receives a pairing navigation", async () => {
  const browser = pairingWindow();
  const client = createLocalAgentClient({
    fetchImpl: async () => jsonResponse({ status: "ready", instance_id: "not-the-runtime" }),
  });
  await assert.rejects(client.wakeAndPair({ windowRef: browser.windowRef }), {
    code: "RUNTIME_IDENTITY_MISMATCH",
  });
  assert.deepEqual(browser.navigated, []);
  assert.equal(browser.popup.closed, true);
});

test("pairing is pinned to the Runtime instance observed by the health probe", async () => {
  const browser = pairingWindow();
  let adapterCalls = 0;
  const client = createLocalAgentClient({
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/health")) {
        return jsonResponse(healthResponse("health-runtime"));
      }
      adapterCalls += 1;
      return jsonResponse(catalogResponse());
    },
    idFactory: () => "wake-instance-state-1234567890-abcde",
  });
  const pending = client.wakeAndPair({ windowRef: browser.windowRef });
  await waitFor(() => browser.navigated.some((url) => url.startsWith(`${DEFAULT_RUNTIME_ORIGIN}/pair.html?`)));
  const pairUrl = new URL(browser.navigated.at(-1));
  browser.dispatch({
    type: "coach.runtime.grant",
    protocol: LOOPBACK_PROTOCOL,
    state: pairUrl.searchParams.get("state"),
    access_token: "i".repeat(43),
    instance_id: "replacement-runtime",
  });
  await assert.rejects(pending, { code: "PAIRING_RESPONSE_INVALID" });
  assert.equal(adapterCalls, 0);
  assert.equal(client.connected, false);
});

test("pairing rejects a same-popup grant with a wrong state, protocol, type or token", async (t) => {
  for (const [name, mutate] of [
    ["state", (grant) => ({ ...grant, state: `${grant.state}x` })],
    ["protocol", (grant) => ({ ...grant, protocol: "coach-loopback.v1" })],
    ["type", (grant) => ({ ...grant, type: "coach.runtime.other" })],
    ["token length", (grant) => ({ ...grant, access_token: "t".repeat(42) })],
    ["token alphabet", (grant) => ({ ...grant, access_token: `${"t".repeat(42)}+` })],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const browser = pairingWindow();
      const client = createLocalAgentClient({
        fetchImpl: async (...args) => {
          calls.push(args);
          return jsonResponse(catalogResponse());
        },
        idFactory: () => "strict-pair-state-1234567890-abcdef",
      });
      const pending = client.pair({ windowRef: browser.windowRef, timeoutMs: 1_000 });
      const state = new URL(browser.opened[0].url).searchParams.get("state");
      const validGrant = {
        type: "coach.runtime.grant",
        protocol: LOOPBACK_PROTOCOL,
        state,
        access_token: "t".repeat(43),
        instance_id: "paired-runtime",
      };
      browser.dispatch(mutate(validGrant));
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, "PAIRING_RESPONSE_INVALID");
        return true;
      });
      assert.equal(calls.length, 0);
      assert.equal(client.connected, false);
      assert.equal(browser.listeners.size, 0);
    });
  }
});

test("Runtime bearer stays inside client memory and is absent from URLs, bodies, connection results and serialization", async () => {
  const token = "runtime-secret-".padEnd(43, "s");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/v1/bootstrap")) {
      return jsonResponse({ protocol: LOOPBACK_PROTOCOL, access_token: token, instance_id: "fixture-runtime" });
    }
    if (url.endsWith("/v1/adapters")) {
      return jsonResponse(catalogResponse([
        { id: "qwen-code", label: "Qwen Code", state: "ready", selectable: true, reason_codes: [] },
      ]));
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
    assert.equal(Object.hasOwn(call.options, "targetAddressSpace"), false);
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

test("Codex personal consent is explicit, memory-only, and returns an experimental selectable state", async () => {
  const token = "c".repeat(43);
  const calls = [];
  const client = createLocalAgentClient({
    origin: "http://127.0.0.1:4317",
    idFactory: () => "codex-personal-consent-request",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/v1/bootstrap")) {
        return jsonResponse({ protocol: LOOPBACK_PROTOCOL, access_token: token, instance_id: "codex-runtime" });
      }
      if (url.endsWith("/v1/adapters")) {
        return jsonResponse(catalogResponse([{
            id: "codex",
            label: "Codex CLI",
            state: "consent_required",
            selectable: false,
            reason_codes: ["codex_personal_consent_required"],
            execution_mode: "personal_experimental",
            framework_adapter_status: "probe_only",
          }]));
      }
      return jsonResponse({
        protocol: LOOPBACK_PROTOCOL,
        adapter: {
          id: "codex",
          label: "Codex CLI",
          state: "experimental_personal",
          selectable: true,
          reason_codes: ["codex_personal_mode_unqualified"],
          execution_mode: "personal_experimental",
          framework_adapter_status: "probe_only",
        },
      });
    },
  });
  const connected = await client.connect();
  assert.equal(connected.adapters[0].state, "consent_required");
  assert.equal(connected.adapters[0].selectable, false);

  const adapter = await client.consentCodexPersonal();
  assert.equal(adapter.state, "experimental_personal");
  assert.equal(adapter.selectable, true);
  assert.equal(adapter.execution_mode, "personal_experimental");
  assert.equal(adapter.framework_adapter_status, "probe_only");
  const consentBody = JSON.parse(calls[2].options.body);
  assert.deepEqual(consentBody, {
    consent_version: "codex-personal-consent.v1",
    accepted: true,
  });
  assert.equal(calls[2].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[2].url.includes(token), false);
  assert.equal(String(calls[2].options.body).includes(token), false);
});

test("Codex personal consent rejects a selectable response for the wrong adapter", async () => {
  const client = createLocalAgentClient({
    origin: "http://127.0.0.1:4317",
    idFactory: () => "codex-wrong-adapter-response",
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/bootstrap")) {
        return jsonResponse({ protocol: LOOPBACK_PROTOCOL, access_token: "c".repeat(43), instance_id: "codex-runtime" });
      }
      if (url.endsWith("/v1/adapters")) {
        return jsonResponse(catalogResponse([{
          id: "codex",
          label: "Codex CLI",
          state: "consent_required",
          selectable: false,
        }]));
      }
      return jsonResponse({
        protocol: LOOPBACK_PROTOCOL,
        adapter: {
          id: "qwen-code",
          label: "Qwen Code",
          state: "experimental_personal",
          selectable: true,
          execution_mode: "personal_experimental",
          framework_adapter_status: "probe_only",
        },
      });
    },
  });
  await client.connect();
  await assert.rejects(client.consentCodexPersonal(), { code: "INVALID_ADAPTER_RESPONSE" });
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
        return jsonResponse(catalogResponse([
          { id: "qwen-code", label: "Qwen Code", state: "ready", selectable: true },
        ]));
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
    confidence: "auto",
    behavior: {
      schema_version: "web-response-observation.v1",
      timing_source: "live",
      timing_quality: "clean",
      duration_seconds: 15,
      first_choice_seconds: 9,
      answer_changes: 0,
      confidence_source: "inferred",
    },
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
  assert.equal(agentPayload.deidentifiedProgress.recommendations[0].reason_code, "clean_inferred_correct");
  for (const forbidden of [
    "duration_seconds",
    "first_choice_seconds",
    "answer_changes",
    "confidence_source",
    "pace_bucket",
    "response_behavior_baseline",
  ]) {
    assert.equal(JSON.stringify(agentPayload).includes(forbidden), false, forbidden);
  }
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
