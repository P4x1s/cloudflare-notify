// v2.1 界面交互专项：语言切换、语法高亮、代码脱敏、导出、统计看板。
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { JSDOM, VirtualConsole } = require('jsdom');

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const mod = await import('./worker.js');
const worker = mod.default;
const env = {
  NOTIFICATIONS: {
    get: async () => null, put: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  },
  SEND_TOKEN: 'master-test', READ_TOKEN: '', WECOM_WEBHOOK: '',
};
const html = await (await worker.fetch(new Request('https://example.com/'), env)).text();

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const messages = [
  { id: 'm1', title: '构建成功', content: '第一行内容', source: 'github-actions', timestamp: Date.now(), previewText: '第一行内容', isRich: false },
  { id: 'm2', title: '路由器告警', content: 'WAN 重拨', source: 'routerhook', timestamp: Date.now() - 60000, previewText: 'WAN 重拨', isRich: false },
];
const stats = {
  ok: true, total: 12, sampled: 12, truncated: false,
  daily: Array.from({ length: 14 }, (_, i) => ({ date: '2026-11-' + String(14 + i).padStart(2, '0'), count: i === 13 ? 3 : i % 2 })),
  hourly: new Array(24).fill(0),
  sources: [{ name: 'github-actions', count: 8 }, { name: 'routerhook', count: 4 }],
  channels: [
    { id: 'wecom', name: '企业微信', ok: 10, fail: 2, rate: 83 },
    { id: 'dingtalk', name: '钉钉', ok: 0, fail: 0, rate: null },
  ],
};
function jsonData(url) {
  if (url.includes('/api/status')) {
    return {
      ok: true, version: '2.1.0', needSendToken: true, wecomConfigured: false,
      channels: [
        { id: 'wecom', name: '企业微信', enabled: true, configured: false, webhook: '' },
        { id: 'dingtalk', name: '钉钉', enabled: false, configured: false, webhook: '' },
        { id: 'feishu', name: '飞书', enabled: false, configured: false, webhook: '' },
      ],
      settings: { quietEnabled: false, quietStart: '23:00', quietEnd: '07:00', quietChannels: ['wecom'] },
      diagnostics: { kvOk: true, sendTokenSet: true, readTokenSet: false, delivery: { consecutiveFailures: 0 }, inboundSignature: false },
    };
  }
  if (url.includes('/api/channels')) return { ok: true, editable: false, channels: jsonData('/api/status').channels };
  if (url.includes('/api/settings')) return { ok: true, settings: { quietEnabled: false, quietStart: '23:00', quietEnd: '07:00', quietChannels: ['wecom'] } };
  if (url.includes('/api/templates')) return { ok: true, templates: {} };
  if (url.includes('/api/stats')) return stats;
  if (url.includes('/api/messages')) return { ok: true, version: 'v2', messages, deliveries: { m1: [{ channel: 'wecom', ok: true, error: '' }] } };
  return { ok: true };
}

let capturedBlob = null;
const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(window) {
    window.fetch = async (url) => ({ ok: true, status: 200, json: async () => jsonData(String(url)) });
    window.XMLHttpRequest = class { open() {} setRequestHeader() {} send() {} };
    if (!window.navigator.clipboard) Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
    window.scrollTo = () => {};
    window.URL.createObjectURL = (blob) => { capturedBlob = blob; return 'blob:test'; };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};
  },
});
await new Promise((r) => setTimeout(r, 500));
const d = dom.window.document;
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
const click = (el) => el && el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

// ---------- L3 ----------
const dict = dom.window.I18N && dom.window.I18N.dict;
ok('语言字典已注入', Boolean(dict && dict.zh && dict.en));
const zhKeys = Object.keys(dict.zh).sort().join(',');
const enKeys = Object.keys(dict.en).sort().join(',');
ok('中英文字典键完全一致', zhKeys === enKeys, zhKeys === enKeys ? '' : 'zh=' + zhKeys.length + ' en=' + enKeys.length);
ok('默认中文导航', d.querySelector('[data-nav="sec-stats"]').textContent === '统计');
click(d.getElementById('btnLang'));
ok('切换到英文导航', d.querySelector('[data-nav="sec-stats"]').textContent === 'Stats');
ok('html lang 同步为 en', d.documentElement.lang === 'en');
ok('语言偏好写入 localStorage', dom.window.localStorage.getItem('cfn_lang') === 'en');
ok('按钮文案切换为中文提示', d.getElementById('btnLang').textContent === '中文');
click(d.getElementById('btnLang'));
ok('可切回中文', d.querySelector('[data-nav="sec-stats"]').textContent === '统计');

// ---------- U4 ----------
const hl = dom.window.highlightCode('const x = "hi" # note <b>');
ok('高亮器输出关键字 span', hl.includes('tok-kw') && hl.includes('const'));
ok('高亮器输出字符串 span', hl.includes('tok-str') && hl.includes('hi'));
ok('高亮器输出注释 span', hl.includes('tok-com') && hl.includes('note'));
ok('高亮器转义 HTML', hl.includes('&lt;b&gt;') && !hl.includes('<b>'));
click([...d.querySelectorAll('.intg-tab')].find((b) => b.getAttribute('data-intg') === 'json'));
const pre = d.getElementById('intgCode');
ok('代码示例已高亮', pre.innerHTML.includes('tok-kw') || pre.innerHTML.includes('tok-str'), pre.innerHTML.slice(0, 120));
ok('完整代码保存在 dataset（供复制完整密钥）', (pre.dataset.full || '').includes('/send'));
ok('行号已渲染', (d.getElementById('intgLn').textContent || '').includes('1'));
ok('长代码折叠入口存在', Boolean(d.getElementById('btnCodeMore')));

// ---------- L1 ----------
capturedBlob = null;
click(d.getElementById('btnExportCsv'));
ok('CSV 导出触发 Blob', Boolean(capturedBlob) && capturedBlob.type.includes('text/csv'));
const csvBuf = capturedBlob ? new Uint8Array(await capturedBlob.arrayBuffer()) : new Uint8Array();
const csvText = capturedBlob ? await capturedBlob.text() : '';
ok('CSV 含表头与 BOM', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf && csvText.includes('id,title,content'),
  [csvBuf[0], csvBuf[1], csvBuf[2]].join(','));
ok('CSV 含当前消息', csvText.includes('构建成功'));
capturedBlob = null;
click(d.getElementById('btnExportJson'));
const jsonText = capturedBlob ? await capturedBlob.text() : '';
ok('JSON 导出可解析', (() => { try { return JSON.parse(jsonText).count === 2; } catch (e) { return false; } })(), jsonText.slice(0, 80));

// ---------- L4 ----------
ok('统计卡片渲染 4 项', d.querySelectorAll('#statsCards .stat-card').length === 4);
ok('统计总量正确', d.querySelector('#statsCards .stat-card .v').textContent === '12');
ok('14 天柱状图渲染', d.querySelectorAll('#statsDaily .stat-bar').length === 14);
ok('来源分布渲染', d.querySelectorAll('#statsSources .stat-row').length === 2);
ok('渠道成功率渲染', d.querySelectorAll('#statsChannels .stat-row').length === 2);
ok('渠道成功率含 83%', d.getElementById('statsChannels').textContent.includes('83%'));
ok('采样说明含条数', d.getElementById('statsNote').textContent.includes('12'));

ok('无 JS 运行时错误', errors.length === 0, errors.join(' | '));
console.log('\nresult: pass=' + pass + ' fail=' + fail);
dom.window.close();
if (fail) process.exit(1);
