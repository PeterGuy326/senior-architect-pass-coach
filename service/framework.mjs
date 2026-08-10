import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createSealedEmployeePackageSnapshot,
  inspectEmployeeHostCompatibility,
} from "@fullstack-ai-infra/digital-employee/host-runtime";

import { CoachError } from "./errors.mjs";
import { employeePackageDirectory } from "./paths.mjs";

const frameworkHostRuntime = import.meta.resolve(
  "@fullstack-ai-infra/digital-employee/host-runtime",
);
const frameworkCli = fileURLToPath(new URL("./bin.js", frameworkHostRuntime));

function runFrameworkCli(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [frameworkCli, ...argumentsList], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new CoachError(
          "DIGITAL_EMPLOYEE_COMMAND_FAILED",
          stderr.trim() || stdout.trim() || `Digital Employee 退出码 ${exitCode}。`,
          { exitCode: 1 },
        ));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new CoachError(
          "INVALID_DIGITAL_EMPLOYEE_OUTPUT",
          "Digital Employee 未返回有效 JSON。",
          { cause: error },
        ));
      }
    });
  });
}

export async function validateEmployeePackage({
  directory = employeePackageDirectory,
  engine,
} = {}) {
  const snapshot = await createSealedEmployeePackageSnapshot(directory);
  try {
    const result = {
      status: "valid",
      package: snapshot.manifest.name,
      version: snapshot.manifest.version,
      digest: snapshot.digest,
      framework: "@fullstack-ai-infra/digital-employee@0.3.0",
    };
    if (engine) {
      const host = await inspectEmployeeHostCompatibility({ directory, engine });
      result.host = {
        engine,
        status: host.host.status,
        adapter_status: host.host.adapterStatus,
        compatible: host.compatibility.compatible,
        issues: host.compatibility.issues,
      };
    }
    return result;
  } finally {
    await snapshot.cleanup();
  }
}

export async function evaluateEmployeePackage({ directory = employeePackageDirectory } = {}) {
  return runFrameworkCli(["eval", directory, "--json"]);
}

export function disabledRunEntry() {
  throw new CoachError(
    "RUN_NOT_ENABLED",
    "当前版本只提供本地确定性 Workbench、静态校验和离线评测；尚未启用模型运行。",
    { exitCode: 3 },
  );
}
