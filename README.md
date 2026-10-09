# filehub — 轻量级文件分发系统

> 🌐 **项目预览**：[https://files.ctyun2026.de5.net/](https://files.ctyun2026.de5.net/)（管理界面需口令登录，页面即本仓库源码部署的真实运行效果）

基于 **Cloudflare Worker + S3 兼容对象存储**的单文件文件分发系统。

零依赖、免服务器：一个 Worker 脚本包含全部后端逻辑与管理前端，部署即用，运行成本为零（免费计划即可）；D1 数据库为**可选项**（仅操作审计日志与短链映射需要），不绑定也可完整使用（仅无审计记录与短链）。

已在**中国科技云（CSTCloud）对象存储**上实测通过，也可用于任何 S3 兼容存储（需支持 SigV4 头签名与分片上传）。

## 功能特性

| 功能 | 说明 |
|---|---|
| 大文件分片上传 | 8MB/片 × 3 并发经 Worker 中转，突破 Cloudflare Worker 100MB 请求体限制，单文件最大 20GB |
| 实时状态栏 | 文件名 / 大小 / 速度 / 进度条 / 预计剩余时间，500ms 刷新（XHR upload.onprogress） |
| 上传队列 | 单飞队列（前一个完成才开始下一个），文件选中瞬间即渲染卡片，可取消、可插队 |
| 断点续传 | 中断后重新选择同一文件自动续传（localStorage 记录 + 服务端会话复用） |
| 限时分享链接 | 1/7/30/365 天或永久有效，HMAC 签名防篡改、过期自动失效，收件人**无需口令** |
| 短链分享 | 域名 + 8 位随机码（`https://域名/xxxxxxxx`），**同文件 + 同时长固定一码**：多次点复制链接都返回同一短链，已发出的链接不会无故失效，也不会一个文件生成无数链接 |
| Range 断点下载 | 下载/视频拖动进度条均支持（206 Partial Content） |
| 额度管控 | ListBuckets 逐桶实时统计**全账号真实用量**，上传前自动拦截放不下的文件 |
| 中文文件名 | 分享下载自动带 UTF-8 Content-Disposition，浏览器显示原始文件名 |
| 操作审计日志 | 上传/下载/删除全部记录（公网 IP、系统、浏览器、时间），默认显示最新 10 条，点击「加载更多」无限追加 |
| 列排序审计 | 使用记录表头可点击排序（文件名/动作/时间/IP，升序↔降序切换），按任一维度归拢查看 |
| 本地时区显示 | 数据库存 UTC 标准时间，界面按浏览器本地时区显示，跨时区访问者各自看到准确时间 |

## 使用说明

1. 打开系统首页，输入管理口令登录（浏览器记住，换设备需重输）
2. 点击或拖拽文件到上传区，可一次选多个（自动排队）
3. 上传过程实时显示速度/进度/剩余时间；排队文件显示"等待中"，急件可点【插队】提前，随时可点【取消】
4. 上传完成后，在文件列表点【复制链接】生成分享链接（可选有效期），发给对方即可
   - 选「短链」时返回 `https://域名/xxxxxxxx`；同一文件选同一有效期多次复制都是**同一个码**（已分享的不失效）
5. 对方打开链接直接下载，无需口令、无需注册
6. 文件不用了点【删除】，额度实时回收（界面"已用 X / 20GB"会立即更新）；删除文件会同步清理其对应的短链映射，旧短链随之失效
7. 文件列表下方的「使用记录」实时记录每次上传/下载/删除（含操作者 IP 与设备信息）；点击表头可按文件名/动作/时间/IP 排序，便于审计某个文件的完整流转

## 部署指南

### 1. 前置条件

- Cloudflare 账号（免费计划即可）
- 任一 S3 兼容对象存储的 Access Key / Secret Key / 桶名（本文以中科云 s3.cstcloud.cn 为例）

### 2. 配置 Worker Secrets

在 Cloudflare 控制台（Worker → Settings → Variables and Secrets）或通过 API 添加：

| Secret | 说明 |
|---|---|
| `S3_AK` | 对象存储 Access Key ID |
| `S3_SK` | 对象存储 Secret Access Key |
| `S3_BUCKET` | 存储桶名 |
| `ADMIN_TOKEN` | 管理口令（自己设定，用于登录管理界面） |
| `SHARE_SECRET` | 分享链接签名密钥（建议随机 32 位以上） |

可选 Vars：`S3_ENDPOINT`（默认 `s3.cstcloud.cn`）、`S3_REGION`（默认 `cn-north-1`）

### 3.（可选）绑定 D1 数据库（操作审计日志 + 短链映射）

「使用记录」与「短链映射」依赖 Cloudflare D1（免费额度：5GB 存储 / 500 万行读 / 10 万行写 每天）。**不绑定 D1 时系统功能完整可用，仅无审计记录与短链**（此时分享链接回退为 HMAC 限时长链，仍可用）。表结构首次访问自动创建，无需手动建表。

控制台方式：Storage & Databases → D1 → Create database（如 `filehub-db`），然后 Worker → Settings → Bindings → Add → D1 database，变量名设为 **`DB`**。

API 方式（需 D1 编辑权限）：

```bash
# 创建数据库，记下返回的 uuid
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"filehub-db"}'
```

部署时在 metadata 中携带绑定：`"bindings":[{"type":"d1","name":"DB","id":"<数据库uuid>"}]`

### 4. 部署脚本

方式一：控制台粘贴 `filehub-worker.js` 内容保存。

方式二：API 部署（Token 需"Workers 脚本：编辑"权限）：

```bash
ACCOUNT_ID="<你的AccountID>"
API_TOKEN="<你的API Token>"
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/filehub" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F 'metadata={"main_module":"filehub-worker.js","compatibility_date":"2024-09-01"};type=application/json' \
  -F "filehub-worker.js=@filehub-worker.js;type=application/javascript+module"
```

Secrets API 示例（注意 `type` 字段必填）：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/filehub/secrets" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"S3_AK","text":"<你的AK>","type":"secret_text"}'
```

### 5. 绑定自定义域名

控制台：Worker → Settings → Domains & Routes → Add Custom Domain。
API 方式（"Workers 脚本：编辑"权限即可，无需 DNS 权限）：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"hostname":"files.yourdomain.com","service":"filehub","environment":"production"}'
```

## 开发说明

### 架构

```
浏览器（内嵌管理页，同源）
   │ 上传：File.slice() 8MB分片 → XHR PUT /api/part（实时进度）
   ▼
Cloudflare Worker（单文件：SigV4 签名 + 上传协调 + 下载代理 + 前端 HTML）
   │ SigV4 头签名（UNSIGNED-PAYLOAD 流式转发，不缓存分片字节）
   ▼
S3 兼容存储（Multipart Upload：Create → UploadPart → Complete）
   │
下载：分享链接 /f/{key}?e={过期时间}&s={HMAC签名} → Worker 校验签名
      → 服务端签名 GET + Range 透传 → 流式回传（206 支持）
短链：/xxxxxxxx → D1 查 shares(file_key, days) → 还原 file_key → 同上
```

### 为什么是"Worker 中转"而不是"预签名直传"

实测部分 S3 网关（如中科云）会拦截一切无 Authorization 头的请求，导致预签名 URL（SigV4/SigV2）与公读 ACL 均不可用。此时浏览器直传路线被堵死，改用 Worker 中转：

- 每片 8MB 远小于 Worker 100MB 请求体限制，天然合规
- Worker 只做签名转发（`UNSIGNED-PAYLOAD` + 流式 body），CPU 消耗极低，免费计划 10ms CPU 限制内可运行
- 权限全部集中在 Worker（管理口令 + 分享 HMAC），存储桶保持全私有

### 关键设计

| 点 | 决策 |
|---|---|
| 断点续传 | 前端 localStorage 记录 `{key, uploadId, chunkSize, done分片表}`；`/api/init` 支持 resume 复用会话（分片边界由文件大小决定，恒一致）；服务端 ListParts 在部分网关有 bug，故不依赖 |
| 速度统计 | 500ms 采样 + 指数平滑（`v = v*0.7 + inst*0.3`）防抖动 |
| 取消上传 | abort 全部 XHR → 调 `/api/abort` 清服务端 MPU 分片 → 清断点记录；重试逻辑区分"用户取消"（不重试）与"网络错误"（重试） |
| 队列单飞 | 严格"前一个结束才启动下一个"（busy 标志），避免分片带宽被多文件争抢 |
| 额度统计 | `GET /`（ListBuckets）+ 逐桶 ListObjects 实时累加，不用 Worker 内存缓存（边缘多实例下不可靠） |
| 目录占位对象 | 部分 S3 网关在 Complete 时自动创建 0 字节目录对象，列表接口按 `key.endsWith('/')` 过滤 |
| 审计日志 | 上传/下载/删除各写一条流水（logs 表，含文件名/动作/IP/系统/浏览器）；下载记录 60 秒防刷窗口（同 IP 同文件的连续 Range 请求不重复计数），跨次下载独立记录 |
| 排序安全 | 列排序参数经白名单（id/file_name/action/ip/log_time）校验后拼接 SQL，防注入 |
| 短链复用 | D1 `shares` 表以 `(file_key, days)` 为唯一键：复制链接先查后插，命中即复用同一短码；不同有效期生成不同码；删除文件时 `DELETE FROM shares WHERE file_key=?` 同步清链 |
| 短链幂等 | 并发点击复制时若 `INSERT` 因唯一索引冲突失败，回退 `SELECT` 已存在那行，绝不丢短链、绝不重复生成 |
| 索引优化 | `shares` 表建 `UNIQUE INDEX (file_key, days)`，复制链接查询走索引不再全表扫，降低 D1 读额度消耗 |
| 前端防刷缓存 | 同一文件 + 同一有效期的短链缓存在浏览器内存（`window.__shareCache`），复点直接复制、零请求；删文件清该项缓存；不写 localStorage、不跨会话，无副作用 |

### 已知限制

- 上传/下载速度受对象存储公网入口带宽限制（Worker 中转又叠加 Cloudflare 边缘链路），几十 MB 文件分钟级、GB 级需小时级
- 分片上传会话保存在前端 localStorage，换浏览器/设备续传需重新上传
- ListMultipartUploads 中断残留需手动清理（取消功能已自动处理）
- 短链映射存储在 D1，若不使用 D1 则分享回退为 HMAC 限时长链（仍可用，仅无短码）

## 限流与额度保护（建议）

项目运行在 Cloudflare 免费计划，D1 / Worker 额度有限。以下措施用于降低无意义消耗：

1. **前端内存缓存**：同一文件+同时效期复点"复制链接"不重复打 API（见上表），个人用户反复点零成本。
2. **D1 唯一索引**：复制链接查询走索引（O(log n)），避免全表扫描。
3. **边缘 Rate Limiting（可选，免费套餐可用、不按量计费）**：在 Cloudflare 控制台 Security → WAF → Rate limiting rules 建一条规则，匹配 `URI Path` 等于 `*/api/share*`，按 IP 每 10 秒超过 10 次则 Block 10 秒。免费套餐提供 1 条规则、按 IP 计数、周期仅 10 秒档；可挡恶意脚本高频刷，被拦请求不进 Worker、不碰 D1，最省额度。

> 说明：早期版本曾误称为"KV"，实际短链映射使用 **D1 数据库**，并非 KV。

## 安全说明

- 所有密钥仅存于 Cloudflare Worker Secrets，**源码不含任何硬编码凭据**
- 管理操作需口令（`X-Auth-Token` 头）；分享链接带 HMAC 签名与过期时间，防篡改
- 存储桶保持 private，匿名访问一律拒绝

## 许可

仅供个人学习与内部使用。
