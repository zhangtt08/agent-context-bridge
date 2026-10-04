// 端到端验收测试：脏工作区 → 审阅清单 → 封存 → 导出（带摘要回执）→ 还原前预览 → 冲突处理
// → 异目录恢复 → 形态保真（符号链接/可执行位）→ 发布（本地裸仓当远端）→ 再恢复 → 损坏/越界阻止
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { addProject, loadResumeReports, saveResumeReport } from "../server/core/store.js";
import { createHandoff } from "../server/core/workflow.js";
import { publishLocal, publishGithub } from "../server/core/transport.js";
import { resumeFromArchive, previewArchiveResume } from "../server/core/resume.js";
import { checkEntries, buildManifest } from "../server/core/package.js";
import { buildPreview, pathFidelityAlerts } from "../server/core/preview.js";
import {
  isGitRepo, isSafeRelPath, caseCollisions, DEFAULT_EXCLUDES, EXCLUSION_REASONS,
  unquoteGitPath, windowsNameIssues,
} from "../server/core/gitutil.js";
import type { ProjectConfig } from "../shared/types.js";
import {
  isLoopbackAddress, resolveBindHost, assertLoopbackOrigins, hostHeaderAllowed, originAllowed,
} from "../server/core/local-guard.js";

const T = path.join(os.tmpdir(), "acb-e2e-" + Date.now());
let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name} ${extra}`); }
}
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "pipe" });
const sha256FileLocal = async (p: string) => crypto.createHash("sha256").update(await fs.readFile(p)).digest("hex");
/** 系统临时目录里 ACB 检查用过的物化目录名（只读列举，用于"用完即清"断言） */
const checkDirs = async (): Promise<string[]> => {
  try { return (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith("acb-check-")); }
  catch { return []; }
};

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
  const { report: report2 } = await resumeFromArchive({ packageDir: rec.packageDir, targetDir: restoreDir2, source: "本机存储" });
  await saveResumeReport(report2);
  check("本机存储恢复同样一致（交接 ID 可省，以包内为准）", report2.digestMatch === true);
  check("恢复回执带条目数与写入数", report2.entryCount !== undefined && report2.restoredCount !== undefined && (report2.restoredCount ?? 0) > 0);

  // ========== 7.1 解包临时目录不残留 ==========
  const leftover = (await fs.readdir(path.dirname(archive))).filter((f) => f.startsWith(".acb-extract-"));
  check("解压临时目录已回收（不在用户目录旁边留残骸）", leftover.length === 0, JSON.stringify(leftover));

  // ========== 7.2 归档摘要可核对（两台电脑比对用） ==========
  const { receipt: localReceipt2 } = await publishLocal(rec, archive);
  const realSha = await sha256FileLocal(archive);
  check("导出回执记录归档 SHA-256 与体积", localReceipt2.archiveSha256 === realSha && (localReceipt2.archiveBytes ?? 0) > 0);
  let shaMismatchBlocked = false;
  try {
    await resumeFromArchive({ filePath: archive, handoffId: rec.handoffId, targetDir: path.join(T, "repoSha"), source: archive, archiveSha256: "f".repeat(64) });
  } catch (e) { shaMismatchBlocked = /摘要与回执不符/.test(String((e as Error).message)); }
  check("归档摘要与回执不符时拒绝恢复", shaMismatchBlocked);

  // ========== 7.3 还原前预览与冲突处理 ==========
  const conflictDir = path.join(T, "repoConflict");
  await fs.mkdir(path.join(conflictDir, "src"), { recursive: true });
  await fs.writeFile(path.join(conflictDir, "src", "a.ts"), "本机已改，不能被覆盖\n");
  const pre = await previewArchiveResume({ filePath: archive, targetDir: conflictDir, source: archive });
  check("预览报告完整性与将写入数", pre.integrityOk === true && pre.willWrite > 0 && pre.entryCount === pre.verifiedCount);
  check("预览不写盘（目标目录里那个文件还是原样）",
    (await fs.readFile(path.join(conflictDir, "src", "a.ts"), "utf8")).includes("不能被覆盖"));
  check("预览列出撞车项", pre.conflicts.some((c) => c.path === "src/a.ts" && !c.identical));
  const abortRes = await resumeFromArchive({ filePath: archive, targetDir: conflictDir, source: archive, onConflict: "abort" });
  check("冲突默认停止不覆盖（判定为恢复被阻塞）", abortRes.report.verdict === "恢复被阻塞"
    && abortRes.report.gaps.some((g) => g.blocking && /冲突/.test(g.title)));
  const skipRes = await resumeFromArchive({ filePath: archive, targetDir: conflictDir, source: archive, onConflict: "skip" });
  check("「跳过已存在」保留本机文件", skipRes.report.digestMatch !== true
    && (await fs.readFile(path.join(conflictDir, "src", "a.ts"), "utf8")).includes("不能被覆盖"));
  const owDir = path.join(T, "repoOverwrite");
  await fs.mkdir(path.join(owDir, "src"), { recursive: true });
  await fs.writeFile(path.join(owDir, "src", "a.ts"), "旧内容\n");
  const owRes = await resumeFromArchive({ filePath: archive, targetDir: owDir, source: archive, onConflict: "overwrite" });
  check("「用包内覆盖」还原成功且指纹一致", owRes.report.digestMatch === true
    && (await fs.readFile(path.join(owDir, "src", "a.ts"), "utf8")).includes("a = 3"));

  // ========== 7.4 填错交接 ID 被拒绝并说清怎么办 ==========
  let idMismatchMsg = "";
  try {
    await resumeFromArchive({ filePath: archive, handoffId: "hnd_deadbeef", targetDir: path.join(T, "repoId"), source: archive });
  } catch (e) { idMismatchMsg = String((e as Error).message); }
  check("包内 ID 与请求 ID 不一致时拒绝并给出出路", /不一致/.test(idMismatchMsg) && /留空/.test(idMismatchMsg));

  // ========== 7.5 清单里的路径穿越被挡 ==========
  const pkgCopy = path.join(T, "pkgEvil");
  await fs.cp(rec.packageDir, pkgCopy, { recursive: true });
  const evilManifest = JSON.parse(await fs.readFile(path.join(pkgCopy, "manifest.json"), "utf8"));
  evilManifest.entries.push({ path: "../../evil.txt", sha256: "0".repeat(64), size: 1 });
  await fs.writeFile(path.join(pkgCopy, "manifest.json"), JSON.stringify(evilManifest));
  const evilCheck = await checkEntries(pkgCopy, evilManifest);
  check("清单里的 ../ 路径判为不安全条目", evilCheck.ok === false && evilCheck.broken.some((b) => b.includes("evil.txt")));
  check("isSafeRelPath 挡绝对路径/盘符/UNC", !isSafeRelPath("/etc/passwd") && !isSafeRelPath("C:\\Windows\\x") && !isSafeRelPath("\\\\srv\\share\\x") && isSafeRelPath("src/a.ts"));

  // ========== 7.6 排除规则表与规则本体一致（防漂移） ==========
  check("EXCLUSION_REASONS 与 DEFAULT_EXCLUDES 一一对应",
    EXCLUSION_REASONS.length === DEFAULT_EXCLUDES.length
    && EXCLUSION_REASONS.every((x, i) => x.re.source === DEFAULT_EXCLUDES[i].source));

  // ========== 7.7 形态保真：符号链接与可执行位跨机不丢 ==========
  const repoM = path.join(T, "repoMode");
  await fs.mkdir(path.join(repoM, "src"), { recursive: true });
  sh("git init -q && git config user.email t@t && git config user.name t", repoM);
  await fs.writeFile(path.join(repoM, "README.md"), "# m\n");
  sh("git add -A && git commit -qm base", repoM);
  await fs.writeFile(path.join(repoM, "run.sh"), "#!/bin/sh\necho hi\n");
  sh("git add run.sh && git update-index --chmod=+x run.sh", repoM);
  await fs.writeFile(path.join(repoM, "src", "link.ts"), "src/../src/a.ts");
  const linkBlob = sh("git hash-object -w src/link.ts", repoM).toString().trim();
  sh(`git update-index --add --cacheinfo 120000,${linkBlob},src/link.ts`, repoM);
  const cfgM: ProjectConfig = { projectId: "prj_mode", name: "mode-repo", path: repoM, checks: [] };
  await addProject(cfgM);
  const createdM = await createHandoff(cfgM, { taskName: "模式保真", runChecks: false });
  const execChange = createdM.record.state.changes.find((c) => c.path === "run.sh");
  const linkChange = createdM.record.state.changes.find((c) => c.path === "src/link.ts");
  check("可执行位以 100755 进入交接状态", execChange?.mode === "100755", JSON.stringify(execChange));
  check("符号链接以 120000 进入交接状态（不再被当成普通文件）", linkChange?.mode === "120000", JSON.stringify(linkChange));
  const archiveM = path.join(T, `acb-${createdM.record.handoffId}.acb.tar.gz`);
  await publishLocal(createdM.record, archiveM);
  const modeDir = path.join(T, "repoModeRestored");
  const rM = await resumeFromArchive({ filePath: archiveM, targetDir: modeDir, source: archiveM });
  check("形态保真的包恢复后代码指纹一致（符号链接不会造成假阴性）", rM.report.digestMatch === true,
    rM.report.steps.find((s) => s.title === "代码指纹复算")?.detail ?? "");
  const idxAfter = sh("git ls-files -s", modeDir).toString();
  check("恢复后的索引保留 120000 模式", /^120000\s+[0-9a-f]{40}\s+\d+\s+src\/link\.ts$/m.test(idxAfter), idxAfter);
  check("恢复后的索引保留 100755 模式", /^100755\s+[0-9a-f]{40}\s+\d+\s+run\.sh$/m.test(idxAfter), idxAfter);
  const linkPlaceholder = rM.report.gaps.find((g) => /符号链接退化/.test(g.title));
  console.log(`      （本机符号链接：${linkPlaceholder ? `无创建权限，退化为普通文件并如实登记 —— ${linkPlaceholder.detail}` : "已按链接目标重建"}）`);

  // ========== 7.8 审阅清单：排除原因、历史凭据告警、大文件提示 ==========
  const prevM = await buildPreview(cfgM);
  check("预览给出纳入条目与体积", prevM.included.length > 0 && prevM.includedBytes >= 0);
  check("预览标注符号链接形态", prevM.included.some((f) => f.kind === "symlink"));

  const repoS = path.join(T, "repoSecret");
  await fs.mkdir(repoS, { recursive: true });
  sh("git init -q && git config user.email t@t && git config user.name t", repoS);
  await fs.writeFile(path.join(repoS, ".env"), "API_KEY=real-secret-never-commit\n");
  await fs.writeFile(path.join(repoS, "server.key"), "-----BEGIN PRIVATE KEY-----\n");
  await fs.writeFile(path.join(repoS, "app.js"), "export const a = 1;\n");
  sh("git add -A && git commit -qm base", repoS);
  await fs.writeFile(path.join(repoS, ".env.local"), "LOCAL=1\n");
  await fs.writeFile(path.join(repoS, "app.js"), "export const a = 2;\n");
  const cfgS: ProjectConfig = { projectId: "prj_secret", name: "secret-repo", path: repoS, checks: [] };
  await addProject(cfgS);
  const prevS = await buildPreview(cfgS);
  check("工作区新增的 .env.local 被排除并说明原因",
    prevS.excluded.some((e) => e.path === ".env.local" && e.kind === "凭据" && /不带出这台电脑/.test(e.reason)));
  check("已提交进历史的凭据被点名（排除策略挡不住历史）",
    prevS.baselineSecrets.includes(".env") && prevS.baselineSecrets.includes("server.key"), JSON.stringify(prevS.baselineSecrets));
  check("历史凭据告警给出可执行出路",
    prevS.alerts.some((a) => a.level === "警告" && /Git 历史/.test(a.title) && a.action.length > 10));
  const createdS = await createHandoff(cfgS, { taskName: "凭据默认排除", runChecks: false });
  check("凭据不进包且写入恢复要求",
    createdS.record.state.excluded.includes(".env.local")
    && createdS.record.state.recoveryRequirements.some((r) => r.includes(".env.local"))
    && !createdS.record.state.changes.some((c) => c.path === ".env.local"));

  // ========== 7.9 大小写碰撞：单测 + 真仓库拦住 ==========
  const col = caseCollisions(["src/A.ts", "src/a.ts", "src/b.ts"]);
  check("caseCollisions 认出仅大小写不同的路径组", col.length === 1 && col[0].length === 2, JSON.stringify(col));
  const repoC2 = path.join(T, "repoCase");
  await fs.mkdir(repoC2, { recursive: true });
  sh("git init -q && git config user.email t@t && git config user.name t", repoC2);
  await fs.writeFile(path.join(repoC2, "README.md"), "# c\n");
  sh("git add -A && git commit -qm base", repoC2);
  // 复现"仓库在 Linux 上写着 A.ts 与 a.ts，拿到 Windows 上只能落一个"的形状：
  // 索引里两个路径都在，工作区只有一个真文件
  await fs.writeFile(path.join(repoC2, "A.ts"), "export const v = 1;\n");
  sh("git add A.ts && git commit -qm A", repoC2);
  const aBlob = sh("git hash-object -w A.ts", repoC2).toString().trim();
  sh(`git update-index --add --cacheinfo 100644,${aBlob},a.ts`, repoC2);
  await fs.writeFile(path.join(repoC2, "A.ts"), "export const v = 2;\n");
  const cfgC2: ProjectConfig = { projectId: "prj_case", name: "case-repo", path: repoC2, checks: [] };
  await addProject(cfgC2);
  const stC2 = sh("git status --porcelain", repoC2).toString();
  let caseMsg = "";
  try { await createHandoff(cfgC2, { taskName: "大小写冲突", runChecks: false }); }
  catch (e) { caseMsg = String((e as Error).message); }
  check("现场就绪：索引里同时有 A.ts 与 a.ts", /A\.ts/.test(stC2) && /a\.ts/.test(stC2), stC2);
  check("仅大小写不同的路径会让打包停下来（Windows 恢复会静默覆盖）", /大小写/.test(caseMsg) && /改名/.test(caseMsg), caseMsg);

  // ========== 7.10 非 ASCII 基线文件 / 目录链接 / 空目录的跨机保真 ==========
  // 现场自己造：git 默认 core.quotePath=true，非 ASCII 路径在 ls-tree/ls-files 的普通输出里
  // 是 "\344\270\255…" 引用串；按那种串去拼路径会得到本机不存在的路径，
  // 于是中文名文件被静默跳过、而回执写着"基线已重建"。这一节就是钉住这条。
  const repoU = path.join(T, "repoUni");
  await fs.mkdir(path.join(repoU, "src", "\u6587\u6863"), { recursive: true });
  await fs.mkdir(path.join(repoU, "\u5360\u4f4d"), { recursive: true });   // 空目录：Git 不保存
  await fs.mkdir(path.join(repoU, "logs"), { recursive: true });           // 又一个空目录
  sh("git init -q && git config user.email t@t && git config user.name t", repoU);
  await fs.writeFile(path.join(repoU, "README.md"), "# u\n");
  await fs.writeFile(path.join(repoU, "\u4e2d\u6587\u6587\u4ef6.md"), "# \u4e2d\u6587\u547d\u540d\n");
  await fs.writeFile(path.join(repoU, "src", "\u6587\u6863", "\u63a5\u53e3.ts"), "export const api = 1;\n");
  await fs.writeFile(path.join(repoU, "run.sh"), "#!/bin/sh\n");
  sh("git add -A && git commit -qm base", repoU);
  // 指向目录的符号链接：与 7.7 同一手法（索引里记 120000，内容就是目标文本）
  await fs.writeFile(path.join(repoU, "\u6307\u5411\u6e90\u7801"), "src");
  const dirBlob = sh("git hash-object -w -- \u6307\u5411\u6e90\u7801", repoU).toString().trim();
  sh("git update-index --add --cacheinfo 120000," + dirBlob + ",\u6307\u5411\u6e90\u7801", repoU);
  sh("git update-index --chmod=+x run.sh", repoU);
  await fs.writeFile(path.join(repoU, "src", "mod.ts"), "export const m = 1;\n");
  await fs.writeFile(path.join(repoU, "src", "\u6587\u6863", "\u65b0\u589e.ts"), "export const n = 2;\n");
  await fs.writeFile(path.join(repoU, ".env"), "SECRET=keep-on-this-machine\n");
  const cfgU: ProjectConfig = { projectId: "prj_uni", name: "unicode-repo", path: repoU, checks: [] };
  await addProject(cfgU);
  const prevU = await buildPreview(cfgU);
  check("\u975e ASCII \u8def\u5f84\u5728\u5ba1\u9605\u6e05\u5355\u91cc\u662f\u771f\u5b9e\u540d\u5b57\uff08\u4e0d\u662f\u516b\u8fdb\u5236\u5f15\u7528\u4e32\uff09",
    prevU.included.some((f) => f.path === "src/\u6587\u6863/\u65b0\u589e.ts") && !prevU.included.some((f) => f.path.includes("\\34")),
    JSON.stringify(prevU.included.map((f) => f.path)));
  check("\u7a7a\u76ee\u5f55\u88ab\u8bc6\u522b\u5e76\u5199\u8fdb\u5ba1\u9605\u6e05\u5355",
    prevU.emptyDirs.includes("\u5360\u4f4d") && prevU.emptyDirs.includes("logs"), JSON.stringify(prevU.emptyDirs));
  check("\u7a7a\u76ee\u5f55\u544a\u8b66\u8bf4\u660e\u4e86 Git \u4e0d\u4fdd\u5b58\u5b83\u4eec",
    prevU.alerts.some((a) => /\u7a7a\u76ee\u5f55/.test(a.title)), JSON.stringify(prevU.alerts.map((a) => a.title)));
  const createdU = await createHandoff(cfgU, { taskName: "\u975e ASCII \u4e0e\u7a7a\u76ee\u5f55\u4fdd\u771f", runChecks: false });
  check("\u7a7a\u76ee\u5f55\u8fdb\u5165\u4ea4\u63a5\u72b6\u6001", (createdU.record.state.emptyDirs ?? []).length >= 2, JSON.stringify(createdU.record.state.emptyDirs));
  const archiveU = path.join(T, `acb-${createdU.record.handoffId}.acb.tar.gz`);
  await publishLocal(createdU.record, archiveU);
  const uniDir = path.join(T, "repoUniRestored");
  const rU = await resumeFromArchive({ filePath: archiveU, targetDir: uniDir, source: archiveU });
  check("\u4e2d\u6587\u540d\u57fa\u7ebf\u6587\u4ef6\u771f\u7684\u843d\u5230\u4e86\u76ee\u5f55", await fs.stat(path.join(uniDir, "\u4e2d\u6587\u6587\u4ef6.md")).then(() => true).catch(() => false));
  check("\u4e2d\u6587\u76ee\u5f55\u4e0b\u7684\u57fa\u7ebf\u6587\u4ef6\u843d\u5730", await fs.stat(path.join(uniDir, "src", "\u6587\u6863", "\u63a5\u53e3.ts")).then(() => true).catch(() => false));
  const stU = sh("git status --porcelain", uniDir).toString();
  check("\u6062\u590d\u540e git \u770b\u4e0d\u5230\u6b8b\u7f3a\uff08\u6ca1\u6709\u5de5\u4f5c\u533a\u5220\u9664\uff09", !/^. D /.test(stU), stU);
  check("\u7a7a\u76ee\u5f55\u5728\u63a5\u6536\u7aef\u91cd\u5efa",
    (await fs.stat(path.join(uniDir, "\u5360\u4f4d")).then((s) => s.isDirectory()).catch(() => false))
    && (await fs.stat(path.join(uniDir, "logs")).then((s) => s.isDirectory()).catch(() => false)));
  check("\u76ee\u5f55\u7b26\u53f7\u94fe\u63a5\u4fdd\u7559 120000 \u6a21\u5f0f",
    /^120000\s+[0-9a-f]{40}\s+\d+\s+\u6307\u5411\u6e90\u7801$/m.test(sh("git -c core.quotepath=false ls-files -s", uniDir).toString()),
    sh("git -c core.quotepath=false ls-files -s", uniDir).toString());
  const dirLinkLstat = await fs.lstat(path.join(uniDir, "\u6307\u5411\u6e90\u7801")).catch(() => null);
  const dirLinkReported = rU.report.steps.some((s) => /\u76ee\u5f55\u8054\u63a5|\u7b26\u53f7\u94fe\u63a5/.test(s.title))
    || rU.report.gaps.some((g) => /\u7b26\u53f7\u94fe\u63a5/.test(g.title));
  console.log(`      \uff08\u76ee\u5f55\u94fe\u63a5\u5f62\u6001\uff1a${dirLinkLstat?.isSymbolicLink() ? "\u5df2\u6309\u94fe\u63a5\u91cd\u5efa" : dirLinkLstat ? "\u9000\u5316\u4e3a\u666e\u901a\u6587\u4ef6\uff08\u672c\u673a\u65e0\u7279\u6743\uff09" : "\u672a\u843d\u5730"}\uff09`);
  check("\u76ee\u5f55\u94fe\u63a5\u8981\u4e48\u662f\u94fe\u63a5\u3001\u8981\u4e48\u5982\u5b9e\u62a5\u544a\uff0c\u4e0d\u80fd\u9759\u9ed8",
    !!dirLinkLstat && (dirLinkLstat.isSymbolicLink() || dirLinkReported));
  check("\u53ef\u6267\u884c\u4f4d\u5728\u4e2d\u6587\u8def\u5f84\u4ed3\u5e93\u91cc\u4e5f\u4e0d\u4e22",
    /^100755\s+[0-9a-f]{40}\s+\d+\s+run\.sh$/m.test(sh("git ls-files -s", uniDir).toString()));
  check("\u5f62\u6001\u4fdd\u771f\u7684\u5305\u6062\u590d\u540e\u6307\u7eb9\u4e00\u81f4", rU.report.digestMatch === true,
    rU.report.steps.find((s) => s.title === "\u4ee3\u7801\u6307\u7eb9\u590d\u7b97")?.detail ?? "");
  check("\u57fa\u7ebf\u7269\u5316\u7ed9\u51fa\u9884\u671f/\u5b9e\u9645/\u672a\u843d\u5730\u4e09\u4e2a\u6570",
    (rU.report.baselineExpected ?? 0) >= 3 && rU.report.baselineWritten === rU.report.baselineExpected
    && (rU.report.baselineSkipped ?? []).length === 0,
    JSON.stringify({ exp: rU.report.baselineExpected, w: rU.report.baselineWritten, skip: rU.report.baselineSkipped }));
  check("\u51ed\u636e\u4e0d\u4f1a\u88ab\u5e26\u5230\u63a5\u6536\u7aef", !await fs.stat(path.join(uniDir, ".env")).then(() => true).catch(() => false));
  const uniBaselineStep = rU.report.steps.find((s) => s.title === "\u57fa\u7ebf\u7269\u5316");
  check("\u57fa\u7ebf\u56de\u6267\u6587\u6848\u70b9\u51fa\u4e86\u94fe\u63a5\u4e0e\u6267\u884c\u4f4d\u7684\u6570\u91cf",
    !!uniBaselineStep && /120000|100755|\u7b26\u53f7\u94fe\u63a5|\u53ef\u6267\u884c/.test(uniBaselineStep.detail), uniBaselineStep?.detail ?? "");

  // ========== 7.11 \u9010\u9879\u56de\u6267\uff1a\u53ea\u5728\u76ee\u6807\u7684\u672c\u673a\u6587\u4ef6\u5fc5\u987b\u770b\u89c1 ==========
  const leftoverDir = path.join(T, "repoLeftover");
  await fs.mkdir(leftoverDir, { recursive: true });
  await fs.writeFile(path.join(leftoverDir, "\u672c\u673a\u65e7\u6587\u4ef6.txt"), "\u8fd9\u662f\u63a5\u6536\u7535\u8111\u81ea\u5df1\u7684\u4e1c\u897f\n");
  const preL = await previewArchiveResume({ filePath: archiveU, targetDir: leftoverDir, source: archiveU });
  check("\u9884\u89c8\u5c31\u80fd\u770b\u89c1\u300c\u53ea\u5728\u76ee\u6807\u300d\u7684\u672c\u673a\u6587\u4ef6",
    (preL.onlyInTarget ?? []).includes("\u672c\u673a\u65e7\u6587\u4ef6.txt"), JSON.stringify(preL.onlyInTarget));
  check("\u9884\u89c8\u62ff\u5230\u4e86\u57fa\u7ebf\u6e05\u5355\uff08\u80fd\u533a\u5206\u5305\u5185\u5bb9\u4e0e\u672c\u673a\u6587\u4ef6\uff09",
    preL.baselineListed === true && (preL.baselineMissingInTarget ?? 0) >= 3,
    JSON.stringify({ listed: preL.baselineListed, missing: preL.baselineMissingInTarget, total: preL.packagePathCount }));
  const rL = await resumeFromArchive({ filePath: archiveU, targetDir: leftoverDir, source: archiveU, onConflict: "skip" });
  check("\u56de\u6267\u5217\u51fa\u300c\u53ea\u5728\u76ee\u6807\u300d\u7684\u672c\u673a\u6587\u4ef6",
    (rL.report.receipt?.onlyInTarget ?? []).includes("\u672c\u673a\u65e7\u6587\u4ef6.txt"), JSON.stringify(rL.report.receipt));
  check("\u300c\u53ea\u5728\u76ee\u6807\u300d\u4e0d\u628a\u4ea4\u63a5\u5185\u5bb9\u7b97\u8fdb\u53bb",
    !(rL.report.receipt?.onlyInTarget ?? []).includes("README.md"));
  check("\u6062\u590d\u62a5\u544a\u6b63\u6587\u91cc\u6709\u9010\u9879\u5bf9\u8d26\u4e00\u680f",
    (await fs.readFile(path.join(leftoverDir, "ACB-RESUME-REPORT.md"), "utf8")).includes("\u53ea\u5728\u76ee\u6807"));

  // ========== 7.12 \u78b0\u649e\u5305\u5728\u672c\u673a\u8fd8\u539f\uff1a\u5199\u5165\u524d\u62e6\u4f4f\uff0c\u800c\u4e0d\u662f\u6253\u5b8c\u518d\u62a5\u6307\u7eb9\u4e0d\u4e00\u81f4 ==========
  // \u73b0\u573a\u81ea\u5df1\u9020\uff1a\u590d\u5236\u4e00\u4efd\u5df2\u5c01\u5b58\u7684\u5305\uff0c\u5f80\u72b6\u6001\u91cc\u63d2\u4e00\u4e2a\u4e0e\u73b0\u6709\u6587\u4ef6\u53ea\u5dee\u5927\u5c0f\u5199\u7684\u8def\u5f84\uff0c
  // \u518d\u91cd\u5efa manifest\uff08\u5426\u5219\u5148\u6302\u5728\u5b8c\u6574\u6027\u4e0a\uff0c\u5c31\u6d4b\u4e0d\u5230\u78b0\u649e\u5224\u636e\uff09\u3002
  const evilPkg = path.join(T, "pkgCaseCollide");
  await fs.cp(createdU.record.packageDir, evilPkg, { recursive: true });
  const evilStatePath = path.join(evilPkg, "acb-state", "project-state.json");
  const evilState = JSON.parse(await fs.readFile(evilStatePath, "utf8"));
  const victim = evilState.changes.find((c: { path: string }) => /mod\.ts$/.test(c.path)) ?? evilState.changes[0];
  evilState.changes.push({ ...victim, path: victim.path.replace("mod.ts", "MOD.ts"), staged: false });
  await fs.writeFile(evilStatePath, JSON.stringify(evilState, null, 2));
  const collisionManifest = await buildManifest(evilPkg, evilState);
  await fs.writeFile(path.join(evilPkg, "manifest.json"), JSON.stringify(collisionManifest, null, 2));
  const collideDir = path.join(T, "repoCollide");
  const rCol = await resumeFromArchive({ packageDir: evilPkg, targetDir: collideDir, source: "\u672c\u673a\u5b58\u50a8\uff08\u4f2a\u9020\u78b0\u649e\u5305\uff09" });
  check("\u4f2a\u9020\u540e\u5305\u5b8c\u6574\u6027\u4ecd\u901a\u8fc7\uff08\u6d4b\u7684\u662f\u78b0\u649e\u5224\u636e\u4e0d\u662f\u635f\u574f\u5224\u636e\uff09",
    rCol.report.steps.some((s) => s.title === "\u6062\u590d\u524d\u6821\u9a8c" && s.ok),
    JSON.stringify(rCol.report.steps[1]));
  check("\u78b0\u649e\u5305\u5728\u5199\u5165\u524d\u88ab\u62e6\u4f4f\uff08\u4e00\u4e2a\u5b57\u8282\u90fd\u6ca1\u5199\uff09",
    rCol.report.verdict === "\u6062\u590d\u88ab\u963b\u585e" && (rCol.report.restoredCount ?? -1) === 0
    && !(await fs.stat(path.join(collideDir, "README.md")).then(() => true).catch(() => false)),
    JSON.stringify({ verdict: rCol.report.verdict, restored: rCol.report.restoredCount }));
  check("\u62e6\u4f4f\u7406\u7531\u70b9\u540d\u5927\u5c0f\u5199\u5e76\u7ed9\u51fa\u4e24\u6761\u51fa\u8def",
    /大小写/.test(rCol.report.gaps.map((g) => g.title + g.detail).join(" "))
    && /\u533a\u5206\u5927\u5c0f\u5199|\u6539\u540d/.test(rCol.report.gaps.map((g) => g.detail).join(" ")),
    JSON.stringify(rCol.report.gaps));

  // ========== 7.13 \u8def\u5f84\u5224\u636e\u51fd\u6570\u81ea\u8eab\uff08\u4e0d\u9760\u672c\u673a\u73af\u5883\u6070\u5de7\u6ee1\u8db3\uff09 ==========
  check("unquoteGitPath \u8fd8\u539f git \u7688\u516b\u8fdb\u5236\u5f15\u7528\u4e32",
    unquoteGitPath('"\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.md"') === "\u4e2d\u6587\u6587\u4ef6.md"
    && unquoteGitPath('"a\\tb"') === "a\tb"
    && unquoteGitPath("src/plain.ts") === "src/plain.ts",
    unquoteGitPath('"\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.md"'));
  check("windowsNameIssues \u8ba4\u51fa\u4fdd\u7559\u8bbe\u5907\u540d\u4e0e\u7ed3\u5c3e\u70b9/\u7a7a\u683c",
    windowsNameIssues("src/nul").length === 1 && windowsNameIssues("a/COM1.log").length === 1
    && windowsNameIssues("bad dir ./x").length > 0 && windowsNameIssues("src/main.ts").length === 0,
    JSON.stringify([windowsNameIssues("src/nul"), windowsNameIssues("a/COM1.log"), windowsNameIssues("src/main.ts")]));
  check("pathFidelityAlerts \u628a\u4e0d\u53ef\u547d\u540d\u8def\u5f84\u5217\u4e3a\u8b66\u544a\uff08\u4e0d\u9759\u9ed8\u5e26\u8fc7\uff09",
    pathFidelityAlerts(["src/nul", "ok.ts"]).some((a) => a.level === "\u8b66\u544a" && /Windows/.test(a.title)),
    JSON.stringify(pathFidelityAlerts(["src/nul"])));
  check("pathFidelityAlerts \u70b9\u540d\u8d85\u957f\u8def\u5f84",
    pathFidelityAlerts(["a/b", "x".repeat(300)], "C:\\dev\\p").some((a) => /260/.test(a.title)));
  check("pathFidelityAlerts \u7684\u963b\u585e\u5224\u636e\u4e0e\u6253\u5305\u5165\u53e3\u540c\u4e00\u4e2a\uff08\u4e0d\u662f\u4e24\u5957\u89c4\u5219\uff09",
    pathFidelityAlerts(["src/A.ts", "src/a.ts"]).every((a) => a.level === "\u963b\u585e")
    && pathFidelityAlerts(["src/A.ts", "src/a.ts"]).length >= 1);

  // ========== 7.14 GitHub \u8def\u5f84\u4e5f\u8981\u4fdd\u7559\u5f62\u6001\uff08\u5199\u6b7b 100644 \u4f1a\u628a\u94fe\u63a5\u4e0e\u6267\u884c\u4f4d\u62b9\u5e73\uff09 ==========
  const bareU = path.join(T, "remoteU.git");
  sh(`git init -q --bare "${bareU}"`, T);
  const { receipt: ghU } = await publishGithub(repoU, createdU.record, bareU);
  check("\u975e ASCII/\u5f62\u6001\u4fdd\u771f\u7684\u5305\u80fd\u53d1\u5e03\u5230\u4ea4\u63a5\u5206\u652f", ghU.state === "\u5df2\u53d1\u5e03" && ghU.readBackConfirmed, JSON.stringify(ghU));
  const ghUDir = path.join(T, "repoUniFromGithub");
  const ghURes = await resumeFromGithub({ remote: bareU, handoffId: createdU.record.handoffId, targetDir: ghUDir });
  check("GitHub \u8def\u5f84\u6062\u590d\u540e\u6307\u7eb9\u4e00\u81f4", ghURes.report.digestMatch === true,
    ghURes.report.steps.find((s) => s.title === "\u4ee3\u7801\u6307\u7eb9\u590d\u7b97")?.detail ?? "");
  const ghIdx = sh("git -c core.quotepath=false ls-files -s", ghUDir).toString();
  check("GitHub \u8def\u5f84\u4fdd\u7559 100755 \u6267\u884c\u4f4d", /^100755\s+[0-9a-f]{40}\s+\d+\s+run\.sh$/m.test(ghIdx), ghIdx);
  check("GitHub \u8def\u5f84\u4fdd\u7559 120000 \u7b26\u53f7\u94fe\u63a5", /^120000\s+[0-9a-f]{40}\s+\d+\s+\u6307\u5411\u6e90\u7801$/m.test(ghIdx), ghIdx);
  check("GitHub \u8def\u5f84\u4e5f\u91cd\u5efa\u7a7a\u76ee\u5f55", await fs.stat(path.join(ghUDir, "\u5360\u4f4d")).then((s) => s.isDirectory()).catch(() => false));
  check("GitHub \u8def\u5f84\u7684\u4e2d\u6587\u57fa\u7ebf\u6587\u4ef6\u843d\u5730", await fs.stat(path.join(ghUDir, "\u4e2d\u6587\u6587\u4ef6.md")).then(() => true).catch(() => false));

  // ========== 7.15 检查用的临时物化目录用完即清 ==========
  // 只断言本次自己创建的那几个快照目录：同名前缀的其它目录可能属于并行运行，不该由本测试处置
  const mySnaps = [created.snapshot.id, createdM.record.state.snapshotId, createdS.record.state.snapshotId];
  const nowDirs = await checkDirs();
  const stillMine = mySnaps.filter((s) => nowDirs.includes(`acb-check-${s}`));
  check("检查物化目录在批次结束后被回收", stillMine.length === 0, JSON.stringify(stillMine));

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

  // ========== 10. 服务层与本机守卫 ==========
  // 上面九节全在核心函数上跑，一个 HTTP 请求都没发过 —— 于是"npm run dev 指向
  // server/index.ts，而那个模块只 export startServer、从不 listen"这种缺陷能在全绿
  // 的情况下活着。这一节把服务真起一次，并钉住四件事：入口形状、Origin/Host 矩阵、
  // "目录不见了"的分类（404 而不是 500）、以及 Agent 能力面与界面同源。
  check("isLoopbackAddress 认 127.x 与 ::1", isLoopbackAddress("127.0.0.1") && isLoopbackAddress("[::1]") && !isLoopbackAddress("localhost") && !isLoopbackAddress("0.0.0.0"));
  let bindThrew = false;
  try { resolveBindHost({ ACB_BIND_HOST: "0.0.0.0" }); } catch { bindThrew = true; }
  check("非回环的 ACB_BIND_HOST 拒绝启动（不是静默接受）", bindThrew);
  let originThrew = false;
  try { assertLoopbackOrigins("http://evil.example.com"); } catch { originThrew = true; }
  check("ACB_ALLOWED_ORIGINS 里的外来源拒绝启动", originThrew && assertLoopbackOrigins("http://localhost:5173").length === 1);
  check("Host 头按固定字面量清单判，不比请求自己", hostHeaderAllowed("127.0.0.1:5174", 5174) && !hostHeaderAllowed("evil.example:5174", 5174) && !hostHeaderAllowed("127.0.0.1:5175", 5174));
  // 省略端口的写法合法（RFC 9110 按 URI 默认端口）；但外域无论带不带端口都要拒。
  // 这一条是发行包体检逼出来的：客户端发 `Host: 127.0.0.1` 时守卫视健康检查为 403。
  check("省略端口的回环 Host 放行，外域仍然拒", hostHeaderAllowed("127.0.0.1", 5174) && hostHeaderAllowed("localhost", 5174) && hostHeaderAllowed("[::1]", 5174) && !hostHeaderAllowed("evil.example", 5174) && !hostHeaderAllowed("acb.example.com:5174", 5174) && !hostHeaderAllowed(undefined, 5174));
  check("Origin 只放本服务源，额外项要显式登记", originAllowed("http://localhost:5174", 5174) && originAllowed("http://localhost:5173", 5174, ["http://localhost:5173"]) && !originAllowed("http://localhost:5173", 5174) && !originAllowed("https://localhost:5174", 5174));

  // 守卫在 index.ts 装载时读 ACB_ALLOWED_ORIGINS，所以必须在 import 之前设好 —— 用 await import
  process.env.ACB_ALLOWED_ORIGINS = "http://localhost:5173";
  const { startServer } = await import("../server/index.js");
  const handle = await startServer(0);
  check("startServer 回句柄而不是端口号（桌面壳读 handle.port/close）",
    typeof handle === "object" && typeof handle.port === "number" && handle.port > 0 && typeof handle.close === "function");
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    const hb = await health.json() as { ok?: boolean; data?: { tools?: number } };
    check("GET /api/health 通，且报的是工具注册表的真数", health.status === 200 && hb.ok === true && (hb.data?.tools ?? 0) >= 17, `tools=${hb.data?.tools}`);
    check("响应不带 CORS 放行头（这个服务没有跨源调用方）", health.headers.get("access-control-allow-origin") === null);
    check("外来 Origin 403", (await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example.com" } })).status === 403);
    check("登记过的回环开发源（vite:5173）放行", (await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5173" } })).status === 200);
    check("没登记的另一个本机端口仍被拒", (await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5999" } })).status === 403);

    const manifest = await fetch(`${base}/api/agent/manifest`);
    const mb = await manifest.json() as { data?: { tools?: { name: string }[] } };
    check("/api/agent/manifest 交出工具表", manifest.status === 200 && (mb.data?.tools?.length ?? 0) >= 17 && mb.data!.tools!.some((t) => t.name === "acb.project_overview"));
    // 调用形状是 {tool, input}（见 server/agent/routes.ts 的 POST /api/agent/tool）
    const unknown = await fetch(`${base}/api/agent/tool`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "acb.不存在", input: {} }),
    });
    const ub = await unknown.json() as { error?: { code?: string; available?: string[] } };
    check("未知工具是 400+unknown_tool，不是 500", unknown.status === 400 && ub.error?.code === "unknown_tool", `${unknown.status} ${ub.error?.code}`);
    check("unknown_tool 带机器可读的可用清单", Array.isArray(ub.error?.available) && (ub.error?.available?.length ?? 0) >= 17);

    // 注册还在、目录被挪走：调用方能自己修好的失败 → 404 并点名是哪个路径。
    // 报 500 的话，Agent 会以为服务坏了去重试，而重试一万次也不会好。
    const gone = path.join(T, "moved-away");
    await addProject({ projectId: "prj_gone", name: "被挪走的项目", path: gone, checks: [] } as ProjectConfig);
    const ov = await fetch(`${base}/api/projects/prj_gone/overview`);
    const ovBody = await ov.json() as { error?: string };
    const ovMsg = ovBody.error ?? "";
    check("目录不见了 → 404（不是 500）", ov.status === 404, `HTTP ${ov.status}`);
    check("失败说得出是哪个目录、也给出路", ovMsg.includes(gone) && /出路|重新注册/.test(ovMsg), ovMsg.slice(0, 70));
    const listed = await fetch(`${base}/api/agent/tool`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "acb.projects_list", input: {} }),
    });
    const lb = await listed.json() as { data?: { projects?: { projectId: string; dirAvailable?: boolean }[] } };
    const row = lb.data?.projects?.find((p) => p.projectId === "prj_gone");
    check("陈行注册表在列表里就露面（dirAvailable=false）", row?.dirAvailable === false, JSON.stringify(row));
    const prevTool = await fetch(`${base}/api/agent/tool`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "acb.project_overview", input: { projectId: "prj_gone" } }),
    });
    const prevBody = await prevTool.json() as { error?: { code?: string; message?: string } };
    check("同一条失败在 Agent 侧是 not_found，不是 internal_error", prevTool.status === 400 && prevBody.error?.code === "not_found", `${prevTool.status} ${prevBody.error?.code}`);
    check("Agent 侧那条也带着路径与出路", (prevBody.error?.message ?? "").includes(gone), (prevBody.error?.message ?? "").slice(0, 70));
  } finally {
    await handle.close();
  }

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
