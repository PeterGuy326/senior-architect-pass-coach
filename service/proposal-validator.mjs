import { CoachError } from "./errors.mjs";
import { requireAuthenticated } from "./auth-context.mjs";

const ACTIONS = new Set([
  "diagnose",
  "status",
  "today",
  "practice",
  "submit",
  "review",
  "mock",
  "case",
  "essay",
]);
const TEACHING_STATUSES = new Set(["completed", "needs_input", "rejected"]);
const SCOPES = new Set(["general", "personalized"]);
const ANSWER_VISIBILITY = new Set([
  "hidden",
  "revealed_after_submission",
  "not_applicable",
]);
const EVENT_TYPES = new Set([
  "diagnostic_result",
  "practice_result",
  "mock_result",
  "case_result",
  "essay_result",
  "retest_result",
]);
const SUBJECTS = new Set(["comprehensive", "case", "essay"]);
const RESULTS = new Set(["mastered", "not_mastered", "needs_retest"]);
const PRE_SUBMISSION_ANSWER_MARKER = /(?:correct\s*answer|reference\s*answer|the\s+answer\s+is|(?:正确)?答案\s*(?:[:：]|是|为)|解析\s*[:：]|\[correct\]|[✓✔])/iu;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", `${label} 必须是对象。`);
  }
  return value;
}

function exactKeys(value, allowed, required, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new CoachError("INVALID_AGENT_PROPOSAL", `${label} 包含未授权字段 ${key}。`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new CoachError("INVALID_AGENT_PROPOSAL", `${label} 缺少字段 ${key}。`);
    }
  }
}

function string(value, label, maxLength = 20_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", `${label} 必须是非空字符串。`);
  }
  return value;
}

function array(value, label, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", `${label} 必须是长度不超过 ${maximum} 的数组。`);
  }
  return value;
}

function assertNoPrematureAnswer(value) {
  if (typeof value === "string") {
    if (PRE_SUBMISSION_ANSWER_MARKER.test(value)) {
      throw new CoachError("ANSWER_GATE_VIOLATION", "考生提交前的自由文本中检测到答案或解析。 ");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoPrematureAnswer);
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(assertNoPrematureAnswer);
  }
}

function validateTeachingResult(value, expectedAction) {
  const result = object(value, "teaching_result");
  const fields = [
    "schema_version",
    "action",
    "status",
    "scope",
    "summary",
    "score_goal",
    "answer_visibility",
    "state_write_performed",
    "assessments",
    "learning_items",
    "feedback",
    "recommendations",
    "source_refs",
  ];
  exactKeys(result, fields, fields, "teaching_result");
  if (result.schema_version !== "architect-pass-coach-teaching-result.v1") {
    throw new CoachError("INVALID_AGENT_PROPOSAL", "teaching_result schema_version 不受支持。");
  }
  if (!ACTIONS.has(result.action) || result.action !== expectedAction) {
    throw new CoachError("PROPOSAL_ACTION_MISMATCH", "智能体结果与待处理动作不一致。");
  }
  if (!TEACHING_STATUSES.has(result.status)) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", "teaching_result.status 无效。");
  }
  if (!SCOPES.has(result.scope)) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", "teaching_result.scope 无效。");
  }
  string(result.summary, "teaching_result.summary");
  const scoreGoal = object(result.score_goal, "teaching_result.score_goal");
  exactKeys(scoreGoal, ["pass_line", "safety_target"], ["pass_line", "safety_target"], "score_goal");
  if (scoreGoal.pass_line !== 45 || scoreGoal.safety_target !== 52) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", "过线目标必须保持 45/52。 ");
  }
  if (!ANSWER_VISIBILITY.has(result.answer_visibility)) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", "answer_visibility 无效。");
  }
  const feedbackItems = array(result.feedback, "teaching_result.feedback");
  if (expectedAction === "submit") {
    if (result.answer_visibility !== "revealed_after_submission") {
      throw new CoachError("ANSWER_GATE_VIOLATION", "只有提交动作可以揭示答案和反馈。");
    }
  } else if (["status", "today"].includes(expectedAction)) {
    if (result.answer_visibility !== "not_applicable" || feedbackItems.length !== 0) {
      throw new CoachError("ANSWER_GATE_VIOLATION", "状态类动作不能包含答案或反馈。");
    }
  } else if (result.answer_visibility !== "hidden" || feedbackItems.length !== 0) {
    throw new CoachError("ANSWER_GATE_VIOLATION", "考生提交前必须隐藏答案和反馈。");
  }
  if (result.answer_visibility === "hidden") assertNoPrematureAnswer(result);
  if (result.state_write_performed !== false) {
    throw new CoachError(
      "AGENT_CLAIMED_STATE_WRITE",
      "智能体只能提出建议，不能声称已经写入学习状态。",
    );
  }
  for (const key of ["assessments", "learning_items", "source_refs"]) {
    array(result[key], `teaching_result.${key}`);
  }
  array(result.recommendations, "teaching_result.recommendations", 3);
  return result;
}

function validateProgressEvent(value) {
  const event = object(value, "proposed_progress_event");
  const fields = [
    "schema_version",
    "event_type",
    "subject",
    "topic_id",
    "result",
    "evidence",
    "proposal_only",
    "requires_authenticated_context",
  ];
  exactKeys(event, fields, fields, "proposed_progress_event");
  if (event.schema_version !== "progress-event-proposal.v1") {
    throw new CoachError("INVALID_AGENT_PROPOSAL", "进度事件 schema_version 不受支持。");
  }
  if (!EVENT_TYPES.has(event.event_type) || !SUBJECTS.has(event.subject) || !RESULTS.has(event.result)) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", "进度事件枚举值无效。");
  }
  string(event.topic_id, "proposed_progress_event.topic_id", 128);
  const evidence = object(event.evidence, "proposed_progress_event.evidence");
  exactKeys(evidence, ["item_id", "summary"], ["item_id", "summary"], "event.evidence");
  string(evidence.item_id, "event.evidence.item_id", 256);
  string(evidence.summary, "event.evidence.summary", 2_000);
  if (event.proposal_only !== true || event.requires_authenticated_context !== true) {
    throw new CoachError("INVALID_AGENT_PROPOSAL", "进度事件必须保持 proposal-only 且要求授权上下文。");
  }
  return event;
}

export function validateTeachingOutput(output, { action, context }) {
  const envelope = object(output, "agent output");
  exactKeys(
    envelope,
    ["teaching_result", "proposed_progress_events"],
    ["teaching_result", "proposed_progress_events"],
    "agent output",
  );
  const teachingResult = validateTeachingResult(envelope.teaching_result, action);
  const events = array(envelope.proposed_progress_events, "proposed_progress_events", 20)
    .map(validateProgressEvent);
  if (!context?.authenticated) {
    if (action !== "diagnose" || teachingResult.scope !== "general" || events.length !== 0) {
      throw new CoachError(
        "ANONYMOUS_SCOPE_VIOLATION",
        "匿名上下文只能做通用诊断，且不能提出个人进度写入。",
      );
    }
  } else if (teachingResult.scope === "personalized") {
    requireAuthenticated(context);
  }
  if (teachingResult.status !== "completed" && events.length > 0) {
    throw new CoachError(
      "UNFINISHED_RESULT_HAS_EVENTS",
      "未完成或已拒绝的结果不能提出进度写入。",
    );
  }
  return { teaching_result: teachingResult, proposed_progress_events: events };
}

function matchAuthorizedWrite(event, authorization) {
  const expectedCommand = event.event_type === "mock_result" ? "mock" : "record";
  const payload = authorization?.payload;
  const payloadMatches = expectedCommand === "record"
    ? (
      payload?.topic_id === event.topic_id &&
      payload?.item_id === event.evidence.item_id &&
      (payload?.subject === undefined || payload.subject === event.subject) &&
      typeof payload?.attempt_id === "string" &&
      typeof payload?.skill === "string" &&
      typeof payload?.score === "number" &&
      typeof payload?.max_score === "number"
    )
    : (
      payload?.subject === event.subject &&
      payload?.paper_id === event.evidence.item_id &&
      typeof payload?.mock_id === "string" &&
      typeof payload?.score === "number" &&
      typeof payload?.duration_minutes === "number"
    );
  return (
    authorization &&
    authorization.event_type === event.event_type &&
    authorization.subject === event.subject &&
    authorization.topic_id === event.topic_id &&
    authorization.item_id === event.evidence.item_id &&
    authorization.expected_result === event.result &&
    authorization.command === expectedCommand &&
    payloadMatches
  );
}

export function authorizeProgressWrites(events, authorizations, context) {
  if (events.length === 0) return [];
  requireAuthenticated(context);
  if (!Array.isArray(authorizations) || authorizations.length !== events.length) {
    throw new CoachError(
      "MISSING_TRUSTED_EVIDENCE",
      "智能体提议没有与本地可信作答证据一一对应，拒绝写入。",
    );
  }
  const remaining = [...authorizations];
  return events.map((event) => {
    const index = remaining.findIndex((authorization) => (
      authorization?.principal_id === context.user_id &&
      matchAuthorizedWrite(event, authorization)
    ));
    if (index < 0) {
      throw new CoachError(
        "PROPOSAL_EVIDENCE_MISMATCH",
        "智能体提议与本地可信作答证据不一致，拒绝写入。",
      );
    }
    return remaining.splice(index, 1)[0];
  });
}
