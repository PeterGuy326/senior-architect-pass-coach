import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyObjectiveAttempt,
  createBlankProgress,
  createLocalProfile,
  objectiveResult,
  planDailyTasks,
  progressSummary,
  subjectStatus,
} from "../docs/src/progress-rules.mjs";
import { createMemoryCoachStore } from "../docs/src/indexeddb-store.mjs";
import { createBrowserCoach } from "../docs/src/harness.mjs";

const curriculumUrl = new URL("../docs/data/curriculum.json", import.meta.url);
const configCurriculumUrl = new URL("../config/curriculum.json", import.meta.url);

function idFactory() {
  let count = 0;
  return () => `fixture-id-${String(++count).padStart(8, "0")}`;
}

function fixtureWorker() {
  const issued = new Map();
  return async (request) => {
    if (request.type === "issue") {
      const itemId = `fixture:${request.payload.task.topic_id}`;
      const contentRef = {
        schema_version: "web-objective-content-ref.v1",
        relative_path: "past-papers/comprehensive-by-year/synthetic.md",
        question_number: 1,
        topic_id: request.payload.task.topic_id,
        subject: "comprehensive",
        item_id: itemId,
        content_revision: "sha256:fixture",
      };
      const publicQuestion = {
        item_id: itemId,
        kind: "multiple_choice",
        subject: "comprehensive",
        topic_id: request.payload.task.topic_id,
        prompt: "以下哪一项符合题意？",
        options: [
          { label: "A", text: "选项甲" },
          { label: "B", text: "选项乙" },
        ],
        source_refs: ["synthetic-test-material"],
      };
      issued.set(itemId, { contentRef, publicQuestion });
      return {
        id: request.id,
        ok: true,
        result: {
          publicQuestion,
          contentRef,
        },
      };
    }
    if (request.type === "rehydrate") {
      const restored = issued.get(request.payload.contentRef.item_id);
      assert.ok(restored);
      assert.deepEqual(restored.contentRef, request.payload.contentRef);
      return { id: request.id, ok: true, result: restored };
    }
    if (request.type === "grade") {
      const contentRef = request.payload.contentRef;
      assert.deepEqual(issued.get(contentRef.item_id).contentRef, contentRef);
      const response = Array.isArray(request.payload.response)
        ? request.payload.response.join("")
        : request.payload.response;
      const correct = response.toUpperCase() === "B";
      return {
        id: request.id,
        ok: true,
        result: {
          grade: {
            schema_version: "web-objective-grade.v1",
            item_id: contentRef.item_id,
            topic_id: contentRef.topic_id,
            subject: "comprehensive",
            selected_answer: response.toUpperCase(),
            reference_answer: "B",
            correct,
            result: objectiveResult({ correct, confidence: request.payload.confidence }),
            score: correct ? 1 : 0,
            max_score: 1,
            explanation: "合成解析，仅用于测试。",
            source_refs: ["synthetic-test-material"],
          },
        },
      };
    }
    throw new Error("unexpected worker request");
  };
}

function attempt({ id, item, score = 1, confidence = "sure", at }) {
  return {
    attempt_id: id,
    item_id: item,
    topic_id: "K08.SOFTWARE_PROCESS_MODELS",
    subject: "comprehensive",
    skill: "recognition",
    score,
    max_score: 1,
    confidence,
    result: objectiveResult({ correct: score === 1, confidence }),
    at,
    source_ref: "synthetic-test-material",
    content_revision: "sha256:fixture",
  };
}

test("deployed curriculum is a mechanical byte-for-byte copy", async () => {
  const [deployed, source] = await Promise.all([
    readFile(curriculumUrl),
    readFile(configCurriculumUrl),
  ]);
  assert.deepEqual(deployed, source);
});

test("45/52 boundaries and all three objective results remain explicit", () => {
  assert.equal(subjectStatus({ lower_bound_score: null }), "unmeasured");
  assert.equal(subjectStatus({ lower_bound_score: 44 }), "danger");
  assert.equal(subjectStatus({ lower_bound_score: 45 }), "near");
  assert.equal(subjectStatus({ lower_bound_score: 51.99 }), "near");
  assert.equal(subjectStatus({ lower_bound_score: 52 }), "safe");
  assert.equal(objectiveResult({ correct: true, confidence: "sure" }), "mastered");
  assert.equal(objectiveResult({ correct: true, confidence: "unsure" }), "needs_retest");
  assert.equal(objectiveResult({ correct: true, confidence: "guess" }), "needs_retest");
  assert.equal(objectiveResult({ correct: false, confidence: "sure" }), "not_mastered");
});

test("daily plan is comprehensive-only, at most three tasks, and within budget", async () => {
  const curriculum = JSON.parse(await readFile(curriculumUrl, "utf8"));
  const profile = createLocalProfile({
    principalId: "local:fixture-00000001",
    dailyMinutes: 23,
    now: "2026-08-10T08:00:00.000Z",
  });
  const tasks = planDailyTasks({
    profile,
    progress: createBlankProgress({ now: "2026-08-10T08:00:00.000Z" }),
    curriculum,
    today: "2026-08-10",
  });
  assert.equal(tasks.length, 2);
  assert.ok(tasks.length <= 3);
  assert.ok(tasks.every((task) => task.subject === "comprehensive" && task.action === "diagnose"));
  assert.ok(tasks.every((task) => task.minutes <= 15));
  assert.ok(tasks.reduce((sum, task) => sum + task.minutes, 0) <= 23);
});

test("recognition requires six qualified items over two days and regresses after a new miss", () => {
  let progress = createBlankProgress({ now: "2026-08-10T08:00:00.000Z" });
  for (let index = 0; index < 6; index += 1) {
    progress = applyObjectiveAttempt(progress, attempt({
      id: `pass-${index}`,
      item: `item-${index}`,
      at: `2026-08-${index < 3 ? "10" : "11"}T0${index}:00:00.000Z`,
    })).progress;
  }
  assert.equal(progress.topics["K08.SOFTWARE_PROCESS_MODELS"].status, "pass_ready");
  progress = applyObjectiveAttempt(progress, attempt({
    id: "regression",
    item: "item-wrong",
    score: 0,
    at: "2026-08-12T08:00:00.000Z",
  })).progress;
  const record = progress.topics["K08.SOFTWARE_PROCESS_MODELS"].mastery.recognition;
  assert.equal(record.status, "fragile");
  assert.equal(record.regression_active, true);
  assert.equal(record.next_review_at, "2026-08-13");
});

test("real browser harness path starts ignorant, issues, grades, and stores no learning content", async () => {
  const curriculum = JSON.parse(await readFile(curriculumUrl, "utf8"));
  const store = createMemoryCoachStore();
  const coach = createBrowserCoach({
    store,
    worker: fixtureWorker(),
    curriculum,
    clock: () => "2026-08-10T08:00:00.000Z",
    idFactory: idFactory(),
  });
  const first = await coach.initialize({ examDate: "2026-11-07", dailyMinutes: 45 });
  assert.equal(first.state, "ready");
  assert.equal(first.knowsProgress, false);
  assert.match(first.message, /不知道.*进度/u);
  assert.equal(first.subjects.case.status, "unmeasured");
  assert.equal(first.subjects.essay.status, "unmeasured");

  const question = await coach.start();
  assert.equal(question.state, "awaiting_answer");
  assert.equal(question.tasks.length, 3);
  assert.equal(question.question.options.length, 2);
  assert.equal(Object.hasOwn(question.question, "answer"), false);

  const feedback = await coach.answer({
    response: "B",
    confidence: "unsure",
    expectedRevision: question.revision,
    expectedItemId: question.question.item_id,
  });
  assert.equal(feedback.state, "feedback");
  assert.equal(feedback.feedback.grade.result, "needs_retest");
  assert.equal(feedback.feedback.grade.reference_answer, "B");
  assert.equal(feedback.knowsProgress, true);

  const exported = await coach.exportData();
  assert.equal(exported.attempts.length, 1);
  assert.equal(exported.progress.subjects.comprehensive.evidence_count, 1);
  const serializedAttempt = JSON.stringify(exported.attempts[0]);
  for (const forbidden of ["response", "prompt", "options", "reference_answer", "explanation", "selected_answer"]) {
    assert.equal(serializedAttempt.includes(forbidden), false, forbidden);
  }
  const serializedSession = JSON.stringify(exported.sessions[0]);
  for (const forbidden of ["prompt", "options", "reference_answer", "explanation", "selected_answer"]) {
    assert.equal(serializedSession.includes(forbidden), false, forbidden);
  }
  coach.close();
});

test("attempt replay is exact, changed time conflicts, and revision CAS admits one publisher", async () => {
  const store = createMemoryCoachStore();
  const now = "2026-08-10T08:00:00.000Z";
  await store.initialize({
    profile: createLocalProfile({ principalId: "local:fixture-00000002", now }),
    progress: createBlankProgress({ now }),
  });
  const session = await store.putSession({
    session_id: "session-cas",
    schema_version: "web-coach-session.v1",
    revision: 0,
    state: "awaiting_answer",
    tasks: [],
    cursor: 0,
    active_item_ref: { item_id: "item-cas", topic_id: "K08.SOFTWARE_PROCESS_MODELS", content_ref: { content_revision: "sha256:fixture" } },
    feedback: null,
    created_at: now,
    updated_at: now,
  });
  const evidence = attempt({ id: "attempt-cas", item: "item-cas", at: now });
  const committed = await store.commitAttempt({
    expectedRevision: session.revision,
    sessionId: session.session_id,
    expectedItemId: "item-cas",
    attempt: evidence,
    feedback: { item_id: "item-cas", result: "mastered", correct: true, source_refs: [] },
  });
  const replayed = await store.commitAttempt({
    expectedRevision: session.revision,
    sessionId: session.session_id,
    expectedItemId: "item-cas",
    attempt: evidence,
    feedback: { item_id: "item-cas", result: "mastered", correct: true, source_refs: [] },
  });
  assert.equal(replayed.replayed, true);
  await assert.rejects(
    store.commitAttempt({
      expectedRevision: session.revision,
      sessionId: session.session_id,
      expectedItemId: "item-cas",
      attempt: { ...evidence, at: "2026-08-10T08:00:01.000Z" },
      feedback: { item_id: "item-cas", result: "mastered", correct: true, source_refs: [] },
    }),
    { code: "ATTEMPT_CONFLICT" },
  );
  const mutations = await Promise.allSettled([
    store.putSession({ ...committed.session, state: "complete" }, { expectedRevision: committed.session.revision }),
    store.putSession({ ...committed.session, state: "complete" }, { expectedRevision: committed.session.revision }),
  ]);
  assert.equal(mutations.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(mutations.filter((result) => result.status === "rejected").length, 1);
});

test("import deterministically rebuilds forged progress from content-free attempts", async () => {
  const curriculum = JSON.parse(await readFile(curriculumUrl, "utf8"));
  const original = createMemoryCoachStore();
  const coach = createBrowserCoach({
    store: original,
    worker: fixtureWorker(),
    curriculum,
    clock: () => "2026-08-10T08:00:00.000Z",
    idFactory: idFactory(),
  });
  await coach.initialize();
  const question = await coach.start();
  await coach.answer({ response: "B", confidence: "sure", expectedRevision: question.revision, expectedItemId: question.question.item_id });
  const exported = await coach.exportData();
  exported.progress.subjects.comprehensive.evidence_count = 999;
  exported.progress.topics.FORGED = { status: "pass_ready" };
  exported.progress.applied_attempt_ids.push("forged-attempt");

  const target = createMemoryCoachStore();
  const imported = await target.importData(exported);
  assert.equal(imported.progress.subjects.comprehensive.evidence_count, 1);
  assert.equal(Object.hasOwn(imported.progress.topics, "FORGED"), false);
  assert.deepEqual(imported.progress.applied_attempt_ids, [imported.attempts[0].attempt_id]);
});

test("clear removes the local authorization and all private progress", async () => {
  const store = createMemoryCoachStore();
  const now = "2026-08-10T08:00:00.000Z";
  await store.initialize({
    profile: createLocalProfile({ principalId: "local:fixture-00000003", now }),
    progress: createBlankProgress({ now }),
  });
  await store.clear();
  assert.equal(await store.getProfile(), null);
  assert.equal(await store.getProgress(), null);
  assert.equal(progressSummary(createBlankProgress({ now })).knows_progress, false);
});

test("restore is read-only: empty returns null, complete state resumes, partial state fails closed", async () => {
  const curriculum = JSON.parse(await readFile(curriculumUrl, "utf8"));
  const now = "2026-08-10T08:00:00.000Z";
  const empty = createMemoryCoachStore();
  const emptyCoach = createBrowserCoach({
    store: empty,
    worker: fixtureWorker(),
    curriculum,
    clock: () => now,
    idFactory: idFactory(),
  });
  assert.equal(await emptyCoach.restore(), null);
  assert.equal(await empty.getProfile(), null);

  await empty.initialize({
    profile: createLocalProfile({ principalId: "local:fixture-00000004", now }),
    progress: createBlankProgress({ now }),
  });
  const restored = await emptyCoach.loadExisting();
  assert.equal(restored.state, "ready");
  assert.equal(restored.knowsProgress, false);
  assert.match(restored.message, /仍不知道.*真实水平/u);

  const partial = createMemoryCoachStore();
  partial.profile = createLocalProfile({ principalId: "local:fixture-00000005", now });
  const partialCoach = createBrowserCoach({
    store: partial,
    worker: fixtureWorker(),
    curriculum,
    clock: () => now,
  });
  await assert.rejects(partialCoach.restore(), { code: "INCOMPLETE_LOCAL_STATE" });
  assert.equal(await partial.getProgress(), null);
});

test("refresh restores the exact awaiting item and revision, then commits into the only session", async () => {
  const curriculum = JSON.parse(await readFile(curriculumUrl, "utf8"));
  const store = createMemoryCoachStore();
  const worker = fixtureWorker();
  const clock = () => "2026-08-10T08:00:00.000Z";
  const first = createBrowserCoach({ store, worker, curriculum, clock, idFactory: idFactory() });
  await first.initialize();
  const issued = await first.start();
  assert.equal(issued.state, "awaiting_answer");

  const refreshed = createBrowserCoach({ store, worker, curriculum, clock, idFactory: idFactory() });
  const restored = await refreshed.restore();
  assert.equal(restored.state, "awaiting_answer");
  assert.equal(restored.sessionId, issued.sessionId);
  assert.equal(restored.revision, issued.revision);
  assert.equal(restored.question.item_id, issued.question.item_id);

  const feedback = await refreshed.answer({
    response: "B",
    confidence: "sure",
    expectedRevision: restored.revision,
    expectedItemId: restored.question.item_id,
  });
  assert.equal(feedback.state, "feedback");
  const exported = await refreshed.exportData();
  assert.equal(exported.sessions.length, 1);
  assert.equal(exported.sessions[0].session_id, issued.sessionId);
  assert.equal(exported.attempts.length, 1);
});

test("feedback refresh safely advances without restoring answer text; ambiguous active sessions fail closed", async () => {
  const curriculum = JSON.parse(await readFile(curriculumUrl, "utf8"));
  const store = createMemoryCoachStore();
  const worker = fixtureWorker();
  const clock = () => "2026-08-10T08:00:00.000Z";
  const first = createBrowserCoach({ store, worker, curriculum, clock, idFactory: idFactory() });
  await first.initialize();
  const issued = await first.start();
  const feedback = await first.answer({
    response: "B",
    confidence: "sure",
    expectedRevision: issued.revision,
    expectedItemId: issued.question.item_id,
  });
  const refreshed = createBrowserCoach({ store, worker, curriculum, clock, idFactory: idFactory() });
  const restored = await refreshed.restore();
  assert.equal(restored.state, "ready");
  assert.equal(restored.sessionId, feedback.sessionId);
  assert.equal(restored.completedTasks, 1);
  assert.equal(restored.feedback, null);
  assert.equal(restored.revision, feedback.revision + 1);

  const duplicate = {
    ...store.sessions.get(feedback.sessionId),
    session_id: "ambiguous-second-session",
    revision: 0,
    state: "ready",
    updated_at: "2026-08-10T08:01:00.000Z",
  };
  store.sessions.set(duplicate.session_id, duplicate);
  const ambiguous = createBrowserCoach({ store, worker, curriculum, clock });
  await assert.rejects(ambiguous.restore(), { code: "AMBIGUOUS_ACTIVE_SESSION" });
});
