'use strict';
const LOGIN_PHASES = new Set(['input', 'bootstrap', 'authorize_continue', 'password_verify',
  'mfa_factor', 'mfa_issue', 'mfa_verify', 'reauthorize', 'redirect', 'callback', 'session']);
const LOGIN_REASONS = new Set(['LOGIN_INPUT_MISSING', 'LOGIN_STEP_FAILED', 'LOGIN_HTTP_ERROR',
  'LOGIN_CREDENTIALS_REJECTED', 'LOGIN_RESPONSE_INVALID', 'LOGIN_PASSWORD_PAGE_MISSING',
  'LOGIN_MFA_FACTOR_MISSING', 'LOGIN_MFA_CODE_REJECTED', 'LOGIN_MFA_REJECTED',
  'LOGIN_CONTINUE_MISSING', 'LOGIN_CALLBACK_INVALID', 'LOGIN_CALLBACK_REUSED', 'LOGIN_SESSION_MISSING']);
function trialDiagnostic(value) {
  return LOGIN_PHASES.has(value?.phase) && LOGIN_REASONS.has(value?.reason)
    ? { phase: value.phase, reason: value.reason } : {};
}
function sessionToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[^\x21-\x7e]/.test(value);
}
function trialSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const session = Object.fromEntries(['accessToken', 'sessionToken']
    .filter((key) => Object.hasOwn(value, key) && sessionToken(value[key]))
    .map((key) => [key, value[key]]));
  return Object.keys(session).length ? session : undefined;
}
function trialResult(r, email, accountId) {
  if (!r || typeof r.email !== 'string' || r.email.trim().toLowerCase() !== email.trim().toLowerCase()
    || typeof r.accountId !== 'string' || r.accountId !== accountId || r.mfaVerified !== true
    || !['eligible', 'ineligible', 'error'].includes(r.status) || r.campaignId !== 'plus-1-month-free'
    || !(r.amountMinor === null || Number.isSafeInteger(r.amountMinor))
    || !(r.currency === null || (typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency)))
    || !(r.billingCountry === null || (typeof r.billingCountry === 'string' && /^[A-Z]{2}$/.test(r.billingCountry)))
    || r.errorCode !== (r.status === 'error' ? 'TRIAL_PROBE_FAILED' : null)
    || (r.session !== undefined && (!r.session || typeof r.session !== 'object' || Array.isArray(r.session)
      || ['accessToken', 'sessionToken'].some((key) => !Object.hasOwn(r.session, key)
        || !sessionToken(r.session[key]))))) {
    throw Object.assign(new Error('INVALID_RESULT'), { code: 'INVALID_RESULT' });
  }
  return { ...Object.fromEntries(['email', 'accountId', 'mfaVerified', 'status', 'campaignId', 'amountMinor',
    'currency', 'billingCountry', 'errorCode'].map((key) => [key, r[key]])),
    ...(r.session === undefined ? {} : { session: trialSession(r.session) }) };
}
module.exports = { trialResult, trialSession, trialDiagnostic };
