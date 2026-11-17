# Cloudflare Notify

一个参考「方糖 / ServerChan」思路的最小通知工具：部署在 **Cloudflare Workers** 上，用一个 URL 或一次 API 调用发送消息，打开网页即可查看，无需自建服务器。

零成本核心：Workers 免费额度 + KV 免费额度 + 免费自定义域名 + 免费 SSL。

---

## 1. 功能特性

| 能力 | 说明 |
| --- | --- |
| URL 发消息 | `GET /send?token=...&title=...&content=...`，浏览器、curl、快捷指令、Webhook 都能用 |
| API 发消息 | `POST /api/send`，支持 JSON 与表单，兼容方糖的 `title` / `desp` 字段 |
| 即时查看 | Web 页面每 5 秒自动轮询，无需手动刷新 |
| 通知折叠 | 通知默认折叠只显示标题，点击展开正文；支持全部展开/折叠 |
| 密钥分层与轮换 | `SEND_TOKEN` 为管理主密钥（只用于后台轮换），另有可一键随机生成的**轮换推送密钥**填给软件；换后旧密钥立即失效 |
| 三种安全传参 | 密钥可放 Header（`X-Token` / `Authorization: Bearer`）、POST body 或 URL，避免密钥进入 URL 历史与日志 |
| 双密钥 | `SEND_TOKEN` 控制发送/管理，`READ_TOKEN` 控制查看/清空；留空即公开 |
| 自定义域名 | Cloudflare 控制台一键绑定，自动签发证书 |
| 安全响应头 | 已设 CSP、nosniff、Referrer-Policy、X-Frame-Options、Permissions-Policy；CORS 默认收紧为同源 |

---

## 2. 项目结构

```
cloudflare-notify/
├── src/
│   ├── index.js        # Worker 入口：路由、鉴权、请求解析
│   ├── messages.js     # KV 存储层：写入、列表、清空、计数
│   ├── utils.js        # 响应封装、CORS、Token 提取
│   └── ui.html         # 通知查看页面（内嵌进 Worker，无外部静态资源）
├── wrangler.toml       # Cloudflare Workers 配置
├── package.json        # 依赖与脚本
├── .dev.vars.example   # 本地环境变量模板
├── .gitignore
└── README.md
```

设计取舍：把 UI 作为文本导入内嵌到 Worker 中，整个服务只有 **一个 Worker + 一个 KV**，没有 Pages 项目、没有构建步骤、没有数据库，部署与迁移成本最低。

---

## 3. 核心接口与数据格式

### 3.1 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/` | 无（页面内再校验 READ_TOKEN） | 通知查看页面 |
| `GET` | `/api/status` | 无 | 服务状态与是否启用密钥 |
| `GET` | `/send` | 轮换密钥或 SEND_TOKEN | **通过 URL 发送消息（最简方式）** |
| `POST` | `/send` | 轮换密钥或 SEND_TOKEN | 表单发送消息 |
| `POST` | `/api/send` | 轮换密钥或 SEND_TOKEN | JSON / 表单发送消息（密钥可放 Header/body/query） |
| `GET` / `POST` | `/<key>.send` | key 为轮换密钥或 SEND_TOKEN | **方糖 / Server酱 兼容端点**，`text`/`title`=标题，`desp`=正文；返回 `errno` 与 `code` 双码 |
| `POST` | `/api/key/rotate` | **仅** SEND_TOKEN（管理主密钥） | 生成新轮换密钥并写入 KV，旧密钥立即失效；返回 `{ key }` |
| `GET` | `/api/key/current` | **仅** SEND_TOKEN | 查看当前轮换密钥 |
| `POST` | `/api/test-wecom` | 轮换密钥或 SEND_TOKEN | 测试企业微信 Webhook 连通性 |
| `GET` | `/api/messages?limit=50&version=...` | READ_TOKEN | 获取通知列表；带 `version` 且无变化时只返回 `unchanged` |
| `GET` | `/api/count` | READ_TOKEN | 通知总数 |
| `POST` | `/api/clear` | READ_TOKEN | 清空全部通知 |
| `OPTIONS` | 任意 | 无 | CORS 预检 |

### 3.2 发送消息

**方式 A：URL 直发（快捷指令 / 浏览器书签 / 只能填 URL 的软件）**

```
GET https://你的域名/send?token=<轮换密钥>&title=标题&content=正文
```

字段别名（兼容方糖习惯）：`title` 可写作 `text`，`content` 可写作 `desp`。

```
curl "https://你的域名/send?token=<轮换密钥>&title=构建完成&content=耗时%2023s&source=github-actions"
```

**方式 B：JSON API + Header 传密钥（推荐，密钥不进 URL）**

```bash
curl -X POST "https://你的域名/api/send" \
  -H "Content-Type: application/json" \
  -H "X-Token: <轮换密钥>" \
  -d '{"title":"告警","content":"CPU 85%","type":"text","source":"server"}'
```

密钥支持四种传法（优先级从高到低）：

```
X-Token: <key>              ← 推荐：不进 URL，不留历史/日志
Authorization: Bearer <key> ← 推荐：同上
POST body 的 token 字段     ← 推荐：同上
?token=<key> 或 ?sendkey=<key> ← 方便，但会进入 URL 历史/日志
```

**为什么不建议把密钥长期写在 URL 里**：URL 会被浏览器历史、服务器/代理日志、`Referer` 请求头、聊天记录与截图保存，泄露面远大于 Header/body。因此推荐：给软件的 key 用**轮换密钥**（泄露后一键作废），且能用 Header/body 就不用 URL。

**发送成功响应**

```json
{
  "ok": true,
  "code": 0,
  "message": "通知已接收",
  "data": {
    "id": "m1a2b3c4-x7k9p2q",
    "title": "构建完成",
    "content": "耗时 23s",
    "type": "text",
    "source": "github-actions",
    "timestamp": 1763281200000
  }
}
```

**失败响应**：HTTP 401 `{"ok":false,"error":"invalid token"}`；HTTP 400 表示标题和内容都为空。

### 3.3 密钥分层、轮换与安全加固

系统采用两级密钥，职责分离（自 v1.3）：

| 密钥 | 存放位置 | 用途 | 能否轮换 |
| --- | --- | --- | --- |
| **管理主密钥** `SEND_TOKEN` | Cloudflare Secret（运行时只读） | 后台管理：生成/查看轮换密钥；也可发送（兼容旧配置） | 否（需在后台改 Secret） |
| **轮换推送密钥** | KV `meta:sendkey`（64 位随机 hex） | 填进各个软件/URL，日常发送用 | **是，一键生成，旧的立即失效** |

**为何这样设计**：Workers 的 Secret 在运行时无法被代码修改，所以"可轮换的密钥"只能放 KV；而轮换接口本身需要一个不会被轮换掉的凭证鉴权，这个角色由 `SEND_TOKEN` 承担。因此 `SEND_TOKEN` 应视为管理凭证，**绝不填进软件或 URL**；软件里填轮换密钥。

**生成轮换密钥**（Web 页面已内置按钮，也可用 API）：

```bash
# 用管理主密钥鉴权生成新密钥（Header 或 query 均可）
curl -X POST "https://你的域名/api/key/rotate" -H "X-Token: <SEND_TOKEN>"

# 返回：{"ok":true,"key":"<64位新密钥>","hint":"..."}
# 旧密钥此刻起立即失效，把返回的 key 填进软件替换旧值

# 查看当前轮换密钥
curl "https://你的域名/api/key/current" -H "X-Token: <SEND_TOKEN>"
```

> 注意：轮换接口只认 `SEND_TOKEN`，轮换密钥无权调用——防止拿到推送密钥的人反过来轮换掉密钥造成拒绝服务。前提是已设置 `SEND_TOKEN`；未设置时轮换接口返回 401。

**让密钥更安全的六种做法（按推荐度）**：

1. **分层**：软件只用轮换密钥，`SEND_TOKEN` 只在后台管理用，永不出现在链接中。
2. **换传参**：优先用 Header（`X-Token`/`Authorization: Bearer`）或 POST body，密钥不进 URL，避免浏览器历史、日志、`Referer` 与截图泄露。
3. **定期轮换**：一旦怀疑泄露，立刻点"生成新推送密钥"，旧 key 即时失效，无需重新部署。
4. **一软件一密钥**（进阶）：本 Demo 只维护一个当前密钥；如需按软件隔离，可给不同软件轮换并分别记录，代价是管理复杂度上升。
5. **绑定自定义域名 + HTTPS**：走自己的域名，避免 `workers.dev` 的不稳定与中间环节；Cloudflare 自动签发免费证书。
6. **控制查看权限**：设置 `READ_TOKEN`，避免任何人都能读取全部通知内容。

> 仍有边界需要说明：只要软件只能填 URL（方糖类），key 就必然出现在那一条 URL 里，无法做到"密钥完全不进 URL"。能做的上限是「用可随时作废的轮换密钥 + 定期轮换」，把泄露窗口压到最小；签名/HMAC 这类防重放机制对只支持填 URL 的软件无能为力，故本 Demo 未引入。

**平台侧纵深防御（v1.3.1 起，无需配置，已内置）**：

| 措施 | 作用 |
| --- | --- |
| `Content-Security-Policy` | 限制脚本/样式来源为 self + 内联、禁止外部资源与 iframe 嵌套，缓解 XSS 数据外带 |
| `X-Content-Type-Options: nosniff` | 禁止 MIME 嗅探，防类型混淆攻击 |
| `Referrer-Policy: no-referrer` | 页面不向外站发送来源信息 |
| `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` | 防点击劫持 |
| `Permissions-Policy` | 禁用摄像头/麦克风/定位/支付等无关能力 |
| CORS 默认同源 | 移除旧版 `Access-Control-Allow-Origin: *`，跨站脚本无法读取 API；同源页面、curl、服务端 Webhook 不受影响 |
| 错误脱敏 | 内部异常只写 console、对客户端返回通用错误；公开的 `/api/status` 不回传底层异常原文 |
| 输出转义 | 所有通知字段经 HTML 实体转义后渲染，折叠交互用事件委托而非内联 `onclick` |

> 说明：UI 是单文件内嵌（内联 `<script>`/`<style>` 是其运行前提），因此 CSP 保留了 `'unsafe-inline'`。若要进一步收紧为纯 `'self'`，需把脚本与样式拆成独立静态资源，届时将不再是单文件部署。

### 3.4 读取消息

```
GET /api/messages?limit=50
GET /api/messages?limit=50&version=<上次响应中的 version>   # 增量检查
```

```json
{
  "ok": true,
  "unchanged": false,
  "version": "1763281200000",
  "count": 1,
  "messages": [
    {
      "id": "m1a2b3c4-x7k9p2q",
      "title": "构建完成",
      "content": "耗时 23s",
      "type": "text",
      "source": "github-actions",
      "timestamp": 1763281200000
    }
  ]
}
```

`limit` 取值 1–200，默认 50。`timestamp` 为毫秒级 Unix 时间戳。
当客户端传入的 `version` 与服务端一致时，响应为 `{"ok":true,"unchanged":true,"version":"..."}`，Worker **不会读取全量列表**，这是控制免费额度的关键机制。

### 3.4 KV 数据格式

每条消息一个 KV 对象：

- **Key**：`msg:<16 位倒序时间戳>-<唯一 ID>`。倒序时间戳让 `KV.list()` 的字典序结果天然按时间倒序，避免全量排序。
- **Value**：上述消息对象的 JSON 字符串。
- **Metadata**：`{ id, timestamp }`（纯 ASCII，避免内部头编码兼容问题）。

---

## 4. Cloudflare 配置与环境变量

### 4.1 `wrangler.toml` 关键项

```toml
name = "cloudflare-notify"          # 决定 *.workers.dev 子域名
main = "worker.js"                  # 单文件版（推荐）；src/ 为历史多文件实现
compatibility_date = "2026-11-16"

[[kv_namespaces]]
binding = "NOTIFICATIONS"
id = "你的_KV_命名空间_ID"
preview_id = "你的_预览_KV_ID"      # wrangler dev --remote 时使用

[vars]
APP_NAME = "Cloudflare Notify"      # 非敏感变量
```

### 4.2 环境变量

| 变量 | 类型 | 必填 | 位置 | 说明 |
| --- | --- | --- | --- | --- |
| `SEND_TOKEN` | Secret | 建议 | `.dev.vars` / `wrangler secret put` | **管理主密钥**：轮换/查看推送密钥，也可发送；不进 URL；不设置则任何人可发送且无法轮换 |
| `READ_TOKEN` | Secret | 可选 | 同上 | 查看与清空密钥；不设置则页面公开 |
| `WECOM_WEBHOOK` | Secret | 可选 | 同上 | 企业微信群机器人 Webhook；配置后消息主动推到群 |
| `APP_NAME` | var | 否 | `wrangler.toml` | 展示名称 |
| `meta:sendkey` | KV（自动生成） | 否 | Dashboard KV / 轮换接口 | 轮换推送密钥，软件填这个；由 `/api/key/rotate` 写入，无需手动配置 |

本地：

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，设置 SEND_TOKEN 与 READ_TOKEN
```

线上（密钥不要写进 `wrangler.toml`）：

```bash
npx wrangler secret put SEND_TOKEN
npx wrangler secret put READ_TOKEN
```

---

## 5. 自定义域名绑定要点

1. **前提**：域名需接入当前 Cloudflare 账户（免费计划即可），且处于 Active 状态。
2. **绑定路径**：Cloudflare Dashboard → **Workers & Pages** → `cloudflare-notify` → **Settings** → **Triggers** → **Custom Domains** → **Add Custom Domain**。
3. 输入完整域名，如 `notify.example.com`，Cloudflare 会自动完成：
   - 添加 `CNAME` 记录指向 Worker；
   - 签发并续期 Universal SSL 证书。
4. **根域名**（`example.com`）同样支持；若与 `@` 的 A 记录冲突，先删除冲突记录。
5. 生效时间通常为数分钟到数小时（取决于 DNS TTL）。
6. 绑定后 `*.workers.dev` 地址仍可用；如需关闭，在 Settings 中禁用即可。
7. 也可以通过 Wrangler 配置路由（适用于已有 Zone）：

```toml
[[routes]]
pattern = "notify.example.com/*"
zone_name = "example.com"
```

> 注意：使用 `[[routes]]` 时域名所在 Zone 必须在本账户内；两种绑定方式不要重复配置同一域名。

---

## 6. 本地运行与验证步骤

### 6.1 环境准备

- Node.js 18+（含 npm）
- 一个 Cloudflare 账户（免费即可）

### 6.2 本地启动

```bash
cd cloudflare-notify
npm install
cp .dev.vars.example .dev.vars     # 按需修改密钥
npm run dev
```

默认地址：`http://localhost:8787`。本地 KV 由 Wrangler 自动模拟，数据保存在 `.wrangler/state`，**无需先创建线上 KV**。

### 6.3 本地接口验证

```bash
# 1) 查看状态
curl http://localhost:8787/api/status

# 2) 发送（把 TOKEN 换成 .dev.vars 里的 SEND_TOKEN）
curl "http://localhost:8787/send?token=TOKEN&title=测试&content=Hello%20World&source=local"

# 3) 读取列表（若设了 READ_TOKEN，加 -H "X-Token: TOKEN"）
curl "http://localhost:8787/api/messages?limit=10"

# 4) 统计
curl "http://localhost:8787/api/count"

# 5) 错误鉴权：应返回 401
curl -i "http://localhost:8787/send?title=无密钥"

# 6) 清空
curl -X POST "http://localhost:8787/api/clear"
```

浏览器打开 `http://localhost:8787`：若设置了 `READ_TOKEN` 会弹出登录框；输入后应看到刚才发送的通知，并在 5 秒内自动更新。

### 6.4 部署到 Cloudflare

```bash
# 1) 登录 Cloudflare
npx wrangler login

# 2) 创建 KV 命名空间，把输出的 id / preview_id 回填到 wrangler.toml
npm run kv:create

# 3) 设置线上密钥（交互式输入）
npx wrangler secret put SEND_TOKEN
npx wrangler secret put READ_TOKEN

# 4) 部署
npm run deploy
```

部署成功后终端会输出 Worker URL，例如 `https://cloudflare-notify.<子域>.workers.dev`。

### 6.5 线上验证

```bash
BASE="https://cloudflare-notify.<子域>.workers.dev"

curl "$BASE/api/status"
curl "$BASE/send?token=<SEND_TOKEN>&title=线上测试&content=部署成功"
curl -H "X-Token: <READ_TOKEN>" "$BASE/api/messages"
```

再用浏览器打开 Worker URL 与自定义域名，确认页面能加载、消息能显示。可用 `npm run tail` 实时查看运行日志排查问题。

---

## 7. 免费额度与限制

| 资源 | 免费额度 | 对本工具的影响 |
| --- | --- | --- |
| Workers 请求 | 100,000 次/天 | 页面每 5 秒轮询约 17,280 次/天（单人常开），额度充足 |
| KV 读取 | 100,000 次/天 | **增量检查**下无新消息时每次轮询仅 1 次读取（约 17,280/天）；有新消息时额外 1 次 list + N 次 get |
| KV 写入 | 1,000 次/天 | 发送一次 = 2 次写入（消息 + 版本号），个人通知足够 |
| KV 存储 | 1 GB | 单条正文上限 20,000 字符 |
| 自定义域名 / SSL | 免费且不限 | 可绑定多个域名 |

优化机制与建议：
- **增量检查（默认开启）**：Web UI 轮询时携带上次响应的 `version`；无新消息时 Worker 只读一个版本号 key，不拉取消息列表，把每次轮询的 KV 读取量从「1 + 消息条数」降到 1。
- 页面处于后台标签页时自动暂停轮询。
- 若仍接近上限，把 `src/ui.html` 中的 `REFRESH_MS` 调大（如 15000，约 5,760 次/天）。
- 消息长期不清理会占满列表；可定期调用 `/api/clear`，或在页面点击「清空」。

---

## 8. 常见用法示例

**GitHub Actions**

```yaml
- name: 发送通知
  run: |
    curl -sG "https://notify.example.com/send" \
      --data-urlencode "token=${{ secrets.SEND_TOKEN }}" \
      --data-urlencode "title=构建完成" \
      --data-urlencode "content=分支 ${{ github.ref_name }} 已部署"
```

**iOS 快捷指令**：「获取 URL 内容」→ URL 填入带 `token/title/content` 的 `/send` 地址，GET 请求即可。

**Linux 定时任务**

```bash
curl -sG "https://notify.example.com/send" \
  --data-urlencode "token=xxx" \
  --data-urlencode "title=备份完成" \
  --data-urlencode "content=$(date)"
```
