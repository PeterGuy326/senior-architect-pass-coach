export const PASS_LINE = 45;
export const SAFETY_TARGET = 52;
export const MAX_DAILY_TASKS = 3;
export const MAX_TASK_MINUTES = 15;

export const OBJECTIVE_RESULTS = Object.freeze({
  MASTERED: "mastered",
  NEEDS_RETEST: "needs_retest",
  NOT_MASTERED: "not_mastered",
});

const SUBJECTS = Object.freeze(["comprehensive", "case", "essay"]);
const CONFIDENCE = new Set(["guess", "unsure", "sure"]);
const BEHAVIOR_SIGNALS = new Set([
  "fluent",
  "hesitant",
  "likely_guess",
  "overconfident_wrong",
  "insufficient_signal",
  "steady",
]);
const BEHAVIOR_REASON_CODES = new Set([
  "clean_confident_correct",
  "clean_inferred_correct",
  "confident_wrong",
  "deliberate_reading_only",
  "explicit_guess",
  "explicit_unsure",
  "fast_correct_ambiguous",
  "fast_wrong_guess_risk",
  "revision_heavy",
  "steady_single_observation",
  "timing_unavailable",
]);
const PACE_BUCKETS = Object.freeze(["very_fast", "fast", "expected", "deliberate", "extended"]);
const PACE_BUCKET_SET = new Set([...PACE_BUCKETS, "unavailable"]);
const MAX_BASELINE_OBSERVATIONS = 48;
const TIMING_SOURCES = new Set(["live", "restored", "unavailable"]);
const TIMING_QUALITIES = new Set(["clean", "interrupted", "resumed", "unavailable"]);
const ATTEMPT_KEYS = new Set([
  "attempt_id",
  "item_id",
  "topic_id",
  "subject",
  "skill",
  "score",
  "max_score",
  "confidence",
  "declared_confidence",
  "confidence_source",
  "behavior_signal",
  "behavior_reason_code",
  "pace_bucket",
  "timing_source",
  "timing_quality",
  "duration_seconds",
  "first_choice_seconds",
  "answer_changes",
  "result",
  "at",
  "source_ref",
  "content_revision",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function dateOnly(value, label = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail("INVALID_DATE", `${label} 必须是 YYYY-MM-DD。`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail("INVALID_DATE", `${label} 不是有效日期。`);
  }
  return value;
}

function isoInstant(value, label = "at") {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("INVALID_INSTANT", `${label} 必须是 ISO-8601 时间。`);
  }
  return value;
}

function addDays(day, amount) {
  const date = new Date(`${dateOnly(day)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayOf(instant) {
  return new Date(isoInstant(instant)).toISOString().slice(0, 10);
}

function blankSubject() {
  return {
    mock_scores: [],
    latest_mock_score: null,
    predicted_score: null,
    lower_bound_score: null,
    evidence_level: "cold_start",
    last_practiced_at: null,
    evidence_count: 0,
  };
}

function blankRecognition() {
  return {
    status: "unseen",
    mastery: 0,
    attempt_count: 0,
    score_sum: 0,
    max_score_sum: 0,
    stability_score_sum: 0,
    stability_max_score_sum: 0,
    attempted_items: [],
    qualified_evidence: [],
    successful_dates: [],
    last_attempt_at: null,
    next_review_at: null,
    regression_active: false,
  };
}

function blankResponseBaseline() {
  return {
    schema_version: "web-response-baseline.v1",
    eligible_count: 0,
    pace_bucket_counts: Object.fromEntries(PACE_BUCKETS.map((bucket) => [bucket, 0])),
  };
}

function normalizedResponseBaseline(raw) {
  if (raw?.schema_version !== "web-response-baseline.v1") return blankResponseBaseline();
  const counts = Object.fromEntries(PACE_BUCKETS.map((bucket) => {
    const count = raw.pace_bucket_counts?.[bucket];
    return [bucket, Number.isSafeInteger(count) && count >= 0 && count <= MAX_BASELINE_OBSERVATIONS ? count : 0];
  }));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total > MAX_BASELINE_OBSERVATIONS || raw.eligible_count !== total) return blankResponseBaseline();
  return {
    schema_version: "web-response-baseline.v1",
    eligible_count: total,
    pace_bucket_counts: counts,
  };
}

export function responseBehaviorBaseline(progress) {
  return clone(normalizedResponseBaseline(progress?.response_behavior_baseline));
}

export function createLocalProfile({ principalId, examDate = null, dailyMinutes = 45, now } = {}) {
  if (typeof principalId !== "string" || !/^local:[A-Za-z0-9._:-]{8,160}$/u.test(principalId)) {
    fail("LOCAL_PRINCIPAL_REQUIRED", "必须使用浏览器本地签发的学习身份。");
  }
  if (examDate !== null) dateOnly(examDate, "examDate");
  if (!Number.isSafeInteger(dailyMinutes) || dailyMinutes < 1 || dailyMinutes > 1_440) {
    fail("INVALID_DAILY_MINUTES", "dailyMinutes 必须是 1-1440 的整数。");
  }
  const createdAt = isoInstant(now || new Date().toISOString(), "now");
  return Object.freeze({
    id: "self",
    schema_version: "web-learner-profile.v1",
    principal_id: principalId,
    authorization: "local-browser-owner",
    exam_date: examDate,
    daily_minutes: dailyMinutes,
    created_at: createdAt,
    updated_at: createdAt,
  });
}

export function createBlankProgress({ now } = {}) {
  const createdAt = isoInstant(now || new Date().toISOString(), "now");
  return {
    id: "current",
    schema_version: "web-progress.v1",
    strategy: { pass_line: PASS_LINE, safe_target: SAFETY_TARGET },
    subjects: Object.fromEntries(SUBJECTS.map((subject) => [subject, blankSubject()])),
    topics: {},
    response_behavior_baseline: blankResponseBaseline(),
    applied_attempt_ids: [],
    created_at: createdAt,
    last_session_at: null,
  };
}

export function objectiveResult({ correct, confidence = "unsure" } = {}) {
  if (typeof correct !== "boolean" || !CONFIDENCE.has(confidence)) {
    fail("INVALID_OBJECTIVE_GRADE", "客观题判定或把握度无效。");
  }
  if (!correct) return OBJECTIVE_RESULTS.NOT_MASTERED;
  return confidence === "sure" ? OBJECTIVE_RESULTS.MASTERED : OBJECTIVE_RESULTS.NEEDS_RETEST;
}

export function subjectStatus(subject, safetyTarget = SAFETY_TARGET) {
  const lower = subject?.lower_bound_score;
  if (lower === null || lower === undefined) return "unmeasured";
  if (lower < PASS_LINE) return "danger";
  if (lower < safetyTarget) return "near";
  return "safe";
}

export function progressSummary(progress) {
  const current = clone(progress || createBlankProgress());
  const subjects = {};
  for (const subject of SUBJECTS) {
    const value = current.subjects?.[subject] || blankSubject();
    subjects[subject] = { ...value, status: subjectStatus(value, SAFETY_TARGET) };
  }
  const evidenceCount = Object.values(subjects)
    .reduce((sum, subject) => sum + Number(subject.evidence_count || 0), 0);
  return {
    knows_progress: evidenceCount > 0,
    score_goal: { pass_line: PASS_LINE, safety_target: SAFETY_TARGET },
    subjects,
    evidence_count: evidenceCount,
    unsupported_subjects: ["case", "essay"],
  };
}

function validateAttempt(attempt) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) {
    fail("INVALID_ATTEMPT", "attempt 必须是对象。");
  }
  const unexpected = Object.keys(attempt).filter((key) => !ATTEMPT_KEYS.has(key));
  if (unexpected.length > 0) {
    fail("PRIVATE_CONTENT_FORBIDDEN", `attempt 禁止保存字段：${unexpected.join("、")}。`);
  }
  for (const key of ["attempt_id", "item_id", "topic_id"]) {
    if (typeof attempt[key] !== "string" || attempt[key].length < 1 || attempt[key].length > 256) {
      fail("INVALID_ATTEMPT", `${key} 无效。`);
    }
  }
  if (attempt.subject !== "comprehensive" || attempt.skill !== "recognition") {
    fail("UNSUPPORTED_WEB_SUBJECT", "首期网页只记录综合知识客观题证据。");
  }
  if (![0, 1].includes(attempt.score) || attempt.max_score !== 1 || !CONFIDENCE.has(attempt.confidence)) {
    fail("INVALID_ATTEMPT", "客观题分数或把握度无效。");
  }
  const hasBehavior = Object.hasOwn(attempt, "behavior_signal");
  if (hasBehavior) {
    const inferredConfidence = attempt.confidence_source === "inferred";
    if (
      !["default", "explicit", "inferred"].includes(attempt.confidence_source) ||
      !BEHAVIOR_SIGNALS.has(attempt.behavior_signal) ||
      (Object.hasOwn(attempt, "behavior_reason_code") && !BEHAVIOR_REASON_CODES.has(attempt.behavior_reason_code)) ||
      (Object.hasOwn(attempt, "pace_bucket") && !PACE_BUCKET_SET.has(attempt.pace_bucket)) ||
      !TIMING_SOURCES.has(attempt.timing_source) ||
      !TIMING_QUALITIES.has(attempt.timing_quality) ||
      (attempt.timing_source === "live" && !["clean", "interrupted"].includes(attempt.timing_quality)) ||
      (attempt.timing_source === "restored" && attempt.timing_quality !== "resumed") ||
      (attempt.timing_source === "unavailable" && attempt.timing_quality !== "unavailable") ||
      (inferredConfidence && (
        Object.hasOwn(attempt, "declared_confidence") || !["sure", "unsure"].includes(attempt.confidence)
      )) ||
      (!inferredConfidence && (
        !CONFIDENCE.has(attempt.declared_confidence) ||
        (attempt.declared_confidence !== "sure" && attempt.confidence !== attempt.declared_confidence) ||
        (attempt.declared_confidence === "sure" && !["sure", "unsure"].includes(attempt.confidence))
      )) ||
      !(attempt.duration_seconds === null || (
        Number.isFinite(attempt.duration_seconds) && attempt.duration_seconds >= 0 && attempt.duration_seconds <= 1_800
      )) ||
      !(attempt.first_choice_seconds === null || (
        Number.isFinite(attempt.first_choice_seconds) && attempt.first_choice_seconds >= 0 && attempt.first_choice_seconds <= 1_800
      )) ||
      !Number.isSafeInteger(attempt.answer_changes) ||
      attempt.answer_changes < 0 ||
      attempt.answer_changes > 20 ||
      (
        attempt.duration_seconds !== null &&
        attempt.first_choice_seconds !== null &&
        attempt.first_choice_seconds > attempt.duration_seconds
      )
    ) fail("INVALID_ATTEMPT", "答题行为证据无效。");
  } else if ([
    "declared_confidence",
    "confidence_source",
    "timing_source",
    "timing_quality",
    "duration_seconds",
    "first_choice_seconds",
    "answer_changes",
    "behavior_reason_code",
    "pace_bucket",
  ].some((key) => Object.hasOwn(attempt, key))) {
    fail("INVALID_ATTEMPT", "答题行为证据不完整。");
  }
  isoInstant(attempt.at);
  const expected = objectiveResult({ correct: attempt.score === 1, confidence: attempt.confidence });
  if (attempt.result !== expected) fail("GRADE_RESULT_MISMATCH", "三态结果与本地判定不一致。");
  return clone(attempt);
}

function recognitionStatus(record) {
  if (record.regression_active) return "fragile";
  const maximum = Number(record.stability_max_score_sum || 0);
  const accuracy = maximum > 0 ? Number(record.stability_score_sum || 0) / maximum : 0;
  const uniqueItems = new Set(record.qualified_evidence.map((item) => item.item_id));
  const dates = new Set(record.qualified_evidence.map((item) => dayOf(item.at)));
  if (uniqueItems.size >= 6 && dates.size >= 2 && accuracy >= 0.8) return "pass_ready";
  if (accuracy >= 0.75 && record.attempt_count >= 2) return "fragile";
  return "learning";
}

export function applyObjectiveAttempt(progress, rawAttempt) {
  const attempt = validateAttempt(rawAttempt);
  const next = clone(progress || createBlankProgress({ now: attempt.at }));
  if (next.schema_version !== "web-progress.v1") fail("UNSUPPORTED_PROGRESS", "进度版本不受支持。");
  if (next.applied_attempt_ids.includes(attempt.attempt_id)) {
    return { progress: next, already_applied: true };
  }

  const topic = next.topics[attempt.topic_id] || {
    topic_id: attempt.topic_id,
    status: "unseen",
    required_skills: ["recognition"],
    mastery: {},
    last_attempt_at: null,
    next_review_at: null,
  };
  const record = topic.mastery.recognition || blankRecognition();
  const wasPassReady = record.status === "pass_ready" || record.ever_pass_ready === true;
  record.attempt_count += 1;
  record.score_sum += attempt.score;
  record.max_score_sum += attempt.max_score;
  record.attempted_items = [...new Set([...record.attempted_items, attempt.item_id])].sort();
  record.last_attempt_at = attempt.at;
  record.latest_ratio = attempt.score;
  record.latest_confidence = attempt.confidence;
  record.latest_behavior_signal = attempt.behavior_signal || null;
  record.latest_behavior_reason_code = attempt.behavior_reason_code || ({
    fluent: attempt.confidence_source === "inferred" ? "clean_inferred_correct" : "clean_confident_correct",
    hesitant: "revision_heavy",
    likely_guess: "fast_wrong_guess_risk",
    overconfident_wrong: "confident_wrong",
    insufficient_signal: "timing_unavailable",
    steady: "steady_single_observation",
  }[attempt.behavior_signal] || null);
  const behaviorRisk = ["hesitant", "likely_guess", "overconfident_wrong", "insufficient_signal"]
    .includes(attempt.behavior_signal);
  const qualifiedCorrect = attempt.score === 1 && attempt.confidence === "sure" && !behaviorRisk;
  const stabilityEligible = attempt.score === 0 || qualifiedCorrect;
  if (stabilityEligible) {
    record.stability_score_sum = Number(record.stability_score_sum || 0) + attempt.score;
    record.stability_max_score_sum = Number(record.stability_max_score_sum || 0) + attempt.max_score;
  }
  record.latest_qualified = qualifiedCorrect;
  if (wasPassReady && attempt.score === 0) record.regression_active = true;
  if (record.latest_qualified) {
    record.qualified_evidence.push({
      attempt_id: attempt.attempt_id,
      item_id: attempt.item_id,
      at: attempt.at,
      ratio: 1,
    });
    record.successful_dates = [...new Set([...record.successful_dates, dayOf(attempt.at)])].sort();
  }
  const stabilityAccuracy = record.stability_max_score_sum > 0
    ? record.stability_score_sum / record.stability_max_score_sum
    : 0;
  const qualifiedItems = new Set(record.qualified_evidence.map((item) => item.item_id));
  record.mastery = Number((stabilityAccuracy * Math.min(1, qualifiedItems.size / 6)).toFixed(4));
  if (record.regression_active && record.latest_qualified) record.regression_active = false;
  record.status = recognitionStatus(record);
  if (record.status === "pass_ready") {
    record.ever_pass_ready = true;
    record.regression_active = false;
  }
  const interval = record.regression_active || !qualifiedCorrect
    ? 1
    : (record.status === "pass_ready" ? 14 : 3);
  record.next_review_at = addDays(dayOf(attempt.at), interval);
  topic.mastery.recognition = record;
  topic.status = record.status;
  topic.last_attempt_at = attempt.at;
  topic.next_review_at = record.next_review_at;
  next.topics[attempt.topic_id] = topic;
  const baseline = normalizedResponseBaseline(next.response_behavior_baseline);
  const baselineEligible = attempt.score === 1
    && attempt.confidence !== "guess"
    && attempt.timing_source === "live"
    && attempt.timing_quality === "clean"
    && attempt.answer_changes === 0
    && PACE_BUCKETS.includes(attempt.pace_bucket);
  if (baselineEligible) {
    if (baseline.eligible_count >= MAX_BASELINE_OBSERVATIONS) {
      for (const bucket of PACE_BUCKETS) {
        baseline.pace_bucket_counts[bucket] = Math.floor(baseline.pace_bucket_counts[bucket] / 2);
      }
      baseline.eligible_count = Object.values(baseline.pace_bucket_counts)
        .reduce((sum, count) => sum + count, 0);
    }
    baseline.pace_bucket_counts[attempt.pace_bucket] += 1;
    baseline.eligible_count += 1;
  }
  next.response_behavior_baseline = baseline;
  const subject = next.subjects.comprehensive;
  subject.evidence_count += 1;
  subject.last_practiced_at = attempt.at;
  next.last_session_at = attempt.at;
  next.applied_attempt_ids.push(attempt.attempt_id);
  return {
    progress: next,
    already_applied: false,
    topic_status: topic.status,
    next_review_at: topic.next_review_at,
  };
}

function coldStartGroupMap(curriculum) {
  const map = new Map();
  const groups = curriculum?.strategy?.comprehensive_cold_start_groups || [];
  groups.forEach((group, index) => group.forEach((topicId) => map.set(topicId, index + 1)));
  return map;
}

function topicMastery(progress, topicId) {
  const record = progress?.topics?.[topicId]?.mastery?.recognition;
  if (!record) return 0;
  return record.status === "pass_ready" ? 1 : Number(record.mastery || 0);
}

export function planDailyTasks({ profile, progress, curriculum, today } = {}) {
  const day = dateOnly(today || new Date().toISOString().slice(0, 10), "today");
  const dailyMinutes = Number(profile?.daily_minutes || 45);
  if (!Number.isSafeInteger(dailyMinutes) || dailyMinutes < 1) {
    fail("INVALID_DAILY_MINUTES", "本地档案缺少有效每日预算。");
  }
  const topics = Array.isArray(curriculum?.topics) ? curriculum.topics : [];
  const groups = coldStartGroupMap(curriculum);
  const comprehensiveEvidence = Number(progress?.subjects?.comprehensive?.evidence_count || 0);
  const ranked = topics
    .filter((topic) => topic?.subjects?.includes("comprehensive"))
    .filter((topic) => topic?.skills?.includes("recognition"))
    .filter((topic) => topic?.raw_tags?.some((tag) => /^§\d+(?:\.\d+)?$/u.test(tag)))
    .map((topic) => {
      const record = progress?.topics?.[topic.id]?.mastery?.recognition;
      const due = typeof record?.next_review_at === "string" && record.next_review_at <= day;
      const mastery = topicMastery(progress, topic.id);
      const frequency = Math.max(0, Number(topic.frequency_count || 0));
      const confidence = { high: 1, medium: 0.9, low: 0.7, expert_estimate: 0.65 }[
        topic.frequency_confidence
      ] || 0.7;
      const value = (1 + Math.log1p(frequency))
        * confidence
        * Number(topic.priority_weight || 0.5)
        * (1 + 0.2 * Number(topic.quick_win || 0))
        * (1 + 0.2 * Number(topic.cross_subject_value || 0));
      const cost = Math.max(0.5, Number(topic.estimated_minutes || 60) / 60);
      const priority = Math.max(0.08, 1 - mastery) * (due ? 1.7 : 1) * value / cost;
      return {
        topic,
        due,
        mastery,
        priority,
        coldGroup: comprehensiveEvidence < 6 ? (groups.get(topic.id) || 999) : 999,
      };
    })
    .sort((left, right) => Number(right.due) - Number(left.due)
      || left.coldGroup - right.coldGroup
      || right.priority - left.priority
      || Number(right.topic.frequency_count || 0) - Number(left.topic.frequency_count || 0)
      || left.topic.id.localeCompare(right.topic.id));

  const selected = [];
  let remaining = dailyMinutes;
  for (const entry of ranked) {
    if (selected.length >= MAX_DAILY_TASKS || remaining < 1) break;
    const minutes = Math.min(MAX_TASK_MINUTES, remaining, Math.max(1, Number(entry.topic.estimated_minutes || 10)));
    const action = entry.due ? "review" : (comprehensiveEvidence < 6 ? "diagnose" : "practice");
    selected.push({
      task_id: `comprehensive:${entry.topic.id}:${selected.length + 1}`,
      action,
      subject: "comprehensive",
      topic_id: entry.topic.id,
      name: entry.topic.name,
      skill: "recognition",
      minutes,
      mastery: Number(entry.mastery.toFixed(4)),
      review_due: entry.due,
      reason: action === "diagnose"
        ? "不知道当前真实水平，先用高频考点建立证据"
        : (entry.due ? "已到复习日，优先防止遗忘" : "当前过线投入产出比最高"),
    });
    remaining -= minutes;
  }
  return selected.map((task, index) => ({ ...task, position: index + 1, total: selected.length }));
}
