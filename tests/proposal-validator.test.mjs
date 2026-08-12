import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeProgressWrites,
  validateTeachingOutput,
} from "../service/proposal-validator.mjs";
import { validateEmployeeOutput } from "../service/schema-validator.mjs";

function validOutput({ action = "diagnose", scope = "general", events = [] } = {}) {
  return {
    teaching_result: {
      schema_version: "architect-pass-coach-teaching-result.v1",
      action,
      status: "completed",
      scope,
      summary: "已完成",
      score_goal: { pass_line: 45, safety_target: 52 },
      answer_visibility: ["status", "today"].includes(action) ? "not_applicable" : "hidden",
      state_write_performed: false,
      assessments: [],
      learning_items: [],
      feedback: [],
      recommendations: [],
      source_refs: [],
    },
    proposed_progress_events: events,
  };
}

test("anonymous output must stay general and event-free", () => {
  const valid = validOutput();
  assert.equal(
    validateTeachingOutput(valid, {
      action: "diagnose",
      context: { authenticated: false },
    }).proposed_progress_events.length,
    0,
  );
  const invalid = validOutput({ action: "diagnose", scope: "personalized" });
  assert.throws(
    () => validateTeachingOutput(invalid, {
      action: "diagnose",
      context: { authenticated: false },
    }),
    (error) => error.code === "ANONYMOUS_SCOPE_VIOLATION",
  );
});

test("agent cannot add identity or claim a state write", () => {
  const identity = validOutput();
  identity.proposed_progress_events = [{
    schema_version: "progress-event-proposal.v1",
    event_type: "practice_result",
    subject: "comprehensive",
    topic_id: "K01",
    result: "mastered",
    evidence: { item_id: "q1", summary: "ok" },
    proposal_only: true,
    requires_authenticated_context: true,
    user_id: "forged",
  }];
  assert.throws(
    () => validateTeachingOutput(identity, {
      action: "diagnose",
      context: { authenticated: true, user_id: "local:test" },
    }),
    /未授权字段 user_id/,
  );

  const claimed = validOutput();
  claimed.teaching_result.state_write_performed = true;
  assert.throws(
    () => validateTeachingOutput(claimed, {
      action: "diagnose",
      context: { authenticated: false },
    }),
    (error) => error.code === "AGENT_CLAIMED_STATE_WRITE",
  );
});

test("trusted authorization must exactly match a proposal", () => {
  const event = {
    event_type: "practice_result",
    subject: "comprehensive",
    topic_id: "K01",
    result: "mastered",
    evidence: { item_id: "q1" },
  };
  const context = { authenticated: true, user_id: "local:test" };
  assert.throws(
    () => authorizeProgressWrites([event], [{
      principal_id: "local:test",
      event_type: "practice_result",
      subject: "comprehensive",
      topic_id: "K01",
      item_id: "different-question",
      expected_result: "mastered",
      command: "record",
      payload: {},
    }], context),
    (error) => error.code === "PROPOSAL_EVIDENCE_MISMATCH",
  );
});

test("answers cannot be revealed before a submit action", () => {
  const output = validOutput({ action: "practice", scope: "personalized" });
  output.teaching_result.answer_visibility = "revealed_after_submission";
  output.teaching_result.feedback = [{
    item_id: "q1",
    result: "mastered",
    explanation: "泄露的答案",
    source_refs: [],
  }];
  assert.throws(
    () => validateTeachingOutput(output, {
      action: "practice",
      context: { authenticated: true, user_id: "local:test" },
    }),
    (error) => error.code === "ANSWER_GATE_VIOLATION",
  );
});

test("hidden output cannot smuggle an answer through summary or recommendations", () => {
  const summaryLeak = validOutput({ action: "practice", scope: "personalized" });
  summaryLeak.teaching_result.summary = "正确答案是 B，解析稍后补充。";
  assert.throws(
    () => validateTeachingOutput(summaryLeak, {
      action: "practice",
      context: { authenticated: true, user_id: "local:test" },
    }),
    (error) => error.code === "ANSWER_GATE_VIOLATION",
  );

  const recommendationLeak = validOutput({ action: "review", scope: "personalized" });
  recommendationLeak.teaching_result.recommendations = [{
    subject: "comprehensive",
    topic_id: "K01",
    priority: 1,
    reason: "答案：A",
  }];
  assert.throws(
    () => validateTeachingOutput(recommendationLeak, {
      action: "review",
      context: { authenticated: true, user_id: "local:test" },
    }),
    (error) => error.code === "ANSWER_GATE_VIOLATION",
  );
});

test("schema-compliant case result is accepted by the outer proposal validator", async () => {
  const event = {
    schema_version: "progress-event-proposal.v1",
    event_type: "case_result",
    subject: "case",
    topic_id: "C01.CASE_ATAM",
    result: "needs_retest",
    evidence: { item_id: "case-atam-001", summary: "权衡证据仍不完整" },
    proposal_only: true,
    requires_authenticated_context: true,
  };
  const output = validOutput({ action: "case", scope: "personalized", events: [event] });
  await validateEmployeeOutput(output);
  const validated = validateTeachingOutput(output, {
    action: "case",
    context: { authenticated: true, user_id: "local:test" },
  });
  assert.deepEqual(validated.proposed_progress_events, [event]);
});
