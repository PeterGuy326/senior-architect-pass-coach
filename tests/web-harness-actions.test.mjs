import assert from "node:assert/strict";
import test from "node:test";

import {
  HARNESS_ACTION_GROUPS,
  harnessAction,
  harnessActionChoices,
} from "../docs/src/harness-actions.mjs";
import { dispatchHarnessAction } from "../docs/src/harness-action-router.mjs";

test("Harness quick actions are a closed browser-owned registry", () => {
  const action = harnessAction("coach-next-step");
  assert.deepEqual(Object.keys(action).sort(), ["id", "kind", "label", "message"]);
  assert.equal(action.kind, "agent");
  assert.equal(Object.isFrozen(action), true);
  assert.equal(Object.isFrozen(HARNESS_ACTION_GROUPS), true);
  assert.equal(Object.isFrozen(HARNESS_ACTION_GROUPS.agent_entry), true);

  for (const hostile of [
    null,
    {},
    "constructor",
    "__proto__",
    "unknown-action",
    "A-not-lowercase",
    "x".repeat(64),
  ]) {
    assert.equal(harnessAction(hostile), null);
  }
});

test("the view receives only bounded action IDs and labels, never hidden prompts", () => {
  const choices = harnessActionChoices([
    "coach-next-step",
    "coach-example",
    "coach-drill",
    "local-progress",
  ]);
  assert.equal(choices.length, 3);
  assert.equal(Object.isFrozen(choices), true);
  assert.deepEqual(choices.map((choice) => Object.keys(choice).sort()), [
    ["id", "label"],
    ["id", "label"],
    ["id", "label"],
  ]);
  assert.doesNotMatch(JSON.stringify(choices), /message|command|provider|model/u);
  assert.deepEqual(harnessActionChoices([{ id: "coach-next-step", label: "模型伪造", value: "run" }]), []);
});

test("every published quick-action group resolves and remains bounded", () => {
  for (const ids of Object.values(HARNESS_ACTION_GROUPS)) {
    const choices = harnessActionChoices(ids);
    assert.ok(choices.length >= 1 && choices.length <= 3);
    assert.equal(choices.length, ids.length);
  }
  assert.deepEqual(
    HARNESS_ACTION_GROUPS.awaiting_answer.map((id) => harnessAction(id).kind),
    ["local"],
  );
  assert.equal(harnessAction("local-return-to-answer").operation, "focus-answer");
  assert.equal(harnessAction("local-next-question").command, "continue");
});

test("return-to-answer is a local no-op on learner data and never calls Agent", async () => {
  const events = [];
  const draft = { input: "AC", selected: ["A", "C"], revision: 7, durationSeconds: 18 };
  const before = structuredClone(draft);
  const handled = await dispatchHarnessAction("local-return-to-answer", {
    state: "awaiting_answer",
    agentAvailable: true,
    focusAnswer: () => events.push("focus"),
    onLearnerChoice: () => events.push("learner"),
    runCommand: () => events.push("command"),
    askAgent: () => events.push("agent"),
  });
  assert.equal(handled, true);
  assert.deepEqual(events, ["focus"]);
  assert.deepEqual(draft, before);
});

test("every Harness action kind fails closed when no Local Agent is available", async (t) => {
  for (const [name, actionId, state] of [
    ["command", "local-progress", "ready"],
    ["local", "local-return-to-answer", "awaiting_answer"],
    ["agent", "coach-next-step", "ready"],
  ]) {
    await t.test(name, async () => {
      const events = [];
      const handled = await dispatchHarnessAction(actionId, {
        state,
        agentAvailable: false,
        onDisconnected: () => events.push("disconnected"),
        onLearnerChoice: () => events.push("learner"),
        runCommand: () => events.push("command"),
        focusAnswer: () => events.push("focus"),
        askAgent: () => events.push("agent"),
        onBlocked: () => events.push("blocked"),
      });
      assert.equal(handled, false);
      assert.deepEqual(events, ["disconnected"]);
    });
  }
});

test("Agent quick actions send once only when the objective permits it", async () => {
  const sent = [];
  assert.equal(await dispatchHarnessAction("coach-next-step", {
    state: "ready",
    agentAvailable: true,
    askAgent: async (message) => {
      sent.push(message);
      return true;
    },
  }), true);
  assert.equal(sent.length, 1);
  assert.equal(await dispatchHarnessAction("coach-next-step", {
    state: "awaiting_answer",
    agentAvailable: true,
    askAgent: async (message) => sent.push(message),
  }), false);
  assert.equal(sent.length, 1);
  assert.equal(await dispatchHarnessAction("coach-next-step", {
    state: "ready",
    agentAvailable: false,
    askAgent: async (message) => sent.push(message),
  }), false);
  assert.equal(sent.length, 1);
});

test("a failed Agent quick action stays retryable and a later success settles it", async () => {
  let attempts = 0;
  const context = {
    state: "ready",
    agentAvailable: true,
    async askAgent() {
      attempts += 1;
      return attempts === 2;
    },
  };
  assert.equal(await dispatchHarnessAction("coach-example", context), false);
  assert.equal(await dispatchHarnessAction("coach-example", context), true);
  assert.equal(attempts, 2);
});
