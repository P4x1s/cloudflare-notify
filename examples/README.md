# 把通知工具接入任意软件

核心原理：这个工具就是一个 HTTP 接口。让目标软件在"事件发生"时向你的 URL 发一条请求即可，**不需要改 Worker 代码**。

```
你的软件 ──事件发生──> HTTP 请求 ──> Worker /send ──> 网页收件箱 + 企业微信群
```

先准备两样东西：

- **发送地址**：`https://你的域名/send`（线上域名，或本地 `http://localhost:8787/send`）
- **发送密钥**：`SEND_TOKEN`（没设密钥可省略 token 参数，但线上强烈建议设置）

最简单的发送方式，浏览器或 curl 直接访问即可：

```bash
curl "https://你的域名/send?token=你的SEND_TOKEN&title=构建完成&content=耗时23秒"
```

## 三种接入模式

按目标软件的能力选择，从上到下越往下越通用。

### 模式一：软件原生支持 Webhook（最省事）

很多软件（NAS、路由器、监控、SaaS）在"通知设置"里允许填一个 URL。把下面这条填进去：

```
https://你的域名/send?token=你的SEND_TOKEN&title=软件通知
```

若软件允许自定义 POST body，改用 JSON 接口更灵活：

```bash
curl -X POST "https://你的域名/api/send?token=你的SEND_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"磁盘告警","content":"剩余空间 5%","source":"nas"}'
```

要点：
- 原生 Webhook 通常把事件内容放在固定字段（如 `text`、`message`）。本工具兼容 `title`/`text`、`content`/`desp`/`body`，多数情况能直接对上；对不上就用模式二做一次字段转换。
- URL 里的密钥会暴露在软件配置和日志中，注意别把配置截图外传。

### 模式二：软件能运行脚本 / 自定义代码（最通用）

用本目录的 `notify.py`（Python 标准库，零依赖），在任何脚本里一行调用：

```bash
# 配置一次（写进软件的启动脚本 / systemd / CI 环境变量）
export NOTIFY_URL="https://你的域名/send?token=你的SEND_TOKEN"

python notify.py "构建完成" "耗时 23 秒"
python notify.py --title "备份结果" --content "成功" --source "backup"
echo "任务完成" | python notify.py --title "定时任务"
```

也支持把地址和密钥分开配置，避免密钥出现在命令行里：

```bash
export NOTIFY_BASE="https://你的域名/send"
export NOTIFY_TOKEN="你的SEND_TOKEN"
python notify.py --title "告警" --content "CPU 90%"
```

其他语言的等价写法：

**Node.js**
```js
const url = new URL('https://你的域名/send');
url.search = new URLSearchParams({
  token: process.env.SEND_TOKEN,
  title: '构建完成',
  content: '耗时 23 秒',
}).toString();
await fetch(url);
```

**PowerShell**
```powershell
$token = '你的SEND_TOKEN'
$title = [uri]::EscapeDataString('构建完成')
$body  = [uri]::EscapeDataString('耗时 23 秒')
Invoke-RestMethod "https://你的域名/send?token=$token&title=$title&content=$body"
```

**curl（纯命令行）**
```bash
curl -sG "https://你的域名/send" \
  --data-urlencode "token=你的SEND_TOKEN" \
  --data-urlencode "title=构建完成" \
  --data-urlencode "content=耗时 23 秒"
```

### 模式三：CI/CD 流水线

以 GitHub Actions 为例，把密钥放进仓库 Secrets（`SEND_TOKEN`），在 job 末尾加一步：

```yaml
- name: 推送通知
  if: always()
  run: |
    curl -sG "https://你的域名/send" \
      --data-urlencode "token=${{ secrets.SEND_TOKEN }}" \
      --data-urlencode "title=构建${{ job.status }}" \
      --data-urlencode "content=${{ github.repository }} / ${{ github.ref_name }}" \
      --data-urlencode "source=github-actions"
```

GitLab CI、Jenkins、飞流等同理：在流水线脚本里加一条 HTTP 请求，密钥用平台的 Secret 变量注入。

## 字段说明

| 参数 | 含义 | 兼容别名 | 上限 |
| --- | --- | --- | --- |
| `title` | 标题 | `text` | 200 字符 |
| `content` | 正文 | `desp`、`body` | 20000 字符 |
| `source` | 来源标记 | — | 100 字符 |
| `token` | 发送密钥 | `sendkey` | — |

`GET /send` 和 `POST /api/send` 都可发送，响应里 `wecom.ok` 表示企业微信是否推送成功。

## 安全与可靠性

- 密钥别硬编码进公开脚本或仓库，用环境变量 / Secrets 注入。
- 通知地址用 HTTPS；自定义域名由 Cloudflare 自动签发免费证书。
- 极端情况下企业微信接口偶发失败（如限流），消息仍会存入网页收件箱，可在页面补看。
- 免费额度：KV 写入 1000 次/天。高频事件（如每秒日志）不要逐条推送，先聚合再发。

## 本地调试

```bash
cd cloudflare-notify
npx wrangler dev                      # 启动本地 Worker，默认 http://localhost:8787
export NOTIFY_URL="http://localhost:8787/send?token=test-send-123"
python examples/notify.py "测试" "本地联调"
```

`.dev.vars` 里的 `NOTIFICATIONS` 本地 KV 自动使用，无需额外配置。
