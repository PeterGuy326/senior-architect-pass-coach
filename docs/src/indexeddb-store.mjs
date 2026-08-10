import { applyObjectiveAttempt, createBlankProgress } from "./progress-rules.mjs";

export const WEB_COACH_DB_NAME = "senior-architect-pass-coach";
export const WEB_COACH_DB_VERSION = 1;
export const WEB_COACH_EXPORT_VERSION = "web-coach-export.v1";

const STORES = Object.freeze({
  profiles: "profiles",
  progress: "topicState",
  attempts: "attempts",
  sessions: "sessions",
  meta: "meta",
});
const ACTIVE_SESSION_STATES = new Set(["ready", "loading", "awaiting_answer", "feedback"]);
const PRIVATE_CONTENT_KEYS = new Set([
  "response",
  "question",
  "prompt",
  "options",
  "answer",
  "selected_answer",
  "reference_answer",
  "explanation",
  "analysis",
  "assessment_bundle",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function error(code, message) {
  const value = new Error(message);
  value.code = code;
  return value;
}

function assertContentFree(value, label) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_CONTENT_KEYS.has(key.toLowerCase())) {
      throw error("PRIVATE_CONTENT_FORBIDDEN", `${label} 禁止持久化 ${key}。`);
    }
    assertContentFree(child, label);
  }
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || error("IDB_REQUEST_FAILED", "浏览器存储请求失败。")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || error("IDB_TRANSACTION_ABORTED", "浏览器存储事务已回滚。")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || error("IDB_TRANSACTION_FAILED", "浏览器存储事务失败。")), { once: true });
  });
}

function sameAttempt(left, right) {
  const keys = [
    "attempt_id", "item_id", "topic_id", "subject", "skill", "score", "max_score",
    "confidence", "result", "at", "source_ref", "content_revision",
  ];
  return keys.every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
}

function validateProfile(profile) {
  if (
    !profile ||
    profile.id !== "self" ||
    profile.schema_version !== "web-learner-profile.v1" ||
    profile.authorization !== "local-browser-owner" ||
    typeof profile.principal_id !== "string" ||
    !profile.principal_id.startsWith("local:")
  ) {
    throw error("INVALID_LOCAL_PROFILE", "导入档案不是有效的浏览器本地授权档案。");
  }
  assertContentFree(profile, "本地档案");
}

function validateProgress(progress) {
  if (!progress || progress.id !== "current" || progress.schema_version !== "web-progress.v1") {
    throw error("INVALID_PROGRESS", "浏览器进度版本无效。");
  }
  assertContentFree(progress, "学习进度");
}

function validateSession(session) {
  if (
    !session ||
    typeof session.session_id !== "string" ||
    session.session_id.length < 1 ||
    !Number.isSafeInteger(session.revision) ||
    session.revision < 0
  ) {
    throw error("INVALID_SESSION", "学习会话无效。");
  }
  assertContentFree(session, "学习会话");
}

function normalizeImport(payload) {
  if (!payload || payload.schema_version !== WEB_COACH_EXPORT_VERSION) {
    throw error("INVALID_IMPORT", "学习数据导出版本不受支持。");
  }
  validateProfile(payload.profile);
  validateProgress(payload.progress);
  if (!Array.isArray(payload.attempts) || !Array.isArray(payload.sessions)) {
    throw error("INVALID_IMPORT", "导入数据缺少 attempts 或 sessions。");
  }
  const attempts = clone(payload.attempts).sort((left, right) => String(left.at).localeCompare(String(right.at))
    || String(left.attempt_id).localeCompare(String(right.attempt_id)));
  const replayed = attempts.reduce(
    (state, attempt) => applyObjectiveAttempt(state, attempt).progress,
    createBlankProgress({ now: payload.progress.created_at }),
  );
  if (replayed.applied_attempt_ids.length !== payload.attempts.length) {
    throw error("INVALID_IMPORT", "导入作答存在重复 attempt_id。");
  }
  payload.sessions.forEach(validateSession);
  attempts.forEach((attempt) => assertContentFree(attempt, "作答证据"));
  return clone({ ...payload, attempts, progress: replayed });
}

async function abortWith(transaction, done, failure) {
  transaction.abort();
  await done.catch(() => {});
  throw failure;
}

class ChangePublisher {
  constructor({ broadcastChannelFactory, channelName = `${WEB_COACH_DB_NAME}:changes` } = {}) {
    this.listeners = new Set();
    const factory = broadcastChannelFactory === undefined
      ? (typeof globalThis.BroadcastChannel === "function" ? (name) => new globalThis.BroadcastChannel(name) : null)
      : broadcastChannelFactory;
    this.channel = typeof factory === "function" ? factory(channelName) : null;
    this.onMessage = (event) => this.#emit(event?.data, false);
    this.channel?.addEventListener?.("message", this.onMessage);
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener_function_required");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(change) {
    this.#emit(change, true);
  }

  #emit(change, broadcast) {
    const safe = clone(change);
    for (const listener of this.listeners) listener(safe);
    if (broadcast) this.channel?.postMessage?.(safe);
  }

  close() {
    this.channel?.removeEventListener?.("message", this.onMessage);
    this.channel?.close?.();
    this.listeners.clear();
  }
}

export class IndexedDbCoachStore {
  constructor({ indexedDB = globalThis.indexedDB, dbName = WEB_COACH_DB_NAME, broadcastChannelFactory } = {}) {
    if (!indexedDB?.open) throw error("INDEXEDDB_UNAVAILABLE", "此浏览器不支持私人学习进度存储。");
    this.indexedDB = indexedDB;
    this.dbName = dbName;
    this.publisher = new ChangePublisher({ broadcastChannelFactory, channelName: `${dbName}:changes` });
    this.databasePromise = null;
  }

  async open() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.dbName, WEB_COACH_DB_VERSION);
        request.addEventListener("upgradeneeded", () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORES.profiles)) database.createObjectStore(STORES.profiles, { keyPath: "id" });
          if (!database.objectStoreNames.contains(STORES.progress)) database.createObjectStore(STORES.progress, { keyPath: "id" });
          if (!database.objectStoreNames.contains(STORES.attempts)) database.createObjectStore(STORES.attempts, { keyPath: "attempt_id" });
          if (!database.objectStoreNames.contains(STORES.sessions)) database.createObjectStore(STORES.sessions, { keyPath: "session_id" });
          if (!database.objectStoreNames.contains(STORES.meta)) database.createObjectStore(STORES.meta, { keyPath: "key" });
        });
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error || error("INDEXEDDB_OPEN_FAILED", "无法打开浏览器私人存储。")), { once: true });
        request.addEventListener("blocked", () => reject(error("INDEXEDDB_BLOCKED", "请关闭其他旧版本页面后重试。")), { once: true });
      });
    }
    return this.databasePromise;
  }

  subscribe(listener) {
    return this.publisher.subscribe(listener);
  }

  async initialize({ profile, progress }) {
    validateProfile(profile);
    validateProgress(progress);
    const database = await this.open();
    const transaction = database.transaction([STORES.profiles, STORES.progress], "readwrite");
    const done = transactionDone(transaction);
    const profileStore = transaction.objectStore(STORES.profiles);
    const progressStore = transaction.objectStore(STORES.progress);
    const existingProfile = await requestValue(profileStore.get("self"));
    const existingProgress = await requestValue(progressStore.get("current"));
    if (!existingProfile) profileStore.put(clone(profile));
    if (!existingProgress) progressStore.put(clone(progress));
    await done;
    const value = {
      profile: clone(existingProfile || profile),
      progress: clone(existingProgress || progress),
      created: !existingProfile,
    };
    if (value.created) this.publisher.publish({ type: "initialized" });
    return value;
  }

  async getProfile() {
    const database = await this.open();
    const transaction = database.transaction(STORES.profiles, "readonly");
    return clone(await requestValue(transaction.objectStore(STORES.profiles).get("self")) || null);
  }

  async getProgress() {
    const database = await this.open();
    const transaction = database.transaction(STORES.progress, "readonly");
    return clone(await requestValue(transaction.objectStore(STORES.progress).get("current")) || null);
  }

  async getSession(sessionId) {
    const database = await this.open();
    const transaction = database.transaction(STORES.sessions, "readonly");
    return clone(await requestValue(transaction.objectStore(STORES.sessions).get(sessionId)) || null);
  }

  async listSessions() {
    const database = await this.open();
    const transaction = database.transaction(STORES.sessions, "readonly");
    const values = await requestValue(transaction.objectStore(STORES.sessions).getAll());
    return clone(values.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))));
  }

  async getActiveSessions() {
    return (await this.listSessions()).filter((session) => ACTIVE_SESSION_STATES.has(session.state));
  }

  async getUniqueActiveSession() {
    const active = await this.getActiveSessions();
    if (active.length > 1) {
      throw error("AMBIGUOUS_ACTIVE_SESSION", "本浏览器存在多个活动学习会话，已拒绝猜测要恢复哪一个。");
    }
    return active[0] || null;
  }

  async putSession(rawSession, { expectedRevision = null } = {}) {
    validateSession(rawSession);
    const database = await this.open();
    const transaction = database.transaction(STORES.sessions, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORES.sessions);
    const [existing, allSessions] = await Promise.all([
      requestValue(store.get(rawSession.session_id)),
      requestValue(store.getAll()),
    ]);
    if (expectedRevision === null) {
      if (existing) {
        return abortWith(transaction, done, error("SESSION_EXISTS", "学习会话已经存在。"));
      }
      if (
        ACTIVE_SESSION_STATES.has(rawSession.state)
        && allSessions.some((session) => ACTIVE_SESSION_STATES.has(session.state))
      ) {
        return abortWith(transaction, done, error("ACTIVE_SESSION_EXISTS", "本浏览器已经存在活动学习会话，请先恢复它。"));
      }
    } else if (!existing || existing.revision !== expectedRevision) {
      return abortWith(transaction, done, error("REVISION_CONFLICT", "学习会话已在其他页面更新，请刷新后继续。"));
    }
    const session = clone(rawSession);
    session.revision = expectedRevision === null ? 0 : expectedRevision + 1;
    store.put(session);
    await done;
    this.publisher.publish({ type: "session", session_id: session.session_id, revision: session.revision });
    return clone(session);
  }

  async commitAttempt({ expectedRevision, sessionId, expectedItemId, attempt, feedback }) {
    assertContentFree(attempt, "作答证据");
    assertContentFree(feedback, "反馈摘要");
    const database = await this.open();
    const transaction = database.transaction(
      [STORES.attempts, STORES.progress, STORES.sessions],
      "readwrite",
    );
    const done = transactionDone(transaction);
    const attemptStore = transaction.objectStore(STORES.attempts);
    const progressStore = transaction.objectStore(STORES.progress);
    const sessionStore = transaction.objectStore(STORES.sessions);
    const [existingAttempt, currentProgress, currentSession] = await Promise.all([
      requestValue(attemptStore.get(attempt.attempt_id)),
      requestValue(progressStore.get("current")),
      requestValue(sessionStore.get(sessionId)),
    ]);
    if (existingAttempt) {
      if (!sameAttempt(existingAttempt, attempt)) {
        return abortWith(transaction, done, error("ATTEMPT_CONFLICT", "相同 attempt_id 对应了不同判定。"));
      }
      await done;
      return { attempt: clone(existingAttempt), progress: clone(currentProgress), session: clone(currentSession), replayed: true };
    }
    if (!currentSession || currentSession.revision !== expectedRevision) {
      return abortWith(transaction, done, error("REVISION_CONFLICT", "学习会话已在其他页面更新，请刷新后继续。"));
    }
    if (currentSession.active_item_ref?.item_id !== expectedItemId || attempt.item_id !== expectedItemId) {
      return abortWith(transaction, done, error("ACTIVE_ITEM_CONFLICT", "提交题目不是当前活动题目。"));
    }
    const applied = applyObjectiveAttempt(currentProgress, attempt);
    const nextSession = {
      ...currentSession,
      state: "feedback",
      revision: currentSession.revision + 1,
      feedback: clone(feedback),
      updated_at: attempt.at,
    };
    validateSession(nextSession);
    attemptStore.put(clone(attempt));
    progressStore.put(clone(applied.progress));
    sessionStore.put(nextSession);
    await done;
    this.publisher.publish({ type: "attempt", session_id: sessionId, revision: nextSession.revision });
    return {
      attempt: clone(attempt),
      progress: clone(applied.progress),
      session: clone(nextSession),
      replayed: false,
    };
  }

  async exportData({ now = new Date().toISOString() } = {}) {
    const database = await this.open();
    const transaction = database.transaction(Object.values(STORES), "readonly");
    const [profile, progress, attempts, sessions] = await Promise.all([
      requestValue(transaction.objectStore(STORES.profiles).get("self")),
      requestValue(transaction.objectStore(STORES.progress).get("current")),
      requestValue(transaction.objectStore(STORES.attempts).getAll()),
      requestValue(transaction.objectStore(STORES.sessions).getAll()),
    ]);
    const payload = {
      schema_version: WEB_COACH_EXPORT_VERSION,
      exported_at: now,
      profile: clone(profile),
      progress: clone(progress),
      attempts: clone(attempts),
      sessions: clone(sessions),
    };
    assertContentFree(payload, "导出数据");
    return payload;
  }

  async importData(rawPayload) {
    const payload = normalizeImport(rawPayload);
    const database = await this.open();
    const transaction = database.transaction(Object.values(STORES), "readwrite");
    const done = transactionDone(transaction);
    for (const name of Object.values(STORES)) transaction.objectStore(name).clear();
    transaction.objectStore(STORES.profiles).put(payload.profile);
    transaction.objectStore(STORES.progress).put(payload.progress);
    payload.attempts.forEach((attempt) => transaction.objectStore(STORES.attempts).put(attempt));
    payload.sessions.forEach((session) => transaction.objectStore(STORES.sessions).put(session));
    transaction.objectStore(STORES.meta).put({ key: "last_import_at", value: new Date().toISOString() });
    await done;
    this.publisher.publish({ type: "imported" });
    return this.exportData();
  }

  async clear() {
    const database = await this.open();
    const transaction = database.transaction(Object.values(STORES), "readwrite");
    const done = transactionDone(transaction);
    for (const name of Object.values(STORES)) transaction.objectStore(name).clear();
    await done;
    this.publisher.publish({ type: "cleared" });
  }

  close() {
    this.publisher.close();
    this.databasePromise?.then((database) => database.close()).catch(() => {});
    this.databasePromise = null;
  }
}

export class MemoryCoachStore {
  constructor() {
    this.profile = null;
    this.progress = null;
    this.attempts = new Map();
    this.sessions = new Map();
    this.publisher = new ChangePublisher({ broadcastChannelFactory: null });
  }

  async open() { return this; }
  subscribe(listener) { return this.publisher.subscribe(listener); }
  async initialize({ profile, progress }) {
    validateProfile(profile);
    validateProgress(progress);
    const created = !this.profile;
    this.profile ||= clone(profile);
    this.progress ||= clone(progress);
    return { profile: clone(this.profile), progress: clone(this.progress), created };
  }
  async getProfile() { return clone(this.profile); }
  async getProgress() { return clone(this.progress); }
  async getSession(id) { return clone(this.sessions.get(id) || null); }
  async listSessions() {
    return [...this.sessions.values()]
      .map(clone)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }
  async getActiveSessions() {
    return (await this.listSessions()).filter((session) => ACTIVE_SESSION_STATES.has(session.state));
  }
  async getUniqueActiveSession() {
    const active = await this.getActiveSessions();
    if (active.length > 1) throw error("AMBIGUOUS_ACTIVE_SESSION", "本浏览器存在多个活动学习会话，已拒绝猜测要恢复哪一个。");
    return active[0] || null;
  }
  async putSession(rawSession, { expectedRevision = null } = {}) {
    validateSession(rawSession);
    const existing = this.sessions.get(rawSession.session_id);
    if (expectedRevision === null ? Boolean(existing) : existing?.revision !== expectedRevision) {
      throw error(expectedRevision === null ? "SESSION_EXISTS" : "REVISION_CONFLICT", "学习会话版本冲突。");
    }
    if (
      expectedRevision === null
      && ACTIVE_SESSION_STATES.has(rawSession.state)
      && [...this.sessions.values()].some((session) => ACTIVE_SESSION_STATES.has(session.state))
    ) {
      throw error("ACTIVE_SESSION_EXISTS", "本浏览器已经存在活动学习会话，请先恢复它。");
    }
    const session = { ...clone(rawSession), revision: expectedRevision === null ? 0 : expectedRevision + 1 };
    this.sessions.set(session.session_id, session);
    this.publisher.publish({ type: "session", session_id: session.session_id, revision: session.revision });
    return clone(session);
  }
  async commitAttempt({ expectedRevision, sessionId, expectedItemId, attempt, feedback }) {
    assertContentFree(attempt, "作答证据");
    assertContentFree(feedback, "反馈摘要");
    const existingAttempt = this.attempts.get(attempt.attempt_id);
    if (existingAttempt) {
      if (!sameAttempt(existingAttempt, attempt)) throw error("ATTEMPT_CONFLICT", "相同 attempt_id 对应了不同判定。");
      return { attempt: clone(existingAttempt), progress: clone(this.progress), session: clone(this.sessions.get(sessionId)), replayed: true };
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.revision !== expectedRevision) throw error("REVISION_CONFLICT", "学习会话版本冲突。");
    if (session.active_item_ref?.item_id !== expectedItemId || attempt.item_id !== expectedItemId) {
      throw error("ACTIVE_ITEM_CONFLICT", "提交题目不是当前活动题目。");
    }
    const applied = applyObjectiveAttempt(this.progress, attempt);
    const nextSession = { ...session, state: "feedback", revision: session.revision + 1, feedback: clone(feedback), updated_at: attempt.at };
    validateSession(nextSession);
    this.attempts.set(attempt.attempt_id, clone(attempt));
    this.progress = clone(applied.progress);
    this.sessions.set(sessionId, nextSession);
    this.publisher.publish({ type: "attempt", session_id: sessionId, revision: nextSession.revision });
    return { attempt: clone(attempt), progress: clone(this.progress), session: clone(nextSession), replayed: false };
  }
  async exportData({ now = new Date().toISOString() } = {}) {
    const payload = {
      schema_version: WEB_COACH_EXPORT_VERSION,
      exported_at: now,
      profile: clone(this.profile),
      progress: clone(this.progress),
      attempts: [...this.attempts.values()].map(clone),
      sessions: [...this.sessions.values()].map(clone),
    };
    assertContentFree(payload, "导出数据");
    return payload;
  }
  async importData(rawPayload) {
    const payload = normalizeImport(rawPayload);
    this.profile = clone(payload.profile);
    this.progress = clone(payload.progress);
    this.attempts = new Map(payload.attempts.map((attempt) => [attempt.attempt_id, clone(attempt)]));
    this.sessions = new Map(payload.sessions.map((session) => [session.session_id, clone(session)]));
    this.publisher.publish({ type: "imported" });
    return this.exportData();
  }
  async clear() {
    this.profile = null;
    this.progress = null;
    this.attempts.clear();
    this.sessions.clear();
    this.publisher.publish({ type: "cleared" });
  }
  close() { this.publisher.close(); }
}

export function createIndexedDbStore(options) {
  return new IndexedDbCoachStore(options);
}

export function createMemoryCoachStore() {
  return new MemoryCoachStore();
}
