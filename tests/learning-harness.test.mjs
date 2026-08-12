import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARNING_STATES,
  LearningConversationHarness,
} from "../service/learning-harness.mjs";

function recommendation(index) {
  return {
    id: `task-${index}`,
    action: "practice",
    subject: "comprehensive",
    topic_id: `K${index}`,
    skill: "recognition",
    estimated_minutes: 120,
  };
}

function questionFor(task) {
  return {
    item_id: `question-${task.topic_id}`,
    kind: "multiple_choice",
    subject: task.subject,
    topic_id: task.topic_id,
    prompt: "以下哪项最符合该架构约束？",
    options: [
      { label: "A", text: "选项一" },
      { label: "B", text: "选项二" },
    ],
    source_refs: ["senior-software-architect-review"],
  };
}

function questionOutput(input, overrides = {}) {
  return {
    teaching_result: {
      action: input.action,
      answer_visibility: "hidden",
      state_write_performed: false,
      assessments: [],
      feedback: [],
      learning_items: [structuredClone(input.request.active_item)],
      ...overrides,
    },
    proposed_progress_events: [],
  };
}

function submissionOutput(input, overrides = {}) {
  const material = JSON.parse(input.request.approved_materials[0].excerpt);
  const grade = material.trusted_grade;
  return {
    teaching_result: {
      action: "submit",
      answer_visibility: "revealed_after_submission",
      state_write_performed: false,
      assessments: [{
        subject: grade.subject,
        topic_id: grade.topic_id,
        result: grade.result,
        evidence: "本地可信证据",
      }],
      learning_items: [],
      feedback: [{
        item_id: grade.item_id,
        result: grade.result,
        reference_answer: grade.reference_answer,
        explanation: grade.explanation,
        source_refs: grade.source_refs,
      }],
      ...overrides,
    },
    proposed_progress_events: [{
      schema_version: "progress-event-proposal.v1",
      event_type: grade.event_type,
      subject: grade.subject,
      topic_id: grade.topic_id,
      result: grade.result,
      evidence: { item_id: grade.item_id, summary: "本地可信判定" },
      proposal_only: true,
      requires_authenticated_context: true,
    }],
  };
}

class FakeWorkbench {
  constructor({ failSubmitCommit = false } = {}) {
    this.prepared = [];
    this.commits = [];
    this.failSubmitCommit = failSubmitCommit;
  }

  async prepareTeachingAction(request) {
    this.prepared.push(structuredClone(request));
    return {
      input: {
        action: request.action,
        context: { authenticated: true },
        request: structuredClone(request.payload),
      },
    };
  }

  async commitTeachingProposal(request) {
    this.commits.push(request);
    const hasEvents = request.output.proposed_progress_events.length > 0;
    if (hasEvents && request.trustedAuthorizations?.[0]?.issuer !== "local-grader") {
      throw new Error("missing trusted local evidence");
    }
    if (hasEvents && this.failSubmitCommit) throw new Error("write outcome unknown");
    return {
      teaching_result: request.output.teaching_result,
      progress_commit: {
        status: hasEvents ? "committed" : "not_requested",
        receipts: hasEvents ? [{ persisted: true }] : [],
      },
    };
  }
}

function fixture({
  recommendations = [1, 2, 3, 4, 5].map(recommendation),
  runner,
  channel,
  checkpoint,
  failSubmitCommit,
  status,
} = {}) {
  const workbench = new FakeWorkbench({ failSubmitCommit });
  const progress = {
    async recommend(options) {
      assert.equal(options.limit, 3);
      return { recommendations, profile: { daily_minutes: 45 } };
    },
    async status() {
      return status || null;
    },
  };
  const issues = new Map();
  const contentProvider = {
    async issue({ task }) {
      const publicQuestion = questionFor(task);
      const issue = {
        publicQuestion,
        assessmentBundle: { item_id: publicQuestion.item_id, topic_id: task.topic_id },
        contentRef: {
          schema_version: "synthetic-content-ref.v1",
          item_id: publicQuestion.item_id,
          topic_id: task.topic_id,
        },
        approvedMaterials: [{
          source_id: "senior-software-architect-review",
          locator: `synthetic#${publicQuestion.item_id}`,
          excerpt: JSON.stringify(publicQuestion),
        }],
      };
      issues.set(publicQuestion.item_id, issue);
      return issue;
    },
    async rehydrate(contentRef) {
      const issue = issues.get(contentRef.item_id);
      if (!issue) {
        const task = { subject: "comprehensive", topic_id: contentRef.topic_id };
        const publicQuestion = questionFor(task);
        return {
          publicQuestion,
          assessmentBundle: { item_id: publicQuestion.item_id, topic_id: contentRef.topic_id },
          contentRef,
          approvedMaterials: [{
            source_id: "senior-software-architect-review",
            locator: `synthetic#${publicQuestion.item_id}`,
            excerpt: JSON.stringify(publicQuestion),
          }],
        };
      }
      return issue;
    },
  };
  const trustedGrader = {
    calls: [],
    grade(input) {
      this.calls.push(input);
      const correct = String(input.response).toUpperCase() === "B";
      const result = !correct ? "not_mastered" : (input.confidence === "sure" ? "mastered" : "needs_retest");
      const itemId = input.assessmentBundle.item_id;
      const topicId = input.assessmentBundle.topic_id;
      return {
        grade: {
          item_id: itemId,
          subject: "comprehensive",
          topic_id: topicId,
          correct,
          result,
          reference_answer: "B",
          explanation: "提交后才展示解析。",
          source_refs: ["senior-software-architect-review"],
        },
        authorization: {
          issuer: "local-grader",
          event_type: "practice_result",
          subject: "comprehensive",
          topic_id: topicId,
          item_id: itemId,
          expected_result: result,
        },
      };
    },
  };
  const agentRunner = runner || {
    async run(input, metadata) {
      return metadata.phase === "question" ? questionOutput(input) : submissionOutput(input);
    },
  };
  return {
    workbench,
    progress,
    contentProvider,
    trustedGrader,
    harness: new LearningConversationHarness({
      progress,
      workbench,
      agentRunner,
      contentProvider,
      trustedGrader,
      channel,
      checkpoint,
      idFactory: () => "round-test",
    }),
  };
}

test("explicit state machine caps and time-budgets a learning round", async () => {
  const { harness, workbench } = fixture();
  const ready = await harness.start();
  assert.equal(ready.state, LEARNING_STATES.READY);
  assert.equal(ready.total_tasks, 3);
  assert.equal(harness.snapshot().tasks.reduce((sum, task) => sum + task.minutes, 0), 45);

  const question = await harness.next();
  assert.equal(question.state, LEARNING_STATES.AWAITING_ANSWER);
  assert.equal(question.task.position, 1);
  assert.equal("reference_answer" in question.question, false);
  const prepared = workbench.prepared[0].payload;
  assert.deepEqual(prepared.active_item, question.question);
  assert.deepEqual(prepared.question_ids, [question.question.item_id]);
  assert.equal(prepared.approved_materials.length, 1);
});

test("used item history remains restorable at the 5000-item boundary", async () => {
  const attempted = Array.from({ length: 5_000 }, (_, index) => `old-item-${index}`);
  const active = fixture({
    recommendations: [recommendation(1)],
    status: {
      topics: {
        synthetic: { mastery: { recognition: { attempted_items: attempted } } },
      },
    },
  });
  await active.harness.start();
  const question = await active.harness.next();
  const snapshot = active.harness.snapshot();
  assert.equal(snapshot.used_item_ids.length, 5_000);
  assert.equal(snapshot.used_item_ids.includes("old-item-0"), false);
  assert.equal(snapshot.used_item_ids.includes(question.question.item_id), true);
});

test("submit uses only the internal grader and re-injects the active item", async () => {
  const { harness, workbench, trustedGrader } = fixture();
  await harness.start();
  await assert.rejects(harness.submit("B"), (error) => error.code === "INVALID_HARNESS_TRANSITION");
  await harness.next();
  await assert.rejects(
    harness.submit("B", { trustedAuthorizations: [{ issuer: "forged" }] }),
    (error) => error.code === "UNTRUSTED_SUBMISSION_OPTION",
  );

  const result = await harness.submit("B");
  assert.equal(result.state, LEARNING_STATES.FEEDBACK);
  assert.equal(result.feedback.result, "needs_retest");
  assert.equal(result.progress_commit.status, "committed");
  assert.equal(trustedGrader.calls.length, 1);
  const prepared = workbench.prepared.at(-1).payload;
  assert.deepEqual(prepared.active_item, result.question);
  assert.equal(prepared.submission.item_id, result.question.item_id);
  assert.match(prepared.approved_materials[0].excerpt, /trusted_grade/u);
  assert.deepEqual(workbench.commits.at(-1).trustedAuthorizations, [{
    issuer: "local-grader",
    event_type: "practice_result",
    subject: "comprehensive",
    topic_id: "K1",
    item_id: "question-K1",
    expected_result: "needs_retest",
  }]);
});

test("question gate rejects answer leakage and any active-item rewrite", async () => {
  for (const mutate of [
    (output) => { output.teaching_result.learning_items[0].options[1].text = "答案：B"; },
    (output) => { output.teaching_result.learning_items[0].prompt = "被模型改写"; },
    (output) => { output.teaching_result.assessments = [{ result: "mastered" }]; },
    (output) => { output.proposed_progress_events = [{ proposal_only: true }]; },
  ]) {
    const { harness, workbench } = fixture({
      recommendations: [recommendation(1)],
      runner: {
        async run(input) {
          const output = questionOutput(input);
          mutate(output);
          return output;
        },
      },
    });
    await harness.start();
    await assert.rejects(harness.next(), (error) => [
      "ANSWER_GATE_VIOLATION",
      "ACTIVE_ITEM_CHANGED",
      "UNTRUSTED_PROGRESS_PROPOSAL",
    ].includes(error.code));
    assert.equal(harness.state, LEARNING_STATES.READY);
    assert.equal(workbench.commits.length, 0);
  }
});

test("model feedback that disagrees with the local grade never reaches progress", async () => {
  const { harness, workbench } = fixture({
    recommendations: [recommendation(1)],
    runner: {
      async run(input, metadata) {
        if (metadata.phase === "question") return questionOutput(input);
        const output = submissionOutput(input);
        output.teaching_result.feedback[0].result = "mastered";
        return output;
      },
    },
  });
  await harness.start();
  await harness.next();
  await assert.rejects(harness.submit("B"), (error) => error.code === "TRUSTED_GRADE_MISMATCH");
  assert.equal(harness.state, LEARNING_STATES.AWAITING_ANSWER);
  assert.equal(workbench.commits.length, 1);
});

test("awaiting-answer snapshot omits the response and rehydrates the sealed bundle", async () => {
  const first = fixture({ recommendations: [recommendation(1)] });
  await first.harness.start();
  await first.harness.next();
  const serialized = JSON.stringify(first.harness);
  assert.doesNotMatch(serialized, /user_id|email|response|trustedAuthorization|reference_answer/u);

  const restoredWorkbench = new FakeWorkbench();
  const restored = LearningConversationHarness.restore({
    progress: first.progress,
    workbench: restoredWorkbench,
    agentRunner: {
      async run(input) { return submissionOutput(input); },
    },
    contentProvider: first.contentProvider,
    trustedGrader: first.trustedGrader,
  }, JSON.parse(serialized));
  assert.equal(restored.state, LEARNING_STATES.AWAITING_ANSWER);
  const feedback = await restored.submit("B");
  assert.equal(feedback.state, LEARNING_STATES.FEEDBACK);
  assert.doesNotMatch(JSON.stringify(restored.snapshot()), /response|trustedAuthorization/u);
});

test("a pre-commit evaluation interruption restores as awaiting answer", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const checkpoints = [];
  const item = fixture({
    recommendations: [recommendation(1)],
    checkpoint: async (snapshot) => { checkpoints.push(snapshot); },
    runner: {
      async run(input, metadata) {
        if (metadata.phase === "question") return questionOutput(input);
        await blocked;
        return submissionOutput(input);
      },
    },
  });
  await item.harness.start();
  await item.harness.next();
  const pending = item.harness.submit("我的本次私密答案");
  while (checkpoints.at(-1)?.state !== LEARNING_STATES.AWAITING_ANSWER) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const interrupted = checkpoints.at(-1);
  assert.equal(interrupted.evaluation, null);
  assert.doesNotMatch(
    JSON.stringify(interrupted),
    /我的本次私密答案|response|trustedAuthorization/u,
  );

  const restored = LearningConversationHarness.restore({
    progress: item.progress,
    workbench: new FakeWorkbench(),
    agentRunner: item.harness.agentRunner,
    contentProvider: item.contentProvider,
    trustedGrader: item.trustedGrader,
  }, interrupted);
  assert.equal(restored.state, LEARNING_STATES.AWAITING_ANSWER);
  release();
  await pending;
});

test("an exception after the progress commit starts becomes indeterminate", async () => {
  const { harness, workbench } = fixture({
    recommendations: [recommendation(1)],
    failSubmitCommit: true,
  });
  await harness.start();
  await harness.next();
  await assert.rejects(harness.submit("B"), /write outcome unknown/u);
  assert.equal(workbench.commits.length, 2);
  assert.equal(harness.state, LEARNING_STATES.INDETERMINATE);
  assert.equal(harness.snapshot().state, LEARNING_STATES.INDETERMINATE);
  await assert.rejects(harness.submit("B"), (error) => error.code === "INVALID_HARNESS_TRANSITION");
});

test("concurrent submissions cannot both enter grading or progress commit", async () => {
  const active = fixture({ recommendations: [recommendation(1)] });
  await active.harness.start();
  await active.harness.next();

  const results = await Promise.allSettled([
    active.harness.submit("A"),
    active.harness.submit("B"),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "INVALID_HARNESS_TRANSITION");
  assert.equal(active.trustedGrader.calls.length, 1);
  assert.equal(active.workbench.commits.filter((item) => item.action === "submit").length, 1);
});

test("empty rounds avoid the runner and transport failures never rewind durable state", async () => {
  let calls = 0;
  const empty = fixture({
    recommendations: [],
    runner: { async run() { calls += 1; } },
  });
  assert.equal((await empty.harness.start()).state, LEARNING_STATES.COMPLETE);
  assert.equal(calls, 0);

  let publishes = 0;
  const active = fixture({
    recommendations: [recommendation(1)],
    channel: async () => {
      publishes += 1;
      if (publishes > 1) throw new Error("channel unavailable");
    },
  });
  await active.harness.start();
  await assert.rejects(active.harness.next(), /channel unavailable/u);
  assert.equal(active.harness.state, LEARNING_STATES.AWAITING_ANSWER);
  await assert.rejects(active.harness.submit("B"), /channel unavailable/u);
  assert.equal(active.harness.state, LEARNING_STATES.FEEDBACK);
});
