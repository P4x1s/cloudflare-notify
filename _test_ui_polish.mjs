// v2.0.0 UI 细节专项：在真实渲染的 DOM 里验证三模块的布局标记与交互流程。
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { JSDOM, VirtualConsole } = require('jsdom');

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const mod = await import('./worker.js');
const env = {
  APP_NAME: 'Cloudflare Notify',
  NOTIFICATIONS: { get: async () => null, put: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
  SEND_TOKEN: 'test-send-token',
  READ_TOKEN: '',
};
const resp = await mod.default.fetch(new Request('https://example.com/'), env);
const html = await resp.text();

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const calls = [];
const clipboard = [];
let sendReq = null;

function jsonResponse(data, status = 200) {
  return { ok: status < 400, status, json: async () => data };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://example.com/',
  virtualConsole: vc,
  beforeParse(window) {
    window.navigator.clipboard = { writeText: async (t) => { clipboard.push(t); } };
    window.fetch = async (u, init = {}) => {
      calls.push((init.method || 'GET') + ' ' + u);
      const url = String(u);
      if (url.includes('/api/status')) return jsonResponse({
        ok: true, version: '2.0.0', rotatingKeyReady: false,
        needSendToken: true, wecomConfigured: true,
      });
      if (url.includes('/api/messages')) return jsonResponse({ ok: true, messages: [], version: '2.0.0' });
      if (url.includes('/api/send')) { sendReq = { url, init }; return jsonResponse({ ok: true, wecom: { configured: true, ok: true } }); }
      if (url.includes('/api/test-wecom')) return jsonResponse({ configured: true, ok: true });
      if (url.includes('/api/key/rotate')) return jsonResponse({ ok: true, key: 'new-rotating-key' });
      if (url.includes('/api/key/current')) return jsonResponse({ ok: true, key: 'cur-rotating-key' });
      return jsonResponse({ ok: true });
    };
  },
});

await new Promise(r => setTimeout(r, 300));
const d = dom.window.document;
const $ = (s) => d.querySelector(s);
const click = (s) => $(s).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

ok('模块徽标显示 9 种方式', $('#sec-integration .tool-badge')?.textContent === '9 种方式');
ok('接入标签为 9 个', d.querySelectorAll('#intgTabs > *').length === 9, 'got ' + d.querySelectorAll('#intgTabs > *').length);
ok('标签使用对齐网格', $('#intgTabs')?.classList.contains('intg-tabs'));
ok('标题不含重复序号', !/[①②③④⑤⑥⑦⑧⑨]/.test($('#intgName')?.textContent || ''));
ok('方糖专用地址默认隐藏', $('#scQuick')?.style.display === 'none');
ok('企微徽标显示已开启', $('#wecomBadge')?.textContent === '企微已开启');

// 切到方糖标签：专用地址出现（先给一个密钥，模拟用户已填）
$('#fSendToken').value = 'token-for-sc';
const scTab = Array.from($('#intgTabs').children).find(b => b.dataset.intg === 'serverchan');
scTab.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
await wait();
ok('方糖标签下显示专用地址', $('#scQuick')?.style.display !== 'none');
ok('专用地址已填密钥', ($('#scUrl')?.dataset.url || '').includes('.send?text='));

// 复制示例 → 行内状态
click('#btnCopyIntg');
await wait();
ok('复制示例写入行内成功提示', ($('#intgStatus')?.textContent || '').includes('已复制'), $('#intgStatus')?.textContent);
ok('剪贴板收到示例内容', clipboard.length >= 1);

// 发送测试通知：密钥走 Header，成功提示含企微状态
$('#fTitle').value = 'UI 测试';
$('#fSendToken').value = 'abc123';
click('#btnSend');
await wait(60);
ok('发送接口 URL 不带 token', sendReq && !sendReq.url.includes('token='), sendReq?.url);
ok('发送密钥走 X-Token Header', sendReq?.init?.headers?.['X-Token'] === 'abc123', JSON.stringify(sendReq?.init?.headers));
ok('发送成功提示含企微状态', ($('#sendFeedback')?.textContent || '').includes('企业微信已送达'), $('#sendFeedback')?.textContent);

// 轮换：缺主密钥时给出明确行内错误
click('#btnRotateKey');
await wait();
ok('缺主密钥时行内提示 SEND_TOKEN', ($('#keyFeedback')?.textContent || '').includes('SEND_TOKEN'), $('#keyFeedback')?.textContent);

// 填入主密钥后轮换成功，密钥框与徽标联动
$('#fMasterToken').value = 'master';
click('#btnRotateKey');
await wait(60);
ok('轮换成功后提示旧 key 失效', ($('#keyFeedback')?.textContent || '').includes('旧密钥立即失效'), $('#keyFeedback')?.textContent);
ok('轮换密钥框显示', $('#rotatedKeyBox')?.style.display === 'block');
ok('密钥徽标变为已就绪', $('#keyBadge')?.textContent === '已就绪');

ok('无 JS 运行时错误', errors.length === 0, errors.join(' | '));

console.log(`\nresult: pass=${pass} fail=${fail}`);
dom.window.close();
process.exit(fail ? 1 : 0);
