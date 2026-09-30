// ACB CLI：register / overview / create / publish / list / restore
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  addProject, listProjects, loadHandoffRecords, getHandoffRecord,
} from "./core/store.js";
import { createHandoff } from "./core/workflow.js";
import { publishLocal, publishGithub, listRemoteHandoffs } from "./core/transport.js";
import { resumeFromArchive } from "./core/resume.js";
import { isGitRepo, gitStatus } from "./core/gitutil.js";
import type { ProjectConfig } from "../shared/types.js";

const [, , cmd, ...args] = process.argv;

async function pickProject(idOrPath?: string): Promise<ProjectConfig> {
  const all = await listProjects();
  if (idOrPath) {
    const p = all.find((x) => x.projectId === idOrPath || path.resolve(x.path) === path.resolve(idOrPath));
    if (p) return p;
    const abs = path.resolve(idOrPath);
    if (await isGitRepo(abs)) {
      const cfg: ProjectConfig = {
        projectId: "prj_" + Math.random().toString(16).slice(2, 10),
        name: path.basename(abs), path: abs, checks: [],
      };
      await addProject(cfg);
      return cfg;
    }
    throw new Error(`项目未找到: ${idOrPath}（先 acb register <path>）`);
  }
  // 无参数：优先当前目录（若已注册），否则取最近注册的项目
  const cwd = path.resolve(process.cwd());
  return all.find((x) => path.resolve(x.path) === cwd) ?? all[all.length - 1]
    ?? (() => { throw new Error("没有已注册项目，先 acb register <path>"); })();
}

async function main() {
  switch (cmd) {
    case "register": {
      const p = path.resolve(args[0] ?? ".");
      if (!(await isGitRepo(p))) throw new Error("目录不是 Git 仓库");
      const cfg: ProjectConfig = {
        projectId: "prj_" + Math.random().toString(16).slice(2, 10),
        name: args[1] ?? path.basename(p), path: p, checks: [],
      };
      await addProject(cfg);
      console.log(`已注册 ${cfg.name} → ${cfg.projectId}（${cfg.path}）`);
      break;
    }
    case "overview": {
      const p = await pickProject(args[0]);
      const st = await gitStatus(p.path);
      const records = await loadHandoffRecords(p.path);
      console.log(`项目 ${p.name}（${p.projectId}）· 分支 ${st.branch} @ ${st.commit?.slice(0, 7)}`);
      console.log(`改动 ${st.entries.length} 项 · 交接 ${records.length} 个`);
      for (const r of records.slice(0, 5)) {
        const pub = r.publications[r.publications.length - 1];
        console.log(`  ${r.handoffId} · ${r.state.taskName} · ${r.state.changes.length} 文件 · ${pub ? pub.state + " " + pub.location : "未发布"}`);
      }
      break;
    }
    case "create": {
      const p = await pickProject(args[0]);
      const taskName = args[1] ?? "未命名任务";
      const r = await createHandoff(p, { taskName, claimText: args[2] });
      console.log(`已封存 ${r.record.handoffId}（快照 ${r.snapshot.id}，${r.snapshot.files} 文件）`);
      for (const v of r.verifications) console.log(`  检查 ${v.name}: ${v.result}`);
      break;
    }
    case "publish": {
      const p = await pickProject(args[0]);
      const handoffId = args[1];
      const target = (args[2] as "github" | "local") ?? "local";
      const rec = await getHandoffRecord(p.path, handoffId);
      if (!rec) throw new Error(`交接不存在: ${handoffId}`);
      const { receipt } = target === "github"
        ? await publishGithub(p.path, rec, p.githubRemote ?? (() => { throw new Error("未配置 githubRemote"); })())
        : await publishLocal(rec, path.join(os.homedir(), "Downloads", `acb-${handoffId}.acb.tar.gz`));
      console.log(`${receipt.state} → ${receipt.location}${receipt.commitSha ? " @ " + receipt.commitSha.slice(0, 10) : ""}`);
      break;
    }
    case "list": {
      const p = await pickProject(args[0]);
      const remote = args[1] ?? p.githubRemote;
      if (!remote) throw new Error("未配置远端");
      const list = await listRemoteHandoffs(p.path, remote);
      for (const l of list) console.log(`${l.id} · ${l.sha.slice(0, 10)}`);
      break;
    }
    case "restore": {
      const filePath = args[0];
      const targetDir = path.resolve(args[1] ?? path.join(os.tmpdir(), "acb-restore"));
      const handoffId = path.basename(filePath ?? "").replace(/\.acb\.tar\.gz$/, "").replace("acb-", "");
      const { report } = await resumeFromArchive({ filePath, handoffId, targetDir, source: filePath });
      console.log(`${report.verdict} · 指纹一致: ${report.digestMatch} → ${targetDir}`);
      for (const g of report.gaps) console.log(`  [${g.kind}] ${g.title} — ${g.detail}`);
      break;
    }
    default:
      console.log(`ACB — Agent Context Bridge CLI

  acb register <path> [name]       注册项目
  acb overview [project]           查看项目与最近交接
  acb create [project] <task> [claim]   创建交接（封存）
  acb publish [project] <id> <local|github>  发布
  acb list [project] [remote]      列出远端交接
  acb restore <file.acb.tar.gz> [targetDir]  恢复
`);
  }
}

main().catch((e) => {
  console.error("[acb] 错误:", e instanceof Error ? e.message : e);
  process.exit(1);
});

void execSync;
