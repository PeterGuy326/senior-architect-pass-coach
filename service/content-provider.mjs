import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { CoachError } from "./errors.mjs";

export const REVIEW_SOURCE_REF = "user-supplied-local-review-material";
export const OBJECTIVE_CONTENT_REF_VERSION = "objective-content-ref.v1";

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const SUBJECTS = new Set(["comprehensive"]);
// A single multiple-choice item is valid recognition evidence only. It must
// never be promoted into application or production mastery.
const SKILLS = new Set(["recognition"]);
const EVENT_TYPES = new Set(["diagnostic_result", "practice_result", "retest_result"]);
const SOURCE_TYPES = new Set(["real", "recalled_real"]);
const TOPIC_ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;
const QUESTION_HEADING = /^###\s+(\d+)\.\s*【题干】\s*\r?$/gmu;
const ANSWER_LINE = /^\s*\*\*答案[：:]\s*([^*\r\n]+?)\*\*[^\r\n]*$/mu;
const ANALYSIS_LINE = /\*\*解析\*\*[：:]\s*([^\r\n]*)/u;
const PUBLIC_ANSWER_MARKER = /(?:\*\*|(?:正确)?答案\s*[：:]|解析\s*[：:]|\[correct\]|[✓✔])/iu;

// Answers and explanations deliberately live only in this module-private WeakMap.
// The returned bundle is an opaque, immutable capability and serializes to metadata only.
const sealedAssessments = new WeakMap();

function contentError(code, message, options) {
  return new CoachError(code, message, options);
}

function nonEmptyText(value, label, maximum = 20_000) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw contentError("INVALID_CONTENT_SELECTION", `${label} 必须是非空字符串。`);
  }
  return value.trim();
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) {
    throw contentError("INVALID_CONTENT_SELECTION", `${label} 不受支持。`);
  }
  return value;
}

function freezeQuestion(question) {
  Object.freeze(question.source_refs);
  for (const option of question.options) Object.freeze(option);
  Object.freeze(question.options);
  return Object.freeze(question);
}

function freezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeJson(child);
  return Object.freeze(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function validateRelativeMarkdownPath(relativePath) {
  const value = nonEmptyText(relativePath, "relativePath", 2_000);
  const segments = value.split("/");
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    segments.includes("..") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw contentError("CONTENT_PATH_FORBIDDEN", "题库文件必须使用内容目录内的相对路径。");
  }
  const normalized = path.normalize(value);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    ![".md", ".markdown"].includes(path.extname(normalized).toLowerCase())
  ) {
    throw contentError("CONTENT_PATH_FORBIDDEN", "题库文件路径越界或不是 Markdown 文件。");
  }
  return normalized.split(path.sep).join("/");
}

function normalizeAnswerLabels(rawAnswer) {
  const compact = rawAnswer
    .trim()
    .toUpperCase()
    .replace(/[，、/]/gu, ",")
    .replace(/[和及]/gu, ",")
    .replace(/\s+/gu, "");
  if (!/^[A-H](?:,?[A-H])*$/u.test(compact)) {
    throw contentError(
      "UNSUPPORTED_OBJECTIVE_ANSWER",
      "当前仅支持答案为 A-H 单字母或字母组合的客观题。",
    );
  }
  const labels = compact.replaceAll(",", "").split("");
  if (new Set(labels).size !== labels.length) {
    throw contentError("UNSUPPORTED_OBJECTIVE_ANSWER", "客观题答案包含重复选项。 ");
  }
  return labels.sort();
}

function parsePromptAndOptions(questionText) {
  const optionPattern = /(^|\r?\n|[ \t]{2,})([A-H])[.．、]\s*/gu;
  const markers = [];
  let match;
  while ((match = optionPattern.exec(questionText)) !== null) {
    markers.push({
      label: match[2],
      markerStart: match.index + match[1].length,
      contentStart: optionPattern.lastIndex,
    });
  }
  if (markers.length < 2 || markers.length > 8) {
    throw contentError(
      "UNSUPPORTED_OBJECTIVE_QUESTION",
      "当前仅支持包含 2-8 个显式字母选项的客观题。",
    );
  }
  if (new Set(markers.map((item) => item.label)).size !== markers.length) {
    throw contentError("UNSUPPORTED_OBJECTIVE_QUESTION", "客观题选项标签重复。 ");
  }
  const prompt = questionText.slice(0, markers[0].markerStart).trim();
  const options = markers.map((marker, index) => {
    const end = index + 1 < markers.length
      ? markers[index + 1].markerStart
      : questionText.length;
    return {
      label: marker.label,
      text: questionText.slice(marker.contentStart, end).trim(),
    };
  });
  if (!prompt || options.some((option) => !option.text)) {
    throw contentError("UNSUPPORTED_OBJECTIVE_QUESTION", "客观题题干或选项为空。 ");
  }
  const publicText = [prompt, ...options.flatMap((option) => [option.label, option.text])].join("\n");
  if (PUBLIC_ANSWER_MARKER.test(publicText)) {
    throw contentError("ANSWER_GATE_VIOLATION", "公开题面中检测到答案、解析或答案标记。 ");
  }
  return { prompt, options };
}

function findQuestionBlock(markdown, questionNumber) {
  const headings = [];
  QUESTION_HEADING.lastIndex = 0;
  let match;
  while ((match = QUESTION_HEADING.exec(markdown)) !== null) {
    headings.push({
      number: Number.parseInt(match[1], 10),
      bodyStart: QUESTION_HEADING.lastIndex,
      headingStart: match.index,
    });
  }
  const index = headings.findIndex((heading) => heading.number === questionNumber);
  if (index < 0) {
    throw contentError("CONTENT_QUESTION_NOT_FOUND", `题库中找不到第 ${questionNumber} 题。`);
  }
  const end = index + 1 < headings.length ? headings[index + 1].headingStart : markdown.length;
  return markdown.slice(headings[index].bodyStart, end).trim();
}

function parseObjectiveQuestion(markdown, questionNumber) {
  const block = findQuestionBlock(markdown, questionNumber);
  const contentRevision = `sha256:${createHash("sha256")
    .update(block, "utf8")
    .digest("hex")}`;
  const answerMatch = ANSWER_LINE.exec(block);
  if (!answerMatch) {
    throw contentError("UNSUPPORTED_OBJECTIVE_QUESTION", "题目缺少受支持的本地答案标记。 ");
  }
  const questionText = block.slice(0, answerMatch.index).trim();
  const { prompt, options } = parsePromptAndOptions(questionText);
  const correctLabels = normalizeAnswerLabels(answerMatch[1]);
  const optionLabels = new Set(options.map((option) => option.label));
  if (correctLabels.some((label) => !optionLabels.has(label))) {
    throw contentError("UNSUPPORTED_OBJECTIVE_ANSWER", "本地答案键引用了不存在的选项。 ");
  }
  const afterAnswer = block.slice(answerMatch.index + answerMatch[0].length);
  const explanation = ANALYSIS_LINE.exec(afterAnswer)?.[1]?.trim()
    || "本题依据本地密封答案键进行确定性判定。";
  return { prompt, options, correctLabels, explanation, contentRevision };
}

function stableItemId(relativePath, questionNumber, publicContent) {
  const digest = createHash("sha256")
    .update(`${relativePath}#${questionNumber}\0`, "utf8")
    .update(JSON.stringify(publicContent), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `ssa-review:q${questionNumber}:${digest}`;
}

async function canonicalDirectory(directory) {
  let canonical;
  try {
    canonical = await realpath(directory);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error("not_directory");
  } catch (error) {
    throw contentError("INVALID_CONTENT_DIRECTORY", "显式提供的题库目录不存在或不是目录。", {
      cause: error,
    });
  }
  return canonical;
}

async function readBoundedMarkdown(contentDirectory, relativePath, maximumBytes) {
  const root = await canonicalDirectory(contentDirectory);
  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate)) {
    throw contentError("CONTENT_PATH_FORBIDDEN", "题库文件不能越过内容目录边界。 ");
  }
  let canonicalFile;
  try {
    canonicalFile = await realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw contentError("CONTENT_FILE_NOT_FOUND", "指定的题库文件不存在。", { cause: error });
    }
    throw error;
  }
  if (!isWithin(root, canonicalFile)) {
    throw contentError("CONTENT_SYMLINK_ESCAPE", "题库文件不能通过符号链接越过内容目录。 ");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(canonicalFile, fsConstants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw contentError("INVALID_CONTENT_FILE", "题库路径必须指向普通文件。 ");
    }
    if (info.size > maximumBytes) {
      throw contentError("CONTENT_FILE_TOO_LARGE", "题库文件超过允许的读取上限。 ");
    }
    const buffer = await handle.readFile();
    if (buffer.length > maximumBytes) {
      throw contentError("CONTENT_FILE_TOO_LARGE", "题库文件超过允许的读取上限。 ");
    }
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function sealAssessment(privateAssessment) {
  const bundle = Object.freeze({
    schema_version: "sealed-objective-assessment.v1",
    item_id: privateAssessment.itemId,
  });
  sealedAssessments.set(bundle, Object.freeze({
    ...privateAssessment,
    correctLabels: Object.freeze([...privateAssessment.correctLabels]),
    optionLabels: Object.freeze([...privateAssessment.optionLabels]),
  }));
  return bundle;
}

/**
 * Runtime-only provider for a user-supplied senior-software-architect-review clone.
 * It never copies source material into this package and never exposes the answer
 * key in the returned public question.
 */
export class LocalObjectiveContentProvider {
  constructor({ contentDirectory, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
    if (typeof contentDirectory !== "string" || contentDirectory.trim().length === 0) {
      throw contentError(
        "CONTENT_DIRECTORY_REQUIRED",
        "必须显式提供 senior-software-architect-review 的本地目录。",
      );
    }
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 32 * 1024 * 1024) {
      throw contentError("INVALID_CONTENT_LIMIT", "maxFileBytes 必须是 1-33554432 的整数。 ");
    }
    this.contentDirectory = path.resolve(contentDirectory);
    this.maxFileBytes = maxFileBytes;
    Object.freeze(this);
  }

  async loadObjectiveQuestion({
    relativePath,
    questionNumber,
    topicId,
    subject = "comprehensive",
    skill = "recognition",
    facet,
    eventType = "practice_result",
    sourceType = "real",
  } = {}) {
    const safeRelativePath = validateRelativeMarkdownPath(relativePath);
    if (!Number.isSafeInteger(questionNumber) || questionNumber < 1) {
      throw contentError("INVALID_CONTENT_SELECTION", "questionNumber 必须是正整数。 ");
    }
    const safeTopicId = nonEmptyText(topicId, "topicId", 128);
    if (!TOPIC_ID.test(safeTopicId)) {
      throw contentError("INVALID_CONTENT_SELECTION", "topicId 格式无效。 ");
    }
    enumValue(subject, SUBJECTS, "subject");
    enumValue(skill, SKILLS, "skill");
    enumValue(eventType, EVENT_TYPES, "eventType");
    enumValue(sourceType, SOURCE_TYPES, "sourceType");
    const safeFacet = facet === undefined ? undefined : nonEmptyText(facet, "facet", 128);
    const markdown = await readBoundedMarkdown(
      this.contentDirectory,
      safeRelativePath,
      this.maxFileBytes,
    );
    const parsed = parseObjectiveQuestion(markdown, questionNumber);
    const itemId = stableItemId(safeRelativePath, questionNumber, {
      prompt: parsed.prompt,
      options: parsed.options,
    });
    const publicQuestion = freezeQuestion({
      item_id: itemId,
      kind: "multiple_choice",
      subject,
      topic_id: safeTopicId,
      prompt: parsed.prompt,
      options: parsed.options,
      source_refs: [REVIEW_SOURCE_REF],
    });
    const assessmentBundle = sealAssessment({
      itemId,
      subject,
      topicId: safeTopicId,
      skill,
      facet: safeFacet,
      eventType,
      sourceType,
      sourceLocator: `${safeRelativePath}#${questionNumber}`,
      optionLabels: parsed.options.map((option) => option.label),
      correctLabels: parsed.correctLabels,
      explanation: parsed.explanation,
      contentRevision: parsed.contentRevision,
    });
    const contentRef = freezeJson({
      schema_version: OBJECTIVE_CONTENT_REF_VERSION,
      relative_path: safeRelativePath,
      question_number: questionNumber,
      topic_id: safeTopicId,
      subject,
      skill,
      event_type: eventType,
      source_type: sourceType,
      ...(safeFacet ? { facet: safeFacet } : {}),
      item_id: itemId,
      content_revision: parsed.contentRevision,
    });
    const approvedMaterials = freezeJson([{
      source_id: REVIEW_SOURCE_REF,
      locator: `question:${itemId}`,
      excerpt: JSON.stringify(publicQuestion),
    }]);
    return Object.freeze({
      publicQuestion,
      assessmentBundle,
      contentRef,
      approvedMaterials,
    });
  }

  async rehydrate(contentRef) {
    if (!contentRef || typeof contentRef !== "object" || Array.isArray(contentRef)) {
      throw contentError("INVALID_CONTENT_REF", "客观题内容引用必须是对象。 ");
    }
    const allowed = new Set([
      "schema_version",
      "relative_path",
      "question_number",
      "topic_id",
      "subject",
      "skill",
      "event_type",
      "source_type",
      "facet",
      "item_id",
      "content_revision",
    ]);
    if (
      contentRef.schema_version !== OBJECTIVE_CONTENT_REF_VERSION ||
      typeof contentRef.content_revision !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(contentRef.content_revision) ||
      Object.keys(contentRef).some((key) => !allowed.has(key))
    ) {
      throw contentError("INVALID_CONTENT_REF", "客观题内容引用版本或字段无效。 ");
    }
    const loaded = await this.loadObjectiveQuestion({
      relativePath: contentRef.relative_path,
      questionNumber: contentRef.question_number,
      topicId: contentRef.topic_id,
      subject: contentRef.subject,
      skill: contentRef.skill,
      eventType: contentRef.event_type,
      sourceType: contentRef.source_type,
      ...(contentRef.facet ? { facet: contentRef.facet } : {}),
    });
    if (
      loaded.publicQuestion.item_id !== contentRef.item_id ||
      loaded.contentRef.content_revision !== contentRef.content_revision
    ) {
      throw contentError("CONTENT_CHANGED", "题库内容引用与当前题目不一致。 ");
    }
    return loaded;
  }
}

function normalizeSubmittedLabels(response, allowedLabels) {
  const values = Array.isArray(response) ? response : [response];
  if (
    values.length < 1 ||
    values.length > 8 ||
    values.some((value) => typeof value !== "string" || value.trim().length === 0)
  ) {
    throw contentError("INVALID_OBJECTIVE_RESPONSE", "客观题作答必须是非空选项字母。 ");
  }
  const compact = values
    .join(",")
    .toUpperCase()
    .replace(/[，、/]/gu, ",")
    .replace(/\s+/gu, "");
  if (!/^[A-H](?:,?[A-H])*$/u.test(compact)) {
    throw contentError("INVALID_OBJECTIVE_RESPONSE", "客观题作答只能包含 A-H 选项字母。 ");
  }
  const labels = compact.replaceAll(",", "").split("");
  if (
    new Set(labels).size !== labels.length ||
    labels.some((label) => !allowedLabels.includes(label))
  ) {
    throw contentError("INVALID_OBJECTIVE_RESPONSE", "客观题作答包含重复或不存在的选项。 ");
  }
  return labels.sort();
}

/**
 * Internal trust-boundary primitive used by TrustedObjectiveGrader. Callers can
 * submit an answer, but cannot forge a bundle or inspect its sealed answer key.
 */
export function evaluateSealedObjectiveAssessment(assessmentBundle, response) {
  const assessment = sealedAssessments.get(assessmentBundle);
  if (!assessment) {
    throw contentError("UNTRUSTED_ASSESSMENT_BUNDLE", "客观题评分包不是本地 Content Provider 签发的。 ");
  }
  const selectedLabels = normalizeSubmittedLabels(response, assessment.optionLabels);
  const correct = selectedLabels.length === assessment.correctLabels.length
    && selectedLabels.every((label, index) => label === assessment.correctLabels[index]);
  return Object.freeze({
    itemId: assessment.itemId,
    subject: assessment.subject,
    topicId: assessment.topicId,
    skill: assessment.skill,
    facet: assessment.facet,
    eventType: assessment.eventType,
    sourceType: assessment.sourceType,
    sourceLocator: assessment.sourceLocator,
    selectedLabels: Object.freeze([...selectedLabels]),
    correctLabels: Object.freeze([...assessment.correctLabels]),
    explanation: assessment.explanation,
    correct,
  });
}
