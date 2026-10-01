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
import { resumeFromArchive, resumeFromGithub, previewArchiveResume, previewGithubResume } from "./core/resume.js";
import { buildPreview } from "./core/preview.js";
import { startJob, getJob } from "./core/jobs.js";
import { verifyPackage } from "./core/package.js";
import { gitStatus, isGitRepo, isWorkTree, resolveProjectDir, isExcluded, excludePolicySummary } from "./core/gitutil.js";
import type { ProjectConfig, ConflictPolicy } from "../shared/types.js";

const app = express();
app.use(express.json({ limit: "4mb" }));

const err = (res: express.Response, e: unknown, code = 400) =>
  res.status(code).json({ error: e instanceof Error ? e.message : String(e) });

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

// ---------- 项目 ----------
app.get("/api/projects", async (_req, res) => {
  res.json(await listProjects());
});

app.post("/api/projects", async (req, res) => {
  try {
    const { path: p, name } = req.body as { path: string; name?: string };
    if (!p) throw new Error("缺少 path");
    const dir = resolveProjectDir(p);
    if (!(await exists_(dir))) throw new Error(`目录不存在: ${dir}`);
    if (!(await isWorkTree(dir))) {
      if (await isGitRepo(dir)) throw new Error("这是 Git 裸仓库或 .git 目录，没有可交接的工作区文件；请选择包含代码的项目根目录");
      throw new Error("目录不是 Git 仓库（请先 git init 或选择已有仓库）");
    }
    const existing = await findProject(dir);
    const cfg: ProjectConfig = existing ?? {
      projectId: "prj_" + crypto.randomBytes(4).toString("hex"),
      name: name ?? path.basename(dir),
      path: dir,
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
        excluded: excludePolicySummary(),
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
        integrity: { label: "未核对", tone: "" },
      })),
      forksList: forks,
    });
  } catch (e) { err(res, e); }
});

/** 单个交接的包完整性实测（打开详情页时才跑，避免总览页逐包扫盘） */
app.get("/api/handoffs/:id/integrity", async (req, res) => {
  try {
    const projects = await listProjects();
    for (const p of projects) {
      const rec = await getHandoffRecord(p.path, req.params.id);
      if (!rec) continue;
      const c = await verifyPackage(rec.packageDir);
      return res.json({
        handoffId: rec.handoffId, ok: c.ok, entryCount: c.entryCount, verifiedCount: c.verifiedCount,
        broken: c.broken.slice(0, 20),
        label: c.ok ? `完整 · ${c.verifiedCount}/${c.entryCount}` : `异常 · ${c.verifiedCount}/${c.entryCount}`,
      });
    }
    return err(res, new Error("交接不存在"), 404);
  } catch (e) { err(res, e); }
});

/** 打包前审阅清单：只探测磁盘，不读内容、不写文件 */
app.get("/api/projects/:id/preview", async (req, res) => {
  try {
    const p = await findProject(req.params.id);
    if (!p) return err(res, new Error("项目未注册"), 404);
    if (!(await isGitRepo(p.path))) return err(res, new Error(`项目目录已不是 Git 仓库：${p.path}（在总览页重新注册，或确认它是否被移动/改名）`));
    res.json(await buildPreview(p));
  } catch (e) { err(res, e); }
});

/** 长任务进度：打包与还原都走这里，大仓库不再是"点了没反应" */
app.get("/api/jobs/:id", (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return err(res, new Error("任务不存在或已过期（20 分钟后清理）；重新发起一次即可，已封存的交接不受影响"), 404);
  res.json(j);
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
// async=true 时立即返回 jobId，进度走 GET /api/jobs/:id —— 大仓库不再"点了没反应"。
app.post("/api/projects/:id/handoffs", async (req, res) => {
  try {
    const p = await findProject(req.params.id);
    if (!p) return err(res, new Error("项目未注册"), 404);
    const { taskName, claimText, claimEvidence, nextStep, runChecks, parentHandoffIds, async: asJob } = req.body as {
      taskName: string; claimText?: string; claimEvidence?: string; nextStep?: string;
      runChecks?: boolean; parentHandoffIds?: string[]; async?: boolean;
    };
    if (!taskName || !taskName.trim()) throw new Error("缺少任务名：写一句另一台电脑上的 Agent 能看懂的话，例如「把登录超时从 3s 调到 8s 并补重试」");
    if (!(await isGitRepo(p.path))) throw new Error(`项目目录已不是 Git 仓库：${p.path}（在总览页重新注册，或确认它是否被移动/改名）`);
    const input = { taskName: taskName.trim(), claimText, claimEvidence, nextStep, runChecks, parentHandoffIds };

    if (asJob) {
      const jobId = startJob("capture", async (report) => createHandoff(p, { ...input, onProgress: report }), remedy);
      return res.json({ jobId });
    }
    res.json(await createHandoff(p, input));
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
    const { target, remote, outPath } = req.body as { target: "github" | "local"; remote?: string; outPath?: string };
    const projects = await listProjects();
    for (const p of projects) {
      const rec = await getHandoffRecord(p.path, req.params.id);
      if (!rec) continue;
      let receipt;
      if (target === "github") {
        const r = remote ?? p.githubRemote;
        if (!r) return err(res, new Error("未配置 GitHub 远端：在项目设置里填一个已存在的仓库地址（git ls-remote 能列出来的那个），或改用「导出本地文件」走 U 盘路径"));
        ({ receipt } = await publishGithub(p.path, rec, r));
      } else {
        const out = outPath?.trim() || path.join(os.homedir(), "Downloads", `acb-${rec.handoffId}.acb.tar.gz`);
        ({ receipt } = await publishLocal(rec, out));
      }
      rec.publications.push(receipt);
      await saveHandoffRecord(p.path, rec);
      return res.json({ receipt, record: rec });
    }
    return err(res, new Error(`交接不存在：${req.params.id}（确认本机注册表里还有这个项目；跨电脑请用交接文件或 GitHub 交接分支恢复）`), 404);
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
interface ResumeBody {
  mode: "file" | "remote" | "github";
  filePath?: string; projectId?: string; remote?: string; handoffId?: string;
  targetDir: string; onConflict?: ConflictPolicy; archiveSha256?: string; async?: boolean;
}

/** 解析恢复来源：本机封存目录 / 交接文件 / 远端分支，三处共用一段，避免"预览"和"恢复"认不同的源 */
async function resolveResumeSource(b: ResumeBody): Promise<{ input: { filePath?: string; packageDir?: string; handoffId?: string; targetDir: string; source: string; archiveSha256?: string; onConflict?: ConflictPolicy }; github?: { remote: string; handoffId: string } }> {
  if (!b.targetDir?.trim()) throw new Error("缺少目标目录：写一个空的目录路径（推荐新目录，ACB 默认不覆盖已有工作）");
  const targetDir = resolveProjectDir(b.targetDir.trim());
  if (b.mode === "file") {
    if (!b.filePath?.trim()) throw new Error("需要交接文件路径：点「选择文件」，或把 .acb.tar.gz 直接拖进本页");
    return { input: { filePath: b.filePath.trim(), handoffId: b.handoffId, targetDir, source: b.filePath.trim(), archiveSha256: b.archiveSha256, onConflict: b.onConflict } };
  }
  if (b.mode === "github") {
    const p = b.projectId ? await findProject(b.projectId) : undefined;
    const r = b.remote?.trim() || p?.githubRemote;
    if (!r) throw new Error("未配置 GitHub 远端：在「项目设置」填已存在的仓库地址，或在本页直接输入远端 URL");
    if (!b.handoffId?.trim()) throw new Error("远端恢复需要交接 ID：点「查看该仓库的交接」从远端选一个");
    return { input: { targetDir, handoffId: b.handoffId, source: `${r} · acb/handoff/${b.handoffId}`, onConflict: b.onConflict }, github: { remote: r, handoffId: b.handoffId.trim() } };
  }
  if (!b.projectId) throw new Error("本机封存恢复需要选择项目");
  const p = await findProject(b.projectId);
  if (!p) throw new Error(`项目未注册：${b.projectId}（在总览页重新注册该项目目录）`);
  const hid = b.handoffId?.trim() || (await loadHandoffRecords(p.path))[0]?.handoffId;
  if (!hid) throw new Error("本机封存存储里没有交接：跨电脑请用「本地交接文件」或「GitHub 交接分支」；先在这台电脑创建一次交接才会有封存记录");
  const rec = await getHandoffRecord(p.path, hid);
  if (!rec) throw new Error(`本机封存存储里没有该交接 ${hid}：跨电脑请用交接文件或 GitHub 交接分支恢复`);
  return { input: { packageDir: rec.packageDir, handoffId: hid, targetDir, source: `本机存储 · ${p.name}/${hid}`, onConflict: b.onConflict } };
}

/** 还原前的差异预览：整包校验 + 与目标目录比对，不写任何文件 */
app.post("/api/resume/preview", async (req, res) => {
  try {
    const b = req.body as ResumeBody;
    const { input, github } = await resolveResumeSource(b);
    if (github) {
      const pre = await previewGithubResume({ ...github, targetDir: input.targetDir });
      const s = pre.state;
      return res.json({
        github: pre,
        preview: s ? {
          handoffId: s.handoffId, projectName: s.projectName, taskName: s.taskName, sealedAt: s.createdAt,
          source: input.source, targetDir: input.targetDir, integrityOk: true,
          entryCount: s.changes.length, verifiedCount: s.changes.length, broken: [],
          packageDigest: "远端分支（无本地清单）", protocolVersion: s.protocolVersion,
          totalBytes: 0, willWrite: s.changes.filter((c) => c.status !== "deleted").length,
          willDelete: s.changes.filter((c) => c.status === "deleted" || c.status === "renamed").length,
          stagedCount: s.changes.filter((c) => c.staged).length,
          symlinkCount: s.changes.filter((c) => c.mode === "120000").length,
          baselineAvailable: true, conflicts: [],
          alerts: pre.reachable
            ? [{ level: "提示" as const, title: "远端分支恢复按检查点树物化", detail: "GitHub 路径的冲突判定在恢复时执行（需要先 fetch 才能比对内容）。", action: "选一个空目录最稳；非空目录会先拒绝，再让你选「跳过已存在」或「覆盖」。" }]
            : [{ level: "阻塞" as const, title: "远端分支不可达", detail: pre.detail, action: "确认远端地址与交接 ID，或先在源电脑完成发布。" }],
          sourceEnv: { os: s.environment.os, runtime: s.environment.runtime },
          archiveInfo: `远端 · ${pre.detail}`,
        } : null,
      });
    }
    const preview = await previewArchiveResume({ ...input, source: input.source });
    res.json({ preview });
  } catch (e) { err(res, e); }
});

app.post("/api/resume", async (req, res) => {
  try {
    const b = req.body as ResumeBody;
    const { input, github } = await resolveResumeSource(b);

    if (b.async) {
      const jobId = startJob("restore", async (report) => {
        const r = github
          ? await resumeFromGithub({ ...github, targetDir: input.targetDir, onConflict: input.onConflict, onProgress: report })
          : await resumeFromArchive({ ...input, onProgress: report });
        await saveResumeReport(r.report);
        return { report: r.report, taskName: r.state.taskName };
      }, remedy);
      return res.json({ jobId });
    }

    const r = github
      ? await resumeFromGithub({ ...github, targetDir: input.targetDir, onConflict: input.onConflict })
      : await resumeFromArchive(input);
    await saveResumeReport(r.report);
    res.json({ report: r.report, taskName: r.state.taskName });
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
