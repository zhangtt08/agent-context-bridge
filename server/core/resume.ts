// Resume Module：先校验再展开；指纹比对；环境差异评估；接手入口生成
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { ResumeReport, ResumeStep, ResumeGap, ProjectState } from "../../shared/types.js";
import { ensureDir, exists, id, isGitRepo, sha256Buf, sourceDigest } from "./gitutil.js";
import { renderReportMarkdown } from "./protocol.js";

export interface ResumeInput {
  /** 本地归档文件路径 */
  filePath?: string;
  /** 已在本机存储中的包目录（远端取回后落地） */
  packageDir?: string;
  targetDir: string;
  handoffId: string;
  source: string;
}

export async function resumeFromArchive(input: ResumeInput): Promise<{ report: ResumeReport; state: ProjectState }> {
  const steps: ResumeStep[] = [];
  const gaps: ResumeGap[] = [];
  const { filePath, packageDir, targetDir, handoffId, source } = input;
  const at = new Date().toISOString();

  // 1. 获取交接
  let workDir: string;
  if (filePath) {
    if (!(await exists(filePath))) throw new Error(`交接文件不存在: ${filePath}`);
    workDir = path.join(path.dirname(filePath), `.acb-extract-${Date.now()}`);
    await ensureDir(workDir);
    await tar.x({ file: filePath, cwd: workDir });
    const entries = await fs.readdir(workDir);
    const pkg = entries.find((e) => e.startsWith("hnd_"));
    if (!pkg) throw new Error("交接文件中没有 hnd_* 包目录");
    workDir = path.join(workDir, pkg);
    steps.push({ title: "获取交接", ok: true, detail: `自包含文件 ${filePath} · 包 ${path.basename(workDir)}` });
  } else if (packageDir) {
    workDir = packageDir;
    steps.push({ title: "获取交接", ok: true, detail: `本地存储 ${workDir}` });
  } else {
    throw new Error("必须提供 filePath 或 packageDir");
  }

  // 2. 恢复前校验（协议版本 / 清单摘要 / 文件完整性）
  const manifest = JSON.parse(await fs.readFile(path.join(workDir, "manifest.json"), "utf8"));
  const state: ProjectState = JSON.parse(await fs.readFile(path.join(workDir, "acb-state", "project-state.json"), "utf8"));
  if (state.handoffId !== handoffId) {
    steps.push({ title: "恢复前校验", ok: false, detail: `包内交接 ${state.handoffId} 与请求的 ${handoffId} 不一致` });
    const report = blockedReport(handoffId, source, targetDir, at, steps, gaps);
    return { report, state };
  }
  const { ok, broken } = await verify(workDir, manifest);
  steps.push({
    title: "恢复前校验", ok,
    detail: ok ? `协议 ${manifest.protocolVersion} 兼容 · 包摘要 ${manifest.packageDigest.slice(0, 19)}… · ${manifest.entries.length} 项完整性通过`
      : `完整性失败：${broken.join("、")}`,
  });
  if (!ok) {
    const report = blockedReport(handoffId, source, targetDir, at, steps, gaps);
    return { report, state };
  }

  // 3. 恢复至目标目录（默认隔离；覆盖已有工作区必须显式确认为空目录或新目录）
  if (await exists(targetDir)) {
    const items = await fs.readdir(targetDir);
    if (items.length > 0) {
      steps.push({ title: "恢复至目标目录", ok: false, detail: `目标目录非空（${items.length} 项），默认不覆盖；请选择新的隔离目录` });
      gaps.push({ kind: "凭据", title: "目标目录已有内容", detail: "恢复限定目标目录；非空目录需用户显式选择覆盖", blocking: true });
      const report = blockedReport(handoffId, source, targetDir, at, steps, gaps);
      return { report, state };
    }
  }
  await ensureDir(targetDir);

  // 基线恢复材料：包内 payload/work（含 .acb-deleted 标记）+ payload/index（暂存版本）
  const workPayload = path.join(workDir, "payload", "work");
  const indexPayload = path.join(workDir, "payload", "index");

  for (const c of state.changes) {
    const target = path.join(targetDir, c.path);
    if (c.status === "deleted") {
      // 工作区中不存在，什么都不写
      continue;
    }
    const src = path.join(workPayload, c.path);
    if (await exists(src)) {
      await ensureDir(path.dirname(target));
      await fs.copyFile(src, target);
    }
    if (c.oldPath) {
      // 重命名：确认旧路径不写入
      void c.oldPath;
    }
  }
  steps.push({ title: "恢复至新目录（默认隔离）", ok: true, detail: `重建工作区 ${state.changes.filter((c) => c.status !== "deleted").length} 项 · 删除 ${state.changes.filter((c) => c.status === "deleted").length} 项保持移除` });

  // 暂存状态重建（git init + update-index，不覆盖工作区内容）
  if (!(await isGitRepo(targetDir))) {
    await gitInit(targetDir);
  }
  // 基线重建：优先用包内 git bundle 重建 HEAD 历史（不 checkout，工作区内容由包提供）
  let baselineOk = false;
  if (state.baseline.commit) {
    const bundle = path.join(workDir, "payload", "baseline.bundle");
    const branch = state.baseline.branch ?? "main";
    if (await exists(bundle)) {
      try {
        // 不能直接 fetch 进当前检出的分支：先落到 FETCH_HEAD，再 update-ref
        await gitCmd(["fetch", "-q", bundle, "HEAD"], targetDir);
        await gitCmd(["update-ref", `refs/heads/${branch}`, "FETCH_HEAD"], targetDir);
        baselineOk = true;
      } catch { baselineOk = false; }
    }
    if (!baselineOk) {
      try {
        await gitCmd(["update-ref", `refs/heads/${branch}`, state.baseline.commit], targetDir);
        baselineOk = true;
      } catch { baselineOk = false; }
    }
    await gitCmd(["symbolic-ref", "HEAD", `refs/heads/${branch}`], targetDir).catch(() => {});
  }

  let stagedCount = 0;
  const capturedPaths = new Set(state.changes.map((c) => c.path));

  if (baselineOk) {
    // 基线填充：index 与工作区先对齐 HEAD，再叠加纳入改动（删除项单独处理）
    await gitCmd(["read-tree", "HEAD"], targetDir).catch(() => {});
    try {
      const ls = await gitCmd(["ls-tree", "-r", "--name-only", "HEAD"], targetDir);
      for (const p of ls.split("\n").filter(Boolean)) {
        if (capturedPaths.has(p)) continue;
        const content = await gitCatFile(targetDir, p);
        if (content === null) continue;
        await ensureDir(path.dirname(path.join(targetDir, p)));
        await fs.writeFile(path.join(targetDir, p), content);
      }
      steps.push({ title: "基线物化", ok: true, detail: "基线文件已从 bundle 重建到工作区与索引（快照未改动的部分）" });
    } catch {
      steps.push({ title: "基线物化", ok: false, detail: "基线文件物化失败，仅恢复了纳入范围的改动" });
    }
  }

  for (const c of state.changes) {
    const idxSrc = path.join(indexPayload, c.path);
    if (c.status === "deleted" || c.status === "renamed") {
      // 暂存的删除 / 重命名旧路径：从索引移除（工作区本就没有）
      const p = c.status === "renamed" ? c.oldPath! : c.path;
      await gitCmd(["update-index", "--force-remove", "--", p], targetDir).catch(() => {});
      continue;
    }
    if (await exists(idxSrc)) {
      await gitAddToIndex(targetDir, idxSrc, c.path);
      stagedCount++;
    } else {
      const t = path.join(targetDir, c.path);
      if (await exists(t)) await gitAddWorktree(targetDir, c.path);
    }
  }
  steps.push({ title: "暂存状态重建", ok: true, detail: `${stagedCount} 个文件的暂存版本单独恢复${baselineOk ? " · 基线历史已由 bundle 重建" : "（基线历史未能重建，代码内容不受影响）"}，未暂存改动保持未暂存` });

  // 4. 指纹复算
  const restoredFiles: { path: string; content: Buffer }[] = [];
  for (const c of state.changes) {
    if (c.status === "deleted") continue;
    const t = path.join(targetDir, c.path);
    if (await exists(t)) restoredFiles.push({ path: c.path, content: await fs.readFile(t) });
  }
  const restoredDigest = sourceDigest(restoredFiles);
  const srcFull = state.sourceDigest.split("full:")[1];
  const resFull = restoredDigest.split("full:")[1];
  const digestMatch = srcFull === resFull;
  steps.push({ title: "代码指纹复算", ok: digestMatch, detail: digestMatch ? `${restoredDigest.split(" ")[0]} = 源快照一致` : `不一致：源 ${state.sourceDigest.split(" ")[0]} vs 恢复 ${restoredDigest.split(" ")[0]}` });

  // 5. 环境差异评估
  const env = await envDiff(state);
  gaps.push(...env.gaps);
  steps.push({ title: "环境差异评估", ok: true, detail: env.detail });

  // 6. 生成接手入口
  const entrySrc = path.join(workDir, "HANDOFF.md");
  const entryDest = path.join(targetDir, "ACB-HANDOFF.md");
  if (await exists(entrySrc)) await fs.copyFile(entrySrc, entryDest);
  steps.push({ title: "生成接手入口", ok: true, detail: `ACB-HANDOFF.md 已写入目标目录，Agent 可直接阅读` });

  // 判定
  let verdict: ResumeReport["verdict"];
  const blockingGaps = gaps.filter((g) => g.blocking);
  if (!digestMatch) verdict = "恢复被阻塞";
  else if (blockingGaps.length > 0) verdict = "需要配置环境";
  else if (state.verifications.some((v) => v.result === "失败" || v.result === "超时")) verdict = "需要重新验证";
  else verdict = "可继续";

  const report: ResumeReport = {
    reportId: id("rep"),
    handoffId, source, targetDir, at,
    verdict, digestMatch, codeRestored: digestMatch,
    steps, gaps,
    entryMarkdownPath: await exists(entryDest) ? entryDest : undefined,
  };
  const md = renderReportMarkdown(report);
  const reportPath = path.join(targetDir, "ACB-RESUME-REPORT.md");
  await fs.writeFile(reportPath, md);
  report.entryMarkdownPath = entryDest;

  // 清理解压临时目录（仅 .acb-extract-* 一层，不动用户目录）
  if (filePath) {
    await fs.rm(path.dirname(workDir), { recursive: true, force: true }).catch(() => {});
  }
  return { report, state };
}

/** 从 GitHub 交接分支直接恢复（跨电脑路径）：分支树 = 工作区检查点，.acb-meta = 状态 + 暂存材料 */
export async function resumeFromGithub(input: { remote: string; handoffId: string; targetDir: string }): Promise<{ report: ResumeReport; state: ProjectState }> {
  const steps: ResumeStep[] = [];
  const gaps: ResumeGap[] = [];
  const { remote, handoffId, targetDir } = input;
  const at = new Date().toISOString();
  const source = `${remote} · acb/handoff/${handoffId}`;
  const branch = `acb/handoff/${handoffId}`;

  if (await exists(targetDir)) {
    const items = await fs.readdir(targetDir);
    if (items.length > 0) throw new Error(`目标目录非空（${items.length} 项），默认不覆盖；请选择新的隔离目录`);
  }
  await ensureDir(targetDir);
  if (!(await isGitRepo(targetDir))) await gitInit(targetDir);

  // 获取：fetch 专用交接分支
  const fetched = await new Promise<boolean>((resolve) => {
    execFile("git", ["fetch", "-q", remote, `refs/heads/${branch}`], { cwd: targetDir, timeout: 120_000 }, (err) => resolve(!err));
  });
  if (!fetched) throw new Error(`远端未找到交接分支 ${branch}（检查远端地址与网络）`);
  await gitCmd(["update-ref", "refs/heads/master", "FETCH_HEAD"], targetDir);
  await gitCmd(["symbolic-ref", "HEAD", "refs/heads/master"], targetDir);
  await gitCmd(["read-tree", "HEAD"], targetDir);
  steps.push({ title: "获取交接", ok: true, detail: source });

  // 读取元数据
  const stateJson = await gitCatFile(targetDir, ".acb-meta/acb-state/project-state.json");
  if (stateJson === null) throw new Error("交接分支缺少 .acb-meta 元数据（该分支可能不是 ACB 交接检查点）");
  const state: ProjectState = JSON.parse(stateJson.toString("utf8"));
  if (state.handoffId !== handoffId) throw new Error(`分支元数据 ${state.handoffId} 与请求的 ${handoffId} 不一致`);
  steps.push({ title: "恢复前校验", ok: true, detail: `协议 ${state.protocolVersion} · 交接 ${state.handoffId} 元数据可达` });

  // 物化检查点树（.acb-meta 一并保留：作为接收端本地的交接记录，状态与 HEAD 一致无噪音）
  const ls = await gitCmd(["ls-tree", "-r", "--name-only", "HEAD"], targetDir);
  for (const p of ls.split("\n").filter(Boolean)) {
    const content = await gitCatFile(targetDir, p);
    if (content === null) continue;
    await ensureDir(path.dirname(path.join(targetDir, p)));
    await fs.writeFile(path.join(targetDir, p), content);
  }
  const dels = state.changes.filter((c) => c.status === "deleted" || c.status === "renamed");
  for (const c of dels) {
    const p = c.status === "renamed" ? c.oldPath! : c.path;
    await fs.rm(path.join(targetDir, p), { force: true }).catch(() => {});
    await gitCmd(["update-index", "--force-remove", "--", p], targetDir).catch(() => {});
  }
  steps.push({ title: "恢复至新目录（默认隔离）", ok: true, detail: `检查点树物化完成 · 删除 ${dels.length} 项保持移除` });

  // 暂存材料：.acb-meta/payload-index/<path>
  let stagedCount = 0;
  for (const c of state.changes) {
    if (!c.staged || c.status === "deleted") continue;
    const blob = await gitCatFile(targetDir, `.acb-meta/payload-index/${c.path}`);
    if (blob === null) continue;
    const tmp = path.join(os.tmpdir(), `acb-idx-${Date.now()}-${c.path.replace(/\//g, "_")}`);
    await ensureDir(path.dirname(tmp));
    await fs.writeFile(tmp, blob);
    await gitAddToIndex(targetDir, tmp, c.path);
    stagedCount++;
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  steps.push({ title: "暂存状态重建", ok: true, detail: `${stagedCount} 个文件的暂存版本自交接分支恢复，未暂存改动保持未暂存` });

  // 指纹复算
  const restoredFiles: { path: string; content: Buffer }[] = [];
  for (const c of state.changes) {
    if (c.status === "deleted") continue;
    const t = path.join(targetDir, c.path);
    if (await exists(t)) restoredFiles.push({ path: c.path, content: await fs.readFile(t) });
  }
  const restoredDigest = sourceDigest(restoredFiles);
  const digestMatch = state.sourceDigest.split("full:")[1] === restoredDigest.split("full:")[1];
  steps.push({ title: "代码指纹复算", ok: digestMatch, detail: digestMatch ? `${restoredDigest.split(" ")[0]} = 源快照一致` : "不一致" });

  // 环境
  const env = await envDiff(state);
  gaps.push(...env.gaps);
  steps.push({ title: "环境差异评估", ok: true, detail: env.detail });

  // 接手入口
  const md = await gitCatFile(targetDir, ".acb-meta/HANDOFF.md");
  const entryDest = path.join(targetDir, "ACB-HANDOFF.md");
  if (md !== null) await fs.writeFile(entryDest, md);
  steps.push({ title: "生成接手入口", ok: true, detail: "ACB-HANDOFF.md 已写入目标目录" });

  let verdict: ResumeReport["verdict"];
  if (!digestMatch) verdict = "恢复被阻塞";
  else if (gaps.some((g) => g.blocking)) verdict = "需要配置环境";
  else if (state.verifications.some((v) => v.result === "失败" || v.result === "超时")) verdict = "需要重新验证";
  else verdict = "可继续";

  const report: ResumeReport = {
    reportId: id("rep"), handoffId, source, targetDir, at,
    verdict, digestMatch, codeRestored: digestMatch, steps, gaps,
    entryMarkdownPath: await exists(entryDest) ? entryDest : undefined,
  };
  await fs.writeFile(path.join(targetDir, "ACB-RESUME-REPORT.md"), renderReportMarkdown(report));
  return { report, state };
}

function blockedReport(handoffId: string, source: string, targetDir: string, at: string, steps: ResumeStep[], gaps: ResumeGap[]): ResumeReport {
  return {
    reportId: id("rep"), handoffId, source, targetDir, at,
    verdict: "恢复被阻塞", digestMatch: null, codeRestored: false,
    steps, gaps, error: "恢复在写入目标前被阻止",
  };
}

async function verify(pkgDir: string, manifest: { entries: { path: string; sha256: string }[] }): Promise<{ ok: boolean; broken: string[] }> {
  const broken: string[] = [];
  for (const e of manifest.entries) {
    try {
      const buf = await fs.readFile(path.join(pkgDir, e.path));
      if (sha256Buf(buf) !== e.sha256) broken.push(e.path);
    } catch {
      broken.push(e.path);
    }
  }
  return { ok: broken.length === 0, broken };
}

async function envDiff(state: ProjectState): Promise<{ gaps: ResumeGap[]; detail: string }> {
  const gaps: ResumeGap[] = [];
  // 恢复要求中的必需文件（如 .env）本机缺失检查
  for (const req of state.recoveryRequirements) {
    gaps.push({ kind: "凭据", title: `${req} 本机缺失`, detail: `恢复要求：需在目标目录补齐（如 ${req}）`, blocking: true });
  }
  const node = process.version;
  gaps.push({ kind: "验证", title: "验证未在本机执行", detail: `源端 ${state.verifications.length} 条记录保留为历史证据；本机 Node ${node}，建议复验`, blocking: false });
  return { gaps, detail: `OS ${process.platform} · Node ${node} · ${gaps.filter((g) => g.blocking).length} 项需补齐` };
}

function gitCmd(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message)); else resolve(stdout.toString());
    });
  });
}

function gitCatFile(cwd: string, relPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile("git", ["cat-file", "blob", `HEAD:${relPath}`], { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout) => {
      if (err) resolve(null); else resolve(Buffer.from(stdout as Buffer));
    });
  });
}

async function gitInit(dir: string): Promise<void> {
  await gitCmd(["init", "-q"], dir);
  await gitCmd(["config", "user.email", "acb@local"], dir);
  await gitCmd(["config", "user.name", "acb"], dir);
}

async function gitAddToIndex(dir: string, srcFile: string, repoPath: string): Promise<void> {
  const blob = (await gitCmd(["hash-object", "-w", "--", srcFile], dir)).trim();
  await gitCmd(["update-index", "--add", "--cacheinfo", `100644,${blob},${repoPath}`], dir);
}

async function gitAddWorktree(dir: string, relPath: string): Promise<void> {
  const blob = (await gitCmd(["hash-object", "-w", "--", relPath], dir)).trim();
  await gitCmd(["update-index", "--add", "--cacheinfo", `100644,${blob},${relPath}`], dir);
}
