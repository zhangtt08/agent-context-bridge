// Git 参数注入防线：远端名/URL 白名单 + 调用方给定 ref 的形态校验
//
// 为什么需要（2026-10-05 验收判为 BLOCKER）：`remote` 一直是从 query/body 直接进来的
// （GET /api/remotes/handoffs?remote=…、POST /api/resume {remote}、项目设置里的 githubRemote），
// 然后被当成 argv 的一个元素交给 git。argv 里没有 shell，所以 `;rm -rf` 这类写法本来就没用，
// 但 git 自己会把**以 - 开头的参数当选项**：
//
//   git ls-remote --heads "--upload-pack=touch /tmp/pwned" .
//
// 这一条在本机 2.55 上实测会执行 `touch /tmp/pwned`（文件真的生成了）。同理还有
// `ext::sh -c …` 这种自带命令的传输后端。所以判据不能是"看起来像 URL"，必须是白名单。
//
// 规则：
//   1. 绝不允许以 - 开头（选项注入）；不允许出现 `::`（ext::/fd:: 这类自带命令的传输）。
//   2. 不允许控制字符、换行、空白开头/结尾。
//   3. URL 只接受 https:// / ssh:// / git+ssh:// 三种方案；http:// 明文、git:// 无认证、
//      file://、ext:// 等一律拒绝（要拷本地仓库走路径那条分支，不走伪 URL）。
//   4. 其余允许：`origin` 这类远端名（^[A-Za-z0-9._/-]+$，且不以 - 开头）、
//      GitHub 常用的 scp 式 git@host:owner/repo.git、以及真实文件系统路径（绝对/相对/盘符）。
//      本地路径不是提权通道：git 只是在本机已经能读的目录里跑 upload-pack，
//      而 e2e 与"裸仓当远端"的验证路径都依赖它。
import { isSafeRelPath } from "./gitutil.js";

export const REMOTE_MAX_LENGTH = 2000;
const ALLOWED_SCHEMES = ["https://", "ssh://", "git+ssh://"];
const NAME_RE = /^[A-Za-z0-9._\/-]+$/;
const SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~\/@-]+$/;
const WIN_PATH_RE = /^[A-Za-z]:[\\/]/;

export class UnsafeGitArgumentError extends Error {
  constructor(value: string, why: string, remedy: string) {
    super(`不安全的 git 参数「${clip(value)}」：${why}。出路：${remedy}`);
    this.name = "UnsafeGitArgumentError";
  }
}

function clip(v: string): string {
  return v.length > 120 ? v.slice(0, 120) + "…" : v;
}

/** 控制字符与换行：git 参数里出现它们一律是伪造（换行还能把一句话变成两条 ref） */
function hasControl(v: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(v);
}

/**
 * 远端值校验：通过返回归一化后的值，不通过抛 UnsafeGitArgumentError（HTTP 层折成 400）。
 * 三条调用路径都要过这里：HTTP 入口（早拒、给出人话）、transport、resume。
 */
export function assertSafeGitRemote(raw: unknown, field = "remote"): string {
  if (typeof raw !== "string") {
    throw new UnsafeGitArgumentError(String(raw ?? ""), `${field} 必须是字符串`, "在项目设置里填远端名或仓库地址");
  }
  const v = raw.trim();
  if (!v) throw new UnsafeGitArgumentError(raw, `${field} 不能为空`, "留空则用项目设置里的远端，或填一个已存在的仓库地址");
  if (v.length > REMOTE_MAX_LENGTH) {
    throw new UnsafeGitArgumentError(v, `${field} 超过 ${REMOTE_MAX_LENGTH} 个字符`, "填远端名（如 origin）或仓库地址，不要粘贴一大段文本");
  }
  if (hasControl(v)) throw new UnsafeGitArgumentError(v, "含控制字符或换行", "远端地址里不该有换行或不可见字符");
  if (v.startsWith("\\\\")) {
    throw new UnsafeGitArgumentError(v, "UNC 路径（\\\\主机\共享）指向别的机器，git 会去那台机器上跑 upload-pack", "改用 https:// / ssh:// 地址，或本机上的目录路径");
  }
  if (v.startsWith("-")) {
    throw new UnsafeGitArgumentError(v, "以 - 开头会被 git 当成选项（例如 --upload-pack=<cmd> 会直接在本机执行命令）", "填远端名（origin）或完整仓库地址（https://… 或 git@host:owner/repo.git）");
  }
  if (v.includes("::")) {
    throw new UnsafeGitArgumentError(v, "含 :: 的是 git 的 ext::/fd:: 这类自带命令传输后端，它会直接执行命令", "改用 https:// 或 ssh:// 地址");
  }
  if (ALLOWED_SCHEMES.some((s) => v.toLowerCase().startsWith(s))) {
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      throw new UnsafeGitArgumentError(v, "URL 解析不出来", "检查 https:// 或 ssh:// 地址是否完整");
    }
    if (!url.hostname) throw new UnsafeGitArgumentError(v, "URL 没有主机名", "补全仓库地址，例如 https://github.com/you/repo.git");
    if (url.protocol === "http:") throw new UnsafeGitArgumentError(v, "http:// 明文远端不在允许清单里", "改用 https:// 地址");
    return v;
  }
  // 其它 scheme:// 或 scheme: 写法（git://、file://、ext://、cvs::…）一律拒绝
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v) && !WIN_PATH_RE.test(v)) {
    throw new UnsafeGitArgumentError(v, "URL 方案不在允许清单（只允许 https:// / ssh:// / git+ssh://，或 scp 式 git@host:path）", "改用 https:// 或 ssh:// 地址");
  }
  if (SCP_RE.test(v)) return v;
  if (WIN_PATH_RE.test(v)) return v;                        // C:\path\to\repo 或 C:/path/to/repo
  if (/^([.~]?\/|\.\/|\.\.\/)/.test(v)) return v;           // 绝对/相对本地路径（裸仓、U 盘目录）
  if (NAME_RE.test(v)) return v;                            // 远端名：origin / upstream / fork/v1
  throw new UnsafeGitArgumentError(
    v,
    "既不是允许的 URL、scp 式地址、本地路径，也不是合法远端名（远端名只允许字母数字与 . _ / -，且不以 - 开头）",
    "填 origin 这样的远端名，或 https://github.com/you/repo.git、git@github.com:you/repo.git、一个本地仓库目录",
  );
}

/** 远端名/URL 的可测判据：不抛就返回 true（脚本与测试里用） */
export function isSafeGitRemote(raw: unknown): boolean {
  try {
    assertSafeGitRemote(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * 调用方给的 ref / pathspec：不允许以 - 开头，不允许控制字符与空格。
 * 允许 `*`（listRemoteHandoffs 的 refs/heads/acb/handoff/* 是内部拼出来的模式，不是用户输入）。
 */
export function assertSafeGitRefish(raw: unknown, field = "ref"): string {
  if (typeof raw !== "string") throw new UnsafeGitArgumentError(String(raw ?? ""), `${field} 必须是字符串`, "按 GET /api/agent/tools 的说明传字符串");
  const v = raw.trim();
  if (!v) throw new UnsafeGitArgumentError(raw, `${field} 不能为空`, "填一个具体的 ref 或模式");
  if (hasControl(v) || /\s/.test(v)) throw new UnsafeGitArgumentError(v, `${field} 含空白或控制字符`, "ref 里不该有空格");
  if (v.startsWith("-")) throw new UnsafeGitArgumentError(v, `${field} 以 - 开头会被当成 git 选项`, "去掉开头的 -");
  if (v.includes("::")) throw new UnsafeGitArgumentError(v, `${field} 含 :: （ext:: 一类自带命令的写法）`, "只填 refs/... 形式的引用");
  if (!/^[A-Za-z0-9!#$%&*+,.;<=>?@^_`{|}~\/\[\]-]+$/.test(v)) {
    throw new UnsafeGitArgumentError(v, `${field} 含 git 引用里不该出现的字符`, "ref 只允许 refs/... 与常用引用字符");
  }
  return v;
}

/** 交接 ID 形态：内部用它拼 refs/heads/acb/handoff/<id>，所以先按 ID 判死再拼 */
export function assertSafeHandoffId(raw: unknown, field = "handoffId"): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!/^hnd_[A-Za-z0-9]+$/.test(v)) {
    throw new UnsafeGitArgumentError(String(raw ?? ""), `${field} 形如 hnd_<16 进制>，收到的是别的东西`, "从「查看该仓库的交接」列表里选，或用创建回执里的 ID");
  }
  return v;
}

/** 供 HTTP 层复用：路径类入参（outPath / targetDir / filePath）不是 git 参数，但仍要挡控制字符 */
export function assertNoControl(v: string, field: string): string {
  if (hasControl(v)) throw new UnsafeGitArgumentError(v, `${field} 含控制字符`, "换成正常路径");
  return v;
}

/** 包内相对路径的守卫（resume/transport 里已有 isSafeRelPath，这里给 HTTP 层一个统一入口） */
export function assertSafeRelPath(p: string, field = "path"): string {
  if (!isSafeRelPath(p)) throw new UnsafeGitArgumentError(p, `${field} 不是干净的项目相对路径`, "用不带 .. 与盘符的相对路径");
  return p;
}
