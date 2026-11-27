// v1.9.1 投递可观测性 + 失败告警回归测试
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const mod = await import('./worker.js');
const worker = mod.default;

let pass = 0, fail = 0;
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
    return { keys: slice.map((name) => ({ name })), list_complete: next >= keys.length,
             cursor: next < keys.length ? String(next) : undefined };
  }
}

const DELIVERY_KEY = 'meta:delivery';
const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET-KEY-12345';

function makeEnv(over = {}) {
  const kv = over.kv || new MockKV();
  return {
    env: {
      NOTIFICATIONS: kv,
      SEND_TOKEN: 'master-secret-123',
      READ_TOKEN: 'read-secret-456',
      WECOM_WEBHOOK: WEBHOOK,
      ...over.env,
    },
    kv,
  };
}
const req = (path, opts = {}) => new Request('https://notify.test' + path, opts);
async function call(path, opts, env, ip = '10.9.0.1') {
  const headers = new Headers({ 'CF-Connecting-IP': ip, ...(opts && opts.headers ? opts.headers : {}) });
  const o = { ...(opts || {}), headers };
  const res = await worker.fetch(req(path, o), env);
  const ct = res.headers.get('Content-Type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { res, body, status: res.status };
}
async function readLog(kv) {
  const raw = await kv.get(DELIVERY_KEY);
  return raw ? JSON.parse(raw) : { items: [], lastAlertAt: 0 };
}

const origFetch = globalThis.fetch;

// ================================================================
section('1. 成功投递：写记录、不告警');
{
  const { env, kv } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
  const r = await call('/send?token=master-secret-123&title=成功测试&content=body', {}, env);
  ok('发送成功', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  ok('wecom.ok=true', r.body.wecom && r.body.wecom.ok === true, JSON.stringify(r.body && r.body.wecom));
  const log = await readLog(kv);
  ok('写入 1 条投递记录', log.items.length === 1, JSON.stringify(log));
  ok('记录 ok=true', log.items[0] && log.items[0].ok === true);
  ok('记录含 source', log.items[0] && log.items[0].source === 'url');
  ok('记录含耗时 ms', Number.isFinite(log.items[0] && log.items[0].ms));
  const msgs = await kv.list({ prefix: 'msg:' });
  ok('无告警消息', msgs.keys.length === 1, 'msgs=' + msgs.keys.length);
}

section('2. 单次失败：写记录、不告警（未达阈值）');
{
  const { env, kv } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 45009, errmsg: 'api freq out of limit' }), { status: 200 });
  const r = await call('/send?token=master-secret-123&title=失败测试&content=body', {}, env);
  ok('发送 API 仍成功（best-effort）', r.status === 200 && r.body.ok === true);
  ok('wecom.ok=false', r.body.wecom && r.body.wecom.ok === false);
  const log = await readLog(kv);
  ok('写入 1 条失败记录', log.items.length === 1 && log.items[0].ok === false, JSON.stringify(log));
  ok('记录脱敏错误', log.items[0].error.includes('freq') && !log.items[0].error.includes('SECRET-KEY'));
  const msgs = await kv.list({ prefix: 'msg:' });
  ok('未达阈值不告警', msgs.keys.length === 1, 'msgs=' + msgs.keys.length);
}

section('3. 连续 3 次失败：触发告警 + 防环');
{
  const { env, kv } = makeEnv();
  globalThis.fetch = async () => { throw new Error('fetch failed: ' + WEBHOOK); };
  for (let i = 1; i <= 3; i++) {
    const r = await call('/send?token=master-secret-123&title=失败' + i + '&content=x', {}, env);
    ok('第 ' + i + ' 次发送 API 成功', r.status === 200 && r.body.ok === true);
  }
  const log = await readLog(kv);
  ok('连续失败 3 次已记录', log.items.length === 3 && log.items.every((x) => x.ok === false), JSON.stringify(log.items));
  ok('错误已脱敏（URL/key 不出现）', !JSON.stringify(log).includes('SECRET-KEY') && !JSON.stringify(log).includes('qyapi.weixin'), JSON.stringify(log));
  ok('记录 lastAlertAt', log.lastAlertAt > 0, String(log.lastAlertAt));
  const msgs = await kv.list({ prefix: 'msg:' });
  ok('产生 1 条系统告警消息（3 条业务 + 1 条告警）', msgs.keys.length === 4, 'msgs=' + msgs.keys.length);
  const alertKeys = msgs.keys.map((k) => k.name);
  const alerts = await Promise.all(alertKeys.map((k) => kv.get(k).then((raw) => JSON.parse(raw))));
  const alert = alerts.find((m) => m && m.source === 'system/alert');
  ok('告警消息存在且来源正确', Boolean(alert), JSON.stringify(alerts.map((m) => m && m.source)));
  ok('告警标题含失败', alert && alert.title.includes('推送失败'));
  ok('告警正文不泄露 Webhook key', alert && !JSON.stringify(alert).includes('SECRET-KEY'));
  ok('防环：告警消息本身无投递记录', log.items.length === 3, 'records=' + log.items.length);
}

section('4. 告警静默窗口：连续失败不重复告警');
{
  const { env, kv } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 45009, errmsg: 'rate limit' }), { status: 200 });
  for (let i = 1; i <= 6; i++) {
    await call('/send?token=master-secret-123&title=限流' + i + '&content=x', {}, env);
  }
  const log = await readLog(kv);
  const msgs = await kv.list({ prefix: 'msg:' });
  ok('6 次失败记录齐全', log.items.length === 6);
  ok('静默窗口内只告警 1 次（6 业务 + 1 告警）', msgs.keys.length === 7, 'msgs=' + msgs.keys.length);
}

section('5. /api/status 暴露投递指标（需鉴权）');
{
  const { env } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
  await call('/send?token=master-secret-123&title=指标&content=x', {}, env);
  const r = await call('/api/status?token=read-secret-456', {}, env);
  ok('status 200', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  const d = r.body.diagnostics && r.body.diagnostics.delivery;
  ok('diagnostics.delivery 存在', Boolean(d), JSON.stringify(r.body.diagnostics));
  ok('lastOkAt 已设置', d && d.lastOkAt > 0);
  ok('lastAt 已设置', d && d.lastAt > 0);
  ok('consecutiveFailures=0', d && d.consecutiveFailures === 0);
  ok('sampled >= 1', d && d.sampled >= 1);
  ok('recent 数组已脱敏', d && Array.isArray(d.recent) && !JSON.stringify(d.recent).includes('SECRET-KEY'));

  const unauth = await call('/api/status', {}, env);
  ok('未鉴权 status 返回 401', unauth.status === 401);
}

section('6. 环形缓冲上限 30');
{
  const { env, kv } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
  for (let i = 0; i < 35; i++) {
    await call('/send?token=master-secret-123&title=批量' + i + '&content=x', {}, env);
  }
  const log = await readLog(kv);
  ok('记录数被裁剪到 30', log.items.length === 30, 'items=' + log.items.length);
  ok('最新一条在最前', log.items[0] && log.items[0].source === 'url');
}

section('7. 未配置 Webhook：不写投递记录');
{
  const { env, kv } = makeEnv({ env: { WECOM_WEBHOOK: '' } });
  const r = await call('/send?token=master-secret-123&title=无webhook&content=x', {}, env);
  ok('发送成功', r.status === 200 && r.body.ok === true);
  ok('wecom.skipped=true', r.body.wecom && r.body.wecom.skipped === true);
  ok('无投递记录（省写额度）', (await kv.get(DELIVERY_KEY)) === null);
}

section('8. 返回结构向后兼容');
{
  const { env } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
  const r = await call('/send?token=master-secret-123&title=兼容&content=x', {}, env);
  ok('响应含 ok/code/errno', r.body.ok === true && r.body.code === 0 && r.body.errno === 0);
  ok('响应含 data.message', Boolean(r.body.data && r.body.data.id));
  ok('响应含 wecom', Boolean(r.body.wecom));
}

globalThis.fetch = origFetch;

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
