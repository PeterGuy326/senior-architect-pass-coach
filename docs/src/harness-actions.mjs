const ACTION_ID = /^[a-z][a-z0-9_-]{0,47}$/u;

const ACTIONS = Object.freeze({
  "coach-next-step": Object.freeze({
    id: "coach-next-step",
    label: "告诉我下一步",
    kind: "agent",
    message: "请结合当前可用的去标识化学习证据，只告诉我现在最值得做的一步，以及完成标准。",
  }),
  "coach-assess-gap": Object.freeze({
    id: "coach-assess-gap",
    label: "先判断我的薄弱点",
    kind: "agent",
    message: "请只根据当前可用的去标识化学习证据，指出最需要核对的一个薄弱点，并问我一个关键问题。",
  }),
  "coach-simplify": Object.freeze({
    id: "coach-simplify",
    label: "讲简单一点",
    kind: "agent",
    message: "请把刚才的内容压缩成三句话：核心边界、常见误区、下一步动作。",
  }),
  "coach-example": Object.freeze({
    id: "coach-example",
    label: "换个架构例子",
    kind: "agent",
    message: "请换一个不含答案或选项的架构场景，用来说明刚才的方法，并给出一条可执行的复习动作。",
  }),
  "coach-drill": Object.freeze({
    id: "coach-drill",
    label: "安排 5 分钟微练",
    kind: "agent",
    message: "请根据刚才暴露的不足安排一个五分钟微练习，只给练习步骤和完成标准，不改写学习进度。",
  }),
  "proactive-clear": Object.freeze({
    id: "proactive-clear",
    label: "能说清关键依据",
    kind: "agent",
    message: "我认为自己能说清刚才追问的关键依据。请不要把这当作掌握证据；继续用一个反例核对我是否真的理解。",
  }),
  "proactive-partial": Object.freeze({
    id: "proactive-partial",
    label: "有点模糊",
    kind: "agent",
    message: "我对刚才的追问有点模糊。请先给一个不泄露答案的最小提示，再告诉我复述时必须包含哪两个关键词。",
  }),
  "proactive-unknown": Object.freeze({
    id: "proactive-unknown",
    label: "还不会",
    kind: "agent",
    message: "我还不会回答刚才的追问。请从最小概念边界开始，用三句话带我补齐，再安排一次复述。",
  }),
  "local-next-question": Object.freeze({
    id: "local-next-question",
    label: "直接做下一题",
    kind: "command",
    command: "continue",
  }),
  "local-progress": Object.freeze({
    id: "local-progress",
    label: "查看当前进度",
    kind: "command",
    command: "progress",
  }),
  "local-return-to-answer": Object.freeze({
    id: "local-return-to-answer",
    label: "继续完成当前题",
    kind: "local",
    operation: "focus-answer",
  }),
});

export const HARNESS_ACTION_GROUPS = Object.freeze({
  agent_entry: Object.freeze(["coach-assess-gap", "coach-next-step", "local-progress"]),
  agent_reply: Object.freeze(["coach-next-step", "coach-assess-gap", "local-progress"]),
  agent_reply_feedback: Object.freeze(["coach-simplify", "coach-drill", "local-next-question"]),
  feedback_coaching: Object.freeze(["coach-example", "coach-drill", "local-next-question"]),
  proactive_answer: Object.freeze(["proactive-clear", "proactive-partial", "proactive-unknown"]),
  awaiting_answer: Object.freeze(["local-return-to-answer"]),
});

export function harnessAction(id) {
  if (typeof id !== "string" || !ACTION_ID.test(id)) return null;
  return Object.hasOwn(ACTIONS, id) ? ACTIONS[id] : null;
}

export function harnessActionChoices(ids) {
  if (!Array.isArray(ids)) return Object.freeze([]);
  return Object.freeze(ids
    .slice(0, 3)
    .map((id) => harnessAction(id))
    .filter(Boolean)
    .map(({ id, label }) => Object.freeze({ id, label })));
}
