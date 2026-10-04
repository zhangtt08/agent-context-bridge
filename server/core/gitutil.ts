// Git 与文件系统操作封装（child_process 调 git，跨平台）
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ExcludeReason } from "../../shared/types.js";

export async function git(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<string> {
  // 目录不存在时先自己说清楚：Windows 上 execFile 会报 "spawn git ENOENT"，
  // 那句话点名的是 git（好像机器上没装 git），而真正的原因通常是注册的项目目录
  // 被移动/改名/删除了。判据必须说得出差在哪一格，否则排查方向被整个带走。
  try {
    await fs.access(opts.cwd);
  } catch {
    return Promise.reject(new Error(`目录不存在，无法在里面跑 git ${args.join(" ")}：${opts.cwd}（出路：项目可能被移动/改名/删除，请按新路径重新注册）`));
  }
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
  // -z：NUL 分隔且不引用路径，非 ASCII / 带空格的中文名才能按原样拿到（普通输出会变成 "\344\270\255…"）
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  const toks = out.split("\0").filter(Boolean);
  const entries: GitStatus["entries"] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.length < 4) continue;
    const x = t[0], y = t[1], p = unquoteGitPath(t.slice(3));
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const to = unquoteGitPath(toks[++i] ?? "");
      entries.push({ path: to, x, y, oldPath: p });
    } else {
      entries.push({ path: p, x, y });
    }
  }
  return { branch, commit, entries };
}

export async function hashObject(cwd: string, file: string): Promise<string> {
  return (await git(["hash-object", "-w", "--", file], { cwd })).trim();
}

/**
 * 解 git 的 C-style 引用路径。core.quotePath 默认开启时，非 ASCII 路径在
 * ls-files / ls-tree 的普通输出里是 "\344\270\255\346\226\207.md" 这样的八进制串，
 * 拿它去拼 path.join 或 isSafeRelPath 判定，结果是这台机器上根本不存在的路径 ——
 * 跨机还原时基线里的中文名文件会被静默丢掉而回执一片绿。
 * 带 -z 的输出不会引用路径（NUL 分隔、原样 UTF-8），这里的解码只作为兜底。
 */
export function unquoteGitPath(raw: string): string {
  const s = raw.trim();
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return raw;
  const body = s.slice(1, -1);
  const buf: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      const code = body.codePointAt(i)!;
      buf.push(...Buffer.from(String.fromCodePoint(code), "utf8"));
      if (code > 0xffff) i++;
      continue;
    }
    const n = body[i + 1] ?? "";
    const esc: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, v: 11, b: 8, '"': 34, "\\": 92 };
    if (esc[n] !== undefined) { buf.push(esc[n]); i++; }
    else if (/[0-7]/.test(n)) {
      const oct = n + (/[0-7]/.test(body[i + 2] ?? "") ? body[i + 2] : "") + (/[0-7]/.test(body[i + 3] ?? "") ? body[i + 3] : "");
      buf.push(parseInt(oct, 8)); i += oct.length;
    } else { buf.push(ch.charCodeAt(0)); }
  }
  return Buffer.from(buf).toString("utf8");
}

/** 跑一条带 -z 的 git 命令并按 NUL 切成条目（顺带兜底解引用） */
export async function gitNul(args: string[], cwd: string): Promise<string[]> {
  const out = await git(args, { cwd });
  return out.split("\0").filter((s) => s.length > 0).map(unquoteGitPath);
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

/**
 * 目标文件系统到底分不分大小写 —— 不靠 process.platform 猜（外接盘、WSL 挂载、
 * Linux 上装的 case-insensitive 卷都可能相反），直接在目标目录里探一次。
 * 只在真的发现碰撞时才调用，正常路径上不会多写一个探针文件。
 * 探不了（目录不可写等）也返回 true：分不清就往"会静默覆盖"那侧判，绝不赌。
 */
export async function fileSystemIsCaseInsensitive(dir: string): Promise<boolean> {
  const probe = `.acb-case-probe-${process.pid}-${Date.now()}`;
  const lower = path.join(dir, probe);
  const upper = path.join(dir, probe.toUpperCase());
  try {
    await fs.writeFile(lower, "");
    return await fs.stat(upper).then(() => true).catch(() => false);
  } catch {
    return true;
  } finally {
    await fs.rm(lower, { force: true }).catch(() => {});
  }
}

/** Win32 保留设备名（含带扩展名的形式）；在 Windows 上这些名字建不出来或不可管理 */
const WIN_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/**
 * 路径在 Windows 上的形态问题（不是安全判定，别和 isSafeRelPath 混起来）：
 * 保留设备名、以点或空格结尾的段。Node 走 \\?\ 前缀能把它们写出来，
 * 但资源管理器与多数命令行工具看不见或打不开 —— 跨机还原时必须说出来而不是默默落地。
 */
export function windowsNameIssues(relPath: string): string[] {
  const out: string[] = [];
  for (const seg of relPath.split("/")) {
    if (!seg) continue;
    if (WIN_RESERVED.test(seg)) out.push(`保留设备名 ${seg}`);
    else if (/[. ]$/.test(seg)) out.push(`以${seg.endsWith(".") ? "点" : "空格"}结尾 ${seg}`);
  }
  return [...new Set(out)];
}

/** MAX_PATH：超过它 Windows 上的常规工具就处理不了（ACB 自己能写，但要如实提示） */
export const WIN_MAX_PATH = 260;

export function projectedPathLength(baseDir: string, relPath: string): number {
  return path.join(baseDir, relPath.split("/").join(path.sep)).length;
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

/** 文件/符号链接的实测大小（符号链接按自身算，不计目标；按字节数而非字符数，中文目标名不能少算） */
export async function statSize(abs: string): Promise<number> {
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) return Buffer.byteLength(await fs.readlink(abs), "utf8");
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
