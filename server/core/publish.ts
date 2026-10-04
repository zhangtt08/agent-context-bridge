// 发布流程：REST 路由（POST /api/handoffs/:id/publish）与 Agent 工具（acb.handoff_publish）
// 共用这一份实现。发布语义（先完整生成、再暴露引用、再读取确认、幂等）留在 transport 里，
// 这里只负责"找到那条交接 → 选适配器 → 把回执记进 record 并落盘"。
import path from "node:path";
import os from "node:os";
import { listProjects, getHandoffRecord, saveHandoffRecord } from "./store.js";
import { publishLocal, publishGithub } from "./transport.js";
import { assertNoControl } from "./remote-policy.js";
import type { HandoffRecord, PublicationReceipt } from "../../shared/types.js";

export interface PublishOutcome {
  receipt: PublicationReceipt;
  record: HandoffRecord;
  projectName: string;
}

/** 未找到交接时抛这个类型，HTTP 层折 404、Agent 层折 not_found，不靠字符串匹配 */
export class HandoffNotFound extends Error {}

/**
 * 发布一条交接。
 * @param target  local = 导出自包含文件（U 盘路径）；github = 推专用交接分支
 * @param remote  github 路径的远端；留空用项目设置里的 githubRemote
 * @param outPath local 路径的输出文件；留空落到 ~/Downloads/acb-<id>.acb.tar.gz
 */
export async function publishHandoff(
  handoffId: string,
  target: "local" | "github",
  remote?: string,
  outPath?: string,
): Promise<PublishOutcome> {
  const projects = await listProjects();
  for (const p of projects) {
    const rec = await getHandoffRecord(p.path, handoffId);
    if (!rec) continue;
    let receipt;
    if (target === "github") {
      const r = remote ?? p.githubRemote;
      if (!r) {
        throw new Error("未配置 GitHub 远端：在项目设置里填一个已存在的仓库地址（git ls-remote 能列出来的那个），或改用「导出本地文件」走 U 盘路径");
      }
      ({ receipt } = await publishGithub(p.path, rec, assertNoControl(r, "remote")));
    } else {
      const out = (outPath?.trim() || path.join(os.homedir(), "Downloads", `acb-${rec.handoffId}.acb.tar.gz`));
      ({ receipt } = await publishLocal(rec, assertNoControl(out, "outPath")));
    }
    rec.publications.push(receipt);
    await saveHandoffRecord(p.path, rec);
    return { receipt, record: rec, projectName: p.name };
  }
  throw new HandoffNotFound(`交接不存在：${handoffId}（确认本机注册表里还有这个项目；跨电脑请用交接文件或 GitHub 交接分支恢复）`);
}
