// 总览视图：唯一一份实现，REST 路由（GET /api/projects/:id/overview）与
// Agent 工具（acb.project_overview）都调这里。
//
// 为什么单独成文件：同一个事实有两个算法迟早分叉 —— 界面说"3 个进行中任务"而 Agent 读到
// 另一个数字时，最难查的正是这种"两边都自洽"的缺陷。这里保持一份，路由只做 HTTP 外壳。
import {
  findProject, listProjects, loadHandoffRecords, getHandoffRecord,
} from "./store.js";
import { gitStatus, isGitRepo, isExcluded, excludePolicySummary } from "./gitutil.js";
import { verifyPackage } from "./package.js";
import type { HandoffRecord, ProjectConfig } from "../../shared/types.js";

export type Records = HandoffRecord[];

/** "项目未注册"在 HTTP 层是 404、在 Agent 层是 not_found，用类型区分而不是靠字符串匹配 */
export class OverviewNotFound extends Error {}

/**
 * 注册还在、但它指向的目录已经不在（或不再是 Git 工作区）。
 * 它是 OverviewNotFound 的子类，所以两道外壳（REST 的 route() 与 Agent 的
 * classifyCoreError）现有的按类型判定会直接把 500 变成 404/not_found ——
 * 这条失败是调用方能自己修好的（把目录移回来或重新注册），不是服务器坏了，
 * 报 500 会让 Agent 以为服务有问题去重试。
 */
export class ProjectDirUnavailable extends OverviewNotFound {}

/**
 * REST 总览、REST 预览、Agent 工具共用的那一道目录检查（只有一份）。
 * 之前同一个判断在路由里带路径带出路、在这里只剩一句"项目目录已不是 Git 仓库"，
 * 于是界面能看到原因、Agent 只拿到一个 500 —— 分叉就是这么长出来的。
 */
export async function requireGitProject(projectIdOrPath: string): Promise<ProjectConfig> {
  const p = await findProject(projectIdOrPath);
  if (!p) throw new OverviewNotFound(`项目未注册：${projectIdOrPath}`);
  if (!(await isGitRepo(p.path))) {
    throw new ProjectDirUnavailable(
      `项目「${p.name}」的目录已不是 Git 仓库：${p.path}（目录可能被移动/改名/删除；出路：把目录移回来，或在项目管理面板里按新路径重新注册）`,
    );
  }
  return p;
}

export function groupTasks(records: Records) {
  const map = new Map<string, { taskId: string; taskName: string; status: string; handoffs: { id: string; at: string }[]; latest?: { id: string; at: string } }>();
  for (const r of records) {
    const t = map.get(r.state.taskId) ?? { taskId: r.state.taskId, taskName: r.state.taskName, status: "进行中", handoffs: [] };
    t.handoffs.push({ id: r.handoffId, at: r.sealedAt });
    if (!t.latest || t.latest.at < r.sealedAt) t.latest = { id: r.handoffId, at: r.sealedAt };
    map.set(r.state.taskId, t);
  }
  return [...map.values()].map((t) => ({
    ...t,
    latestHandoff: t.latest?.id ?? "—",
    handoffTime: t.latest?.at ?? "",
  }));
}

export function detectForks(records: Records) {
  const forks: { parent: string; children: string[] }[] = [];
  const byParent = new Map<string, string[]>();
  for (const r of records) {
    for (const p of r.state.parentHandoffIds) {
      byParent.set(p, [...(byParent.get(p) ?? []), r.handoffId]);
    }
  }
  for (const [parent, children] of byParent) {
    if (children.length > 1) forks.push({ parent, children });
  }
  return forks;
}

export function latestPublication(r: HandoffRecord) {
  const pub = r.publications[r.publications.length - 1];
  if (!pub) return { label: "未发布", tone: "" };
  if (pub.state === "已发布") return { label: pub.target === "github" ? `已发布 · ${pub.location.split("·").pop()?.trim()}` : `本地导出`, tone: "green" };
  if (pub.state === "失败") return { label: `发布失败`, tone: "red" };
  return { label: pub.state, tone: "" };
}

export function verifySummary(r: HandoffRecord) {
  const vs = r.state.verifications;
  if (vs.length === 0) return { label: "未执行", tone: "" };
  const fail = vs.filter((v) => v.result === "失败" || v.result === "超时" || v.result === "执行器错误").length;
  if (fail > 0) return { label: `${fail} 项失败`, tone: "red" };
  return { label: "检查通过", tone: "green" };
}

/** 总览页数据；项目未注册或目录已不是 Git 仓库时抛错（由调用方折成 HTTP/Agent 错误） */
export async function buildProjectOverview(projectIdOrPath: string) {
  const p = await requireGitProject(projectIdOrPath);

  const st = await gitStatus(p.path);
  const realEntries = st.entries.filter((e) => !isExcluded(e.path));
  const records = await loadHandoffRecords(p.path);
  const tasks = groupTasks(records);
  const forks = detectForks(records);

  return {
    config: p,
    branch: st.branch,
    commit: st.commit,
    dirty: {
      staged: realEntries.filter((e) => e.x !== " " && e.x !== "?").length,
      unstaged: realEntries.filter((e) => e.y === "M" || e.y === "D").length,
      untracked: realEntries.filter((e) => e.x === "?").length,
      excluded: excludePolicySummary(),
      total: realEntries.length,
      env: { os: `${process.platform}`, node: process.version },
    },
    stats: {
      changes: realEntries.length,
      activeTasks: tasks.filter((t) => t.status === "进行中").length,
      published: records.filter((r) => r.publications.some((x) => x.state === "已发布")).length,
      forks: forks.length,
      failedChecks: records.filter((r) => r.state.verifications.some((v) => v.result !== "通过" && v.result !== "未执行")).length,
    },
    tasks,
    handoffs: records.slice(0, 10).map((r) => ({
      handoffId: r.handoffId,
      taskName: r.state.taskName,
      sealedAt: r.sealedAt,
      snapshot: `${r.state.baseline.commit?.slice(0, 7) ?? "无"} + ${r.state.changes.length} 文件`,
      publish: latestPublication(r),
      verify: verifySummary(r),
      integrity: { label: "未核对", tone: "" },
    })),
    forksList: forks,
  };
}

/** 单条交接在本机哪个项目下（跨项目扫注册表；REST 与工具共用同一条查找路径） */
export async function locateHandoff(handoffId: string): Promise<{ project: ProjectConfig; record: HandoffRecord; children: string[] } | null> {
  const projects = await listProjects();
  for (const p of projects) {
    const rec = await getHandoffRecord(p.path, handoffId);
    if (!rec) continue;
    const all = await loadHandoffRecords(p.path);
    const children = all.filter((r) => r.state.parentHandoffIds.includes(handoffId)).map((r) => r.handoffId);
    return { project: p, record: rec, children };
  }
  return null;
}

/** 包完整性实测（打开详情页/工具调用时才跑，避免总览页逐包扫盘） */
export async function measureIntegrity(rec: HandoffRecord) {
  const c = await verifyPackage(rec.packageDir);
  return {
    handoffId: rec.handoffId,
    packageDir: rec.packageDir,
    ok: c.ok,
    entryCount: c.entryCount,
    verifiedCount: c.verifiedCount,
    broken: c.broken.slice(0, 20),
    brokenCount: c.broken.length,
    label: c.ok ? `完整 · ${c.verifiedCount}/${c.entryCount}` : `异常 · ${c.verifiedCount}/${c.entryCount}`,
  };
}
