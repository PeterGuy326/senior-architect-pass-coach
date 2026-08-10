import {
  createSealedEmployeePackageSnapshot,
  inspectEmployeeHostCompatibility,
  runEmployeePackage,
} from "@fullstack-ai-infra/digital-employee/host-runtime";

import { CoachError } from "./errors.mjs";
import { employeePackageDirectory } from "./paths.mjs";
import { loadPackagePresentation } from "./presentation.mjs";

const defaultRuntime = Object.freeze({
  createSealedEmployeePackageSnapshot,
  inspectEmployeeHostCompatibility,
  runEmployeePackage,
});

function hostError(code, message, options = {}) {
  return new CoachError(code, message, { exitCode: 3, ...options });
}

/** Agent-native, one-shot Digital Employee runner with a pinned package digest. */
export class DigitalEmployeeHostRunner {
  mode = "agent-host";

  constructor({
    engine,
    directory = employeePackageDirectory,
    hostRegistry,
    deadlineMs = 120_000,
    runtime = defaultRuntime,
    clock = () => Date.now(),
    audit,
    presentationLoader = loadPackagePresentation,
  } = {}) {
    if (typeof engine !== "string" || engine.trim().length === 0) {
      throw new TypeError("engine_required");
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1_000 || deadlineMs > 900_000) {
      throw new TypeError("deadlineMs_must_be_1000_to_900000");
    }
    this.engine = engine;
    this.directory = directory;
    this.hostRegistry = hostRegistry;
    this.deadlineMs = deadlineMs;
    this.runtime = runtime;
    this.clock = clock;
    this.audit = audit;
    this.presentationLoader = presentationLoader;
    this.pinnedDigest = null;
    this.employee = null;
  }

  async preflight() {
    const snapshot = await this.runtime.createSealedEmployeePackageSnapshot(this.directory);
    try {
      const presentation = await this.presentationLoader({ directory: snapshot.directory });
      const checked = await this.runtime.inspectEmployeeHostCompatibility({
        directory: snapshot.directory,
        engine: this.engine,
        ...(this.hostRegistry ? { hostRegistry: this.hostRegistry } : {}),
      });
      if (checked?.compatibility?.compatible !== true) {
        throw hostError(
          "HOST_INCOMPATIBLE",
          `Agent Host ${this.engine} 不能安全运行当前数字员工包。`,
          {
            details: {
              engine: this.engine,
              host_status: checked?.host?.status,
              adapter_status: checked?.host?.adapterStatus,
              issues: checked?.compatibility?.issues || [],
            },
          },
        );
      }
      this.pinnedDigest = snapshot.digest;
      this.employee = {
        name: snapshot.manifest.name,
        version: snapshot.manifest.version,
      };
      return {
        engine: this.engine,
        digest: snapshot.digest,
        employee: { ...this.employee },
        presentation,
        host: {
          status: checked.host.status,
          adapter_status: checked.host.adapterStatus,
        },
      };
    } finally {
      await snapshot.cleanup();
    }
  }

  async run(input, { runId, signal } = {}) {
    if (!this.pinnedDigest) await this.preflight();
    const snapshot = await this.runtime.createSealedEmployeePackageSnapshot(this.directory);
    try {
      if (snapshot.digest !== this.pinnedDigest) {
        throw hostError(
          "EMPLOYEE_PACKAGE_CHANGED",
          "数字员工包在会话期间发生变化；请重新开始会话并复核新版本。",
        );
      }
      const result = await this.runtime.runEmployeePackage({
        directory: snapshot.directory,
        engine: this.engine,
        ...(this.hostRegistry ? { hostRegistry: this.hostRegistry } : {}),
        input,
        ...(runId ? { runId } : {}),
        expectedPackageDigest: this.pinnedDigest,
        deadline: new Date(this.clock() + this.deadlineMs).toISOString(),
        ...(signal ? { signal } : {}),
        ...(this.audit
          ? {
            onEvent: async (event) => {
              if (["run.started", "run.completed", "run.failed"].includes(event?.type)) {
                await this.audit({ type: event.type, runId: event.runId, timestamp: event.timestamp });
              }
            },
          }
          : {}),
      });
      if (result?.status !== "completed") {
        throw hostError(
          "HOST_RUN_FAILED",
          `Agent Host ${this.engine} 未能完成本轮教学。`,
          {
            details: {
              engine: this.engine,
              code: result?.error?.code || "unknown_host_error",
              retryable: result?.error?.retryable === true,
              issues: result?.issues || [],
            },
          },
        );
      }
      return result.output;
    } finally {
      await snapshot.cleanup();
    }
  }
}
