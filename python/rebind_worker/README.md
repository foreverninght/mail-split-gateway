# 换绑执行器

运行要求为 Python 3.12+、Node 22.5+；依赖安装和可选开关见[项目快速启动](../../README.md)。以下协议以 `src/rebind/worker.js`、`worker.py`、`runtime.py`、`trial_runtime.py` 和 `recovery_runtime.py` 为准，凭据与结果仅通过管道传输。

## 换绑与恢复

Node 导出 `RebindWorker`，提供 `run()`、`runRecovery()`、`runTrial()` 和 `close()`。构造参数包括 `pythonPath`、`nodePath`、`timeoutMs`（默认 300000）。所有请求均需非空的 `credentials: {email,password,totpSecret}` 和显式 `proxy`；换绑还需 `newEmail`、`waitForCode`，恢复和资格检查还需 `expectedAccountId`。

`run()` 阶段为 `login_old → eligibility → begin → verify → login_new → completed`。旧邮箱与新邮箱分别执行密码/TOTP 登录，校验账号 ID 相同、新会话邮箱匹配、密码和 TOTP 密钥保持不变。`completed` 仅表示身份验证完成，持久化与别名清理由服务层负责。结果含 `email`、`accountId`、`originalAccountId`、`password`、`totpSecret`、`sessionToken`、`accessToken`、`mfaVerified: true`，应由服务加密保存，避免记录原始结果。

消息采用一行一个 JSON，经 stdin/stdout 传递，凭据和代理不放入 argv。首条换绑请求为 `{type:"run",credentials,newEmail,proxy}`。服务传入 `onIdentity` 时，Node 自动加入 `requireIdentityCheckpoint:true` 和 `requireStageAck:true`：每个 `{type:"stage",stage}` 都等待串行 `onStage` 完成，再回复 `{type:"stage_ack",stage}`；旧账号登录后收到 `{type:"identity",accountId}`，等待 `onIdentity` 持久化检查点，再回复 `{type:"identity_ack"}`。Python 收到确认才继续。当前 `RebindService` 使用这两个确认；直接调用且省略 `onIdentity` 时不启用确认协议。

`begin` 前记录 Unix 毫秒时间，通过 `{type:"need_code",issuedAfter}` 请求验证码；Node 调用 `waitForCode({issuedAfter,signal})`，回复 `{type:"code",code}`，验证码为 4–10 位 ASCII 数字。最终消息是 `{type:"result",result}` 或 `{type:"error",code,diagnostic}`。诊断仅暴露白名单分类、状态码等字段，无原始响应正文。`REAUTH_FAILED` 会结束该次尝试；进入 begin/verify 后的中断走结果对账，不盲目重放换绑。

`runRecovery()` 使用 `{type:"recover",credentials,newEmail,expectedAccountId,proxy}`，只登录新邮箱并核对身份，阶段为 `login_recovery`，不重新发起换绑或请求验证码。服务层根据恢复结果处理保存与清理。

默认输出总限额 1 MiB、单条 stdout 行 256 KiB、stdin 消息 64 KiB；stderr 只计入限额并丢弃。回调应响应取消；`close()` 中止活动任务并等待释放。

## 独立试用资格检查

请求为 `{type:"trial",credentials,proxy,expectedAccountId,session,mfaPreviouslyVerified}`。`session` 可含 `sessionToken` 和 `accessToken`。存在可用 session token 时，必须有 `mfaPreviouslyVerified:true`，执行 `session_trial`：恢复 Cookie（支持分块），请求 `/api/auth/session`，验证邮箱和返回 access token 中的账号 ID。仅 HTTP 401 或 HTTP 200 空对象表示过期并触发重新登录；网络异常、其他 HTTP 状态和身份不匹配直接失败。缺少可用 session token 时也走 `login_trial` 密码/TOTP 登录。恢复时使用服务端返回的 access token，不直接信任传入的旧 access token。

随后执行 `trial_qualification`，不发起换绑、不请求验证码，也不使用换绑的 ACK 协议。会话在 `finally` 关闭。结果含 `email`、`accountId`、`mfaVerified:true`、`status`（`eligible` / `ineligible` / `error`）、`campaignId:"plus-1-month-free"`、`amountMinor`、`currency`、`billingCountry`、`errorCode`，并可含内部 `session: {accessToken,sessionToken}`。金额为整数或 null，币种为三位大写字母或 null，地区为两位大写字母或 null。

有效资格要求优惠检查来源及明确的 `check_coupon:state=eligible` 证据；无资格也要求优惠检查来源。未知或畸形元数据返回 `error` / `TRIAL_PROBE_FAILED`，探测异常走错误协议，不推断为无资格。服务层仅在非 error 结论且账号与会话快照仍匹配时加密更新会话，防止覆盖并发换绑或更新。

资格结论独立于换绑结果。服务在已有持久化换绑结果时安排独立检查；资格检查失败不将已验证换绑判为失败。

## 环境与本地检查

子进程仅继承白名单系统环境（PATH、系统路径、临时目录、locale），另设置 Python 编码/禁用字节码和 SDK Node 路径。服务主密钥、管理密钥及继承的代理配置不转发。SDK 使用随附只读资产与哈希校验；vendored 第三方代码和 SDK 的来源、版权及许可条件仍需独立核对，详见项目许可证说明。

在项目根目录运行以下模拟测试；这些命令不代表真实账号或 Linux/systemd 部署已验证：

```sh
node --test test/rebind-worker.test.js test/rebind-trial-worker.test.js
python -B -m unittest discover -s python/rebind_worker -p 'test_*.py'
```

Node 的 Python 测试默认在 Windows 使用 `python`，其他平台使用 `python3`；可通过 `REBIND_TEST_PYTHON` 指向已安装依赖的解释器。
