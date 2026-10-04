// 恢复流程：REST 路由（POST /api/resume/preview、POST /api/resume）与 Agent 工具
// （acb.resume_preview / acb.resume_restore）共用这一份"来源解析 + 执行 + 落报告"。
//
// 为什么必须共用：预览说"会写 12 个文件"而恢复实际写了 11 个，是因为两条路径各自认了一次源
// （不同的 mode 判定、不同的 remote 兜底）。这一类"同一个事实两个算法"的分叉在这台机器上
// 曾经让恢复静默丢掉中文名文件而回执全绿，别再开第二份。
import { findProject, loadHandoffRecords, getHandoffRecord, saveResumeReport } from "./store.js";
import { resumeFromArchive, resumeFromGithub, previewArchiveResume, previewGithubResume } from "./resume.js";
import { resolveProjectDir } from "./gitutil.js";
import { assertNoControl, assertSafeGitRemote, assertSafeHandoffId } from "./remote-policy.js";
import type { ConflictPolicy, ResumePreview, ResumeReport, ProjectState } from "../../shared/types.js";

export interface ResumeRequest {
  mode: "file" | "remote" | "github";
  filePath?: string;
  projectId?: string;
  remote?: string;
  handoffId?: string;
  targetDir: string;
  onConflict?: ConflictPolicy;
  archiveSha256?: string;
}

export interface ResolvedSource {
  input: {
    filePath?: string;
    packageDir?: string;
    handoffId?: string;
    targetDir: string;
    source: string;
    archiveSha256?: string;
    onConflict?: ConflictPolicy;
  };
  github?: { remote: string; handoffId: string };
}

/** 解析恢复来源：本机封存目录 / 交接文件 / 远端分支，三处共用一段，避免"预览"和"恢复"认不同的源 */
export async function resolveResumeSource(b: ResumeRequest): Promise<ResolvedSource> {
  if (!b.targetDir?.trim()) throw new Error("缺少目标目录：写一个空的目录路径（推荐新目录，ACB 默认不覆盖已有工作）");
  const targetDir = resolveProjectDir(assertNoControl(b.targetDir.trim(), "targetDir"));
  if (b.mode === "file") {
    if (!b.filePath?.trim()) throw new Error("需要交接文件路径：点「选择文件」，或把 .acb.tar.gz 直接拖进本页");
    const fp = assertNoControl(b.filePath.trim(), "filePath");
    return { input: { filePath: fp, handoffId: b.handoffId, targetDir, source: fp, archiveSha256: b.archiveSha256, onConflict: b.onConflict } };
  }
  if (b.mode === "github") {
    const p = b.projectId ? await findProject(b.projectId) : undefined;
    const rawRemote = b.remote?.trim() || p?.githubRemote;
    if (!rawRemote) throw new Error("未配置 GitHub 远端：在「项目设置」填已存在的仓库地址，或在本页直接输入远端 URL");
    // 预览与恢复都走 git ls-remote/fetch，所以远端值在拼 argv 之前判死（见 remote-policy.ts）
    const r = assertSafeGitRemote(rawRemote, "remote");
    if (!b.handoffId?.trim()) throw new Error("远端恢复需要交接 ID：点「查看该仓库的交接」从远端选一个");
    return {
      input: { targetDir, handoffId: b.handoffId, source: `${r} · acb/handoff/${b.handoffId}`, onConflict: b.onConflict },
      github: { remote: r, handoffId: b.handoffId.trim() },
    };
  }
  if (!b.projectId) throw new Error("本机封存恢复需要选择项目");
  const p = await findProject(b.projectId);
  if (!p) throw new Error(`项目未注册：${b.projectId}（在总览页重新注册该项目目录）`);
  const hid = b.handoffId?.trim() || (await loadHandoffRecords(p.path))[0]?.handoffId;
  if (!hid) throw new Error("本机封存存储里没有交接：跨电脑请用「本地交接文件」或「GitHub 交接分支」；先在这台电脑创建一次交接才会有封存记录");
  // handoffId 会被拼进 <project>/.acb/store/handoffs/<id>/record.json —— 先按 ID 形态判死，
  // 否则 ?handoffId=../../.. 就是拿着本机服务的钥匙去读注册表外面的文件
  const safeHid = assertSafeHandoffId(hid);
  const rec = await getHandoffRecord(p.path, safeHid);
  if (!rec) throw new Error(`本机封存存储里没有该交接 ${safeHid}：跨电脑请用交接文件或 GitHub 交接分支恢复`);
  return { input: { packageDir: rec.packageDir, handoffId: safeHid, targetDir, source: `本机存储 · ${p.name}/${safeHid}`, onConflict: b.onConflict } };
}

/** GitHub 分支预览的返回形状（界面与工具读的是同一个对象，不再各拼一份） */
export interface ResumePreviewResult {
  preview: ResumePreview | null;
  github?: { reachable: boolean; state?: ProjectState; detail: string };
}

/** 还原前的差异预览：整包校验 + 与目标目录比对，不写任何用户目录 */
export async function previewResume(b: ResumeRequest): Promise<ResumePreviewResult> {
  const { input, github } = await resolveResumeSource(b);
  if (github) {
    const pre = await previewGithubResume({ ...github, targetDir: input.targetDir });
    const s = pre.state;
    return {
      github: pre,
      preview: s ? {
        handoffId: s.handoffId, projectName: s.projectName, taskName: s.taskName, sealedAt: s.createdAt,
        source: input.source, targetDir: input.targetDir, integrityOk: true,
        entryCount: s.changes.length, verifiedCount: s.changes.length, broken: [],
        packageDigest: "远端分支（无本地清单）", protocolVersion: s.protocolVersion,
        totalBytes: 0, willWrite: s.changes.filter((c) => c.status !== "deleted").length,
        willDelete: s.changes.filter((c) => c.status === "deleted" || c.status === "renamed").length,
        stagedCount: s.changes.filter((c) => c.staged).length,
        symlinkCount: s.changes.filter((c) => c.mode === "120000").length,
        baselineAvailable: true, conflicts: [],
        alerts: pre.reachable
          ? [{ level: "提示" as const, title: "远端分支恢复按检查点树物化", detail: "GitHub 路径的冲突判定在恢复时执行（需要先 fetch 才能比对内容）。", action: "选一个空目录最稳；非空目录会先拒绝，再让你选「跳过已存在」或「覆盖」。" }]
          : [{ level: "阻塞" as const, title: "远端分支不可达", detail: pre.detail, action: "确认远端地址与交接 ID，或先在源电脑完成发布。" }],
        sourceEnv: { os: s.environment.os, runtime: s.environment.runtime },
        archiveInfo: `远端 · ${pre.detail}`,
      } : null,
    };
  }
  return { preview: await previewArchiveResume({ ...input, source: input.source }) };
}

/** 真正动手恢复并落 Resume Report（报告是恢复的一部分，不是调用方的作业） */
export async function performResume(b: ResumeRequest, onProgress?: (stage: string, pct: number, message: string) => void): Promise<{ report: ResumeReport; taskName: string }> {
  const { input, github } = await resolveResumeSource(b);
  const r = github
    ? await resumeFromGithub({ ...github, targetDir: input.targetDir, onConflict: input.onConflict, ...(onProgress ? { onProgress } : {}) })
    : await resumeFromArchive({ ...input, ...(onProgress ? { onProgress } : {}) });
  await saveResumeReport(r.report);
  return { report: r.report, taskName: r.state.taskName };
}
