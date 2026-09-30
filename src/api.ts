// 前端 API 层：与本地 ACB 服务（:5174）通信，类型与后端共享
import type {
  ProjectConfig, HandoffRecord, PublicationReceipt, ResumeReport,
  VerificationRecord, ProjectState,
} from "../shared/types.js";

const BASE = "/api";

// Electron 桌面壳经 preload 注入的原生对话框（浏览器端不存在，用可选属性降级）
declare global {
  interface Window {
    acb?: {
      pickFolder?: () => Promise<string | null>;
      pickArchive?: () => Promise<string | null>;
    };
  }
}

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
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

  createHandoff: (id: string, input: { taskName: string; claimText?: string; claimEvidence?: string; nextStep?: string; runChecks?: boolean; parentHandoffIds?: string[] }) =>
    j<CreateResult>(`/projects/${id}/handoffs`, { method: "POST", body: JSON.stringify(input) }),

  handoff: (id: string) => j<{ record: HandoffRecord; project: ProjectConfig; children: string[] }>(`/handoffs/${id}`),
  publish: (id: string, target: "github" | "local", remote?: string) =>
    j<{ receipt: PublicationReceipt; record: HandoffRecord }>(`/handoffs/${id}/publish`, { method: "POST", body: JSON.stringify({ target, remote }) }),

  // 列出远端交接：优先用远端地址直查（电脑 B 未注册项目时），否则用项目配置的远端
  remoteHandoffs: (projectId: string | null, remote?: string) => {
    const qs = remote ? `remote=${encodeURIComponent(remote)}` : `projectId=${encodeURIComponent(projectId ?? "")}`;
    return j<{ id: string; sha: string; taskName: string | null; parentHandoffIds: string[] }[]>(`/remotes/handoffs?${qs}`);
  },

  resume: (input: { mode: "file" | "remote" | "github"; filePath?: string; projectId?: string; remote?: string; handoffId?: string; targetDir: string }) =>
    j<{ report: ResumeReport; taskName?: string }>("/resume", { method: "POST", body: JSON.stringify(input) }),
  resumeReports: () => j<ResumeReport[]>("/resume/reports"),
};

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
  dirty: { staged: number; unstaged: number; untracked: number; excluded: string[]; total: number; env: { os: string; node: string } };
  stats: { changes: number; activeTasks: number; published: number; forks: number; failedChecks: number };
  tasks: OverviewTask[];
  handoffs: OverviewHandoff[];
  forksList: { parent: string; children: string[] }[];
}
export interface CreateResult {
  record: HandoffRecord;
  snapshot: { id: string; digest: string; files: number };
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

export function shortDigest(s: string): string {
  const full = s.split("full:")[1];
  if (!full) return s;
  return `src_sha256:${full.slice(0, 12)}…${full.slice(-4)}`;
}

export type { HandoffRecord, ProjectState, PublicationReceipt, ResumeReport, VerificationRecord, ProjectConfig };
