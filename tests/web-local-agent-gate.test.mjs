import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertLocalAgentAccess,
  localAgentGateCopy,
  localAgentGateState,
  LOCAL_AGENT_GATE_STATES,
} from "../docs/src/local-agent-gate.mjs";

test("legacy Local Agent gate unlocks only for one connected selectable Agent", () => {
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

test("legacy Local Agent assertion remains fail-closed for historical callers", () => {
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

test("Pages is a static Agent-first handoff and exposes no Runtime gate or browser tutor", async () => {
  const [html, privacy, retiredPair, landing, serviceWorker] = await Promise.all([
    readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/privacy.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/pair.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/src/landing.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/sw.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /入口就是[\s\S]*你正在使用的/u);
  assert.match(html, /senior-software-architect-review/u);
  assert.match(html, /开始私教，我只求考过/u);
  assert.match(html, /python3 scripts\/serve\.py/u);
  assert.match(html, /不下载 Runtime/u);
  assert.doesNotMatch(html, /id="agent-gate"|id="chat-timeline"|id="answer-form"/u);
  assert.doesNotMatch(html, /127\.0\.0\.1:43127|local-agent-client|src\/app\.mjs/u);
  assert.match(privacy, /当前 GitHub Pages 只是静态使用说明/u);
  assert.match(privacy, /\.study\//u);
  assert.doesNotMatch(privacy, /src\/pair\.mjs|id="pair-approve"/u);
  assert.match(retiredPair, /这个连接页已经停用/u);
  assert.doesNotMatch(retiredPair, /src\/pair\.mjs|id="pair-approve"|postMessage/u);
  assert.match(landing, /navigator\.clipboard\.writeText/u);
  assert.match(landing, /serviceWorker\.register\("\.\/sw\.js"/u);
  assert.match(serviceWorker, /architect-pass-coach-pages-v22/u);
  assert.match(serviceWorker, /\.\/src\/landing\.mjs/u);
  assert.doesNotMatch(serviceWorker, /\.\/src\/local-agent-gate\.mjs|\.\/src\/app\.mjs/u);
});

test("every published HTML entry is Agent-first or an inert retirement notice", async () => {
  const docsUrl = new URL("../docs/", import.meta.url);
  const htmlNames = (await readdir(docsUrl))
    .filter((name) => name.endsWith(".html"))
    .sort();
  assert.deepEqual(htmlNames, ["index.html", "pair.html", "privacy.html"]);

  for (const name of htmlNames) {
    const html = await readFile(new URL(name, docsUrl), "utf8");
    assert.doesNotMatch(
      html,
      /src\/(?:app|pair)\.mjs|id="(?:agent-gate|pair-approve|chat-timeline|answer-form)"|127\.0\.0\.1:43127|runtime-install-link/u,
      name,
    );
  }
  await assert.rejects(
    access(new URL("../.github/workflows/runtime-bundle.yml", import.meta.url)),
    (error) => error?.code === "ENOENT",
  );
});
