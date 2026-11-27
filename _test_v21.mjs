// v2.1.0 专项测试：L1 导出 / L3 语言字典 / L4 统计 / L5 API 文档 / L6 多租户。
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

const MASTER = 'master-token-v21';
const READ = 'read-token-v21';
let ipSeq = 0;
function makeEnv(over = {}) {
  const kv = new MockKV();
  return { kv, env: { NOTIFICATIONS: kv, SEND_TOKEN: MASTER, READ_TOKEN: READ, WECOM_WEBHOOK: '', ...over } };
}
async function call(path, opts, env, headers = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '172.20.' + (ipSeq++ % 250) + '.' + (1 + ipSeq % 250), ...((opts && opts.headers) || {}), ...headers });
  const res = await worker.fetch(new Request('https://notify.test' + path, { ...(opts || {}), headers: h }), env);
  const ct = res.headers.get('Content-Type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { res, body, status: res.status, ct };
}
const admin = () => ({ 'X-Token': MASTER, 'Content-Type': 'application/json' });
const reader = () => ({ 'X-Token': READ });

// ================================================================
section('1. L5 开放 API 文档');
{
  const { env } = makeEnv();
  const spec = await call('/openapi.json', {}, env);
  ok('OpenAPI 版本为 3.0.3', spec.status === 200 && spec.body.openapi === '3.0.3', JSON.stringify(spec.body).slice(0, 120));
  ok('规范包含 v2.2 版本号', spec.body.info.version === '2.2.0', spec.body.info.version);
  ok('规范覆盖导出/统计/租户端点', ['/api/export', '/api/stats', '/api/tenants'].every((p) => spec.body.paths[p]));
  const docs = await call('/docs', {}, env);
  ok('文档页公开可访问', docs.status === 200 && docs.ct.includes('text/html'), docs.ct);
  ok('文档页渲染端点表', docs.body.includes('doc-table') && docs.body.includes('/api/tenants'));
  ok('文档页不泄露密钥', !docs.body.includes(MASTER) && !docs.body.includes(READ));
}

// ================================================================
section('2. L1 导出：JSON / CSV / Markdown');
{
  const { env } = makeEnv();
  await call('/api/send?token=' + MASTER + '&title=Hello&content=line1%2C%22quoted%22&source=ci', {}, env);
  await call('/api/send?token=' + MASTER + '&title=World&content=body2&source=cron', {}, env);
  await call('/api/send?token=' + MASTER + '&title=%3Dcmd%28%29&content=body3&source=test', {}, env);
  const unauth = await call('/api/export?format=json', {}, env);
  ok('导出需要查看权限', unauth.status === 401, JSON.stringify(unauth.body));
  const j = await call('/api/export?format=json', {}, env, reader());
  ok('JSON 导出 200', j.status === 200 && j.ct.includes('application/json'), j.ct);
  ok('JSON 含全部消息与字段', j.body.count === 3 && j.body.messages[0].id && j.body.messages[0].deliveries);
  ok('JSON 带下载文件名', (j.res.headers.get('Content-Disposition') || '').includes('notify-'));
  const csv = await call('/api/export?format=csv', {}, env, reader());
  ok('CSV 为 text/csv', csv.status === 200 && csv.ct.includes('text/csv'), csv.ct);
  const rawCsv = await worker.fetch(new Request('https://notify.test/api/export?format=csv', { headers: reader() }), env);
  const csvBytes = new Uint8Array(await rawCsv.arrayBuffer());
  ok('CSV 带 UTF-8 BOM', csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    [csvBytes[0], csvBytes[1], csvBytes[2]].join(','));
  ok('CSV 正确转义双引号', csv.body.includes('""quoted""'));
  ok('CSV 防公式注入', csv.body.includes('"\'=cmd()"'), csv.body.slice(0, 300));
  const md = await call('/api/export?format=md', {}, env, reader());
  ok('Markdown 导出标题', md.status === 200 && md.body.includes('# 通知导出') && md.body.includes('## Hello'));
  const bad = await call('/api/export?format=exe', {}, env, reader());
  ok('非法格式被拒绝', bad.status === 400, JSON.stringify(bad.body));
  const limited = await call('/api/export?format=json&limit=1', {}, env, reader());
  ok('limit 参数生效', limited.body.count === 1, String(limited.body.count));
}

// ================================================================
section('3. L4 统计：趋势 / 来源 / 渠道成功率');
{
  const { env } = makeEnv();
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  await call('/api/channels', { method: 'PUT', headers: admin(), body: JSON.stringify({ channels: [
    { id: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=S', enabled: true },
  ] }) }, env);
  await call('/api/send?token=' + MASTER + '&title=A&source=ci', {}, env);
  await call('/api/send?token=' + MASTER + '&title=B&source=cron', {}, env);
  await call('/api/send?token=' + MASTER + '&title=C&source=ci', {}, env);
  const s = await call('/api/stats', {}, env, reader());
  ok('统计 200 且总量正确', s.status === 200 && s.body.total === 3 && s.body.sampled === 3, JSON.stringify(s.body).slice(0, 160));
  ok('近 14 天趋势含 14 项', s.body.daily.length === 14, String(s.body.daily.length));
  ok('今日计数已累加', s.body.daily[13].count === 3, JSON.stringify(s.body.daily[13]));
  ok('来源分布 ci=2 cron=1', (() => {
    const m = Object.fromEntries(s.body.sources.map((x) => [x.name, x.count]));
    return m.ci === 2 && m.cron === 1;
  })(), JSON.stringify(s.body.sources));
  ok('渠道统计含钉钉成功 3 次', (() => {
    const d = s.body.channels.find((c) => c.id === 'dingtalk');
    return d && d.ok === 3 && d.fail === 0 && d.rate === 100;
  })(), JSON.stringify(s.body.channels));
  ok('未鉴权统计被拒绝', (await call('/api/stats', {}, env)).status === 401);
}

// ================================================================
section('4. L6 多租户：隔离 / 密钥 / 配额 / 停用');
{
  const { env } = makeEnv();
  const created = await call('/api/tenants', {
    method: 'POST', headers: admin(),
    body: JSON.stringify({ id: 'acme', name: 'Acme', sendKey: 'tenant-send', readToken: 'tenant-read', dailyQuota: 2 }),
  }, env);
  ok('创建租户成功', created.status === 200 && created.body.ok === true, JSON.stringify(created.body));
  ok('租户响应不回显密钥', !JSON.stringify(created.body).includes('tenant-send') && !JSON.stringify(created.body).includes('tenant-read'));
  const dup = await call('/api/tenants', {
    method: 'POST', headers: admin(), body: JSON.stringify({ id: 'acme' }),
  }, env);
  ok('重复租户被拒绝', dup.status === 409, JSON.stringify(dup.body));
  const badId = await call('/api/tenants', {
    method: 'POST', headers: admin(), body: JSON.stringify({ id: 'BAD ID!' }),
  }, env);
  ok('非法租户 ID 被拒绝', badId.status === 400, JSON.stringify(badId.body));
  const list = await call('/api/tenants', {}, env, reader());
  ok('管理员未授权时租户列表 401', list.status === 401);
  const listOk = await call('/api/tenants', {}, env, admin());
  ok('管理员可列出租户且密钥脱敏', listOk.body.tenants.length === 1 && !JSON.stringify(listOk.body).includes('tenant-send'));

  // 默认租户发送 1 条
  await call('/api/send?token=' + MASTER + '&title=default-msg&source=default', {}, env);
  // 租户用自己的密钥发送 2 条
  const t1 = await call('/api/send?token=tenant-send&title=tenant-1&source=acme', {}, env, { 'X-Tenant-ID': 'acme' });
  const t2 = await call('/api/send?token=tenant-send&title=tenant-2&source=acme', {}, env, { 'X-Tenant-ID': 'acme' });
  ok('租户密钥可发送', t1.status === 200 && t2.status === 200, JSON.stringify(t2.body));
  const masterForTenant = await call('/api/send?token=' + MASTER + '&title=bad&source=acme', {}, env, { 'X-Tenant-ID': 'acme' });
  ok('管理主密钥不能直接发到租户', masterForTenant.status === 401, JSON.stringify(masterForTenant.body));
  const t3 = await call('/api/send?token=tenant-send&title=tenant-3&source=acme', {}, env, { 'X-Tenant-ID': 'acme' });
  ok('超出每日配额返回 429', t3.status === 429 && t3.body.used === 2, JSON.stringify(t3.body));
  const idem = await call('/api/send?token=tenant-send&title=idem&source=acme', {}, env, {
    'X-Tenant-ID': 'acme', 'X-Idempotency-Key': 'k1',
  });
  const idem2 = await call('/api/send?token=tenant-send&title=idem&source=acme', {}, env, {
    'X-Tenant-ID': 'acme', 'X-Idempotency-Key': 'k1',
  });
  ok('配额耗尽时上游无法绕过（幂等只命中已有记录）', idem.status === 429 && idem2.status === 429);

  const defaultList = await call('/api/messages', {}, env, reader());
  const tenantList = await call('/api/messages', {}, env, { 'X-Token': 'tenant-read', 'X-Tenant-ID': 'acme' });
  const defaultText = JSON.stringify(defaultList.body);
  const tenantText = JSON.stringify(tenantList.body);
  ok('默认租户看不到租户消息', defaultText.includes('default-msg') && !defaultText.includes('tenant-1'));
  ok('租户看不到默认租户消息', tenantText.includes('tenant-1') && !tenantText.includes('default-msg'));
  ok('租户查看密钥可读取数据', tenantList.status === 200 && tenantList.body.count === 2, JSON.stringify(tenantList.body).slice(0, 120));
  ok('错误查看密钥被拒绝', (await call('/api/messages', {}, env, { 'X-Token': MASTER, 'X-Tenant-ID': 'acme' })).status === 401);
  const self = await call('/api/tenant', {}, env, { 'X-Token': 'tenant-read', 'X-Tenant-ID': 'acme' });
  ok('租户自查返回配额用量', self.status === 200 && self.body.tenant.usedToday === 2, JSON.stringify(self.body));
  const unknown = await call('/api/messages', {}, env, { 'X-Tenant-ID': 'ghost' });
  ok('未知租户返回 404', unknown.status === 404, JSON.stringify(unknown.body));

  // 提额后停用
  await call('/api/tenants/acme', {
    method: 'PUT', headers: admin(), body: JSON.stringify({ dailyQuota: 10, enabled: false }),
  }, env);
  const disabled = await call('/api/send?token=tenant-send&title=x', {}, env, { 'X-Tenant-ID': 'acme' });
  ok('停用租户无法发送', disabled.status === 403, JSON.stringify(disabled.body));
  await call('/api/tenants/acme', {
    method: 'PUT', headers: admin(), body: JSON.stringify({ enabled: true }),
  }, env);
  const live = await call('/api/messages', {}, env, { 'X-Token': 'tenant-read', 'X-Tenant-ID': 'acme' });
  ok('停用期间数据仍在（重新启用可读）', live.status === 200 && live.body.count === 2);
  await call('/api/tenants/acme', { method: 'DELETE', headers: admin() }, env);
  ok('删除租户后不可访问', (await call('/api/messages', {}, env, { 'X-Tenant-ID': 'acme' })).status === 404);
}

// ================================================================
section('5. L3 语言字典与逻辑一致性');
{
  const { env } = makeEnv();
  const first = await worker.fetch(new Request('https://notify.test/', { headers: reader() }), env);
  const cookie = (first.headers.get('Set-Cookie') || '').split(';')[0];
  const pageRes = await worker.fetch(new Request('https://notify.test/', { headers: { Cookie: cookie } }), env);
  const pageHtml = await pageRes.text();
  ok('会话 Cookie 换发后可访问主页', pageRes.status === 200 && Boolean(cookie), String(pageRes.status));
  ok('主页注入语言字典', pageHtml.includes('window.I18N') && pageHtml.includes('stats.today'));
  ok('主页注入高亮器', pageHtml.includes('window.highlightCode'));
  ok('主页注入统计节点', pageHtml.includes('id="statsCards"'));
  ok('主页注入导出按钮', pageHtml.includes('btnExportCsv'));
  ok('主页含国际化标记', pageHtml.includes('data-i18n="sec.stats"'));
  const loginPage = await call('/', {}, env);
  ok('登录页含品牌化元素与多语言', loginPage.status === 401 && loginPage.body.includes('auth-back') && loginPage.body.includes('window.I18N'));
  ok('登录页错误提示位于输入框下方', loginPage.body.indexOf('id="loginErr"') > loginPage.body.indexOf('id="loginToken"'));
  const login = await call('/?token=' + READ, {}, env, {});
  ok('密钥直达换发 Cookie', login.status === 302);
}

console.log('\nresult: pass=' + pass + ' fail=' + fail);
if (fail) { console.log('failures:\n - ' + failures.join('\n - ')); process.exit(1); }
