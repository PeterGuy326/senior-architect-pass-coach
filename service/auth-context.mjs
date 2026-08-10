import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { CoachError } from "./errors.mjs";
import { assertPrivateDataDirectory } from "./paths.mjs";

export const AUTH_CONTEXT_SCHEMA_VERSION = "coach-local-auth.v1";
export const AUTH_CONTEXT_FILE_NAME = ".local-auth.json";

function validateAuthDocument(document) {
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.schema_version !== AUTH_CONTEXT_SCHEMA_VERSION ||
    typeof document.user_id !== "string" ||
    !/^local:[0-9a-f-]{36}$/i.test(document.user_id) ||
    typeof document.created_at !== "string"
  ) {
    throw new CoachError("INVALID_LOCAL_AUTH", "本地授权上下文损坏，请检查私人数据目录。", {
      exitCode: 1,
    });
  }
  return document;
}

async function assertSecureRegularFile(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CoachError("INSECURE_LOCAL_AUTH", "本地授权文件必须是普通文件，不能是符号链接。", {
      exitCode: 1,
    });
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new CoachError("INSECURE_LOCAL_AUTH", "本地授权文件权限过宽；请将权限改为 0600。", {
      exitCode: 1,
    });
  }
}

export async function initializeLocalAuth(dataDirectory) {
  const directory = assertPrivateDataDirectory(dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const filePath = path.join(directory, AUTH_CONTEXT_FILE_NAME);
  const document = {
    schema_version: AUTH_CONTEXT_SCHEMA_VERSION,
    user_id: `local:${randomUUID()}`,
    created_at: new Date().toISOString(),
  };
  try {
    const handle = await open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { authenticated: true, user_id: document.user_id, data_directory: directory };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return loadLocalAuth(directory, { required: true });
  }
}

export async function loadLocalAuth(dataDirectory, { required = false } = {}) {
  const directory = assertPrivateDataDirectory(dataDirectory);
  const filePath = path.join(directory, AUTH_CONTEXT_FILE_NAME);
  try {
    await assertSecureRegularFile(filePath);
    const document = validateAuthDocument(JSON.parse(await readFile(filePath, "utf8")));
    return { authenticated: true, user_id: document.user_id, data_directory: directory };
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return { authenticated: false };
    if (error?.code === "ENOENT") {
      throw new CoachError("AUTHENTICATION_REQUIRED", "尚未建立本地授权上下文，请先运行 setup。", {
        exitCode: 1,
      });
    }
    if (error instanceof SyntaxError) {
      throw new CoachError("INVALID_LOCAL_AUTH", "本地授权上下文不是有效 JSON。", {
        exitCode: 1,
      });
    }
    throw error;
  }
}

export function requireAuthenticated(context) {
  if (!context?.authenticated || typeof context.user_id !== "string") {
    throw new CoachError(
      "AUTHENTICATION_REQUIRED",
      "该操作会读取或写入个人学习进度，需要先运行 setup 建立本地授权上下文。",
      { exitCode: 1 },
    );
  }
  return context;
}
