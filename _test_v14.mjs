// Cloudflare Notify v1.4.0 回归测试（Node mock KV + 直接 import worker.js）
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

// 登录限速按 IP 计数，所以每个测试分组用不同的 IP，避免互相干扰
let ipCounter = 0;
function nextIp() { ipCounter++; return '10.0.0.' + ipCounter; }

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
function cookieHeader(res) {
  const c = res.headers.get('Set-Cookie');
  if (!c) return '';
  return c.split(';')[0].split('=')[0] + '=' + decodeURIComponent(c.split(';')[0].split('=')[1] || '');
}

// ================================================================
section('1. 页面服务端鉴权（核心安全修复）');
{
  const { env } = makeEnv();
  const IP = nextIp();

  // 未登录 → 只返回最小登录页
  const r1 = await call('/', {}, env, IP);
  ok('未鉴权时 / 返回 401', r1.status === 401, 'got ' + r1.status);
  ok('未鉴权时返回的是登录页', r1.body.includes('auth-card') && r1.body.includes('btnLogin'));
  ok('未鉴权页面不含推送地址 DOM (scUrl)', !r1.body.includes('scUrl'));
  ok('未鉴权页面不含密钥 DOM (rotatedKeyBox)', !r1.body.includes('rotatedKeyBox'));
  ok('未鉴权页面不含发送表单 (fSendToken)', !r1.body.includes('fSendToken'));
  ok('未鉴权页面不含管理密钥输入 (fMasterToken)', !r1.body.includes('fMasterToken'));
  ok('未鉴权页面不含通知列表容器', !r1.body.includes('id="list"'));
  ok('未鉴权页面不含任何 .send 推送地址', !/\/[0-9a-f]{16,}\.send/.test(r1.body));

  // 关键攻击场景：删掉遮罩 div 也不能看到 key
  const stripped = r1.body.replace(/<div class="overlay"[\s\S]*?<\/div>\s*<\/div>/g, '');
  ok('删除遮罩 div 后仍无密钥/地址', !stripped.includes('scUrl') && !stripped.includes('rotatedKeyBox'));

  // 错误密钥登录
  const r2 = await call('/api/login', jsonBody({ token: 'wrong' }), env, IP);
  ok('错误密钥登录返回 401', r2.status === 401);
  ok('错误密钥登录不下发 Cookie', !r2.res.headers.get('Set-Cookie'));

  // 正确密钥登录
  const r3 = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
  ok('正确密钥登录返回 200', r3.status === 200, 'got ' + r3.status);
  const sc = r3.res.headers.get('Set-Cookie') || '';
  ok('登录后下发 Set-Cookie', !!sc);
  ok('Cookie 为 HttpOnly', /HttpOnly/i.test(sc));
  ok('Cookie 为 SameSite=Strict', /SameSite=Strict/i.test(sc));
  ok('Cookie 名为 cfn_session', sc.startsWith('cfn_session='));

  // 带 Cookie 访问 → 完整页面
  const ck = cookieHeader(r3.res);
  const r4 = await call('/', { headers: { Cookie: ck } }, env, IP);
  ok('带会话 Cookie 后 / 返回 200', r4.status === 200, 'got ' + r4.status);
  ok('完整页面含推送地址 DOM', r4.body.includes('scUrl'));
  ok('完整页面含密钥 DOM', r4.body.includes('rotatedKeyBox'));
  ok('完整页面含通知列表', r4.body.includes('id="list"'));

  // 伪造 Cookie
  const r5 = await call('/', { headers: { Cookie: 'cfn_session=1.abc.def' } }, env, IP);
  ok('伪造会话 Cookie 被拒绝', r5.status === 401);
  const r6 = await call('/', { headers: { Cookie: 'cfn_session=' + '9'.repeat(20) } }, env, IP);
  ok('垃圾会话 Cookie 被拒绝', r6.status === 401);

  // 带 token 的 query：服务端换发会话 Cookie 并 302 到干净地址（密钥不留历史）
  const r7 = await call('/?token=read-secret-456', {}, env, IP);
  ok('query 带 READ_TOKEN → 302 跳转', r7.status === 302, 'got ' + r7.status);
  ok('302 下发会话 Cookie', (r7.res.headers.get('Set-Cookie') || '').startsWith('cfn_session='));
  ok('302 Location 清理了 URL 上的 token', !(r7.res.headers.get('Location') || '').includes('token'));
  const r7b = await call('/', { headers: { Cookie: cookieHeader(r7.res) } }, env, IP);
  ok('跟随 302 后可访问完整页面', r7b.status === 200 && r7b.body.includes('scUrl'));

  // READ_TOKEN 未配置 → 公开模式
  const { env: envOpen } = makeEnv({ env: { READ_TOKEN: '' } });
  const r8 = await call('/', {}, envOpen);
  ok('未配置 READ_TOKEN 时页面公开', r8.status === 200);
  ok('公开模式下含完整 UI', r8.body.includes('scUrl'));
  const r9 = await call('/api/status', {}, envOpen);
  ok('公开模式下 /api/status 可访问', r9.status === 200);
}

// ================================================================
section('2. API 鉴权（会话 Cookie 可用于 API）');
{
  const { env } = makeEnv();
  const IP = nextIp();
  const lr = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
  const ck = cookieHeader(lr.res);

  const a1 = await call('/api/messages', {}, env, IP);
  ok('无凭据 /api/messages 返回 401', a1.status === 401);

  const a2 = await call('/api/messages', { headers: { Cookie: ck } }, env, IP);
  ok('带会话 Cookie /api/messages 返回 200', a2.status === 200);

  const a3 = await call('/api/messages', { headers: { 'X-Token': 'read-secret-456' } }, env, IP);
  ok('带 X-Token /api/messages 返回 200', a3.status === 200);

  const a4 = await call('/api/status', {}, env, IP);
  ok('未鉴权 /api/status 返回 401', a4.status === 401);

  const a5 = await call('/api/count', { headers: { Cookie: ck } }, env, IP);
  ok('带会话 /api/count 返回 200', a5.status === 200);

  // 轮换密钥不能用于管理接口
  const kr = await call('/api/key/rotate', { method: 'POST', headers: { 'X-Token': 'master-secret-123' } }, env, IP);
  ok('SEND_TOKEN 可轮换密钥', kr.status === 200, 'got ' + kr.status);
  const rotKey = kr.body.key;
  ok('轮换密钥为 64 位十六进制', /^[0-9a-f]{64}$/.test(rotKey || ''), rotKey);

  const kr2 = await call('/api/key/rotate', { method: 'POST', headers: { 'X-Token': rotKey } }, env, IP);
  ok('轮换密钥无权轮换（防 DoS）', kr2.status === 401);

  const kr3 = await call('/api/key/current', { headers: { 'X-Token': 'wrong' } }, env, IP);
  ok('错误密钥无法查看当前密钥', kr3.status === 401);

  // 登出
  const lo = await call('/api/logout', { method: 'POST' }, env, IP);
  ok('/api/logout 返回 200', lo.status === 200);
  ok('/api/logout 下发清除 Cookie', /Max-Age=0/i.test(lo.res.headers.get('Set-Cookie') || ''));
}

// ================================================================
section('3. 登录限速');
{
  const { env } = makeEnv();
  const IP = nextIp();
  let last = 0;
  for (let i = 0; i < 10; i++) {
    last = await call('/api/login', jsonBody({ token: 'bad-' + i }), env, IP);
  }
  ok('连续失败后触发 429 限速', last.status === 429, 'got ' + last.status);
  const good = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
  ok('限速期间正确密钥也被拦截', good.status === 429, 'got ' + good.status);
}

// ================================================================
section('4. 发送 / 方糖兼容 / 消息存取（回归）');
{
  const { env } = makeEnv();
  const IP = nextIp();

  const s1 = await call('/api/send', jsonBody({ title: '标题A', content: '正文A' }), env, IP);
  ok('无 token 发送被拒（ SEND_TOKEN 已配置）', s1.status === 401, 'got ' + s1.status);

  const s2 = await call('/api/send?token=master-secret-123', jsonBody({ title: '标题A', content: '正文A' }), env, IP);
  ok('query token 发送成功', s2.status === 200 && s2.body.ok === true);
  ok('返回 code:0（Server酱兼容）', s2.body.code === 0);
  ok('返回 errno:0（方糖兼容）', s2.body.errno === 0);

  const s3 = await call('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': 'master-secret-123' }, body: JSON.stringify({ title: 'B', content: 'C' }) }, env, IP);
  ok('Header token 发送成功', s3.status === 200 && s3.body.ok === true);

  const s4 = await call('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': 'master-secret-123' }, body: JSON.stringify({ title: 'D', content: 'E', token: 'master-secret-123' }) }, env, IP);
  ok('body token 发送成功', s4.status === 200 && s4.body.ok === true);

  const sc1 = await call('/master-secret-123.send?text=T&desp=D', {}, env, IP);
  ok('方糖 path 发送成功', sc1.status === 200 && sc1.body.errno === 0 && sc1.body.code === 0);

  const sc2 = await call('/wrongkey.send?text=T', {}, env, IP);
  ok('错误 path key 被拒', sc2.status === 401);

  // 读取
  const lr = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
  const ck = cookieHeader(lr.res);
  const m1 = await call('/api/messages', { headers: { Cookie: ck } }, env, IP);
  ok('消息列表返回 4 条', m1.body.count === 4, 'got ' + m1.body.count);
  ok('消息列表含 title/content', m1.body.messages[0].title && 'content' in m1.body.messages[0]);

  // 增量
  const m2 = await call('/api/messages?version=' + m1.body.version, { headers: { Cookie: ck } }, env, IP);
  ok('增量检查 unchanged=true', m2.body.unchanged === true);

  // 轮换密钥也能发送
  const kr = await call('/api/key/rotate', { method: 'POST', headers: { 'X-Token': 'master-secret-123' } }, env, IP);
  const rotKey = kr.body.key;
  const s5 = await call('/api/send?token=' + rotKey, jsonBody({ title: 'F', content: 'G' }), env, IP);
  ok('轮换密钥可发送', s5.status === 200 && s5.body.ok === true);

  // 旧密钥失效
  const kr2 = await call('/api/key/rotate', { method: 'POST', headers: { 'X-Token': 'master-secret-123' } }, env, IP);
  const s6 = await call('/api/send?token=' + rotKey, jsonBody({ title: 'H', content: 'I' }), env, IP);
  ok('轮换后旧密钥立即失效', s6.status === 401, 'got ' + s6.status);

  // 清空
  const c1 = await call('/api/clear', { method: 'POST', headers: { Cookie: ck } }, env, IP);
  ok('清空成功', c1.status === 200 && c1.body.deleted >= 4, JSON.stringify(c1.body));
  const m3 = await call('/api/messages', { headers: { Cookie: ck } }, env, IP);
  ok('清空后列表为空', m3.body.count === 0);
}

// ================================================================
section('5. UI 折叠可读性 + 布局整合（回归断言）');
{
  const { env } = makeEnv();
  const IP = nextIp();
  const r = await call('/', { headers: { Cookie: 'x' }, env: env }, env).catch(() => null);
  const { env: envOpen } = makeEnv({ env: { READ_TOKEN: '' } });
  const page = await call('/', {}, envOpen);

  ok('页面含 m-preview 摘要容器', page.body.includes('m-preview'));
  ok('页面含 previewOf 摘要函数', page.body.includes('previewOf'));
  ok('页面含 msg-main 包裹层', page.body.includes('msg-main'));
  ok('折叠态仍展示 m-body（展开区）', page.body.includes('m-body'));
  ok('使用 -webkit-line-clamp 限制摘要行数', page.body.includes('-webkit-line-clamp'));
  ok('已移除旧的 .grid 三列布局', !page.body.includes('class="grid"'));
  ok('已移除旧的 .card 卡片类', !page.body.includes('class="card'));
  ok('改为统一 .panel 外框', page.body.includes('class="panel"'));
  ok('内部用 .section + 发丝线分区', page.body.includes('class="section"'));
  ok('分区样式用 border-top 而非独立卡片', page.body.includes('.section + .section'));
  ok('登录遮罩不再承担安全职责（改由服务端鉴权）', !page.body.includes('id="loginOverlay"') || page.body.includes('会话已失效'));
}

// ================================================================
section('6. 安全响应头 / 错误脱敏（回归）');
{
  const { env } = makeEnv();
  const IP = nextIp();
  const r = await call('/', {}, env, IP);
  const h = r.res.headers;
  ok('CSP 存在', (h.get('Content-Security-Policy') || '').includes("default-src 'self'"));
  ok('X-Content-Type-Options: nosniff', h.get('X-Content-Type-Options') === 'nosniff');
  ok('Referrer-Policy: no-referrer', h.get('Referrer-Policy') === 'no-referrer');
  ok('X-Frame-Options: DENY', h.get('X-Frame-Options') === 'DENY');
  ok('Permissions-Policy 存在', (h.get('Permissions-Policy') || '').includes('camera=()'));
  ok('Cache-Control: no-store', h.get('Cache-Control') === 'no-store');

  const nf = await call('/nope', {}, env, IP);
  ok('未知路径返回 404 JSON', nf.status === 404 && nf.body.ok === false);
  ok('404 不泄露堆栈', !JSON.stringify(nf.body).includes('at '));

  const bad = await call('/api/send?token=master-secret-123', jsonBody({}), env, IP);
  ok('空内容发送返回 400', bad.status === 400, 'got ' + bad.status);

  // CORS：不应有通配 ACAO
  const cr = await call('/api/status', {}, env, IP);
  ok('无通配 Access-Control-Allow-Origin', !cr.res.headers.get('Access-Control-Allow-Origin'));

  const pre = await worker.fetch(req('/', { method: 'OPTIONS' }), env);
  ok('OPTIONS 预检返回 204', pre.status === 204);
  ok('预检 Allow-Headers 含 X-Token', (pre.headers.get('Access-Control-Allow-Headers') || '').includes('X-Token'));
}

// ================================================================
section('7. 会话 Cookie 篡改检测');
{
  const { env } = makeEnv();
  const IP = nextIp();
  const lr = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
  const ck = cookieHeader(lr.res);
  const value = ck.split('=')[1];

  const t1 = await call('/', { headers: { Cookie: 'cfn_session=' + value.slice(0, -1) + 'X' } }, env, IP);
  ok('签名被篡改 → 401', t1.status === 401);

  const t2 = await call('/', { headers: { Cookie: 'cfn_session=' + encodeURIComponent('99999999999999.abc.deadbeef') } }, env, IP);
  ok('过期/伪造令牌 → 401', t2.status === 401);

  const t3 = await call('/', { headers: { Cookie: 'cfn_session=' + value.replace(/^[^.]+/, String(Date.now() + 9e9)) } }, env, IP);
  ok('改过期时间导致签名不匹配 → 401', t3.status === 401);

  const t4 = await call('/', { headers: { Cookie: ck } }, env, IP);
  ok('原 Cookie 仍然有效 → 200', t4.status === 200);
}

// ================================================================
section('8. 变更 READ_TOKEN 后旧会话立即失效');
{
  const { env } = makeEnv();
  const IP = nextIp();
  const lr = await call('/api/login', jsonBody({ token: 'read-secret-456' }), env, IP);
  const ck = cookieHeader(lr.res);
  ok('登录后可访问', (await call('/', { headers: { Cookie: ck } }, env)).status === 200);

  env.READ_TOKEN = 'new-read-secret-789';
  const after = await call('/', { headers: { Cookie: ck } }, env, IP);
  ok('改 READ_TOKEN 后旧会话失效 → 401', after.status === 401, 'got ' + after.status);
}

// ================================================================
console.log('\n' + '='.repeat(56));
console.log('通过: ' + pass + '   失败: ' + fail);
if (fail) { console.log('\n失败项:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过 ✓');
