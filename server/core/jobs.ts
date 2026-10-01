// 长任务进度：内存作业表 + 轮询。大仓库封存/还原要几十秒到几分钟，
// 没有进度反馈时界面看起来像卡死，用户会重复点击造成重复封存。
import { id } from "./gitutil.js";
import type { JobView } from "../../shared/types.js";

export type JobResult = { ok: true; value: unknown } | { ok: false; error: string; remedy?: string };

interface Job {
  view: JobView;
  settle: Promise<void>;
}

const JOBS = new Map<string, Job>();
const KEEP_MS = 20 * 60 * 1000;   // 完成后保留 20 分钟，够页面刷新与失败重试读取
const MAX_KEEP = 40;

function prune() {
  if (JOBS.size <= MAX_KEEP) return;
  const finished = [...JOBS.values()].filter((j) => j.view.state !== "进行中");
  for (const j of finished) {
    if (Date.now() - new Date(j.view.endedAt ?? j.view.startedAt).getTime() > KEEP_MS) JOBS.delete(j.view.id);
  }
}

/**
 * 启动一个后台作业，立即返回作业 ID。
 * executor 抛出的异常折成 job.error + job.remedy，不冒泡到 HTTP 层。
 */
export function startJob(
  kind: JobView["kind"],
  executor: (report: (stage: string, pct: number, message: string) => void) => Promise<unknown>,
  remedy?: (error: string) => string | undefined,
): string {
  prune();
  const jobId = id("job");
  const view: JobView = {
    id: jobId, kind, state: "进行中", stage: "排队", pct: 0,
    message: "任务已受理", startedAt: new Date().toISOString(),
  };
  const report = (stage: string, pct: number, message: string) => {
    view.stage = stage;
    view.pct = Math.max(0, Math.min(99, Math.round(pct)));
    view.message = message;
  };
  const settle = (async () => {
    try {
      const value = await executor(report);
      view.state = "完成";
      view.pct = 100;
      view.stage = "完成";
      view.message = "任务完成";
      view.result = value;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      view.state = "失败";
      view.error = msg;
      view.message = msg;
      view.remedy = remedy?.(msg);
    } finally {
      view.endedAt = new Date().toISOString();
    }
  })();
  JOBS.set(jobId, { view, settle });
  return jobId;
}

export function getJob(jobId: string): JobView | undefined {
  return JOBS.get(jobId)?.view;
}

/** 测试与优雅关闭用：等所有在跑的作业结束 */
export async function drainJobs(): Promise<void> {
  await Promise.all([...JOBS.values()].map((j) => j.settle));
}
