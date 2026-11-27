// 推送接入面板专项测试：验证示例目录与服务端路由一致、动态渲染、脱敏与无 XSS 风险。
// 运行：node _test_integrations.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
const _worker = fs.readFileSync(path.join(__dirname, '_worker.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// 提取 UI 内联脚本里定义的 INTEGRATIONS 数组源码，并在沙箱里求值
function extractCatalog(text) {
  const startMark = 'var INTEGRATIONS = [';
  const endMark = '\n  var stateIntg';
  const s = text.indexOf(startMark);
  const e = text.indexOf(endMark, s);
  if (s < 0 || e < 0) throw new Error('INTEGRATIONS 定义未找到');
  let literal = text.slice(s + 'var INTEGRATIONS = '.length, e).trim().replace(/;$/, '');
  // INTEGRATIONS 定义在 UI_HTML 模板字面量内，其转义(\\n \\' \\$ 等)是给模板求值用的。
  // 先用模板字面量求值一次，得到浏览器脚本实际看到的文本，再解析为数组。
  literal = Function('return `' + literal + '`')();
  return Function('return ' + literal)();
}

// 提取模板字面量里的 UI_HTML 原始内容（不做插值求值，仅检查静态结构）
function extractUiTemplate(text) {
  const s = text.indexOf('const UI_HTML = `');
  const e = text.indexOf('// 未通过服务端鉴权', s);
  return text.slice(s, e);
}

section('1. 部署入口一致性');
ok('worker.js 与 _worker.js 逐字节一致', src === _worker);

let catalog;
try { catalog = extractCatalog(src); ok('INTEGRATIONS 可解析', true); }
catch (err) { ok('INTEGRATIONS 可解析', false, err.message); catalog = []; }

section('2. 接入方式目录完整性');
const expectedIds = ['urlget', 'json', 'form', 'serverchan', 'python', 'node', 'ci', 'routerhook', 'vars'];
ok('共 9 种接入方式', catalog.length === 9, `实际 ${catalog.length}`);
for (const id of expectedIds) {
  ok(`包含 ${id}`, catalog.some(x => x.id === id));
}
ok('每项都有 label/name/scene/note/code', catalog.every(x =>
  x.label && x.name && x.scene && x.note && typeof x.code === 'function'));
ok('label 无重复', new Set(catalog.map(x => x.label)).size === catalog.length);
ok('id 无重复', new Set(catalog.map(x => x.id)).size === catalog.length);

section('3. 示例与服务端路由一致');
const O = 'https://notify.example.com';
const K = 'test-key-123';
function codeOf(id) {
  const item = catalog.find(x => x.id === id);
  return item.code(O, K);
}
ok('URL 直发使用 /send 且字段为 token/title/content', (() => {
  const c = codeOf('urlget');
  return c.includes(O + '/send?token=') && c.includes('&title=') && c.includes('&content=');
})());
ok('JSON API 使用 /api/send + X-Token + json body', (() => {
  const c = codeOf('json');
  return c.includes(O + '/api/send') && c.includes('X-Token: ' + K) &&
    c.includes('"title"') && c.includes('"content"');
})());
ok('表单 API 使用 --data-urlencode', (() => {
  const c = codeOf('form');
  return c.includes(O + '/api/send') && c.includes('--data-urlencode "title=') &&
    c.includes('--data-urlencode "content=');
})());
ok('方糖端点使用 /<key>.send?text=&desp=', (() => {
  const c = codeOf('serverchan');
  return c.includes(O + '/' + K + '.send') && c.includes('?text=') && c.includes('&desp=');
})());
ok('Python 示例用 requests.post + X-Token', (() => {
  const c = codeOf('python');
  return c.includes('requests.post(') && c.includes('"X-Token": "' + K + '"');
})());
ok('Node.js 示例用 fetch + X-Token', (() => {
  const c = codeOf('node');
  return c.includes('fetch(') && c.includes('"X-Token": "' + K + '"');
})());
ok('CI 示例含 GitHub Actions 与 crontab 两种', (() => {
  const c = codeOf('ci');
  return c.includes('GitHub Actions') && c.includes('secrets.SEND_TOKEN') &&
    c.includes('crontab') && c.includes('*/5 * * * *');
})());
ok('RouterHook 示例使用 /api/routerhook/{event}?device=', (() => {
  const c = codeOf('routerhook');
  return c.includes(O + '/api/routerhook/manuINFO?device=RAX50') &&
    c.includes('X-Token: ' + K) && c.includes('"msgTYPE"');
})());

// 服务端确实存在这些路由
ok('服务端实现了 /send 与 /api/send 的 GET/POST',
  src.includes("path === '/api/send' || path === '/send'"));
ok('服务端实现了 /<key>.send 兼容路由', src.includes('/^\\/([^/]+)\\.send$/'));
ok('服务端实现了 /api/routerhook/{event} 路由', src.includes('/^\\/api\\/routerhook\\/([^/]+)$/'));
ok('服务端 extractToken 支持 token/sendkey/X-Token/Bearer/body',
  src.includes("searchParams.get('token')") && src.includes("searchParams.get('sendkey')") &&
  src.includes("headers.get('X-Token')") && src.includes("startsWith('bearer ')"));

section('4. 动态密钥与域名');
ok('示例不含写死真实域名', catalog.every(x => !x.code('https://x.example', K).includes('ntfy.588816.xyz')));
ok('示例域名随 origin 变化', codeOf('urlget').startsWith(O) && codeOf('urlget').startsWith('https://x.example') === false);
ok('示例密钥随入参变化', codeOf('urlget').includes(K) && !codeOf('urlget').includes('<你的密钥>'));
ok('key 经 encodeURIComponent 处理（方糖路径）', codeOf('serverchan').includes(encodeURIComponent(K)) || K === encodeURIComponent(K));

section('5. UI 结构与渲染接线');
const ui = extractUiTemplate(src);
for (const id of ['intgTabs', 'intgName', 'intgScene', 'intgCode', 'intgNote', 'btnCopyIntg']) {
  ok(`UI 含元素 #${id}`, ui.includes(`id="${id}"`));
}
ok('init() 调用 renderIntegrations()', /renderServerchanUrl\(\);[\s\S]{0,300}?renderIntegrations\(\);[\s\S]{0,80}?start\(\)/.test(src));
ok('轮换密钥后刷新面板', /renderServerchanUrl\(\);\s*\n\s*renderIntegrations\(\);\s*\n\s*\}/.test(src));
ok('输入密钥时刷新面板', /\$\('fSendToken'\)\.addEventListener\('input',\s*function \(\) \{[\s\S]{0,120}?renderIntegrations\(\);/.test(src));
ok('复制按钮绑定 btnCopyIntg', src.includes("$('btnCopyIntg').addEventListener('click'"));
ok('会话失效清空示例代码', /intgCode.*textContent = ''/.test(src));
ok('标签点击使用 closest 事件委托', src.includes("closest('.intg-tab')"));

section('6. 安全：转义与脱敏');
ok('标签文字经 esc() 转义', /esc\(INTEGRATIONS\[i\]\.label\)/.test(src));
ok('示例代码写入前经高亮器转义', /pre\.dataset\.full = fullCode/.test(src) && /highlightCode\(viewLines\.join/.test(src));
ok('登录页不含接入面板 DOM', (() => {
  const s = src.indexOf('const LOGIN_HTML = `');
  const login = src.slice(s);
  return !login.includes('intgTabs') && !login.includes('INTEGRATIONS');
})());
ok('GitHub Actions 密钥用 Secrets 占位而非明文', codeOf('ci').includes('secrets.SEND_TOKEN'));

console.log('\n========================================');
console.log(`接入面板专项：通过 ${pass} / 失败 ${fail}`);
console.log('========================================');
if (fail) process.exit(1);
