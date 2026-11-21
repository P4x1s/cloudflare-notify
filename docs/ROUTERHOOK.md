# RouterHook 路由器通知完整接入教程（v1.8）

Cloudflare Notify 已完整兼容 [RouterHook](https://github.com/sdlyfjx/rogsoft/tree/RouterHook/routerhook) 路由器 WebHook 插件。**无需修改 RouterHook 源码、无需额外服务器**，只需把回调 URL 指向本服务即可。

---

## 目录

1. [支持的事件](#1-支持的事件)
2. [快速开始（3 步）](#2-快速开始3-步)
3. [Hook URL 与 Header 配置](#3-hook-url-与-header-配置)
4. [获取轮换推送密钥](#4-获取轮换推送密钥)
5. [多路由器配置](#5-多路由器配置)
6. [消息展示：中文摘要 + 完整 JSON](#6-消息展示中文摘要--完整-json)
7. [传感器聚合机制](#7-传感器聚合机制)
8. [企业微信推送策略](#8-企业微信推送策略)
9. [Durable Objects 部署配置](#9-durable-objects-部署配置)
10. [验证与排障](#10-验证与排障)

---

## 1. 支持的事件

字段定义以 RouterHook 实际源码为准（README + `routerhook_check.sh` / `routerhook_ifup_trigger.sh` / `routerhook_dhcp_trigger.sh` / `routerhook_hass.sh` / `routerhook_sender.sh`）。

### 普通事件（立即生成一条通知）

| 事件 | 触发场景 | 生成的中文标题 |
| --- | --- | --- |
| `manuINFO` | 手动推送 | `<设备> · 手动状态报告` |
| `cronINFO` | 定时推送 | `<设备> · 定时状态报告` |
| `ifUP` | 网络重拨上线 | `<设备> · 网络重拨通知` |
| `newDHCP` | 新设备上线 | `<设备> · 新设备上线` |
| 其它未知事件 | 未来扩展 | `<设备> · <事件名>`（通用接收，原始 JSON 不丢失） |

### 虚拟传感器事件（进入聚合，不逐条通知）

| 事件 | 含义 | 来源字段 |
| --- | --- | --- |
| `rh_load` | 系统负载（1/5/15 分钟，靠 unit 区分） | `state` / `value1` |
| `rh_mem_free` | 空闲内存 | 同上 |
| `rh_swap_free` | 空闲 SWAP | 同上 |
| `rh_cpu_temp` | CPU 温度 | 同上 |
| `rh_24g_temp` | 2.4G 温度 | 同上 |
| `rh_5g1_temp` | 5G-1 温度 | 同上 |
| `rh_dev` | 聚合设备在线状态 | `ON`/`OFF` → 在线/离线 |
| `rh_dev_<mac>` | 指定 MAC 设备在线状态（MAC 去冒号、小写） | 同上 |
| `rh_*` 任意 | 未知传感器通用解析 | `state`→`value1`，单位 `attributes.unit_of_measurement`→`value2`，名称 `attributes.friendly_name`→`value3`→事件映射名 |

> **重要**：普通事件靠 JSON 里的 `msgTYPE` 识别；虚拟传感器的 JSON **没有 `msgTYPE`**，只能靠 URL 路径中的 `_PRM_EVENT` 替换结果识别。本服务两者都支持。

---

## 2. 快速开始（3 步）

### 第 1 步：准备接收地址

你需要两样东西：

- **服务域名**：例如 `https://ntfy.example.com`（替换成你自己的）
- **轮换推送密钥**：见 [第 4 节](#4-获取轮换推送密钥)，例如 `a1b2c3...`

### 第 2 步：在 RouterHook 里配置回调 URL

把 RouterHook 的「Webhook 地址 / 回调 URL」填成：

```
https://ntfy.example.com/api/routerhook/_PRM_EVENT
```

`_PRM_EVENT` 是 RouterHook 的动态参数，发送前会自动替换成当前事件名（如 `manuINFO`、`rh_cpu_temp`）。这就是本服务路由里的 `{event}`。

### 第 3 步：配置自定义 Header

在 RouterHook 的「自定义请求头」里添加一行：

| Header 名 | Header 值 |
| --- | --- |
| `X-Token` | `<你的轮换推送密钥>` |

点击「手动推送」按钮，如果通知中心立刻出现一条「`<设备> · 手动状态报告`」，说明接入成功。

---

## 3. Hook URL 与 Header 配置

### 3.1 URL 结构

```
https://<域名>/api/routerhook/<事件名>?device=<设备标识>
```

- `<事件名>`：通常写 `_PRM_EVENT` 一个地址通吃所有事件；也可以写死某个事件名。
- `?device=<设备标识>`：可选，用于区分多台路由器。虚拟传感器**没有 sysINFO**，必须靠这个参数指定设备，否则会归到默认设备 `Router`。普通消息会自动从 `sysINFO.routerNAME` 读取设备名。

### 3.2 RouterHook 动态参数

RouterHook 支持 3 个动态参数，会在请求发出前替换（见其 README「关于动态参数」）：

| 参数 | 替换为 | 本服务是否需要 |
| --- | --- | --- |
| `_PRM_EVENT` | 当前事件名（`manuINFO`/`rh_cpu_temp` 等） | **需要**，放在 URL 路径里 |
| `_PRM_DT` | GMT 时间字符串 | 不需要，但可放在 Header 里带时间戳 |
| `_PRM_TS` | 10 位 Unix 时间戳 | 不需要，同上 |

### 3.3 鉴权 Header

本服务复用现有的发送密钥体系，RouterHook 可用以下任意一种（优先级从高到低）：

1. `X-Token: <轮换密钥>` — **推荐**
2. `Authorization: Bearer <轮换密钥>`
3. POST body 里的 `token` 字段（RouterHook 的 JSON 由插件生成，不方便加，不推荐）
4. URL query `?token=<轮换密钥>`（密钥会进日志，不推荐）

**注意**：如果你在 RouterHook 里用 `Authorization` 自定义头，务必写成完整的 `Bearer <密钥>`（中间有空格），本服务会正确剥离 `Bearer ` 前缀再比对——不会把整个字符串当密钥。

### 3.4 成功判定

RouterHook 的 `sender.sh` 靠检查响应体里是否含 `success` 字符串来判定推送成功。本服务的响应体：

```json
{
  "ok": true,
  "success": "success",
  "code": 0,
  "errno": 0,
  "message": "success",
  "aggregated": false,
  "data": { "pushid": "...", "timestamp": 1234567890000, "source": "RouterHook/RAX50" },
  "wecom": { "configured": true, "ok": true }
}
```

所以在 RouterHook 日志里会显示「推送成功」。

---

## 4. 获取轮换推送密钥

轮换密钥可以随时重置，避免密钥泄露后长期使用：

```bash
# 用 SEND_TOKEN（管理主密钥）调用轮换接口，拿到新 key
curl -X POST "https://ntfy.example.com/api/key/rotate" \
  -H "Content-Type: application/json" \
  -d '{"token":"<你的SEND_TOKEN>"}'
# 返回 {"ok":true,"key":"<64位新密钥>"}
```

把返回的 `key` 填到 RouterHook 的 `X-Token` Header。旧密钥在轮换后立即失效，记得同步更新所有设备。

也可以登录通知中心网页，在页面上直接查看/复制当前轮换密钥。

---

## 5. 多路由器配置

支持多台路由器接入同一个通知中心，**数据完全隔离**。

为每台路由器的 Hook URL 加不同的 `device` 参数：

```
# 路由器 A（华硕 RAX50）
https://ntfy.example.com/api/routerhook/_PRM_EVENT?device=RAX50

# 路由器 B（AX86U）
https://ntfy.example.com/api/routerhook/_PRM_EVENT?device=AX86U
```

隔离效果：

- 每台设备有独立的 Durable Object 实例（按 `device` 标识生成），传感器聚合状态互不干扰；
- 消息 `source` 字段分别为 `RouterHook/RAX50`、`RouterHook/AX86U`，传感器汇总为 `RouterHook/RAX50/Sensors`；
- 摘要里的设备名、标题都带各自的设备标识。

设备标识会做安全规范化：仅保留字母、数字、`.`、`_`、`-`，其它字符替换为 `_`，最长 64 字符；展示时仍保留原始名称（截断到 80 字符）。这避免了特殊字符导致存储键或 DO 对象名冲突。

> **优先级**：URL `device` 参数 > 普通消息的 `sysINFO.routerNAME` > 默认 `Router`。虚拟传感器因为没有 sysINFO，务必用 URL 参数指定。

---

## 6. 消息展示：中文摘要 + 完整 JSON

每条 RouterHook 消息都由两部分组成，中间用明显分隔线隔开。

### 6.1 普通消息示例（manuINFO）

标题：`RAX50 · 手动状态报告`

正文：

```
【设备基本信息】
设备名称：RAX50
当前时间：2026年11月21日 12点00分00秒
固件版本：384.14
工作模式：无线路由器
运行时间：2天6小时
系统负载(1min)：1.2
内存全部：429.99 MB
内存空闲：140.42 MB
JFFS 使用率：9%

【温度信息】
CPU 温度：65°C
2.4G 温度：42°C
5G-1 温度：48°C

【网络信息】
WAN 连接协议：pppoe
WAN 公网 IPv4：1.2.3.4
WAN DNS：8.8.8.8、1.1.1.1
WAN 接收流量：5.3 GiB
DDNS：example.ddns.net
LAN IP：192.168.50.1
WiFi SmartConnect：MyWiFi

【USB 信息】
USB2 设备：General UDisk
USB2 挂载状态：mounted

【在线客户端】
在线设备数量：1
名称：Laptop　IP：192.168.50.10　MAC：aa:bb:cc:dd:ee:ff

【DHCP 租期列表】
DHCP 租期设备数量：1
名称：Phone　IP：192.168.50.11

────────────────────
【完整原始 JSON】
{
  "msgTYPE": "manuINFO",
  "sysINFO": { ... },
  ...
}
```

**字段不存在时不显示**，不会用虚构值填充。多 WAN（`netINFO.WAN` / `ifUP.netSTATE`）会分别显示为 `WAN 0`、`WAN 1`。

### 6.2 原始 JSON 安全展示

- 完整 JSON 保留所有字段（包括摘要未用到的），用 2 空格缩进格式化，方便阅读；
- 超过 12000 字符会截断并标注（防止超大消息撑爆 KV/前端）；
- 复用 v1.7 的 `sanitizeRichHtml` 白名单消毒：`<script>`、`<img onerror=>` 等全部转义为文本显示，不会执行；
- 摘要用 `<h3>` 分节、`<div>` 逐行，JSON 放在 `<pre><code>` 里，折叠/展开/全文查看等原有能力全部保留。

---

## 7. 传感器聚合机制

这是本次升级的核心：**高频传感器（如每 10 秒一次 CPU 温度）不会每次生成一条通知**。

### 7.1 聚合规则

- **按设备隔离**：RAX50 的传感器只进 RAX50 的聚合缓存；
- **按传感器类型隔离**：每种传感器（事件名 + 单位）独立保存最新值；
- **同类只留最新**：15 秒内收到 60°C → 62°C → 65°C，最终只保留 65°C；
- **固定窗口 60 秒**：第一组数据到达时设定一次闹钟，后续数据只更新值、**不重置窗口**——因此持续上报也不会导致汇总永远不触发。

### 7.2 汇总通知示例

标题：`RAX50 · 传感器状态汇总`

```
【系统状态】
系统负载(1min)：1.8 1min
空闲内存：130 MB
空闲 SWAP：20 MB

【温度状态】
Router CPU Temperature：65 °C

【设备在线状态】
Router Device Union：在线 OL

【更新时间】
聚合窗口开始：2026/11/21 12:00:00

────────────────────
【完整传感器 JSON】
【Router CPU Temperature · 原始 JSON】
{ "state": 65, "value1": 65, ... }
（每种传感器最新一条）
```

### 7.3 窗口配置

默认 60 秒。可通过环境变量 `ROUTERHOOK_WINDOW_SECONDS` 调整为 `30` / `60` / `120`（其他值忽略，回退 60）。

```toml
# wrangler.toml
[vars]
ROUTERHOOK_WINDOW_SECONDS = "60"
```

### 7.4 为什么用 Durable Objects

KV 没有原子读改写能力、无法可靠调度定时发送。若用「收到请求时写 KV、等下一条请求再发上一批」的方式，最后一批数据在传感器停报后会永远滞留在 KV 里。Durable Objects 提供：

- 每个设备独立实例，天然隔离；
- `storage` 原子状态 + `setAlarm()` 定时唤醒，窗口到点必发；
- 单实例串行处理，天然避免并发覆盖。

---

## 8. 企业微信推送策略

- **普通事件**（manuINFO/cronINFO/ifUP/newDHCP）：和现有行为一致，立即推送；
- **传感器**：**不逐条推送**，只在聚合窗口到期时把汇总通知推一次，避免刷屏；
- 推送失败（Webhook 失效）只影响主动推送，消息仍正常存入通知中心（与原有可靠性策略一致）；
- 汇总通知的正文经 HTML→markdown 转换后发送，群里不会出现字面标签。

---

## 9. Durable Objects 部署配置

### 9.1 文件配置（已就绪）

`wrangler.toml` 已包含：

```toml
[[durable_objects.bindings]]
name = "ROUTERHOOK_SENSOR"
class_name = "RouterHookSensorDO"

[[migrations]]
tag = "v1"
new_classes = ["RouterHookSensorDO"]
```

`worker.js` 顶层导出了 `export class RouterHookSensorDO`（与 `export default { fetch }` 共存，不冲突）。

### 9.2 Cloudflare Dashboard 部署

1. Worker → Settings → Bindings → Add → **Durable Object**
2. Variable name 填 `ROUTERHOOK_SENSOR`
3. Durable Object class 选 `RouterHookSensorDO`
4. 保存并部署

> **迁移（Migration）**：通过 `wrangler deploy` 部署时，`wrangler.toml` 里的 `[[migrations]]` 会自动创建 DO 命名空间。Dashboard 在线编辑器部署时，添加绑定会自动完成迁移，一般无需手动操作。

### 9.3 降级行为

如果未绑定 `ROUTERHOOK_SENSOR`（例如只在在线编辑器粘贴了 worker.js 但没加绑定），传感器会**自动降级为逐条即时通知**——数据不会丢失，但会失去聚合（高频上报会刷屏）。看到这种现象时，检查 DO 绑定即可。

---

## 10. 验证与排障

### 10.1 一键测试脚本

仓库提供 `examples/routerhook-test.sh`，填入域名和密钥后运行：

```bash
ROUTERHOOK_URL="https://ntfy.example.com" \
SEND_KEY="<你的轮换密钥>" \
bash examples/routerhook-test.sh
```

脚本会依次发送 manuINFO / cronINFO / ifUP / newDHCP / 各类传感器，并打印每条响应。

### 10.2 验证传感器是否聚合成功

1. 在 RouterHook 里把「虚拟传感器触发间隔」设为 10 秒，开启 CPU 温度等；
2. 等 1~2 分钟后打开通知中心：
   - **正确聚合**：看到一条「`<设备> · 传感器状态汇总`」，而不是几十条独立温度通知；
   - **未聚合**：出现大量单条传感器通知 → 检查 DO 绑定（见 9.3）。

### 10.3 企业微信检查

`/api/status` 里 `wecomConfigured` 为 `true` 表示已配置 Webhook。发送一条普通消息后看响应 `wecom.ok`；传感器则等汇总通知发出后检查群里是否只有汇总那一条。

### 10.4 常见 HTTP 错误

| 状态 | 原因 | 处理 |
| --- | --- | --- |
| 200 | 成功 | 响应体含 `success` |
| 400 | JSON 为空/非法、事件名非法 | 检查 RouterHook 的 URL 与 JSON 配置 |
| 401 | 密钥错误或缺失 | 检查 `X-Token` 是否为**当前**轮换密钥（轮换后要更新） |
| 500 | Worker 内部异常 | 看 Dashboard → Workers → Logs；常见是 KV 写入额度用尽（见下） |

> **免费额度提醒**：Cloudflare 免费版 KV 写入额度为 **1000 次/天（按账户共享）**。传感器每 60 秒一条汇总、每条消息写 2 次 KV，若长期高频运行需留意账户内其它 Worker（如 uptime 监控）的总写入量。传感器聚合本身已把逐条写入压缩为窗口级写入，显著降低消耗。

---

## 附：与 RouterHook 源码的一致性说明

本实现逐字核对了 RouterHook RouterHook 分支的源码。发现并兼容了需求描述之外的两个实际细节：

1. **成功判定**：`routerhook_sender.sh` 用 `grep "success"` 检查响应体——因此响应体必须含 `success` 字符串（本服务已包含）。
2. **额外传感器**：源码里除常见的 `rh_load`/`rh_mem_free`/`rh_swap_free`/`rh_cpu_temp`/`rh_dev` 外，还有 `rh_24g_temp`、`rh_5g1_temp`（2.4G/5G-1 温度）——本服务的通用 `rh_*` 解析已覆盖，并在映射表里给出了中文名。
