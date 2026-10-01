// Transport Module：Local Archive Adapter + GitHub Adapter（同一 Transport Interface）
// 发布语义：先完整生成、再暴露引用、再读取确认；重复发布幂等；不改源端分支/HEAD/暂存区/工作区。
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HandoffRecord, PublicationReceipt, ProjectState } from "../../shared/types.js";
import { git, exists } from "./gitutil.js";
import { exportArchive, verifyPackage } from "./package.js";

export interface PublishResult { receipt: PublicationReceipt }

const metaPrefix = ".acb-meta";

/** 本地自包含文件导出 */
export async function publishLocal(rec: HandoffRecord, outPath: string): Promise<PublishResult> {
  const archive = await exportArchive(rec, outPath);
  // 读取确认：包内条目逐条校验 + 条目数核对；同时记下归档自身的 SHA-256 供两台电脑比对
  const check = await verifyPackage(rec.packageDir);
  const receipt: PublicationReceipt = {
    target: "local",
    state: check.ok ? "已发布" : "失败",
    location: archive.path,
    readBackConfirmed: check.ok,
    attempts: 1,
    publishedAt: new Date().toISOString(),
    archiveSha256: archive.sha256,
    archiveBytes: archive.bytes,
    error: check.ok
      ? undefined
      : `包完整性校验未通过：${check.broken.slice(0, 5).join("、")}${check.broken.length > 5 ? " 等" : ""}（${check.verifiedCount}/${check.entryCount} 通过）—— 重新创建交接后再导出，勿手工修补包目录`,
  };
  return { receipt };
}

/**
 * GitHub Adapter：把代码检查点与交接元数据提交到专用交接分支 acb/handoff/<id>。
 * 使用 git commit-tree 创建一次性提交（固定作者/时间戳 → 幂等 SHA），仅 push 该 SHA，
 * 不移动任何本地分支；发布后 ls-remote + 取回确认。
 */
export async function publishGithub(projectPath: string, rec: HandoffRecord, remote: string): Promise<PublishResult> {
  const s: ProjectState = rec.state;
  const branch = `acb/handoff/${s.handoffId}`;
  const pkgDir = rec.packageDir;
  const metaPrefix = ".acb-meta";

  // 1. 先完整生成：用临时索引构建树（基线 + 纳入内容 + 元数据），不动源工作区/索引
  const tmpIndex = path.join(pkgDir, "..", `${s.handoffId}.index`);
  const env = { GIT_INDEX_FILE: tmpIndex };

  if (s.baseline.commit) {
    await git(["read-tree", s.baseline.commit], { cwd: projectPath, env });
  } else {
    await fs.writeFile(tmpIndex, "");
  }

  const updateIndex = async (...args: string[]) => git(["update-index", ...args], { cwd: projectPath, env });
  const hashFile = async (abs: string) => (await git(["hash-object", "-w", "--", abs], { cwd: projectPath })).trim();

  // 应用纳入范围：删除 / 重命名 / 修改 / 新增（内容来自封存材料，而非当前工作区）
  for (const c of s.changes) {
    if (c.status === "deleted" || c.status === "renamed") {
      const p = c.status === "renamed" ? c.oldPath! : c.path;
      await updateIndex("--force-remove", "--", p).catch(() => {});
    }
    if (c.status !== "deleted") {
      const abs = path.join(pkgDir, "payload", "work", c.path);
      if (await exists(abs)) {
        const blob = await hashFile(abs);
        await updateIndex("--add", "--cacheinfo", `100644,${blob},${c.path}`);
      }
    }
  }

  // 元数据目录（.acb-meta/）独立保留：状态、清单、接手入口、暂存恢复材料
  for (const f of ["acb-state/project-state.json", "manifest.json", "HANDOFF.md"]) {
    const blob = await hashFile(path.join(pkgDir, f));
    await updateIndex("--add", "--cacheinfo", `100644,${blob},${metaPrefix}/${f}`);
  }
  for (const c of s.changes) {
    if (!c.staged || c.status === "deleted") continue;
    const idxAbs = path.join(pkgDir, "payload", "index", c.path);
    if (!(await exists(idxAbs))) continue;
    const blob = await hashFile(idxAbs);
    await updateIndex("--add", "--cacheinfo", `100644,${blob},${metaPrefix}/payload-index/${c.path}`);
  }

  const tree = (await git(["write-tree"], { cwd: projectPath, env })).trim();

  // 固定时间戳与身份 → 相同内容产生相同 SHA（幂等）
  const ts = s.createdAt;
  const ident = { GIT_AUTHOR_NAME: "acb", GIT_AUTHOR_EMAIL: "acb@local", GIT_COMMITTER_NAME: "acb", GIT_COMMITTER_EMAIL: "acb@local" };
  const dateEnv = { GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts };
  const parentArgs = s.baseline.commit ? ["-p", s.baseline.commit] : [];
  const commitSha = (
    await git(["commit-tree", tree, ...parentArgs, "-m", `ACB handoff ${s.handoffId} (${s.taskName})`], {
      cwd: projectPath, env: { ...env, ...ident, ...dateEnv },
    })
  ).trim();

  // 清理临时索引
  await fs.rm(tmpIndex, { force: true }).catch(() => {});

  // 2. 暴露引用：仅推送该 SHA 到专用分支（网络抖动重试，退避递增）
  let attempts = 0, lastErr: string | undefined;
  let pushed = false;
  for (let i = 0; i < 3 && !pushed; i++) {
    attempts++;
    try {
      await git(["push", remote, `${commitSha}:refs/heads/${branch}`], { cwd: projectPath });
      pushed = true;
    } catch (e) {
      lastErr = (e as Error).message;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }

  // 3. 读取确认：远端可见 + 必需元数据真的取得回来（代码上传成功 ≠ 交接可用）
  let readBack = false;
  let readBackDetail = "";
  if (pushed) {
    try {
      const out = await git(["ls-remote", remote, `refs/heads/${branch}`], { cwd: projectPath });
      if (!out.includes(commitSha)) {
        readBackDetail = "远端引用里找不到这次推送的提交";
      } else {
        try {
          await git(["fetch", "-q", remote, `refs/heads/${branch}`], { cwd: projectPath });
          const meta = await git(["cat-file", "-p", `${commitSha}:${metaPrefix}/manifest.json`], { cwd: projectPath });
          readBack = JSON.parse(meta).handoffId === s.handoffId;
          readBackDetail = readBack ? "清单已从远端取回并核对" : "远端清单里的交接 ID 与本次不一致";
        } catch (e) {
          readBackDetail = `清单取回失败：${(e as Error).message}`;
        }
      }
    } catch (e) {
      readBackDetail = `远端查询失败：${(e as Error).message}`;
    }
  }

  const receipt: PublicationReceipt = {
    target: "github",
    state: pushed && readBack ? "已发布" : "失败",
    location: `${remote} · ${branch}`,
    commitSha,
    readBackConfirmed: readBack,
    attempts,
    publishedAt: new Date().toISOString(),
    error: pushed && readBack ? undefined : buildPushError(pushed, lastErr, readBackDetail, remote, branch),
  };
  return { receipt };
}

/** 失败回执要说清"卡在哪一步"与"下一步做什么"，否则用户只能对着 stderr 猜 */
function buildPushError(pushed: boolean, lastErr: string | undefined, readBackDetail: string, remote: string, branch: string): string {
  if (!pushed) {
    return `推送失败（3 次尝试）：${lastErr ?? "未知原因"}。出路：确认远端地址 ${remote} 已存在且本机 git 凭据可用（在终端 git ls-remote ${remote} 应能列出来）；网络受限就改用「导出本地文件」把交接包拷过去。`;
  }
  return `提交已推送但读取确认未通过：${readBackDetail || "未确认"}。分支 ${branch} 不要手工改动，直接再点一次「幂等重试发布」即可（同一内容会产生同一提交）。`;
}

/** 列出远端全部交接引用（分叉通过父关系识别，由上层处理） */
export async function listRemoteHandoffs(projectPath: string, remote: string): Promise<{ id: string; branch: string; sha: string }[]> {
  const out = await git(["ls-remote", "--heads", remote, "refs/heads/acb/handoff/*"], { cwd: projectPath });
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const [sha, ref] = line.split("\t");
    return { id: ref.replace("refs/heads/acb/handoff/", ""), branch: ref, sha };
  });
}

/** 从远端取回指定交接的元数据（不落到工作区，仅读对象） */
export async function fetchRemoteMeta(projectPath: string, remote: string, handoffId: string): Promise<{ state: ProjectState; commitSha: string } | null> {
  const branch = `acb/handoff/${handoffId}`;
  const out = await git(["ls-remote", remote, `refs/heads/${branch}`], { cwd: projectPath }).catch(() => "");
  if (!out.trim()) return null;
  const sha = out.split("\t")[0].trim();
  const metaJson = await git(["cat-file", "-p", `${sha}:${metaPrefix}/acb-state/project-state.json`], { cwd: projectPath }).catch(() => null);
  if (!metaJson) return null;
  return { state: JSON.parse(metaJson), commitSha: sha };
}

export { execFile };
