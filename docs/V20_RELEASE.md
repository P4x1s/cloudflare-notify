# Cloudflare Notify v2.0.0 升级说明

> 发布日期：2026-11-27
> 定位：从「个人工具」升级为「可交付给团队使用的通知中心」。单文件部署方式不变，旧接口保持兼容。

---

## 1. 兼容性

- Worker 入口仍是单个 `worker.js`，KV 绑定名仍是 `NOTIFICATIONS`，Durable Object 仍是 `RouterHookSensorDO`。
- `GET /send`、`POST /api/send`、方糖兼容端点 `/<key>.send`、RouterHook 接口全部保持原有字段与返回码。
- 旧响应字段 `wecom: { configured, ok, error }` 保留；新增 `channels: [...]` 与 `silenced`。
- 未配置任何新功能时，行为与 v1.9.2 一致（渠道默认全部回退到环境变量中的 `WECOM_WEBHOOK`）。
- 版本号：`/api/status` 与 `{version}` 变量均返回 `2.0.0`。

---

## 2. 功能完善

### 2.1 统一渠道抽象层（C1/C2/C3/C4/C6）

- 新增统一接口 `sendChannel(channel, message, env)`，所有渠道返回 `{ id, name, configured, ok, skipped?, error?, ms? }`。
- 已实现渠道：
  - **企业微信**：沿用原有 markdown 消息格式与失败告警逻辑；
  - **钉钉**：`msgtype: markdown`，补全必填的 `title` 字段，元信息改用普通行（钉钉不支持 `>` 引用块）；
  - **飞书**：`msg_type: interactive` 卡片，标题 + 正文 + 来源时间分层。
- `dispatchChannels()` 遍历已启用且已配置的渠道，`Promise.allSettled` 语义并行发送，单个渠道失败不影响其他渠道。
- 每条消息的投递结果写入 `meta:delivery`（环形缓冲 30 条），新增 `channel` 字段；`/api/messages` 返回 `deliveries` 映射，面板可看到每条消息各渠道的送达状态。
- 面板新增「通知渠道」模块：状态徽标、Webhook 输入框（password）、启用开关、测试发送、保存配置。读取接口对 Webhook 脱敏。

### 2.2 消息管理（E1/U2）

- `DELETE /api/messages/:id`：删除单条消息，写 `meta:audit` 审计记录。
- 面板：关键词搜索（标题/正文/来源）、来源 chips 过滤、按今天/昨天/日期分组、复制内容、重新推送、删除。
- 清空与删除均改为自定义确认弹窗，不再使用浏览器原生 `confirm()`。

### 2.3 规则与模板（C5/E3/E5/E4）

- `GET/PUT /api/templates`：命名模板，格式 `{ "deploy": { "title": "...", "content": "..." } }`，发送时传 `template=deploy`；变量用 `{name}` 占位，服务端渲染。
- `GET/PUT /api/settings`：静默时段设置（`quietEnabled` / `quietStart` / `quietEnd` / `quietChannels`）。静默期内消息正常落库，只跳过外发渠道。
- 幂等：`X-Idempotency-Key` Header 或 `idempotency_key` 参数，24 小时有效，重复请求直接返回首次结果，不重复落库与推送。
- 面板「预览变量」可实时查看 `{date}` 等内置变量渲染结果，未知变量原样保留。

### 2.4 容量优化

- 消息写入带 `expirationTtl`，默认 90 天，可用 `MESSAGE_TTL_DAYS` 调整（1～365 天），防止 KV 1GB 上限被长期累积占满。
- 面板轮询从固定 5 秒改为自适应：无变化时 5 秒 → 15 秒 → 30 秒；有变化或手动刷新立即重置。多标签页场景下 KV 读次数可下降 3～6 倍。

---

## 3. 安全加固

| 措施 | 说明 |
| --- | --- |
| 发送限流 | 按 IP 与密钥指纹双维度滑动窗口。默认单 IP 60 次/分、500 次/天；单密钥 120 次/分、1000 次/天。超限返回 429 + `Retry-After` |
| 入站 HMAC 签名 | 设置 `INBOUND_SIGNING_SECRET` 后，写请求必须带 `X-Cfn-Signature: sha256=<HMAC-SHA256(密钥, 原始请求体)>`；未配置时保持旧行为 |
| Webhook 校验 | 只允许 HTTPS；拒绝 localhost、127/8、10/8、192.168/16、172.16/12、169.254/16 与 `.local`，阻止 SSRF 指向内网 |
| 请求体上限 | 256KB，超限返回 413 |
| 写操作鉴权 | 删除、清空、配置变更需要 `SEND_TOKEN`；若启用了 `READ_TOKEN`，会话 Cookie 也可执行；两者都未设置的公开模式保持旧行为 |
| 常量时间比较 | 方糖兼容端点的 key 校验改用 `timingSafeEqual`，避免时序侧信道 |
| 审计日志 | 删除、清空、渠道/模板/设置变更写入 `meta:audit`（最多 30 条），`/api/status` 可见最近 5 条 |
| 错误信息脱敏 | 新渠道的错误同样经 `sanitizePushError()` 处理，Webhook key 不会出现在响应与日志中 |

---

## 4. 新增 API

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/channels` | 查看权限 | 渠道列表（Webhook 脱敏），`editable` 表示是否为管理员 |
| PUT | `/api/channels` | 管理主密钥 | 保存渠道配置，可只提交部分渠道 |
| POST | `/api/channels/test` | 管理主密钥 | 测试指定渠道连通性 |
| GET / PUT | `/api/templates` | 查看 / 管理 | 通知模板 |
| GET / PUT | `/api/settings` | 查看 / 管理 | 静默时段设置 |
| DELETE | `/api/messages/:id` | 写权限 | 删除单条消息 |

---

## 5. 配置变量

### 普通变量（可放 `wrangler.toml` 的 `[vars]` 或 Dashboard）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MESSAGE_TTL_DAYS` | `90` | 消息自动过期天数（1～365） |
| `SEND_RATE_PER_MIN` | `60` | 单 IP 每分钟发送上限 |
| `SEND_RATE_PER_DAY` | `500` | 单 IP 每天发送上限 |
| `KEY_RATE_PER_MIN` | `120` | 单密钥每分钟发送上限 |
| `KEY_RATE_PER_DAY` | `1000` | 单密钥每天发送上限 |
| `ROUTERHOOK_WINDOW_SECONDS` | `60` | RouterHook 传感器聚合窗口（30/60/120） |

### Secret（只能放 Dashboard → Secrets）

| 变量 | 说明 |
| --- | --- |
| `INBOUND_SIGNING_SECRET` | 可选；启用入站 HMAC 签名校验 |

> 渠道 Webhook 不再需要写进 Secrets：面板保存到 KV 即可。首次升级不配置时会自动回退读取 `WECOM_WEBHOOK` 环境变量。

---

## 6. 测试与验证

本地共 14 个测试脚本全部通过：

- 既有回归：`_test_delivery`、`_test_integrations`、`_test_real_ts`、`_test_render_dom`、`_test_render_syntax`、`_test_rich`、`_test_routerhook`、`_test_src`、`_test_turnstile`、`_test_ui_polish`、`_test_v14`、`_test_variables`
- 新增专项：
  - `_test_v20.mjs`：42 项，覆盖多渠道分发与单渠道失败隔离、模板与变量渲染、幂等与 TTL、单条删除与审计、静默时段、HMAC 签名、Webhook 安全校验、超大请求体、限流与状态一致性。
  - `_test_ui_v20.mjs`：17 项，在 jsdom 中执行服务端真实渲染的 HTML，验证渠道卡片、搜索/过滤、投递状态、自定义确认弹窗、主题切换、变量预览与移动端操作栏。

执行方式：

```bash
node _test_render_syntax.mjs   # 模板字面量语法校验
node _test_render_dom.mjs      # 真实渲染 DOM 校验
node _test_v20.mjs             # 功能 / 安全 / 逻辑一致性
node _test_ui_v20.mjs          # 界面交互
```

---

## 7. 升级步骤

1. 用新的 `worker.js` 替换 Worker 代码（Dashboard 粘贴或 `wrangler deploy`）。
2. 确认 KV 绑定 `NOTIFICATIONS` 与 Durable Object 绑定 `ROUTERHOOK_SENSOR` 保持不变。
3. 可选：在 Dashboard 添加 `MESSAGE_TTL_DAYS` 等普通变量；如需入站签名，添加 Secret `INBOUND_SIGNING_SECRET`。
4. 打开页面，在「通知渠道」填入钉钉/飞书 Webhook 并点「测试发送」。
5. 访问 `/api/status`，确认 `version` 为 `2.0.0`、`features` 包含新能力。

无需迁移 KV 数据：旧消息、密钥、投递日志均可直接读取。
