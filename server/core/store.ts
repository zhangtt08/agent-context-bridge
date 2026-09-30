// 本地存储：项目注册表 + 交接存储（<project>/.acb/store）
// ACB_HOME 可重定向注册表/报告位置（e2e 隔离用），默认 ~/.acb
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectConfig, HandoffRecord, ResumeReport } from "../../shared/types.js";
import { ensureDir, exists } from "./gitutil.js";

function acbHome(): string {
  return process.env.ACB_HOME || os.homedir();
}

const REGISTRY = () => path.join(acbHome(), ".acb", "projects.json");
const REPORTS = () => path.join(acbHome(), ".acb", "resume-reports.json");

// 同一目录的不同拼写（8.3 短名、大小写、正反斜杠）视为同一路径，避免注册表重复
async function sameDir(a: string, b: string): Promise<boolean> {
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b));
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export function storeDir(projectPath: string): string {
  return path.join(projectPath, ".acb", "store");
}

export async function listProjects(): Promise<ProjectConfig[]> {
  if (!(await exists(REGISTRY()))) return [];
  return JSON.parse(await fs.readFile(REGISTRY(), "utf8"));
}

export async function saveProjects(list: ProjectConfig[]): Promise<void> {
  await ensureDir(path.dirname(REGISTRY()));
  await fs.writeFile(REGISTRY(), JSON.stringify(list, null, 2));
}

export async function addProject(cfg: ProjectConfig): Promise<void> {
  const list = await listProjects();
  let i = -1;
  for (let k = 0; k < list.length; k++) {
    if (list[k].projectId === cfg.projectId || (await sameDir(list[k].path, cfg.path))) { i = k; break; }
  }
  if (i >= 0) list[i] = cfg; else list.push(cfg);
  await saveProjects(list);
}

export async function findProject(projectIdOrPath: string): Promise<ProjectConfig | undefined> {
  const list = await listProjects();
  for (const p of list) {
    if (p.projectId === projectIdOrPath || (await sameDir(p.path, projectIdOrPath))) return p;
  }
  return undefined;
}

export async function removeProject(projectId: string): Promise<void> {
  await saveProjects((await listProjects()).filter((p) => p.projectId !== projectId));
}

export async function loadHandoffRecords(projectPath: string): Promise<HandoffRecord[]> {
  const dir = path.join(storeDir(projectPath), "handoffs");
  if (!(await exists(dir))) return [];
  const out: HandoffRecord[] = [];
  for (const h of await fs.readdir(dir)) {
    const f = path.join(dir, h, "record.json");
    if (await exists(f)) out.push(JSON.parse(await fs.readFile(f, "utf8")));
  }
  return out.sort((a, b) => (a.sealedAt < b.sealedAt ? 1 : -1));
}

export async function saveHandoffRecord(projectPath: string, rec: HandoffRecord): Promise<void> {
  const f = path.join(storeDir(projectPath), "handoffs", rec.handoffId, "record.json");
  await ensureDir(path.dirname(f));
  await fs.writeFile(f, JSON.stringify(rec, null, 2));
}

export async function getHandoffRecord(projectPath: string, handoffId: string): Promise<HandoffRecord | undefined> {
  const f = path.join(storeDir(projectPath), "handoffs", handoffId, "record.json");
  if (!(await exists(f))) return undefined;
  return JSON.parse(await fs.readFile(f, "utf8"));
}

export async function saveResumeReport(r: ResumeReport): Promise<void> {
  await ensureDir(path.dirname(REPORTS()));
  const list = await loadResumeReports();
  list.unshift(r);
  await fs.writeFile(REPORTS(), JSON.stringify(list.slice(0, 50), null, 2));
}

export async function loadResumeReports(): Promise<ResumeReport[]> {
  if (!(await exists(REPORTS()))) return [];
  return JSON.parse(await fs.readFile(REPORTS(), "utf8"));
}
