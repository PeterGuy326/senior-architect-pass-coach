import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createContentWorkerHandler } from "../docs/src/content-worker.mjs";
import {
  PINNED_CONTENT_SOURCE,
  assertAllowedRawUrl,
  createByteBudget,
  fetchBoundedUtf8,
  rawUrlForPinnedFile,
  validateContentSource,
} from "../docs/src/github-content.mjs";
import {
  gradeObjectiveAssessment,
  parsePaperCandidates,
  rehydrateObjectiveQuestion,
  splitQuestionBlocks,
} from "../docs/src/objective-parser.mjs";

const SYNTHETIC_PAPER = `# 合成客观题（回忆版）

### 1. 【题干】
合成题一用于验证相似标签不会串题。
A. 甲  B. 乙  C. 丙  D. 丁
**答案：B**  |  **考点**：§4.10 合成标签
**解析**：仅供测试的隐藏说明一。

### 2-3. 【题干】
这是一道只充当边界的合成组合题。
A. 甲  B. 乙  C. 丙  D. 丁
**答案：2-A，3-B**  |  **考点**：§4.1 合成组合题
**解析**：组合题必须跳过。

### 4. 【题干】
合成多选题应选择两个互不相邻的选项。
A. 甲  B. 乙  C. 丙  D. 丁
**答案：A、C**  |  **考点**：§4.1 合成单题
**解析**：仅供测试的隐藏说明二。
`;

const PARSE_CONTEXT = {
  rawTags: ["§4.1"],
  relativePath: "past-papers/comprehensive-by-year/synthetic.md",
  topicId: "K08.SYNTHETIC",
  subject: "comprehensive",
  sourceType: "recalled_real",
  action: "practice",
  sourceCommit: "a".repeat(40),
};

test("内容清单固定到 commit、七文件白名单且不内置外部内容", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../docs/data/content-source.json", import.meta.url),
    "utf8",
  ));
  assert.equal(validateContentSource(manifest), PINNED_CONTENT_SOURCE);
  assert.equal(manifest.papers.files.length, 7);
  assert.match(manifest.papers.commit, /^[a-f0-9]{40}$/u);
  assert.equal(manifest.license, "NOASSERTION");
  assert.equal(manifest.content_included, false);

  const first = manifest.papers.files[0];
  const url = rawUrlForPinnedFile(manifest.papers.repository, manifest.papers.commit, first.path);
  assert.equal(assertAllowedRawUrl(url), url);
  assert.match(url, /^https:\/\/raw\.githubusercontent\.com\//u);
  assert.throws(
    () => assertAllowedRawUrl("https://example.test/answers.md"),
    (error) => error.code === "CONTENT_URL_FORBIDDEN",
  );
  assert.throws(
    () => rawUrlForPinnedFile(manifest.papers.repository, "b".repeat(40), first.path),
    (error) => error.code === "CONTENT_URL_FORBIDDEN",
  );
});

test("组合题参与切块但被跳过，§4.1 不命中 §4.10", async () => {
  const blocks = splitQuestionBlocks(SYNTHETIC_PAPER);
  assert.deepEqual(blocks.map(({ questionNumber, rangeEnd }) => [questionNumber, rangeEnd]), [
    [1, null],
    [2, 3],
    [4, null],
  ]);

  const candidates = await parsePaperCandidates(SYNTHETIC_PAPER, PARSE_CONTEXT);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contentRef.question_number, 4);
  assert.deepEqual(candidates[0].publicQuestion.options.map((option) => option.label), [
    "A", "B", "C", "D",
  ]);
  assert.doesNotMatch(
    JSON.stringify({
      publicQuestion: candidates[0].publicQuestion,
      contentRef: candidates[0].contentRef,
    }),
    /答案|解析|A、C|隐藏说明/u,
  );
});

test("多选判分严格遵守三态，提交后才产生答案反馈", async () => {
  const [{ assessment }] = await parsePaperCandidates(SYNTHETIC_PAPER, PARSE_CONTEXT);
  assert.equal(gradeObjectiveAssessment(assessment, "C,A", "sure").grade.result, "mastered");
  assert.equal(
    gradeObjectiveAssessment(assessment, ["A", "C"], "unsure").grade.result,
    "needs_retest",
  );
  assert.equal(gradeObjectiveAssessment(assessment, "B", "sure").grade.result, "not_mastered");
  assert.equal(gradeObjectiveAssessment(assessment, "A,C", "guess").grade.result, "needs_retest");
});

test("刷新后可按 contentRef 重建，同题块变化会被摘要拒绝", async () => {
  const [issued] = await parsePaperCandidates(SYNTHETIC_PAPER, PARSE_CONTEXT);
  const restored = await rehydrateObjectiveQuestion(SYNTHETIC_PAPER, issued.contentRef);
  assert.deepEqual(restored.publicQuestion, issued.publicQuestion);

  const changedAnswer = SYNTHETIC_PAPER.replace("**答案：A、C**", "**答案：B**");
  await assert.rejects(
    rehydrateObjectiveQuestion(changedAnswer, issued.contentRef),
    (error) => error.code === "CONTENT_CHANGED",
  );
});

test("受限 fetch 使用 omit/no-referrer 且执行总字节上限", async () => {
  const entry = PINNED_CONTENT_SOURCE.curriculum;
  const url = rawUrlForPinnedFile(entry.repository, entry.commit, entry.path);
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    const bytes = new TextEncoder().encode("synthetic");
    return {
      ok: true,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer,
    };
  };
  const budget = createByteBudget(32);
  assert.equal(await fetchBoundedUtf8(url, {
    fetchImpl,
    timeoutMs: 1_000,
    maximumBytes: 16,
    budget,
  }), "synthetic");
  assert.equal(budget.used, 9);
  assert.equal(calls[0][1].credentials, "omit");
  assert.equal(calls[0][1].referrerPolicy, "no-referrer");
  assert.equal(calls[0][1].redirect, "error");
  await assert.rejects(
    fetchBoundedUtf8(url, { fetchImpl, maximumBytes: 16, budget: createByteBudget(4) }),
    (error) => error.code === "CONTENT_TOTAL_TOO_LARGE",
  );
});

test("Worker 只在 issue 返回公开题面，grade 后才返回答案", async () => {
  const [issued] = await parsePaperCandidates(SYNTHETIC_PAPER, PARSE_CONTEXT);
  const repository = {
    async issue() {
      return issued;
    },
    async rehydrate(contentRef) {
      assert.deepEqual(contentRef, issued.contentRef);
      return issued;
    },
    async grade(payload) {
      return gradeObjectiveAssessment(issued.assessment, payload.response, payload.confidence);
    },
  };
  const handle = createContentWorkerHandler({ repository });
  const issueResponse = await handle({
    id: "turn-1",
    type: "issue",
    payload: { task: { subject: "comprehensive", topic_id: "K08.SYNTHETIC", action: "practice" } },
  });
  assert.equal(issueResponse.ok, true);
  assert.deepEqual(Object.keys(issueResponse.result).sort(), ["contentRef", "publicQuestion"]);
  assert.doesNotMatch(JSON.stringify(issueResponse), /答案|解析|A、C|隐藏说明/u);

  const restoredResponse = await handle({
    id: "turn-restore",
    type: "rehydrate",
    payload: { contentRef: issued.contentRef },
  });
  assert.equal(restoredResponse.ok, true);
  assert.deepEqual(restoredResponse.result, issueResponse.result);
  assert.doesNotMatch(JSON.stringify(restoredResponse), /答案|解析|A、C|隐藏说明/u);

  const gradeResponse = await handle({
    id: "turn-2",
    type: "grade",
    payload: { contentRef: issued.contentRef, response: "A,C", confidence: "sure" },
  });
  assert.equal(gradeResponse.ok, true);
  assert.equal(gradeResponse.result.grade.reference_answer, "A、C");
  assert.equal(gradeResponse.result.grade.result, "mastered");
});
