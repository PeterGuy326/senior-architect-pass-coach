import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalObjectiveContentProvider } from "../service/content-provider.mjs";

const SYNTHETIC_PAPER = `# 合成练习材料

### 1. 【题干】
某系统要在两个合成方案之间选择，下列描述正确的是（ ）。
A. 方案甲只保留一个组件  B. 方案乙引入异步边界
C. 方案丙删除所有状态  D. 方案丁取消故障处理
**答案：B**  |  **考点**：合成考点
**解析**：异步边界能隔离合成场景中的瞬时故障。

### 2. 【题干】
该合成题故意缺少选项。
**答案：A**
**解析**：仅用于测试拒绝路径。
`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-content-"));
  await mkdir(path.join(directory, "papers"));
  await writeFile(path.join(directory, "papers", "synthetic.md"), SYNTHETIC_PAPER, "utf8");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    provider: new LocalObjectiveContentProvider({ contentDirectory: directory }),
  };
}

test("provider returns an answer-free public question and an opaque sealed bundle", async (t) => {
  const { provider } = await fixture(t);
  const loaded = await provider.loadObjectiveQuestion({
    relativePath: "papers/synthetic.md",
    questionNumber: 1,
    topicId: "K06.SYNTHETIC",
  });

  assert.equal(loaded.publicQuestion.kind, "multiple_choice");
  assert.equal(loaded.publicQuestion.options.length, 4);
  assert.deepEqual(loaded.publicQuestion.options.map((item) => item.label), ["A", "B", "C", "D"]);
  assert.equal(loaded.publicQuestion.source_refs[0], "user-supplied-local-review-material");
  assert.doesNotMatch(JSON.stringify(loaded.publicQuestion), /答案|解析|异步边界能隔离/u);
  assert.deepEqual(Object.keys(loaded.assessmentBundle), ["schema_version", "item_id"]);
  assert.doesNotMatch(JSON.stringify(loaded.assessmentBundle), /答案|解析|异步边界能隔离|"B"/u);
  assert.equal(Object.isFrozen(loaded.publicQuestion), true);
  assert.equal(Object.isFrozen(loaded.assessmentBundle), true);
  assert.equal(loaded.contentRef.schema_version, "objective-content-ref.v1");
  assert.equal(loaded.contentRef.relative_path, "papers/synthetic.md");
  assert.equal(loaded.contentRef.question_number, 1);
  assert.match(loaded.contentRef.content_revision, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(loaded.approvedMaterials, [{
    source_id: "user-supplied-local-review-material",
    locator: `question:${loaded.publicQuestion.item_id}`,
    excerpt: JSON.stringify(loaded.publicQuestion),
  }]);
  assert.doesNotMatch(JSON.stringify(loaded.contentRef), /答案|解析|异步边界能隔离|"B"/u);

  const rehydrated = await provider.rehydrate(JSON.parse(JSON.stringify(loaded.contentRef)));
  assert.deepEqual(rehydrated.publicQuestion, loaded.publicQuestion);
  assert.notEqual(rehydrated.assessmentBundle, loaded.assessmentBundle);
});

test("rehydration rejects an answer-key-only content change", async (t) => {
  const { directory, provider } = await fixture(t);
  const loaded = await provider.loadObjectiveQuestion({
    relativePath: "papers/synthetic.md",
    questionNumber: 1,
    topicId: "K06.SYNTHETIC",
  });
  const originalPublicQuestion = structuredClone(loaded.publicQuestion);

  await writeFile(
    path.join(directory, "papers", "synthetic.md"),
    SYNTHETIC_PAPER.replace("**答案：B**", "**答案：C**"),
    "utf8",
  );

  await assert.rejects(
    provider.rehydrate(JSON.parse(JSON.stringify(loaded.contentRef))),
    (error) => error.code === "CONTENT_CHANGED",
  );
  const changed = await provider.loadObjectiveQuestion({
    relativePath: "papers/synthetic.md",
    questionNumber: 1,
    topicId: "K06.SYNTHETIC",
  });
  assert.deepEqual(changed.publicQuestion, originalPublicQuestion);
  assert.notEqual(changed.contentRef.content_revision, loaded.contentRef.content_revision);
});

test("provider rejects traversal, absolute paths and symlink escape", async (t) => {
  const { directory, provider } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "architect-content-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "outside.md"), SYNTHETIC_PAPER, "utf8");
  await symlink(path.join(outside, "outside.md"), path.join(directory, "papers", "escape.md"));

  const selection = { questionNumber: 1, topicId: "K06.SYNTHETIC" };
  await assert.rejects(
    provider.loadObjectiveQuestion({ ...selection, relativePath: "../outside.md" }),
    (error) => error.code === "CONTENT_PATH_FORBIDDEN",
  );
  await assert.rejects(
    provider.loadObjectiveQuestion({
      ...selection,
      relativePath: "papers/../papers/synthetic.md",
    }),
    (error) => error.code === "CONTENT_PATH_FORBIDDEN",
  );
  await assert.rejects(
    provider.loadObjectiveQuestion({ ...selection, relativePath: path.join(outside, "outside.md") }),
    (error) => error.code === "CONTENT_PATH_FORBIDDEN",
  );
  await assert.rejects(
    provider.loadObjectiveQuestion({ ...selection, relativePath: "papers/escape.md" }),
    (error) => error.code === "CONTENT_SYMLINK_ESCAPE",
  );
});

test("provider rejects blocks that cannot form a complete objective question", async (t) => {
  const { provider } = await fixture(t);
  await assert.rejects(
    provider.loadObjectiveQuestion({
      relativePath: "papers/synthetic.md",
      questionNumber: 2,
      topicId: "K06.SYNTHETIC",
    }),
    (error) => error.code === "UNSUPPORTED_OBJECTIVE_QUESTION",
  );
});
