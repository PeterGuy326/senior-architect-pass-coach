import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalObjectiveContentProvider } from "../service/content-provider.mjs";
import { LocalObjectiveQuestionSelector } from "../service/content-selector.mjs";

const PAPER = `### 2. 【题干】
这是相邻但不同的合成考点（ ）。
A. 相邻甲  B. 相邻乙
**答案：A**  |  **考点**：§4.10 合成相邻考点

### 3. 【题干】
合成过程采用哪一种描述（ ）。
A. 合成甲  B. 合成乙  C. 合成丙  D. 合成丁
**答案：B**  |  **考点**：§4.1 合成过程
**解析**：合成乙满足本题条件。

### 4. 【题干】
这是另一个主题（ ）。
A. 一  B. 二
**答案：A**  |  **考点**：§9.9 其他主题
`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-selector-"));
  const papers = path.join(root, "past-papers", "comprehensive-by-year");
  await mkdir(papers, { recursive: true });
  await writeFile(path.join(papers, "2099.md"), PAPER, "utf8");
  const curriculumPath = path.join(root, "curriculum.json");
  await writeFile(curriculumPath, JSON.stringify({
    topics: [{ id: "K08.SYNTHETIC", raw_tags: ["§4.1"] }],
  }), "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const contentProvider = new LocalObjectiveContentProvider({ contentDirectory: root });
  return {
    selector: new LocalObjectiveQuestionSelector({ contentProvider, curriculumPath }),
  };
}

test("selector binds a recommended topic to a tagged local objective question", async (t) => {
  const { selector } = await fixture(t);
  const loaded = await selector.issue({
    task: { action: "practice", subject: "comprehensive", topic_id: "K08.SYNTHETIC" },
  });

  assert.equal(loaded.publicQuestion.topic_id, "K08.SYNTHETIC");
  assert.equal(loaded.contentRef.question_number, 3);
  assert.equal(loaded.contentRef.event_type, "practice_result");
  assert.equal(loaded.contentRef.source_type, "real");
  assert.doesNotMatch(JSON.stringify(loaded.publicQuestion), /答案|解析|合成乙满足/u);

  const restored = await selector.rehydrate(loaded.contentRef);
  assert.deepEqual(restored.publicQuestion, loaded.publicQuestion);

  await assert.rejects(
    selector.issue({
      task: { action: "review", subject: "comprehensive", topic_id: "K08.SYNTHETIC" },
      usedItemIds: [loaded.publicQuestion.item_id],
    }),
    (error) => error.code === "OBJECTIVE_CONTENT_NOT_FOUND",
  );
});

test("selector derives recalled provenance from the paper metadata, not its filename", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-selector-source-"));
  const papers = path.join(root, "past-papers", "comprehensive-by-year");
  await mkdir(papers, { recursive: true });
  await writeFile(
    path.join(papers, "2100上.md"),
    `# 2100 年综合知识真题（回忆版）\n\n${PAPER}`,
    "utf8",
  );
  const curriculumPath = path.join(root, "curriculum.json");
  await writeFile(curriculumPath, JSON.stringify({
    topics: [{ id: "K08.SYNTHETIC", raw_tags: ["§4.1"] }],
  }), "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const contentProvider = new LocalObjectiveContentProvider({ contentDirectory: root });
  const selector = new LocalObjectiveQuestionSelector({ contentProvider, curriculumPath });

  const loaded = await selector.issue({
    task: { action: "practice", subject: "comprehensive", topic_id: "K08.SYNTHETIC" },
  });
  assert.equal(loaded.contentRef.source_type, "recalled_real");
});

test("selector rejects a file changed between tag selection and sealed loading", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "architect-selector-race-"));
  const papers = path.join(root, "past-papers", "comprehensive-by-year");
  await mkdir(papers, { recursive: true });
  const paperPath = path.join(papers, "2099.md");
  await writeFile(paperPath, PAPER, "utf8");
  const curriculumPath = path.join(root, "curriculum.json");
  await writeFile(curriculumPath, JSON.stringify({
    topics: [{ id: "K08.SYNTHETIC", raw_tags: ["§4.1"] }],
  }), "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new LocalObjectiveContentProvider({ contentDirectory: root });
  let mutate = true;
  const racingProvider = {
    contentDirectory: provider.contentDirectory,
    maxFileBytes: provider.maxFileBytes,
    async loadObjectiveQuestion(options) {
      if (mutate) {
        mutate = false;
        await writeFile(
          paperPath,
          PAPER.replace("合成过程采用哪一种描述", "变化后的合成过程采用哪一种描述"),
          "utf8",
        );
      }
      return provider.loadObjectiveQuestion(options);
    },
    async rehydrate(contentRef) { return provider.rehydrate(contentRef); },
  };
  const selector = new LocalObjectiveQuestionSelector({
    contentProvider: racingProvider,
    curriculumPath,
  });

  await assert.rejects(
    selector.issue({
      task: { action: "practice", subject: "comprehensive", topic_id: "K08.SYNTHETIC" },
    }),
    (error) => error.code === "CONTENT_CHANGED",
  );
});

test("selector fails closed for unsupported or unmapped tasks", async (t) => {
  const { selector } = await fixture(t);
  await assert.rejects(
    selector.issue({
      task: { action: "case", subject: "case", topic_id: "K08.SYNTHETIC" },
    }),
    (error) => error.code === "UNSUPPORTED_PHASE1_TASK",
  );
  await assert.rejects(
    selector.issue({
      task: { action: "practice", subject: "comprehensive", topic_id: "K00.UNKNOWN" },
    }),
    (error) => error.code === "CONTENT_TOPIC_NOT_MAPPED",
  );
});
