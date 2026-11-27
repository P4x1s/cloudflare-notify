// 用 jsdom 执行"服务端真实渲染"的 HTML，验证运行时行为。
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { JSDOM, VirtualConsole } = require('jsdom');

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const mod = await import('./worker.js');
const worker = mod.default;
const env = {
  APP_NAME: 'Cloudflare Notify',
  NOTIFICATIONS: { get: async () => null, put: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
  SEND_TOKEN: 'test-send-token',
  READ_TOKEN: '',
};
const resp = await worker.fetch(new Request('https://example.com/'), env);
const html = await resp.text();

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

// 拦截网络：api 请求返回空数据，避免真实网络；记录被调用的接口
const called = [];
class MockXHR {
  constructor() { this.readyState = 0; this.status = 0; this.responseText = ''; this.headers = {}; }
  open(m, u) { this._m = m; this._u = u; called.push(m + ' ' + u); }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send() {
    this.readyState = 4; this.status = 200;
    if (this._u.includes('/api/messages')) this.responseText = JSON.stringify({ ok: true, messages: [] });
    else if (this._u.includes('/api/status')) this.responseText = JSON.stringify({ ok: true, version: '2.0.0', rotatingKeyReady: false });
    else this.responseText = JSON.stringify({ ok: true });
    if (this.onreadystatechange) this.onreadystatechange();
    if (this.onload) this.onload();
  }
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://example.com/',
  virtualConsole: vc,
  beforeParse(window) {
    window.XMLHttpRequest = MockXHR;
    window.fetch = async (u) => {
      called.push('fetch ' + u);
      return { ok: true, status: 200, json: async () => ({ ok: true, messages: [], version: '2.0.0' }) };
    };
  },
});

await new Promise(r => setTimeout(r, 400));
const d = dom.window.document;
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

const tabs = d.querySelectorAll('#intgTabs > *');
ok('接入标签已渲染 (9 个)', tabs.length === 9, 'got ' + tabs.length);
ok('标签文本含 URL 直发', d.querySelector('#intgTabs')?.textContent.includes('URL 直发'));
ok('标签文本含 RouterHook', d.querySelector('#intgTabs')?.textContent.includes('RouterHook'));
ok('代码容器存在', !!d.querySelector('#intgCode'));
ok('轮询/加载接口被调用', called.length > 0, 'calls=' + called.length);
ok('无 JS 运行时错误', errors.length === 0, errors.join(' | '));

console.log('\ncalled endpoints:', called.slice(0, 6));
console.log('errors:', errors);
console.log(`\nresult: pass=${pass} fail=${fail}`);
dom.window.close();
process.exit(fail ? 1 : 0);
