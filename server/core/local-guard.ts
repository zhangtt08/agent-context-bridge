// 本机回环守卫：绑定地址 + Host/Origin 校验 + 可选本机令牌
//
// 为什么需要这一层（2026-10-05 验收判为 BLOCKER）：ACB 的 API 没有任何鉴权，而它最核心的
// 能力之一就是执行「项目设置里配置的命令」（server/core/verify.ts 的 exec(c.cmd)）。
// 一旦服务监听在非回环地址上，同一局域网里任何一台机器都能
// PUT /api/projects/:id/config 写入 checks[].cmd，再 POST /api/projects/:id/handoffs 触发它
// —— 那是一台无人值守的远程命令执行器。
//
// 闸门（顺序即优先级）：
//   1. 绑定地址：只绑 127.0.0.1。ACB_BIND_HOST 可覆盖，但值必须是字面回环地址，否则拒绝启动。
//   2. Host 头：只允许 127.0.0.1:<port> / localhost:<port> / [::1]:<port>。
//      这是 DNS 重绑定防线，所以判据是一份**固定字面量清单**，绝不拿请求自己的 Host 当基准
//      （用请求的 Host 当基准等于没有检查：evil.example 解析到 127.0.0.1 之后，
//        Host 就是 evil.example:5174，"看起来"自洽，而浏览器眼里它是另一个源）。
//   3. Origin/Referer：存在时必须也指向同一个回环 host:port，否则 403。
//      回环绑定挡住了"别的机器直接连"，但本机里别的网页（另一个 localhost 端口上的应用）
//      仍然能对这里发 fetch —— 那是 CSRF，Origin 检查堵的就是这一条。
//   4. 令牌（可选）：ACB_LOCAL_TOKEN 一旦设置，所有非只读请求必须带 x-acb-token。
//      用于"确实要让本机另一个进程写"的场景，而不是把服务开给网络。
//
// 一律不回 `Access-Control-Allow-Origin`：这个服务没有跨源调用方。浏览器能用它是因为
// 前端与 API 同源（vite 的 /api 代理、桌面壳的 loadURL 都指回这个端口）。
import { timingSafeEqual, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/** 默认端口（ACB_PORT 未设置时使用）；Host/Origin 校验允许下面三种回环写法 */
export const DEFAULT_PORT = 5174;

/** Host/Origin 里认作"本服务自己"的回环写法 */
const LOOPBACK_HOST_FORMS = ["127.0.0.1", "localhost", "[::1]"];

/** 字面回环地址：127.0.0.0/8 与 ::1。localhost 是主机名不是地址，按地址判时不算。 */
export function isLoopbackAddress(raw: string): boolean {
  const s = raw.trim().replace(/^\[|\]$/g, "");
  if (s === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

/**
 * 解析要绑定的地址。ACB_BIND_HOST 只用于"换一种回环写法"（::1、127.0.0.2 之类），
 * 任何非回环值一律拒绝启动并说清为什么 —— 静默接受 0.0.0.0 就是把 RCE 摆到局域网里。
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.ACB_BIND_HOST ?? "").trim();
  if (!raw) return "127.0.0.1";
  if (isLoopbackAddress(raw)) return raw.replace(/^\[|\]$/g, "");
  throw new Error(
    `ACB_BIND_HOST="${raw}" 不是回环地址，ACB 拒绝以此启动。` +
    `原因：本服务的检查功能会执行项目里配置的命令，绑到非回环地址等于把远程命令执行开放给整个局域网。` +
    `出路：删掉 ACB_BIND_HOST（默认只监听 127.0.0.1），或改成 127.0.0.1 / ::1；` +
    `要跨电脑交接请用「发布到 GitHub 交接分支」或「导出本地文件」，那不是开放 API。`,
  );
}

/** Host 头拆成 [host, port|undefined]；IPv6 字面量 [::1]:5174 的方括号保留在 host 里 */
function splitHost(header: string): [string, string | undefined] {
  const s = header.trim().toLowerCase();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end === -1) return [s, undefined];
    const host = s.slice(0, end + 1);
    const rest = s.slice(end + 1);
    return [host, rest.startsWith(":") ? rest.slice(1) : undefined];
  }
  const i = s.lastIndexOf(":");
  if (i > 0 && /^\d+$/.test(s.slice(i + 1))) return [s.slice(0, i), s.slice(i + 1)];
  return [s, undefined];
}

/** Host 头是否在允许的回环 host:port 清单里（清单是字面量，不是"和请求自己比"） */
export function hostHeaderAllowed(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const [hostForm, hp] = splitHost(header);
  const name = hostForm.replace(/^\[|\]$/g, "");
  const hostOk = LOOPBACK_HOST_FORMS.includes(hostForm) || isLoopbackAddress(name);
  // 不带端口的 Host 头是合法的（RFC 9110：省略就按 URI 的默认端口）。
  // 因为"没写端口"而拒它会打断真实的本机客户端 —— 发行包体检就是这么红的：
  // 客户端发 `Host: 127.0.0.1`，服务在 5085。防 rebinding 靠的是 host 必须是
  // 回环字面量，与那一段端口在不在无关；所以**写明了别的端口仍然拒**。
  return hostOk && (hp === undefined || hp === String(port));
}

function expectedOrigins(port: number): string[] {
  return LOOPBACK_HOST_FORMS.map((h) => `http://${h}:${port}`);
}

/**
 * Origin/Referer 是否指向本服务自己的回环源。接受带路径的 Referer（比的是 URL 的 origin 部分）。
 * extra 来自 ACB_ALLOWED_ORIGINS，启动期已被 assertLoopbackOrigins 限定为回环源，
 * 所以这份清单里不可能出现 evil.example。
 */
export function originAllowed(value: string | undefined, port: number, extra: string[] = []): boolean {
  if (!value) return true;                      // 没有 Origin/Referer：curl、CLI、桌面壳顶层导航
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;                                // 畸形 Origin 一律按不可信处理
  }
  if (url.protocol !== "http:") return false;    // https 回环源起不来这个服务，出现在这里就是伪造
  const origin = url.origin.replace(/^\[|\]$/g, "");
  const form = url.hostname === "::1" ? `[${url.hostname}]` : url.hostname;
  if (!(LOOPBACK_HOST_FORMS.includes(form) || isLoopbackAddress(url.hostname))) return false;
  const portOk = url.port === String(port);
  return portOk || extra.includes(origin) || extra.includes(url.origin);
}

/**
 * ACB_ALLOWED_ORIGINS 的启动期校验：只准加回环来源。
 * 留这个口子是因为开发模式的 vite 代理端口（5173）与 API 端口（5174）不同，
 * 但"能加任意源"和"没有这道检查"是同一件事，所以非回环的一律拒绝启动。
 */
export function assertLoopbackOrigins(csv: string | undefined): string[] {
  const list = (csv ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const raw of list) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`ACB_ALLOWED_ORIGINS 里的「${raw}」不是合法 URL，拒绝启动`);
    }
    if (!(isLoopbackAddress(url.hostname) || url.hostname === "localhost" || url.hostname === "::1")) {
      throw new Error(
        `ACB_ALLOWED_ORIGINS 里的「${raw}」不是回环来源，拒绝启动：` +
        `这一项只用于放行本机其它端口的开发代理，放行外部源等于关掉 Origin 检查。`,
      );
    }
  }
  return list;
}

/** 定时安全比较：两边各自哈希成固定长度 —— 长度不同也不提前返回，且不抛 unequal length */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function forbidden(res: Response, code: string, message: string): void {
  res.status(403).json({ ok: false, error: { code, message } });
}

export interface GuardConfig {
  /** 实际监听端口（绑 0 时由 startServer 回填），用 getter 而不是启动时的快照 */
  port: () => number;
  /** 额外放行的回环源（启动期已校验） */
  allowedOrigins?: string[];
  /** 令牌；undefined/空串表示不启用 */
  token?: string | undefined;
}

/** 只读方法：GET/HEAD 不改状态，令牌只管写 */
const READONLY_METHODS = new Set(["GET", "HEAD"]);

/**
 * 本机守卫中间件：挂在**所有**路由之前（含静态文件与 SPA 回退），
 * 否则绕过守卫的入口就是那条静态资源路径。
 */
export function localGuard(cfg: GuardConfig) {
  return function guard(req: Request, res: Response, next: NextFunction): void {
    const port = cfg.port();
    const extra = cfg.allowedOrigins ?? assertLoopbackOrigins(process.env.ACB_ALLOWED_ORIGINS);
    const token = cfg.token ?? process.env.ACB_LOCAL_TOKEN ?? "";

    if (!hostHeaderAllowed(req.headers.host, port)) {
      forbidden(
        res,
        "forbidden_host",
        `Host 头「${req.headers.host ?? "(缺失)"}」不是本机回环地址（只接受 127.0.0.1${port ? `:${port}` : ""} / localhost / [::1]，端口可省略）。` +
        `这一条挡的是 DNS 重绑定：域名解析到 127.0.0.1 之后请求确实打在回环上，但它来自另一个源。` +
        `出路：直接用 http://127.0.0.1:${port}/ 访问；要跨电脑交接请用「发布到 GitHub 交接分支」或「导出本地文件」。`,
      );
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === "string" && origin && !originAllowed(origin, port, extra)) {
      forbidden(
        res,
        "forbidden_origin",
        `Origin「${origin}」不是本服务自己的回环源（允许：${expectedOrigins(port).join(" / ")}）。` +
        `这是跨站请求伪造防线：另一个 localhost 端口上的页面也不能改本机项目状态。` +
        `出路：在同源页面里调用；开发模式把代理端口加进 ACB_ALLOWED_ORIGINS（只接受回环源）。`,
      );
      return;
    }

    const referer = req.headers.referer ?? req.headers.referrer;
    const ref = Array.isArray(referer) ? referer[0] : referer;
    if (typeof ref === "string" && ref && !originAllowed(ref, port, extra)) {
      forbidden(res, "forbidden_origin", `Referer「${ref}」不是本机回环来源，已拒绝。`);
      return;
    }

    if (token && !READONLY_METHODS.has(req.method.toUpperCase())) {
      const raw = req.headers["x-acb-token"];
      const provided = Array.isArray(raw) ? raw[0] : raw;
      if (!tokenMatches(provided, token)) {
        forbidden(
          res,
          "unauthorized",
          `服务设置了 ACB_LOCAL_TOKEN：${req.method} 请求必须带请求头 x-acb-token 且值与令牌一致。` +
          `出路：把令牌放进调用方环境变量（ACB_LOCAL_TOKEN），不要把它写进代码或交接包。`,
        );
        return;
      }
    }

    next();
  };
}
