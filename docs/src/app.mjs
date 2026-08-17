import { createWebCoachHarness } from "./harness.mjs";
import { createChatView } from "./chat-view.mjs";
import { createResponseTimer } from "./response-behavior.mjs";
import { HARNESS_ACTION_GROUPS } from "./harness-actions.mjs";
import { dispatchHarnessAction } from "./harness-action-router.mjs";
import { isDialogBackdropPoint, shouldDismissDialog } from "./dialog-interaction.mjs";
import {
  assertLocalAgentAccess,
  localAgentGateCopy,
  localAgentGateState,
  LOCAL_AGENT_GATE_STATES,
} from "./local-agent-gate.mjs";
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
const MOBILE_LOCAL_AGENT_UNAVAILABLE = navigator.userAgentData?.mobile === true
  || /Android|iPhone|iPad|iPod|\bMobile\b/u.test(String(navigator.userAgent || ""));

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
  chatSheet: document.querySelector(".chat-sheet"),
  agentGate: document.querySelector("#agent-gate"),
  agentGateTitle: document.querySelector("#agent-gate-title"),
  agentGateDetail: document.querySelector("#agent-gate-detail"),
  agentGateConnect: document.querySelector("#agent-gate-connect"),
  agentGateStatus: document.querySelector("#agent-gate-status"),
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
  engineHelpPanel: document.querySelector("#engine-help-panel"),
  engineHelpClose: document.querySelector("#engine-help-close"),
  engineHelpTitle: document.querySelector("#engine-help-title"),
  engineHelpCopy: document.querySelector("#engine-help-copy"),
  engineHelpCommand: document.querySelector("#engine-help-command"),
  engineHelpLink: document.querySelector("#engine-help-link"),
  engineHelpRetest: document.querySelector("#engine-help-retest"),
  engineHelpStatus: document.querySelector("#engine-help-status"),
  runtimeConnect: document.querySelector("#runtime-connect"),
  runtimeInstallLink: document.querySelector("#runtime-install-link"),
  runtimeCalloutCopy: document.querySelector("#runtime-callout-copy"),
  toolButtons: [...document.querySelectorAll("[data-command]")],
  agentRequiredButtons: [...document.querySelectorAll("[data-requires-agent]")],
});

const requiredElements = Object.entries(elements)
  .filter(([key, value]) => !["toolButtons", "agentRequiredButtons"].includes(key) && !value)
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
let profileRestoreAttempted = false;
let profileRestoreFailed = false;
let onboardingRendered = false;
let agentGateMessage = "";
let previousAgentGateState = LOCAL_AGENT_GATE_STATES.REQUIRED;
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
    detail: "可以探测本机安装；连接后可明确同意使用本机个人实验模式。",
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
  codex_version_not_audited: "当前只开放已审计的 Codex CLI 0.146.0 / 0.147.0",
  codex_auth_file_missing: "未找到可供本机个人模式复用的 Codex 登录",
  codex_auth_file_unsafe: "Codex 登录文件类型或权限不符合安全要求",
  codex_command_surface_unsupported: "Codex CLI 命令面与已审计版本不一致",
  qoder_local_consent_required: "需明确同意复用本机 Qoder CLI 登录",
  qoder_local_mode_unqualified: "本机模式尚未通过 Digital Employee 工具白名单认证",
  qoder_login_required: "请先在本机完成 qodercli 登录",
  qoder_executable_not_found: "本机未发现 Qoder CLI",
  qoder_status_probe_failed: "Qoder CLI 状态检测失败",
  qoder_status_invalid: "Qoder CLI 状态输出无效",
  hermes_local_consent_required: "需明确同意复用本机 Hermes 登录",
  hermes_local_mode_unqualified: "本机模式尚未通过 Digital Employee 工具白名单认证",
  hermes_login_required: "请先在本机完成 hermes 登录",
  hermes_executable_not_found: "本机未发现 Hermes Agent",
  hermes_status_probe_failed: "Hermes Agent 状态检测失败",
  hermes_status_invalid: "Hermes Agent 状态输出无效",
  hermes_adapter_not_implemented: "Digital Employee 尚无合格的 Hermes 运行适配器",
  hermes_version_probe_failed: "Hermes Agent 版本检测失败",
});
const ENGINE_INSTALL_GUIDES = Object.freeze({
  codex: Object.freeze({
    title: "启用 Codex CLI",
    copy: "Codex CLI 未安装或尚未登录。请先在本机安装并登录 OpenAI Codex，之后点“重新检测”；"
      + "本机复用你已登录的 ChatGPT / Codex 账号，无需配置服务令牌。",
    command: "codex install",
    href: "https://github.com/openai/codex",
  }),
  qoder: Object.freeze({
    title: "启用 Qoder CLI",
    copy: "Qoder CLI 未安装或尚未登录。请先在本机安装并登录 Qoder CLI，之后点“重新检测”；"
      + "本机复用你已登录的 Qoder 账号，无需配置服务令牌。",
    command: null,
    href: "https://docs.qoder.com",
  }),
  hermes: Object.freeze({
    title: "启用 Hermes Agent",
    copy: "Hermes Agent 未安装或尚未配置模型凭据。请先在终端执行官方安装命令并完成配置，之后点“重新检测”；"
      + "本机复用 ~/.hermes/.env 里你已配置的凭据，无需在这里填写任何令牌。",
    command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    href: "https://hermes-agent.nousresearch.com",
  }),
});
const ENGINE_HELP_REASONS = Object.freeze({
  codex_executable_not_found: "codex",
  codex_login_required: "codex",
  codex_auth_file_missing: "codex",
  qoder_executable_not_found: "qoder",
  qoder_login_required: "qoder",
  hermes_executable_not_found: "hermes",
  hermes_login_required: "hermes",
});

function safeMessage(error, fallback = "本机 Agent 暂时无法继续，请稍后重试。") {
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
  if (engine === "content-only") return "尚未选择 Agent";
  return adapterById(engine)?.label || engine;
}

function currentAgentGateState() {
  return localAgentGateState({
    connected: localAgentClient?.connected === true,
    engine: selectedEngine,
    selectable: adapterById(selectedEngine)?.selectable === true,
  });
}

function agentChatAvailable() {
  return currentAgentGateState() === LOCAL_AGENT_GATE_STATES.READY && !profileRestoreFailed;
}

function dialogBusy() {
  return connectingRuntime || operating;
}

function answerSurfaceVisible() {
  return agentChatAvailable()
    && document.visibilityState !== "hidden"
    && document.hasFocus()
    && !elements.engineDialog.open;
}

function syncAgentGate(message = "") {
  const state = currentAgentGateState();
  const ready = state === LOCAL_AGENT_GATE_STATES.READY;
  const interactive = ready && !profileRestoreFailed;
  const relocked = previousAgentGateState === LOCAL_AGENT_GATE_STATES.READY && !ready;
  previousAgentGateState = state;
  const copy = localAgentGateCopy(state);
  if (ready) agentGateMessage = "";
  else if (message) agentGateMessage = message;
  elements.chatSheet.dataset.agentReady = ready ? "true" : "false";
  elements.agentGate.hidden = ready;
  elements.timeline.hidden = !ready;
  elements.timeline.setAttribute("aria-hidden", ready ? "false" : "true");
  elements.answerForm.hidden = !interactive;
  elements.optionPanel.hidden = !interactive || currentView?.state !== "awaiting_answer";
  elements.taskList.hidden = !interactive;
  elements.taskSummary.hidden = !interactive;
  elements.subjectList.hidden = !interactive;
  elements.evidenceBadge.hidden = !interactive;
  elements.timeline.inert = !ready;
  elements.optionPanel.inert = !interactive;
  elements.answerForm.inert = !interactive;
  elements.agentGateTitle.textContent = copy.title;
  elements.agentGateDetail.textContent = copy.detail;
  elements.agentGateConnect.textContent = copy.action;
  elements.agentGateConnect.disabled = ready || connectingRuntime || operating || MOBILE_LOCAL_AGENT_UNAVAILABLE;
  elements.engineTrigger.disabled = operating || connectingRuntime || MOBILE_LOCAL_AGENT_UNAVAILABLE;
  elements.agentGateStatus.textContent = MOBILE_LOCAL_AGENT_UNAVAILABLE
    ? "当前移动设备无法连接电脑上的 Runtime。请在安装了 Runtime 的桌面 Chrome 或 Edge 中打开本页。"
    : agentGateMessage || (
      state === LOCAL_AGENT_GATE_STATES.CHOOSE_AGENT
        ? "Runtime 已通过身份与工作区检查；选择一个标记为可用的 Agent 才会解锁。"
        : "未连接时，对话、建档、出题和复习均保持锁定。桌面 Chrome / Edge 是当前配对主路径。"
    );
  chat.setAgentChatAvailable(interactive);
  for (const button of elements.agentRequiredButtons) {
    const allowsRepair = button.hasAttribute("data-allows-profile-repair");
    button.disabled = !ready || operating || (profileRestoreFailed && !allowsRepair);
  }
  elements.importFile.disabled = !ready || operating;
  if (!interactive) {
    responseTimer.setVisible(false);
    chat.setComposer({ enabled: false });
    elements.sessionLabel.textContent = profileRestoreFailed
      ? "档案需要处理"
      : state === LOCAL_AGENT_GATE_STATES.CHOOSE_AGENT ? "等待选择 Agent" : "等待本机 Agent";
    elements.sessionDot.dataset.state = "";
  } else if (!operating) {
    chat.setComposer({
      enabled: true,
      answering: currentView?.state === "awaiting_answer",
      busy: BUSY_STATES.has(currentView?.state),
    });
  }
  if (relocked) {
    globalThis.requestAnimationFrame?.(() => elements.agentGate.focus({ preventScroll: true }));
  }
  return state;
}

function requireLocalAgentAccess(
  message = "请先连接并选择一个可用的本机 Agent。",
  { allowProfileRepair = false } = {},
) {
  try {
    assertLocalAgentAccess({
      connected: localAgentClient?.connected === true,
      engine: selectedEngine,
      selectable: adapterById(selectedEngine)?.selectable === true,
    });
    if (profileRestoreFailed && !allowProfileRepair) {
      const repairMessage = "本地档案校验失败。请先导入可信备份，或清除本机数据后重新建档。";
      syncAgentGate(repairMessage);
      chat.setStatus(repairMessage, "error");
      return false;
    }
    return true;
  } catch {
    syncAgentGate(message);
    chat.setStatus(message, "agent-required");
    return false;
  }
}

function openEngineDialog() {
  if (MOBILE_LOCAL_AGENT_UNAVAILABLE) {
    syncAgentGate("当前移动设备无法连接电脑上的 Runtime。请改用安装了 Runtime 的桌面 Chrome 或 Edge。");
    return;
  }
  if (elements.engineDialog.open) return;
  dialogReturnFocus = document.activeElement;
  dialogFocusAfterClose = null;
  responseTimer.setVisible(false);
  if (typeof elements.engineDialog.showModal === "function") elements.engineDialog.showModal();
  else elements.engineDialog.setAttribute("open", "");
  elements.engineTrigger.setAttribute("aria-expanded", "true");
  elements.agentGateConnect.setAttribute("aria-expanded", "true");
  syncDialogBusy();
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
    elements.engineTrigger.setAttribute("aria-expanded", "false");
    elements.agentGateConnect.setAttribute("aria-expanded", "false");
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
      // A failed Harness initialization must not prevent the Page from
      // returning to the mandatory, retryable Local Agent gate.
    }
  }
  updateRuntimeCallout();
  renderEngineList();
  syncAgentGate("本机 Agent 连接已中断。已提交的学习证据保持不变；重新接入前不会继续对话或复习。");
}

function updateEngineUi(message = "") {
  const display = engineDisplayName();
  const agentSelected = currentAgentGateState() === LOCAL_AGENT_GATE_STATES.READY;
  const runtimeConnected = Boolean(localAgentClient?.connected);
  elements.engineTrigger.dataset.connected = runtimeConnected ? "true" : "false";
  elements.engineTriggerLabel.textContent = agentSelected
    ? `${display} · 本机 Agent`
    : runtimeConnected
      ? "Runtime 已连接 · 选择 Agent"
      : "尚未接入 · 连接本机 Agent";
  elements.engineDialogStatus.textContent = message || (
    localAgentClient?.connected
      ? `当前：${display}${agentSelected ? " · Agent 已选择" : " · Runtime 已连接"}`
      : "本机 Runtime 尚未连接；下列状态是框架能力，不代表本机已安装。"
  );
  for (const button of elements.engineList.querySelectorAll("button[data-engine]")) {
    button.setAttribute("aria-pressed", button.dataset.engine === selectedEngine ? "true" : "false");
  }
  renderModelProfiles();
  syncAgentGate(agentSelected ? "" : message);
}

function engineHelpEngine(adapter) {
  const reasons = Array.isArray(adapter?.reasons) ? adapter.reasons : [];
  for (const reason of reasons) {
    if (ENGINE_HELP_REASONS[reason] && ENGINE_INSTALL_GUIDES[ENGINE_HELP_REASONS[reason]]) {
      return ENGINE_HELP_REASONS[reason];
    }
  }
  return null;
}

function openEngineHelp(engine) {
  const guide = ENGINE_INSTALL_GUIDES[engine];
  if (!guide || !localAgentClient?.connected) return false;
  elements.engineHelpTitle.textContent = guide.title;
  elements.engineHelpCopy.textContent = guide.copy;
  elements.engineHelpCommand.textContent = guide.command || "";
  elements.engineHelpCommand.hidden = !guide.command;
  elements.engineHelpLink.href = guide.href;
  elements.engineHelpLink.hidden = !guide.href;
  elements.engineHelpStatus.textContent = "";
  elements.engineHelpRetest.dataset.engine = engine;
  elements.engineHelpPanel.hidden = false;
  elements.engineHelpClose.focus({ preventScroll: true });
  return true;
}

function closeEngineHelp() {
  elements.engineHelpPanel.hidden = true;
  elements.engineHelpStatus.textContent = "";
  delete elements.engineHelpRetest.dataset.engine;
}

async function retestEngineHelp() {
  const engine = elements.engineHelpRetest.dataset.engine;
  if (!engine || operating || connectingRuntime) return;
  elements.engineHelpStatus.textContent = "正在重新检测本机安装……";
  try {
    const refreshed = await localAgentClient.preflight(engine);
    runtimeAdapters = runtimeAdapters.map((item) => item.id === engine ? refreshed : item);
    elements.engineHelpStatus.textContent = refreshed.selectable === true
      ? "检测完成：已就绪，可以直接点引擎卡片同意启用。"
      : `检测完成：${adapterDiagnostic(refreshed) || "仍不可用"}。`;
    renderEngineList();
  } catch (error) {
    elements.engineHelpStatus.textContent = safeMessage(error, "重新检测失败；请确认 Runtime 仍在运行。");
  }
}

function createEngineCard({ id, label, state, detail, reasons = [], selectable = false }) {
  const button = document.createElement("button");
  button.className = "engine-card";
  button.type = "button";
  button.dataset.engine = id;
  button.dataset.engineState = state;
  const directConnect = !localAgentClient?.connected && DIRECT_CONNECT_AGENT_IDS.has(id);
  const helpEngine = localAgentClient?.connected ? engineHelpEngine({ id, reasons }) : null;
  const actionable = selectable || state === "consent_required" || directConnect || helpEngine !== null;
  button.dataset.engineSelectable = selectable ? "true" : "false";
  button.dataset.engineActionable = actionable ? "true" : "false";
  button.dataset.engineEntry = directConnect ? "direct" : (helpEngine ? "help" : "status");
  button.setAttribute("aria-pressed", id === selectedEngine ? "true" : "false");
  button.disabled = operating || connectingRuntime || !actionable;

  const title = document.createElement("span");
  title.className = "engine-card__title";
  title.textContent = label;
  const status = document.createElement("span");
  status.className = "engine-card__state";
  status.textContent = directConnect
    ? "点击接入 →"
    : helpEngine
      ? "查看安装 / 登录引导 →"
      : (ADAPTER_STATE_LABELS[state] || state);
  const copy = document.createElement("span");
  copy.className = "engine-card__detail";
  const reasonCopy = reasons.map((reason) => ADAPTER_REASON_LABELS[reason] || "需要在本机 Runtime 查看诊断");
  copy.textContent = [detail, ...new Set(reasonCopy)].filter(Boolean).join(" · ").slice(0, 720) || "状态由本机 Runtime 报告。";
  button.append(title, status, copy);
  button.addEventListener("click", () => {
    if (helpEngine) {
      openEngineHelp(helpEngine);
      return;
    }
    void selectEngine(id).catch((error) => {
      updateEngineUi(safeMessage(error, "目标 Agent 未能进入对话；学习档案没有变化，私教仍保持锁定。"));
    });
  });
  return button;
}

function renderEngineList() {
  const visibleAdapters = localAgentClient?.connected
    ? runtimeAdapters
    : STATIC_AGENT_CATALOG;
  const cards = visibleAdapters.map((adapter) => createEngineCard(adapter));
  elements.engineList.replaceChildren(...cards);
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
  syncAgentGate();
  requestEngineDialogClose({ focusTarget: elements.input });
  if (!profileRestoreAttempted) await restoreExistingProfile();
  if (profileRestoreFailed) {
    syncAgentGate("本地档案校验失败。请先导入可信备份，或清除本机数据后重新建档。");
    return false;
  }
  if (!initialized && !onboardingRendered) {
    renderOnboarding("本机 Agent 已接入。我仍不知道你的学习进度；明确建档后才会开始诊断。");
  }
  syncResponseTimer(currentView);
  const answering = currentView?.state === "awaiting_answer";
  chat.appendHarness([
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

function personalConsentConfirmText(engine) {
  if (engine === "codex") {
    return "启用 Codex CLI 个人实验模式？\n\n"
      + "它会复用你本机已登录的 ChatGPT / Codex 账号。提交后只向 Codex 发送科目、考点、掌握结果和去身份化进度，"
      + "不发送题干、选项、你的作答、参考答案、解析或登录文件内容；Codex 只能选择一个补救计划，由本地模板显示。"
      + "无题面复习时，你主动输入的追问会由 Codex 发往 OpenAI。学习进度仍由浏览器 Harness 决定。"
      + "此模式尚未通过 Digital Employee 工具白名单认证，授权仅在当前 Runtime 内存中有效。";
  }
  if (engine === "hermes") {
    return "启用 Hermes Agent 本机模式？\n\n"
      + "它会复用你本机已登录的 Hermes Agent 账号，不需要配置任何服务令牌。"
      + "提交后只向 Hermes 发送科目、考点、掌握结果和去身份化进度；当前题引导时会附上题目本身但绝不附带答案。"
      + "你主动输入的追问会由 Hermes 发往其在线服务。学习进度仍由浏览器 Harness 决定。"
      + "此模式尚未通过 Digital Employee 工具白名单认证，授权仅在当前 Runtime 内存中有效。";
  }
  return "启用 Qoder CLI 本机模式？\n\n"
    + "它会直接复用你本机已登录的 Qoder CLI 账号，不需要配置任何服务令牌。"
    + "提交后只向 Qoder 发送科目、考点、掌握结果和去身份化进度；当前题引导时会附上题目本身但绝不附带答案。"
    + "你主动输入的追问会由 Qoder 发往其在线服务。学习进度仍由浏览器 Harness 决定。"
    + "此模式尚未通过 Digital Employee 工具白名单认证，授权仅在当前 Runtime 内存中有效。";
}

async function selectEngine(engine, { enterConversation = true } = {}) {
  if (operating || connectingRuntime) return;
  if (engine === "content-only") return false;
  {
    let adapter = adapterById(engine);
    if (!localAgentClient?.connected) {
      if (!DIRECT_CONNECT_AGENT_IDS.has(engine)) return false;
      return connectRuntime({ preferredEngine: engine });
    }
    if ((engine === "codex" || engine === "qoder" || engine === "hermes") && adapter?.state === "consent_required") {
      const accepted = window.confirm(personalConsentConfirmText(engine));
      if (!accepted) {
        updateEngineUi(`已取消 ${engineDisplayName(engine)} 本机模式；学习档案没有变化，私教仍保持锁定。`);
        return false;
      }
      connectingRuntime = true;
      renderEngineList();
      updateEngineUi(`正在为当前内存授权启用 ${engineDisplayName(engine)} 本机模式……`);
      let consentError = "";
      try {
        const refreshed = engine === "codex"
          ? await localAgentClient.consentCodexPersonal()
          : engine === "qoder"
            ? await localAgentClient.consentQoderLocal()
            : await localAgentClient.consentHermesLocal();
        runtimeAdapters = runtimeAdapters.map((item) => item.id === engine ? refreshed : item);
        adapter = refreshed;
      } catch (error) {
        adapter = null;
        consentError = safeMessage(error, `${engineDisplayName(engine)} 本机模式未能启用；学习档案没有变化。`);
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
      updateEngineUi(`${engineDisplayName(engine)} 已检测，但当前不可用${diagnosis ? `：${diagnosis}` : ""}。学习档案没有变化，私教仍保持锁定。`);
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
  if (enterConversation) {
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
      : "本机 Runtime 已连接。请选择状态为“可用”的 Agent；选择前私教仍保持锁定。";
  } catch (error) {
    newClient?.disconnect();
    localAgentClient = previous.client;
    runtimeAdapters = previous.adapters;
    runtimeWorkspace = previous.workspace;
    selectedEngine = previous.engine;
    selectedModelPreference = previous.modelPreference;
    completionMessage = safeMessage(error, "本机 Runtime 连接失败；学习档案没有变化，私教仍保持锁定。");
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
  elements.engineTrigger.addEventListener("click", openEngineDialog);
  elements.agentGateConnect.addEventListener("click", openEngineDialog);
  elements.engineDialog.addEventListener("close", () => {
    elements.engineTrigger.setAttribute("aria-expanded", "false");
    elements.agentGateConnect.setAttribute("aria-expanded", "false");
    closeEngineHelp();
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
  elements.engineHelpClose.addEventListener("click", closeEngineHelp);
  elements.engineHelpRetest.addEventListener("click", () => { void retestEngineHelp(); });
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
    if (!agentChatAvailable()) {
      responseTimer.setVisible(false);
      return;
    }
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
  syncAgentGate();
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
    chat.setComposer({ enabled: agentChatAvailable(), busy: true });
    chat.setStatus(message || "正在处理……", "busy");
  } else if (agentChatAvailable()) {
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
  syncAgentGate();
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
      chat.appendHarness([safeMessage(error)], { error: true });
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
  if (!requireLocalAgentAccess()) return false;
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
  if (!requireLocalAgentAccess()) return false;
  if (!currentView || currentView.state !== "awaiting_answer") {
    chat.appendHarness(["现在没有等待作答的题目。输入“出题”开始，或输入“查看进度”。"]);
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
      title: `${engineDisplayName()} · 批改与讲解执行笺`,
      engine: `${selectedModelProfile()?.label || "Runtime 默认档位"} · 判分先于 Agent`,
      completeLabel: "固定判分已保存 · Agent 讲解已收口",
      failureLabel: "本轮执行中止 · 未完成的步骤没有写入进度",
      stages: [
        { id: "grade", label: "固定答案键判分", detail: "模型无权决定对错" },
        { id: "commit", label: "原子提交学习证据" },
        { id: "agent", label: `等待 ${engineDisplayName()} 补充讲解` },
        { id: "contract", label: "校验并展示最终结果" },
      ],
    },
  });
}

async function showProgress() {
  if (!requireLocalAgentAccess()) return false;
  if (!initialized) {
    chat.appendHarness(["本地 Harness 还没有读取或建立这台浏览器的私人档案。先点击“建档并开始诊断”。"]);
    return;
  }
  await operate("正在读取本地进度……", async () => {
    const coach = await getCoach();
    const view = await coach.status();
    currentView = view;
    chat.appendHarness(chat.progressSummary(view), {
      annotation: "只展示已有作答证据；没有证据的科目保持未测量。",
    });
    return null;
  });
}

function showTasks() {
  if (!requireLocalAgentAccess()) return false;
  if (!initialized || !currentView) {
    chat.appendHarness(["建档后，本地 Harness 会把每天 45 分钟压成最多 3 个任务。先完成一次短诊断。"]);
    return;
  }
  chat.appendHarness(chat.taskSummaryCopy(currentView), {
    annotation: "优先高频、到期复测和当前最薄弱的识别能力。",
  });
}

async function continueStudy() {
  if (!requireLocalAgentAccess()) return false;
  if (!initialized) {
    chat.appendHarness(["先建本浏览器私人档案，本地 Harness 才有权保存学习证据。"]);
    return;
  }
  if (BUSY_STATES.has(currentView?.state)) {
    chat.appendSystem("题目或批改仍在处理中，请稍等。");
    return;
  }
  if (currentView?.state === "awaiting_answer") {
    chat.appendHarness(["当前题还在等你作答。可输入 A–H；多选可输入 AC 或 A,C。"]);
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
  if (!requireLocalAgentAccess()) return false;
  if (!initialized) {
    chat.appendHarness(["当前还没有可导出的私人档案。先建档并完成至少一次诊断。"]);
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
    chat.appendHarness(["档案已在本机导出。文件含私人学习记录，请妥善保管；它没有自动上传。"]);
    return null;
  });
}

function requestImport() {
  if (!requireLocalAgentAccess(
    "请先接入本机 Agent，再导入私人档案。",
    { allowProfileRepair: true },
  )) return false;
  if (operating) return;
  elements.importFile.click();
}

async function importProfile(file) {
  if (!requireLocalAgentAccess(
    "请先接入本机 Agent，再导入私人档案。",
    { allowProfileRepair: true },
  )) return false;
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    chat.appendHarness(["导入文件超过 2 MiB，已拒绝读取。正常的私人档案不会这么大。"], { error: true });
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
    profileRestoreFailed = false;
    profileRestoreAttempted = true;
    initialized = true;
    chat.clear();
    chat.appendLearner("导入我选择的本地私人档案");
    updateFromView(imported);
    chat.appendHarness(["导入完成。输入“查看进度”核对，或输入“出题”继续。"]);
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
    profileRestoreAttempted = true;
    profileRestoreFailed = false;
    onboardingRendered = false;
    chat.clear();
    renderOnboarding("本机档案已经清除。我现在不知道你的学习进度；重新建档后会先诊断。");
    return null;
  });
}

function showHelp() {
  if (!requireLocalAgentAccess()) return false;
  const lines = [
    "你可以像聊天一样输入：今天学什么、查看进度、继续、出题。",
    "答题时只需输入 A、AC 或 A,C；私教会按题目长短计算参考用时，再以实际前台做题时间为主自动判断，交卷后显示时间依据。",
    `当前已选择 ${engineDisplayName()}：完成客观题后会生成个性化讲解；不在答题状态时也可以直接提问。`,
  ];
  chat.appendHarness(lines);
}

async function askAgent(raw) {
  if (!requireLocalAgentAccess()) return false;
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
  if (!requireLocalAgentAccess()) return false;
  return dispatchHarnessAction(actionId, {
    operating,
    state: currentView?.state,
    agentAvailable: agentChatAvailable(),
    onLearnerChoice: (label) => chat.appendLearner(label),
    runCommand: handleCommand,
    focusAnswer: () => elements.input.focus({ preventScroll: true }),
    askAgent,
    onBlocked: (message) => chat.appendSystem(message),
    onDisconnected: () => chat.appendHarness([
      "当前 Agent 已断开。请重新选择一个可用 Agent；学习档案没有变化。",
    ], { error: true }),
  });
}

async function handleCommand(command) {
  if (["progress", "tasks", "continue", "question", "export", "help"].includes(command) && !requireLocalAgentAccess()) {
    return false;
  }
  if (command === "import" && !requireLocalAgentAccess(
    "请先接入本机 Agent，再导入私人档案。",
    { allowProfileRepair: true },
  )) return false;
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
  if (!requireLocalAgentAccess()) return false;
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
    chat.appendHarness(["这是一道客观题，请输入 A–H；多选可输入 AC 或 A,C。要看可用指令，输入“帮助”。"]);
  } else if (agentChatAvailable()) {
    await askAgent(raw);
  } else if (!initialized) {
    chat.appendHarness(["本地 Harness 还没有获得本浏览器档案的本地授权。请先点击“建档并开始诊断”。"]);
  } else {
    showHelp();
  }
}

function renderOnboarding(message) {
  onboardingRendered = true;
  chat.clear();
  chat.setComposer({ enabled: agentChatAvailable() });
  chat.setStatus("尚未读取本浏览器档案。", "ready");
  chat.appendHarness([
    message || "我现在还不知道你的学习进度，也不会猜。",
    "在这个浏览器里明确建一份私人档案后，本地 Harness 才会用综合客观题做短诊断。",
  ], {
    action: {
      label: "在本浏览器建档并开始诊断",
      onClick: launchCoach,
    },
  });
}

async function restoreExistingProfile() {
  if (profileRestoreAttempted) return currentView;
  profileRestoreAttempted = true;
  restoringProfile = true;
  setOperating(true, "正在检查本浏览器是否已有档案……");
  try {
    const coach = await getCoach();
    const existing = await coach.restore();
    if (!existing) {
      profileRestoreFailed = false;
      chat.setStatus("尚无本地档案 · 点击后才会创建", "ready");
      return null;
    }

    initialized = true;
    profileRestoreFailed = false;
    onboardingRendered = false;
    currentView = existing;
    chat.clear();
    updateFromView(existing);
    chat.appendHarness([
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
    return existing;
  } catch (error) {
    initialized = false;
    profileRestoreFailed = true;
    currentView = null;
    chat.clear();
    chat.appendHarness([
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
syncAgentGate();
chat.setStatus(
  LOOPBACK_RUNTIME_PAGE
    ? "本机 Runtime 页面 · 尚未连接 Agent · 学习数据仍仅存浏览器"
    : PUBLIC_COACH_PAGE
      ? "本机 Agent 必选 · 连接成功后才能开始 · 学习数据仅存当前浏览器"
      : "网页预览 · 本机 Agent 必选 · 当前来源不能解锁",
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
