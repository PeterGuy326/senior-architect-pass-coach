import { execFile } from "node:child_process";

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "@fullstack-ai-infra/digital-employee";
import { createBuiltInAgentHostRegistry } from "@fullstack-ai-infra/digital-employee/host-runtime";

const VERSION_TEXT = /^[^\u0000-\u001F\u007F]{1,256}$/u;

export const COACH_ENGINE_CATALOG = Object.freeze([
  Object.freeze({ id: "claude-code", label: "Claude Code" }),
  Object.freeze({ id: "qoder", label: "Qoder CLI" }),
  Object.freeze({ id: "codex", label: "Codex CLI" }),
  Object.freeze({ id: "qwen-code", label: "Qwen Code" }),
  Object.freeze({ id: "codebuddy", label: "CodeBuddy Code" }),
  Object.freeze({ id: "hermes", label: "Hermes Agent (Nous Research)" }),
]);

function runVersionProbe(execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl(
      "hermes",
      ["--version"],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout = "", stderr = "") => resolve({ error, stdout, stderr }),
    );
  });
}

function safeVersion(stdout, stderr) {
  const firstLine = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine && VERSION_TEXT.test(firstLine) ? firstLine : undefined;
}

/**
 * Probe-only Hermes registration inspired by Open Design's declarative
 * RuntimeAgentDef catalog. Digital Employee 0.3.0 does not ship a Hermes
 * runnable adapter, so this probe must never claim that model execution is
 * available merely because a `hermes` executable exists on PATH.
 */
export async function probeHermesAgentHost({ execFileImpl = execFile } = {}) {
  const result = await runVersionProbe(execFileImpl);
  const missing = result.error?.code === "ENOENT";
  const installed = !result.error;
  const status = installed ? "installed" : (missing ? "not_found" : "probe_failed");
  const issueCode = installed
    ? "hermes_adapter_not_implemented"
    : (missing ? "hermes_executable_not_found" : "hermes_version_probe_failed");
  const version = safeVersion(result.stdout, result.stderr);
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: "hermes",
    displayName: "Hermes Agent (Nous Research)",
    status,
    available: installed,
    adapterStatus: "probe_only",
    ...(version ? { version } : {}),
    capabilities: createUnknownAgentHostCapabilities(),
    capabilitySource: "adapter_declaration",
    issues: [{
      code: issueCode,
      message: installed
        ? "Hermes is installed, but this Digital Employee release has no conformance-verified Hermes adapter."
        : "Hermes is not available as a runnable Digital Employee adapter.",
      blocking: true,
    }],
  };
}

/** One operator-owned registry is shared by compatibility inspection and runs. */
export function createCoachAgentHostRegistry({ hermesProbe = probeHermesAgentHost } = {}) {
  if (typeof hermesProbe !== "function") throw new TypeError("hermesProbe_must_be_a_function");
  const registry = createBuiltInAgentHostRegistry();
  registry.register({
    id: "hermes",
    aliases: ["hermes-agent"],
    probe: () => hermesProbe(),
  });
  return registry;
}
