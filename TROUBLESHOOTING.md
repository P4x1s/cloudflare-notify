# 兼容端点接入 & 线上排查

## 一、用自有服务替换旧式推送端点

### 你的专属推送地址

你在 Worker Secret 里设置的 `SEND_TOKEN` 就是你的 key（Key）。专属推送地址是：

```
https://你的域名/<SEND_TOKEN>.send
```

例如 `SEND_TOKEN` 为 `my-key-123`，域名为 `notify.example.com`：

```
https://notify.example.com/my-key-123.send?text=标题&desp=正文
```

- 参数 `text`（或 `title`）= 标题；`desp`（或 `content`、`body`）= 正文。
- 支持 GET 和 POST（表单 / JSON 均可）。
- 返回体同时带 `errno`（方糖）和 `code`（Server酱³），两种判定方式都能识别成功：
  ```json
  { "code": 0, "errno": 0, "errmsg": "success", "data": { "pushid": "...", "wecom": { "ok": true } } }
  ```

Web 查看页第一张卡片会自动生成这个地址（需先在「发送测试通知」里填入 SEND_TOKEN），点一下即可复制。

### 哪些软件能接，哪些不能

这是能否迁移的关键，务必看清：

| 软件行为 | 能否用本服务 | 做法 |
| --- | --- | --- |
| 允许填「自定义 Webhook URL / 推送地址 / 服务器地址」 | ✅ 可以 | 填入完整的 `https://你的域名/<key>.send` |
| 允许填「Server酱 SCKEY / sendkey」且可改服务器域名 | ✅ 可以 | 域名填你的域名，key 填 SEND_TOKEN |
| 写死 `https://sc.ftqq.com/<key>.send`，只能填一串 key | ❌ 不可以 | 域名被软件写死，无法改指向本服务 |
| 只支持邮箱 / 钉钉 /  Telegram 等专有协议 | ❌ 不可以 | 协议不同，需软件本身支持 webhook |

判断方法：打开那个软件的通知设置，看有没有一个让你填**完整 URL** 或**服务器地址**的输入框。有就能用，只有一个 key 输入框且提示 sc.ftqq.com 的就不能用。

### 安全提醒

- `SEND_TOKEN` 就是 key，等同发消息权限。设置成 32 位以上随机串，别用简单词。
- key 出现在 URL 里，会被软件日志、浏览器历史记录，注意保管。
- 泄露了就在 Cloudflare Secrets 里改掉 `SEND_TOKEN`，旧 key 立即失效。

## 二、线上页面打不开 / 功能异常排查

### 第一步：确认 Worker 是否活着

浏览器访问：

```
https://你的域名/api/status
```

- **返回一段 JSON**（含 `version`、`diagnostics`）→ Worker 正常，问题在页面加载或网络层面，看第 2、3 步。
- **返回 Cloudflare 错误页（1101 / 500 / 502 等）**→ 代码或绑定有问题，看第 4 步。
- **完全连不上 / 超时**→ 网络层面问题，看第 3 步。

### 第二步：用内置配置自检

打开查看页首页，顶部「配置自检」卡片会逐项显示：

- **Worker 服务**：本页能打开即为正常。
- **KV 存储绑定**：异常说明没绑定 KV。去 Settings → Variables → KV Namespace Bindings 添加，变量名必须是 `NOTIFICATIONS`，然后重新部署。
- **发送密钥 SEND_TOKEN / 查看密钥 READ_TOKEN / 企业微信 WECOM_WEBHOOK**：显示是否已设置。密钥只在服务端判断「有没有设置」，不会在页面明文显示，安全。

也可直接看 `/api/status` 的 `diagnostics` 字段，含义同上。

### 第三步：网络层面（国内访问 workers.dev 常见）

`*.workers.dev` 这个官方域名在部分地区访问不稳定。若 `/api/status` 用 workers.dev 域名连不上，但 Cloudflare Dashboard 里 Worker 显示正常：

1. **绑定自定义域名**（推荐）：Settings → Triggers → Custom Domains → Add Custom Domain，填一个已接入该 Cloudflare 账户的域名，平台自动配 CNAME 和免费 SSL。之后用自定义域名访问。
2. 换网络 / 换 DNS（如 1.1.1.1）排除本地 DNS 污染。
3. 确认访问的是根路径 `https://你的域名/`，不是某个 API 路径。

### 第四步：部署本身出问题

- **代码没生效**：确认在线编辑器里点了 **Save and deploy**，等待部署完成（Dashboard 显示 Success）。
- **粘贴不完整**：确认 `worker.js` 全文粘贴，文件以 `export default { ... }` 结尾；在线编辑器右上角显示的版本号应更新。
- **KV Namespace 没绑定**：见第二步。缺 KV 时首页可能能开，但发消息、列表接口会 500。
- **变量名写错**：KV 绑定名必须是 `NOTIFICATIONS`；密钥名必须是 `SEND_TOKEN` / `READ_TOKEN` / `WECOM_WEBHOOK`，大小写敏感。
- **回滚验证**：若刚改过代码出问题，用 Dashboard 的 Deployments 回到上一个成功的版本。

### 快速自检清单

```
[ ] 访问 /api/status 有 JSON 返回
[ ] diagnostics.kvOk = true
[ ] SEND_TOKEN 已设置
[ ] 用自定义域名（而非 workers.dev）访问
[ ] Dashboard 部署状态 = Success
[ ] 首页顶部配置自检全绿
```

---

## 附录：RouterHook 接入排障（v1.8）

完整教程见 [docs/ROUTERHOOK.md](docs/ROUTERHOOK.md)。这里只列最常见的坑。

### RouterHook 日志显示「推送失败」

 RouterHook 的 `routerhook_sender.sh` 靠**响应体是否包含 `success` 字符串**判定成功。本服务正常响应一定含 `"success":"success"`。若显示失败：

- 看响应体：400（JSON/事件名问题）、401（密钥错误）、500（服务端异常）；
- 密钥是否**当前**轮换密钥——轮换后旧 key 立即失效，所有设备都要更新 `X-Token`；
- `Authorization` 头若使用，必须是 `Bearer <密钥>`（空格分隔）。

### 通知中心收不到普通消息

1. Hook URL 是否为 `https://你的域名/api/routerhook/_PRM_EVENT`（`_PRM_EVENT` 会被替换成事件名）；
2. 普通事件的 JSON 里是否有 `msgTYPE` 字段——`manuINFO`/`cronINFO` 由 RouterHook 自动加；
3. `/api/status` 是否 `kvOk: true`；
4. 看 Dashboard Logs 是否有 `[notify] unhandled error`。

### 传感器只收到单条、没有聚合

说明 **Durable Object 绑定缺失**，`ROUTERHOOK_SENSOR` 未绑定时会自动降级为逐条即时通知（数据不丢失但不聚合）。修复：

- Dashboard → Worker → Settings → Bindings → Add → Durable Object → 变量名 `ROUTERHOOK_SENSOR`、类 `RouterHookSensorDO`；
- 用 wrangler 部署则确认 `wrangler.toml` 里 `[[durable_objects.bindings]]` 与 `[[migrations]]` 都在。

### 传感器汇总一直不来

- 默认窗口 60 秒：第一条数据到达后满 60 秒才生成汇总，请耐心等待；
- 确认没有把 `ROUTERHOOK_WINDOW_SECONDS` 设成非法值（只接受 30/60/120）；
- Dashboard Logs 搜索 `[routerhook-do]` 看 Alarm 是否报错。

### 企业微信没有传感器通知

这是**设计如此**：企业微信只接收聚合后的汇总通知（窗口到期时推一次），不接收逐条传感器，避免刷屏。普通事件仍即时推送。

### 多设备数据串到一起

检查每台路由器的 Hook URL 是否带了不同的 `?device=` 参数，例如 `?device=RAX50` 与 `?device=AX86U`。虚拟传感器没有 `sysINFO`，**必须**用 URL 参数指定设备，否则全部归到默认设备 `Router`。

### HTTP 500 且日志是 KV 写入额度错误

Cloudflare 免费版 KV 写入 **1000 次/天，按账户共享**。检查账户内其它 Worker（如 uptime 监控类）是否高频写入 KV。传感器聚合已把逐条写入压缩为窗口级，但其它服务的写入仍会占用同一额度。
