#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { ContentOnlyCoachRunner } from "./content-only-runner.mjs";
import { LocalObjectiveContentProvider } from "./content-provider.mjs";
import { LocalObjectiveQuestionSelector } from "./content-selector.mjs";
import { CoachError, publicError } from "./errors.mjs";
import { DigitalEmployeeHostRunner } from "./host-runner.mjs";
import { LEARNING_STATES } from "./learning-harness.mjs";
import {
  defaultContentDirectory,
  defaultDataDirectory,
} from "./paths.mjs";
import { CoachSessionController } from "./session-controller.mjs";
import { ConversationSessionStore } from "./session-store.mjs";
import { LocalCoachWorkbench } from "./workbench.mjs";

const USAGE = `系统架构设计师过线私教（本地 Workbench）

用法：
  architect-pass-coach setup [--exam-date YYYY-MM-DD] [--daily-minutes 45]
  architect-pass-coach status [--json]
  architect-pass-coach today [--subject comprehensive|case|essay] [--json]
  architect-pass-coach doctor [--engine codex|qoder|claude-code|qwen-code|codebuddy] [--json]
  architect-pass-coach validate-package [--engine ...] [--json]
  architect-pass-coach eval-package [--json]
  architect-pass-coach session start [--mode content-only|agent-host] [--engine ...] [--json]
  architect-pass-coach session list [--json]
  architect-pass-coach session resume [--session-id ID] [--json]
  architect-pass-coach session turn --session-id ID --turn-id TURN --expected-revision N \
    --intent next|answer|advance|close [--expected-item-id ITEM] [--answer A] [--json]
  architect-pass-coach run

通用选项：
  --data-dir PATH      私人状态目录（必须在代码仓库外）
  --content-dir PATH   公开复习资料 clone 根目录
  --json               输出 JSON

content-only 无需模型凭证；agent-host 使用 Digital Employee one-shot Host。
Codex 在 Digital Employee 0.3.0 中仅 probe，会在运行前被拒绝。
`;

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const sessionAction = command === "session" && argv[1] && !argv[1].startsWith("-")
    ? argv[1]
    : null;
  const rest = command === "session"
    ? argv.slice(sessionAction ? 2 : 1)
    : (command === argv[0] ? argv.slice(1) : argv);
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
      mode: { type: "string" },
      "session-id": { type: "string" },
      "turn-id": { type: "string" },
      "expected-revision": { type: "string" },
      "expected-item-id": { type: "string" },
      intent: { type: "string" },
      answer: { type: "string" },
      confidence: { type: "string" },
      "duration-seconds": { type: "string" },
    },
  });
  if (positionals.length > 0) {
    throw new CoachError("UNEXPECTED_ARGUMENT", `不支持的位置参数：${positionals.join(" ")}`);
  }
  return {
    command: values.help ? "help" : (command === "session" ? `session:${sessionAction || "help"}` : command),
    values: {
      ...values,
      dataDirectory: values["data-dir"] || defaultDataDirectory(),
      contentDirectory: values["content-dir"] || defaultContentDirectory(),
      examDate: values["exam-date"],
      dailyMinutes: Number.parseInt(values["daily-minutes"], 10),
      sessionId: values["session-id"],
      turnId: values["turn-id"],
      expectedRevision: values["expected-revision"] === undefined
        ? undefined
        : Number.parseInt(values["expected-revision"], 10),
      expectedItemId: values["expected-item-id"],
      durationSeconds: values["duration-seconds"] === undefined
        ? undefined
        : Number.parseInt(values["duration-seconds"], 10),
    },
  };
}

function printQuestion(question) {
  process.stdout.write(`\n老师：${question.prompt}\n`);
  for (const option of question.options || []) {
    process.stdout.write(`  ${option.label}. ${option.text}\n`);
  }
  process.stdout.write("\n直接输入选项作答；若你非常确定，可输入 /sure B。\n");
}

function printSessionView(view) {
  process.stdout.write(`\n会话：${view.session_id}  模式：${view.mode}${view.engine ? ` (${view.engine})` : ""}\n`);
  if (view.state === LEARNING_STATES.READY) {
    process.stdout.write(`老师：今天安排 ${view.total_tasks} 个过线任务，输入 /next 开始。\n`);
    return;
  }
  if (view.state === LEARNING_STATES.AWAITING_ANSWER) {
    printQuestion(view.question);
    return;
  }
  if (view.state === LEARNING_STATES.FEEDBACK) {
    const labels = {
      mastered: "已掌握",
      not_mastered: "未掌握",
      needs_retest: "答对但仍需复测",
    };
    process.stdout.write(`\n老师：${labels[view.feedback.result] || view.feedback.result}\n`);
    if (view.feedback.reference_answer) {
      process.stdout.write(`参考答案：${view.feedback.reference_answer}\n`);
    }
    process.stdout.write(`${view.feedback.explanation}\n`);
    process.stdout.write(
      view.progress_commit?.status === "committed"
        ? "本次证据已写入私人进度。输入 /next 继续。\n"
        : "本次反馈未写入进度。\n",
    );
    return;
  }
  if (view.state === LEARNING_STATES.INDETERMINATE) {
    process.stdout.write(`老师：${view.interruption.message}\n`);
    return;
  }
  if (view.state === LEARNING_STATES.COMPLETE) {
    process.stdout.write("老师：今天这一轮完成了。先保住正确率，不追加无效刷题。\n");
  }
}

async function runSessionRepl(controller, workbench) {
  const presentation = controller.view().presentation;
  process.stdout.write(`\n${presentation.display_name}\n${presentation.welcome}\n`);
  process.stdout.write(
    `${presentation.infrastructure_attribution} · 发布者 ${presentation.publisher.name} ` +
    `(${presentation.publisher.verification === "self_asserted" ? "未验证声明" : "已验证"})\n`,
  );
  process.stdout.write("输入 /help 查看命令。\n");
  let view = controller.view();
  if (view.state === LEARNING_STATES.READY) {
    view = await controller.next();
  }
  printSessionView(view);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (view.state !== LEARNING_STATES.COMPLETE) {
      let line;
      try {
        line = (await readline.question("\n你：")).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === "/help") {
        process.stdout.write(
          "/next 下一题；/answer A 作答；/sure A 确信作答；/status 看进度；" +
          "/pause 或 /quit 保存退出；/close 关闭会话。\n",
        );
        continue;
      }
      if (line === "/pause" || line === "/quit") {
        process.stdout.write(`会话 ${controller.sessionId} 已保存；下次使用 session resume。\n`);
        break;
      }
      if (line === "/close") {
        await controller.close();
        process.stdout.write("会话已关闭。\n");
        break;
      }
      if (line === "/status") {
        const status = await workbench.status();
        for (const [subject, item] of Object.entries(status.subjects || {})) {
          process.stdout.write(`${subject}: ${item.status}，保守下界 ${item.lower_bound_score ?? "未测"}\n`);
        }
        continue;
      }
      if (line === "/next") {
        if (view.state === LEARNING_STATES.FEEDBACK) view = await controller.advance();
        if (view.state === LEARNING_STATES.READY) view = await controller.next();
        printSessionView(view);
        continue;
      }
      if (view.state === LEARNING_STATES.AWAITING_ANSWER) {
        const sure = line.startsWith("/sure ");
        const explicit = line.startsWith("/answer ") || sure;
        const answer = explicit ? line.slice(line.indexOf(" ") + 1).trim() : line;
        view = await controller.submit(answer, { confidence: sure ? "sure" : "unsure" });
        printSessionView(view);
        continue;
      }
      process.stdout.write("当前状态不接受自由文本，请使用 /next、/status、/pause 或 /close。\n");
    }
    if (view.state === LEARNING_STATES.COMPLETE) {
      await controller.close();
      process.stdout.write("会话已归档。\n");
    }
  } finally {
    readline.close();
  }
}

async function assertContentClone(contentDirectory) {
  try {
    const canonical = await realpath(contentDirectory);
    const info = await stat(canonical);
    const papers = await stat(path.join(canonical, "past-papers", "comprehensive-by-year"));
    if (!info.isDirectory() || !papers.isDirectory()) throw new Error("not_directory");
  } catch (error) {
    throw new CoachError(
      "INVALID_CONTENT_DIRECTORY",
      "content-dir 必须指向用户自行 clone 的 senior-software-architect-review 仓库。",
      { exitCode: 1, cause: error },
    );
  }
}

function sessionComponents(values, { mode, engine } = {}) {
  const workbench = new LocalCoachWorkbench({
    dataDirectory: values.dataDirectory,
    contentDirectory: values.contentDirectory,
  });
  const provider = new LocalObjectiveContentProvider({ contentDirectory: values.contentDirectory });
  const contentProvider = new LocalObjectiveQuestionSelector({ contentProvider: provider });
  const store = new ConversationSessionStore({ dataDirectory: values.dataDirectory });
  const runner = mode === "agent-host"
    ? new DigitalEmployeeHostRunner({ engine })
    : new ContentOnlyCoachRunner();
  return { workbench, contentProvider, store, runner };
}

async function resolveStoredSession(store, sessionId) {
  if (sessionId) return store.load(sessionId);
  const active = await store.listActive();
  if (active.length === 0) {
    throw new CoachError("SESSION_NOT_FOUND", "没有可恢复的学习会话。", { exitCode: 1 });
  }
  if (active.length > 1) {
    throw new CoachError(
      "SESSION_SELECTION_REQUIRED",
      "存在多个活动会话，请使用 --session-id 指定。",
      { exitCode: 1 },
    );
  }
  return active[0];
}

async function dispatchSession(command, values) {
  if (command === "session:help") {
    process.stdout.write(USAGE);
    return undefined;
  }
  if (command === "session:list") {
    const workbench = new LocalCoachWorkbench({
      dataDirectory: values.dataDirectory,
      contentDirectory: values.contentDirectory,
    });
    await workbench.context({ required: true });
    const store = new ConversationSessionStore({ dataDirectory: values.dataDirectory });
    const active = await store.listActive();
    return {
      sessions: active.map((document) => ({
        session_id: document.session_id,
        revision: document.revision,
        updated_at: document.updated_at,
        mode: document.state?.mode,
        engine: document.state?.engine,
        state: document.state?.harness?.state,
      })),
    };
  }
  await assertContentClone(values.contentDirectory);
  if (command === "session:start") {
    const mode = values.mode || (values.engine ? "agent-host" : "content-only");
    if (mode === "agent-host" && !values.engine) {
      throw new CoachError("ENGINE_REQUIRED", "agent-host 模式必须指定 --engine。", { exitCode: 1 });
    }
    const components = sessionComponents(values, { mode, engine: values.engine });
    const controller = await CoachSessionController.start({
      ...components,
      mode,
      engine: values.engine,
      subject: values.subject || "comprehensive",
      today: values.today,
    });
    if (values.json) return controller.view();
    await runSessionRepl(controller, components.workbench);
    return undefined;
  }

  const initial = sessionComponents(values, { mode: "content-only" });
  const document = await resolveStoredSession(initial.store, values.sessionId);
  const storedMode = document.state?.mode;
  const storedEngine = document.state?.engine;
  if (values.engine && values.engine !== storedEngine) {
    throw new CoachError("SESSION_ENGINE_MISMATCH", "--engine 与会话原 engine 不一致。", { exitCode: 1 });
  }
  const components = sessionComponents(values, { mode: storedMode, engine: storedEngine });
  const controller = await CoachSessionController.resume({
    ...components,
    sessionId: document.session_id,
    allowClosed: command === "session:turn",
  });
  if (command === "session:resume") {
    if (values.json) return controller.view();
    await runSessionRepl(controller, components.workbench);
    return undefined;
  }
  if (command === "session:turn") {
    if (!["next", "answer", "advance", "close"].includes(values.intent)) {
      throw new CoachError(
        "INVALID_SESSION_INTENT",
        "session turn 的 --intent 必须是 next、answer、advance 或 close。",
        { exitCode: 1 },
      );
    }
    return controller.handleMachineTurn({
      turnId: values.turnId,
      expectedRevision: values.expectedRevision,
      expectedItemId: values.expectedItemId,
      intent: values.intent,
      ...(values.answer === undefined ? {} : { answer: values.answer }),
      ...(values.confidence === undefined ? {} : { confidence: values.confidence }),
      ...(values.durationSeconds === undefined ? {} : { durationSeconds: values.durationSeconds }),
    });
  }
  throw new CoachError("UNKNOWN_COMMAND", `未知 session 子命令。\n\n${USAGE}`);
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
  if (command.startsWith("session:")) {
    if (command === "session:list") {
      if (result.sessions.length === 0) process.stdout.write("没有活动学习会话。\n");
      for (const session of result.sessions) {
        process.stdout.write(
          `${session.session_id}  ${session.state}  ${session.mode}` +
          `${session.engine ? ` (${session.engine})` : ""}  revision ${session.revision}\n`,
        );
      }
      return;
    }
    printSessionView(result);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function dispatch(command, values) {
  if (command === "help") {
    process.stdout.write(USAGE);
    return undefined;
  }
  if (command.startsWith("session:")) return dispatchSession(command, values);
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
