// v2.2.0 专项测试：主密钥来源收紧、三渠道测试端点、安全加固与逻辑一致性。
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
      keys: slice.map((name) => ({ name, metadata: this.map.get(name).options.metadata || undefined })),
      list_complete: next >= keys.length,
      cursor: next < keys.length ? String(next) : undefined,
    };
  }
}

const MASTER = 'master-token-v22';
const READ = 'read-token-v22';
let ipSeq = 0;
function makeEnv(over = {}) {
  const kv = new MockKV();
  return { kv, env: { NOTIFICATIONS: kv, SEND_TOKEN: MASTER, READ_TOKEN: READ, WECOM_WEBHOOK: '', ...over } };
}
async function call(path, opts, env, headers = {}) {
  const h = new Headers({
    'CF-Connecting-IP': '10.55.' + (ipSeq++ % 250) + '.' + (1 + ipSeq % 250),
    ...((opts && opts.headers) || {}),
    ...headers,
  });
  const res = await worker.fetch(new Request('https://notify.test' + path, { ...(opts || {}), headers: h }), env);
  const ct = res.headers.get('Content-Type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { res, body, status: res.status, ct };
}
const admin = () => ({ 'X-Token': MASTER, 'Content-Type': 'application/json' });
const reader = () => ({ 'X-Token': READ });

// 捕获渠道 Webhook 的外发请求；不真的访问网络。
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, opts) => {
  outbound.push({ url: String(url), body: JSON.parse(String((opts && opts.body) || '{}')) });
  return new Response(JSON.stringify({ errcode: 0, code: 0, StatusCode: 0 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
async function configureChannels(env) {
  const r = await call('/api/channels', {
    method: 'PUT', body: JSON.stringify({ channels: [
      { id: 'wecom', webhook: 'https://qyapi.example.com/hook?key=SECRET_WECOM_123', enabled: true },
      { id: 'dingtalk', webhook: 'https://oapi.example.com/hook?access_token=SECRET_DING_456', enabled: true },
      { id: 'feishu', webhook: 'https://open.example.com/hook/SECRET_FEISHU_789', enabled: true },
    ] }),
  }, env, admin());
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

// ================================================================
section('1. 管理凭据来源收紧（主密钥禁止走 URL）');
{
  const { env } = makeEnv();
  const good = await call('/api/key/rotate', { method: 'POST' }, env, admin());
  ok('Header 传主密钥可轮换', good.status === 200 && good.body.key, JSON.stringify(good.body).slice(0, 100));
  const rotated = good.body.key;
  const query = await call('/api/key/rotate?token=' + MASTER, { method: 'POST' }, env);
  ok('URL query 中的主密钥被拒绝', query.status === 401, JSON.stringify(query.body));
  const rotating = await call('/api/key/rotate', { method: 'POST' }, env, { 'X-Token': rotated });
  ok('轮换密钥无权执行管理操作', rotating.status === 401, JSON.stringify(rotating.body));
  const bearer = await call('/api/key/rotate', { method: 'POST' }, env, { Authorization: 'Bearer ' + MASTER });
  ok('Bearer 形式仍可用于管理操作', bearer.status === 200, JSON.stringify(bearer.body).slice(0, 100));
  const badQueryCfg = await call('/api/channels?token=' + MASTER, {
    method: 'PUT', body: JSON.stringify({ channels: [] }),
  }, env);
  ok('渠道配置的 query 主密钥同样被拒绝', badQueryCfg.status === 401, JSON.stringify(badQueryCfg.body));
}

// ================================================================
section('2. 三渠道测试端点');
{
  const { env } = makeEnv();
  await configureChannels(env);
  outbound.length = 0;

  const noToken = await call('/api/test-channel', {
    method: 'POST', body: JSON.stringify({ id: 'dingtalk' }),
  }, env);
  ok('测试端点需要发送凭据', noToken.status === 401, JSON.stringify(noToken.body));

  const badId = await call('/api/test-channel', {
    method: 'POST', body: JSON.stringify({ id: 'telegram' }),
  }, env, { 'X-Token': MASTER, 'Content-Type': 'application/json' });
  ok('未知渠道被拒绝', badId.status === 400, JSON.stringify(badId.body));

  const dd = await call('/api/test-channel', {
    method: 'POST', body: JSON.stringify({ id: 'dingtalk' }),
  }, env, { 'X-Token': MASTER, 'Content-Type': 'application/json' });
  ok('钉钉测试返回成功', dd.status === 200 && dd.body.ok === true && dd.body.id === 'dingtalk', JSON.stringify(dd.body));
  const ddCall = outbound.find((x) => x.url.includes('oapi.example.com'));
  ok('钉钉使用 markdown 负载', Boolean(ddCall && ddCall.body.msgtype === 'markdown' && ddCall.body.markdown.title), JSON.stringify(ddCall || {}).slice(0, 160));

  const fs = await call('/api/test-channel', {
    method: 'POST', body: JSON.stringify({ id: 'feishu' }),
  }, env, { 'X-Token': MASTER, 'Content-Type': 'application/json' });
  ok('飞书测试返回成功', fs.status === 200 && fs.body.ok === true && fs.body.id === 'feishu', JSON.stringify(fs.body));
  const fsCall = outbound.find((x) => x.url.includes('open.example.com'));
  ok('飞书使用交互卡片负载', Boolean(fsCall && fsCall.body.msg_type === 'interactive' && fsCall.body.card.header), JSON.stringify(fsCall || {}).slice(0, 160));

  const wc = await call('/api/test-wecom', { method: 'POST' }, env, { 'X-Token': MASTER });
  ok('旧企微别名保持兼容', wc.status === 200 && wc.body.id === 'wecom', JSON.stringify(wc.body));
  const legacy = await call('/api/test-channel?id=wecom', { method: 'POST' }, env, { 'X-Token': MASTER });
  ok('query 指定渠道可用（发送密钥）', legacy.status === 200 && legacy.body.id === 'wecom', JSON.stringify(legacy.body));

  const noCfg = await call('/api/test-channel', {
    method: 'POST', body: JSON.stringify({ id: 'feishu' }),
  }, makeEnv().env, { 'X-Token': MASTER, 'Content-Type': 'application/json' });
  ok('未配置渠道给出明确 400', noCfg.status === 400 && String(noCfg.body.error).includes('飞书'), JSON.stringify(noCfg.body));
}

// ================================================================
section('3. 测试端点限流与签名');
{
  const RATE_MASTER = 'rate-master-unique-2201';
  const rateEnv = makeEnv({ SEND_TOKEN: RATE_MASTER, KEY_RATE_PER_MIN: '1', SEND_RATE_PER_MIN: '1000', SEND_RATE_PER_DAY: '10000' }).env;
  await call('/api/channels', {
    method: 'PUT', body: JSON.stringify({ channels: [
      { id: 'wecom', webhook: 'https://qyapi.example.com/hook?key=RATE_KEY', enabled: true },
    ] }),
  }, rateEnv, { 'X-Token': RATE_MASTER, 'Content-Type': 'application/json' });
  const h = { 'X-Token': RATE_MASTER, 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.99.99.99' };
  const first = await call('/api/test-channel', { method: 'POST', body: JSON.stringify({ id: 'wecom' }) }, rateEnv, h);
  const second = await call('/api/test-channel', { method: 'POST', body: JSON.stringify({ id: 'wecom' }) }, rateEnv, h);
  ok('渠道测试受发送限流约束', first.status === 200 && second.status === 429, first.status + '/' + second.status);

  const { env } = makeEnv({ INBOUND_SIGNING_SECRET: 'sign-secret-2201' });
  await configureChannels({ ...env, INBOUND_SIGNING_SECRET: '' });
  const raw = JSON.stringify({ id: 'dingtalk' });
  const noSig = await call('/api/channels/test', {
    method: 'POST', body: raw,
  }, env, admin());
  ok('管理渠道测试缺签名被拒', noSig.status === 403, JSON.stringify(noSig.body));
  const sig = 'sha256=' + createHmac('sha256', 'sign-secret-2201').update(raw).digest('hex');
  const withSig = await call('/api/channels/test', {
    method: 'POST', body: raw,
  }, env, { ...admin(), 'X-Cfn-Signature': sig });
  ok('正确签名可通过管理渠道测试', withSig.status === 200 && withSig.body.ok === true, JSON.stringify(withSig.body));
  const queryAdmin = await call('/api/channels/test?token=' + MASTER, {
    method: 'POST', body: raw,
  }, env, { 'X-Cfn-Signature': sig, 'Content-Type': 'application/json' });
  ok('管理渠道测试不接受 query 主密钥', queryAdmin.status === 401, JSON.stringify(queryAdmin.body));
}

// ================================================================
section('4. Webhook 安全与脱敏');
{
  const { env } = makeEnv();
  const http = await call('/api/channels', {
    method: 'PUT', body: JSON.stringify({ channels: [{ id: 'dingtalk', webhook: 'http://example.com/hook' }] }),
  }, env, admin());
  ok('拒绝明文 HTTP Webhook', http.status === 400 && String(http.body.error).includes('HTTPS'), JSON.stringify(http.body));
  const privateIp = await call('/api/channels', {
    method: 'PUT', body: JSON.stringify({ channels: [{ id: 'dingtalk', webhook: 'https://192.168.1.1/hook' }] }),
  }, env, admin());
  ok('拒绝内网地址 Webhook', privateIp.status === 400 && String(privateIp.body.error).includes('内网'), JSON.stringify(privateIp.body));
  const loopback = await call('/api/channels', {
    method: 'PUT', body: JSON.stringify({ channels: [{ id: 'feishu', webhook: 'https://localhost/hook' }] }),
  }, env, admin());
  ok('拒绝 localhost Webhook', loopback.status === 400, JSON.stringify(loopback.body));

  await configureChannels(env);
  const listed = await call('/api/channels', {}, env, reader());
  const rawList = JSON.stringify(listed.body);
  ok('渠道列表不泄露完整 Webhook', !rawList.includes('SECRET_DING_456') && !rawList.includes('SECRET_FEISHU_789') && !rawList.includes('SECRET_WECOM_123'), rawList.slice(0, 300));
  ok('渠道列表仅显示脱敏值', rawList.includes('***'), rawList.slice(0, 300));
}

// ================================================================
section('5. 密钥泄露面检查');
{
  const { env } = makeEnv();
  await configureChannels(env);
  await call('/api/send?token=' + MASTER + '&title=SecretMsg&content=body', {}, env);
  const status = await call('/api/status', {}, env, reader());
  const docs = await call('/docs', {}, env);
  const spec = await call('/openapi.json', {}, env);
  const exported = await call('/api/export?format=json', {}, env, reader());
  for (const [name, r] of [['status', status], ['docs', docs], ['openapi', spec], ['export', exported]]) {
    ok(name + ' 不含主密钥', !JSON.stringify(r.body).includes(MASTER));
  }
  ok('导出不含原始 Webhook 密钥', !JSON.stringify(exported.body).includes('SECRET_DING_456'));
  ok('文档明确管理端点不接受 query', String(docs.body).includes('不接受 URL query'));
  const login = await call('/', {}, env);
  ok('登录页不回显主密钥', !String(login.body).includes(MASTER));
}

// ================================================================
section('6. XSS / 注入 / 幂等 / 静默');
{
  const { env } = makeEnv({ SEND_TOKEN: MASTER });
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
  const sent = await call('/api/send?token=' + MASTER + '&title=' + encodeURIComponent(evil) + '&content=' + encodeURIComponent(evil) + '&type=markdown', {}, env);
  ok('恶意内容可正常入库', sent.status === 200, JSON.stringify(sent.body).slice(0, 120));
  const list = await call('/api/messages?limit=10', {}, env, reader());
  const rendered = JSON.stringify((list.body.messages || []).map((m) => m.contentHtml || ''));
  ok('富文本消毒不产生带 onerror 的真实标签', !/<[^>]*onerror/i.test(rendered), rendered.slice(0, 300));
  ok('富文本消毒去除 script 标签', !rendered.includes('<script'));
  ok('富文本消毒去除 javascript: 协议', !rendered.includes('javascript:'));

  const idemHdr = { 'X-Token': MASTER, 'X-Idempotency-Key': 'idem-v22-fixed-001', 'Content-Type': 'application/json' };
  const i1 = await call('/api/send', { method: 'POST', body: JSON.stringify({ title: 'idem', source: 'test' }) }, env, idemHdr);
  const i2 = await call('/api/send', { method: 'POST', body: JSON.stringify({ title: 'idem', source: 'test' }) }, env, idemHdr);
  ok('幂等键重放返回同一结果', i1.body.data && i2.body.data && i1.body.data.id === i2.body.data.id && i2.body.idempotent === true,
    JSON.stringify({ a: i1.body.data && i1.body.data.id, b: i2.body.data && i2.body.data.id, idem: i2.body.idempotent }));

  const qEnv = makeEnv().env;
  await configureChannels(qEnv);
  const quiet = await call('/api/settings', {
    method: 'PUT', body: JSON.stringify({ quietEnabled: true, quietStart: '00:00', quietEnd: '23:59', quietChannels: ['dingtalk', 'feishu'] }),
  }, qEnv, admin());
  ok('静默时段配置成功', quiet.status === 200, JSON.stringify(quiet.body));
  const quietSend = await call('/api/send', {
    method: 'POST', body: JSON.stringify({ title: 'quiet test', source: 'test' }),
  }, qEnv, { 'X-Token': MASTER, 'Content-Type': 'application/json' });
  const dd = (quietSend.body.channels || []).find((c) => c.id === 'dingtalk');
  ok('静默时段跳过外发但仍入库', quietSend.status === 200 && dd && dd.skipped === true && dd.silenced === true,
    JSON.stringify(quietSend.body.channels || []).slice(0, 200));
}

// ================================================================
section('7. 租户隔离与配额');
{
  const { env } = makeEnv();
  const created = await call('/api/tenants', {
    method: 'POST', body: JSON.stringify({ id: 'team_a', name: 'A 组', sendKey: 'tenant-send-a', readToken: 'tenant-read-a', dailyQuota: 2 }),
  }, env, admin());
  ok('租户创建成功', created.status === 200 && created.body.ok === true, JSON.stringify(created.body).slice(0, 200));
  ok('租户密钥在列表中脱敏', !JSON.stringify(created.body).includes('tenant-send-a'));
  await call('/api/tenants', {
    method: 'POST', body: JSON.stringify({ id: 'team_b', name: 'B 组', sendKey: 'tenant-send-b', readToken: 'tenant-read-b', dailyQuota: 2 }),
  }, env, admin());

  await call('/api/send', {
    method: 'POST', body: JSON.stringify({ title: 'A 组专属', source: 'test' }),
  }, env, { 'X-Token': 'tenant-send-a', 'X-Tenant-ID': 'team_a', 'Content-Type': 'application/json' });
  const aList = await call('/api/messages?limit=20', {}, env, { 'X-Token': 'tenant-read-a', 'X-Tenant-ID': 'team_a' });
  const bList = await call('/api/messages?limit=20', {}, env, { 'X-Token': 'tenant-read-b', 'X-Tenant-ID': 'team_b' });
  const dList = await call('/api/messages?limit=20', {}, env, reader());
  ok('租户 A 可见自己的消息', aList.status === 200 && JSON.stringify(aList.body).includes('A 组专属'));
  ok('租户 B 看不到 A 的消息', bList.status === 200 && !JSON.stringify(bList.body).includes('A 组专属'));
  ok('默认租户看不到 A 的消息', dList.status === 200 && !JSON.stringify(dList.body).includes('A 组专属'));

  const unknown = await call('/api/messages', {}, env, { 'X-Token': READ, 'X-Tenant-ID': 'not_exist' });
  ok('未知租户被拒绝', unknown.status === 404, JSON.stringify(unknown.body));
}

// ================================================================
section('8. 版本与接口一致性');
{
  const { env } = makeEnv();
  const status = await call('/api/status', {}, env, reader());
  ok('服务版本为 2.2.0', status.body.version === '2.2.0', status.body.version);
  ok('features 含三渠道测试能力', status.body.features.includes('test-channels'));
  const spec = await call('/openapi.json', {}, env);
  ok('OpenAPI 版本一致', spec.body.info.version === '2.2.0', spec.body.info.version);
  ok('OpenAPI 覆盖新增测试端点', Boolean(spec.body.paths['/api/test-channel'] && spec.body.paths['/api/test-wecom']));
  const session = await call('/api/login', {
    method: 'POST', body: JSON.stringify({ token: READ }),
  }, env, { 'Content-Type': 'application/json' });
  const cookie = session.res.headers.get('Set-Cookie') || '';
  ok('会话 Cookie 为 HttpOnly', cookie.includes('HttpOnly'), cookie);
  ok('会话 Cookie 为 SameSite=Strict', cookie.includes('SameSite=Strict'), cookie);

  const fs = await import('node:fs');
  const src = fs.readFileSync('./src/index.js', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  ok('src/index.js 版本一致', src.includes("const VERSION = '2.2.0'"));
  ok('package.json 版本一致', pkg.version === '2.2.0', pkg.version);
}

globalThis.fetch = realFetch;
console.log('\nresult: pass=' + pass + ' fail=' + fail);
if (fail) { console.log('failures:\n - ' + failures.join('\n - ')); process.exit(1); }
