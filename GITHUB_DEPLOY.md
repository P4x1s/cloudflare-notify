# Cloudflare Notify 完整部署教程（GitHub 导入 · 2026 版）

本文带你从零部署这套通知工具：从 GitHub 导入 Cloudflare Workers，到能发消息、收到企业微信推送、绑定自己的域名。按 `GITHUB_DEPLOY.md` 全篇操作即可，无需本地环境。

项目仓库：`https://github.com/P4x1s/cloudflare-notify`

---

## 目录

- [0. 先看清三个概念，避免走弯路](#0-先看清三个概念避免走弯路)
- [1. 前置准备](#1-前置准备)
- [2. 从 GitHub 导入部署（核心步骤）](#2-从-github-导入部署核心步骤)
- [3. 验证页面能打开](#3-验证页面能打开)
- [4. 绑定 KV 命名空间（让消息能存下来）](#4-绑定-kv-命名空间让消息能存下来)
- [5. 配置密钥 Secrets](#5-配置密钥-secrets)
- [6. 发送测试消息，验证全链路](#6-发送测试消息验证全链路)
- [7. 绑定自定义域名（可选但推荐）](#7-绑定自定义域名可选但推荐)
- [8. 日常使用：三种发送消息方式](#8-日常使用三种发送消息方式)
- [9. 自动部署：改代码后自动上线](#9-自动部署改代码后自动上线)
- [10. 免费额度说明](#10-免费额度说明)
- [11. 常见错误对照表](#11-常见错误对照表)
- [12. 另一种部署方式：在线粘贴单文件](#12-另一种部署方式在线粘贴单文件)

---

## 0. 先看清三个概念，避免走弯路

### Workers 还是 Pages？—— 404 的根源

Cloudflare 后台有两个入口，名字很像，行为完全不同。**这个工具是 Workers，不是 Pages。**

| 入口 | 运行方式 | 本项目的结果 |
| --- | --- | --- |
| **Workers**（正确） | 按 `wrangler.toml` 的 `main = "worker.js"` 执行一段服务端代码 | ✅ 页面正常 |
| Pages（错误） | 找静态 `index.html` 或前端构建产物 | ❌ 找不到 → 404 |

> 你之前遇到的 404，几乎可以确定是建成了 Pages。 Pages 去找静态首页，而本项目没有 `index.html`，返回 404。**删掉重建，走 Workers 入口即可解决。**

### 三种"变量"分别放什么

| 类型 | 放哪里 | 例子 |
| --- | --- | --- |
| 代码配置 | GitHub 仓库里的 `wrangler.toml` | Worker 名称、入口文件 |
| 绑定 Binding | Dashboard → Settings → Bindings | KV 命名空间 `NOTIFICATIONS` |
| 密钥 Secret | Dashboard → Settings → Variables → Secrets | `SEND_TOKEN`、`WECOM_WEBHOOK` |

**密钥绝不写进 GitHub 仓库**——仓库是公开的，写进去等于把发消息权限公开。

### 部署成功的判断标准

不是"页面能开"就算完，完整可用要满足三条，逐项在 `/api/status` 里能看到：
1. `diagnostics.kvBound = true` 且 `kvOk = true`（存储可用）
2. `needSendToken = true`（发送密钥已设）
3. 配了企微时 `wecomConfigured = true`（推送可用）

---

## 1. 前置准备

只需两样，都免费：

1. **Cloudflare 账号**：到 `dash.cloudflare.com` 注册，邮箱验证即可。免费版足够，无需绑卡。
2. **GitHub 账号**：本项目已上传到 `https://github.com/P4x1s/cloudflare-notify`，你可直接用这个仓库导入；若想改成自己的，点右上角 Fork。

> 用现成仓库导入即可，不必重新上传。仓库里已包含全部代码与配置，且不含任何密钥。

---

## 2. 从 GitHub 导入部署（核心步骤）

以下按 Cloudflare 2026 年当前界面（官方文档 2026-10-28 更新）：

1. 登录 Cloudflare Dashboard → 左侧 **Workers & Pages**。
2. 点 **Create application**。
3. 在来源里选 **GitHub**（会列出 Artifacts / GitHub / GitLab 三个选项，选 GitHub）。首次使用会要求 GitHub 授权，点授权并同意。
4. 在仓库列表里选中 `cloudflare-notify`（可用搜索框过滤）。
5. 进入配置页，按下面填：

   | 配置项 | 填写值 | 说明 |
   | --- | --- | --- |
   | Project name / Worker name | `cloudflare-notify` | **必须与 `wrangler.toml` 里的 `name` 完全一致**，否则构建失败 |
   | Production branch | `main` | 默认即可 |
   | Root directory | 留空（仓库根目录） | 配置文件在根目录 |
   | Build command | 留空 | 单文件 Worker 无需构建 |
   | Deploy command | `npx wrangler deploy` | 若已自动填好就不用改 |

   > 官方明确要求：Dashboard 里的 Worker 名称必须匹配 `wrangler.toml` 的 `name`。本仓库该值是 `cloudflare-notify`，照填即可。

6. 点 **Save and Deploy**，等待首次构建完成（通常十几秒）。
7. 成功后 Cloudflare 会给出 `https://cloudflare-notify.<你的子域>.workers.dev` 地址。

> 如果构建失败并提示找不到 KV namespace：确认你用的是本仓库的 `wrangler.toml`——它已注释掉占位符 KV 绑定，不会触发这个错误。

---

## 3. 验证页面能打开

打开 Cloudflare 给你的 `workers.dev` 地址：

- 出现带「配置自检」「发送测试通知」卡片的通知页面 = 部署成功，404 已解决。
- 仍是 404 = 回到第 2 步确认选的是 **Workers** 而不是 Pages。
- 完全打不开（超时）= 多为国内访问 `*.workers.dev` 不稳定，做第 7 步绑定自定义域名，或稍后重试。

再访问 `https://<你的地址>/api/status`，应返回类似这样的 JSON（这是页面自检数据）：

```json
{
  "ok": true,
  "service": "cloudflare-notify",
  "version": "1.2.0",
  "single_file": true,
  "needSendToken": false,
  "needReadToken": false,
  "wecomConfigured": false,
  "diagnostics": {
    "kvBound": false,
    "kvOk": false,
    "kvError": "",
    "serverchanReady": false
  }
}
```

刚部署时 `kvBound/needSendToken` 是 `false` 属于正常——还没绑定，接下来两步补上。

---

## 4. 绑定 KV 命名空间（让消息能存下来）

KV 是 Cloudflare 的键值存储，用来保存通知消息。不绑定时页面能开，但发消息会失败。

1. 该 Worker → **Settings** → **Bindings** → **Add** → **KV Namespace**。
2. **Variable name** 精确填写 `NOTIFICATIONS`（全大写，大小写敏感，代码靠这个名字找 KV）。
3. KV Namespace 选 **Create new namespace**，名称如 `cloudflare-notify-kv`，创建后选中它。
4. 点 **Add binding** 保存。立即生效，无需重新部署。

验证：刷新 `/api/status`，`diagnostics.kvBound` 和 `kvOk` 都变成 `true` 即成功。

> 为什么写在 Dashboard 而不是 `wrangler.toml`？KV 的 ID 是每个人账户独有的，无法预置。本仓库的 `wrangler.toml` 刻意未声明 KV，因此 Dashboard 添加的绑定不会被后续 GitHub 部署覆盖。若你日后想改成写进配置文件，见 `wrangler.toml` 底部注释。

---

## 5. 配置密钥 Secrets

该 Worker → **Settings** → **Variables** → **Secrets** → **Add**，逐个添加：

| 变量名 | 是否必填 | 作用 |
| --- | --- | --- |
| `SEND_TOKEN` | 强烈建议 | 发送密钥，也是方糖风格 key。不设则任何人都能往你的工具发消息 |
| `READ_TOKEN` | 可选 | 查看/清空密钥；留空则查看页面完全公开 |
| `WECOM_WEBHOOK` | 可选 | 企业微信群机器人 Webhook 完整 URL；配了才会主动推群 |

**生成 `SEND_TOKEN`**：用任意密码生成器生成 32 位以上随机字符串，或用命令：

```bash
openssl rand -hex 24
```

**获取 `WECOM_WEBHOOK`**：企业微信 App → 进入群聊 → 右上角「…」→ 群机器人 → 添加机器人 → 复制 Webhook 地址，形如：

```
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key
```

> 这些值只存在于 Cloudflare 后台，保存即生效，不要写进代码或 GitHub。Webhook 地址等同于发消息凭证，泄露后可在群机器人设置里重置。

验证：刷新 `/api/status`，`needSendToken` 和 `wecomConfigured` 应为 `true`。

---

## 6. 发送测试消息，验证全链路

浏览器直接打开（把尖括号内容换成你自己的值）：

```
https://<你的域名>/send?token=<SEND_TOKEN>&title=测试&content=来自Cloudflare
```

返回 `"ok": true` 即发送成功。此时：

- 打开通知页面能看到这条消息 = KV 存储正常；
- 若配了 `WECOM_WEBHOOK`，响应里还有 `"wecom": {"configured": true, "ok": true}` = 企业微信也收到了推送。

也可以点页面上的「测试企微推送」按钮验证连通性（需先设 `SEND_TOKEN`）。

---

## 7. 绑定自定义域名（可选但推荐）

`*.workers.dev` 在国内访问有时不稳定，绑定自己的域名更可靠，也让推送地址更好记。

**前提**：你的域名已接入 Cloudflare（Nameservers 指向 Cloudflare），且该域名下要绑定的主机名没有已存在的 CNAME 记录。

1. 该 Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**。
2. 填入域名，如 `notify.example.com`（可用子域名，避免影响主站）。
3. 点 **Add Custom Domain**。

Cloudflare 会自动创建 DNS 记录并签发 SSL 证书（免费，无需你配置）。等待几十秒生效后，用 `https://notify.example.com` 访问即可。

> 域名必须是在 Cloudflare 账户下激活的 zone；不能用别人的域名，也不能绑到已有 CNAME 的主机名。

---

## 8. 日常使用：三种发送消息方式

部署完成后，这个工具就是一个 HTTP 接口，任何能发 HTTP 请求的东西都能对接。

### 方式一：浏览器 / 快捷指令（最简单）

```
https://<你的域名>/send?token=<SEND_TOKEN>&title=标题&content=正文
```

### 方式二：curl / 脚本（通用）

```bash
curl "https://<你的域名>/send?token=<SEND_TOKEN>&title=构建完成&content=耗时 23s"
```

项目 `examples/notify.py` 是零依赖的 Python 脚本，支持位置参数、`--stdin` 管道，适合接入各种软件：

```bash
NOTIFY_URL="https://<你的域名>/send?token=<SEND_TOKEN>" python notify.py "标题" "正文"
```

Node、PowerShell、GitHub Actions 的等价写法见 `examples/README.md`。

### 方式三：方糖 / Server酱风格 key（给只让填 key 的软件）

你的 `SEND_TOKEN` 就是 key，专属推送地址：

```
https://<你的域名>/<SEND_TOKEN>.send?text=标题&desp=正文
```

兼容方糖的 `text`/`desp` 参数，也兼容 `title`/`content`，返回体同时带 `errno` 和 `code` 双码。

> 限制：只有支持「自定义 Webhook URL / 服务器地址」的软件能填这个完整地址。把域名写死为 `sc.ftqq.com`、只让你填一串 key 的软件无法迁移——它不会把消息发到你的域名。

---

## 9. 自动部署：改代码后自动上线

通过 Workers Builds 导入后，已自动开启 Git 集成：

- 你往 `main` 分支 push 一个 commit → Cloudflare 自动构建并部署新版本。
- 在 Dashboard 该 Worker → **Deployments** → **View build history** 可看每次构建状态和日志（保留 90 天）。
- 非生产分支的构建会生成 Preview（预览环境），不影响线上。

若想临时停止自动上线、只构建不发布，把 Deploy command 改为：

```
npx wrangler versions upload
```

这样每次 push 只生成版本，不会自动切到线上，可手动回滚或发布。

---

## 10. 免费额度说明

Cloudflare 免费版完全够个人通知使用：

| 资源 | 免费额度 | 本项目消耗 |
| --- | --- | --- |
| Workers 请求 | 100,000 次/天 | 页面每 5 秒轮询，单人常开约 17,280 次/天 |
| KV 读取 | 100,000 次/天 | 页面已做增量检查，无新消息时每次仅 1 次读取 |
| KV 写入 | 1,000 次/天 | 发一条消息 = 1 次写入 |
| KV 存储 | 1 GB | 单条正文上限 2 万字符 |
| Workers Builds | 3,000 构建分钟/月 | 单文件构建十几秒，个人更新频率远用不完 |
| 自定义域名 + SSL | 免费且不限 | 可绑多个域名 |

> 若有大量高频事件，先聚合再发，避免触及 KV 写入上限。

---

## 11. 常见错误对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 404 Not Found | 建成了 Pages | 删掉重建，走 Workers → Create application → GitHub |
| 构建失败，提示 Worker name 不匹配 | Dashboard 名称与 `wrangler.toml` 的 `name` 不一致 | 统一填 `cloudflare-notify` |
| 构建失败，报 KV namespace 找不到 | `wrangler.toml` 里 KV ID 是占位符 | 用本仓库版本（已注释掉 KV 绑定） |
| 页面能开但发消息 500 | KV 未绑定 | 按第 4 步绑定 `NOTIFICATIONS` |
| `/api/status` 里 `needSendToken:false` | 没设 `SEND_TOKEN` | 按第 5 步添加 Secret |
| 企业微信没收到消息 | `WECOM_WEBHOOK` 未配或已失效 | 重新获取 Webhook，更新 Secret；点「测试企微推送」验证 |
| 地址被占用 | workers.dev 子域名全局唯一 | 改 `wrangler.toml` 的 `name`，push 后重新部署 |
| `workers.dev` 打不开（超时） | 国内网络对该域名不稳定 | 按第 7 步绑定自定义域名 |
| 自定义域名添加失败 | 域名未接入 Cloudflare，或该主机名已有 CNAME | 先把域名接入 Cloudflare，删掉冲突的 CNAME 记录 |

---

## 12. 另一种部署方式：在线粘贴单文件

如果不想用 GitHub，也可以直接粘贴部署（适合临时试用）：

1. Workers & Pages → Create application → **Workers** → **Create Worker**。
2. 起名（如 `cloudflare-notify`）→ Deploy。
3. 点 **Edit code**，把 `worker.js` 的全部内容粘贴进去，覆盖默认代码 → **Save and deploy**。
4. 之后同样按第 4、5 步绑定 KV 和设置 Secrets。

> 在线粘贴方式不自带 Git 自动部署，每次改代码都要手动粘贴；GitHub 导入方式改完 push 即上线，长期维护更省事。

---

## 附：本项目文件说明

| 文件 | 作用 |
| --- | --- |
| `worker.js` | 核心单文件：路由、KV 存储、Web 页面、企业微信推送、方糖兼容端点全在这里 |
| `wrangler.toml` | Workers 部署配置（已避开占位符 KV 陷阱） |
| `GITHUB_DEPLOY.md` | 本文档 |
| `README.md` / `TROUBLESHOOTING.md` | 接口文档与排查手册 |
| `.dev.vars.example` | 环境变量模板（无真实密钥） |
| `examples/` | 软件接入脚本 `notify.py` 与说明 |
| `src/` | 历史多文件版，仅作参考，不参与部署 |

敏感文件 `.dev.vars` 已排除，仓库内不含任何真实 Webhook 或密钥。
