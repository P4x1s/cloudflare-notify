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
  .hint.box.ok { border-color: var(--ok); color: var(--ok); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

  /* ---------- 推送接入方式切换 ---------- */
  .intg-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 12px; }
  .intg-tab {
    font-size: 11px; padding: 5px 9px; border-radius: 999px;
    border: var(--line); background: transparent; color: var(--muted); cursor: pointer;
  }
  .intg-tab:hover { border-color: var(--primary); color: var(--text); }
  .intg-tab.active { background: var(--primary); border-color: var(--primary); color: #fff; }
  .intg-card { border: var(--line); border-radius: 11px; padding: 12px; background: var(--bg); }
  .intg-name { font-size: 12.5px; font-weight: 600; margin-bottom: 3px; }
  .intg-scene { font-size: 11px; color: var(--muted); line-height: 1.6; margin-bottom: 9px; }
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
`;

const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>通知中心 · Cloudflare Notify</title>
<style>${UI_CSS}</style>
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
      <button class="ghost" id="btnDiag" style="display:none">配置自检</button>
      <button class="ghost" id="btnLogout" style="display:none">退出</button>
    </div>
  </header>

  <div class="panel">
    <div class="diag-strip" id="diagStrip" hidden>
      <div class="diag-inner" id="diagBody"></div>
    </div>

    <div class="panel-cols">
      <div class="panel-side">
        <section class="section">
          <h2>推送接入</h2>
          <p class="sec-desc">
            支持 <b>6 类接入方式</b>：浏览器直发、JSON / 表单 API、方糖 / Server酱、脚本语言、CI 定时任务、RouterHook 路由器。
            点标签看对应示例，一键复制；示例会自动填入当前轮换密钥。
          </p>
          <div class="intg-tabs" id="intgTabs"></div>
          <div class="intg-card">
            <div class="intg-name" id="intgName"></div>
            <div class="intg-scene" id="intgScene"></div>
            <pre class="intg-code" id="intgCode"></pre>
            <div class="hint" id="intgNote"></div>
            <div class="row">
              <button class="ghost" id="btnCopyIntg">复制这段示例</button>
            </div>
          </div>

          <div class="intg-sep"></div>
          <div class="intg-quick-label">方糖 / Server酱 专用地址（可直接粘进软件）</div>
          <div class="hint box dashed" id="scUrl"></div>
          <div class="row">
            <button class="ghost" id="btnCopyScUrl">复制推送地址</button>
          </div>
          <div class="hint" id="scHint"></div>
        </section>

        <section class="section">
          <h2>密钥与轮换</h2>
          <p class="sec-desc">
            两级密钥：<b>管理主密钥 SEND_TOKEN</b> 只用于后台管理，绝不要填进软件或 URL；
            <b>轮换推送密钥</b> 才是填进软件的那个，随时可换、换后旧的立即失效。
          </p>
          <label for="fMasterToken">管理主密钥（SEND_TOKEN）</label>
          <input id="fMasterToken" type="password" placeholder="仅用于生成 / 查看轮换密钥" autocomplete="off" />
          <div class="hint" id="keyStatus">当前轮换密钥状态加载中…</div>
          <div class="row">
            <button class="primary" id="btnRotateKey">生成新推送密钥</button>
            <button class="ghost" id="btnViewKey">查看当前密钥</button>
          </div>
          <div class="hint box ok" id="rotatedKeyBox" style="display:none"></div>
          <div class="hint" id="rotateHint"></div>
        </section>

        <section class="section">
          <h2>发送测试通知</h2>
          <label for="fTitle">标题</label>
          <input id="fTitle" placeholder="例如：构建完成" autocomplete="off" />
          <label for="fContent">内容</label>
          <textarea id="fContent" placeholder="在这里输入通知正文…"></textarea>
          <label for="fSendToken">发送密钥（SEND_TOKEN）</label>
          <input id="fSendToken" type="password" placeholder="留空则使用浏览器保存的值" autocomplete="off" />
          <div class="hint" id="sendHint">密钥仅保存在本机浏览器，不会上传到第三方。</div>
          <div class="hint" id="wecomHint"></div>
          <div class="row">
            <button class="primary" id="btnSend">发送通知</button>
            <button class="ghost" id="btnCopyCurl">复制 curl 示例</button>
            <button class="ghost" id="btnTestWecom">测试企微推送</button>
          </div>
          <div class="hint box" id="curlBox" style="display:none"></div>
        </section>
      </div>

      <div class="panel-main">
        <section class="section">
          <div class="list-head">
            <h2>最近通知</h2>
            <div class="list-actions">
              <span class="count" id="count"></span>
              <button class="ghost toggle-all" id="btnToggleAll">全部展开</button>
              <button class="ghost" id="btnRefresh">刷新</button>
              <button class="ghost danger" id="btnClear">清空</button>
            </div>
          </div>
          <div class="hint" style="margin:0 0 12px">折叠时显示标题与内容摘要，点击标题行展开全文。</div>
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

<div class="toast" id="toast"></div>

<!--@TS_SCRIPTS@-->
<script>
(function () {
  'use strict';

  var REFRESH_MS = 5000;
  var state = {
    status: null,
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

  // 推送接入示例目录：所有端点与字段别名均与 worker.js 服务端实现一致。
  // 生成时用 location.origin 与当前轮换密钥，避免写死域名/密钥。
  var INTEGRATIONS = [
    {
      id: 'urlget', label: 'URL 直发',
      name: '① 浏览器 / 快捷指令：URL 直发（GET）',
      scene: '适用：地址栏、iOS 快捷指令、只支持 GET 的 Webhook、简单脚本。',
      note: 'title/text、content/desp 都是等价字段别名；type 可填 text 或 markdown。密钥写在 URL 会进历史与日志，仅建议可信环境使用。',
      code: function (o, k) { return o + '/send?token=' + k + '&title=构建完成&content=耗时%2023s&source=ci'; }
    },
    {
      id: 'json', label: 'JSON API',
      name: '② 程序调用：JSON API（POST，推荐）',
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
      name: '③ 表单提交：Form API（POST）',
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
      name: '④ 软件集成：方糖 / Server酱 兼容端点',
      scene: '适用：只支持 sc.ftqq.com 格式、但允许自定义域名/服务器地址的软件。把 key 放在路径里。',
      note: 'GET 用 text/title 作标题、desp/content 作正文；POST 用表单。返回同时带 errno（方糖）与 code（Server酱³）双码。写死 sc.ftqq.com 的软件无法迁移。',
      code: function (o, k) {
        return o + '/' + encodeURIComponent(k) + '.send?text=构建完成&desp=耗时%2023s';
      }
    },
    {
      id: 'python', label: 'Python',
      name: '⑤ 脚本：Python 示例',
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
      name: '⑥ 脚本：Node.js 示例',
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
      name: '⑦ CI 与定时任务：GitHub Actions / crontab',
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
      name: '⑧ 路由器：RouterHook 事件推送',
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
      name: '⑨ 动态变量：内置 + 自定义',
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
    var item = INTEGRATIONS[0];
    for (var j = 0; j < INTEGRATIONS.length; j++) {
      if (INTEGRATIONS[j].id === stateIntg) { item = INTEGRATIONS[j]; break; }
    }
    $('intgName').textContent = item.name;
    $('intgScene').textContent = item.scene;
    $('intgNote').textContent = item.note;
    $('intgCode').textContent = item.code(location.origin, currentKey());
  }

  function setStatus(kind, text) {
    $('dot').className = 'dot' + (kind ? ' ' + kind : '');
    $('statusText').textContent = text;
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
  }

  function renderServerchanUrl() {
    // 优先用轮换密钥（更安全），其次用户手填的密钥，最后浏览器保存的 SEND_TOKEN
    var token = state.rotatingKey || $('fSendToken').value.trim() || state.sendToken;
    var box = $('scUrl');
    if (!token) {
      box.textContent = '请先在「密钥与轮换」生成推送密钥，或在发送表单填入密钥，这里会生成专属地址。';
      box.dataset.url = '';
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
      : '尚未生成轮换推送密钥。填入 SEND_TOKEN 后点「生成新推送密钥」，软件用生成出的 key。';
    $('keyStatus').textContent = text;
  }

  function render() {
    var box = $('list');
    $('count').textContent = state.messages.length + ' 条';

    if (!state.messages.length) {
      box.innerHTML = '<div class="empty"><div class="icon">◇</div>' +
        '<p>暂无通知。用左侧表单发送一条，或调用 /send 接口。</p></div>';
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
    fetch('/api/status', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { requireReauth(); throw new Error('unauthorized'); }
      return r.json();
    }).then(function (s) {
      state.status = s;
      $('btnLogout').style.display = 'inline-block';
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
      renderIntegrations();
      start();
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
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
      $('loginErr').textContent = '验证失败：' + err.message;
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
    if (!payload.title && !payload.content) { toast('请填写标题或内容'); return; }

    btn.disabled = true;
    var url = '/api/send' + (token ? '?token=' + encodeURIComponent(token) : '');
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin'
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

  $('btnCopyIntg').addEventListener('click', function () {
    var text = $('intgCode').textContent;
    if (!text) { toast('暂无可复制的示例'); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('已复制该接入示例'); });
    else toast('请手动复制代码框内容');
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

  $('fSendToken').addEventListener('input', function () {
    renderServerchanUrl();
    renderIntegrations();
  });
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
    fetch(url, { method: 'POST', credentials: 'same-origin' }).then(function (r) {
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
    renderIntegrations();
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
    fetch('/api/key/rotate', { method: 'POST', headers: headers, credentials: 'same-origin' }).then(function (r) {
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
    fetch('/api/key/current', { headers: { 'X-Token': m }, credentials: 'same-origin' }).then(function (r) {
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

// 未通过服务端鉴权时返回的最小登录页：
// 里面**没有**任何推送地址、密钥、通知列表等敏感 DOM，
// 即便攻击者删掉遮罩 div 也拿不到任何信息。
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>访问验证 · Cloudflare Notify</title>
<style>${UI_CSS}</style>
</head>
<body>
<div class="auth-wrap">
  <div class="auth-card">
    <div class="brand">
      <div class="logo">✦</div>
      <div>
        <h1>通知中心</h1>
        <div class="sub">Cloudflare Notify</div>
      </div>
    </div>
    <p class="lead">该通知服务已开启查看验证。请输入查看密钥（READ_TOKEN）以查看通知与接入地址。</p>
    <label for="loginToken">查看密钥</label>
    <input id="loginToken" type="password" placeholder="READ_TOKEN" autocomplete="current-password" />
    <!--@TS_WIDGET@-->
    <div class="row">
      <button class="primary" id="btnLogin">进入通知中心</button>
    </div>
    <div class="auth-err" id="loginErr"></div>
    <div class="hint" style="margin-top:14px">验证通过后会签发 HttpOnly 会话 Cookie，密钥不会保存在浏览器本地。</div>
  </div>
</div>

<div class="toast" id="toast"></div>

<!--@TS_SCRIPTS@-->
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

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
      $('loginErr').textContent = '请输入查看密钥';
      $('loginErr').classList.add('show');
      return;
    }
    // Turnstile 启用时必须先拿到验证 token 才能提交（服务端会独立校验）
    var tsToken = '';
    if (window.TS && window.TS.enabled()) {
      tsToken = window.TS.token();
      if (!tsToken) {
        $('loginErr').textContent = '请先完成人机验证';
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
      $('loginErr').textContent = '验证失败：' + err.message;
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
  return tpl
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

/** 管理操作鉴权：只认管理主密钥 SEND_TOKEN，轮换密钥无权调用 */
function hasAdminPermission(request, url, env, body) {
  const master = String(env.SEND_TOKEN || '').trim();
  if (!master) return false;
  const token = extractToken(request, url, body);
  return Boolean(token) && timingSafeEqual(token, master);
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

  // 企业微信 markdown 上限 4096 字节，中文按 3 字节算，正文截断以留足余量。
  // 正文/标题先做 HTML→markdown 转换：加粗/链接/换行保留语义，其余标签剥离，
  // 避免群里有到 <b>xxx</b> 这类字面标签碎片。
  const title = (stripTagsText(message.title || '', 100) || '（无标题）');
  const body = htmlToMarkdown(message.content).slice(0, 1000);
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

async function createMessage(env, data) {
  const now = new Date();
  const title = renderVars(String(data.title || data.text || '').trim(), data, now);
  const content = renderVars(String(data.content || data.desp || data.body || '').trim(), data, now);
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
  // 双返回码：errno（方糖）+ code（Server酱³），两种客户端都能判定成功
  return json({ ok: true, code: 0, errno: 0, message: '通知已接收', data: message, wecom });
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

const VERSION = '1.9.0';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
    }

    try {
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
        // 传入全部 query 参数，使 v.<name> / var.<name> 自定义变量一并进入渲染层；
        // title/content 的字段别名兼容逻辑仍在 createMessage 内统一处理。
        const data = Object.fromEntries(url.searchParams.entries());
        if (!data.source) data.source = 'url';
        return await createMessage(env, data);
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
        if (!(await hasReadPermission(request, url, env))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        return json({ ok: true, deleted: await clearMessages(env) });
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
        const key = decodeURIComponent(sendMatch[1]);
        const data = method === 'GET'
          ? Object.assign(Object.fromEntries(url.searchParams.entries()), {
              source: url.searchParams.get('source') || 'serverchan',
            })
          : await parseBody(request);
        return await serverchanSend(env, key, data);
      }

      // ===================== RouterHook 专用接收接口 =====================
      // POST /api/routerhook/{event}?device=XXX
      // RouterHook 的 sender.sh 用 `grep "success"` 判定推送成功，因此响应体必须含 "success"。
      // 普通事件（manuINFO/cronINFO/ifUP/newDHCP）立即落库；rh_* 传感器进入 DO 聚合窗口。
      const rhMatch = path.match(/^\/api\/routerhook\/([^/]+)$/);
      if (rhMatch && method === 'POST') {
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
