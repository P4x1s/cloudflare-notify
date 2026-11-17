/**
 * Cloudflare Notify —— 单文件版 Worker
 * 功能与 src/ 多文件版完全一致：URL 发消息、JSON/表单 API、Web 查看页、双密钥、增量检查、清空。
 * 本文件自包含，可直接粘贴到 Cloudflare Workers 在线编辑器（Edit code）部署。
 *
 * ============================ 在线部署步骤 ============================
 * 1. Cloudflare Dashboard → Workers & Pages → Create worker → 起名字 → Deploy。
 * 2. 进入该 Worker → Edit code → 全选替换为该文件内容 → Save and deploy。
 * 3. Settings → Variables → KV Namespace Bindings → Add binding：
 *      Variable name 填 NOTIFICATIONS，Namespace 选择（或新建）一个 KV namespace。
 *    ⚠ 变量名必须是 NOTIFICATIONS，代码里按这个名字读取。
 * 4. Settings → Variables → Secrets → Add secret（强烈建议设置）：
 *      SEND_TOKEN = 发送密钥（调用 /send、/api/send 时必带）
 *      READ_TOKEN = 查看/清空密钥（可选；留空则查看页公开）
 *      WECOM_WEBHOOK = 企业微信群机器人 Webhook 完整 URL（可选；配置后消息主动推到群）
 * 5. 保存绑定与密钥后立即生效，无需重新部署代码。
 *    访问 https://<你的worker名>.<你的子域>.workers.dev 查看通知页。
 *
 * ======================== 企业微信主动推送（可选） ========================
 * 效果：每次 /send 收到消息后，Worker 立即把同一条消息推到企业微信群，手机实时收到。
 * 拿 Webhook：企业微信 App → 进入/新建一个内部群 → 群右上角「…」→ 群机器人
 *           → 添加机器人（起名如「通知助手」）→ 复制 Webhook 地址
 *           形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx
 * 配置：把该地址原样填入 Secret WECOM_WEBHOOK（不要填到 SEND_TOKEN 里）。
 * 验证：POST /api/test-wecom?token=<SEND_TOKEN> 会往群里发一条测试消息；
 *      或普通发送后看响应里的 wecom 字段（{configured,ok,error}）。
 * 说明：推送失败（如 URL 失效）只影响主动推送，消息仍会正常存入网页收件箱。
 * ======================================================================
 *
 * ====================== 密钥分层与安全轮换（v1.3） ======================
 * 两级密钥，职责分离：
 *   1) SEND_TOKEN（Secret，管理主密钥）：只在后台管理用，绝不填进软件或 URL。
 *      用于轮换密钥、查看当前密钥。Secret 在 Workers 运行时只读，故不可轮换。
 *   2) 轮换推送密钥（KV，meta:sendkey）：由管理接口随机生成，填进软件/URL 的就是它。
 *      一键轮换后旧密钥立即失效，把泄露影响压到最小。
 * 发送时两种密钥都可通过（兼容旧配置），但推荐软件只用轮换密钥。
 *
 * 管理接口（均需 SEND_TOKEN 作管理凭证，轮换密钥无权调用，防拒绝服务）：
 *   POST /api/key/rotate  → 生成新轮换密钥并写入 KV，返回 { key }；旧 key 立即失效
 *   GET  /api/key/current → 查看当前轮换密钥（需管理凭证）
 *
 * 更安全的传参（避免密钥进入 URL 历史/日志/Referer/聊天记录）：
 *   ① Header：X-Token: <key> 或 Authorization: Bearer <key>
 *   ② POST body：JSON 或表单里带 token 字段
 *   ③ 方糖 path 形式 /<key>.send（软件只能填 URL 时用），配合定期轮换
 * ======================================================================
 *
 * ====================== 方糖 / Server酱 兼容推送 ======================
 * 把「轮换推送密钥」当作你的 key（也可用 SEND_TOKEN，但不推荐放进 URL）：
 *   https://<你的域名>/<key>.send
 * 用法（兼容方糖 text/desp 与 Server酱 title/desp 参数）：
 *   https://<你的域名>/<key>.send?text=标题&desp=正文
 *   curl -X POST "https://<你的域名>/<key>.send" -d "title=标题&desp=正文"
 * 返回同时兼容 errno（方糖）与 code（Server酱³）两种判定：{code:0,errno:0,...}
 * 注意：写死 sc.ftqq.com 域名的软件无法迁移，只有能自定义 Webhook/服务器地址的软件可用。
 * ======================================================================
 *
 * 最简单的发送消息方式（浏览器地址栏 / curl / 快捷指令）：
 *   https://<你的域名>/send?token=<SEND_TOKEN>&title=标题&content=正文
 *
 * 自定义域名：Settings → Triggers → Custom Domains → Add Custom Domain，
 * 域名需已接入该 Cloudflare 账户，平台自动配置 CNAME 与免费 SSL。
 *
 * 用 wrangler 本地跑单文件（可选）：新建 wrangler.toml，写
 *   name = "cloudflare-notify"
 *   main = "worker.js"
 *   compatibility_date = "2026-11-16"
 *   [[kv_namespaces]]
 *   binding = "NOTIFICATIONS"
 *   id = "<你的KV ID>"
 * 然后 npx wrangler dev。
 * ====================================================================
 */

// ============================== 内嵌 Web UI ==============================
const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>通知中心 · Cloudflare Notify</title>
<style>
  :root {
    --bg: #f4f6fa;
    --card: #ffffff;
    --text: #1f2430;
    --muted: #6b7280;
    --border: #e5e7eb;
    --primary: #2563eb;
    --primary-hover: #1d4ed8;
    --danger: #dc2626;
    --ok: #16a34a;
    --shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --card: #191c23;
      --text: #e8eaed;
      --muted: #9aa1ad;
      --border: #2b303b;
      --primary: #4f8cff;
      --primary-hover: #3b74e0;
      --danger: #f87171;
      --ok: #4ade80;
      --shadow: 0 1px 3px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.2);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Microsoft YaHei", sans-serif;
    background: var(--bg);
    background-image: radial-gradient(1000px 500px at 12% -8%, rgba(79,140,255,.10), transparent 60%),
                      radial-gradient(800px 400px at 100% 0%, rgba(124,58,237,.08), transparent 55%);
    background-attachment: fixed;
    color: var(--text);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 32px 22px 64px; }

  header.top {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 12px; margin-bottom: 24px;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand .logo {
    width: 40px; height: 40px; border-radius: 11px; flex: none;
    background: linear-gradient(135deg, var(--primary), #7c3aed);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 20px; box-shadow: var(--shadow);
  }
  .brand h1 { font-size: 19px; margin: 0; letter-spacing: .2px; }
  .brand .sub { font-size: 12px; color: var(--muted); }
  .status {
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: var(--ok); box-shadow: 0 0 0 3px rgba(22,163,74,.15); }
  .dot.error { background: var(--danger); }

  .grid { display: grid; grid-template-columns: 300px 300px 1fr; gap: 20px; align-items: start; }
  @media (max-width: 1080px) { .grid { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }

  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; box-shadow: var(--shadow); padding: 22px;
    transition: transform .18s ease, box-shadow .18s ease;
  }
  .card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,.10), 0 14px 34px rgba(0,0,0,.06); }
  .card h2 { margin: 0 0 14px; font-size: 15px; font-weight: 650; letter-spacing: .2px; }

  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 5px; }
  label:first-of-type { margin-top: 0; }
  input, textarea {
    width: 100%; padding: 9px 11px; border-radius: 9px;
    border: 1px solid var(--border); background: transparent; color: var(--text);
    font: inherit; font-size: 13px; outline: none; transition: border-color .15s;
  }
  input:focus, textarea:focus { border-color: var(--primary); }
  textarea { min-height: 96px; resize: vertical; }
  .hint { font-size: 11px; color: var(--muted); margin-top: 5px; word-break: break-all; }

  button {
    font: inherit; cursor: pointer; border-radius: 9px; border: 1px solid var(--border);
    background: var(--card); color: var(--text); padding: 8px 13px; font-size: 13px;
    transition: background .15s, border-color .15s, opacity .15s;
  }
  button:hover { border-color: var(--primary); }
  button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  button.primary:hover { background: var(--primary-hover); }
  button.ghost { background: transparent; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 16px; flex-wrap: wrap; }

  .list-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-bottom: 14px; flex-wrap: wrap;
  }
  .list-head h2 { margin: 0; }
  .list-actions { display: flex; gap: 8px; align-items: center; }
  .count { font-size: 12px; color: var(--muted); }

  .msg {
    border: 1px solid var(--border); border-radius: 11px;
    margin-bottom: 9px; background: var(--bg); overflow: hidden;
    transition: border-color .15s, box-shadow .15s;
  }
  .msg:hover { border-color: var(--primary); }
  .msg.open { box-shadow: 0 2px 10px rgba(0,0,0,.05); }
  .msg-head {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px;
    cursor: pointer; user-select: none;
  }
  .msg-head:hover { background: rgba(79,140,255,.05); }
  .msg-chevron {
    flex: none; color: var(--muted); font-size: 12px; line-height: 1;
    transition: transform .18s ease;
  }
  .msg.open .msg-chevron { transform: rotate(90deg); color: var(--primary); }
  .msg .m-title {
    flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 14px;
    word-break: break-word; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
  .msg .m-time { font-size: 11px; color: var(--muted); white-space: nowrap; flex: none; }
  .msg .m-source {
    font-size: 10px; padding: 1px 7px; border-radius: 999px; flex: none;
    background: rgba(79,140,255,.12); color: var(--primary);
    max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .msg-detail { padding: 0 14px 13px 34px; }
  .msg:not(.open) .msg-detail { display: none; }
  .msg .m-body {
    font-size: 13px; color: var(--text); white-space: pre-wrap;
    word-break: break-word; opacity: .9;
    border-top: 1px solid var(--border); padding-top: 10px;
    max-height: 360px; overflow-y: auto;
  }
  .msg .m-meta { margin-top: 8px; font-size: 11px; color: var(--muted); }
  .toggle-all { font-size: 12px; padding: 5px 10px; }

  .empty { text-align: center; padding: 48px 12px; color: var(--muted); }
  .empty .icon { font-size: 34px; opacity: .5; }
  .empty p { margin: 8px 0 0; font-size: 13px; }

  .toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(20px);
    background: #111827; color: #fff; padding: 9px 16px; border-radius: 9px;
    font-size: 13px; opacity: 0; pointer-events: none; transition: .25s; z-index: 50;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.45); backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 40;
  }
  .overlay.hidden { display: none; }
  .login { width: 100%; max-width: 360px; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="logo">✦</div>
      <div>
        <h1>通知中心</h1>
        <div class="sub">Cloudflare Notify · 免费、免服务器的消息通知</div>
      </div>
    </div>
    <div class="status">
      <span class="dot" id="dot"></span>
      <span id="statusText">正在连接…</span>
      <button class="ghost" id="btnLogout" style="display:none">退出</button>
    </div>
  </header>

  <div id="diagCard" class="card" style="margin-bottom:20px;display:none">
    <h2>配置自检</h2>
    <div id="diagBody" style="font-size:13px;line-height:1.9"></div>
  </div>

  <div class="grid">
    <section class="card">
      <h2>密钥管理与轮换</h2>
      <p style="font-size:12px;color:var(--muted);margin:0 0 10px">
        两级密钥：<b>管理主密钥 SEND_TOKEN</b> 只用于后台轮换，绝不要填进软件或 URL；<b>轮换推送密钥</b> 才是填进软件的那个，随时可换、换后旧的立即失效。
      </p>
      <label for="fMasterToken">管理主密钥（SEND_TOKEN）</label>
      <input id="fMasterToken" type="password" placeholder="仅用于生成/查看轮换密钥" />
      <div class="hint" id="keyStatus">当前轮换密钥状态加载中…</div>
      <div class="row">
        <button class="primary" id="btnRotateKey">生成新推送密钥</button>
        <button class="ghost" id="btnViewKey">查看当前密钥</button>
      </div>
      <div class="hint" id="rotatedKeyBox" style="display:none;padding:9px 11px;border:1px solid var(--ok);border-radius:9px;word-break:break-all;cursor:pointer"></div>
      <div class="hint" id="rotateHint" style="margin-top:8px"></div>
    </section>

    <section class="card">
      <h2>方糖风格推送地址</h2>
      <p style="font-size:12px;color:var(--muted);margin:0 0 10px">
        把下面这个地址填到任何支持「自定义 Webhook / Server酱 / 方糖」的软件里，即可推送到企业微信。key 优先使用上面的<b>轮换推送密钥</b>（更安全）。
      </p>
      <div class="hint" id="scUrl" style="padding:9px 11px;border:1px dashed var(--border);border-radius:9px;word-break:break-all;cursor:pointer"></div>
      <div class="row">
        <button class="ghost" id="btnCopyScUrl">复制推送地址</button>
      </div>
      <div class="hint" id="scHint"></div>
    </section>

    <section class="card">
      <h2>发送测试通知</h2>
      <label for="fTitle">标题</label>
      <input id="fTitle" placeholder="例如：构建完成" />
      <label for="fContent">内容</label>
      <textarea id="fContent" placeholder="在这里输入通知正文…"></textarea>
      <label for="fSendToken">发送密钥（SEND_TOKEN）</label>
      <input id="fSendToken" type="password" placeholder="留空则使用浏览器保存的值" />
      <div class="hint" id="sendHint">密钥仅保存在本机浏览器，不会上传到第三方。</div>
      <div class="hint" id="wecomHint"></div>
      <div class="row">
        <button class="primary" id="btnSend">发送通知</button>
        <button class="ghost" id="btnCopyCurl">复制 curl 示例</button>
        <button class="ghost" id="btnTestWecom">测试企微推送</button>
      </div>
      <div class="hint" id="curlBox" style="display:none"></div>
    </section>

    <section class="card">
      <div class="list-head">
        <h2>最近通知</h2>
        <div class="list-actions">
          <span class="count" id="count"></span>
          <button class="ghost toggle-all" id="btnToggleAll">全部展开</button>
          <button class="ghost" id="btnRefresh">刷新</button>
          <button class="ghost danger" id="btnClear">清空</button>
        </div>
      </div>
      <div class="hint" style="margin:0 0 10px">点标题行展开/折叠，默认只显示标题；新消息自动收起。</div>
      <div id="list">
        <div class="empty"><div class="icon">◇</div><p>加载中…</p></div>
      </div>
    </section>
  </div>
</div>

<div class="overlay hidden" id="loginOverlay">
  <div class="card login">
    <h2>访问验证</h2>
    <p style="font-size:13px;color:var(--muted);margin:0 0 12px">
      该通知服务启用了查看密钥，请输入 READ_TOKEN 继续。
    </p>
    <label for="loginToken">查看密钥</label>
    <input id="loginToken" type="password" placeholder="READ_TOKEN" />
    <div class="row">
      <button class="primary" id="btnLogin">进入</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  'use strict';

  var REFRESH_MS = 5000;
  var state = {
    status: null,
    readToken: localStorage.getItem('cfn_read_token') || '',
    sendToken: localStorage.getItem('cfn_send_token') || '',
    rotatingKey: '',
    messages: [],
    expanded: {},
    allExpanded: false,
    version: '',
    timer: null
  };

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function setStatus(kind, text) {
    $('dot').className = 'dot' + (kind ? ' ' + kind : '');
    $('statusText').textContent = text;
  }

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (state.readToken) headers['X-Token'] = state.readToken;
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) {
          showLogin();
          throw new Error('unauthorized');
        }
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
      });
    });
  }

  function showLogin() {
    clearInterval(state.timer);
    $('loginOverlay').classList.remove('hidden');
    $('btnLogout').style.display = 'none';
    setStatus('error', '需要验证');
  }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (e) { return String(ts); }
  }

  function renderDiagnostics(s) {
    var d = s.diagnostics;
    if (!d) return;
    var rows = [
      ['Worker 服务', true, '可访问（本页已成功加载）'],
      ['KV 存储绑定', d.kvOk, d.kvOk ? '正常，消息可存取' : (d.kvError || '未绑定，请在 Settings → Variables → KV Namespace Bindings 添加 NOTIFICATIONS')],
      ['发送密钥 SEND_TOKEN', d.sendTokenSet, d.sendTokenSet ? '已设置，方糖地址可用' : '未设置，请先添加 Secret'],
      ['查看密钥 READ_TOKEN', d.readTokenSet, d.readTokenSet ? '已设置，查看需验证' : '未设置，查看页公开'],
      ['企业微信 WECOM_WEBHOOK', d.wecomWebhookSet, d.wecomWebhookSet ? '已配置，可主动推送' : '未配置，仅网页收件箱'],
    ];
    var allOk = true;
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var label = rows[i][0], okFlag = rows[i][1], note = rows[i][2];
      if (!okFlag && label !== '查看密钥 READ_TOKEN' && label !== '企业微信 WECOM_WEBHOOK') allOk = false;
      var color = okFlag ? 'var(--ok)' : 'var(--danger)';
      html += '<div style="display:flex;gap:9px;align-items:flex-start">' +
        '<span style="color:' + color + ';font-weight:600;white-space:nowrap">' + (okFlag ? '● 正常' : '● 异常') + '</span>' +
        '<span><b>' + esc(label) + '</b> — ' + esc(note) + '</span></div>';
    }
    if (!allOk) {
      html += '<div style="margin-top:10px;padding:9px 11px;border-radius:9px;background:rgba(220,38,38,.08);font-size:12px">' +
        '存在异常项。若访问的是 *.workers.dev 地址且打不开，多为网络原因，建议绑定自定义域名（Settings → Triggers → Custom Domains）。' +
        '</div>';
    }
    $('diagBody').innerHTML = html;
    $('diagCard').style.display = 'block';
  }

  function renderServerchanUrl() {
    // 优先用轮换密钥（更安全），其次用户手填的密钥，最后浏览器保存的 SEND_TOKEN
    var token = state.rotatingKey || $('fSendToken').value.trim() || state.sendToken;
    var box = $('scUrl');
    if (!token) {
      box.textContent = '请先在「密钥管理与轮换」生成推送密钥，或在发送表单填入密钥，这里会生成专属地址。';
      $('scHint').textContent = '推荐点「生成新推送密钥」——用轮换密钥而不是 SEND_TOKEN，泄露后一键作废。';
      return;
    }
    var url = location.origin + '/' + encodeURIComponent(token) + '.send?text=标题&desp=正文';
    box.textContent = url;
    box.dataset.url = url;
    $('scHint').textContent = '写死 sc.ftqq.com 的软件无法改用本服务；能填「自定义 Webhook / 服务器地址」的软件可用。建议在软件里填这个轮换密钥，泄露后点「生成新推送密钥」即可让旧 key 失效。';
  }

  function renderKeyStatus(s) {
    var text = s.rotatingKeyReady
      ? '已生成轮换推送密钥' + (s.rotatedAt ? '（' + fmtTime(s.rotatedAt) + ' 更新）' : '') + '。软件里应填这个 key，不要填 SEND_TOKEN。'
      : '尚未生成轮换推送密钥。填入 SEND_TOKEN 后点「生成新推送密钥」，Software 用生成出的 key。';
    $('keyStatus').textContent = text;
  }

  function render() {
    var box = $('list');
    $('count').textContent = state.messages.length + ' 条';

    if (!state.messages.length) {
      box.innerHTML = '<div class="empty"><div class="icon">◇</div>' +
        '<p>暂无通知。用上方表单发送一条，或调用 /send 接口。</p></div>';
      return;
    }

    var html = '';
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      var id = String(m.id || i);
      var open = state.allExpanded || Boolean(state.expanded[id]);
      html += '<div class="msg' + (open ? ' open' : '') + '" data-id="' + esc(id) + '">' +
        '<div class="msg-head" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="msg-chevron">▶</span>' +
        '<span class="m-title">' + esc(m.title || '（无标题）') + '</span>' +
        (m.source ? '<span class="m-source">' + esc(m.source) + '</span>' : '') +
        '<span class="m-time">' + esc(fmtTime(m.timestamp)) + '</span></div>' +
        '<div class="msg-detail">' +
        (m.content ? '<div class="m-body">' + esc(m.content) + '</div>' : '') +
        '<div class="m-meta">来源：' + esc(m.source || 'api') + ' · ID：' + esc(id) + '</div>' +
        '</div></div>';
    }
    box.innerHTML = html;
    $('btnToggleAll').textContent = state.allExpanded ? '全部折叠' : '全部展开';
  }

  function toggleMessage(id) {
    if (state.allExpanded) {
      // 从"全部展开"状态下单独折叠某条：先固化每条为展开，再翻转目标
      for (var k = 0; k < state.messages.length; k++) state.expanded[String(state.messages[k].id || k)] = true;
      state.allExpanded = false;
      state.expanded[id] = false;
    } else {
      state.expanded[id] = !state.expanded[id];
    }
    render();
  }

  function loadMessages() {
    var url = '/api/messages?limit=50' +
      (state.version ? '&version=' + encodeURIComponent(state.version) : '');
    return api(url).then(function (data) {
      state.version = data.version || state.version;
      if (!data.unchanged) {
        state.messages = data.messages || [];
        render();
      }
      setStatus('live', '已连接 · ' + fmtTime(Date.now()) + ' 更新');
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
      setStatus('error', '连接失败：' + err.message);
    });
  }

  function init() {
    fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
      state.status = s;
      if (s.needReadToken && !state.readToken) {
        showLogin();
        return;
      }
      if (s.needReadToken) $('btnLogout').style.display = 'inline-block';
      $('sendHint').textContent = s.needSendToken
        ? '服务端已启用发送密钥，请输入 SEND_TOKEN。'
        : '服务端未设置发送密钥，可直接发送（建议线上设置）。';
      $('wecomHint').textContent = s.wecomConfigured
        ? '企业微信推送：已开启，新消息会同步推到群。'
        : '企业微信推送：未配置（在 Worker Secrets 设置 WECOM_WEBHOOK 即可开启）。';
      $('btnTestWecom').disabled = !s.wecomConfigured;
      renderDiagnostics(s);
      renderKeyStatus(s);
      renderServerchanUrl();
      start();
    }).catch(function (err) {
      setStatus('error', '无法获取服务状态');
    });
  }

  function start() {
    loadMessages();
    clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (!document.hidden) loadMessages();
    }, REFRESH_MS);
  }

  // 事件委托：点标题行展开/折叠（不用 inline onclick，便于严格 CSP）
  $('list').addEventListener('click', function (e) {
    var head = e.target.closest && e.target.closest('.msg-head');
    if (!head) return;
    var card = head.parentNode;
    if (card && card.dataset && card.dataset.id) toggleMessage(card.dataset.id);
  });
  $('list').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var head = e.target.closest && e.target.closest('.msg-head');
    if (!head) return;
    e.preventDefault();
    var card = head.parentNode;
    if (card && card.dataset && card.dataset.id) toggleMessage(card.dataset.id);
  });

  $('btnToggleAll').addEventListener('click', function () {
    state.allExpanded = !state.allExpanded;
    state.expanded = {};
    render();
  });

  $('btnRefresh').addEventListener('click', function () {
    loadMessages().then(function () { toast('已刷新'); });
  });

  $('btnLogin').addEventListener('click', function () {
    state.readToken = $('loginToken').value.trim();
    localStorage.setItem('cfn_read_token', state.readToken);
    $('loginOverlay').classList.add('hidden');
    $('btnLogout').style.display = 'inline-block';
    init();
  });
  $('loginToken').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btnLogin').click();
  });

  $('btnLogout').addEventListener('click', function () {
    state.readToken = '';
    localStorage.removeItem('cfn_read_token');
    $('btnLogout').style.display = 'none';
    location.reload();
  });

  $('btnSend').addEventListener('click', function () {
    var btn = this;
    var token = $('fSendToken').value.trim() || state.sendToken;
    var payload = { title: $('fTitle').value.trim(), content: $('fContent').value.trim() };
    if (!payload.title && !payload.content) { toast('请填写标题或内容'); return; }

    btn.disabled = true;
    var url = '/api/send' + (token ? '?token=' + encodeURIComponent(token) : '');
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (res) {
        if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
        if (token) {
          state.sendToken = token;
          localStorage.setItem('cfn_send_token', token);
          renderServerchanUrl();
        }
        $('fTitle').value = '';
        $('fContent').value = '';
        toast('发送成功');
        return loadMessages();
      })
      .catch(function (err) { toast('发送失败：' + err.message); })
      .finally(function () { btn.disabled = false; });
  });

  $('btnClear').addEventListener('click', function () {
    if (!window.confirm('确定清空全部通知吗？此操作不可恢复。')) return;
    api('/api/clear', { method: 'POST' }).then(function (data) {
      toast('已清空 ' + (data.deleted || 0) + ' 条');
      return loadMessages();
    }).catch(function (err) {
      if (err.message !== 'unauthorized') toast('清空失败：' + err.message);
    });
  });

  $('btnCopyCurl').addEventListener('click', function () {
    var token = state.rotatingKey || $('fSendToken').value.trim() || state.sendToken || '<YOUR_KEY>';
    var title = $('fTitle').value.trim() || '测试标题';
    var content = $('fContent').value.trim() || '测试内容';
    // 用 Header 传密钥：密钥不进 URL，不会留在浏览器历史/日志/Referer 中
    var cmd = 'curl -X POST "' + location.origin + '/api/send" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -H "X-Token: ' + token + '" \\\n' +
      "  -d '" + JSON.stringify({ title: title, content: content }) + "'";
    var box = $('curlBox');
    box.textContent = cmd;
    box.style.display = 'block';
    if (navigator.clipboard) navigator.clipboard.writeText(cmd).then(function () { toast('已复制 curl（密钥走 Header，更安全）'); });
    else toast('已生成，请手动复制');
  });

  $('fSendToken').addEventListener('input', renderServerchanUrl);
  $('scUrl').addEventListener('click', function () {
    var url = this.dataset.url;
    if (url && navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('已复制推送地址'); });
  });
  $('btnCopyScUrl').addEventListener('click', function () {
    var box = $('scUrl');
    var url = box.dataset.url;
    if (!url) { toast('请先填入 SEND_TOKEN'); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('已复制推送地址'); });
    else { box.textContent = url; toast('请手动复制'); }
  });

  $('btnTestWecom').addEventListener('click', function () {
    var btn = this;
    var token = $('fSendToken').value.trim() || state.sendToken;
    btn.disabled = true;
    var url = '/api/test-wecom' + (token ? '?token=' + encodeURIComponent(token) : '');
    fetch(url, { method: 'POST' }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      toast('测试成功，请查看企业微信群');
    }).catch(function (err) {
      toast('测试失败：' + err.message);
    }).finally(function () {
      btn.disabled = false;
    });
  });

  function showRotatedKey(key, isNew) {
    state.rotatingKey = key;
    var box = $('rotatedKeyBox');
    box.textContent = key;
    box.dataset.key = key;
    box.style.display = 'block';
    $('rotateHint').textContent = isNew
      ? '新密钥已生效，旧密钥立即失效。请到软件里替换成这个新 key。点密钥框可复制。'
      : '这是当前生效的推送密钥。点密钥框可复制；轮换后此 key 失效。';
    renderServerchanUrl();
  }

  function adminHeaders() {
    var m = $('fMasterToken').value.trim();
    if (!m) { toast('请先填入管理主密钥 SEND_TOKEN'); return null; }
    return { 'Content-Type': 'application/json', 'X-Token': m };
  }

  $('btnRotateKey').addEventListener('click', function () {
    var btn = this;
    var headers = adminHeaders();
    if (!headers) return;
    btn.disabled = true;
    fetch('/api/key/rotate', { method: 'POST', headers: headers }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      showRotatedKey(res.d.key, true);
      toast('新推送密钥已生成，旧 key 已失效');
    }).catch(function (err) {
      toast('轮换失败：' + err.message);
    }).finally(function () { btn.disabled = false; });
  });

  $('btnViewKey').addEventListener('click', function () {
    var btn = this;
    var m = $('fMasterToken').value.trim();
    if (!m) { toast('请先填入管理主密钥 SEND_TOKEN'); return; }
    btn.disabled = true;
    fetch('/api/key/current', { headers: { 'X-Token': m } }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      if (!res.d.key) { toast('尚未生成轮换密钥，请先点「生成新推送密钥」'); return; }
      showRotatedKey(res.d.key, false);
    }).catch(function (err) {
      toast('查看失败：' + err.message);
    }).finally(function () { btn.disabled = false; });
  });

  $('rotatedKeyBox').addEventListener('click', function () {
    var key = this.dataset.key;
    if (key && navigator.clipboard) navigator.clipboard.writeText(key).then(function () { toast('已复制推送密钥'); });
  });

  init();
})();
</script>
</body>
</html>`;

// ============================== 工具函数 ==============================
// CORS 默认收紧：不设置 Access-Control-Allow-Origin，跨站浏览器脚本无法读取响应。
// 同源页面、curl、服务端 Webhook 调用均不受影响（它们不依赖 CORS）。
// 这是有意的收窄——旧版用 '*' 允许任意站点读取 API，已移除。
const CORS_PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token',
  'Access-Control-Max-Age': '86400',
};

// 统一的安全响应头（纵深防御）
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

// UI 为单文件内嵌（内联 script/style 是它运行的前提），CSP 收紧到 self + unsafe-inline。
// 若移除 unsafe-inline，需要把脚本与样式拆成独立静态资源，届时不再是单文件。
const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function json(data, status = 200, extraHeaders = {}, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': HTML_CSP,
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * 从 query / X-Token / Authorization: Bearer / POST body 四种方式提取密钥。
 * 推荐用 Header 或 body，避免密钥写进 URL（URL 会进浏览器历史、日志、Referer）。
 * body 是已解析的对象（可选），仅在没有更优先来源时读取。
 */
function extractToken(request, url, body) {
  const fromQuery = url.searchParams.get('token') || url.searchParams.get('sendkey');
  if (fromQuery) return fromQuery;
  const fromHeader = request.headers.get('X-Token');
  if (fromHeader) return fromHeader;
  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (body && typeof body === 'object') {
    const fromBody = body.token || body.sendkey || body.key;
    if (fromBody) return String(fromBody);
  }
  return null;
}

/** 读取/校验查看密钥。未配置时视为公开访问。 */
function hasReadPermission(request, url, env) {
  const expected = env.READ_TOKEN;
  if (!expected) return true;
  return extractToken(request, url) === expected;
}

/**
 * 校验发送凭证：管理主密钥 SEND_TOKEN，或 KV 中当前生效的轮换密钥，任一匹配即可。
 * 未配置任何发送密钥时视为公开（兼容旧行为）。
 */
async function hasSendPermission(request, url, env, body) {
  const token = extractToken(request, url, body);
  const master = String(env.SEND_TOKEN || '').trim();
  const current = await getCurrentSendKey(env);
  if (!master && !current) return true;
  if (!token) return false;
  return token === master || (Boolean(current) && token === current);
}

/** 管理操作鉴权：只认管理主密钥 SEND_TOKEN，轮换密钥无权调用 */
function hasAdminPermission(request, url, env, body) {
  const master = String(env.SEND_TOKEN || '').trim();
  if (!master) return false;
  return extractToken(request, url, body) === master;
}

function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// ============================== KV 存储层 ==============================
const PREFIX = 'msg:';
const VERSION_KEY = 'meta:version';
const SENDKEY_KEY = 'meta:sendkey';
const ROTATED_AT_KEY = 'meta:sendkey_rotated_at';
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

async function getVersion(env) {
  return (await env.NOTIFICATIONS.get(VERSION_KEY)) || '0';
}

/** 用 Web Crypto 生成 32 字节随机密钥（64 位十六进制），比时间戳类 key 更难猜 */
function generateSendKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

/** 读取当前生效的轮换密钥；无 KV 绑定或从未生成时返回空串 */
async function getCurrentSendKey(env) {
  if (!env.NOTIFICATIONS) return '';
  try {
    return String((await env.NOTIFICATIONS.get(SENDKEY_KEY)) || '');
  } catch (e) {
    return '';
  }
}

/** 轮换：生成新密钥写入 KV 并覆盖旧值；旧的立即失效 */
async function rotateSendKey(env) {
  const key = generateSendKey();
  await env.NOTIFICATIONS.put(SENDKEY_KEY, key);
  await env.NOTIFICATIONS.put(ROTATED_AT_KEY, String(Date.now()));
  await env.NOTIFICATIONS.put(VERSION_KEY, String(Date.now()));
  return key;
}

async function saveMessage(env, input) {
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
  await env.NOTIFICATIONS.put(key, JSON.stringify(message), {
    metadata: { id: message.id, timestamp: message.timestamp },
  });
  await env.NOTIFICATIONS.put(VERSION_KEY, String(now));
  return message;
}

async function listMessages(env, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const result = await env.NOTIFICATIONS.list({ prefix: PREFIX, limit: safeLimit });
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

async function clearMessages(env) {
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

async function countMessages(env) {
  let total = 0;
  let cursor;
  do {
    const result = await env.NOTIFICATIONS.list({ prefix: PREFIX, cursor, limit: 1000 });
    total += result.keys.length;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return total;
}

// ============================== 企业微信推送 ==============================
/** 毫秒时间戳 → 北京时间字符串（固定 UTC+8，不依赖 Intl 时区数据） */
function fmtWecomTime(ts) {
  return new Date(Number(ts) + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 通过企业微信群机器人 Webhook 推送通知。
 * 未配置 Webhook 时静默跳过；任何异常都被吞掉，绝不影响消息入库。
 * 返回 { configured, ok, error? }。
 */
async function pushToWecom(env, message) {
  const webhook = String(env.WECOM_WEBHOOK || '').trim();
  if (!webhook) return { configured: false, ok: false, skipped: true };

  // 企业微信 markdown 上限 4096 字节，中文按 3 字节算，正文截断以留足余量
  const title = String(message.title || '（无标题）').slice(0, 100);
  const body = String(message.content || '').slice(0, 1000);
  const meta = String(message.source || 'api').slice(0, 60) + ' · ' + fmtWecomTime(message.timestamp);
  const markdown = {
    msgtype: 'markdown',
    markdown: { content: '**' + title + '**' + (body ? '\n' + body : '') + '\n> ' + meta },
  };

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(markdown),
      signal: AbortSignal.timeout(8000),
    });
    let result = {};
    try { result = await res.json(); } catch (_) { /* 企业微信异常时可能非 JSON */ }
    if (!res.ok || result.errcode !== 0) {
      return { configured: true, ok: false, error: result.errmsg || ('HTTP ' + res.status) };
    }
    return { configured: true, ok: true };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      error: err && err.message ? err.message : 'Webhook 请求失败',
    };
  }
}

// ============================== 请求处理 ==============================
async function parseBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    try { return await request.json(); } catch { return {}; }
  }
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

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
  // 主动推送到企业微信（best-effort：失败不影响消息入库与 API 成功响应）
  const wecom = await pushToWecom(env, message);
  return json({ ok: true, code: 0, message: '通知已接收', data: message, wecom });
}

/**
 * 方糖 / Server酱 兼容发送：路径中的 key 为管理主密钥 SEND_TOKEN 或当前轮换密钥。
 * 同时返回 errno（方糖）与 code（Server酱³）以兼容各类客户端判定成功。
 */
async function serverchanSend(env, key, data) {
  const master = String(env.SEND_TOKEN || '').trim();
  const current = await getCurrentSendKey(env);
  if (!master && !current) {
    return json({ code: 1, errno: 1, errmsg: '服务端未设置 SEND_TOKEN，请先配置密钥', message: '服务端未设置 SEND_TOKEN' }, 401);
  }
  if (key !== master && !(Boolean(current) && key === current)) {
    return json({ code: 1, errno: 1, errmsg: 'key 错误', message: 'invalid key' }, 401);
  }
  const title = String(data.title || data.text || '').trim();
  const desp = String(data.desp || data.content || data.body || '').trim();
  if (!title && !desp) {
    return json({ code: 1, errno: 1, errmsg: '标题或正文不能为空', message: 'empty content' }, 400);
  }
  const message = await saveMessage(env, {
    title: title || '（无标题）',
    content: desp,
    type: data.type || 'markdown',
    source: data.source || 'serverchan',
  });
  const wecom = await pushToWecom(env, message);
  return json({
    code: 0,
    errno: 0,
    message: '',
    errmsg: 'success',
    data: {
      pushid: message.id,
      readkey: message.id,
      timestamp: message.timestamp,
      wecom,
    },
  });
}

const VERSION = '1.3.1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
    }

    try {
      // 查看页面
      if (path === '/' || path === '/index.html') {
        return html(UI_HTML);
      }

      // 服务状态 + 配置自检（用于排查"页面打不开 / 功能异常"）
      if (path === '/api/status' && method === 'GET') {
        let kvOk = false;
        let kvError = '';
        try {
          await env.NOTIFICATIONS.list({ limit: 1 });
          kvOk = true;
        } catch (e) {
          // 脱敏：只返回归类后的提示，不暴露底层异常原文（该端点无需鉴权）。
          kvError = 'KV 绑定不可用，请检查 NOTIFICATIONS 绑定';
        }
        const rotatingKey = await getCurrentSendKey(env);
        const rotatedAt = kvOk ? String((await env.NOTIFICATIONS.get(ROTATED_AT_KEY)) || '') : '';
        return json({
          ok: true,
          service: 'cloudflare-notify',
          version: VERSION,
          single_file: true,
          needSendToken: Boolean(env.SEND_TOKEN),
          needReadToken: Boolean(env.READ_TOKEN),
          wecomConfigured: Boolean(env.WECOM_WEBHOOK),
          rotatingKeyReady: Boolean(rotatingKey),
          rotatedAt: rotatedAt ? Number(rotatedAt) : 0,
          diagnostics: {
            kvBound: Boolean(env.NOTIFICATIONS),
            kvOk,
            kvError,
            sendTokenSet: Boolean(env.SEND_TOKEN),
            readTokenSet: Boolean(env.READ_TOKEN),
            wecomWebhookSet: Boolean(env.WECOM_WEBHOOK),
            serverchanReady: Boolean(env.SEND_TOKEN || rotatingKey),
            rotatingKeyReady: Boolean(rotatingKey),
          },
        });
      }

      // 生成/轮换推送密钥（管理主密钥鉴权；旧密钥立即失效）
      if (path === '/api/key/rotate' && method === 'POST') {
        const body = await parseBody(request);
        if (!hasAdminPermission(request, url, env, body)) {
          return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        }
        if (!env.NOTIFICATIONS) {
          return json({ ok: false, error: '未绑定 KV 命名空间 NOTIFICATIONS，无法轮换' }, 400);
        }
        const key = await rotateSendKey(env);
        return json({
          ok: true,
          key,
          hint: '把这个新 key 填进软件并替换旧值；旧 key 已立即失效。',
        });
      }

      // 查看当前推送密钥（管理主密钥鉴权）
      if (path === '/api/key/current' && method === 'GET') {
        if (!hasAdminPermission(request, url, env)) {
          return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        }
        const key = await getCurrentSendKey(env);
        return json({ ok: true, key, configured: Boolean(key) });
      }

      // 读取通知（增量检查）
      if (path === '/api/messages' && method === 'GET') {
        if (!hasReadPermission(request, url, env)) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
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

      // 发送消息：POST（密钥可放 query / Header / body）
      if ((path === '/api/send' || path === '/send') && method === 'POST') {
        const body = await parseBody(request);
        if (!(await hasSendPermission(request, url, env, body))) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        return await createMessage(env, body);
      }

      // 发送消息：GET（URL 直发）
      if ((path === '/api/send' || path === '/send') && method === 'GET') {
        if (!(await hasSendPermission(request, url, env))) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        return await createMessage(env, {
          title: url.searchParams.get('title') || url.searchParams.get('text') || '',
          content: url.searchParams.get('content') || url.searchParams.get('desp') || '',
          type: url.searchParams.get('type') || 'text',
          source: url.searchParams.get('source') || 'url',
        });
      }

      // 测试企业微信 Webhook 连通性
      if (path === '/api/test-wecom' && method === 'POST') {
        if (!(await hasSendPermission(request, url, env))) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        if (!String(env.WECOM_WEBHOOK || '').trim()) {
          return json({ ok: false, error: '未配置 WECOM_WEBHOOK' }, 400);
        }
        const result = await pushToWecom(env, {
          title: '企业微信推送测试',
          content: '看到这条消息即表示 Webhook 配置成功。',
          source: 'test',
          timestamp: Date.now(),
        });
        return json(result, result.ok ? 200 : 502);
      }

      // 清空
      if (path === '/api/clear' && method === 'POST') {
        if (!hasReadPermission(request, url, env)) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({ ok: true, deleted: await clearMessages(env) });
      }

      // 统计
      if (path === '/api/count' && method === 'GET') {
        if (!hasReadPermission(request, url, env)) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({ ok: true, total: await countMessages(env) });
      }

      // 方糖 / Server酱 兼容：/<SEND_TOKEN>.send
      const sendMatch = path.match(/^\/([^/]+)\.send$/);
      if (sendMatch && (method === 'GET' || method === 'POST')) {
        const key = decodeURIComponent(sendMatch[1]);
        const data = method === 'GET'
          ? {
              title: url.searchParams.get('title') || url.searchParams.get('text') || '',
              desp: url.searchParams.get('desp') || url.searchParams.get('content') || '',
              source: url.searchParams.get('source') || 'serverchan',
            }
          : await parseBody(request);
        return await serverchanSend(env, key, data);
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      // 不向客户端暴露内部异常细节（可能含 KV 结构/配置敏感信息）。
      // 详细堆栈写入 console，可在 Cloudflare Dashboard → Workers → Logs 查看。
      console.error('[notify] unhandled error:', err && err.stack ? err.stack : err);
      return json(
        { ok: false, error: 'internal server error' },
        500
      );
    }
  },
};
