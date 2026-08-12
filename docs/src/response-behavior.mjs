export const RESPONSE_BEHAVIOR_SIGNALS = Object.freeze({
  FLUENT: "fluent",
  HESITANT: "hesitant",
  LIKELY_GUESS: "likely_guess",
  OVERCONFIDENT_WRONG: "overconfident_wrong",
  INSUFFICIENT: "insufficient_signal",
  STEADY: "steady",
});

const CONFIDENCE = new Set(["guess", "unsure", "sure", "auto"]);
const CONFIDENCE_SOURCES = new Set(["default", "explicit", "inferred"]);
const TIMING_SOURCES = new Set(["live", "restored", "unavailable"]);
const TIMING_QUALITIES = new Set(["clean", "interrupted", "resumed", "unavailable"]);
const PACE_BUCKETS = new Set(["very_fast", "fast", "expected", "deliberate", "extended", "unavailable"]);
const OBSERVATION_KEYS = new Set([
  "schema_version",
  "timing_source",
  "timing_quality",
  "duration_seconds",
  "first_choice_seconds",
  "answer_changes",
  "confidence_source",
]);
const MAX_CONTINUOUS_ACTIVE_MILLISECONDS = 10 * 60 * 1_000;
const PERSONAL_BASELINE_MINIMUM = 12;
const FAST_RATIO = 0.55;
const DELIBERATE_RATIO = 1.6;
const EXTENDED_RATIO = 2.4;
const EARLY_CHOICE_RATIO = 0.25;

function behaviorError(message) {
  const error = new Error(message);
  error.code = "INVALID_RESPONSE_BEHAVIOR";
  return error;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundedSeconds(value) {
  return Math.round(value * 10) / 10;
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function optionTexts(question) {
  return Array.isArray(question?.options)
    ? question.options.map((option) => normalizedText(
        typeof option === "string" ? option : (option?.text ?? option?.content ?? ""),
      ))
    : [];
}

function readingUnits(value) {
  const text = normalizedText(value);
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const latinWords = (text.match(/[A-Za-z]+(?:[-_][A-Za-z]+)*/gu) || []).length;
  const numbers = (text.match(/\d+(?:\.\d+)?/gu) || []).length;
  const symbols = (text.match(/[=<>≤≥+*/%→←↔∧∨¬(){}[\]]/gu) || []).length;
  return cjk + (latinWords * 1.8) + (numbers * 1.3) + (symbols * 0.45);
}

function questionLoad(question) {
  const prompt = normalizedText(question?.prompt);
  const options = optionTexts(question);
  const promptUnits = readingUnits(prompt);
  const optionUnits = options.reduce((sum, option) => sum + readingUnits(option), 0);
  const longestOption = options.reduce((maximum, option) => Math.max(maximum, readingUnits(option)), 0);
  const contrastMarkers = (prompt.match(/(?:不正确|不恰当|不包括|错误|除外|不能|最不)/gu) || []).length;
  const reasoningMarkers = ([prompt, ...options].join(" ").match(/(?:如果|则|只有|除非|同时|分别|依次|对应|相比|当且仅当)/gu) || []).length;
  const structuredTokens = ([prompt, ...options].join(" ").match(/(?:\d+(?:\.\d+)?|[A-Za-z]{2,}|[=<>≤≥+*/%→←↔])/gu) || []).length;
  const complexitySeconds = Math.min(12,
    (Math.min(2, contrastMarkers) * 2.5)
    + (Math.min(4, reasoningMarkers) * 1.25)
    + (Math.min(12, structuredTokens) * 0.3)
    + Math.min(4, Math.max(0, longestOption - 30) * 0.08));
  const seconds = clamp(
    6
      + (promptUnits * 0.11)
      + (optionUnits * 0.075)
      + (Math.max(0, options.length - 2) * 1.2)
      + complexitySeconds,
    12,
    90,
  );
  return Object.freeze({
    base_expected_seconds: roundedSeconds(seconds),
    question_load: seconds < 18 ? "short" : (seconds < 35 ? "standard" : (seconds < 60 ? "long" : "very_long")),
  });
}

function baselineAdjustment(raw) {
  const counts = raw?.pace_bucket_counts;
  if (
    raw?.schema_version !== "web-response-baseline.v1" ||
    !counts ||
    typeof counts !== "object" ||
    Array.isArray(counts)
  ) return Object.freeze({ source: "population", multiplier: 1, sample_count: 0 });
  const ordered = [
    ["very_fast", 0.8],
    ["fast", 0.8],
    ["expected", 1],
    ["deliberate", 1.25],
    ["extended", 1.25],
  ];
  const values = ordered.map(([key]) => counts[key]);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 48)) {
    return Object.freeze({ source: "population", multiplier: 1, sample_count: 0 });
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (raw.eligible_count !== total || total < PERSONAL_BASELINE_MINIMUM || total > 48) {
    return Object.freeze({ source: "population", multiplier: 1, sample_count: total });
  }
  const midpoint = (total + 1) / 2;
  let cumulative = 0;
  let median = 1;
  for (const [key, representative] of ordered) {
    cumulative += counts[key];
    if (cumulative >= midpoint) {
      median = representative;
      break;
    }
  }
  return Object.freeze({
    source: "personal",
    multiplier: clamp(median, 0.8, 1.25),
    sample_count: total,
  });
}

export function estimateQuestionDuration(question, { personalBaseline = null } = {}) {
  const load = questionLoad(question);
  const baseline = baselineAdjustment(personalBaseline);
  const expected = baseline.source === "personal"
    ? clamp(load.base_expected_seconds * baseline.multiplier, 8, 105)
    : load.base_expected_seconds;
  return Object.freeze({
    base_expected_seconds: load.base_expected_seconds,
    expected_seconds: roundedSeconds(expected),
    question_load: load.question_load,
    baseline_source: baseline.source,
    baseline_sample_count: baseline.sample_count,
  });
}

export function estimateQuestionReadingSeconds(question) {
  return estimateQuestionDuration(question).expected_seconds;
}

export function normalizeResponseObservation(raw, { question, personalBaseline = null } = {}) {
  const estimate = estimateQuestionDuration(question, { personalBaseline });
  if (raw === null || raw === undefined) {
    return Object.freeze({
      schema_version: "web-response-observation.v1",
      timing_source: "unavailable",
      timing_quality: "unavailable",
      duration_seconds: null,
      first_choice_seconds: null,
      answer_changes: 0,
      confidence_source: "default",
      expected_reading_seconds: estimate.expected_seconds,
      expected_duration_seconds: estimate.expected_seconds,
      base_expected_duration_seconds: estimate.base_expected_seconds,
      question_load: estimate.question_load,
      baseline_source: estimate.baseline_source,
      baseline_sample_count: estimate.baseline_sample_count,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw behaviorError("答题行为观察必须是对象。");
  }
  const unexpected = Object.keys(raw).filter((key) => !OBSERVATION_KEYS.has(key));
  if (unexpected.length) throw behaviorError(`答题行为观察包含未授权字段：${unexpected.join("、")}。`);
  if (
    raw.schema_version !== "web-response-observation.v1" ||
    !TIMING_SOURCES.has(raw.timing_source) ||
    !TIMING_QUALITIES.has(raw.timing_quality) ||
    (raw.timing_source === "live" && !["clean", "interrupted"].includes(raw.timing_quality)) ||
    (raw.timing_source === "restored" && raw.timing_quality !== "resumed") ||
    (raw.timing_source === "unavailable" && raw.timing_quality !== "unavailable")
  ) {
    throw behaviorError("答题行为观察版本或计时来源无效。");
  }
  const duration = raw.duration_seconds;
  const firstChoice = raw.first_choice_seconds;
  const changes = raw.answer_changes;
  const confidenceSource = raw.confidence_source ?? "default";
  if (
    !(duration === null || (Number.isFinite(duration) && duration >= 0 && duration <= 1_800)) ||
    !(firstChoice === null || (Number.isFinite(firstChoice) && firstChoice >= 0 && firstChoice <= 1_800)) ||
    !Number.isSafeInteger(changes) ||
    changes < 0 ||
    changes > 20 ||
    !CONFIDENCE_SOURCES.has(confidenceSource) ||
    (duration !== null && firstChoice !== null && firstChoice > duration)
  ) {
    throw behaviorError("答题行为观察的用时或改选次数无效。");
  }
  return Object.freeze({
    schema_version: "web-response-observation.v1",
    timing_source: raw.timing_source,
    timing_quality: raw.timing_quality,
    duration_seconds: duration === null ? null : roundedSeconds(duration),
    first_choice_seconds: firstChoice === null ? null : roundedSeconds(firstChoice),
    answer_changes: changes,
    confidence_source: confidenceSource,
    expected_reading_seconds: estimate.expected_seconds,
    expected_duration_seconds: estimate.expected_seconds,
    base_expected_duration_seconds: estimate.base_expected_seconds,
    question_load: estimate.question_load,
    baseline_source: estimate.baseline_source,
    baseline_sample_count: estimate.baseline_sample_count,
  });
}

function timingBand(observation) {
  if (
    observation.timing_source !== "live" ||
    observation.timing_quality !== "clean" ||
    observation.duration_seconds === null ||
    observation.first_choice_seconds === null
  ) return "unknown";

  const expected = observation.expected_duration_seconds;
  const duration = observation.duration_seconds;
  const firstChoice = observation.first_choice_seconds;
  const ratio = duration / expected;
  if (ratio < FAST_RATIO) return "fast";
  if (ratio > EXTENDED_RATIO) return "extended";
  if (firstChoice < expected * EARLY_CHOICE_RATIO) return "early_choice";
  if (ratio > DELIBERATE_RATIO) return "deliberate";
  return "steady";
}

function paceBucket(observation) {
  if (
    observation.timing_source !== "live" ||
    observation.timing_quality !== "clean" ||
    observation.duration_seconds === null
  ) return "unavailable";
  // Keep the durable pace evidence anchored to the immutable question-load
  // estimate. Using the already-personalized expectation here would feed the
  // learner baseline back into itself and make repeated replays drift.
  const ratio = observation.duration_seconds / observation.base_expected_duration_seconds;
  if (ratio < 0.45) return "very_fast";
  if (ratio < 0.7) return "fast";
  if (ratio <= 1.6) return "expected";
  if (ratio <= 2.4) return "deliberate";
  return "extended";
}

export function calibrateResponseConfidence({
  question,
  observation,
  declaredConfidence = "unsure",
  personalBaseline = null,
} = {}) {
  if (!CONFIDENCE.has(declaredConfidence)) throw behaviorError("作答把握度模式无效。");
  const normalized = normalizeResponseObservation(observation, { question, personalBaseline });
  const band = timingBand(normalized);
  const inferred = declaredConfidence === "auto";
  const effectiveConfidence = inferred && band === "steady"
    && normalized.timing_source === "live"
    && normalized.timing_quality === "clean"
    && normalized.answer_changes === 0
    ? "sure"
    : (inferred ? "unsure" : declaredConfidence);
  return Object.freeze({
    observation: inferred
      ? Object.freeze({ ...normalized, confidence_source: "inferred" })
      : normalized,
    timing_band: band,
    pace_bucket: paceBucket(normalized),
    declared_confidence: declaredConfidence,
    effective_confidence: effectiveConfidence,
  });
}

function signalSummary(signal, calibration) {
  const duration = calibration.observation.duration_seconds;
  const changes = calibration.observation.answer_changes;
  const expected = calibration.observation.expected_duration_seconds;
  const reference = calibration.observation.baseline_source === "personal" ? "个人历史基线" : "题干与选项负荷";
  const evidence = duration === null
    ? ""
    : `（按${reference}预计约 ${expected} 秒；前台有效用时 ${duration} 秒${changes ? `，改选 ${changes} 次` : "，未反复改选"}）`;
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.FLUENT) return `答题节奏呈熟练倾向${evidence}。`;
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.HESITANT) {
    if (calibration.observation.confidence_source === "explicit" && calibration.declared_confidence === "unsure") {
      return `你明确标记了“不确定”${evidence}，本题按较保守的证据处理。`;
    }
    if (calibration.timing_band === "extended") {
      return `这题用时明显超出参考区间${evidence}，说明当前提取还不够顺畅；已安排复测。`;
    }
    if (calibration.timing_band === "deliberate") {
      return `这题用时高于参考区间${evidence}；慢读不等于答错，但本次还不作为稳定掌握证据。`;
    }
    return `答题节奏显示有些犹豫${evidence}，本题按较保守的证据处理。`;
  }
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS) {
    if (calibration.observation.confidence_source === "explicit") {
      return `你明确标记了“我在猜”${evidence}，即使答对也仍需复测。`;
    }
    return calibration.timing_band === "early_choice"
      ? `很早就完成首次选择且结果错误${evidence}；后来等待不会改变这条证据，后续会换题复测。`
      : `这次很快作答且结果错误${evidence}，更像猜测；后续会换题复测。`;
  }
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.OVERCONFIDENT_WRONG) return `先前标记为确定但结果错误${evidence}；这更像熟悉感误判，已进入优先复测。`;
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT) {
    if (calibration.timing_band === "early_choice") {
      return `很早就完成首次选择${evidence}，即使后来等待到正常总用时，也暂不能排除猜测；本题安排复测。`;
    }
    return calibration.timing_band === "fast"
      ? `这题答得很快${evidence}，但单题无法区分熟练与猜中；暂不根据用时下结论。`
      : "这题没有完整、连续的前台计时，不根据用时推断熟练度。";
  }
  return `答题节奏正常${evidence}；单题不足以判断已经熟练。`;
}

export function assessResponseBehavior({
  question,
  observation,
  declaredConfidence = "unsure",
  correct,
  personalBaseline = null,
} = {}) {
  if (typeof correct !== "boolean") throw behaviorError("必须先有可信判分才能完成行为判断。");
  const calibration = calibrateResponseConfidence({ question, observation, declaredConfidence, personalBaseline });
  let signal = RESPONSE_BEHAVIOR_SIGNALS.STEADY;
  let reasonCode = "steady_single_observation";
  const confidenceIsExplicit = calibration.observation.confidence_source === "explicit";
  if (declaredConfidence === "guess" && confidenceIsExplicit) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS;
    reasonCode = "explicit_guess";
  } else if (!correct && declaredConfidence === "sure" && confidenceIsExplicit) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.OVERCONFIDENT_WRONG;
    reasonCode = "confident_wrong";
  } else if (declaredConfidence === "unsure" && confidenceIsExplicit) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.HESITANT;
    reasonCode = "explicit_unsure";
  } else if (calibration.timing_band === "unknown") {
    signal = RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT;
    reasonCode = "timing_unavailable";
  } else if (calibration.observation.answer_changes >= 1) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.HESITANT;
    reasonCode = "revision_heavy";
  } else if (calibration.timing_band === "early_choice") {
    signal = correct
      ? RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT
      : RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS;
    reasonCode = correct ? "early_choice_ambiguous" : "early_choice_wrong_guess_risk";
  } else if (calibration.timing_band === "fast") {
    signal = correct
      ? RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT
      : RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS;
    reasonCode = correct ? "fast_correct_ambiguous" : "fast_wrong_guess_risk";
  } else if (calibration.timing_band === "extended") {
    signal = RESPONSE_BEHAVIOR_SIGNALS.HESITANT;
    reasonCode = "extended_duration";
  } else if (calibration.timing_band === "deliberate") {
    signal = RESPONSE_BEHAVIOR_SIGNALS.HESITANT;
    reasonCode = "deliberate_duration";
  } else if (
    correct &&
    calibration.effective_confidence === "sure" &&
    (confidenceIsExplicit || declaredConfidence === "auto") &&
    calibration.observation.answer_changes === 0
  ) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.FLUENT;
    reasonCode = declaredConfidence === "auto" ? "clean_inferred_correct" : "clean_confident_correct";
  }

  if (!PACE_BUCKETS.has(calibration.pace_bucket)) throw behaviorError("作答节奏分桶无效。");
  return Object.freeze({
    schema_version: "web-response-behavior.v1",
    confidence_mode: declaredConfidence === "auto" ? "inferred" : "declared",
    signal,
    reason_code: reasonCode,
    timing_band: calibration.timing_band,
    pace_bucket: calibration.pace_bucket,
    timing_source: calibration.observation.timing_source,
    timing_quality: calibration.observation.timing_quality,
    confidence_source: calibration.observation.confidence_source,
    ...(declaredConfidence === "auto" ? {} : { declared_confidence: declaredConfidence }),
    effective_confidence: calibration.effective_confidence,
    duration_seconds: calibration.observation.duration_seconds,
    first_choice_seconds: calibration.observation.first_choice_seconds,
    answer_changes: calibration.observation.answer_changes,
    expected_reading_seconds: calibration.observation.expected_reading_seconds,
    expected_duration_seconds: calibration.observation.expected_duration_seconds,
    base_expected_duration_seconds: calibration.observation.base_expected_duration_seconds,
    question_load: calibration.observation.question_load,
    baseline_source: calibration.observation.baseline_source,
    summary: signalSummary(signal, calibration),
  });
}

function canonicalLabels(value) {
  return [...new Set(String(value || "").toUpperCase().match(/[A-H]/gu) || [])].sort().join("");
}

function isAdditionOnly(previous, current) {
  if (!previous || !current || previous === current) return false;
  const prior = new Set(previous);
  const next = new Set(current);
  return next.size > prior.size && [...prior].every((label) => next.has(label));
}

export function createResponseTimer({ now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  if (typeof now !== "function") throw new TypeError("response_timer_clock_required");
  let record = null;

  function readNow() {
    const value = Number(now());
    if (!Number.isFinite(value) || value < 0) throw behaviorError("答题计时器时钟无效。");
    return value;
  }

  function activeMilliseconds(at = readNow()) {
    if (!record) return 0;
    if (record.activeSince === null) return record.activeMilliseconds;
    const delta = at - record.activeSince;
    if (delta < 0 || delta > MAX_CONTINUOUS_ACTIVE_MILLISECONDS) {
      record.interrupted = true;
      return record.activeMilliseconds;
    }
    return record.activeMilliseconds + delta;
  }

  return Object.freeze({
    start({ itemId, revision, restored = false, visible = true } = {}) {
      if (typeof itemId !== "string" || !itemId || !Number.isSafeInteger(revision) || revision < 0) {
        throw behaviorError("题目计时标识无效。");
      }
      const key = `${itemId}:${revision}`;
      if (record?.key === key) return false;
      const at = readNow();
      record = {
        key,
        activeMilliseconds: 0,
        activeSince: visible ? at : null,
        firstChoiceMilliseconds: null,
        answerChanges: 0,
        lastAnswer: "",
        restored: restored === true,
        interrupted: false,
      };
      return true;
    },
    setVisible(visible) {
      if (!record) return;
      const at = readNow();
      if (!visible && record.activeSince !== null) {
        record.activeMilliseconds = activeMilliseconds(at);
        record.activeSince = null;
        record.interrupted = true;
      } else if (visible && record.activeSince === null) {
        record.activeSince = at;
      }
    },
    recordAnswer(value) {
      if (!record) return;
      const at = readNow();
      const answer = canonicalLabels(value);
      if (!answer) return;
      if (answer && record.firstChoiceMilliseconds === null) {
        record.firstChoiceMilliseconds = activeMilliseconds(at);
      }
      if (record.lastAnswer && answer !== record.lastAnswer && !isAdditionOnly(record.lastAnswer, answer)) {
        record.answerChanges = Math.min(20, record.answerChanges + 1);
      }
      record.lastAnswer = answer;
    },
    snapshot() {
      if (!record) return null;
      const duration = roundedSeconds(Math.min(1_800, activeMilliseconds() / 1_000));
      return Object.freeze({
        schema_version: "web-response-observation.v1",
        timing_source: record.restored ? "restored" : "live",
        timing_quality: record.restored ? "resumed" : (record.interrupted ? "interrupted" : "clean"),
        duration_seconds: duration,
        first_choice_seconds: record.firstChoiceMilliseconds === null
          ? null
          : roundedSeconds(record.firstChoiceMilliseconds / 1_000),
        answer_changes: record.answerChanges,
      });
    },
    currentKey() {
      return record?.key || null;
    },
    clear() {
      record = null;
    },
  });
}
