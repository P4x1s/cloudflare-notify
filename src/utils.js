/**
 * 公共工具函数：响应封装、鉴权、参数提取
 */

// 跨域响应头：方便快捷指令、浏览器书签、各种脚本直接调用
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token',
  'Access-Control-Max-Age': '86400',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  ...CORS_HEADERS,
};

/** 返回 JSON 响应 */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/** 返回 HTML 响应 */
export function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

/**
 * 从请求中提取密钥，兼容三种传参方式：
 * 1. URL 参数：?token=xxx 或 ?sendkey=xxx
 * 2. 请求头：X-Token: xxx
 * 3. 请求头：Authorization: Bearer xxx
 */
export function extractToken(request, url) {
  const fromQuery = url.searchParams.get('token') || url.searchParams.get('sendkey');
  if (fromQuery) return fromQuery;

  const fromHeader = request.headers.get('X-Token');
  if (fromHeader) return fromHeader;

  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

  return null;
}

/**
 * 校验密钥。
 * kind = 'send' -> 校验 env.SEND_TOKEN
 * kind = 'read' -> 校验 env.READ_TOKEN
 * 对应密钥未配置时视为公开访问。
 */
export function hasPermission(request, url, env, kind) {
  const expected = kind === 'send' ? env.SEND_TOKEN : env.READ_TOKEN;
  if (!expected) return true; // 未设置密钥 -> 不校验
  return extractToken(request, url) === expected;
}

/** 生成唯一 ID（时间戳 + 随机数） */
export function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}
