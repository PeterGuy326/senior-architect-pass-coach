import { harnessAction } from "./harness-actions.mjs";

export async function dispatchHarnessAction(actionId, context = {}) {
  const action = harnessAction(actionId);
  if (!action || context.operating === true) return false;
  if (context.agentAvailable !== true) {
    context.onDisconnected?.();
    return false;
  }
  if (action.kind === "agent" && context.state === "awaiting_answer") {
    context.onBlocked?.("请先提交当前题；作答前 Agent 不会介入题面或答案判断。");
    return false;
  }
  if (action.kind === "command") {
    context.onLearnerChoice?.(action.label);
    await context.runCommand?.(action.command);
    return true;
  }
  if (action.kind === "local" && action.operation === "focus-answer") {
    context.focusAnswer?.();
    return true;
  }
  if (action.kind !== "agent") return false;
  context.onLearnerChoice?.(action.label);
  return await context.askAgent?.(action.message) === true;
}
