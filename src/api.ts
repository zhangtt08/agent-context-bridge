// 前端 API 层：与本地 ACB 服务通信，类型与后端共享
import type {
  ProjectConfig, HandoffRecord, PublicationReceipt, ResumeReport,
  VerificationRecord, ProjectState, CapturePreview, ResumePreview, JobView, ConflictPolicy,
  PreviewAlert, PreviewFile, PreviewExclusion, ResumeConflict,
} from "../shared/types.js";

const BASE = "/api";

// Electron 桌面壳经 preload 注入的原生对话框与拖放路径解析（浏览器端不存在，用可选属性降级）
declare global {
  interface Window {
    acb?: {
      platform?: string;
      pickFolder?: () => Promise<string | null>;
      pickArchive?: () => Promise<string | null>;
      getPathForFile?: (file: File) => string;
      /** 自绘标题栏的窗口三键（frameless 窗口用，浏览器端不存在） */
      windowControls?: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<boolean>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
      };
    };
  }
}

/** 桌面壳注入的窗口三键；浏览器端返回 undefined */
export function windowControls(): NonNullable<Window["acb"]>["windowControls"] {
  return window.acb?.windowControls;
}

/** 桌面壳报告的平台；浏览器端返回 undefined（macOS 用系统红绿灯，不渲染自绘三键） */
export function desktopPlatform(): string | undefined {
  return window.acb?.platform;
}

/** 从拖放的 File 取本机路径；非桌面版或取不到时返回 null */
export function pathFromDrop(file: File | undefined | null): string | null {
  const p = file && window.acb?.getPathForFile?.(file);
  return p ? p : null;
}

/** 服务在不在，决定错误提示该说什么：本地 API 掉了要指回启动入口，而不是丢一句 JSON 解析失败 */
async function j<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + url, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new Error("连不上本地 ACB 服务。出路：桌面版请确认 ACB.exe 已启动；开发模式请在项目目录跑 npm run dev（API 在 :5174）。");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`服务返回的不是 JSON（HTTP ${res.status}）。出路：确认只有一个 ACB 服务在跑；开发模式下 /api 需要代理到 :5174。`);
  }
  if (!res.ok) {
    const e = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(e);
  }
  return data as T;
}

export interface ProjectSelect extends ProjectConfig {}

export const api = {
  listProjects: () => j<ProjectConfig[]>("/projects"),
  registerProject: (path: string, name?: string) =>
    j<ProjectConfig>("/projects", { method: "POST", body: JSON.stringify({ path, name }) }),
  removeProject: (id: string) => j<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),
  seedDemo: () => j<ProjectConfig>("/demo/seed", { method: "POST" }),

  overview: (id: string) => j<Overview>(`/projects/${id}/overview`),
  config: (id: string) => j<ProjectConfig>(`/projects/${id}/config`),
  saveConfig: (id: string, patch: Partial<Pick<ProjectConfig, "checks" | "githubRemote" | "name">>) =>
    j<ProjectConfig>(`/projects/${id}/config`, { method: "PUT", body: JSON.stringify(patch) }),

  /** 打包前审阅清单（只探测磁盘，不写文件） */
  preview: (id: string) => j<CapturePreview>(`/projects/${id}/preview`),
  /** 异步打包：立即拿 jobId，进度走 job() */
  createHandoff: (id: string, input: {
    taskName: string; claimText?: string; claimEvidence?: string; nextStep?: string;
    runChecks?: boolean; parentHandoffIds?: string[];
  }) => j<{ jobId: string }>(`/projects/${id}/handoffs`, { method: "POST", body: JSON.stringify({ ...input, async: true }) }),
  /** 同步打包（CLI/测试用，界面不走这条） */
  createHandoffSync: (id: string, input: { taskName: string; runChecks?: boolean; parentHandoffIds?: string[] }) =>
    j<CreateResult>(`/projects/${id}/handoffs`, { method: "POST", body: JSON.stringify({ ...input, async: false }) }),

  job: (jobId: string) => j<JobView>(`/jobs/${jobId}`),
  integrity: (id: string) => j<{ handoffId: string; ok: boolean; entryCount: number; verifiedCount: number; broken: string[]; label: string }>(`/handoffs/${id}/integrity`),

  handoff: (id: string) => j<{ record: HandoffRecord; project: ProjectConfig; children: string[] }>(`/handoffs/${id}`),
  publish: (id: string, target: "github" | "local", remote?: string) =>
    j<{ receipt: PublicationReceipt; record: HandoffRecord }>(`/handoffs/${id}/publish`, { method: "POST", body: JSON.stringify({ target, remote }) }),

  // 列出远端交接：优先用远端地址直查（电脑 B 未注册项目时），否则用项目配置的远端
  remoteHandoffs: (projectId: string | null, remote?: string) => {
    const qs = remote ? `remote=${encodeURIComponent(remote)}` : `projectId=${encodeURIComponent(projectId ?? "")}`;
    return j<{ id: string; sha: string; taskName: string | null; parentHandoffIds: string[] }[]>(`/remotes/handoffs?${qs}`);
  },

  /** 还原前预览：目标目录撞了什么、包里有什么、完整性如何 */
  resumePreview: (input: ResumeInput) => j<{ preview: ResumePreview | null; github?: { reachable: boolean; detail: string } }>(
    "/resume/preview", { method: "POST", body: JSON.stringify(input) }),
  resume: (input: ResumeInput) =>
    j<{ report: ResumeReport; taskName?: string } | { jobId: string }>("/resume", { method: "POST", body: JSON.stringify({ ...input, async: true }) }),
  resumeReports: () => j<ResumeReport[]>("/resume/reports"),
};

export interface ResumeInput {
  mode: "file" | "remote" | "github";
  filePath?: string;
  projectId?: string;
  remote?: string;
  handoffId?: string;
  targetDir: string;
  onConflict?: ConflictPolicy;
  archiveSha256?: string;
}

/** 轮询作业直到结束：一次一跳，服务挂了也能退出而不是永远转圈 */
export async function waitJob(jobId: string, onTick?: (j: JobView) => void, timeoutMs = 30 * 60_000): Promise<JobView> {
  const started = Date.now();
  for (;;) {
    const view = await api.job(jobId);
    onTick?.(view);
    if (view.state !== "进行中") return view;
    if (Date.now() - started > timeoutMs) {
      throw new Error("任务超过 30 分钟仍未结束。出路：确认磁盘与 git 还在工作（大仓库的 bundle 可能很慢），或取消后改用 GitHub 交接分支路径。");
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

/** 把作业结果收成可用类型 */
export function jobResult<T>(view: JobView): T {
  if (view.state !== "完成") throw new Error(view.error ?? view.message);
  return view.result as T;
}

// ---- Overview 数据形状（与后端 /projects/:id/overview 对齐） ----
export interface OverviewTask {
  taskId: string;
  taskName: string;
  status: string;
  latestHandoff: string;
  handoffTime: string;
  handoffs: { id: string; at: string }[];
}
export interface OverviewHandoff {
  handoffId: string;
  taskName: string;
  sealedAt: string;
  snapshot: string;
  publish: { label: string; tone: string };
  verify: { label: string; tone: string };
  integrity: { label: string; tone: string };
}
export interface Overview {
  config: ProjectConfig;
  branch: string | null;
  commit: string | null;
  dirty: {
    staged: number; unstaged: number; untracked: number; total: number;
    excluded: { label: string; reason: string; kind: string }[];
    env: { os: string; node: string };
  };
  stats: { changes: number; activeTasks: number; published: number; forks: number; failedChecks: number };
  tasks: OverviewTask[];
  handoffs: OverviewHandoff[];
  forksList: { parent: string; children: string[] }[];
}
export interface CreateResult {
  record: HandoffRecord;
  snapshot: { id: string; digest: string; files: number; bytes: number };
  verifications: VerificationRecord[];
  warnings: string[];
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function shortDigest(s: string): string {
  const full = s.split("full:")[1];
  if (!full) return s;
  return `src_sha256:${full.slice(0, 12)}…${full.slice(-4)}`;
}

export type {
  HandoffRecord, ProjectState, PublicationReceipt, ResumeReport, VerificationRecord, ProjectConfig,
  CapturePreview, ResumePreview, JobView, PreviewAlert, PreviewFile, PreviewExclusion, ResumeConflict, ConflictPolicy,
};
