// 端到端渲染语法验证：调用 worker.fetch 拿服务端真实渲染的 HTML，
// 提取所有 <script> 块做 node --check，防止模板字面量转义 bug 溜到线上。
import { webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const mod = await import('./worker.js');
const worker = mod.default;

// 公开模式（无 READ_TOKEN）即可拿到完整页面 HTML
const env = {
  APP_NAME: 'Cloudflare Notify',
  NOTIFICATIONS: { get: async () => null, put: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
  SEND_TOKEN: 'test-send-token',
  READ_TOKEN: '',
};

const req = new Request('https://example.com/');
const resp = await worker.fetch(req, env);
const html = await resp.text();
console.log('fetch status:', resp.status, 'html bytes:', html.length);

const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('script blocks:', blocks.length);

let failed = 0;
for (let i = 0; i < blocks.length; i++) {
  const f = `._render_script_${i}.mjs`;
  writeFileSync(f, blocks[i], 'utf-8');
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`  block ${i}: OK (${blocks[i].length} bytes)`);
  } catch (e) {
    failed++;
    console.log(`  block ${i}: SYNTAX ERROR`);
    console.log(String(e.stderr || '').split('\n').slice(0, 8).join('\n'));
  }
}
console.log('\nresult:', failed === 0 ? 'ALL SCRIPTS VALID' : `${failed} BLOCK(S) INVALID`);
process.exit(failed ? 1 : 0);
