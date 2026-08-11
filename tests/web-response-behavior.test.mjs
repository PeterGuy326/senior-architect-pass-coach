import assert from "node:assert/strict";
import test from "node:test";

import {
  RESPONSE_BEHAVIOR_SIGNALS,
  assessResponseBehavior,
  calibrateResponseConfidence,
  createResponseTimer,
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
  assert.equal(long, 45);
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
