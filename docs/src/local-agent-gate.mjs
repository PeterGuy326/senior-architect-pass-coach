const ENGINE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const NON_AGENT_ENGINE_IDS = new Set(["content-only", "constructor", "prototype"]);

export const LOCAL_AGENT_GATE_STATES = Object.freeze({
  REQUIRED: "required",
  CHOOSE_AGENT: "choose_agent",
  READY: "ready",
});

export function localAgentGateState({ connected = false, engine = null, selectable = false } = {}) {
  if (connected !== true) return LOCAL_AGENT_GATE_STATES.REQUIRED;
  if (
    typeof engine !== "string"
    || !ENGINE_ID.test(engine)
    || NON_AGENT_ENGINE_IDS.has(engine)
    || selectable !== true
  ) {
    return LOCAL_AGENT_GATE_STATES.CHOOSE_AGENT;
  }
  return LOCAL_AGENT_GATE_STATES.READY;
}

export function localAgentGateCopy(state) {
  if (state === LOCAL_AGENT_GATE_STATES.READY) {
    return Object.freeze({
      title: "本机 Agent 已接入",
      detail: "可以开始建档、复习或直接对话。",
      action: "已接入",
    });
  }
  if (state === LOCAL_AGENT_GATE_STATES.CHOOSE_AGENT) {
    return Object.freeze({
      title: "Runtime 已连接，还要选择一个 Agent",
      detail: "只有通过本私教员工契约检查的本机 Agent 才能解锁对话与复习，不会自动改选其他模型。",
      action: "选择本机 Agent",
    });
  }
  return Object.freeze({
    title: "先接入本机 Agent，再开始私教",
    detail: "这里不提供浏览器伪聊天机器人，也不会在失败时退回规则话术。安装一次 Runtime，然后由你明确选择本机 Agent。",
    action: "连接并选择本机 Agent",
  });
}

export function assertLocalAgentAccess({ connected = false, engine = null, selectable = false } = {}) {
  const state = localAgentGateState({ connected, engine, selectable });
  if (state !== LOCAL_AGENT_GATE_STATES.READY) {
    const error = new Error(localAgentGateCopy(state).detail);
    error.code = "LOCAL_AGENT_REQUIRED";
    error.gateState = state;
    throw error;
  }
  return true;
}
