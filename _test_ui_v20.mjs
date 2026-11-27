// v2.0 界面交互专项：在真实渲染 DOM 中验证渠道面板、搜索、确认弹窗、主题切换。
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { JSDOM, VirtualConsole } = require('jsdom');

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const mod = await import('./worker.js');
const worker = mod.default;
const env = {
  APP_NAME: 'Cloudflare Notify',
  NOTIFICATIONS: {
    get: async () => null,
    put: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  },
  SEND_TOKEN: 'master-test',
  READ_TOKEN: '',
  WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET',
};
const resp = await worker.fetch(new Request('https://example.com/'), env);
const html = await resp.text();

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const messages = [
  { id: 'm1', title: '构建成功', content: '第一行内容', source: 'github-actions', timestamp: Date.now(), previewText: '第一行内容', isRich: false },
  { id: 'm2', title: '路由器告警', content: 'WAN 重拨', source: 'routerhook', timestamp: Date.now() - 60000, previewText: 'WAN 重拨', isRich: false },
];
const calls = [];
function jsonData(url) {
  if (url.includes('/api/status')) {
    return {
      ok: true, version: '2.0.0', needSendToken: true, wecomConfigured: true,
      channels: [
        { id: 'wecom', name: '企业微信', enabled: true, configured: true, webhook: 'https://qyapi***' },
        { id: 'dingtalk', name: '钉钉', enabled: false, configured: false, webhook: '' },
        { id: 'feishu', name: '飞书', enabled: false, configured: false, webhook: '' },
      ],
      settings: { quietEnabled: false, quietStart: '23:00', quietEnd: '07:00', quietChannels: ['wecom'] },
      diagnostics: { kvOk: true, sendTokenSet: true, readTokenSet: false, delivery: { consecutiveFailures: 0 }, inboundSignature: false },
    };
  }
  if (url.includes('/api/channels')) {
    return {
      ok: true, editable: false,
      channels: [
        { id: 'wecom', name: '企业微信', enabled: true, configured: true, webhook: 'https://qyapi***' },
        { id: 'dingtalk', name: '钉钉', enabled: false, configured: false, webhook: '' },
        { id: 'feishu', name: '飞书', enabled: false, configured: false, webhook: '' },
      ],
    };
  }
  if (url.includes('/api/settings')) {
    return { ok: true, settings: { quietEnabled: false, quietStart: '23:00', quietEnd: '07:00', quietChannels: ['wecom'] } };
  }
  if (url.includes('/api/templates')) return { ok: true, templates: { deploy: { title: '上线', content: '内容' } } };
  if (url.includes('/api/messages')) {
    return { ok: true, version: 'v2', messages, deliveries: { m1: [{ channel: 'wecom', ok: true, error: '' }] } };
  }
  return { ok: true };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://example.com/',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => jsonData(String(url)) };
    };
    window.XMLHttpRequest = class {
      open() {} setRequestHeader() {} send() {}
    };
    if (!window.navigator.clipboard) {
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
    }
    window.scrollTo = () => {};
  },
});

await new Promise((r) => setTimeout(r, 500));
const d = dom.window.document;
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

ok('三个渠道卡片已渲染', d.querySelectorAll('.channel-card').length === 3,
  'got ' + d.querySelectorAll('.channel-card').length);
ok('渠道配置从面板读取', calls.some((u) => u.includes('/api/channels')));
ok('规则设置从面板读取', calls.some((u) => u.includes('/api/settings')));
ok('消息列表渲染两条', d.querySelectorAll('.msg').length === 2, 'got ' + d.querySelectorAll('.msg').length);
ok('来源过滤 chips 已渲染', d.querySelectorAll('#sourceChips .chip').length >= 3);
ok('投递状态行已渲染', (d.querySelector('.delivery-line')?.textContent || '').includes('企微'));
ok('消息操作按钮已渲染', d.querySelectorAll('.msg-actions [data-act]').length === 6);

const search = d.querySelector('#fSearch');
search.value = '路由器';
search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
ok('搜索过滤生效', d.querySelectorAll('.msg').length === 1, 'got ' + d.querySelectorAll('.msg').length);
ok('搜索后计数更新', (d.querySelector('#count')?.textContent || '').startsWith('1'));

search.value = '';
search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
const chip = [...d.querySelectorAll('#sourceChips .chip')].find((b) => b.getAttribute('data-source') === 'github-actions');
chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
ok('来源过滤生效', d.querySelectorAll('.msg').length === 1, 'got ' + d.querySelectorAll('.msg').length);
search.value = '不存在的关键词';
search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
ok('组合过滤无结果时给出提示', d.querySelector('.empty') !== null);
search.value = '';
search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

const themeBtn = d.querySelector('#btnTheme');
themeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
ok('主题切换写入 data-theme', d.documentElement.getAttribute('data-theme') === 'dark',
  String(d.documentElement.getAttribute('data-theme')));

const allChip = [...d.querySelectorAll('#sourceChips .chip')].find((b) => b.getAttribute('data-source') === 'all');
allChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const delBtn = [...d.querySelectorAll('[data-act="delete"]')][0];
if (delBtn) delBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
ok('删除走自定义确认弹窗', !d.querySelector('#confirmOverlay').classList.contains('hidden'));

const preview = d.querySelector('#btnPreviewVars');
d.querySelector('#fContent').value = '{date} {version} {unknown}';
preview.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const previewText = d.querySelector('#varPreview').textContent || '';
ok('变量预览渲染内置变量', previewText.includes('2.0.0') && !previewText.includes('{date}'), previewText);
ok('未知变量原样保留', previewText.includes('{unknown}'), previewText);
ok('移动端操作栏存在', Boolean(d.querySelector('.bottom-bar')));
ok('无 JS 运行时错误', errors.length === 0, errors.join(' | '));

console.log('\nresult: pass=' + pass + ' fail=' + fail);
dom.window.close();
process.exit(fail ? 1 : 0);
