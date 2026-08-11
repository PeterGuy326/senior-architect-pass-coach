import { createWebCoachHarness } from "./harness.mjs";
import { createChatView } from "./chat-view.mjs";
import { createLocalAgentClient, isLocalAgentRuntimeOrigin } from "./local-agent-client.mjs";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const ANSWER_LABELS = /^[A-H]+$/u;
const BUSY_STATES = new Set(["loading", "generating_question", "evaluating"]);

const elements = Object.freeze({
  timeline: document.querySelector("#chat-timeline"),
  optionPanel: document.querySelector("#option-panel"),
  input: document.querySelector("#answer-input"),
  submitButton: document.querySelector("#submit-answer"),
  confidenceField: document.querySelector("#confidence-field"),
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
  engineList: document.querySelector("#engine-list"),
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

const chat = createChatView({
  timeline: elements.timeline,
  optionPanel: elements.optionPanel,
  input: elements.input,
  submitButton: elements.submitButton,
  confidenceField: elements.confidenceField,
  sessionLabel: elements.sessionLabel,
  sessionDot: elements.sessionDot,
  taskList: elements.taskList,
  taskSummary: elements.taskSummary,
  subjectList: elements.subjectList,
  evidenceBadge: elements.evidenceBadge,
  statusLine: elements.statusLine,
  onOption: () => {
    elements.answerError.textContent = "";
    elements.input.focus();
  },
});

let coachPromise = null;
let unsubscribe = null;
let currentView = null;
let initialized = false;
let operating = false;
let localAgentClient = null;
let runtimeAdapters = [];
let selectedEngine = "content-only";
let connectingRuntime = false;

const LOOPBACK_RUNTIME_PAGE = isLocalAgentRuntimeOrigin(location.origin);
const ADAPTER_STATE_LABELS = Object.freeze({
  ready: "可用",
  ready_unverified: "等待验证",
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

function updateEngineUi(message = "") {
  const display = engineDisplayName();
  const agentActive = agentChatAvailable();
  elements.engineTrigger.dataset.connected = agentActive ? "true" : "false";
  elements.engineTriggerLabel.textContent = agentActive
    ? `${display} · 本机 Agent`
    : "基础私教 · 连接本机 Agent";
  elements.engineDialogStatus.textContent = message || `当前：${display}${agentActive ? " · Agent 讲解已启用" : ""}`;
  chat.setAgentChatAvailable(agentActive);
  for (const button of elements.engineList.querySelectorAll("button[data-engine]")) {
    button.setAttribute("aria-pressed", button.dataset.engine === selectedEngine ? "true" : "false");
  }
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
  button.dataset.engineSelectable = id === "content-only" || selectable ? "true" : "false";
  button.setAttribute("aria-pressed", id === selectedEngine ? "true" : "false");
  button.disabled = operating || connectingRuntime || (id !== "content-only" && selectable !== true);

  const title = document.createElement("span");
  title.className = "engine-card__title";
  title.textContent = label;
  const status = document.createElement("span");
  status.className = "engine-card__state";
  status.textContent = id === "content-only" ? "始终可用" : (ADAPTER_STATE_LABELS[state] || state);
  const copy = document.createElement("span");
  copy.className = "engine-card__detail";
  const reasonCopy = reasons.map((reason) => ADAPTER_REASON_LABELS[reason] || "需要在本机 Runtime 查看诊断");
  copy.textContent = id === "content-only"
    ? "固定题库、固定答案键、浏览器私人进度；不调用模型。"
    : [detail, ...new Set(reasonCopy)].filter(Boolean).join(" · ").slice(0, 720) || "状态由本机 Runtime 报告。";
  button.append(title, status, copy);
  button.addEventListener("click", () => selectEngine(id));
  return button;
}

function renderEngineList() {
  const contentOnly = createEngineCard({
    id: "content-only",
    label: "基础私教",
    state: "ready",
    selectable: true,
  });
  const cards = runtimeAdapters.map((adapter) => createEngineCard(adapter));
  elements.engineList.replaceChildren(contentOnly, ...cards);
  updateEngineUi();
}

async function selectEngine(engine) {
  if (operating || connectingRuntime) return;
  if (engine !== "content-only") {
    const adapter = adapterById(engine);
    if (!localAgentClient?.connected || adapter?.selectable !== true) return;
  }
  selectedEngine = engine;
  if (coachPromise) {
    const coach = await coachPromise;
    coach.setAgentPreference(engine);
  }
  updateEngineUi(`已选择：${engineDisplayName()}。学习档案、当前题目和进度均未改变。`);
}

async function connectRuntime() {
  if (!LOOPBACK_RUNTIME_PAGE || connectingRuntime || operating) return;
  connectingRuntime = true;
  let completionMessage = "";
  elements.runtimeConnect.disabled = true;
  elements.engineTrigger.disabled = true;
  elements.engineDialogStatus.textContent = "正在与本机 Runtime 建立仅存内存的授权……";
  try {
    const client = createLocalAgentClient({ origin: location.origin });
    const connection = await client.connect();
    localAgentClient?.disconnect();
    localAgentClient = client;
    runtimeAdapters = connection.adapters;
    const coach = await getCoach();
    coach.setAgentClient(client);
    selectedEngine = "content-only";
    coach.setAgentPreference(selectedEngine);
    completionMessage = "本机 Runtime 已连接。请选择状态为“可用”的 Agent；基础私教仍可随时切回。";
  } catch (error) {
    localAgentClient?.disconnect();
    localAgentClient = null;
    runtimeAdapters = [];
    selectedEngine = "content-only";
    completionMessage = safeMessage(error, "本机 Runtime 连接失败；基础私教不受影响。");
  } finally {
    connectingRuntime = false;
    elements.runtimeConnect.disabled = false;
    elements.engineTrigger.disabled = operating;
    renderEngineList();
    updateEngineUi(completionMessage);
  }
}

function setupEngineControls() {
  if (LOOPBACK_RUNTIME_PAGE) {
    elements.runtimeConnect.hidden = false;
    elements.runtimeInstallLink.hidden = true;
    elements.runtimeCalloutCopy.textContent = "当前页面由 127.0.0.1 本机 Runtime 提供。只有点击下方按钮后才会连接；授权令牌仅留在页面内存。";
  } else {
    elements.runtimeConnect.hidden = true;
    elements.runtimeInstallLink.hidden = false;
    elements.runtimeCalloutCopy.textContent = "当前是公开网页：不会扫描或连接 localhost。要用 Agent，请安装并从本机 Runtime 打开同一页面。";
  }
  elements.engineTrigger.addEventListener("click", () => {
    if (typeof elements.engineDialog.showModal === "function") elements.engineDialog.showModal();
    else elements.engineDialog.setAttribute("open", "");
  });
  elements.runtimeConnect.addEventListener("click", connectRuntime);
  renderEngineList();
}

function updateFromView(view) {
  currentView = view;
  chat.renderState(view);
}

async function getCoach() {
  if (!coachPromise) {
    coachPromise = createWebCoachHarness()
      .then((coach) => {
        if (localAgentClient?.connected) coach.setAgentClient(localAgentClient);
        coach.setAgentPreference(selectedEngine);
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
    const unavailable = button.dataset.engine !== "content-only" && button.dataset.engineSelectable !== "true";
    button.disabled = value || connectingRuntime || unavailable;
  }
  if (value) {
    chat.setComposer({ enabled: initialized, busy: true });
    chat.setStatus(message || "正在处理……", "busy");
  } else if (initialized && currentView) {
    chat.setComposer({
      enabled: true,
      answering: currentView.state === "awaiting_answer",
      busy: BUSY_STATES.has(currentView.state),
    });
    if (elements.statusLine.dataset.state === "busy") {
      chat.setStatus(`本地档案 · revision ${currentView.revision ?? "—"}`, currentView.state);
    }
  }
}

async function operate(message, action) {
  if (operating) {
    chat.appendSystem("上一条指令还在处理，请稍等。");
    return null;
  }
  setOperating(true, message);
  elements.answerError.textContent = "";
  try {
    const result = await action();
    if (result && typeof result === "object" && typeof result.state === "string") {
      updateFromView(result);
    }
    return result;
  } catch (error) {
    if (currentView?.state !== "error") {
      chat.appendCoach([safeMessage(error)], { error: true });
    }
    chat.setStatus("本次操作没有写入新的学习进度。", "error");
    return null;
  } finally {
    setOperating(false);
  }
}

function confidenceValue() {
  return elements.confidenceField.querySelector("input[name='confidence']:checked")?.value || "unsure";
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
  let value = String(rawValue || "").trim();
  let confidence = confidenceValue();
  const confidencePrefixes = [
    { pattern: /^(?:\/?sure|确定)\s*[:：]?\s*(.+)$/iu, value: "sure" },
    { pattern: /^(?:\/?unsure|不确定)\s*[:：]?\s*(.+)$/iu, value: "unsure" },
    { pattern: /^(?:\/?guess|猜)\s*[:：]?\s*(.+)$/iu, value: "guess" },
  ];
  for (const prefix of confidencePrefixes) {
    const match = value.match(prefix.pattern);
    if (match) {
      confidence = prefix.value;
      value = match[1];
      break;
    }
  }
  const response = canonicalLabels(value);
  return response ? { response, confidence } : null;
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
  const unsure = elements.confidenceField.querySelector("input[value='unsure']");
  if (unsure) unsure.checked = true;
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

  const certainty = answer.confidence === "sure" ? "确定" : answer.confidence === "guess" ? "猜的" : "不确定";
  chat.appendLearner(`${answer.response} · ${certainty}`);
  resetAnswerControls();
  await operate("正在按固定答案键批改……", async () => {
    const coach = await getCoach();
    return coach.answer({
      response: answer.response,
      confidence: answer.confidence,
      expectedRevision: currentView.revision,
      expectedItemId: currentView.question.item_id,
    });
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
    "答题时直接输入 A、AC 或 A,C；也可以输入“sure B”“确定 B”“unsure AC”，明确告诉我把握度。",
    agentChatAvailable()
      ? `当前已选择 ${engineDisplayName()}：完成客观题后会生成个性化讲解；不在答题状态时也可以直接提问。`
      : "基础私教不调用模型，只执行确定性的学习指令；可从顶部选择本机 Agent。",
  ];
  chat.appendCoach(lines);
}

async function askAgent(raw) {
  await operate(`正在请 ${engineDisplayName()} 结合你的弱项回答……`, async () => {
    const coach = await getCoach();
    const result = await coach.askAgent(raw);
    chat.appendCoach([result.coaching_text], {
      annotation: `讲解引擎 ${result.engine} · 本次对话不写入学习进度`,
    });
    return null;
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
  if (!initialized) {
    chat.appendCoach(["我还没有获得本浏览器档案的本地授权。请先点击“建档并开始诊断”。"]);
  } else if (currentView?.state === "awaiting_answer") {
    chat.appendCoach(["这是一道客观题，请输入 A–H；多选可输入 AC 或 A,C。要看可用指令，输入“帮助”。"]);
  } else if (agentChatAvailable()) {
    await askAgent(raw);
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
    if (answer) chat.setSelected(answer.response);
  }
});
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
    : "零安装基础私教 · 数据仅存当前浏览器",
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
