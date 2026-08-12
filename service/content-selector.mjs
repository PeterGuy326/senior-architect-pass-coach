import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";

import { CoachError } from "./errors.mjs";
import { repositoryRoot } from "./paths.mjs";

const HEADING = /^###\s+(\d+)\.\s*【题干】\s*\r?$/gmu;
const SUPPORTED_ACTIONS = new Set(["diagnose", "practice", "review"]);
const EVENT_TYPE_BY_ACTION = Object.freeze({
  diagnose: "diagnostic_result",
  practice: "practice_result",
  review: "retest_result",
});

function sourceTypeFor(markdown) {
  return /回忆版/u.test(markdown.slice(0, 4_096)) ? "recalled_real" : "real";
}

function selectorError(code, message, options = {}) {
  return new CoachError(code, message, options);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function questionCandidatesWithTags(markdown, tags) {
  const headings = [];
  HEADING.lastIndex = 0;
  let match;
  while ((match = HEADING.exec(markdown)) !== null) {
    headings.push({
      number: Number.parseInt(match[1], 10),
      start: match.index,
      bodyStart: HEADING.lastIndex,
    });
  }
  return headings
    .map((heading, index) => {
      const end = index + 1 < headings.length ? headings[index + 1].start : markdown.length;
      const block = markdown.slice(heading.bodyStart, end).trim();
      const matches = tags.some((tag) => {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        return new RegExp(
          `\\*\\*考点\\*\\*\\s*[：:]\\s*${escaped}(?![\\d.])`,
          "u",
        ).test(block);
      });
      return matches
        ? {
          number: heading.number,
          contentRevision: `sha256:${createHash("sha256").update(block, "utf8").digest("hex")}`,
        }
        : null;
    })
    .filter(Boolean);
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw selectorError("INVALID_CONTENT_INDEX", `${label} 不是有效 JSON。`, { cause: error });
  }
}

async function readBoundedFile(filePath, maximumBytes) {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) {
      throw selectorError("CONTENT_FILE_TOO_LARGE", "历年题文件不是普通文件或超过读取上限。 ");
    }
    const buffer = await handle.readFile();
    if (buffer.length > maximumBytes) {
      throw selectorError("CONTENT_FILE_TOO_LARGE", "历年题文件超过读取上限。 ");
    }
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Deterministically chooses an objective question whose source tag matches the
 * current trusted curriculum topic. It reads only a user-supplied content clone;
 * the selected answer remains sealed by LocalObjectiveContentProvider.
 */
export class LocalObjectiveQuestionSelector {
  constructor({
    contentProvider,
    curriculumPath = path.join(repositoryRoot, "config", "curriculum.json"),
    papersRelativeDirectory = "past-papers/comprehensive-by-year",
  } = {}) {
    if (!contentProvider?.loadObjectiveQuestion) {
      throw new TypeError("contentProvider_loadObjectiveQuestion_required");
    }
    if (typeof curriculumPath !== "string" || curriculumPath.length === 0) {
      throw new TypeError("curriculumPath_required");
    }
    this.contentProvider = contentProvider;
    this.curriculumPath = path.resolve(curriculumPath);
    this.papersRelativeDirectory = papersRelativeDirectory;
  }

  async issue({ task, usedItemIds = [] } = {}) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw selectorError("INVALID_CONTENT_TASK", "选题任务必须是对象。 ");
    }
    if (task.subject !== "comprehensive" || !SUPPORTED_ACTIONS.has(task.action)) {
      throw selectorError(
        "UNSUPPORTED_PHASE1_TASK",
        "首期对话闭环只支持综合知识的 diagnose、practice 和 review 客观题。",
      );
    }
    const curriculum = await readJson(this.curriculumPath, "课程索引");
    const topic = Array.isArray(curriculum?.topics)
      ? curriculum.topics.find((item) => item?.id === task.topic_id)
      : null;
    const tags = Array.isArray(topic?.raw_tags)
      ? topic.raw_tags.filter((tag) => typeof tag === "string" && /^§\d+(?:\.\d+)?$/u.test(tag))
      : [];
    if (tags.length === 0) {
      throw selectorError("CONTENT_TOPIC_NOT_MAPPED", `考点 ${task.topic_id} 没有可用的历年题标签。`);
    }

    const contentRoot = await realpath(this.contentProvider.contentDirectory);
    const papersDirectory = await realpath(path.join(contentRoot, this.papersRelativeDirectory));
    if (!isWithin(contentRoot, papersDirectory) || !(await stat(papersDirectory)).isDirectory()) {
      throw selectorError("CONTENT_PATH_FORBIDDEN", "历年题目录越过了复习资料边界。 ");
    }
    const entries = await readdir(papersDirectory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.md$/iu.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, "zh-CN", { numeric: true }));
    const used = new Set(usedItemIds);
    for (const file of files) {
      const absolute = path.join(papersDirectory, file);
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size > this.contentProvider.maxFileBytes) continue;
      const markdown = await readBoundedFile(absolute, this.contentProvider.maxFileBytes);
      const candidates = questionCandidatesWithTags(markdown, tags);
      for (const candidate of candidates) {
        const questionNumber = candidate.number;
        const relativePath = path.posix.join(this.papersRelativeDirectory, file);
        try {
          const loaded = await this.contentProvider.loadObjectiveQuestion({
            relativePath,
            questionNumber,
            topicId: task.topic_id,
            subject: task.subject,
            skill: "recognition",
            eventType: EVENT_TYPE_BY_ACTION[task.action],
            sourceType: sourceTypeFor(markdown),
          });
          if (loaded.contentRef.content_revision !== candidate.contentRevision) {
            throw selectorError(
              "CONTENT_CHANGED",
              "历年题在考点选择与密封加载之间发生变化，拒绝错绑题目。",
            );
          }
          if (!used.has(loaded.publicQuestion.item_id)) return loaded;
        } catch (error) {
          if ([
            "UNSUPPORTED_OBJECTIVE_QUESTION",
            "UNSUPPORTED_OBJECTIVE_ANSWER",
          ].includes(error?.code)) continue;
          throw error;
        }
      }
    }
    throw selectorError(
      "OBJECTIVE_CONTENT_NOT_FOUND",
      `本地题库里没有找到可安全解析且匹配 ${task.topic_id} 的客观题。`,
    );
  }

  async rehydrate(contentRef) {
    return this.contentProvider.rehydrate(contentRef);
  }
}
