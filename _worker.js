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
 *      READ_TOKEN = 查看密钥（可选；设置后网页需登录才能看通知与接入地址）
 *      WECOM_WEBHOOK = 企业微信群机器人 Webhook 完整 URL（可选；配置后消息主动推到群）
 * 5. 保存绑定与密钥后立即生效，无需重新部署代码。
 *    访问 https://<你的worker名>.<你的子域>.workers.dev 查看通知页。
 *    若设置了 READ_TOKEN，会先看到登录页，输入它即可进入。
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
 * ==================== 查看页的访问控制（v1.4，默认开启） ====================
 * 设置了 READ_TOKEN 时，查看页与只读接口都需要凭据：
 *   · 打开网页 → 服务端只返回**最小登录页**，里面没有推送地址、密钥、通知列表
 *     这些 DOM。删掉任何遮罩 div 也看不到（旧版是纯前端遮罩，属真实漏洞）。
 *   · 输入 READ_TOKEN → POST /api/login → 服务端签发 HttpOnly 会话 Cookie
 *     （HMAC-SHA256 签名，密钥就是 READ_TOKEN，7 天有效）→ 之后自动带上。
 *   · 密钥不落 localStorage，JS/XSS 都读不到；改 READ_TOKEN 会让旧会话立即失效。
 *   · 直接访问 /?token=<READ_TOKEN> 也能进：服务端换发 Cookie 并 302 到干净地址。
 *   · 同一 IP 5 分钟内登录失败 8 次会被临时锁定（429）。
 * 未设置 READ_TOKEN 时保持零配置的公开模式（页面本身不含任何密钥）。
 * ======================================================================
 *
 * ====================== 富文本消息展示（v1.7） ======================
 * 推送正文支持有限 HTML 渲染（加粗/斜体/链接/换行/列表/代码块/引用/标题等）：
 *   <b>加粗</b> <a href="https://x.com">链接</a> <br> <p> <ul><li> <pre><code> <blockquote> ...
 * 安全：服务端 escape-then-allowlist 白名单消毒——先全量转义再只还原白名单标签，
 *   script/iframe/img 及所有事件属性保持转义原样显示；a 只放行 http/https/mailto
 *   协议的 href 并强制 rel="noopener noreferrer"。纯文本消息保留原始换行。
 * API：GET /api/messages 每条消息附加 isRich / contentHtml / previewText 三个字段，
 *   原 title/content 等字段原样保留，旧客户端不受影响。
 * 企业微信推送：正文自动做 HTML→markdown 转换（加粗/链接/换行保留语义）。
 * ======================================================================
 *
 * ====================== RouterHook 路由器通知兼容（v1.8） ======================
 * 专用接口：POST /api/routerhook/{event}?device=<设备标识>
 *   event：manuINFO / cronINFO / ifUP / newDHCP / rh_* 传感器；未知事件通用接收不丢弃。
 *   鉴权：X-Token / Authorization: Bearer / body token / query token（复用发送密钥体系）。
 *   响应体含 "success" 字符串——RouterHook 的 sender.sh 靠 grep success 判定成功。
 * 普通事件立即生成「中文摘要 + 完整原始 JSON」通知；rh_* 传感器进入 Durable Object
 *   按设备独立聚合，固定 60 秒窗口（ROUTERHOOK_WINDOW_SECONDS 可配 30/60/120），
 *   窗口到期生成一条汇总通知，企业微信只推汇总后的消息，避免刷屏。
 * 绑定：Durable Object namespace = ROUTERHOOK_SENSOR（见 wrangler.toml 的 binding/migration）。
 *   未绑定时自动降级为逐条即时通知，数据不丢失。
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
// 安全模型（v1.4）：
//   1) 页面本体由服务端鉴权——配置了 READ_TOKEN 时，未通过验证的请求只会拿到
//      「最小登录页」，里面**不存在**任何推送地址 / 密钥 DOM，删遮罩也看不到。
//   2) 验证通过后签发 HttpOnly 会话 Cookie（HMAC-SHA256 签名，密钥=READ_TOKEN）。
//      Cookie 不落地 localStorage，JS 读不到，XSS 也偷不走。
//   3) READ_TOKEN 未配置时视为公开模式，保持零配置即可用的体验。

const UI_CSS = `
  :root {
    --bg: #f4f6fa;
    --card: #ffffff;
    --text: #1f2430;
    --muted: #6b7280;
    --border: #e5e7eb;
    --line: 1px solid var(--border);
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
  .wrap { max-width: 1200px; margin: 0 auto; padding: 28px 20px 56px; }

  /* ---------- 页头 ---------- */
  header.top {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 12px; margin-bottom: 18px; padding: 0 2px;
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
  .status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: var(--ok); box-shadow: 0 0 0 3px rgba(22,163,74,.15); }
  .dot.error { background: var(--danger); }

  /* ---------- 统一面板：整页一个外框，内部只用发丝线分区 ---------- */
  .panel {
    background: var(--card); border: var(--line);
    border-radius: 16px; box-shadow: var(--shadow); overflow: hidden;
  }
  .panel-cols { display: grid; grid-template-columns: 344px minmax(0, 1fr); }
  .panel-side { border-right: var(--line); min-width: 0; }
  .panel-main { min-width: 0; }
  @media (max-width: 980px) {
    .panel-cols { grid-template-columns: 1fr; }
    .panel-side { border-right: none; border-bottom: var(--line); }
  }

  .section { padding: 22px 24px; }
  .section + .section { border-top: var(--line); }
  .section h2 { margin: 0 0 4px; font-size: 14px; font-weight: 650; letter-spacing: .2px; }
  .sec-desc { font-size: 12px; color: var(--muted); margin: 0 0 14px; line-height: 1.65; }

  /* ---------- 表单 ---------- */
  label { display: block; font-size: 12px; color: var(--muted); margin: 14px 0 5px; }
  label:first-of-type { margin-top: 0; }
  input, textarea {
    width: 100%; padding: 9px 11px; border-radius: 9px;
    border: var(--line); background: transparent; color: var(--text);
    font: inherit; font-size: 13px; outline: none; transition: border-color .15s;
  }
  input:focus, textarea:focus { border-color: var(--primary); }
  textarea { min-height: 92px; resize: vertical; }
  .hint { font-size: 11px; color: var(--muted); margin-top: 6px; line-height: 1.6; word-break: break-word; }
  .hint.box {
    padding: 9px 11px; border: var(--line); border-radius: 9px;
    font-size: 12px; color: var(--text);
  }
  .hint.box.dashed { border-style: dashed; cursor: pointer; }
  .hint.box.dashed:hover { border-color: var(--primary); }
  .hint.box.ok { border-color: var(--ok); color: var(--ok); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .key-box { cursor: pointer; }
  .key-box:hover { border-color: var(--primary); }
  .key-box::after {
    content: ' · 点击复制'; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 10px; opacity: .7;
  }

  /* ---------- 工具模块：统一头部 / 状态 / 卡片 ---------- */
  .tool-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .tool-head h2 { margin: 0; }
  .tool-badge {
    flex: none; font-size: 10.5px; color: var(--muted); line-height: 1.5;
    border: var(--line); border-radius: 999px; padding: 1px 8px;
  }
  .tool-badge.on { color: var(--ok); border-color: var(--ok); }
  .tool-note { font-size: 12px; color: var(--muted); margin: 7px 0 14px; line-height: 1.65; }
  .tool-note b { color: var(--text); font-weight: 600; }
  .inline-status {
    display: none; align-items: flex-start; gap: 7px; margin-top: 10px; padding: 8px 10px;
    border: var(--line); border-radius: 9px; font-size: 11.5px; line-height: 1.6;
    background: rgba(127,127,127,.05);
  }
  .inline-status.show { display: flex; }
  .inline-status .mark { flex: none; font-weight: 700; }
  .inline-status.ok { border-color: var(--ok); color: var(--ok); }
  .inline-status.err { border-color: var(--danger); color: var(--danger); }
  .inline-status.info { color: var(--muted); }

  /* ---------- 推送接入方式切换 ---------- */
  .intg-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 2px 0 12px; }
  .intg-tab {
    font-size: 11px; padding: 6px 4px; border-radius: 8px;
    border: var(--line); background: transparent; color: var(--muted); cursor: pointer;
    text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .intg-tab:hover { border-color: var(--primary); color: var(--text); }
  .intg-tab.active { background: var(--primary); border-color: var(--primary); color: #fff; }
  .intg-card { border: var(--line); border-radius: 11px; padding: 13px; background: var(--bg); }
  .intg-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .intg-copy { flex: none; padding: 4px 9px; font-size: 11px; }
  .intg-name { font-size: 12.5px; font-weight: 600; margin: 0; }
  .intg-scene { font-size: 11px; color: var(--muted); line-height: 1.6; margin: 8px 0 10px; }
  .intg-code {
    margin: 0; padding: 10px 11px; border-radius: 8px; border: var(--line);
    background: rgba(127,127,127,.08); color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
    max-height: 230px; overflow: auto;
  }
  .intg-card .hint { margin-top: 8px; }
  .intg-sep { height: 1px; background: var(--line); margin: 16px 0 14px; }
  .intg-quick-label { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }

  button {
    font: inherit; cursor: pointer; border-radius: 9px; border: var(--line);
    background: var(--card); color: var(--text); padding: 8px 13px; font-size: 13px;
    transition: background .15s, border-color .15s, opacity .15s;
  }
  button:hover { border-color: var(--primary); }
  button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  button.primary:hover { background: var(--primary-hover); }
  button.ghost { background: transparent; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }

  /* ---------- 自检条 ---------- */
  .diag-strip { border-bottom: var(--line); background: rgba(79,140,255,.05); }
  .diag-strip[hidden] { display: none; }
  .diag-inner { padding: 16px 24px; font-size: 13px; line-height: 1.9; }

  /* ---------- 通知列表 ---------- */
  .list-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-bottom: 10px; flex-wrap: wrap;
  }
  .list-head h2 { margin: 0 0 0; }
  .list-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .count { font-size: 12px; color: var(--muted); }

  .msg {
    border: var(--line); border-radius: 11px;
    margin-bottom: 8px; background: var(--bg); overflow: hidden;
    transition: border-color .15s, box-shadow .15s;
  }
  .msg:hover { border-color: var(--primary); }
  .msg.open { box-shadow: 0 2px 10px rgba(0,0,0,.05); }
  .msg-head {
    display: flex; align-items: flex-start; gap: 10px; padding: 11px 14px;
    cursor: pointer; user-select: none;
  }
  .msg-head:hover { background: rgba(79,140,255,.05); }
  .msg-head:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
  .msg-chevron {
    flex: none; color: var(--muted); font-size: 11px; line-height: 1.7;
    transition: transform .18s ease;
  }
  .msg.open .msg-chevron { transform: rotate(90deg); color: var(--primary); }
  .msg-main { flex: 1 1 auto; min-width: 0; }
  .msg-row { display: flex; align-items: baseline; gap: 8px; }
  .msg .m-title {
    flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 14px; line-height: 1.5;
    word-break: break-word; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .msg .m-time { font-size: 11px; color: var(--muted); white-space: nowrap; flex: none; }
  .msg .m-source {
    font-size: 10px; padding: 1px 7px; border-radius: 999px; flex: none;
    background: rgba(79,140,255,.12); color: var(--primary);
    max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* 折叠态的正文摘要：两行 clamp——不展开也能读到内容 */
  .msg .m-preview {
    margin-top: 2px; font-size: 12.5px; line-height: 1.55; color: var(--muted);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-word;
  }
  .msg .m-preview:empty { display: none; }
  .msg.open .m-preview { display: none; }
  .msg .m-hint {
    flex: none; font-size: 11px; color: var(--muted); margin-top: 2px;
    opacity: 0; transition: opacity .15s;
  }
  .msg:hover .m-hint, .msg-head:focus-visible .m-hint { opacity: .8; }
  .msg.open .m-hint { display: none; }
  .msg-detail { padding: 0 14px 12px 35px; }
  .msg:not(.open) .msg-detail { display: none; }
  .msg .m-body {
    font-size: 13px; color: var(--text);
    word-break: break-word; border-top: var(--line); padding-top: 10px;
    max-height: 380px; overflow-y: auto;
  }
  /* 纯文本消息：pre-wrap 保留推送时的原始换行与空行 */
  .msg .m-body.text { white-space: pre-wrap; }
  /* 富文本消息：排版交给白名单标签，源码换行折叠为空格 */
  .msg .m-body.rich { white-space: normal; line-height: 1.7; }
  .msg .m-body.rich p, .msg .m-body.rich div, .msg .m-body.rich blockquote,
  .msg .m-body.rich pre, .msg .m-body.rich ul, .msg .m-body.rich ol { margin: 7px 0; }
  .msg .m-body.rich > :first-child { margin-top: 0; }
  .msg .m-body.rich > :last-child { margin-bottom: 0; }
  .msg .m-body.rich h1, .msg .m-body.rich h2, .msg .m-body.rich h3,
  .msg .m-body.rich h4, .msg .m-body.rich h5, .msg .m-body.rich h6 {
    margin: 12px 0 5px; font-weight: 600; line-height: 1.4;
  }
  .msg .m-body.rich h1 { font-size: 17px; }
  .msg .m-body.rich h2 { font-size: 16px; }
  .msg .m-body.rich h3 { font-size: 15px; }
  .msg .m-body.rich h4, .msg .m-body.rich h5, .msg .m-body.rich h6 { font-size: 14px; }
  .msg .m-body.rich a {
    color: var(--primary); text-decoration: none;
    border-bottom: 1px dashed rgba(79,140,255,.45); word-break: break-all;
  }
  .msg .m-body.rich a:hover { border-bottom-style: solid; }
  .msg .m-body.rich code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; background: rgba(127,127,127,.14);
    padding: 1px 5px; border-radius: 4px;
  }
  .msg .m-body.rich pre {
    background: rgba(127,127,127,.10); border: var(--line); border-radius: 8px;
    padding: 9px 12px; overflow-x: auto; white-space: pre;
  }
  .msg .m-body.rich pre code { background: none; padding: 0; font-size: 12px; }
  .msg .m-body.rich blockquote {
    border-left: 3px solid var(--primary); padding: 2px 0 2px 10px; color: var(--muted);
  }
  .msg .m-body.rich ul, .msg .m-body.rich ol { padding-left: 22px; }
  .msg .m-body.rich li { margin: 3px 0; }
  .msg .m-body.rich mark { background: rgba(255,213,79,.45); color: inherit; padding: 0 2px; border-radius: 3px; }
  .msg .m-body.rich hr { border: none; border-top: var(--line); margin: 12px 0; }
  .msg .m-meta { margin-top: 8px; font-size: 11px; color: var(--muted); }
  .toggle-all { font-size: 12px; padding: 5px 10px; }

  .empty { text-align: center; padding: 44px 12px; color: var(--muted); }
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
  .login-box {
    width: 100%; max-width: 360px; background: var(--card);
    border: var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 24px;
  }
  .login-box h2 { margin: 0 0 6px; font-size: 16px; }

  /* ---------- 独立登录页 ---------- */
  .auth-wrap {
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .auth-card {
    width: 100%; max-width: 380px; background: var(--card);
    border: var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 30px 28px;
  }
  .auth-card .brand { margin-bottom: 20px; }
  .auth-card h1 { font-size: 18px; margin: 0 0 6px; }
  .auth-card .sub { font-size: 12px; color: var(--muted); }
  .auth-card .lead { font-size: 13px; color: var(--muted); margin: 0 0 18px; line-height: 1.7; }
  .auth-err {
    display: none; margin-top: 12px; padding: 9px 11px; border-radius: 9px;
    background: rgba(220,38,38,.10); color: var(--danger); font-size: 12px;
  }
  .auth-err.show { display: block; }

  /* ---------- Turnstile 人机验证 ---------- */
  /* 组件容器必须在渲染时可见（display:none 会让 iframe 尺寸为 0），故不做隐藏切换 */
  .ts-widget { margin: 16px 0; min-height: 65px; }
  .ts-msg {
    display: none; margin-top: 10px; padding: 8px 10px; border-radius: 9px;
    background: rgba(220,38,38,.10); color: var(--danger); font-size: 12px;
  }
  .ts-msg.show { display: block; }
  .ts-msg.info { background: rgba(79,140,255,.10); color: var(--primary); }
  .primary:disabled { opacity: .55; cursor: not-allowed; }

  /* ---------- v2.0：手动主题覆盖（优先级高于系统偏好） ---------- */
  :root[data-theme="light"] {
    color-scheme: light; --bg:#f4f6fa; --card:#ffffff; --text:#1f2430; --muted:#6b7280;
    --border:#e5e7eb; --primary:#2563eb; --primary-hover:#1d4ed8; --danger:#dc2626; --ok:#16a34a;
  }
  :root[data-theme="dark"] {
    color-scheme: dark; --bg:#0f1115; --card:#191c23; --text:#e8eaed; --muted:#9aa1ad;
    --border:#2b303b; --primary:#4f8cff; --primary-hover:#3b74e0; --danger:#f87171; --ok:#4ade80;
  }

  /* ---------- v2.0：快捷导航 ---------- */
  .quick-nav { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 14px; }
  .quick-nav a {
    font-size:11.5px; color:var(--muted); text-decoration:none; border:var(--line);
    border-radius:999px; padding:4px 11px; background:transparent;
  }
  .quick-nav a:hover, .quick-nav a.active { color:var(--primary); border-color:var(--primary); }

  /* ---------- v2.0：服务状态小组件 ---------- */
  .health-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
  .health-item {
    display:flex; align-items:center; gap:7px; font-size:11.5px; padding:6px 8px;
    border:var(--line); border-radius:8px; background:var(--bg); min-width:0;
  }
  .health-item .flag { color:var(--ok); font-weight:700; flex:none; }
  .health-item.bad .flag { color:var(--danger); }
  .health-item span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* ---------- v2.0：渠道配置卡片 ---------- */
  .channel-card { border:var(--line); border-radius:10px; padding:11px; background:var(--bg); margin-bottom:9px; }
  .channel-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .channel-name { font-size:12.5px; font-weight:600; }
  .channel-card input[type="password"], .channel-card input[type="text"] { font-size:12px; padding:7px 9px; }
  .switch { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--muted); cursor:pointer; }
  .channel-state { font-size:10px; color:var(--muted); }
  .channel-state.on { color:var(--ok); }

  /* ---------- v2.0：消息搜索/过滤/操作 ---------- */
  .search-box { position:relative; flex:1 1 220px; min-width:160px; }
  .search-box input { font-size:12px; padding:7px 10px 7px 28px; }
  .search-box::before { content:'⌕'; position:absolute; left:9px; top:4px; color:var(--muted); font-size:15px; }
  .chips { display:flex; gap:5px; flex-wrap:wrap; margin:0 0 10px; }
  .chip {
    font-size:10.5px; padding:3px 9px; border-radius:999px; border:var(--line);
    background:transparent; color:var(--muted); cursor:pointer;
  }
  .chip.active { color:#fff; background:var(--primary); border-color:var(--primary); }
  .day-group {
    font-size:11px; color:var(--muted); margin:12px 0 6px; padding-left:2px;
    display:flex; align-items:center; gap:8px;
  }
  .day-group::after { content:''; flex:1; height:1px; background:var(--line); }
  .msg-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:9px; }
  .msg-actions button { font-size:11px; padding:4px 9px; }
  .delivery-line { font-size:11px; color:var(--muted); margin-top:7px; line-height:1.7; }
  .delivery-line .ok { color:var(--ok); }
  .delivery-line .bad { color:var(--danger); }

  /* ---------- v2.0：代码块复制按钮 ---------- */
  .code-wrap { position:relative; }
  .code-copy {
    position:absolute; right:7px; top:7px; font-size:10px; padding:3px 7px;
    border-radius:6px; border:var(--line); background:var(--card); opacity:.75;
  }
  .code-copy:hover { opacity:1; }

  /* ---------- v2.0：自定义确认弹窗 ---------- */
  .confirm-box {
    width:100%; max-width:380px; background:var(--card); border:var(--line);
    border-radius:14px; box-shadow:var(--shadow); padding:22px;
  }
  .confirm-box h3 { margin:0 0 8px; font-size:15px; }
  .confirm-box p { margin:0 0 16px; font-size:12.5px; color:var(--muted); line-height:1.7; }
  .confirm-box .row { justify-content:flex-end; margin-top:0; }

  /* ---------- v2.0：<600px 移动端深度适配 ---------- */
  @media (max-width: 600px) {
    .wrap { padding:16px 12px 78px; }
    header.top { align-items:flex-start; }
    .brand h1 { font-size:17px; }
    .section { padding:16px 14px; }
    .panel-cols { grid-template-columns:1fr; }
    .intg-tabs { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .intg-code { max-height:200px; font-size:12px; }
    .row { flex-direction:column; align-items:stretch; }
    .row button { width:100%; }
    input, textarea { font-size:16px; }
    .msg-head { padding:9px 10px; gap:7px; }
    .msg .m-title { font-size:13px; }
    .msg-detail { padding:0 10px 10px 10px; }
    .msg .m-body { max-height:260px; }
    .list-actions { width:100%; }
    .list-actions button { flex:1 1 auto; }
    .search-box { flex-basis:100%; }
    .health-grid { grid-template-columns:1fr; }
    .bottom-bar {
      position:fixed; left:0; right:0; bottom:0; z-index:30; display:flex; gap:6px;
      padding:8px 12px calc(8px + env(safe-area-inset-bottom)); border-top:var(--line);
      background:var(--card); box-shadow:0 -4px 16px rgba(0,0,0,.06);
    }
    .bottom-bar button { flex:1; font-size:12px; padding:7px 4px; }
  }
  @media (min-width: 601px) { .bottom-bar { display:none; } }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }

  /* ---------- v2.1：U4 语法高亮 / E7 登录页 / L4 统计 / L5 文档 ---------- */
  .code-body { display:flex; gap:9px; }
  .code-ln { flex:0 0 auto; text-align:right; color:var(--muted); opacity:.55; user-select:none;
    font-size:11px; line-height:1.75; border-right:1px solid var(--line); padding-right:8px; }
  .intg-code { flex:1 1 auto; min-width:0; white-space:pre-wrap; word-break:break-all; }
  .tok-kw { color:#c678dd; font-weight:600; }
  .tok-str { color:#3b9b6b; }
  .tok-com { color:#8b949e; font-style:italic; }
  .tok-num { color:#d19a66; }
  :root[data-theme="light"] .tok-kw { color:#a626a4; }
  :root[data-theme="light"] .tok-str { color:#0a7a45; }
  :root[data-theme="light"] .tok-com { color:#7a7f87; }
  :root[data-theme="light"] .tok-num { color:#b8641b; }
  .code-more { display:inline-block; margin-top:6px; font-size:11px; color:var(--primary); cursor:pointer; }
  .code-more:hover { text-decoration:underline; }

  .stats-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:14px; }
  .stat-card { background:var(--bg); border:var(--line); border-radius:10px; padding:12px; }
  .stat-card .v { font-size:20px; font-weight:700; line-height:1.2; }
  .stat-card .k { font-size:11px; color:var(--muted); margin-top:4px; }
  .stat-block { margin-top:12px; }
  .stat-block h3 { font-size:12px; margin:0 0 8px; color:var(--muted); font-weight:600; }
  .stat-bars { display:flex; align-items:flex-end; gap:3px; height:76px; }
  .stat-bar { flex:1 1 0; min-width:2px; background:var(--primary); opacity:.75; border-radius:3px 3px 0 0; position:relative; }
  .stat-bar:hover { opacity:1; }
  .stat-row { display:flex; align-items:center; gap:8px; font-size:11.5px; margin:5px 0; }
  .stat-row .n { flex:0 0 88px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .stat-row .track { flex:1 1 auto; height:8px; background:var(--bg); border-radius:4px; overflow:hidden; }
  .stat-row .fill { height:100%; background:var(--primary); border-radius:4px; }
  .stat-row .c { flex:0 0 44px; text-align:right; color:var(--muted); }

  .doc-table { overflow-x:auto; }
  .doc-table table { width:100%; border-collapse:collapse; font-size:12px; }
  .doc-table th, .doc-table td { text-align:left; padding:8px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
  .doc-table th { color:var(--muted); font-weight:600; }
  .doc-verb { display:inline-block; min-width:46px; text-align:center; padding:2px 6px; border-radius:5px;
    font-size:10px; font-weight:700; color:#fff; background:#4f8cff; }
  .doc-verb.post { background:#2e9e6b; }
  .doc-verb.put { background:#d99a2b; }
  .doc-verb.delete { background:#d9534f; }

  .auth-back { display:inline-block; margin-top:16px; font-size:12px; color:var(--primary); }
  .auth-lead { font-size:12.5px; line-height:1.75; color:var(--muted); }
  .auth-err.show { display:block !important; }

  @media (max-width: 600px) {
    .stats-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .stat-row .n { flex-basis:66px; }
    .doc-table { font-size:11px; }
  }

  /* ---------- v2.2：主密钥保存开关 ---------- */
  .remember-master { margin:8px 0 2px; font-size:12px; color:var(--muted); }
  .remember-master input { width:auto; margin:0; accent-color:var(--primary); }
  #masterSaveHint { min-height:16px; }
  #forgetMasterRow { margin-top:6px; }
`;

// L3：中英文字典随页面下发，不依赖外部资源；模板注入点由 applyTurnstile 统一处理。
const I18N_JS = `
(function (w) {
  'use strict';
  var D = {
    zh: {
      'app.name': '通知中心',
      'app.sub': '免费、免服务器的消息通知',
      'nav.integration': '接入', 'nav.channels': '渠道', 'nav.rules': '规则', 'nav.keys': '密钥',
      'nav.send': '发送', 'nav.list': '通知', 'nav.stats': '统计', 'nav.docs': 'API 文档',
      'header.theme': '主题', 'header.diag': '配置自检', 'header.logout': '退出', 'header.lang': 'EN',
      'status.connecting': '正在连接…', 'status.live': '已连接', 'status.error': '连接失败',
      'sec.integration': '推送接入', 'sec.channels': '通知渠道', 'sec.rules': '规则与模板',
      'sec.keys': '密钥与轮换', 'sec.send': '发送测试通知', 'sec.list': '最近通知', 'sec.stats': '统计看板',
      'badge.ways': '9 种方式', 'badge.optional': '可选',
      'note.integration': '点标签查看示例，复制后把示例里的密钥换成下方生成的轮换推送密钥即可。',
      'note.channels': '企业微信 / 钉钉 / 飞书可同时启用。Webhook 只保存在你自己的 KV，面板展示时自动脱敏。',
      'note.rules': '静默时段内的消息仍会存入通知中心，只是不推送到外部渠道。',
      'note.keys': '软件里只填轮换推送密钥；SEND_TOKEN 是管理主密钥，仅用于下方操作，不要填进软件。',
      'label.rememberMaster': '记住主密钥（仅存本机浏览器）',
      'hint.masterSaved': '已保存：下次打开会自动填入。公共电脑上请勿勾选。',
      'hint.masterUnsaved': '未保存：刷新后需重新输入主密钥。',
      'btn.forgetMaster': '清除已保存的主密钥',
      'confirm.forgetMaster': '将立即从本机浏览器删除已保存的主密钥并清空输入框，确定继续吗？',
      'toast.masterSaved': '主密钥已保存到本机浏览器',
      'toast.masterCleared': '已清除本机保存的主密钥',
      'err.masterRequired': '请先输入主密钥，再勾选记住',
      'note.send': '先填标题或内容，点「发送通知」验证链路；密钥可留空以使用浏览器保存值。',
      'note.list': '折叠时显示标题与内容摘要，点击标题行展开全文；支持按来源过滤与按时间分组。',
      'btn.copyExample': '复制示例', 'btn.copy': '复制', 'btn.copyPushUrl': '复制推送地址',
      'btn.saveChannels': '保存渠道配置', 'btn.saveRules': '保存规则', 'btn.previewVars': '预览变量',
      'btn.viewKey': '查看当前密钥', 'btn.rotateKey': '生成新密钥', 'btn.send': '发送通知',
      'btn.copyCurl': '复制 curl', 'btn.testWecom': '测试企微', 'btn.testDingtalk': '测试钉钉', 'btn.testFeishu': '测试飞书', 'btn.toggleAll': '全部展开',
      'btn.collapseAll': '全部折叠', 'btn.refresh': '刷新', 'btn.clear': '清空',
      'btn.exportJson': '导出 JSON', 'btn.exportCsv': '导出 CSV', 'btn.exportMd': '导出 MD',
      'label.search': '搜索标题、内容或来源…', 'empty.list': '暂无通知。用左侧表单发送一条，或调用 /send 接口。',
      'empty.filter': '没有匹配的通知，试试调整搜索词或来源过滤。',
      'stats.total': '累计消息', 'stats.today': '今日消息', 'stats.sources': '来源分布',
      'stats.channels': '渠道投递', 'stats.rate': '成功率', 'stats.sample': '基于最近 {n} 条统计',
      'login.title': '访问验证', 'login.lead': '该通知服务已开启查看验证。请输入查看密钥（READ_TOKEN）以查看通知与接入地址。',
      'login.token': '查看密钥', 'login.enter': '进入通知中心', 'login.err': '验证失败',
      'toast.refreshed': '已刷新', 'toast.copied': '已复制', 'toast.exported': '已生成导出文件'
    },
    en: {
      'app.name': 'Notification Center',
      'app.sub': 'Free, serverless message notifications',
      'nav.integration': 'Integrations', 'nav.channels': 'Channels', 'nav.rules': 'Rules', 'nav.keys': 'Keys',
      'nav.send': 'Send', 'nav.list': 'Messages', 'nav.stats': 'Stats', 'nav.docs': 'API Docs',
      'header.theme': 'Theme', 'header.diag': 'Diagnostics', 'header.logout': 'Sign out', 'header.lang': '中文',
      'status.connecting': 'Connecting…', 'status.live': 'Connected', 'status.error': 'Connection failed',
      'sec.integration': 'Push integrations', 'sec.channels': 'Channels', 'sec.rules': 'Rules & templates',
      'sec.keys': 'Keys & rotation', 'sec.send': 'Send a test', 'sec.list': 'Recent messages', 'sec.stats': 'Statistics',
      'badge.ways': '9 ways', 'badge.optional': 'Optional',
      'note.integration': 'Pick a tab, copy the sample, then replace the key with the rotating key generated below.',
      'note.channels': 'WeCom / DingTalk / Feishu can be enabled together. Webhooks stay in your own KV and are masked in the panel.',
      'note.rules': 'Messages during quiet hours are still stored, only outbound pushes are skipped.',
      'note.keys': 'Put only the rotating key in your apps. SEND_TOKEN is the admin key — never paste it into clients.',
      'label.rememberMaster': 'Remember admin key (this browser only)',
      'hint.masterSaved': 'Saved: it will be filled in next time. Do not enable on a shared computer.',
      'hint.masterUnsaved': 'Not saved: you will need to enter it again after a refresh.',
      'btn.forgetMaster': 'Forget saved admin key',
      'confirm.forgetMaster': 'This removes the saved admin key from this browser and clears the input. Continue?',
      'toast.masterSaved': 'Admin key saved in this browser',
      'toast.masterCleared': 'Saved admin key removed',
      'err.masterRequired': 'Enter the admin key before enabling remember',
      'note.send': 'Enter a title or body and click Send. Leave the key blank to use the saved one.',
      'note.list': 'Click a row to expand. Search, source filters and day grouping are supported.',
      'btn.copyExample': 'Copy sample', 'btn.copy': 'Copy', 'btn.copyPushUrl': 'Copy push URL',
      'btn.saveChannels': 'Save channels', 'btn.saveRules': 'Save rules', 'btn.previewVars': 'Preview vars',
      'btn.viewKey': 'Show current key', 'btn.rotateKey': 'Rotate key', 'btn.send': 'Send',
      'btn.copyCurl': 'Copy curl', 'btn.testWecom': 'Test WeCom', 'btn.testDingtalk': 'Test DingTalk', 'btn.testFeishu': 'Test Feishu', 'btn.toggleAll': 'Expand all',
      'btn.collapseAll': 'Collapse all', 'btn.refresh': 'Refresh', 'btn.clear': 'Clear',
      'btn.exportJson': 'Export JSON', 'btn.exportCsv': 'Export CSV', 'btn.exportMd': 'Export MD',
      'label.search': 'Search title, body or source…', 'empty.list': 'No messages yet. Send one below or call /send.',
      'empty.filter': 'No matching messages. Try another keyword or source filter.',
      'stats.total': 'Total messages', 'stats.today': 'Today', 'stats.sources': 'Sources',
      'stats.channels': 'Delivery', 'stats.rate': 'Success rate', 'stats.sample': 'Based on the latest {n} messages',
      'login.title': 'Access verification', 'login.lead': 'This notification service requires verification. Enter READ_TOKEN to view messages and integration URLs.',
      'login.token': 'Read token', 'login.enter': 'Enter notification center', 'login.err': 'Verification failed',
      'toast.refreshed': 'Refreshed', 'toast.copied': 'Copied', 'toast.exported': 'Export file generated'
    }
  };
  function lang() { try { return localStorage.getItem('cfn_lang') === 'en' ? 'en' : 'zh'; } catch (e) { return 'zh'; } }
  function setLang(v) { try { localStorage.setItem('cfn_lang', v); } catch (e) {} }
  function t(k, vars) {
    var d = D[lang()] || D.zh;
    var s = d[k] != null ? d[k] : (D.zh[k] != null ? D.zh[k] : k);
    if (vars) for (var key in vars) s = s.split('{' + key + '}').join(vars[key]);
    return s;
  }
  function apply(root) {
    var scope = root || document;
    var a = scope.querySelectorAll('[data-i18n]');
    for (var i = 0; i < a.length; i++) a[i].textContent = t(a[i].getAttribute('data-i18n'));
    var b = scope.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < b.length; j++) b[j].setAttribute('placeholder', t(b[j].getAttribute('data-i18n-ph')));
    var c = scope.querySelectorAll('[data-i18n-title]');
    for (var k = 0; k < c.length; k++) c[k].setAttribute('title', t(c[k].getAttribute('data-i18n-title')));
    document.documentElement.lang = lang() === 'en' ? 'en' : 'zh-CN';
  }
  w.I18N = { t: t, apply: apply, lang: lang, setLang: setLang, dict: D };
})(window);
`;

// U4：纯前端轻量高亮器（关键字/字符串/注释/数字四类），无依赖、无外部资源。
const HIGHLIGHT_JS = `
(function (w) {
  'use strict';
  var NL = String.fromCharCode(10);
  var BS = String.fromCharCode(92);
  var KW = {};
  ('curl import from const let var function return await async if else for in of new print run name uses with method headers json body data true false null None True False --data-urlencode pip install').split(' ').forEach(function (k) { KW[k] = 1; });
  function esc(s) {
    s = s.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
    s = s.split('"').join('&quot;').split(String.fromCharCode(39)).join('&#39;');
    return s;
  }
  function wordStart(c) { return /[A-Za-z_$]/.test(c); }
  function wordChar(c) { return /[A-Za-z0-9_$]/.test(c); }
  function highlight(src) {
    var s = String(src || '');
    var out = '';
    var i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '#' || (c === '/' && s.charAt(i + 1) === '/')) {
        var j = i;
        while (j < s.length && s.charAt(j) !== NL) j++;
        out += '<span class="tok-com">' + esc(s.slice(i, j)) + '</span>';
        i = j;
      } else if (c === '"' || c === String.fromCharCode(39)) {
        var q = c;
        var k = i + 1;
        while (k < s.length) {
          if (s.charAt(k) === BS) { k += 2; continue; }
          if (s.charAt(k) === q) { k++; break; }
          k++;
        }
        out += '<span class="tok-str">' + esc(s.slice(i, k)) + '</span>';
        i = k;
      } else if (c >= '0' && c <= '9') {
        var d = i;
        while (d < s.length && /[0-9.]/.test(s.charAt(d))) d++;
        out += '<span class="tok-num">' + esc(s.slice(i, d)) + '</span>';
        i = d;
      } else if (wordStart(c)) {
        var e = i + 1;
        while (e < s.length && wordChar(s.charAt(e))) e++;
        var w = s.slice(i, e);
        out += KW[w] ? '<span class="tok-kw">' + esc(w) + '</span>' : esc(w);
        i = e;
      } else {
        out += esc(c);
        i++;
      }
    }
    return out;
  }
  w.highlightCode = highlight;
})(window);
`;

const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>通知中心 · Cloudflare Notify</title>
<script>(function(){try{var t=localStorage.getItem('cfn_theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<!--@I18N_JS@-->
<!--@HIGHLIGHT_JS@-->
<style>${UI_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="logo">✦</div>
      <div>
        <h1 data-i18n="app.name">通知中心</h1>
        <div class="sub">Cloudflare Notify · <span data-i18n="app.sub">免费、免服务器的消息通知</span></div>
      </div>
    </div>
    <div class="status">
      <span class="dot" id="dot"></span>
      <span id="statusText">正在连接…</span>
      <button class="ghost" id="btnTheme" data-i18n-title="header.theme" title="切换主题">主题</button>
      <button class="ghost" id="btnLang" data-i18n="header.lang" title="切换语言">EN</button>
      <a class="ghost" href="/docs" title="API 文档" data-i18n-title="nav.docs">API 文档</a>
      <button class="ghost" id="btnDiag" style="display:none" data-i18n="header.diag">配置自检</button>
      <button class="ghost" id="btnLogout" style="display:none" data-i18n="header.logout">退出</button>
    </div>
  </header>

  <nav class="quick-nav" id="quickNav">
    <a href="#sec-integration" data-nav="sec-integration" data-i18n="nav.integration">接入</a>
    <a href="#sec-channels" data-nav="sec-channels" data-i18n="nav.channels">渠道</a>
    <a href="#sec-rules" data-nav="sec-rules" data-i18n="nav.rules">规则</a>
    <a href="#sec-key" data-nav="sec-key" data-i18n="nav.keys">密钥</a>
    <a href="#sec-send" data-nav="sec-send" data-i18n="nav.send">发送</a>
    <a href="#sec-list" data-nav="sec-list" data-i18n="nav.list">通知</a>
    <a href="#sec-stats" data-nav="sec-stats" data-i18n="nav.stats">统计</a>
    <a href="/docs" data-nav="docs" data-i18n="nav.docs">API 文档</a>
  </nav>

  <div class="panel">
    <div class="diag-strip" id="diagStrip" hidden>
      <div class="diag-inner" id="diagBody"></div>
    </div>
    <div class="section" id="healthPanel" style="display:none">
      <div class="tool-head"><h2>服务状态</h2><span class="tool-badge" id="healthBadge">检查中</span></div>
      <div class="health-grid" id="healthGrid"></div>
    </div>

    <div class="panel-cols">
      <div class="panel-side">
        <section class="section" id="sec-integration">
          <div class="tool-head">
            <h2 data-i18n="sec.integration">推送接入</h2>
            <span class="tool-badge" data-i18n="badge.ways">9 种方式</span>
          </div>
          <p class="tool-note" data-i18n="note.integration">点标签查看示例，复制后把示例里的密钥换成下方生成的轮换推送密钥即可。</p>
          <div class="intg-tabs" id="intgTabs"></div>
          <div class="intg-card">
            <div class="intg-head">
              <div class="intg-name" id="intgName"></div>
              <button class="ghost intg-copy" id="btnCopyIntg">复制示例</button>
            </div>
            <div class="intg-scene" id="intgScene"></div>
            <div class="code-wrap">
              <div class="code-body">
                <div class="code-ln" id="intgLn"></div>
                <pre class="intg-code" id="intgCode"></pre>
              </div>
              <button class="code-copy" id="btnCodeCopy" type="button" data-i18n="btn.copy">复制</button>
            </div>
            <span class="code-more" id="btnCodeMore" style="display:none"></span>
            <div class="hint" id="intgNote"></div>
          </div>
          <div class="inline-status" id="intgStatus" role="status"></div>
          <div id="scQuick" style="display:none">
            <div class="intg-sep"></div>
            <div class="intg-quick-label">方糖 / Server酱 专用地址（已填好密钥，可直接粘进软件）</div>
            <div class="hint box dashed" id="scUrl"></div>
            <div class="row">
              <button class="ghost" id="btnCopyScUrl">复制推送地址</button>
            </div>
            <div class="hint" id="scHint"></div>
          </div>
        </section>

        <section class="section" id="sec-channels">
          <div class="tool-head">
            <h2 data-i18n="sec.channels">通知渠道</h2>
            <span class="tool-badge" id="channelBadge">读取中</span>
          </div>
          <p class="tool-note" data-i18n="note.channels">企业微信 / 钉钉 / 飞书可同时启用。Webhook 只保存在你自己的 KV，面板展示时自动脱敏。</p>
          <div id="channelList"></div>
          <div class="inline-status" id="channelStatus" role="status"></div>
          <div class="row">
            <button class="primary" id="btnSaveChannels">保存渠道配置</button>
          </div>
          <div class="hint" id="channelHint">保存需要管理主密钥 SEND_TOKEN。</div>
        </section>

        <section class="section" id="sec-rules">
          <div class="tool-head">
            <h2 data-i18n="sec.rules">规则与模板</h2>
            <span class="tool-badge" id="ruleBadge" data-i18n="badge.optional">可选</span>
          </div>
          <p class="tool-note" data-i18n="note.rules">静默时段内的消息仍会存入通知中心，只是不推送到外部渠道。</p>
          <label><input type="checkbox" id="fQuietEnabled" style="width:auto;margin-right:6px" />启用静默时段</label>
          <div class="row" style="margin-top:8px">
            <input type="time" id="fQuietStart" value="23:00" style="flex:1" />
            <input type="time" id="fQuietEnd" value="07:00" style="flex:1" />
          </div>
          <label for="fTemplates">通知模板（JSON）</label>
          <textarea id="fTemplates" style="min-height:76px;font-size:11px" placeholder='{"deploy":{"title":"{title}","content":"{content}"}}'></textarea>
          <div class="row">
            <button class="primary" id="btnSaveRules">保存规则</button>
            <button class="ghost" id="btnPreviewVars">预览变量</button>
          </div>
          <div class="inline-status" id="ruleStatus" role="status"></div>
          <div class="hint box" id="varPreview" style="display:none"></div>
        </section>

        <section class="section" id="sec-key">
          <div class="tool-head">
            <h2 data-i18n="sec.keys">密钥与轮换</h2>
            <span class="tool-badge" id="keyBadge">读取中</span>
          </div>
          <p class="tool-note" data-i18n="note.keys">软件里只填轮换推送密钥；SEND_TOKEN 是管理主密钥，仅用于下方操作，不要填进软件。</p>
          <label for="fMasterToken">管理主密钥 SEND_TOKEN</label>
          <input id="fMasterToken" type="password" placeholder="仅用于生成 / 查看轮换密钥" autocomplete="off" />
          <label class="switch remember-master"><input type="checkbox" id="chkRememberMaster" /><span data-i18n="label.rememberMaster">记住主密钥（仅存本机浏览器）</span></label>
          <div class="hint" id="masterSaveHint"></div>
          <div class="row" id="forgetMasterRow" style="display:none">
            <button class="ghost danger" id="btnForgetMaster" data-i18n="btn.forgetMaster">清除已保存的主密钥</button>
          </div>
          <div class="hint" id="keyStatus">正在读取轮换密钥状态…</div>
          <div class="row">
            <button class="ghost" id="btnViewKey">查看当前密钥</button>
            <button class="primary" id="btnRotateKey">生成新密钥</button>
          </div>
          <div class="inline-status" id="keyFeedback" role="status"></div>
          <div class="hint box ok key-box" id="rotatedKeyBox" style="display:none"></div>
          <div class="hint" id="rotateHint"></div>
        </section>

        <section class="section" id="sec-send">
          <div class="tool-head">
            <h2 data-i18n="sec.send">发送测试通知</h2>
            <span class="tool-badge" id="wecomBadge">企微 —</span>
            <span class="tool-badge" id="sendChannelsBadge">渠道 —</span>
          </div>
          <p class="tool-note" data-i18n="note.send">先填标题或内容，点「发送通知」验证链路；密钥可留空以使用浏览器保存值。</p>
          <label for="fTitle">标题</label>
          <input id="fTitle" placeholder="例如：构建完成" autocomplete="off" />
          <label for="fContent">内容</label>
          <textarea id="fContent" placeholder="支持 {date} 等变量模板，留空亦可发送"></textarea>
          <label for="fSendToken">发送密钥（SEND_TOKEN 或轮换密钥）</label>
          <input id="fSendToken" type="password" placeholder="留空则使用已保存的密钥" autocomplete="off" />
          <div class="hint" id="sendHint"></div>
          <div class="row">
            <button class="primary" id="btnSend">发送通知</button>
            <button class="ghost" id="btnCopyCurl">复制 curl</button>
            <button class="ghost" id="btnTestWecom" data-i18n="btn.testWecom">测试企微</button>
            <button class="ghost" id="btnTestDingtalk" data-i18n="btn.testDingtalk">测试钉钉</button>
            <button class="ghost" id="btnTestFeishu" data-i18n="btn.testFeishu">测试飞书</button>
          </div>
          <div class="inline-status" id="sendFeedback" role="status"></div>
          <div class="hint" id="wecomHint"></div>
          <div class="hint box" id="curlBox" style="display:none"></div>
        </section>
      </div>

      <div class="panel-main">
        <section class="section" id="sec-stats">
          <div class="tool-head">
            <h2 data-i18n="sec.stats">统计看板</h2>
            <span class="tool-badge" id="statsBadge">读取中</span>
          </div>
          <div class="stats-grid" id="statsCards"><div class="stat-card"><div class="v">—</div><div class="k">加载中…</div></div></div>
          <div class="stat-block"><h3 data-i18n="stats.sources">来源分布</h3><div id="statsSources"></div></div>
          <div class="stat-block"><h3 data-i18n="stats.channels">渠道投递</h3><div id="statsChannels"></div></div>
          <div class="stat-block"><h3>近 14 天 / UTC+8</h3><div class="stat-bars" id="statsDaily"></div><div class="hint" id="statsNote"></div></div>
        </section>

        <section class="section" id="sec-list">
          <div class="list-head">
            <h2 data-i18n="sec.list">最近通知</h2>
            <div class="list-actions">
              <span class="count" id="count"></span>
              <button class="ghost toggle-all" id="btnToggleAll" data-i18n="btn.toggleAll">全部展开</button>
              <button class="ghost" id="btnRefresh" data-i18n="btn.refresh">刷新</button>
              <button class="ghost danger" id="btnClear" data-i18n="btn.clear">清空</button>
              <button class="ghost" id="btnExportJson" data-i18n="btn.exportJson">导出 JSON</button>
              <button class="ghost" id="btnExportCsv" data-i18n="btn.exportCsv">导出 CSV</button>
              <button class="ghost" id="btnExportMd" data-i18n="btn.exportMd">导出 MD</button>
            </div>
          </div>
          <div class="list-head" style="margin-bottom:6px">
            <div class="search-box"><input id="fSearch" type="search" data-i18n-ph="label.search" placeholder="搜索标题、内容或来源…" autocomplete="off" /></div>
          </div>
          <div class="chips" id="sourceChips"></div>
          <div class="hint" style="margin:0 0 12px" data-i18n="note.list">折叠时显示标题与内容摘要，点击标题行展开全文；支持按来源过滤与按时间分组。</div>
          <div id="list">
            <div class="empty"><div class="icon">◇</div><p>加载中…</p></div>
          </div>
        </section>
      </div>
    </div>
  </div>
</div>

<div class="overlay hidden" id="loginOverlay">
  <div class="login-box">
    <h2>会话已失效</h2>
    <p class="sec-desc">为安全起见，页面中的密钥与推送地址已清空。请重新验证以继续。</p>
    <label for="loginToken">查看密钥（READ_TOKEN）</label>
    <input id="loginToken" type="password" placeholder="READ_TOKEN" autocomplete="current-password" />
    <!--@TS_WIDGET@-->
    <div class="row">
      <button class="primary" id="btnLogin">重新验证</button>
    </div>
    <div class="auth-err" id="loginErr"></div>
  </div>
</div>

<div class="overlay hidden" id="confirmOverlay">
  <div class="confirm-box">
    <h3 id="confirmTitle">确认操作</h3>
    <p id="confirmText"></p>
    <div class="row">
      <button class="ghost" id="btnConfirmCancel">取消</button>
      <button class="danger" id="btnConfirmOk">确认</button>
    </div>
  </div>
</div>

<div class="bottom-bar">
  <button id="btnMobileRefresh">刷新</button>
  <button id="btnMobileToggle">展开全部</button>
  <button id="btnMobileTop">回到顶部</button>
</div>

<div class="toast" id="toast"></div>

<!--@TS_SCRIPTS@-->
<script>
(function () {
  'use strict';

  var T = window.I18N ? window.I18N.t : function (k) { return k; };
  if (window.I18N) window.I18N.apply();

  var REFRESH_MS = 5000;
  var state = {
    status: null,
    sendToken: localStorage.getItem('cfn_send_token') || '',
    rotatingKey: '',
    messages: [],
    expanded: {},
    allExpanded: false,
    version: '',
    timer: null,
    idlePolls: 0,
    search: '',
    sourceFilter: 'all',
    channels: [],
    settings: null,
    templates: {},
    deliveries: {},
    adminMode: false
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

  // 自定义确认弹窗（E6）：替代原生 confirm，风格与主界面一致。
  function confirmAction(title, text, onOk) {
    $('confirmTitle').textContent = title || '确认操作';
    $('confirmText').textContent = text || '';
    $('confirmOverlay').classList.remove('hidden');
    function cleanup() {
      $('confirmOverlay').classList.add('hidden');
      $('btnConfirmOk').onclick = null;
      $('btnConfirmCancel').onclick = null;
    }
    $('btnConfirmOk').onclick = function () { cleanup(); onOk(); };
    $('btnConfirmCancel').onclick = cleanup;
  }

  // v2.2：主密钥保存是本机的显式选择，仅在用户勾选时写入 localStorage；
  // 不进 URL、不进日志、不随导出文件下载。公共设备可一键清除。
  var MASTER_KEY_STORAGE = 'cfn_master_token';
  function masterToken() {
    return $('fMasterToken') ? $('fMasterToken').value.trim() : '';
  }
  function savedMaster() {
    try { return localStorage.getItem(MASTER_KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  function updateMasterSaveUi() {
    var saved = savedMaster();
    var chk = $('chkRememberMaster');
    if (!chk) return;
    chk.checked = Boolean(saved);
    var row = $('forgetMasterRow');
    if (row) row.style.display = saved ? 'flex' : 'none';
    var hint = $('masterSaveHint');
    if (hint) hint.textContent = T(saved ? 'hint.masterSaved' : 'hint.masterUnsaved');
    var forget = $('btnForgetMaster');
    if (forget) forget.textContent = T('btn.forgetMaster');
  }
  function persistMaster() {
    var v = masterToken();
    var remember = $('chkRememberMaster') && $('chkRememberMaster').checked;
    try {
      if (v && remember) localStorage.setItem(MASTER_KEY_STORAGE, v);
      else localStorage.removeItem(MASTER_KEY_STORAGE);
    } catch (e) { /* 隐私模式下 localStorage 不可用时静默降级为不保存 */ }
    updateMasterSaveUi();
  }
  (function restoreMaster() {
    var saved = savedMaster();
    if (saved && $('fMasterToken') && !$('fMasterToken').value) $('fMasterToken').value = saved;
    updateMasterSaveUi();
  })();

  // 推送接入示例目录：所有端点与字段别名均与 worker.js 服务端实现一致。
  // 生成时用 location.origin 与当前轮换密钥，避免写死域名/密钥。
  var INTEGRATIONS = [
    {
      id: 'urlget', label: 'URL 直发',
      name: '浏览器 / 快捷指令：URL 直发（GET）',
      scene: '适用：地址栏、iOS 快捷指令、只支持 GET 的 Webhook、简单脚本。',
      note: 'title/text、content/desp 都是等价字段别名；type 可填 text 或 markdown。密钥写在 URL 会进历史与日志，仅建议可信环境使用。',
      code: function (o, k) { return o + '/send?token=' + k + '&title=构建完成&content=耗时%2023s&source=ci'; }
    },
    {
      id: 'json', label: 'JSON API',
      name: '程序调用：JSON API（POST，推荐）',
      scene: '适用：Node.js / Python / Go / 任意能发 HTTP 的服务端程序。密钥走 Header，不进 URL。',
      note: 'Body 支持 title/text、content/desp/body、type、source；返回 { ok:true, code:0, errno:0 }。Header 传参推荐 X-Token 或 Authorization: Bearer。',
      code: function (o, k) {
        return 'curl -X POST "' + o + '/api/send" \\\n' +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "X-Token: ' + k + '" \\\n' +
          '  -d \\'{"title":"构建完成","content":"耗时 23s"}\\'';
      }
    },
    {
      id: 'form', label: '表单 API',
      name: '表单提交：Form API（POST）',
      scene: '适用：curl、HTML 表单、curl 类工具、不擅长拼 JSON 的脚本。',
      note: '服务端按 Content-Type 自动解析 application/x-www-form-urlencoded 与 multipart/form-data；密钥同样可放 Header。',
      code: function (o, k) {
        return 'curl -X POST "' + o + '/api/send" \\\n' +
          '  -H "X-Token: ' + k + '" \\\n' +
          '  --data-urlencode "title=构建完成" \\\n' +
          '  --data-urlencode "content=耗时 23s"';
      }
    },
    {
      id: 'serverchan', label: '方糖/Server酱',
      name: '软件集成：方糖 / Server酱 兼容端点',
      scene: '适用：只支持 sc.ftqq.com 格式、但允许自定义域名/服务器地址的软件。把 key 放在路径里。',
      note: 'GET 用 text/title 作标题、desp/content 作正文；POST 用表单。返回同时带 errno（方糖）与 code（Server酱³）双码。写死 sc.ftqq.com 的软件无法迁移。',
      code: function (o, k) {
        return o + '/' + encodeURIComponent(k) + '.send?text=构建完成&desp=耗时%2023s';
      }
    },
    {
      id: 'python', label: 'Python',
      name: '脚本：Python 示例',
      scene: '适用：运维脚本、备份任务、数据采集后推送。用 requests 或标准库 urllib。',
      note: '用 Header 传 token，避免密钥进入 URL。requests 未安装时可用 urllib.request 替代。',
      code: function (o, k) {
        return '# pip install requests\\n' +
          'import requests\\n\\n' +
          'r = requests.post(\\n' +
          '    "' + o + '/api/send",\\n' +
          '    headers={"X-Token": "' + k + '", "Content-Type": "application/json"},\\n' +
          '    json={"title": "构建完成", "content": "耗时 23s"},\\n' +
          ')\\n' +
          'print(r.status_code, r.json())';
      }
    },
    {
      id: 'node', label: 'Node.js',
      name: '脚本：Node.js 示例',
      scene: '适用：Node 服务、npm 脚本、Serverless 函数中调用。无需额外依赖，用内置 fetch。',
      note: 'Node 18+ 内置 fetch；更低版本可用 node-fetch 或 https 模块。',
      code: function (o, k) {
        return 'const r = await fetch("' + o + '/api/send", {\\n' +
          '  method: "POST",\\n' +
          '  headers: { "Content-Type": "application/json", "X-Token": "' + k + '" },\\n' +
          '  body: JSON.stringify({ title: "构建完成", content: "耗时 23s" }),\\n' +
          '});\\n' +
          'console.log(r.status, await r.json());';
      }
    },
    {
      id: 'ci', label: 'CI / 定时',
      name: 'CI 与定时任务：GitHub Actions / crontab',
      scene: '适用：构建完成、部署成功、备份结果、定时巡检推送到企业微信。',
      note: 'CI 里把密钥存进 Secrets，不要写死在 YAML；crontab 里用 % 需转义。两种写法都调用同一个 /send 端点。',
      code: function (o, k) {
        return '# GitHub Actions（把密钥放进 Secrets.SEND_TOKEN）\\n' +
          '- name: 发送通知\\n' +
          '  run: |\\n' +
          '    curl -sG "' + o + '/send" \\\n' +
          '      --data-urlencode "token=\${{ secrets.SEND_TOKEN }}" \\\n' +
          '      --data-urlencode "title=构建完成" \\\n' +
          '      --data-urlencode "content=分支已部署"\\n\\n' +
          '# Linux crontab：每 5 分钟推送一次\\n' +
          '*/5 * * * * curl -sG "' + o + '/send" --data-urlencode "token=' + k + '" \\\n' +
          '  --data-urlencode "title=定时巡检" --data-urlencode "content=服务正常"';
      }
    },
    {
      id: 'routerhook', label: 'RouterHook',
      name: '路由器：RouterHook 事件推送',
      scene: '适用：RouterHook 插件的 manuINFO / cronINFO / ifUP / newDHCP 与 rh_* 传感器事件。',
      note: '响应体含 success 字符串，RouterHook 据此判定成功；rh_* 传感器经 Durable Object 按设备聚合（默认 60 秒窗口），企业微信只收汇总不刷屏。多路由器用 ?device= 区分。详见 docs/ROUTERHOOK.md。',
      code: function (o, k) {
        return 'curl -X POST "' + o + '/api/routerhook/manuINFO?device=RAX50" \\\n' +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "X-Token: ' + k + '" \\\n' +
          '  -d \\'{"msgTYPE":"manuINFO","desc":"WAN 重拨完成"}\\'';
      }
    },
    {
      id: 'vars', label: '变量模板',
      name: '动态变量：内置 + 自定义',
      scene: '适用：定时巡检、CI 构建、或想让软件把标题/正文动态填入模板的场景。',
      note: '内置变量由服务端按 GMT+8 自动生成：date/time/datetime/timestamp/timestamp_ms/weekday/uuid/random/version/source；自定义变量用 v.名称=值（或 JSON body 的 v 对象）提供，同名时覆盖内置。未匹配占位符原样保留，替换值不再二次解析；空格与中文请做 URL 编码。',
      code: function (o, k) {
        return o + '/send?token=' + k + '&title={title}&content={date}%20{time}&source=ci&v.title=Build%20Done\\n' +
          '\\n' +
          '# 只用内置变量（无需 v.* 参数）：\\n' +
          o + '/send?token=' + k + '&title=check&content={datetime}%20OK';
      }
    }
  ];

  var stateIntg = 'urlget';
  var stateCodeExpanded = false;

  function currentKey() {
    return state.rotatingKey || $('fSendToken').value.trim() || state.sendToken || '<你的密钥>';
  }

  function renderIntegrations() {
    var tabs = $('intgTabs');
    if (!tabs.childNodes.length) {
      var html = '';
      for (var i = 0; i < INTEGRATIONS.length; i++) {
        html += '<button type="button" class="intg-tab' + (INTEGRATIONS[i].id === stateIntg ? ' active' : '') +
          '" data-intg="' + INTEGRATIONS[i].id + '">' + esc(INTEGRATIONS[i].label) + '</button>';
      }
      tabs.innerHTML = html;
      tabs.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('.intg-tab');
        if (!btn) return;
        stateIntg = btn.getAttribute('data-intg');
        renderIntegrations();
      });
    }
    Array.prototype.forEach.call(tabs.childNodes, function (b) {
      b.className = 'intg-tab' + (b.getAttribute('data-intg') === stateIntg ? ' active' : '');
    });
    var item = currentIntg();
    $('intgName').textContent = item.name;
    $('intgScene').textContent = item.scene;
    $('intgNote').textContent = item.note;
    // U4：展示时脱敏密钥、纯正则高亮、行号与长代码折叠；完整值只放在 dataset 供复制。
    var fullCode = item.code(location.origin, currentKey());
    var key = currentKey();
    var shownCode = fullCode;
    if (key && key !== '<你的密钥>' && key.length > 4) {
      var masked = key.charAt(0) + '********' + key.charAt(key.length - 1);
      shownCode = fullCode.split(key).join(masked);
    }
    var allLines = shownCode.split(String.fromCharCode(10));
    var collapsed = allLines.length > 14 && !stateCodeExpanded;
    var viewLines = collapsed ? allLines.slice(0, 14) : allLines;
    var pre = $('intgCode');
    pre.innerHTML = window.highlightCode ? window.highlightCode(viewLines.join(String.fromCharCode(10))) : esc(viewLines.join(String.fromCharCode(10)));
    pre.dataset.full = fullCode;
    $('intgLn').innerHTML = viewLines.map(function (_, i) { return String(i + 1); }).join(String.fromCharCode(10));
    var more = $('btnCodeMore');
    more.style.display = allLines.length > 14 ? 'inline-block' : 'none';
    more.textContent = collapsed ? '展开全部（' + allLines.length + ' 行）' : '收起代码';
    // 方糖专用地址只在对应标签下显示，避免与其他标签的示例重复占位
    $('scQuick').style.display = stateIntg === 'serverchan' ? '' : 'none';
    if (stateIntg === 'serverchan') renderServerchanUrl();
    var hasKey = Boolean(currentKey() && currentKey() !== '<你的密钥>');
    setInline('intgStatus', 'info', hasKey
      ? '示例已自动填入当前密钥；复制即可用，密钥不会上传到第三方。'
      : '示例中的密钥为占位符。到「密钥与轮换」生成轮换密钥后会自动替换。');
  }

  function setStatus(kind, text) {
    $('dot').className = 'dot' + (kind ? ' ' + kind : '');
    $('statusText').textContent = text;
  }

  // 模块内行内反馈：成功/失败留在原地，不再只靠一闪而过的 toast。
  // 文本一律用 textContent 写入，避免把用户内容当作 HTML 解析。
  function setInline(id, kind, text) {
    var el = $(id);
    if (!el) return;
    el.className = 'inline-status' + (kind ? ' ' + kind : '') + (text ? ' show' : '');
    el.textContent = '';
    if (!text) return;
    var mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = kind === 'err' ? '✕' : kind === 'ok' ? '✓' : 'i';
    var msg = document.createElement('span');
    msg.textContent = text;
    el.appendChild(mark);
    el.appendChild(msg);
  }

  function friendlyAuthError(err) {
    var m = String((err && err.message) || err || '请求失败');
    if (m === 'unauthorized' || m === 'invalid token' || m.indexOf('401') >= 0) {
      return '密钥不正确，请核对后重试（管理主密钥为 SEND_TOKEN）。';
    }
    return m;
  }

  function currentIntg() {
    for (var i = 0; i < INTEGRATIONS.length; i++) {
      if (INTEGRATIONS[i].id === stateIntg) return INTEGRATIONS[i];
    }
    return INTEGRATIONS[0];
  }

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
      credentials: 'same-origin'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) {
          requireReauth();
          throw new Error('unauthorized');
        }
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
      });
    });
  }

  // 会话失效：立刻抹掉页面里已渲染的敏感信息，再要求重新验证
  function wipeSensitive() {
    state.rotatingKey = '';
    var sc = $('scUrl');
    if (sc) { sc.textContent = ''; sc.dataset.url = ''; }
    var rk = $('rotatedKeyBox');
    if (rk) { rk.textContent = ''; rk.dataset.key = ''; rk.style.display = 'none'; }
    var sh = $('scHint');
    if (sh) sh.textContent = '';
    var intgCode = $('intgCode');
    if (intgCode) intgCode.textContent = '';
  }

  function requireReauth() {
    clearInterval(state.timer);
    wipeSensitive();
    $('loginOverlay').classList.remove('hidden');
    $('btnLogout').style.display = 'none';
    setStatus('error', '需要重新验证');
    // 弹层此刻才可见 → 此时挂载 Turnstile 组件（不可见容器渲染出的 iframe 尺寸为 0）
    if (window.TS && window.TS.enabled()) window.TS.start();
  }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (e) { return String(ts); }
  }

  function previewOf(content) {
    var s = String(content || '').replace(/\\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
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
      ['人机验证 TURNSTILE', d.turnstileEnabled || !d.turnstileMisconfigured,
        d.turnstileEnabled ? '已启用，登录需完成人机验证'
          : (d.turnstileMisconfigured ? '配置不完整：TURNSTILE_SITE_KEY 与 TURNSTILE_SECRET_KEY 必须同时设置'
                                       : '未启用（可选）')],    ];
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
    $('btnDiag').style.display = 'inline-block';
    if (!allOk) $('diagStrip').hidden = false;
    $('btnDiag').addEventListener('click', function () {
      $('diagStrip').hidden = !$('diagStrip').hidden;
    });
    renderHealth(s, allOk);
  }

  // 常驻服务状态小组件（U6）：默认展开，异常项用红色标识。
  function renderHealth(s, allOk) {
    if (!s || !s.diagnostics) return;
    var d = s.diagnostics;
    var readyChannels = (s.channels || []).filter(function (c) { return c.configured && c.enabled; }).length;
    var fails = d.delivery ? Number(d.delivery.consecutiveFailures || 0) : 0;
    var items = [
      ['Worker 服务', true],
      ['KV 存储', Boolean(d.kvOk)],
      ['推送渠道', readyChannels > 0],
      ['发送密钥', Boolean(d.sendTokenSet)],
      ['最近投递', fails < 3],
      ['安全配置', Boolean(d.sendTokenSet || d.readTokenSet)],
    ];
    var good = 0;
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var ok = Boolean(items[i][1]);
      if (ok) good++;
      html += '<div class="health-item' + (ok ? '' : ' bad') + '">' +
        '<span class="flag">' + (ok ? '✓' : '✕') + '</span><span>' + esc(items[i][0]) + '</span></div>';
    }
    $('healthGrid').innerHTML = html;
    $('healthBadge').textContent = good + '/' + items.length + ' 正常';
    $('healthBadge').className = 'tool-badge' + (good === items.length ? ' on' : '');
    $('healthPanel').style.display = '';
  }

  function renderServerchanUrl() {
    // 优先用轮换密钥（更安全），其次用户手填的密钥，最后浏览器保存的 SEND_TOKEN
    var token = state.rotatingKey || $('fSendToken').value.trim() || state.sendToken;
    var box = $('scUrl');
    if (!token) {
      box.textContent = '尚未取得密钥：先在「密钥与轮换」生成，或在下方填入发送密钥。';
      box.dataset.url = '';
      $('scHint').textContent = '轮换密钥可在泄露后一键作废，不要填 SEND_TOKEN。';
      return;
    }
    var url = location.origin + '/' + encodeURIComponent(token) + '.send?text=标题&desp=正文';
    box.textContent = url;
    box.dataset.url = url;
    $('scHint').textContent = '仅支持填「自定义 Webhook / 服务器地址」的软件；写死 sc.ftqq.com 的无法迁移。';
  }

  function renderKeyStatus(s) {
    $('keyStatus').textContent = s.rotatingKeyReady
      ? '轮换密钥已就绪' + (s.rotatedAt ? ' · ' + fmtTime(s.rotatedAt) + ' 更新' : '') + '。'
      : '尚未生成轮换密钥：填入 SEND_TOKEN 后点「生成新密钥」。';
    var badge = $('keyBadge');
    badge.textContent = s.rotatingKeyReady ? '已就绪' : '未生成';
    badge.className = 'tool-badge' + (s.rotatingKeyReady ? ' on' : '');
  }

  function sourceChips() {
    var counts = {};
    for (var i = 0; i < state.messages.length; i++) {
      var s = String(state.messages[i].source || 'api');
      counts[s] = (counts[s] || 0) + 1;
    }
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 8);
    var html = '<button type="button" class="chip' + (state.sourceFilter === 'all' ? ' active' : '') +
      '" data-source="all">全部 ' + state.messages.length + '</button>';
    for (var j = 0; j < keys.length; j++) {
      html += '<button type="button" class="chip' + (state.sourceFilter === keys[j] ? ' active' : '') +
        '" data-source="' + esc(keys[j]) + '">' + esc(keys[j]) + ' ' + counts[keys[j]] + '</button>';
    }
    $('sourceChips').innerHTML = html;
  }

  function dayLabel(ts) {
    var d = new Date(ts);
    var today = new Date();
    var yest = new Date(Date.now() - 86400000);
    var same = function (a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    };
    if (same(d, today)) return '今天';
    if (same(d, yest)) return '昨天';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function visibleMessages() {
    var q = String(state.search || '').trim().toLowerCase();
    var out = [];
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (state.sourceFilter !== 'all' && String(m.source || 'api') !== state.sourceFilter) continue;
      if (q) {
        var hay = String(m.title || '') + ' ' + String(m.content || '') + ' ' + String(m.source || '');
        if (hay.toLowerCase().indexOf(q) < 0) continue;
      }
      out.push(m);
    }
    return out;
  }

  function deliveryHtml(id) {
    var rows = (state.deliveries && state.deliveries[id]) || [];
    if (!rows.length) return '';
    var html = '<div class="delivery-line">投递：';
    for (var i = 0; i < rows.length; i++) {
      var label = { wecom: '企微', dingtalk: '钉钉', feishu: '飞书' }[rows[i].channel] || rows[i].channel;
      html += '<span class="' + (rows[i].ok ? 'ok' : 'bad') + '">' + esc(label) + (rows[i].ok ? ' ✓' : ' ✕') + '</span> ';
    }
    return html + '</div>';
  }

  function render() {
    var box = $('list');
    var list = visibleMessages();
    $('count').textContent = list.length + (list.length === state.messages.length ? '' : ' / ' + state.messages.length) + ' 条';
    sourceChips();

    if (!list.length) {
      box.innerHTML = '<div class="empty"><div class="icon">◇</div>' +
        '<p>' + (state.messages.length ? '没有匹配的通知，试试调整搜索词或来源过滤。' : '暂无通知。用左侧表单发送一条，或调用 /send 接口。') + '</p></div>';
      return;
    }

    var html = '';
    var lastDay = '';
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var id = String(m.id || i);
      var day = dayLabel(m.timestamp);
      if (day !== lastDay) {
        html += '<div class="day-group">' + esc(day) + '</div>';
        lastDay = day;
      }
      var open = state.allExpanded || Boolean(state.expanded[id]);
      html += '<div class="msg' + (open ? ' open' : '') + '" data-id="' + esc(id) + '">' +
        '<div class="msg-head" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="msg-chevron">▶</span>' +
        '<div class="msg-main">' +
        '<div class="msg-row">' +
        '<span class="m-title">' + esc(m.title || '（无标题）') + '</span>' +
        (m.source ? '<span class="m-source">' + esc(m.source) + '</span>' : '') +
        '<span class="m-time">' + esc(fmtTime(m.timestamp)) + '</span>' +
        '</div>' +
        '<div class="m-preview">' + esc(m.previewText != null ? m.previewText : previewOf(m.content)) + '</div>' +
        '</div>' +
        '<span class="m-hint">展开</span>' +
        '</div>' +
        '<div class="msg-detail">' +
        // 富文本：服务端已按白名单消毒（contentHtml），这里不再二次转义；
        // 旧数据/旧接口无该字段时降级为纯文本转义，展示不劣化。
        (m.content ? '<div class="m-body ' + (m.isRich ? 'rich' : 'text') + '">' +
          (m.contentHtml || esc(m.content)) + '</div>' : '') +
        deliveryHtml(id) +
        '<div class="m-meta">来源：' + esc(m.source || 'api') + ' · ID：' + esc(id) + '</div>' +
        '<div class="msg-actions">' +
        '<button type="button" class="ghost" data-act="copy" data-id="' + esc(id) + '">复制内容</button>' +
        '<button type="button" class="ghost" data-act="resend" data-id="' + esc(id) + '">重新推送</button>' +
        '<button type="button" class="ghost danger" data-act="delete" data-id="' + esc(id) + '">删除</button>' +
        '</div>' +
        '</div></div>';
    }
    box.innerHTML = html;
    $('btnToggleAll').textContent = state.allExpanded ? '全部折叠' : '全部展开';
    var mobileToggle = $('btnMobileToggle');
    if (mobileToggle) mobileToggle.textContent = state.allExpanded ? '折叠全部' : '展开全部';
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
        if (data.deliveries) state.deliveries = data.deliveries;
        state.idlePolls = 0;
        render();
      }
      setStatus('live', '已连接 · ' + fmtTime(Date.now()) + ' 更新');
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
      setStatus('error', '连接失败：' + err.message);
    });
  }

  // ---------- v2.1：L4 统计看板 / L1 消息导出 ----------
  function loadStats() {
    return api('/api/stats').then(function (s) {
      if (!s || !s.ok) return;
      var badge = $('statsBadge');
      badge.textContent = s.total + ' 条';
      badge.className = 'tool-badge' + (s.total ? ' on' : '');
      var NL = String.fromCharCode(10);
      var maxDay = 1;
      for (var i = 0; i < s.daily.length; i++) maxDay = Math.max(maxDay, s.daily[i].count);
      $('statsCards').innerHTML =
        '<div class="stat-card"><div class="v">' + s.total + '</div><div class="k">' + esc(T('stats.total')) + '</div></div>' +
        '<div class="stat-card"><div class="v">' + (s.daily.length ? s.daily[s.daily.length - 1].count : 0) + '</div><div class="k">' + esc(T('stats.today')) + '</div></div>' +
        '<div class="stat-card"><div class="v">' + s.sources.length + '</div><div class="k">' + esc(T('stats.sources')) + '</div></div>' +
        '<div class="stat-card"><div class="v">' + s.channels.filter(function (c) { return c.ok + c.fail > 0; }).length + '</div><div class="k">' + esc(T('stats.channels')) + '</div></div>';
      var smax = 1;
      for (var j = 0; j < s.sources.length; j++) smax = Math.max(smax, s.sources[j].count);
      $('statsSources').innerHTML = s.sources.length
        ? s.sources.map(function (x) {
            return '<div class="stat-row"><span class="n">' + esc(x.name) + '</span>' +
              '<span class="track"><span class="fill" style="width:' + Math.round(x.count * 100 / smax) + '%"></span></span>' +
              '<span class="c">' + x.count + '</span></div>';
          }).join('')
        : '<div class="hint">—</div>';
      $('statsChannels').innerHTML = s.channels.map(function (c) {
        return '<div class="stat-row"><span class="n">' + esc(c.name) + '</span>' +
          '<span class="track"><span class="fill" style="width:' + (c.rate == null ? 0 : c.rate) + '%"></span></span>' +
          '<span class="c">' + (c.rate == null ? '—' : c.rate + '%') + '</span></div>';
      }).join('');
      $('statsDaily').innerHTML = s.daily.map(function (d) {
        var h = Math.max(2, Math.round(d.count * 66 / maxDay));
        return '<span class="stat-bar" style="height:' + h + 'px" title="' + esc(d.date) + ': ' + d.count + '"></span>';
      }).join('');
      $('statsNote').textContent = T('stats.sample', { n: s.sampled }) + (s.truncated ? '（仅最近 500 条）' : '');
    }).catch(function () {
      $('statsBadge').textContent = '—';
    });
  }

  function exportMessages(format) {
    var list = visibleMessages();
    var NL = String.fromCharCode(10);
    var stamp = new Date().toISOString().slice(0, 10);
    var text;
    var mime;
    var ext;
    var cell = function (v) {
      var s = String(v == null ? '' : v);
      var first = s.charAt(0);
      if (first === '=' || first === '+' || first === '-' || first === '@' ||
          first === String.fromCharCode(9) || first === String.fromCharCode(13)) s = "'" + s;
      return '"' + s.split('"').join('""') + '"';
    };
    if (format === 'csv') {
      var lines = ['id,title,content,type,source,timestamp,time,deliveries'];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        var ds = (state.deliveries && state.deliveries[m.id]) || [];
        lines.push([m.id, m.title, m.content, m.type, m.source, m.timestamp,
          new Date(Number(m.timestamp)).toISOString(),
          ds.map(function (d) { return d.channel + ':' + (d.ok ? 'ok' : 'fail'); }).join('|')].map(cell).join(','));
      }
      text = String.fromCharCode(65279) + lines.join(String.fromCharCode(13) + NL);
      mime = 'text/csv;charset=utf-8';
      ext = 'csv';
    } else if (format === 'md') {
      var out = ['# 通知导出', '', '数量：' + list.length, ''];
      for (var k = 0; k < list.length; k++) {
        var x = list[k];
        out.push('## ' + (x.title || '（无标题）'), '',
          '- 时间：' + new Date(Number(x.timestamp)).toISOString(),
          '- 来源：' + (x.source || 'api'), '- ID：' + String(x.id), '', String(x.content || ''), '');
      }
      text = out.join(NL);
      mime = 'text/markdown;charset=utf-8';
      ext = 'md';
    } else {
      text = JSON.stringify({
        version: (state.status && state.status.version) || '', exportedAt: new Date().toISOString(),
        count: list.length,
        messages: list.map(function (m) {
          return { id: m.id, title: m.title, content: m.content, type: m.type, source: m.source,
            timestamp: m.timestamp, time: new Date(Number(m.timestamp)).toISOString(),
            deliveries: (state.deliveries && state.deliveries[m.id]) || [] };
        }),
      }, null, 2);
      mime = 'application/json;charset=utf-8';
      ext = 'json';
    }
    var blob = new Blob([text], { type: mime });
    var href = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = href;
    a.download = 'notify-' + stamp + '.' + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
    toast(T('toast.exported'));
  }

  ['json', 'csv', 'md'].forEach(function (fmt) {
    var btn = $('btnExport' + fmt.charAt(0).toUpperCase() + fmt.slice(1));
    if (btn) btn.addEventListener('click', function () { exportMessages(fmt); });
  });

  function init() {
    fetch('/api/status', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { requireReauth(); throw new Error('unauthorized'); }
      return r.json();
    }).then(function (s) {
      state.status = s;
      $('btnLogout').style.display = 'inline-block';
      $('sendHint').textContent = s.needSendToken
        ? '服务端要求发送密钥：填入 SEND_TOKEN 或轮换密钥。'
        : '服务端未要求发送密钥，可直接发送。';
      var cfgOf = function (id) {
        return (s.channels || []).find(function (c) { return c.id === id; }) || null;
      };
      var wecomCfg = cfgOf('wecom');
      var wecomReady = Boolean(s.wecomConfigured || (wecomCfg && wecomCfg.configured));
      $('wecomHint').textContent = wecomReady
        ? '新消息会同步推到企业微信群。'
        : '未配置 WECOM_WEBHOOK，可在 Worker Secrets 或渠道面板中设置后开启推送。';
      var wb = $('wecomBadge');
      wb.textContent = wecomReady ? '企微已开启' : '企微未配置';
      wb.className = 'tool-badge' + (wecomReady ? ' on' : '');
      // v2.2：三个渠道的测试按钮按各自配置状态独立启用，不再依赖企微 Webhook。
      var ids = [
        ['btnTestWecom', 'wecom', '企业微信'],
        ['btnTestDingtalk', 'dingtalk', '钉钉'],
        ['btnTestFeishu', 'feishu', '飞书'],
      ];
      var ready = 0;
      ids.forEach(function (item) {
        var btn = $(item[0]);
        if (!btn) return;
        var c = cfgOf(item[1]);
        var on = Boolean(c && c.configured);
        if (on) ready++;
        btn.disabled = !on;
        btn.title = on ? '向' + item[2] + '群发送一条测试消息' : '未配置' + item[2] + ' Webhook，无法测试';
        if (window.I18N) btn.textContent = T('btn.test' + item[1].charAt(0).toUpperCase() + item[1].slice(1));
      });
      var cb = $('sendChannelsBadge');
      if (cb) {
        cb.textContent = ready + '/' + ids.length + ' 渠道可用';
        cb.className = 'tool-badge' + (ready ? ' on' : '');
      }
      renderDiagnostics(s);
      renderKeyStatus(s);
      renderServerchanUrl();
      loadChannels();
      loadRules();
      renderIntegrations();
      loadStats();
      start();
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
      setStatus('error', '无法获取服务状态');
    });
  }

  function start() {
    loadMessages();
    clearInterval(state.timer);
    // 自适应轮询：无变化时逐步从 5s 降到 15s / 30s，显著减少 KV 读次数。
    state.timer = setInterval(function () {
      if (document.hidden) return;
      state.idlePolls++;
      var every = state.idlePolls < 4 ? 1 : (state.idlePolls < 12 ? 3 : 6);
      if (state.idlePolls % every === 0) loadMessages();
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
    state.idlePolls = 0;
    loadMessages().then(function () { toast('已刷新'); });
  });

  // ---------- v2.0 交互：主题 / 导航 / 搜索 / 消息操作 ----------
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('cfn_theme', t); } catch (e) {}
  }
  $('btnTheme').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    toast(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
  });

  // L3：语言切换（偏好存 localStorage，下次打开保持）
  $('btnLang').addEventListener('click', function () {
    var next = (window.I18N && window.I18N.lang() === 'en') ? 'zh' : 'en';
    if (window.I18N) {
      window.I18N.setLang(next);
      window.I18N.apply();
    }
    this.textContent = next === 'en' ? '中文' : 'EN';
    render();
    renderIntegrations();
    toast(next === 'en' ? 'Switched to English' : '已切换为中文');
  });

  $('quickNav').addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-nav]');
    if (!a) return;
    var el = $(a.getAttribute('data-nav'));
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    Array.prototype.forEach.call($('quickNav').children, function (n) {
      n.className = n === a ? 'active' : '';
    });
  });

  $('fSearch').addEventListener('input', function () {
    state.search = this.value;
    render();
  });
  $('sourceChips').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.chip');
    if (!b) return;
    state.sourceFilter = b.getAttribute('data-source') || 'all';
    render();
  });

  $('list').addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    var m = null;
    for (var i = 0; i < state.messages.length; i++) {
      if (String(state.messages[i].id) === id) { m = state.messages[i]; break; }
    }
    if (!m) return;

    if (act === 'copy') {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(String(m.content || m.title || '')).then(function () {
          toast('已复制消息内容');
        });
      } else {
        toast('当前环境不支持自动复制');
      }
      return;
    }
    if (act === 'resend') {
      var headers = {};
      var t = state.rotatingKey || state.sendToken;
      if (t) headers['X-Token'] = t;
      api('/api/send', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ title: m.title, content: m.content, source: m.source || 'resend' }),
      }).then(function () {
        toast('已重新推送');
        return loadMessages();
      }).catch(function (err) {
        if (err.message !== 'unauthorized') toast('重新推送失败：' + err.message);
      });
      return;
    }
    if (act === 'delete') {
      confirmAction('删除这条通知', '删除后无法恢复，确定要删除「' + String(m.title || '无标题').slice(0, 40) + '」吗？', function () {
        var mt = masterToken();
        var h = mt ? { 'X-Token': mt } : {};
        api('/api/messages/' + encodeURIComponent(id), { method: 'DELETE', headers: h })
          .then(function () { toast('已删除'); return loadMessages(); })
          .catch(function (err) {
            if (err.message !== 'unauthorized') toast('删除失败：' + err.message);
          });
      });
    }
  });

  if ($('btnMobileRefresh')) $('btnMobileRefresh').addEventListener('click', function () {
    state.idlePolls = 0;
    loadMessages().then(function () { toast('已刷新'); });
  });
  if ($('btnMobileToggle')) $('btnMobileToggle').addEventListener('click', function () {
    state.allExpanded = !state.allExpanded;
    state.expanded = {};
    render();
  });
  if ($('btnMobileTop')) $('btnMobileTop').addEventListener('click', function () {
    window.scrollTo(0, 0);
  });
  $('btnCodeMore').addEventListener('click', function () {
    stateCodeExpanded = !stateCodeExpanded;
    renderIntegrations();
  });
  $('btnCodeCopy').addEventListener('click', function () {
    var el = $('intgCode');
    var text = el.dataset.full || el.textContent;
    if (!text) { setInline('intgStatus', 'err', '示例为空，请刷新页面后重试。'); return; }
    if (!navigator.clipboard) { setInline('intgStatus', 'err', '当前环境不支持自动复制。'); return; }
    navigator.clipboard.writeText(text).then(function () {
      setInline('intgStatus', 'ok', '示例代码已复制。');
    });
  });

  // ---------- v2.0 交互：渠道 / 规则 ----------
  function renderChannels() {
    var html = '';
    for (var i = 0; i < state.channels.length; i++) {
      var c = state.channels[i];
      html += '<div class="channel-card" data-channel="' + esc(c.id) + '">' +
        '<div class="channel-top">' +
        '<span class="channel-name">' + esc(c.name) + '</span>' +
        '<span class="channel-state' + (c.configured ? ' on' : '') + '">' + (c.configured ? '已配置' : '未配置') + '</span>' +
        '</div>' +
        '<input type="password" class="channel-webhook" value="' + esc(c.webhook || '') + '" placeholder="留空则不启用该渠道" autocomplete="off" />' +
        '<div class="row" style="margin-top:8px">' +
        '<label class="switch"><input type="checkbox" class="channel-enabled" ' + (c.enabled ? 'checked' : '') + ' />启用</label>' +
        '<button type="button" class="ghost" data-test="' + esc(c.id) + '">测试发送</button>' +
        '</div></div>';
    }
    $('channelList').innerHTML = html;
    var ready = state.channels.filter(function (c) { return c.configured && c.enabled; }).length;
    $('channelBadge').textContent = ready + '/' + state.channels.length + ' 已配置';
    $('channelBadge').className = 'tool-badge' + (ready ? ' on' : '');
  }

  function loadChannels() {
    // 带主密钥读取配置：保存过主密钥时面板直接进入可编辑模式，不必再次手工输入。
    var mt = masterToken();
    var headers = mt ? { 'X-Token': mt } : {};
    return api('/api/channels', { headers: headers }).then(function (data) {
      state.channels = data.channels || [];
      state.adminMode = Boolean(data.editable);
      renderChannels();
      setInline('channelStatus', 'info', state.adminMode
        ? '可在面板直接保存渠道配置，Webhook 仅存于你的 KV。'
        : '当前只读：填入管理主密钥 SEND_TOKEN 后可修改配置。');
      return data;
    }).catch(function (err) {
      if (err.message !== 'unauthorized') setInline('channelStatus', 'err', '渠道读取失败：' + err.message);
    });
  }

  $('channelList').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-test]');
    if (!b) return;
    var mt = masterToken();
    if (!mt) { setInline('channelStatus', 'err', '请先填入管理主密钥 SEND_TOKEN。'); return; }
    var id = b.getAttribute('data-test');
    b.disabled = true;
    setInline('channelStatus', 'info', '正在测试 ' + id + ' 渠道…');
    api('/api/channels/test', {
      method: 'POST',
      headers: { 'X-Token': mt },
      body: JSON.stringify({ id: id }),
    }).then(function (data) {
      setInline('channelStatus', 'ok', '测试消息已发往 ' + id + '，请到对应群查看。');
    }).catch(function (err) {
      setInline('channelStatus', 'err', '测试失败：' + err.message);
    }).finally(function () { b.disabled = false; });
  });

  $('btnSaveChannels').addEventListener('click', function () {
    var mt = masterToken();
    if (!mt) { setInline('channelStatus', 'err', '请先填入管理主密钥 SEND_TOKEN。'); return; }
    var cards = $('channelList').querySelectorAll('.channel-card');
    var cfg = [];
    for (var i = 0; i < cards.length; i++) {
      cfg.push({
        id: cards[i].getAttribute('data-channel'),
        webhook: cards[i].querySelector('.channel-webhook').value.trim(),
        enabled: cards[i].querySelector('.channel-enabled').checked,
      });
    }
    var btn = this;
    btn.disabled = true;
    api('/api/channels', {
      method: 'PUT',
      headers: { 'X-Token': mt },
      body: JSON.stringify({ channels: cfg }),
    }).then(function (data) {
      state.channels = data.channels || [];
      renderChannels();
      setInline('channelStatus', 'ok', '渠道配置已保存并立即生效。');
    }).catch(function (err) {
      setInline('channelStatus', 'err', '保存失败：' + err.message);
    }).finally(function () { btn.disabled = false; });
  });

  function loadRules() {
    return api('/api/settings').then(function (data) {
      state.settings = data.settings || null;
      if (state.settings) {
        $('fQuietEnabled').checked = Boolean(state.settings.quietEnabled);
        $('fQuietStart').value = state.settings.quietStart || '23:00';
        $('fQuietEnd').value = state.settings.quietEnd || '07:00';
      }
      return api('/api/templates');
    }).then(function (data) {
      state.templates = data.templates || {};
      $('fTemplates').value = JSON.stringify(state.templates, null, 2);
      $('ruleBadge').textContent = Object.keys(state.templates).length + ' 个模板';
    }).catch(function (err) {
      if (err.message !== 'unauthorized') setInline('ruleStatus', 'err', '规则读取失败：' + err.message);
    });
  }

  $('btnSaveRules').addEventListener('click', function () {
    var mt = masterToken();
    if (!mt) { setInline('ruleStatus', 'err', '请先填入管理主密钥 SEND_TOKEN。'); return; }
    var settings = {
      quietEnabled: $('fQuietEnabled').checked,
      quietStart: $('fQuietStart').value,
      quietEnd: $('fQuietEnd').value,
      quietChannels: ['wecom', 'dingtalk', 'feishu'],
    };
    var templates;
    try { templates = JSON.parse($('fTemplates').value.trim() || '{}'); }
    catch (e) { setInline('ruleStatus', 'err', '模板 JSON 格式不正确：' + e.message); return; }
    var btn = this;
    btn.disabled = true;
    api('/api/settings', {
      method: 'PUT', headers: { 'X-Token': mt }, body: JSON.stringify({ settings: settings }),
    }).then(function () {
      return api('/api/templates', {
        method: 'PUT', headers: { 'X-Token': mt }, body: JSON.stringify({ templates: templates }),
      });
    }).then(function (data) {
      state.templates = data.templates || {};
      state.settings = settings;
      $('fTemplates').value = JSON.stringify(state.templates, null, 2);
      $('ruleBadge').textContent = Object.keys(state.templates).length + ' 个模板';
      setInline('ruleStatus', 'ok', '规则与模板已保存。');
    }).catch(function (err) {
      setInline('ruleStatus', 'err', '保存失败：' + err.message);
    }).finally(function () { btn.disabled = false; });
  });

  function previewVars() {
    var src = $('fContent').value || $('fTitle').value || '';
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var map = {
      date: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
      time: p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()),
      datetime: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()),
      timestamp: String(Math.floor(d.getTime() / 1000)),
      timestamp_ms: String(d.getTime()),
      weekday: '星期' + '日一二三四五六'[d.getDay()],
      version: '2.0.0',
      source: 'preview',
    };
    var out = '';
    var pos = 0;
    while (true) {
      var a = src.indexOf('{', pos);
      if (a < 0) { out += src.slice(pos); break; }
      var b = src.indexOf('}', a + 1);
      if (b < 0) { out += src.slice(pos); break; }
      var name = src.slice(a + 1, b);
      out += src.slice(pos, a);
      out += Object.prototype.hasOwnProperty.call(map, name) ? map[name] : ('{' + name + '}');
      pos = b + 1;
    }
    $('varPreview').textContent = '预览：' + (out || '（内容为空）');
    $('varPreview').style.display = 'block';
  }
  $('btnPreviewVars').addEventListener('click', previewVars);

  $('btnLogin').addEventListener('click', function () {
    var btn = this;
    var token = $('loginToken').value.trim();
    if (!token) { $('loginErr').textContent = '请输入查看密钥'; $('loginErr').classList.add('show'); return; }
    // Turnstile 启用时必须先拿到验证 token 才能提交（服务端会独立校验）
    var tsToken = '';
    if (window.TS && window.TS.enabled()) {
      tsToken = window.TS.token();
      if (!tsToken) { $('loginErr').textContent = '请先完成人机验证'; $('loginErr').classList.add('show'); return; }
    }
    btn.disabled = true;
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, turnstileToken: tsToken, 'cf-turnstile-response': tsToken }),
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      location.reload();
    }).catch(function (err) {
      $('loginErr').textContent = T('login.err') + '：' + err.message;
      $('loginErr').classList.add('show');
      // token 单次使用：失败后必须重置组件拿新 token
      if (window.TS && window.TS.enabled()) window.TS.reset();
    }).finally(function () { btn.disabled = false; });
  });
  $('loginToken').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btnLogin').click();
  });

  $('btnLogout').addEventListener('click', function () {
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
      location.reload();
    });
  });

  $('btnSend').addEventListener('click', function () {
    var btn = this;
    var token = $('fSendToken').value.trim() || state.sendToken;
    var payload = { title: $('fTitle').value.trim(), content: $('fContent').value.trim() };
    if (!payload.title && !payload.content) {
      setInline('sendFeedback', 'err', '请至少填写标题或内容。');
      return;
    }

    btn.disabled = true;
    setInline('sendFeedback', 'info', '正在发送…');
    // 密钥走 X-Token Header，不进 URL，避免留在浏览器历史与日志里
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Token'] = token;
    fetch('/api/send', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      credentials: 'same-origin'
    }).then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (res) {
        if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
        if (token) {
          state.sendToken = token;
          localStorage.setItem('cfn_send_token', token);
          renderServerchanUrl();
          renderIntegrations();
        }
        $('fTitle').value = '';
        $('fContent').value = '';
        var w = res.d.wecom || {};
        var channels = res.d.channels || [];
        var msg = '已存入通知中心';
        if (w.configured && w.ok === false) {
          msg += ' · 企业微信推送失败：' + (w.error || '未知错误');
        } else if (w.configured) {
          msg += ' · 企业微信已送达';
        } else {
          msg += ' · 未配置企业微信推送';
        }
        var others = channels.filter(function (c) { return c.id !== 'wecom' && c.configured && c.ok; })
          .map(function (c) { return c.name || c.id; });
        if (others.length) msg += ' · 另已送达 ' + others.join('/');
        setInline('sendFeedback', w.configured && w.ok === false ? 'err' : 'ok', msg);
        return loadMessages();
      })
      .catch(function (err) { setInline('sendFeedback', 'err', '发送失败：' + friendlyAuthError(err)); })
      .finally(function () { btn.disabled = false; });
  });

  $('btnClear').addEventListener('click', function () {
    confirmAction('清空全部通知', '此操作会删除收件箱里的全部消息，且无法恢复。确定继续吗？', function () {
      var mt = masterToken();
      var h = mt ? { 'X-Token': mt } : {};
      api('/api/clear', { method: 'POST', headers: h }).then(function (data) {
        toast('已清空 ' + (data.deleted || 0) + ' 条');
        return loadMessages();
      }).catch(function (err) {
        if (err.message !== 'unauthorized') toast('清空失败：' + err.message);
      });
    });
  });

  // ---------- v2.2：主密钥保存 ----------
  if ($('chkRememberMaster')) $('chkRememberMaster').addEventListener('change', function () {
    if (this.checked && !masterToken()) {
      this.checked = false;
      setInline('keyFeedback', 'err', T('err.masterRequired'));
      return;
    }
    persistMaster();
    setInline('keyFeedback', 'ok', T(this.checked ? 'toast.masterSaved' : 'toast.masterCleared'));
  });
  if ($('fMasterToken')) $('fMasterToken').addEventListener('change', persistMaster);
  if ($('btnForgetMaster')) $('btnForgetMaster').addEventListener('click', function () {
    confirmAction(T('btn.forgetMaster'), T('confirm.forgetMaster'), function () {
      try { localStorage.removeItem(MASTER_KEY_STORAGE); } catch (e) {}
      $('fMasterToken').value = '';
      updateMasterSaveUi();
      setInline('keyFeedback', 'ok', T('toast.masterCleared'));
    });
  });

  $('btnCopyIntg').addEventListener('click', function () {
    var text = $('intgCode').textContent;
    if (!text) { setInline('intgStatus', 'err', '示例为空，请刷新页面后重试。'); return; }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        setInline('intgStatus', 'ok', '已复制「' + currentIntg().label + '」示例。');
      }).catch(function () {
        setInline('intgStatus', 'err', '复制失败，请手动选中代码框内容复制。');
      });
    } else {
      setInline('intgStatus', 'err', '当前环境不支持自动复制，请手动选中代码框内容。');
    }
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
    if (navigator.clipboard) {
      navigator.clipboard.writeText(cmd).then(function () {
        setInline('sendFeedback', 'ok', '已复制 curl 示例，密钥走 Header、不进 URL。');
      }).catch(function () {
        setInline('sendFeedback', 'info', '已生成 curl 示例，请手动复制上方内容。');
      });
    } else {
      setInline('sendFeedback', 'info', '已生成 curl 示例，请手动复制上方内容。');
    }
  });

  $('fSendToken').addEventListener('input', function () {
    renderServerchanUrl();
    renderIntegrations();
  });
  function copyScUrl() {
    var url = $('scUrl').dataset.url;
    if (!url) {
      setInline('intgStatus', 'err', '尚无专用地址：请先生成轮换密钥或填入发送密钥。');
      return;
    }
    if (!navigator.clipboard) {
      setInline('intgStatus', 'err', '当前环境不支持自动复制，请手动选中地址复制。');
      return;
    }
    navigator.clipboard.writeText(url).then(function () {
      setInline('intgStatus', 'ok', '已复制方糖 / Server酱 专用地址。');
    }).catch(function () {
      setInline('intgStatus', 'err', '复制失败，请手动选中地址复制。');
    });
  }
  $('scUrl').addEventListener('click', copyScUrl);
  $('btnCopyScUrl').addEventListener('click', copyScUrl);

  // v2.2：三个渠道统一走 /api/test-channel，用发送密钥即可；测试请求同样受限流与可选签名保护。
  function runChannelTest(id, name, btn) {
    var token = $('fSendToken').value.trim() || state.sendToken || masterToken();
    btn.disabled = true;
    setInline('sendFeedback', 'info', '正在测试' + name + '推送…');
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Token'] = token;
    fetch('/api/test-channel', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ id: id }),
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      setInline('sendFeedback', 'ok', '测试消息已发到' + name + '，请查收。');
    }).catch(function (err) {
      setInline('sendFeedback', 'err', name + '测试失败：' + friendlyAuthError(err));
    }).finally(function () {
      // 未配置的渠道保持禁用，配置过的恢复可点。
      var c = (state.status && state.status.channels || []).find(function (x) { return x.id === id; });
      btn.disabled = !(c && c.configured);
    });
  }
  [
    ['btnTestWecom', 'wecom', '企业微信'],
    ['btnTestDingtalk', 'dingtalk', '钉钉'],
    ['btnTestFeishu', 'feishu', '飞书'],
  ].forEach(function (item) {
    var btn = $(item[0]);
    if (btn) btn.addEventListener('click', function () { runChannelTest(item[1], item[2], this); });
  });

  function showRotatedKey(key, isNew) {
    state.rotatingKey = key;
    var box = $('rotatedKeyBox');
    box.textContent = key;
    box.dataset.key = key;
    box.style.display = 'block';
    $('rotateHint').textContent = '轮换后旧 key 立即失效，记得同步更新软件里的配置。';
    setInline('keyFeedback', 'ok', isNew
      ? '新密钥已生效，旧密钥立即失效；请到软件里替换。'
      : '已读取当前生效的轮换密钥。');
    var badge = $('keyBadge');
    badge.textContent = '已就绪';
    badge.className = 'tool-badge on';
    renderServerchanUrl();
    renderIntegrations();
  }

  function adminHeaders() {
    var m = $('fMasterToken').value.trim();
    if (!m) {
      setInline('keyFeedback', 'err', '请先填入管理主密钥 SEND_TOKEN，再执行此操作。');
      return null;
    }
    return { 'Content-Type': 'application/json', 'X-Token': m };
  }

  $('btnRotateKey').addEventListener('click', function () {
    var btn = this;
    var headers = adminHeaders();
    if (!headers) return;
    btn.disabled = true;
    setInline('keyFeedback', 'info', '正在生成新推送密钥…');
    fetch('/api/key/rotate', { method: 'POST', headers: headers, credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      showRotatedKey(res.d.key, true);
    }).catch(function (err) {
      setInline('keyFeedback', 'err', '生成失败：' + friendlyAuthError(err));
    }).finally(function () { btn.disabled = false; });
  });

  $('btnViewKey').addEventListener('click', function () {
    var btn = this;
    var headers = adminHeaders();
    if (!headers) return;
    btn.disabled = true;
    setInline('keyFeedback', 'info', '正在读取当前轮换密钥…');
    fetch('/api/key/current', { headers: headers, credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      if (!res.d.key) {
        setInline('keyFeedback', 'info', '尚未生成轮换密钥，点「生成新密钥」创建。');
        return;
      }
      showRotatedKey(res.d.key, false);
    }).catch(function (err) {
      setInline('keyFeedback', 'err', '读取失败：' + friendlyAuthError(err));
    }).finally(function () { btn.disabled = false; });
  });

  $('rotatedKeyBox').addEventListener('click', function () {
    var key = this.dataset.key;
    if (!key) return;
    if (!navigator.clipboard) {
      setInline('keyFeedback', 'err', '当前环境不支持自动复制，请手动选中密钥。');
      return;
    }
    navigator.clipboard.writeText(key).then(function () {
      setInline('keyFeedback', 'ok', '已复制轮换密钥。');
    }).catch(function () {
      setInline('keyFeedback', 'err', '复制失败，请手动选中密钥。');
    });
  });

  init();
})();
</script>
</body>
</html>`;

// 未通过服务端鉴权时返回的最小登录页：
// 里面**没有**任何推送地址、密钥、通知列表等敏感 DOM，
// 即便攻击者删掉遮罩 div 也拿不到任何信息。
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>访问验证 · Cloudflare Notify</title>
<!--@I18N_JS@-->
<!--@HIGHLIGHT_JS@-->
<style>${UI_CSS}</style>
</head>
<body>
<div class="auth-wrap">
  <div class="auth-card">
    <div class="brand">
      <div class="logo">✦</div>
      <div>
        <h1 data-i18n="app.name">通知中心</h1>
        <div class="sub">Cloudflare Notify · v2.1</div>
      </div>
    </div>
    <p class="auth-lead" data-i18n="login.lead">该通知服务已开启查看验证。请输入查看密钥（READ_TOKEN）以查看通知与接入地址。</p>
    <!--@PUBLIC_HINT@-->
    <label for="loginToken" data-i18n="login.token">查看密钥</label>
    <input id="loginToken" type="password" data-i18n-ph="login.token" placeholder="READ_TOKEN" autocomplete="current-password" />
    <div class="auth-err" id="loginErr"></div>
    <!--@TS_WIDGET@-->
    <div class="row">
      <button class="primary" id="btnLogin" data-i18n="login.enter">进入通知中心</button>
    </div>
    <div class="hint" style="margin-top:14px">验证通过后会签发 HttpOnly 会话 Cookie，密钥不会保存在浏览器本地。</div>
    <a class="auth-back" href="/">← 回到首页 / Back to home</a>
    <a class="auth-back" href="/docs" style="margin-left:14px">API 文档</a>
  </div>
</div>

<div class="toast" id="toast"></div>

<!--@TS_SCRIPTS@-->
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var T = window.I18N ? window.I18N.t : function (k) { return k; };
  if (window.I18N) window.I18N.apply();

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  $('btnLogin').addEventListener('click', function () {
    var btn = this;
    var token = $('loginToken').value.trim();
    if (!token) {
      $('loginErr').textContent = T('login.err') + ': ' + T('login.token');
      $('loginErr').classList.add('show');
      return;
    }
    // Turnstile 启用时必须先拿到验证 token 才能提交（服务端会独立校验）
    var tsToken = '';
    if (window.TS && window.TS.enabled()) {
      tsToken = window.TS.token();
      if (!tsToken) {
        $('loginErr').textContent = T('login.err') + ': Turnstile';
        $('loginErr').classList.add('show');
        return;
      }
    }
    btn.disabled = true;
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, turnstileToken: tsToken, 'cf-turnstile-response': tsToken }),
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      if (!res.d.ok) throw new Error(res.d.error || ('HTTP ' + res.s));
      location.replace('/');
    }).catch(function (err) {
      $('loginErr').textContent = T('login.err') + '：' + err.message;
      $('loginErr').classList.add('show');
      btn.disabled = false;
      // token 单次使用：失败后必须重置组件拿新 token
      if (window.TS && window.TS.enabled()) window.TS.reset();
    });
  });

  $('loginToken').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btnLogin').click();
  });
  $('loginToken').focus();

  // 组件渲染（登录页容器始终可见，可直接挂载）
  if (window.TS && window.TS.enabled()) window.TS.start();
})();
</script>
</body>
</html>`;

// ============================== 工具函数 ==============================
// CORS 默认收紧：不设置 Access-Control-Allow-Origin，跨站浏览器脚本无法读取响应。
// 同源页面、curl、服务端 Webhook 调用均不受影响（它们不依赖 CORS）。
// 这是有意的收窄——旧版用 '*' 允许任意站点读取 API，已移除。
const CORS_PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token, X-Idempotency-Key, X-Cfn-Signature',
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

// ============================== Turnstile 人机验证 ==============================
// Cloudflare Turnstile 人机验证（可选功能，默认关闭）。
// 官方文档：https://developers.cloudflare.com/turnstile/
//
// 官方明确要求的三条，缺一不可：
//   1) 前端组件本身**不构成保护**（token 可伪造）→ 必须在服务端调用 Siteverify 校验；
//   2) token 单次使用、生成后 300 秒过期 → 校验失败后前端要 reset() 重新挑战；
//   3) 客户端组件需要 CSP 放行 challenges.cloudflare.com（script-src + frame-src）。
//
// 启用方式（两个环境变量必须同时存在）：
//   TURNSTILE_SITE_KEY   —— Cloudflare 控制台给出的公开 site key（0x... 开头），可放普通变量
//   TURNSTILE_SECRET_KEY —— 同一 widget 的 secret key，**只能放 Secrets**，绝不写进代码
// 只配一个 → 视为未启用（并在 /api/status 标出"配置不完整"），避免把用户锁在门外。
// 未启用时不加载任何外部资源、不放宽 CSP，对现有部署零影响。
const TURNSTILE_ACTION = 'login';
const TURNSTILE_DEFAULT_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * 组件与校验接口的源站。
 * 默认全球站；中国大陆部署可设 TURNSTILE_API_ORIGIN=https://challenges.cloudflare-cn.com
 * （该地址对应 Cloudflare 中国区 widget，与 site key 所属区域必须一致）
 */
function turnstileOrigin(env) {
  const raw = String((env && env.TURNSTILE_API_ORIGIN) || '').trim().replace(/\/+$/, '');
  return raw || TURNSTILE_DEFAULT_ORIGIN;
}

function turnstileSiteKey(env) {
  return String((env && env.TURNSTILE_SITE_KEY) || '').trim();
}

function turnstileSecretKey(env) {
  return String((env && env.TURNSTILE_SECRET_KEY) || '').trim();
}

/**
 * 期望的 hostname 白名单（官方推荐做法）。
 * 解析 TURNSTILE_HOSTNAMES="a.com,b.com"，去掉空项与首尾空白。
 * 官方提醒：生产环境白名单里不要出现 localhost / 127.0.0.1。
 */
function turnstileHostnames(env) {
  const raw = String((env && env.TURNSTILE_HOSTNAMES) || '');
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 两个变量都在才算启用 */
function turnstileEnabled(env) {
  return Boolean(turnstileSiteKey(env)) && Boolean(turnstileSecretKey(env));
}

/** 只配了一半 → 配置不完整（页面可显示，服务端不放行校验，避免直接锁死用户） */
function turnstileMisconfigured(env) {
  return Boolean(turnstileSiteKey(env)) !== Boolean(turnstileSecretKey(env));
}

/** 页面 CSP：启用 Turnstile 时放行 challenges.cloudflare.com（官方要求的 script-src + frame-src） */
function buildCsp(env) {
  if (!turnstileEnabled(env)) return HTML_CSP;
  const origin = turnstileOrigin(env);
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${origin}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${origin}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    `frame-src 'self' ${origin}`,
    "form-action 'self'",
  ].join('; ');
}

/** 合法 IP 才作为 remoteip 上报（X-Forwarded-For 可能是多段列表，非法值会让 Siteverify 报错） */
function normalizeIp(ip) {
  const s = String(ip || '').trim();
  if (!s || s === 'unknown') return '';
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(s)) return s;
  if (s.indexOf(':') >= 0 && /^[0-9a-fA-F:.]+$/.test(s)) return s;
  return '';
}

/** 由任意字符串派生稳定 UUID（幂等键：同一 token 重试时复用同一 key，不会被判成 token 重放） */
async function uuidFromText(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cfn-turnstile:' + text));
  const b = new Uint8Array(digest).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 服务端校验 Turnstile token（Siteverify）。
 * 返回 { ok, code, hostname }；code 只写进服务端日志，不返回给客户端（避免泄露内部细节）。
 * 失败一律拒绝（fail closed）：宁可让人重试，也不放行未经验证的请求。
 *
 * 按官方「已有 widget」接入流程实现：
 *   - Siteverify 用 application/x-www-form-urlencoded，10 秒超时；
 *   - 必须校验 success === true、action 一致、hostname 在允许列表内；
 *   - 绝不在浏览器里调 Siteverify（浏览器 → 自己的后端 → siteverify）。
 */
async function verifyTurnstileToken(env, token, ip, requestHost) {
  const secret = turnstileSecretKey(env);
  if (!secret) return { ok: true, code: 'disabled' };

  const response = String(token || '').trim();
  if (!response) return { ok: false, code: 'missing-input-response' };
  if (response.length > 2048) return { ok: false, code: 'invalid-input-response' };

  const payload = { secret, response };
  const remoteip = normalizeIp(ip);
  if (remoteip) payload.remoteip = remoteip;
  // 幂等键：同一 token 的网络重试视为同一次校验，不会被误判成"token 重放"
  payload.idempotency_key = await uuidFromText(response);

  for (let attempt = 0; attempt < 2; attempt++) {
    let data = null;
    try {
      const res = await fetch(`${turnstileOrigin(env)}/turnstile/v0/siteverify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        if (attempt === 0) continue; // 网络抖动重试（同幂等键）
        return { ok: false, code: 'http-' + res.status };
      }
      data = await res.json();
    } catch (e) {
      if (attempt === 0) continue; // 网络异常/超时重试
      return { ok: false, code: 'network-error' };
    }

    if (!data || typeof data !== 'object') return { ok: false, code: 'bad-response' };
    if (data.success === true) {
      // 官方建议：action 与预期不符也要拒绝（测试密钥不返回 action，跳过该判断）
      if (data.action && data.action !== TURNSTILE_ACTION) {
        return { ok: false, code: 'action-mismatch' };
      }
      const hostname = String(data.hostname || '');
      if (!turnstileHostnameAllowed(env, hostname, requestHost)) {
        return { ok: false, code: 'hostname-mismatch' };
      }
      return { ok: true, code: 'ok', hostname };
    }

    const codes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    // internal-error 是 Cloudflare 侧故障，可安全重试；timeout-or-duplicate（token 已用过/过期）不能重试
    if (codes.indexOf('internal-error') >= 0 && attempt === 0) continue;
    return { ok: false, code: codes.join(',') || 'unknown' };
  }
  return { ok: false, code: 'unknown' };
}

/**
 * hostname 允许列表判定（官方建议：服务端同时校验 hostname / action）。
 *   1) 显式配置 TURNSTILE_HOSTNAMES → 必须命中白名单；
 *   2) 未配置 → 退化为「必须等于本次请求的 Host」，等效更严格，且不会把用户锁死；
 *   3) 官方测试密钥返回 dummy-key.invalid → 跳过（仅用于本地自测）。
 */
function turnstileHostnameAllowed(env, hostname, requestHost) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h || h === 'dummy-key.invalid') return true; // 测试密钥无真实域名
  const explicit = turnstileHostnames(env);
  if (explicit.length) return explicit.indexOf(h) >= 0;
  const req = String(requestHost || '').trim().toLowerCase();
  if (!req) return true; // 拿不到 Host 则不做此项判断（其余校验仍然生效）
  return h === req;
}

// ------------------------------ 客户端组件 ------------------------------
// 显式渲染（render=explicit）：由我们自己控制挂载时机与回调。
// 为什么不在页面加载时直接挂载：主界面的重新验证弹层默认 display:none，
// 组件在不可见容器里渲染会拿到 0 尺寸的 iframe，导致组件显示异常。
// 所以：api.js 按需动态注入（不进 <head>，不拖慢主界面），容器可见后再 render()。

// 客户端脚本（登录页与主界面弹层共用）。刻意保持 ES5 写法，兼容老浏览器。
const TURNSTILE_CLIENT_JS = [
  '(function () {',
  "  'use strict';",
  '  var CFG = window.__TS_CFG__ || {};',
  '  var st = { token: "", id: null, started: false, injected: false, tries: 0 };',
  '  function el(id) { return document.getElementById(id); }',
  '  function note(text, info) {',
  '    var m = el("tsMsg");',
  '    if (!m) return;',
  '    m.textContent = text || "";',
  '    m.className = "ts-msg" + (text ? " show" : "") + (info ? " info" : "");',
  '  }',
  '  function fire(type) {',
  '    try {',
  '      document.dispatchEvent(new CustomEvent(type, { detail: { token: st.token } }));',
  '    } catch (e) {',
  '      try { document.dispatchEvent(new Event(type)); } catch (e2) {}',
  '    }',
  '  }',
  '  function visible(box) {',
  '    // 容器不可见时 iframe 会拿到 0 尺寸，组件将无法正常显示，必须等可见后再渲染',
  '    return !!(box.offsetWidth || box.offsetHeight || box.getClientRects().length);',
  '  }',
  '  function draw() {',
  '    var box = el("tsWidget");',
  '    if (!box || !window.turnstile || st.id !== null) return;',
  '    if (!visible(box)) {',
  '      st.tries += 1;',
  '      if (st.tries < 60) { setTimeout(draw, 50); }',
  '      return;',
  '    }',
  '    st.tries = 0;',
  '    st.id = window.turnstile.render(box, {',
  '      sitekey: CFG.sitekey,',
  '      action: CFG.action || "login",',
  '      theme: "auto",',
  '      size: "normal",',
  '      callback: function (t) { st.token = t; note(""); fire("ts:token"); },',
  '      "error-callback": function () { st.token = ""; note("人机验证加载失败，请刷新页面重试"); fire("ts:token"); },',
  '      "expired-callback": function () { st.token = ""; note("验证已过期，请重新验证"); fire("ts:token"); },',
  '      "timeout-callback": function () { st.token = ""; note("验证超时，请重新验证"); fire("ts:token"); }',
  '    });',
  '  }',
  '  function ready(fn) {',
  '    // 注意：显式渲染（render=explicit）模式下 turnstile.ready() 的回调并不保证被触发，',
  '    // 因此这里不依赖它，onload= 参数回调 + script.onload 才是可靠的触发点。',
  '    var called = false;',
  '    function once() { if (called) return; called = true; fn(); }',
  '    if (window.turnstile && window.turnstile.ready) {',
  '      try { window.turnstile.ready(once); } catch (e) {}',
  '    }',
  '    setTimeout(once, 1200);',
  '  }',
  '  function inject() {',
  '    if (st.injected) return;',
  '    st.injected = true;',
  '    // 官方推荐的显式渲染写法：api.js?onload=<全局回调名>，API 就绪时回调被调用。',
  '    // 再叠一层 script.onload 兜底；两者都调用幂等的 draw()，重复调用无副作用。',
  '    var CB = "__tsOnLoad";',
  '    window[CB] = function () { ready(draw); };',
  '    var s = document.createElement("script");',
  '    s.src = CFG.origin + "/turnstile/v0/api.js?render=explicit&onload=" + CB;',
  '    s.async = true;',
  '    s.defer = true;',
  '    s.onload = function () { ready(draw); };',
  '    s.onerror = function () {',
  '      st.injected = false;',
  '      note("人机验证组件加载失败，请检查网络后刷新重试");',
  '    };',
  '    document.head.appendChild(s);',
  '  }',
  '  window.TS = {',
  '    enabled: function () { return !!CFG.sitekey; },',
  '    token: function () { return st.token; },',
  '    reset: function () {',
  '      st.token = "";',
  '      if (st.id !== null && window.turnstile && window.turnstile.reset) {',
  '        try { window.turnstile.reset(st.id); } catch (e) {}',
  '      }',
  '      fire("ts:token");',
  '    },',
  '    start: function () {',
  '      if (!CFG.sitekey) return;',
  '      if (window.turnstile && window.turnstile.render) {',
  '        // API 已就绪（例如弹层第二次打开），直接渲染；容器不可见时 draw() 会自行重试',
  '        draw();',
  '        return;',
  '      }',
  '      inject();',
  '    }',
  '  };',
  '})();',
].join('\n');

/** Turnstile 组件容器（仅在启用时插入，避免未启用时页面出现空块） */
function tsWidgetBlock() {
  return [
    '<div class="ts-widget" id="tsWidget"></div>',
    '<div class="ts-msg" id="tsMsg"></div>',
  ].join('\n');
}

/** Turnstile 客户端脚本（仅在启用时插入；未启用时页面不引用任何外部资源） */
function tsScriptBlock(env) {
  const cfg = JSON.stringify({
    sitekey: turnstileSiteKey(env),
    action: TURNSTILE_ACTION,
    origin: turnstileOrigin(env),
  }).replace(/</g, '\\u003c'); // 防止 JSON 里的 < 提前闭合 script 标签
  return [
    `<script>window.__TS_CFG__=${cfg};</script>`,
    `<script>${TURNSTILE_CLIENT_JS}</script>`,
  ].join('\n');
}

/**
 * 把模板里的 Turnstile 占位符换成真实内容。
 * 未启用 → 占位符替换为空串（页面完全不引用外部资源，CSP 保持最严）。
 */
function applyTurnstile(tpl, env) {
  const widget = turnstileEnabled(env) ? tsWidgetBlock() : '';
  const scripts = turnstileEnabled(env) ? tsScriptBlock(env) : '';
  const publicHint = String((env && env.READ_TOKEN) || '').trim()
    ? ''
    : '<div class="hint box" style="margin-bottom:12px">当前为公开模式，未设置查看密钥（READ_TOKEN）。建议设置后限制通知内容可见范围。</div>';
  return tpl
    .split('<!--@I18N_JS@-->').join('<script>' + I18N_JS + '</script>')
    .split('<!--@HIGHLIGHT_JS@-->').join('<script>' + HIGHLIGHT_JS + '</script>')
    .split('<!--@PUBLIC_HINT@-->').join(publicHint)
    .split('<!--@TS_WIDGET@-->').join(widget)
    .split('<!--@TS_SCRIPTS@-->').join(scripts);
}

// ============================== 会话与鉴权 ==============================
// 会话 Cookie 用 READ_TOKEN 作 HMAC 密钥签名（无状态，不需要 KV）。
// 好处：密钥不落在 localStorage / JS 变量里，HttpOnly 让 XSS 也读不到；
// 改 READ_TOKEN 会让所有旧会话立刻失效。
const SESSION_COOKIE = 'cfn_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/** 常量时间字符串比较，避免时序侧信道泄露密钥 */
function timingSafeEqual(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  const la = sa.length;
  const lb = sb.length;
  let diff = la ^ lb;
  const len = Math.max(la, lb);
  for (let i = 0; i < len; i++) {
    const ca = i < la ? sa.charCodeAt(i) : 0;
    const cb = i < lb ? sb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/** HMAC-SHA256(secret, message) → 十六进制 */
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成会话令牌：<过期毫秒>.<随机数>.<HMAC签名> */
async function createSessionToken(env) {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${exp}.${nonce}`;
  const sig = await hmacHex(env.READ_TOKEN, payload);
  return `${payload}.${sig}`;
}

/** 校验会话令牌：格式、有效期、签名三者都要过 */
async function verifySessionToken(env, token) {
  if (!token || !env.READ_TOKEN) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const sig = await hmacHex(env.READ_TOKEN, payload);
  return timingSafeEqual(sig, parts[2]);
}

/** 从 Cookie 头取指定值 */
function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const parts = raw.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    if (p.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(p.slice(idx + 1).trim());
      } catch (e) {
        return '';
      }
    }
  }
  return '';
}

function sessionCookieHeader(token, secure) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearSessionCookieHeader(secure) {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** 登录失败限速：单 isolate 内按 IP 计数（尽力而为，生产环境建议再加 WAF 规则） */
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;

function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILS;
}

function noteLoginFailure(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { first: Date.now(), count: 1 });
    return;
  }
  rec.count += 1;
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  );
}

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

function html(body, status = 200, extraHeaders = {}, env = null) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': buildCsp(env),
      ...SECURITY_HEADERS,
      ...extraHeaders,
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

/**
 * 读取/校验查看密钥。未配置时视为公开访问。
 * 接受三种凭据：READ_TOKEN 直传（query/Header/body）、已签发的会话 Cookie。
 */
async function hasReadPermission(request, url, env) {
  const expected = env.READ_TOKEN;
  if (!expected) return true;
  const direct = extractToken(request, url);
  if (direct && timingSafeEqual(direct, expected)) return true;
  const session = getCookie(request, SESSION_COOKIE);
  if (session && (await verifySessionToken(env, session))) return true;
  return false;
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
  if (master && timingSafeEqual(token, master)) return true;
  return Boolean(current) && timingSafeEqual(token, current);
}

/**
 * 管理凭据只从 Header / Authorization / Body 读取，禁止走 URL query。
 * 原因：query 会进入浏览器历史、Referer、CDN 与网关日志，主密钥一旦出现在 URL 即视为泄露。
 */
function extractAdminToken(request, body) {
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

/** 管理操作鉴权：只认管理主密钥 SEND_TOKEN，轮换密钥无权调用，且不接受 URL 中的 token */
function hasAdminPermission(request, url, env, body) {
  const master = String(env.SEND_TOKEN || '').trim();
  if (!master) return false;
  const token = extractAdminToken(request, body);
  return Boolean(token) && timingSafeEqual(token, master);
}

/**
 * 写操作鉴权（删除 / 清空 / 配置变更）：
 * 1) 管理主密钥 SEND_TOKEN 优先；
 * 2) 已启用 READ_TOKEN 时，会话 Cookie / READ_TOKEN 也可执行（方便面板操作）；
 * 3) 两个密钥都没配置的完全公开模式，保持旧行为可用。
 */
async function hasWritePermission(request, url, env, body) {
  if (hasAdminPermission(request, url, env, body)) return true;
  if (env.READ_TOKEN && (await hasReadPermission(request, url, env))) return true;
  return !env.SEND_TOKEN && !env.READ_TOKEN;
}

/**
 * 入站 HMAC 签名（可选）：设置 INBOUND_SIGNING_SECRET 后，所有写请求必须带
 * X-Cfn-Signature: sha256=<HMAC-SHA256(secret, 原始请求体)>，防止伪造 Webhook。
 * 未设置密钥时保持旧行为（签名校验关闭）。
 */
async function verifyInboundSignature(request, env) {
  const secret = String((env && env.INBOUND_SIGNING_SECRET) || '').trim();
  if (!secret) return { ok: true };
  const provided = String(request.headers.get('X-Cfn-Signature') || '').trim();
  if (!/^sha256=[0-9a-f]{64}$/i.test(provided)) return { ok: false, error: '缺少或无效的 X-Cfn-Signature' };
  const raw = await request.clone().text();
  if (raw.length > 262144) return { ok: false, error: '请求体过大' };
  const expected = 'sha256=' + await hmacHex(secret, raw);
  return timingSafeEqual(provided.toLowerCase(), expected.toLowerCase())
    ? { ok: true }
    : { ok: false, error: '签名校验失败' };
}

/**
 * 发送入口限流（E2）：按 IP 与密钥指纹双维度做滑动窗口计数。
 * 计数在 isolate 内存中，尽力而为；生产环境建议同时配置 Cloudflare WAF Rate Limiting。
 * 默认值：单 IP 60 次/分、500 次/天；单密钥 120 次/分、1000 次/天。
 */
const rateBuckets = new Map();
const RATE_BUCKET_MAX = 4096;

function rateBucket(key, windowMs, now) {
  let rec = rateBuckets.get(key);
  if (!rec || now - rec.start >= windowMs) {
    rec = { start: now, count: 0 };
    rateBuckets.set(key, rec);
  }
  rec.count += 1;
  if (rateBuckets.size > RATE_BUCKET_MAX) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start >= Math.max(60000, windowMs)) rateBuckets.delete(k);
    }
    while (rateBuckets.size > RATE_BUCKET_MAX) {
      const oldest = rateBuckets.keys().next().value;
      if (oldest === undefined) break;
      rateBuckets.delete(oldest);
    }
  }
  return rec;
}

async function checkSendRateLimit(request, env) {
  const now = Date.now();
  const ip = clientIp(request).slice(0, 80);
  const token = String(
    request.headers.get('X-Token') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
    new URL(request.url).searchParams.get('token') || ''
  );
  const fp = token ? (await sha256Hex(token)).slice(0, 16) : 'anon';
  const num = (name, dflt) => {
    const v = Number(env && env[name]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
  };
  const limits = [
    ['ip-m:' + ip, 60000, num('SEND_RATE_PER_MIN', 60)],
    ['ip-d:' + ip, 86400000, num('SEND_RATE_PER_DAY', 500)],
    ['key-m:' + fp, 60000, num('KEY_RATE_PER_MIN', 120)],
    ['key-d:' + fp, 86400000, num('KEY_RATE_PER_DAY', 1000)],
  ];
  for (const [key, windowMs, max] of limits) {
    const rec = rateBucket(key, windowMs, now);
    if (rec.count > max) {
      const retry = Math.max(1, Math.ceil((rec.start + windowMs - now) / 1000));
      return json(
        { ok: false, error: '请求过于频繁，请稍后重试', retryAfter: retry },
        429,
        { 'Retry-After': String(retry) }
      );
    }
  }
  return null;
}

function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// ============================== KV 存储层 ==============================
const PREFIX = 'msg:';
const VERSION_KEY = 'meta:version';
const SENDKEY_KEY = 'meta:sendkey';
const ROTATED_AT_KEY = 'meta:sendkey_rotated_at';
const CHANNELS_KEY = 'meta:channels';
const TEMPLATES_KEY = 'meta:templates';
const SETTINGS_KEY = 'meta:settings';
const AUDIT_KEY = 'meta:audit';
const TENANTS_KEY = 'meta:tenants';
const TENANT_QUOTA_PREFIX = 'meta:tenantquota:';
const IDEM_PREFIX = 'meta:idem:';
const IDEM_TTL_SECONDS = 24 * 60 * 60;
const CHANNEL_IDS = Object.freeze(['wecom', 'dingtalk', 'feishu']);
const CHANNEL_NAMES = Object.freeze({ wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' });
const AUDIT_MAX = 30;
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

/** SHA-256 十六进制（幂等键 / 审计指纹使用，不用于密钥派生） */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 版本号自增：面板改配置后轮询客户端能立刻拿到新数据 */
async function bumpVersion(env) {
  try {
    if (env && env.NOTIFICATIONS) await env.NOTIFICATIONS.put(VERSION_KEY, String(Date.now()));
  } catch (e) {
    console.warn('[notify] bump version failed:', e && e.message ? e.message : e);
  }
}

/** 操作审计：只记录动作与脱敏摘要，不记录密钥原文 */
async function appendAudit(env, action, detail) {
  try {
    if (!env || !env.NOTIFICATIONS) return;
    const raw = await env.NOTIFICATIONS.get(AUDIT_KEY);
    let items = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) items = parsed.items;
    }
    items.unshift({ at: Date.now(), action: String(action || '').slice(0, 60), detail: String(detail || '').slice(0, 200) });
    await env.NOTIFICATIONS.put(AUDIT_KEY, JSON.stringify({ items: items.slice(0, AUDIT_MAX) }));
  } catch (e) {
    console.warn('[notify] audit write failed:', e && e.message ? e.message : e);
  }
}

/** 默认静默时段设置（不改变既有行为） */
function defaultSettings() {
  return {
    quietEnabled: false,
    quietStart: '23:00',
    quietEnd: '07:00',
    quietChannels: ['wecom', 'dingtalk', 'feishu'],
  };
}

async function readSettings(env) {
  const fallback = defaultSettings();
  try {
    if (!env || !env.NOTIFICATIONS) return fallback;
    const raw = await env.NOTIFICATIONS.get(SETTINGS_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return fallback;
    const timeOk = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
    return {
      quietEnabled: Boolean(v.quietEnabled),
      quietStart: timeOk(v.quietStart) ? v.quietStart : fallback.quietStart,
      quietEnd: timeOk(v.quietEnd) ? v.quietEnd : fallback.quietEnd,
      quietChannels: Array.isArray(v.quietChannels)
        ? v.quietChannels.filter((x) => CHANNEL_IDS.indexOf(x) >= 0)
        : fallback.quietChannels.slice(),
    };
  } catch (_) {
    return fallback;
  }
}

function normalizeSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('设置必须是对象');
  const timeOk = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
  if (!timeOk(input.quietStart) || !timeOk(input.quietEnd)) throw new Error('静默时段格式应为 HH:MM');
  const channels = Array.isArray(input.quietChannels)
    ? input.quietChannels.filter((x) => CHANNEL_IDS.indexOf(x) >= 0)
    : [];
  return {
    quietEnabled: Boolean(input.quietEnabled),
    quietStart: String(input.quietStart),
    quietEnd: String(input.quietEnd),
    quietChannels: channels,
  };
}

/** 判断当前（GMT+8）是否处于静默时段；跨零点与同区间均可正确处理 */
function isQuietNow(settings, now) {
  if (!settings || !settings.quietEnabled) return false;
  const d = shift8(now || new Date());
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
  const toMin = (s) => {
    const p = String(s || '00:00').split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  };
  const a = toMin(settings.quietStart);
  const b = toMin(settings.quietEnd);
  if (a === b) return false;
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

async function readTemplates(env) {
  try {
    if (!env || !env.NOTIFICATIONS) return {};
    const raw = await env.NOTIFICATIONS.get(TEMPLATES_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

function normalizeTemplates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模板配置必须是对象');
  const out = {};
  const names = Object.keys(input);
  if (names.length > 30) throw new Error('模板数量最多 30 个');
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error('模板名只能包含字母、数字、下划线和短横线');
    const t = input[name];
    if (!t || typeof t !== 'object') throw new Error('模板 ' + name + ' 格式不正确');
    const title = String(t.title || '').slice(0, 200);
    const content = String(t.content || '').slice(0, 4000);
    if (!title && !content) throw new Error('模板 ' + name + ' 的标题与内容不能同时为空');
    out[name] = { title, content };
  }
  return out;
}

/** Webhook 安全校验：只允许公网 HTTPS，阻止内网地址（SSRF 防护） */
function normalizeWebhook(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length > 2048) throw new Error('Webhook 地址过长');
  let u;
  try { u = new URL(s); } catch (_) { throw new Error('Webhook 必须是合法 URL'); }
  if (u.protocol !== 'https:') throw new Error('Webhook 必须使用 HTTPS');
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) {
    throw new Error('Webhook 不允许指向内网或保留地址');
  }
  return s;
}

function maskWebhook(url) {
  const s = String(url || '');
  if (!s) return '';
  return s
    // query 形态：企业微信 key / 钉钉 access_token 等
    .replace(/([?&](?:key|token|access_token|secret)=)[^&\s]+/gi, '$1***')
    // 路径形态：飞书 /open-apis/bot/v2/hook/<token>，以及通用 /hook/<token>
    .replace(/(\/(?:hook|v2\/hook)\/)[A-Za-z0-9_-]{8,}/gi, '$1***');
}

function defaultChannelConfigs(env) {
  return CHANNEL_IDS.map((id) => ({
    id,
    name: CHANNEL_NAMES[id],
    webhook: id === 'wecom' ? String((env && env.WECOM_WEBHOOK) || '').trim() : '',
    enabled: true,
  }));
}

/** 面板配置优先；未配置过时回退到环境变量（保持旧部署零改动可用） */
async function readChannelConfigs(env) {
  const fallback = defaultChannelConfigs(env);
  try {
    if (!env || !env.NOTIFICATIONS) return fallback;
    const raw = await env.NOTIFICATIONS.get(CHANNELS_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw);
    if (!Array.isArray(stored)) return fallback;
    return fallback.map((d) => {
      const s = stored.find((x) => x && x.id === d.id) || {};
      return {
        id: d.id,
        name: d.name,
        webhook: typeof s.webhook === 'string' ? s.webhook : '',
        enabled: s.enabled !== false,
      };
    });
  } catch (_) {
    return fallback;
  }
}

function normalizeChannelConfigs(input) {
  if (!Array.isArray(input)) throw new Error('渠道配置必须是数组');
  if (input.length > CHANNEL_IDS.length) throw new Error('渠道数量超出上限');
  const out = [];
  for (const item of input) {
    if (!item || CHANNEL_IDS.indexOf(item.id) < 0) throw new Error('不支持的渠道');
    if (out.some((x) => x.id === item.id)) throw new Error('渠道不能重复');
    out.push({
      id: item.id,
      name: CHANNEL_NAMES[item.id],
      webhook: normalizeWebhook(item.webhook),
      enabled: item.enabled !== false,
    });
  }
  return out;
}

/** 幂等：从 Header / query / body 中取幂等键并做长度限制 */
function getIdempotencyKey(meta, data) {
  const fromMeta = meta && meta.idempotencyKey;
  const raw = fromMeta || (data && (data.idempotency_key || data.idempotencyKey));
  const key = String(raw || '').trim();
  return key.length <= 200 ? key : '';
}

async function readIdempotency(env, key) {
  if (!key || !env || !env.NOTIFICATIONS) return null;
  try {
    const raw = await env.NOTIFICATIONS.get(IDEM_PREFIX + await sha256Hex(key));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch (_) {
    return null;
  }
}

async function writeIdempotency(env, key, status, body) {
  if (!key || !env || !env.NOTIFICATIONS) return;
  try {
    await env.NOTIFICATIONS.put(
      IDEM_PREFIX + await sha256Hex(key),
      JSON.stringify({ status, body, at: Date.now() }),
      { expirationTtl: IDEM_TTL_SECONDS }
    );
  } catch (e) {
    console.warn('[notify] idempotency write failed:', e && e.message ? e.message : e);
  }
}

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

function sanitizeRichHtml(content) {
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
function stripTagsText(content, maxLen = 220) {
  let s = String(content || '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|blockquote|pre|h[1-6]|li|tr|ul|ol)>/gi, '\n');
  s = s.replace(/<[a-zA-Z/!][^>]*>/g, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, maxLen);
}

/** HTML → 企业微信 markdown：加粗/斜体/行内代码/链接/换行转换，其余标签剥离后解码实体 */
function htmlToMarkdown(content) {
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
function decorateMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const content = String(m.content || '');
  return Object.assign({}, m, {
    isRich: looksLikeHtml(content),
    contentHtml: sanitizeRichHtml(content),
    previewText: stripTagsText(content),
  });
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
  // 历史消息自动过期，防止免费版 KV 1GB 上限被长期累积的消息占满。
  // 默认 90 天，可通过 MESSAGE_TTL_DAYS 变量调整（1～365 天）。
  const ttlDays = Math.max(1, Math.min(365, Number((env && env.MESSAGE_TTL_DAYS) || 90) || 90));
  await env.NOTIFICATIONS.put(key, JSON.stringify(message), {
    metadata: { id: message.id, timestamp: message.timestamp },
    expirationTtl: ttlDays * 86400,
  });
  await bumpVersion(env);
  return message;
}

/** 按消息 ID 找到 KV key（key 内嵌 id，避免逐条 getValue 消耗读额度） */
async function findMessageKey(env, id) {
  const target = String(id || '');
  if (!target || !/^[A-Za-z0-9-]{1,40}$/.test(target)) return null;
  let cursor;
  do {
    const result = await env.NOTIFICATIONS.list({ prefix: PREFIX, cursor, limit: 1000 });
    const hit = result.keys.find((k) => k.name.endsWith('-' + target));
    if (hit) return hit.name;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return null;
}

/** 删除单条消息；返回是否命中 */
async function deleteMessage(env, id) {
  const key = await findMessageKey(env, id);
  if (!key) return false;
  await env.NOTIFICATIONS.delete(key);
  await bumpVersion(env);
  return true;
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

// ============================== L6 多租户准备 ==============================
// 租户注册表存在账号级 KV（不经 scopeEnv 包装）；租户自己的消息/配置/审计
// 全部通过 scopeEnv 加 `t:<id>:` 前缀，做到数据、密钥、配额三层隔离。
const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

function normalizeTenant(input, existing) {
  const src = Object.assign({}, existing || {}, input || {});
  const id = String(src.id || '').trim().toLowerCase();
  if (!TENANT_ID_RE.test(id)) throw new Error('租户 ID 需为 2-32 位小写字母、数字、下划线或短横线');
  const out = {
    id,
    name: String(src.name || id).slice(0, 60),
    sendKey: src.sendKey == null ? '' : String(src.sendKey).slice(0, 200),
    readToken: src.readToken == null ? '' : String(src.readToken).slice(0, 200),
    enabled: src.enabled !== false,
    dailyQuota: Math.max(1, Math.min(100000, Number(src.dailyQuota || 200) || 200)),
    plan: String(src.plan || 'free').slice(0, 40),
    status: String(src.status || 'active').slice(0, 40),
    createdAt: existing && existing.createdAt ? existing.createdAt : Date.now(),
  };
  return out;
}

function publicTenant(t, used) {
  return {
    id: t.id, name: t.name, enabled: t.enabled, dailyQuota: t.dailyQuota,
    plan: t.plan, status: t.status, createdAt: t.createdAt,
    sendKeySet: Boolean(t.sendKey), readTokenSet: Boolean(t.readToken),
    usedToday: used || 0,
  };
}

async function readTenants(env) {
  try {
    const raw = await env.NOTIFICATIONS.get(TENANTS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && Array.isArray(v.items) ? v.items : [];
  } catch (_) { return []; }
}

async function writeTenants(env, items) {
  await env.NOTIFICATIONS.put(TENANTS_KEY, JSON.stringify({ items }));
  await bumpVersion(env);
}

function tenantPrefix(id) {
  return id && id !== 'default' ? 't:' + id + ':' : '';
}

/** 生成租户作用域 env：KV 键加前缀，SEND_TOKEN / READ_TOKEN 替换为租户自己的密钥。 */
function scopeEnv(env, tenantId, tenant) {
  const prefix = tenantPrefix(tenantId);
  const base = env.NOTIFICATIONS;
  const scoped = Object.assign({}, env);
  scoped.__raw = env;
  scoped.TENANT_ID = tenantId || '';
  if (!prefix) return scoped;
  scoped.NOTIFICATIONS = {
    async get(k, o) { return base.get(prefix + k, o); },
    async put(k, v, o) { return base.put(prefix + k, v, o); },
    async delete(k) { return base.delete(prefix + k); },
    async list(o) {
      const opt = Object.assign({}, o || {});
      opt.prefix = prefix + (opt.prefix || '');
      const r = await base.list(opt);
      return Object.assign({}, r, {
        keys: (r.keys || []).map((k) => Object.assign({}, k, {
          name: k.name.indexOf(prefix) === 0 ? k.name.slice(prefix.length) : k.name,
        })),
      });
    },
  };
  if (tenant) {
    if (tenant.sendKey) scoped.SEND_TOKEN = tenant.sendKey;
    if (tenant.readToken) scoped.READ_TOKEN = tenant.readToken;
  }
  return scoped;
}

function quotaKey(tenantId, ts) {
  const day = new Date(Number(ts) + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return TENANT_QUOTA_PREFIX + tenantId + ':' + day;
}

async function tenantQuotaUsage(env, tenantId) {
  if (!tenantId || tenantId === 'default') return 0;
  const raw = await (env.__raw || env).NOTIFICATIONS.get(quotaKey(tenantId, Date.now()));
  return Math.max(0, Number(raw || 0) || 0);
}

/** 发送前调用：租户校验 + 日配额计数（TTL 48h，跨天后自然归零）。 */
async function checkTenantQuota(env) {
  const id = env.TENANT_ID || '';
  if (!id || id === 'default') return null;
  const base = env.__raw || env;
  const tenants = await readTenants(base);
  const t = tenants.find((x) => x.id === id);
  if (!t || !t.enabled || t.status !== 'active') {
    return json({ ok: false, error: '租户未启用或已停用' }, 403);
  }
  const used = await tenantQuotaUsage(env, id);
  if (used >= t.dailyQuota) {
    return json({ ok: false, error: '租户当日发送配额已用完', quota: t.dailyQuota, used }, 429);
  }
  await base.NOTIFICATIONS.put(quotaKey(id, Date.now()), String(used + 1), { expirationTtl: 172800 });
  return null;
}

async function resolveTenantContext(env, request, url) {
  const raw = String(request.headers.get('X-Tenant-ID') || url.searchParams.get('tenant') || '').trim().toLowerCase();
  if (!raw || raw === 'default') return { env, tenantId: '', tenant: null, error: null };
  if (!TENANT_ID_RE.test(raw)) {
    return { env, tenantId: raw, tenant: null, error: json({ ok: false, error: 'invalid tenant id' }, 400) };
  }
  const list = await readTenants(env);
  const found = list.find((x) => x.id === raw);
  if (!found) return { env, tenantId: raw, tenant: null, error: json({ ok: false, error: '未知租户' }, 404) };
  if (!found.enabled || found.status !== 'active') {
    return { env, tenantId: raw, tenant: null, error: json({ ok: false, error: '租户已停用' }, 403) };
  }
  return { env: scopeEnv(env, raw, found), tenantId: raw, tenant: found, error: null };
}

// ============================== 企业微信推送 ==============================
/** 毫秒时间戳 → 北京时间字符串（固定 UTC+8，不依赖 Intl 时区数据） */
function fmtWecomTime(ts) {
  return new Date(Number(ts) + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// ---- 投递可观测性：单 KV key 环形缓冲（省免费写额度）+ 失败告警 ----
const DELIVERY_KEY = 'meta:delivery';
const DELIVERY_MAX = 30;
const ALERT_THRESHOLD = 3;          // 连续失败 N 次触发告警
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 告警静默窗口，防刷屏

/** 错误脱敏：去掉完整 URL、query key/token、控制字符，绝不让 Webhook key 进日志或 KV */
function sanitizePushError(err, env) {
  let s = err == null ? '' : (typeof err === 'string' ? err : (err.message || String(err)));
  try {
    const wh = String((env && env.WECOM_WEBHOOK) || '').trim();
    if (wh) s = s.split(wh).join('[webhook]');
  } catch (_) { /* ignore */ }
  s = s.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
       .replace(/([?&](?:key|token|sendkey|access_token)=)[^&\s"']+/gi, '$1***')
       .replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.slice(0, 240) || 'unknown error';
}

/** 读投递日志；任何异常都退化为空，绝不影响主流程 */
async function readDeliveryLog(env) {
  try {
    const raw = await env.NOTIFICATIONS.get(DELIVERY_KEY);
    if (!raw) return { items: [], lastAlertAt: 0 };
    const v = JSON.parse(raw);
    if (!v || !Array.isArray(v.items)) return { items: [], lastAlertAt: 0 };
    return { items: v.items.slice(0, DELIVERY_MAX), lastAlertAt: Number(v.lastAlertAt) || 0 };
  } catch (_) {
    return { items: [], lastAlertAt: 0 };
  }
}

async function writeDeliveryLog(env, log) {
  try {
    await env.NOTIFICATIONS.put(DELIVERY_KEY, JSON.stringify({
      items: (log.items || []).slice(0, DELIVERY_MAX),
      lastAlertAt: Number(log.lastAlertAt) || 0,
    }));
  } catch (e) {
    console.warn('[notify] delivery log write failed:', e && e.message ? e.message : e);
  }
}

async function recordDelivery(env, entry) {
  const log = await readDeliveryLog(env);
  log.items.unshift(entry);
  log.items = log.items.slice(0, DELIVERY_MAX);
  await writeDeliveryLog(env, log);
  return log;
}

/** 从最新一条往前数连续失败次数 */
function consecutiveFailures(items) {
  let n = 0;
  for (const it of items || []) {
    if (it && it.ok === false) n++;
    else break;
  }
  return n;
}

/**
 * 连续失败达到阈值且过了静默窗口时，写一条系统告警消息到通知中心。
 * 关键：告警直接 saveMessage，不经过 pushToWecom —— 天然防环（告警不会再触发告警）。
 */
async function maybeAlertWecom(env, log, watchedItems) {
  const fails = consecutiveFailures(watchedItems || log.items);
  if (fails < ALERT_THRESHOLD) return;
  const now = Date.now();
  if (log.lastAlertAt && now - log.lastAlertAt < ALERT_COOLDOWN_MS) return;
  const lastErr = ((log.items || []).find((x) => x && x.error) || {}).error || 'unknown error';
  log.lastAlertAt = now;
  await writeDeliveryLog(env, log); // 先落告警时间，防并发重复告警
  try {
    await saveMessage(env, {
      title: '⚠️ 企业微信推送失败告警',
      content: '连续 ' + fails + ' 次推送失败。最近错误：' + lastErr +
        '。请检查 WECOM_WEBHOOK 配置、群机器人是否有效、是否被限流（群机器人约 20 条/分钟）。' +
        '本告警直接进入通知中心，不会再次触发推送。',
      type: 'text',
      source: 'system/alert',
    });
    console.warn('[notify] wecom failure alert sent, consecutive=' + fails);
  } catch (e) {
    console.warn('[notify] wecom failure alert failed:', e && e.message ? e.message : e);
  }
}

/** 供 /api/status 使用的投递摘要（已鉴权端点，字段均已脱敏） */
async function readDeliverySummary(env) {
  const log = await readDeliveryLog(env);
  const items = log.items || [];
  const last = items[0] || null;
  const lastOk = items.find((x) => x && x.ok === true) || null;
  return {
    lastAt: last ? last.ts : 0,
    lastOkAt: lastOk ? lastOk.ts : 0,
    lastError: last && last.ok === false ? (last.error || '') : '',
    consecutiveFailures: consecutiveFailures(items),
    recentFailures: items.filter((x) => x && x.ok === false).length,
    sampled: items.length,
    recent: items.slice(0, 10).map((x) => ({
      ts: x.ts, ok: x.ok, source: x.source || '', error: x.error || '',
    })),
  };
}

/**
 * 统一渠道发送接口（C1）。所有渠道返回同构结果：
 *   { id, name, configured, ok, skipped?, error?, ms? }
 * 新增渠道只需在这里加一个分支 + 在 CHANNEL_IDS 注册，核心流程无需改动。
 */
async function sendChannel(channel, message, env) {
  const id = channel.id;
  const name = channel.name || CHANNEL_NAMES[id] || id;
  const webhook = String(channel.webhook || '').trim();
  if (!webhook) return { id, name, configured: false, ok: false, skipped: true };

  // 正文先做 HTML→markdown 转换，避免群聊里出现字面 HTML 标签碎片。
  const title = stripTagsText(message.title || '', 100) || '（无标题）';
  const body = htmlToMarkdown(message.content).slice(0, 1000);
  const meta = String(message.source || 'api').slice(0, 60) + ' · ' + fmtWecomTime(message.timestamp || Date.now());

  let payload;
  if (id === 'wecom') {
    payload = {
      msgtype: 'markdown',
      markdown: { content: '**' + title + '**' + (body ? '\n' + body : '') + '\n> ' + meta },
    };
  } else if (id === 'dingtalk') {
    // 钉钉 markdown 不支持 '>' 引用块，元信息改为普通行；title 为 markdown 类型必填字段。
    payload = {
      msgtype: 'markdown',
      markdown: { title: title.slice(0, 80), text: '### ' + title + '\n\n' + body + '\n\n' + meta },
    };
  } else if (id === 'feishu') {
    // 飞书自定义机器人：交互式卡片，视觉层级优于纯文本。
    payload = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: title.slice(0, 100) }, template: 'blue' },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: body || '（无正文）' } },
          { tag: 'hr' },
          { tag: 'note', elements: [{ tag: 'plain_text', content: meta }] },
        ],
      },
    };
  } else {
    return { id, name, configured: false, ok: false, error: 'unsupported channel' };
  }

  let result;
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    let p = {};
    try { p = await res.json(); } catch (_) { /* 部分机器人异常时返回非 JSON */ }
    const ok = res.ok && (id === 'feishu' ? (p.code === 0 || p.StatusCode === 0) : p.errcode === 0);
    result = ok
      ? { id, name, configured: true, ok: true }
      : { id, name, configured: true, ok: false, error: sanitizePushError(p.errmsg || p.msg || ('HTTP ' + res.status), env) };
  } catch (err) {
    result = { id, name, configured: true, ok: false, error: sanitizePushError(err, env) };
  }
  return result;
}

/**
 * 分发到所有已启用且已配置的渠道（C1/C4/C6）。
 * - 静默时段内只跳过外发渠道，消息仍正常落库；
 * - 各渠道并行发送，单个失败不影响其他渠道；
 * - 统一写入脱敏投递日志，企业微信连续失败时触发系统告警（防环）。
 * 返回 { channels, wecom, silenced }，其中 wecom 保持旧结构向后兼容。
 */
async function dispatchChannels(env, message) {
  const configs = await readChannelConfigs(env);
  const settings = await readSettings(env);
  const silenced = isQuietNow(settings);
  const quietIds = settings.quietChannels || [];
  const targets = configs.filter((c) => c.enabled !== false && c.webhook && (!silenced || quietIds.indexOf(c.id) < 0));
  const skippedOf = (c) => ({
    id: c.id,
    name: c.name || CHANNEL_NAMES[c.id] || c.id,
    configured: false,
    ok: false,
    skipped: true,
    silenced: silenced && quietIds.indexOf(c.id) >= 0,
  });

  if (!targets.length) {
    return {
      channels: configs.map(skippedOf),
      wecom: Object.assign(skippedOf(configs.find((c) => c.id === 'wecom') || { id: 'wecom' }), { silenced }),
      silenced,
    };
  }

  const results = await Promise.all(targets.map(async (c) => {
    const t0 = Date.now();
    const r = await sendChannel(c, message, env);
    r.ms = Date.now() - t0;
    return r;
  }));

  try {
    const log = await readDeliveryLog(env);
    for (const r of results) {
      log.items.unshift({
        ts: Date.now(),
        ms: r.ms || 0,
        ok: r.ok,
        channel: r.id,
        source: String((message && message.source) || 'api').slice(0, 60),
        eventId: String((message && message.id) || ''),
        error: r.ok ? '' : String(r.error || '').slice(0, 240),
      });
    }
    log.items = log.items.slice(0, DELIVERY_MAX);
    await writeDeliveryLog(env, log);
    const wecom = results.find((r) => r.id === 'wecom');
    if (wecom && wecom.ok === false) {
      // 只看企微记录，避免其他渠道失败误触发企微告警
      const wecomItems = log.items.filter((x) => !x.channel || x.channel === 'wecom');
      await maybeAlertWecom(env, log, wecomItems);
    }
  } catch (e) {
    console.warn('[notify] delivery bookkeeping failed:', e && e.message ? e.message : e);
  }

  return {
    channels: configs.map((c) => results.find((r) => r.id === c.id) || skippedOf(c)),
    wecom: results.find((r) => r.id === 'wecom') || skippedOf({ id: 'wecom', name: '企业微信' }),
    silenced,
  };
}

/** 兼容旧调用方（RouterHook DO / 测试端点）：仍返回旧的 wecom 结构 */
async function pushToWecom(env, message) {
  const result = await dispatchChannels(env, message);
  return result.wecom;
}

// ============================== RouterHook 兼容模块 ==============================
// 说明：字段以 RouterHook 实际源码（sdlyfjx/rogsoft RouterHook 分支）为准。
// 普通事件靠 body.msgTYPE 识别；虚拟传感器 body 无 msgTYPE，只能靠 URL 路径事件名识别。
// 所有内容最终都会经过 decorateMessage → sanitizeRichHtml 白名单消毒后再进 innerHTML，
// 因此这里拼接的白名单标签（h3/div/hr/pre/code）会被保留，其它一切内容（含注入）会被转义为文本。

const RH_MAX_JSON_CHARS = 12000;
const RH_EVENT_TITLE = {
  manuINFO: '手动状态报告',
  cronINFO: '定时状态报告',
  ifUP: '网络重拨通知',
  newDHCP: '新设备上线',
};
const RH_SENSOR_NAME = {
  rh_load: '系统负载',
  rh_mem_free: '空闲内存',
  rh_swap_free: '空闲 SWAP',
  rh_cpu_temp: 'CPU 温度',
  rh_24g_temp: '2.4G 温度',
  rh_5g1_temp: '5G-1 温度',
  rh_dev: '聚合设备在线状态',
};

/** 安全文本化：null/undefined/空串返回空；对象转 JSON；布尔转 true/false */
function rhText(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback == null ? '' : String(fallback);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (_) { return ''; }
  }
  return String(v);
}

/** 设备标识规范化：保留原始名称用于展示，同时生成安全 key（仅字母数字_-.） */
function rhDeviceKey(raw) {
  const s = rhText(raw, '').trim() || 'Router';
  const safe = s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 64);
  return { display: s.slice(0, 80), key: safe || 'Router' };
}

/** 解析设备标识：URL device 参数优先 → sysINFO.routerNAME → 默认 Router */
function rhResolveDevice(event, body, url) {
  const fromUrl = url.searchParams.get('device');
  const fromBody = body && body.sysINFO ? body.sysINFO.routerNAME : null;
  return rhDeviceKey(fromUrl || fromBody || 'Router');
}

function rhLine(label, value) {
  const s = rhText(value);
  return s ? '<div>' + label + '：' + s + '</div>' : '';
}

function rhSection(title, lines) {
  const body = lines.filter(Boolean).join('');
  return body ? '<h3>【' + title + '】</h3>' + body : '';
}

/** 完整原始 JSON：缩进展示，超长截断；内容交给 sanitizeRichHtml 统一消毒 */
function rhRawJson(obj) {
  let s;
  try { s = JSON.stringify(obj, null, 2); } catch (_) { s = rhText(obj); }
  if (!s) return '';
  if (s.length > RH_MAX_JSON_CHARS) s = s.slice(0, RH_MAX_JSON_CHARS) + '\n…（原始 JSON 过长，已截断）';
  return '<hr><h3>【完整原始 JSON】</h3><pre><code>' + s + '</code></pre>';
}

/** WAN / netSTATE 数组（兼容多 WAN） */
function rhWanLines(wans) {
  const arr = Array.isArray(wans) ? wans : (wans ? [wans] : []);
  const out = [];
  arr.forEach((w, i) => {
    if (!w || typeof w !== 'object') return;
    const tag = arr.length > 1 ? 'WAN' + i : 'WAN';
    if (rhText(w.proto)) out.push(rhLine(tag + ' 连接协议', w.proto));
    if (rhText(w.pubIPv4)) out.push(rhLine(tag + ' 公网 IPv4', w.pubIPv4));
    if (rhText(w.pubIPv6)) out.push(rhLine(tag + ' 公网 IPv6', w.pubIPv6));
    if (rhText(w.wanIPv4)) out.push(rhLine(tag + ' WAN IPv4', w.wanIPv4));
    if (Array.isArray(w.wanDNS) && w.wanDNS.some(rhText)) out.push(rhLine(tag + ' DNS', w.wanDNS.filter(rhText).join('、')));
    if (rhText(w.wanRX)) out.push(rhLine(tag + ' 接收流量', w.wanRX));
    if (rhText(w.wanTX)) out.push(rhLine(tag + ' 发送流量', w.wanTX));
  });
  return out;
}

/** 客户端 / DHCP 租期列表 */
function rhClientLines(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const out = [];
  list.forEach((c) => {
    if (!c || typeof c !== 'object') return;
    const parts = [];
    if (rhText(c.name)) parts.push('名称：' + rhText(c.name));
    if (rhText(c.ip)) parts.push('IP：' + rhText(c.ip));
    if (rhText(c.mac)) parts.push('MAC：' + rhText(c.mac));
    if (parts.length) out.push('<div>' + parts.join('　') + '</div>');
  });
  return out;
}

/** manuINFO / cronINFO 中文摘要（字段不存在不显示，不虚构数据） */
function formatRhStatus(body, device, isCron) {
  const sys = body.sysINFO && typeof body.sysINFO === 'object' ? body.sysINFO : {};
  const temp = body.tempINFO && typeof body.tempINFO === 'object' ? body.tempINFO : {};
  const net = body.netINFO && typeof body.netINFO === 'object' ? body.netINFO : {};
  const basic = [];
  basic.push(rhLine('设备名称', sys.routerNAME || device.display));
  basic.push(rhLine('当前时间', sys.routerTIME));
  basic.push(rhLine('固件版本', sys.routerFIRMWARE));
  basic.push(rhLine('工作模式', sys.routerMODE));
  basic.push(rhLine('运行时间', sys.routerUPTIME));
  if (Array.isArray(sys.routerAVGLOAD)) {
    const lbl = ['系统负载(1min)', '系统负载(5min)', '系统负载(15min)'];
    sys.routerAVGLOAD.forEach((v, i) => basic.push(rhLine(lbl[i] || ('系统负载' + i), v)));
  }
  if (sys.routerMEM && typeof sys.routerMEM === 'object') {
    const unit = rhText(sys.routerMEM.unit, '');
    basic.push(rhLine('内存全部', rhText(sys.routerMEM.all) ? rhText(sys.routerMEM.all) + unit : ''));
    basic.push(rhLine('内存空闲', rhText(sys.routerMEM.free) ? rhText(sys.routerMEM.free) + unit : ''));
  }
  if (sys.routerSWAP && typeof sys.routerSWAP === 'object') {
    basic.push(rhLine('SWAP 空闲', sys.routerSWAP.free));
    basic.push(rhLine('SWAP 全部', sys.routerSWAP.total));
  }
  if (sys.routerJFFS && typeof sys.routerJFFS === 'object') {
    basic.push(rhLine('JFFS 已用', sys.routerJFFS.used));
    basic.push(rhLine('JFFS 全部', sys.routerJFFS.total));
    basic.push(rhLine('JFFS 可用', sys.routerJFFS.available));
    basic.push(rhLine('JFFS 使用率', sys.routerJFFS.use));
  }
  const temps = [];
  const tu = rhText(temp.unit, '');
  temps.push(rhLine('CPU 温度', rhText(temp.CPU) ? rhText(temp.CPU) + tu : ''));
  temps.push(rhLine('2.4G 温度', rhText(temp['24G']) ? rhText(temp['24G']) + tu : ''));
  temps.push(rhLine('5G-1 温度', rhText(temp['5G1']) ? rhText(temp['5G1']) + tu : ''));
  temps.push(rhLine('5G-2 温度', rhText(temp['5G2']) ? rhText(temp['5G2']) + tu : ''));
  const network = rhWanLines(net.WAN);
  network.push(rhLine('DDNS', net.DDNS));
  network.push(rhLine('国内网络', net.chinaSTATUS));
  network.push(rhLine('国外网络', net.foreignSTATUS));
  network.push(rhLine('LAN IP', net.routerLANIP));
  if (net.wifiINFO && typeof net.wifiINFO === 'object') {
    Object.keys(net.wifiINFO).forEach((k) => {
      if (k === 'end') return;
      network.push(rhLine('WiFi ' + k, net.wifiINFO[k]));
    });
  }
  if (net.guestINFO && typeof net.guestINFO === 'object') {
    Object.keys(net.guestINFO).forEach((k) => {
      if (k === 'end') return;
      network.push(rhLine('访客 WiFi ' + k, net.guestINFO[k]));
    });
  }
  const usb = [];
  if (Array.isArray(body.usbINFO)) {
    body.usbINFO.forEach((u, i) => {
      if (!u || typeof u !== 'object' || !Object.keys(u).length) return;
      const tag = 'USB' + (i + 1);
      usb.push(rhLine(tag + ' 设备', u.name));
      usb.push(rhLine(tag + ' 挂载状态', u.status));
      usb.push(rhLine(tag + ' 总容量', u.total));
      usb.push(rhLine(tag + ' 已使用', u.used));
      usb.push(rhLine(tag + ' 剩余容量', u.free));
      usb.push(rhLine(tag + ' 使用率', u.use));
    });
  }
  const clients = rhClientLines(body.cliINFO);
  const dhcp = rhClientLines(body.dhcpINFO);
  const countLine = (arr, label) => (Array.isArray(arr) && arr.length ? '<div>' + label + '：' + arr.length + '</div>' : '');
  let content = rhSection('设备基本信息', basic)
    + rhSection('温度信息', temps)
    + rhSection('网络信息', network)
    + rhSection('USB 信息', usb)
    + countLine(body.cliINFO, '在线设备数量') + rhSection('在线客户端', clients)
    + countLine(body.dhcpINFO, 'DHCP 租期设备数量') + rhSection('DHCP 租期列表', dhcp)
    + rhRawJson(body);
  return {
    title: device.display + ' · ' + (isCron ? '定时状态报告' : '手动状态报告'),
    content,
    source: 'RouterHook/' + device.key,
    isSensor: false,
  };
}

/** ifUP 网络重拨（兼容 netSTATE 多 WAN 数组） */
function formatRhIfUp(body, device) {
  const lines = [];
  lines.push(rhLine('重拨时间', body.rebootTIME));
  lines.push(rhLine('路由器运行时间', body.upTIME || body.value1));
  const network = rhWanLines(body.netSTATE);
  let content = rhSection('网络重拨', lines) + rhSection('网络状态', network) + rhRawJson(body);
  return { title: device.display + ' · 网络重拨通知', content, source: 'RouterHook/' + device.key, isSensor: false };
}

/** newDHCP 新设备上线 */
function formatRhNewDhcp(body, device) {
  const lines = [];
  lines.push(rhLine('新设备名称', body.cliNAME || body.value1));
  lines.push(rhLine('设备 IP', body.cliIP || body.value2));
  lines.push(rhLine('设备 MAC', body.cliMAC || body.value3));
  lines.push(rhLine('上线时间', body.upTIME));
  lines.push(rhLine('DHCP 到期时间', body.expTIME));
  let content = rhSection('新设备上线', lines);
  if (Array.isArray(body.cliLISTS) && body.cliLISTS.length) {
    content += '<div>当前 DHCP 租期内设备数量：' + body.cliLISTS.length + '</div>'
      + rhSection('DHCP 租期列表', rhClientLines(body.cliLISTS));
  }
  content += rhRawJson(body);
  return { title: device.display + ' · 新设备上线', content, source: 'RouterHook/' + device.key, isSensor: false };
}

/** 未知普通事件：通用接收，不丢弃有效数据 */
function formatRhUnknown(event, body, device) {
  const content = '<div>收到 RouterHook 事件：' + event + '</div>' + rhRawJson(body);
  return { title: device.display + ' · ' + event, content, source: 'RouterHook/' + device.key, isSensor: false };
}

/**
 * 解析传感器字段（供单条降级与 DO 聚合共用）。
 * 状态：state 优先 → value1；单位：attributes.unit_of_measurement → value2；名称：friendly_name → value3 → 事件映射。
 * ON/OFF 转为中文"在线/离线"，不当普通数值处理。
 */
function parseRhSensor(event, body) {
  const attrs = body.attributes && typeof body.attributes === 'object' ? body.attributes : {};
  let state = body.state !== undefined && body.state !== null && body.state !== '' ? body.state : body.value1;
  const rawState = rhText(state);
  const isOnOff = /^on$/i.test(rawState) || /^off$/i.test(rawState);
  const displayState = isOnOff ? (/^on$/i.test(rawState) ? '在线' : '离线') : rawState;
  const unit = rhText(attrs.unit_of_measurement) || rhText(body.value2);
  const name = rhText(attrs.friendly_name) || rhText(body.value3)
    || RH_SENSOR_NAME[event]
    || (event.indexOf('rh_dev_') === 0 ? '设备在线状态' : event);
  return {
    event,
    name,
    state, // 保留原始类型（数字/字符串/布尔），聚合比较与展示分离
    stateText: rawState,
    displayState,
    isOnOff,
    unit,
    friendlyName: rhText(attrs.friendly_name),
    raw: body,
    ts: Date.now(),
  };
}

function sensorDisplay(s) {
  return s.displayState + (s.unit ? ' ' + s.unit : '');
}

/** 传感器分组：系统状态 / 温度状态 / 设备在线状态 / 其它 */
function rhSensorGroup(s) {
  if (/_temp$/.test(s.event)) return '温度状态';
  if (s.event === 'rh_dev' || s.event.indexOf('rh_dev_') === 0) return '设备在线状态';
  if (s.event === 'rh_load' || s.event === 'rh_mem_free' || s.event === 'rh_swap_free') return '系统状态';
  return '其它传感器';
}

/** 传感器汇总正文（DO Alarm 到期时生成，供单条降级也复用） */
function formatRhSensorSummary(sensors, device, windowStart) {
  const groups = {};
  sensors.forEach((s) => {
    const g = rhSensorGroup(s);
    (groups[g] = groups[g] || []).push(s);
  });
  const order = ['系统状态', '温度状态', '设备在线状态', '其它传感器'];
  let content = '';
  order.forEach((g) => {
    const list = groups[g];
    if (!list || !list.length) return;
    const lines = list.map((s) => {
      // rh_load 有 1min/5min/15min 三种单位，用 unit 区分标签避免互相覆盖
      const label = s.event === 'rh_load' && s.unit ? '系统负载(' + s.unit + ')' : (s.friendlyName || s.name);
      return rhLine(label, sensorDisplay(s));
    });
    content += rhSection(g, lines);
  });
  if (windowStart) content += rhSection('更新时间', ['<div>聚合窗口开始：' + new Date(windowStart).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '</div>']);
  const rawLines = sensors.map((s) => '<h3>【' + (s.friendlyName || s.name) + ' · 原始 JSON】</h3><pre><code>'
    + (() => { let j; try { j = JSON.stringify(s.raw, null, 2); } catch (_) { j = rhText(s.raw); } return j.length > RH_MAX_JSON_CHARS ? j.slice(0, RH_MAX_JSON_CHARS) : j; })()
    + '</code></pre>');
  content += '<hr><h3>【完整传感器 JSON】</h3>' + rawLines.join('');
  return { title: device.display + ' · 传感器状态汇总', content, source: 'RouterHook/' + device.key + '/Sensors', isSensor: true };
}

/** 单条传感器降级（未绑定 DO 时使用，避免数据丢失） */
function formatRhSensorSingle(s, device) {
  return {
    title: device.display + ' · ' + s.name,
    content: rhSection('传感器状态', [rhLine(s.friendlyName || s.name, sensorDisplay(s))])
      + rhSection('更新时间', ['<div>' + new Date(s.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '</div>'])
      + rhRawJson(s.raw),
    source: 'RouterHook/' + device.key + '/Sensors',
    isSensor: true,
  };
}

// ============================== 请求处理 ==============================
class BodyTooLargeError extends Error {}

/** 请求体解析：限制最大 256KB，避免大 body 消耗 CPU 与内存 */
async function parseBody(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > 262144) throw new BodyTooLargeError('request body too large');
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const text = await request.text();
    if (text.length > 262144) throw new BodyTooLargeError('request body too large');
    try { return JSON.parse(text); } catch { return {}; }
  }
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

/**
 * 变量标签渲染：把文本里的 {name} 占位符替换为实际值。
 * - 内置变量（服务端生成，时区 GMT+8，与用户所在时区一致）：
 *     {date} YYYY-MM-DD、{time} HH:MM:SS、{datetime} YYYY-MM-DD HH:MM:SS、
 *     {timestamp} 秒级 Unix、{timestamp_ms} 毫秒级、{weekday} 中文星期、
 *     {uuid} 随机 UUID、{random} 8 位随机串、{version} 版本号、{source} 来源标识。
 * - 自定义变量：调用方用 v.<name> 或 var.<name> 参数传入，如 &v.title=构建完成；
 *   自定义值优先于同名内置变量，允许覆盖（如 {date} 传业务日期）。
 * - 单次替换：替换值里的 { } 不会被二次解析，避免递归注入。
 * - 未匹配占位符原样保留，保证正文里字面花括号（如 JSON 片段）不被破坏。
 * - 自定义值长度上限，防止滥用；移除控制字符，降低注入风险。
 */
const VAR_BUILTIN = Object.freeze({
  date: (d) => fmt8(d, 'date'),
  time: (d) => fmt8(d, 'time'),
  datetime: (d) => fmt8(d, 'datetime'),
  timestamp: (d) => String(Math.floor(d.getTime() / 1000)),
  timestamp_ms: (d) => String(d.getTime()),
  weekday: (d) => '星期' + '日一二三四五六'[shift8(d).getUTCDay()],
  uuid: () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : generateId(),
  random: () => Math.random().toString(36).slice(2, 10).padEnd(8, '0'),
  version: () => VERSION,
});
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAR_TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const VAR_VALUE_MAX = 500;

/** 把 Date 换算到 GMT+8 后取 UTC 字段（Workers 恒定 UTC，手动平移避免依赖运行环境时区） */
function shift8(date) {
  return new Date(date.getTime() + 8 * 3600 * 1000);
}
function fmt8(date, kind) {
  const d = shift8(date);
  const p = (n) => String(n).padStart(2, '0');
  const ymd = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  const hms = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
  return kind === 'date' ? ymd : kind === 'time' ? hms : ymd + ' ' + hms;
}

/** 自定义变量值安全化：去控制字符、限长 */
function sanitizeVarValue(val) {
  if (val == null) return null;
  return String(val).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, VAR_VALUE_MAX);
}

/**
 * 提取调用方自定义变量，支持两种写法（后者优先）：
 *   扁平：v.<name> / var.<name>（URL query 与 JSON body 都适用）
 *   嵌套：JSON body 里的 "v": { "<name>": "..." } 或 "var": { ... }
 */
function collectCustomVars(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const ns of ['v', 'var']) {
    const group = data[ns];
    if (group && typeof group === 'object' && !Array.isArray(group)) {
      for (const key of Object.keys(group)) {
        if (!VAR_NAME_RE.test(key)) continue;
        const val = sanitizeVarValue(group[key]);
        if (val !== null) out[key] = val;
      }
    }
  }
  for (const key of Object.keys(data)) {
    const m = /^(?:v|var)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(key);
    if (!m) continue;
    const val = sanitizeVarValue(data[key]);
    if (val !== null) out[m[1]] = val;
  }
  return out;
}

/** 渲染一段文本：内置变量 + 自定义变量，单次替换、未匹配原样保留 */
function renderVars(text, data, now) {
  const src = String(text == null ? '' : text);
  if (src.indexOf('{') === -1) return src; // 无占位符：零开销直通
  const custom = collectCustomVars(data);
  return src.replace(VAR_TOKEN_RE, (full, name) => {
    if (!VAR_NAME_RE.test(name)) return full;
    if (Object.prototype.hasOwnProperty.call(custom, name)) return custom[name];
    if (name === 'source') return String((data && data.source) || 'api');
    if (Object.prototype.hasOwnProperty.call(VAR_BUILTIN, name)) return VAR_BUILTIN[name](now);
    return full;
  });
}

async function createMessage(env, data, meta) {
  const input = data || {};
  const idemKey = getIdempotencyKey(meta, input);
  if (idemKey) {
    const hit = await readIdempotency(env, idemKey);
    if (hit && hit.body) return json(Object.assign({}, hit.body, { idempotent: true }), hit.status || 200);
  }
  // L6：租户日配额在幂等命中之后计数，重放不会重复扣减。
  const quotaLimited = await checkTenantQuota(env);
  if (quotaLimited) return quotaLimited;

  const now = new Date();
  let src = input;
  const templateName = String(input.template || '').trim();
  if (templateName) {
    const templates = await readTemplates(env);
    const tpl = templates[templateName];
    if (!tpl) return json({ ok: false, error: '模板不存在：' + templateName.slice(0, 40) }, 400);
    src = Object.assign({}, input, {
      title: input.title || input.text || tpl.title,
      content: input.content || input.desp || input.body || tpl.content,
    });
  }

  const title = renderVars(String(src.title || src.text || '').trim(), src, now);
  const content = renderVars(String(src.content || src.desp || src.body || '').trim(), src, now);
  if (!title && !content) {
    return json({ ok: false, error: 'title 或 content 至少填写一个' }, 400);
  }
  const message = await saveMessage(env, {
    title: title || '（无标题）',
    content,
    type: src.type || 'text',
    source: src.source || 'api',
  });
  // 并行推送到所有已启用渠道（best-effort：失败不影响消息入库与 API 成功响应）
  const delivery = await dispatchChannels(env, message);
  // 双返回码：errno（方糖）+ code（Server酱³），两种客户端都能判定成功
  const body = {
    ok: true,
    code: 0,
    errno: 0,
    message: '通知已接收',
    data: message,
    wecom: delivery.wecom,
    channels: delivery.channels,
    silenced: delivery.silenced,
  };
  const response = json(body);
  if (idemKey) await writeIdempotency(env, idemKey, 200, body);
  return response;
}

/**
 * 方糖 / Server酱 兼容发送：路径中的 key 为管理主密钥 SEND_TOKEN 或当前轮换密钥。
 * 同时返回 errno（方糖）与 code（Server酱³）以兼容各类客户端判定成功。
 */
async function serverchanSend(env, key, data, meta) {
  const master = String(env.SEND_TOKEN || '').trim();
  const current = await getCurrentSendKey(env);
  if (!master && !current) {
    return json({ code: 1, errno: 1, errmsg: '服务端未设置 SEND_TOKEN，请先配置密钥', message: '服务端未设置 SEND_TOKEN' }, 401);
  }
  // 常量时间比较，避免按字节时序差异猜测密钥
  const masterOk = Boolean(master) && timingSafeEqual(key, master);
  const currentOk = Boolean(current) && timingSafeEqual(key, current);
  if (!masterOk && !currentOk) {
    return json({ code: 1, errno: 1, errmsg: 'key 错误', message: 'invalid key' }, 401);
  }
  const idemKey = getIdempotencyKey(meta, data);
  if (idemKey) {
    const hit = await readIdempotency(env, idemKey);
    if (hit && hit.body) return json(Object.assign({}, hit.body, { idempotent: true }), hit.status || 200);
  }
  const now = new Date();
  const title = renderVars(String(data.title || data.text || '').trim(), data, now);
  const desp = renderVars(String(data.desp || data.content || data.body || '').trim(), data, now);
  if (!title && !desp) {
    return json({ code: 1, errno: 1, errmsg: '标题或正文不能为空', message: 'empty content' }, 400);
  }
  const message = await saveMessage(env, {
    title: title || '（无标题）',
    content: desp,
    type: data.type || 'markdown',
    source: data.source || 'serverchan',
  });
  const delivery = await dispatchChannels(env, message);
  const body = {
    code: 0,
    errno: 0,
    ok: true,
    message: '',
    errmsg: 'success',
    data: {
      pushid: message.id,
      readkey: message.id,
      timestamp: message.timestamp,
      wecom: delivery.wecom,
      channels: delivery.channels,
    },
  };
  if (idemKey) await writeIdempotency(env, idemKey, 200, body);
  return json(body);
}

/**
 * RouterHook 传感器聚合 Durable Object。
 * 每台设备一个实例（idFromName(设备 key)），固定窗口 Alarm（默认 60 秒）：
 * - 首条数据设置一次 Alarm，后续数据只更新状态、不重置窗口（避免持续上报导致永不触发）；
 * - 同种传感器（event + unit）只保留最新值，不同传感器并存；
 * - Alarm 到期生成一条汇总通知，经 saveMessage + pushToWecom 落库推送；
 * - 刷新期间到达的数据进入下一窗口（不丢失）。
 */
// 生产环境（Cloudflare Workers）继承真正的 DurableObject 基类；
// Node 本地测试无该全局，用空类兜底，保证模块可 import。
const DOBase = typeof DurableObject !== 'undefined' ? DurableObject : class {};
export class RouterHookSensorDO extends DOBase {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  /** 聚合窗口秒数，可用 ROUTERHOOK_WINDOW_SECONDS 环境变量覆盖（30/60/120） */
  windowMs() {
    const raw = Number(this.env && this.env.ROUTERHOOK_WINDOW_SECONDS);
    const sec = [30, 60, 120].indexOf(raw) >= 0 ? raw : 60;
    return sec * 1000;
  }

  async fetch(request) {
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
    let input;
    try { input = await request.json(); } catch (_) { return json({ ok: false, error: 'invalid json' }, 400); }
    const sensor = input && input.sensor;
    const deviceRaw = input && input.device;
    if (!sensor || !sensor.event) return json({ ok: false, error: 'missing sensor' }, 400);
    const device = rhDeviceKey(deviceRaw || 'Router');

    // 聚合状态：{ sensors: { "<event>|<unit>": sensor }, windowStart: number }
    const state = (await this.storage.get('agg')) || { sensors: {}, windowStart: 0 };
    const slot = sensor.event + '|' + (sensor.unit || '');
    state.sensors[slot] = sensor; // 同种传感器只保留最新
    if (!state.windowStart) state.windowStart = Date.now();
    await this.storage.put('agg', state);

    const alarm = await this.storage.getAlarm();
    if (alarm === null) await this.storage.setAlarm(Date.now() + this.windowMs());
    return json({ ok: true, success: 'success', aggregated: true, pending: Object.keys(state.sensors).length });
  }

  async alarm() {
    // 防重入：先取走状态并清空，确保同一批数据只推送一次
    const state = (await this.storage.get('agg')) || { sensors: {}, windowStart: 0 };
    await this.storage.delete('agg');
    const sensors = Object.keys(state.sensors).map((k) => state.sensors[k]);
    if (!sensors.length) return;

    try {
      const device = rhDeviceKey(sensors[0] && sensors[0].device || 'Router');
      const formatted = formatRhSensorSummary(sensors, device, state.windowStart);
      const message = await saveMessage(this.env, {
        title: formatted.title,
        content: formatted.content,
        type: 'text',
        source: formatted.source,
      });
      await pushToWecom(this.env, message); // best-effort：失败不影响落库
    } catch (err) {
      // DO Alarm 失败不能丢失原始传感器数据：回写状态，下一窗口重试
      console.error('[routerhook-do] alarm error:', err && err.stack ? err.stack : err);
      const current = (await this.storage.get('agg')) || { sensors: {}, windowStart: 0 };
      sensors.forEach((s) => { current.sensors[s.event + '|' + (s.unit || '')] = s; });
      if (!current.windowStart) current.windowStart = state.windowStart;
      await this.storage.put('agg', current);
      await this.storage.setAlarm(Date.now() + this.windowMs());
    }
  }
}

const VERSION = '2.2.0';

// ============================== L5 开放 API 描述 ==============================
function apiOp(summary, parameters, extra) {
  return Object.assign({
    summary,
    responses: { 200: { description: '成功' }, 400: { description: '参数错误' }, 401: { description: '密钥无效' } },
  }, parameters ? { parameters } : {}, extra || {});
}
const Q_TOKEN = { name: 'token', in: 'query', required: false, description: '发送密钥，可替代 X-Token' };
const Q_TITLE = { name: 'title', in: 'query', required: false, description: '标题（text 为等价别名）' };
const Q_CONTENT = { name: 'content', in: 'query', required: false, description: '正文（desp / body 为等价别名）' };
const Q_FORMAT = { name: 'format', in: 'query', required: false, description: 'json / csv / md，默认 json' };
const Q_LIMIT = { name: 'limit', in: 'query', required: false, description: '条数，1~1000，默认 500' };
const H_TENANT = { name: 'X-Tenant-ID', in: 'header', required: false, description: '租户 ID；不传即默认租户' };
const H_IDEM = { name: 'X-Idempotency-Key', in: 'header', required: false, description: '24 小时幂等键' };

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Cloudflare Notify API',
    version: VERSION,
    description: '自研单文件通知中心。除 /docs 与 /openapi.json 外，所有端点需密钥鉴权；管理类端点仅认管理主密钥 SEND_TOKEN，且只接受 Header/Body，不接受 URL query。',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      XToken: { type: 'apiKey', in: 'header', name: 'X-Token' },
      Bearer: { type: 'http', scheme: 'bearer' },
      QueryToken: { type: 'apiKey', in: 'query', name: 'token' },
    },
  },
  security: [{ XToken: [] }, { Bearer: [] }, { QueryToken: [] }],
  paths: {
    '/api/send': {
      post: apiOp('发送通知（JSON / 表单）', [H_TENANT, H_IDEM], {
        description: 'Body 支持 title/text、content/desp/body、type、source、template 及 v.<name> 自定义变量。',
      }),
      get: apiOp('发送通知（URL 直发）', [Q_TOKEN, Q_TITLE, Q_CONTENT, H_TENANT]),
    },
    '/send': {
      get: apiOp('Server酱 / 方糖兼容发送（GET）', [Q_TOKEN, { name: 'text', in: 'query', required: false, description: '标题' }, { name: 'desp', in: 'query', required: false, description: '正文' }]),
      post: apiOp('Server酱 / 方糖兼容发送（POST 表单）'),
    },
    '/{key}.send': {
      get: apiOp('方糖兼容：密钥写在路径中', [Q_TITLE, Q_CONTENT]),
      post: apiOp('方糖兼容：密钥写在路径中（表单）'),
    },
    '/api/messages': {
      get: apiOp('读取通知列表（支持 version 增量判定）', [H_TENANT, { name: 'limit', in: 'query', required: false, description: '默认 50' }, { name: 'version', in: 'query', required: false, description: '版本号，未变化返回 unchanged' }]),
    },
    '/api/messages/{id}': {
      delete: apiOp('删除单条通知', [H_TENANT], { description: '需要管理权限：管理主密钥或已启用的查看验证。' }),
    },
    '/api/export': {
      get: apiOp('导出通知（JSON / CSV / Markdown）', [Q_FORMAT, Q_LIMIT, H_TENANT]),
    },
    '/api/stats': {
      get: apiOp('统计看板：近 14 天趋势、来源分布、渠道成功率', [H_TENANT]),
    },
    '/api/channels': {
      get: apiOp('读取渠道配置（Webhook 脱敏）', [H_TENANT]),
      put: apiOp('保存渠道配置（管理主密钥）', [H_TENANT]),
    },
    '/api/channels/test': {
      post: apiOp('测试指定渠道连通性（管理主密钥，不可从 URL 传密钥）', [H_TENANT]),
    },
    '/api/test-channel': {
      post: apiOp('测试企微/钉钉/飞书连通性（发送密钥即可）', [H_TENANT, { name: 'id', in: 'query', required: false, description: 'wecom / dingtalk / feishu，默认 wecom；也可放 JSON body' }]),
    },
    '/api/test-wecom': {
      post: apiOp('测试企业微信连通性（旧别名，等同 /api/test-channel?id=wecom）', [H_TENANT]),
    },
    '/api/templates': {
      get: apiOp('读取通知模板', [H_TENANT]),
      put: apiOp('保存通知模板（管理主密钥）', [H_TENANT]),
    },
    '/api/settings': {
      get: apiOp('读取静默时段等设置', [H_TENANT]),
      put: apiOp('保存设置（管理主密钥）', [H_TENANT]),
    },
    '/api/key/rotate': {
      post: apiOp('轮换推送密钥（管理主密钥）', []),
    },
    '/api/routerhook/{event}': {
      post: apiOp('RouterHook 事件接收（响应体含 success）', [H_TENANT, { name: 'device', in: 'query', required: false, description: '设备标识，用于多路由器区分与传感器聚合' }]),
    },
    '/api/tenants': {
      get: apiOp('列出租户（管理主密钥，密钥脱敏）', []),
      post: apiOp('创建租户（管理主密钥）', []),
    },
    '/api/tenants/{id}': {
      put: apiOp('更新租户（管理主密钥）', []),
      delete: apiOp('注销租户（管理主密钥，历史数据保留）', []),
    },
    '/api/tenant': {
      get: apiOp('查询当前租户信息与当日配额', [H_TENANT]),
    },
    '/api/login': {
      post: apiOp('用 READ_TOKEN 换取 HttpOnly 会话 Cookie', []),
    },
  },
};

function renderDocsHtml() {
  const rows = [];
  for (const [p, item] of Object.entries(OPENAPI_SPEC.paths)) {
    for (const [verb, op] of Object.entries(item)) {
      if (['get', 'post', 'put', 'delete'].indexOf(verb) < 0) continue;
      const params = (op.parameters || []).map((x) => x.name).join(', ');
      rows.push('<tr><td><span class="doc-verb ' + verb + '">' + verb.toUpperCase() + '</span></td>' +
        '<td><code>' + escapeHtmlText(p) + '</code></td>' +
        '<td>' + escapeHtmlText(op.summary || '') + '</td>' +
        '<td>' + escapeHtmlText(params || '—') + '</td></tr>');
    }
  }
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
    '<title>API 文档 · Cloudflare Notify</title><style>' + UI_CSS + '</style></head><body>' +
    '<div class="wrap"><header class="top"><div class="brand"><div class="logo">✦</div><div>' +
    '<h1>API 文档</h1><div class="sub">Cloudflare Notify · v' + escapeHtmlText(VERSION) + '</div></div></div>' +
    '<div class="status"><a class="ghost" href="/">返回通知中心</a>' +
    '<a class="ghost" href="/openapi.json">OpenAPI JSON</a></div></header>' +
    '<div class="panel"><section class="section">' +
    '<h2>鉴权方式</h2><p class="tool-note">发送与读取端点接受 <code>X-Token</code> Header、<code>Authorization: Bearer</code> 或 <code>?token=</code>。' +
    '管理类端点（配置、轮换、租户）只认 <code>SEND_TOKEN</code>，且只接受 Header / Body，<b>不接受 URL query</b>，避免主密钥进入日志。' +
    '所有写操作同时支持可选 HMAC 入站签名与 256KB 请求体上限。</p>' +
    '<h2>端点一览</h2><div class="doc-table"><table><thead><tr><th>方法</th><th>路径</th><th>说明</th><th>主要参数</th></tr></thead>' +
    '<tbody>' + rows.join('') + '</tbody></table></div></section></div></div></body></html>';
}

export default {
  async fetch(request, rawEnv) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    // env 是「本次请求作用域」：默认等同 rawEnv；带 X-Tenant-ID / ?tenant= 时
    // 换成租户作用域（KV 前缀 + 租户自己的密钥），下游业务逻辑无需感知。
    let env = rawEnv;
    let tenantId = '';
    let tenant = null;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
    }

    try {
      const resolved = await resolveTenantContext(rawEnv, request, url);
      if (resolved.error) return resolved.error;
      env = resolved.env;
      tenantId = resolved.tenantId;
      tenant = resolved.tenant;

      // ---- 登录 / 退出（会话 Cookie）----
      if (path === '/api/login' && method === 'POST') {
        const ip = clientIp(request);
        if (loginBlocked(ip)) {
          return json({ ok: false, error: '尝试次数过多，请稍后再试' }, 429);
        }
        const body = await parseBody(request);
        const provided = String(body.token || body.readToken || '').trim();
        const expected = String(env.READ_TOKEN || '').trim();
        if (!expected) {
          // 未配置 READ_TOKEN：无需登录，直接放行
          return json({ ok: true, message: '未启用查看验证' }, 200);
        }
        // Turnstile 人机验证：配置后必须先通过服务端校验（客户端组件本身不构成保护）
        if (turnstileEnabled(env)) {
          const verdict = await verifyTurnstileToken(
            env,
            body.turnstileToken || body['cf-turnstile-response'],
            ip,
            url.hostname
          );
          if (!verdict.ok) {
            // 只记服务端日志，不把具体错误码回给客户端
            console.warn('[notify] turnstile rejected:', verdict.code);
            // 官方语义：人机验证未通过属于"禁止访问" → 403（区别于密钥错误的 401）
            return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
          }
        }
        if (!provided || !timingSafeEqual(provided, expected)) {
          noteLoginFailure(ip);
          return json({ ok: false, error: '密钥不正确' }, 401);
        }
        clearLoginFailures(ip);
        const session = await createSessionToken(env);
        return json(
          { ok: true, message: '验证通过' },
          200,
          { 'Set-Cookie': sessionCookieHeader(session, url.protocol === 'https:') }
        );
      }

      if (path === '/api/logout' && method === 'POST') {
        return json(
          { ok: true },
          200,
          { 'Set-Cookie': clearSessionCookieHeader(url.protocol === 'https:') }
        );
      }

      // ---- 查看页面（服务端鉴权后才下发完整 UI）----
      if (path === '/' || path === '/index.html') {
        const expected = String(env.READ_TOKEN || '').trim();
        if (!expected) {
          // 公开模式：未配置 READ_TOKEN，直接返回完整页面
          return html(applyTurnstile(UI_HTML, env), 200, {}, env);
        }
        const session = getCookie(request, SESSION_COOKIE);
        if (session && (await verifySessionToken(env, session))) {
          return html(applyTurnstile(UI_HTML, env), 200, {}, env);
        }
        // 兼容：URL / Header 直接带 READ_TOKEN → 立刻换成会话 Cookie 并 302 到干净地址，
        // 这样密钥不会长期留在浏览器历史、地址栏和 Referer 里。
        const direct = extractToken(request, url);
        if (direct && timingSafeEqual(direct, expected)) {
          const token = await createSessionToken(env);
          return new Response(null, {
            status: 302,
            headers: {
              Location: path === '/index.html' ? '/' : path,
              'Set-Cookie': sessionCookieHeader(token, url.protocol === 'https:'),
              'Cache-Control': 'no-store',
              ...SECURITY_HEADERS,
            },
          });
        }
        // 未鉴权：只返回最小登录页，不含任何密钥/地址/通知数据
        return html(applyTurnstile(LOGIN_HTML, env), 401, {}, env);
      }

      // 服务状态 + 配置自检（用于排查"页面打不开 / 功能异常"）
      if (path === '/api/status' && method === 'GET') {
        // 配置了 READ_TOKEN 时，状态接口同样需要鉴权，避免泄露配置细节
        if (!(await hasReadPermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
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
          features: ['channels', 'test-channels', 'templates', 'quiet-hours', 'idempotency', 'rate-limit', 'inbound-signature', 'message-ttl', 'export', 'stats', 'i18n', 'api-docs', 'tenants'],
          channels: (await readChannelConfigs(env)).map((c) => ({
            id: c.id, name: c.name, enabled: c.enabled, configured: Boolean(c.webhook), webhook: maskWebhook(c.webhook),
          })),
          settings: await readSettings(env),
          templates: Object.keys(await readTemplates(env)),
          messageTtlDays: Math.max(1, Math.min(365, Number(env.MESSAGE_TTL_DAYS || 90) || 90)),
          diagnostics: {
            kvBound: Boolean(env.NOTIFICATIONS),
            kvOk,
            kvError,
            sendTokenSet: Boolean(env.SEND_TOKEN),
            readTokenSet: Boolean(env.READ_TOKEN),
            wecomWebhookSet: Boolean(env.WECOM_WEBHOOK),
            serverchanReady: Boolean(env.SEND_TOKEN || rotatingKey),
            rotatingKeyReady: Boolean(rotatingKey),
            turnstileEnabled: turnstileEnabled(env),
            turnstileSiteKeySet: Boolean(turnstileSiteKey(env)),
            turnstileSecretKeySet: Boolean(turnstileSecretKey(env)),
            turnstileMisconfigured: turnstileMisconfigured(env),
            turnstileHostnames: turnstileHostnames(env),
            inboundSignature: Boolean(env.INBOUND_SIGNING_SECRET),
            delivery: await readDeliverySummary(env),
            audit: await (async () => {
              try {
                const raw = await env.NOTIFICATIONS.get(AUDIT_KEY);
                const v = raw ? JSON.parse(raw) : null;
                return (v && Array.isArray(v.items) ? v.items : []).slice(0, 5);
              } catch (_) { return []; }
            })(),
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
        if (!(await hasReadPermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        const version = await getVersion(env);
        const clientVersion = url.searchParams.get('version');
        if (clientVersion && clientVersion === version) {
          return json({ ok: true, unchanged: true, version });
        }
        const messages = (await listMessages(env, url.searchParams.get('limit') || 50)).map(decorateMessage);
        // 投递明细按消息 ID 归组，供面板展示每个渠道的送达状态（C6）
        const deliveries = {};
        try {
          const log = await readDeliveryLog(env);
          for (const x of (log.items || [])) {
            const id = x && x.eventId;
            if (!id) continue;
            if (!deliveries[id]) deliveries[id] = [];
            deliveries[id].push({
              channel: x.channel || 'wecom',
              ok: Boolean(x.ok),
              error: String(x.error || '').slice(0, 120),
              ts: x.ts,
            });
          }
        } catch (_) { /* 投递日志读取失败不影响消息列表 */ }
        return json({
          ok: true,
          unchanged: false,
          version,
          count: messages.length,
          messages,
          deliveries,
        });
      }

      // 发送消息：POST（密钥可放 query / Header / body）
      if ((path === '/api/send' || path === '/send') && method === 'POST') {
        const limited = await checkSendRateLimit(request, env);
        if (limited) return limited;
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const body = await parseBody(request);
        if (!(await hasSendPermission(request, url, env, body))) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        return await createMessage(env, body, {
          idempotencyKey: request.headers.get('X-Idempotency-Key'),
        });
      }

      // 发送消息：GET（URL 直发）
      if ((path === '/api/send' || path === '/send') && method === 'GET') {
        const limited = await checkSendRateLimit(request, env);
        if (limited) return limited;
        if (!(await hasSendPermission(request, url, env))) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        // 传入全部 query 参数，使 v.<name> / var.<name> 自定义变量一并进入渲染层；
        // title/content 的字段别名兼容逻辑仍在 createMessage 内统一处理。
        const data = Object.fromEntries(url.searchParams.entries());
        if (!data.source) data.source = 'url';
        return await createMessage(env, data, {
          idempotencyKey: request.headers.get('X-Idempotency-Key'),
        });
      }

      // 渠道连通性测试：企微 / 钉钉 / 飞书共用一套鉴权、限流与签名校验。
      // /api/test-wecom 保留为旧别名（默认 wecom），新面板三个按钮统一调用 /api/test-channel。
      if ((path === '/api/test-wecom' || path === '/api/test-channel') && method === 'POST') {
        const limited = await checkSendRateLimit(request, env);
        if (limited) return limited;
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        if (!(await hasSendPermission(request, url, env))) {
          return json({ ok: false, error: 'invalid token' }, 401);
        }
        const testBody = await parseBody(request);
        const asked = String(
          (testBody && (testBody.id || testBody.channel)) || url.searchParams.get('id') || 'wecom'
        ).trim().toLowerCase();
        if (CHANNEL_IDS.indexOf(asked) < 0) return json({ ok: false, error: '不支持的渠道' }, 400);
        const configs = await readChannelConfigs(env);
        const channel = configs.find((c) => c.id === asked);
        if (!channel || !channel.webhook) {
          return json({ ok: false, error: '未配置 ' + (CHANNEL_NAMES[asked] || asked) + ' Webhook' }, 400);
        }
        const result = await sendChannel(channel, {
          title: (CHANNEL_NAMES[asked] || asked) + '推送测试',
          content: '看到这条消息即表示 Webhook 配置成功。',
          source: 'test',
          timestamp: Date.now(),
        }, env);
        await appendAudit(env, 'channel.test', 'id=' + asked + ' ok=' + (result.ok ? 1 : 0));
        return json(Object.assign({ id: asked }, result), result.ok ? 200 : 502);
      }

      // 清空（写操作：需要管理主密钥或已启用的查看验证）
      if (path === '/api/clear' && method === 'POST') {
        if (!(await hasWritePermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized: 需要管理权限' }, 401);
        }
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const deleted = await clearMessages(env);
        await appendAudit(env, 'clear', 'deleted=' + deleted);
        return json({ ok: true, deleted });
      }

      // 删除单条消息（E1）
      const deleteMatch = path.match(/^\/api\/messages\/([A-Za-z0-9_-]{1,40})$/);
      if (deleteMatch && method === 'DELETE') {
        if (!(await hasWritePermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized: 需要管理权限' }, 401);
        }
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const id = deleteMatch[1];
        const deleted = await deleteMessage(env, id);
        await appendAudit(env, 'message.delete', 'id=' + id + ' hit=' + deleted);
        return json({ ok: true, deleted, id }, deleted ? 200 : 404);
      }

      // 渠道配置：读取（查看权限，Webhook 脱敏）
      if (path === '/api/channels' && method === 'GET') {
        if (!(await hasReadPermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        const configs = await readChannelConfigs(env);
        return json({
          ok: true,
          channels: configs.map((c) => ({
            id: c.id, name: c.name, enabled: c.enabled,
            configured: Boolean(c.webhook), webhook: maskWebhook(c.webhook),
          })),
          editable: hasAdminPermission(request, url, env),
        });
      }

      // 渠道配置：保存（管理主密钥；支持只提交部分渠道）
      if (path === '/api/channels' && method === 'PUT') {
        if (!hasAdminPermission(request, url, env)) {
          return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        }
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const body = await parseBody(request);
        const input = body && Array.isArray(body.channels) ? body.channels : body;
        let next;
        try {
          const current = await readChannelConfigs(env);
          const incoming = normalizeChannelConfigs(input);
          next = current.map((c) => {
            const found = incoming.find((x) => x.id === c.id);
            return found || c;
          });
        } catch (e) {
          return json({ ok: false, error: e && e.message ? e.message : '配置无效' }, 400);
        }
        await env.NOTIFICATIONS.put(CHANNELS_KEY, JSON.stringify(next));
        await bumpVersion(env);
        await appendAudit(env, 'channels.update', next.map((c) => c.id + ':' + (c.enabled ? 'on' : 'off')).join(','));
        return json({
          ok: true,
          channels: next.map((c) => ({
            id: c.id, name: c.name, enabled: c.enabled,
            configured: Boolean(c.webhook), webhook: maskWebhook(c.webhook),
          })),
        });
      }

      // 指定渠道测试发送（管理主密钥；与配置保存同级保护：限流 + 可选签名 + 审计）
      if (path === '/api/channels/test' && method === 'POST') {
        if (!hasAdminPermission(request, url, env)) {
          return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        }
        const limited = await checkSendRateLimit(request, env);
        if (limited) return limited;
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const body = await parseBody(request);
        const id = String(body.id || body.channel || '').trim();
        if (CHANNEL_IDS.indexOf(id) < 0) return json({ ok: false, error: '不支持的渠道' }, 400);
        const configs = await readChannelConfigs(env);
        const channel = configs.find((c) => c.id === id);
        if (!channel || !channel.webhook) return json({ ok: false, error: '该渠道未配置 Webhook' }, 400);
        const result = await sendChannel(channel, {
          title: '渠道连通性测试 · ' + channel.name,
          content: '看到这条消息即表示 ' + channel.name + ' 配置成功。',
          source: 'test',
          timestamp: Date.now(),
        }, env);
        await appendAudit(env, 'channel.test', 'id=' + id + ' ok=' + (result.ok ? 1 : 0));
        return json(Object.assign({ ok: result.ok }, result), result.ok ? 200 : 502);
      }

      // 通知模板（读取：查看权限；保存：管理主密钥）
      if (path === '/api/templates' && method === 'GET') {
        if (!(await hasReadPermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({ ok: true, templates: await readTemplates(env) });
      }
      if (path === '/api/templates' && method === 'PUT') {
        if (!hasAdminPermission(request, url, env)) {
          return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        }
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const body = await parseBody(request);
        let next;
        try { next = normalizeTemplates(body && body.templates ? body.templates : body); }
        catch (e) { return json({ ok: false, error: e && e.message ? e.message : '模板无效' }, 400); }
        await env.NOTIFICATIONS.put(TEMPLATES_KEY, JSON.stringify(next));
        await bumpVersion(env);
        await appendAudit(env, 'templates.update', Object.keys(next).join(','));
        return json({ ok: true, templates: next });
      }

      // 静默时段设置（读取：查看权限；保存：管理主密钥）
      if (path === '/api/settings' && method === 'GET') {
        if (!(await hasReadPermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({ ok: true, settings: await readSettings(env) });
      }
      if (path === '/api/settings' && method === 'PUT') {
        if (!hasAdminPermission(request, url, env)) {
          return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        }
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const body = await parseBody(request);
        let next;
        try { next = normalizeSettings(body && body.settings ? body.settings : body); }
        catch (e) { return json({ ok: false, error: e && e.message ? e.message : '设置无效' }, 400); }
        await env.NOTIFICATIONS.put(SETTINGS_KEY, JSON.stringify(next));
        await bumpVersion(env);
        await appendAudit(env, 'settings.update', 'quiet=' + (next.quietEnabled ? next.quietStart + '-' + next.quietEnd : 'off'));
        return json({ ok: true, settings: next });
      }

      // ================= L1 导出 / L4 统计 / L5 文档 / L6 租户 =================

      // 消息导出：JSON / CSV / Markdown，按查看权限，带 BOM 的 CSV 可直接用 Excel 打开
      if (path === '/api/export' && method === 'GET') {
        if (!(await hasReadPermission(request, url, env))) return json({ ok: false, error: 'unauthorized' }, 401);
        const format = String(url.searchParams.get('format') || 'json').toLowerCase();
        if (['json', 'csv', 'md'].indexOf(format) < 0) {
          return json({ ok: false, error: 'format 仅支持 json / csv / md' }, 400);
        }
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 500) || 500));
        const items = (await listMessages(env, limit)).map(decorateMessage);
        const log = await readDeliveryLog(env);
        const deliveries = {};
        for (const x of (log.items || [])) {
          if (!x || !x.eventId) continue;
          (deliveries[x.eventId] = deliveries[x.eventId] || []).push({
            channel: x.channel || 'wecom', ok: Boolean(x.ok), error: String(x.error || '').slice(0, 120),
          });
        }
        let text;
        let type;
        if (format === 'json') {
          text = JSON.stringify({
            version: VERSION, exportedAt: new Date().toISOString(), count: items.length,
            messages: items.map((m) => ({
              id: m.id, title: m.title, content: m.content, type: m.type, source: m.source,
              timestamp: m.timestamp, time: new Date(Number(m.timestamp)).toISOString(),
              deliveries: deliveries[m.id] || [],
            })),
          }, null, 2);
          type = 'application/json; charset=utf-8';
        } else if (format === 'csv') {
          // CSV 公式注入防护：Excel 会把 = + - @ 开头的单元格当公式执行。
          const cell = (v) => {
            let s = String(v == null ? '' : v);
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return '"' + s.replace(/"/g, '""') + '"';
          };
          const lines = ['id,title,content,type,source,timestamp,time,deliveries'];
          for (const m of items) {
            lines.push([m.id, m.title, m.content, m.type, m.source, m.timestamp,
              new Date(Number(m.timestamp)).toISOString(),
              (deliveries[m.id] || []).map((d) => d.channel + ':' + (d.ok ? 'ok' : 'fail')).join('|'),
            ].map(cell).join(','));
          }
          text = '\ufeff' + lines.join('\r\n');
          type = 'text/csv; charset=utf-8';
        } else {
          const lines = ['# 通知导出', '', '导出时间：' + new Date().toISOString(), '数量：' + items.length, ''];
          for (const m of items) {
            lines.push('## ' + (m.title || '（无标题）'), '',
              '- 时间：' + new Date(Number(m.timestamp)).toISOString(),
              '- 来源：' + (m.source || 'api'), '- ID：' + String(m.id), '',
              String(m.content || ''), '');
          }
          text = lines.join('\n');
          type = 'text/markdown; charset=utf-8';
        }
        const stamp = new Date().toISOString().slice(0, 10);
        return new Response(text, {
          status: 200,
          headers: {
            'Content-Type': type,
            'Content-Disposition': 'attachment; filename="notify-' + stamp + '.' + (format === 'md' ? 'md' : format) + '"',
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
          },
        });
      }

      // 统计看板数据：一次 list + 最多 500 次 get，仅在打开看板时请求，不参与轮询
      if (path === '/api/stats' && method === 'GET') {
        if (!(await hasReadPermission(request, url, env))) return json({ ok: false, error: 'unauthorized' }, 401);
        const messages = await listMessages(env, 500);
        const dayKey = (ts) => new Date(Number(ts) + 8 * 3600 * 1000).toISOString().slice(0, 10);
        const days = [];
        for (let i = 13; i >= 0; i--) {
          days.push({ date: new Date(Date.now() - i * 86400000 + 8 * 3600 * 1000).toISOString().slice(0, 10), count: 0 });
        }
        const byDay = Object.fromEntries(days.map((d) => [d.date, d]));
        const sources = {};
        const hours = new Array(24).fill(0);
        for (const m of messages) {
          const k = dayKey(m.timestamp || 0);
          if (byDay[k]) byDay[k].count++;
          const s = String(m.source || 'api');
          sources[s] = (sources[s] || 0) + 1;
          hours[new Date(Number(m.timestamp || 0) + 8 * 3600 * 1000).getUTCHours()]++;
        }
        const channels = {};
        for (const c of (await readChannelConfigs(env)).map((x) => ({ id: x.id, name: x.name }))) {
          channels[c.id] = { id: c.id, name: c.name, ok: 0, fail: 0 };
        }
        const log = await readDeliveryLog(env);
        for (const x of (log.items || [])) {
          const id = String((x && x.channel) || 'wecom');
          if (!channels[id]) channels[id] = { id, name: id, ok: 0, fail: 0 };
          if (x.ok) channels[id].ok++; else channels[id].fail++;
        }
        const channelStats = Object.values(channels).map((c) => Object.assign({}, c, {
          rate: c.ok + c.fail ? Math.round(c.ok * 100 / (c.ok + c.fail)) : null,
        }));
        return json({
          ok: true,
          total: await countMessages(env),
          sampled: messages.length,
          truncated: messages.length >= 500,
          daily: days,
          hourly: hours,
          sources: Object.entries(sources).map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count).slice(0, 10),
          channels: channelStats,
        });
      }

      // 开放 API：机器可读的 OpenAPI 3.0 描述 + 服务端内嵌文档页
      if (path === '/openapi.json' && method === 'GET') {
        return json(OPENAPI_SPEC);
      }
      if (path === '/docs' && method === 'GET') {
        return html(renderDocsHtml(), 200, {}, env);
      }

      // L6：租户自查（租户自己的密钥即可，不需要管理主密钥）
      if (path === '/api/tenant' && method === 'GET') {
        if (!tenantId) return json({ ok: false, error: '未指定租户（X-Tenant-ID 或 ?tenant=）' }, 400);
        return json({ ok: true, tenant: publicTenant(tenant, await tenantQuotaUsage(env, tenantId)) });
      }

      // L6：租户注册表（仅管理主密钥 SEND_TOKEN 可读写，密钥在响应中一律脱敏）
      if (path === '/api/tenants' && method === 'GET') {
        if (!hasAdminPermission(request, url, rawEnv)) return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        const list = await readTenants(rawEnv);
        const out = [];
        for (const t of list) out.push(publicTenant(t, await tenantQuotaUsage(rawEnv, t.id)));
        return json({ ok: true, tenants: out });
      }
      if (path === '/api/tenants' && method === 'POST') {
        if (!hasAdminPermission(request, url, rawEnv)) return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        const sig = await verifyInboundSignature(request, rawEnv);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const body = await parseBody(request);
        let next;
        try {
          const list = await readTenants(rawEnv);
          const id = String(body.id || '').trim().toLowerCase();
          if (list.some((x) => x.id === id)) return json({ ok: false, error: '租户已存在' }, 409);
          const created = normalizeTenant(body);
          list.push(created);
          next = list;
        } catch (e) {
          return json({ ok: false, error: e && e.message ? e.message : '租户配置无效' }, 400);
        }
        await writeTenants(rawEnv, next);
        await appendAudit(rawEnv, 'tenant.create', String(body.id || '').toLowerCase());
        return json({ ok: true, tenant: publicTenant(next[next.length - 1], 0) });
      }
      const tenantMatch = path.match(/^\/api\/tenants\/([a-z0-9][a-z0-9_-]{1,31})$/);
      if (tenantMatch && (method === 'PUT' || method === 'DELETE')) {
        if (!hasAdminPermission(request, url, rawEnv)) return json({ ok: false, error: 'unauthorized: 需要管理主密钥 SEND_TOKEN' }, 401);
        const sig = await verifyInboundSignature(request, rawEnv);
        if (!sig.ok) return json({ ok: false, error: sig.error }, 403);
        const id = tenantMatch[1];
        const list = await readTenants(rawEnv);
        const idx = list.findIndex((x) => x.id === id);
        if (idx < 0) return json({ ok: false, error: '未知租户' }, 404);
        if (method === 'DELETE') {
          list.splice(idx, 1);
          await writeTenants(rawEnv, list);
          await appendAudit(rawEnv, 'tenant.delete', id);
          return json({ ok: true, deleted: id, note: '仅注销租户，历史数据保留，重新创建后可继续读取' });
        }
        const body = await parseBody(request);
        let updated;
        try {
          updated = normalizeTenant(Object.assign({}, body, { id }), list[idx]);
          list[idx] = updated;
        } catch (e) {
          return json({ ok: false, error: e && e.message ? e.message : '租户配置无效' }, 400);
        }
        await writeTenants(rawEnv, list);
        await appendAudit(rawEnv, 'tenant.update', id + ':' + (updated.enabled ? 'on' : 'off'));
        return json({ ok: true, tenant: publicTenant(updated, await tenantQuotaUsage(rawEnv, id)) });
      }

      // 统计
      if (path === '/api/count' && method === 'GET') {
        if (!(await hasReadPermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({ ok: true, total: await countMessages(env) });
      }

      // 方糖 / Server酱 兼容：/<SEND_TOKEN>.send
      const sendMatch = path.match(/^\/([^/]+)\.send$/);
      if (sendMatch && (method === 'GET' || method === 'POST')) {
        const limited = await checkSendRateLimit(request, env);
        if (limited) return limited;
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, code: 1, errno: 1, error: sig.error }, 403);
        const key = decodeURIComponent(sendMatch[1]);
        const data = method === 'GET'
          ? Object.assign(Object.fromEntries(url.searchParams.entries()), {
              source: url.searchParams.get('source') || 'serverchan',
            })
          : await parseBody(request);
        return await serverchanSend(env, key, data, {
          idempotencyKey: request.headers.get('X-Idempotency-Key'),
        });
      }

      // ===================== RouterHook 专用接收接口 =====================
      // POST /api/routerhook/{event}?device=XXX
      // RouterHook 的 sender.sh 用 `grep "success"` 判定推送成功，因此响应体必须含 "success"。
      // 普通事件（manuINFO/cronINFO/ifUP/newDHCP）立即落库；rh_* 传感器进入 DO 聚合窗口。
      const rhMatch = path.match(/^\/api\/routerhook\/([^/]+)$/);
      if (rhMatch && method === 'POST') {
        const limited = await checkSendRateLimit(request, env);
        if (limited) return limited;
        const sig = await verifyInboundSignature(request, env);
        if (!sig.ok) return json({ ok: false, error: sig.error, success: 'failed' }, 403);
        let event;
        try { event = decodeURIComponent(rhMatch[1]); } catch (_) { event = rhMatch[1]; }
        // 事件名白名单：字母数字下划线短横线（rh_dev_<mac> 去冒号后符合）
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(event)) {
          return json({ ok: false, error: 'invalid event' }, 400);
        }

        // 严格 JSON 解析：非法 JSON 必须 400（parseBody 会吞错返回 {}，这里不能复用）
        const rawText = await request.text();
        if (!rawText || !rawText.trim()) return json({ ok: false, error: 'empty json body' }, 400);
        let rhBody;
        try { rhBody = JSON.parse(rawText); } catch (_) { return json({ ok: false, error: 'invalid json' }, 400); }
        if (!rhBody || typeof rhBody !== 'object' || Array.isArray(rhBody)) {
          return json({ ok: false, error: 'invalid json object' }, 400);
        }

        // 鉴权：复用现有发送密钥体系（X-Token / Authorization Bearer / body token / query token）
        if (!(await hasSendPermission(request, url, env, rhBody))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }

        const device = rhResolveDevice(event, rhBody, url);
        const msgType = rhText(rhBody.msgTYPE);
        let formatted;
        let aggregated = false;

        if (event.indexOf('rh_') === 0 || (!msgType && Object.prototype.hasOwnProperty.call(rhBody, 'state'))) {
          // 传感器：body 无 msgTYPE，靠 URL 路径识别；优先用 msgTYPE 作为事件名（若存在）
          const sensorEvent = event.indexOf('rh_') === 0 ? event : ('rh_' + event);
          const sensor = parseRhSensor(sensorEvent, rhBody);
          sensor.device = device.key;
          const stub = env.ROUTERHOOK_SENSOR;
          if (stub && typeof stub.idFromName === 'function') {
            const id = stub.idFromName(device.key);
            await stub.get(id).fetch(new Request('https://routerhook-do/ingest', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sensor, device: device.key }),
            }));
            aggregated = true;
            formatted = null; // 由 DO Alarm 到期后生成汇总
          } else {
            // DO 未绑定：降级为立即单条通知，保证数据不丢失
            formatted = formatRhSensorSingle(sensor, device);
          }
        } else if (msgType === 'manuINFO' || event === 'manuINFO') {
          formatted = formatRhStatus(rhBody, device, false);
        } else if (msgType === 'cronINFO' || event === 'cronINFO') {
          formatted = formatRhStatus(rhBody, device, true);
        } else if (msgType === 'ifUP' || event === 'ifUP') {
          formatted = formatRhIfUp(rhBody, device);
        } else if (msgType === 'newDHCP' || event === 'newDHCP') {
          formatted = formatRhNewDhcp(rhBody, device);
        } else {
          // 未知事件：通用接收，不丢弃有效数据
          formatted = formatRhUnknown(event, rhBody, device);
        }

        let wecom = { configured: false, ok: false, skipped: true };
        let data = null;
        if (formatted) {
          const message = await saveMessage(env, {
            title: formatted.title,
            content: formatted.content,
            type: 'text',
            source: formatted.source,
          });
          wecom = await pushToWecom(env, message); // best-effort
          data = { pushid: message.id, timestamp: message.timestamp, source: formatted.source };
        }
        // RouterHook sender.sh 判定成功的唯一依据是响应体包含 "success"
        return json({
          ok: true,
          success: 'success',
          code: 0,
          errno: 0,
          message: 'success',
          aggregated,
          data,
          wecom,
        });
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return json({ ok: false, error: '请求体过大（上限 256KB）' }, 413);
      }
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
