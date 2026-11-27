// 变量标签专项测试（v1.9）：
//   A 内置变量（date/time/datetime/timestamp/timestamp_ms/weekday/uuid/random/version/source）
//   B 自定义变量（v.<name> / var.<name>，自定义覆盖内置，值安全化/限长）
//   C 单次替换（替换值里的 { } 不二次解析）、未匹配占位符原样保留
//   D 三入口一致（GET /send、POST /api/send、方糖 <key>.send）
//   E 时区 GMT+8、无占位符零开销直通、XSS 经现有消毒链路、向后兼容
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
  async put(k, v, opt) { this.map.set(k, { value: String(v), metadata: opt && opt.metadata }); }
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

function makeEnv() {
  return {
    APP_NAME: 'Cloudflare Notify',
    NOTIFICATIONS: new MockKV(),
    SEND_TOKEN: 'master-key',
    READ_TOKEN: '',
    WECOM_WEBHOOK: '',
  };
}

// 发送并返回落库的消息（取最后一条 msg:）
async function sendAndGetLast(env, url, init) {
  const resp = await worker.fetch(new Request(url, init), env);
  const body = await resp.json();
  const keys = [...env.NOTIFICATIONS.map.keys()].filter((k) => k.startsWith('msg:')).sort();
  const raw = keys.length ? env.NOTIFICATIONS.map.get(keys[keys.length - 1]).value : null;
  return { resp, body, message: raw ? JSON.parse(raw) : null };
}

const BASE = 'https://notify.example.com';
const KEY = 'master-key'; // 用管理主密钥鉴权

// ---------- A 内置变量 ----------
section('A. 内置变量');
{
  const env = makeEnv();
  const before = Date.now();
  const { body, message } = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=t&content=%7Bdate%7D%7C%7Btime%7D%7C%7Bdatetime%7D%7C%7Btimestamp%7D%7C%7Btimestamp_ms%7D%7C%7Bweekday%7D%7C%7Bversion%7D%7C%7Bsource%7D&source=ci`);
  const after = Date.now();
  ok('发送成功', body.ok === true);
  const parts = message.content.split('|');
  ok('{date} 格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(parts[0]), parts[0]);
  ok('{time} 格式 HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(parts[1]), parts[1]);
  ok('{datetime} 格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(parts[2]), parts[2]);
  const ts = Number(parts[3]);
  ok('{timestamp} 秒级且在合理区间', ts >= Math.floor(before / 1000) - 1 && ts <= Math.floor(after / 1000) + 1, String(ts));
  const tms = Number(parts[4]);
  ok('{timestamp_ms} 毫秒级且在合理区间', tms >= before - 1000 && tms <= after + 1000, String(tms));
  ok('{weekday} 中文星期', /^星期[日一二三四五六]$/.test(parts[5]), parts[5]);
  ok('{version} 展开为版本号', parts[6] === '2.0.0', parts[6]);
  ok('{source} 展开为来源', parts[7] === 'ci', parts[7]);

  // GMT+8：date 应等于现在 +8h 的 UTC 日期
  const d8 = new Date(before + 8 * 3600 * 1000);
  const expectDate = d8.getUTCFullYear() + '-' + String(d8.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d8.getUTCDate()).padStart(2, '0');
  ok('日期按 GMT+8 计算', parts[0] === expectDate, `${parts[0]} vs ${expectDate}`);
}
{
  const env = makeEnv();
  const { message } = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=t&content=%7Buuid%7D%7C%7Brandom%7D`);
  const [u, r] = message.content.split('|');
  ok('{uuid} 标准 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u), u);
  ok('{random} 8 位随机串', /^[0-9a-z]{8}$/.test(r), r);
}

// ---------- B 自定义变量 ----------
section('B. 自定义变量');
{
  const env = makeEnv();
  const { message } = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=%7Btitle%7D&content=耗时%20%7Bcost%7D&v.title=%E6%9E%84%E5%BB%BA%E5%AE%8C%E6%88%90&v.cost=23s`);
  ok('v.title 替换 {title}', message.title === '构建完成', message.title);
  ok('v.cost 替换 {cost}', message.content === '耗时 23s', message.content);
}
{
  const env = makeEnv();
  const { message } = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=t&content=%7Bx%7D&var.x=OK`);
  ok('var.<name> 前缀同样生效', message.content === 'OK', message.content);
}
{
  const env = makeEnv();
  const { message } = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=t&content=%7Bdate%7D&v.date=2020-01-01`);
  ok('自定义变量覆盖同名内置变量', message.content === '2020-01-01', message.content);
}
{
  const env = makeEnv();
  const long = 'A'.repeat(900);
  const url = `${BASE}/send?token=${KEY}&title=t&content=%7Bv%7D&v.v=${encodeURIComponent(long)}`;
  const { message } = await sendAndGetLast(env, url);
  ok('自定义值限长 500', message.content.length === 500, String(message.content.length));
}
{
  const env = makeEnv();
  const url = `${BASE}/send?token=${KEY}&title=t&content=%7Bctl%7D&v.ctl=${encodeURIComponent('a\nb\tc')}`;
  const { message } = await sendAndGetLast(env, url);
  ok('控制字符被清理为空格', message.content === 'a b c', JSON.stringify(message.content));
}

// ---------- C 单次替换 / 未匹配保留 ----------
section('C. 单次替换与未匹配保留');
{
  const env = makeEnv();
  // v.x 的值是 "{date}"，渲染 {x} 后应得到字面 "{date}"，不得二次解析成真实日期
  const { message } = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=t&content=%7Bx%7D&v.x=%7Bdate%7D`);
  ok('替换值里的占位符不二次解析', message.content === '{date}', message.content);
}
{
  const env = makeEnv();
  const { message } = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=t&content=%7Bunknown%7D`);
  ok('未匹配占位符原样保留', message.content === '{unknown}', message.content);
}

// ---------- D 三入口一致 ----------
section('D. 三入口一致');
{
  // GET /send 已在 A/B 覆盖
  const env1 = makeEnv();
  const r1 = await sendAndGetLast(env1,
    `${BASE}/send?token=${KEY}&title=%7Bn%7D&content=body&v.n=GET`);
  ok('GET /send 渲染 v.n', r1.message.title === 'GET', r1.message.title);

  const env2 = makeEnv();
  const r2 = await sendAndGetLast(env2, `${BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': KEY },
    body: JSON.stringify({ title: '{n}', content: 'body', source: 'ci', v: { n: 'POST' } }),
  });
  ok('POST body 的 v 对象生效', r2.message.title === 'POST', r2.message.title);

  const env3 = makeEnv();
  const r3 = await sendAndGetLast(env3, `${BASE}/${KEY}.send?title=%7Bn%7D&desp=body&v.n=FANGTANG`);
  ok('方糖端点渲染 v.n', r3.body.code === 0, JSON.stringify(r3.body));
  ok('方糖端点落库标题已替换', r3.message.title === 'FANGTANG', r3.message.title);
}

// ---------- E 兼容性 / 安全 / 时区 ----------
section('E. 兼容性与安全');
{
  const env = makeEnv();
  const { message } = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=%E6%97%A0%E5%8F%98%E9%87%8F&content=%E7%BA%AF%E6%96%87%E6%9C%AC`);
  ok('无占位符内容直通不变', message.content === '纯文本' && message.title === '无变量');
}
{
  // 两个请求时间接近，验证每次渲染取当前时间（非固定）
  const env = makeEnv();
  const a = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=a&content=%7Btimestamp_ms%7D`);
  const b = await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=b&content=%7Btimestamp_ms%7D`);
  ok('两次渲染各自取当前时间', Number(b.message.content) >= Number(a.message.content));
}
{
  // 变量值含 <script>：存原文，但 API 输出的 contentHtml 经白名单消毒，不含可执行脚本
  const env = makeEnv();
  await sendAndGetLast(env,
    `${BASE}/send?token=${KEY}&title=t&content=%7Bx%7D&v.x=${encodeURIComponent('<script>alert(1)</script><b>ok</b>')}`);
  const listResp = await worker.fetch(new Request(`${BASE}/api/messages`), env);
  const list = await listResp.json();
  const last = list.messages[0];
  ok('XSS 脚本未进入 contentHtml', !/<script/i.test(last.contentHtml), last.contentHtml);
  ok('白名单标签 <b> 保留', /<b>ok<\/b>/.test(last.contentHtml), last.contentHtml);
  ok('previewText 为纯文本', !/<[^>]+>/.test(last.previewText), last.previewText);
}
{
  // 未授权不落库（鉴权仍生效）
  const env = makeEnv();
  const resp = await worker.fetch(new Request(`${BASE}/send?title=%7Bdate%7D&content=x`), env);
  ok('未带密钥 401', resp.status === 401);
  const keys = [...env.NOTIFICATIONS.map.keys()].filter((k) => k.startsWith('msg:'));
  ok('未授权不写 KV', keys.length === 0);
}

console.log('\n========================================');
console.log(`变量标签测试：通过 ${pass} / 失败 ${fail}`);
console.log('========================================');
if (fail) { console.log(failures.join('\n')); process.exit(1); }
