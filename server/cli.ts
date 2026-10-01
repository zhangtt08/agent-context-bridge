// ACB CLI：register / overview / preview / create / publish / list / restore
// 与桌面界面走同一批核心 Module，不做第二套规则。
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  addProject, listProjects, loadHandoffRecords, getHandoffRecord, saveHandoffRecord,
} from "./core/store.js";
import { createHandoff } from "./core/workflow.js";
import { publishLocal, publishGithub, listRemoteHandoffs } from "./core/transport.js";
import { resumeFromArchive, previewArchiveResume } from "./core/resume.js";
import { buildPreview } from "./core/preview.js";
import { isWorkTree, isGitRepo, resolveProjectDir } from "./core/gitutil.js";
import type { ProjectConfig, ConflictPolicy } from "../shared/types.js";

const [, , cmd, ...args] = process.argv;

function newId(): string {
  return "prj_" + crypto.randomBytes(4).toString("hex");
}

async function pickProject(idOrPath?: string): Promise<ProjectConfig> {
  const all = await listProjects();
  if (idOrPath) {
    const p = all.find((x) => x.projectId === idOrPath || path.resolve(x.path) === path.resolve(idOrPath));
    if (p) return p;
    const abs = resolveProjectDir(idOrPath);
    if (await isWorkTree(abs)) {
      const cfg: ProjectConfig = { projectId: newId(), name: path.basename(abs), path: abs, checks: [] };
      await addProject(cfg);
      return cfg;
    }
    throw new Error(`项目未找到：${idOrPath}。出路：acb register <包含代码的项目根目录>`);
  }
  const cwd = path.resolve(process.cwd());
  return all.find((x) => path.resolve(x.path) === cwd) ?? all[all.length - 1]
    ?? (() => { throw new Error("没有已注册项目。出路：acb register <path>"); })();
}

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  switch (cmd) {
    case "register": {
      const p = resolveProjectDir(args[0] ?? ".");
      if (!(await isWorkTree(p))) throw new Error("目录不是可用的 Git 工作区（裸仓库或 .git 目录无法交接）。出路：选择包含代码的项目根目录");
      const cfg: ProjectConfig = { projectId: newId(), name: args[1] ?? path.basename(p), path: p, checks: [] };
      await addProject(cfg);
      console.log(`已注册 ${cfg.name} → ${cfg.projectId}（${cfg.path}）`);
      break;
    }
    case "overview": {
      const p = await pickProject(args[0]);
      const records = await loadHandoffRecords(p.path);
      console.log(`项目 ${p.name}（${p.projectId}）· 检查命令 ${p.checks.length} 条 · 远端 ${p.githubRemote ?? "未配置"}`);
      console.log(`交接 ${records.length} 个`);
      for (const r of records.slice(0, 8)) {
        const pub = r.publications[r.publications.length - 1];
        console.log(`  ${r.handoffId} · ${r.state.taskName} · ${r.state.changes.length} 文件 · ${pub ? pub.state + " " + pub.location : "未发布"}`);
      }
      break;
    }
    case "preview": {
      const p = await pickProject(args[0]);
      const v = await buildPreview(p);
      console.log(`基线 ${v.baseline.branch ?? "(无)"} @ ${v.baseline.commit?.slice(0, 7) ?? "无"} · 纳入 ${v.included.length} 项 ${v.includedBytes} B · ${v.bundleNote}`);
      for (const f of v.included) console.log(`  + ${f.path} [${f.status}${f.staged ? "/暂存" : ""}] ${f.kind} ${f.bytes}B`);
      for (const e of v.excluded) console.log(`  - ${e.path} 排除：${e.reason}`);
      for (const a of v.alerts) console.log(`  ! [${a.level}] ${a.title} — ${a.detail}\n      出路：${a.action}`);
      if (v.alerts.some((a) => a.level === "阻塞")) process.exitCode = 1;
      break;
    }
    case "create": {
      const p = await pickProject(args[0]);
      const taskName = args[1] ?? "未命名任务";
      const r = await createHandoff(p, { taskName, claimText: args[2], runChecks: flag("checks") === undefined ? false : true });
      console.log(`已封存 ${r.record.handoffId}（快照 ${r.snapshot.id}，${r.snapshot.files} 文件 / ${r.snapshot.bytes} B，清单 ${r.record.manifest.entries.length} 条）`);
      for (const v of r.verifications) console.log(`  检查 ${v.name}: ${v.result}`);
      for (const w of r.warnings) console.log(`  提示：${w}`);
      break;
    }
    case "publish": {
      const p = await pickProject(args[0]);
      const handoffId = args[1];
      const target = (args[2] as "github" | "local") ?? "local";
      const rec = await getHandoffRecord(p.path, handoffId);
      if (!rec) throw new Error(`交接不存在：${handoffId}。出路：acb overview 看本机封存了哪些交接`);
      const { receipt } = target === "github"
        ? await publishGithub(p.path, rec, p.githubRemote ?? (() => { throw new Error("未配置 githubRemote。出路：用界面项目设置填写，或改用 local 导出文件"); })())
        : await publishLocal(rec, path.join(os.homedir(), "Downloads", `acb-${handoffId}.acb.tar.gz`));
      rec.publications.push(receipt);
      await saveHandoffRecord(p.path, rec);
      console.log(`${receipt.state} → ${receipt.location}${receipt.commitSha ? " @ " + receipt.commitSha.slice(0, 10) : ""}（读取确认 ${receipt.readBackConfirmed ? "通过" : "未通过"}）`);
      if (receipt.archiveSha256) console.log(`归档 sha256：${receipt.archiveSha256} · ${receipt.archiveBytes} B（在另一台电脑核对同一份文件时用）`);
      if (receipt.error) console.log(`原因：${receipt.error}`);
      if (receipt.state !== "已发布") process.exitCode = 1;
      break;
    }
    case "list": {
      const p = await pickProject(args[0]);
      const remote = args[1] ?? p.githubRemote;
      if (!remote) throw new Error("未配置远端。出路：acb list [project] <remote-url>，或在界面项目设置里填");
      const list = await listRemoteHandoffs(p.path, remote);
      if (!list.length) console.log("远端没有 acb/handoff/* 分支（先在源电脑 acb publish <id> github）");
      for (const l of list) console.log(`${l.id} · ${l.sha.slice(0, 10)}`);
      break;
    }
    case "restore": {
      const filePath = args[0];
      const targetDir = path.resolve(args[1] ?? path.join(os.tmpdir(), "acb-restore"));
      const conflictArg = flag("conflict") as string | undefined;
      if (!filePath) throw new Error("用法：acb restore <file.acb.tar.gz> [targetDir] [--conflict preview|abort|skip|overwrite]");
      // `--conflict preview` 不是恢复策略而是"只看不写"的另一种模式，所以不能塞进 ConflictPolicy
      // （那是 resume 的落盘分支，编译器按联合类型判等，塞进去只会得到一个永远不成立的比较）。
      if (conflictArg === "preview") {
        const v = await previewArchiveResume({ filePath, targetDir, source: filePath });
        console.log(`预览：完整性 ${v.verifiedCount}/${v.entryCount} · 将写入 ${v.willWrite} 项 · 撞车 ${v.conflicts.length} 项`);
        for (const a of v.alerts) console.log(`  ! [${a.level}] ${a.title} — ${a.action}`);
        break;
      }
      const onConflict = (conflictArg as ConflictPolicy | undefined) ?? "abort";
      const { report } = await resumeFromArchive({ filePath, targetDir, source: filePath, onConflict });
      console.log(`${report.verdict} · 指纹一致 ${report.digestMatch} · 写入 ${report.restoredCount}/${report.entryCount} → ${targetDir}`);
      for (const s of report.steps) console.log(`  [${s.ok ? "x" : " "}] ${s.title} — ${s.detail}`);
      for (const g of report.gaps) console.log(`  [${g.kind}${g.blocking ? "·阻塞" : ""}] ${g.title} — ${g.detail}`);
      if (report.verdict === "恢复被阻塞") process.exitCode = 1;
      break;
    }
    default:
      console.log(`ACB — Agent Context Bridge CLI

  acb register <path> [name]              注册项目（必须是 Git 工作区）
  acb overview [project]                  项目与本机封存交接
  acb preview [project]                   打包前审阅清单（纳入/排除及原因、凭据告警）
  acb create [project] <task> [claim]     创建交接并封存
  acb publish [project] <id> <local|github>  发布并给回执（本地导出含 sha256）
  acb list [project] [remote]             列出远端交接分支
  acb restore <file> [dir] [--conflict abort|skip|overwrite]
                                          还原；--conflict preview 只看差异不写盘

  退出码非零 = 有阻塞项或未发布成功，可直接用于脚本判断。
`);
  }
}

main().catch((e) => {
  console.error("[acb] 错误:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
