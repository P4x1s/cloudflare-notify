/**
 * Cloudflare Notify —— Worker 入口（历史多文件版，仅作参考；实际部署用单文件 worker.js）
 *
 * 路由表：
 *   GET  /                 通知查看页面（服务端鉴权后才下发完整 UI）
 *   POST /api/login        登录换取 HttpOnly 会话 Cookie
 *   POST /api/logout       注销会话
 *   GET  /api/status       服务状态与配置自检
 *   GET  /api/messages     获取通知列表
 *   GET  /send             通过 URL 发送消息（方糖风格，最简单）
 *   POST /send             通过表单发送消息
 *   POST /api/send         通过 JSON / 表单发送消息
 *   POST /api/clear        清空全部通知
 *   GET  /api/count        统计通知总数
 */
import uiHtml from './ui.html';
import {
  CORS_HEADERS,
  SECURITY_HEADERS,
  SESSION_COOKIE,
  applyTurnstile,
  clearSessionCookieHeader,
  createSessionToken,
  extractToken,
  getCookie,
  hasPermission,
  html,
  json,
  sessionCookieHeader,
  timingSafeEqual,
  turnstileEnabled,
  turnstileHostnameAllowed,
  turnstileHostnames,
  turnstileMisconfigured,
  turnstileSecretKey,
  turnstileSiteKey,
  verifySessionToken,
  verifyTurnstileToken,
} from './utils.js';
import {
  saveMessage,
  listMessages,
  clearMessages,
  countMessages,
  getVersion,
  decorateMessage,
} from './messages.js';

const VERSION = '1.7.0';

// 登录失败限速：按 IP 计数（单 isolate 内尽力而为，生产环境建议再加 WAF 规则）
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;

function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILS;
}

function noteLoginFailure(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { first: Date.now(), count: 1 });
    return;
  }
  rec.count += 1;
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检请求
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ---- 登录 / 注销（会话 Cookie）----
      if (path === '/api/login' && method === 'POST') {
        const ip = clientIp(request);
        if (loginBlocked(ip)) {
          return json({ ok: false, error: '尝试次数过多，请稍后再试' }, 429);
        }
        const body = await parseBody(request);
        const expected = String(env.READ_TOKEN || '').trim();
        if (!expected) {
          return json({ ok: true, message: '未启用查看验证' }, 200);
        }
        // Turnstile 人机验证：配置后必须先通过服务端校验（客户端组件本身不构成保护）
        if (turnstileEnabled(env)) {
          const verdict = await verifyTurnstileToken(
            env,
            body.turnstileToken || body['cf-turnstile-response'],
            ip,
            url.hostname
          );
          if (!verdict.ok) {
            console.warn('[notify] turnstile rejected:', verdict.code);
            // 官方语义：人机验证未通过属于"禁止访问" → 403（区别于密钥错误的 401）
            return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
          }
        }
        const provided = String(body.token || body.readToken || '').trim();
        if (!provided || !timingSafeEqual(provided, expected)) {
          noteLoginFailure(ip);
          return json({ ok: false, error: '密钥不正确' }, 401);
        }
        loginAttempts.delete(ip);
        const session = await createSessionToken(env);
        return json(
          { ok: true, message: '验证通过' },
          200,
          { 'Set-Cookie': sessionCookieHeader(session, url.protocol === 'https:') }
        );
      }

      if (path === '/api/logout' && method === 'POST') {
        return json(
          { ok: true },
          200,
          { 'Set-Cookie': clearSessionCookieHeader(url.protocol === 'https:') }
        );
      }

      // ---- Web UI：服务端鉴权后才下发完整页面 ----
      if (path === '/' || path === '/index.html') {
        const expected = String(env.READ_TOKEN || '').trim();
        if (!expected) return html(applyTurnstile(uiHtml, env), 200, {}, env);
        const session = getCookie(request, SESSION_COOKIE);
        if (session && (await verifySessionToken(env, session))) {
          return html(applyTurnstile(uiHtml, env), 200, {}, env);
        }
        const direct = extractToken(request, url);
        if (direct && timingSafeEqual(direct, expected)) {
          const token = await createSessionToken(env);
          return new Response(null, {
            status: 302,
            headers: {
              Location: path === '/index.html' ? '/' : path,
              'Set-Cookie': sessionCookieHeader(token, url.protocol === 'https:'),
              'Cache-Control': 'no-store',
              ...SECURITY_HEADERS,
            },
          });
        }
        // 未鉴权：只返回最小登录页（无任何敏感 DOM）
        return html(applyTurnstile(LOGIN_HTML, env), 401, {}, env);
      }

      // ---- 服务状态与配置自检 ----
      if (path === '/api/status' && method === 'GET') {
        if (!(await hasPermission(request, url, env, 'read'))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({
          ok: true,
          service: 'cloudflare-notify',
          version: VERSION,
          needSendToken: Boolean(env.SEND_TOKEN),
          needReadToken: Boolean(env.READ_TOKEN),
          diagnostics: {
            turnstileEnabled: turnstileEnabled(env),
            turnstileSiteKeySet: Boolean(turnstileSiteKey(env)),
            turnstileSecretKeySet: Boolean(turnstileSecretKey(env)),
            turnstileMisconfigured: turnstileMisconfigured(env),
            turnstileHostnames: turnstileHostnames(env),
          },
        });
      }

      // ---- 读取通知 ----
      if (path === '/api/messages' && method === 'GET') {
        if (!(await hasPermission(request, url, env, 'read'))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        // 增量检查：客户端版本号一致时只返回标记，不读取全量列表，显著节省 KV 读取额度
        const version = await getVersion(env);
        const clientVersion = url.searchParams.get('version');
        if (clientVersion && clientVersion === version) {
          return json({ ok: true, unchanged: true, version });
        }
        const messages = (await listMessages(env, url.searchParams.get('limit') || 50)).map(decorateMessage);
        return json({
          ok: true,
          unchanged: false,
          version,
          count: messages.length,
          messages,
        });
      }

      // ---- 发送消息：POST（JSON 或表单）----
      if ((path === '/api/send' || path === '/send') && method === 'POST') {
        const body = await parseBody(request);
        if (!(await hasPermission(request, url, env, 'send', body))) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        return await createMessage(env, body);
      }

      // ---- 发送消息：GET（最简单的 URL 调用方式）----
      if ((path === '/api/send' || path === '/send') && method === 'GET') {
        if (!(await hasPermission(request, url, env, 'send'))) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        return await createMessage(env, {
          title: url.searchParams.get('title') || url.searchParams.get('text') || '',
          content: url.searchParams.get('content') || url.searchParams.get('desp') || '',
          type: url.searchParams.get('type') || 'text',
          source: url.searchParams.get('source') || 'url',
        });
      }

      // ---- 清空通知 ----
      if (path === '/api/clear' && method === 'POST') {
        if (!(await hasPermission(request, url, env, 'read'))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        const deleted = await clearMessages(env);
        return json({ ok: true, deleted });
      }

      // ---- 统计总数 ----
      if (path === '/api/count' && method === 'GET') {
        if (!(await hasPermission(request, url, env, 'read'))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({ ok: true, total: await countMessages(env) });
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      // 不向客户端暴露内部异常细节
      console.error('[notify] unhandled error:', err && err.stack ? err.stack : err);
      return json({ ok: false, error: 'internal server error' }, 500);
    }
  },
};

/** 解析请求体，同时兼容 JSON 与 application/x-www-form-urlencoded / multipart */
async function parseBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

/** 统一的消息创建逻辑 */
async function createMessage(env, data) {
  const title = String(data.title || data.text || '').trim();
  const content = String(data.content || data.desp || data.body || '').trim();

  if (!title && !content) {
    return json({ ok: false, error: 'title 或 content 至少填写一个' }, 400);
  }

  const message = await saveMessage(env, {
    title: title || '（无标题）',
    content,
    type: data.type || 'text',
    source: data.source || 'api',
  });

  // 双返回码：errno（方糖）+ code（Server酱³）
  return json({
    ok: true,
    code: 0,
    errno: 0,
    message: '通知已接收',
    data: message,
  });
}

// 未通过服务端鉴权时返回的最小登录页（不含任何推送地址 / 密钥 / 通知数据）
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>访问验证 · Cloudflare Notify</title>
<style>
  :root { --bg:#f4f6fa; --card:#fff; --text:#1f2430; --muted:#6b7280; --border:#e5e7eb; --primary:#2563eb; --danger:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#191c23; --text:#e8eaed; --muted:#9aa1ad; --border:#2b303b; --primary:#4f8cff; --danger:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:var(--bg); color:var(--text); line-height:1.6; -webkit-font-smoothing:antialiased; }
  .auth-card { width:100%; max-width:380px; background:var(--card); border:1px solid var(--border);
    border-radius:16px; padding:30px 28px; box-shadow:0 8px 30px rgba(0,0,0,.08); }
  .logo { width:42px; height:42px; border-radius:12px; background:linear-gradient(135deg,var(--primary),#7c3aed);
    display:flex; align-items:center; justify-content:center; color:#fff; font-size:20px; margin-bottom:18px; }
  h1 { font-size:18px; margin:0 0 6px; }
  .lead { font-size:13px; color:var(--muted); margin:0 0 18px; line-height:1.7; }
  label { display:block; font-size:12px; color:var(--muted); margin:0 0 5px; }
  input { width:100%; padding:10px 12px; border-radius:9px; border:1px solid var(--border);
    background:transparent; color:var(--text); font:inherit; font-size:14px; outline:none; }
  input:focus { border-color:var(--primary); }
  button { margin-top:16px; width:100%; font:inherit; cursor:pointer; border-radius:9px;
    border:1px solid var(--primary); background:var(--primary); color:#fff; padding:10px 14px; font-size:14px; }
  button:disabled { opacity:.6; cursor:not-allowed; }
  .err { display:none; margin-top:12px; padding:9px 11px; border-radius:9px;
    background:rgba(220,38,38,.10); color:var(--danger); font-size:12px; }
  .err.show { display:block; }
  .hint { margin-top:16px; font-size:11px; color:var(--muted); }
</style>
</head>
<body>
<div class="auth-card">
  <div class="logo">✦</div>
  <h1>通知中心</h1>
  <p class="lead">该通知服务已开启查看验证。请输入查看密钥（READ_TOKEN）以查看通知与接入地址。</p>
  <label for="loginToken">查看密钥</label>
  <input id="loginToken" type="password" placeholder="READ_TOKEN" autocomplete="current-password" />
  <!--@TS_WIDGET@-->
  <button id="btnLogin">进入通知中心</button>
  <div class="err" id="loginErr"></div>
  <div class="hint">验证通过后会签发 HttpOnly 会话 Cookie，密钥不会保存在浏览器本地。</div>
</div>
<!--@TS_SCRIPTS@-->
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  $('btnLogin').addEventListener('click', function () {
    var btn = this;
    var token = $('loginToken').value.trim();
    if (!token) {
      $('loginErr').textContent = '请输入查看密钥';
      $('loginErr').classList.add('show');
      return;
    }
    // Turnstile 启用时必须先拿到验证 token 才能提交（服务端会独立校验）
    var tsToken = '';
    if (window.TS && window.TS.enabled()) {
      tsToken = window.TS.token();
      if (!tsToken) {
        $('loginErr').textContent = '请先完成人机验证';
        $('loginErr').classList.add('show');
        return;
      }
    }
    btn.disabled = true;
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, turnstileToken: tsToken, 'cf-turnstile-response': tsToken }),
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      location.replace('/');
    }).catch(function (err) {
      $('loginErr').textContent = '验证失败：' + err.message;
      $('loginErr').classList.add('show');
      btn.disabled = false;
      // token 单次使用：失败后必须重置组件拿新 token
      if (window.TS && window.TS.enabled()) window.TS.reset();
    });
  });
  $('loginToken').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btnLogin').click();
  });
  $('loginToken').focus();
  // 组件渲染（登录页容器始终可见，可直接挂载）
  if (window.TS && window.TS.enabled()) window.TS.start();
})();
</script>
</body>
</html>`;
