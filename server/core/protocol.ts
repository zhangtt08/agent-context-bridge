// Protocol Module：Project State 组装、校验、Markdown 接手入口渲染
import type { HandoffRecord, ProjectState, VerificationRecord, ResumeReport } from "../../shared/types.js";

export function validateState(s: ProjectState): string[] {
  const errs: string[] = [];
  if (s.protocolVersion !== "0.1") errs.push("协议版本必须为 0.1");
  if (!s.projectId || !s.taskId || !s.snapshotId || !s.handoffId) errs.push("缺少必需身份字段");
  if (!s.sourceDigest.startsWith("src_sha256:")) errs.push("source_digest 格式非法");
  // 不变量 1：一个 State 只绑定一个 Snapshot（字段唯一性已隐含）
  // 不变量 9：代码可恢复 / 测试通过 / 任务完成 分别表达
  if (s.verifications.length > 0 && s.verifications.some((v) => !v.snapshotId)) {
    errs.push("验证记录必须绑定快照");
  }
  // 声明不得表述为已验证
  for (const c of s.claims) {
    if (/已验证|测试已通过/.test(c.text) && !c.evidence) {
      errs.push(`声明"${c.text.slice(0, 20)}…"使用了验证性表述但未关联证据`);
    }
  }
  return errs;
}

/** 按阅读顺序渲染接手入口 Markdown（由结构化状态生成，修改状态须重新生成） */
export function renderEntryMarkdown(rec: HandoffRecord): string {
  const s = rec.state;
  const L: string[] = [];
  L.push(`# 接手入口 · ${s.taskName}`, "");
  L.push(`> 交接 ${s.handoffId} · 快照 ${s.snapshotId} · 项目 ${s.projectName}（${s.projectId}）`);
  L.push(`> 协议 ${s.protocolVersion} · 生成于 ${s.createdAt} · 工具 ${s.toolVersion}`);
  if (s.parentHandoffIds.length) L.push(`> 接续自：${s.parentHandoffIds.join("、")}`);
  L.push("");

  L.push("## 一、任务目标与验收", "", `- 任务：${s.taskName}（${s.taskId}）`, "- 验收条件：见项目配置或用户输入；未提供时如实记录为待确认。", "");

  L.push("## 二、代码对应关系", "");
  L.push(`- 快照 \`${s.snapshotId}\`，基线 \`${s.baseline.branch ?? "(无分支)"} @ ${s.baseline.commit?.slice(0, 7) ?? "(无提交)"}\``);
  L.push(`- 代码指纹：\`${s.sourceDigest.split(" ")[0]}\``);
  L.push(`- 纳入范围：${s.changes.length} 项改动（${s.changes.filter((c) => c.staged).length} 项含暂存材料）`);
  const adds = s.changes.filter((c) => c.status === "added").length;
  const dels = s.changes.filter((c) => c.status === "deleted").length;
  const rens = s.changes.filter((c) => c.status === "renamed").length;
  L.push(`- 其中新增 ${adds} · 删除 ${dels} · 重命名 ${rens}`);
  if (s.excluded.length) L.push(`- 排除：${s.excluded.join("、")}`);
  L.push("");

  L.push("## 三、已有证据与局限", "");
  if (s.verifications.length === 0) {
    L.push("- 本次未执行任何检查（状态：未执行）。", "");
  } else {
    for (const v of s.verifications) {
      const line = v.result === "通过"
        ? `- [通过] ${v.name}（退出码 ${v.exitCode}，${v.durationMs}ms）`
        : v.result === "失败"
          ? `- [失败] ${v.name}（退出码 ${v.exitCode}）`
          : `- [${v.result}] ${v.name}`;
      L.push(line);
    }
    L.push("", "以上为源端历史证据，仅证明该检查在该快照与环境上的结果；接收端未复验前保持未验证状态。", "");
  }

  L.push("## 四、未完成与阻塞", "");
  const openClaims = s.claims.filter((c) => !c.evidence);
  L.push(...(openClaims.length ? openClaims.map((c) => `- 待确认：${c.text}`) : ["- 无待确认声明。"]));
  if (s.recoveryRequirements.length) {
    L.push("", "接收端需补齐：", ...s.recoveryRequirements.map((r) => `- ${r}`));
  }
  L.push("");

  L.push("## 五、关键决策与声明", "");
  L.push(...(s.claims.length ? s.claims.map((c) => `- [${c.sessionId} @ ${c.at}] ${c.text}${c.evidence ? `（证据：${c.evidence}）` : ""}`) : ["- 无声明记录。"]));
  L.push("");

  L.push("## 六、建议下一步", "");
  const next = s.claims.find((c) => c.nextStep)?.nextStep;
  L.push(next ? `- ${next}` : "- 无；请接手 Agent 阅读状态后自行规划。");
  L.push("");

  L.push("## 七、相关文件入口", "", `- 项目状态：\`acb-state/project-state.json\``, `- 包清单：\`manifest.json\``, "");
  return L.join("\n");
}

export function renderReportMarkdown(r: ResumeReport): string {
  const L: string[] = [];
  L.push(`# 恢复报告 · ${r.handoffId}`, "");
  L.push(`> 总体判定：**${r.verdict}** · 代码恢复：${r.codeRestored ? "成功" : "失败"} · 指纹比对：${r.digestMatch === null ? "未执行" : r.digestMatch ? "一致 ✓" : "不一致 ✗"}`);
  L.push(`> 目标目录：\`${r.targetDir}\` · 恢复时间 ${r.at}`, "");
  L.push("## 恢复步骤", "", ...r.steps.map((s) => `- [${s.ok ? "x" : " "}] ${s.title} — ${s.detail}`), "");
  if (r.gaps.length) {
    L.push("## 差异与补齐动作", "", ...r.gaps.map((g) => `- ${g.blocking ? "[阻塞]" : "[提示]"} [${g.kind}] ${g.title} — ${g.detail}`), "");
  }
  return L.join("\n");
}

/** 观测/验证/声明的事实分离校验：验证结果不得从声明推断 */
export function summarizeVerify(records: VerificationRecord[]): { pass: number; fail: number; other: number } {
  const pass = records.filter((v) => v.result === "通过").length;
  const fail = records.filter((v) => v.result === "失败" || v.result === "超时" || v.result === "执行器错误").length;
  return { pass, fail, other: records.length - pass - fail };
}
