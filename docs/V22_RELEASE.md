# v2.2.0 升级说明

> 发布日期：2026-11-27
> 定位：v2.1 功能全量落地后的安全与体验补强版本。单文件 Worker 架构不变，旧接口保持兼容。

## 一、本次新增

### 1. 主密钥可保存（显式 opt-in）

- 「密钥与轮换」区块新增 **记住主密钥（仅存本机浏览器）** 开关。
  - 勾选时把 `SEND_TOKEN` 写入 `localStorage.cfn_master_token`，刷新页面自动回填输入框；
  - 取消勾选或输入框留空时立即删除本地值；
  - 「清除已保存的主密钥」按钮配自定义确认弹窗，一键删除本地值并清空输入框。
- 安全边界：
  - 不进入 URL、不进入服务端日志、不随 `/api/export` 下载；
  - 不写入 DOM 属性，仅设置输入框 `value`；
  - 已保存主密钥时，`/api/channels` 读取请求会带 `X-Token`，面板直接进入可编辑模式。
- 使用建议：仅在自己专属设备勾选；公共电脑保持关闭。

### 2. 三渠道测试入口

- 「发送测试通知」区块在「测试企微」之外新增 **测试钉钉**、**测试飞书**。
- 三个按钮统一调用新端点 `POST /api/test-channel`，可传 `{"id":"dingtalk"}` 或 `?id=feishu`；缺省 `wecom`。
- 按钮按 `/api/status` 中各渠道的实际配置状态独立启用，徽标显示 `N/3 渠道可用`。
- 旧端点 `POST /api/test-wecom` 保留为别名，行为与 `id=wecom` 完全一致。
- 测试链路复用发送鉴权（轮换密钥或 `SEND_TOKEN`），无需管理主密钥即可测试。

## 二、安全加固

| 项目 | 变更 | 修复的问题 |
| --- | --- | --- |
| 管理凭据来源 | `hasAdminPermission` 改为只从 `X-Token` / `Authorization: Bearer` / Body 取 token，**不再接受 URL query** | 主密钥出现在浏览器历史、Referer、CDN 与网关日志 |
| 渠道测试保护 | `/api/channels/test` 补齐 IP+密钥限流、可选 HMAC 入站签名校验与操作审计 | 管理测试端点缺少限流与签名，可被用于刷外部 Webhook |
| 统一测试端点 | `/api/test-channel` 与 `/api/test-wecom` 均带限流、签名与审计 | 新增入口不能成为绕过限流的旁路 |
| Webhook 脱敏 | `maskWebhook` 在 query 脱敏之外，新增路径式脱敏（`/hook/<token>`、`/v2/hook/<token>`） | **飞书 Webhook 密钥位于 URL 路径**，旧版在 `/api/status` 与 `/api/channels` 中会完整回显 |
| 文档口径 | OpenAPI 与内嵌文档页明确管理端点不接受 query | 避免使用者按旧示例把主密钥写进 URL |

## 三、修复的真实 BUG

1. **飞书 Webhook 密钥泄露**：`/api/status` 的 `channels[].webhook` 与 `/api/channels` 返回值使用 `maskWebhook`，旧实现只替换 query 参数。飞书机器人地址形如 `https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，密钥在路径中，导致查看权限用户可读到完整密钥。v2.2 已对路径段做脱敏。
2. **渠道面板只读状态不刷新**：即使页面已输入主密钥，`/api/channels` 读取请求未带凭据，`editable` 永远为 false。v2.2 在读取时带上已保存/已输入的主密钥。
3. **渠道测试按钮联动错误**：企微未配置时三个测试按钮一起被禁用。v2.2 按渠道独立判断配置状态。
4. **旧测试版本断言过时**：升级后 4 套既有测试仍断言 `2.1.0`/`2.0.0`，已同步到 `2.2.0`。

## 四、测试与验证

| 测试 | 数量 | 覆盖 |
| --- | --- | --- |
| `_test_v22.mjs` | 51 项 | 管理凭据来源、三渠道测试、限流与签名、Webhook 脱敏、密钥泄露面、XSS/注入/幂等/静默、租户隔离、版本一致性 |
| `_test_ui_v22.mjs` | 29 项 | 主密钥回填/保存/清除、空值保护、DOM 不泄露、三按钮端点与 id、Header 传密钥、i18n 键一致 |
| 全量回归 | 18 套脚本 | 含渲染语法、DOM、RouterHook、富文本消毒、限流、变量、旧版专项等，全部通过 |

测试过程中先发现 1 个真实安全漏洞（飞书 Webhook 路径脱敏）与 3 个测试自身断言问题，均已修复并复测至全绿。

## 五、升级方式

- **Cloudflare Dashboard**：粘贴新版 `worker.js` 或 `wrangler deploy`。
- **流水线部署**：保留现有绑定（KV、Durable Object、Turnstile、Secrets），仅替换脚本正文。
- **无需新增 Secret / 变量**；现有配置与 KV 数据完全兼容。
- 升级后 `/api/status` 的 `version` 返回 `2.2.0`。

## 六、兼容性与注意事项

- `POST /api/test-wecom`、`/api/channels`、`/api/settings` 等旧端点保留。
- 通过 `?token=<SEND_TOKEN>` 调用**管理端点**的脚本将返回 401，需改用 Header 或 Body。发送类端点仍支持 query token。
- 勾选「记住主密钥」后，任何能执行本机脚本的人都能读取该密钥；这是显式权衡，不是默认行为。
