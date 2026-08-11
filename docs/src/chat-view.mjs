const STATE_LABELS = Object.freeze({
  cold_start: "等待建档",
  ready: "档案已就绪",
  loading: "正在选题",
  generating_question: "正在选题",
  awaiting_answer: "等待作答",
  evaluating: "正在批改",
  feedback: "本题已批注",
  indeterminate: "需要核对",
  complete: "今日任务完成",
  error: "暂时不可用",
});

const ACTIVE_STATES = new Set(["ready", "awaiting_answer", "feedback", "complete"]);
const BUSY_STATES = new Set(["loading", "generating_question", "evaluating"]);
const REDUCED_MOTION = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function replaceChildren(parent, children = []) {
  parent.replaceChildren(...children.filter(Boolean));
}

function asText(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeOptions(question) {
  if (!Array.isArray(question?.options)) return [];
  return question.options
    .map((option, index) => {
      if (typeof option === "string") {
        return { label: String.fromCharCode(65 + index), text: option };
      }
      return {
        label: asText(option?.label, String.fromCharCode(65 + index)).toUpperCase(),
        text: asText(option?.text ?? option?.content ?? option?.value),
      };
    })
    .filter((option) => /^[A-H]$/u.test(option.label) && option.text);
}

function normalizeSubjects(subjects) {
  const subjectNames = Object.freeze({
    comprehensive: "综合知识",
    case: "案例分析",
    essay: "论文",
  });
  const entries = Array.isArray(subjects)
    ? subjects
    : subjects && typeof subjects === "object"
      ? Object.entries(subjects).map(([name, value]) => (
          value && typeof value === "object" ? { name, ...value } : { name, value }
        ))
      : [];

  return entries.slice(0, 8).map((subject, index) => {
    const rawName = asText(
      subject?.name ?? subject?.subject ?? subject?.title ?? subject?.topic_id,
      `知识领域 ${index + 1}`,
    );
    const name = subjectNames[rawName] || rawName;
    const rawProgress = Number(
      subject?.progress ?? subject?.mastery ?? subject?.score ?? subject?.ratio ?? subject?.value,
    );
    const progress = Number.isFinite(rawProgress)
      ? clamp(rawProgress <= 1 ? rawProgress * 100 : rawProgress, 0, 100)
      : 0;
    const state = asText(subject?.state ?? subject?.status ?? subject?.label, progress ? `${Math.round(progress)}%` : "待诊断");
    return { name, progress, state };
  });
}

function normalizeTasks(view) {
  const tasks = Array.isArray(view?.tasks) ? view.tasks : [];
  if (tasks.length) {
    return tasks.slice(0, 3).map((task, index) => ({
      text: asText(
        task?.title ?? task?.label ?? task?.description ?? task?.name ?? task?.reason ?? task,
        `学习任务 ${index + 1}`,
      ),
      state: asText(task?.state ?? task?.status),
    }));
  }

  const currentTask = asText(view?.task?.title ?? view?.task?.label ?? view?.task?.description);
  return [
    { text: currentTask || "完成当前综合诊断题", state: view?.state === "complete" ? "done" : "current" },
    { text: "根据作答证据调整弱项", state: "pending" },
    { text: "完成复测或收束今日任务", state: "pending" },
  ];
}

function humanTaskState(task, index, completed) {
  if (["done", "complete", "completed", "mastered"].includes(task.state)) return "done";
  if (["current", "active", "in_progress"].includes(task.state)) return "current";
  if (index < completed) return "done";
  if (index === completed) return "current";
  return "pending";
}

function feedbackCopy(feedback) {
  const grade = feedback?.grade ?? feedback ?? {};
  const result = asText(grade.result ?? grade.status).toLowerCase();
  const correct = grade.correct === true || result === "correct" || result === "mastered";
  const needsRetest = result.includes("retest") || result.includes("guess");
  const behaviorRisk = ["hesitant", "likely_guess", "overconfident_wrong"].includes(feedback?.behavior?.signal);

  let verdict = "这题已经完成批注。";
  if (correct && needsRetest) verdict = "答案对了，但这次把握不足：先记为“需要复测”。";
  else if (correct && behaviorRisk) verdict = "答案对了；但这次行为信号仍建议复测，暂不计为稳定掌握证据。";
  else if (correct) verdict = "答对了，而且证据足够：这部分可以暂记为已掌握。";
  else if (grade.correct === false || result.includes("wrong") || result.includes("not_mastered")) {
    verdict = "这题没有答对：先记入弱项，后面会安排复测。";
  }

  return {
    verdict,
    reference: asText(grade.reference_answer ?? grade.answer),
    explanation: asText(grade.explanation ?? grade.analysis ?? feedback?.message),
    behavior: asText(feedback?.behavior?.summary),
  };
}

export function createChatView({
  timeline,
  optionPanel,
  input,
  submitButton,
  confidenceField,
  sessionLabel,
  sessionDot,
  taskList,
  taskSummary,
  subjectList,
  evidenceBadge,
  statusLine,
  onOption,
}) {
  if (!(timeline instanceof HTMLElement)) throw new TypeError("timeline is required");

  const renderedKeys = new Set();
  const renderedAgentKeys = new Set();
  let selected = new Set();
  let currentQuestion = null;
  let agentChatAvailable = false;

  function appendMessage(role, { paragraphs = [], question, annotation, action } = {}) {
    const item = node("li", `message message--${role}`);
    const byline = node("div", "message__byline");
    const chop = node("span", "teacher-chop", role === "learner" ? "我" : role === "system" ? "记" : "师");
    chop.setAttribute("aria-hidden", "true");
    byline.append(chop, node("span", "", role === "learner" ? "我的回答" : role === "system" ? "学习记录" : "过线私教"));

    const paper = node("div", "message__paper");
    for (const paragraph of paragraphs) {
      if (asText(paragraph)) paper.append(node("p", "", paragraph));
    }

    if (question) {
      const meta = node("div", "question-meta");
      const subject = asText(question.subject, "综合知识");
      const topic = asText(question.topic_id);
      meta.append(node("span", "", subject));
      if (topic) meta.append(node("span", "", topic));
      meta.append(node("span", "", "作答前不显示答案"));
      paper.append(meta, node("p", "question-prompt", asText(question.prompt, "题目暂时无法显示。")));
    }

    if (annotation) {
      const note = node("div", "annotation");
      note.append(node("span", "annotation__mark", "批"), node("span", "", annotation));
      paper.append(note);
    }

    if (action?.label && typeof action.onClick === "function") {
      const button = node("button", "primary-action");
      button.type = "button";
      button.append(node("span", "", action.label), node("span", "", "→"));
      button.addEventListener("click", action.onClick, { once: action.once !== false });
      paper.append(button);
    }

    item.append(byline, paper);
    timeline.append(item);
    item.scrollIntoView({ block: "nearest", behavior: REDUCED_MOTION ? "auto" : "smooth" });
    return item;
  }

  function appendCoach(paragraphs, options = {}) {
    return appendMessage(options.error ? "error" : "coach", { ...options, paragraphs });
  }

  function appendLearner(text) {
    return appendMessage("learner", { paragraphs: [text] });
  }

  function appendSystem(text) {
    return appendMessage("system", { paragraphs: [text] });
  }

  function clear() {
    replaceChildren(timeline);
    replaceChildren(optionPanel);
    optionPanel.hidden = true;
    renderedKeys.clear();
    renderedAgentKeys.clear();
    selected = new Set();
    currentQuestion = null;
  }

  function setStatus(message, state = "") {
    statusLine.textContent = asText(message);
    statusLine.dataset.state = state;
  }

  function setComposer({ enabled = true, answering = false, busy = false } = {}) {
    input.disabled = !enabled || busy;
    confidenceField.disabled = !enabled || !answering || busy;
    submitButton.disabled = !enabled || busy;
    submitButton.textContent = answering ? "交卷" : "发送";
    input.placeholder = answering
      ? "输入 A–H；多选可输入 AC 或 A,C"
      : agentChatAvailable
        ? "向专属私教提问，或输入：查看进度 / 继续 / 出题"
        : "输入：今天学什么 / 查看进度 / 继续 / 出题";
    input.setAttribute("aria-label", answering ? "输入 A 到 H 的答案，可输入多个选项" : "输入学习指令");
  }

  function setSelected(value, { syncInput = true } = {}) {
    selected = new Set(String(value || "").toUpperCase().match(/[A-H]/gu) || []);
    for (const button of optionPanel.querySelectorAll("button[data-option]")) {
      button.setAttribute("aria-pressed", selected.has(button.dataset.option) ? "true" : "false");
    }
    if (syncInput) input.value = [...selected].sort().join("");
  }

  function setAgentChatAvailable(value) {
    agentChatAvailable = value === true;
  }

  function renderOptions(question) {
    const options = normalizeOptions(question);
    replaceChildren(optionPanel);
    selected = new Set();
    currentQuestion = question;
    if (!options.length) {
      optionPanel.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const option of options) {
      const button = node("button", "option-button");
      button.type = "button";
      button.dataset.option = option.label;
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", `选择 ${option.label}：${option.text}`);
      button.append(node("span", "option-button__letter", option.label), node("span", "", option.text));
      button.addEventListener("click", () => {
        if (selected.has(option.label)) selected.delete(option.label);
        else selected.add(option.label);
        setSelected([...selected].sort().join(""));
        onOption?.([...selected].sort().join(""), option.label);
      });
      fragment.append(button);
    }
    optionPanel.append(fragment);
    optionPanel.hidden = false;
  }

  function updateSession(view) {
    const state = asText(view?.state, "cold_start");
    sessionLabel.textContent = STATE_LABELS[state] || "学习中";
    sessionDot.dataset.state = BUSY_STATES.has(state)
      ? "busy"
      : state === "error" || state === "indeterminate"
        ? "error"
        : ACTIVE_STATES.has(state)
          ? "active"
          : "";
  }

  function updateTasks(view) {
    const tasks = normalizeTasks(view);
    const rawCompleted = Number.isFinite(Number(view?.completedTasks)) ? Number(view.completedTasks) : 0;
    const completed = view?.state === "feedback" ? rawCompleted + 1 : rawCompleted;
    const numerals = ["壹", "贰", "叁"];
    const items = tasks.map((task, index) => {
      const item = node("li");
      item.dataset.taskState = humanTaskState(task, index, completed);
      item.append(node("span", "task-index", numerals[index]), node("span", "task-copy", task.text));
      return item;
    });
    replaceChildren(taskList, items);
    const total = Number.isFinite(Number(view?.totalTasks)) ? Number(view.totalTasks) : tasks.length;
    taskSummary.textContent = total ? `已完成 ${Math.min(completed, total)} / ${total} · 每轮最多 3 项` : "尚未开始 · 每轮最多 3 项";
  }

  function updateSubjects(view) {
    const subjects = normalizeSubjects(view?.subjects);
    evidenceBadge.textContent = view?.knowsProgress ? "已有作答证据" : "尚无证据";
    evidenceBadge.dataset.evidence = view?.knowsProgress ? "known" : "unknown";
    if (!subjects.length) {
      replaceChildren(subjectList, [node("p", "empty-copy", "完成诊断后，这里才会出现你的强弱项。")]);
      return;
    }
    const rows = subjects.map((subject) => {
      const row = node("div", "subject-row");
      const track = node("span", "subject-row__track");
      const fill = node("span", "subject-row__fill");
      fill.style.width = `${subject.progress}%`;
      track.append(fill);
      row.append(
        node("span", "subject-row__name", subject.name),
        node("span", "subject-row__state", subject.state),
        track,
      );
      return row;
    });
    replaceChildren(subjectList, rows);
  }

  function renderState(view, { force = false } = {}) {
    if (!view || typeof view !== "object") return;
    updateSession(view);
    updateTasks(view);
    updateSubjects(view);

    const state = asText(view.state, "ready");
    const key = `${state}:${asText(view.revision, "0")}:${asText(view.question?.item_id ?? view.feedback?.grade?.item_id)}`;
    if (!force && renderedKeys.has(key)) {
      renderAgentResult(view);
      setComposer({ enabled: true, answering: state === "awaiting_answer", busy: BUSY_STATES.has(state) });
      return;
    }
    renderedKeys.add(key);

    if (state === "loading" || state === "generating_question") {
      appendSystem(asText(view.message, "正在从固定公开版本中挑选本轮最有价值的一题……"));
      setComposer({ enabled: true, busy: true });
    } else if (state === "awaiting_answer" && view.question) {
      appendMessage("coach", {
        paragraphs: [asText(view.message, "先看题。按真实把握作答，猜对也会安排复测。")],
        question: view.question,
      });
      renderOptions(view.question);
      setComposer({ enabled: true, answering: true });
    } else if (state === "evaluating") {
      appendSystem(asText(view.message, "正在按固定参考答案批改，并保存这次作答证据……"));
      setComposer({ enabled: true, busy: true });
    } else if (state === "feedback") {
      optionPanel.hidden = true;
      const copy = feedbackCopy(view.feedback);
      const paragraphs = [copy.verdict];
      if (copy.behavior) paragraphs.push(copy.behavior);
      if (copy.reference) paragraphs.push(`参考答案：${copy.reference}`);
      if (copy.explanation) paragraphs.push(copy.explanation);
      appendCoach(paragraphs, { annotation: "用时只是辅助信号；不会单凭快答升级掌握，刷新或切走页面后的残缺计时也不作推断。" });
      setComposer({ enabled: true });
    } else if (state === "complete") {
      optionPanel.hidden = true;
      appendCoach([
        asText(view.message, "今天这一轮已经收束。进度已留在当前浏览器，下次会从真实证据继续。"),
        "可以输入“查看进度”，或输入“出题”再开一轮。",
      ], { annotation: "到这里就停也可以。过线靠稳定重复，不靠一次刷满。" });
      setComposer({ enabled: true });
    } else if (state === "indeterminate" || state === "error") {
      optionPanel.hidden = true;
      appendCoach([
        asText(view.error?.message ?? view.error ?? view.message, "当前会话需要人工核对，系统没有冒险重复提交。"),
      ], { error: true });
      setComposer({ enabled: true });
    } else if (state === "ready") {
      appendCoach([
        asText(view.message, view.knowsProgress ? "已读取这个浏览器里的真实学习档案。" : "私人档案已建好，目前还没有作答证据。"),
      ]);
      setComposer({ enabled: true });
    }

    renderAgentResult(view);

    setStatus(view.error ? "本轮未写入新进度。" : `本地档案 · revision ${asText(view.revision, "—")}` , state);
  }

  function renderAgentResult(view) {
    if (view?.state !== "feedback") return;
    const coaching = view?.agent?.coaching;
    const failure = view?.agent?.failure;
    if (coaching?.coaching_text) {
      const engine = asText(coaching.engine ?? view.agent?.preference, "本机 Agent").slice(0, 64);
      const text = asText(coaching.coaching_text).slice(0, 2_000);
      const key = `coaching:${asText(view.revision)}:${engine}:${text}`;
      if (renderedAgentKeys.has(key)) return;
      renderedAgentKeys.add(key);
      appendCoach([text], { annotation: `讲解引擎 ${engine} · 判分固定答案键` });
    } else if (failure?.message) {
      const engine = asText(view.agent?.preference, "本机 Agent").slice(0, 64);
      const message = asText(failure.message).slice(0, 240);
      const key = `failure:${asText(view.revision)}:${engine}:${message}`;
      if (renderedAgentKeys.has(key)) return;
      renderedAgentKeys.add(key);
      appendSystem(`讲解引擎 ${engine} 暂时不可用：${message} 固定答案批改与学习进度已经保存，不会回滚。`);
    }
  }

  function progressSummary(view) {
    const subjects = normalizeSubjects(view?.subjects);
    if (!view?.knowsProgress || !subjects.length) {
      return ["我还没有足够的真实作答证据判断进度。先完成诊断，不会凭感觉编造掌握度。"];
    }
    const lines = subjects.slice(0, 5).map((subject) => `${subject.name}：${subject.state}`);
    return ["这是当前浏览器里有证据的学习进度：", ...lines];
  }

  function taskSummaryCopy(view) {
    const tasks = normalizeTasks(view);
    const rawCompleted = Number.isFinite(Number(view?.completedTasks)) ? Number(view.completedTasks) : 0;
    const completed = view?.state === "feedback" ? rawCompleted + 1 : rawCompleted;
    return [
      `今日任务已完成 ${completed} / ${Number(view?.totalTasks) || tasks.length}：`,
      ...tasks.map((task, index) => `${index + 1}. ${task.text}`),
    ];
  }

  return Object.freeze({
    appendCoach,
    appendLearner,
    appendSystem,
    clear,
    currentQuestion: () => currentQuestion,
    progressSummary,
    renderState,
    setComposer,
    setAgentChatAvailable,
    setSelected,
    setStatus,
    taskSummaryCopy,
  });
}
