// Capture Module：捕获稳定 Snapshot（基线 + 暂存区 + 工作区 + 新文件）
// 分两步：plan() 只探测磁盘不读内容（预览用，大仓库也快）；capture() 在 plan 之上读恢复材料。
// 两个入口共用同一套纳入/排除/模式判定，避免"预览说的"和"打包做的"不一致。
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GitStatus, git, gitStatus, id, isExcluded, exclusionInfo, sourceDigest, ensureDir,
  statSize, looksLikeSecret, repoSize, fmtBytes, isSafeRelPath,
} from "./gitutil.js";
import type { ExcludeReason, Observation } from "../../shared/types.js";

export interface CapturedFile {
  path: string;                 // 相对路径
  workContent: Buffer | null;   // 工作区内容（deleted 为 null；符号链接为链接目标文本）
  indexContent: Buffer | null;  // 暂存版本（与 HEAD 不同的暂存改动）
  mode: string;                 // 100644 / 100755 / 120000
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  bytes: number;
}

export interface PlannedFile {
  path: string;
  abs: string;
  status: CapturedFile["status"];
  mode: string;
  staged: boolean;
  oldPath?: string;
  bytes: number;
  kind: "file" | "executable" | "symlink" | "deleted";
  /** 工作区文件读不到（悬空符号链接等）：预览就要如实说出来，而不是静默少一个文件 */
  unreadable: boolean;
}

export interface CapturePlan {
  status: GitStatus;
  files: PlannedFile[];
  excluded: { path: string; reason: string; kind: ExcludeReason }[];
  /** 基线提交里的文件路径与其中看起来像凭据的文件（bundle 会把历史一起带走） */
  baselinePaths: string[];
  baselineSecrets: string[];
  repoBytes: number;
  objects: number;
}

export interface Snapshot {
  snapshotId: string;
  projectId: string;
  projectPath: string;
  takenAt: string;
  baseline: { ref: string; commit: string | null; branch: string | null };
  files: CapturedFile[];
  digest: string;
  observations: Observation[];
  excluded: string[];
  unreadable: string[];
}

export type Progress = (stage: string, pct: number, message: string) => void;

async function readIfExists(p: string): Promise<Buffer | null> {
  try { return await fs.readFile(p); } catch { return null; }
}

/** 符号链接按链接目标存文本（Git 就是这么存的），普通文件按字节读 */
async function readEntryContent(abs: string, mode: string): Promise<Buffer | null> {
  if (mode === "120000") {
    try { return Buffer.from(normalizeLink(await fs.readlink(abs)), "utf8"); } catch { return await readIfExists(abs); }
  }
  return readIfExists(abs);
}

/**
 * Git 的 120000 blob 一律用正斜杠存链接目标；Windows 的 readlink 会把目标里的 / 变成 \。
 * 不归一化就会出现"同一份内容在 Windows 上复算出不同指纹"的假阴性，
 * 也会让接收端把反斜杠当目标写回去 —— 两个都是跨机还原的真坑。
 */
export function normalizeLink(target: string): string {
  return process.platform === "win32" ? target.replace(/\\/g, "/") : target;
}

function statusOf(x: string, y: string, renamed: boolean): CapturedFile["status"] {
  if (renamed) return "renamed";
  if (x === "?") return "added";
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

function sig(st: GitStatus): string {
  return JSON.stringify(st.entries.map((e) => [e.x + e.y, e.path, e.oldPath ?? ""]));
}

/** 索引里记录的真实模式：100755 / 120000 即使在 Windows 检出后仍留在索引中 */
async function indexModes(cwd: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const out = await git(["ls-files", "-s"], { cwd });
    for (const line of out.split("\n")) {
      const m = /^(\d{6}) [0-9a-f]+ (?:\d+\t)?(.*)$/.exec(line.trim());
      if (m) map.set(m[2], m[1]);
    }
  } catch { /* 空索引仓库：全部按未跟踪处理 */ }
  return map;
}

async function listTree(cwd: string, commit: string): Promise<string[]> {
  try {
    const out = await git(["ls-tree", "-r", "--name-only", commit], { cwd });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 只做磁盘探测，不读文件内容。顺带挡下三类跨机还原的坑：
 * 路径穿越（拼进 path.join 会写到目标目录外）、被误当文件内容的符号链接、
 * 已提交进历史因此排除策略挡不住的凭据文件。
 */
export async function plan(projectPath: string, onProgress?: Progress): Promise<CapturePlan> {
  onProgress?.("扫描工作区", 5, "正在读取 git 状态（大仓库首次扫描会慢）");
  let st = await gitStatus(projectPath);
  const s1 = sig(st);
  const st2 = await gitStatus(projectPath);
  if (sig(st2) !== s1) {
    st = st2;
    const st3 = await gitStatus(projectPath);
    if (sig(st3) !== sig(st2)) {
      throw new Error("捕获期间工作区持续发生变化，请先停止外部编辑（含 watch 模式构建），或先 git commit 一次再创建交接");
    }
  }

  const modes = await indexModes(projectPath);
  onProgress?.("扫描工作区", 15, `已取到 ${st.entries.length} 项改动，正在探测文件形态`);

  const files: PlannedFile[] = [];
  const excluded: CapturePlan["excluded"] = [];

  for (const e of st.entries) {
    if (!isSafeRelPath(e.path)) {
      excluded.push({ path: e.path, reason: "路径含无法安全映射到其它机器的片段，已跳过", kind: "工具存储" });
      continue;
    }
    if (isExcluded(e.path)) {
      const info = exclusionInfo(e.path);
      excluded.push({ path: e.path, reason: info?.reason ?? "按纳入策略排除", kind: info?.kind ?? "产物" });
      continue;
    }
    const x = e.x;
    const status = statusOf(x, e.y, !!e.oldPath);
    const abs = path.join(projectPath, e.path);
    const tracked = x !== "?";
    let mode = modes.get(e.path) ?? modes.get(e.oldPath ?? "") ?? "100644";
    let unreadable = false;
    let bytes = 0;

    if (status === "deleted") {
      bytes = 0;
    } else {
      let stt: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      try { stt = await fs.lstat(abs); } catch { stt = null; }
      if (stt?.isSymbolicLink()) mode = "120000";
      else if (!tracked && stt?.isFile()) mode = (stt.mode & 0o111) ? "100755" : "100644";
      else if (!tracked && stt?.isDirectory()) mode = "100644";     // git 不会给出目录条目，防御性处理
      bytes = stt ? await statSize(abs) : 0;
      unreadable = stt === null || stt.isDirectory();
    }

    const kind: PlannedFile["kind"] =
      status === "deleted" ? "deleted" : mode === "120000" ? "symlink" : mode === "100755" ? "executable" : "file";
    files.push({
      // 暂存区是否有独立版本：x 非空格即索引与 HEAD 有差异（含 MD：暂存改动 + 工作区删除）
      path: e.path, abs, status, mode, kind, bytes, unreadable,
      staged: x !== " " && x !== "?",
      oldPath: e.oldPath,
    });
  }

  onProgress?.("扫描基线", 22, "正在核对基线提交里的凭据与历史体积");
  const baselinePaths = st.commit ? await listTree(projectPath, st.commit) : [];
  const baselineSecrets = baselinePaths.filter((p) => looksLikeSecret(p));
  const size = await repoSize(projectPath);

  return { status: st, files, excluded, baselinePaths, baselineSecrets, repoBytes: size.bytes, objects: size.objects };
}

/** 读取恢复材料：在 plan 的结果上补齐内容字节 */
export async function capture(
  projectId: string,
  projectPath: string,
  onProgress?: Progress,
  preplant?: CapturePlan,
): Promise<Snapshot> {
  const p0 = preplant ?? await plan(projectPath, onProgress);
  const st = p0.status;
  onProgress?.("读取文件", 30, `正在读取 ${p0.files.length} 个文件的恢复材料`);

  const files = new Map<string, CapturedFile>();
  const unreadable: string[] = [];
  let done = 0;
  for (const p of p0.files) {
    const workContent = p.status === "deleted" ? null : await readEntryContent(p.abs, p.mode);
    let indexContent: Buffer | null = null;
    const x = st.entries.find((e) => e.path === p.path)?.x ?? " ";
    if (p.status !== "deleted" && x !== " " && x !== "?") indexContent = await gitShow(projectPath, "", p.path);
    else if (x === "M" && p.status === "deleted") indexContent = await gitShow(projectPath, "", p.path);
    if (workContent === null && p.status !== "deleted") unreadable.push(p.path);
    files.set(p.path, {
      path: p.path, workContent, indexContent, mode: p.mode,
      status: p.status, oldPath: p.oldPath, bytes: p.bytes,
    });
    done++;
    if (p0.files.length > 200 && done % 200 === 0) {
      onProgress?.("读取文件", 30 + Math.round((done / p0.files.length) * 20), `已读取 ${done}/${p0.files.length}`);
    }
  }

  return assemble(projectId, projectPath, st, files, p0, unreadable);
}

async function assemble(
  projectId: string, projectPath: string, st: GitStatus,
  files: Map<string, CapturedFile>, p0: CapturePlan, unreadable: string[],
): Promise<Snapshot> {
  const snapshotId = id("snp");
  const takenAt = new Date().toISOString();
  const digest = sourceDigest(
    [...files.values()].filter((f) => f.workContent !== null).map((f) => ({ path: f.path, content: f.workContent! })),
  );

  const stagedCount = [...files.values()].filter((f) => f.indexContent !== null).length;
  const links = [...files.values()].filter((f) => f.mode === "120000").length;
  const execs = [...files.values()].filter((f) => f.mode === "100755").length;
  const observations: Observation[] = [
    { source: "git", scope: "工作区", at: takenAt, text: `基线 ${st.commit?.slice(0, 7) ?? "（无提交）"} · 分支 ${st.branch ?? "（无）"} · ${files.size} 项改动纳入捕获范围` },
    { source: "git", scope: "暂存区", at: takenAt, text: `${stagedCount} 个文件存在暂存改动，将单独保存暂存恢复材料` },
    { source: "fs", scope: "排除策略", at: takenAt, text: p0.excluded.length ? `按纳入策略排除：${p0.excluded.map((e) => e.path).join("、")}` : "无排除项" },
    { source: "fs", scope: "文件形态", at: takenAt, text: `${links} 个符号链接按链接目标保存 · ${execs} 个可执行位随文件模式保留（Windows ↔ Linux 时执行位最容易丢）` },
    { source: "git", scope: "基线 bundle", at: takenAt, text: `仓库对象约 ${fmtBytes(p0.repoBytes)} · ${p0.objects} 个对象，基线 bundle 随包携带完整历史` },
  ];
  if (p0.baselineSecrets.length) {
    observations.push({
      source: "git", scope: "凭据告警", at: takenAt,
      text: `已提交进 Git 历史的凭据文件 ${p0.baselineSecrets.length} 个（${p0.baselineSecrets.slice(0, 5).join("、")}${p0.baselineSecrets.length > 5 ? " 等" : ""}）：纳入策略只挡工作区改动，基线 bundle 会连同历史一起带走，需要另行清理历史或在接收端替换`,
    });
  }
  if (unreadable.length) {
    observations.push({
      source: "fs", scope: "缺失材料", at: takenAt,
      text: `${unreadable.length} 个路径读不到内容（${unreadable.slice(0, 5).join("、")}${unreadable.length > 5 ? " 等" : ""}），通常是悬空符号链接；未纳入恢复材料，接收端不会凭空出现该文件`,
    });
  }

  return {
    snapshotId, projectId, projectPath, takenAt,
    baseline: { ref: "HEAD", commit: st.commit, branch: st.branch },
    files: [...files.values()],
    digest,
    observations,
    excluded: p0.excluded.map((e) => e.path),
    unreadable,
  };
}

/** 在独立检查目录中物化快照（基线 + 工作区内容，与源工作区隔离） */
export async function materialize(snap: Snapshot, targetDir: string): Promise<void> {
  await ensureDir(targetDir);
  const touched = new Set(snap.files.map((f) => f.path));

  if (snap.baseline.commit) {
    const ls = await listTree(snap.projectPath, snap.baseline.commit);
    for (const p of ls) {
      if (isExcluded(p) || touched.has(p)) continue;
      const content = await gitShow(snap.projectPath, snap.baseline.commit, p);
      if (content === null) continue;
      await ensureDir(path.dirname(path.join(targetDir, p)));
      await fs.writeFile(path.join(targetDir, p), content);
    }
  }
  for (const f of snap.files) {
    if (f.workContent === null) continue; // 删除项与读不到的项都不物化
    const dest = path.join(targetDir, f.path);
    await ensureDir(path.dirname(dest));
    await fs.writeFile(dest, f.workContent);
    if (f.mode === "100755") await fs.chmod(dest, 0o755).catch(() => {});
  }
  await fs.writeFile(
    path.join(targetDir, ".acb-check.json"),
    JSON.stringify({ snapshotId: snap.snapshotId, at: snap.takenAt }),
  );
}

export function gitShow(projectPath: string, commit: string, relPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile("git", ["show", `${commit}:${relPath}`], { cwd: projectPath, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(Buffer.from(stdout as Buffer));
    });
  });
}
