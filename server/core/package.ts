// Package Module：封装 / 校验 / 本地持久化 / 自包含归档
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { HandoffRecord, PackageManifest, ProjectState } from "../../shared/types.js";
import { sha256Buf, sha256File, ensureDir, sourceDigest } from "./gitutil.js";
import { renderEntryMarkdown } from "./protocol.js";

/** 封存到本地存储：<project>/.acb/store/handoffs/<id>/ */
export async function seal(s: ProjectState, snapFiles: { path: string; workContent: Buffer | null; indexContent: Buffer | null }[], storeDir: string, projectPath?: string): Promise<HandoffRecord> {
  const pkgDir = path.join(storeDir, "handoffs", s.handoffId);
  await ensureDir(path.join(pkgDir, "acb-state"));
  await ensureDir(path.join(pkgDir, "payload", "work"));
  await ensureDir(path.join(pkgDir, "payload", "index"));

  // 1. Project State
  const stateJson = JSON.stringify(s, null, 2);
  await fs.writeFile(path.join(pkgDir, "acb-state", "project-state.json"), stateJson);

  // 2. 代码恢复材料
  const stateChanges = s.changes;
  for (const c of stateChanges) {
    const f = snapFiles.find((x) => x.path === c.path);
    if (!f) continue;
    if (f.workContent !== null) {
      await ensureDir(path.dirname(path.join(pkgDir, "payload", "work", c.path)));
      await fs.writeFile(path.join(pkgDir, "payload", "work", c.path), f.workContent);
    } else {
      // 删除项：写删除标记
      await ensureDir(path.dirname(path.join(pkgDir, "payload", "work", c.path + ".acb-deleted")));
      await fs.writeFile(path.join(pkgDir, "payload", "work", c.path + ".acb-deleted"), "");
    }
    if (f.indexContent !== null) {
      await ensureDir(path.dirname(path.join(pkgDir, "payload", "index", c.path)));
      await fs.writeFile(path.join(pkgDir, "payload", "index", c.path), f.indexContent);
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
    await new Promise<void>((resolve) => {
      execFile("git", ["bundle", "create", bundle, "HEAD"], { cwd: projectPath }, () => resolve());
    });
  }

  // 3. 包清单（摘要不含本清单自身 —— 避免自引用）
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
      const full = path.join(base, it);
      const st = await fs.stat(full);
      if (st.isDirectory()) await walk(full, prefix + it + "/");
      else await add(full, prefix + it);
    }
  }
  await walk(pkgDir, "");
  const h = sourceDigest(entries.map((e) => ({ path: e.path, content: Buffer.from(e.sha256) })));
  const digest = "pkg_sha256:" + h.split("full:")[1];
  return {
    protocolVersion: "0.1", handoffId: s.handoffId, projectId: s.projectId,
    createdAt: s.createdAt, entries, packageDigest: digest,
    requiredCapabilities: ["git"],
  };
}

/** 校验包完整性：逐条目比对 sha256 */
export async function verifyPackage(pkgDir: string): Promise<{ ok: boolean; broken: string[] }> {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(pkgDir, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, broken: ["manifest.json 缺失或损坏"] };
  }
  const broken: string[] = [];
  for (const e of manifest.entries) {
    const full = path.join(pkgDir, e.path);
    try {
      const actual = await sha256File(full);
      if (actual !== e.sha256) broken.push(e.path);
    } catch {
      broken.push(e.path);
    }
  }
  return { ok: broken.length === 0, broken };
}

/** 导出自包含交接文件（含恢复所需全部材料） */
export async function exportArchive(rec: HandoffRecord, outPath: string): Promise<string> {
  await ensureDir(path.dirname(outPath));
  await tar.c(
    { gzip: true, file: outPath, cwd: path.dirname(rec.packageDir), portable: true },
    [path.basename(rec.packageDir)],
  );
  return outPath;
}

export async function loadRecord(pkgDir: string): Promise<HandoffRecord> {
  return JSON.parse(await fs.readFile(path.join(pkgDir, "record.json"), "utf8"));
}
