#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { CoachError, publicError } from "./errors.mjs";
import {
  defaultContentDirectory,
  defaultDataDirectory,
} from "./paths.mjs";
import { LocalCoachWorkbench } from "./workbench.mjs";

const USAGE = `系统架构设计师过线私教（本地 Workbench）

用法：
  architect-pass-coach setup [--exam-date YYYY-MM-DD] [--daily-minutes 45]
  architect-pass-coach status [--json]
  architect-pass-coach today [--subject comprehensive|case|essay] [--json]
  architect-pass-coach doctor [--engine codex|qoder|claude-code|qwen-code|codebuddy] [--json]
  architect-pass-coach validate-package [--engine ...] [--json]
  architect-pass-coach eval-package [--json]
  architect-pass-coach run

通用选项：
  --data-dir PATH      私人状态目录（必须在代码仓库外）
  --content-dir PATH   公开复习资料 clone 根目录
  --json               输出 JSON

当前 run 尚未启用；validate/eval 均为离线检查，不发起模型调用。Codex 仅探测。
`;

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
      "data-dir": { type: "string" },
      "content-dir": { type: "string" },
      "exam-date": { type: "string" },
      "daily-minutes": { type: "string", default: "45" },
      subject: { type: "string" },
      today: { type: "string" },
      engine: { type: "string" },
    },
  });
  if (positionals.length > 0) {
    throw new CoachError("UNEXPECTED_ARGUMENT", `不支持的位置参数：${positionals.join(" ")}`);
  }
  return {
    command: values.help ? "help" : command,
    values: {
      ...values,
      dataDirectory: values["data-dir"] || defaultDataDirectory(),
      contentDirectory: values["content-dir"] || defaultContentDirectory(),
      examDate: values["exam-date"],
      dailyMinutes: Number.parseInt(values["daily-minutes"], 10),
    },
  };
}

function printHuman(command, result) {
  if (command === "setup") {
    process.stdout.write(`${result.message}\n私人目录：${result.data_directory}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`考试日期：${result.profile?.exam_date || "未设置"}\n`);
    for (const [subject, item] of Object.entries(result.subjects || {})) {
      process.stdout.write(
        `${subject}: ${item.status}；保守下界 ${item.lower_bound_score ?? "未测"}\n`,
      );
    }
    return;
  }
  if (command === "today") {
    process.stdout.write(`当前优先科目：${result.target_subject || "待诊断"}\n`);
    for (const [index, item] of (result.recommendations || []).entries()) {
      process.stdout.write(
        `${index + 1}. [${item.subject}] ${item.topic_id} ${item.name || ""} — ${item.reason || "按确定性优先级安排"}\n`,
      );
    }
    return;
  }
  if (command === "doctor") {
    for (const check of result.checks || []) {
      process.stdout.write(`[${check.healthy ? "PASS" : "FAIL"}] ${check.name}: ${check.message}\n`);
    }
    return;
  }
  if (command === "validate-package") {
    process.stdout.write(`员工包有效：${result.package}@${result.version}\n摘要：${result.digest}\n`);
    if (result.host) {
      process.stdout.write(
        `Host ${result.host.engine}: ${result.host.status} [${result.host.adapter_status}]\n`,
      );
    }
    return;
  }
  if (command === "eval-package") {
    process.stdout.write(`离线评测：${result.status || "completed"}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function dispatch(command, values) {
  if (command === "help") {
    process.stdout.write(USAGE);
    return undefined;
  }
  const workbench = new LocalCoachWorkbench({
    dataDirectory: values.dataDirectory,
    contentDirectory: values.contentDirectory,
  });
  switch (command) {
    case "setup":
      if (!Number.isInteger(values.dailyMinutes) || values.dailyMinutes < 1 || values.dailyMinutes > 1440) {
        throw new CoachError("INVALID_DAILY_MINUTES", "daily-minutes 必须在 1–1440 之间。");
      }
      return workbench.setup({ examDate: values.examDate, dailyMinutes: values.dailyMinutes });
    case "status":
      return workbench.status();
    case "today":
      return workbench.today({ subject: values.subject, today: values.today });
    case "doctor":
      return workbench.doctor({ engine: values.engine });
    case "validate-package":
      return workbench.validatePackage({ engine: values.engine });
    case "eval-package":
      return workbench.evalPackage();
    case "run":
      return workbench.runTeachingAction();
    default:
      throw new CoachError("UNKNOWN_COMMAND", `未知命令：${command}。\n\n${USAGE}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parse(argv);
    const result = await dispatch(parsed.command, parsed.values);
    if (result !== undefined) {
      if (parsed.values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else printHuman(parsed.command, result);
    }
    return 0;
  } catch (error) {
    const value = publicError(error);
    const json = parsed?.values?.json || argv.includes("--json");
    if (json) process.stderr.write(`${JSON.stringify(value, null, 2)}\n`);
    else process.stderr.write(`错误 [${value.code}]：${value.message}\n`);
    return error instanceof CoachError ? error.exitCode : 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
