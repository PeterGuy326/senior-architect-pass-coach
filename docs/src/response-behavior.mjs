export const RESPONSE_BEHAVIOR_SIGNALS = Object.freeze({
  FLUENT: "fluent",
  HESITANT: "hesitant",
  LIKELY_GUESS: "likely_guess",
  OVERCONFIDENT_WRONG: "overconfident_wrong",
  INSUFFICIENT: "insufficient_signal",
  STEADY: "steady",
});

const CONFIDENCE = new Set(["guess", "unsure", "sure"]);
const CONFIDENCE_SOURCES = new Set(["default", "explicit"]);
const TIMING_SOURCES = new Set(["live", "restored", "unavailable"]);
const TIMING_QUALITIES = new Set(["clean", "interrupted", "resumed", "unavailable"]);
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

function questionText(question) {
  const prompt = typeof question?.prompt === "string" ? question.prompt : "";
  const options = Array.isArray(question?.options)
    ? question.options.map((option) => (
        typeof option === "string" ? option : String(option?.text ?? option?.content ?? "")
      ))
    : [];
  return [prompt, ...options].join(" ");
}

export function estimateQuestionReadingSeconds(question) {
  const textLength = Array.from(questionText(question).replace(/\s+/gu, "")).length;
  const optionCount = Array.isArray(question?.options) ? question.options.length : 0;
  return roundedSeconds(clamp(8 + (textLength * 0.07) + Math.max(0, optionCount - 2) * 0.75, 12, 45));
}

export function normalizeResponseObservation(raw, { question } = {}) {
  const expectedReadingSeconds = estimateQuestionReadingSeconds(question);
  if (raw === null || raw === undefined) {
    return Object.freeze({
      schema_version: "web-response-observation.v1",
      timing_source: "unavailable",
      timing_quality: "unavailable",
      duration_seconds: null,
      first_choice_seconds: null,
      answer_changes: 0,
      confidence_source: "default",
      expected_reading_seconds: expectedReadingSeconds,
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
    expected_reading_seconds: expectedReadingSeconds,
  });
}

function timingBand(observation) {
  if (
    observation.timing_source !== "live" ||
    observation.timing_quality !== "clean" ||
    observation.duration_seconds === null ||
    observation.first_choice_seconds === null
  ) return "unknown";

  const expected = observation.expected_reading_seconds;
  const duration = observation.duration_seconds;
  const firstChoice = observation.first_choice_seconds;
  const changes = observation.answer_changes;
  if (
    changes >= 2 ||
    duration > expected * 2 ||
    firstChoice > expected * 1.8 ||
    (changes >= 1 && duration > expected * 1.3)
  ) return "hesitant";
  if (
    duration < expected * 0.5 ||
    (firstChoice < expected * 0.25 && duration < expected * 0.65)
  ) return "fast";
  return "steady";
}

export function calibrateResponseConfidence({ question, observation, declaredConfidence = "unsure" } = {}) {
  if (!CONFIDENCE.has(declaredConfidence)) throw behaviorError("自报把握度无效。");
  const normalized = normalizeResponseObservation(observation, { question });
  const band = timingBand(normalized);
  return Object.freeze({
    observation: normalized,
    timing_band: band,
    declared_confidence: declaredConfidence,
    effective_confidence: declaredConfidence,
  });
}

function signalSummary(signal, calibration) {
  const duration = calibration.observation.duration_seconds;
  const changes = calibration.observation.answer_changes;
  const evidence = duration === null
    ? ""
    : `（前台有效用时 ${duration} 秒${changes ? `，改选 ${changes} 次` : "，未反复改选"}）`;
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.FLUENT) return `答题节奏呈熟练倾向${evidence}。`;
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.HESITANT) {
    return calibration.observation.confidence_source === "explicit" && calibration.declared_confidence === "unsure"
      ? `你明确标记了“不确定”${evidence}，本题按较保守的证据处理。`
      : `答题节奏显示有些犹豫${evidence}，本题按较保守的证据处理。`;
  }
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS) {
    return calibration.observation.confidence_source === "explicit"
      ? `你明确标记了“我在猜”${evidence}，即使答对也仍需复测。`
      : `这次很快作答且结果错误${evidence}，更像猜测；后续会换题复测。`;
  }
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.OVERCONFIDENT_WRONG) return `自报确定但结果错误${evidence}；这更像熟悉感误判，已进入优先复测。`;
  if (signal === RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT) {
    return calibration.timing_band === "fast"
      ? `这题答得很快${evidence}，但单题无法区分熟练与猜中；暂不根据用时下结论。`
      : "这题没有完整、连续的前台计时，不根据用时推断熟练度。";
  }
  return `答题节奏正常${evidence}；单题不足以判断已经熟练。`;
}

export function assessResponseBehavior({ question, observation, declaredConfidence = "unsure", correct } = {}) {
  if (typeof correct !== "boolean") throw behaviorError("必须先有可信判分才能完成行为判断。");
  const calibration = calibrateResponseConfidence({ question, observation, declaredConfidence });
  let signal = RESPONSE_BEHAVIOR_SIGNALS.STEADY;
  const confidenceIsExplicit = calibration.observation.confidence_source === "explicit";
  if (declaredConfidence === "guess" && confidenceIsExplicit) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS;
  } else if (!correct && declaredConfidence === "sure" && confidenceIsExplicit) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.OVERCONFIDENT_WRONG;
  } else if (declaredConfidence === "unsure" && confidenceIsExplicit) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.HESITANT;
  } else if (calibration.timing_band === "unknown") {
    signal = RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT;
  } else if (calibration.timing_band === "hesitant") {
    signal = RESPONSE_BEHAVIOR_SIGNALS.HESITANT;
  } else if (calibration.timing_band === "fast") {
    signal = correct
      ? RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT
      : RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS;
  } else if (
    correct &&
    declaredConfidence === "sure" &&
    confidenceIsExplicit &&
    calibration.observation.answer_changes === 0
  ) {
    signal = RESPONSE_BEHAVIOR_SIGNALS.FLUENT;
  }

  return Object.freeze({
    schema_version: "web-response-behavior.v1",
    signal,
    timing_band: calibration.timing_band,
    timing_source: calibration.observation.timing_source,
    timing_quality: calibration.observation.timing_quality,
    confidence_source: calibration.observation.confidence_source,
    declared_confidence: declaredConfidence,
    effective_confidence: calibration.effective_confidence,
    duration_seconds: calibration.observation.duration_seconds,
    first_choice_seconds: calibration.observation.first_choice_seconds,
    answer_changes: calibration.observation.answer_changes,
    expected_reading_seconds: calibration.observation.expected_reading_seconds,
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
