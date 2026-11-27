// v2.2 界面交互专项：主密钥保存/清除、三渠道测试按钮、状态徽标与 DOM 安全。
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { JSDOM, VirtualConsole } = require('jsdom');

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const mod = await import('./worker.js');
const worker = mod.default;
const MASTER_SECRET = 'MASTERSECRET-v22-ui';
const env = {
  NOTIFICATIONS: { get: async () => null, put: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
  SEND_TOKEN: MASTER_SECRET, READ_TOKEN: '', WECOM_WEBHOOK: '',
};
const html = await (await worker.fetch(new Request('https://example.com/'), env)).text();

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const fetched = [];
function jsonData(url, opts) {
  fetched.push({ url: String(url), opts: opts || {} });
  if (String(url).includes('/api/status')) {
    return {
      ok: true, version: '2.2.0', needSendToken: true, wecomConfigured: true,
      channels: [
        { id: 'wecom', name: '企业微信', enabled: true, configured: true, webhook: 'https://qyapi.example.com/hook?key=***' },
        { id: 'dingtalk', name: '钉钉', enabled: true, configured: true, webhook: 'https://oapi.example.com/hook?access_token=***' },
        { id: 'feishu', name: '飞书', enabled: true, configured: true, webhook: 'https://open.example.com/hook/***' },
      ],
      settings: { quietEnabled: false, quietStart: '23:00', quietEnd: '07:00', quietChannels: ['wecom'] },
      diagnostics: { kvOk: true, sendTokenSet: true, readTokenSet: false, delivery: { consecutiveFailures: 0 }, inboundSignature: false },
    };
  }
  if (String(url).includes('/api/channels')) return { ok: true, editable: true, channels: jsonData('/api/status').channels };
  if (String(url).includes('/api/settings')) return { ok: true, settings: { quietEnabled: false, quietStart: '23:00', quietEnd: '07:00', quietChannels: ['wecom'] } };
  if (String(url).includes('/api/templates')) return { ok: true, templates: {} };
  if (String(url).includes('/api/stats')) return { ok: true, total: 0, daily: [], sources: [], channels: [] };
  if (String(url).includes('/api/messages')) return { ok: true, version: 'v2', messages: [], deliveries: {} };
  return { ok: true };
}

let optsAtDom = null;
const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(window) {
    // 模拟上一次会话已勾选「记住主密钥」
    window.localStorage.setItem('cfn_master_token', MASTER_SECRET);
    window.fetch = async (url, opts) => {
      optsAtDom = opts;
      return { ok: true, status: 200, json: async () => jsonData(url, opts) };
    };
    window.XMLHttpRequest = class { open() {} setRequestHeader() {} send() {} };
    if (!window.navigator.clipboard) Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
    window.scrollTo = () => {};
    window.URL.createObjectURL = () => 'blob:test';
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};
  },
});
await new Promise((r) => setTimeout(r, 400));
const d = dom.window.document;
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
const click = (el) => el && el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const change = (el) => el && el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

// ---------- 主密钥保存 ----------
ok('复选框存在', Boolean(d.getElementById('chkRememberMaster')));
ok('已保存主密钥自动回填输入框', d.getElementById('fMasterToken').value === MASTER_SECRET, d.getElementById('fMasterToken').value);
ok('已保存状态下复选框为选中', d.getElementById('chkRememberMaster').checked === true);
ok('清除按钮可见', d.getElementById('forgetMasterRow').style.display !== 'none');
ok('提示文案反映已保存状态', d.getElementById('masterSaveHint').textContent.includes('已保存'));
ok('主密钥未写入 DOM 属性', !d.documentElement.outerHTML.includes(MASTER_SECRET));
ok('渠道读取带主密钥 Header', fetched.some((f) => f.url.includes('/api/channels') && f.opts.headers && f.opts.headers['X-Token'] === MASTER_SECRET),
  JSON.stringify(fetched.filter((f) => f.url.includes('/api/channels')).slice(0, 2)));

// 取消勾选 → 清除 localStorage
d.getElementById('chkRememberMaster').checked = false;
change(d.getElementById('chkRememberMaster'));
ok('取消勾选后移除本地主密钥', dom.window.localStorage.getItem('cfn_master_token') === null);
ok('取消勾选后清除按钮隐藏', d.getElementById('forgetMasterRow').style.display === 'none');

// 重新输入并勾选 → 保存
d.getElementById('fMasterToken').value = 'NEW-MASTER-2202';
d.getElementById('chkRememberMaster').checked = true;
change(d.getElementById('chkRememberMaster'));
ok('勾选后保存新主密钥', dom.window.localStorage.getItem('cfn_master_token') === 'NEW-MASTER-2202');

// 空值时不允许勾选
d.getElementById('fMasterToken').value = '';
d.getElementById('chkRememberMaster').checked = true;
change(d.getElementById('chkRememberMaster'));
ok('空主密钥不能勾选记住', d.getElementById('chkRememberMaster').checked === false);

// 一键清除
d.getElementById('fMasterToken').value = MASTER_SECRET;
dom.window.localStorage.setItem('cfn_master_token', MASTER_SECRET);
change(d.getElementById('chkRememberMaster'));
click(d.getElementById('btnForgetMaster'));
click(d.getElementById('btnConfirmOk'));
ok('一键清除删除 localStorage', dom.window.localStorage.getItem('cfn_master_token') === null);
ok('一键清空输入框', d.getElementById('fMasterToken').value === '');

// ---------- 三渠道测试按钮 ----------
ok('三个测试按钮全部存在', ['btnTestWecom', 'btnTestDingtalk', 'btnTestFeishu'].every((id) => Boolean(d.getElementById(id))));
const ids = ['btnTestWecom', 'btnTestDingtalk', 'btnTestFeishu'];
ok('三个测试按钮均根据配置启用', ids.every((id) => d.getElementById(id).disabled === false),
  ids.map((id) => id + '=' + d.getElementById(id).disabled).join(','));
ok('渠道徽标显示 3/3 可用', d.getElementById('sendChannelsBadge').textContent.includes('3/3'), d.getElementById('sendChannelsBadge').textContent);
ok('测试按钮文案已国际化', d.getElementById('btnTestDingtalk').textContent === '测试钉钉');

// 测试按钮优先使用「发送密钥」输入框；此处显式填入以验证密钥走 Header。
d.getElementById('fSendToken').value = MASTER_SECRET;
for (const [btnId, channel] of [['btnTestWecom', 'wecom'], ['btnTestDingtalk', 'dingtalk'], ['btnTestFeishu', 'feishu']]) {
  fetched.length = 0;
  click(d.getElementById(btnId));
  await new Promise((r) => setTimeout(r, 30));
  const hit = fetched.find((f) => String(f.url).includes('/api/test-channel'));
  ok(btnId + ' 调用统一测试端点', Boolean(hit), JSON.stringify(fetched.map((f) => f.url).slice(-3)));
  ok(btnId + ' 提交正确渠道 id', Boolean(hit && JSON.parse(hit.opts.body).id === channel), hit && hit.opts.body);
  ok(btnId + ' 密钥走 Header 不进 URL', Boolean(hit && String(hit.url).indexOf('token=') === -1 && hit.opts.headers['X-Token'] === MASTER_SECRET));
}

// ---------- 全局安全性 ----------
ok('中英文键完全一致', Object.keys(dom.window.I18N.dict.zh).sort().join() === Object.keys(dom.window.I18N.dict.en).sort().join());
ok('新增 i18n 键齐全', ['btn.testDingtalk', 'btn.testFeishu', 'label.rememberMaster', 'btn.forgetMaster', 'hint.masterSaved']
  .every((k) => dom.window.I18N.dict.zh[k] && dom.window.I18N.dict.en[k]));
ok('无 JS 运行时错误', errors.length === 0, errors.join(' | '));

console.log('\nresult: pass=' + pass + ' fail=' + fail);
dom.window.close();
if (fail) process.exit(1);
