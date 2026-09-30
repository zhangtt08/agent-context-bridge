// Git 与文件系统操作封装（child_process 调 git，跨平台）
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function git(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} 失败: ${stderr || err.message}`));
      else resolve(stdout.toString());
    });
  });
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try { await git(["rev-parse", "--is-inside-work-tree"], { cwd: dir }); return true; } catch { return false; }
}

/** 是否为可交接的 Git 工作区（.git 目录本身/裸仓库会返回 false） */
export async function isWorkTree(dir: string): Promise<boolean> {
  try { return (await git(["rev-parse", "--is-inside-work-tree"], { cwd: dir })).trim() === "true"; }
  catch { return false; }
}

/** 注册目录归一化：误选 .git 子目录时自动改用其所在项目根目录 */
export function resolveProjectDir(input: string): string {
  const abs = path.resolve(input);
  return path.basename(abs) === ".git" ? path.dirname(abs) : abs;
}

export interface GitStatus {
  branch: string | null;
  commit: string | null;
  /** 状态行解析结果 */
  entries: { path: string; x: string; y: string; oldPath?: string }[];
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  let branch: string | null = null, commit: string | null = null;
  try { branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).trim(); } catch { /* 无提交 */ }
  try { commit = (await git(["rev-parse", "HEAD"], { cwd })).trim(); } catch { commit = null; }
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  const toks = out.split("\0").filter(Boolean);
  const entries: GitStatus["entries"] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.length < 4) continue;
    const x = t[0], y = t[1], p = t.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const to = toks[++i];
      entries.push({ path: to, x, y, oldPath: p });
    } else {
      entries.push({ path: p.replace(/^"|"$/g, ""), x, y });
    }
  }
  return { branch, commit, entries };
}

export async function hashObject(cwd: string, file: string): Promise<string> {
  return (await git(["hash-object", "-w", "--", file], { cwd })).trim();
}

export async function sha256File(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256Buf(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 纳入范围的代码内容指纹：排序路径 + 内容字节 */
export function sourceDigest(files: { path: string; content: Buffer }[]): string {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update(f.path); h.update("\x00"); h.update(f.content); h.update("\x01");
  }
  const hex = h.digest("hex");
  return `src_sha256:${hex.slice(0, 12)}…${hex.slice(-4)} full:${hex}`;
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

/** 默认排除：凭据、依赖、产物、ACB 自身存储 */
export const DEFAULT_EXCLUDES = [
  /^\.env(\..*)?$/i, /^node_modules\//, /^dist\//, /^build\//, /^\.acb\//,
  /^\.git\//, /^out\//, /^target\//, /\.log$/i, /\.acb$/i, /^\.DS_Store$/i,
];

export function isExcluded(relPath: string, extra: string[] = []): boolean {
  return DEFAULT_EXCLUDES.some((re) => re.test(relPath)) || extra.some((e) => relPath === e || relPath.startsWith(e + "/"));
}

export async function walkFiles(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
