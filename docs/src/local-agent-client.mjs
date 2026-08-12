export const LOOPBACK_PROTOCOL = "coach-loopback.v3";
export const DEFAULT_RUNTIME_ORIGIN = "http://127.0.0.1:43127";
export const PUBLIC_COACH_ORIGIN = "https://peterguy326.github.io";
export const RUNTIME_LAUNCH_URL = "senior-architect-pass-coach://launch";
const AGENT_CATALOG_SCHEMA = "coach-agent-catalog.v1";
const WORKSPACE_SCHEMA = "coach-local-workspace.v1";

const PAIRING_MESSAGE_TYPE = "coach.runtime.grant";
const PAIRING_STATE = /^[A-Za-z0-9_-]{32,128}$/u;
const RUNTIME_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const RUNTIME_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_COACHING_CHARS = 2_000;
const MAX_CHAT_CHARS = 2_000;
const ADAPTER_STATES = new Set([
  "ready_unverified",
  "ready",
  "consent_required",
  "experimental_personal",
  "needs_configuration",
  "needs_login",
  "probe_only",
  "incompatible",
  "unavailable",
]);
const SOURCE_REFS = new Set(["senior-software-architect-review", "user-supplied-local-review-material"]);
const SUBJECTS = new Set(["comprehensive", "case", "essay"]);
const RUNTIME_REASON_MESSAGES = Object.freeze({
  protocol_header_required: "本机 Runtime 协议版本不匹配。",
  origin_not_allowed: "本机 Runtime 拒绝了当前页面来源。",
  authentication_required: "本机 Runtime 内存授权已失效，请重新连接。",
  adapter_not_found: "本机 Runtime 中没有这个 Agent 引擎。",
  adapter_not_selectable: "该 Agent 当前不可运行，请查看引擎状态。",
  agent_busy: "本机 Agent 正在处理上一条请求，请稍后再试。",
  agent_run_failed: "本机 Agent 本次运行失败，固定批改不受影响。",
  agent_output_rejected: "Agent 输出未通过教师契约校验，已拒绝显示。",
  invalid_request: "本机 Runtime 拒绝了无效的讲解请求。",
  invalid_idempotency_key: "本机 Runtime 拒绝了无效的请求标识。",
  idempotency_key_conflict: "同一请求标识对应了不同内容，已安全拒绝。",
  request_body_too_large: "发送给本机 Runtime 的上下文超过安全上限。",
  application_json_required: "本机 Runtime 只接受受约束的 JSON 请求。",
  runtime_internal_error: "本机 Runtime 暂时异常，固定私教仍可使用。",
});

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reportStage(callback, stage) {
  try { callback?.(stage); } catch { /* UI status reporting cannot break pairing */ }
}

function navigatePopup(popup, target) {
  if (!popup || popup.closed) {
    throw clientError("PAIRING_POPUP_CLOSED", "本机连接窗口已关闭，请重新点击连接。");
  }
  try {
    if (typeof popup.location?.replace === "function") popup.location.replace(target);
    else popup.location.href = target;
  } catch {
    throw clientError("PAIRING_POPUP_NAVIGATION_FAILED", "浏览器阻止了本机连接窗口，请允许打开应用和弹窗后重试。");
  }
}

function showLauncherPlaceholder(popup) {
  try {
    popup.document.title = "正在连接本机 Runtime";
    popup.document.documentElement.lang = "zh-CN";
    popup.document.body.textContent = "正在检测并唤起架构过线私教 Runtime。确认服务就绪后，这个窗口才会进入本机配对页。";
  } catch { /* best-effort; a WindowProxy is enough for later navigation */ }
}

function delay(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function cleanText(value, maximum = MAX_COACHING_CHARS) {
  if (typeof value !== "string") return "";
  const result = value
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, "")
    .trim()
    .slice(0, maximum);
  return /[\uD800-\uDBFF]$/u.test(result) ? result.slice(0, -1) : result;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedQuestion(question, { required = true } = {}) {
  if (!question || typeof question !== "object") {
    if (!required) return null;
    throw clientError("INVALID_PUBLIC_QUESTION", "提交后讲解需要当前公开题面。");
  }
  const options = Array.isArray(question.options)
    ? question.options.slice(0, 8).map((option) => ({
        label: cleanText(option?.label, 8),
        text: cleanText(option?.text ?? option?.content ?? option?.value, 2_000),
      })).filter((option) => /^[A-H]$/u.test(option.label) && option.text)
    : [];
  const sourceRefs = Array.isArray(question.source_refs)
    ? question.source_refs.slice(0, 8).map((value) => cleanText(value, 128))
    : [];
  if (!sourceRefs.length || sourceRefs.some((value) => !SOURCE_REFS.has(value))) {
    throw clientError("INVALID_PUBLIC_QUESTION", "当前题面的资料来源不在 Agent 白名单中。");
  }
  const value = {
    item_id: cleanText(question.item_id, 128),
    kind: cleanText(question.kind, 64),
    subject: cleanText(question.subject, 64),
    topic_id: cleanText(question.topic_id, 128),
    prompt: cleanText(question.prompt, 12_000),
    source_refs: sourceRefs,
  };
  if (options.length) value.options = options;
  if (!value.item_id || !value.kind || !SUBJECTS.has(value.subject) || !value.topic_id || !value.prompt) {
    throw clientError("INVALID_PUBLIC_QUESTION", "当前公开题面结构无效。");
  }
  return value;
}

function boundedGrade(grade) {
  if (!grade || typeof grade !== "object") return null;
  const sourceRefs = Array.isArray(grade.source_refs)
    ? grade.source_refs.slice(0, 8).map((value) => cleanText(value, 128))
    : [];
  if (!sourceRefs.length || sourceRefs.some((value) => !SOURCE_REFS.has(value))) {
    throw clientError("INVALID_TRUSTED_GRADE", "可信判分的资料来源不在 Agent 白名单中。");
  }
  return {
    schema_version: "web-trusted-objective-grade.v1",
    item_id: cleanText(grade.item_id, 256),
    topic_id: cleanText(grade.topic_id, 256),
    subject: cleanText(grade.subject, 64),
    selected_answer: cleanText(grade.selected_answer, 16),
    reference_answer: cleanText(grade.reference_answer, 16),
    correct: grade.correct === true,
    result: cleanText(grade.result, 64),
    score: grade.score === 1 ? 1 : 0,
    max_score: 1,
    explanation: cleanText(grade.explanation, 8_000),
    source_refs: sourceRefs,
  };
}

function boundedProgress(progress) {
  if (!progress || progress.schema_version !== "deidentified-progress.v1") {
    throw clientError("INVALID_DEIDENTIFIED_PROGRESS", "Agent 上下文必须是去身份化学习摘要。");
  }
  const subjects = Object.fromEntries(["comprehensive", "case", "essay"].map((name) => {
    const source = progress.subjects?.[name] || {};
    return [name, {
      status: cleanText(source.status, 64) || "unmeasured",
      latest_mock_score: typeof source.latest_mock_score === "number" && Number.isFinite(source.latest_mock_score)
        ? Math.max(0, Math.min(75, source.latest_mock_score))
        : null,
      evidence_count: Math.max(0, Math.min(100_000, Number(source.evidence_count) || 0)),
      lower_bound_score: typeof source.lower_bound_score === "number" && Number.isFinite(source.lower_bound_score)
        ? Math.max(0, Math.min(75, source.lower_bound_score))
        : null,
      evidence_level: cleanText(source.evidence_level, 64) || "cold_start",
    }];
  }));
  const recommendations = Array.isArray(progress.recommendations)
    ? progress.recommendations.slice(0, 3).map((item) => ({
        topic_id: cleanText(item?.topic_id, 128),
        subject: SUBJECTS.has(item?.subject) ? item.subject : "comprehensive",
        skill: cleanText(item?.skill, 128) || "recognition",
        priority_score: typeof item?.priority_score === "number" && Number.isFinite(item.priority_score)
          ? item.priority_score
          : null,
        mastery: typeof item?.mastery === "number" && Number.isFinite(item.mastery) ? item.mastery : null,
        review_due: item?.review_due === true,
        estimated_minutes: typeof item?.estimated_minutes === "number" && Number.isFinite(item.estimated_minutes)
          ? Math.max(0, item.estimated_minutes)
          : null,
        reason_code: cleanText(item?.reason_code, 128) || "deterministic_priority",
      })).filter((item) => item.topic_id)
    : [];
  const targetSubject = SUBJECTS.has(progress.target_subject) ? progress.target_subject : null;
  const maintenanceSubject = SUBJECTS.has(progress.maintenance_subject) ? progress.maintenance_subject : null;
  return {
    schema_version: "deidentified-progress.v1",
    subjects,
    target_subject: targetSubject,
    maintenance_subject: maintenanceSubject,
    crunch_mode: progress.crunch_mode === true,
    days_to_exam: Number.isInteger(progress.days_to_exam) ? Math.max(0, Math.min(3_650, progress.days_to_exam)) : null,
    recommendations,
  };
}

function safeAdapter(raw) {
  if (!raw || typeof raw !== "object") throw clientError("INVALID_ADAPTER_RESPONSE", "Runtime 返回了无效引擎状态。");
  const id = cleanText(raw.id ?? raw.adapter_id ?? raw.engine, 64);
  const state = cleanText(raw.state ?? raw.status, 64);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id) || !ADAPTER_STATES.has(state)) {
    throw clientError("INVALID_ADAPTER_RESPONSE", "Runtime 返回了无法识别的引擎状态。");
  }
  const rawReasons = Array.isArray(raw.reason_codes) ? raw.reason_codes : raw.reasons;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.slice(0, 8).map((reason) => cleanText(reason, 128)).filter((reason) => /^[a-z0-9_]{1,128}$/u.test(reason))
    : [];
  const selectable = raw.selectable === true;
  if (selectable && !new Set(["ready", "experimental_personal"]).has(state)) {
    throw clientError("INVALID_ADAPTER_RESPONSE", "Runtime 返回了矛盾的引擎可用状态。");
  }
  return Object.freeze({
    id,
    label: cleanText(raw.label ?? raw.name, 80) || id,
    state,
    detail: "",
    reasons: Object.freeze(reasons),
    selectable,
    execution_mode: cleanText(raw.execution_mode, 64),
    framework_adapter_status: cleanText(raw.framework_adapter_status, 64),
  });
}

function safeWorkspaceBinding(raw) {
  if (
    !raw
    || typeof raw !== "object"
    || Array.isArray(raw)
    || raw.schema_version !== WORKSPACE_SCHEMA
    || raw.state !== "ready"
    || raw.memory_owner !== "browser_harness"
    || raw.agent_role !== "replaceable_brain"
    || !raw.employee
    || typeof raw.employee !== "object"
    || Array.isArray(raw.employee)
    || typeof raw.employee.name !== "string"
    || raw.employee.name !== "senior-architect-pass-coach"
    || typeof raw.employee.version !== "string"
    || typeof raw.employee.digest !== "string"
    || !PACKAGE_NAME.test(raw.employee.name)
    || !PACKAGE_VERSION.test(raw.employee.version)
    || !PACKAGE_DIGEST.test(raw.employee.digest)
  ) {
    throw clientError("RUNTIME_UPDATE_REQUIRED", "本机 Runtime 未提供受绑定的 Digital Employee 工作区，请更新 Runtime 后重试。");
  }
  const allowedWorkspaceKeys = ["agent_role", "employee", "memory_owner", "schema_version", "state"];
  const allowedEmployeeKeys = ["digest", "name", "version"];
  if (
    Object.keys(raw).some((key) => !allowedWorkspaceKeys.includes(key))
    || Object.keys(raw.employee).some((key) => !allowedEmployeeKeys.includes(key))
  ) {
    throw clientError("INVALID_WORKSPACE_BINDING", "本机 Runtime 返回了无效的 Digital Employee 工作区绑定。");
  }
  return Object.freeze({
    schema_version: WORKSPACE_SCHEMA,
    state: "ready",
    employee: Object.freeze({
      name: raw.employee.name,
      version: raw.employee.version,
      digest: raw.employee.digest,
    }),
    memory_owner: "browser_harness",
    agent_role: "replaceable_brain",
  });
}

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  throw clientError("SECURE_RANDOM_UNAVAILABLE", "当前浏览器不能生成安全的本机配对状态。");
}

export function isLocalAgentRuntimeOrigin(value = globalThis.location?.origin) {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value)) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.origin === value && port >= 1 && port <= 65_535 && !url.username && !url.password;
  } catch {
    return false;
  }
}

export class LocalAgentClient {
  #origin;
  #fetch;
  #token = null;
  #instanceId = null;
  #workspace = null;
  #idFactory;

  constructor({ origin = DEFAULT_RUNTIME_ORIGIN, fetchImpl = globalThis.fetch, idFactory = requestId } = {}) {
    if (!isLocalAgentRuntimeOrigin(origin)) {
      throw clientError("LOOPBACK_RUNTIME_REQUIRED", "Agent Runtime 端点必须是 127.0.0.1 本机地址。");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetch_function_required");
    if (typeof idFactory !== "function") throw new TypeError("id_factory_required");
    this.#origin = origin;
    // Browser-native fetch requires Window/globalThis as its receiver. Keeping
    // an unbound reference in a private field makes Chrome throw
    // `Illegal invocation` before any Runtime request is sent.
    this.#fetch = fetchImpl.bind(globalThis);
    this.#idFactory = idFactory;
  }

  get connected() {
    return Boolean(this.#token);
  }

  get connectionInfo() {
    return Object.freeze({
      connected: this.connected,
      protocol: LOOPBACK_PROTOCOL,
      instance_id: this.#instanceId,
      workspace: this.#workspace,
    });
  }

  /**
   * Performs an explicit, user-triggered health check. It never bootstraps a
   * bearer and is intentionally not called during page load.
   */
  async probe({ timeoutMs = 700 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) {
      throw new TypeError("timeoutMs_must_be_50_to_10000");
    }
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.#fetch(new URL("/v1/health", this.#origin).href, {
        method: "GET",
        mode: "cors",
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw clientError("RUNTIME_UNREACHABLE", "本机 Runtime 尚未运行。");
    } finally {
      globalThis.clearTimeout(timeout);
    }
    if (!response?.ok) {
      throw clientError("RUNTIME_HEALTH_REJECTED", "43127 端口有响应，但它拒绝了私教 Runtime 探活；请关闭占用该端口的程序后重试。");
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw clientError("RUNTIME_IDENTITY_MISMATCH", "43127 端口不是可识别的私教 Runtime。");
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw clientError("RUNTIME_IDENTITY_MISMATCH", "43127 端口不是可识别的私教 Runtime。");
    }
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw clientError("RUNTIME_IDENTITY_MISMATCH", "43127 端口不是可识别的私教 Runtime。");
    }
    if (
      !result
      || typeof result !== "object"
      || Array.isArray(result)
      || result.protocol !== LOOPBACK_PROTOCOL
      || result.status !== "ready"
      || result.workspace_status !== "ready"
      || typeof result.instance_id !== "string"
      || !RUNTIME_INSTANCE.test(result.instance_id)
    ) {
      throw clientError("RUNTIME_IDENTITY_MISMATCH", "43127 端口不是可识别的私教 Runtime。");
    }
    return Object.freeze({
      protocol: LOOPBACK_PROTOCOL,
      status: "ready",
      instance_id: cleanText(result.instance_id, 128),
      workspace_status: "ready",
    });
  }

  /**
   * Page-entry lifecycle for an installed Runtime. A same-click placeholder
   * popup is retained while the client probes localhost. If Runtime is down,
   * that popup is navigated to one fixed, launch-only custom URL scheme. Only
   * after the expected health contract is observed may it navigate to the
   * loopback pairing page. No bearer, state, command, URL or path is ever put
   * in the deep link.
   */
  async wakeAndPair({
    windowRef = globalThis.window,
    onStage,
    initialProbeTimeoutMs = 700,
    startupTimeoutMs = 8_000,
    pollIntervalMs = 300,
    pairTimeoutMs = 120_000,
  } = {}) {
    this.disconnect();
    if (
      !windowRef
      || typeof windowRef.open !== "function"
      || typeof windowRef.addEventListener !== "function"
      || typeof windowRef.removeEventListener !== "function"
    ) {
      throw clientError("PAIRING_UNAVAILABLE", "当前浏览器不能打开本机 Agent 配对窗口。");
    }
    if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 60_000) {
      throw new TypeError("startupTimeoutMs_must_be_100_to_60000");
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 2_000) {
      throw new TypeError("pollIntervalMs_must_be_10_to_2000");
    }
    let popup;
    try {
      popup = windowRef.open(
        "about:blank",
        "_blank",
        "popup,width=520,height=680,resizable=yes,scrollbars=yes",
      );
    } catch {
      popup = null;
    }
    if (!popup) {
      throw clientError("PAIRING_POPUP_BLOCKED", "浏览器拦截了连接窗口，请允许本站弹窗后重试。");
    }
    showLauncherPlaceholder(popup);

    try {
      reportStage(onStage, "checking");
      let health;
      try {
        health = await this.probe({ timeoutMs: initialProbeTimeoutMs });
      } catch (error) {
        if (error?.code !== "RUNTIME_UNREACHABLE") throw error;
        reportStage(onStage, "launching");
        navigatePopup(popup, RUNTIME_LAUNCH_URL);
        reportStage(onStage, "waiting");
        const deadline = Date.now() + startupTimeoutMs;
        let ready = false;
        while (Date.now() < deadline) {
          if (popup.closed) {
            throw clientError("PAIRING_POPUP_CLOSED", "本机连接窗口已关闭，请重新点击连接。");
          }
          await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
          try {
            health = await this.probe({ timeoutMs: Math.min(initialProbeTimeoutMs, Math.max(50, deadline - Date.now())) });
            ready = true;
            break;
          } catch (probeError) {
            if (probeError?.code !== "RUNTIME_UNREACHABLE") throw probeError;
          }
        }
        if (!ready) {
          throw clientError(
            "RUNTIME_START_TIMEOUT",
            "本机 Runtime 未能启动：可能尚未安装、浏览器未获准唤起，或应用启动失败。请先安装最新 Runtime；若已经安装，请允许浏览器打开“架构过线私教”后重试。",
          );
        }
      }
      reportStage(onStage, "pairing");
      return await this.pair({
        windowRef,
        timeoutMs: pairTimeoutMs,
        popupRef: popup,
        expectedInstanceId: health.instance_id,
      });
    } catch (error) {
      try { popup.close?.(); } catch { /* best-effort popup cleanup */ }
      throw error;
    }
  }

  async connect() {
    this.disconnect();
    const result = await this.#request("/v1/bootstrap", {
      method: "POST",
      body: { protocol: LOOPBACK_PROTOCOL },
      authenticated: false,
    });
    if (result.protocol !== LOOPBACK_PROTOCOL) {
      throw clientError("PROTOCOL_MISMATCH", "本机 Runtime 与网页协议版本不一致。");
    }
    const token = typeof result.access_token === "string"
      ? result.access_token
      : (typeof result.bearer_token === "string" ? result.bearer_token : result.token);
    if (typeof token !== "string" || !RUNTIME_TOKEN.test(token)) {
      throw clientError("INVALID_BOOTSTRAP", "本机 Runtime 没有签发有效的内存令牌。");
    }
    this.#token = token;
    this.#instanceId = cleanText(result.instance_id, 128) || null;
    try {
      const adapters = await this.listAdapters();
      return Object.freeze({ ...this.connectionInfo, adapters });
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  /**
   * Opens the Runtime-owned confirmation page and adopts its one-time grant.
   * The bearer never appears in a URL, DOM node, browser store, or return
   * value; it moves from the loopback popup to this private field only.
   */
  pair({
    windowRef = globalThis.window,
    timeoutMs = 120_000,
    popupRef = null,
    expectedInstanceId = null,
  } = {}) {
    this.disconnect();
    if (
      !windowRef
      || typeof windowRef.open !== "function"
      || typeof windowRef.addEventListener !== "function"
      || typeof windowRef.removeEventListener !== "function"
    ) {
      return Promise.reject(clientError("PAIRING_UNAVAILABLE", "当前浏览器不能打开本机 Agent 配对窗口。"));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      return Promise.reject(new TypeError("timeoutMs_must_be_1000_to_300000"));
    }
    if (expectedInstanceId !== null && !RUNTIME_INSTANCE.test(expectedInstanceId)) {
      return Promise.reject(new TypeError("expectedInstanceId_invalid"));
    }
    let state;
    try {
      state = String(this.#idFactory()).replace(/[^A-Za-z0-9_-]/gu, "").padEnd(32, "0").slice(0, 128);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!PAIRING_STATE.test(state)) {
      return Promise.reject(clientError("PAIRING_STATE_INVALID", "无法建立安全的本机配对状态。"));
    }
    const pairUrl = new URL("/pair.html", this.#origin);
    pairUrl.searchParams.set("state", state);

    return new Promise((resolve, reject) => {
      let settled = false;
      let popup = popupRef;
      let closePoll = null;
      const finish = (error, grant) => {
        if (settled) return;
        settled = true;
        windowRef.removeEventListener("message", onMessage);
        globalThis.clearTimeout(timeout);
        if (closePoll !== null) globalThis.clearInterval(closePoll);
        try { popup?.close?.(); } catch { /* best-effort popup cleanup */ }
        if (error) reject(error);
        else resolve(grant);
      };
      const onMessage = (event) => {
        if (event.source !== popup || event.origin !== this.#origin) return;
        const data = event.data;
        if (
          !data
          || typeof data !== "object"
          || Array.isArray(data)
          || data.type !== PAIRING_MESSAGE_TYPE
          || data.protocol !== LOOPBACK_PROTOCOL
          || data.state !== state
          || !RUNTIME_TOKEN.test(data.access_token)
          || typeof data.instance_id !== "string"
          || !RUNTIME_INSTANCE.test(data.instance_id)
          || (expectedInstanceId !== null && data.instance_id !== expectedInstanceId)
        ) {
          finish(clientError("PAIRING_RESPONSE_INVALID", "本机 Runtime 返回了无效配对授权。"));
          return;
        }
        this.#token = data.access_token;
        this.#instanceId = cleanText(data.instance_id, 128) || null;
        this.listAdapters().then(
          (adapters) => finish(null, Object.freeze({ ...this.connectionInfo, adapters })),
          (error) => {
            this.disconnect();
            finish(error);
          },
        );
      };
      windowRef.addEventListener("message", onMessage);
      const timeout = globalThis.setTimeout(() => {
        finish(clientError("PAIRING_TIMEOUT", "本机 Agent 配对已超时，请重新连接。"));
      }, timeoutMs);
      closePoll = globalThis.setInterval(() => {
        if (popup?.closed) {
          finish(clientError("PAIRING_POPUP_CLOSED", "本机连接窗口已关闭，请重新点击目标 Agent。"));
        }
      }, 250);
      if (popup) {
        try {
          navigatePopup(popup, pairUrl.href);
        } catch (error) {
          finish(error);
        }
      } else {
        try {
          popup = windowRef.open(
            pairUrl.href,
            `coach-agent-pair-${state}`,
            "popup,width=520,height=680,resizable=yes,scrollbars=yes",
          );
        } catch {
          popup = null;
        }
        if (!popup) {
          finish(clientError("PAIRING_POPUP_BLOCKED", "浏览器拦截了配对窗口，请允许弹窗后重试。"));
        }
      }
    });
  }

  disconnect() {
    this.#token = null;
    this.#instanceId = null;
    this.#workspace = null;
  }

  async listAdapters() {
    this.#assertConnected();
    const result = await this.#request("/v1/adapters", { authenticated: true });
    if (result.protocol !== LOOPBACK_PROTOCOL || result.schema_version !== AGENT_CATALOG_SCHEMA) {
      throw clientError("PROTOCOL_MISMATCH", "本机 Runtime 与网页协议版本不一致。");
    }
    this.#workspace = safeWorkspaceBinding(result.workspace);
    if (!Array.isArray(result.adapters) || result.adapters.length > 24) {
      throw clientError("INVALID_ADAPTER_RESPONSE", "本机 Runtime 的引擎清单无效。");
    }
    return Object.freeze(result.adapters.map(safeAdapter));
  }

  async consentCodexPersonal() {
    this.#assertConnected();
    const result = await this.#request("/v1/adapters/codex/personal-consent", {
      method: "POST",
      body: {
        consent_version: "codex-personal-consent.v1",
        accepted: true,
      },
      authenticated: true,
    });
    if (result.protocol !== LOOPBACK_PROTOCOL) {
      throw clientError("PROTOCOL_MISMATCH", "本机 Runtime 与网页协议版本不一致。");
    }
    const adapter = safeAdapter(result.adapter);
    if (
      adapter.id !== "codex"
      || adapter.state !== "experimental_personal"
      || adapter.selectable !== true
      || adapter.execution_mode !== "personal_experimental"
      || adapter.framework_adapter_status !== "probe_only"
    ) {
      throw clientError("INVALID_ADAPTER_RESPONSE", "Runtime 返回了无效的 Codex 个人模式状态。");
    }
    return adapter;
  }

  async coach({ phase, engine, message = "", publicQuestion = null, trustedGrade = null, deidentifiedProgress } = {}) {
    this.#assertConnected();
    if (!["submission", "chat"].includes(phase)) {
      throw clientError("INVALID_COACH_PHASE", "Agent 仅接受提交后讲解或自然语言问答。");
    }
    const engineId = cleanText(engine, 64);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(engineId) || engineId === "content-only") {
      throw clientError("INVALID_ENGINE", "请选择 Runtime 报告可用的 Agent 引擎。");
    }
    const chatMessage = cleanText(message, MAX_CHAT_CHARS);
    if (phase === "chat" && !chatMessage) throw clientError("EMPTY_CHAT_MESSAGE", "请输入要问私教的问题。");
    const question = boundedQuestion(publicQuestion, { required: phase === "submission" });
    const body = {
      phase: phase === "submission" ? "submit" : phase,
      engine: engineId,
      public_question: question,
      deidentified_progress: boundedProgress(deidentifiedProgress),
    };
    if (trustedGrade) body.trusted_grade = boundedGrade(trustedGrade);
    if (phase === "submission" && !trustedGrade) throw clientError("INVALID_TRUSTED_GRADE", "提交后讲解缺少可信判分。");
    if (phase === "chat") body.message = chatMessage;
    const result = await this.#request("/v1/coach", { method: "POST", body, authenticated: true });
    if (result.protocol !== LOOPBACK_PROTOCOL) {
      throw clientError("PROTOCOL_MISMATCH", "本机 Runtime 与网页协议版本不一致。");
    }
    const coachingText = cleanText(result.coaching_text, MAX_COACHING_CHARS);
    if (!coachingText) throw clientError("EMPTY_AGENT_COACHING", "Agent 没有返回可显示的讲解。");
    return Object.freeze({
      coaching_text: coachingText,
      engine: cleanText(result.engine ?? result.adapter_id, 64) || engineId,
    });
  }

  #assertConnected() {
    if (!this.#token) throw clientError("RUNTIME_NOT_CONNECTED", "请先显式连接本机 Agent Runtime。");
  }

  async #request(pathname, { method = "GET", body, authenticated = false } = {}) {
    const url = new URL(pathname, this.#origin);
    if (url.origin !== this.#origin || !pathname.startsWith("/v1/")) {
      throw clientError("INVALID_RUNTIME_ENDPOINT", "拒绝访问非本机 Runtime 端点。");
    }
    const headers = {
      "Accept": "application/json",
      "X-Coach-Protocol": LOOPBACK_PROTOCOL,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated) {
      this.#assertConnected();
      headers.Authorization = `Bearer ${this.#token}`;
    }
    if (method !== "GET") headers["Idempotency-Key"] = String(this.#idFactory()).slice(0, 160);
    let response;
    try {
      response = await this.#fetch(url.href, {
        method,
        mode: "cors",
        headers,
        body: body === undefined ? undefined : JSON.stringify(cloneJson(body)),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        // Keep targetAddressSpace unset for the pinned 127.0.0.1 literal.
        // Current LNA distinguishes loopback from the "local" address space;
        // declaring "local" here makes Chromium reject the resolved loopback.
      });
    } catch {
      throw clientError("RUNTIME_UNREACHABLE", "本机 Agent Runtime 暂时无法连接。");
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw clientError("RUNTIME_RESPONSE_TOO_LARGE", "本机 Runtime 响应超过安全上限。");
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw clientError("RUNTIME_RESPONSE_TOO_LARGE", "本机 Runtime 响应超过安全上限。");
    let result = {};
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw clientError("INVALID_RUNTIME_RESPONSE", "本机 Runtime 返回了无效 JSON。");
    }
    if (!response.ok) {
      const rawReason = cleanText(result?.reason_code, 80);
      const reason = /^[a-z0-9_]{1,80}$/u.test(rawReason) ? rawReason : "runtime_request_failed";
      throw clientError(
        reason,
        RUNTIME_REASON_MESSAGES[reason] || "本机 Runtime 拒绝了本次请求；固定私教仍可使用。",
      );
    }
    return result;
  }
}

export function createLocalAgentClient(options) {
  return new LocalAgentClient(options);
}
