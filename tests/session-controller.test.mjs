import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ContentOnlyCoachRunner } from "../service/content-only-runner.mjs";
import { CoachSessionController } from "../service/session-controller.mjs";
import { ConversationSessionStore } from "../service/session-store.mjs";

function dependencies(root) {
  const metrics = { progressCommits: 0 };
  const question = {
    item_id: "synthetic:item",
    kind: "multiple_choice",
    subject: "comprehensive",
    topic_id: "K08.SYNTHETIC",
    prompt: "合成过程题？",
    options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }],
    source_refs: ["senior-software-architect-review"],
  };
  const issue = {
    publicQuestion: question,
    assessmentBundle: { item_id: question.item_id },
    contentRef: { schema_version: "synthetic-ref.v1", item_id: question.item_id },
    approvedMaterials: [{
      source_id: "senior-software-architect-review",
      locator: "synthetic#1",
      excerpt: JSON.stringify(question),
    }],
  };
  const workbench = {
    async context() {
      return { authenticated: true, user_id: "local:123e4567-e89b-42d3-a456-426614174000" };
    },
    async today() {
      return {
        recommendations: [{
          action: "practice",
          subject: "comprehensive",
          topic_id: "K08.SYNTHETIC",
          skill: "recognition",
          estimated_minutes: 10,
        }],
        profile: { daily_minutes: 45 },
      };
    },
    async prepareTeachingAction({ action, payload }) {
      return { input: { action, context: { authenticated: true }, request: payload } };
    },
    async commitTeachingProposal({ output }) {
      if (output.proposed_progress_events.length > 0) metrics.progressCommits += 1;
      return {
        teaching_result: output.teaching_result,
        progress_commit: {
          status: output.proposed_progress_events.length ? "committed" : "not_requested",
          receipts: [],
        },
      };
    },
  };
  const contentProvider = {
    async issue() { return issue; },
    async rehydrate() { return issue; },
  };
  const trustedGraderFactory = () => ({
    grade({ response, confidence }) {
      const correct = String(response).toUpperCase() === "B";
      const result = !correct
        ? "not_mastered"
        : (confidence === "sure" ? "mastered" : "needs_retest");
      return {
        grade: {
          item_id: question.item_id,
          subject: question.subject,
          topic_id: question.topic_id,
          correct,
          result,
          reference_answer: "B",
          explanation: `合成解析：提交 ${response}。`,
          source_refs: ["senior-software-architect-review"],
        },
        authorization: {
          event_type: "practice_result",
          subject: question.subject,
          topic_id: question.topic_id,
          item_id: question.item_id,
          expected_result: result,
        },
      };
    },
  });
  return {
    store: new ConversationSessionStore({ dataDirectory: root }),
    workbench,
    runner: new ContentOnlyCoachRunner(),
    contentProvider,
    trustedGraderFactory,
    metrics,
  };
}

test("controller durably starts, resumes and closes one Harness session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  const started = await CoachSessionController.start({ ...deps, idFactory: () => "round-1" });
  assert.equal(started.view().state, "ready");
  assert.equal(started.view().presentation.display_name, "系统架构设计师过线私教");
  await started.next();
  const awaiting = started.view();
  assert.equal(awaiting.state, "awaiting_answer");
  assert.ok(awaiting.revision >= 3);

  const resumed = await CoachSessionController.resume({
    ...deps,
    sessionId: started.sessionId,
  });
  assert.deepEqual(resumed.view().question, awaiting.question);
  await resumed.submit("B", { confidence: "sure" });
  assert.equal(resumed.view().feedback.result, "mastered");
  assert.equal((await resumed.close()).status, "closed");
});

test("unsupported case or essay sessions fail before a document is created", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-subject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  await assert.rejects(
    CoachSessionController.start({ ...deps, subject: "case" }),
    (error) => error.code === "UNSUPPORTED_PHASE1_SUBJECT",
  );
  assert.deepEqual(await deps.store.listActive(), []);
});

test("machine turns reject stale deliveries and replay a completed turn receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  const controller = await CoachSessionController.start({ ...deps, idFactory: () => "round-turn" });
  const started = controller.view();

  await assert.rejects(
    controller.handleMachineTurn({
      turnId: "next-stale",
      expectedRevision: started.revision - 1,
      intent: "next",
    }),
    (error) => error.code === "STALE_SESSION_REVISION",
  );

  const nextRequest = {
    turnId: "next-1",
    expectedRevision: started.revision,
    intent: "next",
  };
  const question = await controller.handleMachineTurn(nextRequest);
  assert.equal(question.state, "awaiting_answer");
  assert.deepEqual(await controller.handleMachineTurn(nextRequest), question);
  await assert.rejects(
    controller.handleMachineTurn({ ...nextRequest, expectedRevision: started.revision + 1 }),
    (error) => error.code === "TURN_ID_CONFLICT",
  );

  const invalidNext = {
    turnId: "next-invalid-state",
    expectedRevision: question.revision,
    intent: "next",
  };
  await assert.rejects(
    controller.handleMachineTurn(invalidNext),
    (error) => error.code === "INVALID_HARNESS_TRANSITION",
  );
  await assert.rejects(
    controller.handleMachineTurn(invalidNext),
    (error) => error.code === "INVALID_HARNESS_TRANSITION",
  );

  await assert.rejects(
    controller.handleMachineTurn({
      turnId: "answer-invalid-label",
      expectedRevision: question.revision,
      expectedItemId: question.question.item_id,
      intent: "answer",
      answer: "Z",
    }),
    (error) => error.code === "INVALID_OBJECTIVE_RESPONSE",
  );

  await assert.rejects(
    controller.handleMachineTurn({
      turnId: "answer-wrong-item",
      expectedRevision: question.revision,
      expectedItemId: "synthetic:old-item",
      intent: "answer",
      answer: "B",
    }),
    (error) => error.code === "STALE_ACTIVE_ITEM",
  );

  const answerRequest = {
    turnId: "answer-1",
    expectedRevision: question.revision,
    expectedItemId: question.question.item_id,
    intent: "answer",
    answer: "B",
    confidence: "sure",
  };
  const feedback = await controller.handleMachineTurn(answerRequest);
  assert.equal(feedback.state, "feedback");
  assert.deepEqual(await controller.handleMachineTurn(answerRequest), feedback);
  assert.equal(deps.metrics.progressCommits, 1);

  const advanceRequest = {
    turnId: "advance-1",
    expectedRevision: feedback.revision,
    expectedItemId: question.question.item_id,
    intent: "advance",
  };
  const completed = await controller.handleMachineTurn(advanceRequest);
  assert.equal(completed.state, "complete");
  assert.deepEqual(await controller.handleMachineTurn(advanceRequest), completed);

  await assert.rejects(
    controller.handleMachineTurn({
      turnId: "delayed-answer",
      expectedRevision: completed.revision,
      expectedItemId: question.question.item_id,
      intent: "answer",
      answer: "A",
    }),
    (error) => error.code === "STALE_ACTIVE_ITEM",
  );
  const stored = await deps.store.load(controller.sessionId);
  assert.equal(stored.state.turn_receipts.length, 3);
  assert.ok(stored.state.turn_receipts.every((item) => item.status === "completed"));
  assert.ok(stored.state.turn_receipts.every((item) => /^sha256:[a-f0-9]{64}$/u.test(item.request_digest)));
});

test("delivery failure after a durable turn returns the completed machine receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  const controller = await CoachSessionController.start({
    ...deps,
    idFactory: () => "round-recovery",
    channel: async (message) => {
      if (message.type === "question") throw new Error("synthetic delivery failure");
    },
  });
  const request = {
    turnId: "next-recover-1",
    expectedRevision: controller.view().revision,
    intent: "next",
  };

  const recovered = await controller.handleMachineTurn(request);
  assert.equal(recovered.state, "awaiting_answer");
  const completed = await deps.store.load(controller.sessionId);
  assert.equal(completed.state.turn_receipts[0].status, "completed");
});

test("a machine close receipt remains idempotent after the session is closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  const controller = await CoachSessionController.start({ ...deps, idFactory: () => "round-close" });
  const request = {
    turnId: "close-1",
    expectedRevision: controller.view().revision,
    intent: "close",
  };
  const closed = await controller.handleMachineTurn(request);
  assert.equal(closed.status, "closed");

  const resumed = await CoachSessionController.resume({
    ...deps,
    sessionId: controller.sessionId,
    allowClosed: true,
  });
  assert.deepEqual(await resumed.handleMachineTurn(request), closed);
});

test("a running machine answer excludes every human mutation and keeps its own receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-cross-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  const delegate = deps.runner;
  let announceSubmission;
  let releaseSubmission;
  const submissionEntered = new Promise((resolve) => { announceSubmission = resolve; });
  const submissionReleased = new Promise((resolve) => { releaseSubmission = resolve; });
  const blockedRunner = {
    mode: delegate.mode,
    async preflight() {
      return delegate.preflight();
    },
    async run(input, metadata) {
      if (input.action === "submit") {
        announceSubmission();
        await submissionReleased;
      }
      return delegate.run(input, metadata);
    },
  };
  const controller = await CoachSessionController.start({
    ...deps,
    runner: blockedRunner,
    idFactory: () => "round-cross-entry",
  });
  await controller.next();
  const awaiting = controller.view();
  const machineRequest = {
    turnId: "machine-answer-a",
    expectedRevision: awaiting.revision,
    expectedItemId: awaiting.question.item_id,
    intent: "answer",
    answer: "A",
    confidence: "sure",
  };
  const pending = controller.handleMachineTurn(machineRequest);
  await submissionEntered;

  const concurrent = await CoachSessionController.resume({
    ...deps,
    runner: blockedRunner,
    sessionId: controller.sessionId,
  });
  for (const mutation of [
    () => concurrent.next(),
    () => concurrent.submit("B", { confidence: "sure" }),
    () => concurrent.advance(),
    () => concurrent.close(),
  ]) {
    await assert.rejects(mutation(), (error) => error.code === "TURN_IN_PROGRESS");
  }

  releaseSubmission();
  const completed = await pending;
  assert.equal(completed.feedback.result, "not_mastered");
  assert.match(completed.feedback.explanation, /提交 A/u);
  assert.deepEqual(await controller.handleMachineTurn(machineRequest), completed);
  assert.equal(deps.metrics.progressCommits, 1);
});

test("an indeterminate machine answer is terminalized without repeating its progress effect", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-indeterminate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  const commit = deps.workbench.commitTeachingProposal.bind(deps.workbench);
  deps.workbench.commitTeachingProposal = async (request) => {
    const result = await commit(request);
    if (request.output.proposed_progress_events.length > 0) {
      throw new Error("synthetic crash after progress effect");
    }
    return result;
  };
  const controller = await CoachSessionController.start({
    ...deps,
    idFactory: () => "round-indeterminate",
  });
  await controller.next();
  const awaiting = controller.view();
  const answerRequest = {
    turnId: "answer-indeterminate",
    expectedRevision: awaiting.revision,
    expectedItemId: awaiting.question.item_id,
    intent: "answer",
    answer: "B",
    confidence: "sure",
  };

  let firstError;
  await assert.rejects(
    controller.handleMachineTurn(answerRequest),
    (error) => {
      firstError = { code: error.code, message: error.message };
      return error.code === "TURN_RESULT_INDETERMINATE" && /effect.*未知/u.test(error.message);
    },
  );
  assert.equal(deps.metrics.progressCommits, 1);
  const terminalized = await deps.store.load(controller.sessionId);
  assert.equal(terminalized.state.harness.state, "indeterminate");
  assert.deepEqual(terminalized.state.turn_receipts[0], {
    turn_id: answerRequest.turnId,
    request_digest: terminalized.state.turn_receipts[0].request_digest,
    status: "failed",
    result: null,
    error: firstError,
  });

  await assert.rejects(
    controller.handleMachineTurn(answerRequest),
    (error) => error.code === firstError.code && error.message === firstError.message,
  );
  assert.equal(deps.metrics.progressCommits, 1);

  const closeRequest = {
    turnId: "close-after-indeterminate",
    expectedRevision: controller.view().revision,
    intent: "close",
  };
  const closed = await controller.handleMachineTurn(closeRequest);
  assert.equal(closed.status, "closed");
  assert.deepEqual(await deps.store.listActive(), []);
});

test("a crash-left running receipt is terminalized on its original turn retry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-indeterminate-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  const controller = await CoachSessionController.start({
    ...deps,
    idFactory: () => "round-indeterminate-recovery",
  });
  await controller.next();
  const awaiting = controller.view();
  const answerRequest = {
    turnId: "answer-crash-recovery",
    expectedRevision: awaiting.revision,
    expectedItemId: awaiting.question.item_id,
    intent: "answer",
    answer: "B",
    confidence: "sure",
  };
  const canonicalRequest = {
    turn_id: answerRequest.turnId,
    expected_revision: answerRequest.expectedRevision,
    expected_item_id: answerRequest.expectedItemId,
    intent: answerRequest.intent,
    answer: answerRequest.answer,
    confidence: answerRequest.confidence,
    duration_seconds: null,
  };
  const requestDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalRequest), "utf8")
    .digest("hex")}`;
  const stored = await deps.store.load(controller.sessionId);
  await deps.store.save(controller.sessionId, {
    expectedRevision: stored.revision,
    state: {
      ...stored.state,
      turn_receipts: [{
        turn_id: answerRequest.turnId,
        request_digest: requestDigest,
        status: "running",
        result: null,
        error: null,
      }],
      harness: {
        ...stored.state.harness,
        state: "indeterminate",
        evaluation: {
          item_id: awaiting.question.item_id,
          attempt_key: `${awaiting.round_id}:1:${awaiting.question.item_id}`,
          phase: "commit_started",
        },
      },
    },
  });

  const recovered = await CoachSessionController.resume({
    ...deps,
    sessionId: controller.sessionId,
  });
  await assert.rejects(
    recovered.handleMachineTurn(answerRequest),
    (error) => error.code === "TURN_RESULT_INDETERMINATE",
  );
  assert.equal(deps.metrics.progressCommits, 0);
  const terminalized = await deps.store.load(controller.sessionId);
  assert.equal(terminalized.state.turn_receipts[0].status, "failed");

  assert.equal((await recovered.close()).status, "closed");
  assert.deepEqual(await deps.store.listActive(), []);
});

test("the owner can close a crash-left indeterminate session without the original turn id", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-controller-indeterminate-owner-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies(root);
  const controller = await CoachSessionController.start({
    ...deps,
    idFactory: () => "round-indeterminate-owner-close",
  });
  await controller.next();
  const awaiting = controller.view();
  const stored = await deps.store.load(controller.sessionId);
  await deps.store.save(controller.sessionId, {
    expectedRevision: stored.revision,
    state: {
      ...stored.state,
      turn_receipts: [{
        turn_id: "lost-answer-turn",
        request_digest: `sha256:${"a".repeat(64)}`,
        status: "running",
        result: null,
        error: null,
      }],
      harness: {
        ...stored.state.harness,
        state: "indeterminate",
        evaluation: {
          item_id: awaiting.question.item_id,
          attempt_key: `${awaiting.round_id}:1:${awaiting.question.item_id}`,
          phase: "commit_started",
        },
      },
    },
  });

  const recovered = await CoachSessionController.resume({
    ...deps,
    sessionId: controller.sessionId,
  });
  assert.equal((await recovered.close()).status, "closed");
  assert.deepEqual(await deps.store.listActive(), []);
  const closed = await deps.store.load(controller.sessionId);
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.state.turn_receipts[0], {
    turn_id: "lost-answer-turn",
    request_digest: `sha256:${"a".repeat(64)}`,
    status: "failed",
    result: null,
    error: {
      code: "TURN_RESULT_INDETERMINATE",
      message: "上次提交的进度 effect 是否发生未知；本 turn 已终结，绝不自动重跑。请核对本地进度后显式关闭会话。",
    },
  });
});
