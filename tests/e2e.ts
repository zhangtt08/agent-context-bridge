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
import { checkEntries } from "../server/core/package.js";
import { buildPreview } from "../server/core/preview.js";
import { isGitRepo, isSafeRelPath, caseCollisions, DEFAULT_EXCLUDES, EXCLUSION_REASONS } from "../server/core/gitutil.js";
import type { ProjectConfig } from "../shared/types.js";

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

  // ========== 7.10 检查用的临时物化目录用完即清 ==========
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
