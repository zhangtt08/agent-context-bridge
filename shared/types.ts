// ACB 共享协议类型 —— 前后端共用（对齐 docs/PROTOCOL-OUTLINE.md v0.1）

export type VerifyResult = "通过" | "失败" | "未执行" | "超时" | "执行器错误";
export type PublishTarget = "github" | "local";
export type PublishState = "未发布" | "发布中" | "已发布" | "失败";
export type ResumeVerdict = "可继续" | "需要配置环境" | "需要重新验证" | "恢复被阻塞";

export interface ProjectConfig {
  projectId: string;
  name: string;
  path: string;
  /** 每项为一条 shell 检查命令 */
  checks: { name: string; cmd: string; timeoutMs?: number }[];
  /** GitHub 远端（可选） */
  githubRemote?: string;
}

export interface FileChange {
  path: string;               // 项目相对路径（/ 分隔）
  status: "added" | "modified" | "deleted" | "renamed";
  staged: boolean;            // 暂存区状态需要恢复材料
  oldPath?: string;           // renamed 时
  /** Git 文件模式：100644 普通 / 100755 可执行 / 120000 符号链接（内容为链接目标） */
  mode: string;
}

export interface Observation {
  source: string;             // git / fs / env
  scope: string;
  at: string;                 // ISO 时间
  text: string;
}

export interface VerificationRecord {
  checkId: string;
  name: string;
  cmd: string;
  snapshotId: string;
  result: VerifyResult;
  exitCode: number | null;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  logTail: string;            // 截断后的日志尾部
}

export interface AgentClaim {
  sessionId: string;
  at: string;
  text: string;
  nextStep?: string;
  evidence?: string;          // 关联证据说明
}

export interface ProjectState {
  protocolVersion: "0.1";
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  sessionId: string;
  snapshotId: string;
  sourceDigest: string;       // 纳入范围的代码内容指纹
  handoffId: string;
  parentHandoffIds: string[];
  createdAt: string;
  toolVersion: string;

  baseline: { ref: string; commit: string | null; branch: string | null };
  changes: FileChange[];
  untrackedIncluded: string[];
  excluded: string[];         // 纳入策略排除项（凭据/产物等）

  environment: { os: string; runtime: string; git: string };
  observations: Observation[];
  verifications: VerificationRecord[];
  claims: AgentClaim[];

  recoveryRequirements: string[];  // 必需但未纳入、接收端需补齐（如 .env）
  capabilities: string[];          // git/node 等
  /**
   * 工作区里的空目录（相对路径）。Git 不保存空目录，所以它们既不在 status 也不在基线树里；
   * 0.1 增补字段，旧包没有这一项，接收端一律按 ?? [] 读。
   */
  emptyDirs?: string[];
}

export interface PackageManifest {
  protocolVersion: "0.1";
  handoffId: string;
  projectId: string;
  createdAt: string;
  entries: { path: string; sha256: string; size: number }[];
  packageDigest: string;      // 对 entries 排序后的整体摘要（不含本清单自身）
  requiredCapabilities: string[];
}

export interface PublicationReceipt {
  target: PublishTarget;
  state: PublishState;
  location: string;           // 仓库/分支 或 文件路径
  commitSha?: string;         // 传输回执
  readBackConfirmed: boolean;
  attempts: number;
  publishedAt: string;
  error?: string;
  /** 本地导出：归档文件自身的 SHA-256 与字节数，供两台电脑逐字核对 */
  archiveSha256?: string;
  archiveBytes?: number;
}

export interface HandoffRecord {
  handoffId: string;
  projectId: string;
  sealedAt: string;
  state: ProjectState;
  manifest: PackageManifest;
  publications: PublicationReceipt[];
  packageDir: string;
  archivePath?: string;       // 本地导出文件
}

export interface ResumeStep {
  title: string;
  ok: boolean;
  detail: string;
}

export interface ResumeGap {
  kind: "环境" | "凭据" | "验证" | "能力";
  title: string;
  detail: string;
  blocking: boolean;
}

export interface ResumeReport {
  reportId: string;
  handoffId: string;
  source: string;             // 文件路径 或 remote#id
  targetDir: string;
  at: string;
  verdict: ResumeVerdict;
  digestMatch: boolean | null;
  codeRestored: boolean;
  steps: ResumeStep[];
  gaps: ResumeGap[];
  entryMarkdownPath?: string;
  error?: string;
  /** 完整性回执：清单条目数 / 实际校验通过数 / 解开后写入数（旧报告可能没有这些字段） */
  entryCount?: number;
  verifiedCount?: number;
  restoredCount?: number;
  archiveSha256?: string;
  /** 基线物化的实测对账：应写入 / 实际写入 / 被跳过的路径（跳过多于 0 时这一步不算通过） */
  baselineExpected?: number;
  baselineWritten?: number;
  baselineSkipped?: string[];
  /** 逐项回执：一致 / 变更 / 只在包里 / 只在目标 */
  receipt?: ResumeReceipt;
}

/** 还原后的逐项对账：把"哪些一致、哪些变更、哪些只在包里、哪些只在目标"摊开，不靠一句话总结 */
export interface ResumeReceipt {
  /** 目标目录里本来就有、且与包内逐字节一致 */
  identical: number;
  /** 目标目录里内容不同、按策略被包内版本替换 */
  overwritten: number;
  /** 只在包里：本次没有落到目标目录的包内路径（跳过/策略/形态问题），逐条给出 */
  onlyInPackage: string[];
  /** 只在目标：还原后仍在目标目录、但不属于本次交接内容的条目（本机自己的东西） */
  onlyInTarget: string[];
  /** 上面两项各自的总数（列表按上限截断时用这两个数说明还有多少） */
  onlyInPackageCount: number;
  onlyInTargetCount: number;
  /** 空目录重建数 */
  emptyDirsRestored: number;
}

/** 恢复冲突处理策略：还原前先看清目标目录已有什么 */
export type ConflictPolicy = "abort" | "skip" | "overwrite";

/** 打包前审阅清单里的一个条目（只 stat，不读内容，因此大仓库也很快） */
export interface PreviewFile {
  path: string;
  bytes: number;
  status: FileChange["status"];
  mode: string;                 // 100644 / 100755 / 120000
  staged: boolean;
  kind: "file" | "executable" | "symlink" | "deleted";
}

/** 被排除项 + 人可读原因 */
export interface PreviewExclusion {
  path: string;
  reason: string;
  kind: ExcludeReason;
}

export type ExcludeReason = "凭据" | "依赖" | "产物" | "工具存储" | "日志" | "系统文件";

/** 审阅清单里的可执行出路 */
export interface PreviewAlert {
  level: "阻塞" | "警告" | "提示";
  title: string;
  detail: string;
  /** 用户下一步能做的事，不是空话 */
  action: string;
}

export interface CapturePreview {
  projectId: string;
  projectName: string;
  at: string;
  baseline: { branch: string | null; commit: string | null; repoBytesApprox: number; objects: number };
  included: PreviewFile[];
  includedBytes: number;
  excluded: PreviewExclusion[];
  /** 已提交进 Git 历史、随基线 bundle 一起带走的凭据文件（排除策略挡不住历史） */
  baselineSecrets: string[];
  /** 工作区里的空目录（Git 不保存，随包单独重建） */
  emptyDirs: string[];
  /** 空目录扫描是否触到上限（触到时列表不完整，必须说明） */
  emptyDirsTruncated: boolean;
  alerts: PreviewAlert[];
  checksConfigured: number;
  env: { os: string; runtime: string; git: string };
  /** 交接包大致的额外开销：基线 bundle 会携带完整历史 */
  bundleNote: string;
}

export interface ResumeConflict {
  path: string;
  identical: boolean;
  packageBytes: number;
  targetBytes: number;
}

/** 还原前的差异预览：整包校验 + 目标目录比对，一个字节都不写 */
export interface ResumePreview {
  handoffId: string;
  projectName: string;
  taskName: string;
  sealedAt: string;
  source: string;
  targetDir: string;
  integrityOk: boolean;
  entryCount: number;
  verifiedCount: number;
  broken: string[];
  packageDigest: string;
  protocolVersion: string;
  totalBytes: number;
  willWrite: number;
  willDelete: number;
  stagedCount: number;
  symlinkCount: number;
  baselineAvailable: boolean;
  conflicts: ResumeConflict[];
  alerts: PreviewAlert[];
  sourceEnv: { os: string; runtime: string };
  /** 归档体积与摘要说明（本机封存目录时写"无归档摘要"） */
  archiveInfo?: string;
  /**
   * 只在目标：目标目录里已有、但交接内容（改动 + 基线树）里没有的条目。
   * 还原不会碰它们，但必须让人看见 —— 否则"恢复完成"会被误读成"目录里就是交接内容"。
   */
  onlyInTarget?: string[];
  /** onlyInTarget 的总数（列表按上限截断时用它说明还有多少） */
  onlyInTargetCount?: number;
  /** 包内总路径数（改动 + 基线树，基线树取不到时为 null） */
  packagePathCount?: number;
  /** 基线树里但目标目录还没有的路径数（= 还原会补上的未改动文件数） */
  baselineMissingInTarget?: number;
  /** 基线文件清单是否拿到了（bundle 缺失/读不出时为 false，此时上面两项按 0 处理并如实标注） */
  baselineListed?: boolean;
}

/** 长任务（打包 / 还原）的进度视图：轮询它就有大仓库的耗时反馈 */
export interface JobView {
  id: string;
  kind: "capture" | "restore";
  state: "进行中" | "完成" | "失败";
  stage: string;
  pct: number;
  message: string;
  startedAt: string;
  endedAt?: string;
  /** 完成后携带结果 */
  result?: unknown;
  error?: string;
  /** 失败时的可执行出路 */
  remedy?: string;
}
