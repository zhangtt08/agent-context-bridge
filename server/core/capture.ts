// Capture Module：捕获稳定 Snapshot（基线 + 暂存区 + 工作区 + 新文件）
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GitStatus, git, gitStatus, id, isExcluded, sourceDigest, ensureDir } from "./gitutil.js";
import type { Observation } from "../../shared/types.js";

export interface CapturedFile {
  path: string;                 // 相对路径
  workContent: Buffer | null;   // 工作区内容（deleted 为 null）
  indexContent: Buffer | null;  // 暂存版本（与 HEAD 不同的暂存改动）
  mode: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
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
}

async function readIfExists(p: string): Promise<Buffer | null> {
  try { return await fs.readFile(p); } catch { return null; }
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

export async function capture(projectId: string, projectPath: string): Promise<Snapshot> {
  let st = await gitStatus(projectPath);
  const s1 = sig(st);
  const st2 = await gitStatus(projectPath);
  if (sig(st2) !== s1) {
    st = st2;
    const st3 = await gitStatus(projectPath);
    if (sig(st3) !== sig(st2)) {
      throw new Error("捕获期间工作区持续发生变化，请停止外部编辑后重试");
    }
  }

  const files = new Map<string, CapturedFile>();
  const excluded: string[] = [];

  for (const e of st.entries) {
    if (isExcluded(e.path)) { excluded.push(e.path); continue; }
    const { x, y } = e;
    const status = statusOf(x, y, !!e.oldPath);
    const abs = path.join(projectPath, e.path);
    const workContent = status === "deleted" ? null : await readIfExists(abs);
    // 暂存版本精确取自索引 blob（git show :path），与工作区内容互不覆盖
    let indexContent: Buffer | null = null;
    if (x !== " " && x !== "?" && status !== "deleted") {
      indexContent = await gitShow(projectPath, "", e.path);
      if (indexContent !== null && workContent !== null && indexContent.equals(workContent)) indexContent = workContent;
    } else if (x === "M" && y === "D") {
      indexContent = await gitShow(projectPath, "", e.path); // 暂存有改动、工作区被删：保留暂存材料
    }
    files.set(e.path, { path: e.path, workContent, indexContent, mode: "100644", status, oldPath: e.oldPath });
  }

  return assemble(projectId, projectPath, st, files, excluded);
}

async function assemble(
  projectId: string, projectPath: string, st: GitStatus,
  files: Map<string, CapturedFile>, excluded: string[],
): Promise<Snapshot> {
  const snapshotId = id("snp");
  const takenAt = new Date().toISOString();
  const digest = sourceDigest(
    [...files.values()].filter((f) => f.workContent !== null).map((f) => ({ path: f.path, content: f.workContent! })),
  );

  const stagedCount = [...files.values()].filter((f) => f.indexContent !== null).length;
  const observations: Observation[] = [
    { source: "git", scope: "工作区", at: takenAt, text: `基线 ${st.commit?.slice(0, 7) ?? "（无提交）"} · 分支 ${st.branch ?? "（无）"} · ${files.size} 项改动纳入捕获范围` },
    { source: "git", scope: "暂存区", at: takenAt, text: `${stagedCount} 个文件存在暂存改动，将单独保存暂存恢复材料` },
    { source: "fs", scope: "排除策略", at: takenAt, text: excluded.length ? `按纳入策略排除：${excluded.join("、")}` : "无排除项" },
  ];

  return {
    snapshotId, projectId, projectPath, takenAt,
    baseline: { ref: "HEAD", commit: st.commit, branch: st.branch },
    files: [...files.values()],
    digest,
    observations,
    excluded,
  };
}

/** 在独立检查目录中物化快照（基线 + 工作区内容，与源工作区隔离） */
export async function materialize(snap: Snapshot, targetDir: string): Promise<void> {
  await ensureDir(targetDir);
  const touched = new Set(snap.files.map((f) => f.path));

  if (snap.baseline.commit) {
    // 基线中未被快照改动的文件：从 git 对象库读取
    const ls = await git(["ls-tree", "-r", "--name-only", snap.baseline.commit], { cwd: snap.projectPath });
    for (const p of ls.split("\n").filter(Boolean)) {
      if (isExcluded(p) || touched.has(p)) continue;
      const content = await gitShow(snap.projectPath, snap.baseline.commit, p);
      if (content === null) continue;
      await ensureDir(path.dirname(path.join(targetDir, p)));
      await fs.writeFile(path.join(targetDir, p), content);
    }
  }
  for (const f of snap.files) {
    if (f.workContent === null) continue; // 删除项不物化
    await ensureDir(path.dirname(path.join(targetDir, f.path)));
    await fs.writeFile(path.join(targetDir, f.path), f.workContent);
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
