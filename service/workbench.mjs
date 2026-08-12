import { loadLocalAuth, initializeLocalAuth, requireAuthenticated } from "./auth-context.mjs";
import { CoachError } from "./errors.mjs";
import {
  disabledRunEntry,
  evaluateEmployeePackage,
  validateEmployeePackage,
} from "./framework.mjs";
import { assertNoIdentityFields, deidentifyProgressSnapshot } from "./privacy.mjs";
import { ProgressEngineClient } from "./progress-engine.mjs";
import { authorizeProgressWrites, validateTeachingOutput } from "./proposal-validator.mjs";
import { validateEmployeeInput, validateEmployeeOutput } from "./schema-validator.mjs";
import { consumeTrustedObjectiveAuthorization } from "./trusted-grader.mjs";

const PERSONAL_ACTIONS = new Set([
  "status",
  "today",
  "practice",
  "submit",
  "review",
  "mock",
  "case",
  "essay",
]);
const OPAQUE_MATERIAL_LOCATOR = /^question:[A-Za-z0-9][A-Za-z0-9._:-]{0,1000}$/u;

function cleanRequestPayload(payload) {
  if (payload === undefined) return {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoachError("INVALID_TEACHING_PAYLOAD", "教学请求 payload 必须是对象。");
  }
  const clone = structuredClone(payload);
  for (const key of [
    "user_id",
    "name",
    "email",
    "data_directory",
    "state_path",
    "progress_snapshot",
    "mode",
    "diagnosis_scope",
  ]) {
    if (key in clone) {
      throw new CoachError("IDENTITY_FIELD_LEAK", `教学请求不能包含身份字段 ${key}。`);
    }
  }
  if (clone.approved_materials !== undefined) {
    if (!Array.isArray(clone.approved_materials)) {
      throw new CoachError("INVALID_TEACHING_PAYLOAD", "approved_materials 必须是数组。 ");
    }
    for (const material of clone.approved_materials) {
      if (
        !material ||
        typeof material !== "object" ||
        Array.isArray(material) ||
        typeof material.locator !== "string" ||
        !OPAQUE_MATERIAL_LOCATOR.test(material.locator)
      ) {
        throw new CoachError(
          "RESOURCE_PATH_LEAK",
          "approved material locator 必须是 Harness 生成的 opaque question locator。",
        );
      }
    }
  }
  return clone;
}

export class LocalCoachWorkbench {
  constructor({ dataDirectory, contentDirectory, engine } = {}) {
    if (!dataDirectory && !engine) {
      throw new TypeError("dataDirectory_or_engine_required");
    }
    this.dataDirectory = dataDirectory || engine.dataDirectory;
    this.engine = engine || new ProgressEngineClient({ dataDirectory, contentDirectory });
  }

  async setup(options = {}) {
    await this.engine.setup(options);
    await initializeLocalAuth(this.dataDirectory);
    return {
      status: "ready",
      message: "本地私人学习档案与授权上下文已就绪。",
      data_directory: this.dataDirectory,
    };
  }

  async context({ required = false } = {}) {
    return loadLocalAuth(this.dataDirectory, { required });
  }

  async status() {
    requireAuthenticated(await this.context({ required: true }));
    return this.engine.status();
  }

  async today(options = {}) {
    requireAuthenticated(await this.context({ required: true }));
    const result = await this.engine.recommend({ ...options, limit: Math.min(options.limit ?? 3, 3) });
    return { ...result, recommendations: (result.recommendations || []).slice(0, 3) };
  }

  async doctor({ engine } = {}) {
    const context = await this.context({ required: false });
    const packageCheck = await validateEmployeePackage({ engine });
    const checks = [
      {
        name: "employee_package",
        healthy: packageCheck.status === "valid",
        message: `${packageCheck.package}@${packageCheck.version}`,
      },
    ];
    if (context.authenticated) {
      const progress = await this.engine.doctor();
      checks.push(...(progress.checks || []));
    } else {
      checks.push({
        name: "personal_progress",
        healthy: true,
        message: "匿名诊断未读取个人进度；运行 setup 后可执行私人状态检查。",
      });
    }
    return {
      healthy: checks.every((check) => check.healthy),
      scope: context.authenticated ? "personal" : "general",
      checks,
      host: packageCheck.host,
    };
  }

  async validatePackage(options = {}) {
    return validateEmployeePackage(options);
  }

  async evalPackage(options = {}) {
    return evaluateEmployeePackage(options);
  }

  async prepareTeachingAction({ action, payload = {} } = {}) {
    const effectiveContext = await this.context({ required: PERSONAL_ACTIONS.has(action) });
    if (PERSONAL_ACTIONS.has(action)) requireAuthenticated(effectiveContext);
    if (!effectiveContext.authenticated && action !== "diagnose") {
      throw new CoachError(
        "ANONYMOUS_SCOPE_VIOLATION",
        "匿名上下文只能执行通用 diagnose。",
      );
    }
    const request = cleanRequestPayload(payload);
    let snapshot = null;
    if (effectiveContext.authenticated) {
      const [status, recommendation] = await Promise.all([
        this.engine.status(),
        this.engine.recommend({ limit: 3 }),
      ]);
      snapshot = assertNoIdentityFields(deidentifyProgressSnapshot(status, recommendation));
    }
    const input = {
        schema_version: "architect-pass-coach-input.v1",
        action,
        context: effectiveContext.authenticated
          ? { authenticated: true }
          : { authenticated: false },
        request: {
          mode: action === "submit" ? "evaluate" : "generate",
          ...(action === "diagnose"
            ? { diagnosis_scope: effectiveContext.authenticated ? "personalized" : "general" }
            : {}),
          ...request,
          ...(snapshot ? { progress_snapshot: snapshot } : {}),
        },
      };
    await validateEmployeeInput(input);
    return {
      input,
      context: effectiveContext,
    };
  }

  async commitTeachingProposal({ output, action, trustedAuthorizations = [] }) {
    const context = await this.context({ required: PERSONAL_ACTIONS.has(action) });
    await validateEmployeeOutput(output);
    const validated = validateTeachingOutput(output, { action, context });
    const verifiedAuthorizations = trustedAuthorizations.map(
      (authorization) => consumeTrustedObjectiveAuthorization(authorization),
    );
    const writes = authorizeProgressWrites(
      validated.proposed_progress_events,
      verifiedAuthorizations,
      context,
    );
    const receipts = [];
    for (const write of writes) {
      // All proposals are validated before the first durable write. The progress
      // engine's stable attempt/mock IDs make a retry idempotent after interruption.
      const result = write.command === "record"
        ? await this.engine.record(write.payload)
        : await this.engine.mock(write.payload);
      receipts.push({
        command: write.command,
        event_type: write.event_type,
        persisted: true,
        exit_code: result.exitCode,
      });
    }
    return {
      teaching_result: validated.teaching_result,
      progress_commit: {
        status: receipts.length > 0 ? "committed" : "not_requested",
        receipts,
      },
    };
  }

  async runTeachingAction() {
    return disabledRunEntry();
  }
}
