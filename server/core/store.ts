// 本地存储：项目注册表 + 交接存储（<project>/.acb/store）
// ACB_HOME 可重定向注册表/报告位置（e2e 隔离用），默认 ~/.acb
//
// 这一层的两条规矩（2026-10-05 验收判为 MAJOR，本轮定死）：
//  1. **写必须原子**：写临时文件 → fsync → rename。之前是裸 fs.writeFile，
//     进程在半途被打断（断电、任务管理器杀掉、ACB.exe 被强行关闭）就会留下半截 JSON，
//     而下一句 JSON.parse 抛出去 —— 一个坏文件让所有请求全红。
//     rename 是目录项级替换：旧内容要么完整保留、要么完整换成新的，不存在"被截断成空文件"。
//  2. **读不许把异常抛给请求**：文件读不出来或解析失败时，报告是哪一条路径、坏在哪，
//     回落到"空但可见"的结构，并把这条警告登记进 notices —— API 响应里点名，
//     而不是静默当成"你还没有项目"（静默回落等于把数据损坏伪装成空库）。
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ProjectConfig, HandoffRecord, ResumeReport } from "../../shared/types.js";
import { ensureDir, exists } from "./gitutil.js";

function acbHome(): string {
  return process.env.ACB_HOME || os.homedir();
}

const REGISTRY = () => path.join(acbHome(), ".acb", "projects.json");
const REPORTS = () => path.join(acbHome(), ".acb", "resume-reports.json");

/** 一条存储警告：坏在哪个文件、为什么坏、什么时候读到的 */
export interface StorageNotice {
  file: string;
  reason: string;
  /** corrupt = JSON 解析不了；shape = 解析出来了但形状不对；write_failed = 写盘失败 */
  kind: "corrupt" | "shape" | "write_failed";
  at: string;
}

let notices: StorageNotice[] = [];
const NOTICE_CAP = 20;

function pushNotice(n: StorageNotice): void {
  notices = [n, ...notices].slice(0, NOTICE_CAP);
  // 同一件事也要落 stderr：界面没打开时（CLI、服务日志）还得看得见
  console.warn(`[acb] 存储警告(${n.kind}) ${n.file}：${n.reason}`);
}

/** 当前存储警告（副本，调用方改不动内部状态） */
export function storageNotices(): StorageNotice[] {
  return notices.map((n) => ({ ...n }));
}

/** 人读一句：给 API 响应与 CLI 用 */
export function storageNoticeLines(): string[] {
  return notices.map((n) => `${n.at} ${n.kind === "write_failed" ? "写入失败" : n.kind === "shape" ? "形状不对" : "内容损坏"}：${n.file} —— ${n.reason}`);
}

export function clearStorageNotices(): void {
  notices = [];
}

/** 测试与"修好了就该消失"的判据用：把某个文件的警告摘掉 */
export function forgetStorageNoticesFor(file: string): void {
  notices = notices.filter((n) => n.file !== file);
}

/**
 * 原子写 JSON：tmp → fsync → rename（→ 尽力 fsync 目录）。
 * Windows 上 rename 目标被别的进程打开时会 EPERM/EBUSY，重试几次再报——
 * 报出来也必须说清是哪个文件，否则用户只会看到一句 Operation not permitted。
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const payload = JSON.stringify(value, null, 2);
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(tmp, "w");
    await fh.writeFile(payload, "utf8");
    await fh.sync();               // 数据先落盘，再让名字指向它
    await fh.close();
    fh = null;
    let lastErr: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        await fs.rename(tmp, file);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
        await new Promise((r) => setTimeout(r, 60 * (i + 1)));
      }
    }
    if (lastErr) throw lastErr;
    // 目录项也尽力同步（POSIX 上有意义；Windows 上会失败，忽略即可）
    try {
      const dh = await fs.open(dir, "r");
      try { await dh.sync(); } catch { /* Windows: EINVAL/EBADF，数据文件已经 sync 过 */ }
      await dh.close();
    } catch { /* 目录打不开不影响本次写入 */ }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    pushNotice({ file, kind: "write_failed", reason: `写入失败：${msg}（旧内容保持不变，本次改动没有落盘）`, at: new Date().toISOString() });
    throw new Error(`写入 ${file} 失败：${msg}。出路：确认该文件没被别的程序独占打开（编辑器/杀毒/另一份 ACB），目录所在磁盘没满；原文件内容未被破坏。`);
  }
}

/**
 * 读 JSON 并核对形状：坏数据 → 警告 + 回落到 fallback，绝不把异常抛进请求。
 * expect 是判据："array" 时 `{}` 也算坏（否则调用方的 .filter/.map 会炸在请求里）。
 */
export async function readJsonSafe<T>(file: string, expect: "array" | "object" = "object"): Promise<{ value: T | null; notice?: StorageNotice }> {
  if (!(await exists(file))) return { value: null };
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    const notice: StorageNotice = { file, kind: "corrupt", reason: `读不出来：${e instanceof Error ? e.message : String(e)}`, at: new Date().toISOString() };
    pushNotice(notice);
    return { value: null, notice };
  }
  if (!raw.trim()) {
    const notice: StorageNotice = { file, kind: "corrupt", reason: "文件是空的（上一次写入被中断留下的空壳）", at: new Date().toISOString() };
    pushNotice(notice);
    return { value: null, notice };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const notice: StorageNotice = {
      file,
      kind: "corrupt",
      reason: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}（按空清单继续服务，原文件一个字节都没动，可以手工修）`,
      at: new Date().toISOString(),
    };
    pushNotice(notice);
    return { value: null, notice };
  }
  const shapeOk = expect === "array" ? Array.isArray(parsed) : typeof parsed === "object" && parsed !== null;
  if (!shapeOk) {
    const notice: StorageNotice = {
      file,
      kind: "shape",
      reason: `内容能解析但不是${expect === "array" ? "数组" : "对象"}（收到 ${Array.isArray(parsed) ? "array" : typeof parsed}），按空清单继续服务`,
      at: new Date().toISOString(),
    };
    pushNotice(notice);
    return { value: null, notice };
  }
  forgetStorageNoticesFor(file);   // 同一进程里读成功过就不再重复报
  return { value: parsed as T };
}

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

/** 注册表路径（警告要说得出文件名，CLI 与界面都靠它指路） */
export function registryPath(): string {
  return REGISTRY();
}
export function reportsPath(): string {
  return REPORTS();
}

export async function listProjects(): Promise<ProjectConfig[]> {
  const { value } = await readJsonSafe<ProjectConfig[]>(REGISTRY(), "array");
  return value ?? [];
}

/** 注册表 + 本次读取是否带警告（API 层用它把"为什么看到的是空的"说清楚） */
export async function listProjectsWithNotices(): Promise<{ projects: ProjectConfig[]; notices: StorageNotice[] }> {
  const before = notices.length;
  const projects = await listProjects();
  return { projects, notices: notices.slice(0, Math.max(0, notices.length - before)) };
}

export async function saveProjects(list: ProjectConfig[]): Promise<void> {
  await writeJsonAtomic(REGISTRY(), list);
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
    if (!(await exists(f))) continue;
    const { value } = await readJsonSafe<HandoffRecord>(f, "object");
    if (value) out.push(value);
  }
  return out.sort((a, b) => (a.sealedAt < b.sealedAt ? 1 : -1));
}

export async function saveHandoffRecord(projectPath: string, rec: HandoffRecord): Promise<void> {
  const f = path.join(storeDir(projectPath), "handoffs", rec.handoffId, "record.json");
  await writeJsonAtomic(f, rec);
}

export async function getHandoffRecord(projectPath: string, handoffId: string): Promise<HandoffRecord | undefined> {
  const f = path.join(storeDir(projectPath), "handoffs", handoffId, "record.json");
  const { value } = await readJsonSafe<HandoffRecord>(f, "object");
  return value ?? undefined;
}

export async function saveResumeReport(r: ResumeReport): Promise<void> {
  const list = await loadResumeReports();
  list.unshift(r);
  await writeJsonAtomic(REPORTS(), list.slice(0, 50));
}

export async function loadResumeReports(): Promise<ResumeReport[]> {
  const { value } = await readJsonSafe<ResumeReport[]>(REPORTS(), "array");
  return value ?? [];
}
