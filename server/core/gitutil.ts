// Git 与文件系统操作封装（child_process 调 git，跨平台）
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ExcludeReason } from "../../shared/types.js";

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
  // 明确的密钥材料：误提交的代价远高于漏带一个文件
  /\.(?:pem|pfx|p12|key|kdbx)$/i, /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(?:\.netrc|\.npmrc|credentials\.ya?ml|service-account\.json)$/i,
  /^\.aws\/credentials$/i,
];

/**
 * 排除原因表：与 DEFAULT_EXCLUDES 一一对应，界面用它回答"这个文件为什么没进包"。
 * 顺序必须与 DEFAULT_EXCLUDES 一致（有 e2e 断言守着）。
 * label 是给界面看的规则摘要（人话），reason 是命中某个具体文件时给出的解释。
 */
export const EXCLUSION_REASONS: { re: RegExp; label: string; reason: string; kind: ExcludeReason }[] = [
  { re: /^\.env(\..*)?$/i, label: ".env*", reason: ".env* 本机凭据/配置，默认不带出这台电脑", kind: "凭据" },
  { re: /^node_modules\//, label: "node_modules/", reason: "依赖目录，接收端 npm ci 即可重建", kind: "依赖" },
  { re: /^dist\//, label: "dist/", reason: "构建产物，可由源码重建", kind: "产物" },
  { re: /^build\//, label: "build/", reason: "构建产物，可由源码重建", kind: "产物" },
  { re: /^\.acb\//, label: ".acb/", reason: "ACB 自己的交接存储，不带出本机", kind: "工具存储" },
  { re: /^\.git\//, label: ".git/", reason: "Git 元数据，基线历史由 bundle 单独携带", kind: "工具存储" },
  { re: /^out\//, label: "out/", reason: "构建产物，可由源码重建", kind: "产物" },
  { re: /^target\//, label: "target/", reason: "构建产物，可由源码重建", kind: "产物" },
  { re: /\.log$/i, label: "*.log", reason: "运行日志，属于本机现场", kind: "日志" },
  { re: /\.acb$/i, label: "*.acb", reason: "ACB 交接包本身，不作为源码带出", kind: "工具存储" },
  { re: /^\.DS_Store$/i, label: ".DS_Store", reason: "macOS 目录元数据", kind: "系统文件" },
  { re: /\.(?:pem|pfx|p12|key|kdbx)$/i, label: "*.pem / *.pfx / *.key", reason: "密钥/证书库文件", kind: "凭据" },
  { re: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, label: "id_rsa 等 SSH 私钥", reason: "SSH 私钥/公钥", kind: "凭据" },
  { re: /(^|\/)(?:\.netrc|\.npmrc|credentials\.ya?ml|service-account\.json)$/i, label: ".npmrc / .netrc / service-account.json", reason: "服务账号/登录凭据", kind: "凭据" },
  { re: /^\.aws\/credentials$/i, label: ".aws/credentials", reason: "云厂商访问密钥", kind: "凭据" },
];

/** 界面用的排除策略摘要（按 kind 去重后的规则一览） */
export function excludePolicySummary(): { label: string; reason: string; kind: ExcludeReason }[] {
  return EXCLUSION_REASONS.map((x) => ({ label: x.label, reason: x.reason, kind: x.kind }));
}

/** 命中的排除规则及原因；没命中返回 null */
export function exclusionInfo(relPath: string): { reason: string; kind: ExcludeReason } | null {
  const hit = EXCLUSION_REASONS.find((x) => x.re.test(relPath));
  return hit ? { reason: hit.reason, kind: hit.kind } : null;
}

/** 看起来像凭据（用于提示"已提交在历史里"的漏网文件） */
export function looksLikeSecret(relPath: string): boolean {
  return EXCLUSION_REASONS.filter((x) => x.kind === "凭据").some((x) => x.re.test(relPath));
}

export function isExcluded(relPath: string, extra: string[] = []): boolean {
  return DEFAULT_EXCLUDES.some((re) => re.test(relPath)) || extra.some((e) => relPath === e || relPath.startsWith(e + "/"));
}

/**
 * 路径安全闸：包内条目与 state.changes 里的路径必须是干净的项目相对路径。
 * tar/git 会自己净化一部分，但清单里的 `..`、绝对路径、盘符、UNC 一旦拼进 path.join
 * 就可能写到目标目录外面，所以在拼接前先自己判一次。
 */
export function isSafeRelPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") || p.startsWith("\\\\")) return false;             // 绝对 / UNC
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false;                             // Windows 盘符
  if (p.includes("\\") || p.includes(":")) return false;                    // 只用 / 分隔
  const segs = p.split("/");
  return !segs.some((s) => s === ".." || s === "") && !/[<>|?*]/.test(p) && !/\p{Cc}/u.test(p);
}

/** 大小写折叠后的碰撞（Windows/macOS 默认不分大小写，恢复时后者会静默覆盖前者） */
export function caseCollisions(paths: string[]): string[][] {
  const byKey = new Map<string, string[]>();
  for (const p of paths) {
    const k = p.toLowerCase();
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  return [...byKey.values()].filter((v) => new Set(v).size > 1);
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

/** 文件/符号链接的实测大小（符号链接按自身算，不计目标） */
export async function statSize(abs: string): Promise<number> {
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) return (await fs.readlink(abs)).length;
    return st.size;
  } catch {
    return 0;
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 仓库对象体积（用于告诉用户"基线 bundle 大概会带走多大历史"） */
export async function repoSize(cwd: string): Promise<{ bytes: number; objects: number }> {
  try {
    const out = await git(["count-objects", "-vH", "--human-readable"], { cwd });
    const bytes = /size-pack:\s*([0-9.]+[KMGT]?i?B)/i.exec(out)?.[1] ?? "0";
    const objects = Number(/count:\s*(\d+)/.exec(out)?.[1] ?? "0");
    return { bytes: parseHi(bytes), objects };
  } catch {
    return { bytes: 0, objects: 0 };
  }
}

function parseHi(s: string): number {
  const m = /^([0-9.]+)\s*([KMGT])?i?B$/i.exec(s.trim());
  if (!m) return 0;
  const mult: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(Number(m[1]) * (m[2] ? mult[m[2].toUpperCase()] : 1));
}
