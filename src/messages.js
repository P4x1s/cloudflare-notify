/**
 * 基于 Cloudflare KV 的消息存储层
 * 设计要点：Key 采用「倒序时间戳」前缀，使 KV list 返回结果天然「最新在前」，
 * 无需在内存中排序即可实现按时间倒序读取。
 */
import { generateId } from './utils.js';

const PREFIX = 'msg:';
const VERSION_KEY = 'meta:version'; // 版本号：用于增量检查，避免轮询时反复读取全量列表
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER; // 9007199254740991（16 位）

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
