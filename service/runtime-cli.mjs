#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  createLocalAgentRuntime,
  DEFAULT_LOOPBACK_PORT,
  PUBLIC_COACH_URL,
} from "./local-agent-runtime.mjs";

function parsePort(value) {
  if (value === undefined) return DEFAULT_LOOPBACK_PORT;
  if (!/^[0-9]{1,5}$/u.test(value)) throw new TypeError("invalid_port");
  const port = Number.parseInt(value, 10);
  if (port < 1_024 || port > 65_535) throw new TypeError("invalid_port");
  return port;
}

export function openRuntimeUrl(
  url,
  { platform = process.platform, spawnImpl = spawn } = {},
) {
  // `--open` is deliberately not a general-purpose URL launcher. Keeping an
  // exact allowlist prevents Runtime output or command-line input from being
  // turned into an arbitrary shell/browser target.
  if (url !== PUBLIC_COACH_URL) return false;
  const command = platform === "darwin"
    ? "/usr/bin/open"
    : (platform === "linux" ? "xdg-open" : null);
  if (!command) return false;
  try {
    const child = spawnImpl(command, [url], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.once?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export async function main(argumentsList = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argumentsList,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        open: { type: "boolean" },
        port: { type: "string", short: "p" },
      },
    }));
  } catch {
    process.stderr.write("用法: architect-pass-coach-runtime [--port 43127] [--open]\n");
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    process.stdout.write("用法: architect-pass-coach-runtime [--port 43127] [--open]\n");
    return;
  }
  let port;
  try {
    port = parsePort(values.port);
  } catch {
    process.stderr.write("端口必须是 1024 到 65535 之间的整数。\n");
    process.exitCode = 2;
    return;
  }

  const runtime = createLocalAgentRuntime({ port });
  try {
    const started = await runtime.start();
    process.stdout.write(`本机 Agent 配对桥已启动：${started.url}\n`);
    process.stdout.write(`私教主入口：${PUBLIC_COACH_URL}\n`);
    process.stdout.write("学习档案仍保存在公开私教页面的浏览器存储；按 Ctrl+C 停止本机 Runtime。\n");
    if (values.open) openRuntimeUrl(PUBLIC_COACH_URL);
  } catch {
    process.stderr.write("本机 Agent Runtime 启动失败；请确认端口未被占用且发布包完整。\n");
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.stop();
    } finally {
      process.exitCode = 0;
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1])
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMainModule = false;
}
if (isMainModule) {
  await main();
}
