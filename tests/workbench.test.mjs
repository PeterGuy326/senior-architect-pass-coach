import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalCoachWorkbench } from "../service/workbench.mjs";

function recommendation(index) {
  return {
    topic_id: `K${index}`,
    name: `考点 ${index}`,
    subject: "comprehensive",
    skill: "recognition",
    priority_score: 10 - index,
    mastery: 0,
    review_due: false,
    estimated_minutes: 10,
    reason: "确定性推荐",
    resources: [`private/path/${index}`],
  };
}

class FakeEngine {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.setupCalls = [];
    this.recordCalls = [];
  }

  async setup(options) {
    this.setupCalls.push(options);
    return { exitCode: 0 };
  }

  async status() {
    return {
      schema_version: 1,
      profile: { background: "不得注入", exam_date: "2026-11-07" },
      subjects: {
        comprehensive: { status: "unmeasured", evidence_level: "cold_start" },
        case: { status: "unmeasured", evidence_level: "cold_start" },
        essay: { status: "unmeasured", evidence_level: "cold_start" },
      },
      topics: {},
    };
  }

  async recommend() {
    return {
      target_subject: "comprehensive",
      maintenance_subject: null,
      crunch_mode: false,
      days_to_exam: 89,
      recommendations: [1, 2, 3, 4, 5].map(recommendation),
      profile: { daily_minutes: 45 },
    };
  }

  async record(payload) {
    this.recordCalls.push(payload);
    return { exitCode: 0 };
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-coach-workbench-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new FakeEngine(directory);
  return { directory, engine, workbench: new LocalCoachWorkbench({ engine }) };
}

test("personal status is rejected before local setup", async (t) => {
  const { workbench } = await fixture(t);
  await assert.rejects(
    workbench.status(),
    (error) => error.code === "AUTHENTICATION_REQUIRED",
  );
});

test("setup creates local authorization and today is capped at three", async (t) => {
  const { workbench, engine } = await fixture(t);
  await workbench.setup({ dailyMinutes: 40 });
  const today = await workbench.today();
  assert.equal(engine.setupCalls.length, 1);
  assert.equal(today.recommendations.length, 3);
});

test("personal employee input contains a deidentified snapshot only", async (t) => {
  const { workbench } = await fixture(t);
  await workbench.setup();
  const prepared = await workbench.prepareTeachingAction({
    action: "today",
    payload: { time_budget_minutes: 30 },
  });
  assert.equal(prepared.input.schema_version, "architect-pass-coach-input.v1");
  assert.deepEqual(prepared.input.context, { authenticated: true });
  assert.equal(prepared.input.request.progress_snapshot.recommendations.length, 3);
  const serialized = JSON.stringify(prepared.input.request.progress_snapshot);
  assert.doesNotMatch(serialized, /不得注入|private\/path|background|resources|local:[0-9a-f-]{36}/);
});

test("anonymous preparation only permits a general diagnosis", async (t) => {
  const { workbench } = await fixture(t);
  const prepared = await workbench.prepareTeachingAction({
    action: "diagnose",
    payload: { message: "我该从哪里开始？" },
  });
  assert.deepEqual(prepared.input.context, { authenticated: false });
  assert.equal(prepared.input.request.diagnosis_scope, "general");
  assert.equal("progress_snapshot" in prepared.input.request, false);
  await assert.rejects(
    workbench.prepareTeachingAction({ action: "today" }),
    (error) => error.code === "AUTHENTICATION_REQUIRED",
  );
});

test("a forged caller context cannot authorize a progress commit", async (t) => {
  const { workbench } = await fixture(t);
  await assert.rejects(
    workbench.commitTeachingProposal({
      output: validOutput({ action: "practice", scope: "personalized" }),
      action: "practice",
      context: { authenticated: true, user_id: "local:forged" },
      trustedAuthorizations: [],
    }),
    (error) => error.code === "AUTHENTICATION_REQUIRED",
  );
});

test("anonymous general diagnosis can be validated without a progress write", async (t) => {
  const { workbench } = await fixture(t);
  const result = await workbench.commitTeachingProposal({
    output: validOutput({ action: "diagnose", scope: "general" }),
    action: "diagnose",
  });
  assert.equal(result.progress_commit.status, "not_requested");
  assert.deepEqual(result.progress_commit.receipts, []);
});

test("a validated proposal writes only the trusted local payload", async (t) => {
  const { workbench, engine } = await fixture(t);
  await workbench.setup();
  const context = await workbench.context({ required: true });
  const output = validOutput({
    action: "submit",
    scope: "personalized",
    answerVisibility: "revealed_after_submission",
    feedback: [{
      item_id: "q-001",
      result: "not_mastered",
      explanation: "该题仍需复测",
      source_refs: [],
    }],
    events: [{
      schema_version: "progress-event-proposal.v1",
      event_type: "practice_result",
      subject: "comprehensive",
      topic_id: "K01",
      result: "not_mastered",
      evidence: { item_id: "q-001", summary: "该题仍需复测" },
      proposal_only: true,
      requires_authenticated_context: true,
    }],
  });
  const trustedPayload = {
    topic_id: "K01",
    skill: "recognition",
    score: 0,
    max_score: 1,
    attempt_id: "attempt-local-001",
    item_id: "q-001",
  };
  const result = await workbench.commitTeachingProposal({
    output,
    action: "submit",
    trustedAuthorizations: [{
      principal_id: context.user_id,
      event_type: "practice_result",
      subject: "comprehensive",
      topic_id: "K01",
      item_id: "q-001",
      expected_result: "not_mastered",
      command: "record",
      payload: trustedPayload,
    }],
  });
  assert.equal(result.progress_commit.status, "committed");
  assert.deepEqual(engine.recordCalls, [trustedPayload]);
});

function validOutput({
  action = "diagnose",
  scope = "general",
  events = [],
  answerVisibility = action === "submit"
    ? "revealed_after_submission"
    : (["status", "today"].includes(action) ? "not_applicable" : "hidden"),
  feedback = [],
} = {}) {
  return {
    teaching_result: {
      schema_version: "architect-pass-coach-teaching-result.v1",
      action,
      status: "completed",
      scope,
      summary: "已完成",
      score_goal: { pass_line: 45, safety_target: 52 },
      answer_visibility: answerVisibility,
      state_write_performed: false,
      assessments: [],
      learning_items: [],
      feedback,
      recommendations: [],
      source_refs: [],
    },
    proposed_progress_events: events,
  };
}

export { validOutput };
