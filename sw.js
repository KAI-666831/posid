// 程式本體：先抓網路最新版，沒網路才用快取
// 模型與引擎由 app 自己存在 posid-models-v1（只清自己 posid- 開頭的快取，不動同網域其他 app），這裡不碰、更新時也不刪
const CACHE = 'posid-v12', KEEP = [CACHE, 'posid-models-v1', 'posid-flags'];
// 實驗：多執行緒加速。開啟時替每個回應加上隔離標頭（COOP/COEP），瀏覽器才允許辨識引擎用多個核心
let isoP = null;
const getIso = () => isoP || (isoP = caches.open('posid-flags').then(c => c.match('mt')).then(r => !!r).catch(() => false));
self.addEventListener('message', e => { if (e.data === 'flags') isoP = null; });
function withIso(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
const iso = p => p.then(res => getIso().then(on => on ? withIso(res) : res));
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html', './checks.js', './docs.js', './pair.js', './qrcode.js', './crew.js', './cont.js', './duo.js', './groups.js', './samples.js', './crops.js', './pos/index.html', './manifest.webmanifest', './icon-180.png', './ort/ort.wasm.min.js', './ort/ort-wasm-simd-threaded.mjs'])));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('posid-') && !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (/\.(onnx|wasm)$|ppocrv5_dict/.test(url.pathname)) {          // 大檔：先看模型快取
    e.respondWith(iso(caches.open('posid-models-v1').then(c => c.match(e.request)).then(hit => hit || fetch(e.request))));
    return;
  }
  e.respondWith(iso(fetch(e.request.url, { cache:'no-store' }).then(res => {   // 不吃瀏覽器快取，每次拿最新版
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request))));
});
