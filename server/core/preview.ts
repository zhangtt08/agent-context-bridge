// Preview Module：把"将要打包什么、排除了什么、为什么"在动手之前摊开给人看。
// 只做磁盘探测（plan），不读文件内容、不写任何文件，因此可以在大仓库上反复刷新。
import { plan, CAPTURE_MEMORY_LIMIT } from "./capture.js";
import {
  caseCollisions, fmtBytes, isExcluded, isSafeRelPath, windowsNameIssues,
  projectedPathLength, WIN_MAX_PATH,
} from "./gitutil.js";
import type { ProjectConfig, CapturePreview, PreviewAlert, PreviewFile } from "../../shared/types.js";

const LARGE_FILE = 5 * 1024 * 1024;      // 单文件 5MB 起提示
const HUGE_REPO = 300 * 1024 * 1024;     // 对象库 300MB 起警告（bundle 会带走完整历史）

/** 只列前若干条，避免告警本身把界面刷成一堵墙 */
const LIST_CAP = 6;

/**
 * 路径形态判据 —— 审阅清单与打包入口共用同一份，
 * 否则会出现"界面说阻塞、CLI 却照样打出包"的两套规则。
 * 只看路径与目录长度，不读任何文件内容。
 */
export function pathFidelityAlerts(paths: string[], baseDir?: string): PreviewAlert[] {
  const alerts: PreviewAlert[] = [];

  // 大小写碰撞：Windows/macOS 默认文件系统不分大小写，恢复时后者会静默覆盖前者
  for (const group of caseCollisions(paths)) {
    alerts.push({
      level: "阻塞",
      title: `路径仅大小写不同：${group.join(" / ")}`,
      detail: "这些路径只在大小写上不同。Windows 与 macOS 默认文件系统不分大小写，恢复时其中一个会被另一个静默覆盖，代码指纹随之不一致。",
      action: "先在源仓库把其中一个改名（例如加目录前缀），再创建交接；ACB 不会替你的项目改名。",
    });
  }

  // 无法安全映射到其它机器的路径（拼进目标目录就会写到外面）
  for (const p of paths) {
    if (isSafeRelPath(p)) continue;
    alerts.push({
      level: "阻塞",
      title: `路径无法安全落地：${p}`,
      detail: "含绝对路径、盘符、UNC、.. 片段或控制字符；写入它会把内容带到目标目录之外。",
      action: "在源仓库把该条目改名或移出纳入范围，再创建交接。",
    });
  }

  // Windows 命名问题（保留设备名、以点/空格结尾）：接收端可能是 Linux，所以只警告
  const named = paths.filter((p) => windowsNameIssues(p).length > 0);
  if (named.length) {
    alerts.push({
      level: "警告",
      title: `${named.length} 个路径在 Windows 上不可命名：${named.slice(0, LIST_CAP).map((p) => `${p}（${windowsNameIssues(p)[0]}）`).join("、")}${named.length > LIST_CAP ? " 等" : ""}`,
      detail: "Windows 把 CON/NUL/COM1 之类名字保留给设备，也不接受以点或空格结尾的段。ACB 用扩展长度路径仍能按字节写出，但资源管理器与多数工具看不见、打不开，删除也要特殊手段。",
      action: "接收端包含 Windows 就先在源仓库改名；确认只交给 Linux/macOS 可以继续。",
    });
  }

  // 超长路径：ACB 写得出来，接收端的其它工具未必能用
  if (baseDir) {
    const long = paths
      .map((p) => ({ p, len: projectedPathLength(baseDir, p) }))
      .filter((x) => x.len > WIN_MAX_PATH)
      .sort((a, b) => b.len - a.len);
    if (long.length) {
      alerts.push({
        level: "警告",
        title: `${long.length} 个路径拼上目录后超过 ${WIN_MAX_PATH} 字符（最长 ${long[0].len}）`,
        detail: `ACB 用扩展长度路径能恢复，但资源管理器复制、部分构建工具与老脚本会在超长路径上失败：${long.slice(0, LIST_CAP).map((x) => `${x.p} (${x.len})`).join("、")}${long.length > LIST_CAP ? " 等" : ""}。`,
        action: "把项目放在更短的根路径下（如 D:\\dev\\p），或在源仓库压平过深的目录层级。",
      });
    }
  }
  return alerts;
}

/** 纳入范围的全部路径（改动 + 未被排除的基线树）——预览与打包用同一个口径，别各写一遍 */
export function fidelityScopePaths(changedPaths: string[], baselinePaths: string[]): string[] {
  return [...changedPaths, ...baselinePaths.filter((p) => !isExcluded(p))];
}

/** 打包入口用的判据：有阻塞项就说明这个包注定无法忠实还原，先拦住 */
export function pathFidelityBlockerMessage(paths: string[]): string | null {
  const blockers = pathFidelityAlerts(paths).filter((a) => a.level === "阻塞");
  if (!blockers.length) return null;
  return blockers.map((b) => `${b.title} —— ${b.detail} 出路：${b.action}`).join(" ; ");
}

export async function buildPreview(cfg: ProjectConfig): Promise<CapturePreview> {
  const p0 = await plan(cfg.path);

  const included: PreviewFile[] = p0.files.map((f) => ({
    path: f.path, bytes: f.bytes, status: f.status, mode: f.mode, staged: f.staged, kind: f.kind,
  }));
  const includedBytes = included.reduce((s, f) => s + f.bytes, 0);

  const alerts: PreviewAlert[] = [];

  // 1. 什么都没有：空工作区创建出来的交接只带基线，用户常常以为是失败了
  if (included.length === 0) {
    alerts.push({
      level: "提示",
      title: "工作区没有未提交改动",
      detail: "本次将只封存基线提交（" + (p0.status.commit?.slice(0, 7) ?? "无提交") + "），不含任何改动文件。",
      action: "若你刚提交完，这样创建是对的；若想带上的改动没出现，检查它是否被 .gitignore 排除（被忽略的文件不会进入 git status，也就不会进入交接包）。",
    });
  }

  // 2. 路径形态：改动 + 基线树一起判（基线里的中文名/仅大小写不同同样会在接收端互相覆盖或落不了地）
  alerts.push(...pathFidelityAlerts(fidelityScopePaths(included.map((f) => f.path), p0.baselinePaths), cfg.path));

  // 3. 已提交进历史的凭据：排除策略只挡工作区改动，挡不住 bundle 携带的历史
  if (p0.baselineSecrets.length) {
    alerts.push({
      level: "警告",
      title: `${p0.baselineSecrets.length} 个凭据文件已在 Git 历史中`,
      detail: `${p0.baselineSecrets.slice(0, LIST_CAP).join("、")}${p0.baselineSecrets.length > LIST_CAP ? " 等" : ""} 已被提交。基线 bundle 随包携带完整历史，纳入策略无法阻止历史里的内容离开这台电脑。`,
      action: "要跨机交接就先确认这些是测试夹具；若是真凭据，请改用只含本机的历史清理（git filter-repo / BFG）或换用只带所需的仓库，并在接收端轮换该凭据。",
    });
  }

  // 4. 工作区里被排除的凭据要说重一点：它们是"故意没带上"的
  const secretExcluded = p0.excluded.filter((e) => e.kind === "凭据");
  if (secretExcluded.length) {
    alerts.push({
      level: "警告",
      title: `已默认排除 ${secretExcluded.length} 个凭据/配置文件`,
      detail: secretExcluded.map((e) => `${e.path}（${e.reason}）`).join("；"),
      action: "这些文件会写进「恢复要求」，接收端需在本机自行补齐后再运行；不要为了让另一台电脑能跑而把它们放进包。",
    });
  }

  // 5. 读不到的路径（悬空符号链接等）：不能静默少一个文件
  const unreadable = p0.files.filter((f) => f.unreadable);
  if (unreadable.length) {
    alerts.push({
      level: "警告",
      title: `${unreadable.length} 个路径读不到内容`,
      detail: `${unreadable.map((f) => f.path).slice(0, LIST_CAP).join("、")}${unreadable.length > LIST_CAP ? " 等" : ""} 在工作区里被 git 报为改动，但内容取不到（常见于指向不存在目标的符号链接）。`,
      action: "接收端不会凭空出现这些文件。先修复链接目标或删掉它们，再创建交接。",
    });
  }

  // 6. 历史体积：bundle 带走完整历史，这是大仓库"打包很慢"的真正原因
  if (p0.repoBytes > HUGE_REPO) {
    alerts.push({
      level: "警告",
      title: `仓库对象约 ${fmtBytes(p0.repoBytes)}，打包会明显偏慢`,
      detail: "为了让接收端不必再克隆原仓库，交接包用 git bundle 携带完整历史；历史越大，封存与导出越久，交接文件也越大。",
      action: "首次交接后，第二台电脑直接 git clone 原仓库再接收交接包会快得多；或用 git shallow/过滤历史瘦身。",
    });
  }

  // 6.5 恢复材料整体驻留内存的上限：让用户在点按钮之前就知道会不会被打回来
  const pendingBytes = included.reduce((s, f) => s + (f.status === "deleted" ? 0 : f.bytes), 0);
  if (pendingBytes > CAPTURE_MEMORY_LIMIT / 3) {
    alerts.push({
      level: "警告",
      title: `改动内容约 ${fmtBytes(pendingBytes)}，需要整体读进内存`,
      detail: `单次捕获的内存上限是 ${fmtBytes(CAPTURE_MEMORY_LIMIT)}，超过就会被拦下（不会半途把机器读到卡死）。通常是二进制或生成物混进了改动范围。`,
      action: "把可再生产物加进 .gitignore，或改用「发布到 GitHub 交接分支」——那条路径按 git 对象传输，不需要整体驻留内存。",
    });
  }

  // 7. 大文件提示（列出前 8 个，按体积倒序）
  const big = included.filter((f) => f.bytes > LARGE_FILE).sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  if (big.length) {
    alerts.push({
      level: "提示",
      title: `${big.length} 个较大的改动文件`,
      detail: big.map((f) => `${f.path} ${fmtBytes(f.bytes)}`).join(" · "),
      action: "大二进制通常不该走交接包；若它们是可再生产物，请加入 .gitignore 或改用对象存储。",
    });
  }

  const symlinks = included.filter((f) => f.kind === "symlink");
  if (symlinks.length) {
    alerts.push({
      level: "提示",
      title: `${symlinks.length} 个符号链接按链接目标保存`,
      detail: `与 Git 一致，符号链接存的是目标路径文本（${symlinks.slice(0, 4).map((f) => f.path).join("、")}${symlinks.length > 4 ? " 等" : ""}）。若目标是绝对路径或指向仓库外，接收端会悬空。`,
      action: "恢复到 Windows 时若没有创建符号链接的权限，ACB 会先试无权限要求的目录联接，再退回写成普通文件并在报告里如实标注，届时请手动补链接。",
    });
  }

  if (p0.emptyDirs.length || p0.scanTruncated) {
    alerts.push({
      level: "提示",
      title: p0.emptyDirs.length
        ? `${p0.emptyDirs.length} 个空目录会一并重建`
        : "空目录扫描达到上限",
      detail: p0.emptyDirs.length
        ? `Git 不保存空目录，所以它们既不在改动清单也不在基线树里：${p0.emptyDirs.slice(0, LIST_CAP).join("、")}${p0.emptyDirs.length > LIST_CAP ? " 等" : ""}。不单独带过去，接收端就缺这些目录（常见于 uploads/、logs/ 这类运行时占位）。`
        : "空目录扫描在达到上限时被截断，本次没有列出可重建的空目录，可能仍有遗漏。",
      action: "无需操作，恢复时会 mkdir 重建；若某目录里有被 .gitignore 掉的文件，那不属于空目录，需要接收端自行创建。",
    });
  }

  return {
    projectId: cfg.projectId,
    projectName: cfg.name,
    at: new Date().toISOString(),
    baseline: {
      branch: p0.status.branch,
      commit: p0.status.commit,
      repoBytesApprox: p0.repoBytes,
      objects: p0.objects,
    },
    included,
    includedBytes,
    excluded: p0.excluded,
    baselineSecrets: p0.baselineSecrets,
    emptyDirs: p0.emptyDirs,
    emptyDirsTruncated: p0.scanTruncated,
    alerts,
    checksConfigured: cfg.checks.length,
    env: { os: process.platform, runtime: `node ${process.version}`, git: ">=2.20" },
    bundleNote: `基线 bundle 额外携带完整历史（约 ${fmtBytes(p0.repoBytes)} · ${p0.objects} 个对象）· 基线树 ${p0.baselinePaths.length} 个路径`,
  };
}

/** 交接包里的凭据要求：写进 ProjectState.recoveryRequirements 的句子在这里生成，只有一处 */
export function recoveryRequirements(excludedPaths: string[]): string[] {
  return excludedPaths.filter((e) => /^\.env(\..*)?$/i.test(e)).map((e) => `${e} 未随包带出，运行前需在本机补齐`);
}
