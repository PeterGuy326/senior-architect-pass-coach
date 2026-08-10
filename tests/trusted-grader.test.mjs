import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalObjectiveContentProvider } from "../service/content-provider.mjs";
import { authorizeProgressWrites } from "../service/proposal-validator.mjs";
import { TrustedObjectiveGrader } from "../service/trusted-grader.mjs";

const LOCAL_PRINCIPAL = "local:123e4567-e89b-42d3-a456-426614174000";
const SYNTHETIC_PAPER = `### 7. 【题干】
合成服务需要降低故障扩散范围，应选择（ ）。
A. 删除监控  B. 放大共享状态
C. 设置隔离边界  D. 取消超时
**答案：C**  |  **考点**：合成可靠性
**解析**：隔离边界限制了合成故障的传播范围。
`;

async function sealedQuestion(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-grader-"));
  await mkdir(path.join(directory, "papers"));
  await writeFile(path.join(directory, "papers", "synthetic.md"), SYNTHETIC_PAPER, "utf8");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new LocalObjectiveContentProvider({ contentDirectory: directory });
  return provider.loadObjectiveQuestion({
    relativePath: "papers/synthetic.md",
    questionNumber: 7,
    topicId: "K07.SYNTHETIC",
    skill: "recognition",
    eventType: "practice_result",
    ...options,
  });
}

test("trusted grader deterministically authorizes a correct local answer", async (t) => {
  const { publicQuestion, assessmentBundle } = await sealedQuestion(t);
  const grader = new TrustedObjectiveGrader({ principalId: LOCAL_PRINCIPAL });
  const input = {
    assessmentBundle,
    response: ["c"],
    attemptKey: "round-1:task-1",
    confidence: "unsure",
    durationSeconds: 17,
  };
  const first = grader.grade(input);
  const second = grader.grade(input);

  assert.deepEqual(first, second);
  assert.equal(first.grade.item_id, publicQuestion.item_id);
  assert.equal(first.grade.correct, true);
  assert.equal(first.grade.result, "needs_retest");
  assert.equal(first.grade.reference_answer, "C");
  assert.match(first.grade.explanation, /隔离边界/u);
  assert.match(first.authorization.payload.attempt_id, /^objective:[0-9a-f]{64}$/u);
  assert.deepEqual(first.authorization, {
    principal_id: LOCAL_PRINCIPAL,
    event_type: "practice_result",
    subject: "comprehensive",
    topic_id: "K07.SYNTHETIC",
    item_id: publicQuestion.item_id,
    expected_result: "needs_retest",
    command: "record",
    payload: {
      topic_id: "K07.SYNTHETIC",
      item_id: publicQuestion.item_id,
      subject: "comprehensive",
      skill: "recognition",
      score: 1,
      max_score: 1,
      attempt_id: first.authorization.payload.attempt_id,
      mode: "practice",
      confidence: "unsure",
      source_type: "real",
      source: "user-supplied-local-review-material:papers/synthetic.md#7",
      wrong_reasons: [],
      duration_seconds: 17,
    },
  });
  const matchingProposal = {
    event_type: "practice_result",
    subject: "comprehensive",
    topic_id: "K07.SYNTHETIC",
    result: "needs_retest",
    evidence: { item_id: publicQuestion.item_id },
  };
  assert.deepEqual(
    authorizeProgressWrites(
      [matchingProposal],
      [first.authorization],
      { authenticated: true, user_id: LOCAL_PRINCIPAL },
    ),
    [first.authorization],
  );
  await assert.rejects(
    async () => authorizeProgressWrites(
      [{ ...matchingProposal, result: "not_mastered" }],
      [first.authorization],
      { authenticated: true, user_id: LOCAL_PRINCIPAL },
    ),
    (error) => error.code === "PROPOSAL_EVIDENCE_MISMATCH",
  );
});

test("wrong answer produces independent not-mastered evidence", async (t) => {
  const { assessmentBundle } = await sealedQuestion(t, { facet: "failure-isolation" });
  const grader = new TrustedObjectiveGrader({ principalId: LOCAL_PRINCIPAL });
  const result = grader.grade({
    assessmentBundle,
    response: "A",
    attemptKey: "round-2:task-1",
  });

  assert.equal(result.grade.correct, false);
  assert.equal(result.grade.result, "not_mastered");
  assert.equal(result.authorization.expected_result, "not_mastered");
  assert.equal(result.authorization.payload.score, 0);
  assert.equal(result.authorization.payload.facet, "failure-isolation");
});

test("a correct answer becomes mastered only with explicit sure confidence", async (t) => {
  const { assessmentBundle } = await sealedQuestion(t);
  const grader = new TrustedObjectiveGrader({ principalId: LOCAL_PRINCIPAL });
  const uncertain = grader.grade({
    assessmentBundle,
    response: "C",
    attemptKey: "round-3:task-1",
  });
  const sure = grader.grade({
    assessmentBundle,
    response: "C",
    attemptKey: "round-4:task-1",
    confidence: "sure",
  });

  assert.equal(uncertain.grade.result, "needs_retest");
  assert.equal(uncertain.authorization.payload.confidence, "unsure");
  assert.equal(sure.grade.result, "mastered");
  assert.equal(sure.authorization.payload.confidence, "sure");
});

test("forged bundles and non-local principals cannot mint trusted authorization", async () => {
  assert.throws(
    () => new TrustedObjectiveGrader({ principalId: "remote:attacker" }),
    (error) => error.code === "LOCAL_PRINCIPAL_REQUIRED",
  );
  const grader = new TrustedObjectiveGrader({ principalId: LOCAL_PRINCIPAL });
  assert.throws(
    () => grader.grade({
      assessmentBundle: Object.freeze({
        schema_version: "sealed-objective-assessment.v1",
        item_id: "forged",
      }),
      response: "A",
      attemptKey: "forged-attempt",
    }),
    (error) => error.code === "UNTRUSTED_ASSESSMENT_BUNDLE",
  );
});
