import { createSealedEmployeePackageSnapshot } from "@fullstack-ai-infra/digital-employee/host-runtime";

import { employeePackageDirectory } from "./paths.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const EXPECTED_EMPLOYEE_NAME = "senior-architect-pass-coach";

function workspaceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * One Runtime-owned, read-only Digital Employee workspace.
 *
 * Digital Employee supplies the sealed package projection and digest. The
 * browser Harness continues to own learner memory, grading and scheduling;
 * Agent adapters are replaceable brains bound to this same package snapshot.
 */
export class LocalEmployeeWorkspace {
  constructor({
    directory = employeePackageDirectory,
    snapshotFactory = createSealedEmployeePackageSnapshot,
  } = {}) {
    if (typeof directory !== "string" || !directory) throw new TypeError("employee_directory_required");
    if (typeof snapshotFactory !== "function") throw new TypeError("snapshot_factory_required");
    this.sourceDirectory = directory;
    this.snapshotFactory = snapshotFactory;
    this.snapshot = null;
    this.preparing = null;
  }

  get ready() {
    return Boolean(this.snapshot);
  }

  get directory() {
    if (!this.snapshot) throw workspaceError("EMPLOYEE_WORKSPACE_NOT_READY");
    return this.snapshot.directory;
  }

  get binding() {
    if (!this.snapshot) throw workspaceError("EMPLOYEE_WORKSPACE_NOT_READY");
    return Object.freeze({
      schema_version: "coach-local-workspace.v1",
      state: "ready",
      employee: Object.freeze({
        name: this.snapshot.manifest.name,
        version: this.snapshot.manifest.version,
        digest: this.snapshot.digest,
      }),
      memory_owner: "browser_harness",
      agent_role: "replaceable_brain",
    });
  }

  async prepare() {
    if (this.snapshot) return this.binding;
    if (this.preparing) return this.preparing;
    this.preparing = (async () => {
      const snapshot = await this.snapshotFactory(this.sourceDirectory);
      if (
        !snapshot
        || typeof snapshot.directory !== "string"
        || typeof snapshot.cleanup !== "function"
        || !snapshot.manifest
        || typeof snapshot.manifest.name !== "string"
        || typeof snapshot.manifest.version !== "string"
        || typeof snapshot.digest !== "string"
        || !SAFE_PACKAGE_NAME.test(snapshot.manifest.name)
        || snapshot.manifest.name !== EXPECTED_EMPLOYEE_NAME
        || !SAFE_VERSION.test(snapshot.manifest.version)
        || !DIGEST.test(snapshot.digest)
      ) {
        await snapshot?.cleanup?.().catch(() => {});
        throw workspaceError("EMPLOYEE_WORKSPACE_INVALID");
      }
      this.snapshot = snapshot;
      return this.binding;
    })();
    try {
      return await this.preparing;
    } finally {
      this.preparing = null;
    }
  }

  async close() {
    if (this.preparing) await this.preparing.catch(() => {});
    const snapshot = this.snapshot;
    this.snapshot = null;
    if (snapshot) await snapshot.cleanup();
  }
}

export function createLocalEmployeeWorkspace(options) {
  return new LocalEmployeeWorkspace(options);
}
