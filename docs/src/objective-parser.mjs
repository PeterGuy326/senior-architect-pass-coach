const BOUNDARY_HEADING = /^###\s+(\d+)(?:-(\d+))?\.\s*【题干】\s*\r?$/gmu;
const ANSWER_LINE = /^\s*\*\*答案[：:]\s*([^*\r\n]+?)\*\*[^\r\n]*$/mu;
const ANALYSIS_LINE = /\*\*解析\*\*[：:]\s*([^\r\n]*)/u;
const OPTION_MARKER = /(^|\r?\n|[ \t]{2,})([A-H])[.．、]\s*/gu;
const PUBLIC_ANSWER_MARKER = /(?:\*\*|(?:正确)?答案\s*[：:]|解析\s*[：:]|\[correct\]|[✓✔])/iu;
const CONTENT_REVISION = /^sha256:[a-f0-9]{64}$/u;
const TOPIC_ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;
const ITEM_ID = /^ssa-review:q[1-9]\d*:([a-f0-9]{24})$/u;
const SOURCE_TYPES = new Set(["real", "recalled_real"]);
const ACTIONS = new Set(["diagnose", "practice", "review"]);
const CONFIDENCE = new Set(["guess", "unsure", "sure"]);
const SOURCE_REF = "senior-software-architect-review";

export const WEB_CONTENT_REF_VERSION = "web-objective-content-ref.v1";

export class ObjectiveContentError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ObjectiveContentError";
    this.code = code;
  }
}

function contentError(code, message, options) {
  return new ObjectiveContentError(code, message, options);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contentError("INVALID_CONTENT_INPUT", `${label} 必须是对象。`);
  }
  return value;
}

function nonEmptyString(value, label, maximum = 20_000) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw contentError("INVALID_CONTENT_INPUT", `${label} 必须是非空字符串。`);
  }
  return value.trim();
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw contentError("INVALID_CONTENT_INPUT", `${label} 包含未允许字段。`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function utf8Bytes(value) {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

export async function sha256Hex(value) {
  const bytes = utf8Bytes(value);
  if (!(bytes instanceof Uint8Array)) {
    throw contentError("INVALID_CONTENT_INPUT", "SHA-256 输入必须是字符串或 Uint8Array。 ");
  }
  if (!globalThis.crypto?.subtle) {
    throw contentError("CRYPTO_UNAVAILABLE", "当前浏览器不支持 Web Crypto SHA-256。 ");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function splitQuestionBlocks(markdown) {
  const text = nonEmptyString(markdown, "markdown", 4 * 1024 * 1024);
  const headings = [];
  BOUNDARY_HEADING.lastIndex = 0;
  let match;
  while ((match = BOUNDARY_HEADING.exec(text)) !== null) {
    headings.push({
      questionNumber: Number.parseInt(match[1], 10),
      rangeEnd: match[2] === undefined ? null : Number.parseInt(match[2], 10),
      headingStart: match.index,
      bodyStart: BOUNDARY_HEADING.lastIndex,
    });
  }
  return headings.map((heading, index) => deepFreeze({
    questionNumber: heading.questionNumber,
    rangeEnd: heading.rangeEnd,
    block: text.slice(
      heading.bodyStart,
      index + 1 < headings.length ? headings[index + 1].headingStart : text.length,
    ).trim(),
  }));
}

export function hasExactTopicTag(block, rawTags) {
  if (!Array.isArray(rawTags) || rawTags.length === 0) return false;
  return rawTags.some((rawTag) => {
    if (typeof rawTag !== "string" || !/^§\d+(?:\.\d+)?$/u.test(rawTag)) return false;
    return new RegExp(
      `\\*\\*考点\\*\\*\\s*[：:]\\s*${escapeRegExp(rawTag)}(?![\\d.])`,
      "u",
    ).test(block);
  });
}

export function detectSourceType(markdown) {
  return /回忆版/u.test(nonEmptyString(markdown, "markdown", 4 * 1024 * 1024).slice(0, 4_096))
    ? "recalled_real"
    : "real";
}

function normalizeReferenceAnswer(rawAnswer) {
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

export function normalizeSubmittedLabels(response, allowedLabels) {
  const values = Array.isArray(response) ? response : [response];
  if (
    values.length < 1
    || values.length > 8
    || values.some((value) => typeof value !== "string" || value.trim().length === 0)
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
    new Set(labels).size !== labels.length
    || labels.some((label) => !allowedLabels.includes(label))
  ) {
    throw contentError("INVALID_OBJECTIVE_RESPONSE", "客观题作答包含重复或不存在的选项。 ");
  }
  return labels.sort();
}

function parsePromptAndOptions(questionText) {
  const markers = [];
  OPTION_MARKER.lastIndex = 0;
  let match;
  while ((match = OPTION_MARKER.exec(questionText)) !== null) {
    markers.push({
      label: match[2],
      markerStart: match.index + match[1].length,
      contentStart: OPTION_MARKER.lastIndex,
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
  const options = markers.map((marker, index) => ({
    label: marker.label,
    text: questionText.slice(
      marker.contentStart,
      index + 1 < markers.length ? markers[index + 1].markerStart : questionText.length,
    ).trim(),
  }));
  if (!prompt || options.some((option) => !option.text)) {
    throw contentError("UNSUPPORTED_OBJECTIVE_QUESTION", "客观题题干或选项为空。 ");
  }
  const publicText = [prompt, ...options.flatMap((option) => [option.label, option.text])].join("\n");
  if (PUBLIC_ANSWER_MARKER.test(publicText)) {
    throw contentError("ANSWER_GATE_VIOLATION", "公开题面中检测到答案或解析标记。 ");
  }
  return { prompt, options };
}

function validateParseContext(context) {
  const value = plainObject(context, "context");
  const relativePath = nonEmptyString(value.relativePath, "relativePath", 2_000);
  if (
    relativePath.includes("\0")
    || relativePath.includes("\\")
    || relativePath.startsWith("/")
    || relativePath.split("/").includes("..")
    || !relativePath.endsWith(".md")
  ) {
    throw contentError("INVALID_CONTENT_INPUT", "relativePath 必须是安全的 Markdown 相对路径。 ");
  }
  const topicId = nonEmptyString(value.topicId, "topicId", 128);
  if (!TOPIC_ID.test(topicId)) {
    throw contentError("INVALID_CONTENT_INPUT", "topicId 格式无效。 ");
  }
  if (value.subject !== "comprehensive") {
    throw contentError("INVALID_CONTENT_INPUT", "浏览器客观题首期只支持 comprehensive。 ");
  }
  if (!SOURCE_TYPES.has(value.sourceType)) {
    throw contentError("INVALID_CONTENT_INPUT", "sourceType 无效。 ");
  }
  if (!ACTIONS.has(value.action)) {
    throw contentError("INVALID_CONTENT_INPUT", "action 无效。 ");
  }
  const sourceCommit = nonEmptyString(value.sourceCommit, "sourceCommit", 64);
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw contentError("INVALID_CONTENT_INPUT", "sourceCommit 必须是完整 Git SHA。 ");
  }
  return {
    relativePath,
    topicId,
    subject: value.subject,
    sourceType: value.sourceType,
    action: value.action,
    sourceCommit,
  };
}

async function stableItemId(relativePath, questionNumber, prompt, options) {
  const digest = await sha256Hex(
    `${relativePath}#${questionNumber}\0${JSON.stringify({ prompt, options })}`,
  );
  return `ssa-review:q${questionNumber}:${digest.slice(0, 24)}`;
}

export async function parseSingleObjectiveBlock(blockRecord, context) {
  const record = plainObject(blockRecord, "blockRecord");
  if (!Number.isSafeInteger(record.questionNumber) || record.questionNumber < 1) {
    throw contentError("INVALID_CONTENT_INPUT", "questionNumber 必须是正整数。 ");
  }
  if (record.rangeEnd !== null && record.rangeEnd !== undefined) {
    throw contentError("UNSUPPORTED_OBJECTIVE_QUESTION", "组合题只作为边界，不进入首期客观题。 ");
  }
  const block = nonEmptyString(record.block, "block", 512 * 1024);
  const safeContext = validateParseContext(context);
  const answerMatch = ANSWER_LINE.exec(block);
  if (!answerMatch) {
    throw contentError("UNSUPPORTED_OBJECTIVE_QUESTION", "题目缺少受支持的答案标记。 ");
  }
  const questionText = block.slice(0, answerMatch.index).trim();
  const { prompt, options } = parsePromptAndOptions(questionText);
  const correctLabels = normalizeReferenceAnswer(answerMatch[1]);
  const optionLabels = options.map((option) => option.label);
  if (correctLabels.some((label) => !optionLabels.includes(label))) {
    throw contentError("UNSUPPORTED_OBJECTIVE_ANSWER", "答案引用了不存在的选项。 ");
  }
  const afterAnswer = block.slice(answerMatch.index + answerMatch[0].length);
  const explanation = ANALYSIS_LINE.exec(afterAnswer)?.[1]?.trim()
    || "本题依据固定版本题库答案进行确定性判定。";
  const contentRevision = `sha256:${await sha256Hex(block)}`;
  const itemId = await stableItemId(
    safeContext.relativePath,
    record.questionNumber,
    prompt,
    options,
  );
  const publicQuestion = deepFreeze({
    item_id: itemId,
    kind: "multiple_choice",
    subject: safeContext.subject,
    topic_id: safeContext.topicId,
    prompt,
    options,
    source_refs: [SOURCE_REF],
  });
  const contentRef = deepFreeze({
    schema_version: WEB_CONTENT_REF_VERSION,
    source_id: SOURCE_REF,
    source_commit: safeContext.sourceCommit,
    relative_path: safeContext.relativePath,
    question_number: record.questionNumber,
    topic_id: safeContext.topicId,
    subject: safeContext.subject,
    source_type: safeContext.sourceType,
    action: safeContext.action,
    item_id: itemId,
    content_revision: contentRevision,
  });
  const assessment = deepFreeze({
    itemId,
    topicId: safeContext.topicId,
    subject: safeContext.subject,
    optionLabels,
    correctLabels,
    explanation,
    sourceRefs: [SOURCE_REF],
  });
  return deepFreeze({ publicQuestion, contentRef, assessment });
}

const SKIPPABLE_PARSE_CODES = new Set([
  "UNSUPPORTED_OBJECTIVE_QUESTION",
  "UNSUPPORTED_OBJECTIVE_ANSWER",
  "ANSWER_GATE_VIOLATION",
]);

export async function parsePaperCandidates(markdown, { rawTags, ...context } = {}) {
  if (!Array.isArray(rawTags) || rawTags.length === 0) {
    throw contentError("INVALID_CONTENT_INPUT", "rawTags 必须是非空数组。 ");
  }
  const candidates = [];
  for (const blockRecord of splitQuestionBlocks(markdown)) {
    if (blockRecord.rangeEnd !== null || !hasExactTopicTag(blockRecord.block, rawTags)) continue;
    try {
      candidates.push(await parseSingleObjectiveBlock(blockRecord, context));
    } catch (error) {
      if (!SKIPPABLE_PARSE_CODES.has(error?.code)) throw error;
    }
  }
  return deepFreeze(candidates);
}

function validateContentRef(contentRef) {
  const ref = plainObject(contentRef, "contentRef");
  exactKeys(ref, new Set([
    "schema_version",
    "source_id",
    "source_commit",
    "relative_path",
    "question_number",
    "topic_id",
    "subject",
    "source_type",
    "action",
    "item_id",
    "content_revision",
  ]), "contentRef");
  if (
    ref.schema_version !== WEB_CONTENT_REF_VERSION
    || ref.source_id !== SOURCE_REF
    || !/^[a-f0-9]{40}$/u.test(ref.source_commit)
    || !Number.isSafeInteger(ref.question_number)
    || ref.question_number < 1
    || typeof ref.item_id !== "string"
    || !ITEM_ID.test(ref.item_id)
    || typeof ref.content_revision !== "string"
    || !CONTENT_REVISION.test(ref.content_revision)
  ) {
    throw contentError("INVALID_CONTENT_REF", "contentRef 版本或字段无效。 ");
  }
  validateParseContext({
    relativePath: ref.relative_path,
    topicId: ref.topic_id,
    subject: ref.subject,
    sourceType: ref.source_type,
    action: ref.action,
    sourceCommit: ref.source_commit,
  });
  return ref;
}

export async function rehydrateObjectiveQuestion(markdown, contentRef) {
  const ref = validateContentRef(contentRef);
  const block = splitQuestionBlocks(markdown).find((candidate) => (
    candidate.rangeEnd === null && candidate.questionNumber === ref.question_number
  ));
  if (!block) {
    throw contentError("CONTENT_QUESTION_NOT_FOUND", "固定题库中找不到引用的客观题。 ");
  }
  const loaded = await parseSingleObjectiveBlock(block, {
    relativePath: ref.relative_path,
    topicId: ref.topic_id,
    subject: ref.subject,
    sourceType: ref.source_type,
    action: ref.action,
    sourceCommit: ref.source_commit,
  });
  if (
    loaded.publicQuestion.item_id !== ref.item_id
    || loaded.contentRef.content_revision !== ref.content_revision
  ) {
    throw contentError("CONTENT_CHANGED", "题目内容与保存的固定引用不一致。 ");
  }
  return loaded;
}

export function gradeObjectiveAssessment(assessment, response, confidence = "unsure") {
  const value = plainObject(assessment, "assessment");
  if (!CONFIDENCE.has(confidence)) {
    throw contentError("INVALID_OBJECTIVE_RESPONSE", "confidence 必须是 guess、unsure 或 sure。 ");
  }
  const selectedLabels = normalizeSubmittedLabels(response, value.optionLabels);
  const correct = selectedLabels.length === value.correctLabels.length
    && selectedLabels.every((label, index) => label === value.correctLabels[index]);
  const result = !correct ? "not_mastered" : confidence === "sure" ? "mastered" : "needs_retest";
  return deepFreeze({
    grade: {
      schema_version: "web-trusted-objective-grade.v1",
      item_id: value.itemId,
      topic_id: value.topicId,
      subject: value.subject,
      selected_answer: selectedLabels.join("、"),
      reference_answer: value.correctLabels.join("、"),
      correct,
      result,
      score: correct ? 1 : 0,
      max_score: 1,
      explanation: value.explanation,
      source_refs: [...value.sourceRefs],
    },
  });
}
