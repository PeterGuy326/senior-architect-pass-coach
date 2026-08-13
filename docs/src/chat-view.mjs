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

export function buildProcessStageSnapshot(stageCount, activeIndex = 0, outcome = "running") {
  if (!Number.isSafeInteger(stageCount) || stageCount < 1 || stageCount > 5) {
    throw new RangeError("stageCount must be between 1 and 5");
  }
  const index = clamp(Number.isSafeInteger(activeIndex) ? activeIndex : 0, 0, stageCount - 1);
  const states = Array.from({ length: stageCount }, (_value, stageIndex) => {
    if (outcome === "done") return "done";
    if (stageIndex < index) return "done";
    if (stageIndex === index) return outcome === "error" ? "error" : "active";
    return "pending";
  });
  return Object.freeze({ activeIndex: index, settled: outcome !== "running", states: Object.freeze(states) });
}

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

function secondsText(value) {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number) || number < 0) return "计时不完整";
  return `${Math.round(number * 10) / 10} 秒`;
}

const QUESTION_LOAD_LABELS = Object.freeze({
  short: "短题",
  standard: "标准题",
  long: "长题",
  very_long: "长材料题",
});

export function buildTimingReceipt(behavior, { correct = null } = {}) {
  if (!behavior || typeof behavior !== "object") return null;
  const expected = typeof behavior.expected_duration_seconds === "number"
    ? behavior.expected_duration_seconds
    : Number.NaN;
  const duration = typeof behavior.duration_seconds === "number"
    ? behavior.duration_seconds
    : Number.NaN;
  const complete = behavior.timing_source === "live"
    && behavior.timing_quality === "clean"
    && Number.isFinite(expected)
    && expected > 0
    && Number.isFinite(duration)
    && duration >= 0;
  const load = QUESTION_LOAD_LABELS[behavior.question_load] || "本题";
  const source = behavior.baseline_source === "personal" ? "个人历史校正" : "按题目长度估算";
  let judgement = "计时不完整 · 本题不按用时判断";
  if (complete) {
    if (behavior.reason_code === "revision_heavy") judgement = "发生真实改选 · 需要复测";
    else if (behavior.timing_band === "early_choice") judgement = "首次选择过早 · 暂不能排除猜测";
    else if (behavior.timing_band === "fast") judgement = correct === false
      ? "明显偏快且答错 · 疑似猜测"
      : "明显偏快 · 需要复测";
    else if (["deliberate", "extended"].includes(behavior.timing_band)) judgement = "用时偏长 · 需要复测";
    else if (behavior.timing_band === "unknown" || behavior.signal === "insufficient_signal") {
      judgement = "计时或证据不完整 · 需要复测";
    }
    else if (correct === false) judgement = "用时正常 · 但答案错误";
    else if (
      correct === true
      && behavior.timing_band === "steady"
      && behavior.signal === "fluent"
      && behavior.effective_confidence === "sure"
    ) judgement = "节奏正常 · 可形成掌握证据";
    else judgement = "节奏正常 · 但行为证据不足，需复测";
  }
  return Object.freeze({
    reference: Number.isFinite(expected) && expected > 0 ? `约 ${secondsText(expected)}` : "暂无参考",
    referenceBasis: `${load} · ${source}`,
    actual: complete ? secondsText(duration) : "计时不完整",
    comparison: complete ? `实际约为参考的 ${Math.round((duration / expected) * 100)}%` : "刷新、切走或中断后不作推断",
    judgement,
  });
}

function feedbackCopy(feedback) {
  const grade = feedback?.grade ?? feedback ?? {};
  const result = asText(grade.result ?? grade.status).toLowerCase();
  const correct = grade.correct === true || result === "correct" || result === "mastered";
  const needsRetest = result.includes("retest") || result.includes("guess");
  const behaviorRisk = ["hesitant", "likely_guess", "overconfident_wrong", "insufficient_signal"]
    .includes(feedback?.behavior?.signal);

  let verdict = "这题已经完成批注。";
  if (correct && needsRetest) verdict = "答案对了，但这次行为证据不足：先记为“需要复测”。";
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
    timing: buildTimingReceipt(feedback?.behavior, { correct: grade.correct === true }),
  };
}

export function createChatView({
  timeline,
  optionPanel,
  input,
  submitButton,
  sessionLabel,
  sessionDot,
  taskList,
  taskSummary,
  subjectList,
  evidenceBadge,
  statusLine,
  onOption,
  onSuggestion,
}) {
  if (!(timeline instanceof HTMLElement)) throw new TypeError("timeline is required");

  const renderedKeys = new Set();
  const renderedAgentKeys = new Set();
  const activeProcessTimers = new Set();
  let selected = new Set();
  let currentQuestion = null;
  let agentChatAvailable = false;

  function appendMessage(role, { paragraphs = [], question, timing, annotation, action, suggestions = [] } = {}) {
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

    if (timing) {
      const receipt = node("section", "timing-receipt");
      receipt.setAttribute("aria-label", "本题用时判定");
      receipt.append(node("h3", "timing-receipt__title", "本题用时判定"));
      const list = node("dl", "timing-receipt__list");
      for (const [label, value, detail] of [
        ["参考用时", timing.reference, timing.referenceBasis],
        ["有效用时", timing.actual, timing.comparison],
        ["本次判断", timing.judgement, "以相对用时为主，对错与改选作校验"],
      ]) {
        const group = node("div", "timing-receipt__item");
        const description = node("dd");
        description.append(node("span", "timing-receipt__value", value), node("small", "", detail));
        group.append(node("dt", "", label), description);
        list.append(group);
      }
      receipt.append(list);
      paper.append(receipt);
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

    const safeSuggestions = (Array.isArray(suggestions) ? suggestions : [])
      .filter((suggestion) => asText(suggestion?.label) && asText(suggestion?.value))
      .slice(0, 3);
    if (safeSuggestions.length && typeof onSuggestion === "function") {
      const suggestionGroup = node("div", "coach-suggestions");
      suggestionGroup.setAttribute("aria-label", "私教建议追问");
      for (const suggestion of safeSuggestions) {
        const button = node("button", "coach-suggestion", suggestion.label);
        button.type = "button";
        button.addEventListener("click", () => {
          for (const peer of suggestionGroup.querySelectorAll("button")) peer.disabled = true;
          onSuggestion(suggestion.value);
        }, { once: true });
        suggestionGroup.append(button);
      }
      paper.append(suggestionGroup);
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

  function startProcess({ title = "本机执行笺", engine = "", stages = [] } = {}) {
    const normalizedStages = (Array.isArray(stages) ? stages : [])
      .map((stage, index) => ({
        id: asText(stage?.id, `stage-${index + 1}`),
        label: asText(stage?.label, `执行节点 ${index + 1}`),
        detail: asText(stage?.detail),
      }))
      .slice(0, 5);
    if (!normalizedStages.length) {
      normalizedStages.push({ id: "running", label: "请求处理中", detail: "" });
    }

    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const item = node("li", "message message--process");
    const byline = node("div", "message__byline");
    const chop = node("span", "teacher-chop", "执");
    chop.setAttribute("aria-hidden", "true");
    byline.append(chop, node("span", "", "执行笺"));

    const paper = node("section", "message__paper process-ledger");
    paper.setAttribute("aria-label", title);
    const heading = node("div", "process-ledger__heading");
    const titleNode = node("strong", "process-ledger__title", title);
    const elapsedNode = node("span", "process-ledger__elapsed", "0.0 秒");
    elapsedNode.setAttribute("aria-hidden", "true");
    heading.append(titleNode, elapsedNode);
    const engineNode = engine ? node("p", "process-ledger__engine", engine) : null;
    const list = node("ol", "process-ledger__stages");
    const stageRows = normalizedStages.map((stage, index) => {
      const row = node("li", "process-stage");
      row.dataset.state = index === 0 ? "active" : "pending";
      row.dataset.processStage = stage.id;
      const mark = node("span", "process-stage__mark", index === 0 ? "进行" : String(index + 1).padStart(2, "0"));
      mark.setAttribute("aria-hidden", "true");
      const copy = node("span", "process-stage__copy");
      copy.append(node("strong", "", stage.label));
      if (stage.detail) copy.append(node("small", "", stage.detail));
      row.append(mark, copy);
      list.append(row);
      return { ...stage, row, mark, copy };
    });
    const boundary = node("p", "process-ledger__boundary", "仅展示可验证的执行节点，不展示模型内部思维链。");
    paper.append(heading, engineNode, list, boundary);
    item.append(byline, paper);
    timeline.append(item);
    item.scrollIntoView({ block: "nearest", behavior: REDUCED_MOTION ? "auto" : "smooth" });

    let settled = false;
    let activeIndex = 0;
    const elapsed = () => Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
    const renderElapsed = () => {
      elapsedNode.textContent = `${(elapsed() / 1_000).toFixed(1)} 秒`;
    };
    const timer = globalThis.setInterval(renderElapsed, 100);
    activeProcessTimers.add(timer);

    function stopTimer() {
      globalThis.clearInterval(timer);
      activeProcessTimers.delete(timer);
      renderElapsed();
    }

    function setStageState(index, state, detail = "") {
      const stage = stageRows[index];
      if (!stage) return;
      stage.row.dataset.state = state;
      stage.mark.textContent = state === "done" ? "成" : state === "active" ? "进行" : state === "error" ? "止" : String(index + 1).padStart(2, "0");
      if (detail) {
        let detailNode = stage.copy.querySelector("small");
        if (!detailNode) {
          detailNode = node("small");
          stage.copy.append(detailNode);
        }
        detailNode.textContent = detail;
      }
    }

    function applySnapshot(snapshot, detail = "") {
      snapshot.states.forEach((state, index) => setStageState(index, state, index === snapshot.activeIndex ? detail : ""));
    }

    function advance(id, detail = "") {
      if (settled) return;
      const targetIndex = stageRows.findIndex((stage) => stage.id === id);
      if (targetIndex < 0 || targetIndex < activeIndex) return;
      activeIndex = targetIndex;
      applySnapshot(buildProcessStageSnapshot(stageRows.length, activeIndex), detail);
      item.scrollIntoView({ block: "nearest", behavior: REDUCED_MOTION ? "auto" : "smooth" });
    }

    function complete(summary = "执行完成", { throughId = null } = {}) {
      if (settled) return;
      const completedIndex = throughId === null
        ? stageRows.length - 1
        : stageRows.findIndex((stage) => stage.id === throughId);
      if (completedIndex < 0) return fail(summary);
      settled = true;
      stageRows.forEach((_stage, index) => {
        setStageState(index, index <= completedIndex ? "done" : "pending");
      });
      paper.dataset.state = "done";
      titleNode.textContent = summary;
      stopTimer();
    }

    function fail(summary = "执行中止 · 未写入学习进度") {
      if (settled) return;
      settled = true;
      applySnapshot(buildProcessStageSnapshot(stageRows.length, activeIndex, "error"));
      paper.dataset.state = "error";
      titleNode.textContent = summary;
      stopTimer();
    }

    return Object.freeze({ advance, complete, fail });
  }

  function clear() {
    for (const timer of activeProcessTimers) globalThis.clearInterval(timer);
    activeProcessTimers.clear();
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
        paragraphs: [asText(view.message, "先看题，直接选答案。私教会根据作答过程自动判断证据强度。")],
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
      appendCoach(paragraphs, {
        timing: copy.timing,
        annotation: "自动判断以相对做题时间为主；固定答案决定对错，真实改选只会让证据更保守。",
      });
      const proactive = (view?.agent?.proactive_suggestions || [])[0];
      if (asText(proactive?.prompt)) {
        appendCoach([`主动追问：${asText(proactive.prompt).slice(0, 160)}`], {
          annotation: agentChatAvailable
            ? "Harness 根据本题证据主动发问 · 直接在输入框回答，所选 Agent 会继续追问"
            : "Harness 根据本题证据主动发问 · 可先口头复述；连接 Agent 后可继续追问",
          action: agentChatAvailable
            ? {
              label: "回答这道追问",
              onClick: () => onSuggestion?.({
                id: asText(proactive.id).slice(0, 64),
                prompt: asText(proactive.prompt).slice(0, 160),
              }),
            }
            : null,
        });
      }
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
      const modelPreference = asText(coaching.model_preference ?? view.agent?.model_preference).slice(0, 32);
      const text = asText(coaching.coaching_text).slice(0, 2_000);
      const key = `coaching:${asText(view.revision)}:${engine}:${text}`;
      if (renderedAgentKeys.has(key)) return;
      renderedAgentKeys.add(key);
      appendCoach([text], {
        annotation: `讲解引擎 ${engine}${modelPreference ? ` · ${modelPreference}` : ""} · 判分固定答案键`,
      });
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
    startProcess,
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
