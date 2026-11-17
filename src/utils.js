/**
 * 公共工具函数：响应封装、鉴权、参数提取
 *
 * 安全模型与单文件版 worker.js（v1.4.0）保持一致：
 *   1) CORS 默认收紧：不设置 Access-Control-Allow-Origin，跨站脚本读不到响应。
 *   2) 页面由服务端鉴权后才下发完整 UI，未鉴权时只返回最小登录页。
 *   3) 会话 Cookie 用 READ_TOKEN 作 HMAC 密钥签名（无状态，不需要 KV）。
 */

// 跨域响应头：只声明允许的方法与请求头，不放开 Origin
export const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token',
  'Access-Control-Max-Age': '86400',
};

// 统一的安全响应头（纵深防御）
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

// 页面 CSP：内嵌 script/style 是单文件版运行的前提
export const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

// ============================== Turnstile 人机验证 ==============================
// 与单文件版 worker.js 行为一致：两个环境变量同时存在才启用，
// 服务端调用 Siteverify 校验（客户端组件本身不构成保护）。
export const TURNSTILE_ACTION = 'login';
export const TURNSTILE_DEFAULT_ORIGIN = 'https://challenges.cloudflare.com';

export function turnstileSiteKey(env) {
  return String((env && env.TURNSTILE_SITE_KEY) || '').trim();
}

export function turnstileSecretKey(env) {
  return String((env && env.TURNSTILE_SECRET_KEY) || '').trim();
}

export function turnstileEnabled(env) {
  return Boolean(turnstileSiteKey(env)) && Boolean(turnstileSecretKey(env));
}

/** 只配了一半 → 配置不完整（不启用，避免把人锁在门外） */
export function turnstileMisconfigured(env) {
  return Boolean(turnstileSiteKey(env)) !== Boolean(turnstileSecretKey(env));
}

/**
 * 期望的 hostname 白名单（官方推荐做法）。
 * 解析 TURNSTILE_HOSTNAMES="a.com,b.com"，去掉空项与首尾空白。
 * 官方提醒：生产环境白名单里不要出现 localhost / 127.0.0.1。
 */
export function turnstileHostnames(env) {
  const raw = String((env && env.TURNSTILE_HOSTNAMES) || '');
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * hostname 允许列表判定（官方建议：服务端同时校验 hostname / action）。
 *   1) 显式配置 TURNSTILE_HOSTNAMES → 必须命中白名单；
 *   2) 未配置 → 退化为「必须等于本次请求的 Host」，等效更严格，且不会把用户锁死；
 *   3) 官方测试密钥返回 dummy-key.invalid → 跳过（仅用于本地自测）。
 */
export function turnstileHostnameAllowed(env, hostname, requestHost) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h || h === 'dummy-key.invalid') return true; // 测试密钥无真实域名
  const explicit = turnstileHostnames(env);
  if (explicit.length) return explicit.indexOf(h) >= 0;
  const req = String(requestHost || '').trim().toLowerCase();
  if (!req) return true; // 拿不到 Host 则不做此项判断（其余校验仍然生效）
  return h === req;
}

/** 中国区部署可设 TURNSTILE_API_ORIGIN=https://challenges.cloudflare-cn.com */
export function turnstileOrigin(env) {
  const raw = String((env && env.TURNSTILE_API_ORIGIN) || '').trim().replace(/\/+$/, '');
  return raw || TURNSTILE_DEFAULT_ORIGIN;
}

/** 启用 Turnstile 时放行 challenges.cloudflare.com（官方要求的 script-src + frame-src） */
export function buildCsp(env) {
  if (!turnstileEnabled(env)) return HTML_CSP;
  const origin = turnstileOrigin(env);
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${origin}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${origin}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    `frame-src 'self' ${origin}`,
    "form-action 'self'",
  ].join('; ');
}

/** 合法 IP 才作为 remoteip 上报 */
function normalizeIp(ip) {
  const s = String(ip || '').trim();
  if (!s || s === 'unknown') return '';
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(s)) return s;
  if (s.indexOf(':') >= 0 && /^[0-9a-fA-F:.]+$/.test(s)) return s;
  return '';
}

/** 由 token 派生稳定 UUID 幂等键：同一 token 重试视为同一次校验 */
async function uuidFromText(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cfn-turnstile:' + text));
  const b = new Uint8Array(digest).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 服务端校验 Turnstile token（Siteverify）。失败一律拒绝（fail closed）。
 * 返回 { ok, code, hostname }；code 只进服务端日志，不回给客户端。
 */
export async function verifyTurnstileToken(env, token, ip, requestHost) {
  const secret = turnstileSecretKey(env);
  if (!secret) return { ok: true, code: 'disabled' };

  const response = String(token || '').trim();
  if (!response) return { ok: false, code: 'missing-input-response' };
  if (response.length > 2048) return { ok: false, code: 'invalid-input-response' };

  const payload = { secret, response };
  const remoteip = normalizeIp(ip);
  if (remoteip) payload.remoteip = remoteip;
  // 幂等键：同一 token 的网络重试视为同一次校验，不会被误判成"token 重放"
  payload.idempotency_key = await uuidFromText(response);

  for (let attempt = 0; attempt < 2; attempt++) {
    let data = null;
    try {
      const res = await fetch(`${turnstileOrigin(env)}/turnstile/v0/siteverify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        if (attempt === 0) continue; // 网络抖动重试（同幂等键）
        return { ok: false, code: 'http-' + res.status };
      }
      data = await res.json();
    } catch (e) {
      if (attempt === 0) continue; // 网络异常/超时重试
      return { ok: false, code: 'network-error' };
    }

    if (!data || typeof data !== 'object') return { ok: false, code: 'bad-response' };
    if (data.success === true) {
      // 官方建议：action 与预期不符也要拒绝（测试密钥不返回 action，跳过该判断）
      if (data.action && data.action !== TURNSTILE_ACTION) {
        return { ok: false, code: 'action-mismatch' };
      }
      const hostname = String(data.hostname || '');
      if (!turnstileHostnameAllowed(env, hostname, requestHost)) {
        return { ok: false, code: 'hostname-mismatch' };
      }
      return { ok: true, code: 'ok', hostname };
    }

    const codes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    // internal-error 是 Cloudflare 侧故障，可安全重试；timeout-or-duplicate（token 已用过/过期）不能重试
    if (codes.indexOf('internal-error') >= 0 && attempt === 0) continue;
    return { ok: false, code: codes.join(',') || 'unknown' };
  }
  return { ok: false, code: 'unknown' };
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  ...SECURITY_HEADERS,
};

/** 返回 JSON 响应 */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/** 返回 HTML 响应（启用 Turnstile 时 CSP 自动放行 challenges.cloudflare.com） */
export function html(body, status = 200, extraHeaders = {}, env = null) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': buildCsp(env),
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * 从请求中提取密钥，兼容四种传参方式：
 * 1. URL 参数：?token=xxx 或 ?sendkey=xxx
 * 2. 请求头：X-Token: xxx
 * 3. 请求头：Authorization: Bearer xxx
 * 4. POST body：JSON / 表单里的 token 字段
 * 推荐用 Header 或 body，避免密钥写进 URL（URL 会进历史、日志、Referer）。
 */
export function extractToken(request, url, body) {
  const fromQuery = url.searchParams.get('token') || url.searchParams.get('sendkey');
  if (fromQuery) return fromQuery;

  const fromHeader = request.headers.get('X-Token');
  if (fromHeader) return fromHeader;

  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

  if (body && typeof body === 'object') {
    const fromBody = body.token || body.sendkey || body.key;
    if (fromBody) return String(fromBody);
  }
  return null;
}

/** 常量时间字符串比较，避免时序侧信道泄露密钥 */
export function timingSafeEqual(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  const la = sa.length;
  const lb = sb.length;
  let diff = la ^ lb;
  const len = Math.max(la, lb);
  for (let i = 0; i < len; i++) {
    const ca = i < la ? sa.charCodeAt(i) : 0;
    const cb = i < lb ? sb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// ============================== 会话 Cookie ==============================
export const SESSION_COOKIE = 'cfn_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/** HMAC-SHA256(secret, message) → 十六进制 */
export async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成会话令牌：<过期毫秒>.<随机数>.<HMAC签名> */
export async function createSessionToken(env) {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${exp}.${nonce}`;
  const sig = await hmacHex(env.READ_TOKEN, payload);
  return `${payload}.${sig}`;
}

/** 校验会话令牌：格式、有效期、签名三者都要过 */
export async function verifySessionToken(env, token) {
  if (!token || !env.READ_TOKEN) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const sig = await hmacHex(env.READ_TOKEN, `${parts[0]}.${parts[1]}`);
  return timingSafeEqual(sig, parts[2]);
}

/** 从 Cookie 头取指定值 */
export function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const p of raw.split(';')) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    if (p.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(p.slice(idx + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

export function sessionCookieHeader(token, secure) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookieHeader(secure) {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * 校验查看权限。接受 READ_TOKEN 直传，或已签发的会话 Cookie。
 * 对应密钥未配置时视为公开访问。
 */
export async function hasPermission(request, url, env, kind, body) {
  const expected = kind === 'send' ? env.SEND_TOKEN : env.READ_TOKEN;
  if (!expected) return true; // 未设置密钥 -> 不校验
  const token = extractToken(request, url, body);
  if (token && timingSafeEqual(token, expected)) return true;
  if (kind === 'read') {
    const session = getCookie(request, SESSION_COOKIE);
    if (session && (await verifySessionToken(env, session))) return true;
  }
  return false;
}

/** 生成唯一 ID（时间戳 + 随机数） */
export function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// ------------------------------ Turnstile 客户端组件 ------------------------------
// 与单文件版 worker.js 完全一致：显式渲染（render=explicit），
// api.js 按需动态注入（不拖慢主界面），容器可见后再 render()
// （不可见容器渲染出的 iframe 尺寸为 0，组件会显示异常）。
export const TURNSTILE_CLIENT_JS = [
  '(function () {',
  "  'use strict';",
  '  var CFG = window.__TS_CFG__ || {};',
  '  var st = { token: "", id: null, started: false, injected: false, tries: 0 };',
  '  function el(id) { return document.getElementById(id); }',
  '  function note(text, info) {',
  '    var m = el("tsMsg");',
  '    if (!m) return;',
  '    m.textContent = text || "";',
  '    m.className = "ts-msg" + (text ? " show" : "") + (info ? " info" : "");',
  '  }',
  '  function fire(type) {',
  '    try {',
  '      document.dispatchEvent(new CustomEvent(type, { detail: { token: st.token } }));',
  '    } catch (e) {',
  '      try { document.dispatchEvent(new Event(type)); } catch (e2) {}',
  '    }',
  '  }',
  '  function visible(box) {',
  '    // 容器不可见时 iframe 会拿到 0 尺寸，组件将无法正常显示，必须等可见后再渲染',
  '    return !!(box.offsetWidth || box.offsetHeight || box.getClientRects().length);',
  '  }',
  '  function draw() {',
  '    var box = el("tsWidget");',
  '    if (!box || !window.turnstile || st.id !== null) return;',
  '    if (!visible(box)) {',
  '      st.tries += 1;',
  '      if (st.tries < 60) { setTimeout(draw, 50); }',
  '      return;',
  '    }',
  '    st.tries = 0;',
  '    st.id = window.turnstile.render(box, {',
  '      sitekey: CFG.sitekey,',
  '      action: CFG.action || "login",',
  '      theme: "auto",',
  '      size: "normal",',
  '      callback: function (t) { st.token = t; note(""); fire("ts:token"); },',
  '      "error-callback": function () { st.token = ""; note("人机验证加载失败，请刷新页面重试"); fire("ts:token"); },',
  '      "expired-callback": function () { st.token = ""; note("验证已过期，请重新验证"); fire("ts:token"); },',
  '      "timeout-callback": function () { st.token = ""; note("验证超时，请重新验证"); fire("ts:token"); }',
  '    });',
  '  }',
  '  function ready(fn) {',
  '    // 注意：显式渲染（render=explicit）模式下 turnstile.ready() 的回调并不保证被触发，',
  '    // 因此这里不依赖它，onload= 参数回调 + script.onload 才是可靠的触发点。',
  '    var called = false;',
  '    function once() { if (called) return; called = true; fn(); }',
  '    if (window.turnstile && window.turnstile.ready) {',
  '      try { window.turnstile.ready(once); } catch (e) {}',
  '    }',
  '    setTimeout(once, 1200);',
  '  }',
  '  function inject() {',
  '    if (st.injected) return;',
  '    st.injected = true;',
  '    // 官方推荐的显式渲染写法：api.js?onload=<全局回调名>，API 就绪时回调被调用。',
  '    // 再叠一层 script.onload 兜底；两者都调用幂等的 draw()，重复调用无副作用。',
  '    var CB = "__tsOnLoad";',
  '    window[CB] = function () { ready(draw); };',
  '    var s = document.createElement("script");',
  '    s.src = CFG.origin + "/turnstile/v0/api.js?render=explicit&onload=" + CB;',
  '    s.async = true;',
  '    s.defer = true;',
  '    s.onload = function () { ready(draw); };',
  '    s.onerror = function () {',
  '      st.injected = false;',
  '      note("人机验证组件加载失败，请检查网络后刷新重试");',
  '    };',
  '    document.head.appendChild(s);',
  '  }',
  '  window.TS = {',
  '    enabled: function () { return !!CFG.sitekey; },',
  '    token: function () { return st.token; },',
  '    reset: function () {',
  '      st.token = "";',
  '      if (st.id !== null && window.turnstile && window.turnstile.reset) {',
  '        try { window.turnstile.reset(st.id); } catch (e) {}',
  '      }',
  '      fire("ts:token");',
  '    },',
  '    start: function () {',
  '      if (!CFG.sitekey) return;',
  '      if (window.turnstile && window.turnstile.render) {',
  '        // API 已就绪（例如弹层第二次打开），直接渲染；容器不可见时 draw() 会自行重试',
  '        draw();',
  '        return;',
  '      }',
  '      inject();',
  '    }',
  '  };',
  '})();',
].join('\n');

/** Turnstile 组件容器（仅在启用时插入） */
export function tsWidgetBlock() {
  return [
    '<div class="ts-widget" id="tsWidget"></div>',
    '<div class="ts-msg" id="tsMsg"></div>',
  ].join('\n');
}

/** Turnstile 客户端脚本（仅在启用时插入；未启用时页面不引用任何外部资源） */
export function tsScriptBlock(env) {
  const cfg = JSON.stringify({
    sitekey: turnstileSiteKey(env),
    action: TURNSTILE_ACTION,
    origin: turnstileOrigin(env),
  }).replace(/</g, '\\u003c');
  return [
    `<script>window.__TS_CFG__=${cfg};</script>`,
    `<script>${TURNSTILE_CLIENT_JS}</script>`,
  ].join('\n');
}

/** 把模板里的 Turnstile 占位符换成真实内容 */
export function applyTurnstile(tpl, env) {
  const on = turnstileEnabled(env);
  return tpl
    .split('<!--@TS_WIDGET@-->').join(on ? tsWidgetBlock() : '')
    .split('<!--@TS_SCRIPTS@-->').join(on ? tsScriptBlock(env) : '');
}
