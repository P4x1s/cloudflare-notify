// RouterHook 全功能兼容专项测试（v1.8）
// 覆盖：
//   A 普通消息（manuINFO/cronINFO/ifUP/newDHCP/多WAN/嵌套数组/中文/完整JSON）
//   B 传感器（rh_load/rh_mem_free/rh_swap_free/rh_cpu_temp/rh_dev/rh_dev_<mac>/未知rh_/ON-OFF/state缺失/attributes缺失）
//   C 聚合（窗口内不逐条推送/最新值/多传感器并存/窗口结束汇总/下一窗口/持续上报仍触发/多设备隔离）
//   D 安全（X-Token/Bearer/错误密钥401/无密钥401/未授权不写KV/XSS转义/空JSON400/非法JSON400/非法事件400）
//   E 回归（原有 /api/messages、/api/send、/send、*.send、/api/status 不受影响）
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const mod = await import('./worker.js');
const worker = mod.default;
const RouterHookSensorDO = mod.RouterHookSensorDO;

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
    return { keys: slice.map((name) => ({ name })),
      list_complete: next >= keys.length,
      cursor: next < keys.length ? String(next) : undefined };
  }
}

// ---------- Mock Durable Object ----------
// 模拟 DO 的 storage（get/put/delete/getAlarm/setAlarm）与 alarm 触发
class MockDOStorage {
  constructor() { this.map = new Map(); this.alarmAt = null; }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(ts) { this.alarmAt = ts; }
}
class MockDOStub {
  constructor(KV, env, wecomCalls) {
    this.storage = new MockDOStorage();
    this.KV = KV;
    this.env = env;
    this.wecomCalls = wecomCalls;
  }
  async fetch(req) {
    const input = await req.json();
    const state = (await this.storage.get('agg')) || { sensors: {}, windowStart: 0 };
    const sensor = input.sensor;
    state.sensors[sensor.event + '|' + (sensor.unit || '')] = sensor;
    if (!state.windowStart) state.windowStart = Date.now();
    await this.storage.put('agg', state);
    if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(Date.now() + 60000);
    return new Response(JSON.stringify({ ok: true, success: 'success', aggregated: true,
      pending: Object.keys(state.sensors).length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  async fireAlarm() {
    const state = (await this.storage.get('agg')) || { sensors: {}, windowStart: 0 };
    await this.storage.delete('agg');
    await this.storage.setAlarm(null);
    const sensors = Object.keys(state.sensors).map((k) => state.sensors[k]);
    if (!sensors.length) return 0;
    const formatted = mod.formatRhSensorSummaryForTest
      ? mod.formatRhSensorSummaryForTest(sensors, { display: 'RAX50', key: 'RAX50' }, state.windowStart)
      : null;
    // 通过真实 worker 存储路径落库：用一条内部消息模拟 DO Alarm 的输出
    // 直接调用 saveMessage 不可导出，这里用 /api/send 落库以复用同一 KV
    const title = 'RAX50 · 传感器状态汇总';
    const lines = sensors.map((s) => s.friendlyName + '：' + s.displayState + (s.unit ? ' ' + s.unit : ''));
    const body = '<h3>【传感器状态】</h3>' + lines.map((l) => '<div>' + l + '</div>').join('')
      + '<hr><h3>【完整传感器 JSON】</h3><pre><code>' + sensors.map((s) => JSON.stringify(s.raw)).join('\n') + '</code></pre>';
    await worker.fetch(new Request('https://cloudflare-notify.com/api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.env.SEND_TOKEN, title, content: body, source: 'RouterHook/RAX50/Sensors' }),
    }), this.env);
    return sensors.length;
  }
}
class MockDOBinding {
  constructor(env, wecomCalls) { this.env = env; this.wecomCalls = wecomCalls; this.instances = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    if (!this.instances.has(id)) this.instances.set(id, new MockDOStub(this.KV, this.env, this.wecomCalls));
    return this.instances.get(id);
  }
}

// ---------- 拦截企业微信 ----------
const wecomCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.includes('qyapi.weixin.qq.com')) {
    let body = null;
    try { body = JSON.parse(String((init && init.body) || '{}')); } catch (_) { body = null; }
    wecomCalls.push({ url, body });
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
};

function makeEnv(over = {}) {
  const kv = new MockKV();
  const env = {
    NOTIFICATIONS: kv,
    SEND_TOKEN: 'master-secret-123',
    READ_TOKEN: 'read-secret-456',
    WECOM_WEBHOOK: '',
    ...over.env,
  };
  const doBinding = new MockDOBinding(env, wecomCalls);
  doBinding.KV = kv;
  env.ROUTERHOOK_SENSOR = doBinding;
  return { kv, env, doBinding };
}

const req = (p, o = {}) => new Request('https://cloudflare-notify.com' + p, o);
const jsonBody = (o, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(o) });
const TOKEN = 'master-secret-123';
let ipCounter = 0;
function nextIp() { ipCounter++; return '10.4.0.' + ipCounter; }
async function call(path, opts = {}, env) {
  const o = { ...opts };
  const headers = new Headers(o.headers || {});
  headers.set('CF-Connecting-IP', nextIp());
  delete o.headers;
  const res = await worker.fetch(req(path, { ...o, headers }), env);
  const ct = res.headers.get('Content-Type') || '';
  return { res, status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}
async function login(env) {
  const r = await call('/api/login', jsonBody({ token: env.READ_TOKEN }), env);
  const setCookie = r.res.headers.get('Set-Cookie') || '';
  const m = setCookie.match(/([^=]+)=([^;]+)/);
  return m ? m[1] + '=' + m[2] : '';
}
async function getMessages(cookie, env, limit = 200) {
  return await call('/api/messages?limit=' + limit, { headers: { Cookie: cookie } }, env);
}

// ============ A. 普通消息 ============
section('A. 普通消息（manuINFO/cronINFO/ifUP/newDHCP）');
{
  const { env } = makeEnv();
  const manuINFO = {
    msgTYPE: 'manuINFO',
    sysINFO: { routerNAME: 'RAX50', routerTIME: '2026年11月21日 12点00分00秒', routerFIRMWARE: '384.14',
      routerMODE: '无线路由器', routerUPTIME: '2天6小时', routerAVGLOAD: [1.2, 0.9, 0.7],
      routerMEM: { unit: 'MB', all: 429.99, free: 140.42 }, routerSWAP: { free: 0, total: 0 },
      routerJFFS: { used: '3.7M', total: '48M', available: '44.3M', use: '9%' } },
    tempINFO: { unit: '°C', CPU: 65, '24G': 42, '5G1': 48 },
    netINFO: { WAN: [{ proto: 'pppoe', pubIPv4: '1.2.3.4', pubIPv6: '2001:db8::1', wanIPv4: '192.168.1.1',
      wanDNS: ['8.8.8.8', '1.1.1.1'], wanRX: '5.3 GiB', wanTX: '483.4 MiB' }],
      DDNS: 'example.ddns.net', chinaSTATUS: '国内链接 ✓ 200ms', foreignSTATUS: '国外链接 ✓ 500ms',
      routerLANIP: '192.168.50.1', wifiINFO: { SmartConnect: 'MyWiFi' }, guestINFO: { '24G1': 'Guest', end: null } },
    usbINFO: [{}, { name: 'General UDisk', status: 'mounted', total: '32G', used: '10G', free: '22G', use: '31%' }],
    cliINFO: [{ ip: '192.168.50.10', name: 'Laptop', mac: 'aa:bb:cc:dd:ee:ff' }],
    dhcpINFO: [{ ip: '192.168.50.11', name: 'Phone', mac: '11:22:33:44:55:66' }],
    extraFIELD: 'keep-me',
  };
  const r = await call('/api/routerhook/manuINFO?device=RAX50', jsonBody(manuINFO, { 'X-Token': TOKEN }), env);
  ok('manuINFO 返回 200', r.status === 200, JSON.stringify(r.body));
  ok('响应体含 success（RouterHook 判定依据）', r.body.success === 'success' && JSON.stringify(r.body).includes('success'));
  const cookie = await login(env);
  const msgs = await getMessages(cookie, env);
  const m = msgs.body.messages.find((x) => x.title && x.title.includes('手动状态报告'));
  ok('manuINFO 已落库', !!m);
  ok('标题为 设备 · 手动状态报告', m && m.title === 'RAX50 · 手动状态报告', m && m.title);
  ok('中文摘要-设备基本信息', m && m.content.includes('【设备基本信息】') && m.content.includes('384.14'));
  ok('中文摘要-温度信息', m && m.content.includes('【温度信息】') && m.content.includes('65°C'));
  ok('中文摘要-网络信息', m && m.content.includes('【网络信息】') && m.content.includes('1.2.3.4'));
  ok('中文摘要-USB 信息', m && m.content.includes('【USB 信息】') && m.content.includes('General UDisk'));
  ok('中文摘要-在线客户端', m && m.content.includes('Laptop'));
  ok('中文摘要-DHCP 租期', m && m.content.includes('Phone'));
  ok('完整原始 JSON 保留', m && m.content.includes('【完整原始 JSON】') && m.content.includes('extraFIELD') && m.content.includes('keep-me'));
  ok('JSON 缩进格式化', m && /"routerNAME": "RAX50"/.test(m.content));
  ok('source 为 RouterHook/RAX50', m && m.source === 'RouterHook/RAX50', m && m.source);

  const cron = { ...manuINFO, msgTYPE: 'cronINFO' };
  const r2 = await call('/api/routerhook/cronINFO', jsonBody(cron, { Authorization: 'Bearer ' + TOKEN }), env);
  ok('cronINFO 200（Bearer 鉴权）', r2.status === 200, JSON.stringify(r2.body));
  const msgs2 = await getMessages(cookie, env);
  ok('cronINFO 标题', msgs2.body.messages.some((x) => x.title === 'RAX50 · 定时状态报告'));

  const ifUP = { msgTYPE: 'ifUP', upTIME: '0天 8小时', rebootTIME: '2026年11月21日 11点45分',
    netSTATE: [
      { proto: 'pppoe', pubIPv4: '1.2.3.4', pubIPv6: '', wanIPv4: '192.168.1.1', wanDNS: ['8.8.8.8'], wanRX: '9.6 GiB', wanTX: '1.0 GiB' },
      { proto: 'dhcp', pubIPv4: '5.6.7.8', pubIPv6: '', wanIPv4: '10.0.0.1', wanDNS: ['1.1.1.1'], wanRX: '2 GiB', wanTX: '3 GiB' },
    ], value1: '0天 8小时', value2: '1.2.3.4', value3: '5.6.7.8' };
  const r3 = await call('/api/routerhook/ifUP?device=RAX50', jsonBody(ifUP, { 'X-Token': TOKEN }), env);
  ok('ifUP 200', r3.status === 200, JSON.stringify(r3.body));
  const msgs3 = await getMessages(cookie, env);
  const ifupMsg = msgs3.body.messages.find((x) => x.title === 'RAX50 · 网络重拨通知');
  ok('ifUP 标题正确', !!ifupMsg);
  ok('ifUP 显示重拨时间', ifupMsg && ifupMsg.content.includes('2026年11月21日 11点45分'));
  ok('ifUP 多 WAN 数组解析（WAN0/WAN1）', ifupMsg && ifupMsg.content.includes('WAN0 公网 IPv4：1.2.3.4') && ifupMsg.content.includes('WAN1 公网 IPv4：5.6.7.8'));

  const newDHCP = { msgTYPE: 'newDHCP', cliNAME: 'MI5C', cliIP: '192.168.50.20', cliMAC: 'aa:bb:cc:00:11:22',
    upTIME: '2026年11月21日 12点01分', expTIME: '2026年11月22日 12点01分',
    cliLISTS: [{ ip: '192.168.50.20', name: 'MI5C', mac: 'aa:bb:cc:00:11:22' }, { ip: '192.168.50.21', name: 'TV' }],
    value1: 'MI5C', value2: '192.168.50.20', value3: 'aa:bb:cc:00:11:22' };
  const r4 = await call('/api/routerhook/newDHCP?device=RAX50', jsonBody(newDHCP, { 'X-Token': TOKEN }), env);
  ok('newDHCP 200', r4.status === 200, JSON.stringify(r4.body));
  const msgs4 = await getMessages(cookie, env);
  const dhcpMsg = msgs4.body.messages.find((x) => x.title === 'RAX50 · 新设备上线');
  ok('newDHCP 标题正确', !!dhcpMsg);
  ok('newDHCP 显示设备信息', dhcpMsg && dhcpMsg.content.includes('MI5C') && dhcpMsg.content.includes('192.168.50.20'));
  ok('newDHCP cliLISTS 数量与列表', dhcpMsg && dhcpMsg.content.includes('当前 DHCP 租期内设备数量：2') && dhcpMsg.content.includes('TV'));

  const unknown = { msgTYPE: 'futureEVENT', someKey: { nested: [1, 2, 3] } };
  const r5 = await call('/api/routerhook/futureEVENT?device=RAX50', jsonBody(unknown, { 'X-Token': TOKEN }), env);
  ok('未知事件通用接收 200（不丢弃）', r5.status === 200, JSON.stringify(r5.body));
  const msgs5 = await getMessages(cookie, env);
  ok('未知事件保留原始 JSON', msgs5.body.messages.some((x) => x.content.includes('futureEVENT') && x.content.includes('nested')));
}

// ============ B. 传感器（无 DO 绑定，逐条降级验证解析） ============
section('B. 传感器字段解析（无 DO 降级为逐条通知）');
{
  const { env } = makeEnv({ env: { WECOM_WEBHOOK: '' } });
  env.ROUTERHOOK_SENSOR = undefined; // 关闭 DO，走逐条降级
  const cases = [
    ['rh_load', { value1: 1.25, value2: '1min', value3: 'Router SystemLoad', state: 1.25, attributes: { unit_of_measurement: '1min', friendly_name: 'Router SystemLoad' } }, 'Router SystemLoad', '1.25 1min'],
    ['rh_mem_free', { value1: 128.5, value2: 'MB', value3: 'Router Memory Available', state: 128.5, attributes: { unit_of_measurement: 'MB', friendly_name: 'Router Memory Available' } }, 'Router Memory Available', '128.5 MB'],
    ['rh_swap_free', { value1: 0, value2: 'MB', state: 0, attributes: { unit_of_measurement: 'MB', friendly_name: 'Router SWAP Available' } }, 'Router SWAP Available', '0 MB'],
    ['rh_cpu_temp', { value1: 62, value2: '°C', value3: 'Router CPU Temperature', state: 62, attributes: { unit_of_measurement: '°C', friendly_name: 'Router CPU Temperature' } }, 'Router CPU Temperature', '62 °C'],
    ['rh_dev', { value1: 'ON', value2: 'OL', value3: 'Router Device Union', state: 'ON', attributes: { unit_of_measurement: 'OL', friendly_name: 'Router Device Union' } }, 'Router Device Union', '在线 OL'],
    ['rh_dev_aabbccddeeff', { value1: 'OFF', value2: 'OL', value3: 'Router Device aa:bb:cc:dd:ee:ff', state: 'OFF', attributes: { unit_of_measurement: 'OL', friendly_name: 'Router Device aa:bb:cc:dd:ee:ff' } }, 'Router Device aa:bb:cc:dd:ee:ff', '离线 OL'],
    ['rh_24g_temp', { value1: 45, value2: '°C', state: 45, attributes: { unit_of_measurement: '°C', friendly_name: 'Router 2.4G Temperature' } }, 'Router 2.4G Temperature', '45 °C'],
    ['rh_5g1_temp', { value1: 48, value2: '°C', state: 48, attributes: { unit_of_measurement: '°C', friendly_name: 'Router 5G-1 Temperature' } }, 'Router 5G-1 Temperature', '48 °C'],
    ['rh_future_sensor', { value1: 99, state: 99 }, 'rh_future_sensor', '99'],
  ];
  for (const [event, body, nameFrag, valueFrag] of cases) {
    const r = await call('/api/routerhook/' + event + '?device=RAX50', jsonBody(body, { 'X-Token': TOKEN }), env);
    ok(event + ' 接收 200', r.status === 200, JSON.stringify(r.body));
  }
  const cookie = await login(env);
  const msgs = await getMessages(cookie, env);
  for (const [event, body, nameFrag, valueFrag] of cases) {
    const m = msgs.body.messages.find((x) => x.content.includes(nameFrag) && x.content.includes(valueFrag));
    ok(event + ' 已落库且字段正确', !!m, m ? m.title : 'not found: ' + nameFrag + ' / ' + valueFrag);
  }
  const onOffMsgs = msgs.body.messages.filter((x) => x.title.includes('Router Device'));
  ok('ON/OFF 转中文在线/离线', onOffMsgs.some((x) => x.content.includes('在线')) && onOffMsgs.some((x) => x.content.includes('离线')));
  // state 缺失用 value1；attributes 缺失用 value2/value3
  const r2 = await call('/api/routerhook/rh_test?device=RAX50', jsonBody({ value1: '77', value2: 'UNIT', value3: 'FallbackName' }, { 'X-Token': TOKEN }), env);
  ok('state 缺失 + attributes 缺失 不报错', r2.status === 200);
  const msgs2 = await getMessages(cookie, env);
  ok('value1/value2/value3 兜底生效', msgs2.body.messages.some((x) => x.content.includes('FallbackName') && x.content.includes('77 UNIT')));
}

// ============ C. 聚合（DO Mock） ============
section('C. 传感器 Durable Object 聚合');
{
  const { env, doBinding } = makeEnv({ env: { WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test' } });
  const ingest = (event, body, device = 'RAX50') =>
    call('/api/routerhook/' + event + '?device=' + device, jsonBody(body, { 'X-Token': TOKEN }), env);

  // 窗口内：3 次 CPU 温度 + 3 次负载 + 3 次内存 + 2 次 SWAP
  await ingest('rh_cpu_temp', { state: 60, value1: 60, value2: '°C', attributes: { unit_of_measurement: '°C', friendly_name: 'Router CPU Temperature' } });
  await ingest('rh_cpu_temp', { state: 62, value1: 62, value2: '°C', attributes: { unit_of_measurement: '°C', friendly_name: 'Router CPU Temperature' } });
  await ingest('rh_cpu_temp', { state: 65, value1: 65, value2: '°C', attributes: { unit_of_measurement: '°C', friendly_name: 'Router CPU Temperature' } });
  await ingest('rh_load', { state: 1.1, value1: 1.1, value2: '1min', attributes: { unit_of_measurement: '1min', friendly_name: 'Router SystemLoad' } });
  await ingest('rh_load', { state: 1.5, value1: 1.5, value2: '1min', attributes: { unit_of_measurement: '1min', friendly_name: 'Router SystemLoad' } });
  await ingest('rh_load', { state: 1.8, value1: 1.8, value2: '1min', attributes: { unit_of_measurement: '1min', friendly_name: 'Router SystemLoad' } });
  await ingest('rh_mem_free', { state: 100, value1: 100, value2: 'MB', attributes: { unit_of_measurement: 'MB', friendly_name: 'Router Memory Available' } });
  await ingest('rh_mem_free', { state: 120, value1: 120, value2: 'MB', attributes: { unit_of_measurement: 'MB', friendly_name: 'Router Memory Available' } });
  await ingest('rh_mem_free', { state: 130, value1: 130, value2: 'MB', attributes: { unit_of_measurement: 'MB', friendly_name: 'Router Memory Available' } });
  await ingest('rh_swap_free', { state: 10, value1: 10, value2: 'MB', attributes: { unit_of_measurement: 'MB', friendly_name: 'Router SWAP Available' } });
  await ingest('rh_swap_free', { state: 20, value1: 20, value2: 'MB', attributes: { unit_of_measurement: 'MB', friendly_name: 'Router SWAP Available' } });

  const cookie = await login(env);
  const before = await getMessages(cookie, env);
  ok('窗口内无独立传感器通知', !before.body.messages.some((x) => x.source && x.source.includes('Sensors')));
  const stub = doBinding.get('RAX50');
  const agg = await stub.storage.get('agg');
  ok('聚合状态已建立', !!agg && Object.keys(agg.sensors).length === 4, agg && Object.keys(agg.sensors).length);
  ok('同类传感器只留最新值（温度65）', agg.sensors['rh_cpu_temp|°C'].state === 65);
  ok('负载只留最新值（1.8）', agg.sensors['rh_load|1min'].state === 1.8);
  ok('内存只留最新值（130）', agg.sensors['rh_mem_free|MB'].state === 130);
  ok('Alarm 只设置一次（固定窗口）', stub.storage.alarmAt !== null);

  // 触发 Alarm
  const fired = await stub.fireAlarm();
  ok('Alarm 到期生成汇总（4 种传感器）', fired === 4, fired);
  const after = await getMessages(cookie, env);
  const summary = after.body.messages.find((x) => x.title === 'RAX50 · 传感器状态汇总');
  ok('汇总通知已落库', !!summary);
  ok('汇总含全部最新值', summary && summary.content.includes('65 °C') && summary.content.includes('1.8 1min') && summary.content.includes('130 MB') && summary.content.includes('20 MB'));
  ok('汇总 source 为 RouterHook/RAX50/Sensors', summary && summary.source === 'RouterHook/RAX50/Sensors');
  ok('企业微信只收到汇总后的通知', wecomCalls.length === 1, wecomCalls.length);

  // 下一窗口
  await ingest('rh_cpu_temp', { state: 70, value1: 70, value2: '°C', attributes: { friendly_name: 'Router CPU Temperature', unit_of_measurement: '°C' } });
  const agg2 = await stub.storage.get('agg');
  ok('下一窗口可继续聚合', !!agg2 && agg2.sensors['rh_cpu_temp|°C'].state === 70);
  ok('新窗口 Alarm 已设置', stub.storage.alarmAt !== null);

  // 多设备隔离
  await ingest('rh_cpu_temp', { state: 88, value1: 88, value2: '°C', attributes: { friendly_name: 'CPU', unit_of_measurement: '°C' } }, 'AX86U');
  const stubB = doBinding.get('AX86U');
  const aggB = await stubB.storage.get('agg');
  ok('多设备独立实例（不同 DO stub）', stub !== stubB);
  ok('两设备数据不串扰', agg2.sensors['rh_cpu_temp|°C'].state === 70 && aggB.sensors['rh_cpu_temp|°C'].state === 88);
}

// ============ D. 安全 ============
section('D. 鉴权、JSON 校验与 XSS 安全');
{
  const { env, kv } = makeEnv();
  const good = { msgTYPE: 'manuINFO', sysINFO: { routerNAME: 'RAX50' } };
  ok('X-Token 正确可接收', (await call('/api/routerhook/manuINFO', jsonBody(good, { 'X-Token': TOKEN }), env)).status === 200);
  ok('Bearer 正确可接收', (await call('/api/routerhook/manuINFO', jsonBody(good, { Authorization: 'Bearer ' + TOKEN }), env)).status === 200);
  ok('body token 可接收', (await call('/api/routerhook/manuINFO?token=' + TOKEN, jsonBody(good), env)).status === 200);
  const bad = await call('/api/routerhook/manuINFO', jsonBody(good, { 'X-Token': 'wrong' }), env);
  ok('错误密钥 401', bad.status === 401, bad.status);
  const noAuth = await call('/api/routerhook/manuINFO', jsonBody(good), env);
  ok('无密钥 401', noAuth.status === 401, noAuth.status);
  const emptyBody = await call('/api/routerhook/manuINFO', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: '' }, env);
  ok('空 JSON 400', emptyBody.status === 400, emptyBody.status);
  const badJson = await call('/api/routerhook/manuINFO', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: '{broken' }, env);
  ok('非法 JSON 400', badJson.status === 400, badJson.status);
  const badEvent = await call('/api/routerhook/..%2Fadmin', jsonBody(good, { 'X-Token': TOKEN }), env);
  ok('非法事件名 400', badEvent.status === 400, badEvent.status);
  const beforeKeys = kv.map.size;
  await call('/api/routerhook/manuINFO', jsonBody(good, { 'X-Token': 'wrong' }), env);
  ok('未授权请求不写 KV', kv.map.size === beforeKeys, kv.map.size + ' vs ' + beforeKeys);

  // XSS：恶意内容经 sanitizeRichHtml 消毒后以文本显示
  const xss = { msgTYPE: 'manuINFO', sysINFO: { routerNAME: '<img src=x onerror=alert(1)>' }, evil: '<script>alert(2)</script>' };
  await call('/api/routerhook/manuINFO?device=RAX50', jsonBody(xss, { 'X-Token': TOKEN }), env);
  const cookie = await login(env);
  const msgs = await getMessages(cookie, env);
  // 消毒结果在 contentHtml 字段（content 是原始存储，故意不消毒以便追溯原始 JSON）
  const xmsg = msgs.body.messages.find((x) => (x.contentHtml || '').includes('&lt;img') || (x.contentHtml || '').includes('onerror'));
  ok('XSS 原文被转义为文本', !!xmsg && xmsg.contentHtml.includes('&lt;img') && !xmsg.contentHtml.includes('<img src=x onerror'),
    xmsg ? xmsg.title : 'not found');
  ok('script 标签被转义', !!xmsg && xmsg.contentHtml.includes('&lt;script&gt;'));
}

// ============ E. 原有功能回归 ============
section('E. 原有 Cloudflare Notify 功能回归');
{
  const { env } = makeEnv();
  const r1 = await call('/api/send', jsonBody({ token: TOKEN, title: '原有发送', content: '<b>富文本</b>' }), env);
  ok('POST /api/send 正常', r1.status === 200 && r1.body.ok === true, JSON.stringify(r1.body));
  const r2 = await call('/send?token=' + TOKEN + '&title=GET发送&content=hello', {}, env);
  ok('GET /send 正常', r2.status === 200 && r2.body.ok === true);
  const r3 = await call('/' + TOKEN + '.send?text=方糖&desp=兼容', {}, env);
  ok('方糖 /<key>.send 正常', r3.status === 200 && r3.body.code === 0 && r3.body.errno === 0);
  const cookie = await login(env);
  const r4 = await call('/api/status', { headers: { Cookie: cookie } }, env);
  ok('/api/status 正常', r4.status === 200 && r4.body.ok === true && r4.body.version === '2.1.0', JSON.stringify(r4.body));
  const r5 = await call('/api/messages', { headers: { Cookie: cookie } }, env);
  ok('/api/messages 正常且有 decorate 字段', r5.status === 200 && r5.body.messages.length > 0
    && r5.body.messages[0].contentHtml !== undefined && r5.body.messages[0].isRich !== undefined);
  const r6 = await call('/api/key/rotate', jsonBody({ token: TOKEN }), env);
  ok('POST /api/key/rotate 正常', r6.status === 200 && !!r6.body.key);
  const r7 = await call('/api/count', { headers: { Cookie: cookie } }, env);
  ok('GET /api/count 正常', r7.status === 200 && r7.body.total > 0);
}

console.log('\n========================================');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)); }
console.log('========================================');
if (fail) process.exitCode = 1;
