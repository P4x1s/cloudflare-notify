/**
 * src/ 多文件参考版的端到端测试
 *
 * 问题：src/index.js 用 `import uiHtml from './ui.html'`（打包器按 text 载入），
 * Node 原生 ESM 不认识 .html。所以这里用「内存转译 + blob 模块」的方式加载：
 *   1) 读 src/index.js，把 .html 的 import 换成 data: URL 的 text import；
 *   2) 用 blob: URL 动态 import，从而在 Node 里跑真实的 src 源码（不是复制品）。
 *
 * 目的：确保 src/ 参考版与单文件 worker.js 的行为一致（尤其是本轮新增的 Turnstile）。
 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');

const uiHtml = readFileSync(path.join(srcDir, 'ui.html'), 'utf-8');
const uiDataUrl =
  'data:text/javascript;base64,' + Buffer.from('export default ' + JSON.stringify(uiHtml) + ';', 'utf-8').toString('base64');

// 把 .html 的 import 换成 data: URL（等价于打包器按 text 载入），
// 转译后的文件仍放在 src/ 目录内，保证 './utils.js' 相对路径可解析。
const tmpFile = path.join(srcDir, '__index_test__.mjs');
let indexCode = readFileSync(path.join(srcDir, 'index.js'), 'utf-8');
indexCode = indexCode.replace(
  "import uiHtml from './ui.html';",
  `import uiHtml from ${JSON.stringify(uiDataUrl)};`
);
writeFileSync(tmpFile, indexCode, 'utf-8');

let worker;
try {
  const mod = await import('file://' + tmpFile.replace(/\\/g, '/'));
  worker = mod.default;
} finally {
  try { unlinkSync(tmpFile); } catch (_) { /* ignore */ }
}

// ---------- Mock KV ----------
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

function makeEnv(over = {}) {
  const kv = over.kv || new MockKV();
  return {
    env: {
      NOTIFICATIONS: kv,
      SEND_TOKEN: 'master-secret-123',
      READ_TOKEN: 'read-secret-456',
      WECOM_WEBHOOK: '',
      ...over.env,
    },
    kv,
  };
}

const req = (path, opts = {}) => new Request('https://notify.test' + path, opts);
const jsonBody = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------- 真实 Siteverify 拦截（不发真实网络请求） ----------
let siteverifyCalls = [];
let siteverifyMode = 'pass'; // pass | fail | action-mismatch | duplicate | error
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/turnstile/v0/siteverify')) {
    siteverifyCalls.push({ url: u, body: init && init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null });
    if (siteverifyMode === 'fail') return new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { headers: { 'Content-Type': 'application/json' } });
    if (siteverifyMode === 'action-mismatch') return new Response(JSON.stringify({ success: true, action: 'signup' }), { headers: { 'Content-Type': 'application/json' } });
    if (siteverifyMode === 'duplicate') return new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), { headers: { 'Content-Type': 'application/json' } });
    if (siteverifyMode === 'error') return new Response(JSON.stringify({ success: false, 'error-codes': ['internal-error'] }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ success: true, action: 'login' }), { headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};

// ============================================================
section('1. src/ 版本可加载且基本路由可用');
// ============================================================
{
  const { env } = makeEnv();
  const res = await worker.fetch(req('/api/status', { headers: { 'X-Token': 'read-secret-456' } }), env);
  ok('GET /api/status 返回 200', res.status === 200, 'got ' + res.status);
  const data = await res.json();
  ok('status 含 version', typeof data.version === 'string');
  ok('version 为 2.0.0', data.version === '2.0.0', 'got ' + data.version);
}

{
  const { env } = makeEnv();
  const res = await worker.fetch(req('/send?token=master-secret-123&title=T&content=C'), env);
  ok('GET /send 发送成功', res.status === 200);
}

// ============================================================
section('2. Turnstile 未配置时：零外部依赖（向后兼容）');
// ============================================================
{
  const { env } = makeEnv();
  siteverifyCalls = [];
  const res = await worker.fetch(req('/'), env);
  const html = await res.text();
  const csp = res.headers.get('Content-Security-Policy') || '';
  ok('页面不引用 challenges.cloudflare.com', !html.includes('challenges.cloudflare.com'));
  ok('CSP 不放行 challenges.cloudflare.com', !csp.includes('challenges.cloudflare.com'));
  ok('页面无 Turnstile 容器', !html.includes('tsWidget'));
  ok('页面无 TS 客户端脚本', !html.includes('window.__TS_CFG__'));
  ok('CSP 保持最严', csp.includes("script-src 'self' 'unsafe-inline'") && !csp.includes('frame-src'));

  const login = await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456' })), env);
  ok('未配置时登录正常通过', login.status === 200, 'got ' + login.status);
  ok('未配置时不调用 Siteverify', siteverifyCalls.length === 0);
}

// ============================================================
section('3. Turnstile 已配置：页面注入 + CSP 放行');
// ============================================================
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: '0xTESTKEY', TURNSTILE_SECRET_KEY: '0xTESTSECRET' } });
  const res = await worker.fetch(req('/'), env);
  const html = await res.text();
  const csp = res.headers.get('Content-Security-Policy') || '';
  ok('页面含 tsWidget 容器', html.includes('id="tsWidget"'));
  ok('页面含 tsMsg 提示位', html.includes('id="tsMsg"'));
  ok('页面含 __TS_CFG__ 配置', html.includes('window.__TS_CFG__'));
  ok('注入 sitekey', html.includes('0xTESTKEY'));
  ok('CSP 放行 script-src', csp.includes("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"));
  ok('CSP 放行 frame-src', csp.includes("frame-src 'self' https://challenges.cloudflare.com"));
  ok('CSP 放行 connect-src', csp.includes("connect-src 'self' https://challenges.cloudflare.com"));
  ok('页面不含 secret key', !html.includes('0xTESTSECRET'));
}

// ============================================================
section('4. 服务端校验（Siteverify）');
// ============================================================
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: '0xTESTKEY', TURNSTILE_SECRET_KEY: '0xTESTSECRET' } });

  // 缺 token
  siteverifyCalls = [];
  let res = await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456' })), env);
  ok('缺 turnstileToken → 403（官方语义）', res.status === 403, 'got ' + res.status);
  ok('缺 token 时不调用 Siteverify', siteverifyCalls.length === 0);
  ok('拒绝时不下发 Cookie', !res.headers.get('Set-Cookie'));

  // 无效 token
  siteverifyMode = 'fail';
  res = await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'bad' })), env);
  ok('无效 token → 403（官方语义）', res.status === 403, 'got ' + res.status);
  ok('无效 token 调用了 Siteverify', siteverifyCalls.length === 1);
  ok('Siteverify 请求带 secret', siteverifyCalls[0].body && siteverifyCalls[0].body.secret === '0xTESTSECRET');
  ok('Siteverify 请求带 response', siteverifyCalls[0].body && siteverifyCalls[0].body.response === 'bad');
  ok('Siteverify 请求带幂等键', siteverifyCalls[0].body && typeof siteverifyCalls[0].body.idempotency_key === 'string');
  const err = await res.json();
  ok('不泄露具体错误码', !JSON.stringify(err).includes('invalid-input-response'));

  // token 重放
  siteverifyMode = 'duplicate';
  res = await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'used' })), env);
  ok('timeout-or-duplicate → 403', res.status === 403, 'got ' + res.status);

  // action 不匹配
  siteverifyMode = 'action-mismatch';
  res = await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' })), env);
  ok('action 不匹配 → 403', res.status === 403, 'got ' + res.status);

  // 通过但密钥错
  siteverifyMode = 'pass';
  res = await worker.fetch(req('/api/login', jsonBody({ token: 'wrong-key', turnstileToken: 'tok' })), env);
  ok('Turnstile 通过但 READ_TOKEN 错 → 401', res.status === 401, 'got ' + res.status);
  ok('校验失败不下发 Cookie', !res.headers.get('Set-Cookie'));

  // 全部正确
  res = await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'good' })), env);
  ok('Turnstile + 密钥都正确 → 200', res.status === 200, 'got ' + res.status);
  ok('下发会话 Cookie', !!res.headers.get('Set-Cookie'));
}

// ============================================================
section('5. internal-error 可安全重试（同幂等键）');
// ============================================================
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: '0xTESTKEY', TURNSTILE_SECRET_KEY: '0xTESTSECRET' } });
  siteverifyMode = 'error';
  siteverifyCalls = [];
  const res = await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' })), env);
  ok('internal-error 重试后仍失败 → 403', res.status === 403, 'got ' + res.status);
  ok('internal-error 重试了 2 次', siteverifyCalls.length === 2, 'got ' + siteverifyCalls.length);
  ok('两次重试用同一幂等键',
    siteverifyCalls.length === 2 && siteverifyCalls[0].body.idempotency_key === siteverifyCalls[1].body.idempotency_key);
}

// ============================================================
section('6. 配置不完整 → 不启用、不锁死用户');
// ============================================================
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: '0xONLYSITE' } });
  const res = await worker.fetch(req('/'), env);
  const html = await res.text();
  ok('只配 site key → 页面无 Turnstile', !html.includes('tsWidget'));
  const login = await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456' })), env);
  ok('只配 site key → 登录仍可用（不锁死）', login.status === 200, 'got ' + login.status);

  const st = await worker.fetch(req('/api/status', { headers: { 'X-Token': 'read-secret-456' } }), env);
  const d = (await st.json()).diagnostics;
  ok('status 标 misconfigured', d.turnstileMisconfigured === true);
  ok('status 标未启用', d.turnstileEnabled === false);
}

// ============================================================
section('7. /api/status 自检字段');
// ============================================================
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: '0xK', TURNSTILE_SECRET_KEY: '0xS' } });
  const st = await worker.fetch(req('/api/status', { headers: { 'X-Token': 'read-secret-456' } }), env);
  const d = (await st.json()).diagnostics;
  ok('turnstileEnabled = true', d.turnstileEnabled === true);
  ok('turnstileSiteKeySet = true', d.turnstileSiteKeySet === true);
  ok('turnstileSecretKeySet = true', d.turnstileSecretKeySet === true);
  ok('turnstileMisconfigured = false', d.turnstileMisconfigured === false);
}

// ============================================================
section('8. 中国区源站');
// ============================================================
{
  const { env } = makeEnv({ env: {
    TURNSTILE_SITE_KEY: '0xK', TURNSTILE_SECRET_KEY: '0xS',
    TURNSTILE_API_ORIGIN: 'https://challenges.cloudflare-cn.com',
  } });
  const res = await worker.fetch(req('/'), env);
  const html = await res.text();
  const csp = res.headers.get('Content-Security-Policy') || '';
  ok('页面注入中国区 origin', html.includes('https://challenges.cloudflare-cn.com'));
  ok('CSP 放行中国区源', csp.includes('https://challenges.cloudflare-cn.com'));
  ok('CSP 未混入全球区源', !csp.includes('https://challenges.cloudflare.com'));

  siteverifyCalls = [];
  siteverifyMode = 'pass';
  await worker.fetch(req('/api/login', jsonBody({ token: 'read-secret-456', turnstileToken: 'tok' })), env);
  ok('Siteverify 请求打中国区接口',
    siteverifyCalls.length === 1 && siteverifyCalls[0].url.includes('challenges.cloudflare-cn.com'));
}

// ============================================================
section('9. 登录限速与 Turnstile 互不干扰');
// ============================================================
{
  const { env } = makeEnv({ env: { TURNSTILE_SITE_KEY: '0xK', TURNSTILE_SECRET_KEY: '0xS' } });
  siteverifyMode = 'pass';
  let last = 0;
  for (let i = 0; i < 9; i++) {
    const r = await worker.fetch(req('/api/login', jsonBody({ token: 'wrong', turnstileToken: 'tok' })), env);
    last = r.status;
  }
  ok('连续失败后触发 429 限速', last === 429, 'got ' + last);
}

// ============================================================
section('10. src/ui.html 模板包含占位符与样式');
// ============================================================
{
  ok('ui.html 含 TS_WIDGET 占位符', uiHtml.includes('<!--@TS_WIDGET@-->'));
  ok('ui.html 含 TS_SCRIPTS 占位符', uiHtml.includes('<!--@TS_SCRIPTS@-->'));
  ok('ui.html 含 .ts-widget 样式', uiHtml.includes('.ts-widget'));
  ok('ui.html 含 .ts-msg 样式', uiHtml.includes('.ts-msg'));
  ok('ui.html 含 primary:disabled 样式', uiHtml.includes('.primary:disabled'));
  ok('ui.html 未硬编码 challenges.cloudflare.com', !uiHtml.includes('challenges.cloudflare.com'));
}

// ============================================================
globalThis.fetch = realFetch;
console.log('\n========================================================');
console.log(`通过: ${pass}   失败: ${fail}`);
if (fail) { console.log('失败项:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('src/ 多文件参考版测试全部通过 ✓');
