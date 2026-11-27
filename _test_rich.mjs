// 富文本消息渲染专项测试（v1.7）
// 覆盖：
//   1) escape-then-allowlist 白名单还原与 XSS 拦截（script/img/iframe/事件属性/危险协议）
//   2) isRich / contentHtml / previewText 三个 API 附加字段
//   3) 企业微信推送的 HTML→markdown 转换
//   4) src/messages.js 纯函数边界用例（无引号 href、实体绕过、畸形输入）
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

// ---------- 拦截企业微信 Webhook，捕获推送 body ----------
const wecomCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.includes('qyapi.weixin.qq.com')) {
    let body = null;
    try { body = JSON.parse(String(init && init.body || '{}')); } catch (e) { body = null; }
    wecomCalls.push({ url, body });
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

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
function nextIp() { ipCounter++; return '10.2.0.' + ipCounter; }

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

function cookieHeader(res) {
  const c = res.headers.get('Set-Cookie');
  if (!c) return '';
  return c.split(';')[0].split('=')[0] + '=' + decodeURIComponent(c.split(';')[0].split('=')[1] || '');
}

// ---------- 端到端：登录 → 发送 → 读取 ----------
const { env: bindings } = makeEnv({ env: { WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key' } });
const IP = nextIp();
const lr = await call('/api/login', jsonBody({ token: 'read-secret-456' }), bindings, IP);
ok('登录成功', lr.status === 200, 'got ' + lr.status);
const CK = cookieHeader(lr.res);
ok('拿到会话 Cookie', !!CK);

// 发送样例：每条一个安全场景
const samples = [
  ['rich-basic', 'plain', '<b>加粗</b> and <i>斜体</i>'],
  ['xss-script', 'plain', '<script>alert(1)</script>'],
  ['xss-img', 'plain', '<img src=x onerror=alert(1)>'],
  ['xss-iframe', 'plain', '<iframe src="https://evil.com"></iframe>'],
  ['a-js', 'plain', '<a href="javascript:alert(1)">点我</a>'],
  ['a-https', 'plain', '<a href="https://example.com/path?x=1&y=2">link</a>'],
  ['a-data', 'plain', '<a href="data:text/html,<b>x</b>">x</a>'],
  ['a-entity', 'plain', '<a href="&#106;avascript:alert(1)">x</a>'],
  ['case-mix', 'plain', '<B>x</B><ScRiPt>y</ScRiPt>'],
  ['attr-drop', 'plain', '<p class="x" onclick="evil()" style="color:red">t</p>'],
  ['br-selfclose', 'plain', 'line1<br/>line2'],
  ['list', 'plain', '<ul><li>1</li><li>2</li></ul>'],
  ['pre-code', 'plain', '<pre><code>var x=1;</code></pre>'],
  ['quote', 'plain', '<blockquote>引用内容</blockquote>'],
  ['plain-text', 'plain', 'line1\nline2'],
  ['lt-text', 'plain', 'a < b'],
  ['preview', 'plain', '<b>标题</b>\n<p>段落一</p>\n<p>段落二</p>'],
  ['close-evil', 'plain', '</script><script>alert(1)</script>'],
  ['a-nohref', 'plain', '<a name="x">t</a>'],
  ['a-single', 'plain', "<a href='https://ok.com'>t</a>"],
  ['wecom', 'plain', '<b>Hi</b> <a href="https://x.com">link</a><br>line2 &amp; more'],
];

for (const [name, , content] of samples) {
  const r = await call('/api/send', jsonBody({ token: 'master-secret-123', title: 'T-' + name, content }), bindings, nextIp());
  ok('发送 ' + name, r.status === 200 && r.body && r.body.ok === true, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
}

const mr = await call('/api/messages?limit=50', { headers: { Cookie: CK } }, bindings, IP);
ok('/api/messages 200', mr.status === 200, 'got ' + mr.status);
const msgs = mr.body.messages || [];
const find = (t) => msgs.find((m) => m.title === t);

section('1. 白名单还原');
{
  const m = find('T-rich-basic');
  ok('isRich = true', m && m.isRich === true);
  ok('b/i 标签还原', m && m.contentHtml.includes('<b>加粗</b>') && m.contentHtml.includes('<i>斜体</i>'), m && m.contentHtml);
  ok('原 content 字段保持原样', m && m.content === '<b>加粗</b> and <i>斜体</i>');
}
section('2. XSS 拦截');
{
  const m = find('T-xss-script');
  ok('script 未还原为真标签', m && !m.contentHtml.includes('<script'), m && m.contentHtml);
  ok('script 以转义文本显示', m && m.contentHtml.includes('&lt;script&gt;'));

  const img = find('T-xss-img');
  ok('img 未还原为真标签', img && !img.contentHtml.includes('<img'));

  const ifr = find('T-xss-iframe');
  ok('iframe 未还原为真标签', ifr && !ifr.contentHtml.includes('<iframe'));

  const evil = find('T-close-evil');
  ok('恶意闭合标签保持转义', evil && !evil.contentHtml.includes('</script>'), evil && evil.contentHtml);
}
section('3. a 标签 href 协议白名单');
{
  const js = find('T-a-js');
  ok('javascript: 被丢弃', js && js.contentHtml.includes('<a>') && !js.contentHtml.includes('javascript:'), js && js.contentHtml);

  const okA = find('T-a-https');
  ok('https 链接保留', okA && okA.contentHtml.includes('href="https://example.com/path?x=1&amp;y=2"'), okA && okA.contentHtml);
  ok('强制 target=_blank + rel=noopener', okA && okA.contentHtml.includes('target="_blank"') && okA.contentHtml.includes('rel="noopener noreferrer"'));
  ok('href 实体保持转义（&amp;）', okA && !/href="[^"]*&(?!amp;)[a-z]+;/.test(okA.contentHtml));

  const data = find('T-a-data');
  ok('data: 协议被丢弃', data && !data.contentHtml.includes('data:text/html'), data && data.contentHtml);

  const ent = find('T-a-entity');
  ok('实体形态协议绕过被丢弃', ent && !ent.contentHtml.includes('avascript:alert'), ent && ent.contentHtml);

  const noHref = find('T-a-nohref');
  ok('非 href 属性被丢弃', noHref && noHref.contentHtml.includes('<a>') && noHref.contentHtml.includes('<a>t</a>'), noHref && noHref.contentHtml);

  const single = find('T-a-single');
  ok('单引号 href 同样放行', single && single.contentHtml.includes('href="https://ok.com"'), single && single.contentHtml);
}
section('4. 属性与大小写');
{
  const m = find('T-case-mix');
  ok('大小写混合 B 标签还原为小写', m && m.contentHtml.includes('<b>x</b>'), m && m.contentHtml);
  ok('大小写混合 SCRIPT 拦截', m && !m.contentHtml.includes('<script') && !m.contentHtml.includes('<SCRIPT'), m && m.contentHtml);

  const p = find('T-attr-drop');
  ok('白名单标签的全部属性被丢弃', p && p.contentHtml === '<p>t</p>', p && p.contentHtml);
}
section('5. 结构标签');
{
  const br = find('T-br-selfclose');
  ok('自闭合 br 还原', br && br.contentHtml.includes('line1<br>line2'), br && br.contentHtml);

  const ul = find('T-list');
  ok('ul/li 还原', ul && ul.contentHtml.includes('<ul><li>1</li><li>2</li></ul>'));

  const pre = find('T-pre-code');
  ok('pre/code 还原', pre && pre.contentHtml.includes('<pre><code>var x=1;</code></pre>'));

  const q = find('T-quote');
  ok('blockquote 还原', q && q.contentHtml.includes('<blockquote>引用内容</blockquote>'));
}
section('6. 纯文本模式（isRich=false）');
{
  const m = find('T-plain-text');
  ok('纯文本 isRich = false', m && m.isRich === false);
  ok('纯文本无标签', m && !m.contentHtml.includes('<'));
  ok('换行符保留在 contentHtml 中（前端 pre-wrap 呈现）', m && m.contentHtml.includes('\n'));

  const lt = find('T-lt-text');
  ok('普通 < 比较符不触发 rich', lt && lt.isRich === false);
  ok('普通 < 转义显示', lt && lt.contentHtml === 'a &lt; b', lt && lt.contentHtml);
}
section('7. previewText 摘要');
{
  const m = find('T-preview');
  ok('previewText 剥离标签', m && m.previewText.includes('标题') && m.previewText.includes('段落一') && !m.previewText.includes('<b>'), m && m.previewText);
  ok('块级标签转为换行', m && m.previewText.includes('\n'), m && m.previewText);

  const lt = find('T-lt-text');
  ok('previewText 保留普通 < 比较符', lt && lt.previewText.includes('a < b'), lt && lt.previewText);
}
section('8. 企业微信 HTML→markdown');
{
  const m = find('T-wecom');
  // 每条消息发送都会触发推送（webhook 已配置），按内容特征定位 T-wecom 的那条
  const wc = wecomCalls.find((c) => c.body && c.body.markdown && c.body.markdown.content.includes('[link](https://x.com)'));
  ok('企业微信推送已捕获', !!wc, 'got ' + wecomCalls.length + ' calls');
  const content = wc && wc.body.markdown ? wc.body.markdown.content : '';
  ok('加粗转换', content.includes('**Hi**'), content);
  ok('链接转换', content.includes('[link](https://x.com)'), content);
  ok('br 转换为换行', content.includes('\nline2'), content);
  ok('实体解码（&amp; → &）', content.includes('& more'), content);
  ok('无标签残留', !/<[a-zA-Z/][^>]*>/.test(content), content);
  ok('消息 title 原样存储不消毒（前端 esc 展示）', m && m.title === 'T-wecom');
}

// ---------- src/messages.js 纯函数边界用例 ----------
section('9. src 版纯函数边界');
{
  const { sanitizeRichHtml, stripTagsText, htmlToMarkdown, decorateMessage } = await import('./src/messages.js');

  ok('无引号 href 保守丢弃', sanitizeRichHtml('<a href=https://x.com>t</a>') === '<a>t</a>',
    sanitizeRichHtml('<a href=https://x.com>t</a>'));
  ok('畸形嵌套引号不产生真标签泄漏', !/<script/i.test(sanitizeRichHtml('<a href="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">x</a>')));
  ok('空内容 → 空串', sanitizeRichHtml('') === '');
  ok('null → 空串', sanitizeRichHtml(null) === '');
  ok('纯文本原样（转义后）', sanitizeRichHtml('hello <world> & "x"') === 'hello &lt;world&gt; &amp; &quot;x&quot;');
  ok('大写 MAILTO 放行', sanitizeRichHtml('<a href="MAILTO:a@b.com">m</a>').includes('href="MAILTO:a@b.com"'));
  ok('协议头大小写混合放行', sanitizeRichHtml('<a href="HttpS://x.com">m</a>').includes('href="HttpS://x.com"'));
  ok('vbscript: 丢弃', sanitizeRichHtml('<a href="vbscript:msgbox">x</a>') === '<a>x</a>',
    sanitizeRichHtml('<a href="vbscript:msgbox">x</a>'));
  ok('相对协议 //x 丢弃', sanitizeRichHtml('<a href="//x.com">x</a>') === '<a>x</a>');
  ok('decorateMessage 保留原字段', (() => {
    const d = decorateMessage({ id: '1', title: 't', content: '<b>x</b>', timestamp: 1 });
    return d.id === '1' && d.isRich === true && typeof d.contentHtml === 'string' && typeof d.previewText === 'string';
  })());
  ok('decorateMessage 容错 null', decorateMessage(null) === null);
  ok('stripTagsText 压缩连续空行', stripTagsText('<p>a</p>\n\n\n\n<p>b</p>') === 'a\n\nb', JSON.stringify(stripTagsText('<p>a</p>\n\n\n\n<p>b</p>')));
  ok('stripTagsText 截断到 maxLen', stripTagsText('x'.repeat(500), 10).length === 10);
  ok('htmlToMarkdown 剥离未知标签', htmlToMarkdown('<u>u</u>t') === 'ut', htmlToMarkdown('<u>u</u>t'));
  ok('htmlToMarkdown 危险链接降级为纯文本', htmlToMarkdown('<a href="javascript:x">t</a>') === 't');
}

console.log('\n========================================================');
console.log('通过: ' + pass + '   失败: ' + fail);
if (fail) {
  console.log('失败项:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('富文本渲染专项测试全部通过 ✓');
}
