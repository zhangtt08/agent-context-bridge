// Verification Module：在快照的独立检查目录中执行已配置检查
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { materialize, Snapshot } from "./capture.js";
import { id } from "./gitutil.js";
import type { VerificationRecord, VerifyResult } from "../../shared/types.js";

const LOG_TAIL = 4000;

export async function runChecks(
  projectPath: string,
  snap: Snapshot,
  checks: { name: string; cmd: string; timeoutMs?: number }[],
  onEach?: (index: number, total: number, name: string) => void,
): Promise<{ records: VerificationRecord[]; checkDir: string }> {
  const checkDir = path.join(os.tmpdir(), `acb-check-${snap.snapshotId}`);
  await fs.rm(checkDir, { recursive: true, force: true });
  await materialize(snap, checkDir);

  const records: VerificationRecord[] = [];
  try {
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i];
      onEach?.(i, checks.length, c.name);
      const startedAt = new Date();
      const rec = await runOne(c, snap, checkDir, startedAt);
      records.push(rec);
    }
  } finally {
    // 检查目录是临时现场，用完就清；清理失败不影响结果，但不能让它长在本机临时目录里
    await fs.rm(checkDir, { recursive: true, force: true }).catch(() => {});
  }
  return { records, checkDir };
}

function runOne(
  c: { name: string; cmd: string; timeoutMs?: number },
  snap: Snapshot,
  checkDir: string,
  startedAt: Date,
): Promise<VerificationRecord> {
  const timeoutMs = c.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const child = exec(c.cmd, { cwd: checkDir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const endedAt = new Date();
      const durationMs = endedAt.getTime() - startedAt.getTime();
      let result: VerifyResult;
      let exitCode: number | null = null;
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (e && e.killed) {
        result = "超时";
      } else if (e && typeof e.code !== "number") {
        result = "执行器错误";
      } else if (e) {
        result = "失败"; exitCode = typeof e.code === "number" ? e.code : null;
      } else {
        result = "通过"; exitCode = 0;
      }
      const logTail = ((stdout || "") + (stderr || "")).slice(-LOG_TAIL);
      resolve({
        checkId: id("chk"), name: c.name, cmd: c.cmd, snapshotId: snap.snapshotId,
        result, exitCode, durationMs,
        startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
        logTail: logTail.trim(),
      });
    });
    void child;
  });
}
