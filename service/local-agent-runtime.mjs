import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { inspectEmployeeHostCompatibility } from "@fullstack-ai-infra/digital-employee/host-runtime";

import { DigitalEmployeeHostRunner } from "./host-runner.mjs";
import { employeePackageDirectory, repositoryRoot } from "./paths.mjs";
import { validateTeachingOutput } from "./proposal-validator.mjs";
import { validateEmployeeInput, validateEmployeeOutput } from "./schema-validator.mjs";

export const LOOPBACK_PROTOCOL = "coach-loopback.v1";
export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_LOOPBACK_PORT = 43_127;

const DEFAULT_DOCS_ROOT = path.join(repositoryRoot, "docs");
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_MAX_STATIC_BYTES = 8 * 1024 * 1024;
const MAX_IDEMPOTENCY_RESULTS = 64;
const MAX_BEARER_HASHES = 4;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_TOPIC_ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;
const SAFE_REASON_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const OBJECTIVE_ANSWER = /^[A-H](?:[、,][A-H])*$/u;
const UNSAFE_INPUT_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const ABSOLUTE_POSIX_PATH = /(?:\/(?:Users|home|private|etc|tmp|var|opt|Library|Volumes|Applications|System|usr|bin|sbin|dev|proc|sys|run)(?:\/[^\s/\\<>"'`]+)+|(?:^|[^\p{L}\p{N}/])\/(?!\/)(?:[^\s/\\<>"'`]+\/)+[^\s/\\<>"'`]+)/iu;
const ABSOLUTE_WINDOWS_PATH = /(?:^|[^\p{L}\p{N}])[A-Za-z]:[\\/][^\s<>"'`]+/u;
const SENSITIVE_CREDENTIAL_TEXT = /(?:\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD)\b|\b(?:api[_ -]?key|access[_ -]?token|password|secret)\b\s*(?::|：|=|是|为))/iu;
const HIDDEN_ANSWER_HINT = /(?:答案|解析|应(?:该)?选|请选择|正确选项(?:是|为)?|选项\s*[A-H]\s*(?:正确|更合适)|[A-H]\s*(?:项)?\s*(?:才是|为)?正确|(?:answer|correct\s+(?:answer|option))\s*(?:is|[:：])?\s*[A-H]\b)/iu;
const SUBJECTS = new Set(["comprehensive", "case", "essay"]);
const RESULTS = new Set(["mastered", "not_mastered", "needs_retest"]);
const QUESTION_KINDS = new Set([
  "diagnostic_question",
  "multiple_choice",
  "review_prompt",
  "mock_section",
  "case_task",
  "essay_task",
]);
const SOURCE_REFS = new Set([
  "senior-software-architect-review",
  "user-supplied-local-review-material",
]);
const ENGINE_CATALOG = Object.freeze([
  Object.freeze({ id: "claude-code", label: "Claude Code" }),
  Object.freeze({ id: "qoder", label: "Qoder CLI" }),
  Object.freeze({ id: "codex", label: "Codex CLI" }),
  Object.freeze({ id: "qwen-code", label: "Qwen Code" }),
  Object.freeze({ id: "codebuddy", label: "CodeBuddy Code" }),
]);
const ENGINE_IDS = new Set(ENGINE_CATALOG.map(({ id }) => id));
const PUBLIC_HOST_STATUSES = new Set(["ready", "installed", "not_ready", "not_found", "probe_failed"]);
const JSON_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});
const STATIC_MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

const PUBLIC_ERRORS = Object.freeze({
  ADAPTER_NOT_FOUND: [404, "adapter_not_found"],
  ADAPTER_NOT_SELECTABLE: [409, "adapter_not_selectable"],
  AGENT_BUSY: [409, "agent_busy"],
  AGENT_OUTPUT_REJECTED: [502, "agent_output_rejected"],
  AGENT_RUN_FAILED: [502, "agent_run_failed"],
  AUTH_REQUIRED: [401, "authentication_required"],
  BODY_TOO_LARGE: [413, "request_body_too_large"],
  CONTENT_TYPE_REQUIRED: [415, "application_json_required"],
  HOST_HEADER_INVALID: [421, "loopback_host_required"],
  IDEMPOTENCY_CONFLICT: [409, "idempotency_key_conflict"],
  INVALID_IDEMPOTENCY_KEY: [400, "invalid_idempotency_key"],
  INVALID_JSON: [400, "invalid_json"],
  INVALID_REQUEST: [400, "invalid_request"],
  METHOD_NOT_ALLOWED: [405, "method_not_allowed"],
  NOT_FOUND: [404, "not_found"],
  ORIGIN_NOT_ALLOWED: [403, "origin_not_allowed"],
  PROTOCOL_REQUIRED: [400, "protocol_header_required"],
  RUNTIME_INTERNAL: [500, "runtime_internal_error"],
  STATIC_FORBIDDEN: [403, "static_path_forbidden"],
  STATIC_NOT_FOUND: [404, "static_asset_not_found"],
  STATIC_READ_FAILED: [500, "static_asset_read_failed"],
});

class RuntimeRequestError extends Error {
  constructor(code) {
    super(code);
    this.name = "RuntimeRequestError";
    this.code = code;
  }
}

function requestError(code) {
  return new RuntimeRequestError(code);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function containsSensitiveText(value) {
  if (typeof value === "string") {
    return (
      SENSITIVE_CREDENTIAL_TEXT.test(value)
      || ABSOLUTE_POSIX_PATH.test(value)
      || ABSOLUTE_WINDOWS_PATH.test(value)
      || /(?:^|[^\p{L}\p{N}])~[\\/]/u.test(value)
      || /\bfile:\/\//iu.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsSensitiveText);
  if (value && typeof value === "object") return Object.values(value).some(containsSensitiveText);
  return false;
}

function exactObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError("INVALID_REQUEST");
  }
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowedKeys.includes(key))
    || requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw requestError("INVALID_REQUEST");
  }
  return value;
}

function boundedText(value, maximum, { pattern, trim = false } = {}) {
  if (typeof value !== "string") throw requestError("INVALID_REQUEST");
  const result = trim ? value.trim() : value;
  if (
    result.length < 1
    || result.length > maximum
    || UNSAFE_INPUT_TEXT.test(result)
    || (pattern && !pattern.test(result))
  ) {
    throw requestError("INVALID_REQUEST");
  }
  return result;
}

function exactStringArray(value, { maximum, pattern, allowed } = {}) {
  if (
    !Array.isArray(value)
    || value.length > maximum
    || value.some((item) => typeof item !== "string")
    || new Set(value).size !== value.length
    || value.some((item) => pattern && !pattern.test(item))
    || value.some((item) => allowed && !allowed.has(item))
  ) {
    throw requestError("INVALID_REQUEST");
  }
  return [...value];
}

function validateQuestion(value) {
  exactObject(
    value,
    ["item_id", "kind", "subject", "topic_id", "prompt", "options", "source_refs"],
    ["item_id", "kind", "subject", "topic_id", "prompt", "source_refs"],
  );
  const question = {
    item_id: boundedText(value.item_id, 128, { pattern: SAFE_IDENTIFIER }),
    kind: boundedText(value.kind, 64),
    subject: boundedText(value.subject, 32),
    topic_id: boundedText(value.topic_id, 128, { pattern: SAFE_TOPIC_ID }),
    prompt: boundedText(value.prompt, 20_000),
    source_refs: exactStringArray(value.source_refs, { maximum: 8, allowed: SOURCE_REFS }),
  };
  if (!QUESTION_KINDS.has(question.kind) || !SUBJECTS.has(question.subject)) {
    throw requestError("INVALID_REQUEST");
  }
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 8) {
      throw requestError("INVALID_REQUEST");
    }
    const labels = new Set();
    question.options = value.options.map((option) => {
      exactObject(option, ["label", "text"]);
      const normalized = {
        label: boundedText(option.label, 8),
        text: boundedText(option.text, 2_000),
      };
      if (labels.has(normalized.label)) throw requestError("INVALID_REQUEST");
      labels.add(normalized.label);
      return normalized;
    });
  }
  return question;
}

function validateTrustedGrade(value, question) {
  exactObject(value, [
    "schema_version",
    "item_id",
    "topic_id",
    "subject",
    "selected_answer",
    "reference_answer",
    "correct",
    "result",
    "score",
    "max_score",
    "explanation",
    "source_refs",
  ]);
  const grade = {
    schema_version: boundedText(value.schema_version, 64),
    item_id: boundedText(value.item_id, 128, { pattern: SAFE_IDENTIFIER }),
    topic_id: boundedText(value.topic_id, 128, { pattern: SAFE_TOPIC_ID }),
    subject: boundedText(value.subject, 32),
    selected_answer: boundedText(value.selected_answer, 128, { pattern: OBJECTIVE_ANSWER }),
    reference_answer: boundedText(value.reference_answer, 128, { pattern: OBJECTIVE_ANSWER }),
    correct: value.correct,
    result: boundedText(value.result, 32),
    score: value.score,
    max_score: value.max_score,
    explanation: boundedText(value.explanation, 10_000),
    source_refs: exactStringArray(value.source_refs, { maximum: 8, allowed: SOURCE_REFS }),
  };
  if (
    grade.schema_version !== "web-trusted-objective-grade.v1"
    || grade.item_id !== question.item_id
    || grade.topic_id !== question.topic_id
    || grade.subject !== question.subject
    || typeof grade.correct !== "boolean"
    || !RESULTS.has(grade.result)
    || grade.max_score !== 1
    || grade.score !== (grade.correct ? 1 : 0)
    || (!grade.correct && grade.result !== "not_mastered")
    || (grade.correct && !["mastered", "needs_retest"].includes(grade.result))
    || !isDeepStrictEqual(grade.source_refs, question.source_refs)
  ) {
    throw requestError("INVALID_REQUEST");
  }
  return grade;
}

function validateProgress(value) {
  exactObject(value, [
    "schema_version",
    "subjects",
    "target_subject",
    "maintenance_subject",
    "crunch_mode",
    "days_to_exam",
    "recommendations",
  ]);
  // The employee input schema is the final source of truth for every nested
  // progress field. This exact outer shape prevents identity/path extensions.
  return cloneJson(value);
}

function normalizeCoachRequest(value) {
  exactObject(
    value,
    ["phase", "engine", "public_question", "trusted_grade", "deidentified_progress", "message"],
    ["phase", "engine", "public_question", "deidentified_progress"],
  );
  const phase = boundedText(value.phase, 16);
  if (!new Set(["submit", "chat"]).has(phase)) throw requestError("INVALID_REQUEST");
  const engine = boundedText(value.engine, 64);
  if (!ENGINE_IDS.has(engine)) throw requestError("ADAPTER_NOT_FOUND");
  const publicQuestion = value.public_question === null && phase === "chat"
    ? null
    : validateQuestion(value.public_question);
  const progress = validateProgress(value.deidentified_progress);
  const hasTrustedGrade = value.trusted_grade !== undefined && value.trusted_grade !== null;
  if (hasTrustedGrade && !publicQuestion) throw requestError("INVALID_REQUEST");
  const trustedGrade = hasTrustedGrade
    ? validateTrustedGrade(value.trusted_grade, publicQuestion)
    : null;
  const message = value.message === undefined
    ? null
    : boundedText(value.message, 2_000, { trim: true });
  if (message !== null && containsSensitiveText(message)) {
    throw requestError("INVALID_REQUEST");
  }
  if (
    (phase === "submit" && (!publicQuestion || !trustedGrade || message !== null))
    || (phase === "chat" && (
      message === null
      || (trustedGrade !== null && !publicQuestion)
      || (publicQuestion !== null && trustedGrade === null)
    ))
  ) {
    throw requestError("INVALID_REQUEST");
  }
  if (containsSensitiveText({ publicQuestion, trustedGrade, progress, message })) {
    throw requestError("INVALID_REQUEST");
  }
  return {
    phase,
    engine,
    publicQuestion,
    trustedGrade,
    progress,
    message,
  };
}

function approvedMaterial(question, grade) {
  const excerpt = grade
    ? JSON.stringify({
      trusted_grade: {
        item_id: grade.item_id,
        subject: grade.subject,
        topic_id: grade.topic_id,
        result: grade.result,
        reference_answer: grade.reference_answer,
        explanation: grade.explanation,
        source_refs: grade.source_refs,
      },
    })
    : "The public question is bound in request.active_item. Do not alter it or reveal its answer.";
  if (excerpt.length > 20_000) throw requestError("INVALID_REQUEST");
  return {
    source_id: question.source_refs[0] || "senior-software-architect-review",
    locator: `question:${question.item_id}`,
    excerpt,
  };
}

async function buildEmployeeInput(request) {
  const isEvaluation = Boolean(request.trustedGrade);
  const action = isEvaluation ? "submit" : (request.publicQuestion ? "practice" : "review");
  const input = {
    schema_version: "architect-pass-coach-input.v1",
    action,
    context: { authenticated: true },
    request: {
      mode: isEvaluation ? "evaluate" : "generate",
      ...(request.publicQuestion
        ? {
          subject: request.publicQuestion.subject,
          topic_ids: [request.publicQuestion.topic_id],
          question_ids: [request.publicQuestion.item_id],
        }
        : {}),
      ...(request.message ? { message: request.message } : {}),
      progress_snapshot: request.progress,
      ...(request.publicQuestion
        ? {
          active_item: request.publicQuestion,
          approved_materials: [approvedMaterial(request.publicQuestion, request.trustedGrade)],
        }
        : {}),
      ...(isEvaluation
        ? {
          submission: {
            item_id: request.publicQuestion.item_id,
            response: request.trustedGrade.selected_answer,
          },
        }
        : {}),
    },
  };
  try {
    await validateEmployeeInput(input);
  } catch {
    throw requestError("INVALID_REQUEST");
  }
  return { action, input };
}

function validateSubmissionFacts(output, request) {
  const result = output.teaching_result;
  const grade = request.trustedGrade;
  if (
    result.status !== "completed"
    || result.scope !== "personalized"
    || result.learning_items.length !== 0
    || result.feedback.length !== 1
    || result.assessments.length !== 1
    || output.proposed_progress_events.length !== 1
  ) {
    throw requestError("AGENT_OUTPUT_REJECTED");
  }
  const expectedFeedback = {
    item_id: grade.item_id,
    result: grade.result,
    reference_answer: grade.reference_answer,
    explanation: grade.explanation,
    source_refs: grade.source_refs,
  };
  if (!isDeepStrictEqual(result.feedback[0], expectedFeedback)) {
    throw requestError("AGENT_OUTPUT_REJECTED");
  }
  const assessment = result.assessments[0];
  const event = output.proposed_progress_events[0];
  if (
    assessment.subject !== grade.subject
    || assessment.topic_id !== grade.topic_id
    || assessment.result !== grade.result
    || event.event_type !== "practice_result"
    || event.subject !== grade.subject
    || event.topic_id !== grade.topic_id
    || event.result !== grade.result
    || event.evidence?.item_id !== grade.item_id
    || event.proposal_only !== true
    || event.requires_authenticated_context !== true
  ) {
    throw requestError("AGENT_OUTPUT_REJECTED");
  }
}

function validateQuestionFacts(output, request) {
  const result = output.teaching_result;
  const expectedItems = request.publicQuestion ? [request.publicQuestion] : [];
  if (
    result.status !== "completed"
    || result.scope !== "personalized"
    || result.feedback.length !== 0
    || result.assessments.length !== 0
    || output.proposed_progress_events.length !== 0
    || !isDeepStrictEqual(result.learning_items, expectedItems)
  ) {
    throw requestError("AGENT_OUTPUT_REJECTED");
  }
}

const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/gu;
const CONTROL_AND_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export function sanitizeCoachingText(value) {
  if (typeof value !== "string") throw requestError("AGENT_OUTPUT_REJECTED");
  let result = value
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_AND_BIDI, "")
    .replace(/\r\n?/gu, "\n")
    .trim();
  result = result.slice(0, 2_000);
  if (/\p{Surrogate}$/u.test(result)) result = result.slice(0, -1);
  if (!result) throw requestError("AGENT_OUTPUT_REJECTED");
  return result;
}

function adapterReasonCodes(host, compatibility) {
  const raw = [
    ...(Array.isArray(host?.issues) ? host.issues : []),
    ...(Array.isArray(compatibility?.issues) ? compatibility.issues : []),
  ];
  return [...new Set(raw
    .map((issue) => issue?.code)
    .filter((code) => typeof code === "string" && SAFE_REASON_CODE.test(code)))]
    .slice(0, 16);
}

function isSelectableAdapter(host, compatibility) {
  return (
    host?.status === "ready"
    && host?.available === true
    && host?.adapterStatus === "runnable"
    && compatibility?.compatible === true
  );
}

function adapterState(host, compatibility) {
  if (isSelectableAdapter(host, compatibility)) return "ready";
  if (host?.adapterStatus === "probe_only") return "probe_only";
  if (Array.isArray(compatibility?.missing) && compatibility.missing.includes("structured_output")) {
    return "incompatible";
  }
  if (host?.status === "not_ready") return "needs_configuration";
  if (host?.status === "installed") return "ready_unverified";
  if (["not_found", "probe_failed"].includes(host?.status)) return "unavailable";
  return "incompatible";
}

function publicAdapter(entry, inspection) {
  if (!inspection) {
    return {
      id: entry.id,
      label: entry.label,
      state: "unavailable",
      selectable: false,
      reason_codes: ["adapter_inspection_failed"],
    };
  }
  const { host, compatibility } = inspection;
  const state = adapterState(host, compatibility);
  return {
    id: entry.id,
    label: entry.label,
    state,
    selectable: isSelectableAdapter(host, compatibility),
    host_status: PUBLIC_HOST_STATUSES.has(host?.status) ? host.status : "probe_failed",
    adapter_status: host?.adapterStatus === "runnable" ? "runnable" : "probe_only",
    reason_codes: adapterReasonCodes(host, compatibility),
  };
}

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function tokenMatches(token, hashes) {
  if (!TOKEN_PATTERN.test(token)) return false;
  const candidate = hashToken(token);
  return hashes.some((expected) => (
    expected.length === candidate.length && timingSafeEqual(expected, candidate)
  ));
}

function safeErrorResult(error) {
  const code = error instanceof RuntimeRequestError && PUBLIC_ERRORS[error.code]
    ? error.code
    : "RUNTIME_INTERNAL";
  const [statusCode, reasonCode] = PUBLIC_ERRORS[code];
  return {
    statusCode,
    body: {
      protocol: LOOPBACK_PROTOCOL,
      status: "error",
      reason_code: reasonCode,
    },
  };
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(body);
}

function sendEmpty(response, statusCode, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    "Content-Length": "0",
    ...extraHeaders,
  });
  response.end();
}

async function readRequestBody(request, maximumBytes) {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw requestError("INVALID_REQUEST");
    if (length > maximumBytes) throw requestError("BODY_TOO_LARGE");
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.once("end", () => {
      if (tooLarge) reject(requestError("BODY_TOO_LARGE"));
      else resolve(Buffer.concat(chunks));
    });
    request.once("error", () => reject(requestError("INVALID_REQUEST")));
    request.once("aborted", () => reject(requestError("INVALID_REQUEST")));
  });
}

async function readJson(request, maximumBytes, { allowEmpty = false } = {}) {
  if (request.headers["content-encoding"] !== undefined) {
    throw requestError("INVALID_REQUEST");
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw requestError("CONTENT_TYPE_REQUIRED");
  }
  const body = await readRequestBody(request, maximumBytes);
  if (body.length === 0 && allowEmpty) return { body, value: {} };
  try {
    return { body, value: JSON.parse(body.toString("utf8")) };
  } catch {
    throw requestError("INVALID_JSON");
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function rawPathname(requestTarget) {
  const end = requestTarget.search(/[?#]/u);
  return end < 0 ? requestTarget : requestTarget.slice(0, end);
}

function decodeStaticSegments(requestTarget) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname(requestTarget));
  } catch {
    throw requestError("STATIC_FORBIDDEN");
  }
  if (!pathname.startsWith("/") || pathname.includes("\0") || pathname.includes("\\")) {
    throw requestError("STATIC_FORBIDDEN");
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw requestError("STATIC_FORBIDDEN");
  }
  if (pathname.endsWith("/") || segments.length === 0) segments.push("index.html");
  return segments;
}

async function openStaticAsset(root, requestTarget, maximumBytes) {
  const segments = decodeStaticSegments(requestTarget);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw requestError("STATIC_NOT_FOUND");
      }
      throw requestError("STATIC_READ_FAILED");
    }
    if (info.isSymbolicLink()) throw requestError("STATIC_FORBIDDEN");
  }
  let canonical;
  try {
    canonical = await realpath(current);
  } catch {
    throw requestError("STATIC_NOT_FOUND");
  }
  if (!isWithin(root, canonical)) throw requestError("STATIC_FORBIDDEN");
  const handle = await open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw requestError("STATIC_NOT_FOUND");
    if (info.size > maximumBytes) throw requestError("STATIC_READ_FAILED");
    const body = await handle.readFile();
    if (body.length > maximumBytes) throw requestError("STATIC_READ_FAILED");
    return { body, extension: path.extname(canonical).toLowerCase() };
  } finally {
    await handle.close();
  }
}

/**
 * Same-origin loopback facade. The browser Harness remains the only owner of
 * learner state and deterministic grading; this runtime only performs a
 * package-validated, one-shot coaching run and discards all event proposals.
 */
export class LocalAgentRuntime {
  constructor({
    docsRoot = DEFAULT_DOCS_ROOT,
    port = DEFAULT_LOOPBACK_PORT,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    maxStaticBytes = DEFAULT_MAX_STATIC_BYTES,
    inspectAdapter = inspectEmployeeHostCompatibility,
    runnerFactory = ({ engine }) => new DigitalEmployeeHostRunner({ engine }),
    tokenFactory = () => randomBytes(32).toString("base64url"),
    serverFactory = createServer,
    employeeDirectory = employeePackageDirectory,
  } = {}) {
    if (!Number.isSafeInteger(port) || (port !== 0 && port < 1_024) || port > 65_535) {
      throw new TypeError("port_must_be_0_or_1024_to_65535");
    }
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
      throw new TypeError("maxBodyBytes_must_be_positive");
    }
    this.docsRoot = path.resolve(docsRoot);
    this.port = port;
    this.maxBodyBytes = maxBodyBytes;
    this.maxStaticBytes = maxStaticBytes;
    this.inspectAdapter = inspectAdapter;
    this.runnerFactory = runnerFactory;
    this.tokenFactory = tokenFactory;
    this.serverFactory = serverFactory;
    this.employeeDirectory = employeeDirectory;
    this.server = null;
    this.canonicalDocsRoot = null;
    this.exactHost = null;
    this.origin = null;
    this.bearerHashes = [];
    this.idempotency = new Map();
    this.runBusy = false;
    this.instanceId = randomUUID();
  }

  get url() {
    return this.origin ? `${this.origin}/` : null;
  }

  async start() {
    if (this.server) throw new TypeError("runtime_already_started");
    const rootInfo = await lstat(this.docsRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new TypeError("docsRoot_must_be_a_real_directory");
    }
    this.canonicalDocsRoot = await realpath(this.docsRoot);
    const server = this.serverFactory((request, response) => {
      this.#handle(request, response).catch((error) => {
        if (!response.headersSent) {
          const result = safeErrorResult(error);
          sendJson(response, result.statusCode, result.body);
        } else {
          response.destroy();
        }
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 130_000;
    server.keepAliveTimeout = 5_000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, LOOPBACK_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
      await new Promise((resolve) => server.close(resolve));
      throw new TypeError("runtime_failed_to_bind_ipv4_loopback");
    }
    this.server = server;
    this.exactHost = `${LOOPBACK_HOST}:${address.port}`;
    this.origin = `http://${this.exactHost}`;
    return { url: this.url, host: LOOPBACK_HOST, port: address.port, protocol: LOOPBACK_PROTOCOL };
  }

  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.bearerHashes.length = 0;
    this.idempotency.clear();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
    });
    this.exactHost = null;
    this.origin = null;
  }

  async inspect(engine) {
    const entry = ENGINE_CATALOG.find((candidate) => candidate.id === engine);
    if (!entry) throw requestError("ADAPTER_NOT_FOUND");
    let inspection;
    try {
      inspection = await this.inspectAdapter({
        directory: this.employeeDirectory,
        engine,
      });
    } catch {
      inspection = null;
    }
    return publicAdapter(entry, inspection);
  }

  async #handle(request, response) {
    this.#assertHost(request);
    const pathname = rawPathname(request.url || "/");
    if (pathname === "/v1/health") {
      if (request.method !== "GET") throw requestError("METHOD_NOT_ALLOWED");
      sendJson(response, 200, {
        protocol: LOOPBACK_PROTOCOL,
        status: "ready",
        instance_id: this.instanceId,
        authentication: "bootstrap_required",
        agent_run_busy: this.runBusy,
      });
      return;
    }
    if (pathname === "/v1/bootstrap") {
      if (request.method !== "POST") throw requestError("METHOD_NOT_ALLOWED");
      this.#assertProtocol(request);
      this.#assertExactOrigin(request, { required: true });
      const { value } = await readJson(request, this.maxBodyBytes, { allowEmpty: true });
      exactObject(value, ["protocol"], []);
      if (value.protocol !== undefined && value.protocol !== LOOPBACK_PROTOCOL) {
        throw requestError("PROTOCOL_REQUIRED");
      }
      const token = this.tokenFactory();
      if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
        throw requestError("RUNTIME_INTERNAL");
      }
      this.bearerHashes.push(hashToken(token));
      if (this.bearerHashes.length > MAX_BEARER_HASHES) this.bearerHashes.shift();
      sendJson(response, 200, {
        protocol: LOOPBACK_PROTOCOL,
        status: "ready",
        access_token: token,
        instance_id: this.instanceId,
      });
      return;
    }
    if (pathname === "/v1/adapters") {
      if (request.method !== "GET") throw requestError("METHOD_NOT_ALLOWED");
      this.#assertProtected(request);
      const adapters = await Promise.all(ENGINE_CATALOG.map(({ id }) => this.inspect(id)));
      sendJson(response, 200, { protocol: LOOPBACK_PROTOCOL, adapters });
      return;
    }
    const preflight = /^\/v1\/adapters\/([A-Za-z0-9-]+)\/preflight$/u.exec(pathname);
    if (preflight) {
      if (request.method !== "POST") throw requestError("METHOD_NOT_ALLOWED");
      this.#assertProtected(request);
      const { value } = await readJson(request, this.maxBodyBytes, { allowEmpty: true });
      exactObject(value, [], []);
      const adapter = await this.inspect(preflight[1]);
      sendJson(response, 200, { protocol: LOOPBACK_PROTOCOL, adapter });
      return;
    }
    if (pathname === "/v1/coach") {
      if (request.method !== "POST") throw requestError("METHOD_NOT_ALLOWED");
      this.#assertProtected(request);
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw requestError("INVALID_IDEMPOTENCY_KEY");
      }
      const { body, value } = await readJson(request, this.maxBodyBytes);
      await this.#handleCoach(response, idempotencyKey, body, value);
      return;
    }
    if (pathname.startsWith("/v1/")) throw requestError("NOT_FOUND");
    if (!new Set(["GET", "HEAD"]).has(request.method)) throw requestError("METHOD_NOT_ALLOWED");
    const asset = await openStaticAsset(
      this.canonicalDocsRoot,
      request.url || "/",
      this.maxStaticBytes,
    );
    const cacheControl = asset.extension === ".html"
      ? "no-cache"
      : "public, max-age=300, must-revalidate";
    const headers = {
      "Cache-Control": cacheControl,
      "Content-Length": asset.body.length,
      "Content-Type": STATIC_MIME_TYPES[asset.extension] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    };
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : asset.body);
  }

  #assertHost(request) {
    if (
      request.headers.host !== this.exactHost
      || request.headers["forwarded"] !== undefined
      || request.headers["x-forwarded-host"] !== undefined
      || request.headers["x-forwarded-for"] !== undefined
      || request.headers["x-forwarded-proto"] !== undefined
    ) {
      throw requestError("HOST_HEADER_INVALID");
    }
  }

  #assertProtocol(request) {
    if (request.headers["x-coach-protocol"] !== LOOPBACK_PROTOCOL) {
      throw requestError("PROTOCOL_REQUIRED");
    }
  }

  #assertExactOrigin(request, { required = false } = {}) {
    const origin = request.headers.origin;
    if ((required && origin !== this.origin) || (origin !== undefined && origin !== this.origin)) {
      throw requestError("ORIGIN_NOT_ALLOWED");
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin") {
      throw requestError("ORIGIN_NOT_ALLOWED");
    }
  }

  #assertProtected(request) {
    this.#assertProtocol(request);
    this.#assertExactOrigin(request);
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      throw requestError("AUTH_REQUIRED");
    }
    const token = authorization.slice("Bearer ".length);
    if (!tokenMatches(token, this.bearerHashes)) throw requestError("AUTH_REQUIRED");
  }

  async #handleCoach(response, idempotencyKey, rawBody, value) {
    const digest = createHash("sha256").update(rawBody).digest("hex");
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) {
      if (existing.digest !== digest) throw requestError("IDEMPOTENCY_CONFLICT");
      const replay = await existing.result;
      sendJson(response, replay.statusCode, replay.body, { "Idempotency-Replayed": "true" });
      return;
    }
    if (this.runBusy) throw requestError("AGENT_BUSY");
    const normalized = normalizeCoachRequest(value);
    this.runBusy = true;
    const result = this.#runCoach(normalized)
      .then((body) => ({ statusCode: 200, body }))
      .catch((error) => safeErrorResult(error))
      .finally(() => { this.runBusy = false; });
    this.idempotency.set(idempotencyKey, { digest, result });
    this.#trimIdempotency();
    const completed = await result;
    sendJson(response, completed.statusCode, completed.body);
  }

  #trimIdempotency() {
    while (this.idempotency.size > MAX_IDEMPOTENCY_RESULTS) {
      const first = this.idempotency.keys().next().value;
      this.idempotency.delete(first);
    }
  }

  async #runCoach(request) {
    const { action, input } = await buildEmployeeInput(request);
    const adapter = await this.inspect(request.engine);
    if (!adapter.selectable) throw requestError("ADAPTER_NOT_SELECTABLE");
    let output;
    try {
      const runner = this.runnerFactory({ engine: request.engine });
      if (!runner || typeof runner.preflight !== "function" || typeof runner.run !== "function") {
        throw new Error("invalid_runner");
      }
      await runner.preflight();
      output = await runner.run(input, { runId: `loopback-${randomUUID()}` });
    } catch {
      throw requestError("AGENT_RUN_FAILED");
    }
    try {
      await validateEmployeeOutput(output);
      validateTeachingOutput(output, {
        action,
        // Local validation identity is never included in employee input or API output.
        context: { authenticated: true, user_id: "local:00000000-0000-4000-8000-000000000000" },
      });
      if (request.trustedGrade) validateSubmissionFacts(output, request);
      else validateQuestionFacts(output, request);
      const summary = sanitizeCoachingText(output.teaching_result.summary);
      if (
        containsSensitiveText(summary)
        || (request.publicQuestion && !request.trustedGrade && HIDDEN_ANSWER_HINT.test(summary))
      ) {
        throw requestError("AGENT_OUTPUT_REJECTED");
      }
      return {
        protocol: LOOPBACK_PROTOCOL,
        status: "completed",
        phase: request.phase,
        engine: request.engine,
        coaching_text: summary,
        answer_visibility: request.trustedGrade ? "revealed_after_submission" : "hidden",
        progress_write: "not_performed",
      };
    } catch (error) {
      if (error instanceof RuntimeRequestError) throw error;
      throw requestError("AGENT_OUTPUT_REJECTED");
    }
  }
}

export function createLocalAgentRuntime(options) {
  return new LocalAgentRuntime(options);
}
