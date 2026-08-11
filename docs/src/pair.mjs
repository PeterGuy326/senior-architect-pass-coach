import {
  LOOPBACK_PROTOCOL,
  PUBLIC_COACH_ORIGIN,
  isLocalAgentRuntimeOrigin,
} from "./local-agent-client.mjs";

const PAIRING_STATE = /^[A-Za-z0-9_-]{32,128}$/u;
const RUNTIME_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MESSAGE_TYPE = "coach.runtime.grant";

const approve = document.querySelector("#pair-approve");
const status = document.querySelector("#pair-status");
if (!approve || !status) throw new Error("PAIR_PAGE_CONTRACT_MISSING");

const state = new URL(location.href).searchParams.get("state") || "";
const eligible = isLocalAgentRuntimeOrigin(location.origin)
  && PAIRING_STATE.test(state)
  && window.opener
  && window.opener !== window;

function fail(message) {
  approve.disabled = true;
  status.dataset.state = "error";
  status.textContent = message;
}

if (!eligible) {
  fail("这个配对窗口无效。请回到正式私教页面重新点击“连接本机 Agent”。");
} else {
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    status.textContent = "正在创建一次性内存授权……";
    let payload;
    try {
      const response = await fetch("/v1/bootstrap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Coach-Protocol": LOOPBACK_PROTOCOL,
        },
        body: JSON.stringify({
          protocol: LOOPBACK_PROTOCOL,
          grant_origin: PUBLIC_COACH_ORIGIN,
        }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      const text = await response.text();
      payload = text ? JSON.parse(text) : {};
      if (
        !response.ok
        || payload.protocol !== LOOPBACK_PROTOCOL
        || !RUNTIME_TOKEN.test(payload.access_token)
        || typeof payload.instance_id !== "string"
        || payload.instance_id.length < 1
        || payload.instance_id.length > 128
      ) {
        throw new Error("invalid_runtime_grant");
      }
      window.opener.postMessage({
        type: MESSAGE_TYPE,
        protocol: LOOPBACK_PROTOCOL,
        state,
        access_token: payload.access_token,
        instance_id: payload.instance_id,
      }, PUBLIC_COACH_ORIGIN);
      payload.access_token = "";
      status.textContent = "已授权，正在返回私教页面……";
      window.setTimeout(() => window.close(), 120);
    } catch {
      if (payload && typeof payload === "object") payload.access_token = "";
      fail("授权失败。请确认 Runtime 版本匹配，然后关闭窗口重试。");
    }
  }, { once: true });
}
