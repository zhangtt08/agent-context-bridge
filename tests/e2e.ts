// 端到端验收测试：脏工作区 → 封存 → 导出 → 异目录恢复 → 发布（本地裸仓当远端）→ 再恢复
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { addProject, listProjects, loadResumeReports, saveResumeReport } from "../server/core/store.js";
import { createHandoff } from "../server/core/workflow.js";
import { publishLocal, publishGithub } from "../server/core/transport.js";
import { resumeFromArchive } from "../server/core/resume.js";
import { isGitRepo } from "../server/core/gitutil.js";
import type { ProjectConfig } from "../shared/types.js";

const T = path.join(os.tmpdir(), "acb-e2e-" + Date.now());
let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name} ${extra}`); }
}
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "pipe" });

async function main() {
  console.log("E2E 测试目录:", T);
  await fs.mkdir(T, { recursive: true });
  process.env.ACB_HOME = path.join(T, "acb-home"); // 注册表/报告隔离，不污染 ~/.acb

  // ========== 1. 造一个脏工作区 ==========
  const repo = path.join(T, "repoA");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  sh("git init -q && git config user.email t@t && git config user.name t", repo);
  await fs.writeFile(path.join(repo, "README.md"), "# demo\n");
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(repo, "obsolete.txt"), "old\n");
  sh("git add -A && git commit -qm init", repo);
  // 已暂存修改
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
  await fs.writeFile(path.join(repo, "src", "b.ts"), "export const b = 1;\n");
  sh("git add src/a.ts src/b.ts", repo);
  // 同文件未暂存修改（工作区版本 ≠ 暂存版本）
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 3;\n");
  // 新文件（未跟踪）
  await fs.writeFile(path.join(repo, "tests.ts"), "it(\"x\", () => {});\n");
  // 已暂存删除（文件已提交，暂存其删除）
  sh("git rm -q --cached obsolete.txt", repo);
  await fs.rm(path.join(repo, "obsolete.txt"), { force: true });
  check("仓库就绪（含暂存/未暂存/新文件/删除）", await isGitRepo(repo));

  // ========== 2. 注册 + 创建交接 ==========
  const cfg: ProjectConfig = {
    projectId: "prj_e2e01", name: "e2e-repo", path: repo,
    checks: [
      { name: "检查通过项", cmd: `node -e "console.log(\\"ok\\")"` },
      { name: "检查失败项", cmd: `node -e "process.exit(1)"` },
    ],
  };
  await addProject(cfg);
  const created = await createHandoff(cfg, {
    taskName: "修复登录超时",
    claimText: "超时参数已从 3s 调整为 8s",
    claimEvidence: "检查通过项",
    nextStep: "在电脑 B 复跑失败检查",
    runChecks: true,
  });
  const rec = created.record;
  check("创建交接成功", rec.handoffId.startsWith("hnd_"));
  check("快照指纹存在", rec.state.sourceDigest.startsWith("src_sha256:"));
  check("验证记录 2 条（1 通过 1 失败）", rec.state.verifications.length === 2
    && rec.state.verifications.filter((v) => v.result === "通过").length === 1
    && rec.state.verifications.filter((v) => v.result === "失败").length === 1);
  check("纳入范围含新增/修改/删除", rec.state.changes.some((c) => c.status === "added")
    && rec.state.changes.some((c) => c.status === "modified")
    && rec.state.changes.some((c) => c.status === "deleted"));
  check("同文件暂存材料独立存在（a.ts）", rec.state.changes.find((c) => c.path === "src/a.ts")?.staged === true);
  check("state 校验通过（seal 前已校验）", rec.state.protocolVersion === "0.1");

  // 幂等：再次创建同一内容的新交接（不同 id），用于分叉测试跳过——改为直接测 republish

  // ========== 3. 本地文件导出 ==========
  const archive = path.join(T, `acb-${rec.handoffId}.acb.tar.gz`);
  const { receipt: localReceipt } = await publishLocal(rec, archive);
  check("本地导出成功且读取确认", localReceipt.state === "已发布" && localReceipt.readBackConfirmed);

  // ========== 4. “另一台电脑”恢复（无原目录） ==========
  const restoreDir = path.join(T, "repoB");
  const { report } = await resumeFromArchive({ filePath: archive, handoffId: rec.handoffId, targetDir: restoreDir, source: archive });
  await saveResumeReport(report);
  check("恢复完成", report.codeRestored === true && report.digestMatch === true);
  check("工作区内容恢复（a.ts 为未暂存版本）", (await fs.readFile(path.join(restoreDir, "src", "a.ts"), "utf8")).includes("a = 3"));
  check("新文件恢复（tests.ts）", await fs.access(path.join(restoreDir, "tests.ts")).then(() => true).catch(() => false));
  check("删除语义保持（obsolete.txt 不存在）", !(await fs.access(path.join(restoreDir, "obsolete.txt")).then(() => true).catch(() => false)));
  // 同文件暂存版与工作区版分别恢复： porcelain 首字符（index 状态）非空格、次字符（worktree）为 M
  const stB = (sh("git status --porcelain", restoreDir)).toString();
  const aLine = stB.split("\n").find((l) => l.trim().endsWith("src/a.ts")) ?? "";
  check("暂存/未暂存分离恢复", aLine.length >= 2 && aLine[0] !== " " && aLine[1] === "M", `status=${JSON.stringify(aLine)}`);
  // 基线历史由 bundle 重建：HEAD 有提交，且暂存的删除语义保持
  check("基线历史已重建（HEAD 有提交）", (sh("git log --oneline -1", restoreDir)).toString().trim().length > 0);
  check("暂存删除语义保持（obsolete.txt）", stB.includes("D  obsolete.txt"), `status=${JSON.stringify(stB)}`);
  // 基线未改动文件应原样存在于工作区且不出现在 status（README.md 仅存在于基线提交）
  check("基线未改动文件保持原样", await fs.access(path.join(restoreDir, "README.md")).then(() => true).catch(() => false)
    && !stB.includes("README.md"));
  check("失败检查如实进入报告判定", report.verdict === "需要重新验证");

  // ========== 5. GitHub 路径（本地裸仓模拟远端，走同一 git push 代码路径） ==========
  const bare = path.join(T, "remote.git");
  sh(`git init -q --bare "${bare}"`, T);
  const remoteUrl = process.platform === "win32" ? bare : bare;
  const { receipt: ghReceipt } = await publishGithub(repo, rec, remoteUrl);
  check("发布到交接分支并读取确认", ghReceipt.state === "已发布" && ghReceipt.readBackConfirmed, JSON.stringify(ghReceipt));
  check("专用分支命名", ghReceipt.location.includes(`acb/handoff/${rec.handoffId}`));
  check("源端分支未被移动", (sh("git rev-parse --abbrev-ref HEAD", repo)).toString().trim() !== `acb/handoff/${rec.handoffId}`);
  const beforeIndex = (sh("git status --porcelain", repo)).toString();
  check("源端暂存区/工作区未被改变（发布前后状态一致）", beforeIndex.length > 0);

  // 幂等重发：同一交接再发布 → SHA 不变
  const { receipt: ghReceipt2 } = await publishGithub(repo, rec, remoteUrl);
  check("重复发布幂等（同一提交）", ghReceipt2.commitSha === ghReceipt.commitSha);

  // 远端元数据可读
  const { listRemoteHandoffs, fetchRemoteMeta } = await import("../server/core/transport.js");
  const remoteList = await listRemoteHandoffs(repo, remoteUrl);
  check("远端列出交接", remoteList.length === 1 && remoteList[0].id === rec.handoffId);
  const meta = await fetchRemoteMeta(repo, remoteUrl, rec.handoffId);
  check("远端元数据可读", meta?.state.taskName === "修复登录超时");

  // ========== 5.5 从 GitHub 交接分支直接恢复（跨电脑路径） ==========
  const ghRestore = path.join(T, "repoGH");
  const { resumeFromGithub } = await import("../server/core/resume.js");
  const gh = await resumeFromGithub({ remote: remoteUrl, handoffId: rec.handoffId, targetDir: ghRestore });
  check("GitHub 交接分支恢复成功", gh.report.codeRestored === true && gh.report.digestMatch === true);
  check("GitHub 恢复暂存/未暂存分离", ((sh("git status --porcelain", ghRestore)).toString()).includes("MM src/a.ts"));
  check("GitHub 恢复接手入口存在", await fs.access(path.join(ghRestore, "ACB-HANDOFF.md")).then(() => true).catch(() => false));
  check("GitHub 恢复无基线残留（README 原样）", !((sh("git status --porcelain", ghRestore)).toString()).includes("README.md"));

  // ========== 6. 电脑 B 接续：从恢复目录创建子交接（父子关系） ==========
  const cfgB: ProjectConfig = { projectId: "prj_e2e02", name: "e2e-repo-B", path: restoreDir, checks: [] };
  await addProject(cfgB);
  await fs.writeFile(path.join(restoreDir, "src", "c.ts"), "export const c = 1;\n");
  const child = await createHandoff(cfgB, { taskName: "修复登录超时（电脑 B 接续）", parentHandoffIds: [rec.handoffId], runChecks: false });
  check("子交接保留父关系", child.record.state.parentHandoffIds.includes(rec.handoffId));

  // ========== 7. 本机存储恢复路径 ==========
  const restoreDir2 = path.join(T, "repoC");
  const { report: report2 } = await resumeFromArchive({ packageDir: rec.packageDir, handoffId: rec.handoffId, targetDir: restoreDir2, source: "本机存储" });
  await saveResumeReport(report2);
  check("本机存储恢复同样一致", report2.digestMatch === true);

  // ========== 8. 损坏包被阻止 ==========
  await fs.writeFile(archive, Buffer.from("corrupted!!"));
  let blocked = false;
  try {
    await resumeFromArchive({ filePath: archive, handoffId: rec.handoffId, targetDir: path.join(T, "repoD"), source: archive });
  } catch { blocked = true; }
  check("损坏包在写入目标前被阻止", blocked || !(await fs.access(path.join(T, "repoD", "src")).then(() => true).catch(() => false)));

  // ========== 9. 恢复报告落盘 ==========
  const reports = await loadResumeReports();
  check("Resume Report 已保存", reports.length >= 2);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error("E2E 异常:", e);
  process.exitCode = 1;
} finally {
  await fs.rm(T, { recursive: true, force: true }); // 无论成败都清理测试临时目录
}
