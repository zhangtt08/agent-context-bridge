// Resume Module：先校验再展开；指纹比对；环境差异评估；接手入口生成
// 两条入口分开：previewArchiveResume() 一个字节都不写，只回答"恢复会发生什么"；
// resumeFromArchive() 才动手，并按 onConflict 处理与目标目录的冲突。
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  ResumeReport, ResumeStep, ResumeGap, ProjectState, PackageManifest,
  ResumePreview, ResumeConflict, PreviewAlert, ConflictPolicy,
} from "../../shared/types.js";
import { ensureDir, exists, id, isGitRepo, sha256File, sourceDigest, isSafeRelPath, fmtBytes, caseCollisions } from "./gitutil.js";
import { checkEntries } from "./package.js";
import { normalizeLink } from "./capture.js";
import { renderReportMarkdown } from "./protocol.js";

export type Progress = (stage: string, pct: number, message: string) => void;

export interface ResumeInput {
  /** 本地归档文件路径 */
  filePath?: string;
  /** 已在本机存储中的包目录（远端取回后落地） */
  packageDir?: string;
  targetDir: string;
  /** 可省略：包内 record/manifest 自带交接 ID，省略时以包内为准 */
  handoffId?: string;
  source: string;
  /** 期望的归档 SHA-256（导出回执里有） */
  archiveSha256?: string;
  /** 与目标目录撞车时怎么办：默认 abort（不覆盖任何已有内容） */
  onConflict?: ConflictPolicy;
  onProgress?: Progress;
}

export interface LoadedPackage {
  workDir: string;
  manifest: PackageManifest;
  state: ProjectState;
  integrity: { ok: boolean; broken: string[]; entryCount: number; verifiedCount: number };
  archiveSha256?: string;
  archiveBytes?: number;
  /** 结束时必须调用：删掉解压临时目录，不在用户机器上留残骸 */
  dispose: () => Promise<void>;
}

/** 解包 + 逐条校验，不落任何用户目录 */
async function loadPackage(input: ResumeInput): Promise<LoadedPackage> {
  const { filePath, packageDir, handoffId, onProgress, archiveSha256 } = input;
  let workDir: string;
  let tmpRoot: string | null = null;
  let sha: string | undefined;
  let bytes: number | undefined;

  if (filePath) {
    if (!(await exists(filePath))) throw new Error(`交接文件不存在: ${filePath}（用「选择文件」挑，或把 .acb.tar.gz 直接拖进本页）`);
    sha = await sha256File(filePath);
    bytes = (await fs.stat(filePath)).size;
    if (archiveSha256 && sha !== archiveSha256) {
      throw new Error(`交接文件摘要与回执不符：期望 ${archiveSha256.slice(0, 16)}…，实际 ${sha.slice(0, 16)}…（文件在传输中被改动或拿错了，请回源电脑重新导出）`);
    }
    tmpRoot = path.join(path.dirname(filePath), `.acb-extract-${Date.now()}-${process.pid}`);
    await ensureDir(tmpRoot);
    workDir = tmpRoot;
    onProgress?.("解包", 15, "正在解压交接文件");
    try {
      await tar.x({ file: filePath, cwd: tmpRoot });
    } catch (e) {
      // 解压失败也要把临时目录收掉，并在用户目录旁边留下现场是不可能的 —— 只留一句可执行的说明
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      throw new Error(`交接文件解压失败：${e instanceof Error ? e.message : String(e)}。出路：核对导出回执里的 SHA-256；不一致说明传输中被改动，回源电脑重新导出。`);
    }
    const entries = await fs.readdir(tmpRoot);
    const pkg = entries.find((e) => e.startsWith("hnd_"));
    if (!pkg) throw new Error("交接文件中没有 hnd_* 包目录：它可能不是 ACB 导出的文件（在源电脑「创建交接 → 导出本地文件」得到 *.acb.tar.gz）");
    workDir = path.join(tmpRoot, pkg);
  } else if (packageDir) {
    if (!(await exists(packageDir))) throw new Error(`本机封存目录不存在：${packageDir}`);
    workDir = packageDir;
  } else {
    throw new Error("必须提供 filePath 或 packageDir");
  }

  const dispose = async () => {
    // 只删本次解压目录自身（.acb-extract-*），绝不删它的父目录 —— 父目录是用户放交接文件的地方
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  };

  let manifest: PackageManifest;
  let state: ProjectState;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(workDir, "manifest.json"), "utf8"));
    state = JSON.parse(await fs.readFile(path.join(workDir, "acb-state", "project-state.json"), "utf8"));
  } catch (e) {
    await dispose();
    throw new Error(`交接包结构不完整（manifest.json / project-state.json 读不出）：${e instanceof Error ? e.message : String(e)}。这份包可能只压了一半，回源电脑重新导出。`);
  }

  onProgress?.("校验清单", 35, `正在逐条核对 ${manifest.entries.length} 个条目`);
  const integrity = await checkEntries(workDir, manifest);
  const expect = handoffId?.trim().replace(/^acb-/, "").replace(/\.acb\.tar\.gz$/, "");
  if (expect && state.handoffId !== expect) {
    await dispose();
    throw new Error(`包内交接 ID 是 ${state.handoffId}，与请求的 ${expect} 不一致：你可能选错了文件，或把 ID 填串了。留空则按包内的 ${state.handoffId} 恢复。`);
  }
  return { workDir, manifest, state, integrity, archiveSha256: sha, archiveBytes: bytes, dispose };
}

/** 从包 + 目标目录推出"恢复会发生什么"，不写任何东西 */
export async function previewArchiveResume(input: ResumeInput): Promise<ResumePreview> {
  const loaded = await loadPackage(input);
  try {
    return await buildPreview(loaded, input);
  } finally {
    await loaded.dispose();
  }
}

async function buildPreview(loaded: LoadedPackage, input: ResumeInput): Promise<ResumePreview> {
  const { state, manifest, integrity, workDir } = loaded;
  const targetDir = input.targetDir;
  const conflicts: ResumeConflict[] = [];
  const alerts: PreviewAlert[] = [];

  let totalBytes = 0;
  let willWrite = 0;
  let symlinkCount = 0;
  for (const c of state.changes) {
    if (c.status === "deleted") continue;
    if (!isSafeRelPath(c.path)) {
      alerts.push({ level: "阻塞", title: `包内路径无法安全落地：${c.path}`, detail: "含绝对路径、盘符或 .. 片段。", action: "这份包不该继续恢复；回源电脑确认工作区后重新创建交接。" });
      continue;
    }
    const src = path.join(workDir, "payload", "work", c.path);
    if (await exists(src)) {
      willWrite++;
      const st = await fs.lstat(src);
      totalBytes += st.size;
      if (c.mode === "120000") symlinkCount++;
      const dst = path.join(targetDir, c.path);
      if (await exists(dst)) {
        const dstBuf = await fs.readFile(dst).catch(() => null);
        const srcBuf = await fs.readFile(src).catch(() => null);
        conflicts.push({
          path: c.path,
          identical: !!dstBuf && !!srcBuf && dstBuf.equals(srcBuf),
          packageBytes: srcBuf?.length ?? 0,
          targetBytes: dstBuf?.length ?? 0,
        });
      }
    }
  }

  const bundleAvailable = state.baseline.commit ? await exists(path.join(workDir, "payload", "baseline.bundle")) : false;
  if (!integrity.ok) {
    alerts.push({
      level: "阻塞", title: `包完整性未通过（${integrity.verifiedCount}/${integrity.entryCount}）`,
      detail: integrity.broken.slice(0, 8).join("、") + (integrity.broken.length > 8 ? " 等" : ""),
      action: "不要试图手工补文件。回源电脑重新创建并导出交接（封存后的包按设计不可原地修改）。",
    });
  }
  const collisions = caseCollisions(state.changes.map((c) => c.path));
  if (collisions.length) {
    alerts.push({
      level: "阻塞", title: `包内有仅大小写不同的路径：${collisions[0].join(" / ")}`,
      detail: "本机的文件系统不分大小写，恢复时其中一个会被另一个静默覆盖，代码指纹随之不一致。",
      action: "换到区分大小写的目录/系统恢复，或回源电脑改名后重新创建交接。",
    });
  }
  if (!bundleAvailable && state.baseline.commit) {
    alerts.push({
      level: "警告", title: "包内没有基线 bundle，HEAD 历史无法重建",
      detail: "改动内容仍会恢复，但基线提交里没有改到的那些文件不会出现，接收端 git log 也会是空的。",
      action: "若这份包是旧版本 ACB 导出的，请回源电脑重新创建交接；或先把原仓库 clone 到目标目录再恢复。",
    });
  }
  if (state.recoveryRequirements.length) {
    alerts.push({
      level: "警告", title: `${state.recoveryRequirements.length} 项凭据/配置需要本机补齐`,
      detail: state.recoveryRequirements.join("；"),
      action: "恢复完成后在本机放置这些文件（不要从源电脑把它们拷进交接包），否则项目可能跑不起来。",
    });
  }
  if (symlinkCount) {
    alerts.push({
      level: "提示", title: `${symlinkCount} 个符号链接需要重建`,
      detail: "Windows 上创建符号链接需要开发者模式或管理员权限；没有权限时 ACB 会退化成写入链接目标的普通文件，并在报告里如实标注，绝不静默。",
      action: "要完整还原链接形态，请在开启开发者模式的机器上恢复，或按报告里的清单手工补回。",
    });
  }
  if (state.environment.os !== process.platform) {
    alerts.push({
      level: "提示", title: `跨操作系统：源端 ${state.environment.os} → 本机 ${process.platform}`,
      detail: "换行符、路径分隔符、可执行位与符号链接都可能表现不同；代码内容按字节核对，表现差异会写进报告。",
      action: "恢复后先跑一次本机的检查命令，不要拿源端的通过记录当本机结论。",
    });
  }

  return {
    handoffId: state.handoffId,
    projectName: state.projectName,
    taskName: state.taskName,
    sealedAt: state.createdAt,
    source: input.source,
    targetDir,
    integrityOk: integrity.ok,
    entryCount: integrity.entryCount,
    verifiedCount: integrity.verifiedCount,
    broken: integrity.broken,
    packageDigest: manifest.packageDigest,
    protocolVersion: manifest.protocolVersion,
    totalBytes,
    willWrite,
    willDelete: state.changes.filter((c) => c.status === "deleted" || c.status === "renamed").length,
    stagedCount: state.changes.filter((c) => c.staged).length,
    symlinkCount,
    baselineAvailable: bundleAvailable,
    conflicts,
    alerts,
    sourceEnv: { os: state.environment.os, runtime: state.environment.runtime },
    archiveInfo: loaded.archiveBytes ? `归档 ${fmtBytes(loaded.archiveBytes)} · sha256 ${loaded.archiveSha256?.slice(0, 16)}…` : "本机封存目录，无归档摘要",
  };
}

/** 按包内模式读回内容：符号链接读链接目标文本（与源端算法一致，否则指纹必然对不上） */
async function readRestoredEntry(dest: string, mode: string): Promise<Buffer | null> {
  try {
    if (mode === "120000") {
      const st = await fs.lstat(dest);
      // Windows 的 readlink 会把目标里的 / 换成 \；归一化后才与源端（Git 用 / 存 120000 blob）一致
      if (st.isSymbolicLink()) return Buffer.from(normalizeLink(await fs.readlink(dest)), "utf8");
    }
    return await fs.readFile(dest);
  } catch {
    return null;
  }
}

export async function resumeFromArchive(input: ResumeInput): Promise<{ report: ResumeReport; state: ProjectState }> {
  const steps: ResumeStep[] = [];
  const gaps: ResumeGap[] = [];
  const { targetDir, source, onProgress } = input;
  const at = new Date().toISOString();
  const report = (stage: string, pct: number, message: string) => onProgress?.(stage, pct, message);

  const loaded = await loadPackage(input);
  const { workDir, manifest, state, integrity } = loaded;
  let placeholderLinks = 0;
  let restoredCount = 0;
  let unsafeSkipped = 0;

  try {
    steps.push({
      title: "获取交接", ok: true,
      detail: input.filePath
        ? `自包含文件 ${input.filePath} · ${fmtBytes(loaded.archiveBytes ?? 0)} · sha256 ${loaded.archiveSha256?.slice(0, 16)}…`
        : `本地存储 ${workDir}`,
    });
    steps.push({
      title: "恢复前校验", ok: integrity.ok,
      detail: integrity.ok
        ? `协议 ${manifest.protocolVersion} · 包摘要 ${manifest.packageDigest.slice(0, 19)}… · ${integrity.verifiedCount}/${integrity.entryCount} 条目逐条核对通过`
        : `完整性失败：${integrity.broken.join("、")}（${integrity.verifiedCount}/${integrity.entryCount} 通过）—— 回源电脑重新创建并导出交接，不要手工补文件`,
    });
    if (!integrity.ok) return { report: blockedReport(state.handoffId, source, targetDir, at, steps, gaps, integrity), state };

    // 冲突处理：非空目标目录不再一句话挡死，而是给出撞车清单与三条出路
    const existing = (await exists(targetDir)) ? await fs.readdir(targetDir) : [];
    const conflicts = await collectConflicts(state, workDir, targetDir);
    if (existing.length > 0 && conflicts.length > 0 && (input.onConflict ?? "abort") === "abort") {
      steps.push({
        title: "恢复至目标目录", ok: false,
        detail: `目标目录已有 ${existing.length} 项，其中 ${conflicts.length} 个路径与交接内容撞车（${conflicts.slice(0, 4).map((c) => c.path).join("、")}${conflicts.length > 4 ? " 等" : ""}）；默认不覆盖`,
      });
      gaps.push({
        kind: "环境", title: "目标目录与交接内容冲突",
        detail: `出路三选一：① 换一个空目录恢复（推荐，隔离最干净）；② 选「跳过已存在」只写入没有的路径；③ 选「覆盖」用包内版本替换 ${conflicts.filter((c) => !c.identical).length} 个不同的文件。`,
        blocking: true,
      });
      return { report: blockedReport(state.handoffId, source, targetDir, at, steps, gaps, integrity), state };
    }
    await ensureDir(targetDir);

    // 写工作区材料
    const workPayload = path.join(workDir, "payload", "work");
    const indexPayload = path.join(workDir, "payload", "index");
    report("写入工作区", 55, `正在恢复 ${state.changes.length} 个路径`);

    for (const c of state.changes) {
      if (c.status === "deleted") continue;
      if (!isSafeRelPath(c.path)) { unsafeSkipped++; continue; }
      const src = path.join(workPayload, c.path);
      const target = path.join(targetDir, c.path);
      if (!(await exists(src))) continue;
      if ((input.onConflict === "skip") && (await exists(target))) continue;
      await ensureDir(path.dirname(target));
      await fs.rm(target, { force: true, recursive: false }).catch(() => {});
      const st = await fs.lstat(src);
      if (c.mode === "120000" || st.isSymbolicLink()) {
        const linkText = (await fs.readFile(src, "utf8")).toString();
        const made = await fs.symlink(linkText, target).then(() => true).catch(() => false);
        if (!made) { await fs.writeFile(target, linkText); placeholderLinks++; }
      } else {
        await fs.copyFile(src, target);
        if (c.mode === "100755") await fs.chmod(target, 0o755).catch(() => {});
      }
      restoredCount++;
    }
    if (unsafeSkipped) gaps.push({ kind: "环境", title: `${unsafeSkipped} 个包内路径被跳过`, detail: "含绝对路径/盘符/../ 片段，写入它们会落到目标目录之外。这份包不该继续用于交接，请回源电脑重新创建。", blocking: true });
    if (placeholderLinks) gaps.push({ kind: "环境", title: `${placeholderLinks} 个符号链接退化为普通文件`, detail: "本机没有创建符号链接的权限（Windows 需开发者模式或管理员）。文件内容是链接目标文本，已如实计入，不算作已完整还原。", blocking: false });
    steps.push({
      title: "恢复至目标目录", ok: true,
      detail: `写入 ${restoredCount} 项（跳过 ${state.changes.filter((c) => c.status === "deleted").length} 项删除语义保持移除${input.onConflict === "skip" ? " · 已存在的路径按选择跳过" : ""}${placeholderLinks ? ` · ${placeholderLinks} 个符号链接退化为普通文件` : ""}）`,
    });

    // git 结构与索引
    if (!(await isGitRepo(targetDir))) await gitInit(targetDir);
    let baselineOk = false;
    if (state.baseline.commit) {
      const bundle = path.join(workDir, "payload", "baseline.bundle");
      const branch = state.baseline.branch ?? "main";
      if (await exists(bundle)) {
        try {
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

    const capturedPaths = new Set(state.changes.map((c) => c.path));
    let baselineFiles = 0;
    if (baselineOk) {
      report("重建基线", 70, "正在从 bundle 重建基线历史与未改动文件");
      await gitCmd(["read-tree", "HEAD"], targetDir).catch(() => {});
      try {
        const ls = await gitCmd(["ls-tree", "-r", "--name-only", "HEAD"], targetDir);
        const modeMap = await indexModeMap(targetDir);
        for (const p of ls.split("\n").filter(Boolean)) {
          if (capturedPaths.has(p) || !isSafeRelPath(p)) continue;
          const content = await gitCatFile(targetDir, p);
          if (content === null) continue;
          const dest = path.join(targetDir, p);
          await ensureDir(path.dirname(dest));
          await fs.rm(dest, { force: true }).catch(() => {});
          const mode = modeMap.get(p) ?? "100644";
          if (mode === "120000") {
            const ok = await fs.symlink(content.toString("utf8"), dest).then(() => true).catch(() => false);
            if (!ok) { await fs.writeFile(dest, content); placeholderLinks++; }
          } else {
            await fs.writeFile(dest, content);
            if (mode === "100755") await fs.chmod(dest, 0o755).catch(() => {});
          }
          baselineFiles++;
        }
        steps.push({ title: "基线物化", ok: true, detail: `基线 ${baselineFiles} 个未改动文件已从 bundle 重建到工作区与索引` });
      } catch {
        steps.push({ title: "基线物化", ok: false, detail: "基线文件物化失败，仅恢复了纳入范围的改动 —— 代码内容仍按指纹核对，但 git log 与未改动文件不完整" });
      }
    } else if (state.baseline.commit) {
      steps.push({ title: "基线物化", ok: false, detail: "包内缺少 baseline.bundle，基线历史无法重建；改动内容不受影响" });
    }

    report("重建暂存区", 82, "正在恢复索引状态");
    let stagedCount = 0;
    for (const c of state.changes) {
      const idxSrc = path.join(indexPayload, c.path);
      if (c.status === "deleted" || c.status === "renamed") {
        const p = c.status === "renamed" ? c.oldPath! : c.path;
        if (isSafeRelPath(p)) await gitCmd(["update-index", "--force-remove", "--", p], targetDir).catch(() => {});
        continue;
      }
      if (await exists(idxSrc)) {
        await gitAddToIndex(targetDir, idxSrc, c.path, c.mode);
        stagedCount++;
      } else {
        const t = path.join(targetDir, c.path);
        if (await exists(t)) await gitAddWorktree(targetDir, c.path, c.mode);
      }
    }
    steps.push({
      title: "暂存状态重建", ok: true,
      detail: `${stagedCount} 个文件的暂存版本单独恢复${baselineOk ? " · 基线历史已由 bundle 重建" : "（基线历史未能重建，代码内容不受影响）"}，未暂存改动保持未暂存`,
    });

    // 指纹复算（按模式读回：符号链接取链接目标文本，否则必然假阴性）
    report("核对指纹", 90, "正在复算恢复后的代码指纹");
    const restoredFiles: { path: string; content: Buffer }[] = [];
    for (const c of state.changes) {
      if (c.status === "deleted" || !isSafeRelPath(c.path)) continue;
      const buf = await readRestoredEntry(path.join(targetDir, c.path), c.mode);
      if (buf !== null) restoredFiles.push({ path: c.path, content: buf });
    }
    const restoredDigest = sourceDigest(restoredFiles);
    const srcFull = state.sourceDigest.split("full:")[1];
    const resFull = restoredDigest.split("full:")[1];
    const digestMatch = srcFull === resFull;
    steps.push({
      title: "代码指纹复算", ok: digestMatch,
      detail: digestMatch
        ? `${restoredDigest.split(" ")[0]} = 源快照一致（复算覆盖 ${restoredFiles.length} 个文件 / 清单 ${integrity.entryCount} 条）`
        : `不一致：源 ${state.sourceDigest.split(" ")[0]} vs 恢复 ${restoredDigest.split(" ")[0]} —— 逐条比对"包完整性校验"那一步的失败项，或按下方缺口处理`,
    });

    const env = await envDiff(state);
    gaps.push(...env.gaps);
    steps.push({ title: "环境差异评估", ok: true, detail: env.detail });

    const entrySrc = path.join(workDir, "HANDOFF.md");
    const entryDest = path.join(targetDir, "ACB-HANDOFF.md");
    if (await exists(entrySrc)) await fs.copyFile(entrySrc, entryDest);
    steps.push({ title: "生成接手入口", ok: true, detail: `ACB-HANDOFF.md 已写入目标目录，Agent 可直接阅读：${entryDest}` });

    let verdict: ResumeReport["verdict"];
    const blockingGaps = gaps.filter((g) => g.blocking);
    if (!digestMatch) verdict = "恢复被阻塞";
    else if (blockingGaps.length > 0) verdict = "需要配置环境";
    else if (state.verifications.some((v) => v.result === "失败" || v.result === "超时")) verdict = "需要重新验证";
    else verdict = "可继续";

    const out: ResumeReport = {
      reportId: id("rep"),
      handoffId: state.handoffId, source, targetDir, at,
      verdict, digestMatch, codeRestored: digestMatch,
      steps, gaps,
      entryMarkdownPath: await exists(entryDest) ? entryDest : undefined,
      entryCount: integrity.entryCount,
      verifiedCount: integrity.verifiedCount,
      restoredCount,
      archiveSha256: loaded.archiveSha256,
    };
    await fs.writeFile(path.join(targetDir, "ACB-RESUME-REPORT.md"), renderReportMarkdown(out));

    report("完成", 99, `恢复结束：${verdict}`);
    return { report: out, state };
  } finally {
    await loaded.dispose();
  }
}

async function collectConflicts(state: ProjectState, workDir: string, targetDir: string): Promise<ResumeConflict[]> {
  const out: ResumeConflict[] = [];
  const work = path.join(workDir, "payload", "work");
  for (const c of state.changes) {
    if (c.status === "deleted" || !isSafeRelPath(c.path)) continue;
    const src = path.join(work, c.path);
    const dst = path.join(targetDir, c.path);
    if (!(await exists(src)) || !(await exists(dst))) continue;
    const a = await readRestoredEntry(dst, c.mode);
    const b = await fs.readFile(src).catch(() => null);
    out.push({ path: c.path, identical: !!a && !!b && a.equals(b), packageBytes: b?.length ?? 0, targetBytes: a?.length ?? 0 });
  }
  return out;
}

async function indexModeMap(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const out = await gitCmd(["ls-files", "-s"], dir);
    for (const line of out.split("\n")) {
      const m = /^(\d{6}) [0-9a-f]+ (?:\d+\t)?(.*)$/.exec(line.trim());
      if (m) map.set(m[2], m[1]);
    }
  } catch { /* 无索引 */ }
  return map;
}

/** GitHub 恢复前的轻量预览：不落地，只看分支可达与元数据 */
export async function previewGithubResume(input: { remote: string; handoffId: string; targetDir: string; cwd?: string }): Promise<{ reachable: boolean; state?: ProjectState; detail: string }> {
  const branch = `acb/handoff/${input.handoffId}`;
  const cwd = input.cwd ?? os.homedir();
  try {
    const out = await gitCmd(["ls-remote", input.remote, `refs/heads/${branch}`], cwd);
    if (!out.trim()) return { reachable: false, detail: `远端没有分支 ${branch}：确认远端地址与交接 ID，或在源电脑先「发布到 GitHub」。` };
    const sha = out.split("\t")[0].trim();
    await gitCmd(["fetch", "-q", input.remote, `refs/heads/${branch}`], cwd).catch(() => {});
    const meta = await gitCmd(["cat-file", "-p", `${sha}:.acb-meta/acb-state/project-state.json`], cwd).catch(() => "");
    if (!meta) return { reachable: true, detail: `分支可见但取不到 .acb-meta 元数据：该分支可能不是 ACB 交接检查点。` };
    const state = JSON.parse(meta) as ProjectState;
    return { reachable: true, state, detail: `远端提交 ${sha.slice(0, 10)} · ${state.changes.length} 项改动 · 封存于 ${state.createdAt}` };
  } catch (e) {
    return { reachable: false, detail: `远端查询失败：${e instanceof Error ? e.message : String(e)}（检查网络、远端地址与本机 git 凭据）` };
  }
}

/** 从 GitHub 交接分支直接恢复（跨电脑路径）：分支树 = 工作区检查点，.acb-meta = 状态 + 暂存材料 */
export async function resumeFromGithub(input: {
  remote: string; handoffId: string; targetDir: string; onConflict?: ConflictPolicy; onProgress?: Progress;
}): Promise<{ report: ResumeReport; state: ProjectState }> {
  const steps: ResumeStep[] = [];
  const gaps: ResumeGap[] = [];
  const { remote, handoffId, targetDir, onProgress } = input;
  const report2 = (stage: string, pct: number, message: string) => onProgress?.(stage, pct, message);
  const at = new Date().toISOString();
  const source = `${remote} · acb/handoff/${handoffId}`;
  const branch = `acb/handoff/${handoffId}`;

  if (await exists(targetDir)) {
    const items = await fs.readdir(targetDir);
    if (items.length > 0 && (input.onConflict ?? "abort") === "abort") {
      throw new Error(`目标目录非空（${items.length} 项），默认不覆盖。出路：换一个空目录，或选择「跳过已存在」/「覆盖」后重试。`);
    }
  }
  report2("连接远端", 10, "正在从远端取回交接分支");
  await ensureDir(targetDir);
  if (!(await isGitRepo(targetDir))) await gitInit(targetDir);

  const fetched = await new Promise<boolean>((resolve) => {
    execFile("git", ["fetch", "-q", remote, `refs/heads/${branch}`], { cwd: targetDir, timeout: 120_000 }, (err, _o, stderr) => {
      if (err) console.warn("[acb] fetch 失败:", stderr);
      resolve(!err);
    });
  });
  if (!fetched) throw new Error(`远端未找到交接分支 ${branch}。出路：确认远端地址（可留空用项目设置里的）、交接 ID 是否正确；网络受限时回源电脑用「导出本地文件」再走文件恢复。`);
  await gitCmd(["update-ref", "refs/heads/master", "FETCH_HEAD"], targetDir);
  await gitCmd(["symbolic-ref", "HEAD", "refs/heads/master"], targetDir);
  await gitCmd(["read-tree", "HEAD"], targetDir);
  steps.push({ title: "获取交接", ok: true, detail: source });

  const stateJson = await gitCatFile(targetDir, ".acb-meta/acb-state/project-state.json");
  if (stateJson === null) throw new Error("交接分支缺少 .acb-meta 元数据（该分支可能不是 ACB 交接检查点，或发布时读取确认没走完）");
  const state: ProjectState = JSON.parse(stateJson.toString("utf8"));
  if (state.handoffId !== handoffId) throw new Error(`分支元数据 ${state.handoffId} 与请求的 ${handoffId} 不一致：不要用别的分支的 ID 恢复`);
  const manifestJson = await gitCatFile(targetDir, ".acb-meta/manifest.json");
  steps.push({ title: "恢复前校验", ok: manifestJson !== null, detail: `协议 ${state.protocolVersion} · 交接 ${state.handoffId} 元数据${manifestJson !== null ? "与清单均已取回" : "缺少清单（分支可能是旧版本发布的）"}` });

  report2("物化检查点", 45, "正在物化远端检查点到目标目录");
  const ls = await gitCmd(["ls-tree", "-r", "--name-only", "HEAD"], targetDir);
  const modeMap = await indexModeMap(targetDir);
  let written = 0;
  let placeholder = 0;
  let skippedConflict = 0;
  for (const p of ls.split("\n").filter(Boolean)) {
    if (!isSafeRelPath(p)) continue;
    const content = await gitCatFile(targetDir, p);
    if (content === null) continue;
    const dest = path.join(targetDir, p);
    if (input.onConflict === "skip" && (await exists(dest))) { skippedConflict++; continue; }
    await ensureDir(path.dirname(dest));
    await fs.rm(dest, { force: true }).catch(() => {});
    const mode = modeMap.get(p) ?? "100644";
    if (mode === "120000") {
      const ok = await fs.symlink(content.toString("utf8"), dest).then(() => true).catch(() => false);
      if (!ok) { await fs.writeFile(dest, content); placeholder++; }
    } else {
      await fs.writeFile(dest, content);
      if (mode === "100755") await fs.chmod(dest, 0o755).catch(() => {});
    }
    written++;
  }
  const dels = state.changes.filter((c) => c.status === "deleted" || c.status === "renamed");
  for (const c of dels) {
    const p = c.status === "renamed" ? c.oldPath! : c.path;
    if (!isSafeRelPath(p)) continue;
    await fs.rm(path.join(targetDir, p), { force: true }).catch(() => {});
    await gitCmd(["update-index", "--force-remove", "--", p], targetDir).catch(() => {});
  }
  if (placeholder) gaps.push({ kind: "环境", title: `${placeholder} 个符号链接退化为普通文件`, detail: "本机没有创建符号链接的权限（Windows 需开发者模式或管理员）。已如实计入，不作为完整还原。", blocking: false });
  steps.push({
    title: "恢复至目标目录", ok: true,
    detail: `检查点树物化 ${written} 项 · 删除 ${dels.length} 项保持移除${skippedConflict ? ` · 按选择跳过 ${skippedConflict} 项已存在路径` : ""}`,
  });

  report2("重建暂存区", 70, "正在从 .acb-meta 恢复索引状态");
  let stagedCount = 0;
  for (const c of state.changes) {
    if (!c.staged || c.status === "deleted" || !isSafeRelPath(c.path)) continue;
    const blob = await gitCatFile(targetDir, `.acb-meta/payload-index/${c.path}`);
    if (blob === null) continue;
    const tmp = path.join(os.tmpdir(), `acb-idx-${Date.now()}-${c.path.replace(/\//g, "_")}`);
    await ensureDir(path.dirname(tmp));
    await fs.writeFile(tmp, blob);
    await gitAddToIndex(targetDir, tmp, c.path, c.mode);
    stagedCount++;
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  steps.push({ title: "暂存状态重建", ok: true, detail: `${stagedCount} 个文件的暂存版本自交接分支恢复，未暂存改动保持未暂存` });

  const restoredFiles: { path: string; content: Buffer }[] = [];
  for (const c of state.changes) {
    if (c.status === "deleted" || !isSafeRelPath(c.path)) continue;
    const buf = await readRestoredEntry(path.join(targetDir, c.path), c.mode);
    if (buf !== null) restoredFiles.push({ path: c.path, content: buf });
  }
  const restoredDigest = sourceDigest(restoredFiles);
  const digestMatch = state.sourceDigest.split("full:")[1] === restoredDigest.split("full:")[1];
  steps.push({
    title: "代码指纹复算", ok: digestMatch,
    detail: digestMatch ? `${restoredDigest.split(" ")[0]} = 源快照一致（复算覆盖 ${restoredFiles.length} 个文件）` : "不一致：包内容或本机文件系统有问题，见上方校验步骤的失败项",
  });

  const env = await envDiff(state);
  gaps.push(...env.gaps);
  steps.push({ title: "环境差异评估", ok: true, detail: env.detail });

  const md = await gitCatFile(targetDir, ".acb-meta/HANDOFF.md");
  const entryDest = path.join(targetDir, "ACB-HANDOFF.md");
  if (md !== null) await fs.writeFile(entryDest, md);
  steps.push({ title: "生成接手入口", ok: md !== null, detail: md !== null ? `ACB-HANDOFF.md 已写入目标目录：${entryDest}` : "分支里没有 HANDOFF.md（旧版本发布），请回源电脑重新发布" });

  let verdict: ResumeReport["verdict"];
  if (!digestMatch) verdict = "恢复被阻塞";
  else if (gaps.some((g) => g.blocking)) verdict = "需要配置环境";
  else if (state.verifications.some((v) => v.result === "失败" || v.result === "超时")) verdict = "需要重新验证";
  else verdict = "可继续";

  const out: ResumeReport = {
    reportId: id("rep"), handoffId, source, targetDir, at,
    verdict, digestMatch, codeRestored: digestMatch, steps, gaps,
    entryMarkdownPath: await exists(entryDest) ? entryDest : undefined,
    entryCount: state.changes.length, restoredCount: written,
  };
  await fs.writeFile(path.join(targetDir, "ACB-RESUME-REPORT.md"), renderReportMarkdown(out));
  report2("完成", 99, `恢复结束：${verdict}`);
  return { report: out, state };
}

function blockedReport(
  handoffId: string, source: string, targetDir: string, at: string,
  steps: ResumeStep[], gaps: ResumeGap[],
  integrity?: { entryCount: number; verifiedCount: number; broken: string[] },
): ResumeReport {
  return {
    reportId: id("rep"), handoffId, source, targetDir, at,
    verdict: "恢复被阻塞", digestMatch: null, codeRestored: false,
    steps, gaps,
    error: "恢复在写入目标前被阻止：" + (steps.find((s) => !s.ok)?.detail ?? "见步骤清单"),
    entryCount: integrity?.entryCount, verifiedCount: integrity?.verifiedCount, restoredCount: 0,
  };
}

async function envDiff(state: ProjectState): Promise<{ gaps: ResumeGap[]; detail: string }> {
  const gaps: ResumeGap[] = [];
  for (const req of state.recoveryRequirements) {
    gaps.push({ kind: "凭据", title: `${req}`, detail: "在本机目标目录里按源端同名文件补齐；ACB 不会替你猜内容。", blocking: true });
  }
  const node = process.version;
  if (state.environment.runtime !== `node ${node}`) {
    gaps.push({ kind: "环境", title: `运行时不同：源端 ${state.environment.runtime} → 本机 ${node}`, detail: "依赖需要在本机重装（npm ci），源端的 node_modules 没有随包带出。", blocking: false });
  }
  if (state.environment.os !== process.platform) {
    gaps.push({ kind: "环境", title: `操作系统不同：源端 ${state.environment.os} → 本机 ${process.platform}`, detail: "换行符/路径分隔符/可执行位/符号链接表现可能不同，代码内容已按字节核对。", blocking: false });
  }
  gaps.push({ kind: "验证", title: "验证未在本机执行", detail: `源端 ${state.verifications.length} 条记录保留为历史证据；本机 Node ${node}，建议在项目设置里配好检查命令后重新创建一次交接以复验`, blocking: false });
  return { gaps, detail: `OS ${process.platform} · Node ${node} · 源端 ${state.environment.os} / ${state.environment.runtime} · ${gaps.filter((g) => g.blocking).length} 项需补齐` };
}

function gitCmd(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
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

async function gitAddToIndex(dir: string, srcFile: string, repoPath: string, mode = "100644"): Promise<void> {
  const blob = (await gitCmd(["hash-object", "-w", "--", srcFile], dir)).trim();
  await gitCmd(["update-index", "--add", "--cacheinfo", `${mode},${blob},${repoPath}`], dir);
}

async function gitAddWorktree(dir: string, relPath: string, mode = "100644"): Promise<void> {
  const blob = (await gitCmd(["hash-object", "-w", "--", relPath], dir)).trim();
  await gitCmd(["update-index", "--add", "--cacheinfo", `${mode},${blob},${relPath}`], dir);
}
