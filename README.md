# Mail Split Gateway

独立的 mail.com 分裂邮箱、IC 邮箱验证码取件与外部注册编排网关。它不依赖 3100/3200 的任务、数据库或运行进程。

## 中文快速启动

要求 Node.js 22.5+（建议使用最新 Node 22 补丁版本）；启用换绑和独立试用资格检查时还需 Python 3.12+。在项目目录执行：

```sh
npm ci
npx playwright install chromium
cp .env.example .env
```

Linux 可将浏览器安装命令替换为 `npx playwright install --with-deps chromium`，同时安装 Chromium 所需系统依赖；系统包安装可能需要管理员权限。Windows PowerShell 使用 `Copy-Item .env.example .env`。

将 `.env` 的两个密钥占位分别替换为独立生成的值。下面的命令每次生成一个 Base64 编码的 32 字节随机值，分别执行两次，用于主密钥与管理密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

主密钥用于解密已有数据，应妥善保管，使用已有数据库时保持一致。按实际访问地址设置 `MAIL_GATEWAY_PUBLIC_URL`；本地默认监听 `127.0.0.1:3110`。随后启动：

```sh
node --env-file=.env src/main.js
```

`npm start` 实际执行 `node src/main.js`，默认不会加载 `.env`；只有外部已注入环境变量时才可直接使用。浏览器路径留空时使用 Playwright 安装的 Chromium，默认以 headless 模式运行。

换绑是可选功能，默认 `MAIL_GATEWAY_REBIND_ENABLED=false`。启用前创建 Python 3.12+ 虚拟环境并安装固定依赖：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r python/rebind_worker/requirements.txt
```

先确认 `python3 --version` 为 3.12+。Windows 使用 `py -3.12 -m venv .venv` 和 `.venv\Scripts\python.exe -m pip install -r python/rebind_worker/requirements.txt`。在 `.env` 设置 `MAIL_GATEWAY_REBIND_ENABLED=true`，并将 `MAIL_GATEWAY_REBIND_PYTHON` 设置为该虚拟环境解释器的实际路径（建议绝对路径；Windows 可使用正斜杠）。执行器还会使用当前 Node 可执行文件运行 SDK 桥接。

独立试用资格检查优先恢复已保存、且曾明确完成 MFA 的会话，再向 `/api/auth/session` 核对邮箱与账号身份并取得当前 access token。仅缺少可用 session token，或会话明确失效（HTTP 401 / HTTP 200 空对象）时重新进行密码/TOTP 登录；网络错误、其他 HTTP 错误及身份不匹配直接报错。资格结论区分 `eligible`、`ineligible`、`error`，只有明确的优惠资格证据才判定有效；成功结论携带的会话经并发状态核对后加密保存。详见 [Python 执行器协议](python/rebind_worker/README.md)。

## Responsibilities

- 管理主邮箱的登录和续期会话。
- 同步 mail.com 后缀及远端分裂邮箱容量。
- 从 `hidden` 后缀中随机创建分裂邮箱。
- 导出 `email----https://host/m/token`。
- 每个主邮箱集中拉取一次收件箱，按精确收件人分发验证码。
- 在交付、过期或人工回收后确认删除远端分裂邮箱。
- 注册批次明确选择 `mail` 或 `ic` 邮箱大类，两个大类不会互相回退。mail 批次按可用主邮箱容量创建临时分裂邮箱；IC 批次按选定取件来源分配已导入邮箱。每批固定绑定 1 条公共站请求代理；每个邮箱的注册代理数量由任务配置（1-100，默认 20）。
- 通过受控浏览器向 ifnexora 提交启用 2FA 的注册批次并监控结果。
- 遵循 ifnexora 当前 Sentinel v2 与 JWE 提交协议，提交请求只接受 `protectedRequest` 和 `sentinelGrant`。
- mail 账号只有试用资格明确有效且 2FA 配置成功才加密保存；IC 账号只要密码完整且 2FA 明确配置成功就保存，试用资格继续按有效、无效或未知分类。
- 合格结果安全落库后再删除临时分裂邮箱。
- 按 IC 上游取件 URL 的主机名选择适配器，对外仍统一导出 `email----https://host/m/token`。

### IC 邮箱取件

IC 邮箱与 mail.com 分裂邮箱完全分开存储，不启动主邮箱会话、不创建分裂邮箱，也不执行解绑。上游取件 URL 使用服务主密钥加密保存，管理列表和公开 API 均不会回显。

当前支持 `icloud.ikunai666.top`：3110 直接请求 `/show/{key}/{email}` HTML，并严格校验页面中的 `pickup-email` 与 `verification-code` 元数据。邮箱匹配且验证码为空表示取件链接有效但暂无邮件，公开接口返回 HTTP 200 空正文；六位数字则直接返回验证码。网络错误、非 200、邮箱不匹配或页面字段异常返回 502，不会伪装成暂无邮件。适配器依据上游 URL 主机名选择，不依据邮箱的 `@icloud.com` 后缀。

`enohaook.top1688.org:5001` 使用另一套 HTML 结构。适配器直接请求给定的 HTTP 取件地址，校验页面邮箱、邮件卡片的精确收件人，并只从验证码邮件的 `iframe srcdoc` 正文节点提取唯一六位数字。“当前无邮件”和最新邮件并非验证码邮件时返回等待；邮箱不匹配、验证码邮件正文缺失或候选码不唯一时返回明确错误。

管理页的“IC 邮箱”页接受每行 `邮箱----上游取件URL`，导入时生成一次 3110 公开链接。以后点击“生成新链接”会使旧链接立即失效。

IC 注册生命周期为 `available -> allocated -> running -> used`。邮箱一旦分配给注册批次就永久进入本次使用流程；准备取件、公共站预检、提交或后续步骤无论成功失败，最终都进入 `used`，不会二次提交。历史上已有注册任务记录的邮箱即使残留为 `available`，启动时也会自动校正为 `used`。IC 邮箱不会进入 mail 分裂邮箱表，也不会执行解绑或远端删除。

分配 IC 邮箱时，网关会先通过对应取件适配器读取一次当前验证码，并且只保存其哈希作为本次注册的基线。公共站轮询期间，相同验证码按“暂无新邮件”处理；只有上游返回不同的六位验证码才会对外提供。该判断不依赖邮件显示时间或时区，也不会把任务开始前的旧验证码交给新注册任务。

批量 IC 任务先为每个已分配邮箱建立可审计的任务记录，再以最多 4 路并发准备取件基线。仅明确的瞬时网络断连或超时会短暂重试 3 次；HTTP 状态、邮箱身份校验和正文解析错误不会被重试掩盖。

公共站任务完成后不会等待整个批次结束再读取结果。任一槽位明确返回注册完成时，网关立即读取短时 reveal、校验响应 JWE 的 `kid`/`typ`/`cty`，再按邮箱大类应用保存条件。mail 结果安全落库后删除对应临时分裂邮箱；IC 结果标记邮箱已使用但不删除邮箱。其他槽位继续独立运行。

公共站请求代理池和注册代理池完全独立。每次导入都是对对应当前代理池的原子覆盖，不存在追加模式；列表包含无效记录时整次覆盖会被拒绝。旧代理行只保留给历史分配记录，不会再进入新任务。

管理页中的两个代理列表由服务端分页，每页只查询并显示 50 条；统计数字始终针对完整的当前代理池。

一个注册批次只分配 1 条公共站请求代理，并从提交、轮询、短时 reveal 到结果收集全程复用该绑定。覆盖代理池或重启服务不会改变运行中批次的绑定。公共站请求代理按整池轮换；无法确认提交结果时进入 `quarantined`，完成对账前不会分配给其他批次。注册代理按任务配置的数量顺序分配，使用后进入统一刷新周期（默认 30 分钟）；每次创建或分配任务前都会释放所有已到期代理，所以大批任务可以同时使用尚未消费和已经刷新完成的代理。

## State Machines

主邮箱状态：

```text
closed -> opening -> ready -> renewing -> ready
                    |          |
                    +-> login_required / unavailable
```

分裂邮箱状态：

```text
creating -> ready -> exported -> active -> delivered
   |                                           |
   +-> create_failed / create_unknown          v
                                      release_pending -> deleting -> deleted
                                                               |
                                                   delete_failed / delete_unknown
```

`create_unknown` 和 `delete_unknown` 只能通过远端地址列表对账离开，不能直接重试。

## 配置

完整模板见 [.env.example](.env.example)，变量按 `src/main.js` 的 `loadConfig()` 整理，密钥仅含占位。毫秒配置采用正数；换绑与 Cloak 模式仅在值严格为 `true` 时启用，headless 仅在值为 `false` 时关闭。

`IFNEXORA_ALLOWED_PROXY_REGIONS` 默认留空，使用注册代理池实际出口国家；需要限定地区时填入 `GB,JP` 等逗号分隔代码。普通 Playwright 启动保持 `MAIL_GATEWAY_BROWSER_CLOAK_MODE=false`；Cloak 模式另需兼容浏览器、对应 Python 环境及 `cloakbrowser.geoip`，不由上述换绑 requirements 安装。

`MAIL_GATEWAY_REBIND_TIMEOUT_MS` 默认 300000；独立资格检查在服务层另有最长 180000 毫秒限制。`.gitignore` 排除环境文件、运行数据、数据库、日志、浏览器配置和缓存，仅保留 `.env.example` 作为环境模板；它不会移除已被 Git 跟踪的文件，发布前仍需核对暂存内容。

已打开的主邮箱默认每 4 分钟主动刷新 compose 读写 token 和邮件正文 token；调度器每 30 秒扫描一次到期会话。刷新会同时验证当前 SID/Cookie，认证被拒绝时会立即通过纯 HTTP 协议重新登录并原子替换会话。续期失败会进入 `login_required` 或 `unavailable`，不会把失败伪装成空收件箱。

公开接口只有 `GET /m/{token}`。管理接口位于 `/api/admin/*`，使用 `X-API-Key` 或 Bearer 认证。

## Verification

### Bulk mailbox import

The mailbox page accepts pasted text or TXT, TSV, CSV and JSON files. File upload
decodes UTF-8, BOM-marked UTF-16, and GB18030 (including GBK exports).
`POST /api/admin/mailboxes/import` requires the same admin authentication as
the single-mailbox endpoint. Send `{ "text": "..." }`,
`{ "mailboxes": [{ "email": "main@example.com", "password": "..." }] }`,
or a direct JSON array. JSON objects also accept `address` and `pass` keys.

Text records use one account per line, separated by `----`, a colon, a tab,
or `|`. Only the separator immediately after the email is consumed; password
whitespace and punctuation are preserved. Do not add formatting spaces around
the password. CSV accepts two columns without a header, or named email/password
columns in either order with optional extra columns. Chinese headers such as
`邮箱` and `密码` are supported. Supplier exports with `#,data` are supported:
the `data` cell contains `email|password` (or another supported text separator).
Comma, semicolon and tab delimiters and Excel `sep=;` directives are accepted.
Quote fields containing delimiters or newlines and double embedded quotation marks.
Do not mix CSV with other text formats in the same import.

Each request accepts 1-5000 records. The response contains `counts` and `results`
with source line numbers (JSON uses item numbers). Existing addresses and repeats
are skipped case-insensitively, without changing passwords. Invalid records do
not prevent valid records from importing; invalid JSON or CSV syntax rejects the
whole document. Passwords are encrypted with the configured master key and are
never included in import results. Importing does not log into the mailbox or
verify its ability to create aliases.

```bash
npm run check
npm test
```

## Linux / systemd 部署样例

[deploy/mail-split-gateway.service](deploy/mail-split-gateway.service) 是通用 headless Node 样例，不依赖 xvfb，不固定 Chromium build 或版本目录。目录约定：

```text
/opt/mail-split-gateway       应用目录，服务只读
/var/lib/mail-split-gateway   SQLite 和运行数据目录
/etc/mail-split-gateway.env   环境配置及密钥，root 读取
```

部署前创建专用 `mailgateway` 用户和组，使数据目录归该用户所有；环境文件设为 root 所有、权限 0600，填入自行生成的密钥与实际配置。样例通过 `EnvironmentFile` 注入配置，无需 Node 的 `--env-file`。环境文件中的值会覆盖样例 `Environment`，因此部署时应将 `MAIL_GATEWAY_DATA_DIR` 设为 `/var/lib/mail-split-gateway`，并按需设置监听地址及公开 URL。

在应用目录安装与锁文件一致的依赖和浏览器：

```sh
npm ci
PLAYWRIGHT_BROWSERS_PATH=/opt/mail-split-gateway/ms-playwright npx playwright install --with-deps chromium
```

确保服务用户可读取应用、浏览器和可选 Python 虚拟环境。`MAIL_GATEWAY_BROWSER_EXECUTABLE` 保持为空，由 Playwright 按依赖版本定位浏览器；自定义浏览器时再填写实际路径。浏览器临时配置使用服务私有临时目录。

Linux 的 Node、Python 和浏览器系统路径依安装方式选择：核对 `command -v node`，调整样例中的 `/usr/local/bin/node`；启用换绑时将 `MAIL_GATEWAY_REBIND_PYTHON` 指向部署虚拟环境解释器。应用路径仍为 `/opt/mail-split-gateway`。确认路径和权限后，将 unit 安装至 `/etc/systemd/system/`，执行 `systemctl daemon-reload` 与 `systemctl enable --now mail-split-gateway`。本样例不替代目标 Linux 环境的实际启动验证。

## 许可证

本副本是脱敏后的开源候选，不是已完成许可审查的最终发布。项目许可证待作者确定；当前未选择 MIT、Apache 或其他许可证，公开源码本身不代表授予任意使用或再分发许可。`python/rebind_worker/registration_core/` 中的上游许可文字不替代原始版权与许可文件，随附 SDK 也需补充核实授权依据。vendored 第三方代码、SDK 及浏览器资产的来源、许可证和再分发条件须分别核对，并保留适用的版权与许可声明。项目未来的许可证选择不自动覆盖这些第三方内容。
