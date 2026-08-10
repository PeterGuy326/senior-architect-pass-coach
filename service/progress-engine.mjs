import { spawn } from "node:child_process";
import path from "node:path";

import { CoachError } from "./errors.mjs";
import { assertPrivateDataDirectory, repositoryRoot } from "./paths.mjs";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function collect(stream, label) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        reject(new CoachError("PROGRESS_ENGINE_OUTPUT_TOO_LARGE", `${label} 输出超过安全上限。`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

function parseJsonOutput(text, command) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
    return value;
  } catch (error) {
    throw new CoachError(
      "INVALID_PROGRESS_ENGINE_OUTPUT",
      `进度引擎 ${command} 没有返回有效 JSON。`,
      { cause: error },
    );
  }
}

export class ProgressEngineClient {
  constructor({
    dataDirectory,
    contentDirectory = repositoryRoot,
    python = process.env.SENIOR_ARCHITECT_PYTHON || "python3",
    cwd = repositoryRoot,
  }) {
    this.dataDirectory = assertPrivateDataDirectory(dataDirectory);
    this.contentDirectory = path.resolve(contentDirectory);
    this.python = python;
    this.cwd = cwd;
  }

  async execute(command, commandArguments = [], { json = false, allowUnhealthy = false } = {}) {
    const argumentsList = [
      "-m",
      "progress_engine",
      "--data-dir",
      this.dataDirectory,
      "--content-dir",
      this.contentDirectory,
      command,
      ...commandArguments,
      ...(json ? ["--json"] : []),
    ];
    const child = spawn(this.python, argumentsList, {
      cwd: this.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout, "stdout"),
      collect(child.stderr, "stderr"),
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }),
    ]).catch((error) => {
      if (error?.code === "ENOENT") {
        throw new CoachError(
          "PYTHON_NOT_FOUND",
          `找不到 Python 命令 ${this.python}；请安装 Python 3 或设置 SENIOR_ARCHITECT_PYTHON。`,
          { exitCode: 1 },
        );
      }
      throw error;
    });
    if (exitCode !== 0 && !(allowUnhealthy && exitCode === 1)) {
      throw new CoachError(
        "PROGRESS_ENGINE_FAILED",
        stderr.trim() || stdout.trim() || `进度引擎 ${command} 失败（退出码 ${exitCode}）。`,
        { exitCode: exitCode === 1 ? 1 : 2, details: { command, exitCode } },
      );
    }
    return {
      exitCode,
      stdout,
      stderr,
      value: json ? parseJsonOutput(stdout, command) : undefined,
    };
  }

  async setup({ examDate, dailyMinutes = 45 } = {}) {
    const args = ["--daily-minutes", String(dailyMinutes)];
    if (examDate) args.push("--exam-date", examDate);
    return this.execute("init", args);
  }

  async status() {
    return (await this.execute("status", [], { json: true })).value;
  }

  async recommend({ limit = 3, subject, today } = {}) {
    const args = ["--limit", String(Math.min(3, Math.max(1, limit)))];
    if (subject) args.push("--subject", subject);
    if (today) args.push("--today", today);
    const value = (await this.execute("recommend", args, { json: true })).value;
    return { ...value, recommendations: (value.recommendations || []).slice(0, 3) };
  }

  async doctor() {
    return (await this.execute("doctor", [], { json: true, allowUnhealthy: true })).value;
  }

  async record(event) {
    const args = [
      "--topic", event.topic_id,
      "--skill", event.skill,
      "--score", String(event.score),
      "--max-score", String(event.max_score),
      "--attempt-id", event.attempt_id,
      "--item-id", event.item_id,
    ];
    const optionalValues = [
      ["--facet", event.facet],
      ["--at", event.at],
      ["--subject", event.subject],
      ["--source", event.source],
      ["--source-type", event.source_type],
      ["--duration-seconds", event.duration_seconds],
      ["--word-count", event.word_count],
      ["--confidence", event.confidence],
      ["--mode", event.mode],
    ];
    for (const [flag, value] of optionalValues) {
      if (value !== undefined && value !== null && value !== "") args.push(flag, String(value));
    }
    for (const reason of event.wrong_reasons || []) args.push("--wrong-reason", reason);
    if (event.complete === true) args.push("--complete");
    return this.execute("record", args);
  }

  async mock(event) {
    const args = [
      "--subject", event.subject,
      "--mock-id", event.mock_id,
      "--paper-id", event.paper_id,
      "--score", String(event.score),
      "--max-score", String(event.max_score ?? 75),
      "--duration-minutes", String(event.duration_minutes),
    ];
    if (event.source_type) args.push("--source-type", event.source_type);
    if (event.at) args.push("--at", event.at);
    if (event.complete === true) args.push("--complete");
    return this.execute("mock", args);
  }
}
