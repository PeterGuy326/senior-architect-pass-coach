import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COACH_ENGINE_CATALOG,
  createCoachAgentHostRegistry,
  probeHermesAgentHost,
} from "../service/agent-host-registry.mjs";

test("the coach catalog declares six engines including a truthful Hermes entry", () => {
  assert.deepEqual(
    COACH_ENGINE_CATALOG.map(({ id }) => id),
    ["claude-code", "qoder", "codex", "qwen-code", "codebuddy", "hermes"],
  );
  assert.equal(
    COACH_ENGINE_CATALOG.find(({ id }) => id === "hermes").label,
    "Hermes Agent (Nous Research)",
  );
});

test("the disconnected Pages catalog stays in exact ID parity with the Runtime catalog", async () => {
  const source = await readFile(new URL("../docs/src/app.mjs", import.meta.url), "utf8");
  const catalogSource = source.slice(
    source.indexOf("const STATIC_AGENT_CATALOG"),
    source.indexOf("const ADAPTER_STATE_LABELS"),
  );
  const webIds = [...catalogSource.matchAll(/\bid:\s*"([a-z0-9._-]+)"/gu)]
    .map((match) => match[1]);
  assert.deepEqual(webIds, COACH_ENGINE_CATALOG.map(({ id }) => id));
  assert.match(catalogSource, /Hermes Agent \(Nous Research\)/u);
  assert.equal((catalogSource.match(/state:\s*"framework_supported"/gu) || []).length, 3);
  assert.equal((catalogSource.match(/state:\s*"package_incompatible"/gu) || []).length, 1);
  assert.equal((catalogSource.match(/state:\s*"probe_only"/gu) || []).length, 2);
  assert.doesNotMatch(catalogSource, /state:\s*"ready"|等待连接本机|本机已安装/u);
  assert.match(source, /基础私教 · Runtime 已连接/u);
  assert.match(source, /已构建并锁定 Digital Employee 工作区/u);
  assert.match(source, /切换 Agent 只替换“大脑”/u);
  assert.match(source, /Codex CLI 个人实验模式/u);
  assert.match(source, /consentCodexPersonal/u);
  assert.match(source, /个人实验模式尚未通过 Digital Employee 工具白名单认证/u);
  assert.match(source, /DIRECT_CONNECT_AGENT_IDS\s*=\s*new Set\(\["claude-code", "codex", "qwen-code", "codebuddy"\]\)/u);
  assert.match(source, /return connectRuntime\(\{ preferredEngine: engine \}\)/u);
  assert.match(source, /selectEngine\(preferredEngine, \{ enterConversation: true \}\)/u);
  assert.match(source, /elements\.engineDialog\.close\(\)/u);
  assert.match(source, /elements\.input\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(source, /选择 Agent 不会自动发送消息/u);
  const entryConversationSource = source.slice(
    source.indexOf("async function enterAgentConversation"),
    source.indexOf("async function selectEngine"),
  );
  assert.doesNotMatch(entryConversationSource, /\.initialize\(|chat\.clear\(/u);
  assert.match(entryConversationSource, /chat\.setComposer\(\{[\s\S]*enabled:\s*true/u);
  assert.match(source, /currentView\?\.state \?\? "ready"/u);
  assert.match(source, /匿名 Agent 对话 · 尚未建立学习档案/u);
  assert.match(source, /RUNTIME_SESSION_LOSS_CODES/u);
  assert.match(source, /coach\.setAgentClient\(null\)/u);
  assert.match(source, /coach\.setAgentPreference\("content-only"\)/u);
  assert.match(source, /RUNTIME_SESSION_LOSS_CODES\.has\(result\?\.agent\?\.failure\?\.code\)/u);
  assert.match(source, /syncInput:\s*false/u);
  assert.match(source, /confidence:\s*"auto"/u);
  assert.match(source, /confidence_source:\s*"inferred"/u);
  const html = await readFile(new URL("../docs/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /name="confidence"|id="confidence-field"|<legend>自报把握度<\/legend>/u);
  assert.match(html, /按题目长短计算参考用时.*实际前台有效用时/u);
  assert.match(html, /直接点击想用的 Agent/u);
  assert.match(html, /检测全部本机 Agent/u);
  const css = await readFile(new URL("../docs/assets/app.css", import.meta.url), "utf8");
  assert.match(css, /\.engine-card\[data-engine-selectable="false"\]\s*\{[^}]*opacity:\s*1/su);
  assert.match(css, /\.engine-card\[data-engine-entry="direct"\]/u);
  assert.doesNotMatch(css, /\.confidence-switch/u);
  assert.match(css, /\.timing-receipt/u);
  const serviceWorker = await readFile(new URL("../docs/sw.js", import.meta.url), "utf8");
  assert.match(serviceWorker, /architect-pass-coach-pages-v13/u);
});

test("an installed Hermes executable remains probe-only without a conformance adapter", async () => {
  const calls = [];
  const result = await probeHermesAgentHost({
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null, "Hermes Agent 0.2.0\n", "");
    },
  });

  assert.deepEqual(calls, [{
    command: "hermes",
    args: ["--version"],
    options: {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 5_000,
      windowsHide: true,
    },
  }]);
  assert.equal(result.hostId, "hermes");
  assert.equal(result.status, "installed");
  assert.equal(result.available, true);
  assert.equal(result.adapterStatus, "probe_only");
  assert.equal(result.version, "Hermes Agent 0.2.0");
  assert.deepEqual(result.issues.map(({ code }) => code), ["hermes_adapter_not_implemented"]);
  assert.equal(result.issues.every(({ blocking }) => blocking === true), true);
});

test("a missing Hermes executable is unavailable and never promoted to runnable", async () => {
  const missing = Object.assign(new Error("private executable path must not escape"), { code: "ENOENT" });
  const result = await probeHermesAgentHost({
    execFileImpl(_command, _args, _options, callback) {
      callback(missing, "", "");
    },
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.available, false);
  assert.equal(result.adapterStatus, "probe_only");
  assert.equal(Object.hasOwn(result, "version"), false);
  assert.deepEqual(result.issues.map(({ code }) => code), ["hermes_executable_not_found"]);
  assert.doesNotMatch(JSON.stringify(result), /private executable path/u);
});

test("the operator registry resolves both Hermes identifiers to the same probe", async () => {
  let probes = 0;
  const registry = createCoachAgentHostRegistry({
    hermesProbe: async () => {
      probes += 1;
      return probeHermesAgentHost({
        execFileImpl(_command, _args, _options, callback) {
          callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "", "");
        },
      });
    },
  });

  assert.equal(registry.resolve("hermes"), "hermes");
  assert.equal(registry.resolve("hermes-agent"), "hermes");
  const result = await registry.probe("hermes-agent");
  assert.equal(result.hostId, "hermes");
  assert.equal(result.status, "not_found");
  assert.equal(result.adapterStatus, "probe_only");
  assert.equal(probes, 1);
});
