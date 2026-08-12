import {
  ObjectiveContentError,
  detectSourceType,
  gradeObjectiveAssessment,
  hasExactTopicTag,
  parsePaperCandidates,
  rehydrateObjectiveQuestion,
  sha256Hex,
  splitQuestionBlocks,
} from "./objective-parser.mjs";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const PINNED_CONTENT_SOURCE = deepFreeze({
  schema_version: "web-content-source.v1",
  source_id: "senior-software-architect-review",
  license: "NOASSERTION",
  content_included: false,
  curriculum: {
    repository: "PeterGuy326/senior-architect-pass-coach",
    commit: "6136d3dfc771276867c41404787eb881c07db8bc",
    path: "config/curriculum.json",
    sha256: "sha256:add2159a15803965d1adcdfdf20280650f836230c617184f58d6208124069c2b",
  },
  papers: {
    repository: "PeterGuy326/senior-software-architect-review",
    commit: "88f4bdc58e668ac887f2f06e152f69a1c129edd1",
    files: [
      ["2025上.md", "d9563b54c32f4a87526d74f1c3cd6a4fc138f740511b7e8b3f671da468b072dc", "recalled_real"],
      ["2023下.md", "7d030281911fd0148b2017d51b2b2629b437f740905b16af37b8896e5a42ff2b", "recalled_real"],
      ["2022.md", "c9d2a70d8f79727795a19766962090e3db8bb8aab2809ddba47a6b81287cfc08", "real"],
      ["2021.md", "099bcd631653cecfef4b1f8e3c07c9438e65ffcbef92295f5148a062f297283b", "real"],
      ["2020.md", "f8610e3d5e3c1201808d3e7bc7206d55790a309641f990e0996c91e8cc0320c6", "recalled_real"],
      ["2019下.md", "8ae7fb55e9972454509a28fb5c94059a5f7b67d43efc0cd01ebed0efdd39007c", "real"],
      ["2018下.md", "a97e96b84d2492bed4b17e93f9fe8e91287fd776012bed972579bf26ab85644f", "real"],
    ].map(([name, digest, sourceType]) => ({
      path: `past-papers/comprehensive-by-year/${name}`,
      sha256: `sha256:${digest}`,
      source_type: sourceType,
    })),
  },
  limits: {
    timeout_ms: 10_000,
    max_file_bytes: 262_144,
    max_total_bytes: 1_048_576,
  },
});

function fail(code, message, options) {
  return new ObjectiveContentError(code, message, options);
}

function encodePath(filePath) {
  return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function uncheckedRawUrl(repository, commit, filePath) {
  const [owner, name] = repository.split("/");
  return `https://raw.githubusercontent.com/${owner}/${name}/${commit}/${encodePath(filePath)}`;
}

const ALLOWED_TUPLES = [
  PINNED_CONTENT_SOURCE.curriculum,
  ...PINNED_CONTENT_SOURCE.papers.files.map((file) => ({
    repository: PINNED_CONTENT_SOURCE.papers.repository,
    commit: PINNED_CONTENT_SOURCE.papers.commit,
    path: file.path,
  })),
];
const ALLOWED_URLS = new Set(ALLOWED_TUPLES.map((entry) => (
  uncheckedRawUrl(entry.repository, entry.commit, entry.path)
)));

export function rawUrlForPinnedFile(repository, commit, filePath) {
  const url = uncheckedRawUrl(repository, commit, filePath);
  if (!ALLOWED_URLS.has(url)) {
    throw fail("CONTENT_URL_FORBIDDEN", "只允许读取固定提交中的白名单题库文件。 ");
  }
  return url;
}

export function assertAllowedRawUrl(value) {
  let url;
  try {
    url = new URL(value).href;
  } catch (error) {
    throw fail("CONTENT_URL_FORBIDDEN", "题库 URL 无效。", { cause: error });
  }
  if (!ALLOWED_URLS.has(url)) {
    throw fail("CONTENT_URL_FORBIDDEN", "题库 URL 不在固定白名单中。 ");
  }
  return url;
}

function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

export function validateContentSource(source) {
  if (!sameJson(source, PINNED_CONTENT_SOURCE)) {
    throw fail("INVALID_CONTENT_SOURCE", "内容清单必须与应用内置的固定来源完全一致。 ");
  }
  return PINNED_CONTENT_SOURCE;
}

export function createByteBudget(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw fail("INVALID_CONTENT_LIMIT", "总字节上限无效。 ");
  }
  let used = 0;
  return Object.freeze({
    consume(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || used + bytes > maximumBytes) {
        throw fail("CONTENT_TOTAL_TOO_LARGE", "本轮题库读取超过总字节上限。 ");
      }
      used += bytes;
      return used;
    },
    get used() {
      return used;
    },
    get remaining() {
      return maximumBytes - used;
    },
    maximumBytes,
  });
}

async function readBoundedResponse(response, maximumBytes, budget) {
  const declared = Number.parseInt(response.headers?.get?.("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw fail("CONTENT_FILE_TOO_LARGE", "固定题库文件超过单文件上限。 ");
  }
  if (Number.isFinite(declared) && declared > budget.remaining) {
    throw fail("CONTENT_TOTAL_TOO_LARGE", "本轮题库读取超过总字节上限。 ");
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw fail("CONTENT_FILE_TOO_LARGE", "固定题库文件超过单文件上限。 ");
    }
    budget.consume(bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw fail("CONTENT_FETCH_FAILED", "固定题库返回了无效字节流。 ");
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw fail("CONTENT_FILE_TOO_LARGE", "固定题库文件超过单文件上限。 ");
      }
      if (total > budget.remaining) {
        await reader.cancel();
        throw fail("CONTENT_TOTAL_TOO_LARGE", "本轮题库读取超过总字节上限。 ");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  budget.consume(total);
  return bytes;
}

export async function fetchBoundedUtf8(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = PINNED_CONTENT_SOURCE.limits.timeout_ms,
  maximumBytes = PINNED_CONTENT_SOURCE.limits.max_file_bytes,
  budget = createByteBudget(PINNED_CONTENT_SOURCE.limits.max_total_bytes),
} = {}) {
  const safeUrl = assertAllowedRawUrl(url);
  if (typeof fetchImpl !== "function") throw fail("CONTENT_FETCH_UNAVAILABLE", "浏览器不支持 fetch。 ");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw fail("INVALID_CONTENT_LIMIT", "读取超时时间无效。 ");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 4 * 1024 * 1024) {
    throw fail("INVALID_CONTENT_LIMIT", "单文件字节上限无效。 ");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(safeUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "force-cache",
      signal: controller.signal,
      headers: { Accept: "text/plain, application/json;q=0.9" },
    });
    if (!response?.ok) throw fail("CONTENT_FETCH_FAILED", "固定题库返回非成功状态。 ");
    const bytes = await readBoundedResponse(response, maximumBytes, budget);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof ObjectiveContentError) throw error;
    throw fail(
      controller.signal.aborted ? "CONTENT_FETCH_TIMEOUT" : "CONTENT_FETCH_FAILED",
      controller.signal.aborted ? "读取固定题库超时。" : "读取固定题库失败。",
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

function validateTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw fail("INVALID_CONTENT_TASK", "选题任务必须是对象。 ");
  }
  if (
    task.subject !== "comprehensive"
    || typeof task.topic_id !== "string"
    || !/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u.test(task.topic_id)
    || !new Set(["diagnose", "practice", "review"]).has(task.action)
  ) {
    throw fail("UNSUPPORTED_PHASE1_TASK", "浏览器首期只支持综合知识客观题。 ");
  }
  return task;
}

function validateUsedItemIds(value) {
  if (value === undefined) return new Set();
  if (
    !Array.isArray(value)
    || value.length > 5_000
    || value.some((item) => typeof item !== "string" || item.length > 256)
  ) {
    throw fail("INVALID_CONTENT_TASK", "usedItemIds 无效。 ");
  }
  return new Set(value);
}

export class GitHubObjectiveRepository {
  constructor({ fetchImpl = globalThis.fetch, source = PINNED_CONTENT_SOURCE } = {}) {
    this.source = validateContentSource(source);
    this.fetchImpl = fetchImpl;
    this.budget = createByteBudget(this.source.limits.max_total_bytes);
    this.cache = new Map();
  }

  async #load(repository, commit, entry) {
    const url = rawUrlForPinnedFile(repository, commit, entry.path);
    if (!this.cache.has(url)) {
      this.cache.set(url, (async () => {
        const text = await fetchBoundedUtf8(url, {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.source.limits.timeout_ms,
          maximumBytes: this.source.limits.max_file_bytes,
          budget: this.budget,
        });
        if (`sha256:${await sha256Hex(text)}` !== entry.sha256) {
          throw fail("CONTENT_DIGEST_MISMATCH", "固定题库文件摘要校验失败。 ");
        }
        return text;
      })());
    }
    try {
      return await this.cache.get(url);
    } catch (error) {
      this.cache.delete(url);
      throw error;
    }
  }

  async loadCurriculum() {
    const entry = this.source.curriculum;
    const text = await this.#load(entry.repository, entry.commit, entry);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw fail("INVALID_CONTENT_INDEX", "固定课程索引不是有效 JSON。", { cause: error });
    }
  }

  async loadPaper(entry) {
    const text = await this.#load(
      this.source.papers.repository,
      this.source.papers.commit,
      entry,
    );
    if (detectSourceType(text) !== entry.source_type) {
      throw fail("CONTENT_SOURCE_TYPE_MISMATCH", "题卷来源类型与固定清单不一致。 ");
    }
    return text;
  }

  async issue({ task, usedItemIds } = {}) {
    const safeTask = validateTask(task);
    const used = validateUsedItemIds(usedItemIds);
    const curriculum = await this.loadCurriculum();
    const topic = Array.isArray(curriculum?.topics)
      ? curriculum.topics.find((item) => item?.id === safeTask.topic_id)
      : null;
    const rawTags = Array.isArray(topic?.raw_tags)
      ? topic.raw_tags.filter((tag) => typeof tag === "string" && /^§\d+(?:\.\d+)?$/u.test(tag))
      : [];
    if (rawTags.length === 0) {
      throw fail("CONTENT_TOPIC_NOT_MAPPED", "该考点没有可用的历年题标签。 ");
    }
    for (const entry of this.source.papers.files) {
      const markdown = await this.loadPaper(entry);
      const candidates = await parsePaperCandidates(markdown, {
        rawTags,
        relativePath: entry.path,
        topicId: safeTask.topic_id,
        subject: safeTask.subject,
        sourceType: entry.source_type,
        action: safeTask.action,
        sourceCommit: this.source.papers.commit,
      });
      const candidate = candidates.find((item) => !used.has(item.publicQuestion.item_id));
      if (candidate) return candidate;
    }
    throw fail("OBJECTIVE_CONTENT_NOT_FOUND", "固定题库中没有未使用的安全客观题。 ");
  }

  async rehydrate(contentRef) {
    if (
      !contentRef
      || typeof contentRef !== "object"
      || contentRef.source_commit !== this.source.papers.commit
    ) {
      throw fail("INVALID_CONTENT_REF", "contentRef 不属于固定题库提交。 ");
    }
    const entry = this.source.papers.files.find((item) => item.path === contentRef.relative_path);
    if (!entry || entry.source_type !== contentRef.source_type) {
      throw fail("INVALID_CONTENT_REF", "contentRef 文件不在固定白名单中。 ");
    }
    const [curriculum, markdown] = await Promise.all([
      this.loadCurriculum(),
      this.loadPaper(entry),
    ]);
    const topic = Array.isArray(curriculum?.topics)
      ? curriculum.topics.find((item) => item?.id === contentRef.topic_id)
      : null;
    const rawTags = Array.isArray(topic?.raw_tags)
      ? topic.raw_tags.filter((tag) => typeof tag === "string" && /^§\d+(?:\.\d+)?$/u.test(tag))
      : [];
    const block = splitQuestionBlocks(markdown).find((candidate) => (
      candidate.rangeEnd === null && candidate.questionNumber === contentRef.question_number
    ));
    if (!block || !hasExactTopicTag(block.block, rawTags)) {
      throw fail("INVALID_CONTENT_REF", "contentRef 的考点映射与固定题库不一致。 ");
    }
    return rehydrateObjectiveQuestion(markdown, contentRef);
  }

  async grade({ contentRef, response, confidence = "unsure" } = {}) {
    const loaded = await this.rehydrate(contentRef);
    return gradeObjectiveAssessment(loaded.assessment, response, confidence);
  }
}

export function createGitHubObjectiveRepository(options) {
  return new GitHubObjectiveRepository(options);
}
