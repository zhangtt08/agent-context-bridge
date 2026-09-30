// ACB 本地服务：Express API（端口 5174），前端经 /api 访问核心 Module
import express from "express";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  addProject, findProject, listProjects, removeProject,
  loadHandoffRecords, getHandoffRecord, saveHandoffRecord, saveResumeReport, loadResumeReports,
} from "./core/store.js";
import { createHandoff } from "./core/workflow.js";
import { publishLocal, publishGithub, listRemoteHandoffs, fetchRemoteMeta } from "./core/transport.js";
import { resumeFromArchive, resumeFromGithub } from "./core/resume.js";
import { gitStatus, isGitRepo, isExcluded } from "./core/gitutil.js";
import type { ProjectConfig } from "../shared/types.js";

const app = express();
app.use(express.json({ limit: "4mb" }));

const err = (res: express.Response, e: unknown, code = 400) =>
  res.status(code).json({ error: e instanceof Error ? e.message : String(e) });

// ---------- 项目 ----------
app.get("/api/projects", async (_req, res) => {
  res.json(await listProjects());
});

app.post("/api/projects", async (req, res) => {
  try {
    const { path: p, name } = req.body as { path: string; name?: string };
    if (!p) throw new Error("缺少 path");
    const abs = path.resolve(p);
    if (!(await exists_(abs))) throw new Error(`目录不存在: ${abs}`);
    if (!(await isGitRepo(abs))) throw new Error("目录不是 Git 仓库（请先 git init 或选择已有仓库）");
    const existing = await findProject(abs);
    const cfg: ProjectConfig = existing ?? {
      projectId: "prj_" + crypto.randomBytes(4).toString("hex"),
      name: name ?? path.basename(abs),
      path: abs,
      checks: [],
    };
    if (name) cfg.name = name;
    await addProject(cfg);
    res.json(cfg);
  } catch (e) { err(res, e); }
});

app.delete("/api/projects/:id", async (req, res) => {
  await removeProject(req.params.id);
  res.json({ ok: true });
});

app.get("/api/projects/:id/config", async (req, res) => {
  const p = await findProject(req.params.id);
  if (!p) return err(res, new Error("项目未注册"), 404);
  res.json(p);
});

app.put("/api/projects/:id/config", async (req, res) => {
  try {
    const p = await findProject(req.params.id);
    if (!p) return err(res, new Error("项目未注册"), 404);
    const { checks, githubRemote, name } = req.body as Partial<ProjectConfig>;
    if (checks) p.checks = checks;
    if (githubRemote !== undefined) p.githubRemote = githubRemote;
    if (name) p.name = name;
    await addProject(p);
    res.json(p);
  } catch (e) { err(res, e); }
});

// ---------- 总览 ----------
app.get("/api/projects/:id/overview", async (req, res) => {
  try {
    const p = await findProject(req.params.id);
    if (!p) return err(res, new Error("项目未注册"), 404);
    if (!(await isGitRepo(p.path))) return err(res, new Error("项目目录已不是 Git 仓库"));

    const st = await gitStatus(p.path);
    const realEntries = st.entries.filter((e) => !isExcluded(e.path));
    const records = await loadHandoffRecords(p.path);
    const tasks = groupTasks(records);
    const forks = detectForks(records);

    res.json({
      config: p,
      branch: st.branch,
      commit: st.commit,
      dirty: {
        staged: realEntries.filter((e) => e.x !== " " && e.x !== "?").length,
        unstaged: realEntries.filter((e) => e.y === "M" || e.y === "D").length,
        untracked: realEntries.filter((e) => e.x === "?").length,
        excluded: [".env*", "node_modules/", "dist/", ".acb/"],
        total: realEntries.length,
        env: { os: `${process.platform}`, node: process.version },
      },
      stats: {
        changes: realEntries.length,
        activeTasks: tasks.filter((t) => t.status === "进行中").length,
        published: records.filter((r) => r.publications.some((x) => x.state === "已发布")).length,
        forks: forks.length,
        failedChecks: records.filter((r) => r.state.verifications.some((v) => v.result !== "通过" && v.result !== "未执行")).length,
      },
      tasks,
      handoffs: records.slice(0, 10).map((r) => ({
        handoffId: r.handoffId,
        taskName: r.state.taskName,
        sealedAt: r.sealedAt,
        snapshot: `${r.state.baseline.commit?.slice(0, 7) ?? "无"} + ${r.state.changes.length} 文件`,
        publish: latestPublication(r),
        verify: verifySummary(r),
        integrity: { label: "完整", tone: "green" },
      })),
      forksList: forks,
    });
  } catch (e) { err(res, e); }
});

function groupTasks(records: Awaited<ReturnType<typeof loadHandoffRecords>>) {
  const map = new Map<string, { taskId: string; taskName: string; status: string; handoffs: { id: string; at: string }[]; latest?: { id: string; at: string } }>();
  for (const r of records) {
    const t = map.get(r.state.taskId) ?? { taskId: r.state.taskId, taskName: r.state.taskName, status: "进行中", handoffs: [] };
    t.handoffs.push({ id: r.handoffId, at: r.sealedAt });
    if (!t.latest || t.latest.at < r.sealedAt) t.latest = { id: r.handoffId, at: r.sealedAt };
    map.set(r.state.taskId, t);
  }
  return [...map.values()].map((t) => ({
    ...t,
    latestHandoff: t.latest?.id ?? "—",
    handoffTime: t.latest?.at ?? "",
  }));
}

function detectForks(records: Awaited<ReturnType<typeof loadHandoffRecords>>) {
  const forks: { parent: string; children: string[] }[] = [];
  const byParent = new Map<string, string[]>();
  for (const r of records) {
    for (const p of r.state.parentHandoffIds) {
      byParent.set(p, [...(byParent.get(p) ?? []), r.handoffId]);
    }
  }
  for (const [parent, children] of byParent) {
    if (children.length > 1) forks.push({ parent, children });
  }
  return forks;
}

function latestPublication(r: Awaited<ReturnType<typeof loadHandoffRecords>>[number]) {
  const pub = r.publications[r.publications.length - 1];
  if (!pub) return { label: "未发布", tone: "" };
  if (pub.state === "已发布") return { label: pub.target === "github" ? `已发布 · ${pub.location.split("·").pop()?.trim()}` : `本地导出`, tone: "green" };
  if (pub.state === "失败") return { label: `发布失败`, tone: "red" };
  return { label: pub.state, tone: "" };
}

function verifySummary(r: Awaited<ReturnType<typeof loadHandoffRecords>>[number]) {
  const vs = r.state.verifications;
  if (vs.length === 0) return { label: "未执行", tone: "" };
  const fail = vs.filter((v) => v.result === "失败" || v.result === "超时" || v.result === "执行器错误").length;
  if (fail > 0) return { label: `${fail} 项失败`, tone: "red" };
  return { label: "检查通过", tone: "green" };
}

// ---------- 创建交接 ----------
app.post("/api/projects/:id/handoffs", async (req, res) => {
  try {
    const p = await findProject(req.params.id);
    if (!p) return err(res, new Error("项目未注册"), 404);
    const { taskName, claimText, claimEvidence, nextStep, runChecks, parentHandoffIds } = req.body as {
      taskName: string; claimText?: string; claimEvidence?: string; nextStep?: string; runChecks?: boolean; parentHandoffIds?: string[];
    };
    if (!taskName) throw new Error("缺少任务名");
    const result = await createHandoff(p, { taskName, claimText, claimEvidence, nextStep, runChecks, parentHandoffIds });
    res.json(result);
  } catch (e) { err(res, e); }
});

// ---------- 交接详情 / 发布 ----------
app.get("/api/handoffs/:id", async (req, res) => {
  try {
    const projects = await listProjects();
    for (const p of projects) {
      const rec = await getHandoffRecord(p.path, req.params.id);
      if (rec) {
        const all = await loadHandoffRecords(p.path);
        const children = all.filter((r) => r.state.parentHandoffIds.includes(req.params.id)).map((r) => r.handoffId);
        return res.json({ record: rec, project: p, children });
      }
    }
    return err(res, new Error("交接不存在"), 404);
  } catch (e) { err(res, e); }
});

app.post("/api/handoffs/:id/publish", async (req, res) => {
  try {
    const { target, remote } = req.body as { target: "github" | "local"; remote?: string };
    const projects = await listProjects();
    for (const p of projects) {
      const rec = await getHandoffRecord(p.path, req.params.id);
      if (!rec) continue;
      let receipt;
      if (target === "github") {
        const r = remote ?? p.githubRemote;
        if (!r) return err(res, new Error("未配置 GitHub 远端（在项目配置中填写 remote URL）"));
        ({ receipt } = await publishGithub(p.path, rec, r));
      } else {
        const out = path.join(os.homedir(), "Downloads", `acb-${rec.handoffId}.acb.tar.gz`);
        ({ receipt } = await publishLocal(rec, out));
      }
      rec.publications.push(receipt);
      await saveHandoffRecord(p.path, rec);
      return res.json({ receipt, record: rec });
    }
    return err(res, new Error("交接不存在"), 404);
  } catch (e) { err(res, e); }
});

// ---------- 远端交接列表 / 元数据 ----------
app.get("/api/remotes/handoffs", async (req, res) => {
  try {
    const { projectId, remote } = req.query as { projectId?: string; remote?: string };
    const p = projectId ? await findProject(projectId) : undefined;
    const r = remote ?? p?.githubRemote;
    const cwd = p?.path ?? os.homedir();
    if (!r) return err(res, new Error("未配置远端"));
    const list = await listRemoteHandoffs(cwd, r);
    const withMeta = await Promise.all(list.map(async (l) => {
      const meta = await fetchRemoteMeta(cwd, r, l.id).catch(() => null);
      return { ...l, taskName: meta?.state.taskName ?? null, parentHandoffIds: meta?.state.parentHandoffIds ?? [] };
    }));
    res.json(withMeta);
  } catch (e) { err(res, e); }
});

// ---------- 恢复 ----------
app.post("/api/resume", async (req, res) => {
  try {
    const { mode, filePath, projectId, remote, handoffId, targetDir } = req.body as {
      mode: "file" | "remote" | "github"; filePath?: string; projectId?: string; remote?: string; handoffId?: string; targetDir: string;
    };
    if (!targetDir) throw new Error("缺少目标目录");
    if (mode === "file") {
      if (!filePath || !handoffId) throw new Error("文件恢复需要 filePath 与 handoffId");
      const { report, state } = await resumeFromArchive({ filePath, handoffId, targetDir, source: filePath });
      await saveResumeReport(report);
      return res.json({ report, taskName: state.taskName });
    }
    if (mode === "github") {
      if (!handoffId) throw new Error("远端恢复需要 handoffId");
      const p = projectId ? await findProject(projectId) : undefined;
      const r = remote ?? p?.githubRemote;
      if (!r) throw new Error("未配置 GitHub 远端");
      const { report, state } = await resumeFromGithub({ remote: r, handoffId, targetDir });
      await saveResumeReport(report);
      return res.json({ report, taskName: state.taskName });
    }
    // remote 模式：从本机封存存储恢复（未指定交接 ID 时默认最新封存）
    if (!projectId) throw new Error("远端恢复需要 projectId");
    const p = await findProject(projectId);
    if (!p) throw new Error("项目未注册");
    const hid = handoffId ?? (await loadHandoffRecords(p.path))[0]?.handoffId;
    if (!hid) throw new Error("本机存储中没有交接（跨电脑请使用交接文件或 GitHub 交接分支恢复）");
    const rec = await getHandoffRecord(p.path, hid);
    if (!rec) throw new Error("本机存储中没有该交接（跨电脑请使用交接文件或 GitHub 交接分支恢复）");
    const { report, state } = await resumeFromArchive({ packageDir: rec.packageDir, handoffId: hid, targetDir, source: `本机存储 · ${p.name}/${hid}` });
    await saveResumeReport(report);
    return res.json({ report, taskName: state.taskName });
  } catch (e) { err(res, e); }
});

app.get("/api/resume/reports", async (_req, res) => {
  res.json(await loadResumeReports());
});

// ---------- 示例项目（验收辅助） ----------
app.post("/api/demo/seed", async (_req, res) => {
  try {
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
      checks: [{ name: "typecheck（演示）", cmd: "node -e \"process.exit(0)\"" }],
    };
    await addProject(cfg);
    res.json(cfg);
  } catch (e) { err(res, e); }
});

function exists_(p: string) {
  return fs.access(p).then(() => true).catch(() => false);
}

// 桌面模式：同源托管前端静态文件（dist/），SPA 回退（cwd 始终为应用根目录）
const distDir = path.resolve(process.cwd(), "dist");
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    res.sendFile(path.join(distDir, "index.html"));
  } else next();
});

/** 启动 HTTP 服务；port 传 0 则随机分配。返回实际端口。 */
export function startServer(port: number = Number(process.env.ACB_PORT ?? 5174)): Promise<number> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const actual = (server.address() as { port: number }).port;
      console.log(`[acb] 服务已启动: http://localhost:${actual}`);
      resolve(actual);
    });
  });
}

export default app;
