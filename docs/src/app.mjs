import { createWebCoachHarness } from "./harness.mjs";
import { createChatView } from "./chat-view.mjs";
import { createResponseTimer } from "./response-behavior.mjs";
import { HARNESS_ACTION_GROUPS } from "./harness-actions.mjs";
import { dispatchHarnessAction } from "./harness-action-router.mjs";
import { isDialogBackdropPoint, shouldDismissDialog } from "./dialog-interaction.mjs";
import {
  createLocalAgentClient,
  DEFAULT_RUNTIME_ORIGIN,
  isLocalAgentRuntimeOrigin,
  PUBLIC_COACH_ORIGIN,
} from "./local-agent-client.mjs";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const ANSWER_LABELS = /^[A-H]+$/u;
const BUSY_STATES = new Set(["loading", "generating_question", "evaluating"]);
const DIRECT_CONNECT_AGENT_IDS = new Set(["claude-code", "codex", "qwen-code", "codebuddy"]);
const RUNTIME_CONNECTION_STAGE_MESSAGES = Object.freeze({
  checking: "正在检查已运行的本机 Runtime；此操作由你刚才的点击触发……",
  launching: "尚未发现 Runtime，正在尝试唤起 macOS 应用；Linux 请先运行 start-local-coach……",
  waiting: "正在等待本机 Runtime；确认服务就绪后才会进入 127.0.0.1 配对页……",
  pairing: "Runtime 已就绪，正在打开本机确认页；授权令牌只留在当前页面内存……",
});

const elements = Object.freeze({
  timeline: document.querySelector("#chat-timeline"),
  optionPanel: document.querySelector("#option-panel"),
  input: document.querySelector("#answer-input"),
  submitButton: document.querySelector("#submit-answer"),
  answerForm: document.querySelector("#answer-form"),
  answerError: document.querySelector("#answer-error"),
  sessionLabel: document.querySelector("#session-label"),
  sessionDot: document.querySelector("#session-dot"),
  taskList: document.querySelector("#task-list"),
  taskSummary: document.querySelector("#task-summary"),
  subjectList: document.querySelector("#subject-list"),
  evidenceBadge: document.querySelector("#evidence-badge"),
  statusLine: document.querySelector("#app-status"),
  createProfile: document.querySelector("#create-profile"),
  importFile: document.querySelector("#import-file"),
  todayDate: document.querySelector("#today-date"),
  engineTrigger: document.querySelector("#engine-trigger"),
  engineTriggerLabel: document.querySelector("#engine-trigger-label"),
  engineDialog: document.querySelector("#engine-dialog"),
  engineDialogClose: document.querySelector("#engine-dialog-close"),
  engineList: document.querySelector("#engine-list"),
  modelProfilePanel: document.querySelector("#model-profile-panel"),
  modelProfileList: document.querySelector("#model-profile-list"),
  engineDialogStatus: document.querySelector("#engine-dialog-status"),
  runtimeConnect: document.querySelector("#runtime-connect"),
  runtimeInstallLink: document.querySelector("#runtime-install-link"),
  runtimeCalloutCopy: document.querySelector("#runtime-callout-copy"),
  toolButtons: [...document.querySelectorAll("[data-command]")],
});

const requiredElements = Object.entries(elements)
  .filter(([key, value]) => key !== "toolButtons" && !value)
  .map(([key]) => key);
if (requiredElements.length) throw new Error(`PAGE_CONTRACT_MISSING:${requiredElements.join(",")}`);

const responseTimer = createResponseTimer();

const chat = createChatView({
  timeline: elements.timeline,
  optionPanel: elements.optionPanel,
  input: elements.input,
  submitButton: elements.submitButton,
  sessionLabel: elements.sessionLabel,
  sessionDot: elements.sessionDot,
  taskList: elements.taskList,
  taskSummary: elements.taskSummary,
  subjectList: elements.subjectList,
  evidenceBadge: elements.evidenceBadge,
  statusLine: elements.statusLine,
  onOption: (value) => {
    elements.answerError.textContent = "";
    responseTimer.recordAnswer(value);
    elements.input.focus();
  },
  onSuggestion: async (actionId) => handleHarnessAction(actionId),
});

let coachPromise = null;
let unsubscribe = null;
let currentView = null;
let initialized = false;
let operating = false;
let localAgentClient = null;
let runtimeAdapters = [];
let runtimeWorkspace = null;
let selectedEngine = "content-only";
let selectedModelPreference = null;
let connectingRuntime = false;
let restoringProfile = false;
let dialogReturnFocus = null;
let dialogFocusAfterClose = null;
let pointerStartedOnBackdrop = false;

const LOOPBACK_RUNTIME_PAGE = isLocalAgentRuntimeOrigin(location.origin);
const PUBLIC_COACH_PAGE = location.origin === PUBLIC_COACH_ORIGIN;
const STATIC_AGENT_CATALOG = Object.freeze([
  Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    state: "framework_supported",
    selectable: false,
    detail: "Digital Employee 支持运行；连接后才检测本机版本、服务凭据和员工契约。",
  }),
  Object.freeze({
    id: "qoder",
    label: "Qoder CLI",
    state: "package_incompatible",
    selectable: false,
    detail: "本私教要求 structured_output；当前 Qoder Adapter 不满足，连接也不会冒充可用。",
  }),
  Object.freeze({
    id: "codex",
    label: "Codex CLI",
    state: "probe_only",
    selectable: false,
    detail: "Digital Employee 0.3.0 仍仅探测；连接后可明确同意使用本机个人实验模式。",
  }),
  Object.freeze({
    id: "qwen-code",
    label: "Qwen Code",
    state: "framework_supported",
    selectable: false,
    detail: "Digital Employee 支持运行；连接后才检测本机版本、服务凭据和模型配置。",
  }),
  Object.freeze({
    id: "codebuddy",
    label: "CodeBuddy Code",
    state: "framework_supported",
    selectable: false,
    detail: "Digital Employee 支持运行；连接后才检测本机版本、服务凭据和模型配置。",
  }),
  Object.freeze({
    id: "hermes",
    label: "Hermes Agent (Nous Research)",
    state: "probe_only",
    selectable: false,
    detail: "可以探测本机安装，但尚无通过本私教契约的运行 Adapter。",
  }),
]);
const ADAPTER_STATE_LABELS = Object.freeze({
  runtime_required: "本机尚未检测",
  framework_supported: "框架支持运行",
  package_incompatible: "本私教不兼容",
  ready: "可用",
  ready_unverified: "等待验证",
  consent_required: "需要本人同意",
  experimental_personal: "个人实验可用",
  needs_configuration: "需要配置",
  needs_login: "需要登录",
  probe_only: "仅检测",
  incompatible: "不兼容",
  unavailable: "不可用",
});
const ADAPTER_REASON_LABELS = Object.freeze({
  adapter_inspection_failed: "本机检测失败",
  host_not_ready: "本机引擎尚未就绪",
  host_adapter_not_runnable: "当前适配器不能运行",
  required_capability_unsupported: "缺少结构化输出能力",
  qwen_api_key_not_configured: "尚未配置 Qwen 服务凭据",
  codebuddy_api_key_not_configured: "尚未配置 CodeBuddy 服务凭据",
  codebuddy_model_not_configured: "尚未配置 CodeBuddy 模型",
  claude_version_probe_failed: "Claude Code 版本检测失败",
  codex_personal_consent_required: "需明确同意复用本机 ChatGPT / Codex 登录",
  codex_personal_mode_unqualified: "个人实验模式尚未通过 Digital Employee 工具白名单认证",
  codex_login_required: "请先在本机 Codex CLI 登录 ChatGPT",
  codex_executable_not_found: "本机未发现 Codex CLI",
  codex_version_probe_failed: "Codex CLI 版本检测失败",
  codex_version_not_audited: "当前只开放已审计的 Codex CLI 0.146.0",
  codex_auth_file_missing: "未找到可供本机个人模式复用的 Codex 登录",
  codex_auth_file_unsafe: "Codex 登录文件类型或权限不符合安全要求",
  codex_command_surface_unsupported: "Codex CLI 命令面与已审计版本不一致",
  hermes_adapter_not_implemented: "Digital Employee 尚无合格的 Hermes 运行适配器",
  hermes_executable_not_found: "本机未发现 Hermes Agent",
  hermes_version_probe_failed: "Hermes Agent 版本检测失败",
});

function safeMessage(error, fallback = "私人老师暂时无法继续，请稍后重试。") {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  return message && message.length <= 512 ? message : fallback;
}

function setToday() {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
  elements.todayDate.textContent = formatter.format(new Date());
  elements.todayDate.setAttribute("aria-label", `今天是 ${formatter.format(new Date())}`);
}

function adapterById(engine) {
  return runtimeAdapters.find((adapter) => adapter.id === engine) || null;
}

function engineDisplayName(engine = selectedEngine) {
  if (engine === "content-only") return "基础私教";
  return adapterById(engine)?.label || engine;
}

function agentChatAvailable() {
  return Boolean(
    localAgentClient?.connected &&
    selectedEngine !== "content-only" &&
    adapterById(selectedEngine)?.selectable === true,
  );
}

function dialogBusy() {
  return connectingRuntime || operating;
}

function answerSurfaceVisible() {
  return document.visibilityState !== "hidden" && document.hasFocus() && !elements.engineDialog.open;
}

function backdropPoint(event) {
  return isDialogBackdropPoint({
    targetIsDialog: event.target === elements.engineDialog,
    clientX: event.clientX,
    clientY: event.clientY,
    rect: elements.engineDialog.getBoundingClientRect(),
  });
}

function syncDialogBusy() {
  const busy = dialogBusy();
  elements.engineDialog.setAttribute("aria-busy", busy ? "true" : "false");
  elements.engineDialogClose.disabled = busy;
}

function requestEngineDialogClose({ focusTarget = null, force = false } = {}) {
  if (!elements.engineDialog.open || (!force && dialogBusy())) return false;
  dialogFocusAfterClose = focusTarget || dialogReturnFocus || elements.engineTrigger;
  if (typeof elements.engineDialog.close === "function") elements.engineDialog.close();
  else {
    elements.engineDialog.removeAttribute("open");
    responseTimer.setVisible(answerSurfaceVisible());
    dialogFocusAfterClose?.focus?.({ preventScroll: true });
    dialogFocusAfterClose = null;
  }
  return true;
}

function selectedAdapter() {
  return adapterById(selectedEngine);
}

function selectedModelProfile() {
  return selectedAdapter()?.model_preferences?.find((profile) => profile.id === selectedModelPreference) || null;
}

function renderModelProfiles() {
  const adapter = selectedAdapter();
  const profiles = adapter?.id === "codex"
    ? (adapter.model_preferences || []).filter((profile) => profile.selectable === true)
    : [];
  elements.modelProfilePanel.hidden = profiles.length === 0;
  if (!profiles.length) {
    elements.modelProfileList.replaceChildren();
    selectedModelPreference = null;
    return;
  }
  if (!profiles.some((profile) => profile.id === selectedModelPreference)) {
    selectedModelPreference = adapter.default_model_preference || profiles[0].id;
  }
  const descriptions = Object.freeze({
    lite: "较弱模型 · 速度因本机账号与服务负载而异",
    fast: "短问短答优先 · 本机 Runtime 已核验",
    balanced: "速度与分析平衡 · 本机 Runtime 已核验",
    deep: "复杂追问优先 · 本机 Runtime 已核验",
  });
  const cards = profiles.map((profile) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-profile-card";
    button.dataset.modelPreference = profile.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", profile.id === selectedModelPreference ? "true" : "false");
    button.tabIndex = profile.id === selectedModelPreference ? 0 : -1;
    button.disabled = operating;
    const title = document.createElement("strong");
    title.textContent = profile.label;
    const detail = document.createElement("small");
    detail.textContent = descriptions[profile.id] || "本机 Runtime 已核验";
    button.append(title, detail);
    button.addEventListener("click", () => {
      selectedModelPreference = profile.id;
      if (coachPromise) {
        void coachPromise.then((coach) => coach.setAgentModelPreference(profile.id));
      }
      renderModelProfiles();
      updateEngineUi(`已选择 ${engineDisplayName()} · ${profile.label}；从下一轮开始生效，学习档案不变。`);
      elements.modelProfileList.querySelector(`[data-model-preference="${profile.id}"]`)?.focus({ preventScroll: true });
    });
    button.addEventListener("keydown", (event) => {
      if (!new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]).has(event.key)) return;
      event.preventDefault();
      const current = profiles.findIndex((candidate) => candidate.id === profile.id);
      const target = event.key === "Home"
        ? 0
        : event.key === "End"
          ? profiles.length - 1
          : (current + (new Set(["ArrowLeft", "ArrowUp"]).has(event.key) ? -1 : 1) + profiles.length) % profiles.length;
      selectedModelPreference = profiles[target].id;
      if (coachPromise) void coachPromise.then((coach) => coach.setAgentModelPreference(selectedModelPreference));
      renderModelProfiles();
      elements.modelProfileList.querySelector(`[data-model-preference="${selectedModelPreference}"]`)?.focus({ preventScroll: true });
      updateEngineUi(`已选择 ${engineDisplayName()} · ${profiles[target].label}；从下一轮开始生效，学习档案不变。`);
    });
    return button;
  });
  elements.modelProfileList.replaceChildren(...cards);
}

const RUNTIME_SESSION_LOSS_CODES = new Set([
  "RUNTIME_NOT_CONNECTED",
  "RUNTIME_UNREACHABLE",
  "authentication_required",
]);

async function resetLostRuntimeConnection() {
  localAgentClient?.disconnect();
  localAgentClient = null;
  runtimeAdapters = [];
  runtimeWorkspace = null;
  selectedEngine = "content-only";
  selectedModelPreference = null;
  if (coachPromise) {
    try {
      const coach = await coachPromise;
      coach.setAgentClient(null);
      coach.setAgentPreference("content-only");
      coach.setAgentModelPreference(null);
    } catch {
      // A failed Harness initialization must not prevent the connection UI
      // from returning to the safe, retryable content-only state.
    }
  }
  updateRuntimeCallout();
  renderEngineList();
}

function updateEngineUi(message = "") {
  const display = engineDisplayName();
  const agentActive = agentChatAvailable();
  const runtimeConnected = Boolean(localAgentClient?.connected);
  elements.engineTrigger.dataset.connected = runtimeConnected ? "true" : "false";
  elements.engineTriggerLabel.textContent = agentActive
    ? `${display} · 本机 Agent`
    : runtimeConnected
      ? "基础私教 · Runtime 已连接"
      : "基础私教 · 连接本机 Agent";
  elements.engineDialogStatus.textContent = message || (
    localAgentClient?.connected
      ? `当前：${display}${agentActive ? " · Agent 讲解已启用" : " · Runtime 已连接"}`
      : "本机 Runtime 尚未连接；下列状态是框架能力，不代表本机已安装。"
  );
  chat.setAgentChatAvailable(agentActive);
  for (const button of elements.engineList.querySelectorAll("button[data-engine]")) {
    button.setAttribute("aria-pressed", button.dataset.engine === selectedEngine ? "true" : "false");
  }
  renderModelProfiles();
  if (initialized && currentView && !BUSY_STATES.has(currentView.state)) {
    chat.setComposer({ enabled: true, answering: currentView.state === "awaiting_answer" });
  }
}

function createEngineCard({ id, label, state, detail, reasons = [], selectable = false }) {
  const button = document.createElement("button");
  button.className = "engine-card";
  button.type = "button";
  button.dataset.engine = id;
  button.dataset.engineState = state;
  const directConnect = !localAgentClient?.connected && DIRECT_CONNECT_AGENT_IDS.has(id);
  const actionable = id === "content-only" || selectable || state === "consent_required" || directConnect;
  button.dataset.engineSelectable = id === "content-only" || selectable ? "true" : "false";
  button.dataset.engineActionable = actionable ? "true" : "false";
  button.dataset.engineEntry = directConnect ? "direct" : "status";
  button.setAttribute("aria-pressed", id === selectedEngine ? "true" : "false");
  button.disabled = operating || connectingRuntime || !actionable;

  const title = document.createElement("span");
  title.className = "engine-card__title";
  title.textContent = label;
  const status = document.createElement("span");
  status.className = "engine-card__state";
  status.textContent = id === "content-only"
    ? "始终可用"
    : directConnect
      ? "点击接入 →"
      : (ADAPTER_STATE_LABELS[state] || state);
  const copy = document.createElement("span");
  copy.className = "engine-card__detail";
  const reasonCopy = reasons.map((reason) => ADAPTER_REASON_LABELS[reason] || "需要在本机 Runtime 查看诊断");
  copy.textContent = id === "content-only"
    ? "固定题库、固定答案键、浏览器私人进度；不调用模型。"
    : [detail, ...new Set(reasonCopy)].filter(Boolean).join(" · ").slice(0, 720) || "状态由本机 Runtime 报告。";
  button.append(title, status, copy);
  button.addEventListener("click", () => {
    void selectEngine(id).catch((error) => {
      updateEngineUi(safeMessage(error, "目标 Agent 未能进入对话；基础私教和学习档案没有变化。"));
    });
  });
  return button;
}

function renderEngineList() {
  const contentOnly = createEngineCard({
    id: "content-only",
    label: "基础私教",
    state: "ready",
    selectable: true,
  });
  const visibleAdapters = localAgentClient?.connected
    ? runtimeAdapters
    : STATIC_AGENT_CATALOG;
  const cards = visibleAdapters.map((adapter) => createEngineCard(adapter));
  elements.engineList.replaceChildren(contentOnly, ...cards);
  updateEngineUi();
  syncDialogBusy();
}

function adapterDiagnostic(adapter) {
  const reasons = Array.isArray(adapter?.reasons) ? adapter.reasons : [];
  return [...new Set(reasons.map((reason) => ADAPTER_REASON_LABELS[reason] || "需在本机 Runtime 查看诊断"))]
    .filter(Boolean)
    .join("；");
}

async function enterAgentConversation(engine) {
  requestEngineDialogClose({ focusTarget: elements.input });
  const answering = currentView?.state === "awaiting_answer";
  chat.appendCoach([
    answering
      ? `${engineDisplayName(engine)} 已接入。请先完成当前题；作答前 Agent 不会介入题面。`
      : `${engineDisplayName(engine)} 已接入。可以直接点下面的选项继续；开放式问题仍可在输入框里补充。`,
  ], {
    annotation: "快捷选项由浏览器 Harness 固定提供，Agent 不能自行注入按钮或命令。",
    suggestions: answering ? HARNESS_ACTION_GROUPS.awaiting_answer : HARNESS_ACTION_GROUPS.agent_entry,
  });
  chat.setComposer({
    enabled: true,
    answering,
  });
  elements.input.focus({ preventScroll: true });
}

async function selectEngine(engine, { enterConversation = true } = {}) {
  if (operating || connectingRuntime) return;
  if (engine !== "content-only") {
    let adapter = adapterById(engine);
    if (!localAgentClient?.connected) {
      if (!DIRECT_CONNECT_AGENT_IDS.has(engine)) return false;
      return connectRuntime({ preferredEngine: engine });
    }
    if (engine === "codex" && adapter?.state === "consent_required") {
      const accepted = window.confirm(
        "启用 Codex CLI 个人实验模式？\n\n"
        + "它会复用你本机已登录的 ChatGPT / Codex 账号。提交后只向 Codex 发送科目、考点、掌握结果和去身份化进度，"
        + "不发送题干、选项、你的作答、参考答案、解析或登录文件内容；Codex 只能选择一个补救计划，由本地模板显示。"
        + "无题面复习时，你主动输入的追问会由 Codex 发往 OpenAI。学习进度仍由浏览器 Harness 决定。"
        + "此模式尚未通过 Digital Employee 工具白名单认证，授权仅在当前 Runtime 内存中有效。",
      );
      if (!accepted) {
        updateEngineUi("已取消 Codex 个人实验模式；基础私教和学习档案没有变化。");
        return false;
      }
      connectingRuntime = true;
      renderEngineList();
      updateEngineUi("正在为当前内存授权启用 Codex 个人实验模式……");
      let consentError = "";
      try {
        const refreshed = await localAgentClient.consentCodexPersonal();
        runtimeAdapters = runtimeAdapters.map((item) => item.id === "codex" ? refreshed : item);
        adapter = refreshed;
      } catch (error) {
        adapter = null;
        consentError = safeMessage(error, "Codex 个人实验模式未能启用；学习档案没有变化。");
      } finally {
        connectingRuntime = false;
        renderEngineList();
      }
      if (consentError) {
        updateEngineUi(consentError);
        return false;
      }
    }
    if (adapter?.selectable !== true) {
      const diagnosis = adapterDiagnostic(adapter);
      updateEngineUi(`${engineDisplayName(engine)} 已检测，但当前不可用${diagnosis ? `：${diagnosis}` : ""}。基础私教和学习档案没有变化。`);
      return false;
    }
  }
  selectedEngine = engine;
  const selected = adapterById(engine);
  selectedModelPreference = engine === "codex"
    ? (selected?.default_model_preference || selected?.model_preferences?.find((profile) => profile.selectable)?.id || null)
    : null;
  if (coachPromise) {
    const coach = await coachPromise;
    coach.setAgentPreference(engine);
    coach.setAgentModelPreference(selectedModelPreference);
  }
  updateEngineUi(`已选择：${engineDisplayName()}。学习档案、当前题目和进度均未改变。`);
  if (engine === "content-only") {
    requestEngineDialogClose({ focusTarget: elements.input });
    chat.appendSystem("已切回基础私教。固定题库、判分、计时和学习档案继续由浏览器 Harness 掌管。");
    chat.setComposer({ enabled: initialized, answering: currentView?.state === "awaiting_answer" });
  } else if (enterConversation) {
    await enterAgentConversation(engine);
  }
  return true;
}

async function connectRuntime({ preferredEngine = null } = {}) {
  if ((!LOOPBACK_RUNTIME_PAGE && !PUBLIC_COACH_PAGE) || connectingRuntime || operating) return;
  const previous = Object.freeze({
    client: localAgentClient,
    adapters: runtimeAdapters,
    workspace: runtimeWorkspace,
    engine: selectedEngine,
    modelPreference: selectedModelPreference,
  });
  let newClient = null;
  let connected = false;
  connectingRuntime = true;
  let completionMessage = "";
  elements.runtimeConnect.disabled = true;
  elements.engineTrigger.disabled = true;
  renderEngineList();
  elements.engineDialogStatus.textContent = "正在检测本机 Runtime；macOS 未启动时会尝试唤起应用，Linux 需先运行 start-local-coach……";
  try {
    newClient = createLocalAgentClient({
      origin: LOOPBACK_RUNTIME_PAGE ? location.origin : DEFAULT_RUNTIME_ORIGIN,
    });
    const connection = LOOPBACK_RUNTIME_PAGE
      ? await newClient.connect()
      : await newClient.wakeAndPair({
          windowRef: window,
          onStage(stage) {
            elements.engineDialogStatus.textContent = RUNTIME_CONNECTION_STAGE_MESSAGES[stage]
              || "正在连接本机 Runtime……";
          },
        });
    localAgentClient?.disconnect();
    localAgentClient = newClient;
    runtimeAdapters = connection.adapters;
    runtimeWorkspace = connection.workspace;
    const coach = await getCoach();
    coach.setAgentClient(newClient);
    selectedEngine = "content-only";
    selectedModelPreference = null;
    coach.setAgentPreference(selectedEngine);
    coach.setAgentModelPreference(null);
    connected = true;
    completionMessage = preferredEngine
      ? "本机 Runtime 已连接，正在验证你选择的 Agent……"
      : "本机 Runtime 已连接。可直接点击状态为“可用”的 Agent；基础私教仍可随时切回。";
  } catch (error) {
    newClient?.disconnect();
    localAgentClient = previous.client;
    runtimeAdapters = previous.adapters;
    runtimeWorkspace = previous.workspace;
    selectedEngine = previous.engine;
    selectedModelPreference = previous.modelPreference;
    completionMessage = safeMessage(error, "本机 Runtime 连接失败；基础私教不受影响。");
  } finally {
    connectingRuntime = false;
    elements.runtimeConnect.disabled = false;
    elements.engineTrigger.disabled = operating;
    updateRuntimeCallout();
    renderEngineList();
    updateEngineUi(completionMessage);
  }
  if (connected && preferredEngine) {
    return selectEngine(preferredEngine, { enterConversation: true });
  }
  return connected;
}

function updateRuntimeCallout() {
  if (localAgentClient?.connected) {
    const employee = runtimeWorkspace?.employee;
    const workspaceCopy = employee
      ? `已构建并锁定 Digital Employee 工作区：${employee.name} ${employee.version}（${employee.digest.slice(0, 19)}…）。`
      : "已连接本机 Runtime。";
    elements.runtimeCalloutCopy.textContent = `${workspaceCopy} 下方是本次对 Agent 安装、凭据和员工契约的真实检测结果；切换 Agent 只替换“大脑”，不会替换浏览器学习档案。`;
    elements.runtimeConnect.textContent = "重新检测本机 Agent";
    return;
  }
  elements.runtimeConnect.textContent = "检测全部本机 Agent";
  if (LOOPBACK_RUNTIME_PAGE) {
    elements.runtimeConnect.hidden = false;
    elements.runtimeInstallLink.hidden = true;
    elements.runtimeCalloutCopy.textContent = "当前页面由 127.0.0.1 本机 Runtime 提供。只有点击下方按钮后才会连接；授权令牌仅留在页面内存。";
  } else if (PUBLIC_COACH_PAGE) {
    elements.runtimeConnect.hidden = false;
    elements.runtimeInstallLink.hidden = false;
    elements.runtimeCalloutCopy.textContent = "直接点击下方想用的 Agent，页面会在这次点击内检测并连接 Runtime；macOS 未运行时可通过固定安全入口唤起应用，Linux 请先运行 start-local-coach。页面加载时不会扫描端口。";
  } else {
    elements.runtimeConnect.hidden = true;
    elements.runtimeInstallLink.hidden = false;
    elements.runtimeCalloutCopy.textContent = "这个预览来源不能连接本机 Runtime。请使用正式 GitHub Pages 页面。";
  }
}

function setupEngineControls() {
  updateRuntimeCallout();
  elements.engineTrigger.addEventListener("click", () => {
    dialogReturnFocus = document.activeElement;
    dialogFocusAfterClose = null;
    responseTimer.setVisible(false);
    if (typeof elements.engineDialog.showModal === "function") elements.engineDialog.showModal();
    else elements.engineDialog.setAttribute("open", "");
    syncDialogBusy();
  });
  elements.engineDialog.addEventListener("close", () => {
    responseTimer.setVisible(answerSurfaceVisible());
    const focusTarget = dialogFocusAfterClose || dialogReturnFocus || elements.engineTrigger;
    dialogFocusAfterClose = null;
    pointerStartedOnBackdrop = false;
    globalThis.requestAnimationFrame?.(() => focusTarget?.focus?.({ preventScroll: true }));
  });
  elements.engineDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!requestEngineDialogClose()) {
      elements.engineDialogStatus.textContent = "当前连接或请求仍在处理中，请稍候。";
    }
  });
  elements.engineDialogClose.addEventListener("click", () => requestEngineDialogClose());
  elements.engineDialog.addEventListener("pointerdown", (event) => {
    pointerStartedOnBackdrop = backdropPoint(event);
  });
  elements.engineDialog.addEventListener("pointercancel", () => {
    pointerStartedOnBackdrop = false;
  });
  elements.engineDialog.addEventListener("click", (event) => {
    const dismiss = shouldDismissDialog({
      busy: dialogBusy(),
      pointerStartedOnBackdrop,
      pointerEndedOnBackdrop: backdropPoint(event),
    });
    pointerStartedOnBackdrop = false;
    if (dismiss) requestEngineDialogClose();
  });
  elements.runtimeConnect.addEventListener("click", () => { void connectRuntime(); });
  renderEngineList();
}

function syncResponseTimer(view) {
  if (view?.state === "awaiting_answer" && view.question?.item_id && Number.isSafeInteger(view.revision)) {
    responseTimer.start({
      itemId: view.question.item_id,
      revision: view.revision,
      restored: restoringProfile,
      visible: document.visibilityState !== "hidden" && document.hasFocus(),
    });
    return;
  }
  responseTimer.clear();
}

function updateFromView(view) {
  if (view?.agent?.model_preference !== undefined) {
    selectedModelPreference = view.agent.model_preference;
  }
  currentView = view;
  chat.renderState(view);
  syncResponseTimer(view);
}

async function getCoach() {
  if (!coachPromise) {
    coachPromise = createWebCoachHarness()
      .then((coach) => {
        if (localAgentClient?.connected) coach.setAgentClient(localAgentClient);
        coach.setAgentPreference(selectedEngine);
        coach.setAgentModelPreference(selectedModelPreference);
        unsubscribe = coach.subscribe(updateFromView);
        return coach;
      })
      .catch((error) => {
        coachPromise = null;
        throw error;
      });
  }
  return coachPromise;
}

function setOperating(value, message = "") {
  operating = value;
  for (const button of elements.toolButtons) button.disabled = value;
  elements.engineTrigger.disabled = value || connectingRuntime;
  for (const button of elements.engineList.querySelectorAll("button[data-engine]")) {
    const unavailable = button.dataset.engineActionable !== "true";
    button.disabled = value || connectingRuntime || unavailable;
  }
  for (const button of elements.modelProfileList.querySelectorAll("button[data-model-preference]")) {
    button.disabled = value;
  }
  syncDialogBusy();
  if (value) {
    chat.setComposer({ enabled: initialized, busy: true });
    chat.setStatus(message || "正在处理……", "busy");
  } else if ((initialized && currentView) || agentChatAvailable()) {
    chat.setComposer({
      enabled: true,
      answering: currentView?.state === "awaiting_answer",
      busy: BUSY_STATES.has(currentView?.state),
    });
    if (elements.statusLine.dataset.state === "busy") {
      chat.setStatus(
        currentView
          ? `本地档案 · revision ${currentView.revision ?? "—"}`
          : "匿名 Agent 对话 · 尚未建立学习档案",
        currentView?.state ?? "ready",
      );
    }
  }
}

async function operate(message, action, { process: processSpec = null } = {}) {
  if (operating) {
    chat.appendSystem("上一条指令还在处理，请稍等。");
    return null;
  }
  setOperating(true, message);
  elements.answerError.textContent = "";
  const process = processSpec ? chat.startProcess(processSpec) : null;
  try {
    const result = await action({ process });
    if (result && typeof result === "object" && typeof result.state === "string") {
      updateFromView(result);
      if (RUNTIME_SESSION_LOSS_CODES.has(result?.agent?.failure?.code)) {
        await resetLostRuntimeConnection();
      }
    }
    process?.complete(processSpec?.completeLabel || "执行完成");
    return result;
  } catch (error) {
    process?.fail(processSpec?.failureLabel || "执行中止 · 未写入学习进度");
    if (RUNTIME_SESSION_LOSS_CODES.has(error?.code)) {
      await resetLostRuntimeConnection();
    }
    if (currentView?.state !== "error") {
      chat.appendCoach([safeMessage(error)], { error: true });
    }
    chat.setStatus("本次操作没有写入新的学习进度。", "error");
    return null;
  } finally {
    setOperating(false);
  }
}

function canonicalLabels(value) {
  const labels = String(value || "")
    .toUpperCase()
    .replace(/[\s,，、/]+/gu, "")
    .split("")
    .filter(Boolean);
  if (!labels.length || !ANSWER_LABELS.test(labels.join(""))) return null;
  if (new Set(labels).size !== labels.length) return null;
  return [...labels].sort().join("");
}

function parseAnswer(rawValue) {
  const response = canonicalLabels(String(rawValue || "").trim());
  return response ? { response } : null;
}

function knownOptionLabels() {
  const options = Array.isArray(currentView?.question?.options) ? currentView.question.options : [];
  return new Set(options.map((option) => String(option?.label || "").toUpperCase()).filter(Boolean));
}

function validForCurrentQuestion(response) {
  const allowed = knownOptionLabels();
  return allowed.size > 0 && [...response].every((label) => allowed.has(label));
}

function recognizeCommand(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  const compact = value.replace(/[\s，,。.!！?？/]+/gu, "");
  if (["查看进度", "进度", "status", "progress"].includes(compact)) return "progress";
  if (["今天学什么", "今日任务", "任务", "today", "tasks"].includes(compact)) return "tasks";
  if (["继续", "下一题", "next", "continue"].includes(compact)) return "continue";
  if (["出题", "开始", "开始诊断", "start", "question"].includes(compact)) return "question";
  if (["导出", "导出档案", "export"].includes(compact)) return "export";
  if (["导入", "导入档案", "import"].includes(compact)) return "import";
  if (["清除", "清除数据", "清除本机数据", "clear"].includes(compact)) return "clear";
  if (["帮助", "怎么用", "help", "?"].includes(compact)) return "help";
  return null;
}

function resetAnswerControls() {
  elements.input.value = "";
  chat.setSelected("");
}

async function launchCoach() {
  await operate("正在建立浏览器本地档案……", async () => {
    chat.clear();
    chat.appendLearner("在本浏览器建档，并立即开始诊断");
    const coach = await getCoach();
    const initial = await coach.initialize({ dailyMinutes: 45 });
    initialized = true;
    updateFromView(initial);
    const started = await coach.start();
    elements.input.focus();
    return started;
  });
}

async function submitAnswer(answer) {
  if (!currentView || currentView.state !== "awaiting_answer") {
    chat.appendCoach(["现在没有等待作答的题目。输入“出题”开始，或输入“查看进度”。"]);
    return;
  }
  if (!validForCurrentQuestion(answer.response)) {
    elements.answerError.textContent = "答案只能使用当前题目提供的 A–H 选项，重复字母也不接受。";
    elements.input.focus();
    return;
  }

  const behaviorSnapshot = responseTimer.snapshot();
  const behavior = behaviorSnapshot
    ? { ...behaviorSnapshot, confidence_source: "inferred" }
    : null;
  chat.appendLearner(answer.response);
  resetAnswerControls();
  const agentActive = agentChatAvailable();
  await operate("正在按固定答案键批改……", async ({ process }) => {
    const coach = await getCoach();
    const result = await coach.answer({
      response: answer.response,
      confidence: "auto",
      behavior,
      expectedRevision: currentView.revision,
      expectedItemId: currentView.question.item_id,
      onPhase(phase) {
        if (phase === "grading") process.advance("grade", "正在读取密封答案键");
        if (phase === "committing") process.advance("commit", "正在原子提交固定判分与行为证据");
        if (phase === "agent" && agentActive) process.advance("agent", `可信进度已提交；正在等待 ${engineDisplayName()}`);
        if (phase === "validating") process.advance("contract", "正在校验员工输出并生成可见视图");
      },
    });
    if (result?.agent?.failure) {
      process.complete("固定判分已保存 · Agent 讲解失败，可重连后继续", { throughId: "commit" });
    } else {
      process.advance("contract", agentActive
        ? "已收到经员工契约校验的讲解；固定判分不会被模型覆盖"
        : "固定答案判分和进度提交均已完成");
    }
    return result;
  }, {
    process: {
      title: agentActive ? `${engineDisplayName()} · 批改与讲解执行笺` : "基础私教 · 批改执行笺",
      engine: agentActive
        ? `${selectedModelProfile()?.label || "Runtime 默认档位"} · 判分先于 Agent`
        : "固定答案键 · 浏览器本地 Harness",
      completeLabel: agentActive ? "固定判分已保存 · Agent 讲解已收口" : "固定判分与进度已保存",
      failureLabel: "本轮执行中止 · 未完成的步骤没有写入进度",
      stages: [
        { id: "grade", label: "固定答案键判分", detail: "模型无权决定对错" },
        { id: "commit", label: "原子提交学习证据" },
        ...(agentActive ? [{ id: "agent", label: `等待 ${engineDisplayName()} 补充讲解` }] : []),
        { id: "contract", label: "校验并展示最终结果" },
      ],
    },
  });
}

async function showProgress() {
  if (!initialized) {
    chat.appendCoach(["我还没有读取或建立这台浏览器的私人档案。先点击“建档并开始诊断”。"]);
    return;
  }
  await operate("正在读取本地进度……", async () => {
    const coach = await getCoach();
    const view = await coach.status();
    currentView = view;
    chat.appendCoach(chat.progressSummary(view), {
      annotation: "只展示已有作答证据；没有证据的科目保持未测量。",
    });
    return null;
  });
}

function showTasks() {
  if (!initialized || !currentView) {
    chat.appendCoach(["建档后，我会把每天 45 分钟压成最多 3 个任务。先完成一次短诊断。"]);
    return;
  }
  chat.appendCoach(chat.taskSummaryCopy(currentView), {
    annotation: "优先高频、到期复测和当前最薄弱的识别能力。",
  });
}

async function continueStudy() {
  if (!initialized) {
    chat.appendCoach(["先建本浏览器私人档案，我才有权保存你的学习证据。"]);
    return;
  }
  if (BUSY_STATES.has(currentView?.state)) {
    chat.appendSystem("题目或批改仍在处理中，请稍等。");
    return;
  }
  if (currentView?.state === "awaiting_answer") {
    chat.appendCoach(["当前题还在等你作答。可输入 A–H；多选可输入 AC 或 A,C。"]);
    elements.input.focus();
    return;
  }

  await operate("正在安排下一步……", async () => {
    const coach = await getCoach();
    if (currentView?.state === "complete" || currentView?.state === "error") {
      return coach.start();
    }
    if (currentView?.state === "feedback") return coach.next();
    if (currentView?.state === "ready") return coach.next();
    return coach.start();
  });
}

async function exportProfile() {
  if (!initialized) {
    chat.appendCoach(["当前还没有可导出的私人档案。先建档并完成至少一次诊断。"]);
    return;
  }
  await operate("正在本机生成导出文件……", async () => {
    const coach = await getCoach();
    const payload = await coach.exportData();
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `architect-pass-coach-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    chat.appendCoach(["档案已在本机导出。文件含私人学习记录，请妥善保管；它没有自动上传。"]);
    return null;
  });
}

function requestImport() {
  if (operating) return;
  elements.importFile.click();
}

async function importProfile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    chat.appendCoach(["导入文件超过 2 MiB，已拒绝读取。正常的私人档案不会这么大。"], { error: true });
    return;
  }
  await operate("正在校验并导入本地档案……", async () => {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error("这不是有效的 JSON 档案文件。");
    }
    const coach = await getCoach();
    const imported = await coach.importData(payload);
    initialized = true;
    chat.clear();
    chat.appendLearner("导入我选择的本地私人档案");
    updateFromView(imported);
    chat.appendCoach(["导入完成。输入“查看进度”核对，或输入“出题”继续。"]);
    elements.input.focus();
    return imported;
  });
}

async function clearProfile() {
  const confirmed = window.confirm("确定清除这个站点在当前浏览器里的私人学习档案吗？导出文件不会被删除。此操作无法在网页内撤销。");
  if (!confirmed) return;
  await operate("正在清除当前浏览器数据……", async () => {
    const coach = await getCoach();
    await coach.clearData();
    unsubscribe?.();
    unsubscribe = null;
    coach.close();
    coachPromise = null;
    initialized = false;
    currentView = null;
    chat.clear();
    renderOnboarding("本机档案已经清除。我现在不知道你的学习进度；重新建档后会先诊断。");
    return null;
  });
}

function showHelp() {
  const lines = [
    "你可以像聊天一样输入：今天学什么、查看进度、继续、出题。",
    "答题时只需输入 A、AC 或 A,C；私教会按题目长短计算参考用时，再以实际前台做题时间为主自动判断，交卷后显示时间依据。",
    agentChatAvailable()
      ? `当前已选择 ${engineDisplayName()}：完成客观题后会生成个性化讲解；不在答题状态时也可以直接提问。`
      : "基础私教不调用模型，只执行确定性的学习指令；可从顶部选择本机 Agent。",
  ];
  chat.appendCoach(lines);
}

async function askAgent(raw) {
  const engine = engineDisplayName();
  const result = await operate(`正在请 ${engine} 结合你的弱项回答……`, async ({ process }) => {
    const coach = await getCoach();
    process.advance("agent", "请求已交给本机 Runtime；页面正在等待结构化回复");
    const reply = await coach.askAgent(raw);
    process.advance("contract", "已收到回复；正在校验边界并准备展示");
    chat.appendCoach([reply.coaching_text], {
      annotation: `讲解引擎 ${reply.engine}${reply.model_preference ? ` · ${reply.model_preference}` : selectedModelProfile()?.label ? ` · ${selectedModelProfile().label}` : ""} · 本次对话不写入学习进度`,
      suggestions: currentView?.state === "feedback"
        ? HARNESS_ACTION_GROUPS.agent_reply_feedback
        : HARNESS_ACTION_GROUPS.agent_reply,
    });
    return true;
  }, {
    process: {
      title: `${engine} · 执行笺`,
      engine: "本机 Agent 调用 · 学习进度只读",
      completeLabel: `${engine} · 回复已完成`,
      stages: [
        {
          id: "context",
          label: "准备允许字段",
          detail: "仅在浏览器内整理当前教学上下文，不发送身份与本地路径",
        },
        { id: "agent", label: `等待 ${engine} 返回` },
        { id: "contract", label: "校验回复并展示" },
      ],
    },
  });
  return result === true;
}

async function handleHarnessAction(actionId) {
  return dispatchHarnessAction(actionId, {
    operating,
    state: currentView?.state,
    agentAvailable: agentChatAvailable(),
    onLearnerChoice: (label) => chat.appendLearner(label),
    runCommand: handleCommand,
    focusAnswer: () => elements.input.focus({ preventScroll: true }),
    askAgent,
    onBlocked: (message) => chat.appendSystem(message),
    onDisconnected: () => chat.appendCoach([
      "当前 Agent 已断开。请重新选择一个可用 Agent；学习档案没有变化。",
    ], { error: true }),
  });
}

async function handleCommand(command) {
  if (command === "progress") return showProgress();
  if (command === "tasks") return showTasks();
  if (command === "continue") return continueStudy();
  if (command === "question") return continueStudy();
  if (command === "export") return exportProfile();
  if (command === "import") return requestImport();
  if (command === "clear") return clearProfile();
  return showHelp();
}

async function handleChatInput(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    elements.answerError.textContent = "请输入学习指令或答案。";
    return;
  }
  const command = recognizeCommand(raw);
  if (command) {
    chat.appendLearner(raw);
    resetAnswerControls();
    await handleCommand(command);
    return;
  }

  const answer = parseAnswer(raw);
  if (currentView?.state === "awaiting_answer" && answer) {
    await submitAnswer(answer);
    return;
  }

  chat.appendLearner(raw);
  resetAnswerControls();
  if (currentView?.state === "awaiting_answer") {
    chat.appendCoach(["这是一道客观题，请输入 A–H；多选可输入 AC 或 A,C。要看可用指令，输入“帮助”。"]);
  } else if (agentChatAvailable()) {
    await askAgent(raw);
  } else if (!initialized) {
    chat.appendCoach(["我还没有获得本浏览器档案的本地授权。请先点击“建档并开始诊断”。"]);
  } else {
    showHelp();
  }
}

function renderOnboarding(message) {
  chat.setComposer({ enabled: false });
  chat.setStatus("尚未读取本浏览器档案。", "ready");
  chat.appendCoach([
    message || "我现在还不知道你的学习进度，也不会猜。",
    "在这个浏览器里建一份私人档案后，我会立即用综合客观题做短诊断。",
  ], {
    action: {
      label: "在本浏览器建档并开始诊断",
      onClick: launchCoach,
    },
  });
}

async function restoreExistingProfile() {
  elements.createProfile.disabled = true;
  restoringProfile = true;
  setOperating(true, "正在只读检查本浏览器是否已有档案……");
  try {
    const coach = await getCoach();
    const existing = await coach.restore();
    if (!existing) {
      chat.setStatus("尚无本地档案 · 点击后才会创建", "ready");
      elements.createProfile.disabled = false;
      return;
    }

    initialized = true;
    currentView = existing;
    chat.clear();
    updateFromView(existing);
    chat.appendCoach([
      existing.knowsProgress
        ? "欢迎回来。已有的作答证据已经恢复，可以直接继续今天的任务。"
        : "欢迎回来。本地档案已经恢复，但证据仍不足，先完成一次短诊断。",
    ], {
      action: {
        label: "继续今天的复习",
        onClick: continueStudy,
      },
    });
    chat.setStatus("已只读恢复本浏览器档案", "ready");
    elements.input.focus();
  } catch (error) {
    initialized = false;
    currentView = null;
    chat.clear();
    chat.appendCoach([
      safeMessage(error),
      "系统没有覆盖异常数据。你可以导入可信备份，或确认后清除本机数据再建档。",
    ], { error: true });
    chat.setComposer({ enabled: false });
    chat.setStatus("本地状态校验失败 · 未覆盖", "error");
  } finally {
    restoringProfile = false;
    setOperating(false);
  }
}

elements.createProfile.addEventListener("click", launchCoach, { once: true });
elements.answerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (operating) return;
  await handleChatInput(elements.input.value);
});
elements.input.addEventListener("input", () => {
  elements.answerError.textContent = "";
  if (currentView?.state === "awaiting_answer") {
    const answer = parseAnswer(elements.input.value);
    if (answer) {
      chat.setSelected(answer.response, { syncInput: false });
      responseTimer.recordAnswer(answer.response);
    }
  }
});
document.addEventListener("visibilitychange", () => {
  responseTimer.setVisible(answerSurfaceVisible());
});
window.addEventListener("blur", () => responseTimer.setVisible(false));
window.addEventListener("focus", () => responseTimer.setVisible(answerSurfaceVisible()));
elements.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  elements.answerForm.requestSubmit();
});
for (const button of elements.toolButtons) {
  button.addEventListener("click", () => handleCommand(button.dataset.command));
}
elements.importFile.addEventListener("change", async () => {
  const [file] = elements.importFile.files || [];
  elements.importFile.value = "";
  await importProfile(file);
});

setToday();
setupEngineControls();
chat.setComposer({ enabled: false });
chat.setStatus(
  LOOPBACK_RUNTIME_PAGE
    ? "本机 Runtime 页面 · 尚未连接 Agent · 学习数据仍仅存浏览器"
    : PUBLIC_COACH_PAGE
      ? "网页私教 · 可显式连接本机 Agent · 数据仅存当前浏览器"
      : "网页预览 · 数据仅存当前浏览器",
  "ready",
);

if (
  "serviceWorker" in navigator &&
  (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))
) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
    chat.setStatus("页面可正常使用；离线缓存暂未启用。", "ready");
  });
}

restoreExistingProfile();
