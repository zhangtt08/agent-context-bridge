/**
 * Agent API 错误类型（契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md v1）。
 * 失败必须回 `{ok:false,error:{code,message}}`；`code` 是给调用方分支用的稳定标识，
 * `message` 是给人看的那一句，`hint` 给可执行出路。内部堆栈绝不原样抛出去。
 *
 * HTTP 状态按本轮验收要求收窄：入参/未知工具/未找到/需要确认一律 400，
 * 只有真正的内部故障才是 500 —— 把调用方的错报成 500 会让 Agent 以为服务坏了去重试。
 */
export type AgentErrorCode =
  | "bad_input"
  | "unknown_tool"
  | "confirm_required"
  | "not_found"
  | "forbidden"
  | "internal_error";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly hint?: string;

  constructor(code: AgentErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.hint = hint;
  }
}

/** 未知异常 → internal_error（只带一句话，不带栈）。 */
export function toAgentError(e: unknown): AgentError {
  if (e instanceof AgentError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new AgentError("internal_error", `工具执行失败：${msg}`);
}

/** code → HTTP 状态：契约只承诺 400（调用方的错）与 500（服务端的错）。 */
export function agentHttpStatus(code: AgentErrorCode): number {
  return code === "internal_error" ? 500 : 400;
}
