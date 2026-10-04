#!/usr/bin/env node
/**
 * 发行包体检（scripts/verify-release.mjs）—— 只读，一个字节都不写 release/。
 *
 * 为什么需要这一条：修好的代码躺在源码里不等于用户双击的那个 ACB.exe 修好了。
 * 本轮验收就撞过这件事（release/ 里的包是几天前打的，server/ 与 agent/ 的改动
 * 一个都没进去）。这个脚本把"包还在、包是新的、包里那份真能起来回答问题"
 * 三件事量成退出码，而不是靠人记。
 *
 * 用法：npm run verify          # 结构 + 新鲜度 + 起包内服务端实测
 *      npm run verify -- --quick  # 跳过运行时冒烟（只要结构与新鲜度）
 *
 * 失败就说得出差在哪一格，并给出对应出路；不会为了让它绿而放宽判据。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = path.join(ROOT, "release", "ACB-win64");
const APP = path.join(RELEASE, "resources", "app");
const quick = process.argv.includes("--quick");

let failed = 0;
let stale = false; // 包比源码旧 —— 后面几条多半是同一个成因，别让它们被读成五个独立缺陷
const ok = (name, extra = "") => console.log(`  ok  ${name}${extra ? "  " + extra : ""}`);
const bad = (name, why, remedy) => {
  failed++;
  console.log(`FAIL  ${name}\n      原因：${why}`);
  if (remedy) console.log(`      出路：${remedy}`);
};

/** 包里必须存在的文件（按 pack-desktop.sh 的装配清单，缺一个就是包不完整） */
const REQUIRED = [
  "ACB.exe",
  "resources/app/main.cjs",
  "resources/app/preload.cjs",
  "resources/app/server.cjs",
  "resources/app/cli.cjs",
  "resources/app/package.json",
  "resources/app/dist/index.html",
  "resources/app/icon.ico",
  "locales/zh-CN.pak",
  "locales/en-US.pak",
];

function mtimeMs(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/** 递归取一棵树里最新的 mtime（源码的"最后改动时刻"） */
function newest(dir, skip = new Set()) {
  let t = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p, skip) : mtimeMs(p));
  }
  return t;
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { host: "127.0.0.1", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(15_000, () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

async function main() {
  console.log("ACB 发行包体检：", RELEASE);

  // ---- 1. 包结构 ----
  if (!existsSync(RELEASE)) {
    bad("发行目录存在", "release/ACB-win64 不在。", "bash scripts/pack-desktop.sh（即 npm run package）");
    return finish();
  }
  ok("发行目录存在");
  for (const rel of REQUIRED) {
    const p = path.join(RELEASE, rel);
    if (existsSync(p) && statSync(p).size > 0) continue;
    bad(`${rel} 就位`, existsSync(p) ? "文件是 0 字节" : "文件不存在", "npm run package 重打一次");
  }
  if (failed === 0) ok(`${REQUIRED.length} 个必需文件都在且非空`);
  // default_app.asar 在的话，Electron 会显示它自己的欢迎页而不是本软件
  if (existsSync(path.join(RELEASE, "resources/default_app.asar"))) {
    bad("未残留 default_app.asar", "它还在就意味着双击看到的是 Electron 默认页。", "重跑打包脚本的第 4 步");
  } else ok("未残留 default_app.asar");

  // ---- 2. 新鲜度：包里那份服务端是不是最新的源码 ----
  const srcTrees = ["server", "shared", "src", "desktop", "build"];
  const bundled = path.join(APP, "server.cjs");
  const bundleT = mtimeMs(bundled);
  const newestSrc = Math.max(...srcTrees.map((d) => newest(path.join(ROOT, d), new Set(["node_modules"]))), mtimeMs(path.join(ROOT, "package.json")));
  if (!bundleT) bad("包内服务端可读", "server.cjs 取不到 mtime。", "重跑打包");
  else if (newestSrc > bundleT) {
    const ageH = ((newestSrc - bundleT) / 3600_000).toFixed(1);
    stale = true;
    bad(
      "包不比源码旧",
      `源码最后改动比包内 server.cjs 新 ${ageH} 小时 —— 这些改动还没进用户双击的那个 exe。`,
      "npm run package（会先跑 npm run build，再重打 bundle）",
    );
  } else ok("包不比源码旧", `（server.cjs 落后于源码 0，差 ${((bundleT - newestSrc) / 86_400_000).toFixed(1)} 天）`);

  // 版本号三处一致：包里的 app/package.json 与仓库 package.json
  const repoV = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const appV = JSON.parse(readFileSync(bundled.replace(/server\.cjs$/, "package.json"), "utf8")).version;
  if (repoV !== appV) bad("版本号一致", `仓库 package.json 是 ${repoV}，包内是 ${appV}。`, "打包脚本里把版本改成同一个来源");
  else ok("版本号一致", repoV);

  if (quick) { ok("--quick：跳过运行时冒烟"); return finish(); }

  // ---- 3. 起包内那份服务端，实测它真能回答（含本机守卫）----
  // ACB_HOME 指到临时目录：体检绝不能往用户 ~/.acb 里写东西。
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acb-verify-home-"));
  const prevHome = process.env.ACB_HOME;
  process.env.ACB_HOME = home;
  try {
    const mod = require(bundled);
    if (typeof mod.startServer !== "function") {
      bad("包内服务端导出 startServer", "require 出来没有 startServer —— 桌面壳就是这么起服务的。", "看 desktop/main.cjs 与 server/index.ts 的导出");
    } else {
      const handle = await mod.startServer(0);
      // 形状判据：新版 startServer 回 { host, port, server, close }，旧版只回端口号。
      // 桌面壳读的是 handle.port —— 旧包 + 新壳 = 窗口打到 http://127.0.0.1:undefined，
      // 而这件事只有把包真起一次才看得见（typecheck 与单测都看不见装配两边的形状）。
      const legacyShape = typeof handle === "number";
      const port = legacyShape ? handle : handle?.port;
      if (legacyShape) {
        bad(
          "包内 startServer 的返回形状",
          "它回的是一个端口号（旧形状），而 desktop/main.cjs 读的是 handle.port。",
          "npm run package 重打（源码已改成返回句柄）",
        );
      } else ok("包内 startServer 返回句柄（与桌面壳同一个形状）");
      if (!port) throw new Error("拿不到监听端口，冒烟无法继续");
      const health = await getJson(`http://127.0.0.1:${port}/api/health`, {});
      if (health.status === 200 && JSON.parse(health.body).ok) ok("包内服务端起得来并回答 /api/health", `:${port}`);
      else bad("包内服务端回答 /api/health", `HTTP ${health.status} ${health.body.slice(0, 120)}`);

      const man = await getJson(`http://127.0.0.1:${port}/api/agent/manifest`, {});
      const tools = man.body.startsWith("{") ? JSON.parse(man.body).data?.tools?.length ?? 0 : 0;
      if (man.status === 200 && tools > 0) ok("包内 Agent 能力面可用", `${tools} 个工具`);
      else bad("包内 Agent 能力面可用", `HTTP ${man.status}，tools=${tools}（为 0 就是界面能用、Agent 读不到东西）`);

      // 守卫必须在包里生效：伪造 Origin 要被拒，不然"只监听回环"这件事少了一半
      const evil = await getJson(`http://127.0.0.1:${port}/api/health`, { origin: "https://evil.example.com" });
      if (evil.status === 403) ok("包内本机守卫拒外来 Origin");
      else bad("包内本机守卫拒外来 Origin", `HTTP ${evil.status}（期望 403）`, "检查 server/core/local-guard.ts 是否进了 bundle");

      if (handle && typeof handle.close === "function") await handle.close();
    }
  } catch (e) {
    bad("包内服务端起得来", String(e?.message ?? e), "这份 bundle 可能是旧装配或坏了；npm run package 重打");
  } finally {
    if (prevHome === undefined) delete process.env.ACB_HOME;
    else process.env.ACB_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
  return finish();
}

function finish() {
  if (failed) {
    console.log(`\n体检结果: ${failed} 项不合格（只读检查，release/ 一个字节没动）`);
    if (stale) console.log("注意：这个包比源码旧，上面「形状/端点/守卫」几条很可能是同一个成因 —— 先 npm run package 重打，再跑一次 npm run verify 看还剩几条。");
  } else console.log("\n体检结果: 全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("体检脚本自己失败了:", e);
  process.exit(2);
});
