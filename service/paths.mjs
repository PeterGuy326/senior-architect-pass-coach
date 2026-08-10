import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, realpathSync } from "node:fs";

import { CoachError } from "./errors.mjs";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const canonicalRepositoryRoot = realpathSync(repositoryRoot);

export const employeePackageDirectory = path.join(
  repositoryRoot,
  "employee",
  "senior-architect-pass-coach",
);

export function defaultDataDirectory(environment = process.env, platform = process.platform) {
  if (environment.SENIOR_ARCHITECT_DATA_DIR) {
    return path.resolve(environment.SENIOR_ARCHITECT_DATA_DIR);
  }
  if (platform === "win32") {
    const base = environment.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "senior-architect-pass-coach");
  }
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "senior-architect-pass-coach",
    );
  }
  const base = environment.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "senior-architect-pass-coach");
}

export function defaultContentDirectory(environment = process.env) {
  return path.resolve(environment.SENIOR_ARCHITECT_CONTENT_DIR || repositoryRoot);
}

export function assertPrivateDataDirectory(dataDirectory) {
  const resolved = path.resolve(dataDirectory);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new CoachError(
      "SYMLINK_DATA_DIRECTORY_FORBIDDEN",
      "私人学习数据目录不能是符号链接。",
    );
  }
  let existingAncestor = resolved;
  const missingSegments = [];
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync(existingAncestor);
  const canonicalCandidate = path.resolve(canonicalAncestor, ...missingSegments);
  const relative = path.relative(canonicalRepositoryRoot, canonicalCandidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new CoachError(
      "REPOSITORY_DATA_DIRECTORY_FORBIDDEN",
      "私人学习数据不能写进代码仓库；请使用默认用户数据目录或仓库外目录。",
    );
  }
  return canonicalCandidate;
}
