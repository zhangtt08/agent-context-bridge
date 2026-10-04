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
  ResumePreview, ResumeConflict, PreviewAlert, ConflictPolicy, ResumeReceipt,
} from "../../shared/types.js";
import {
  ensureDir, exists, id, isGitRepo, sha256File, sourceDigest, isSafeRelPath, fmtBytes,
  caseCollisions, fileSystemIsCaseInsensitive, windowsNameIssues, gitNul, isExcluded,
  projectedPathLength, WIN_MAX_PATH,
} from "./gitutil.js";
import { checkEntries } from "./package.js";
import { normalizeLink } from "./capture.js";
import { renderReportMarkdown } from "./protocol.js";
import { assertSafeGitRemote, assertSafeGitRefish } from "./remote-policy.js";

export type Progress = (stage: string, pct: number, message: string) => void;

/** 逐项回执里每类最多列多少条（超过就只报总数，别把 JSON 撑爆） */
const RECEIPT_CAP = 50;
/** 预览扫描目标目录的条目上限：这是"看清会发生什么"，不是磁盘盘点 */
const TARGET_SCAN_LIMIT = 4000;

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
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acb-extract-"));
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
    if (!pkg) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      throw new Error("交接文件中没有 hnd_* 包目录：它可能不是 ACB 导出的文件（在源电脑「创建交接 → 导出本地文件」得到 *.acb.tar.gz）");
    }
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

  let integrity: LoadedPackage["integrity"];
  try {
    if (!Array.isArray(manifest.entries)) throw new Error("交接清单缺少 entries 数组");
    onProgress?.("校验清单", 35, `正在逐条核对 ${manifest.entries.length} 个条目`);
    integrity = await checkEntries(workDir, manifest);
  } catch (e) {
    await dispose();
    throw e;
  }
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

/**
 * 列出 baseline.bundle 里的基线文件树。bundle 不是仓库，必须先落到一个一次性仓库才能读树 ——
 * 一次性仓库建在系统临时目录里、用完即删，绝不在用户目录旁边留残骸。
 * 基线文件路径按 -z 取（真实 UTF-8）：默认输出会被 core.quotePath 把非 ASCII 名字
 * 引用成 "\344\270\255…" 串，那种路径既过不了安全判定也写不下去，会被静默跳过。
 */
async function listTreeFromBundle(bundle: string): Promise<string[] | null> {
  let probe: string | null = null;
  try {
    probe = await fs.mkdtemp(path.join(os.tmpdir(), "acb-bundle-probe-"));
    await gitCmd(["init", "-q"], probe);
    await gitCmd(["fetch", "-q", bundle, "HEAD"], probe);
    await gitCmd(["update-ref", "HEAD", "FETCH_HEAD"], probe);
    return await gitNul(["ls-tree", "-r", "--name-only", "-z", "HEAD"], probe);
  } catch {
    return null;
  } finally {
    if (probe) await fs.rm(probe, { recursive: true, force: true }).catch(() => {});
  }
}

/** 交接包"应当产出"的全部路径：改动（去掉删除项）+ 基线树 */
function packagePathSet(state: ProjectState, baselinePaths: string[] | null): Set<string> {
  const s = new Set<string>();
  for (const c of state.changes) if (c.status !== "deleted") s.add(c.path);
  for (const p of baselinePaths ?? []) s.add(p);
  return s;
}

/** 扫目标目录现有条目（有上限、按排除规则剪枝），供"只在目标"对账用 */
async function scanTargetEntries(targetDir: string): Promise<{ paths: string[]; capped: boolean }> {
  const out: string[] = [];
  const stack: string[] = [""];
  try { await fs.lstat(targetDir); } catch { return { paths: out, capped: false }; }
  while (stack.length) {
    const rel = stack.pop()!;
    let names: string[];
    try { names = await fs.readdir(path.join(targetDir, rel)); } catch { continue; }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (childRel === ".git") continue;
      if (out.length >= TARGET_SCAN_LIMIT) return { paths: out, capped: true };
      let st: Awaited<ReturnType<typeof fs.lstat>>;
      try { st = await fs.lstat(path.join(targetDir, childRel)); } catch { continue; }
      if (st.isDirectory()) {
        if (!isExcluded(childRel + "/")) stack.push(childRel);
      } else {
        out.push(childRel);
      }
    }
  }
  return { paths: out, capped: false };
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
        // 按形态比较：符号链接要比链接目标文本，直接 readFile(dst) 会顺着链接读到目标文件的内容，
        // 于是"内容相同/不同"的判定与恢复时真正写入的字节不是一回事（悬空链接还会一律判成不同）
        const dstBuf = await readRestoredEntry(dst, c.mode);
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

  const bundlePath = path.join(workDir, "payload", "baseline.bundle");
  const bundleAvailable = state.baseline.commit ? await exists(bundlePath) : false;
  // 基线树清单：预览阶段也要知道"包里没有改动的那些文件叫什么"，否则"只在目标"这一栏只能瞎猜
  const baselinePaths = bundleAvailable ? await listTreeFromBundle(bundlePath) : null;
  const pkgPaths = packagePathSet(state, baselinePaths);

  const { paths: targetEntries, capped: targetCapped } = await scanTargetEntries(targetDir);
  const onlyInTarget = targetEntries.filter((p) => !pkgPaths.has(p) && !p.startsWith(".acb-case-probe"));
  const baselineMissingInTarget = (baselinePaths ?? []).filter((p) => !targetEntries.includes(p)).length;

  if (!integrity.ok) {
    alerts.push({
      level: "阻塞", title: `包完整性未通过（${integrity.verifiedCount}/${integrity.entryCount}）`,
      detail: integrity.broken.slice(0, 8).join("、") + (integrity.broken.length > 8 ? " 等" : ""),
      action: "不要试图手工补文件。回源电脑重新创建并导出交接（封存后的包按设计不可原地修改）。",
    });
  }
  const collisions = caseCollisions([...state.changes.map((c) => c.path), ...(baselinePaths ?? [])]);
  if (collisions.length) {
    alerts.push({
      level: "阻塞", title: `包内有仅大小写不同的路径：${collisions[0].join(" / ")}`,
      detail: "本机的文件系统不分大小写，恢复时其中一个会被另一个静默覆盖，代码指纹随之不一致。",
      action: "换到区分大小写的目录/系统恢复，或回源电脑改名后重新创建交接。",
    });
  }
  const named = state.changes.map((c) => c.path).filter((p) => windowsNameIssues(p).length > 0);
  if (named.length) {
    alerts.push({
      level: "警告", title: `${named.length} 个包内路径在 Windows 上不可命名`,
      detail: `${named.slice(0, 6).join("、")}${named.length > 6 ? " 等" : ""} 含保留设备名或以点/空格结尾的段。ACB 用扩展长度路径写得出来，但资源管理器与多数工具打不开它们。`,
      action: "在本机恢复后若要继续用这些文件，请回源电脑改名；只在 Linux 侧使用则可以继续。",
    });
  }
  const long = state.changes.map((c) => c.path)
    .map((p) => ({ p, len: projectedPathLength(targetDir, p) }))
    .filter((x) => x.len > WIN_MAX_PATH);
  if (long.length) {
    alerts.push({
      level: "警告", title: `${long.length} 个路径拼上目标目录后超过 ${WIN_MAX_PATH} 字符`,
      detail: `最长 ${long.sort((a, b) => b.len - a.len)[0].len} 字符（${long[0].p}）。ACB 写得出来，但目标目录里其他工具未必读得到。`,
      action: "换一个更短的目标目录路径（如 D:\\dev\\p），或压平源仓库的目录层级。",
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
      detail: "Windows 上创建符号链接需要开发者模式或管理员权限；没有权限时 ACB 会先退化成目录联接（不需要特权），再退化成写入链接目标的普通文件，并在报告里如实标注，绝不静默。",
      action: "要完整还原链接形态，请在开启开发者模式的机器上恢复，或按报告里的清单手工补回。",
    });
  }
  const empties = state.emptyDirs ?? [];
  if (empties.length) {
    alerts.push({
      level: "提示", title: `${empties.length} 个空目录会一并重建`,
      detail: `Git 不保存空目录，包里的清单是：${empties.slice(0, 6).join("、")}${empties.length > 6 ? " 等" : ""}。`,
      action: "无需操作；恢复完成后这些目录会存在（旧版本 ACB 打的包没有这一项，那就需要接收端手工建）。",
    });
  }
  if (onlyInTarget.length) {
    alerts.push({
      level: "提示", title: `目标目录里有 ${onlyInTarget.length} 个条目不属于这次交接`,
      detail: `${onlyInTarget.slice(0, 6).join("、")}${onlyInTarget.length > 6 ? " 等" : ""}${targetCapped ? "（已达扫描上限，可能更多）" : ""}。它们既不在改动清单也不在基线树里，恢复不会碰它们。`,
      action: "确认这些是本机自己的文件即可继续；若目标目录里其实放着上一版项目的残留，建议换一个空目录恢复。",
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
    onlyInTarget: onlyInTarget.slice(0, RECEIPT_CAP),
    onlyInTargetCount: onlyInTarget.length,
    packagePathCount: pkgPaths.size,
    baselineMissingInTarget,
    baselineListed: baselinePaths !== null,
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

/** 链接载荷文件（包内）的读法：它始终是普通文件，内容就是链接目标文本，按字节取 */
async function readLinkPayload(src: string): Promise<Buffer | null> {
  return fs.readFile(src).catch(() => null);
}

type LinkKind = "symlink" | "junction" | "plain";

/**
 * 创建链接。Windows 上分三档：符号链接（要开发者模式/管理员）→ 目录联接（不需要特权，
 * 但对目录目标）→ 普通文件（最后兜底，必须如实计入 notRestored）。
 * 老写法 fs.symlink(target, dest) 不带 type，指向目录的链接在非 Windows 之外会表现不一致。
 */
async function makeLink(linkText: string, dest: string): Promise<LinkKind> {
  const absTarget = path.isAbsolute(linkText) ? linkText : path.resolve(path.dirname(dest), linkText);
  let targetIsDir = false;
  try { targetIsDir = (await fs.stat(absTarget)).isDirectory(); } catch { /* 悬空目标按普通链接处理 */ }
  // 先按不带 type 的写法试：Node 会自己分辨目标是文件还是目录，POSIX 上这一步就够了
  if (await fs.symlink(linkText, dest).then(() => true).catch(() => false)) return "symlink";
  if (process.platform === "win32") {
    if (targetIsDir && await fs.symlink(absTarget, dest, "junction").then(() => true).catch(() => false)) return "junction";
    if (!targetIsDir && await fs.symlink(linkText, dest, "file").then(() => true).catch(() => false)) return "symlink";
  }
  return "plain";
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
  let junctionLinks = 0;
  let restoredCount = 0;
  let unsafeSkipped = 0;
  const notRestored: string[] = [];

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

    // 大小写碰撞：接收端文件系统不分大小写时，先探明再拒绝 —— 一个字节都不写，
    // 否则两个只差大小写的路径互相覆盖，最后只剩一条"指纹不一致"让人猜
    const bundleForProbe = path.join(workDir, "payload", "baseline.bundle");
    const baselinePaths = state.baseline.commit && await exists(bundleForProbe)
      ? await listTreeFromBundle(bundleForProbe)
      : null;
    const collisions = caseCollisions([...state.changes.map((c) => c.path), ...(baselinePaths ?? [])]);
    const probeDir = (await exists(targetDir)) ? targetDir : path.dirname(targetDir);
    if (collisions.length && await fileSystemIsCaseInsensitive(probeDir)) {
      steps.push({ title: "恢复至目标目录", ok: false, detail: `包内有 ${collisions.length} 组仅大小写不同的路径，本机文件系统不分大小写：写入必然互相覆盖，故未写入任何文件` });
      gaps.push({
        kind: "环境", title: "包内路径在大小写不敏感的文件系统上无法忠实还原",
        detail: `冲突组：${collisions.map((g) => g.join(" / ")).slice(0, 6).join("；")}${collisions.length > 6 ? " 等" : ""}。出路：换一个区分大小写的目录/卷恢复（Linux 或专门建的大小写敏感卷），或回源电脑改名后重新创建交接。`,
        blocking: true,
      });
      return { report: blockedReport(state.handoffId, source, targetDir, at, steps, gaps, integrity), state };
    }

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
    const written = new Set<string>();

    for (const c of state.changes) {
      if (c.status === "deleted") continue;
      if (!isSafeRelPath(c.path)) { unsafeSkipped++; notRestored.push(`${c.path}（路径不安全）`); continue; }
      const src = path.join(workPayload, c.path);
      const target = path.join(targetDir, c.path);
      if (!(await exists(src))) { notRestored.push(`${c.path}（包内无此材料）`); continue; }
      if ((input.onConflict === "skip") && (await exists(target))) { notRestored.push(`${c.path}（按选择跳过）`); continue; }
      await ensureDir(path.dirname(target));
      await fs.rm(target, { force: true, recursive: false }).catch(() => {});
      const st = await fs.lstat(src);
      if (c.mode === "120000" || st.isSymbolicLink()) {
        const linkBuf = await readLinkPayload(src);
        const linkText = (linkBuf ?? Buffer.alloc(0)).toString("utf8");
        const kind = await makeLink(linkText, target);
        if (kind === "plain") { placeholderLinks++; notRestored.push(`${c.path}（链接退化为普通文件）`); }
        else if (kind === "junction") junctionLinks++;
      } else {
        await fs.copyFile(src, target);
        if (c.mode === "100755") await fs.chmod(target, 0o755).catch(() => {});
      }
      written.add(c.path);
      restoredCount++;
    }
    if (unsafeSkipped) gaps.push({ kind: "环境", title: `${unsafeSkipped} 个包内路径被跳过`, detail: "含绝对路径/盘符/../ 片段，写入它们会落到目标目录之外。这份包不该继续用于交接，请回源电脑重新创建。", blocking: true });
    if (placeholderLinks) gaps.push({ kind: "环境", title: `${placeholderLinks} 个符号链接退化为普通文件`, detail: "本机没有创建符号链接的权限（Windows 需开发者模式或管理员），目录联接也不适用。文件内容是链接目标文本，已如实计入「只在包里」，不算作已完整还原。", blocking: false });
    if (junctionLinks) steps.push({ title: "目录联接", ok: true, detail: `${junctionLinks} 个指向目录的链接以 Windows 目录联接（junction）落地：不需要特权，语义与目录符号链接等价，但复制/备份工具会把它当普通目录跟随` });
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
    let baselineWritten = 0;
    const baselineSkipped: string[] = [];
    if (baselineOk) {
      report("重建基线", 70, "正在从 bundle 重建基线历史与未改动文件");
      await gitCmd(["read-tree", "HEAD"], targetDir).catch(() => {});
      try {
        // -z：基线树里的非 ASCII 文件名（中文项目名/目录名）要按原样拿到。
        // 按默认的引用串处理会得到 "\"\\344\\270\\255…\"" 这种本机不存在的路径，
        // 它既过不了安全判定也写不下去 —— 于是整批文件被静默跳过而回执仍然说"基线已重建"。
        const ls = await gitNul(["ls-tree", "-r", "--name-only", "-z", "HEAD"], targetDir);
        const modeMap = await indexModeMap(targetDir);
        for (const p of ls) {
          if (!p) continue;
          if (capturedPaths.has(p)) continue;
          if (!isSafeRelPath(p)) { baselineSkipped.push(`${p}（路径不安全）`); continue; }
          const content = await gitCatFile(targetDir, p);
          if (content === null) { baselineSkipped.push(`${p}（对象读不出）`); continue; }
          const dest = path.join(targetDir, p);
          await ensureDir(path.dirname(dest));
          await fs.rm(dest, { force: true }).catch(() => {});
          const mode = modeMap.get(p) ?? "100644";
          if (mode === "120000") {
            const kind = await makeLink(content.toString("utf8"), dest);
            if (kind === "plain") placeholderLinks++;
            else if (kind === "junction") junctionLinks++;
          } else {
            await fs.writeFile(dest, content);
            if (mode === "100755") await fs.chmod(dest, 0o755).catch(() => {});
          }
          written.add(p);
          baselineWritten++;
        }
        // 索引说是链接、工作区里却不是：这是形态丢失，不是文件丢失，单独说清（别用计数掩盖）
        const modeLost = await detectLostModes(targetDir, ls, modeMap);
        const linkTotal = ls.filter((p) => modeMap.get(p) === "120000").length;
        const execTotal = ls.filter((p) => modeMap.get(p) === "100755").length;
        steps.push({
          title: "基线物化", ok: baselineSkipped.length === 0 && modeLost.length === 0,
          detail: baselineSkipped.length || modeLost.length
            ? `基线 ${ls.length} 个路径里写入 ${baselineWritten} 个；未落地 ${baselineSkipped.length} 项：${baselineSkipped.slice(0, 6).join("、")}${baselineSkipped.length > 6 ? ` 等 ${baselineSkipped.length} 项` : ""}${modeLost.length ? `；链接形态未还原 ${modeLost.length}/${linkTotal}：${modeLost.slice(0, 4).join("、")}` : ""}`
            : `基线 ${baselineWritten} 个未改动文件已从 bundle 重建到工作区与索引（含 ${linkTotal} 个符号链接、${execTotal} 个可执行位）`,
        });
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

    // 空目录：Git 不保存它们，只能靠包内清单重建；建不出来（同名文件已存在）要如实计入
    const emptyDirs = state.emptyDirs ?? [];
    let emptyDirsRestored = 0;
    for (const d of emptyDirs) {
      if (!isSafeRelPath(d)) continue;
      const dir = path.join(targetDir, d);
      const ok = await ensureDir(dir).then(() => true).catch(() => false);
      if (ok) emptyDirsRestored++;
      else notRestored.push(`${d}（空目录建不出来）`);
    }
    if (emptyDirs.length) {
      steps.push({
        title: "空目录重建", ok: emptyDirsRestored === emptyDirs.length,
        detail: `${emptyDirsRestored}/${emptyDirs.length} 个空目录已重建（Git 不保存空目录，靠交接清单带过来）`,
      });
    }

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

    const env = await envDiff(state, targetDir);
    gaps.push(...env.gaps);
    steps.push({ title: "环境差异评估", ok: true, detail: env.detail });

    const entrySrc = path.join(workDir, "HANDOFF.md");
    const entryDest = path.join(targetDir, "ACB-HANDOFF.md");
    if (await exists(entrySrc)) await fs.copyFile(entrySrc, entryDest);
    steps.push({ title: "生成接手入口", ok: true, detail: `ACB-HANDOFF.md 已写入目标目录，Agent 可直接阅读：${entryDest}` });

    // 逐项对账：一致 / 覆盖 / 只在包里 / 只在目标（本机自己的东西）
    const { paths: afterTarget, capped } = await scanTargetEntries(targetDir);
    const pkgPaths = packagePathSet(state, baselinePaths);
    const onlyInTarget = afterTarget.filter((p) => !pkgPaths.has(p) && !p.startsWith("ACB-") && !p.startsWith(".acb-case-probe"));
    const receipt: ResumeReceipt = {
      identical: conflicts.filter((c) => c.identical).length,
      overwritten: input.onConflict === "overwrite" ? conflicts.filter((c) => !c.identical).length : 0,
      onlyInPackage: notRestored.slice(0, RECEIPT_CAP),
      onlyInTarget: onlyInTarget.slice(0, RECEIPT_CAP),
      onlyInPackageCount: notRestored.length + baselineSkipped.length,
      onlyInTargetCount: onlyInTarget.length + (capped ? 1 : 0),
      emptyDirsRestored,
    };
    if (notRestored.length || baselineSkipped.length) {
      gaps.push({
        kind: "环境", title: `${notRestored.length + baselineSkipped.length} 个包内路径没有落地（只在包里）`,
        detail: [...notRestored, ...baselineSkipped].slice(0, 8).join("；") + "。这些路径在包里但不在目标目录里，回执按逐项列出，不做静默省略。",
        blocking: false,
      });
    }
    if (onlyInTarget.length) {
      gaps.push({
        kind: "环境", title: `目标目录里另有 ${onlyInTarget.length} 个条目不属于本次交接（只在目标）`,
        detail: `${onlyInTarget.slice(0, 8).join("、")}${onlyInTarget.length > 8 ? " 等" : ""}。恢复没有触碰它们 —— 它们是这台机器自己的文件，不是交接内容的一部分。`,
        blocking: false,
      });
    }

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
      baselineExpected: baselinePaths?.filter((p) => !capturedPaths.has(p)).length,
      baselineWritten,
      baselineSkipped,
      receipt,
    };
    await fs.writeFile(path.join(targetDir, "ACB-RESUME-REPORT.md"), renderReportMarkdown(out));

    report("完成", 99, `恢复结束：${verdict}`);
    return { report: out, state };
  } finally {
    await loaded.dispose();
  }
}

/**
 * 索引模式与工作区形态是否一致：Windows 上 checkout 出来的 120000 条目可能只是普通文件
 * （没有创建链接的特权）。这一步把"模式记进索引但形态已经丢掉"的路径列出来，
 * 免得基线物化那一步用"含 N 个符号链接"这种计数掩盖真实丢失。
 */
async function detectLostModes(dir: string, paths: string[], modeMap: Map<string, string>): Promise<string[]> {
  const lost: string[] = [];
  for (const p of paths) {
    if (modeMap.get(p) !== "120000") continue;
    const st = await fs.lstat(path.join(dir, p)).catch(() => null);
    if (!st || !st.isSymbolicLink()) lost.push(p);
  }
  return lost;
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
    // 同样必须 -z，否则非 ASCII 路径的 key 与 ls-tree 的结果对不上，链接位与执行位就查不出来了
    for (const line of await gitNul(["ls-files", "-s", "-z"], dir)) {
      const m = /^(\d{6}) [0-9a-f]+ (?:\d+\t)?(.*)$/s.exec(line.trim());
      if (m) map.set(m[2], m[1]);
    }
  } catch { /* 无索引 */ }
  return map;
}

/** GitHub 恢复前的轻量预览：不落地，只看分支可达与元数据 */
export async function previewGithubResume(input: { remote: string; handoffId: string; targetDir: string; cwd?: string }): Promise<{ reachable: boolean; state?: ProjectState; detail: string }> {
  // remote 与 handoffId 都来自请求体，最后会当成 argv 交给 git —— 在拼 ref 之前先判死（见 remote-policy.ts）
  const remote = assertSafeGitRemote(input.remote);
  const handoffId = assertSafeGitRefish(input.handoffId, "handoffId");
  const branch = `acb/handoff/${handoffId}`;
  const ref = assertSafeGitRefish(`refs/heads/${branch}`, "ref");
  const cwd = input.cwd ?? os.homedir();
  try {
    const out = await gitCmd(["ls-remote", remote, "--", ref], cwd);
    if (!out.trim()) return { reachable: false, detail: `远端没有分支 ${branch}：确认远端地址与交接 ID，或在源电脑先「发布到 GitHub」。` };
    const sha = out.split("\t")[0].trim();
    // sha 是远端输出的一部分，拼进 cat-file 之前按 40 位十六进制判死
    if (!/^[0-9a-f]{40}$/.test(sha)) return { reachable: false, detail: "远端返回的提交号不是合法的 SHA-1，已停止读取。" };
    await gitCmd(["fetch", "-q", remote, "--", ref], cwd).catch(() => {});
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
  // 与 previewGithubResume 同一把尺：恢复这条路径真的会把远端内容写进工作区，
  // 所以 remote/handoffId 在被拼成 git argv 之前必须判死，而不是只在 HTTP 层判
  //（预览与执行认不同的源，是最难查的那种差异）。
  const remote = assertSafeGitRemote(input.remote);
  const handoffId = assertSafeGitRefish(input.handoffId, "handoffId");
  const { targetDir, onProgress } = input;
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
    execFile("git", ["fetch", "-q", remote, "--", `refs/heads/${branch}`], { cwd: targetDir, timeout: 120_000 }, (err, _o, stderr) => {
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

  const collisions = caseCollisions(state.changes.map((c) => c.path));
  if (collisions.length && await fileSystemIsCaseInsensitive(targetDir)) {
    throw new Error(`分支内容里有 ${collisions.length} 组仅大小写不同的路径（${collisions[0].join(" / ")}），本机文件系统不分大小写，恢复会静默覆盖。出路：换一个区分大小写的目录/卷，或回源电脑改名后重新发布。`);
  }

  report2("物化检查点", 45, "正在物化远端检查点到目标目录");
  // -z 同上一条理由：远端分支里的中文路径在默认输出里是被引用过的八进制串，落不了地
  const ls = await gitNul(["ls-tree", "-r", "--name-only", "-z", "HEAD"], targetDir);
  const modeMap = await indexModeMap(targetDir);
  let written = 0;
  let placeholder = 0;
  let junction = 0;
  let skippedConflict = 0;
  const notRestored: string[] = [];
  const writtenPaths = new Set<string>();
  // 代码路径（不含 .acb-meta/**：那是交接元数据，会一并落地但不计入代码对账）
  const codePaths = ls.filter((p) => p && !p.startsWith(".acb-meta/"));
  for (const p of ls) {
    if (!p) continue;
    if (!isSafeRelPath(p)) { notRestored.push(`${p}（路径不安全）`); continue; }
    const content = await gitCatFile(targetDir, p);
    if (content === null) { notRestored.push(`${p}（对象读不出）`); continue; }
    const dest = path.join(targetDir, p);
    if (input.onConflict === "skip" && (await exists(dest))) { skippedConflict++; notRestored.push(`${p}（按选择跳过）`); continue; }
    await ensureDir(path.dirname(dest));
    await fs.rm(dest, { force: true }).catch(() => {});
    const mode = modeMap.get(p) ?? "100644";
    if (mode === "120000") {
      const kind = await makeLink(content.toString("utf8"), dest);
      if (kind === "plain") { placeholder++; notRestored.push(`${p}（链接退化为普通文件）`); }
      else if (kind === "junction") junction++;
    } else {
      await fs.writeFile(dest, content);
      if (mode === "100755") await fs.chmod(dest, 0o755).catch(() => {});
    }
    writtenPaths.add(p);
    written++;
  }
  const dels = state.changes.filter((c) => c.status === "deleted" || c.status === "renamed");
  for (const c of dels) {
    const p = c.status === "renamed" ? c.oldPath! : c.path;
    if (!isSafeRelPath(p)) continue;
    await fs.rm(path.join(targetDir, p), { force: true }).catch(() => {});
    await gitCmd(["update-index", "--force-remove", "--", p], targetDir).catch(() => {});
  }
  if (placeholder) gaps.push({ kind: "环境", title: `${placeholder} 个符号链接退化为普通文件`, detail: "本机没有创建符号链接的权限（Windows 需开发者模式或管理员）。已如实计入「只在包里」，不作为完整还原。", blocking: false });
  if (junction) steps.push({ title: "目录联接", ok: true, detail: `${junction} 个指向目录的链接以 Windows 目录联接落地（不需要特权）` });
  steps.push({
    title: "恢复至目标目录", ok: true,
    detail: `检查点树物化 ${written} 项 · 删除 ${dels.length} 项保持移除${skippedConflict ? ` · 按选择跳过 ${skippedConflict} 项已存在路径` : ""}${notRestored.length ? ` · ${notRestored.length} 项只在包里未落地` : ""}`,
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

  const emptyDirs = state.emptyDirs ?? [];
  let emptyDirsRestored = 0;
  for (const d of emptyDirs) {
    if (!isSafeRelPath(d)) continue;
    if (await ensureDir(path.join(targetDir, d)).then(() => true).catch(() => false)) emptyDirsRestored++;
  }
  if (emptyDirs.length) {
    steps.push({ title: "空目录重建", ok: emptyDirsRestored === emptyDirs.length, detail: `${emptyDirsRestored}/${emptyDirs.length} 个空目录已重建` });
  }

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

  const env = await envDiff(state, targetDir);
  gaps.push(...env.gaps);
  steps.push({ title: "环境差异评估", ok: true, detail: env.detail });

  const md = await gitCatFile(targetDir, ".acb-meta/HANDOFF.md");
  const entryDest = path.join(targetDir, "ACB-HANDOFF.md");
  if (md !== null) await fs.writeFile(entryDest, md);
  steps.push({ title: "生成接手入口", ok: md !== null, detail: md !== null ? `ACB-HANDOFF.md 已写入目标目录：${entryDest}` : "分支里没有 HANDOFF.md（旧版本发布），请回源电脑重新发布" });

  const { paths: afterTarget, capped } = await scanTargetEntries(targetDir);
  const onlyInTarget = afterTarget.filter((p) => !writtenPaths.has(p) && !p.startsWith("ACB-"));
  const receipt: ResumeReceipt = {
    identical: 0,
    overwritten: 0,
    onlyInPackage: notRestored.slice(0, RECEIPT_CAP),
    onlyInTarget: onlyInTarget.slice(0, RECEIPT_CAP),
    onlyInPackageCount: notRestored.length,
    onlyInTargetCount: onlyInTarget.length + (capped ? 1 : 0),
    emptyDirsRestored,
  };
  if (onlyInTarget.length) {
    gaps.push({ kind: "环境", title: `目标目录里另有 ${onlyInTarget.length} 个条目不属于本次交接（只在目标）`, detail: `${onlyInTarget.slice(0, 8).join("、")}${onlyInTarget.length > 8 ? " 等" : ""}；恢复没有触碰它们。`, blocking: false });
  }

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
    baselineExpected: codePaths.length, baselineWritten: written,
    receipt,
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

async function envDiff(state: ProjectState, targetDir: string): Promise<{ gaps: ResumeGap[]; detail: string }> {
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
  // 本机能不能把这些路径摆出来：保留设备名与结尾点/空格在 Windows 上是另一回事，别混进 OS 差异里
  const named = state.changes.map((c) => c.path).filter((p) => windowsNameIssues(p).length > 0);
  if (named.length && process.platform === "win32") {
    gaps.push({
      kind: "环境", title: `${named.length} 个路径在本机（Windows）不可命名，已按字节写出但不可用`,
      detail: `${named.slice(0, 8).join("、")}${named.length > 8 ? " 等" : ""} 含保留设备名或以点/空格结尾。ACB 用扩展长度路径写出的这些条目，资源管理器与多数工具看不见。`,
      blocking: false,
    });
  }
  const long = state.changes.map((c) => c.path)
    .map((p) => projectedPathLength(targetDir, p))
    .filter((len) => len > WIN_MAX_PATH).length;
  if (long) {
    gaps.push({
      kind: "环境", title: `${long} 个路径拼上目标目录后超过 ${WIN_MAX_PATH} 字符`,
      detail: "ACB 自己能读写（扩展长度路径），但目标目录里的其他工具可能失败。换一个更短的目标目录路径最稳。",
      blocking: false,
    });
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
