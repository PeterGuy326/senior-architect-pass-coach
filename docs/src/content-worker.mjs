import { createGitHubObjectiveRepository } from "./github-content.mjs";

function validateEnvelope(message) {
  if (
    !message
    || typeof message !== "object"
    || Array.isArray(message)
    || !(typeof message.id === "string" || Number.isSafeInteger(message.id))
    || !new Set(["issue", "rehydrate", "grade"]).has(message.type)
    || !message.payload
    || typeof message.payload !== "object"
    || Array.isArray(message.payload)
  ) {
    throw Object.assign(new Error("Worker 请求格式无效。"), { code: "INVALID_WORKER_REQUEST" });
  }
  return message;
}

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "CONTENT_WORKER_FAILED",
    message: typeof error?.message === "string" && error.message.length <= 512
      ? error.message
      : "浏览器题库处理失败。",
  };
}

export function createContentWorkerHandler({ repository = createGitHubObjectiveRepository() } = {}) {
  if (!repository?.issue || !repository?.rehydrate || !repository?.grade) {
    throw new TypeError("content_repository_required");
  }
  return async function handleContentWorkerMessage(message) {
    const id = message?.id ?? null;
    try {
      const request = validateEnvelope(message);
      if (request.type === "issue") {
        const issued = await repository.issue(request.payload);
        return {
          id: request.id,
          ok: true,
          result: {
            publicQuestion: issued.publicQuestion,
            contentRef: issued.contentRef,
          },
        };
      }
      if (request.type === "rehydrate") {
        const restored = await repository.rehydrate(request.payload.contentRef);
        return {
          id: request.id,
          ok: true,
          result: {
            publicQuestion: restored.publicQuestion,
            contentRef: restored.contentRef,
          },
        };
      }
      const graded = await repository.grade(request.payload);
      return { id: request.id, ok: true, result: { grade: graded.grade } };
    } catch (error) {
      return { id, ok: false, error: safeError(error) };
    }
  };
}

export function installContentWorker(scope, handler = createContentWorkerHandler()) {
  if (!scope?.addEventListener || !scope?.postMessage) throw new TypeError("worker_scope_required");
  scope.addEventListener("message", async (event) => {
    scope.postMessage(await handler(event.data));
  });
}

const isDedicatedWorkerScope = (
  typeof globalThis.document === "undefined"
  && typeof globalThis.addEventListener === "function"
  && typeof globalThis.postMessage === "function"
  && typeof globalThis.close === "function"
);

if (isDedicatedWorkerScope) {
  installContentWorker(globalThis);
}
