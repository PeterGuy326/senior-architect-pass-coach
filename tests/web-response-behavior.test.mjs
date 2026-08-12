import assert from "node:assert/strict";
import test from "node:test";

import {
  RESPONSE_BEHAVIOR_SIGNALS,
  assessResponseBehavior,
  calibrateResponseConfidence,
  createResponseTimer,
  estimateQuestionDuration,
  estimateQuestionReadingSeconds,
  normalizeResponseObservation,
} from "../docs/src/response-behavior.mjs";
import { objectiveResult } from "../docs/src/progress-rules.mjs";

const QUESTION = Object.freeze({
  prompt: "某系统需要根据业务变化选择合适的软件过程模型，以下哪一项最符合题意？",
  options: Object.freeze([
    Object.freeze({ label: "A", text: "瀑布模型" }),
    Object.freeze({ label: "B", text: "原型模型" }),
    Object.freeze({ label: "C", text: "螺旋模型" }),
    Object.freeze({ label: "D", text: "喷泉模型" }),
  ]),
});

function live({ duration, first = duration / 2, changes = 0, quality = "clean", confidenceSource = "explicit" }) {
  return {
    schema_version: "web-response-observation.v1",
    timing_source: "live",
    timing_quality: quality,
    duration_seconds: duration,
    first_choice_seconds: first,
    answer_changes: changes,
    confidence_source: confidenceSource,
  };
}

test("response timing is normalized by bounded question reading load", () => {
  const short = estimateQuestionReadingSeconds({ prompt: "选择正确项", options: ["甲", "乙"] });
  const current = estimateQuestionReadingSeconds(QUESTION);
  const long = estimateQuestionReadingSeconds({ prompt: "长".repeat(2_000), options: ["甲", "乙", "丙", "丁"] });
  assert.equal(short, 12);
  assert.ok(current >= short);
  assert.equal(long, 90);

  const shortOptions = estimateQuestionReadingSeconds({
    prompt: "以下哪项正确？",
    options: ["甲", "乙", "丙", "丁"],
  });
  const longOptions = estimateQuestionReadingSeconds({
    prompt: "以下哪项正确？",
    options: ["甲".repeat(80), "乙".repeat(80), "丙".repeat(80), "丁".repeat(80)],
  });
  const logicHeavy = estimateQuestionReadingSeconds({
    prompt: "如果 A=1 且 B=2，以下哪项不正确？",
    options: ["A→B", "B→A", "A=B", "A≠B"],
  });
  assert.ok(longOptions > shortOptions);
  assert.ok(logicHeavy > shortOptions);
});

test("personal timing needs twelve bounded observations and only adjusts the question-normalized expectation", () => {
  const question = {
    prompt: "某业务系统需要在一致性、可用性、恢复时间和实现成本之间权衡，请选择最符合约束的架构战术。".repeat(2),
    options: ["方案甲".repeat(12), "方案乙".repeat(12), "方案丙".repeat(12), "方案丁".repeat(12)],
  };
  const population = estimateQuestionDuration(question);
  const insufficient = estimateQuestionDuration(question, {
    personalBaseline: {
      schema_version: "web-response-baseline.v1",
      eligible_count: 11,
      pace_bucket_counts: { very_fast: 0, fast: 11, expected: 0, deliberate: 0, extended: 0 },
    },
  });
  const established = estimateQuestionDuration(question, {
    personalBaseline: {
      schema_version: "web-response-baseline.v1",
      eligible_count: 12,
      pace_bucket_counts: { very_fast: 0, fast: 12, expected: 0, deliberate: 0, extended: 0 },
    },
  });
  assert.equal(insufficient.baseline_source, "population");
  assert.equal(insufficient.expected_seconds, population.expected_seconds);
  assert.equal(established.baseline_source, "personal");
  assert.ok(established.expected_seconds < population.expected_seconds);
  assert.equal(established.base_expected_seconds, population.base_expected_seconds);
});

test("a short-question pace converges only after twelve matching personal observations", () => {
  const question = { prompt: "选择正确项", options: ["甲", "乙"] };
  const elevenFast = {
    schema_version: "web-response-baseline.v1",
    eligible_count: 11,
    pace_bucket_counts: { very_fast: 0, fast: 11, expected: 0, deliberate: 0, extended: 0 },
  };
  const twelveFast = {
    ...elevenFast,
    eligible_count: 12,
    pace_bucket_counts: { ...elevenFast.pace_bucket_counts, fast: 12 },
  };
  const observation = live({ duration: 6.4, first: 2.5, changes: 0 });
  const before = assessResponseBehavior({
    question,
    observation,
    declaredConfidence: "sure",
    correct: true,
    personalBaseline: elevenFast,
  });
  const established = assessResponseBehavior({
    question,
    observation,
    declaredConfidence: "sure",
    correct: true,
    personalBaseline: twelveFast,
  });

  assert.equal(before.signal, RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT);
  assert.equal(before.baseline_source, "population");
  assert.equal(established.signal, RESPONSE_BEHAVIOR_SIGNALS.FLUENT);
  assert.equal(established.baseline_source, "personal");
  assert.equal(established.pace_bucket, "fast");
  assert.ok(established.expected_duration_seconds < before.expected_duration_seconds);

  const inferredBefore = assessResponseBehavior({
    question,
    observation: { ...observation, confidence_source: "inferred" },
    declaredConfidence: "auto",
    correct: true,
    personalBaseline: elevenFast,
  });
  const inferredEstablished = assessResponseBehavior({
    question,
    observation: { ...observation, confidence_source: "inferred" },
    declaredConfidence: "auto",
    correct: true,
    personalBaseline: twelveFast,
  });
  assert.equal(inferredBefore.signal, RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT);
  assert.equal(inferredBefore.effective_confidence, "unsure");
  assert.equal(inferredEstablished.signal, RESPONSE_BEHAVIOR_SIGNALS.FLUENT);
  assert.equal(inferredEstablished.effective_confidence, "sure");
  assert.equal(inferredEstablished.reason_code, "clean_inferred_correct");

  for (const variant of [
    { correct: false, confidence: "sure", expected: RESPONSE_BEHAVIOR_SIGNALS.OVERCONFIDENT_WRONG },
    { correct: true, confidence: "guess", expected: RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS },
    { correct: true, confidence: "unsure", expected: RESPONSE_BEHAVIOR_SIGNALS.HESITANT },
  ]) {
    assert.equal(assessResponseBehavior({
      question,
      observation,
      declaredConfidence: variant.confidence,
      correct: variant.correct,
      personalBaseline: twelveFast,
    }).signal, variant.expected);
  }
  assert.notEqual(assessResponseBehavior({
    question,
    observation: { ...observation, timing_quality: "interrupted" },
    declaredConfidence: "sure",
    correct: true,
    personalBaseline: twelveFast,
  }).signal, RESPONSE_BEHAVIOR_SIGNALS.FLUENT);
  assert.notEqual(assessResponseBehavior({
    question,
    observation: live({ duration: 2, first: 1, changes: 0 }),
    declaredConfidence: "sure",
    correct: true,
    personalBaseline: twelveFast,
  }).signal, RESPONSE_BEHAVIOR_SIGNALS.FLUENT);
});

test("only a correct explicit sure answer with a clean steady rhythm is fluent", () => {
  const expected = estimateQuestionReadingSeconds(QUESTION);
  const behavior = assessResponseBehavior({
    question: QUESTION,
    observation: live({ duration: expected, first: expected * 0.7 }),
    declaredConfidence: "sure",
    correct: true,
  });
  assert.equal(behavior.signal, RESPONSE_BEHAVIOR_SIGNALS.FLUENT);
  assert.equal(behavior.effective_confidence, "sure");
  assert.equal(objectiveResult({ correct: true, confidence: behavior.effective_confidence }), "mastered");
  assert.match(behavior.summary, /熟练倾向/u);
});

test("automatic evidence infers confidence conservatively from timing quality and reconsideration", () => {
  const expected = estimateQuestionReadingSeconds(QUESTION);
  const assess = ({ duration, first, changes = 0, quality = "clean", source = "live", correct = true }) =>
    assessResponseBehavior({
      question: QUESTION,
      observation: {
        ...live({ duration, first, changes, quality, confidenceSource: "inferred" }),
        timing_source: source,
        timing_quality: source === "restored" ? "resumed" : quality,
      },
      declaredConfidence: "auto",
      correct,
    });

  const fluent = assess({ duration: expected, first: expected * 0.6 });
  assert.equal(fluent.signal, RESPONSE_BEHAVIOR_SIGNALS.FLUENT);
  assert.equal(fluent.reason_code, "clean_inferred_correct");
  assert.equal(fluent.confidence_source, "inferred");
  assert.equal(fluent.confidence_mode, "inferred");
  assert.equal(Object.hasOwn(fluent, "declared_confidence"), false);
  assert.equal(fluent.effective_confidence, "sure");
  assert.equal(objectiveResult({ correct: true, confidence: fluent.effective_confidence }), "mastered");

  const fast = assess({ duration: expected * 0.49, first: expected * 0.2 });
  assert.equal(fast.signal, RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT);
  assert.equal(fast.effective_confidence, "unsure");
  assert.equal(objectiveResult({ correct: true, confidence: fast.effective_confidence }), "needs_retest");

  const revised = assess({ duration: expected, first: expected * 0.5, changes: 2 });
  assert.equal(revised.signal, RESPONSE_BEHAVIOR_SIGNALS.HESITANT);
  assert.equal(revised.effective_confidence, "unsure");

  const deliberate = assess({ duration: expected * 2, first: expected * 1.85 });
  assert.equal(deliberate.signal, RESPONSE_BEHAVIOR_SIGNALS.HESITANT);
  assert.equal(deliberate.effective_confidence, "unsure");
  assert.equal(objectiveResult({ correct: true, confidence: deliberate.effective_confidence }), "needs_retest");

  const restored = assess({
    duration: expected,
    first: expected * 0.5,
    source: "restored",
  });
  assert.equal(restored.signal, RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT);
  assert.equal(restored.effective_confidence, "unsure");

  const fastWrong = assess({
    duration: expected * 0.49,
    first: expected * 0.2,
    correct: false,
  });
  assert.equal(fastWrong.signal, RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS);
  assert.equal(fastWrong.effective_confidence, "unsure");
  assert.equal(objectiveResult({ correct: false, confidence: fastWrong.effective_confidence }), "not_mastered");
});

test("hesitation changes the review signal without rewriting trusted objective confidence", () => {
  const expected = estimateQuestionReadingSeconds(QUESTION);
  const slowSure = assessResponseBehavior({
    question: QUESTION,
    observation: live({ duration: expected * 2 + 0.1, first: expected, changes: 2 }),
    declaredConfidence: "sure",
    correct: true,
  });
  assert.equal(slowSure.signal, RESPONSE_BEHAVIOR_SIGNALS.HESITANT);
  assert.equal(slowSure.effective_confidence, "sure");
  assert.equal(objectiveResult({ correct: true, confidence: slowSure.effective_confidence }), "mastered");

  const fastUnsure = assessResponseBehavior({
    question: QUESTION,
    observation: live({ duration: expected * 0.49, first: expected * 0.2 }),
    declaredConfidence: "unsure",
    correct: true,
  });
  assert.equal(fastUnsure.effective_confidence, "unsure");
  assert.notEqual(fastUnsure.signal, RESPONSE_BEHAVIOR_SIGNALS.FLUENT);
  assert.equal(objectiveResult({ correct: true, confidence: fastUnsure.effective_confidence }), "needs_retest");
});

test("slow reading and revision both trigger conservative retest evidence", () => {
  const expected = estimateQuestionReadingSeconds(QUESTION);
  const deliberate = assessResponseBehavior({
    question: QUESTION,
    observation: live({ duration: expected * 2.1, first: expected * 1.9, changes: 0 }),
    declaredConfidence: "sure",
    correct: true,
  });
  assert.equal(deliberate.signal, RESPONSE_BEHAVIOR_SIGNALS.HESITANT);
  assert.equal(deliberate.reason_code, "deliberate_duration");
  assert.match(deliberate.summary, /不作为稳定掌握证据/u);

  const revised = assessResponseBehavior({
    question: QUESTION,
    observation: live({ duration: expected, first: expected * 0.5, changes: 2 }),
    declaredConfidence: "sure",
    correct: true,
  });
  assert.equal(revised.signal, RESPONSE_BEHAVIOR_SIGNALS.HESITANT);
  assert.equal(revised.reason_code, "revision_heavy");
});

test("total active duration is primary and timing boundaries fail conservatively", () => {
  const expected = estimateQuestionReadingSeconds(QUESTION);
  const auto = ({ duration, first, changes = 0, correct = true }) => assessResponseBehavior({
    question: QUESTION,
    observation: live({ duration, first, changes, confidenceSource: "inferred" }),
    declaredConfidence: "auto",
    correct,
  });

  const justFast = auto({ duration: (expected * 0.55) - 0.1, first: expected * 0.3 });
  const justSteady = auto({ duration: (expected * 0.55) + 0.1, first: expected * 0.3 });
  assert.equal(justFast.timing_band, "fast");
  assert.equal(justFast.effective_confidence, "unsure");
  assert.equal(justSteady.timing_band, "steady");
  assert.equal(justSteady.effective_confidence, "sure");

  const steadyUpper = auto({ duration: (expected * 1.6) - 0.1, first: expected * 0.4 });
  const deliberate = auto({ duration: (expected * 1.6) + 0.1, first: expected * 0.4 });
  const deliberateUpper = auto({ duration: expected * 2.4, first: expected * 0.4 });
  const extended = auto({ duration: (expected * 2.4) + 0.1, first: expected * 0.4 });
  assert.equal(steadyUpper.timing_band, "steady");
  assert.equal(deliberate.timing_band, "deliberate");
  assert.equal(deliberate.effective_confidence, "unsure");
  assert.equal(deliberateUpper.timing_band, "deliberate");
  assert.equal(extended.timing_band, "extended");
  assert.equal(extended.effective_confidence, "unsure");

  const waitedAfterInstantChoice = auto({ duration: expected, first: expected * 0.1 });
  assert.equal(waitedAfterInstantChoice.timing_band, "early_choice");
  assert.equal(waitedAfterInstantChoice.reason_code, "early_choice_ambiguous");
  assert.equal(waitedAfterInstantChoice.effective_confidence, "unsure");

  const revisedOnce = auto({ duration: expected, first: expected * 0.5, changes: 1 });
  assert.equal(revisedOnce.timing_band, "steady");
  assert.equal(revisedOnce.signal, RESPONSE_BEHAVIOR_SIGNALS.HESITANT);
  assert.equal(revisedOnce.effective_confidence, "unsure");
});

test("guess, overconfidence, rapid correctness and restored timing remain distinct", () => {
  const expected = estimateQuestionReadingSeconds(QUESTION);
  const rapid = live({ duration: expected * 0.49, first: expected * 0.2 });
  assert.equal(assessResponseBehavior({
    question: QUESTION,
    observation: rapid,
    declaredConfidence: "guess",
    correct: true,
  }).signal, RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS);
  assert.equal(assessResponseBehavior({
    question: QUESTION,
    observation: rapid,
    declaredConfidence: "sure",
    correct: false,
  }).signal, RESPONSE_BEHAVIOR_SIGNALS.OVERCONFIDENT_WRONG);
  assert.equal(assessResponseBehavior({
    question: QUESTION,
    observation: rapid,
    declaredConfidence: "sure",
    correct: true,
  }).signal, RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT);

  const restored = assessResponseBehavior({
    question: QUESTION,
    observation: {
      ...rapid,
      timing_source: "restored",
      timing_quality: "resumed",
    },
    declaredConfidence: "sure",
    correct: true,
  });
  assert.equal(restored.signal, RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT);
  assert.equal(restored.effective_confidence, "sure");
});

test("an untouched confidence default is not misreported as an explicit hesitation", () => {
  const expected = estimateQuestionReadingSeconds(QUESTION);
  const fastWrong = assessResponseBehavior({
    question: QUESTION,
    observation: live({
      duration: expected * 0.49,
      first: expected * 0.2,
      confidenceSource: "default",
    }),
    declaredConfidence: "unsure",
    correct: false,
  });
  assert.equal(fastWrong.signal, RESPONSE_BEHAVIOR_SIGNALS.LIKELY_GUESS);
  assert.equal(fastWrong.confidence_source, "default");
  assert.match(fastWrong.summary, /更像猜测/u);

  const explicitUnsure = assessResponseBehavior({
    question: QUESTION,
    observation: live({ duration: expected, confidenceSource: "explicit" }),
    declaredConfidence: "unsure",
    correct: true,
  });
  assert.equal(explicitUnsure.signal, RESPONSE_BEHAVIOR_SIGNALS.HESITANT);
  assert.match(explicitUnsure.summary, /明确标记/u);
});

test("the active timer excludes background time and counts reconsideration, not multi-select construction", () => {
  let milliseconds = 0;
  const timer = createResponseTimer({ now: () => milliseconds });
  assert.equal(timer.start({ itemId: "item-1", revision: 2, visible: true }), true);
  assert.equal(timer.start({ itemId: "item-1", revision: 2, visible: true }), false);
  milliseconds = 5_000;
  timer.recordAnswer("A");
  milliseconds = 5_500;
  timer.recordAnswer("AC");
  milliseconds = 6_000;
  timer.setVisible(false);
  milliseconds = 66_000;
  timer.setVisible(true);
  milliseconds = 71_000;
  timer.recordAnswer("CA");
  timer.recordAnswer("");
  timer.recordAnswer("A");
  assert.deepEqual(timer.snapshot(), {
    schema_version: "web-response-observation.v1",
    timing_source: "live",
    timing_quality: "interrupted",
    duration_seconds: 11,
    first_choice_seconds: 5,
    answer_changes: 1,
  });
});

test("behavior envelopes reject raw traces, invalid clocks and impossible timing", () => {
  assert.throws(() => normalizeResponseObservation({
    ...live({ duration: 10, first: 5 }),
    selection_trace: ["A", "B"],
  }, { question: QUESTION }), { code: "INVALID_RESPONSE_BEHAVIOR" });
  assert.throws(() => normalizeResponseObservation(
    live({ duration: 5, first: 6 }),
    { question: QUESTION },
  ), { code: "INVALID_RESPONSE_BEHAVIOR" });
  assert.throws(() => calibrateResponseConfidence({
    question: QUESTION,
    observation: live({ duration: -1, first: 0 }),
    declaredConfidence: "sure",
  }), { code: "INVALID_RESPONSE_BEHAVIOR" });
  const timer = createResponseTimer({ now: () => Number.NaN });
  assert.throws(() => timer.start({ itemId: "item", revision: 0 }), { code: "INVALID_RESPONSE_BEHAVIOR" });
});

test("a long foreground clock jump fails closed instead of looking like hesitation", () => {
  let milliseconds = 1_000;
  const timer = createResponseTimer({ now: () => milliseconds });
  timer.start({ itemId: "sleep-item", revision: 1, visible: true });
  milliseconds += 11 * 60 * 1_000;
  timer.recordAnswer("B");
  const observation = timer.snapshot();
  assert.equal(observation.timing_quality, "interrupted");
  assert.equal(observation.duration_seconds, 0);
  assert.equal(assessResponseBehavior({
    question: QUESTION,
    observation,
    declaredConfidence: "sure",
    correct: true,
  }).signal, RESPONSE_BEHAVIOR_SIGNALS.INSUFFICIENT);
});
