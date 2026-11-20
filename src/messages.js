/**
 * 基于 Cloudflare KV 的消息存储层
 * 设计要点：Key 采用「倒序时间戳」前缀，使 KV list 返回结果天然「最新在前」，
 * 无需在内存中排序即可实现按时间倒序读取。
 */
import { generateId } from './utils.js';

const PREFIX = 'msg:';
const VERSION_KEY = 'meta:version'; // 版本号：用于增量检查，避免轮询时反复读取全量列表
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER; // 9007199254740991（16 位）

// ==================== 富文本消息渲染（v1.7，安全白名单） ====================
// 设计：escape-then-allowlist（先转义再放行）。
//   1) 先把整个内容做 HTML 转义——所有 < > & " ' 都变成实体；
//   2) 再把「转义后的白名单标签」还原成真标签。
// 任何不在白名单里的标签（script/iframe/img/svg/...）和**所有属性**都保持转义状态、
// 以纯文本显示——从根上杜绝 XSS，不依赖黑名单枚举，"onerror=" 之类注入天然无效。
// a 是唯一带属性的例外：只还原 href，协议必须是 http/https/mailto，其他写法一律
// 丢弃；同时强制 target="_blank" rel="noopener noreferrer" 防 tab 劫持。
// 纯文本消息（不含任何 HTML 标签）由前端用 pre-wrap 原样保留换行，两条链路展示一致。

const RICH_ALLOWED_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'code', 'pre', 'br', 'hr',
  'p', 'div', 'span', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a',
];

/** 服务端版 HTML 转义（与前端 esc() 规则一致，保证往返无损） */
function escapeHtmlText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function sanitizeRichHtml(content) {
  // 1) 全量转义（null/undefined 容错为空串）
  let out = escapeHtmlText(content == null ? '' : content);
  // 2) 还原白名单标签。转义后标签形如 &lt;div class=&quot;x&quot;&gt;；
  //    原文中的真实 < > 已全部转义，非贪婪匹配到第一个 &gt; 边界可靠。
  out = out.replace(/&lt;(\/?)([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)\/?&gt;/g, (m, slash, tag, attrs) => {
    tag = tag.toLowerCase();
    if (RICH_ALLOWED_TAGS.indexOf(tag) === -1) return m; // 不在白名单 → 保持转义显示
    if (slash) return '</' + tag + '>';                  // 闭合标签：属性无意义，直接还原
    if (tag === 'br') return '<br>';
    if (tag === 'hr') return '<hr>';
    if (tag === 'a') {
      // 仅提取 href 属性（引号转义后是 &quot; / &#39;，用反向引用保证配对）
      const href = /href\s*=\s*(&quot;|&#39;)([\s\S]*?)\1/i.exec(attrs);
      if (!href) return '<a>';
      const value = href[2].trim();
      // 协议白名单：javascript:/data:/vbscript: 等危险协议一律丢弃，
      // 不做实体解码——实体形态的绕过（&#106;avascript:）同样不匹配、同样被丢弃
      if (!/^(https?:\/\/|mailto:)/i.test(value)) return '<a>';
      // value 保持转义状态输出（&amp; 等实体由浏览器自行解码），不引入二次解码风险
      return '<a href="' + value + '" target="_blank" rel="noopener noreferrer">';
    }
    return '<' + tag + '>'; // 其余白名单标签：属性全部丢弃
  });
  return out;
}

/** 剥离全部标签取纯文本（折叠摘要预览用；< 后必须跟字母/斜杠/! 才视为标签，避免误伤 "a < b"） */
export function stripTagsText(content, maxLen = 220) {
  let s = String(content || '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|blockquote|pre|h[1-6]|li|tr|ul|ol)>/gi, '\n');
  s = s.replace(/<[a-zA-Z/!][^>]*>/g, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, maxLen);
}

/** HTML → 企业微信 markdown：加粗/斜体/行内代码/链接/换行转换，其余标签剥离后解码实体 */
export function htmlToMarkdown(content) {
  let s = String(content || '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|blockquote|pre|h[1-6]|li|tr|ul|ol)>/gi, '\n');
  s = s.replace(/<(strong|b)>/gi, '**').replace(/<\/(strong|b)>/gi, '**');
  s = s.replace(/<(em|i)>/gi, '*').replace(/<\/(em|i)>/gi, '*');
  s = s.replace(/<code>/gi, '`').replace(/<\/code>/gi, '`');
  s = s.replace(/<a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
    const safe = /^(https?:\/\/|mailto:)/i.test(href) ? href : '';
    const label = text.replace(/<[^>]*>/g, '');
    return safe ? '[' + label + '](' + safe + ')' : label;
  });
  s = s.replace(/<[a-zA-Z/!][^>]*>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return s;
}

/** 判定内容是否含 HTML 标签（决定前端 rich / text 两种渲染模式） */
function looksLikeHtml(content) {
  return /<\s*\/?\s*[a-zA-Z][^>]*>/.test(String(content || ''));
}

/** 为 API 输出附加渲染字段（只加字段不改存储，旧客户端与新字段互不影响） */
export function decorateMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const content = String(m.content || '');
  return Object.assign({}, m, {
    isRich: looksLikeHtml(content),
    contentHtml: sanitizeRichHtml(content),
    previewText: stripTagsText(content),
  });
}

/** 读取当前数据版本号（不存在时返回 '0'） */
export async function getVersion(env) {
  return (await env.NOTIFICATIONS.get(VERSION_KEY)) || '0';
}

/** 保存一条通知 */
export async function saveMessage(env, input) {
  const id = generateId();
  const now = Date.now();
  const key = `${PREFIX}${String(MAX_TIMESTAMP - now).padStart(16, '0')}-${id}`;

  const message = {
    id,
    title: String(input.title || '').slice(0, 200),
    content: String(input.content || '').slice(0, 20000),
    type: input.type || 'text',
    source: String(input.source || '').slice(0, 100),
    timestamp: now,
  };

  // metadata 会通过内部头传递，只放 ASCII 字段，避免非 ASCII 字符的兼容性问题
  await env.NOTIFICATIONS.put(key, JSON.stringify(message), {
    metadata: { id: message.id, timestamp: message.timestamp },
  });
  await env.NOTIFICATIONS.put(VERSION_KEY, String(now));

  return message;
}

/** 读取最近 limit 条通知（最新在前） */
export async function listMessages(env, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const result = await env.NOTIFICATIONS.list({ prefix: PREFIX, limit: safeLimit });

  // KV list 只返回 key 和 metadata，正文需要逐个 get
  const messages = await Promise.all(
    result.keys.map(async (key) => {
      try {
        const raw = await env.NOTIFICATIONS.get(key.name);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    })
  );

  return messages.filter(Boolean);
}

/** 清空全部通知，返回删除条数 */
export async function clearMessages(env) {
  let deleted = 0;
  let cursor;
  do {
    const result = await env.NOTIFICATIONS.list({ prefix: PREFIX, cursor, limit: 1000 });
    if (result.keys.length) {
      await Promise.all(result.keys.map((key) => env.NOTIFICATIONS.delete(key.name)));
      deleted += result.keys.length;
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  if (deleted > 0) await env.NOTIFICATIONS.put(VERSION_KEY, String(Date.now()));
  return deleted;
}

/** 统计消息总数 */
export async function countMessages(env) {
  let total = 0;
  let cursor;
  do {
    const result = await env.NOTIFICATIONS.list({ prefix: PREFIX, cursor, limit: 1000 });
    total += result.keys.length;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return total;
}
