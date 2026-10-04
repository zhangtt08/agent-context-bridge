// ACB 本地服务：Express API（端口 5174，只监听 127.0.0.1），前端经 /api 访问核心 Module
//
// 安全边界（2026-10-05 验收后的形状，改这里之前先读 server/core/local-guard.ts 的注释）：
//  · 只绑回环；Host/Origin 不按请求自己的值判；ACB_LOCAL_TOKEN 可以再加一道写权限令牌；
//  · 任何"要执行的命令"只有一个入口（项目设置里的 checks[].cmd），写它要么走同源回环、要么带令牌；
//  · 存储读不出来的时候必须点名文件并降级，不能把一个坏文件变成"所有请求 500"。
import express from "express";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { Server } from "node:http";
import {
  addProject, findProject, listProjects, removeProject,
  loadResumeReports, storageNoticeLines,
} from "./core/store.js";
import { createHandoff } from "./core/workflow.js";
import { publishHandoff, HandoffNotFound } from "./core/publish.js";
import { previewResume, performResume, type ResumeRequest } from "./core/resume-flow.js";
import { buildPreview } from "./core/preview.js";
import { buildProjectOverview, locateHandoff, measureIntegrity, requireGitProject, OverviewNotFound } from "./core/overview.js";
import { registerProjectDir, saveProjectConfig, ProjectNotRegistered } from "./core/registry.js";
import { listRemoteHandoffs, fetchRemoteMeta } from "./core/transport.js";
import { startJob, getJob } from "./core/jobs.js";
import { assertSafeGitRemote, assertSafeHandoffId, UnsafeGitArgumentError } from "./core/remote-policy.js";
import { localGuard, resolveBindHost, assertLoopbackOrigins, DEFAULT_PORT } from "./core/local-guard.js";
import { createAgentRouter, createHealthHandler } from "./agent/routes.js";
import type { ProjectConfig } from "../shared/types.js";

const app = express();

/** 进程启动时刻：/api/health 的 uptime_ms 与 Agent 工具共用同一个基准 */
const BOOTED_AT = Date.now();

/** 实际监听端口：绑 0（桌面版随机端口）时由 startServer 回填，Host/Origin 校验读这一个值 */
const bound = { port: Number(process.env.ACB_PORT ?? DEFAULT_PORT) };

// ---- 第一道：本机守卫（必须在任何路由与 body 解析之前）----
app.use(localGuard({ port: () => bound.port, allowedOrigins: assertLoopbackOrigins(process.env.ACB_ALLOWED_ORIGINS) }));

app.use(express.json({ limit: "4mb" }));

// 解析层的错（坏 JSON、超大 body）必须在这一道回 JSON。落到 Express 默认处理器
// 会回一页 HTML（甲方探针实测：POST 畸形 JSON 得到 400 + `<!DOCTYPE html>`），
// 而契约要的是 {ok:false,error:{code,message}} —— Agent 读 HTML 只能报"服务坏了"。
// 只认这两类，其余原样 next()，不去抢路由自己的错误分类。
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const e = err as { type?: string; status?: number | string; message?: string };
  const parseFailed = e?.type === "entity.parse.failed" || e instanceof SyntaxError;
  const tooLarge = e?.type === "entity.too.large" || e?.status === 413;
  if (!parseFailed && !tooLarge) { next(err); return; }
  res.status(tooLarge ? 413 : 400).json({
    ok: false,
    error: {
      code: tooLarge ? "too_large" : "bad_json",
      message: tooLarge
        ? "请求体超过 4mb 上限 —— 这一条从一开始就没被读，不是读到一半截断。"
        : `请求体不是合法 JSON：${String(e?.message || "未知原因").slice(0, 160)}`,
    },
  });
});

// ---- 第二道：存储警告随响应露面（坏文件绝不能被静默当成"你还没有项目"）----
// 挂在 json 之前：res.json 被包一层，发送前把当前警告塞进响应头，
// REST 的形状因此一个字都不用改（界面照旧读数组），但 CLI/curl 也看得见问题。
app.use((req, res, next) => {
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    const w = storageNoticeLines();
    if (w.length && !res.headersSent) res.setHeader("x-acb-storage-warning", encodeURIComponent(w.join(" | ").slice(0, 600)));
    return send(body);
  }) as typeof res.json;
  next();
});

const err = (res: express.Response, e: unknown, code = 400) =>
  res.status(code).json({ error: e instanceof Error ? e.message : String(e) });

/**
 * 路由外壳：每条路由自己兜住异常。
 * 之前 GET /api/projects 这类没有 try/catch 的入口，一旦注册表是半截 JSON 就抛出去，
 * Express 5 会把它交给默认错误处理 → 每个请求 500 + 一段 HTML。
 * 现在：已知失败按类型给状态码，未知异常给 500 + JSON（并打日志）。
 *
 * 泛型 P 是为了保住 Express 5 从路径字面量推断出来的 params 类型（:id → string），
 * 否则 req.params.id 会是 string | string[]，每条路由都要多写一次转换。
 */
type RouteParams = Record<string, string>;

function route<P extends RouteParams>(
  fn: (req: express.Request<P>, res: express.Response) => Promise<void> | void,
): express.RequestHandler<P> {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (res.headersSent) { next(e); return; }
      if (e instanceof UnsafeGitArgumentError) { err(res, e, 400); return; }
      if (e instanceof OverviewNotFound || e instanceof HandoffNotFound || e instanceof ProjectNotRegistered) {
        err(res, e, 404);
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const status = statusFor(e);
      (status >= 500 ? console.error : console.warn)(`[acb] ${req.method} ${req.originalUrl} 失败(${status}):`, msg);
      err(res, e, status);
    }
  };
}

/**
 * 状态码判据：本项目由路由抛出的人写错误一律是「调用方能改的失败」（缺参数、目录不对、
 * 包已损坏……），按 400 回；只有 TypeError/ReferenceError/SyntaxError 这种「代码自己炸了」
 * 才算 500。之前 GET 类路由没有兜底，一个半截的 projects.json 会把每个请求变成 500 + HTML。
 */
function statusFor(e: unknown): number {
  return e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError ? 500 : 400;
}

/** 错误必须给得出下一步：把最常见的几种失败翻成动作 */
function remedy(msg: string): string | undefined {
  if (/不是 Git 仓库|无法交接|裸仓库/.test(msg)) return "在总览页重新选择一个包含代码的项目根目录（不是 .git 目录），或先 git init";
  if (/工作区持续发生变化/.test(msg)) return "停掉 watch 模式的构建/测试，或先提交一次，再重新创建交接";
  if (/目录不存在|不存在:/.test(msg)) return "检查路径是否被移动或改名；桌面版可把文件夹直接拖进窗口";
  if (/大小写/.test(msg)) return "先在源仓库把冲突路径改名，再创建交接";
  if (/凭据|remote|远端/.test(msg)) return "在项目设置里填写已存在的远端地址，或改用「导出本地文件」走 U 盘路径";
  if (/完整性|清单/.test(msg)) return "回源电脑重新创建并导出交接；封存后的包按设计不可原地修改";
  return undefined;
}

// ---------- Agent API 契约（先于 SPA 兜底注册，否则会被兜成 HTML）----------
const healthHandler = createHealthHandler({ bootedAt: BOOTED_AT, port: () => bound.port });
app.get("/api/health", (req, res) => {
  try {
    healthHandler(req, res, () => { res.status(500).json({ ok: false, error: { code: "internal_error", message: "健康检查没有被路由接住" } }); });
  } catch (e) {
    err(res, e, 500);
  }
});
app.use("/api/agent", createAgentRouter({ bootedAt: BOOTED_AT, port: () => bound.port }));

/** 存储层健康：坏文件点名 + 回落位置（与 /api/health 的 storage_warnings 同一份数据） */
app.get("/api/storage/health", route(async (_req, res) => {
  const projects = await listProjects();
  res.json({
    ok: true,
    data: {
      home: process.env.ACB_HOME || os.homedir(),
      projectsVisible: projects.length,
      warnings: storageNoticeLines(),
      note: storageNoticeLines().length
        ? "有文件读不出来：已按空清单继续服务，原文件一个字节没动。按上面的路径手工修复或换一个新目录启动。"
        : "存储读取全部正常。",
    },
  });
}));

// ---------- 项目 ----------
app.get("/api/projects", route(async (_req, res) => {
  res.json(await listProjects());
}));

app.post("/api/projects", route(async (req, res) => {
  const { path: p, name } = req.body as { path: string; name?: string };
  if (!p) throw new Error("缺少 path：要点「选择文件夹」，或把项目目录拖进窗口");
  const { config, alreadyRegistered } = await registerProjectDir(p, name);
  res.json({ ...config, alreadyRegistered });
}));

app.delete("/api/projects/:id", route(async (req, res) => {
  await removeProject(req.params.id);
  res.json({ ok: true });
}));

app.get("/api/projects/:id/config", route(async (req, res) => {
  const p = await findProject(req.params.id);
  if (!p) throw new ProjectNotRegistered(`项目未注册：${req.params.id}`);
  res.json(p);
}));

app.put("/api/projects/:id/config", route(async (req, res) => {
  const { checks, githubRemote, name } = req.body as Partial<ProjectConfig> & { checks?: unknown[] };
  const p = await saveProjectConfig(req.params.id, { name, githubRemote, checks });
  res.json(p);
}));

// ---------- 总览 ----------
app.get("/api/projects/:id/overview", route(async (req, res) => {
  res.json(await buildProjectOverview(req.params.id));
}));

/** 单个交接的包完整性实测（打开详情页时才跑，避免总览页逐包扫盘） */
app.get("/api/handoffs/:id/integrity", route(async (req, res) => {
  const id = assertSafeHandoffId(req.params.id);
  const located = await locateHandoff(id);
  if (!located) throw new HandoffNotFound(`交接不存在：${id}（确认本机注册表里还有这个项目）`);
  res.json(await measureIntegrity(located.record));
}));

/** 打包前审阅清单：只探测磁盘，不读内容、不写文件 */
app.get("/api/projects/:id/preview", route(async (req, res) => {
  const p = await requireGitProject(req.params.id);
  res.json(await buildPreview(p));
}));

/** 长任务进度：打包与还原都走这里，大仓库不再是"点了没反应" */
app.get("/api/jobs/:id", route((req, res) => {
  const j = getJob(req.params.id);
  if (!j) throw new Error("任务不存在或已过期（20 分钟后清理）；重新发起一次即可，已封存的交接不受影响");
  res.json(j);
}));

// ---------- 创建交接 ----------
// async=true 时立即返回 jobId，进度走 GET /api/jobs/:id —— 大仓库不再"点了没反应"。
app.post("/api/projects/:id/handoffs", route(async (req, res) => {
  const p = await requireGitProject(req.params.id);
  const { taskName, claimText, claimEvidence, nextStep, runChecks, parentHandoffIds, async: asJob } = req.body as {
    taskName: string; claimText?: string; claimEvidence?: string; nextStep?: string;
    runChecks?: boolean; parentHandoffIds?: string[]; async?: boolean;
  };
  if (!taskName || !taskName.trim()) throw new Error("缺少任务名：写一句另一台电脑上的 Agent 能看懂的话，例如「把登录超时从 3s 调到 8s 并补重试」");
  const input = { taskName: taskName.trim(), claimText, claimEvidence, nextStep, runChecks, parentHandoffIds };

  if (asJob) {
    const jobId = startJob("capture", async (report) => createHandoff(p, { ...input, onProgress: report }), remedy);
    res.json({ jobId });
    return;
  }
  res.json(await createHandoff(p, input));
}));

// ---------- 交接详情 / 发布 ----------
app.get("/api/handoffs/:id", route(async (req, res) => {
  const located = await locateHandoff(assertSafeHandoffId(req.params.id));
  if (!located) throw new HandoffNotFound(`交接不存在：${req.params.id}（确认本机注册表里还有这个项目；跨电脑请用交接文件或 GitHub 交接分支恢复）`);
  res.json({ record: located.record, project: located.project, children: located.children });
}));

app.post("/api/handoffs/:id/publish", route(async (req, res) => {
  const { target, remote, outPath } = req.body as { target: "github" | "local"; remote?: string; outPath?: string };
  if (remote !== undefined && remote !== null && remote !== "") assertSafeGitRemote(remote, "remote");
  const out = await publishHandoff(assertSafeHandoffId(req.params.id), target, remote ?? undefined, outPath ?? undefined);
  res.json({ receipt: out.receipt, record: out.record });
}));

// ---------- 远端交接列表 / 元数据 ----------
app.get("/api/remotes/handoffs", route(async (req, res) => {
  const { projectId, remote } = req.query as { projectId?: string; remote?: string };
  const p = projectId ? await findProject(projectId) : undefined;
  // 远端值来自 query：先过白名单再交给 git（--upload-pack=<cmd> 这类写法会直接执行命令）
  const r = assertSafeGitRemote(remote ?? p?.githubRemote ?? "", "remote");
  const cwd = p?.path ?? os.homedir();
  const list = await listRemoteHandoffs(cwd, r);
  const withMeta = await Promise.all(list.map(async (l) => {
    const meta = await fetchRemoteMeta(cwd, r, l.id).catch(() => null);
    return { ...l, taskName: meta?.state.taskName ?? null, parentHandoffIds: meta?.state.parentHandoffIds ?? [] };
  }));
  res.json(withMeta);
}));

// ---------- 恢复 ----------
type ResumeBody = ResumeRequest & { async?: boolean };

app.post("/api/resume/preview", route(async (req, res) => {
  const b = req.body as ResumeBody;
  if (b.remote) assertSafeGitRemote(b.remote, "remote");
  res.json(await previewResume(b));
}));

app.post("/api/resume", route(async (req, res) => {
  const b = req.body as ResumeBody;
  if (b.remote) assertSafeGitRemote(b.remote, "remote");
  if (b.async) {
    const jobId = startJob("restore", (report) => performResume(b, report), remedy);
    res.json({ jobId });
    return;
  }
  res.json(await performResume(b));
}));

app.get("/api/resume/reports", route(async (_req, res) => {
  res.json(await loadResumeReports());
}));

// ---------- 示例项目（验收辅助）----------
app.post("/api/demo/seed", route(async (_req, res) => {
  const demoRoot = path.join(os.tmpdir(), "acb-demo");
  const demoPath = path.join(demoRoot, "shopmate-api");
  await fs.rm(demoPath, { recursive: true, force: true });
  await fs.mkdir(path.join(demoPath, "src", "auth"), { recursive: true });
  await fs.mkdir(path.join(demoPath, "tests"), { recursive: true });
  const run = (args: string) => new Promise<void>((resolve, reject) => {
    exec(args, { cwd: demoPath }, (e) => e ? reject(e) : resolve());
  });
  await run("git init -q");
  await run("git config user.email demo@acb.local");
  await run("git config user.name acb-demo");
  await fs.writeFile(path.join(demoPath, "README.md"), "# shopmate-api\n\n演示项目：用于验收 ACB 交接闭环。\n");
  await fs.writeFile(path.join(demoPath, "src", "auth", "session.ts"), "export const TIMEOUT = 3000;\n");
  await fs.writeFile(path.join(demoPath, "src", "auth", "legacy.ts"), "// legacy\n");
  await run("git add -A");
  await run("git commit -qm init");
  // 脏工作区：已暂存 / 未暂存 / 新文件 / 暂存删除
  await fs.writeFile(path.join(demoPath, "src", "auth", "session.ts"), "export const TIMEOUT = 8000;\nexport const RETRY = 2;\n");
  await fs.writeFile(path.join(demoPath, "src", "auth", "middleware.ts"), "export const guard = () => true;\n");
  await run("git add src/auth/session.ts src/auth/middleware.ts");
  await fs.writeFile(path.join(demoPath, "src", "auth", "session.ts"), "export const TIMEOUT = 8500;\nexport const RETRY = 2;\n");
  await fs.writeFile(path.join(demoPath, "src", "retry.ts"), "export const withRetry = async <T,>(fn: () => Promise<T>) => fn();\n");
  await fs.writeFile(path.join(demoPath, "tests", "login.spec.ts"), "it(\"login ok\", () => {});\n");
  await run("git rm -q --cached src/auth/legacy.ts");
  await fs.rm(path.join(demoPath, "src", "auth", "legacy.ts"), { force: true });
  const cfg: ProjectConfig = {
    projectId: "prj_" + crypto.randomBytes(4).toString("hex"),
    name: "shopmate-api（示例）",
    path: demoPath,
    // 演示检查只跑一条无条件退 0 的 node 内联脚本：它是本项目自己写的常量，
    // 不是任何外来包里的内容（交接包按设计永不执行包内命令）。
    checks: [{ name: "typecheck（演示）", cmd: "node -e \"process.exit(0)\"" }],
  };
  await addProject(cfg);
  res.json(cfg);
}));

// 桌面模式：同源托管前端静态文件（dist/），SPA 回退（cwd 始终为应用根目录）
const distDir = path.resolve(process.cwd(), "dist");
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    res.sendFile(path.join(distDir, "index.html"));
  } else next();
});

export interface ServerHandle {
  server: Server;
  host: string;
  port: number;
  /** 测试与桌面壳退出用：等连接收干净再返回 */
  close: () => Promise<void>;
}

/**
 * 启动 HTTP 服务：只绑回环（ACB_BIND_HOST 也必须是个回环地址，否则这里就拒绝启动）。
 * port 传 0 则随机分配。返回实际地址、server 句柄与 close()。
 */
export function startServer(port: number = Number(process.env.ACB_PORT ?? DEFAULT_PORT)): Promise<ServerHandle> {
  const host = resolveBindHost();
  return new Promise<ServerHandle>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      bound.port = actual;
      console.log(`[acb] 服务已启动: http://127.0.0.1:${actual}（只监听回环；局域网访问按设计不可用）`);
      // 固定端口时把实际地址留给 MCP 桥与 personal-agent-hub 发现（随机端口不写，
      // 否则一次测试/一次桌面启动就会把发现文件改成谁也连不上的旧端口）
      if (port !== 0) void writeEndpoint(actual);
      resolve({
        server,
        host,
        port: actual,
        close: () => new Promise<void>((done, failClose) => {
          server.close((e) => (e ? failClose(e) : done()));
          server.closeAllConnections?.();
        }),
      });
    });
    server.on("error", (e) => reject(e));
  });
}

/** agent/.endpoint 是发现文件（生成物）；目录不在（打包版）就跳过，绝不为此新建目录 */
async function writeEndpoint(port: number): Promise<void> {
  const dir = path.resolve(process.cwd(), "agent");
  try {
    if (!(await isDir(dir))) return;
    await fs.writeFile(path.join(dir, ".endpoint"), `http://127.0.0.1:${port}`, "utf8");
  } catch { /* 发现文件写不了不影响服务本身 */ }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export default app;
