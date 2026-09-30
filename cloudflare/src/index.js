/* SenseNova Studio —— Cloudflare Worker 代理
 *
 * 为什么需要它
 *   商汤接口对浏览器的 CORS preflight 直接返回 404，且响应缺
 *   Access-Control-Allow-Methods / Allow-Headers，浏览器会拒绝真实请求。
 *   所以前端永远不直连商汤，而是走本 Worker 转发：
 *
 *       手机浏览器  ──>  https://<subdomain>.workers.dev  ──>  https://token.sensenova.cn/v1
 *
 * 部署后前端与 API 同源，无需任何 CORS 头（本地 server.py 版仍保留 CORS，两种模式互不干扰）。
 *
 * 路由
 *   /api/models               GET   -> /v1/models
 *   /api/images/generations   POST  -> /v1/images/generations
 *   /api/images/edits         POST  -> /v1/images/edits
 *   /api/download?url=...     GET   代理下载上游临时直链（带 SSRF 防护）
 *   /api/health               GET   健康检查
 *   其他所有路径               -> 静态资源（assets，404 时回落 index.html）
 *
 * 安全
 *   - Key 由前端每次请求通过 Authorization 头带过来，Worker 不做任何持久化，也不落日志
 *   - /api/download 有 SSRF 防护，避免这个代理被当作内网探测跳板
 *   - 上游请求头只白名单透传，避免把请求体里的 base64 参考图回显出去
 *
 * 超时
 *   4K 单张实测约 114s，这里留 10 分钟余量。Workers 无 wall-clock 限制，
 *   这段等待属于 I/O 而非 CPU 消耗，不计入免费版的 10ms CPU 配额。
 */

const UPSTREAM_HOST = "https://token.sensenova.cn";
const API_PREFIX = "/v1";
const TIMEOUT_MS = 10 * 60 * 1000;
const APP_NAME = "SenseNova Studio";
const VERSION = "1.1.0";
const USER_AGENT = `${APP_NAME}/${VERSION}`;

// 前端路径 -> 上游路径
const PROXY = {
  "/api/models":             { path: "/models",             method: "GET" },
  "/api/images/generations": { path: "/images/generations", method: "POST" },
  "/api/images/edits":       { path: "/images/edits",       method: "POST" },
};

// 只有这些响应头可以透传。
// 故意排除 content-encoding / content-length：Worker 取到上游 body 时已经完成解压，
// 若原样带回 content-encoding，浏览器会二次解压而失败；流式转发下长度也未知。
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "content-disposition",
  "expires",
  "etag",
  "last-modified",
];

const MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const BLOCKED_SUFFIX = [".local", ".internal", ".home.arpa", ".lan"];

/* ============================================================
   入口
   ============================================================ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") return health(env);
      if (path === "/api/download") return download(url, env);

      const rule = PROXY[path];
      if (rule) return proxyApi(request, rule, env);

      if (path.startsWith("/api/")) {
        return json(404, { ok: false, error: "未知接口", path });
      }

      // 静态资源交给 assets 处理；404 回落 index.html 由配置里的
      // not_found_handling: "single-page-application" 完成
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json(500, { ok: false, error: "服务器内部错误", detail: msg(err) });
    }
  }
};

/* ============================================================
   上游转发
   ============================================================ */
async function proxyApi(request, rule, env) {
  const key = request.headers.get("authorization") || "";
  if (!key) {
    return json(401, {
      ok: false,
      error: "缺少 Authorization 头",
      hint: "请先在页面里填写 API Key",
    });
  }

  const upstream =
    String(env.UPSTREAM || UPSTREAM_HOST).replace(/\/+$/, "") + API_PREFIX + rule.path;

  const headers = new Headers();
  headers.set("authorization", key);
  headers.set("content-type", request.headers.get("content-type") || "application/json");
  headers.set("user-agent", USER_AGENT);

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstream, {
      method: rule.method,
      headers,
      // 请求体流式转发，避免把几十 MB 的 base64 参考图整体读进内存
      body: rule.method === "POST" ? request.body : undefined,
      duplex: "half",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return json(502, {
      ok: false,
      error: `无法连接上游服务 ${upstream}`,
      detail: msg(err),
      hint: "请检查网络，或确认 dashboard 里配置的 UPSTREAM 是否正确",
    });
  }

  // 状态码与响应体原样透传 —— 前端依赖上游的错误体做错误映射
  const out = new Headers();
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = upstreamResp.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers: out });
}

/* ============================================================
   下载代理（带 SSRF 防护）
   ============================================================ */
async function download(url, env) {
  const target = url.searchParams.get("url") || "";
  if (!target) {
    return json(400, { ok: false, error: "缺少 url 参数", hint: "形如 /api/download?url=https://..." });
  }

  const reason = blockReason(target);
  if (reason) {
    return json(400, { ok: false, error: `地址不受允许：${reason}` });
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(target, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return json(502, {
      ok: false,
      error: "下载失败",
      detail: msg(err),
      hint: "图片直链可能已过期（有效期约 24 小时），请重新生成",
    });
  }

  const ctype = upstreamResp.headers.get("content-type") || "application/octet-stream";
  const out = new Headers();
  out.set("content-type", ctype);
  out.set("content-disposition", `attachment; filename="${guessFilename(target, ctype)}"`);
  out.set("cache-control", "no-store");
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers: out });
}

/**
 * 只放行公网 http(s) 地址。
 * 不做这个检查，公开 Worker 就能被用来探测内网或云元数据接口（169.254.169.254）。
 *
 * 取舍说明：这里检查协议、IP 字面量与内网主机名后缀，但不做 DNS 反解。
 * 原因是目标 URL 只来源于我方 /v1 接口返回的 CDN 直链，域名可预期；
 * Workers 侧做完整 DNS 反解需要额外的探测请求，对大文件下载是纯开销。
 * 需要更强约束时，可加 `host: "ip"` 兼容标志后取 response.addresses 逐一校验。
 */
function blockReason(target) {
  let u;
  try {
    u = new URL(target);
  } catch (_e) {
    return "不是合法的 URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "必须是 http:// 或 https:// 地址";
  }
  const host = (u.hostname || "").toLowerCase();
  if (!host) return "地址缺少主机名";
  if (host === "localhost" || host === "0.0.0.0" || host === "metadata.google.internal") {
    return "不允许访问本机/元数据地址";
  }
  if (BLOCKED_SUFFIX.some((s) => host.endsWith(s))) return "不允许访问内网主机名";
  if (host.includes(":")) return "暂不允许访问 IPv6 地址";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isPrivateIPv4(host)) {
    return `不允许访问内网或回环地址（${host}）`;
  }
  return "";
}

function isPrivateIPv4(text) {
  const parts = text.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function guessFilename(url, contentType) {
  const raw = url.split("?")[0].split("/").filter(Boolean).pop() || "";
  let base = decodeURIComponent(raw).replace(/[^\w.\-]+/g, "_").slice(0, 60) || "image";
  if (!/\.[A-Za-z0-9]{2,5}$/.test(base)) {
    base += MIME_EXT[(contentType || "").split(";")[0].trim().toLowerCase()] || ".png";
  }
  return base;
}

/* ============================================================
   工具
   ============================================================ */
function health(env) {
  return json(200, {
    ok: true,
    app: APP_NAME,
    version: VERSION,
    upstream: String(env.UPSTREAM || UPSTREAM_HOST) + API_PREFIX,
    upstream_timeout_ms: TIMEOUT_MS,
    runtime: "cloudflare-worker",
  });
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function msg(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  return err.message || err.name || String(err);
}
