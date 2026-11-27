// v2.0.0 专项测试：功能、安全、逻辑一致性三类验证。
import assert from 'node:assert/strict';
import { webcrypto, createHmac } from 'node:crypto';

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
  async put(k, v, options = {}) { this.map.set(k, { value: String(v), options }); }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
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

const MASTER = 'master-token-v20';
const READ = 'read-token-v20';
let ipSeq = 0;

function makeEnv(over = {}) {
  const kv = new MockKV();
  return {
    kv,
    env: {
      NOTIFICATIONS: kv,
      SEND_TOKEN: MASTER,
      READ_TOKEN: READ,
      WECOM_WEBHOOK: '',
      ...over,
    },
  };
}
function makeHeaders(extra = {}) {
  return new Headers({ 'CF-Connecting-IP': '172.31.' + (ipSeq++ % 250) + '.' + (1 + ipSeq % 250), ...extra });
}
async function call(path, opts, env, headers = {}) {
  const h = makeHeaders({ ...((opts && opts.headers) || {}), ...headers });
  const o = { ...(opts || {}), headers: h };
  const res = await worker.fetch(new Request('https://notify.test' + path, o), env);
  const ct = res.headers.get('Content-Type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { res, body, status: res.status };
}
const adminHeaders = () => ({ 'X-Token': MASTER, 'Content-Type': 'application/json' });
const msgKeys = async (kv) => (await kv.list({ prefix: 'msg:' })).keys.length;
const origFetch = globalThis.fetch;

// ================================================================
section('1. 多渠道分发：钉钉 + 飞书并行送达并逐渠道记账');
{
  const { env, kv } = makeEnv();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('dingtalk')) return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    if (u.includes('feishu')) return new Response(JSON.stringify({ code: 0, msg: 'ok' }), { status: 200 });
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  };
  const cfg = await call('/api/channels', {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({ channels: [
      { id: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=DT', enabled: true },
      { id: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/FS', enabled: true },
    ] }),
  }, env);
  ok('渠道配置保存成功', cfg.status === 200 && cfg.body.ok === true, JSON.stringify(cfg.body));
  ok('Webhook 返回时脱敏', !JSON.stringify(cfg.body).includes('access_token=DT'));

  const r = await call('/api/send?token=' + MASTER + '&title=多渠道&content=测试', {}, env);
  ok('发送成功', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  const chans = r.body.channels || [];
  ok('返回三个渠道结果', chans.length === 3, JSON.stringify(chans));
  ok('钉钉已送达', chans.find((c) => c.id === 'dingtalk')?.ok === true);
  ok('飞书已送达', chans.find((c) => c.id === 'feishu')?.ok === true);
  ok('企微未配置被跳过', chans.find((c) => c.id === 'wecom')?.skipped === true);
  const raw = await kv.get('meta:delivery');
  const log = raw ? JSON.parse(raw) : { items: [] };
  ok('投递日志含两条渠道记录', log.items.length === 2, JSON.stringify(log.items));
  ok('记录区分渠道', log.items.some((x) => x.channel === 'dingtalk') && log.items.some((x) => x.channel === 'feishu'));
}

// ================================================================
section('2. 单渠道失败不影响其他渠道');
{
  const { env } = makeEnv();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('dingtalk')) return new Response(JSON.stringify({ errcode: 310000, errmsg: 'sign check fail' }), { status: 200 });
    if (u.includes('feishu')) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  };
  await call('/api/channels', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ channels: [
    { id: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=DT', enabled: true },
    { id: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/FS', enabled: true },
  ] }) }, env);
  const r = await call('/api/send?token=' + MASTER + '&title=部分失败&content=测试', {}, env);
  const chans = r.body.channels || [];
  ok('钉钉失败', chans.find((c) => c.id === 'dingtalk')?.ok === false);
  ok('飞书仍成功', chans.find((c) => c.id === 'feishu')?.ok === true);
  ok('错误信息已脱敏', !JSON.stringify(chans).includes('DT'));
}

// ================================================================
section('3. 模板、幂等与消息 TTL');
{
  const { env, kv } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  const t = await call('/api/templates', {
    method: 'PUT', headers: adminHeaders(),
    body: JSON.stringify({ templates: { deploy: { title: '上线通知：{service}', content: '时间 {date} {time}' } } }),
  }, env);
  ok('模板保存成功', t.status === 200 && t.body.ok === true, JSON.stringify(t.body));

  const r1 = await call('/api/send?token=' + MASTER + '&template=deploy&service=web&v.service=api&title=', {}, env,
    { 'X-Idempotency-Key': 'idem-abc-123' });
  ok('模板变量渲染：自定义优先', r1.body.data?.title === '上线通知：api', JSON.stringify(r1.body.data));
  ok('内置变量已渲染', r1.body.data?.content.includes('20'), r1.body.data?.content);
  const r2 = await call('/api/send?token=' + MASTER + '&template=deploy&service=web&v.service=api&title=', {}, env,
    { 'X-Idempotency-Key': 'idem-abc-123' });
  ok('重复幂等键返回 idempotent', r2.body.idempotent === true, JSON.stringify(r2.body));
  ok('幂等命中未重复落库', (await msgKeys(kv)) === 1, 'keys=' + await msgKeys(kv));

  const msgEntry = [...kv.map.entries()].find(([k]) => k.startsWith('msg:'));
  ok('消息写入带 expirationTtl', Boolean(msgEntry && msgEntry[1].options.expirationTtl === 90 * 86400),
    JSON.stringify(msgEntry && msgEntry[1].options));
  const idemEntry = [...kv.map.keys()].find((k) => k.startsWith('meta:idem:'));
  ok('幂等记录带 24h TTL', Boolean(idemEntry && kv.map.get(idemEntry).options.expirationTtl === 86400));
}

// ================================================================
section('4. 单条删除与写权限校验');
{
  const { env, kv } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  await call('/send?token=' + MASTER + '&title=A&content=1', {}, env);
  await call('/send?token=' + MASTER + '&title=B&content=2', {}, env);
  ok('已有两条消息', (await msgKeys(kv)) === 2);
  const id = (await kv.list({ prefix: 'msg:' })).keys[0].name.split('-').pop();
  const unauth = await call('/api/messages/' + id, { method: 'DELETE' }, env, { 'X-Token': 'wrong' });
  ok('错误密钥不能删除', unauth.status === 401, String(unauth.status));
  const del = await call('/api/messages/' + id, { method: 'DELETE' }, env, adminHeaders());
  ok('管理员删除成功', del.status === 200 && del.body.deleted === true, JSON.stringify(del.body));
  ok('仅剩一条消息', (await msgKeys(kv)) === 1);
  const audit = JSON.parse(await kv.get('meta:audit'));
  ok('删除写入审计日志', audit.items[0].action === 'message.delete', JSON.stringify(audit.items[0]));
}

// ================================================================
section('5. 静默时段：只落库不外发');
{
  const { env, kv } = makeEnv();
  let sent = 0;
  globalThis.fetch = async () => { sent++; return new Response(JSON.stringify({ errcode: 0 }), { status: 200 }); };
  await call('/api/channels', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ channels: [
    { id: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=DT', enabled: true },
  ] }) }, env);
  const s = await call('/api/settings', {
    method: 'PUT', headers: adminHeaders(),
    body: JSON.stringify({ settings: { quietEnabled: true, quietStart: '00:00', quietEnd: '23:59', quietChannels: ['dingtalk'] } }),
  }, env);
  ok('静默设置保存成功', s.status === 200 && s.body.settings.quietEnabled === true, JSON.stringify(s.body));
  const r = await call('/send?token=' + MASTER + '&title=静默测试&content=x', {}, env);
  ok('消息仍落库', r.status === 200 && (await msgKeys(kv)) === 1);
  ok('外发被跳过', sent === 0, 'sent=' + sent);
  ok('响应标记 silenced', r.body.silenced === true, JSON.stringify(r.body.silenced));
}

// ================================================================
section('6. 入站签名校验（L2）');
{
  const secret = 'hmac-secret-v20';
  const { env } = makeEnv({ INBOUND_SIGNING_SECRET: secret });
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  const raw = JSON.stringify({ title: '签名测试', content: 'x' });
  const noSig = await worker.fetch(new Request('https://notify.test/api/send', {
    method: 'POST', headers: makeHeaders({ 'Content-Type': 'application/json', 'X-Token': MASTER }), body: raw,
  }), env);
  ok('缺少签名被拒绝', noSig.status === 403, String(noSig.status));
  const sig = createHmac('sha256', secret).update(raw).digest('hex');
  const good = await worker.fetch(new Request('https://notify.test/api/send', {
    method: 'POST',
    headers: makeHeaders({ 'Content-Type': 'application/json', 'X-Token': MASTER, 'X-Cfn-Signature': 'sha256=' + sig }),
    body: raw,
  }), env);
  const body = await good.json();
  ok('正确签名放行', good.status === 200 && body.ok === true, JSON.stringify(body));
}

// ================================================================
section('7. 安全边界：Webhook 校验 / 超大请求体 / 密钥泄露');
{
  const { env } = makeEnv();
  const httpUrl = await call('/api/channels', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ channels: [
    { id: 'wecom', webhook: 'http://example.com/hook', enabled: true },
  ] }) }, env);
  ok('拒绝 HTTP Webhook', httpUrl.status === 400, JSON.stringify(httpUrl.body));
  const privateUrl = await call('/api/channels', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ channels: [
    { id: 'wecom', webhook: 'https://192.168.1.1/hook', enabled: true },
  ] }) }, env);
  ok('拒绝内网 Webhook', privateUrl.status === 400, JSON.stringify(privateUrl.body));

  const big = await call('/api/send', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ title: 'x', content: 'a'.repeat(300000) }),
  }, env);
  ok('超大请求体返回 413', big.status === 413, String(big.status));

  const status = await call('/api/status?token=' + READ, {}, env);
  ok('状态接口不泄露密钥', !JSON.stringify(status.body).includes(MASTER) && !JSON.stringify(status.body).includes(READ));
  const page = await worker.fetch(new Request('https://notify.test/?token=' + READ), env);
  const html = await page.text();
  ok('页面不泄露管理密钥', !html.includes(MASTER));
}

// ================================================================
section('8. 发送限流与逻辑一致性');
{
  const { env } = makeEnv({ SEND_RATE_PER_MIN: '5', KEY_RATE_PER_MIN: '5' });
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  let last;
  for (let i = 0; i < 6; i++) {
    last = await call('/send?token=' + MASTER + '&title=限流' + i + '&content=x', {}, env,
      { 'CF-Connecting-IP': '203.0.113.' + (100 + i) });
  }
  ok('第 6 次请求按 IP 限流返回 429', last.status === 429, String(last.status));
  ok('429 带 Retry-After', Number(last.res.headers.get('Retry-After')) > 0);

  const status = await call('/api/status?token=' + READ, {}, env);
  ok('版本号为 2.0.0', status.body.version === '2.0.0', status.body.version);
  ok('状态声明新特性', (status.body.features || []).includes('channels') && (status.body.features || []).includes('rate-limit'));
  ok('状态含渠道配置', Array.isArray(status.body.channels) && status.body.channels.length === 3);
  ok('状态含静默设置', Boolean(status.body.settings) && status.body.settings.quietEnabled === false);
  ok('状态含消息保留天数', status.body.messageTtlDays === 90, String(status.body.messageTtlDays));
}

globalThis.fetch = origFetch;
console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
