/* SenseNova Studio —— Service Worker
 *
 * 作用
 *   1. 让「添加到主屏幕」在 iOS/Android 上获得独立全屏外壳
 *   2. 缓存页面壳（HTML/manifest/图标），弱网或断网时仍能打开界面
 *
 * 缓存策略：Network-first + Cache-fallback
 *   - 静态壳：先走网络拿到最新版本，同时写回缓存；网络失败才退回缓存
 *   - /api/* ：完全绕过缓存直接放行（生成结果绝不能被旧缓存污染）
 *   - 非 GET ：一律不拦截，直接交回浏览器
 *
 * 升级流程：改 CACHE 版本号即可让所有客户端激活新缓存并丢弃旧缓存
 */
const CACHE = "sns-studio-v1";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个 add 而不是 addAll：任何一个资源 404 都不应导致整个 install 失败
    for (const url of SHELL) {
      try {
        await cache.add(url);
      } catch (err) {
        console.warn("[sw] 缓存跳过", url, err);
      }
    }
  })().then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (!url.protocol.startsWith("http")) return;
  // 只处理同源请求；跨源（上游 CDN 直链等）交给浏览器默认行为
  if (url.origin !== self.location.origin) return;
  // API 一律不缓存
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      return new Response(
        "离线状态，无法加载页面",
        { status: 503, statusText: "offline", headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
  })());
});
