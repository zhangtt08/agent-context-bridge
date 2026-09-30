// Workflow Module：编排 捕获→(可选)验证→封装→(封存)；发布与恢复单独入口
import { ProjectConfig } from "../../shared/types.js";
import { capture, Snapshot } from "./capture.js";
import { runChecks } from "./verify.js";
import { seal } from "./package.js";
import { validateState, renderEntryMarkdown } from "./protocol.js";
import { id, isGitRepo } from "./gitutil.js";
import { storeDir, saveHandoffRecord } from "./store.js";
import type { HandoffRecord, VerificationRecord, ProjectState } from "../../shared/types.js";

export interface CreateHandoffInput {
  taskName: string;
  claimText?: string;
  claimEvidence?: string;
  nextStep?: string;
  runChecks?: boolean;
  parentHandoffIds?: string[];
}

export interface CreateHandoffResult {
  record: HandoffRecord;
  snapshot: { id: string; digest: string; files: number };
  verifications: VerificationRecord[];
  warnings: string[];
}

export async function createHandoff(cfg: ProjectConfig, input: CreateHandoffInput): Promise<CreateHandoffResult> {
  if (!(await isGitRepo(cfg.path))) {
    throw new Error(`目录不是 Git 仓库: ${cfg.path}`);
  }
  const warnings: string[] = [];
  const snap: Snapshot = await capture(cfg.projectId, cfg.path);

  let verifications: VerificationRecord[] = [];
  if (input.runChecks && cfg.checks.length > 0) {
    const { records } = await runChecks(cfg.path, snap, cfg.checks);
    verifications = records;
  } else if (input.runChecks && cfg.checks.length === 0) {
    warnings.push("项目未配置检查命令，验证状态保持为未执行");
  }

  const taskId = "tsk_" + Buffer.from(input.taskName).toString("hex").slice(0, 8);
  const state: ProjectState = {
    protocolVersion: "0.1",
    projectId: cfg.projectId,
    projectName: cfg.name,
    taskId,
    taskName: input.taskName,
    sessionId: "sess_" + id("s").split("_")[1],
    snapshotId: snap.snapshotId,
    sourceDigest: snap.digest,
    handoffId: id("hnd"),
    parentHandoffIds: input.parentHandoffIds ?? [],
    createdAt: new Date().toISOString(),
    toolVersion: "acb 0.1.0",
    baseline: snap.baseline,
    changes: snap.files.map((f) => ({
      path: f.path, status: f.status, staged: f.indexContent !== null,
      oldPath: f.oldPath, mode: f.mode,
    })),
    untrackedIncluded: snap.files.filter((f) => f.status === "added").map((f) => f.path),
    excluded: snap.excluded,
    environment: { os: `${process.platform}`, runtime: `node ${process.version}`, git: ">=2.20" },
    observations: snap.observations,
    verifications,
    claims: input.claimText
      ? [{ sessionId: "sess_web", at: new Date().toISOString(), text: input.claimText, nextStep: input.nextStep, evidence: input.claimEvidence }]
      : input.nextStep
        ? [{ sessionId: "sess_web", at: new Date().toISOString(), text: "（无工作声明）", nextStep: input.nextStep }]
        : [],
    recoveryRequirements: snap.excluded.filter((e) => /^\.env/i.test(e)).map((e) => `${e} 本机缺失，运行前需补齐`),
    capabilities: ["git"],
  };

  const errs = validateState(state);
  if (errs.length) throw new Error("状态校验失败: " + errs.join("; "));

  const record = await seal(
    state,
    snap.files.map((f) => ({ path: f.path, workContent: f.workContent, indexContent: f.indexContent })),
    storeDir(cfg.path),
    cfg.path,
  );
  await saveHandoffRecord(cfg.path, record);
  return {
    record,
    snapshot: { id: snap.snapshotId, digest: snap.digest, files: snap.files.length },
    verifications,
    warnings,
  };
}

export { renderEntryMarkdown };
