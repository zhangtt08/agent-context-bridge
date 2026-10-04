// Package Module：封装 / 校验 / 本地持久化 / 自包含归档
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { HandoffRecord, PackageManifest, ProjectState } from "../../shared/types.js";
import { sha256Buf, sha256File, ensureDir, sourceDigest, isSafeRelPath, exists } from "./gitutil.js";
import { renderEntryMarkdown } from "./protocol.js";

/** 封存到本地存储：<project>/.acb/store/handoffs/<id>/ */
export async function seal(
  s: ProjectState,
  snapFiles: { path: string; workContent: Buffer | null; indexContent: Buffer | null; mode: string }[],
  storeDir: string,
  projectPath?: string,
  onProgress?: (stage: string, pct: number, message: string) => void,
): Promise<HandoffRecord> {
  const pkgDir = path.join(storeDir, "handoffs", s.handoffId);
  await ensureDir(path.join(pkgDir, "acb-state"));
  await ensureDir(path.join(pkgDir, "payload", "work"));
  await ensureDir(path.join(pkgDir, "payload", "index"));

  // 1. Project State
  const stateJson = JSON.stringify(s, null, 2);
  await fs.writeFile(path.join(pkgDir, "acb-state", "project-state.json"), stateJson);

  // 2. 代码恢复材料
  const stateChanges = s.changes;
  onProgress?.("封存材料", 60, `写入 ${stateChanges.length} 项恢复材料`);
  for (const c of stateChanges) {
    const f = snapFiles.find((x) => x.path === c.path);
    if (!f) continue;
    if (f.workContent !== null) {
      const dest = path.join(pkgDir, "payload", "work", c.path);
      await ensureDir(path.dirname(dest));
      await fs.writeFile(dest, f.workContent);
      // 可执行位随材料一起落盘（POSIX 上 tar 会带走；Windows 上 chmod 近似无操作，模式仍存于清单与索引）
      if (c.mode === "100755") await fs.chmod(dest, 0o755).catch(() => {});
    } else {
      // 删除项：写删除标记
      await ensureDir(path.dirname(path.join(pkgDir, "payload", "work", c.path + ".acb-deleted")));
      await fs.writeFile(path.join(pkgDir, "payload", "work", c.path + ".acb-deleted"), "");
    }
    if (f.indexContent !== null) {
      const dest = path.join(pkgDir, "payload", "index", c.path);
      await ensureDir(path.dirname(dest));
      await fs.writeFile(dest, f.indexContent);
      if (c.mode === "100755") await fs.chmod(dest, 0o755).catch(() => {});
    }
    if (c.oldPath) {
      await ensureDir(path.dirname(path.join(pkgDir, "payload", "work", c.oldPath + ".acb-deleted")));
      await fs.writeFile(path.join(pkgDir, "payload", "work", c.oldPath + ".acb-deleted"), "");
    }
  }

  // 2.5 基线材料：git bundle 随包携带，接收端可重建 HEAD 历史
  if (s.baseline.commit && projectPath) {
    await ensureDir(path.join(pkgDir, "payload"));
    const bundle = path.join(pkgDir, "payload", "baseline.bundle");
    onProgress?.("打包基线历史", 70, "正在用 git bundle 打包完整历史（仓库越大越久）");
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["bundle", "create", bundle, "HEAD"], { cwd: projectPath, timeout: 30 * 60_000 }, (err, _out, stderr) => {
        void (async () => {
          const written = await exists(bundle);
          if (err && !written) {
            reject(new Error(`基线历史打包失败：${stderr || err.message}（改动材料已写好；重试仍失败时，可改用「发布到 GitHub 交接分支」路径，它不需要 bundle）`));
          } else resolve();
        })();
      });
    });
  }

  // 3. 包清单（摘要不含本清单自身 —— 避免自引用）
  onProgress?.("生成清单", 85, "正在逐文件计算 SHA-256 清单");
  const manifest = await buildManifest(pkgDir, s);
  await fs.writeFile(path.join(pkgDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // 4. Markdown 接手入口（由状态生成）
  const record: HandoffRecord = {
    handoffId: s.handoffId, projectId: s.projectId, sealedAt: s.createdAt,
    state: s, manifest, publications: [], packageDir: pkgDir,
  };
  await fs.writeFile(path.join(pkgDir, "HANDOFF.md"), renderEntryMarkdown(record));

  await fs.writeFile(path.join(pkgDir, "record.json"), JSON.stringify(record, null, 2));
  return record;
}

export async function buildManifest(pkgDir: string, s: ProjectState): Promise<PackageManifest> {
  const entries: PackageManifest["entries"] = [];
  async function add(full: string, entryPath: string) {
    const buf = await fs.readFile(full);
    entries.push({ path: entryPath.split(path.sep).join("/"), sha256: sha256Buf(buf), size: buf.length });
  }
  async function walk(base: string, prefix: string) {
    let items: string[] = [];
    try { items = await fs.readdir(base); } catch { return; }
    for (const it of items) {
      if (!prefix && it === "manifest.json") continue;
      const full = path.join(base, it);
      const st = await fs.lstat(full);
      if (st.isDirectory()) await walk(full, prefix + it + "/");
      else if (st.isFile()) await add(full, prefix + it);
    }
  }
  await walk(pkgDir, "");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = sourceDigest(entries.map((e) => ({ path: e.path, content: Buffer.from(e.sha256) })));
  const digest = "pkg_sha256:" + h.split("full:")[1];
  return {
    protocolVersion: "0.1", handoffId: s.handoffId, projectId: s.projectId,
    createdAt: s.createdAt, entries, packageDigest: digest,
    requiredCapabilities: ["git"],
  };
}

export interface IntegrityCheck {
  ok: boolean;
  broken: string[];
  /** 清单条目数 / 实际校验通过数：解开后核对文件数用的就是这两个 */
  entryCount: number;
  verifiedCount: number;
}

/** 校验包完整性：逐条目比对 sha256，并核对条目数 */
export async function verifyPackage(pkgDir: string): Promise<IntegrityCheck> {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(pkgDir, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, broken: ["manifest.json 缺失或损坏"], entryCount: 0, verifiedCount: 0 };
  }
  return checkEntries(pkgDir, manifest);
}

export async function checkEntries(pkgDir: string, manifest: PackageManifest): Promise<IntegrityCheck> {
  const broken: string[] = [];
  let verified = 0;
  for (const e of manifest.entries) {
    // 清单里的路径来自包内文件，先当不可信数据处理：拼进 pkgDir 之前必须过安全闸
    if (!isSafeRelPath(e.path)) { broken.push(`${e.path}（路径不安全）`); continue; }
    const full = path.join(pkgDir, e.path);
    try {
      const actual = await sha256File(full);
      if (actual !== e.sha256) broken.push(e.path);
      else verified++;
    } catch {
      broken.push(e.path);
    }
  }
  return { ok: broken.length === 0, broken, entryCount: manifest.entries.length, verifiedCount: verified };
}

export interface ArchiveInfo { path: string; sha256: string; bytes: number }

/**
 * 导出自包含交接文件（含恢复所需全部材料）。
 * 先写 .part 再原子改名，并在导出后重算 SHA-256 —— 半截文件不会顶着一个可用的名字。
 */
export async function exportArchive(rec: HandoffRecord, outPath: string): Promise<ArchiveInfo> {
  await ensureDir(path.dirname(outPath));
  const tmp = outPath + ".part";
  await fs.rm(tmp, { force: true }).catch(() => {});
  try {
    await tar.c(
      { gzip: true, file: tmp, cwd: path.dirname(rec.packageDir), portable: true },
      [path.basename(rec.packageDir)],
    );
    const info = await sha256File(tmp);
    const st = await fs.stat(tmp);
    await fs.rename(tmp, outPath);
    return { path: outPath, sha256: info, bytes: st.size };
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function loadRecord(pkgDir: string): Promise<HandoffRecord> {
  return JSON.parse(await fs.readFile(path.join(pkgDir, "record.json"), "utf8"));
}
