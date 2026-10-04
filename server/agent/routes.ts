/**
 * Agent API 端点（契约：personal-agent-hub/docs/AGENT_API_STANDARD.md v1，就地接入形状 B）。
 *
 *   GET  /api/health          契约健康检查
 *   GET  /api/agent/manifest  项目身份 + 工具清单
 *   GET  /api/agent/tools     [{name,description,input_schema,risk}]
 *   POST /api/agent/tool      {tool,input} -> {ok:true,data,tool,ms}
 *
 * 为什么不另起一个进程/端口：ACB 本来就有常驻 Express（5174），再起一个 agent 服务就是
 * 第二个端口、第二份启动方式和两份会漂移的实现（本轮验收也明确要求"就地实现，不新增端口"）。
 *
 * ⚠ 挂载顺序：这些必须**先于** express.static 与 SPA 回退注册，
 * 否则未知路径会被兜底成 index.html 的 HTML，Agent 读到的是 200 + 一段 HTML。
 *
 * ⚠ 兜底只兜 /api/agent/*：把兜底挂在 /api 上会把 /api/projects 这类 REST 路由一起吃掉。
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { AGENT_API_VERSION, AGENT_PROJECT_ID, AGENT_TOOLS, executeAgentTool, type AgentContext } from "./tools.js";
import { agentHttpStatus, toAgentError, type AgentErrorCode } from "./errors.js";
import { storageNoticeLines } from "../core/store.js";
import { DEFAULT_PORT } from "../core/local-guard.js";

let cachedVersion: string | null = null;

/**
 * 版本只有一个来源：package.json。读不出来时如实回 "unknown"，
 * 不硬编码一个数字冒充当前版本（硬编码的版本号一定会腐烂）。
 */
export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const p = path.resolve(process.cwd(), "package.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string; name?: string };
    if (j.name === "acb" && typeof j.version === "string") {
      cachedVersion = j.version;
      return cachedVersion;
    }
  } catch { /* 读不到就按 unknown */ }
  return "unknown";
}

/** base_url 只回环：把 localhost 归一成 127.0.0.1 —— 别的机器拿到这个地址应该连不上，那是设计意图 */
export function baseUrlOf(req: express.Request): string {
  const host = req.headers.host?.trim();
  if (!host) return `http://127.0.0.1:${DEFAULT_PORT}`;
  return `http://${host.replace(/^localhost/i, "127.0.0.1")}`;
}

function fail(res: express.Response, code: AgentErrorCode, message: string, hint?: string, http?: number): void {
  res.status(http ?? agentHttpStatus(code)).json({
    ok: false,
    error: {
      code,
      message,
      // unknown_tool 的可用清单必须是机器可读的数组：只写在 message 里 Agent 解析不到
      ...(code === "unknown_tool" ? { available: AGENT_TOOLS.map((t) => t.name) } : {}),
      ...(hint ? { hint } : {}),
    },
  });
}

function toolViews() {
  return AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk }));
}

export interface AgentRouterOptions {
  /** 进程启动时刻（uptime_ms 的分母） */
  bootedAt: number;
  /** 实际监听端口（Host/Origin 校验用的同一个值；绑 0 时由 startServer 回填） */
  port: () => number;
}

/** GET /api/health —— 单独导出，由 index.ts 挂在 app 上（它不在 /api/agent 前缀下） */
export function createHealthHandler(opts: AgentRouterOptions): express.RequestHandler {
  return (req, res) => {
    res.json({
      ok: true,
      data: {
        project: AGENT_PROJECT_ID,
        version: appVersion(),
        agent_api: AGENT_API_VERSION,
        uptime_ms: Date.now() - opts.bootedAt,
        tools: AGENT_TOOLS.length,
        base_url: baseUrlOf(req),
        listening_port: opts.port(),
        /** 只回答"要不要令牌"，绝不回显值 */
        local_token_required: Boolean(process.env.ACB_LOCAL_TOKEN?.trim()),
        /** 存储层警告：坏文件不会被静默降级成"空库"，健康检查里就能看见 */
        storage_warnings: storageNoticeLines(),
      },
    });
  };
}

/** /api/agent/* —— 挂在 app.use("/api/agent", router) */
export function createAgentRouter(opts: AgentRouterOptions): express.Router {
  const router = express.Router();
  const ctxFor = (req: express.Request): AgentContext => ({ bootedAt: opts.bootedAt, port: opts.port() });

  router.get("/manifest", (req, res) => {
    res.json({
      ok: true,
      data: {
        project: AGENT_PROJECT_ID,
        name: "ACB · Agent Context Bridge",
        version: appVersion(),
        base_url: baseUrlOf(req),
        agent_api: AGENT_API_VERSION,
        tools: toolViews(),
        conventions: {
          envelope: "{ok:true,data} / {ok:false,error:{code,message}}",
          single_entrypoint: "POST /api/agent/tool",
          bind: "只监听 127.0.0.1（ACB_BIND_HOST 也只接受回环地址）",
          confirm: "risk 为 exec/destructive 的工具必须带 input.confirm=true；缺了回 400 confirm_required",
          rest: "界面用的 REST 路由与 Agent 工具互不替代：契约端点由 agent/tools 提供",
        },
      },
    });
  });

  router.get("/tools", (_req, res) => {
    res.json({ ok: true, data: toolViews() });
  });

  router.post("/tool", async (req, res) => {
    const t0 = Date.now();
    const body = (req.body ?? {}) as { tool?: unknown; input?: unknown };
    try {
      const r = await executeAgentTool(body.tool, body.input, ctxFor(req));
      res.json({ ok: true, data: r.data, tool: r.tool, risk: r.risk, ms: Date.now() - t0 });
    } catch (e) {
      const err = toAgentError(e);
      if (err.code === "internal_error") console.error("[acb][agent]", err.message);
      fail(res, err.code, err.message, err.hint);
    }
  });

  // 走到这里的是 /api/agent 下拼错的方法或路径：仍然回契约形状 + 出路，绝不落到 SPA 的 HTML。
  // 用 router.use() 而不是 "/agent/*"：Express 5 的 path-to-regexp 不接受裸 *，
  // 而这个兜底也只在 /api/agent 前缀内生效（挂在 app.use("/api/agent", router) 之下）。
  router.use((req, res) => {
    if (req.path === "/tool" && req.method !== "POST") {
      fail(
        res,
        "bad_input",
        `调用工具请用 POST /api/agent/tool，body 形如 {tool:"acb.projects_list",input:{}}（收到 ${req.method} ${req.originalUrl}）。`,
        "工具清单在 GET /api/agent/tools。",
      );
      return;
    }
    fail(
      res,
      "unknown_tool",
      `Agent 契约只有四个端点：GET /api/health、GET /api/agent/manifest、GET /api/agent/tools、POST /api/agent/tool（收到 ${req.method} ${req.originalUrl}）。`,
      "见 personal-agent-hub/docs/AGENT_API_STANDARD.md。",
    );
  });

  return router;
}
