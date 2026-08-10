import { createHash } from "node:crypto";

import { CoachError, publicError } from "./errors.mjs";
import { LEARNING_STATES, LearningConversationHarness } from "./learning-harness.mjs";
import { TrustedObjectiveGrader } from "./trusted-grader.mjs";

export const COACH_SESSION_STATE_VERSION = "coach-session-state.v2";

const TURN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TURN_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MACHINE_INTENTS = new Set(["next", "answer", "advance", "close"]);
const CONFIDENCE = new Set(["guess", "unsure", "sure"]);
const MAX_TURN_RECEIPTS = 16;
const MACHINE_MUTATION_CAPABILITY = Object.freeze({});

function controllerError(code, message, options = {}) {
  return new CoachError(code, message, { exitCode: 1, ...options });
}

function indeterminateTurnError() {
  return controllerError(
    "TURN_RESULT_INDETERMINATE",
    "上次提交的进度 effect 是否发生未知；本 turn 已终结，绝不自动重跑。请核对本地进度后显式关闭会话。",
  );
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateTurnReceipts(value) {
  if (!Array.isArray(value) || value.length > MAX_TURN_RECEIPTS) {
    throw controllerError("INVALID_COACH_SESSION", "会话 turn receipts 已损坏。 ");
  }
  const ids = new Set();
  let running = 0;
  for (const receipt of value) {
    const keys = new Set(["turn_id", "request_digest", "status", "result", "error"]);
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      Object.keys(receipt).length !== keys.size ||
      Object.keys(receipt).some((key) => !keys.has(key)) ||
      typeof receipt.turn_id !== "string" ||
      !TURN_ID_PATTERN.test(receipt.turn_id) ||
      ids.has(receipt.turn_id) ||
      typeof receipt.request_digest !== "string" ||
      !TURN_DIGEST_PATTERN.test(receipt.request_digest) ||
      !["running", "completed", "failed"].includes(receipt.status) ||
      (receipt.status === "running" && (receipt.result !== null || receipt.error !== null)) ||
      (receipt.status === "completed" && (
        !receipt.result ||
        typeof receipt.result !== "object" ||
        Array.isArray(receipt.result) ||
        receipt.error !== null
      )) ||
      (receipt.status === "failed" && (
        receipt.result !== null ||
        !receipt.error ||
        typeof receipt.error !== "object" ||
        Array.isArray(receipt.error) ||
        Object.keys(receipt.error).length !== 2 ||
        typeof receipt.error.code !== "string" ||
        typeof receipt.error.message !== "string"
      ))
    ) {
      throw controllerError("INVALID_COACH_SESSION", "会话 turn receipt 无效。 ");
    }
    if (receipt.status === "running") running += 1;
    ids.add(receipt.turn_id);
  }
  if (running > 1) {
    throw controllerError("INVALID_COACH_SESSION", "会话同时包含多个未决机器轮次。 ");
  }
  return value;
}

function validateStoredState(state) {
  const exactKeys = new Set([
    "schema_version",
    "mode",
    "engine",
    "package_digest",
    "turn_receipts",
    "harness",
  ]);
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    Object.keys(state).length !== exactKeys.size ||
    Object.keys(state).some((key) => !exactKeys.has(key)) ||
    state.schema_version !== COACH_SESSION_STATE_VERSION ||
    !["content-only", "agent-host"].includes(state.mode) ||
    (state.mode === "content-only" && state.engine !== null) ||
    (state.mode === "agent-host" && typeof state.engine !== "string") ||
    typeof state.package_digest !== "string" ||
    !TURN_DIGEST_PATTERN.test(state.package_digest) ||
    !Array.isArray(state.turn_receipts) ||
    !state.harness ||
    typeof state.harness !== "object" ||
    Array.isArray(state.harness)
  ) {
    throw controllerError("INVALID_COACH_SESSION", "会话元数据已损坏或版本不受支持。 ");
  }
  validateTurnReceipts(state.turn_receipts);
  return state;
}

async function trustedGraderFor(workbench, factory) {
  const context = await workbench.context({ required: true });
  if (!context?.authenticated || typeof context.user_id !== "string") {
    throw controllerError("AUTHENTICATION_REQUIRED", "开始学习会话前必须先运行 setup。 ");
  }
  return factory(context.user_id);
}

async function preflightRunner(runner, mode) {
  if (typeof runner?.preflight !== "function") {
    throw new TypeError(`${mode.replaceAll("-", "_")}_runner_preflight_required`);
  }
  const result = await runner.preflight();
  if (
    !result ||
    typeof result.digest !== "string" ||
    !TURN_DIGEST_PATTERN.test(result.digest) ||
    (mode === "content-only" && result.engine !== null) ||
    (mode === "agent-host" && typeof result.engine !== "string")
  ) {
    throw controllerError("INVALID_RUNNER_PREFLIGHT", "runner preflight 未返回有效的员工包绑定。 ");
  }
  if (
    !result.presentation ||
    typeof result.presentation !== "object" ||
    result.presentation.schema_version !== "coach-package-presentation.v1"
  ) {
    throw controllerError("INVALID_RUNNER_PREFLIGHT", "runner preflight 缺少受 digest 绑定的员工展示信息。 ");
  }
  return { engine: result.engine, digest: result.digest, presentation: result.presentation };
}

function normalizeMachineTurn(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw controllerError("INVALID_MACHINE_TURN", "机器轮次必须是对象。 ");
  }
  const allowed = new Set([
    "turnId",
    "expectedRevision",
    "expectedItemId",
    "intent",
    "answer",
    "confidence",
    "durationSeconds",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw controllerError("INVALID_MACHINE_TURN", "机器轮次包含未受信字段。 ");
  }
  const turnId = options.turnId;
  if (typeof turnId !== "string" || !TURN_ID_PATTERN.test(turnId)) {
    throw controllerError("INVALID_TURN_ID", "turn-id 格式无效。 ");
  }
  const expectedRevision = options.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw controllerError("INVALID_SESSION_REVISION", "expected-revision 必须是正整数。 ");
  }
  const intent = options.intent;
  if (!MACHINE_INTENTS.has(intent)) {
    throw controllerError("INVALID_SESSION_INTENT", "机器轮次 intent 无效。 ");
  }
  const expectedItemId = options.expectedItemId;
  if (
    expectedItemId !== undefined &&
    (typeof expectedItemId !== "string" || expectedItemId.length < 1 || expectedItemId.length > 512)
  ) {
    throw controllerError("INVALID_EXPECTED_ITEM", "expected-item-id 格式无效。 ");
  }
  if (["answer", "advance"].includes(intent) && expectedItemId === undefined) {
    throw controllerError(
      "EXPECTED_ITEM_REQUIRED",
      `${intent} 必须提供 expected-item-id 以防延迟消息作用到其他题目。`,
    );
  }
  let answer;
  if (intent === "answer") {
    if (typeof options.answer === "string") {
      if (options.answer.trim().length < 1 || options.answer.length > 50_000) {
        throw controllerError("ANSWER_REQUIRED", "answer intent 必须提供非空 answer。 ");
      }
      answer = options.answer.trim();
    } else if (
      Array.isArray(options.answer) &&
      options.answer.length >= 1 &&
      options.answer.length <= 20 &&
      options.answer.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 128)
    ) {
      answer = [...options.answer];
    } else {
      throw controllerError("ANSWER_REQUIRED", "answer intent 必须提供有效 answer。 ");
    }
  } else if (options.answer !== undefined) {
    throw controllerError("UNEXPECTED_ANSWER", "只有 answer intent 可以携带 answer。 ");
  }
  if (
    intent !== "answer" &&
    (options.confidence !== undefined || options.durationSeconds !== undefined)
  ) {
    throw controllerError(
      "UNEXPECTED_SUBMISSION_METADATA",
      "只有 answer intent 可以携带 confidence 或 duration-seconds。",
    );
  }
  const confidence = options.confidence ?? "unsure";
  if (!CONFIDENCE.has(confidence)) {
    throw controllerError("INVALID_SUBMISSION", "confidence 必须是 guess、unsure 或 sure。 ");
  }
  const durationSeconds = options.durationSeconds;
  if (
    durationSeconds !== undefined &&
    (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1)
  ) {
    throw controllerError("INVALID_SUBMISSION", "duration-seconds 必须是正整数。 ");
  }
  const request = {
    turn_id: turnId,
    expected_revision: expectedRevision,
    expected_item_id: expectedItemId ?? null,
    intent,
    answer: answer ?? null,
    confidence: intent === "answer" ? confidence : null,
    duration_seconds: intent === "answer" ? (durationSeconds ?? null) : null,
  };
  return {
    turnId,
    expectedRevision,
    expectedItemId,
    intent,
    answer,
    confidence,
    durationSeconds,
    requestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex")}`,
  };
}

/** Coordinates a durable store document with the channel-neutral Harness. */
export class CoachSessionController {
  constructor({ store, document, metadata, harness, presentation }) {
    this.store = store;
    this.document = document;
    this.metadata = metadata;
    this.harness = harness;
    this.presentation = presentation;
  }

  static async start({
    store,
    workbench,
    runner,
    contentProvider,
    mode = "content-only",
    engine,
    subject = "comprehensive",
    today,
    channel,
    idFactory,
    trustedGraderFactory = (principalId) => new TrustedObjectiveGrader({ principalId }),
  } = {}) {
    if (!store?.create || !store?.save) throw new TypeError("session_store_required");
    if (!workbench) throw new TypeError("workbench_required");
    if (!["content-only", "agent-host"].includes(mode)) {
      throw controllerError("INVALID_SESSION_MODE", "session mode 必须是 content-only 或 agent-host。 ");
    }
    if (runner?.mode !== mode) {
      throw controllerError("SESSION_RUNNER_MISMATCH", "runner 与声明的 session mode 不一致。 ");
    }
    if (subject !== "comprehensive") {
      throw controllerError(
        "UNSUPPORTED_PHASE1_SUBJECT",
        "首期对话闭环只支持综合知识客观题；案例和论文尚未开放。",
      );
    }
    if (mode === "agent-host" && runner?.engine !== engine) {
      throw controllerError("SESSION_ENGINE_MISMATCH", "Agent Host runner 与指定 engine 不一致。 ");
    }
    const trustedGrader = await trustedGraderFor(workbench, trustedGraderFactory);
    const preflight = await preflightRunner(runner, mode);
    const metadata = {
      schema_version: COACH_SESSION_STATE_VERSION,
      mode,
      engine: mode === "agent-host" ? preflight.engine : null,
      package_digest: preflight.digest,
      turn_receipts: [],
    };
    let document;
    let harness;
    const checkpoint = async (snapshot) => {
      document = await store.save(document.session_id, {
        expectedRevision: document.revision,
        state: { ...metadata, harness: snapshot },
      });
    };
    harness = new LearningConversationHarness({
      workbench,
      agentRunner: runner,
      contentProvider,
      trustedGrader,
      checkpoint,
      channel,
      idFactory,
    });
    document = await store.create({ state: { ...metadata, harness: harness.snapshot() } });
    try {
      await harness.start({ subject, today });
    } catch (error) {
      if (document.state?.harness?.state === LEARNING_STATES.COLD_START) {
        await store.close(document.session_id, {
          expectedRevision: document.revision,
          state: { ...metadata, harness: harness.snapshot() },
        }).catch(() => {});
      }
      throw error;
    }
    const controller = new CoachSessionController({
      store,
      document,
      metadata,
      harness,
      presentation: preflight.presentation,
    });
    Object.defineProperty(controller, "document", {
      configurable: true,
      get: () => document,
      set: (value) => { document = value; },
    });
    return controller;
  }

  static async resume({
    store,
    sessionId,
    workbench,
    runner,
    contentProvider,
    channel,
    trustedGraderFactory = (principalId) => new TrustedObjectiveGrader({ principalId }),
    allowClosed = false,
  } = {}) {
    if (!store?.load || !store?.save) throw new TypeError("session_store_required");
    const document = await store.load(sessionId);
    if (document.status !== "active" && !allowClosed) {
      throw controllerError("SESSION_CLOSED", `会话 ${sessionId} 已关闭。`);
    }
    const stored = validateStoredState(document.state);
    const metadata = {
      schema_version: stored.schema_version,
      mode: stored.mode,
      engine: stored.engine,
      package_digest: stored.package_digest,
      turn_receipts: stored.turn_receipts,
    };
    if (runner?.mode !== metadata.mode) {
      throw controllerError("SESSION_RUNNER_MISMATCH", "恢复会话的 runner 与原 session mode 不一致。 ");
    }
    if (metadata.mode === "agent-host" && runner?.engine !== metadata.engine) {
        throw controllerError("SESSION_ENGINE_MISMATCH", "恢复会话必须使用原来的 Agent Host engine。 ");
    }
    const checked = await preflightRunner(runner, metadata.mode);
    if (checked.digest !== metadata.package_digest) {
      throw controllerError(
        "EMPLOYEE_PACKAGE_CHANGED",
        "数字员工包版本已变化，不能静默恢复旧会话。",
      );
    }
    const trustedGrader = await trustedGraderFor(workbench, trustedGraderFactory);
    let current = document;
    const checkpoint = async (snapshot) => {
      current = await store.save(current.session_id, {
        expectedRevision: current.revision,
        state: { ...metadata, harness: snapshot },
      });
    };
    const harness = LearningConversationHarness.restore({
      workbench,
      agentRunner: runner,
      contentProvider,
      trustedGrader,
      checkpoint,
      channel,
    }, stored.harness);
    const controller = new CoachSessionController({
      store,
      document: current,
      metadata,
      harness,
      presentation: checked.presentation,
    });
    Object.defineProperty(controller, "document", {
      configurable: true,
      get: () => current,
      set: (value) => { current = value; },
    });
    return controller;
  }

  get sessionId() {
    return this.document.session_id;
  }

  view() {
    return {
      session_id: this.sessionId,
      mode: this.metadata.mode,
      engine: this.metadata.engine,
      revision: this.document.revision,
      presentation: jsonClone(this.presentation),
      ...this.harness.view(),
    };
  }

  async next() {
    this.#assertHumanMutationAllowed();
    return this.#next(MACHINE_MUTATION_CAPABILITY);
  }

  async #next(capability) {
    this.#assertMachineMutationCapability(capability);
    await this.harness.next();
    return this.view();
  }

  async submit(response, options) {
    this.#assertHumanMutationAllowed();
    return this.#submit(response, options, MACHINE_MUTATION_CAPABILITY);
  }

  async #submit(response, options, capability) {
    this.#assertMachineMutationCapability(capability);
    await this.harness.submit(response, options);
    return this.view();
  }

  async advance() {
    this.#assertHumanMutationAllowed();
    return this.#advance(MACHINE_MUTATION_CAPABILITY);
  }

  async #advance(capability) {
    this.#assertMachineMutationCapability(capability);
    await this.harness.advance();
    return this.view();
  }

  #assertHumanMutationAllowed() {
    if (this.metadata.turn_receipts.some((item) => item.status === "running")) {
      throw controllerError(
        "TURN_IN_PROGRESS",
        "机器轮次尚未得到确定收据；请使用原 turn-id 重试，不能从其他入口修改会话。",
      );
    }
  }

  #assertMachineMutationCapability(capability) {
    if (capability !== MACHINE_MUTATION_CAPABILITY) {
      throw controllerError("UNAUTHORIZED_SESSION_MUTATION", "会话 mutation 缺少内部执行授权。 ");
    }
  }

  async handleMachineTurn(options) {
    const turn = normalizeMachineTurn(options);
    let receipt = this.metadata.turn_receipts.find((item) => item.turn_id === turn.turnId);
    if (receipt) {
      if (receipt.request_digest !== turn.requestDigest) {
        throw controllerError(
          "TURN_ID_CONFLICT",
          "同一 turn-id 已绑定到不同请求；拒绝重放。",
        );
      }
      if (receipt.status === "completed") return jsonClone(receipt.result);
      if (receipt.status === "failed") {
        throw controllerError(receipt.error.code, receipt.error.message);
      }
      return this.#recoverRunningTurn(receipt, turn);
    }
    if (this.document.status !== "active") {
      throw controllerError("SESSION_CLOSED", `会话 ${this.sessionId} 已关闭。`);
    }
    if (this.document.revision !== turn.expectedRevision) {
      throw controllerError(
        "STALE_SESSION_REVISION",
        `会话已从 revision ${turn.expectedRevision} 更新到 ${this.document.revision}。`,
        { details: { expectedRevision: turn.expectedRevision, actualRevision: this.document.revision } },
      );
    }
    if (this.metadata.turn_receipts.some((item) => item.status === "running")) {
      throw controllerError(
        "TURN_IN_PROGRESS",
        "另一个机器轮次尚未得到确定收据；请使用原 turn-id 重试。",
      );
    }
    this.#assertExpectedItem(turn);
    this.#assertTurnCanStart(turn);
    receipt = {
      turn_id: turn.turnId,
      request_digest: turn.requestDigest,
      status: "running",
      result: null,
      error: null,
    };
    const previous = this.metadata.turn_receipts;
    this.metadata.turn_receipts = [
      ...previous.filter((item) => item.status !== "running").slice(-(MAX_TURN_RECEIPTS - 1)),
      receipt,
    ];
    try {
      await this.#saveMetadata();
    } catch (error) {
      this.metadata.turn_receipts = previous;
      throw error;
    }
    return this.#executeMachineTurn(receipt, turn);
  }

  #assertExpectedItem(turn) {
    if (turn.expectedItemId === undefined) return;
    const actual = this.harness.view().question?.item_id;
    if (actual !== turn.expectedItemId) {
      throw controllerError(
        "STALE_ACTIVE_ITEM",
        "消息绑定的题目已不是当前 active item；拒绝把延迟答案应用到新题。",
        { details: { expectedItemId: turn.expectedItemId, actualItemId: actual ?? null } },
      );
    }
  }

  #assertTurnCanStart(turn) {
    const view = this.harness.view();
    const requiredState = {
      next: LEARNING_STATES.READY,
      answer: LEARNING_STATES.AWAITING_ANSWER,
      advance: LEARNING_STATES.FEEDBACK,
    }[turn.intent];
    if (requiredState && view.state !== requiredState) {
      throw controllerError(
        "INVALID_HARNESS_TRANSITION",
        `当前状态 ${view.state} 不能执行 ${turn.intent}；需要 ${requiredState}。`,
      );
    }
    if (turn.intent !== "answer") return;
    const allowed = new Set((view.question?.options || []).map((item) => item.label));
    const values = Array.isArray(turn.answer) ? turn.answer : [turn.answer];
    const compact = values
      .join(",")
      .toUpperCase()
      .replace(/[，、/]/gu, ",")
      .replace(/\s+/gu, "");
    if (!/^[A-H](?:,?[A-H])*$/u.test(compact)) {
      throw controllerError("INVALID_OBJECTIVE_RESPONSE", "客观题作答只能包含 A-H 选项字母。 ");
    }
    const labels = compact.replaceAll(",", "").split("");
    if (
      new Set(labels).size !== labels.length ||
      labels.some((label) => !allowed.has(label))
    ) {
      throw controllerError(
        "INVALID_OBJECTIVE_RESPONSE",
        "客观题作答包含重复或当前题目不存在的选项。",
      );
    }
  }

  async #saveMetadata() {
    this.document = await this.store.save(this.sessionId, {
      expectedRevision: this.document.revision,
      state: { ...this.metadata, harness: this.harness.snapshot() },
    });
  }

  async #recoverRunningTurn(receipt, turn) {
    const state = this.harness.view().state;
    if (turn.intent === "next" && state === LEARNING_STATES.AWAITING_ANSWER) {
      return this.#completeMachineTurn(receipt, this.view());
    }
    if (turn.intent === "answer" && state === LEARNING_STATES.FEEDBACK) {
      this.#assertExpectedItem(turn);
      return this.#completeMachineTurn(receipt, this.view());
    }
    if (
      turn.intent === "advance" &&
      [LEARNING_STATES.READY, LEARNING_STATES.COMPLETE].includes(state)
    ) {
      return this.#completeMachineTurn(receipt, this.view());
    }
    if (state === LEARNING_STATES.INDETERMINATE) {
      return this.#failMachineTurn(receipt, indeterminateTurnError());
    }
    this.#assertExpectedItem(turn);
    const retryableState = (
      (turn.intent === "next" && state === LEARNING_STATES.READY) ||
      (turn.intent === "answer" && state === LEARNING_STATES.AWAITING_ANSWER) ||
      (turn.intent === "advance" && state === LEARNING_STATES.FEEDBACK) ||
      turn.intent === "close"
    );
    if (!retryableState) {
      throw controllerError("TURN_RECOVERY_REQUIRED", "无法安全判断上次机器轮次是否完成。 ");
    }
    return this.#executeMachineTurn(receipt, turn);
  }

  async #executeMachineTurn(receipt, turn) {
    if (turn.intent === "close") return this.#closeMachineTurn(receipt);
    let result;
    try {
      if (turn.intent === "next") result = await this.#next(MACHINE_MUTATION_CAPABILITY);
      if (turn.intent === "answer") {
        result = await this.#submit(turn.answer, {
          confidence: turn.confidence,
          ...(turn.durationSeconds === undefined ? {} : { durationSeconds: turn.durationSeconds }),
        }, MACHINE_MUTATION_CAPABILITY);
      }
      if (turn.intent === "advance") result = await this.#advance(MACHINE_MUTATION_CAPABILITY);
    } catch (error) {
      const state = this.harness.view().state;
      const completed = (
        (turn.intent === "next" && state === LEARNING_STATES.AWAITING_ANSWER) ||
        (turn.intent === "answer" && state === LEARNING_STATES.FEEDBACK) ||
        (turn.intent === "advance" && [LEARNING_STATES.READY, LEARNING_STATES.COMPLETE].includes(state))
      );
      if (completed) return this.#completeMachineTurn(receipt, this.view());
      if (state === LEARNING_STATES.INDETERMINATE) {
        return this.#failMachineTurn(receipt, indeterminateTurnError());
      }
      const safelyFailed = (
        (turn.intent === "next" && state === LEARNING_STATES.READY) ||
        (turn.intent === "answer" && state === LEARNING_STATES.AWAITING_ANSWER) ||
        (turn.intent === "advance" && state === LEARNING_STATES.FEEDBACK)
      );
      if (safelyFailed) return this.#failMachineTurn(receipt, error);
      throw error;
    }
    return this.#completeMachineTurn(receipt, result);
  }

  async #failMachineTurn(receipt, error) {
    const safe = publicError(error);
    receipt.status = "failed";
    receipt.result = null;
    receipt.error = { code: safe.code, message: safe.message };
    try {
      await this.#saveMetadata();
    } catch (saveError) {
      receipt.status = "running";
      receipt.error = null;
      throw saveError;
    }
    throw controllerError(safe.code, safe.message);
  }

  async #completeMachineTurn(receipt, result) {
    const completed = { ...jsonClone(result), revision: this.document.revision + 1 };
    receipt.status = "completed";
    receipt.result = completed;
    receipt.error = null;
    try {
      await this.#saveMetadata();
    } catch (error) {
      receipt.status = "running";
      receipt.result = null;
      receipt.error = null;
      throw error;
    }
    return jsonClone(completed);
  }

  async #closeMachineTurn(receipt) {
    const result = {
      session_id: this.sessionId,
      status: "closed",
      revision: this.document.revision + 1,
    };
    receipt.status = "completed";
    receipt.result = result;
    receipt.error = null;
    try {
      this.document = await this.store.close(this.sessionId, {
        expectedRevision: this.document.revision,
        state: { ...this.metadata, harness: this.harness.snapshot() },
      });
    } catch (error) {
      receipt.status = "running";
      receipt.result = null;
      receipt.error = null;
      throw error;
    }
    return jsonClone(result);
  }

  async close() {
    const running = this.metadata.turn_receipts.filter((item) => item.status === "running");
    if (
      this.harness.view().state === LEARNING_STATES.INDETERMINATE &&
      running.length === 1
    ) {
      const receipt = running[0];
      const failure = indeterminateTurnError();
      receipt.status = "failed";
      receipt.result = null;
      receipt.error = { code: failure.code, message: failure.message };
      try {
        this.document = await this.store.close(this.sessionId, {
          expectedRevision: this.document.revision,
          state: { ...this.metadata, harness: this.harness.snapshot() },
        });
      } catch (error) {
        receipt.status = "running";
        receipt.error = null;
        throw error;
      }
      return { session_id: this.sessionId, status: this.document.status };
    }
    this.#assertHumanMutationAllowed();
    this.document = await this.store.close(this.sessionId, {
      expectedRevision: this.document.revision,
      state: { ...this.metadata, harness: this.harness.snapshot() },
    });
    return { session_id: this.sessionId, status: this.document.status };
  }
}
