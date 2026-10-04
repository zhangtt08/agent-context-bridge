#!/usr/bin/env node
// MCP (Model Context Protocol) stdio 桥 —— personal-agent-hub 标准实现（模板复制，逻辑不动）。
// 用法：node <project>/agent/mcp-server.mjs
// 逻辑：读 agent/.endpoint（或 AGENT_BASE_URL）；不通则按 agent/launch.json 登记的命令自动拉起本地服务。
//
// 相对模板只改了两处，且都是 ACB 自己的安全形状：
//   1. 端口不写死：ready_port 缺失时直接报错，而不是回落到某个"别的项目的默认端口"；
//   2. 本机令牌：ACB 服务设了 ACB_LOCAL_TOKEN 时，非只读的 tools/call 必须带 x-agent-token，
//      否则会被 server/core/local-guard.ts 判 403。桥把同一个环境变量透传过去，不新存一份。
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROTOCOL = '2.2.0';
// 版本只有一个来源：package.json（与 /api/health、exe 元数据同一个）。写死一个数字
// 的话，桥自己报的版本和服务报的版本迟早分叉 —— 而那正是"看起来两个都对"的缺陷形状。
const appVersion = (() => {
  try {
    const j = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    if (j.name === 'acb' && typeof j.version === 'string') return j.version;
  } catch { /* 读不到就退回未知，不硬编一个看起来像真的号 */ }
  return 'unknown';
})();
const SERVER_INFO = { name: path.basename(PROJECT_ROOT) + '-agent-api', version: appVersion };

const log = (...a) => process.stderr.write(`[mcp] ${a.join(' ')}\n`);

function endpointFile() {
  const p = path.join(__dirname, '.endpoint');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

function headers(withBody) {
  const h = withBody ? { 'content-type': 'application/json' } : {};
  const token = (process.env.ACB_LOCAL_TOKEN ?? '').trim();
  if (token) h['x-agent-token'] = token;
  return h;
}

async function rpc(base, method, params) {
  const isList = method === 'tools/list';
  const res = await fetch(`${base}/api/agent/${isList ? 'tools' : 'tool'}`, {
    method: isList ? 'GET' : 'POST',
    headers: headers(!isList),
    body: isList ? undefined : JSON.stringify(params),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

async function ensureBase() {
  const candidates = [process.env.AGENT_BASE_URL, endpointFile(), process.env.AGENT_DEFAULT_BASE].filter(Boolean);
  for (const base of candidates) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return base;
    } catch { /* 继续尝试 */ }
  }
  // 自动拉起：约定 agent/launch.json = {"command":"node","args":[...],"ready_port":5174}
  const launchFile = path.join(__dirname, 'launch.json');
  if (!existsSync(launchFile)) throw new Error(`Agent 服务未启动且缺少 ${launchFile}；请先运行 npm run agent:serve`);
  const spec = JSON.parse(readFileSync(launchFile, 'utf8'));
  if (!Number.isInteger(spec.ready_port)) {
    throw new Error(`${launchFile} 缺少整数 ready_port —— 端口不能靠猜，请写项目实际监听的那个（ACB 默认 5174）`);
  }
  const child = spawn(spec.command, spec.args, { cwd: PROJECT_ROOT, stdio: 'ignore', detached: true, shell: false });
  child.unref();
  const port = spec.ready_port;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    for (let p = port; p < port + 12; p++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) });
        if (r.ok) return `http://127.0.0.1:${p}`;
      } catch { /* 未就绪 */ }
    }
  }
  throw new Error('自动拉起 Agent 服务超时（30s）');
}

let BASE = null;

function msg(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return msg(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return msg(id, {});
  if (method === 'tools/list') {
    BASE = BASE || await ensureBase();
    const body = await rpc(BASE, 'tools/list');
    return msg(id, { tools: body.data.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: t.risk === 'read', destructiveHint: false, openWorldHint: false } })) });
  }
  if (method === 'tools/call') {
    BASE = BASE || await ensureBase();
    try {
      const body = await rpc(BASE, 'tools/call', { tool: params.name, input: params.arguments || {} });
      return msg(id, { content: [{ type: 'text', text: JSON.stringify(body.data, null, 2) }], isError: false });
    } catch (e) {
      return msg(id, { content: [{ type: 'text', text: `调用失败：${e.message}` }], isError: true });
    }
  }
  return err(id, -32601, `不支持的方法：${method}`);
}

let buf = '';

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { write(err(null, -32700, 'parse error')); continue; }
    // 响应是异步的。切勿在此 process.exit()：stdout 接管道时写是异步缓冲的，
    // 立即退出会丢掉尚未 flush 的 tools/list、tools/call 响应。让事件循环自然排空。
    handle(req).then((out) => { if (out) write(out); })
      .catch((e) => write(err(req.id, -32603, e.message)));
  }
});
log(`bridge ready for ${PROJECT_ROOT}`);
