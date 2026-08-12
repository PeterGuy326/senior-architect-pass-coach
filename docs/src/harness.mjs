/**
 * Browser coach API
 *
 * createBrowserCoach({ store, worker, curriculum?, clock?, idFactory? }) returns:
 * - restore()/loadExisting() load existing state without creating a profile
 * - initialize(options)  create/load the browser-local authorized profile
 * - start()              plan at most three tasks and issue the first question
 * - answer()/submit()    grade and atomically commit one objective attempt
 * - advance()/next()     move to the next task
 * - getView()/status()   return the current public UI projection
 * - subscribe(listener)  receive every view change
 * - exportData()/importData()/clearData() manage browser-local learner data
 * - close()              release Worker, IndexedDB and BroadcastChannel handles
 */

import { createIndexedDbStore } from "./indexeddb-store.mjs";
import {
  createBlankProgress,
  createLocalProfile,
  objectiveResult,
  planDailyTasks,
  progressSummary,
  responseBehaviorBaseline,
} from "./progress-rules.mjs";
import {
  assessResponseBehavior,
  calibrateResponseConfidence,
} from "./response-behavior.mjs";

export const WEB_HARNESS_STATES = Object.freeze({
  READY: "ready",
  LOADING: "loading",
  AWAITING_ANSWER: "awaiting_answer",
  EVALUATING: "evaluating",
  FEEDBACK: "feedback",
  COMPLETE: "complete",
  ERROR: "error",
});

const CONFIDENCE = new Set(["guess", "unsure", "sure"]);
const AGENT_ENGINE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_AGENT_TEXT = 2_000;
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "answer", "correct_answer", "reference_answer", "explanation", "analysis", "feedback", "result",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function coachError(code, message) {
  const value = new Error(message);
  value.code = code;
  return value;
}

function nowFrom(clock) {
  const value = typeof clock === "function" ? clock() : clock?.now?.();
  const instant = value || new Date().toISOString();
  if (typeof instant !== "string" || Number.isNaN(Date.parse(instant))) {
    throw coachError("INVALID_CLOCK", "clock 必须返回 ISO-8601 时间。");
  }
  return instant;
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "WEB_COACH_FAILED",
    message: typeof error?.message === "string" && error.message.length <= 512
      ? error.message
      : "私人老师暂时无法继续，请重试。",
  };
}

function safeAgentText(value, maximum = MAX_AGENT_TEXT) {
  if (typeof value !== "string") return "";
  const result = value
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, "")
    .trim()
    .slice(0, maximum);
  return /[\uD800-\uDBFF]$/u.test(result) ? result.slice(0, -1) : result;
}

function assertNoAnswer(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase())) {
      throw coachError("ANSWER_GATE_VIOLATION", `作答前题面包含 ${key}。`);
    }
    assertNoAnswer(child);
  }
}

function validateQuestion(rawQuestion, task) {
  const question = clone(rawQuestion);
  if (
    !question ||
    typeof question.item_id !== "string" ||
    question.subject !== "comprehensive" ||
    question.topic_id !== task.topic_id ||
    typeof question.prompt !== "string" ||
    !Array.isArray(question.options) ||
    question.options.length < 2 ||
    question.options.length > 8
  ) {
    throw coachError("INVALID_WORKER_QUESTION", "题库 Worker 返回了无效题面。");
  }
  assertNoAnswer(question);
  return question;
}

function unwrapWorkerResponse(request, response) {
  if (!response || typeof response !== "object" || response.id !== request.id) {
    throw coachError("INVALID_WORKER_RESPONSE", "题库 Worker 响应与当前请求不匹配。");
  }
  if (response.ok === false) {
    throw coachError(response.error?.code || "CONTENT_WORKER_FAILED", response.error?.message || "题库 Worker 执行失败。");
  }
  if (response.ok !== true) throw coachError("INVALID_WORKER_RESPONSE", "题库 Worker 响应缺少 ok 状态。");
  return clone(response.result ?? response.payload);
}

async function requestWorker(worker, request, timeoutMs = 20_000) {
  if (typeof worker === "function") return unwrapWorkerResponse(request, await worker(clone(request)));
  if (typeof worker?.request === "function") return unwrapWorkerResponse(request, await worker.request(clone(request)));
  if (!worker?.postMessage || !worker?.addEventListener) throw new TypeError("worker_request_or_postMessage_required");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(coachError("CONTENT_WORKER_TIMEOUT", "题库加载超时，请检查网络后重试。"))), timeoutMs);
    const onMessage = (event) => {
      if (event?.data?.id !== request.id) return;
      finish(() => {
        try { resolve(unwrapWorkerResponse(request, event.data)); } catch (error) { reject(error); }
      });
    };
    const onError = () => finish(() => reject(coachError("CONTENT_WORKER_FAILED", "题库 Worker 异常退出。")));
    const finish = (callback) => {
      clearTimeout(timer);
      worker.removeEventListener?.("message", onMessage);
      worker.removeEventListener?.("error", onError);
      callback();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(clone(request));
  });
}

function normalizeSubmission(value, options) {
  let response = value;
  let settings = options || {};
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "response")) {
    response = value.response;
    settings = value;
  }
  const confidence = settings.confidence || "unsure";
  if (!CONFIDENCE.has(confidence)) throw coachError("INVALID_CONFIDENCE", "把握度必须是 guess、unsure 或 sure。");
  if (
    !(typeof response === "string" && response.trim()) &&
    !(Array.isArray(response) && response.length > 0 && response.every((item) => typeof item === "string" && item.trim()))
  ) {
    throw coachError("INVALID_RESPONSE", "请选择至少一个有效选项。");
  }
  return {
    response: Array.isArray(response) ? response.map((item) => item.trim()) : response.trim(),
    confidence,
    behavior: settings.behavior ?? null,
    expectedRevision: settings.expectedRevision,
    expectedItemId: settings.expectedItemId,
  };
}

function validateGrade(raw, task, question, confidence) {
  const grade = clone(raw?.grade || raw);
  if (
    !grade ||
    grade.item_id !== question.item_id ||
    grade.topic_id !== task.topic_id ||
    grade.subject !== "comprehensive" ||
    typeof grade.correct !== "boolean" ||
    grade.score !== (grade.correct ? 1 : 0) ||
    grade.max_score !== 1
  ) {
    throw coachError("INVALID_WORKER_GRADE", "题库 Worker 判定与当前题目不一致。");
  }
  const expected = objectiveResult({ correct: grade.correct, confidence });
  if (grade.result !== expected) throw coachError("GRADE_RESULT_MISMATCH", "题库 Worker 三态判定不一致。");
  return grade;
}

function sameContentRef(left, right) {
  const keys = [
    "schema_version",
    "source_id",
    "source_commit",
    "relative_path",
    "question_number",
    "topic_id",
    "subject",
    "source_type",
    "action",
    "item_id",
    "content_revision",
  ];
  return keys.every((key) => left?.[key] === right?.[key]);
}

function validateRestorableSession(session) {
  if (
    !session ||
    session.schema_version !== "web-coach-session.v1" ||
    !Array.isArray(session.tasks) ||
    session.tasks.length < 1 ||
    session.tasks.length > 3 ||
    !Number.isSafeInteger(session.cursor) ||
    session.cursor < 0 ||
    session.cursor >= session.tasks.length ||
    !["ready", "loading", "awaiting_answer", "feedback"].includes(session.state)
  ) {
    throw coachError("INVALID_ACTIVE_SESSION", "活动学习会话结构无效，已拒绝恢复。");
  }
  return session;
}

export class BrowserCoachHarness {
  constructor({
    store,
    worker,
    curriculum = null,
    curriculumLoader = null,
    clock,
    idFactory = defaultId,
    ownsWorker = false,
    agentClient = null,
    agentEngine = "content-only",
  } = {}) {
    if (!store?.initialize || !store?.commitAttempt) throw new TypeError("coach_store_required");
    if (!worker) throw new TypeError("content_worker_required");
    this.store = store;
    this.worker = worker;
    this.curriculum = curriculum;
    this.curriculumLoader = curriculumLoader;
    this.clock = clock;
    this.idFactory = idFactory;
    this.ownsWorker = ownsWorker;
    this.listeners = new Set();
    this.profile = null;
    this.progress = null;
    this.session = null;
    this.question = null;
    this.feedback = null;
    this.responseBehavior = null;
    this.state = WEB_HARNESS_STATES.READY;
    this.message = "尚未读取本浏览器的学习进度。";
    this.lastError = null;
    this.agentClient = null;
    this.agentEngine = "content-only";
    this.agentCoaching = null;
    this.agentFailure = null;
    this.requestCounter = 0;
    this.unsubscribeStore = this.store.subscribe?.(() => {});
    this.setAgentClient(agentClient);
    this.setAgentPreference(agentEngine);
  }

  setAgentClient(client) {
    if (client !== null && typeof client?.coach !== "function") throw new TypeError("agent_client_coach_required");
    this.agentClient = client;
    this.#clearAgentTurn();
    return this.getView();
  }

  setAgentPreference(engine = "content-only") {
    if (typeof engine !== "string" || !AGENT_ENGINE.test(engine)) {
      throw coachError("INVALID_AGENT_ENGINE", "Agent 引擎标识无效。");
    }
    this.agentEngine = engine;
    this.#clearAgentTurn();
    return this.getView();
  }

  getAgentPreference() {
    return this.agentEngine;
  }

  async initialize({ examDate = null, dailyMinutes = 45 } = {}) {
    await this.#ensureCurriculum();
    const now = nowFrom(this.clock);
    const profile = createLocalProfile({
      principalId: `local:${this.idFactory()}`,
      examDate,
      dailyMinutes,
      now,
    });
    const initialized = await this.store.initialize({ profile, progress: createBlankProgress({ now }) });
    this.profile = initialized.profile;
    this.progress = initialized.progress;
    this.session = null;
    this.question = null;
    this.feedback = null;
    this.responseBehavior = null;
    this.#clearAgentTurn();
    this.state = WEB_HARNESS_STATES.READY;
    this.lastError = null;
    const summary = progressSummary(this.progress);
    this.message = initialized.created
      ? "我还不知道你的当前进度。先做高频综合题诊断，建立真实证据；案例和论文暂时保持未测量。"
      : (summary.knows_progress
        ? `我只按本浏览器中的 ${summary.evidence_count} 条真实证据安排今天的任务。`
        : "我仍不知道你的真实进度。先做诊断，不会编造掌握情况。");
    return this.#emit();
  }

  async restore() {
    const [profile, progress] = await Promise.all([
      this.store.getProfile(),
      this.store.getProgress(),
    ]);
    if (!profile && !progress) return null;
    if (!profile || !progress) {
      throw coachError("INCOMPLETE_LOCAL_STATE", "本浏览器的档案与进度不完整，已拒绝猜测或覆盖；请导入备份或清除后重建。");
    }
    if (
      profile.schema_version !== "web-learner-profile.v1" ||
      profile.authorization !== "local-browser-owner" ||
      progress.schema_version !== "web-progress.v1"
    ) {
      throw coachError("INVALID_LOCAL_STATE", "本浏览器中的私人学习状态版本无效。");
    }
    this.profile = profile;
    this.progress = progress;
    this.session = null;
    this.question = null;
    this.feedback = null;
    this.responseBehavior = null;
    this.#clearAgentTurn();
    this.state = WEB_HARNESS_STATES.READY;
    this.lastError = null;
    const summary = progressSummary(progress);
    this.message = summary.knows_progress
      ? `已恢复本浏览器中的 ${summary.evidence_count} 条真实学习证据。`
      : "已恢复本地档案，但我仍不知道你的真实水平；先做诊断。";
    const active = await this.#getUniqueActiveSession();
    if (active) return this.#restoreActiveSession(active);
    return this.#emit();
  }

  loadExisting() {
    return this.restore();
  }

  async start() {
    await this.#ensureInitialized();
    const active = await this.#getUniqueActiveSession();
    if (active) {
      if (!this.session || this.session.session_id !== active.session_id) {
        await this.#restoreActiveSession(active);
      }
      if (this.state === WEB_HARNESS_STATES.AWAITING_ANSWER && this.question) return this.getView();
      if (this.state === WEB_HARNESS_STATES.FEEDBACK) return this.advance();
      if (this.state === WEB_HARNESS_STATES.READY) return this.#loadCurrentQuestion();
      throw coachError("INVALID_HARNESS_TRANSITION", "现有活动会话暂时不能开始新一轮。");
    }
    const tasks = planDailyTasks({
      profile: this.profile,
      progress: this.progress,
      curriculum: this.curriculum,
      today: nowFrom(this.clock).slice(0, 10),
    });
    const now = nowFrom(this.clock);
    const session = {
      session_id: String(this.idFactory()),
      schema_version: "web-coach-session.v1",
      revision: 0,
      state: tasks.length ? WEB_HARNESS_STATES.READY : WEB_HARNESS_STATES.COMPLETE,
      tasks,
      cursor: 0,
      active_item_ref: null,
      feedback: null,
      created_at: now,
      updated_at: now,
    };
    this.session = await this.store.putSession(session);
    this.state = this.session.state;
    this.question = null;
    this.feedback = null;
    this.responseBehavior = null;
    this.#clearAgentTurn();
    if (!tasks.length) {
      this.message = "当前没有可安全解析的综合知识任务。";
      return this.#emit();
    }
    return this.#loadCurrentQuestion();
  }

  async answer(value, options = undefined) {
    const submission = normalizeSubmission(value, options);
    if (this.state !== WEB_HARNESS_STATES.AWAITING_ANSWER || !this.session || !this.question) {
      throw coachError("INVALID_HARNESS_TRANSITION", "当前没有等待作答的题目。");
    }
    const expectedRevision = submission.expectedRevision ?? this.session.revision;
    const expectedItemId = submission.expectedItemId ?? this.question.item_id;
    if (expectedRevision !== this.session.revision || expectedItemId !== this.question.item_id) {
      throw coachError("STALE_VIEW", "页面题目或版本已经过期，请刷新后继续。");
    }
    const personalBaseline = responseBehaviorBaseline(this.progress);
    const calibration = calibrateResponseConfidence({
      question: this.question,
      observation: submission.behavior,
      declaredConfidence: submission.confidence,
      personalBaseline,
    });
    this.state = WEB_HARNESS_STATES.EVALUATING;
    this.message = "正在使用固定答案键判定；如已连接 Agent，讲解会在进度提交后生成。";
    this.#emit();
    try {
      const result = await this.#workerRequest("grade", {
        contentRef: clone(this.session.active_item_ref.content_ref),
        response: submission.response,
        confidence: calibration.effective_confidence,
      });
      const task = this.session.tasks[this.session.cursor];
      const grade = validateGrade(result, task, this.question, calibration.effective_confidence);
      const behavior = assessResponseBehavior({
        question: this.question,
        observation: submission.behavior,
        declaredConfidence: submission.confidence,
        correct: grade.correct,
        personalBaseline,
      });
      const now = nowFrom(this.clock);
      const attempt = {
        attempt_id: `objective:${this.session.session_id}:${this.session.cursor + 1}:${this.question.item_id}`,
        item_id: this.question.item_id,
        topic_id: task.topic_id,
        subject: "comprehensive",
        skill: "recognition",
        score: grade.correct ? 1 : 0,
        max_score: 1,
        confidence: behavior.effective_confidence,
        declared_confidence: behavior.declared_confidence,
        confidence_source: behavior.confidence_source,
        behavior_signal: behavior.signal,
        behavior_reason_code: behavior.reason_code,
        pace_bucket: behavior.pace_bucket,
        timing_source: behavior.timing_source,
        timing_quality: behavior.timing_quality,
        duration_seconds: behavior.duration_seconds,
        first_choice_seconds: behavior.first_choice_seconds,
        answer_changes: behavior.answer_changes,
        result: grade.result,
        at: now,
        source_ref: Array.isArray(grade.source_refs) ? grade.source_refs[0] : "public-review-repository",
        content_revision: this.session.active_item_ref.content_ref?.content_revision || null,
      };
      const committed = await this.store.commitAttempt({
        expectedRevision,
        sessionId: this.session.session_id,
        expectedItemId,
        attempt,
        feedback: {
          item_id: grade.item_id,
          result: grade.result,
          correct: grade.correct,
          source_refs: Array.isArray(grade.source_refs) ? grade.source_refs : [],
          behavior: {
            schema_version: behavior.schema_version,
            signal: behavior.signal,
            reason_code: behavior.reason_code,
            timing_band: behavior.timing_band,
            pace_bucket: behavior.pace_bucket,
            timing_source: behavior.timing_source,
            timing_quality: behavior.timing_quality,
            declared_confidence: behavior.declared_confidence,
            confidence_source: behavior.confidence_source,
            effective_confidence: behavior.effective_confidence,
            duration_seconds: behavior.duration_seconds,
            first_choice_seconds: behavior.first_choice_seconds,
            answer_changes: behavior.answer_changes,
            expected_duration_seconds: behavior.expected_duration_seconds,
            question_load: behavior.question_load,
            baseline_source: behavior.baseline_source,
            summary: behavior.summary,
          },
        },
      });
      this.progress = committed.progress;
      this.session = committed.session;
      this.feedback = grade;
      this.responseBehavior = behavior;
      this.state = WEB_HARNESS_STATES.FEEDBACK;
      this.lastError = null;
      const behaviorRisk = ["hesitant", "likely_guess", "overconfident_wrong", "insufficient_signal"]
        .includes(behavior.signal);
      this.message = grade.result === "mastered"
        ? (behaviorRisk
          ? "这题答对且自报确定；行为信号仍建议复测，本次不计入稳定掌握证据。"
          : "这题答对且把握明确，记为 mastered；答题用时只作为辅助行为证据。")
        : (grade.result === "needs_retest"
          ? "答案正确但把握不足，记为 needs_retest，稍后再测。"
          : "这题尚未掌握，已进入优先复习队列。");
      const committedView = this.#emit();
      if (!this.#agentEnabled()) return committedView;
      try {
        const coaching = await this.agentClient.coach({
          phase: "submission",
          engine: this.agentEngine,
          publicQuestion: clone(this.question),
          trustedGrade: clone(grade),
          deidentifiedProgress: this.#deidentifiedProgress(task.topic_id),
        });
        const coachingText = safeAgentText(coaching?.coaching_text);
        if (!coachingText) throw coachError("EMPTY_AGENT_COACHING", "Agent 没有返回可显示的讲解。");
        this.agentCoaching = {
          coaching_text: coachingText,
          engine: safeAgentText(coaching?.engine, 64) || this.agentEngine,
        };
        this.agentFailure = null;
      } catch (error) {
        this.agentCoaching = null;
        this.agentFailure = {
          code: safeAgentText(error?.code, 80) || "AGENT_COACHING_FAILED",
          message: safeAgentText(error?.message, 240) || "Agent 讲解暂时不可用，已保留固定答案批改结果。",
        };
      }
      return this.#emit();
    } catch (error) {
      return this.#fail(error);
    }
  }

  submit(value, options) {
    return this.answer(value, options);
  }

  async advance() {
    if (this.state !== WEB_HARNESS_STATES.FEEDBACK || !this.session) {
      throw coachError("INVALID_HARNESS_TRANSITION", "查看反馈后才能进入下一项任务。");
    }
    const cursor = this.session.cursor + 1;
    const complete = cursor >= this.session.tasks.length;
    const next = {
      ...this.session,
      cursor,
      state: complete ? WEB_HARNESS_STATES.COMPLETE : WEB_HARNESS_STATES.READY,
      active_item_ref: null,
      feedback: null,
      updated_at: nowFrom(this.clock),
    };
    this.session = await this.store.putSession(next, { expectedRevision: this.session.revision });
    this.question = null;
    this.feedback = null;
    this.responseBehavior = null;
    this.#clearAgentTurn();
    this.state = this.session.state;
    if (complete) {
      this.message = "今天最多 3 项已经完成。到此为止，留出精力稳定过线。";
      return this.#emit();
    }
    return this.#loadCurrentQuestion();
  }

  async next() {
    if (!this.session) return this.start();
    if (this.state === WEB_HARNESS_STATES.FEEDBACK) return this.advance();
    if (this.state === WEB_HARNESS_STATES.READY) return this.#loadCurrentQuestion();
    throw coachError("INVALID_HARNESS_TRANSITION", `当前状态 ${this.state} 不能进入下一题。`);
  }

  async status() {
    this.profile = await this.store.getProfile();
    this.progress = await this.store.getProgress();
    return this.getView();
  }

  async askAgent(message) {
    const text = safeAgentText(message);
    if (!text) throw coachError("EMPTY_CHAT_MESSAGE", "请输入要问私教的问题。");
    if (!this.#agentEnabled()) {
      throw coachError("AGENT_NOT_SELECTED", "请先连接本机 Runtime，并选择一个可用 Agent 引擎。");
    }
    try {
      const result = await this.agentClient.coach({
        phase: "chat",
        engine: this.agentEngine,
        message: text,
        publicQuestion: this.question ? clone(this.question) : null,
        trustedGrade: this.state === WEB_HARNESS_STATES.FEEDBACK && this.feedback ? clone(this.feedback) : null,
        deidentifiedProgress: this.#deidentifiedProgress(this.session?.tasks?.[this.session.cursor]?.topic_id),
      });
      const coachingText = safeAgentText(result?.coaching_text);
      if (!coachingText) throw coachError("EMPTY_AGENT_COACHING", "Agent 没有返回可显示的回答。");
      return Object.freeze({
        coaching_text: coachingText,
        engine: safeAgentText(result?.engine, 64) || this.agentEngine,
      });
    } catch (error) {
      throw coachError(
        safeAgentText(error?.code, 80) || "AGENT_CHAT_FAILED",
        safeAgentText(error?.message, 240) || "Agent 对话暂时不可用，学习进度没有改变。",
      );
    }
  }

  getView() {
    const summary = progressSummary(this.progress || createBlankProgress({ now: nowFrom(this.clock) }));
    const task = this.session?.tasks?.[this.session.cursor] || null;
    return clone({
      state: this.state,
      revision: this.session?.revision || 0,
      sessionId: this.session?.session_id || null,
      knowsProgress: summary.knows_progress,
      scoreGoal: { passLine: summary.score_goal.pass_line, safetyTarget: summary.score_goal.safety_target },
      subjects: summary.subjects,
      unsupportedSubjects: summary.unsupported_subjects,
      task,
      question: [WEB_HARNESS_STATES.AWAITING_ANSWER, WEB_HARNESS_STATES.EVALUATING].includes(this.state)
        ? this.question
        : null,
      feedback: this.state === WEB_HARNESS_STATES.FEEDBACK && this.feedback
        ? { grade: this.feedback, behavior: this.responseBehavior }
        : null,
      tasks: this.session?.tasks || [],
      completedTasks: this.session?.cursor || 0,
      totalTasks: this.session?.tasks?.length || 0,
      message: this.message,
      error: this.lastError,
      agent: {
        preference: this.agentEngine,
        connected: Boolean(this.agentClient?.connected),
        coaching: this.agentCoaching,
        failure: this.agentFailure,
      },
    });
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener_function_required");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  exportData() {
    return this.store.exportData({ now: nowFrom(this.clock) });
  }

  async importData(payload) {
    await this.store.importData(payload);
    this.profile = await this.store.getProfile();
    this.progress = await this.store.getProgress();
    this.session = null;
    this.question = null;
    this.feedback = null;
    this.responseBehavior = null;
    this.#clearAgentTurn();
    this.state = WEB_HARNESS_STATES.READY;
    this.lastError = null;
    this.message = "本地学习进度已导入；题库正文和答案没有写入导出文件。";
    return this.#emit();
  }

  async clearData() {
    await this.store.clear();
    this.profile = null;
    this.progress = null;
    this.session = null;
    this.question = null;
    this.feedback = null;
    this.responseBehavior = null;
    this.#clearAgentTurn();
    this.state = WEB_HARNESS_STATES.READY;
    this.lastError = null;
    this.message = "已清除本浏览器中的私人学习数据。我现在不知道你的进度，重新开始会先诊断。";
    return this.#emit();
  }

  close() {
    this.unsubscribeStore?.();
    this.listeners.clear();
    if (this.ownsWorker) this.worker.terminate?.();
    this.store.close?.();
  }

  #agentEnabled() {
    return this.agentEngine !== "content-only" && Boolean(this.agentClient?.connected) && typeof this.agentClient?.coach === "function";
  }

  #clearAgentTurn() {
    this.agentCoaching = null;
    this.agentFailure = null;
  }

  #deidentifiedProgress(currentTopic = null) {
    const summary = progressSummary(this.progress || createBlankProgress({ now: nowFrom(this.clock) }));
    const subjectProgress = (subject) => {
      const value = summary.subjects?.[subject] || {};
      const evidenceCount = Math.max(0, Number(value.evidence_count || 0));
      return {
        status: safeAgentText(value.status, 64) || "unmeasured",
        latest_mock_score: typeof value.latest_mock_score === "number" && Number.isFinite(value.latest_mock_score)
          ? value.latest_mock_score
          : null,
        lower_bound_score: typeof value.lower_bound_score === "number" && Number.isFinite(value.lower_bound_score)
          ? value.lower_bound_score
          : null,
        evidence_level: evidenceCount > 0 ? "observed" : "cold_start",
        evidence_count: evidenceCount,
      };
    };
    const recommendations = (this.session?.tasks || [])
      .slice(this.session?.cursor || 0, (this.session?.cursor || 0) + 3)
      .map((task) => {
        const topic = this.progress?.topics?.[task.topic_id];
        const mastery = Number(topic?.mastery?.recognition?.mastery);
        const latestBehavior = topic?.mastery?.recognition?.latest_behavior_signal;
        const latestReasonCode = topic?.mastery?.recognition?.latest_behavior_reason_code;
        const behaviorReason = typeof latestReasonCode === "string" && /^[a-z0-9_]{1,64}$/u.test(latestReasonCode)
          ? latestReasonCode
          : ({
          fluent: "answer_fluent",
          hesitant: "answer_hesitant",
          likely_guess: "answer_likely_guess",
          overconfident_wrong: "answer_overconfident_wrong",
          }[latestBehavior] || null);
        const reviewDue = task.review_due === true || task.action === "review" || task.action === "retest";
        return {
          topic_id: safeAgentText(task.topic_id, 128),
          subject: "comprehensive",
          skill: "recognition",
          priority_score: null,
          mastery: Number.isFinite(mastery) ? mastery : null,
          review_due: reviewDue,
          estimated_minutes: Number.isFinite(Number(task.minutes)) ? Number(task.minutes) : null,
          reason_code: behaviorReason || (task.action === "diagnose" ? "cold_start" : (reviewDue ? "review_due" : "pass_priority")),
        };
      })
      .filter((item) => item.topic_id);
    let daysToExam = null;
    if (typeof this.profile?.exam_date === "string") {
      const milliseconds = Date.parse(`${this.profile.exam_date}T00:00:00.000Z`) - Date.parse(nowFrom(this.clock));
      if (Number.isFinite(milliseconds)) daysToExam = Math.max(0, Math.ceil(milliseconds / 86_400_000));
    }
    return {
      schema_version: "deidentified-progress.v1",
      subjects: Object.fromEntries(["comprehensive", "case", "essay"].map((subject) => [subject, subjectProgress(subject)])),
      target_subject: "comprehensive",
      maintenance_subject: null,
      crunch_mode: daysToExam !== null && daysToExam <= 3,
      days_to_exam: daysToExam,
      recommendations,
    };
  }

  async #getUniqueActiveSession() {
    if (typeof this.store.getUniqueActiveSession === "function") {
      return this.store.getUniqueActiveSession();
    }
    const sessions = typeof this.store.listSessions === "function" ? await this.store.listSessions() : [];
    const active = sessions.filter((session) => ["ready", "loading", "awaiting_answer", "feedback"].includes(session.state));
    if (active.length > 1) {
      throw coachError("AMBIGUOUS_ACTIVE_SESSION", "本浏览器存在多个活动学习会话，已拒绝猜测要恢复哪一个。");
    }
    return active[0] || null;
  }

  async #restoreActiveSession(rawSession) {
    const session = validateRestorableSession(clone(rawSession));
    this.session = session;
    this.question = null;
    this.feedback = null;
    this.responseBehavior = null;
    this.#clearAgentTurn();
    this.lastError = null;
    const task = session.tasks[session.cursor];

    if (session.state === WEB_HARNESS_STATES.AWAITING_ANSWER) {
      const storedRef = session.active_item_ref?.content_ref;
      if (
        !storedRef ||
        session.active_item_ref.item_id !== storedRef.item_id ||
        session.active_item_ref.topic_id !== task.topic_id
      ) {
        throw coachError("INVALID_ACTIVE_SESSION", "等待作答会话缺少受信内容引用。");
      }
      const restored = await this.#workerRequest("rehydrate", { contentRef: clone(storedRef) });
      const question = validateQuestion(restored?.publicQuestion, task);
      if (
        !sameContentRef(restored?.contentRef, storedRef) ||
        question.item_id !== session.active_item_ref.item_id
      ) {
        throw coachError("CONTENT_CHANGED", "恢复题目与保存的内容引用不一致，已拒绝继续判题。");
      }
      this.question = question;
      this.state = WEB_HARNESS_STATES.AWAITING_ANSWER;
      this.message = `${task.name || task.topic_id}：已恢复刷新前的同一道题，继续作答即可。`;
      return this.#emit();
    }

    if (session.state === WEB_HARNESS_STATES.FEEDBACK) {
      const cursor = session.cursor + 1;
      const complete = cursor >= session.tasks.length;
      const advanced = {
        ...session,
        cursor,
        state: complete ? WEB_HARNESS_STATES.COMPLETE : WEB_HARNESS_STATES.READY,
        active_item_ref: null,
        feedback: null,
        error: null,
        updated_at: nowFrom(this.clock),
      };
      this.session = await this.store.putSession(advanced, { expectedRevision: session.revision });
      this.state = this.session.state;
      this.message = complete
        ? "上题进度已经保存；答案正文未持久化，本轮现已安全完成。"
        : "上题进度已经保存；答案正文未持久化，已安全进入下一项准备态。";
      return this.#emit();
    }

    if (session.state === WEB_HARNESS_STATES.LOADING) {
      const ready = {
        ...session,
        state: WEB_HARNESS_STATES.READY,
        active_item_ref: null,
        feedback: null,
        error: null,
        updated_at: nowFrom(this.clock),
      };
      this.session = await this.store.putSession(ready, { expectedRevision: session.revision });
    }
    this.state = WEB_HARNESS_STATES.READY;
    this.message = "已恢复未完成的本地学习会话，继续后会重新加载当前公开题面。";
    return this.#emit();
  }

  async #ensureInitialized() {
    if (!this.profile || !this.progress) {
      await this.initialize();
      return;
    }
    await this.#ensureCurriculum();
  }

  async #ensureCurriculum() {
    if (this.curriculum) return;
    if (typeof this.curriculumLoader !== "function") throw coachError("CURRICULUM_REQUIRED", "缺少浏览器课程索引。");
    this.curriculum = await this.curriculumLoader();
  }

  async #loadCurrentQuestion() {
    const task = this.session.tasks[this.session.cursor];
    const loading = {
      ...this.session,
      state: WEB_HARNESS_STATES.LOADING,
      active_item_ref: null,
      feedback: null,
      updated_at: nowFrom(this.clock),
    };
    this.session = await this.store.putSession(loading, { expectedRevision: this.session.revision });
    this.state = WEB_HARNESS_STATES.LOADING;
    this.message = `正在从公开复习仓库加载第 ${this.session.cursor + 1}/${this.session.tasks.length} 项。`;
    this.#emit();
    try {
      const usedItemIds = Object.values(this.progress?.topics || {})
        .flatMap((topic) => topic?.mastery?.recognition?.attempted_items || [])
        .slice(-5_000);
      const result = await this.#workerRequest("issue", { task: clone(task), usedItemIds });
      const question = validateQuestion(result?.publicQuestion, task);
      if (!result?.contentRef || typeof result.contentRef !== "object") {
        throw coachError("INVALID_CONTENT_REF", "题库 Worker 缺少可恢复内容引用。");
      }
      const awaiting = {
        ...this.session,
        state: WEB_HARNESS_STATES.AWAITING_ANSWER,
        active_item_ref: {
          item_id: question.item_id,
          topic_id: question.topic_id,
          content_ref: clone(result.contentRef),
        },
        updated_at: nowFrom(this.clock),
      };
      this.session = await this.store.putSession(awaiting, { expectedRevision: this.session.revision });
      this.question = question;
      this.feedback = null;
      this.responseBehavior = null;
      this.#clearAgentTurn();
      this.state = WEB_HARNESS_STATES.AWAITING_ANSWER;
      this.lastError = null;
      this.message = `${task.name || task.topic_id}：先独立作答，再看参考答案。`;
      return this.#emit();
    } catch (error) {
      return this.#fail(error, true);
    }
  }

  async #workerRequest(type, payload) {
    const request = { id: `web-${++this.requestCounter}-${this.idFactory()}`, type, payload: clone(payload) };
    return requestWorker(this.worker, request);
  }

  async #fail(reason, persist = false) {
    this.lastError = safeError(reason);
    this.state = WEB_HARNESS_STATES.ERROR;
    this.message = this.lastError.message;
    if (persist && this.session) {
      const failed = {
        ...this.session,
        state: WEB_HARNESS_STATES.ERROR,
        active_item_ref: null,
        feedback: null,
        error: this.lastError,
        updated_at: nowFrom(this.clock),
      };
      try { this.session = await this.store.putSession(failed, { expectedRevision: this.session.revision }); } catch {}
    }
    this.#emit();
    throw reason;
  }

  #emit() {
    const view = this.getView();
    for (const listener of this.listeners) listener(clone(view));
    return view;
  }
}

export function createBrowserCoach(options) {
  return new BrowserCoachHarness(options);
}

export async function createWebCoachHarness({
  workerUrl = new URL("./content-worker.mjs", import.meta.url),
  store = createIndexedDbStore(),
  curriculum,
  curriculumUrl = new URL("../data/curriculum.json", import.meta.url),
  fetchImpl = globalThis.fetch,
  WorkerImpl = globalThis.Worker,
  ...options
} = {}) {
  if (typeof WorkerImpl !== "function") throw coachError("WEB_WORKER_UNAVAILABLE", "此浏览器不支持题库 Worker。");
  if (!curriculum && typeof fetchImpl !== "function") throw coachError("FETCH_UNAVAILABLE", "此浏览器无法加载课程索引。");
  const worker = new WorkerImpl(workerUrl, { type: "module", name: "architect-coach-content" });
  const curriculumLoader = curriculum ? null : async () => {
    const response = await fetchImpl(curriculumUrl, { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw coachError("CURRICULUM_LOAD_FAILED", "课程索引加载失败。");
    return response.json();
  };
  return createBrowserCoach({
    store,
    worker,
    curriculum,
    curriculumLoader,
    ownsWorker: true,
    ...options,
  });
}
