import assert from "node:assert/strict";
import test from "node:test";

import { DigitalEmployeeHostRunner } from "../service/host-runner.mjs";

const PRESENTATION = Object.freeze({
  schema_version: "coach-package-presentation.v1",
  display_name: "合成私教",
});
const presentationLoader = async () => PRESENTATION;

function runtimeFixture({ compatible = true, result } = {}) {
  const calls = { snapshots: 0, cleanups: 0, inspections: [], runs: [] };
  const runtime = {
    async createSealedEmployeePackageSnapshot() {
      calls.snapshots += 1;
      return {
        directory: `/sealed/${calls.snapshots}`,
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        manifest: { name: "coach", version: "1.0.0" },
        async cleanup() { calls.cleanups += 1; },
      };
    },
    async inspectEmployeeHostCompatibility(options) {
      calls.inspections.push(options);
      return {
        host: { status: compatible ? "ready" : "probe_only", adapterStatus: compatible ? "runnable" : "probe_only" },
        compatibility: { compatible, issues: compatible ? [] : [{ code: "agent_host_adapter_not_runnable" }] },
      };
    },
    async runEmployeePackage(options) {
      calls.runs.push(options);
      return result || { status: "completed", output: { ok: true } };
    },
  };
  return { runtime, calls };
}

test("host runner preflights compatibility and pins the sealed package digest", async () => {
  const { runtime, calls } = runtimeFixture();
  const runner = new DigitalEmployeeHostRunner({
    engine: "qwen-code",
    runtime,
    presentationLoader,
    clock: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });
  const preflight = await runner.preflight();
  const output = await runner.run({ action: "practice" }, { runId: "turn-1" });

  assert.equal(preflight.engine, "qwen-code");
  assert.equal(output.ok, true);
  assert.equal(calls.runs[0].expectedPackageDigest, preflight.digest);
  assert.equal(calls.runs[0].deadline, "2026-01-01T00:02:00.000Z");
  assert.equal(calls.cleanups, 2);
});

test("probe-only or incompatible engines fail before a model run", async () => {
  const { runtime, calls } = runtimeFixture({ compatible: false });
  const runner = new DigitalEmployeeHostRunner({
    engine: "codex",
    runtime,
    presentationLoader,
  });

  await assert.rejects(runner.preflight(), (error) => error.code === "HOST_INCOMPATIBLE");
  assert.equal(calls.runs.length, 0);
  assert.equal(calls.cleanups, 1);
});

test("failed framework envelopes retain safe code and retryability", async () => {
  const { runtime } = runtimeFixture({
    result: {
      status: "failed",
      error: { code: "agent_host_timed_out", message: "internal", retryable: true },
      issues: [{ code: "timeout" }],
    },
  });
  const runner = new DigitalEmployeeHostRunner({
    engine: "qwen-code",
    runtime,
    presentationLoader,
  });

  await assert.rejects(
    runner.run({ action: "practice" }),
    (error) => (
      error.code === "HOST_RUN_FAILED" &&
      error.details.code === "agent_host_timed_out" &&
      error.details.retryable === true
    ),
  );
});
