/**
 * Cloudflare Notify —— Worker 入口
 *
 * 路由表：
 *   GET  /                 通知查看页面（Web UI）
 *   GET  /api/status       服务状态（是否启用密钥、版本号）
 *   GET  /api/messages     获取通知列表
 *   GET  /send             通过 URL 发送消息（方糖风格，最简单）
 *   POST /send             通过表单发送消息
 *   POST /api/send         通过 JSON / 表单发送消息
 *   POST /api/clear        清空全部通知
 *   GET  /api/count        统计通知总数
 */
import uiHtml from './ui.html';
import { CORS_HEADERS, json, html, hasPermission } from './utils.js';
import {
  saveMessage,
  listMessages,
  clearMessages,
  countMessages,
  getVersion,
} from './messages.js';

const VERSION = '1.0.0';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检请求
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ---- Web UI ----
      if (path === '/' || path === '/index.html') {
        return html(uiHtml);
      }

      // ---- 服务状态（无需鉴权，供前端判断是否弹出登录框）----
      if (path === '/api/status' && method === 'GET') {
        return json({
          ok: true,
          service: 'cloudflare-notify',
          version: VERSION,
          needSendToken: Boolean(env.SEND_TOKEN),
          needReadToken: Boolean(env.READ_TOKEN),
        });
      }

      // ---- 读取通知 ----
      if (path === '/api/messages' && method === 'GET') {
        if (!hasPermission(request, url, env, 'read')) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        // 增量检查：客户端版本号一致时只返回标记，不读取全量列表，显著节省 KV 读取额度
        const version = await getVersion(env);
        const clientVersion = url.searchParams.get('version');
        if (clientVersion && clientVersion === version) {
          return json({ ok: true, unchanged: true, version });
        }
        const messages = await listMessages(env, url.searchParams.get('limit') || 50);
        return json({
          ok: true,
          unchanged: false,
          version,
          count: messages.length,
          messages,
        });
      }

      // ---- 发送消息：POST（JSON 或表单）----
      if ((path === '/api/send' || path === '/send') && method === 'POST') {
        if (!hasPermission(request, url, env, 'send')) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        return await createMessage(env, await parseBody(request));
      }

      // ---- 发送消息：GET（最简单的 URL 调用方式）----
      if ((path === '/api/send' || path === '/send') && method === 'GET') {
        if (!hasPermission(request, url, env, 'send')) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        return await createMessage(env, {
          title: url.searchParams.get('title') || url.searchParams.get('text') || '',
          content: url.searchParams.get('content') || url.searchParams.get('desp') || '',
          type: url.searchParams.get('type') || 'text',
          source: url.searchParams.get('source') || 'url',
        });
      }

      // ---- 清空通知 ----
      if (path === '/api/clear' && method === 'POST') {
        if (!hasPermission(request, url, env, 'read')) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        const deleted = await clearMessages(env);
        return json({ ok: true, deleted });
      }

      // ---- 统计总数 ----
      if (path === '/api/count' && method === 'GET') {
        if (!hasPermission(request, url, env, 'read')) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({ ok: true, total: await countMessages(env) });
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json(
        { ok: false, error: err && err.message ? err.message : 'internal error' },
        500
      );
    }
  },
};

/** 解析请求体，同时兼容 JSON 与 application/x-www-form-urlencoded / multipart */
async function parseBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

/** 统一的消息创建逻辑 */
async function createMessage(env, data) {
  const title = String(data.title || data.text || '').trim();
  const content = String(data.content || data.desp || data.body || '').trim();

  if (!title && !content) {
    return json({ ok: false, error: 'title 或 content 至少填写一个' }, 400);
  }

  const message = await saveMessage(env, {
    title: title || '（无标题）',
    content,
    type: data.type || 'text',
    source: data.source || 'api',
  });

  return json({
    ok: true,
    code: 0,
    message: '通知已接收',
    data: message,
  });
}
