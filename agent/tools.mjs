#!/usr/bin/env node
/**
 * ACB · Agent 能力注册表的命令行外壳（ESM）
 *
 * 实现只有一份：server/agent/tools.ts（编译产物 dist-server/server/agent/tools.js）。
 * 这个文件**不重写任何 handler** —— 把 handler 复制一份到 .mjs 里，迟早会出现
 * "Agent 看到的数字和界面看到的数字不一样"这种最难查的缺陷。这里做的只有三件事：
 *   1. 优先打 HTTP（服务在跑就走这一条路，与界面共用同一份进程内状态与守卫）；
 *   2. 服务没在跑时，回落到**同一份编译产物**直连本地模块（只读工具也一样读真数据）；
 *      两处都没有就先给出可执行出路，而不是抛一句 MODULE_NOT_FOUND。
 *   3. 给命令行一个自查入口（--list / --manifest / --call / --selftest）。
 *
 * 用法：
 *   node agent/tools.mjs --list
 *   node agent/tools.mjs --manifest
 *   node agent/tools.mjs --call acb.projects_list
 *   node agent/tools.mjs --call acb.project_overview '{"projectId":"prj_x"}'
 *   node agent/tools.mjs --selftest            # 逐个跑只读工具，确认没有假数据
 *
 * 端口与启动：见 agent/README.md 与 agent/launch.json（服务仍是项目自己的 5174，不另起进程）。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_BASE = process.env.AGENT_DEFAULT_BASE || "http://127.0.0.1:5174";

/* ------------------------------------------------------------------ *
 * 注册表来源
 * ------------------------------------------------------------------ */

let cachedRegistry = null;

/** 读同一份编译产物；没有就直接说清要怎么把它造出来。 */
function loadBuiltRegistry() {
  if (cachedRegistry) return cachedRegistry;
  const built = path.join(PROJECT_ROOT, "dist-server", "server", "agent", "tools.js");
  if (!existsSync(built)) return null;
  cachedRegistry = require(built);
  return cachedRegistry;
}

export function baseUrlCandidates() {
  const endpoint = path.join(__dirname, ".endpoint");
  return [
    process.env.AGENT_BASE_URL,
    existsSync(endpoint) ? readFileSync(endpoint, "utf8").trim() : null,
    DEFAULT_BASE,
  ].filter(Boolean);
}

/** 找一个活着的服务地址；都不活着返回 null（调用方据此决定走 HTTP 还是直连模块）。 */
export async function findLiveBase(timeoutMs = 1500) {
  for (const base of baseUrlCandidates()) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return base;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

function tokenHeaders(withBody) {
  const h = withBody ? { "content-type": "application/json" } : {};
  const token = (process.env.ACB_LOCAL_TOKEN ?? "").trim();
  if (token) h["x-acb-token"] = token;
  return h;
}

/** 直连模式所需的 ctx（端口只是给 acb.storage_status 展示用的，按默认值报并说明可能不同） */
function localCtx() {
  return { bootedAt: Date.now(), port: Number(process.env.ACB_PORT ?? 5174) };
}

export async function listTools() {
  const base = await findLiveBase();
  if (base) {
    const r = await fetch(`${base}/api/agent/tools`, { headers: tokenHeaders(false), signal: AbortSignal.timeout(8000) });
    const body = await r.json();
    return body.data;
  }
  const reg = loadBuiltRegistry();
  if (!reg) throw new Error(noRegistryMessage());
  return reg.listAgentTools();
}

function noRegistryMessage() {
  return (
    "既没有一个在跑的服务，也没有编译产物 dist-server/server/agent/tools.js。\n" +
    "  任一条都能解决：\n" +
    "    npm run agent:serve            # 起服务（默认 127.0.0.1:5174），本命令随后自动改走 HTTP\n" +
    "    npx tsc -p tsconfig.server.json # 只要 CLI 用：编译出同一份注册表"
  );
}

export async function getManifest() {
  const base = await findLiveBase();
  if (base) {
    const r = await fetch(`${base}/api/agent/manifest`, { headers: tokenHeaders(false), signal: AbortSignal.timeout(8000) });
    const body = await r.json();
    return { ...body, _via: `${base}/api/agent/manifest` };
  }
  const reg = loadBuiltRegistry();
  if (!reg) throw new Error(noRegistryMessage());
  return {
    ok: true,
    data: {
      project: reg.AGENT_PROJECT_ID,
      version: readPkgVersion(),
      base_url: DEFAULT_BASE,
      agent_api: reg.AGENT_API_VERSION,
      tools: reg.listAgentTools(),
    },
    _via: "本地注册表（服务未启动；起服请用 npm run agent:serve）",
  };
}

function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

/**
 * 调用一个工具。
 * 服务活着 → 走 HTTP（同一份守卫、同一份作业表、同一份存储缓存；这是正路）。
 * 服务没起 → 直连同一份编译产物执行。注意这条路径**绕过了本机守卫**（Host/Origin/令牌都是
 * 网络入口的闸门），但它并没有提权：能跑这条命令的进程本来就有本机用户的文件权限，
 * 与 npm run cli 是同一档。写/执行类工具依旧由注册表里的 confirm 闸门拦着。
 */
export async function callTool(name, input = {}, opts = {}) {
  const base = opts.preferHttp === false ? null : await findLiveBase();
  if (base) {
    const started = Date.now();
    const r = await fetch(`${base}/api/agent/tool`, {
      method: "POST",
      headers: tokenHeaders(true),
      body: JSON.stringify({ tool: name, input }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.ok === false) {
      const e = body?.error ?? {};
      const err = new Error(e.message || `HTTP ${r.status}`);
      err.code = e.code ?? "http_error";
      err.available = e.available;
      err.hint = e.hint;
      throw err;
    }
    return { ...body, _via: `${base}/api/agent/tool`, _ms: Date.now() - started };
  }
  const reg = loadBuiltRegistry();
  if (!reg) throw new Error(noRegistryMessage());
  const t0 = Date.now();
  const r = await reg.executeAgentTool(name, input, localCtx());
  return { ok: true, data: r.data, tool: r.tool, risk: r.risk, ms: Date.now() - t0, _via: "直连本地模块（服务未启动）" };
}

/* ------------------------------------------------------------------ *
 * CLI（输出走 ASCII 转义：这台机器的控制台是 GBK，原样打中文会变成乱码）
 * ------------------------------------------------------------------ */

function ascii(s) {
  return String(s).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function out(s) {
  process.stdout.write(ascii(s) + "\n");
}

async function main(argv) {
  const flag = argv[0];
  if (!flag || flag === "--help" || flag === "-h") {
    out("用法: node agent/tools.mjs --list | --manifest | --call <tool> ['{json}'] | --selftest");
    return 0;
  }

  if (flag === "--list") {
    const tools = await listTools();
    for (const t of tools) out(`${t.name}\t${t.risk}`);
    out(`(共 ${tools.length} 个工具，清单与 GET /api/agent/tools 同源)`);
    return 0;
  }

  if (flag === "--manifest") {
    out(JSON.stringify(await getManifest(), null, 2));
    return 0;
  }

  if (flag === "--call") {
    const name = argv[1];
    if (!name) {
      out("缺少工具名。例：node agent/tools.mjs --call acb.projects_list");
      return 2;
    }
    let input = {};
    if (argv[2]) {
      try {
        input = JSON.parse(argv[2]);
      } catch (e) {
        out(`input 不是合法 JSON：${e.message}`);
        return 2;
      }
    }
    try {
      out(JSON.stringify(await callTool(name, input), null, 2));
      return 0;
    } catch (e) {
      out(`调用失败 [${e.code ?? "error"}] ${e.message}`);
      if (e.hint) out(`  出路：${e.hint}`);
      if (Array.isArray(e.available)) out(`  可用：${e.available.join(", ")}`);
      return 1;
    }
  }

  if (flag === "--selftest") {
    const tools = (await listTools()).filter((t) => t.risk === "read");
    // 需要真实 id 的只读工具：先同一条路拿一个真 id，再拿它去调详情 ——
    // 否则自检报的是"我自己造出来的失败"，而不是工具的问题。
    let projectId = null;
    let handoffId = null;
    try {
      const p = await callTool("acb.projects_list", {});
      const all = p.data?.projects ?? [];
      // 按 dirAvailable 挑一个目录还在的项目：注册表里躺着被移动/改名的旧路径是常态，
      // 直接取 projects[0] 的话，自检报的是"这台机器的注册表有陈行"，而不是工具的问题。
      // 一个可用项目都没有时如实跳过（并在下一行说清是哪些路径不可用），不编 id。
      projectId = all.find((x) => x.dirAvailable)?.projectId ?? null;
      if (!projectId && all.length) {
        out(`NOTE 注册表里 ${all.length} 个项目，目录都不可用，需要项目 id 的只读自检跳过：${(p.data?.unavailable ?? []).join(", ")}`);
      }
      if (projectId) {
        const hs = await callTool("acb.handoffs_list", { projectId, limit: 1 });
        handoffId = hs.data?.rows?.[0]?.handoffId ?? null;
      }
    } catch { /* 空注册表就跳过详情类 */ }
    // 预览恢复需要一个"目标目录"。自检不替用户猜他要把包恢复到哪儿（那等于编一个 id），
    // 而是自己造一个临时空目录、用完即删 —— 这条路径是只读的（一个字节不写用户目录），
    // 但它恰好是整包校验 + 比对那一步唯一能被真正跑起来的入口。
    let targetDir = null;
    if (handoffId) {
      targetDir = await mkdtemp(path.join(os.tmpdir(), "acb-selftest-target-"));
    }
    const inputs = {
      "acb.project_overview": projectId ? { projectId } : null,
      "acb.handoffs_list": projectId ? { projectId, limit: 1 } : null,
      "acb.handoff_preview": projectId ? { projectId } : null,
      "acb.handoff_detail": handoffId ? { handoffId } : null,
      "acb.handoff_integrity": handoffId ? { handoffId } : null,
      "acb.handoff_preview_resume": handoffId && projectId ? { mode: "remote", projectId, handoffId, targetDir } : null,
      "acb.remote_handoffs": null,
      "acb.job_status": null,
    };
    let failed = 0;
    let skipped = 0;
    for (const t of tools) {
      const input = t.name in inputs ? inputs[t.name] : {};
      if (input === null) {
        skipped += 1;
        out(`SKIP ${t.name}  (本机没有可用于这条工具的真实 id —— 跳过而不是编一个)`);
        continue;
      }
      const started = Date.now();
      try {
        const r = await callTool(t.name, input);
        out(`PASS ${t.name}  ${Date.now() - started}ms  payload=${JSON.stringify(r.data ?? null).length}B`);
      } catch (e) {
        failed += 1;
        out(`FAIL ${t.name}  ${e.code ?? ""} ${e.message.split("\n")[0]}`);
      }
    }
    out(
      `只读工具自检：${tools.length - failed - skipped}/${tools.length - skipped} 通过` +
      `（跳过 ${skipped} 条；写/exec/destructive 工具不在自检范围内 —— 它们会改本机状态，必须 confirm）`,
    );
    // 自检自己造的临时目录，用完即删（预览恢复只读，不往里写东西）
    if (targetDir) await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    return failed ? 1 : 0;
  }

  out(`不认识参数 ${flag}；用 --help 看用法`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 用 exitCode 而不是 process.exit()：Windows 上 fetch 的 socket 还在收尾时硬退出会撞
  // libuv 的 UV_HANDLE_CLOSING 断言，而事件循环本来就会自己排空。
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code ?? 0; })
    .catch((e) => {
      out(`异常：${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
}

