import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertLocalAgentAccess,
  localAgentGateCopy,
  localAgentGateState,
  LOCAL_AGENT_GATE_STATES,
} from "../docs/src/local-agent-gate.mjs";

test("Local Agent gate unlocks only for one connected selectable Agent", () => {
  const cases = [
    [{}, LOCAL_AGENT_GATE_STATES.REQUIRED],
    [{ connected: false, engine: "claude-code", selectable: true }, LOCAL_AGENT_GATE_STATES.REQUIRED],
    [{ connected: true }, LOCAL_AGENT_GATE_STATES.CHOOSE_AGENT],
    [{ connected: true, engine: "content-only", selectable: true }, LOCAL_AGENT_GATE_STATES.CHOOSE_AGENT],
    [{ connected: true, engine: "qoder", selectable: false }, LOCAL_AGENT_GATE_STATES.CHOOSE_AGENT],
    [{ connected: true, engine: "constructor", selectable: true }, LOCAL_AGENT_GATE_STATES.CHOOSE_AGENT],
    [{ connected: true, engine: "claude-code", selectable: true }, LOCAL_AGENT_GATE_STATES.READY],
    [{ connected: true, engine: "codex", selectable: true }, LOCAL_AGENT_GATE_STATES.READY],
  ];
  for (const [input, expected] of cases) {
    assert.equal(localAgentGateState(input), expected, JSON.stringify(input));
  }
});

test("Local Agent assertion fails closed without exposing a content-only fallback", () => {
  for (const input of [
    {},
    { connected: true, engine: "content-only", selectable: true },
    { connected: true, engine: "qoder", selectable: false },
  ]) {
    assert.throws(
      () => assertLocalAgentAccess(input),
      (error) => error?.code === "LOCAL_AGENT_REQUIRED" && /不会自动改选|不提供浏览器伪聊天机器人/u.test(error.message),
    );
  }
  assert.equal(assertLocalAgentAccess({ connected: true, engine: "qwen-code", selectable: true }), true);
  assert.match(localAgentGateCopy(LOCAL_AGENT_GATE_STATES.REQUIRED).detail, /不提供浏览器伪聊天机器人/u);
});

test("Pages exposes a mandatory Local Agent gate and no browser tutor card", async () => {
  const [html, app, chatView, router, serviceWorker] = await Promise.all([
    readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/src/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/src/chat-view.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/src/harness-action-router.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/sw.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="agent-gate"/u);
  assert.match(html, /先接入本机 Agent，再开始私教/u);
  assert.match(html, /不提供浏览器伪聊天机器人/u);
  assert.match(html, /id="chat-timeline"[\s\S]*aria-hidden="true"[\s\S]*hidden/u);
  assert.match(html, /id="answer-form"[^>]*hidden/u);
  assert.doesNotMatch(html, /data-engine="content-only"|基础私教无需|始终可用/u);

  assert.match(app, /assertLocalAgentAccess/u);
  for (const functionName of [
    "launchCoach",
    "submitAnswer",
    "showProgress",
    "showTasks",
    "continueStudy",
    "showHelp",
    "askAgent",
    "handleHarnessAction",
    "handleChatInput",
  ]) {
    const start = app.indexOf(`function ${functionName}`);
    const next = app.indexOf("\nfunction ", start + 10);
    const body = app.slice(start, next < 0 ? app.length : next);
    assert.ok(start >= 0, functionName);
    assert.match(body, /requireLocalAgentAccess/u, functionName);
  }
  assert.doesNotMatch(app.slice(app.lastIndexOf("setToday()")), /restoreExistingProfile\(\)/u);
  assert.match(app, /answerSurfaceVisible\(\)[\s\S]*agentChatAvailable\(\)/u);
  assert.match(app, /function agentChatAvailable\(\)[\s\S]*LOCAL_AGENT_GATE_STATES\.READY && !profileRestoreFailed/u);
  assert.match(app, /elements\.timeline\.inert = !ready/u);
  assert.match(app, /elements\.answerForm\.hidden = !interactive/u);
  assert.match(app, /elements\.optionPanel\.hidden = !interactive \|\| currentView\?\.state !== "awaiting_answer"/u);
  for (const learnerDataElement of ["taskList", "taskSummary", "subjectList", "evidenceBadge"]) {
    assert.match(app, new RegExp(`elements\\.${learnerDataElement}\\.hidden = !interactive`, "u"));
  }
  assert.match(app, /MOBILE_LOCAL_AGENT_UNAVAILABLE[\s\S]*移动设备无法连接电脑上的 Runtime/u);
  assert.match(app, /if \(relocked\)[\s\S]*elements\.agentGate\.focus/u);

  const importButton = html.match(/<button[^>]*data-command="import"[^>]*>/u)?.[0] || "";
  const exportButton = html.match(/<button[^>]*data-command="export"[^>]*>/u)?.[0] || "";
  const clearButton = html.match(/<button[^>]*data-command="clear"[^>]*>/u)?.[0] || "";
  assert.match(importButton, /data-requires-agent/u);
  assert.match(importButton, /data-allows-profile-repair/u);
  assert.match(exportButton, /data-requires-agent/u);
  assert.doesNotMatch(clearButton, /data-requires-agent/u);
  assert.match(html, /id="import-file"[\s\S]*?aria-label="选择要导入的私人档案 JSON 文件"[\s\S]*?disabled/u);
  assert.match(app, /elements\.importFile\.disabled = !ready \|\| operating/u);

  for (const functionName of ["requestImport", "importProfile"]) {
    const start = app.indexOf(`function ${functionName}`);
    const next = app.indexOf("\nfunction ", start + 10);
    const body = app.slice(start, next < 0 ? app.length : next);
    assert.ok(start >= 0, functionName);
    assert.match(body, /requireLocalAgentAccess/u, functionName);
    assert.match(body, /allowProfileRepair: true/u, functionName);
  }
  assert.match(app, /if \(profileRestoreFailed\)[\s\S]*导入可信备份[\s\S]*return false/u);
  assert.match(router, /context\.agentAvailable !== true[\s\S]*return false/u);

  assert.match(chatView, /role === "coach"[\s\S]*label: "本机 Agent"/u);
  assert.match(chatView, /label: "本地 Harness"/u);
  assert.match(chatView, /appendMessage\("harness"/u);
  assert.match(serviceWorker, /architect-pass-coach-pages-v17/u);
  assert.match(serviceWorker, /\.\/src\/local-agent-gate\.mjs/u);
});
