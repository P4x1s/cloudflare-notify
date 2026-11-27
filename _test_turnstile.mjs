// Turnstile 人机验证专项测试
// 用 Cloudflare 官方 dummy keys 验证完整链路，不访问真实网络：
//   sitekey 1x00000000000000000000AA → 组件始终可见且通过
//   secret  1x0000000000000000000000000000000AA → 校验始终通过
//   secret  2x0000000000000000000000000000000AA → 校验始终失败
//   secret  3x0000000000000000000000000000000AA → 返回 token already spent
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const mod = await import('./worker.js');
const worker = mod.default;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

class MockKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k).value : null; }
  async put(k, v) { this.map.set(k, { value: String(v) }); }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    let keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + limit);
    const next = start + slice.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: next >= keys.length,
      cursor: next < keys.length ? String(next) : undefined,
    };
  }
}

// ---------- 拦截 Siteverify 请求，避免真实联网 ----------
const siteverifyCalls = [];
let siteverifyResponder = () => ({ success: true, hostname: 'cloudflare-notify.com', action: 'login' });
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
    // 官方流程要求 Siteverify 用 application/x-www-form-urlencoded
    const raw = init && init.body ? String(init.body) : '';
    let body = null;
    try { body = Object.fromEntries(new URLSearchParams(raw)); } catch (e) { body = null; }
    siteverifyCalls.push({
      url, body, raw,
      contentType: (init && init.headers && (init.headers['Content-Type'] || init.headers['content-type'])) || '',
      hasSignal: !!(init && init.signal),
    });
    const data = siteverifyResponder();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

const TS_SITEKEY = '1x00000000000000000000AA';
const TS_SECRET_OK = '1x0000000000000000000000000000000AA';
const TS_SECRET_FAIL = '2x0000000000000000000000000000000AA';
const TS_SECRET_SPENT = '3x0000000000000000000000000000000AA';

function makeEnv(over = {}) {
  return {
    env: {
      NOTIFICATIONS: new MockKV(),
      SEND_TOKEN: 'master-secret-123',
      READ_TOKEN: 'read-secret-456',
      WECOM_WEBHOOK: '',
      ...over.env,
    },
  };
}

const req = (path, opts = {}) => new Request('https://cloudflare-notify.com' + path, opts);
const jsonBody = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

let ipCounter = 0;
function nextIp() { ipCounter++; return '10.1.0.' + ipCounter; }

async function call(path, opts = {}, env, ip) {
  const o = opts ? { ...opts } : {};
  const headers = new Headers(o.headers || {});
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (o.headers) delete o.headers;
  const res = await worker.fetch(req(path, { ...o, headers }), env);
  const ct = res.headers.get('Content-Type') || '';
  let body = null;
  if (ct.includes('application/json')) body = await res.json();
  else body = await res.text();
  return { res, body, status: res.status };
}

function cookieOf(res) {
  const c = res.headers.get('Set-Cookie');
  return c ? c.split(';')[0] : '';
}

// ================================================================
section('1. 未配置 Turnstile：不引入任何外部依赖（向后兼容）');
{
  const { env } = makeEnv();
  const IP = nextIp();
  const r = await call('/', {}, env, IP);
  ok('未配置时登录页正常返回 401', r.status === 401);
  ok('页面不含 Turnstile 容器', !r.body.includes('id="tsWidget"'));
  ok('页面不引用 challenges.cloudflare.com', !r.body.includes('challenges.cloudflare.com'));
  ok('页面不含 turnstile 客户端脚本', !r.body.includes('window.__TS_CFG__'));
  const csp = r.res.headers.get('Content-Security-Policy') || '';
  ok('CSP 未放行 challenges.cloudflare.com', !csp.includes('challenges.cloudflare.com'));
  ok('CSP 仍含 default-src self', csp.includes("default-src 'self'"));

  // 未配置时登录流程保持原样（不带 turnstileToken 也能登录）
  const lr = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
  ok('未配置时登录成功', lr.status === 200, 'got ' + lr.status);
  ok('未配置时不会调用 Siteverify', siteverifyCalls.length === 0);
}

// ================================================================
section('2. 已配置 Turnstile：页面注入 + CSP 放行');
{
  const { env } = makeEnv({
    env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK },
  });
  const IP = nextIp();
  const r = await call('/', {}, env, IP);
  ok('登录页返回 401', r.status === 401);
  ok('页面含 Turnstile 容器', r.body.includes('id="tsWidget"'));
  ok('页面含提示信息容器', r.body.includes('id="tsMsg"'));
  ok('页面注入 sitekey 配置', r.body.includes('__TS_CFG__') && r.body.includes(TS_SITEKEY));
  ok('页面引用 api.js（render=explicit）', r.body.includes('/turnstile/v0/api.js?render=explicit'));
  ok('api.js 由客户端动态注入（不在 head 里静态加载）', r.body.includes('document.createElement("script")'));
  ok('页面引用 challenges.cloudflare.com', r.body.includes('challenges.cloudflare.com'));

  const csp = r.res.headers.get('Content-Security-Policy') || '';
  ok('CSP script-src 放行 challenges.cloudflare.com', csp.includes("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"));
  ok('CSP frame-src 放行 challenges.cloudflare.com', csp.includes('frame-src') && csp.includes('https://challenges.cloudflare.com'));
  ok('CSP 仍含 frame-ancestors none', csp.includes("frame-ancestors 'none'"));
  ok('CSP 仍含 object-src none', csp.includes("object-src 'none'"));

  // 主界面（已登录）也要带容器与脚本
  const lr = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'dummy-token' }), env, IP);
  const ck = cookieOf(lr.res);
  const main = await call('/', { headers: { Cookie: ck } }, env, IP);
  ok('主界面返回 200', main.status === 200);
  ok('主界面含重新验证弹层的 Turnstile 容器', main.body.includes('id="tsWidget"'));
  ok('主界面注入 TS 客户端脚本', main.body.includes('window.__TS_CFG__'));
}

// ================================================================
section('3. 服务端校验：缺 token / 无效 token / 有效 token');
{
  // 3a. 缺少 token → 拒绝
  {
    const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
    const IP = nextIp();
    siteverifyCalls.length = 0;
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
    ok('未带 turnstileToken → 403（官方语义：禁止访问）', r.status === 403, 'got ' + r.status);
    ok('未带 token 时不下发 Cookie', !r.res.headers.get('Set-Cookie'));
    ok('未带 token 时不调用 Siteverify（省一次外部请求）', siteverifyCalls.length === 0);
  }

  // 3b. Siteverify 判定失败 → 拒绝
  {
    const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_FAIL } });
    const IP = nextIp();
    siteverifyCalls.length = 0;
    siteverifyResponder = () => ({ success: false, 'error-codes': ['invalid-input-response'] });
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'bad-token' }), env, IP);
    ok('校验失败 → 403（官方语义：禁止访问）', r.status === 403, 'got ' + r.status);
    ok('校验失败不下发 Cookie', !r.res.headers.get('Set-Cookie'));
    ok('确实调用了 Siteverify', siteverifyCalls.length === 1);
    ok('Siteverify 请求体带 secret 与 response', !!(siteverifyCalls[0].body && siteverifyCalls[0].body.secret && siteverifyCalls[0].body.response));
    ok('Siteverify 请求体带幂等键', !!(siteverifyCalls[0].body && siteverifyCalls[0].body.idempotency_key));
    ok('错误响应不泄露具体错误码', !r.body.error.includes('invalid-input-response'));
  }

  // 3c. Siteverify 通过 → 放行
  {
    const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
    const IP = nextIp();
    siteverifyCalls.length = 0;
    siteverifyResponder = () => ({ success: true, hostname: 'cloudflare-notify.com', action: 'login' });
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'good-token' }), env, IP);
    ok('校验通过 → 200', r.status === 200, 'got ' + r.status);
    ok('校验通过下发 Cookie', (r.res.headers.get('Set-Cookie') || '').startsWith('cfn_session='));
    ok('校验通过确实调用了 Siteverify', siteverifyCalls.length === 1);
    ok('Siteverify 带上 remoteip', !!(siteverifyCalls[0].body && siteverifyCalls[0].body.remoteip === IP));
  }

  // 3d. token 已用完（timeout-or-duplicate）→ 拒绝
  {
    const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_SPENT } });
    const IP = nextIp();
    siteverifyResponder = () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'spent-token' }), env, IP);
    ok('token 重放（timeout-or-duplicate）→ 403', r.status === 403, 'got ' + r.status);
    ok('token 重放不下发 Cookie', !r.res.headers.get('Set-Cookie'));
  }

  // 3e. action 不匹配 → 拒绝
  {
    const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
    const IP = nextIp();
    siteverifyResponder = () => ({ success: true, hostname: 'cloudflare-notify.com', action: 'other_action' });
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' }), env, IP);
    ok('action 不匹配 → 403', r.status === 403, 'got ' + r.status);
  }

  // 3f. 密钥错误仍然被拒（Turnstile 通过也不能跳过密钥校验）
  {
    const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
    const IP = nextIp();
    siteverifyResponder = () => ({ success: true, hostname: 'cloudflare-notify.com', action: 'login' });
    const r = await call('/api/login', jsonBody({ token: 'wrong-key', turnstileToken: 'tok' }), env, IP);
    ok('Turnstile 通过但密钥错误 → 401', r.status === 401, 'got ' + r.status);
    ok('密钥错误不下发 Cookie', !r.res.headers.get('Set-Cookie'));
  }
}

// ================================================================
section('4. 配置不完整（只配一个变量）→ 不启用，且状态自检能看出来');
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY } });
  const IP = nextIp();
  const r = await call('/', {}, env, IP);
  ok('只配 sitekey 时页面不含 Turnstile 容器', !r.body.includes('id="tsWidget"'));
  ok('只配 sitekey 时 CSP 不放行 challenges', !(r.res.headers.get('Content-Security-Policy') || '').includes('challenges.cloudflare.com'));
  // 不会把人锁在门外：仍然可以正常登录
  const lr = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
  ok('只配 sitekey 时仍可登录（不锁死用户）', lr.status === 200, 'got ' + lr.status);

  const { env: env2 } = makeEnv({ env: { TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
  const lr2 = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env2, nextIp());
  ok('只配 secret 时仍可登录（不锁死用户）', lr2.status === 200, 'got ' + lr2.status);
}

// ================================================================
section('5. /api/status 自检暴露 Turnstile 配置状态');
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
  const IP = nextIp();
  const lr = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' }), env, IP);
  const ck = cookieOf(lr.res);
  const st = await call('/api/status', { headers: { Cookie: ck } }, env, IP);
  ok('状态接口返回 200', st.status === 200);
  ok('diagnostics.turnstileEnabled = true', st.body.diagnostics.turnstileEnabled === true);
  ok('diagnostics.turnstileSiteKeySet = true', st.body.diagnostics.turnstileSiteKeySet === true);
  ok('diagnostics.turnstileSecretKeySet = true', st.body.diagnostics.turnstileSecretKeySet === true);
  ok('diagnostics.turnstileMisconfigured = false', st.body.diagnostics.turnstileMisconfigured === false);
  ok('状态接口不泄露 secret 内容', !JSON.stringify(st.body).includes(TS_SECRET_OK));

  const { env: envBad } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY } });
  const IP2 = nextIp();
  const lr2 = await call('/api/login', jsonBody({ token: 'read-secret-456' }), envBad, IP2);
  const st2 = await call('/api/status', { headers: { Cookie: cookieOf(lr2.res) } }, envBad, IP2);
  ok('配置不完整时 turnstileEnabled = false', st2.body.diagnostics.turnstileEnabled === false);
  ok('配置不完整时 turnstileMisconfigured = true', st2.body.diagnostics.turnstileMisconfigured === true);
}

// ================================================================
section('6. 中国区源站可配置（challenges.cloudflare-cn.com）');
{
  const { env } = makeEnv({
    env: {
      TURNSTILE_SITE_KEY: TS_SITEKEY,
      TURNSTILE_SECRET_KEY: TS_SECRET_OK,
      TURNSTILE_API_ORIGIN: 'https://challenges.cloudflare-cn.com',
    },
  });
  const IP = nextIp();
  const r = await call('/', {}, env, IP);
  ok('页面注入中国区 origin', r.body.includes('"origin":"https://challenges.cloudflare-cn.com"'));
  ok('客户端按 origin 拼接 api.js 路径', r.body.includes('/turnstile/v0/api.js?render=explicit'));
  const csp = r.res.headers.get('Content-Security-Policy') || '';
  ok('CSP 放行中国区源', csp.includes('https://challenges.cloudflare-cn.com'));
  ok('CSP 未混入全球区源', !csp.includes('https://challenges.cloudflare.com'));
}

// ================================================================
section('7. Turnstile 与登录限速互不干扰');
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
  const IP = nextIp();
  siteverifyResponder = () => ({ success: true, hostname: 'cloudflare-notify.com', action: 'login' });
  // 连续失败（Turnstile 通过但密钥错）应触发既有的 IP 限速
  let last;
  for (let i = 0; i < 10; i++) {
    last = await call('/api/login', jsonBody({ token: 'bad-' + i, turnstileToken: 'tok' }), env, IP);
  }
  ok('Turnstile 启用时限速依然生效', last.status === 429, 'got ' + last.status);
}

// ================================================================
section('8. 客户端脚本安全细节');
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
  const IP = nextIp();
  const r = await call('/', {}, env, IP);
  const body = r.body;
  ok('客户端脚本不包含 secret key', !body.includes(TS_SECRET_OK));
  ok('客户端脚本不含 siteverify 调用（校验只在服务端）', !body.includes('siteverify'));
  ok('客户端使用 render=explicit 显式渲染', body.includes('render=explicit'));
  ok('客户端实现 token 过期回调', body.includes('expired-callback'));
  ok('客户端实现错误回调', body.includes('error-callback'));
  ok('客户端实现 reset（token 单次使用需重置）', body.includes('turnstile.reset'));
  ok('客户端等待容器可见后再渲染', body.includes('offsetWidth'));
  ok('提交时携带 turnstileToken 字段', body.includes('turnstileToken'));
  ok('提交时携带官方标准字段名 cf-turnstile-response', body.includes("'cf-turnstile-response'"));
  ok('登录失败后调用 TS.reset', body.includes('TS.reset'));

  // 回归：显式渲染模式下 turnstile.ready() 的回调不保证触发，
  // 必须用官方推荐的 onload= 参数回调，否则组件永不渲染。
  ok('api.js 带 onload= 参数回调（官方显式渲染写法）', /api\.js\?render=explicit&onload=/.test(body));
  ok('注册了 onload 全局回调函数', body.includes('window[CB] = function ()'));
  ok('script.onload 作为兜底触发渲染', /s\.onload = function \(\) \{ ready\(draw\); \}/.test(body));
  ok('不把 requestAnimationFrame 作为唯一渲染触发点', !body.includes('requestAnimationFrame(draw)'));
  ok('ready() 内置超时兜底（turnstile.ready 不回调时也能渲染）', body.includes('setTimeout(once, 1200)'));
}

// ================================================================
// 9. 官方「已有 widget」接入流程专项
//    依据 https://developers.cloudflare.com/turnstile/spin/prompt.md
// ================================================================
section('9. 官方已有-widget 流程：Siteverify 调用形态');
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
  const IP = nextIp();
  siteverifyCalls.length = 0;
  siteverifyResponder = () => ({ success: true, hostname: 'cloudflare-notify.com', action: 'login' });
  await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' }), env, IP);
  const c = siteverifyCalls[0];
  ok('Siteverify 用 application/x-www-form-urlencoded（官方规范）',
    String(c.contentType).indexOf('application/x-www-form-urlencoded') >= 0, 'got ' + c.contentType);
  ok('Siteverify 带 10 秒超时信号', c.hasSignal === true);
  ok('Siteverify body 含 secret', !!(c.body && c.body.secret));
  ok('Siteverify body 含 response', !!(c.body && c.body.response === 'tok'));
  ok('Siteverify body 含 remoteip', !!(c.body && c.body.remoteip === IP));
  ok('Siteverify body 含 idempotency_key（安全重试）', !!(c.body && c.body.idempotency_key));
  ok('Siteverify body 仍是合法 urlencoded 串', String(c.raw).indexOf('secret=') >= 0 && String(c.raw).indexOf('&') >= 0);
}

section('10. 官方已有-widget 流程：hostname 白名单校验');
{
  // 10a. 未配置 TURNSTILE_HOSTNAMES → 退化为「必须等于请求 Host」
  {
    const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
    const IP = nextIp();
    siteverifyResponder = () => ({ success: true, hostname: 'evil.example.com', action: 'login' });
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' }), env, IP);
    ok('hostname 与请求域名不一致 → 403（防跨站 token 复用）', r.status === 403, 'got ' + r.status);
    ok('hostname 不匹配时不发 Cookie', !r.res.headers.get('Set-Cookie'));
  }
  // 10b. 配置了白名单 → 必须命中
  {
    const { env } = makeEnv({
      env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK, TURNSTILE_HOSTNAMES: 'cloudflare-notify.com,www.cloudflare-notify.com' },
    });
    const IP = nextIp();
    siteverifyResponder = () => ({ success: true, hostname: 'cloudflare-notify.com', action: 'login' });
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' }), env, IP);
    ok('hostname 命中白名单 → 200', r.status === 200, 'got ' + r.status);
  }
  // 10c. 配置了白名单但不命中 → 403
  {
    const { env } = makeEnv({
      env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK, TURNSTILE_HOSTNAMES: 'cloudflare-notify.com' },
    });
    const IP = nextIp();
    siteverifyResponder = () => ({ success: true, hostname: 'other.com', action: 'login' });
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' }), env, IP);
    ok('hostname 不在白名单 → 403', r.status === 403, 'got ' + r.status);
  }
  // 10d. 官方测试密钥返回 dummy-key.invalid → 跳过 hostname 判断（不误伤本地自测）
  {
    const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK } });
    const IP = nextIp();
    siteverifyResponder = () => ({ success: true, hostname: 'dummy-key.invalid', action: 'login' });
    const r = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' }), env, IP);
    ok('测试密钥的 dummy hostname 不被误判 → 200', r.status === 200, 'got ' + r.status);
  }
  // 10e. 白名单状态可通过 /api/status 自检暴露
  {
    const { env } = makeEnv({
      env: { TURNSTILE_SITE_KEY: TS_SITEKEY, TURNSTILE_SECRET_KEY: TS_SECRET_OK, TURNSTILE_HOSTNAMES: 'a.com,b.com' },
    });
    const IP = nextIp();
    siteverifyResponder = () => ({ success: true, hostname: 'a.com', action: 'login' });
    const lr = await call('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' }), env, IP);
    const r = await call('/api/status', { headers: { Cookie: cookieOf(lr.res) } }, env, IP);
    const d = r.body || {};
    ok('status 暴露 turnstileHostnames', Array.isArray(d.diagnostics && d.diagnostics.turnstileHostnames));
    ok('status 的 hostname 列表内容正确',
      Array.isArray(d.diagnostics && d.diagnostics.turnstileHostnames) && d.diagnostics.turnstileHostnames.join(',') === 'a.com,b.com',
      JSON.stringify(d.diagnostics && d.diagnostics.turnstileHostnames));
  }
}

globalThis.fetch = realFetch;

console.log('\n' + '='.repeat(56));
console.log('通过: ' + pass + '   失败: ' + fail);
if (fail) { console.log('\n失败项:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('Turnstile 专项测试全部通过 ✓');
