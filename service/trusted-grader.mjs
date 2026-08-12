import { createHash } from "node:crypto";

import { evaluateSealedObjectiveAssessment, REVIEW_SOURCE_REF } from "./content-provider.mjs";
import { CoachError } from "./errors.mjs";

const LOCAL_PRINCIPAL = /^local:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONFIDENCE = new Set(["guess", "unsure", "sure"]);
const MODE_BY_EVENT_TYPE = Object.freeze({
  diagnostic_result: "diagnostic",
  practice_result: "practice",
  retest_result: "review",
});
const sealedProgressAuthorizations = new WeakMap();

function gradingError(code, message) {
  return new CoachError(code, message);
}

function nonEmptyText(value, label, maximum = 512) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw gradingError("INVALID_TRUSTED_GRADING_INPUT", `${label} 必须是非空字符串。`);
  }
  return value.trim();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sealProgressAuthorization(value) {
  const capability = deepFreeze(value);
  sealedProgressAuthorizations.set(capability, capability);
  return capability;
}

export function consumeTrustedObjectiveAuthorization(capability) {
  const authorization = sealedProgressAuthorizations.get(capability);
  if (!authorization) {
    throw gradingError(
      "UNTRUSTED_PROGRESS_AUTHORIZATION",
      "进度授权不是本进程 Trusted Objective Grader 签发的 capability。",
    );
  }
  return authorization;
}

function deterministicAttemptId(principalId, itemId, attemptKey) {
  const digest = createHash("sha256")
    .update(principalId, "utf8")
    .update("\0")
    .update(itemId, "utf8")
    .update("\0")
    .update(attemptKey, "utf8")
    .digest("hex");
  return `objective:${digest}`;
}

function answerText(labels) {
  return labels.join("、");
}

/**
 * Deterministic local grader. It never accepts model assessments or progress
 * proposals as grading inputs; the Workbench separately matches this locally
 * issued capability against any model proposal before writing progress.
 */
export class TrustedObjectiveGrader {
  constructor({ principalId } = {}) {
    if (typeof principalId !== "string" || !LOCAL_PRINCIPAL.test(principalId)) {
      throw gradingError(
        "LOCAL_PRINCIPAL_REQUIRED",
        "Trusted Grader 只能绑定 setup 创建的本地用户身份。",
      );
    }
    this.principalId = principalId;
    Object.freeze(this);
  }

  grade({
    assessmentBundle,
    response,
    attemptKey,
    confidence = "unsure",
    durationSeconds,
  } = {}) {
    const safeAttemptKey = nonEmptyText(attemptKey, "attemptKey");
    if (!CONFIDENCE.has(confidence)) {
      throw gradingError("INVALID_TRUSTED_GRADING_INPUT", "confidence 无效。 ");
    }
    if (
      durationSeconds !== undefined &&
      (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1)
    ) {
      throw gradingError("INVALID_TRUSTED_GRADING_INPUT", "durationSeconds 必须是正整数。 ");
    }
    const evaluated = evaluateSealedObjectiveAssessment(assessmentBundle, response);
    const result = !evaluated.correct
      ? "not_mastered"
      : (confidence === "sure" ? "mastered" : "needs_retest");
    const score = evaluated.correct ? 1 : 0;
    const attemptId = deterministicAttemptId(
      this.principalId,
      evaluated.itemId,
      safeAttemptKey,
    );
    const payload = {
      topic_id: evaluated.topicId,
      item_id: evaluated.itemId,
      subject: evaluated.subject,
      skill: evaluated.skill,
      score,
      max_score: 1,
      attempt_id: attemptId,
      mode: MODE_BY_EVENT_TYPE[evaluated.eventType],
      confidence,
      source_type: evaluated.sourceType,
      source: `${REVIEW_SOURCE_REF}:${evaluated.sourceLocator}`,
      wrong_reasons: [],
      ...(evaluated.facet ? { facet: evaluated.facet } : {}),
      ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
    };
    return deepFreeze({
      grade: {
        schema_version: "trusted-objective-grade.v1",
        item_id: evaluated.itemId,
        subject: evaluated.subject,
        topic_id: evaluated.topicId,
        selected_answer: answerText(evaluated.selectedLabels),
        reference_answer: answerText(evaluated.correctLabels),
        correct: evaluated.correct,
        result,
        score,
        max_score: 1,
        explanation: evaluated.explanation,
        source_refs: [REVIEW_SOURCE_REF],
      },
      authorization: sealProgressAuthorization({
        principal_id: this.principalId,
        event_type: evaluated.eventType,
        subject: evaluated.subject,
        topic_id: evaluated.topicId,
        item_id: evaluated.itemId,
        expected_result: result,
        command: "record",
        payload,
      }),
    });
  }
}
