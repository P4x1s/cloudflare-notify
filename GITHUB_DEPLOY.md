# 从 GitHub 导入部署 Cloudflare Notify（含 404 排查）

这份目录是**可直接上传到 GitHub 的完整项目**。按本文操作即可导入 Cloudflare 并打开页面。

---

## 0. 先看懂：你遇到的 404 是怎么回事

如果 Worker 真的跑起来了，访问根路径 `/` 会直接显示通知页面（即使没配 KV、没配密钥也一样能打开）。**返回 404 说明请求根本没到达这段代码**，最常见的原因只有一个：

> **你在 Cloudflare 创建的是 Pages 项目，而不是 Workers。**

Cloudflare 后台有两个入口，名字很像，行为完全不同：

| 入口 | 找什么文件 | 本项目结果 |
| --- | --- | --- |
| **Workers**（正确） | 按 `wrangler.toml` 的 `main = "worker.js"` 执行 | ✅ 页面正常 |
| Pages（错误） | 找静态 `index.html` / 构建产物 | ❌ 没有 → 404 |

**结论：导入时必须走 Workers 的 "Connect to Git"，不要进 Pages。**

---

## 1. 上传到 GitHub

1. GitHub → New repository，建议命名 `cloudflare-notify`，可见性随意（私有亦可）。
2. 不要勾选 README / .gitignore / license 初始化，建一个空仓库。
3. 把本目录里的**全部文件和文件夹**上传到该仓库根目录（可直接把文件拖进网页上传框）：
   ```
   .dev.vars.example   .gitignore   README.md   TROUBLESHOOTING.md
   GITHUB_DEPLOY.md    package.json  package-lock.json  wrangler.toml
   worker.js
   examples/           src/
   ```
4. 确认仓库里**没有** `.dev.vars`（含真实 Webhook 密钥的文件）——本目录已排除，不要从原项目单独补传。

---

## 2. 用 Workers 导入（关键步骤）

1. 登录 Cloudflare Dashboard → 左侧 **Workers & Pages**。
2. 点 **Create** → 顶部选 **Workers** 标签 → 找到 **Connect to Git**（或 "Import from GitHub"）。不要点 Pages 的 "Connect to Git"。
3. 首次会要求授权 GitHub，按提示授权，选中刚建的仓库。
4. 构建配置按如下填写：
   - **Build command**：留空（单文件无需构建）
   - **Deploy command**：`npx wrangler deploy`
   - **Root directory**：留空（仓库根目录）
   - Wrangler 会自动读取 `wrangler.toml`
5. 点 **Save and Deploy**，等待首次部署完成。

> 若 Cloudflare 界面是旧版：Workers & Pages → Create a Worker → 选 "Connect to Git" 入口，其余一致。只要最终创建出来的是 **Workers**（左侧列表图标是 Workers 而非 Pages），步骤就对。

---

## 3. 确认页面能打开

部署完成后，打开 Cloudflare 给你的地址（`https://cloudflare-notify.<你的子域>.workers.dev`）：
- 出现通知页面 = 部署成功，404 已解决；
- 仍是 404 = 返回第 2 步核对是不是选成了 Pages。

再访问 `https://<你的地址>/api/status`，应返回一段含 `version: "1.2.0"` 和 `diagnostics` 的 JSON。这是页面自检数据，可据此确认各项配置状态。

---

## 4. 绑定 KV（让消息能存下来）

页面能开之后，补上存储：

1. 该 Worker → **Settings** → **Bindings** → **Add** → **KV Namespace**。
2. Variable name 必须精确填写 `NOTIFICATIONS`（大小写一致，代码靠这个名字找 KV）。
3. KV Namespace 选 **Create new namespace**，起名如 `cloudflare-notify-kv`，创建后选中它。
4. 保存后立即生效，无需重新部署。

验证：再访问 `/api/status`，`diagnostics.kvBound` 和 `kvOk` 都应为 `true`。

> 通过 GitHub 自动部署时，Dashboard 里加的绑定不会被 `wrangler.toml` 覆盖（本目录的配置未声明 KV，因此无冲突）。若你日后改为在 `wrangler.toml` 里写 KV，见该文件底部注释。

---

## 5. 配置密钥（Secrets）

该 Worker → **Settings** → **Variables** → **Secrets** → **Add**：

| 变量名 | 是否必填 | 作用 |
| --- | --- | --- |
| `SEND_TOKEN` | 强烈建议 | 发送密钥，也是方糖风格 key； `/<SEND_TOKEN>.send` 用得上 |
| `READ_TOKEN` | 可选 | 查看/清空密钥；留空则查看页公开 |
| `WECOM_WEBHOOK` | 可选 | 企业微信群机器人 Webhook 完整 URL，配了才会主动推群 |

> 这些值不要写进 GitHub 仓库文件。Secrets 存在 Cloudflare 后台，保存即生效。

---

## 6. 发一条消息验证

```
https://<你的域名>/send?token=<SEND_TOKEN>&title=测试&content=来自GitHub部署
```
返回 `"ok": true` 且页面能看到这条消息即全链路打通。若配了 `WECOM_WEBHOOK`，响应里还会带 `wecom.ok` 字段反映推送结果。

---

## 7. 常见错误对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 404 | 建成了 Pages | 删掉重建，走 Workers → Connect to Git |
| 部署失败，报 KV namespace 找不到 | `wrangler.toml` 里 KV ID 是占位符 | 用本目录的 `wrangler.toml`（已去掉 KV 绑定） |
| 页面能开但发消息 500 | KV 未绑定 | 按第 4 步绑定 `NOTIFICATIONS` |
| `/api/status` 里 `needSendToken:false` | 没设 `SEND_TOKEN` | 按第 5 步添加 Secret |
| 地址被占用 | 子域名全局唯一 | 改 `wrangler.toml` 的 `name` 后重新提交、重新部署 |

---

## 8. 本项目文件说明

| 文件 | 作用 |
| --- | --- |
| `worker.js` | 核心单文件：路由、KV 存储、Web 页面、企业微信推送、方糖兼容端点全在这里 |
| `wrangler.toml` | Workers 部署配置（GitHub 导入专用，已避开占位符 KV 陷阱） |
| `GITHUB_DEPLOY.md` | 本文档 |
| `README.md` / `TROUBLESHOOTING.md` | 接口文档与排查手册 |
| `.dev.vars.example` | 环境变量模板（无真实密钥） |
| `examples/` | 软件接入脚本 `notify.py` 与说明 |
| `src/` | 历史多文件版，仅作参考，不参与部署 |

敏感文件 `.dev.vars` 已排除。本目录任何文件都不含真实 Webhook 或密钥，可安全上传公开仓库。
