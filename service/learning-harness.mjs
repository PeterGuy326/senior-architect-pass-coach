import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { CoachError } from "./errors.mjs";
import { assertNoIdentityFields } from "./privacy.mjs";

export const LEARNING_STATES = Object.freeze({
  COLD_START: "cold_start",
  READY: "ready",
  GENERATING_QUESTION: "generating_question",
  AWAITING_ANSWER: "awaiting_answer",
  EVALUATING: "evaluating",
  FEEDBACK: "feedback",
  INDETERMINATE: "indeterminate",
  COMPLETE: "complete",
});

export const LEARNING_SNAPSHOT_VERSION = "learning-harness-session.v2";

const STABLE_STATES = new Set([
  LEARNING_STATES.COLD_START,
  LEARNING_STATES.READY,
  LEARNING_STATES.AWAITING_ANSWER,
  LEARNING_STATES.FEEDBACK,
  LEARNING_STATES.INDETERMINATE,
  LEARNING_STATES.COMPLETE,
]);
const TASK_ACTIONS = new Set(["diagnose", "practice", "review", "mock", "case", "essay"]);
const SUBJECTS = new Set(["comprehensive", "case", "essay"]);
const RESULTS = new Set(["mastered", "not_mastered", "needs_retest"]);
const CONFIDENCE = new Set(["guess", "unsure", "sure"]);
const FORBIDDEN_QUESTION_KEYS = new Set([
  "answer",
  "correct_answer",
  "reference_answer",
  "explanation",
  "analysis",
  "feedback",
  "result",
  "is_correct",
]);
const ANSWER_MARKER = /(?:correct\s*answer|reference\s*answer|the\s+answer\s+is|(?:正确)?答案\s*(?:[:：]|是|为)|解析\s*[:：]|\[correct\]|[（(]正确[）)]|[✓✔])/iu;

function harnessError(code, message, options = {}) {
  return new CoachError(code, message, options);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw harnessError("INVALID_HARNESS_DATA", `${label} 必须是对象。`);
  }
  return value;
}

function text(value, label, maximum = 20_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw harnessError("INVALID_HARNESS_DATA", `${label} 必须是非空字符串。`);
  }
  return value;
}

function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new CoachError("UNSERIALIZABLE_HARNESS_DATA", "学习会话必须可以序列化。", {
      cause: error,
    });
  }
}

function actionFor(recommendation) {
  if (TASK_ACTIONS.has(recommendation?.action)) return recommendation.action;
  if (recommendation?.subject === "case") return "case";
  if (recommendation?.subject === "essay") return "essay";
  if (recommendation?.review_due === true) return "review";
  if (recommendation?.mastery === null || recommendation?.mastery === undefined) return "diagnose";
  return "practice";
}

function normalizeTask(item, index) {
  object(item, `recommendations[${index}]`);
  const subject = text(item.subject, `recommendations[${index}].subject`, 32);
  if (!SUBJECTS.has(subject)) {
    throw harnessError("INVALID_HARNESS_TASK", `不支持的科目 ${subject}。`);
  }
  const topicId = text(item.topic_id, `recommendations[${index}].topic_id`, 128);
  const action = actionFor(item);
  return {
    task_id: typeof (item.task_id || item.id) === "string" && (item.task_id || item.id).length > 0
      ? (item.task_id || item.id).slice(0, 128)
      : `${subject}:${topicId}:${index + 1}`,
    action,
    subject,
    topic_id: topicId,
    skill: typeof item.skill === "string" ? item.skill.slice(0, 128) : null,
    minutes: Number.isFinite(item.minutes)
      ? Math.max(0, Math.trunc(item.minutes))
      : (Number.isFinite(item.estimated_minutes)
        ? Math.max(0, Math.trunc(item.estimated_minutes))
        : null),
  };
}

function budgetTasks(recommendations, dailyMinutes) {
  const normalized = recommendations.slice(0, 3).map(normalizeTask);
  if (!Number.isInteger(dailyMinutes) || dailyMinutes < 1) return normalized;
  const result = [];
  let remaining = dailyMinutes;
  for (const task of normalized) {
    if (remaining < 1) break;
    const minutes = Math.min(15, Math.max(1, task.minutes || 10), remaining);
    result.push({ ...task, minutes });
    remaining -= minutes;
  }
  return result;
}

function attemptedItemIds(status) {
  const ids = new Set();
  for (const topic of Object.values(status?.topics || {})) {
    for (const mastery of Object.values(topic?.mastery || {})) {
      for (const itemId of mastery?.attempted_items || []) {
        if (typeof itemId === "string" && itemId.length > 0 && itemId.length <= 128) ids.add(itemId);
      }
    }
  }
  return [...ids].slice(0, 5_000);
}

function applyDiagnosticActions(tasks, status) {
  return tasks.map((task) => {
    const subject = status?.subjects?.[task.subject];
    const unmeasured = subject?.lower_bound_score === null || subject?.status === "unmeasured";
    const thinEvidence = Number.isInteger(subject?.evidence_count) && subject.evidence_count < 6;
    return task.action === "practice" && (unmeasured || thinEvidence)
      ? { ...task, action: "diagnose" }
      : task;
  });
}

function normalizeQuestion(item, task) {
  object(item, "learning_item");
  const question = {
    item_id: text(item.item_id, "learning_item.item_id", 128),
    kind: text(item.kind, "learning_item.kind", 64),
    subject: text(item.subject, "learning_item.subject", 32),
    topic_id: text(item.topic_id, "learning_item.topic_id", 128),
    prompt: text(item.prompt, "learning_item.prompt"),
    source_refs: Array.isArray(item.source_refs) ? [...item.source_refs] : [],
  };
  if (question.subject !== task.subject || question.topic_id !== task.topic_id) {
    throw harnessError("QUESTION_TASK_MISMATCH", "题目与当前受信任务不一致。 ");
  }
  if (item.options !== undefined) {
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 8) {
      throw harnessError("INVALID_HARNESS_DATA", "选择题选项数量无效。 ");
    }
    question.options = item.options.map((option, index) => ({
      label: text(object(option, `options[${index}]`).label, `options[${index}].label`, 8),
      text: text(option.text, `options[${index}].text`, 2_000),
    }));
  }
  assertQuestionHasNoAnswer(question);
  return question;
}

function assertQuestionHasNoAnswer(question) {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_QUESTION_KEYS.has(key.toLowerCase())) {
        throw harnessError("ANSWER_GATE_VIOLATION", `题目阶段包含答案字段 ${key}。`);
      }
      if (typeof child === "string" && ANSWER_MARKER.test(child)) {
        throw harnessError("ANSWER_GATE_VIOLATION", "题目阶段检测到答案或解析标记。 ");
      }
      visit(child);
    }
  };
  visit(question);
}

function normalizeApprovedMaterials(items, question) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 32) {
    throw harnessError("INVALID_CONTENT_ISSUE", "受信题目必须带 1-32 条批准材料。 ");
  }
  return items.map((item, index) => ({
    source_id: text(object(item, `approvedMaterials[${index}]`).source_id, "source_id", 128),
    locator: `question:${question.item_id}:material:${index + 1}`,
    excerpt: text(item.excerpt, "excerpt", 20_000),
  }));
}

function normalizeContentIssue(issue, task) {
  object(issue, "content issue");
  const question = normalizeQuestion(issue.publicQuestion, task);
  object(issue.assessmentBundle, "assessmentBundle");
  object(issue.contentRef, "contentRef");
  return {
    question,
    assessmentBundle: issue.assessmentBundle,
    contentRef: jsonClone(issue.contentRef),
    approvedMaterials: normalizeApprovedMaterials(issue.approvedMaterials, question),
  };
}

function assertQuestionOutput(output, task, expectedQuestion) {
  const result = object(output.teaching_result, "teaching_result");
  if (result.action !== task.action || result.answer_visibility !== "hidden") {
    throw harnessError("ANSWER_GATE_VIOLATION", "作答前的教学结果必须隐藏答案。 ");
  }
  if (result.state_write_performed !== false) {
    throw harnessError("AGENT_CLAIMED_STATE_WRITE", "智能体不能声称已经写入学习进度。 ");
  }
  if (!Array.isArray(result.feedback) || result.feedback.length !== 0) {
    throw harnessError("ANSWER_GATE_VIOLATION", "作答前不能返回反馈。 ");
  }
  if (!Array.isArray(result.assessments) || result.assessments.length !== 0) {
    throw harnessError("ANSWER_GATE_VIOLATION", "作答前不能返回判定。 ");
  }
  if (!Array.isArray(output.proposed_progress_events) || output.proposed_progress_events.length !== 0) {
    throw harnessError("UNTRUSTED_PROGRESS_PROPOSAL", "作答前不能提出进度事件。 ");
  }
  if (!Array.isArray(result.learning_items) || result.learning_items.length !== 1) {
    throw harnessError("INVALID_QUESTION_COUNT", "每个学习任务必须恰好返回一道受信题。 ");
  }
  const returned = normalizeQuestion(result.learning_items[0], task);
  if (!isDeepStrictEqual(returned, expectedQuestion)) {
    throw harnessError("ACTIVE_ITEM_CHANGED", "智能体改写了本地受信题目，拒绝展示。 ");
  }
  return returned;
}

function normalizeFeedback(item, question) {
  object(item, "feedback");
  if (item.item_id !== question.item_id) {
    throw harnessError("FEEDBACK_ITEM_MISMATCH", "反馈与当前作答题目不一致。 ");
  }
  const value = {
    item_id: text(item.item_id, "feedback.item_id", 128),
    result: text(item.result, "feedback.result", 32),
    explanation: text(item.explanation, "feedback.explanation", 10_000),
    source_refs: Array.isArray(item.source_refs) ? [...item.source_refs] : [],
  };
  if (!RESULTS.has(value.result)) {
    throw harnessError("INVALID_HARNESS_DATA", `不支持的反馈结果 ${value.result}。`);
  }
  if (item.reference_answer !== undefined) {
    value.reference_answer = text(item.reference_answer, "feedback.reference_answer");
  }
  return value;
}

function assertSubmissionOutput(output, task, question, trustedGrade, authorization) {
  const result = object(output.teaching_result, "teaching_result");
  if (result.action !== "submit" || result.answer_visibility !== "revealed_after_submission") {
    throw harnessError("ANSWER_GATE_VIOLATION", "只有 submit 结果可以揭示答案和反馈。 ");
  }
  if (result.state_write_performed !== false) {
    throw harnessError("AGENT_CLAIMED_STATE_WRITE", "智能体只能提出进度事件。 ");
  }
  if (!Array.isArray(result.feedback) || result.feedback.length !== 1) {
    throw harnessError("INVALID_FEEDBACK_COUNT", "单题提交必须返回且只返回一条反馈。 ");
  }
  const feedback = normalizeFeedback(result.feedback[0], question);
  const expectedFeedback = {
    item_id: trustedGrade.item_id,
    result: trustedGrade.result,
    reference_answer: trustedGrade.reference_answer,
    explanation: trustedGrade.explanation,
    source_refs: jsonClone(trustedGrade.source_refs),
  };
  if (!isDeepStrictEqual(feedback, expectedFeedback)) {
    throw harnessError("TRUSTED_GRADE_MISMATCH", "智能体反馈与本地可信判定不一致。 ");
  }
  if (!Array.isArray(result.assessments) || result.assessments.length !== 1) {
    throw harnessError("INVALID_ASSESSMENT_COUNT", "单题提交必须返回且只返回一条判定。 ");
  }
  const assessment = object(result.assessments[0], "assessment");
  if (
    assessment.subject !== trustedGrade.subject ||
    assessment.topic_id !== trustedGrade.topic_id ||
    assessment.result !== trustedGrade.result
  ) {
    throw harnessError("TRUSTED_GRADE_MISMATCH", "智能体 assessment 与本地可信判定不一致。 ");
  }
  if (!Array.isArray(output.proposed_progress_events) || output.proposed_progress_events.length !== 1) {
    throw harnessError("INVALID_PROGRESS_PROPOSAL_COUNT", "客观题提交必须产生且只产生一条进度提议。 ");
  }
  const event = object(output.proposed_progress_events[0], "proposed_progress_events[0]");
  if (
    event.event_type !== authorization.event_type ||
    event.subject !== task.subject ||
    event.topic_id !== task.topic_id ||
    event.result !== trustedGrade.result ||
    event.evidence?.item_id !== question.item_id ||
    event.proposal_only !== true ||
    event.requires_authenticated_context !== true
  ) {
    throw harnessError("PROPOSAL_TASK_MISMATCH", "智能体进度提议与本地可信判定不一致。 ");
  }
  return feedback;
}

function validateResponse(response) {
  if (typeof response === "string") return text(response.trim(), "response", 50_000);
  if (
    Array.isArray(response) &&
    response.length >= 1 &&
    response.length <= 20 &&
    response.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 128) &&
    new Set(response).size === response.length
  ) {
    return [...response];
  }
  throw harnessError("INVALID_SUBMISSION", "作答必须是非空文本或不重复的选项数组。 ");
}

function validateSubmitOptions(options) {
  if (options === undefined) return { confidence: "unsure", durationSeconds: undefined };
  object(options, "submit options");
  const allowed = new Set(["confidence", "durationSeconds"]);
  const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw harnessError(
      "UNTRUSTED_SUBMISSION_OPTION",
      `提交参数不能包含 ${unexpected.join("、")}；题目、身份和授权只能由受信外层绑定。`,
    );
  }
  const confidence = options.confidence ?? "unsure";
  if (!CONFIDENCE.has(confidence)) {
    throw harnessError("INVALID_SUBMISSION", "confidence 必须是 guess、unsure 或 sure。 ");
  }
  if (
    options.durationSeconds !== undefined &&
    (!Number.isSafeInteger(options.durationSeconds) || options.durationSeconds < 1)
  ) {
    throw harnessError("INVALID_SUBMISSION", "durationSeconds 必须是正整数。 ");
  }
  return { confidence, durationSeconds: options.durationSeconds };
}

async function runAgent(agentRunner, input, metadata) {
  const output = typeof agentRunner === "function"
    ? await agentRunner(input, metadata)
    : await agentRunner?.run?.(input, metadata);
  if (output === undefined) throw new TypeError("agentRunner_function_or_run_method_required");
  return object(output, "agent output");
}

async function publish(channel, message) {
  if (!channel) return;
  if (typeof channel === "function") {
    await channel(message);
    return;
  }
  if (typeof channel.publish === "function") {
    await channel.publish(message);
    return;
  }
  throw new TypeError("channel_function_or_publish_method_required");
}

function publicTask(task, index, total) {
  return { ...jsonClone(task), position: index + 1, total };
}

function validateEvaluation(value, question) {
  if (value === null || value === undefined) return null;
  object(value, "evaluation");
  if (
    value.item_id !== question?.item_id ||
    typeof value.attempt_key !== "string" ||
    value.attempt_key.length < 1 ||
    !["evaluation_started", "commit_started"].includes(value.phase)
  ) {
    throw harnessError("INVALID_HARNESS_STATE", "中断判题元数据无效。 ");
  }
  return {
    item_id: value.item_id,
    attempt_key: value.attempt_key,
    phase: value.phase,
  };
}

function validateSnapshot(snapshot) {
  object(snapshot, "snapshot");
  if (snapshot.schema_version !== LEARNING_SNAPSHOT_VERSION) {
    throw harnessError("UNSUPPORTED_HARNESS_SNAPSHOT", "学习会话快照版本不受支持。 ");
  }
  if (!STABLE_STATES.has(snapshot.state)) {
    throw harnessError("INVALID_HARNESS_STATE", "只能从稳定状态恢复学习会话。 ");
  }
  const roundId = text(snapshot.round_id, "snapshot.round_id", 128);
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.length > 3) {
    throw harnessError("ROUND_TASK_LIMIT_EXCEEDED", "每轮最多只能包含 3 个任务。 ");
  }
  const tasks = snapshot.tasks.map(normalizeTask);
  const cursor = snapshot.cursor;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > tasks.length) {
    throw harnessError("INVALID_HARNESS_CURSOR", "学习会话游标无效。 ");
  }
  let question = null;
  if (snapshot.question !== null && snapshot.question !== undefined) {
    if (cursor >= tasks.length) throw harnessError("INVALID_HARNESS_STATE", "完成态不能带有当前题目。 ");
    question = normalizeQuestion(snapshot.question, tasks[cursor]);
  }
  let feedback = null;
  if (snapshot.feedback !== null && snapshot.feedback !== undefined) {
    if (!question) throw harnessError("INVALID_HARNESS_STATE", "反馈态缺少当前题目。 ");
    feedback = normalizeFeedback(snapshot.feedback, question);
  }
  const contentRef = snapshot.content_ref === null || snapshot.content_ref === undefined
    ? null
    : jsonClone(object(snapshot.content_ref, "content_ref"));
  const evaluation = validateEvaluation(snapshot.evaluation, question);
  const progressCommit = snapshot.progress_commit === null || snapshot.progress_commit === undefined
    ? null
    : jsonClone(object(snapshot.progress_commit, "progress_commit"));
  if (
    !Array.isArray(snapshot.used_item_ids) ||
    snapshot.used_item_ids.length > 5_000 ||
    snapshot.used_item_ids.some((item) => typeof item !== "string" || item.length < 1 || item.length > 128)
  ) {
    throw harnessError("INVALID_HARNESS_STATE", "历史题目引用无效。 ");
  }
  const usedItemIds = [...new Set(snapshot.used_item_ids)];
  if (snapshot.state === LEARNING_STATES.COLD_START && (tasks.length !== 0 || cursor !== 0)) {
    throw harnessError("INVALID_HARNESS_STATE", "cold_start 快照不能包含学习任务。 ");
  }
  if (snapshot.state === LEARNING_STATES.READY && (question || feedback || contentRef || cursor >= tasks.length)) {
    throw harnessError("INVALID_HARNESS_STATE", "ready 快照结构无效。 ");
  }
  if (snapshot.state === LEARNING_STATES.AWAITING_ANSWER && (!question || !contentRef || feedback || evaluation)) {
    throw harnessError("INVALID_HARNESS_STATE", "awaiting_answer 快照结构无效。 ");
  }
  if (snapshot.state === LEARNING_STATES.FEEDBACK && (!question || !contentRef || !feedback || evaluation)) {
    throw harnessError("INVALID_HARNESS_STATE", "feedback 快照结构无效。 ");
  }
  if (snapshot.state === LEARNING_STATES.INDETERMINATE && (!question || !contentRef || !evaluation || feedback)) {
    throw harnessError("INVALID_HARNESS_STATE", "indeterminate 快照结构无效。 ");
  }
  if (snapshot.state === LEARNING_STATES.COMPLETE && (cursor !== tasks.length || question || feedback || contentRef)) {
    throw harnessError("INVALID_HARNESS_STATE", "complete 快照结构无效。 ");
  }
  return {
    roundId,
    state: snapshot.state,
    tasks,
    cursor,
    question,
    feedback,
    contentRef,
    evaluation,
    progressCommit,
    usedItemIds,
  };
}

function submissionMaterials(baseMaterials, question, grade, authorization) {
  const locator = baseMaterials[0]?.locator || question.item_id;
  return [{
    source_id: baseMaterials[0]?.source_id || "user-supplied-local-review-material",
    locator: `${locator}:trusted-grade`,
    excerpt: JSON.stringify({
      active_item: question,
      trusted_grade: {
        ...grade,
        event_type: authorization.event_type,
      },
    }),
  }];
}

/**
 * Transport-neutral conversation harness. The Host stays one-shot; this outer
 * state machine re-injects the complete active item on every turn. Models only
 * propose. A locally bound Trusted Grader is the sole source of write authority.
 */
export class LearningConversationHarness {
  constructor({
    progress,
    workbench,
    agentRunner,
    contentProvider,
    trustedGrader,
    checkpoint,
    channel,
    snapshot,
    idFactory = randomUUID,
  } = {}) {
    if (!workbench) throw new TypeError("workbench_required");
    if (!agentRunner) throw new TypeError("agentRunner_required");
    if (!contentProvider?.issue || !contentProvider?.rehydrate) {
      throw new TypeError("contentProvider_issue_and_rehydrate_required");
    }
    if (!trustedGrader?.grade) throw new TypeError("trustedGrader_required");
    if (checkpoint && typeof checkpoint !== "function") throw new TypeError("checkpoint_function_required");
    this.progress = progress;
    this.workbench = workbench;
    this.agentRunner = agentRunner;
    this.contentProvider = contentProvider;
    this.trustedGrader = trustedGrader;
    this.checkpoint = checkpoint;
    this.channel = channel;
    this.idFactory = idFactory;
    this.assessmentBundle = null;
    this.approvedMaterials = null;
    if (snapshot) {
      const restored = validateSnapshot(assertNoIdentityFields(jsonClone(snapshot)));
      this.roundId = restored.roundId;
      this.state = restored.state;
      this.tasks = restored.tasks;
      this.cursor = restored.cursor;
      this.question = restored.question;
      this.feedback = restored.feedback;
      this.contentRef = restored.contentRef;
      this.evaluation = restored.evaluation;
      this.progressCommit = restored.progressCommit;
      this.usedItemIds = restored.usedItemIds;
    } else {
      this.roundId = String(this.idFactory());
      this.state = LEARNING_STATES.COLD_START;
      this.tasks = [];
      this.cursor = 0;
      this.question = null;
      this.feedback = null;
      this.contentRef = null;
      this.evaluation = null;
      this.progressCommit = null;
      this.usedItemIds = [];
    }
  }

  static restore(dependencies, snapshot) {
    return new LearningConversationHarness({ ...dependencies, snapshot });
  }

  async start({ subject, today } = {}) {
    this.#expect(LEARNING_STATES.COLD_START);
    const provider = this.progress || this.workbench;
    const load = typeof provider.recommend === "function"
      ? provider.recommend.bind(provider)
      : provider.today?.bind(provider);
    if (!load) throw new TypeError("progress_recommend_or_workbench_today_required");
    const [result, status] = await Promise.all([
      load({ limit: 3, subject, today }),
      typeof provider.status === "function" ? provider.status() : null,
    ]);
    const recommendations = Array.isArray(result?.recommendations) ? result.recommendations : [];
    this.tasks = applyDiagnosticActions(
      budgetTasks(recommendations, result?.profile?.daily_minutes),
      status,
    );
    this.usedItemIds = attemptedItemIds(status);
    this.cursor = 0;
    this.state = this.tasks.length > 0 ? LEARNING_STATES.READY : LEARNING_STATES.COMPLETE;
    await this.#checkpoint();
    const view = this.view();
    await this.#publish(this.state === LEARNING_STATES.COMPLETE ? "round_complete" : "round_ready", view);
    return view;
  }

  async next() {
    this.#expect(LEARNING_STATES.READY);
    const task = this.tasks[this.cursor];
    this.state = LEARNING_STATES.GENERATING_QUESTION;
    let issue;
    try {
      issue = normalizeContentIssue(await this.contentProvider.issue({
        task: jsonClone(task),
        roundId: this.roundId,
        taskIndex: this.cursor,
        usedItemIds: [...this.usedItemIds],
      }), task);
      const payload = {
        count: 1,
        subject: task.subject,
        topic_ids: [task.topic_id],
        question_ids: [issue.question.item_id],
        active_item: issue.question,
        approved_materials: issue.approvedMaterials,
      };
      const prepared = await this.workbench.prepareTeachingAction({ action: task.action, payload });
      const output = await runAgent(this.agentRunner, prepared.input, {
        phase: "question",
        task: publicTask(task, this.cursor, this.tasks.length),
      });
      const question = assertQuestionOutput(output, task, issue.question);
      await this.workbench.commitTeachingProposal({
        output,
        action: task.action,
        trustedAuthorizations: [],
      });
      this.question = question;
      this.feedback = null;
      this.contentRef = issue.contentRef;
      this.assessmentBundle = issue.assessmentBundle;
      this.approvedMaterials = issue.approvedMaterials;
      this.progressCommit = null;
      if (!this.usedItemIds.includes(question.item_id)) {
        this.usedItemIds.push(question.item_id);
        this.usedItemIds = this.usedItemIds.slice(-5_000);
      }
      this.evaluation = null;
      this.state = LEARNING_STATES.AWAITING_ANSWER;
    } catch (error) {
      this.state = LEARNING_STATES.READY;
      throw error;
    }
    await this.#checkpoint();
    const view = this.view();
    await this.#publish("question", view);
    return view;
  }

  async submit(response, options = undefined) {
    this.#expect(LEARNING_STATES.AWAITING_ANSWER);
    const submission = validateResponse(response);
    const { confidence, durationSeconds } = validateSubmitOptions(options);
    const task = this.tasks[this.cursor];
    const question = this.question;
    const attemptKey = `${this.roundId}:${this.cursor + 1}:${question.item_id}`;
    this.evaluation = {
      item_id: question.item_id,
      attempt_key: attemptKey,
      phase: "evaluation_started",
    };
    this.state = LEARNING_STATES.EVALUATING;

    let commitStarted = false;
    let committed;
    try {
      await this.#ensureAssessmentBundle(task);
      await this.#checkpoint();
      const graded = this.trustedGrader.grade({
        assessmentBundle: this.assessmentBundle,
        response: submission,
        attemptKey,
        confidence,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
      object(graded, "trusted grade");
      const grade = object(graded.grade, "trusted grade.grade");
      const authorization = object(graded.authorization, "trusted grade.authorization");
      const prepared = await this.workbench.prepareTeachingAction({
        action: "submit",
        payload: {
          subject: task.subject,
          topic_ids: [task.topic_id],
          question_ids: [question.item_id],
          active_item: question,
          submission: { item_id: question.item_id, response: submission },
          approved_materials: submissionMaterials(
            this.approvedMaterials,
            question,
            grade,
            authorization,
          ),
        },
      });
      const output = await runAgent(this.agentRunner, prepared.input, {
        phase: "submission",
        task: publicTask(task, this.cursor, this.tasks.length),
        item_id: question.item_id,
      });
      const feedback = assertSubmissionOutput(output, task, question, grade, authorization);
      this.evaluation = { ...this.evaluation, phase: "commit_started" };
      await this.#checkpoint();
      commitStarted = true;
      committed = await this.workbench.commitTeachingProposal({
        output,
        action: "submit",
        trustedAuthorizations: [authorization],
      });
      this.feedback = feedback;
      this.progressCommit = jsonClone(committed.progress_commit);
      this.evaluation = null;
      this.state = LEARNING_STATES.FEEDBACK;
      await this.#checkpoint();
    } catch (error) {
      if (commitStarted) {
        this.state = LEARNING_STATES.INDETERMINATE;
      } else {
        this.state = LEARNING_STATES.AWAITING_ANSWER;
        this.evaluation = null;
      }
      await this.#checkpoint().catch(() => {});
      throw error;
    }
    const view = this.view();
    await this.#publish("feedback", view);
    return view;
  }

  async advance() {
    this.#expect(LEARNING_STATES.FEEDBACK);
    this.cursor += 1;
    this.question = null;
    this.feedback = null;
    this.contentRef = null;
    this.assessmentBundle = null;
    this.approvedMaterials = null;
    this.progressCommit = null;
    this.evaluation = null;
    this.state = this.cursor < this.tasks.length ? LEARNING_STATES.READY : LEARNING_STATES.COMPLETE;
    await this.#checkpoint();
    const view = this.view();
    await this.#publish(this.state === LEARNING_STATES.COMPLETE ? "round_complete" : "task_ready", view);
    return view;
  }

  view() {
    const currentTask = this.cursor < this.tasks.length
      ? publicTask(this.tasks[this.cursor], this.cursor, this.tasks.length)
      : null;
    return jsonClone({
      state: this.state,
      round_id: this.roundId,
      completed_tasks: this.cursor,
      total_tasks: this.tasks.length,
      task: currentTask,
      question: this.question,
      feedback: this.feedback,
      progress_commit: this.progressCommit,
      ...(this.state === LEARNING_STATES.INDETERMINATE
        ? {
          interruption: {
            item_id: this.evaluation?.item_id,
            phase: this.evaluation?.phase,
            message: "上次提交结果未知，已禁止自动重答；请先核对本地进度。",
          },
        }
        : {}),
    });
  }

  snapshot() {
    const stableState = this.state === LEARNING_STATES.GENERATING_QUESTION
      ? LEARNING_STATES.READY
      : (this.state === LEARNING_STATES.EVALUATING
        ? (this.evaluation?.phase === "commit_started"
          ? LEARNING_STATES.INDETERMINATE
          : LEARNING_STATES.AWAITING_ANSWER)
        : this.state);
    const keepsQuestion = [
      LEARNING_STATES.AWAITING_ANSWER,
      LEARNING_STATES.FEEDBACK,
      LEARNING_STATES.INDETERMINATE,
    ].includes(stableState);
    const snapshot = {
      schema_version: LEARNING_SNAPSHOT_VERSION,
      round_id: this.roundId,
      state: stableState,
      tasks: this.tasks,
      cursor: this.cursor,
      question: keepsQuestion ? this.question : null,
      feedback: stableState === LEARNING_STATES.FEEDBACK ? this.feedback : null,
      content_ref: keepsQuestion ? this.contentRef : null,
      evaluation: stableState === LEARNING_STATES.INDETERMINATE ? this.evaluation : null,
      progress_commit: stableState === LEARNING_STATES.FEEDBACK ? this.progressCommit : null,
      used_item_ids: this.usedItemIds,
    };
    return assertNoIdentityFields(jsonClone(snapshot));
  }

  toJSON() {
    return this.snapshot();
  }

  async #ensureAssessmentBundle(task) {
    if (this.assessmentBundle && this.approvedMaterials) return;
    const restored = normalizeContentIssue(
      await this.contentProvider.rehydrate(jsonClone(this.contentRef)),
      task,
    );
    if (!isDeepStrictEqual(restored.question, this.question)) {
      throw harnessError("CONTENT_CHANGED", "恢复会话时本地题面已经变化，拒绝继续判题。 ");
    }
    this.assessmentBundle = restored.assessmentBundle;
    this.approvedMaterials = restored.approvedMaterials;
  }

  #expect(expected) {
    if (this.state !== expected) {
      throw harnessError(
        "INVALID_HARNESS_TRANSITION",
        `当前状态 ${this.state} 不能执行该操作；需要 ${expected}。`,
      );
    }
  }

  async #checkpoint() {
    if (this.checkpoint) await this.checkpoint(this.snapshot());
  }

  async #publish(type, payload) {
    await publish(this.channel, jsonClone({
      schema_version: "learning-harness-message.v1",
      type,
      state: this.state,
      round_id: this.roundId,
      payload,
    }));
  }
}

export const LearningHarness = LearningConversationHarness;
