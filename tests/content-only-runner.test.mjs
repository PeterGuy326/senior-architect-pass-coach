import assert from "node:assert/strict";
import test from "node:test";

import { ContentOnlyCoachRunner } from "../service/content-only-runner.mjs";
import { validateEmployeeOutput } from "../service/schema-validator.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const PRESENTATION = Object.freeze({
  schema_version: "coach-package-presentation.v1",
  display_name: "合成私教",
});
const presentationLoader = async () => PRESENTATION;

const activeItem = {
  item_id: "synthetic:item:1",
  kind: "multiple_choice",
  subject: "comprehensive",
  topic_id: "K08.SYNTHETIC",
  prompt: "合成题目？",
  options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }],
  source_refs: ["senior-software-architect-review"],
};

function runtimeFixture({ digests = [DIGEST_A] } = {}) {
  const calls = { directories: [], cleanups: 0 };
  const runtime = {
    async createSealedEmployeePackageSnapshot(directory) {
      const index = calls.directories.length;
      calls.directories.push(directory);
      return {
        directory: `/sealed/${index + 1}`,
        digest: digests[index] ?? digests.at(-1),
        manifest: { name: "senior-architect-pass-coach", version: "0.1.0" },
        async cleanup() { calls.cleanups += 1; },
      };
    },
  };
  return { runtime, calls };
}

test("content-only preflight seals the employee package and pins its identity", async () => {
  const { runtime, calls } = runtimeFixture();
  const runner = new ContentOnlyCoachRunner({
    directory: "/publisher/employee",
    runtime,
    presentationLoader,
  });

  const result = await runner.preflight();

  assert.deepEqual(result, {
    engine: null,
    digest: DIGEST_A,
    employee: { name: "senior-architect-pass-coach", version: "0.1.0" },
    presentation: PRESENTATION,
  });
  assert.equal(runner.pinnedDigest, DIGEST_A);
  assert.deepEqual(runner.employee, result.employee);
  assert.deepEqual(calls.directories, ["/publisher/employee"]);
  assert.equal(calls.cleanups, 1);
});

test("content-only runner echoes the trusted active item without an answer", async () => {
  const { runtime, calls } = runtimeFixture();
  const runner = new ContentOnlyCoachRunner({ runtime, presentationLoader });
  const input = {
    action: "practice",
    context: { authenticated: true },
    request: { active_item: activeItem },
  };
  const first = await runner.run(input);
  const second = await runner.run(input);

  await validateEmployeeOutput(first);
  assert.deepEqual(first, second);
  assert.deepEqual(first.teaching_result.learning_items, [activeItem]);
  assert.equal(first.teaching_result.answer_visibility, "hidden");
  assert.deepEqual(first.proposed_progress_events, []);
  assert.equal(calls.directories.length, 3);
  assert.equal(calls.cleanups, 3);
});

test("content-only runner projects, but does not invent, a trusted grade", async () => {
  const { runtime, calls } = runtimeFixture();
  const runner = new ContentOnlyCoachRunner({ runtime, presentationLoader });
  const trustedGrade = {
    item_id: activeItem.item_id,
    subject: activeItem.subject,
    topic_id: activeItem.topic_id,
    correct: true,
    result: "needs_retest",
    reference_answer: "B",
    explanation: "合成解析。",
    source_refs: ["senior-software-architect-review"],
    event_type: "practice_result",
  };
  const output = await runner.run({
    action: "submit",
    context: { authenticated: true },
    request: {
      active_item: activeItem,
      approved_materials: [{ excerpt: JSON.stringify({ trusted_grade: trustedGrade }) }],
    },
  });

  await validateEmployeeOutput(output);
  assert.deepEqual(output.teaching_result.feedback[0], {
    item_id: activeItem.item_id,
    result: "needs_retest",
    reference_answer: "B",
    explanation: "合成解析。",
    source_refs: ["senior-software-architect-review"],
  });
  assert.equal(output.proposed_progress_events[0].result, "needs_retest");
  assert.equal(output.teaching_result.state_write_performed, false);
  assert.equal(calls.directories.length, 2);
  assert.equal(calls.cleanups, 2);
});

test("content-only runner fails closed when the employee package changes", async () => {
  const { runtime, calls } = runtimeFixture({ digests: [DIGEST_A, DIGEST_B] });
  const runner = new ContentOnlyCoachRunner({ runtime, presentationLoader });

  await assert.rejects(
    runner.run({
      action: "practice",
      context: { authenticated: true },
      request: { active_item: activeItem },
    }),
    (error) => error.code === "EMPLOYEE_PACKAGE_CHANGED",
  );
  assert.equal(calls.directories.length, 2);
  assert.equal(calls.cleanups, 2);
});
