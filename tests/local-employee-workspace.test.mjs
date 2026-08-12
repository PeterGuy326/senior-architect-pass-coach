import assert from "node:assert/strict";
import test from "node:test";

import { LocalEmployeeWorkspace } from "../service/local-employee-workspace.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;

function fixtureSnapshot({ cleanup = async () => {} } = {}) {
  return {
    directory: "/sealed/employee",
    digest: DIGEST,
    manifest: { name: "senior-architect-pass-coach", version: "0.3.0" },
    cleanup,
  };
}

test("workspace seals one immutable employee binding and treats Agents as replaceable brains", async () => {
  let snapshots = 0;
  let cleanups = 0;
  const workspace = new LocalEmployeeWorkspace({
    directory: "/publisher/employee",
    snapshotFactory: async (directory) => {
      assert.equal(directory, "/publisher/employee");
      snapshots += 1;
      return fixtureSnapshot({ cleanup: async () => { cleanups += 1; } });
    },
  });

  const [first, second] = await Promise.all([workspace.prepare(), workspace.prepare()]);
  assert.deepEqual(first, second);
  assert.equal(snapshots, 1);
  assert.equal(workspace.directory, "/sealed/employee");
  assert.deepEqual(first, {
    schema_version: "coach-local-workspace.v1",
    state: "ready",
    employee: {
      name: "senior-architect-pass-coach",
      version: "0.3.0",
      digest: DIGEST,
    },
    memory_owner: "browser_harness",
    agent_role: "replaceable_brain",
  });

  await workspace.close();
  await workspace.close();
  assert.equal(cleanups, 1);
  assert.throws(() => workspace.binding, { code: "EMPLOYEE_WORKSPACE_NOT_READY" });
});

test("invalid snapshots fail closed and are cleaned", async () => {
  let cleaned = false;
  const workspace = new LocalEmployeeWorkspace({
    snapshotFactory: async () => fixtureSnapshot({ cleanup: async () => { cleaned = true; } }),
  });
  workspace.snapshotFactory = async () => ({
    ...fixtureSnapshot({ cleanup: async () => { cleaned = true; } }),
    digest: "not-a-digest",
  });
  await assert.rejects(workspace.prepare(), { code: "EMPLOYEE_WORKSPACE_INVALID" });
  assert.equal(cleaned, true);
  assert.equal(workspace.ready, false);
});

test("workspace identity fields must be primitive strings", async () => {
  for (const invalid of [
    { manifest: { name: "senior-architect-pass-coach", version: 3 } },
    { digest: new String(DIGEST) },
  ]) {
    let cleaned = false;
    const workspace = new LocalEmployeeWorkspace({
      snapshotFactory: async () => ({
        ...fixtureSnapshot({ cleanup: async () => { cleaned = true; } }),
        ...invalid,
      }),
    });
    await assert.rejects(workspace.prepare(), { code: "EMPLOYEE_WORKSPACE_INVALID" });
    assert.equal(cleaned, true);
    assert.equal(workspace.ready, false);
  }
});

test("workspace refuses to bind a different Digital Employee package", async () => {
  let cleaned = false;
  const workspace = new LocalEmployeeWorkspace({
    snapshotFactory: async () => ({
      ...fixtureSnapshot({ cleanup: async () => { cleaned = true; } }),
      manifest: { name: "different-employee", version: "0.3.0" },
    }),
  });
  await assert.rejects(workspace.prepare(), { code: "EMPLOYEE_WORKSPACE_INVALID" });
  assert.equal(cleaned, true);
  assert.equal(workspace.ready, false);
});
