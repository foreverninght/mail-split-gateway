'use strict';

const state = {
  trialRequests: new Map(),
  apiKey: sessionStorage.getItem('mailGatewayApiKey') || '',
  mailboxes: [], selectedId: null, proxyStats: null, controlProxyStats: null, currentView: 'mail',
  proxyPages: { task: 1, control: 1, rebind: 1 },
  accounts: [], accountFiltersInitialized: false, accountLoad: 0, revealRequest: 0, historyRequest: 0,
};

const BATCH_STATE_LABELS = {
  queued: '等待执行',
  creating_aliases: '准备邮箱',
  allocating_proxies: '绑定代理',
  submitting: '公共站校验并提交',
  submit_unknown: '提交结果待对账',
  accepted: '公共站已接收',
  running: '注册执行中',
  collecting_results: '整理结果',
  completed: '已完成',
  partial_completed: '部分完成',
  failed: '失败',
};

const BATCH_STATE_PROGRESS = {
  queued: '正在等待前一批任务完成',
  creating_aliases: '正在准备本批邮箱',
  allocating_proxies: '正在为本批绑定公共站代理和注册代理',
  submitting: '正在通过公共站安全校验并提交；校验失败时会在同一代理上重新获取一次',
  submit_unknown: '公共站可能已收到任务，需要执行对账',
  accepted: '公共站已接收任务，正在等待开始执行',
  running: '公共站正在执行注册及已配置的后加步骤',
  collecting_results: '正在读取结果、保存账号并完成邮箱状态',
  completed: '本批全部完成',
  partial_completed: '本批已结束，但并非全部邮箱合格',
};
const elements = Object.fromEntries([
  'apiKey', 'connectionStatus', 'mailboxRows', 'workspace', 'workspaceTitle', 'workspaceState',
  'createCount', 'exportOutput', 'aliasRows', 'domainRows', 'notice', 'mainNav',
  'registrationCount', 'registrationProxyCount', 'requiredProxyCount', 'proxyReadiness', 'registrationRows',
  'registrationMailboxCategory', 'registrationMailboxProvider', 'registrationProviderField', 'registrationCountLabel',
  'proxyStats', 'proxyRows', 'proxyInput', 'proxyPagination',
  'controlProxyStats', 'controlProxyRows', 'controlProxyPagination',
  'accountRows', 'accountReveal', 'accountDateFilter', 'accountCategoryFilter',
  'accountTrialFilter', 'accountSearchInput', 'accountFilterSummary',
  'accountStatusFilter', 'accountStatusCounts', 'accountHistory', 'accountHistoryContent',
  'revealedEmail', 'revealedPassword', 'revealedTotpSecret', 'revealedTotp', 'revealedSession',
  'controlProxyInput',
  'icMailboxRows', 'icMailboxImportText', 'icMailboxImportResult', 'icMailboxExportOutput',
].map((id) => [id, document.getElementById(id)]));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function showNotice(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.className = `visible${error ? ' error' : ''}`;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { elements.notice.className = ''; }, 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-api-key': state.apiKey,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body.code || body.error;
    const error = new Error(code === 'MAILBOX_CREATION_BLOCKED' ? '该主邮箱创建不可用，请选择其它主邮箱；已有邮箱仍可收信和清理。' : body.message || body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return body;
}

function stateClass(value) {
  return /failed|unknown|unavailable|required/.test(value) ? 'state error' : 'state';
}

function actionButton(label, action, id, danger = false) {
  return `<button type="button" data-action="${action}" data-id="${escapeHtml(id)}"${danger ? ' class="danger"' : ''}>${label}</button>`;
}

function mailboxCanCreate(mailbox) {
  return Boolean(mailbox) && !Number(mailbox.creation_blocked) && mailbox.state !== 'disabled';
}

function mailboxCreationLabel(mailbox) {
  if (mailboxCanCreate(mailbox)) return '';
  return `创建不可用 · ${mailbox.creation_blocked_reason || (mailbox.state === 'disabled' ? '主邮箱已停用' : '此前创建失败')}${mailbox.creation_blocked_at ? ' · ' + mailbox.creation_blocked_at : ''}`;
}

function updateMailboxCreation() {
  const mailbox = state.mailboxes.find((item) => item.id === state.selectedId);
  document.getElementById('createButton').disabled = !mailboxCanCreate(mailbox);
  elements.createCount.disabled = !mailboxCanCreate(mailbox);
  if (mailbox) elements.workspaceState.textContent = `${mailbox.state} · ${mailbox.remote_alias_count} / 9${mailboxCreationLabel(mailbox) ? ' · ' + mailboxCreationLabel(mailbox) : ''}`;
  document.getElementById('registrationMailboxAvailability').textContent = `MAIL 可创建主邮箱：${state.mailboxes.filter(mailboxCanCreate).length}（创建不可用的主邮箱不参与分配）`;
}

function renderMailboxes() {
  if (!state.mailboxes.length) {
    elements.mailboxRows.innerHTML = '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
    return;
  }
  elements.mailboxRows.innerHTML = state.mailboxes.map((mailbox) => `
    <tr>
      <td>${escapeHtml(mailbox.email)}</td>
      <td><span class="${stateClass(mailbox.state)}">${escapeHtml(mailbox.state)}</span>${mailboxCanCreate(mailbox) ? '' : '<br><span class="state error">创建不可用</span>'}</td>
      <td>${mailbox.remote_alias_count} / 9</td>
      <td class="error-text">${escapeHtml(mailboxCreationLabel(mailbox) || mailbox.last_error)}</td>
      <td><div class="actions">${actionButton('管理', 'select', mailbox.id)}</div></td>
    </tr>`).join('');
}

async function loadMailboxes() {
  const body = await api('/api/admin/mailboxes');
  state.mailboxes = body.mailboxes;
  elements.connectionStatus.textContent = '已连接';
  elements.mainNav.hidden = false;
  renderMailboxes();
  updateMailboxCreation();
  if (state.selectedId) await selectMailbox(state.selectedId);
}

const POOLS = {
  task: { prefix: 'proxy', route: '/api/admin/proxies', label: '注册任务', reusable: true },
  control: { prefix: 'controlProxy', route: '/api/admin/control-proxies', label: '公共站请求', reusable: false },
  rebind: { prefix: 'rebindProxy', route: '/api/admin/rebind/proxies', label: '账号换绑', reusable: true },
};
const poolState = Object.fromEntries(Object.keys(POOLS).map((kind) => [kind, {
  status: '', q: '', limit: '50', stats: null, loaded: false, disabled: false, busy: false, sequence: 0,
}]));
let activePool = 'task';
const poolElement = (kind, suffix) => document.getElementById(POOLS[kind].prefix + suffix);
function poolLabels(kind) {
  return { total: '总数', available: '可用', reserved: '占用', consumed: POOLS[kind].reusable ? '冷却' : '已用', quarantined: '隔离' };
}
function renderPoolStats(target, stats, kind) {
  target.innerHTML = Object.entries(poolLabels(kind)).map(([key, label]) =>
    '<div><span>' + label + '</span><strong>' + escapeHtml(stats[key] ?? 0) + '</strong></div>').join('');
}
function updatePoolRule() {
  const pool = poolState[activePool];
  const hours = Number(pool.cooldownMs) / 3600000;
  const cooldown = Number.isFinite(hours) && hours > 0 ? hours + ' 小时' : '服务端规定时间';
  document.getElementById('poolRule').textContent = activePool === 'control'
    ? '公共站请求：每批自动分配 1 条。已用代理不自动复用；隔离代理需核对。三池互不借用。'
    : POOLS[activePool].label + '：任务自动从本池分配，使用后冷却 ' + cooldown + ' 再复用；占用或隔离代理不参与分配。' + (activePool === 'rebind' ? '账号满 24 小时只解锁按钮，仍需手动换绑。' : '每批需求按邮箱数量 × 每邮箱代理数计算。');
  document.getElementById('poolLoadStatus').textContent = pool.error || (pool.loaded ? (pool.stats.total ? '库存已更新；列表仅显示脱敏信息。' : '代理池为空，请先导入。') : '库存尚未加载。');
}
function selectPool(kind) {
  activePool = kind;
  document.querySelectorAll('[data-pool]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.pool === kind)));
  document.querySelectorAll('[data-pool-panel]').forEach((panel) => { panel.hidden = panel.dataset.poolPanel !== kind; });
  const status = document.getElementById('poolStatus');
  status.innerHTML = '<option value="">全部状态</option>' + Object.entries(poolLabels(kind)).filter(([key]) => key !== 'total').map(([key, label]) => '<option value="' + key + '">' + label + '</option>').join('');
  status.value = poolState[kind].status;
  document.getElementById('poolSearch').value = poolState[kind].q;
  document.getElementById('poolLimit').value = poolState[kind].limit;
  updatePoolRule();
}
function poolError(error) {
  if (error.status === 400) return '导入格式或参数有误，请检查预检结果；代理池未变更。';
  if (error.status === 409) return '代理池存在占用或状态冲突，请刷新后重试；草稿已保留。';
  if (error.status === 404) return '该代理池服务尚未启用。';
  if (error.status === 401 || error.status === 403) return '连接密钥失效，请重新连接。';
  return '请求失败，请检查连接并重试；草稿已保留。';
}

function updateProxyReadiness() {
  const count = Number(elements.registrationCount.value || 1);
  const perMailbox = Number(elements.registrationProxyCount.value || 20);
  const required = count * perMailbox;
  elements.requiredProxyCount.textContent = required;
  const taskAvailable = state.proxyStats?.available || 0;
  const controlAvailable = state.controlProxyStats?.available || 0;
  const ready = taskAvailable >= required && controlAvailable >= 1;
  elements.proxyReadiness.textContent = `公共站请求代理 ${controlAvailable} 条可用，本批需要 1 条；注册代理 ${taskAvailable} 条可用，本批需要 ${required} 条`;
  elements.proxyReadiness.className = `status-line${ready ? '' : ' error-text'}`;
  document.getElementById('startRegistrationButton').disabled = !ready;
}

function renderProxyRows(target, proxies, kind) {
  const html = proxies.length ? proxies.map((proxy) => '<tr><td>' + escapeHtml(proxy.id) + '</td><td>' + escapeHtml(proxy.masked_endpoint) + '</td><td><span class="state">' + escapeHtml(poolLabels(kind)[proxy.status] || '待核对') + '</span></td><td>' + escapeHtml(proxy.batch_id || proxy.job_id || '') + '</td><td>' + escapeHtml(proxy.cooldown_until || proxy.imported_at) + '</td><td>' + (proxy.last_error ? '异常，需核对（详情已隐藏）' : '—') + '</td></tr>').join('') : '<tr><td colspan="6" class="empty">当前筛选下暂无代理</td></tr>';
  if (target._renderedHtml !== html) { target.innerHTML = html; target._renderedHtml = html; }
}
function renderPagination(target, kind, pagination) {
  const page = Number(pagination.page) || 1;
  const pages = Math.max(1, Number(pagination.pages) || 1);
  const html = '<button type="button" data-page-kind="' + kind + '" data-page="' + (page - 1) + '" aria-label="上一页"' + (page <= 1 ? ' disabled' : '') + '>←</button><span>第 ' + page + ' / ' + pages + ' 页，共 ' + (Number(pagination.total) || 0) + ' 条</span><button type="button" data-page-kind="' + kind + '" data-page="' + (page + 1) + '" aria-label="下一页"' + (page >= pages ? ' disabled' : '') + '>→</button>';
  if (target._renderedHtml !== html) { target.innerHTML = html; target._renderedHtml = html; }
}
async function loadPool(kind) {
  const pool = poolState[kind];
  const sequence = ++pool.sequence;
  const query = new URLSearchParams({ page: state.proxyPages[kind], limit: pool.limit, status: pool.status, q: pool.q });
  try {
    const body = await api(POOLS[kind].route + '?' + query);
    if (sequence !== pool.sequence) return;
    pool.stats = body.stats;
    pool.cooldownMs = body.cooldownMs;
    pool.loaded = true;
    pool.disabled = false;
    pool.error = '';
    state.proxyPages[kind] = body.pagination.page;
    if (kind === 'task') state.proxyStats = body.stats;
    if (kind === 'control') state.controlProxyStats = body.stats;
    renderPoolStats(poolElement(kind, 'Stats'), body.stats, kind);
    renderProxyRows(poolElement(kind, 'Rows'), body.proxies, kind);
    renderPagination(poolElement(kind, 'Pagination'), kind, body.pagination);
  } catch (error) {
    if (sequence !== pool.sequence) return;
    pool.loaded = false;
    pool.disabled = error.status === 404;
    pool.error = poolError(error) + ' 已有展示可能过期。';
    if (kind === 'task') state.proxyStats = null;
    if (kind === 'control') state.controlProxyStats = null;
  }
  if (sequence !== pool.sequence) return;
  poolElement(kind, 'Form').querySelector('button[type="submit"]').disabled = pool.disabled || pool.busy;
  if (activePool === kind) updatePoolRule();
  updateProxyReadiness();
  updateRebindPoolSummary();
}
async function loadProxies() {
  await Promise.all(Object.keys(POOLS).map(loadPool));
}

async function loadRegistrations() {
  const body = await api('/api/admin/registration-batches');
  elements.registrationRows.innerHTML = body.batches.length ? body.batches.map((batch) => `<tr>
    <td>${escapeHtml(batch.created_at)}</td><td>${escapeHtml(batch.mailbox_category || 'mail')}${batch.mailbox_provider ? `<br>${escapeHtml(batch.mailbox_provider)}` : ''}</td><td>${batch.requested_count}</td>
    <td><span class="${stateClass(batch.state)}" title="${escapeHtml(batch.state)}">${escapeHtml(BATCH_STATE_LABELS[batch.state] || batch.state)}</span></td>
    <td>${batch.success_count}</td><td>${batch.qualified_count}</td><td>${batch.failed_count}</td>
    <td class="${batch.last_error ? 'error-text' : ''}">${escapeHtml(batch.last_error || BATCH_STATE_PROGRESS[batch.state] || '')}${batch.state === 'submit_unknown' ? ` ${actionButton('对账', 'reconcile-batch', batch.id)}` : ''}</td></tr>`).join('')
    : '<tr><td colspan="8" class="empty">暂无任务</td></tr>';
}

async function loadAccounts(background = false) {
  if (background && state.accountLoading) return;
  const request = ++state.accountLoad;
  state.accountLoading = true;
  if (!background) { clearAccountReveal(); closeAccountHistory(); }
  let body;
  try { body = await api('/api/admin/qualified-accounts'); }
  catch (error) { if (request === state.accountLoad) clearAccountReveal(); throw error; }
  finally { if (request === state.accountLoad) state.accountLoading = false; }
  if (request !== state.accountLoad) return;
  const accounts = [...new Map(body.accounts.map((account) => [account.id, account])).values()];
  if (background && JSON.stringify(accounts) === JSON.stringify(state.accounts)) {
    if (state.historyAccountId) await showAccountHistory(state.historyAccountId);
    return;
  }
  clearAccountReveal();
  state.accounts = accounts;
  const historyId = state.historyAccountId;
  if (background && historyId) await showAccountHistory(historyId);
  updateAccountFilterOptions();
  renderAccounts();
}

const ACCOUNT_STATUS_LABELS = { original: '未换绑', rebinding: '换绑中', rebound: '已换绑', needs_review: '待核对' };
function accountStatus(account) { return account.rebind_status || 'original'; }
function credentialsReady(account) {
  return !['rebinding', 'needs_review'].includes(accountStatus(account))
    && (account.credential_ready === true || (account.credential_ready == null && accountStatus(account) === 'original'));
}
function accountStatusLabel(account) {
  return (ACCOUNT_STATUS_LABELS[accountStatus(account)] || '待核对') + (accountStatus(account) === 'rebound' && account.cleanup_pending ? '·清理待重试' : '');
}
function accountEmailLabel(account) {
  if (['rebinding', 'needs_review'].includes(accountStatus(account))) return `上次确认邮箱：${account.email}`;
  return account.original_email && account.original_email !== account.email
    ? `${account.original_email} → ${account.email}` : account.email;
}

const ACCOUNT_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const ACCOUNT_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function accountDate(account) {
  const parts = Object.fromEntries(ACCOUNT_DATE_FORMAT.formatToParts(new Date(account.created_at))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function accountCategoryLabel(value) {
  return ({ mail: 'Mail 分裂邮箱', ic: 'IC 邮箱', gmail: 'Gmail', outlook: 'Outlook' })[value] || value;
}

function trialLabel(value) {
  return ({
    observed_eligible: '有试用资格',
    observed_ineligible: '无试用资格',
    unknown: '资格未知',
  })[value] || '资格未知';
}

const POST_TRIAL_LABELS = { not_checked: '待检测', checking: '检测中', eligible: '有资格', ineligible: '无资格', error: '检测失败' };
function postTrialStatus(account) {
  return Object.hasOwn(POST_TRIAL_LABELS, account.post_rebind_trial_status) ? account.post_rebind_trial_status : 'not_checked';
}
function accountTrialFilter(account) {
  if (accountStatus(account) !== 'rebound') return account.trial_qualification;
  const status = postTrialStatus(account);
  return ({ eligible: 'observed_eligible', ineligible: 'observed_ineligible' })[status] || status;
}
function trialErrorLabel(code) {
  const labels = {
    ACCOUNT_CREDENTIALS_UNCONFIRMED: '账号凭据尚未确认，请刷新核对。',
    ACCOUNT_NOT_REBOUND: '账号尚未完成换绑，请刷新核对。',
    TRIAL_CHECK_TIMEOUT: '检测超时，请手动重试。',
    TIMEOUT: '检测超时，请手动重试。',
    TRIAL_CHECK_FAILED: '资格检测失败，请手动重试。',
    TRIAL_PROBE_FAILED: '资格检测失败，请手动重试。',
    REBIND_PROXY_POOL_EXHAUSTED: '换绑代理池暂无可用代理，请检查库存后重试。',
    TRIAL_WORKER_UNAVAILABLE: '资格检测服务暂不可用，请稍后重试。',
    TRIAL_INTERRUPTED: '资格检测已中断，请手动重试。',
    TRIAL_STALE_RESULT: '检测期间账号状态已变化，结果已失效，请刷新核对。',
    TRIAL_CHECK_ACTIVE: '已有资格检测正在进行，请等待检测结果。',
    TRIAL_ACCOUNT_NOT_READY: '账号尚未准备好检测资格，请刷新核对换绑状态和凭据。',
    WORKER_TIMEOUT: '检测执行超时，请手动重试。',
    WORKER_START_FAILED: '检测执行程序启动失败，请稍后重试。',
    LOGIN_FAILED: '登录未完成，原因未确认。',
    LOGIN_INCOMPLETE: '登录未完成，原因未确认。',
    NETWORK_TLS: '网络 TLS 连接失败，请稍后重试。',
    NETWORK: '网络连接失败，请稍后重试。',
    PROXY: '代理连接失败，请稍后重试。',
    PROXY_FAILED: '代理连接失败，请稍后重试。',
    MFA_FAILED: '两步验证失败，请核对验证凭据后重试。',
    MFA_INVALID_CODE: '两步验证码无效，请核对验证凭据后重试。',
    ACCOUNT_MISMATCH: '检测登录账号不匹配，请刷新核对当前账号。',
    SESSION_EMAIL_MISMATCH: '检测会话邮箱不匹配，请刷新核对当前邮箱。',
    IDEMPOTENCY_CONFLICT: '请求标识与已有检测冲突，请刷新后手动重新检测。',
    INVALID_IDEMPOTENCY_KEY: '检测请求标识无效，请手动重新检测。',
  };
  return Object.hasOwn(labels, code) ? labels[code] : '资格检测失败，请刷新核对后手动重试。';
}
function accountTrialHtml(account) {
  const registration = `注册资格：${escapeHtml(trialLabel(account.trial_qualification))}`;
  if (accountStatus(account) !== 'rebound') return registration;
  const status = postTrialStatus(account);
  const confirmed = account.post_rebind_trial_last_confirmed_status;
  const sameEmail = String(account.email || '').trim().toLowerCase() === String(account.post_rebind_trial_last_confirmed_email || '').trim().toLowerCase();
  const errorCode = account.post_rebind_trial_error_code;
  const category = String(account.post_rebind_trial_error_category || '').toUpperCase();
  const phases = { input: '检查登录参数', bootstrap: '认证初始化', authorize_continue: '提交登录邮箱',
    password_verify: '验证密码', mfa_factor: '获取两步验证方式', mfa_issue: '发起两步验证',
    mfa_verify: '验证两步验证码', reauthorize: '重新授权', redirect: '处理登录跳转',
    callback: '处理登录回调', session: '获取登录会话' };
  const reasonLabels = { LOGIN_INPUT_MISSING: '登录参数缺失', LOGIN_STEP_FAILED: '登录步骤执行失败',
    LOGIN_HTTP_ERROR: '登录服务响应异常', LOGIN_CREDENTIALS_REJECTED: '登录凭据校验未通过',
    LOGIN_RESPONSE_INVALID: '登录响应格式异常', LOGIN_PASSWORD_PAGE_MISSING: '未找到密码验证页面',
    LOGIN_MFA_FACTOR_MISSING: '未找到两步验证方式', LOGIN_MFA_CODE_REJECTED: '两步验证码校验未通过',
    LOGIN_MFA_REJECTED: '两步验证未通过', LOGIN_CONTINUE_MISSING: '缺少后续登录地址',
    LOGIN_CALLBACK_INVALID: '登录回调无效', LOGIN_CALLBACK_REUSED: '登录回调已使用',
    LOGIN_SESSION_MISSING: '未取得完整登录会话' };
  const phase = Object.hasOwn(phases, account.post_rebind_trial_error_phase) ? phases[account.post_rebind_trial_error_phase] : '';
  const reason = Object.hasOwn(reasonLabels, account.post_rebind_trial_error_reason) ? reasonLabels[account.post_rebind_trial_error_reason] : '';
  const categories = { TLS: '网络 TLS 连接失败，请稍后重试。', NETWORK_TLS: '网络 TLS 连接失败，请稍后重试。',
    NETWORK: '网络连接失败，请稍后重试。', TIMEOUT: '网络超时，请稍后重试。', NETWORK_TIMEOUT: '网络超时，请稍后重试。',
    PROXY: '代理连接失败，请稍后重试。', NETWORK_PROXY: '代理连接失败，请稍后重试。',
    HTTP: '远端服务响应异常。', PROTOCOL: '远端响应格式异常。' };
  const categoryLabel = Object.hasOwn(categories, category) ? categories[category]
    : ['NETWORK_TLS', 'NETWORK_TIMEOUT', 'NETWORK_PROXY'].includes(errorCode) ? categories[errorCode] : '';
  const httpStatus = account.post_rebind_trial_http_status;
  const validHttp = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599;
  const loginHttp = phase || ['LOGIN_FAILED', 'LOGIN_INCOMPLETE'].includes(errorCode) || account.post_rebind_trial_error_reason === 'LOGIN_HTTP_ERROR';
  const httpLabel = validHttp && loginHttp ? ({
    429: '登录服务限流（HTTP 429），本次已停止自动重试',
    403: '登录请求被服务端拦截（HTTP 403）',
    401: '登录认证未通过（HTTP 401）',
  }[httpStatus] || `登录服务响应异常（HTTP ${httpStatus}）`) : '';
  const specificReason = reason && !['LOGIN_STEP_FAILED', 'LOGIN_HTTP_ERROR'].includes(account.post_rebind_trial_error_reason);
  const reasons = specificReason ? [reason + (validHttp ? `（HTTP ${httpStatus}）` : '')] : httpLabel ? [httpLabel] : categoryLabel
    ? [...(!phase && ['LOGIN_FAILED', 'LOGIN_INCOMPLETE'].includes(errorCode) ? ['登录未完成。'] : []),
      phase ? categoryLabel.replace('网络 TLS 连接失败', 'TLS连接失败') : categoryLabel]
    : reason ? [reason]
    : [trialErrorLabel(errorCode)];
  const stages = { session_trial: '核验已有会话（失效后重新登录），资格查询尚未开始',
    login_trial: '重新登录，资格查询尚未开始', trial_qualification: '查询试用资格' };
  const stage = Object.hasOwn(stages, account.post_rebind_trial_stage) ? stages[account.post_rebind_trial_stage] : '';
  const attempts = account.post_rebind_trial_attempts;
  return `换绑后：${POST_TRIAL_LABELS[status]}<br><small>检测时间：${escapeHtml(account.post_rebind_trial_checked_at || '尚未完成检测')}</small>`
    + (status === 'checking' && Number.isInteger(attempts) && attempts >= 1 && attempts <= 3 ? `<br><small>检测中第${attempts}/3次</small>` : '')
    + (['checking', 'error'].includes(status) && stage ? `<br><small>检测阶段：${stage}</small>` : '')
    + (status === 'error' ? `<br><small>最近检测失败，当前资格未确认。${phase ? `登录步骤：${phase}：` : ''}${[...new Set(reasons)].join(' ')}</small>` : '')
    + (!['eligible', 'ineligible'].includes(status) && sameEmail && ['eligible', 'ineligible'].includes(confirmed) ? `<br><small>上次成功确认：${POST_TRIAL_LABELS[confirmed]} · ${escapeHtml(account.post_rebind_trial_last_confirmed_checked_at || '时间未知')}（仅历史记录，不代表当前资格）</small>` : '')
    + `<br><small>原${registration}（独立保留）</small>`;
}
function trialButtons(account) {
  if (accountStatus(account) !== 'rebound' || !credentialsReady(account)) return '';
  const pending = state.trialRequests.get(account.id);
  const disabled = pending?.busy || postTrialStatus(account) === 'checking';
  return `<button type="button" data-action="trial-check" data-id="${escapeHtml(account.id)}"${disabled ? ' disabled' : ''}>${pending?.key ? '重试检测请求' : postTrialStatus(account) === 'not_checked' ? '检测资格' : '重新检测'}</button>`
    + (pending?.key ? `<button type="button" data-action="trial-latest" data-id="${escapeHtml(account.id)}"${pending.busy ? ' disabled' : ''}>核对最新检测</button>` : '')
    + (pending?.message ? `<small role="status">${escapeHtml(pending.message)}</small>` : '');
}
async function checkAccountTrial(id, latest = false) {
  const previous = state.trialRequests.get(id);
  if (previous?.busy) return;
  const pending = { key: previous?.key || rebindRequestId(), busy: true, message: '' };
  state.trialRequests.set(id, pending);
  renderAccounts();
  elements.accountHistoryContent.querySelectorAll('button[data-action^="trial-"]').forEach((button) => {
    if (button.dataset.id === id) button.disabled = true;
  });
  try {
    const fresh = await api(`/api/admin/qualified-accounts/${encodeURIComponent(id)}/rebind-history`);
    const account = fresh.account;
    if (!account || account.id !== id || accountStatus(account) !== 'rebound' || !credentialsReady(account)) {
      pending.message = trialErrorLabel('TRIAL_ACCOUNT_NOT_READY');
      return;
    }
    if (!latest && postTrialStatus(account) === 'checking') {
      pending.message = trialErrorLabel('TRIAL_CHECK_ACTIVE');
      return;
    }
    const path = `/api/admin/qualified-accounts/${encodeURIComponent(id)}/trial-check`;
    const body = await api(path, latest ? {} : { method: 'POST', body: JSON.stringify({ idempotencyKey: pending.key }) });
    if (!Object.hasOwn(body, 'check') || (!latest && !body.check)) throw new Error('Invalid check response');
    const confirmed = !latest || body.check?.idempotency_key === pending.key;
    if (confirmed) pending.key = null;
    pending.message = confirmed ? '检测请求已确认。' : '当前请求尚未确认，重试将沿用原请求标识。';
    const current = state.accounts.find((item) => item.id === id);
    if (current && confirmed) current.post_rebind_trial_status = body.check === null ? 'not_checked'
      : Object.hasOwn(POST_TRIAL_LABELS, body.check.status) ? body.check.status : 'checking';
    try { await loadAccounts(true); }
    catch { pending.message += '账号列表刷新失败，请手动刷新。'; }
  } catch (error) {
    const notCreated = !latest && ((error.status === 409
      && ['TRIAL_CHECK_ACTIVE', 'TRIAL_ACCOUNT_NOT_READY', 'IDEMPOTENCY_CONFLICT'].includes(error.code))
      || (error.status === 400 && error.code === 'INVALID_IDEMPOTENCY_KEY'));
    if (notCreated) {
      pending.key = null;
      pending.message = trialErrorLabel(error.code);
      if (error.code === 'TRIAL_CHECK_ACTIVE') {
        const current = state.accounts.find((item) => item.id === id);
        if (current) current.post_rebind_trial_status = 'checking';
      }
      try { await loadAccounts(true); }
      catch { pending.message += '账号列表刷新失败，请手动刷新。'; }
    } else pending.message = `${trialErrorLabel(error.code)} 请求结果未确认；重试沿用原请求标识，也可核对最新检测。`;
  } finally {
    pending.busy = false;
    renderAccounts();
    if (state.historyAccountId === id) await showAccountHistory(id);
  }
}

function mfaLabel(value) {
  return value === 'enabled' ? '已开启' : value;
}

function replaceSelectOptions(select, options, previousValue) {
  select.innerHTML = options.map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
  select.value = options.some((option) => option.value === previousValue) ? previousValue : options[0].value;
}

function updateAccountFilterOptions() {
  const previousDate = elements.accountDateFilter.value;
  const previousCategory = elements.accountCategoryFilter.value;
  const dates = [...new Set(state.accounts.map(accountDate))].sort().reverse();
  const categories = [...new Set(state.accounts.map((account) => account.mailbox_category))].sort();
  replaceSelectOptions(elements.accountDateFilter, [
    { value: 'all', label: '全部日期' },
    ...dates.map((date) => ({
      value: date,
      label: `${date} (${state.accounts.filter((account) => accountDate(account) === date).length})`,
    })),
  ], state.accountFiltersInitialized ? previousDate : (dates[0] || 'all'));
  replaceSelectOptions(elements.accountCategoryFilter, [
    { value: 'all', label: '全部注册来源' },
    ...categories.map((category) => ({ value: category, label: accountCategoryLabel(category) })),
  ], previousCategory || 'all');
  state.accountFiltersInitialized = true;
}

function renderAccounts() {
  const status = elements.accountStatusFilter.value || 'all';
  elements.accountStatusCounts.innerHTML = Object.entries({ all: '全部', ...ACCOUNT_STATUS_LABELS }).map(([value, label]) =>
    `<button type="button" data-account-status="${value}" aria-pressed="${value === status}">${label} <strong>${value === 'all' ? state.accounts.length : state.accounts.filter((account) => accountStatus(account) === value).length}</strong></button>`).join('');
  const date = elements.accountDateFilter.value;
  const category = elements.accountCategoryFilter.value;
  const trial = elements.accountTrialFilter.value;
  const query = elements.accountSearchInput.value.trim().toLowerCase();
  const accounts = state.accounts.filter((account) => (
    (date === 'all' || accountDate(account) === date)
    && (status === 'all' || accountStatus(account) === status)
    && (category === 'all' || account.mailbox_category === category)
    && (trial === 'all' || accountTrialFilter(account) === trial)
    && (!query || [account.email, account.original_email].some((email) => String(email || '').toLowerCase().includes(query)))
  ));
  if (status === 'rebound') accounts.sort((a, b) => String(b.rebound_at || '').localeCompare(String(a.rebound_at || '')));
  elements.accountFilterSummary.textContent = `显示 ${accounts.length} / ${state.accounts.length} 个账号`;
  if (!accounts.length) {
    elements.accountRows.innerHTML = '<tr><td colspan="7" class="empty">当前筛选条件下没有账号</td></tr>';
    return;
  }
  const groups = new Map();
  for (const account of accounts) {
    const key = status === 'rebound' ? '已换绑 · 按换绑时间倒序' : accountDate(account);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }
  elements.accountRows.innerHTML = [...groups.entries()].sort(([left], [right]) => right.localeCompare(left))
    .map(([registeredDate, group]) => {
      const eligible = group.filter((account) => accountTrialFilter(account) === 'observed_eligible').length;
      const rows = group.map((account) => `<tr data-account-id="${escapeHtml(account.id)}">
        <td>${escapeHtml(accountEmailLabel(account))}</td>
        <td>${escapeHtml(accountCategoryLabel(account.mailbox_category))}</td>
        <td><span class="state">${escapeHtml(mfaLabel(account.mfa_status))}</span></td>
        <td>${accountTrialHtml(account)}</td>
        <td>${escapeHtml(accountDate(account))}<br>${escapeHtml(ACCOUNT_TIME_FORMAT.format(new Date(account.created_at)))}</td>
        <td><span class="state">${escapeHtml(accountStatusLabel(account))}</span><br>${escapeHtml(account.rebound_at || '—')}</td>
        <td><div class="actions"><button type="button" data-action="reveal-account" data-id="${escapeHtml(account.id)}"${credentialsReady(account) ? '' : ' disabled'}>查看凭据</button>${actionButton('换绑历史', 'account-history', account.id)}${trialButtons(account)}</div></td>
      </tr>`).join('');
      return `<tr class="account-date-row"><th colspan="7"><div class="account-date-heading">
        <span>${escapeHtml(registeredDate)}</span><span>${group.length} 个账号，其中 ${eligible} 个有试用资格</span>
      </div></th></tr>${rows}`;
    }).join('');
}

async function loadIcMailboxes() {
  const body = await api('/api/admin/ic-mailboxes');
  elements.icMailboxRows.innerHTML = body.mailboxes.length ? body.mailboxes.map((mailbox) => `<tr>
    <td>${escapeHtml(mailbox.email)}</td>
    <td>${escapeHtml(mailbox.pickup_hostname)}</td>
    <td>${escapeHtml(mailbox.adapter_key)}</td>
    <td><span class="${stateClass(mailbox.state)}">${escapeHtml(mailbox.state)}</span></td>
    <td>${escapeHtml(mailbox.last_accessed_at || '')}</td>
    <td class="error-text">${escapeHtml(mailbox.last_error)}</td>
    <td><div class="actions">
      ${actionButton('测试取件', 'test-ic-mailbox', mailbox.id)}
      ${actionButton('生成新链接', 'rotate-ic-token', mailbox.id)}
    </div></td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">暂无 IC 邮箱</td></tr>';
}

async function switchView(view) {
  clearAccountReveal();
  closeAccountHistory();
  state.currentView = view;
  document.querySelectorAll('[data-page]').forEach((page) => { page.hidden = page.dataset.page !== view; });
  document.querySelectorAll('.nav-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  if (view === 'registration') await Promise.all([loadRegistrations(), loadProxies(), loadMailboxes()]);
  if (view === 'proxies') await loadProxies();
  if (view === 'accounts') await loadAccounts();
  if (view === 'ic-mail') await loadIcMailboxes();
  if (view === 'rebind') await loadRebind();
}

async function selectMailbox(id) {
  state.selectedId = id;
  const mailbox = state.mailboxes.find((item) => item.id === id);
  if (!mailbox) return;
  elements.workspace.hidden = false;
  elements.workspaceTitle.textContent = mailbox.email;
  updateMailboxCreation();
  const [aliases, domains] = await Promise.all([
    api(`/api/admin/mailboxes/${encodeURIComponent(id)}/aliases`),
    api(`/api/admin/mailboxes/${encodeURIComponent(id)}/domains`),
  ]);
  renderAliases(aliases.aliases);
  renderDomains(domains.domains);
}

function renderAliases(aliases) {
  elements.aliasRows.innerHTML = aliases.length ? aliases.map((alias) => {
    const canRelease = ['ready', 'exported', 'active', 'delivered', 'delete_failed', 'release_pending'].includes(alias.state);
    const canReconcile = ['create_unknown', 'delete_unknown'].includes(alias.state);
    return `<tr>
      <td>${escapeHtml(alias.email)}</td>
      <td><span class="${stateClass(alias.state)}">${escapeHtml(alias.state)}</span></td>
      <td>${escapeHtml(alias.first_accessed_at || '')}</td>
      <td>${escapeHtml(alias.delivered_at || '')}</td>
      <td class="error-text">${escapeHtml(alias.last_error)}</td>
      <td><div class="actions">
        ${canReconcile ? actionButton('对账', 'reconcile', alias.id) : ''}
        ${canRelease ? actionButton('回收', 'release', alias.id, true) : ''}
      </div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">暂无分裂邮箱</td></tr>';
}

function renderDomains(domains) {
  elements.domainRows.innerHTML = domains.length ? domains.map((domain) => `
    <tr>
      <td>${escapeHtml(domain.domain)}</td>
      <td><span class="state">${escapeHtml(domain.remote_state)}</span></td>
      <td><select data-domain="${escapeHtml(domain.domain)}">
        ${['hidden', 'explicit', 'blacklist'].map((kind) => `<option value="${kind}"${kind === domain.kind ? ' selected' : ''}>${kind}</option>`).join('')}
      </select></td>
    </tr>`).join('') : '<tr><td colspan="3" class="empty">同步后显示后缀</td></tr>';
}

async function mailboxAction(action) {
  if (!state.selectedId) return;
  await api(`/api/admin/mailboxes/${encodeURIComponent(state.selectedId)}/${action}`, { method: 'POST', body: '{}' });
  showNotice(`${action} 完成`);
  await loadMailboxes();
}

document.getElementById('authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.apiKey = elements.apiKey.value;
  sessionStorage.setItem('mailGatewayApiKey', state.apiKey);
  try { await loadMailboxes(); } catch (error) { showNotice(error.message, true); }
});

document.getElementById('mailboxForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api('/api/admin/mailboxes', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
    formElement.reset();
    await loadMailboxes();
    showNotice('主邮箱已添加');
  } catch (error) {
    showNotice(error.message, true);
    await loadMailboxes().catch(() => {});
  }
});

document.getElementById('mailboxImportFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const input = document.getElementById('mailboxImportText');
  const button = document.querySelector('#mailboxImportForm button[type="submit"]');
  input.value = '';
  button.disabled = true;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('文件不能超过 4 MB');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    try { input.value = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch (error) {
      if (encoding !== 'utf-8') throw error;
      input.value = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    }
  } catch (error) { showNotice(`文件读取失败：${error.message}`, true); }
  finally { button.disabled = false; }
});

document.getElementById('mailboxImportForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  const output = document.getElementById('mailboxImportResult');
  output.textContent = '正在导入...';
  try {
    const text = document.getElementById('mailboxImportText').value;
    const body = await api('/api/admin/mailboxes/import', { method: 'POST', body: JSON.stringify({ text }) });
    const { imported, duplicates, invalid } = body.counts;
    output.textContent = `成功 ${imported}，重复 ${duplicates}，无效 ${invalid}\n` + body.results.map((row) =>
      `第 ${row.line} 行：${({ imported: '成功', duplicate: '重复，已跳过', invalid: '格式无效' })[row.status]}${row.email ? ` (${row.email})` : ''}`
    ).join('\n');
    form.reset();
    await loadMailboxes().catch(() => showNotice('导入已完成，列表刷新失败，请刷新列表', true));
  } catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
});

document.getElementById('icMailboxImportForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  elements.icMailboxImportResult.textContent = '正在导入...';
  try {
    const body = await api('/api/admin/ic-mailboxes/import', {
      method: 'POST', body: JSON.stringify({ text: elements.icMailboxImportText.value }),
    });
    const lines = body.results.filter((item) => item.exportLine).map((item) => item.exportLine);
    elements.icMailboxExportOutput.value = lines.join('\n');
    elements.icMailboxImportResult.textContent = `成功 ${body.counts.imported}，重复 ${body.counts.duplicates}，无效 ${body.counts.invalid}\n`
      + body.results.map((item) => `第 ${item.line} 行：${item.status}${item.error ? ` (${item.error})` : ''}`).join('\n');
    await loadIcMailboxes();
  } catch (error) {
    elements.icMailboxImportResult.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('copyIcMailboxExportButton').addEventListener('click', async () => {
  await navigator.clipboard.writeText(elements.icMailboxExportOutput.value);
  showNotice('已复制');
});

document.getElementById('refreshIcMailboxesButton').addEventListener('click', () => {
  loadIcMailboxes().catch((error) => showNotice(error.message, true));
});

elements.icMailboxRows.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  button.disabled = true;
  try {
    const action = button.dataset.action === 'test-ic-mailbox' ? 'test' : 'rotate-token';
    const body = await api(`/api/admin/ic-mailboxes/${encodeURIComponent(button.dataset.id)}/${action}`, {
      method: 'POST', body: '{}',
    });
    if (action === 'test') {
      showNotice(body.result.status === 'code' ? `取件成功：${body.result.code}` : '取件正常，当前暂无邮件');
    } else {
      elements.icMailboxExportOutput.value = body.result.exportLine;
      await navigator.clipboard.writeText(body.result.exportLine);
      showNotice('新链接已生成并复制，旧链接已失效');
    }
    await loadIcMailboxes();
  } catch (error) {
    showNotice(error.message, true);
    await loadIcMailboxes().catch(() => {});
  } finally {
    button.disabled = false;
  }
});

elements.mailboxRows.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action="select"]');
  if (button) selectMailbox(button.dataset.id).catch((error) => showNotice(error.message, true));
});

document.getElementById('refreshButton').addEventListener('click', () => loadMailboxes().catch((error) => showNotice(error.message, true)));
document.getElementById('openButton').addEventListener('click', () => mailboxAction('open').catch((error) => showNotice(error.message, true)));
document.getElementById('syncButton').addEventListener('click', () => mailboxAction('sync').catch((error) => showNotice(error.message, true)));
document.getElementById('closeButton').addEventListener('click', () => mailboxAction('close').catch((error) => showNotice(error.message, true)));

document.getElementById('createButton').addEventListener('click', async () => {
  if (!mailboxCanCreate(state.mailboxes.find((item) => item.id === state.selectedId))) return;
  try {
    const body = await api(`/api/admin/mailboxes/${encodeURIComponent(state.selectedId)}/aliases`, {
      method: 'POST',
      body: JSON.stringify({ count: Number(elements.createCount.value) }),
    });
    elements.exportOutput.value = body.results.filter((item) => item.ok).map((item) => item.exportLine).join('\n');
    const failed = body.results.filter((item) => !item.ok).length;
    showNotice(failed ? `创建完成，${failed} 个失败` : '创建完成', failed > 0);
    await loadMailboxes();
  } catch (error) {
    showNotice(error.message, true);
    if (error.code === 'MAILBOX_CREATION_BLOCKED') {
      const mailbox = state.mailboxes.find((item) => item.id === state.selectedId);
      if (mailbox) mailbox.creation_blocked = 1;
      renderMailboxes();
      updateMailboxCreation();
      await loadMailboxes().catch(() => {});
    }
  }
});

document.getElementById('clearAliasesButton').addEventListener('click', async () => {
  if (!confirm('确认删除这个主邮箱下的全部远端分裂邮箱？')) return;
  try {
    const body = await api(`/api/admin/mailboxes/${encodeURIComponent(state.selectedId)}/aliases/clear`, {
      method: 'POST',
      body: '{}',
    });
    const { deleted, failed } = body.result;
    showNotice(`已删除 ${deleted} 个${failed ? `，${failed} 个失败` : ''}`, failed > 0);
    await loadMailboxes();
  } catch (error) { showNotice(error.message, true); }
});

document.getElementById('copyExportButton').addEventListener('click', async () => {
  await navigator.clipboard.writeText(elements.exportOutput.value);
  showNotice('已复制');
});

elements.aliasRows.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  try {
    const body = await api(`/api/admin/aliases/${encodeURIComponent(button.dataset.id)}/${button.dataset.action}`, { method: 'POST', body: '{}' });
    if (body.result?.exportLine) elements.exportOutput.value = body.result.exportLine;
    showNotice(`${button.dataset.action} 完成`);
    await loadMailboxes();
  } catch (error) { showNotice(error.message, true); }
});

elements.domainRows.addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-domain]');
  if (!select) return;
  try {
    await api(`/api/admin/mailboxes/${encodeURIComponent(state.selectedId)}/domains/${encodeURIComponent(select.dataset.domain)}`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: select.value }),
    });
    showNotice('后缀分类已更新');
  } catch (error) { showNotice(error.message, true); }
});

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  document.getElementById('aliasesPanel').hidden = tab.dataset.tab !== 'aliases';
  document.getElementById('domainsPanel').hidden = tab.dataset.tab !== 'domains';
}));

document.querySelectorAll('.nav-tab').forEach((tab) => tab.addEventListener('click', () => {
  switchView(tab.dataset.view).catch((error) => showNotice(error.message, true));
}));

elements.registrationCount.addEventListener('input', () => {
  updateProxyReadiness();
});
elements.registrationProxyCount.addEventListener('input', () => {
  updateProxyReadiness();
});
elements.registrationMailboxCategory.addEventListener('change', () => {
  const ic = elements.registrationMailboxCategory.value === 'ic';
  elements.registrationProviderField.hidden = !ic;
  elements.registrationMailboxProvider.disabled = !ic;
  document.getElementById('registrationMailboxAvailability').hidden = ic;
  elements.registrationCountLabel.textContent = ic ? 'IC 邮箱数量' : '分裂邮箱数量';
});

document.getElementById('registrationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('startRegistrationButton');
  button.disabled = true;
  try {
    await api('/api/admin/registration-batches', {
      method: 'POST', body: JSON.stringify({
        count: Number(elements.registrationCount.value),
        proxiesPerMailbox: Number(elements.registrationProxyCount.value),
        mailboxCategory: elements.registrationMailboxCategory.value,
        mailboxProvider: elements.registrationMailboxCategory.value === 'ic'
          ? elements.registrationMailboxProvider.value : '',
      }),
    });
    showNotice('注册任务已创建');
    await Promise.all([loadRegistrations(), loadProxies()]);
  } catch (error) { showNotice(error.message, true); }
  finally { updateProxyReadiness(); }
});

function normalizeProxyDraft(value, kind) {
  const raw = value.trim();
  const supplier = true;
  const hostFirst = raw.match(/^([^\s:@/]+):(\d+)@([^\s:]+):(.+)$/);
  let endpoint = raw;
  if (supplier && hostFirst) {
    const [, host, port, user, password] = hostFirst;
    endpoint = 'http://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@' + host + ':' + port;
  } else if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!url.hostname || !url.port) throw new Error();
    } catch {
      const parts = raw.replace(/^https?:\/\//i, '').split(':');
      if (!supplier || parts.length !== 4 || !parts.every(Boolean)) throw new Error();
      const [host, port, user, password] = parts;
      endpoint = 'http://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@' + host + ':' + port;
    }
  } else {
    const parts = raw.split(':');
    if (![2, 4].includes(parts.length) || !parts.every(Boolean)) throw new Error();
    const [host, port] = parts;
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || /[\s/@]/.test(host)) throw new Error();
  }
  if (/^https?:\/\//i.test(endpoint)) {
    const url = new URL(endpoint);
    if (!url.hostname || !url.port || Number(url.port) < 1) throw new Error();
  }
  return endpoint;
}
function preflightProxy(text, kind) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const unique = new Set();
  const invalid = [];
  let duplicates = 0;
  let valid = 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let bad = false;
    for (const entry of line.trim().split(/\s+/)) {
      try {
        const endpoint = normalizeProxyDraft(entry, kind);
        valid += 1;
        if (unique.has(endpoint)) duplicates += 1;
        else unique.add(endpoint);
      } catch { bad = true; }
    }
    if (bad) invalid.push(index + 1);
  });
  return { total: text ? lines.length : 0, valid, duplicates, invalid, unique: unique.size, oversized: new TextEncoder().encode(text).length > 4 * 1024 * 1024 };
}
function previewProxy(kind) {
  const result = preflightProxy(poolElement(kind, 'Input').value, kind);
  poolElement(kind, 'Preview').textContent = '总行 ' + result.total + ' · 有效记录 ' + result.valid + ' · 重复 ' + result.duplicates + ' · 去重后 ' + result.unique + ' · 无效行 ' + result.invalid.length + (result.invalid.length ? '（行号：' + result.invalid.slice(0, 60).join('、') + (result.invalid.length > 60 ? '…' : '') + '）' : '') + (result.oversized ? '；内容超过 4 MB。' : '');
  return result;
}
async function readProxyFile(file) {
  if (file.size > 4 * 1024 * 1024) throw new Error();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch (error) {
    if (encoding !== 'utf-8') throw error;
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
}
Object.keys(POOLS).forEach((kind) => {
  let previewTimer;
  poolElement(kind, 'Input').addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => previewProxy(kind), 200);
  });
  poolElement(kind, 'File').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file || poolState[kind].busy) return;
    clearTimeout(previewTimer);
    const form = poolElement(kind, 'Form');
    const controls = [...form.querySelectorAll('input, textarea, select, button')];
    poolState[kind].busy = true;
    controls.forEach((control) => { control.disabled = true; });
    try {
      const text = await readProxyFile(file);
      const input = poolElement(kind, 'Input');
      if (input.value.trim() && !window.confirm('用 TXT 内容替换当前未提交草稿？取消将保留原草稿。')) return;
      const combined = text;
      if (new TextEncoder().encode(combined).length > 4 * 1024 * 1024) throw new Error();
      input.value = combined;
      previewProxy(kind);
    } catch { poolElement(kind, 'Preview').textContent = '文件读取失败：请使用不超过 4 MB 的 TXT，检查编码及解码后大小。原草稿已保留。'; }
    finally {
      poolState[kind].busy = false;
      controls.forEach((control) => { control.disabled = false; });
      form.querySelector('button[type="submit"]').disabled = poolState[kind].disabled;
      event.target.value = '';
    }
  });
  poolElement(kind, 'Form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const pool = poolState[kind];
    if (pool.busy || pool.disabled) return;
    clearTimeout(previewTimer);
    const result = previewProxy(kind);
    if (result.invalid.length || !result.unique || result.oversized) {
      showNotice('请修正无效行并检查内容大小，空列表不会提交。', true);
      return;
    }
    const current = pool.loaded ? pool.stats.total + ' 条' : '尚未确认（建议先刷新库存）';
    if (!window.confirm('确认覆盖' + POOLS[kind].label + '代理池？当前库存：' + current + '；新有效记录：' + result.unique + ' 条。现有可替换库存将被替换；进行中条目由服务端保护。取消会保留草稿。')) return;
    const text = poolElement(kind, 'Input').value;
    const controls = [...event.currentTarget.querySelectorAll('input, textarea, select, button')];
    const button = event.currentTarget.querySelector('button[type="submit"]');
    pool.busy = true;
    controls.forEach((control) => { control.disabled = true; });
    button.textContent = '导入中…';
    try {
      await api(POOLS[kind].route + '/import', { method: 'POST', body: JSON.stringify({ text, mode: 'replace' }) });
      clearTimeout(previewTimer);
      poolElement(kind, 'Input').value = '';
      poolElement(kind, 'File').value = '';
      state.proxyPages[kind] = 1;
      poolElement(kind, 'Preview').textContent = '导入已成功，敏感草稿已清空。';
      showNotice(POOLS[kind].label + '代理导入成功');
      await loadPool(kind);
      if (!pool.loaded) poolElement(kind, 'Preview').textContent = '导入已成功，但库存刷新失败。请刷新库存核对，无需重复导入。';
    } catch (error) { poolElement(kind, 'Preview').textContent = poolError(error); }
    finally {
      pool.busy = false;
      controls.forEach((control) => { control.disabled = false; });
      button.disabled = pool.disabled;
      button.textContent = '预检并覆盖';
    }
  });
});
document.querySelectorAll('[data-pool]').forEach((button) => button.addEventListener('click', () => {
  selectPool(button.dataset.pool);
  loadPool(activePool);
}));
['poolStatus', 'poolSearch', 'poolLimit'].forEach((id) => {
  document.getElementById(id).addEventListener(id === 'poolSearch' ? 'input' : 'change', () => {
    const pool = poolState[activePool];
    pool.status = document.getElementById('poolStatus').value;
    pool.q = document.getElementById('poolSearch').value;
    pool.limit = document.getElementById('poolLimit').value;
    state.proxyPages[activePool] = 1;
    loadPool(activePool);
  });
});
selectPool('task');

document.getElementById('refreshRegistrationsButton').addEventListener('click', () => Promise.all([loadRegistrations(), loadMailboxes()]).catch((error) => showNotice(error.message, true)));
document.getElementById('refreshProxiesButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '刷新中…';
  try { await loadPool(activePool); }
  finally { button.disabled = false; button.textContent = '刷新库存'; }
});
document.getElementById('refreshAccountsButton').addEventListener('click', () => loadAccounts().catch((error) => showNotice(error.message, true)));
['accountDateFilter', 'accountCategoryFilter', 'accountTrialFilter'].forEach((id) => {
  elements[id].addEventListener('change', renderAccounts);
});
elements.accountSearchInput.addEventListener('input', renderAccounts);
function selectAccountStatus(status) {
  elements.accountStatusFilter.value = status;
  elements.accountDateFilter.value = 'all';
  renderAccounts();
}
elements.accountStatusFilter.addEventListener('change', () => selectAccountStatus(elements.accountStatusFilter.value));
elements.accountStatusCounts.addEventListener('click', (event) => {
  const button = event.target.closest('[data-account-status]');
  if (button) selectAccountStatus(button.dataset.accountStatus);
});

document.querySelectorAll('.pagination').forEach((pagination) => pagination.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-page-kind]');
  if (!button || button.disabled) return;
  state.proxyPages[button.dataset.pageKind] = Number(button.dataset.page);
  await loadPool(button.dataset.pageKind);
}));

elements.registrationRows.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action="reconcile-batch"]');
  if (!button) return;
  try {
    await api(`/api/admin/registration-batches/${encodeURIComponent(button.dataset.id)}/reconcile`, { method: 'POST', body: '{}' });
    showNotice('提交结果已对账');
    await Promise.all([loadRegistrations(), loadProxies()]);
  } catch (error) { showNotice(error.message, true); }
});

function clearAccountReveal() {
  ++state.revealRequest;
  state.revealedAccountId = null;
  elements.accountReveal.hidden = true;
  elements.revealedEmail.textContent = '';
  ['revealedPassword', 'revealedTotpSecret', 'revealedTotp', 'revealedSession'].forEach((id) => { elements[id].value = ''; });
}
function closeAccountHistory() {
  ++state.historyRequest;
  state.historyAccountId = null;
  elements.accountHistory.hidden = true;
  elements.accountHistoryContent.textContent = '';
}
function receivingLabel(entry) {
  if (aliasCreationFailed(entry)) return '目标邮箱未创建成功，候选地址不可用于收信';
  if (entry.state === 'preparation_failed') return '无可用临时收码地址';
  return entry.mailbox_receiving === 'released' ? '临时收码邮箱已清理，后续收码不可用'
    : entry.mailbox_receiving === 'protected' ? '临时收码地址仍保护'
      : entry.mailbox_receiving === 'not_applicable' ? '无临时收码地址' : '临时收码地址待核对';
}
async function showAccountHistory(id) {
  clearAccountReveal();
  closeAccountHistory();
  const request = state.historyRequest;
  state.historyAccountId = id;
  elements.accountHistory.hidden = false;
  elements.accountHistoryContent.textContent = '正在读取换绑历史…';
  try {
    const body = await api(`/api/admin/qualified-accounts/${encodeURIComponent(id)}/rebind-history`);
    if (request !== state.historyRequest) return;
    elements.accountHistoryContent.innerHTML = `<p>${['rebinding', 'needs_review'].includes(accountStatus(body.account)) ? '上次确认邮箱' : '当前登录邮箱'}：${escapeHtml(body.account.email)} · ${escapeHtml(accountStatusLabel(body.account))}</p>`
      + `<p>${accountTrialHtml(body.account)}</p>${trialButtons(body.account)}`
      + (body.history.length ? body.history.map((entry) => `<article class="account-history-entry">
        <p>${escapeHtml(entry.original_email)} → 尝试目标邮箱：${escapeHtml(entry.target_email || entry.new_email || '尚未分配')}</p>
        <p>${escapeHtml(REBIND_LABELS[entry.state] || '待核对')} · ${escapeHtml(REBIND_STAGE_LABELS[entry.stage] || '进度待核对')} · ${entry.verified_at ? '已验证：' + escapeHtml(entry.verified_at) : '尚未验证（目标邮箱未确认为当前登录邮箱）'}</p>
        <p>${receivingLabel(entry)}${entry.cleanup_pending ? ' · 清理待重试' : ''}</p>
        ${rebindFailureLabel(entry) ? `<p class="error-text">${escapeHtml(rebindFailureLabel(entry))}</p>` : ''}
        <p>发起：${escapeHtml(entry.created_at || '—')} · 完成：${escapeHtml(entry.completed_at || '—')}</p>
      </article>`).join('') : '<p>暂无换绑尝试，仍使用原邮箱。</p>');
  } catch { if (request === state.historyRequest) elements.accountHistoryContent.textContent = '换绑历史读取失败，请重试。'; }
}
async function revealAccount(id, copyField) {
  clearAccountReveal();
  const request = state.revealRequest;
  try {
    const body = await api(`/api/admin/qualified-accounts/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: '{}' });
    if (request !== state.revealRequest || state.currentView !== 'accounts') return;
    const account = state.accounts.find((item) => item.id === id);
    if (!account || !credentialsReady(account)) return;
    elements.revealedEmail.textContent = body.account.email;
    elements.revealedPassword.value = body.account.password;
    elements.revealedTotpSecret.value = body.account.totpSecret;
    elements.revealedTotp.value = body.account.totp;
    elements.revealedSession.value = JSON.stringify(body.account.session || body.account.result || {}, null, 2);
    state.revealedAccountId = id;
    elements.accountReveal.hidden = false;
    if (copyField) {
      await navigator.clipboard.writeText(elements[copyField].value);
      showNotice('已核验并复制最新凭据');
    } else elements.accountReveal.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (request !== state.revealRequest) return;
    clearAccountReveal();
    showNotice(error.status === 409 && error.code === 'ACCOUNT_CREDENTIALS_UNCONFIRMED' ? '账号凭据尚未确认，请等待换绑完成或核对账号状态。' : '读取凭据失败，请刷新后重试。', true);
  }
}
elements.accountHistoryContent.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled || button.dataset.id !== state.historyAccountId) return;
  if (button.dataset.action === 'trial-check') checkAccountTrial(button.dataset.id);
  if (button.dataset.action === 'trial-latest') checkAccountTrial(button.dataset.id, true);
});

elements.accountRows.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  if (button.dataset.action === 'account-history') showAccountHistory(button.dataset.id);
  if (button.dataset.action === 'trial-check') checkAccountTrial(button.dataset.id);
  if (button.dataset.action === 'trial-latest') checkAccountTrial(button.dataset.id, true);
  if (button.dataset.action === 'reveal-account') { closeAccountHistory(); revealAccount(button.dataset.id); }
});

document.getElementById('closeRevealButton').addEventListener('click', clearAccountReveal);
document.getElementById('closeHistoryButton').addEventListener('click', closeAccountHistory);

elements.accountReveal.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]');
  if (!button || !state.revealedAccountId || elements.accountReveal.hidden) return;
  await revealAccount(state.revealedAccountId, button.dataset.copy);
});

async function openManagedAccount(id, history = false) {
  await switchView('accounts');
  elements.accountDateFilter.value = 'all';
  elements.accountCategoryFilter.value = 'all';
  elements.accountTrialFilter.value = 'all';
  elements.accountSearchInput.value = '';
  selectAccountStatus(id ? 'all' : 'rebound');
  const row = [...elements.accountRows.querySelectorAll('[data-account-id]')].find((item) => item.dataset.accountId === id);
  if (row) { row.tabIndex = -1; row.focus(); row.scrollIntoView({ block: 'center' }); }
  if (history && id) await showAccountHistory(id);
}
document.getElementById('viewReboundAccounts').addEventListener('click', () => openManagedAccount().catch((error) => showNotice(error.message, true)));
['rebindAccountRows', 'rebindJobRows'].forEach((id) => document.getElementById(id).addEventListener('click', (event) => {
  const button = event.target.closest('[data-managed-account]');
  if (button) openManagedAccount(button.dataset.managedAccount, button.dataset.history === 'true').catch((error) => showNotice(error.message, true));
}));
setInterval(() => {
  if (state.apiKey && state.currentView === 'accounts' && !document.hidden) loadAccounts(true).catch(() => {});
}, 5000);

const rebindState = { accounts: [], jobs: [], mailboxes: [], loading: false, busy: false, ready: false, pending: null, submission: '', recoveries: new Map() };
const rebindElement = (id) => document.getElementById(id);
const REBIND_LABELS = {
  queued: '等待执行', running: '执行中', preparing: '准备邮箱', creating_alias: '准备邮箱',
  rebinding: '换绑中', verifying: '核对中', cleanup_pending: '清理待重试',
  cleaning: '清理中', completed: '已完成', succeeded: '已完成', failed: '失败',
  preparation_failed: '准备邮箱失败（账号未换绑）',
  unknown: '待核对', submit_unknown: '待核对', rebind_unknown: '待核对', needs_review: '待核对',
};

const REBIND_STAGE_LABELS = {
  ...REBIND_LABELS,
  login_old: '登录原账号', eligibility: '核验换绑资格', begin: '发起换绑',
  alias_create_failed: '目标邮箱创建失败',
  verify: '验证邮箱', login_new: '重登验证', completed: '重登验证完成', reconciled: '结果已核对',
};

function aliasCreationFailed(entry) {
  return entry.stage === 'alias_create_failed' || entry.alias_state === 'create_failed' || entry.mailbox_receiving === 'create_failed'
    || (entry.state === 'preparation_failed' && Boolean(entry.target_email || entry.new_email));
}

function rebindFailureLabel(entry) {
  if (entry.state === 'cleanup_pending') return '换绑已成功，临时邮箱清理失败';
  if (entry.recovery_state === 'recovered' || ['completed', 'succeeded'].includes(entry.state)) return '';
  if (aliasCreationFailed(entry)) return '目标邮箱未创建成功；此地址仅为尝试候选';
  if (entry.code === 'MAILBOX_CREATION_BLOCKED' || entry.error_code === 'MAILBOX_CREATION_BLOCKED') return '主邮箱创建不可用，请手动选择其它主邮箱';
  if (entry.state === 'preparation_failed') return '邮箱准备未完成，原账号未换绑；可选择其它主邮箱手动发起新任务';
  const reason = recoveryErrorLabel(entry);
  if (reason && (entry.recovery_error_code || entry.recovery_error_category)) {
    return `原失败阶段：${REBIND_STAGE_LABELS[entry.failed_stage || entry.stage] || '阶段待确认'}；最近核对结果：${reason}`;
  }
  if (reason) return `${REBIND_STAGE_LABELS[entry.failed_stage] || '结果核对'}失败：${reason}`;
  if (entry.state === 'failed' || entry.last_error) return '本次尝试发生异常，请查看换绑历史核对';
  return '';
}

function recoveryErrorLabel(job) {
  const hasRecoveryError = Boolean(job.recovery_error_code || job.recovery_error_category);
  const codes = [job.reconcile_block_reason, hasRecoveryError ? job.recovery_error_code : job.last_error_code];
  const labels = {
    ACCOUNT_MISMATCH: '账号身份不匹配，请人工核查',
    SESSION_EMAIL_MISMATCH: '登录邮箱不匹配，请人工核查',
    RECOVERY_IDENTITY_MISSING: '缺少原账号身份，请人工核查',
    RECOVERY_IDENTITY_CONFLICT: '原账号身份记录冲突，请人工核查',
    RECOVERY_SNAPSHOT_CONFLICT: '账号归档冲突，请人工核查',
    NOT_ELIGIBLE: '换绑资格未通过',
    REBIND_NOT_ELIGIBLE: '换绑资格未通过',
    RECOVERY_NOT_ELIGIBLE: '当前任务不满足核对条件，请人工核查',
    NETWORK_TIMEOUT: '网络超时',
    WORKER_TIMEOUT: '核对执行超时',
    NETWORK_TLS: 'TLS 安全连接失败',
    NETWORK_PROXY: '代理连接失败',
    NETWORK_FAILED: '网络连接失败',
    REBIND_PROXY_POOL_EXHAUSTED: '换绑代理池暂无可用代理',
    RECOVERY_WORKER_UNAVAILABLE: '核对服务暂不可用',
    RECOVERY_INTERRUPTED: '核对过程已中断',
    LOGIN_FAILED: '目标邮箱登录未通过',
    LOGIN_INCOMPLETE: '目标邮箱登录未通过',
    MFA_FAILED: '双重验证未通过',
    MFA_INVALID_CODE: '双重验证未通过',
    VERIFY_FAILED: '邮箱验证码验证请求未确认',
  };
  for (const code of codes) if (Object.hasOwn(labels, code)) return labels[code];
  const category = hasRecoveryError ? job.recovery_error_category : job.error_category;
  const categories = { timeout: '网络超时', tls: 'TLS 安全连接失败', proxy: '代理连接失败', http: '远端服务响应异常', protocol: '远端响应格式异常', unknown: '原因尚未确认' };
  return Object.hasOwn(categories, category) ? categories[category] : hasRecoveryError ? '核对结果尚未确认' : '';
}

function recoveryEligible(job) {
  return job.state === 'needs_review' && [job.stage, job.failed_stage].some((stage) => ['verify', 'login_new', 'completed'].includes(stage));
}

function recoveryBlocked(job) {
  return job.can_reconcile === false || recoveryErrorLabel(job).includes('人工核查');
}

function recoveryHtml(job) {
  if (job.recovery_state === 'recovered' || (job.state === 'completed' && job.stage === 'reconciled')) return '<p>已核对恢复</p>';
  if (!recoveryEligible(job)) return '';
  const pending = rebindState.recoveries.get(job.id);
  const checking = job.recovery_state === 'checking';
  const attempts = Math.min(2, Math.max(1, Number(job.recovery_auto_attempts ?? job.recovery_attempts) || 1));
  const message = checking ? job.recovery_mode === 'manual' ? '正在手动核对' : `正在核对远端结果（第${attempts}/2次）`
    : recoveryBlocked(job) ? '请人工核查身份与归档记录，重复核对不会修复此问题'
      : job.recovery_state === 'exhausted' ? '自动核对未确认，可手动核对' : '远端结果待核对';
  return `<p>${message}</p><button type="button" data-rebind-reconcile="${escapeHtml(job.id)}"${checking || pending?.busy || recoveryBlocked(job) || !rebindState.ready ? ' disabled' : ''}>核对远端结果</button><p><small>只登录目标邮箱核验身份，不再次提交邮箱变更；与试用资格检测独立。</small></p>${pending?.message ? `<p class="error-text">${escapeHtml(pending.message)}</p>` : ''}`;
}

function rebindRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function updateRebindPoolSummary() {
  const pool = poolState.rebind;
  const stats = pool.stats;
  const text = pool.disabled ? '独立换绑池尚未启用，暂不可提交。'
    : !pool.loaded ? '独立换绑池读取失败或尚未加载，暂不可提交。'
      : '独立换绑池：可用 ' + (stats.available || 0) + ' · 冷却 ' + (stats.consumed || 0) + ' · 隔离 ' + (stats.quarantined || 0) + ((stats.available || 0) > 0 ? '。提交时自动分配代理。' : '。暂无可用代理，请导入或等待冷却结束。');
  rebindElement('rebindPoolSummary').textContent = text;
}
function rebindPoolReady() {
  return poolState.rebind.loaded && !poolState.rebind.disabled && poolState.rebind.stats?.available > 0;
}
function rebindAvailable(account) {
  const deadline = Date.parse(account.eligible_at ?? account.cooldown_until);
  return rebindState.ready && !account.completed_job_id && !account.active_job_id && (account.eligible ?? account.can_rebind) === true && Number.isFinite(deadline) && deadline <= Date.now();
}

function renderRebind() {
  const target = rebindState.mailboxes.find((mailbox) => mailbox.id === rebindElement('rebindMailbox').value && mailboxCanCreate(mailbox));
  const accountHtml = rebindState.accounts.map((account) => {
    const available = rebindAvailable(account);
    const activeJob = rebindState.jobs.find((job) => job.id === account.active_job_id);
    const status = account.completed_job_id ? '已换绑'
      : account.active_job_id ? (REBIND_LABELS[activeJob?.state] || '执行中 / 待核对')
        : available ? '可换绑' : '冷却中或暂不可换绑';
    return `<tr><td>${escapeHtml(account.email)}</td><td>${escapeHtml(account.eligible_at ?? account.cooldown_until ?? '待确认')}</td>
      <td>${escapeHtml(status)}</td><td><button type="button" data-rebind-account="${escapeHtml(account.id)}"${!available || !target || !rebindPoolReady() || rebindState.busy ? ' disabled' : ''}>手动换绑</button> <button type="button" data-managed-account="${escapeHtml(account.id)}">${account.completed_job_id || account.rebind_status === 'rebound' ? '查看已换绑账号' : '查看账号'}</button> <button type="button" data-managed-account="${escapeHtml(account.id)}" data-history="true">换绑历史</button></td></tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">暂无合格账号</td></tr>';
  const accountRows = rebindElement('rebindAccountRows');
  if (accountRows._renderedHtml !== accountHtml) { accountRows.innerHTML = accountHtml; accountRows._renderedHtml = accountHtml; }
  const jobHtml = rebindState.jobs.map((job) => `<tr>
    <td title="${escapeHtml(job.id)}">换绑尝试</td><td>${escapeHtml(job.original_email || rebindState.accounts.find((account) => account.id === job.account_id)?.original_email || rebindState.accounts.find((account) => account.id === job.account_id)?.email || '原邮箱待确认')} → 尝试目标邮箱：${escapeHtml(job.target_email || job.new_email || '目标待分配')}</td>
    <td>${escapeHtml(REBIND_LABELS[job.state] || '处理中 / 待核对')}${REBIND_STAGE_LABELS[job.stage] ? ` · ${escapeHtml(REBIND_STAGE_LABELS[job.stage])}` : ''}${rebindFailureLabel(job) ? `<br><span class="error-text">${escapeHtml(rebindFailureLabel(job))}</span>` : ''}${recoveryHtml(job)}</td>
    <td>${escapeHtml(job.updated_at || job.created_at)}</td>
    <td><button type="button" data-managed-account="${escapeHtml(job.account_id)}">查看对应账号</button> <button type="button" data-managed-account="${escapeHtml(job.account_id)}" data-history="true">换绑历史</button> ${job.state === 'cleanup_pending' ? `<button type="button" data-rebind-cleanup="${escapeHtml(job.id)}"${rebindState.busy || !rebindState.ready ? ' disabled' : ''}>重试清理</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无换绑任务</td></tr>';
  const jobRows = rebindElement('rebindJobRows');
  if (jobRows._renderedHtml !== jobHtml) { jobRows.innerHTML = jobHtml; jobRows._renderedHtml = jobHtml; }
}

async function loadRebind() {
  if (rebindState.loading || [...rebindState.recoveries.values()].some((pending) => pending.busy)) return;
  rebindState.loading = true;
  rebindElement('refreshRebindButton').disabled = true;
  rebindElement('refreshRebindButton').textContent = '刷新中…';
  try {
    const [accounts, jobs, mailboxes] = await Promise.all([
      api('/api/admin/rebind/accounts'), api('/api/admin/rebind/jobs'), api('/api/admin/mailboxes'), loadPool('rebind'),
    ]);
    rebindState.accounts = accounts.accounts;
    rebindState.jobs = await Promise.all(jobs.jobs.map(async (job) => {
      if (!recoveryEligible(job) || (job.recovery_state !== 'checking' && !rebindState.recoveries.has(job.id))) return job;
      try {
        const body = await api(`/api/admin/rebind/jobs/${encodeURIComponent(job.id)}/reconcile`);
        return body.job?.id === job.id ? body.job : job;
      } catch { return job; }
    }));
    rebindState.mailboxes = mailboxes.mailboxes;
    state.mailboxes = mailboxes.mailboxes;
    renderMailboxes();
    updateMailboxCreation();
    const select = rebindElement('rebindMailbox');
    const selected = select.value;
    const options = '<option value="">请选择主邮箱</option>' + mailboxes.mailboxes.map((mailbox) =>
      `<option value="${escapeHtml(mailbox.id)}"${mailboxCanCreate(mailbox) ? '' : ' disabled=""'}>${escapeHtml(mailbox.email)}${mailboxCanCreate(mailbox) ? '' : '（不可创建）'}</option>`).join('');
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = mailboxes.mailboxes.some((mailbox) => mailbox.id === selected && mailboxCanCreate(mailbox)) ? selected : '';
    if (selected && !select.value) rebindState.pending = null;
    rebindState.ready = true;
    if (rebindState.jobs.some((job) => job.recovery_state === 'recovered')) {
      await loadAccounts(true).catch(() => {});
    }
    rebindElement('rebindStatus').textContent = rebindState.submission || '只读刷新中；选择主邮箱后，手动发起单账号换绑。';
  } catch {
    rebindState.ready = false;
    rebindElement('rebindStatus').textContent = (rebindState.submission ? rebindState.submission + ' ' : '') + '换绑服务未配置或读取失败；保留已有任务，请刷新核对。';
  } finally {
    rebindState.loading = false;
    rebindElement('refreshRebindButton').disabled = false;
    rebindElement('refreshRebindButton').textContent = '刷新';
    renderRebind();
  }
}

rebindElement('configureRebindPool').addEventListener('click', () => {
  selectPool('rebind');
  switchView('proxies').catch(() => showNotice('代理池加载失败，请刷新。', true));
});
rebindElement('refreshRebindButton').addEventListener('click', loadRebind);
rebindElement('rebindJobRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-rebind-reconcile]');
  if (!button || button.disabled || !rebindState.ready || rebindState.loading) return;
  const job = rebindState.jobs.find((item) => item.id === button.dataset.rebindReconcile);
  if (!job || !recoveryEligible(job) || recoveryBlocked(job) || job.recovery_state === 'checking') return;
  const previous = rebindState.recoveries.get(job.id);
  if (previous?.busy) return;
  const pending = { key: previous?.key || rebindRequestId(), busy: true, message: '' };
  rebindState.recoveries.set(job.id, pending);
  renderRebind();
  try {
    const body = await api(`/api/admin/rebind/jobs/${encodeURIComponent(job.id)}/reconcile`, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: pending.key }),
    });
    if (body.job?.id !== job.id || !body.job.state || !body.recovery) throw new Error('Unconfirmed response');
    rebindState.jobs = rebindState.jobs.map((item) => item.id === job.id ? body.job : item);
    pending.key = null;
    pending.message = '核对请求已确认；再次核对须手动点击。';
    await loadAccounts(true).catch(() => { pending.message += '账号读取失败，请刷新核对。'; });
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 408) {
      pending.key = null;
      pending.message = (recoveryErrorLabel({ recovery_error_code: error.code }) || '核对请求未受理，请刷新核对当前状态') + '；再次核对须手动点击。';
    } else {
      pending.message = '核对请求结果未知，请先刷新；再次点击沿用请求标识。未再次提交邮箱变更。';
    }
  } finally {
    pending.busy = false;
    renderRebind();
  }
  if (!pending.key) await loadRebind();
});
rebindElement('rebindMailbox').addEventListener('change', renderRebind);
rebindElement('rebindAccountRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-rebind-account]');
  if (!button || button.disabled || rebindState.busy) return;
  const accountId = button.dataset.rebindAccount;
  const mailboxId = rebindElement('rebindMailbox').value;
  const account = rebindState.accounts.find((item) => item.id === accountId);
  if (!account || !rebindState.mailboxes.some((mailbox) => mailbox.id === mailboxId && mailboxCanCreate(mailbox)) || !rebindAvailable(account) || !rebindPoolReady()) return;
  if (!rebindState.pending || rebindState.pending.accountId !== accountId || rebindState.pending.mailboxId !== mailboxId) {
    rebindState.pending = { accountId, mailboxId, idempotencyKey: rebindRequestId() };
  }
  rebindState.busy = true;
  renderRebind();
  try {
    await api('/api/admin/rebind/jobs', { method: 'POST', body: JSON.stringify({ ...rebindState.pending }) });
    rebindState.pending = null;
    rebindState.ready = false;
    rebindState.submission = '任务已提交。';
    rebindElement('rebindStatus').textContent = rebindState.submission;
    await loadRebind();
  } catch (error) {
    if (error.code === 'MAILBOX_CREATION_BLOCKED') {
      const mailbox = rebindState.mailboxes.find((item) => item.id === mailboxId);
      if (mailbox) mailbox.creation_blocked = 1;
      const option = [...rebindElement('rebindMailbox').options].find((item) => item.value === mailboxId);
      if (option) { option.disabled = true; option.textContent = `${mailbox?.email || '主邮箱'}（不可创建）`; }
      rebindElement('rebindMailbox').value = '';
      rebindState.pending = null;
      renderMailboxes();
      updateMailboxCreation();
      rebindState.submission = error.message;
    } else {
      rebindState.ready = false;
      rebindState.submission = (error.status === 400 ? '参数或换绑资格不满足，请检查目标邮箱。' : error.status === 409 ? '代理池库存或账号状态冲突，请刷新核对。' : '提交未确认，请先刷新核对任务。') + '同一选择重试将沿用请求标识。';
    }
    rebindElement('rebindStatus').textContent = rebindState.submission;
  } finally {
    rebindState.busy = false;
    renderRebind();
  }
});
rebindElement('rebindJobRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-rebind-cleanup]');
  if (!button || rebindState.busy || !rebindState.ready) return;
  const job = rebindState.jobs.find((item) => item.id === button.dataset.rebindCleanup);
  if (!job || job.state !== 'cleanup_pending') return;
  rebindState.busy = true;
  renderRebind();
  try {
    await api(`/api/admin/rebind/jobs/${encodeURIComponent(job.id)}/retry-cleanup`, { method: 'POST', body: '{}' });
    await loadRebind();
  } catch {
    rebindElement('rebindStatus').textContent = '清理重试未确认，请刷新核对状态。';
  } finally {
    rebindState.busy = false;
    renderRebind();
  }
});
setInterval(() => {
  if (state.apiKey && state.currentView === 'rebind' && !rebindState.busy) loadRebind();
}, 5000);

setInterval(() => {
  if (!state.apiKey || state.currentView !== 'registration') return;
  Promise.all([loadRegistrations(), loadProxies()]).catch(() => {});
}, 5000);

if (state.apiKey) {
  elements.apiKey.value = state.apiKey;
  loadMailboxes().catch(() => { elements.connectionStatus.textContent = '密钥无效或服务不可用'; });
}
