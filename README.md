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
| 双密钥 | `SEND_TOKEN` 控制发送，`READ_TOKEN` 控制查看/清空；留空即公开 |
| 自定义域名 | Cloudflare 控制台一键绑定，自动签发证书 |
| 跨域支持 | 已配置 CORS，可被任意来源的脚本调用 |

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
| `GET` | `/send` | SEND_TOKEN | **通过 URL 发送消息（最简方式）** |
| `POST` | `/send` | SEND_TOKEN | 表单发送消息 |
| `POST` | `/api/send` | SEND_TOKEN | JSON / 表单发送消息 |
| `GET` / `POST` | `/<SEND_TOKEN>.send` | key 即路径中的 SEND_TOKEN | **方糖 / Server酱 兼容端点**，`text`/`title`=标题，`desp`=正文；返回 `errno` 与 `code` 双码 |
| `POST` | `/api/test-wecom` | SEND_TOKEN | 测试企业微信 Webhook 连通性 |
| `GET` | `/api/messages?limit=50&version=...` | READ_TOKEN | 获取通知列表；带 `version` 且无变化时只返回 `unchanged` |
| `GET` | `/api/count` | READ_TOKEN | 通知总数 |
| `POST` | `/api/clear` | READ_TOKEN | 清空全部通知 |
| `OPTIONS` | 任意 | 无 | CORS 预检 |

### 3.2 发送消息

**方式 A：URL 直发（推荐给快捷指令 / 浏览器书签 / 监控脚本）**

```
GET https://你的域名/send?token=<SEND_TOKEN>&title=标题&content=正文
```

字段别名（兼容方糖习惯）：`title` 可写作 `text`，`content` 可写作 `desp`。

```
curl "https://你的域名/send?token=my-secret&title=构建完成&content=耗时%2023s&source=github-actions"
```

**方式 B：JSON API**

```bash
curl -X POST "https://你的域名/api/send?token=my-secret" \
  -H "Content-Type: application/json" \
  -d '{"title":"告警","content":"CPU 85%","type":"text","source":"server"}'
```

也可把密钥放在请求头（三种方式等价）：

```
X-Token: my-secret
Authorization: Bearer my-secret
?token=my-secret  或  ?sendkey=my-secret
```

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

### 3.3 读取消息

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
| `SEND_TOKEN` | Secret | 建议 | `.dev.vars` / `wrangler secret put` | 发送密钥；同时是方糖端点的 key；不设置则任何人可发送 |
| `READ_TOKEN` | Secret | 可选 | 同上 | 查看与清空密钥；不设置则页面公开 |
| `WECOM_WEBHOOK` | Secret | 可选 | 同上 | 企业微信群机器人 Webhook；配置后消息主动推到群 |
| `APP_NAME` | var | 否 | `wrangler.toml` | 展示名称 |

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
