// 项目注册表写入：REST 路由（POST /api/projects、PUT /api/projects/:id/config）与
// Agent 工具（acb.project_register、acb.project_config_save）共用这一份判定。
//
// 为什么抽出来：注册与配置写入是这台机器上"哪些目录会被 ACB 接管、以后会执行哪些命令"的
// 唯一入口。两处各写一遍校验，就会出现"界面拦住的 Agent 没拦、Agent 拦的界面没拦"，
// 而 checks[].cmd 是要被执行的东西 —— 这种分叉直接决定第一号安全缺陷会不会回来。
import crypto from "node:crypto";
import path from "node:path";
import { addProject, findProject } from "./store.js";
import { exists, isGitRepo, isWorkTree, resolveProjectDir } from "./gitutil.js";
import { assertSafeGitRemote } from "./remote-policy.js";
import type { ProjectConfig } from "../../shared/types.js";

/** 一条已配置检查的形态判定：cmd 是要被 exec 的，所以只接受结构完整、长度受限的条目 */
export function assertCheckShape(c: unknown, i: number): { name: string; cmd: string; timeoutMs?: number } {
  const e = c as { name?: unknown; cmd?: unknown; timeoutMs?: unknown };
  if (!e || typeof e !== "object") throw new Error(`checks[${i}] 必须是对象 {{name,cmd,timeoutMs?}}`);
  if (typeof e.name !== "string" || !e.name.trim()) throw new Error(`checks[${i}] 缺少非空 name`);
  if (typeof e.cmd !== "string" || !e.cmd.trim()) throw new Error(`checks[${i}] 缺少非空 cmd`);
  if (e.name.length > 200) throw new Error(`checks[${i}] 的 name 超过 200 个字符`);
  if (e.cmd.length > 2000) throw new Error(`checks[${i}] 的 cmd 超过 2000 个字符`);
  const out: { name: string; cmd: string; timeoutMs?: number } = { name: e.name.trim(), cmd: e.cmd };
  if (e.timeoutMs !== undefined) {
    if (typeof e.timeoutMs !== "number" || !Number.isFinite(e.timeoutMs) || e.timeoutMs <= 0 || e.timeoutMs > 600_000) {
      throw new Error(`checks[${i}] 的 timeoutMs 必须是 1–600000 之间的毫秒数`);
    }
    out.timeoutMs = e.timeoutMs;
  }
  return out;
}

/**
 * 注册（或重新注册）一个项目目录。
 * 返回的 alreadyRegistered 说明这是更新已有条目还是新增 —— 调用方据此决定要不要提示用户。
 */
export async function registerProjectDir(
  raw: string,
  name?: string,
): Promise<{ config: ProjectConfig; alreadyRegistered: boolean }> {
  const dir = resolveProjectDir(raw);
  if (!(await exists(dir))) throw new Error(`目录不存在: ${dir}`);
  if (!(await isWorkTree(dir))) {
    if (await isGitRepo(dir)) throw new Error("这是 Git 裸仓库或 .git 目录，没有可交接的工作区文件；请选择包含代码的项目根目录");
    throw new Error("目录不是 Git 仓库（请先 git init 或选择已有仓库）");
  }
  const existing = await findProject(dir);
  const config: ProjectConfig = existing ?? {
    projectId: "prj_" + crypto.randomBytes(4).toString("hex"),
    name: name ?? path.basename(dir),
    path: dir,
    checks: [],
  };
  if (name) config.name = name;
  await addProject(config);
  return { config, alreadyRegistered: Boolean(existing) };
}

export interface ConfigPatch {
  name?: string;
  githubRemote?: string;
  checks?: unknown[];
}

/**
 * 写项目配置。三条边界：
 *  1. 只接受 name / githubRemote / checks 三个字段，其余忽略（不给隐式写入留口子）；
 *  2. githubRemote 过远端白名单 —— 它会进 git argv（见 remote-policy.ts）；
 *  3. checks[].cmd 是"以后会被执行的内容"，只按形态收，不在这里执行任何东西。
 */
export async function saveProjectConfig(
  projectIdOrPath: string,
  patch: ConfigPatch,
): Promise<ProjectConfig> {
  const p = await findProject(projectIdOrPath);
  if (!p) throw new ProjectNotRegistered(`项目未注册：${projectIdOrPath}`);
  if (patch.name) p.name = patch.name;
  if (patch.githubRemote !== undefined) {
    p.githubRemote = patch.githubRemote === "" ? undefined : assertSafeGitRemote(patch.githubRemote, "githubRemote");
  }
  if (patch.checks) {
    if (!Array.isArray(patch.checks)) throw new Error("checks 必须是数组：[{name,cmd,timeoutMs?}]");
    if (patch.checks.length > 50) throw new Error("checks 最多 50 条");
    p.checks = patch.checks.map((c, i) => assertCheckShape(c, i));
  }
  await addProject(p);
  return p;
}

/** 未注册是 404/not_found，用类型区分而不是靠中文串匹配 */
export class ProjectNotRegistered extends Error {}
