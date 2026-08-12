import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { CoachError } from "./errors.mjs";
import { assertPrivateDataDirectory } from "./paths.mjs";

export const SESSION_SCHEMA_VERSION = "coach-conversation-session.v1";
export const SESSION_DIRECTORY_NAME = "sessions";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVISION_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.r([1-9][0-9]*)\.json$/;
const SESSION_STATUSES = new Set(["active", "closed"]);
const SESSION_DOCUMENT_KEYS = new Set([
  "schema_version",
  "session_id",
  "revision",
  "status",
  "created_at",
  "updated_at",
  "closed_at",
  "state",
]);

function sessionError(code, message, options = {}) {
  return new CoachError(code, message, { exitCode: 1, ...options });
}

function assertSessionId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    sessionId === "." ||
    sessionId === ".."
  ) {
    throw sessionError(
      "INVALID_SESSION_ID",
      "会话 ID 只能包含字母、数字、点、下划线和连字符，且不能用于目录跳转。",
    );
  }
  return sessionId;
}

function assertRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw sessionError("INVALID_SESSION_REVISION", "会话 revision 必须是正整数。");
  }
  return revision;
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertSafeJsonValue(value, location = "state", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") {
    throw sessionError(
      "INVALID_SESSION_STATE",
      `会话快照 ${location} 不是可恢复的 JSON 值。`,
    );
  }
  if (seen.has(value)) {
    throw sessionError("INVALID_SESSION_STATE", "会话快照不能包含循环引用。");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJsonValue(item, `${location}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw sessionError(
        "INVALID_SESSION_STATE",
        `会话快照 ${location} 必须是普通 JSON 对象。`,
      );
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (
        normalized === "response" ||
        normalized === "rawresponse" ||
        normalized === "userresponse" ||
        normalized.startsWith("trustedauthorization")
      ) {
        throw sessionError(
          "SESSION_SENSITIVE_FIELD_FORBIDDEN",
          "会话存储禁止持久化用户原始 response 或 trustedAuthorization。",
          { details: { field: key } },
        );
      }
      assertSafeJsonValue(item, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function cloneState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw sessionError("INVALID_SESSION_STATE", "会话 state 必须是 JSON 对象。");
  }
  assertSafeJsonValue(state);
  return JSON.parse(JSON.stringify(state));
}

function validateDocument(document, expectedSessionId, expectedRevision) {
  const validObject = document && typeof document === "object" && !Array.isArray(document);
  if (
    !validObject ||
    Object.keys(document).length !== SESSION_DOCUMENT_KEYS.size ||
    Object.keys(document).some((key) => !SESSION_DOCUMENT_KEYS.has(key)) ||
    document.schema_version !== SESSION_SCHEMA_VERSION ||
    document.session_id !== expectedSessionId ||
    document.revision !== expectedRevision ||
    !Number.isSafeInteger(document.revision) ||
    document.revision < 1 ||
    !SESSION_STATUSES.has(document.status) ||
    !isIsoTimestamp(document.created_at) ||
    !isIsoTimestamp(document.updated_at) ||
    !document.state ||
    typeof document.state !== "object" ||
    Array.isArray(document.state) ||
    (document.status === "active" && document.closed_at !== null) ||
    (document.status === "closed" && !isIsoTimestamp(document.closed_at))
  ) {
    throw sessionError(
      "INVALID_SESSION_DOCUMENT",
      `会话 ${expectedSessionId} 的 schema 或 revision 已损坏。`,
    );
  }
  assertSessionId(document.session_id);
  const state = cloneState(document.state);
  return { ...document, state };
}

function nowIso(clock) {
  const value = clock();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!isIsoTimestamp(timestamp)) {
    throw sessionError("INVALID_SESSION_CLOCK", "会话存储时钟必须返回 ISO 时间或 Date。");
  }
  return timestamp;
}

function parseRevisionFileName(fileName) {
  const match = REVISION_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision)) return null;
  return { sessionId: match[1], revision };
}

async function readOwnerOnlyFile(filePath) {
  const pathInfo = await lstat(filePath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw sessionError(
      "INSECURE_SESSION_STORAGE",
      "会话 revision 必须是 owner-only 的普通文件，不能是符号链接。",
    );
  }
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw sessionError(
        "INSECURE_SESSION_STORAGE",
        "会话 revision 不能通过符号链接读取。",
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw sessionError("INSECURE_SESSION_STORAGE", "会话 revision 必须是普通文件。");
    }
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      throw sessionError("INSECURE_SESSION_STORAGE", "会话 revision 文件权限必须为 0600。");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ConversationSessionStore {
  constructor({
    dataDirectory,
    clock = () => new Date(),
    idFactory = randomUUID,
    afterPublish = async () => {},
  }) {
    this.dataDirectory = assertPrivateDataDirectory(dataDirectory);
    this.sessionDirectory = path.join(this.dataDirectory, SESSION_DIRECTORY_NAME);
    this.clock = clock;
    this.idFactory = idFactory;
    this.afterPublish = afterPublish;
  }

  async ensureDirectory() {
    assertPrivateDataDirectory(this.dataDirectory);
    await mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.sessionDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw sessionError(
        "INSECURE_SESSION_STORAGE",
        "sessions 必须是 owner-only 的普通目录，不能是符号链接。",
      );
    }
    if (process.platform !== "win32") await chmod(this.sessionDirectory, 0o700);
  }

  revisionPath(sessionId, revision) {
    const safeId = assertSessionId(sessionId);
    const safeRevision = assertRevision(revision);
    const candidate = path.join(this.sessionDirectory, `${safeId}.r${safeRevision}.json`);
    if (path.dirname(candidate) !== this.sessionDirectory) {
      throw sessionError("INVALID_SESSION_ID", "会话 revision 路径越界。");
    }
    return candidate;
  }

  async revisionNumbers(sessionId) {
    const safeId = assertSessionId(sessionId);
    await this.ensureDirectory();
    const entries = await readdir(this.sessionDirectory, { withFileTypes: true });
    const revisions = [];
    for (const entry of entries) {
      const parsed = parseRevisionFileName(entry.name);
      if (!parsed || parsed.sessionId !== safeId) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw sessionError(
          "INSECURE_SESSION_STORAGE",
          `会话 ${safeId} 的 revision ${parsed.revision} 不是安全的普通文件。`,
        );
      }
      revisions.push(parsed.revision);
    }
    return revisions.sort((left, right) => left - right);
  }

  async readRevision(sessionId, revision) {
    const safeId = assertSessionId(sessionId);
    const safeRevision = assertRevision(revision);
    let text;
    try {
      text = await readOwnerOnlyFile(this.revisionPath(safeId, safeRevision));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw sessionError("SESSION_NOT_FOUND", `找不到会话 ${safeId} revision ${safeRevision}。`);
      }
      throw error;
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw sessionError(
        "INVALID_SESSION_DOCUMENT",
        `会话 ${safeId} revision ${safeRevision} 不是有效 JSON。`,
        { cause: error },
      );
    }
    return validateDocument(document, safeId, safeRevision);
  }

  async readHead(sessionId, { required = true } = {}) {
    const safeId = assertSessionId(sessionId);
    const revisions = await this.revisionNumbers(safeId);
    if (revisions.length === 0) {
      if (!required) return null;
      throw sessionError("SESSION_NOT_FOUND", `找不到会话 ${safeId}。`);
    }
    if (revisions[0] !== 1) {
      throw sessionError(
        "INVALID_SESSION_DOCUMENT",
        `会话 ${safeId} 的 revision 序列没有从 1 开始。`,
      );
    }
    let current = null;
    let expected = 1;
    for (const revision of revisions) {
      if (revision !== expected) break;
      try {
        current = await this.readRevision(safeId, revision);
      } catch (error) {
        if (current && error?.code === "INVALID_SESSION_DOCUMENT") break;
        throw error;
      }
      expected += 1;
    }
    return current;
  }

  async publish(document, { conflictCode, expectedRevision }) {
    await this.ensureDirectory();
    const safeDocument = validateDocument(
      document,
      document.session_id,
      document.revision,
    );
    const destination = this.revisionPath(safeDocument.session_id, safeDocument.revision);
    const temporary = path.join(
      this.sessionDirectory,
      `.${safeDocument.session_id}.r${safeDocument.revision}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(safeDocument, null, 2)}\n`, "utf8");
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        throw sessionError(
          conflictCode,
          conflictCode === "SESSION_ALREADY_EXISTS"
            ? `会话 ${safeDocument.session_id} 已存在。`
            : `会话 ${safeDocument.session_id} 的 revision ${safeDocument.revision} 已被其他写入者发布。`,
          {
            cause: error,
            details: {
              expectedRevision,
              actualRevision: safeDocument.revision,
            },
          },
        );
      }
      await syncDirectory(this.sessionDirectory);
      await this.afterPublish(Object.freeze({
        sessionId: safeDocument.session_id,
        revision: safeDocument.revision,
        filePath: destination,
      }));
      return safeDocument;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async create({ sessionId = this.idFactory(), state = {} } = {}) {
    const safeId = assertSessionId(sessionId);
    const safeState = cloneState(state);
    if (await this.readHead(safeId, { required: false })) {
      throw sessionError("SESSION_ALREADY_EXISTS", `会话 ${safeId} 已存在。`);
    }
    const timestamp = nowIso(this.clock);
    return this.publish({
      schema_version: SESSION_SCHEMA_VERSION,
      session_id: safeId,
      revision: 1,
      status: "active",
      created_at: timestamp,
      updated_at: timestamp,
      closed_at: null,
      state: safeState,
    }, {
      conflictCode: "SESSION_ALREADY_EXISTS",
      expectedRevision: 0,
    });
  }

  async load(sessionId) {
    return this.readHead(assertSessionId(sessionId));
  }

  async save(sessionId, { expectedRevision, state } = {}) {
    const safeId = assertSessionId(sessionId);
    assertRevision(expectedRevision);
    const safeState = cloneState(state);
    const current = await this.readHead(safeId);
    if (current.revision !== expectedRevision) {
      throw sessionError(
        "SESSION_REVISION_CONFLICT",
        `会话 ${safeId} 已从 revision ${expectedRevision} 更新到 ${current.revision}。`,
        { details: { expectedRevision, actualRevision: current.revision } },
      );
    }
    if (current.status !== "active") {
      throw sessionError("SESSION_CLOSED", `会话 ${safeId} 已关闭，不能继续保存。`);
    }
    return this.publish({
      ...current,
      revision: current.revision + 1,
      updated_at: nowIso(this.clock),
      state: safeState,
    }, {
      conflictCode: "SESSION_REVISION_CONFLICT",
      expectedRevision,
    });
  }

  async listActive() {
    await this.ensureDirectory();
    const entries = await readdir(this.sessionDirectory, { withFileTypes: true });
    const sessionIds = new Set();
    for (const entry of entries) {
      const parsed = parseRevisionFileName(entry.name);
      if (parsed) sessionIds.add(parsed.sessionId);
    }
    const active = [];
    for (const sessionId of sessionIds) {
      const document = await this.readHead(sessionId);
      if (document.status === "active") active.push(document);
    }
    return active.sort((left, right) => (
      right.updated_at.localeCompare(left.updated_at) ||
      left.session_id.localeCompare(right.session_id)
    ));
  }

  async close(sessionId, { expectedRevision, state } = {}) {
    const safeId = assertSessionId(sessionId);
    assertRevision(expectedRevision);
    const safeState = state === undefined ? null : cloneState(state);
    const current = await this.readHead(safeId);
    if (current.revision !== expectedRevision) {
      throw sessionError(
        "SESSION_REVISION_CONFLICT",
        `会话 ${safeId} 已从 revision ${expectedRevision} 更新到 ${current.revision}。`,
        { details: { expectedRevision, actualRevision: current.revision } },
      );
    }
    if (current.status === "closed") return current;
    const timestamp = nowIso(this.clock);
    return this.publish({
      ...current,
      revision: current.revision + 1,
      status: "closed",
      updated_at: timestamp,
      closed_at: timestamp,
      state: safeState ?? current.state,
    }, {
      conflictCode: "SESSION_REVISION_CONFLICT",
      expectedRevision,
    });
  }
}
