// Workflow Module：编排 捕获→(可选)验证→封装→(封存)；发布与恢复单独入口
import { ProjectConfig } from "../../shared/types.js";
import { capture, Snapshot } from "./capture.js";
import { runChecks } from "./verify.js";
import { seal } from "./package.js";
import { validateState, renderEntryMarkdown } from "./protocol.js";
import { id, isGitRepo, caseCollisions } from "./gitutil.js";
import { recoveryRequirements } from "./preview.js";
import { storeDir, saveHandoffRecord } from "./store.js";
import type { HandoffRecord, VerificationRecord, ProjectState } from "../../shared/types.js";

export interface CreateHandoffInput {
  taskName: string;
  claimText?: string;
  claimEvidence?: string;
  nextStep?: string;
  runChecks?: boolean;
  parentHandoffIds?: string[];
  /** 打包前审阅清单时用户没确认过的阻塞项（如大小写碰撞）在此拦住 */
  onProgress?: (stage: string, pct: number, message: string) => void;
}

export interface CreateHandoffResult {
  record: HandoffRecord;
  snapshot: { id: string; digest: string; files: number; bytes: number };
  verifications: VerificationRecord[];
  warnings: string[];
}

export async function createHandoff(cfg: ProjectConfig, input: CreateHandoffInput): Promise<CreateHandoffResult> {
  if (!(await isGitRepo(cfg.path))) {
    throw new Error(`目录不是 Git 仓库: ${cfg.path}（请先在总览页重新注册，或在本机 git init 后再来）`);
  }
  const warnings: string[] = [];
  const onProgress = input.onProgress;
  onProgress?.("捕获快照", 10, "正在扫描工作区");
  const snap: Snapshot = await capture(cfg.projectId, cfg.path, onProgress);

  // 只在大小写不敏感的本机文件系统上拦：Linux 接收端能容纳，但同一份包在 Windows 上还原会静默覆盖
  const collisions = caseCollisions(snap.files.map((f) => f.path));
  if (collisions.length) {
    throw new Error(`纳入范围里有仅大小写不同的路径（${collisions[0].join(" / ")}），Windows/macOS 恢复时其中一个会被静默覆盖 —— 请先在源仓库改名再创建交接`);
  }

  let verifications: VerificationRecord[] = [];
  if (input.runChecks && cfg.checks.length > 0) {
    onProgress?.("执行检查", 55, `正在执行 ${cfg.checks.length} 条已配置检查（失败也会如实封存）`);
    const { records } = await runChecks(cfg.path, snap, cfg.checks, (i, total, name) =>
      onProgress?.("执行检查", 55 + Math.round((i / total) * 15), `检查 ${i + 1}/${total}：${name}`));
    verifications = records;
  } else if (input.runChecks && cfg.checks.length === 0) {
    warnings.push("项目未配置检查命令，验证状态保持为未执行；可在项目设置里添加后重试");
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
    recoveryRequirements: recoveryRequirements(snap.excluded),
    capabilities: ["git"],
  };

  const errs = validateState(state);
  if (errs.length) throw new Error("状态校验失败: " + errs.join("; "));

  onProgress?.("封装封存", 78, "正在写出包内材料与清单");
  const record = await seal(
    state,
    snap.files.map((f) => ({ path: f.path, workContent: f.workContent, indexContent: f.indexContent, mode: f.mode })),
    storeDir(cfg.path),
    cfg.path,
    onProgress,
  );
  await saveHandoffRecord(cfg.path, record);
  onProgress?.("完成", 99, "交接已封存");
  return {
    record,
    snapshot: {
      id: snap.snapshotId, digest: snap.digest, files: snap.files.length,
      bytes: snap.files.reduce((s, f) => s + f.bytes, 0),
    },
    verifications,
    warnings,
  };
}

export { renderEntryMarkdown };
