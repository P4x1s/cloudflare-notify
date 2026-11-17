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

/** 返回 HTML 响应 */
export function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': HTML_CSP,
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
