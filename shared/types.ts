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
  mode: string;               // 如 100644
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
}
