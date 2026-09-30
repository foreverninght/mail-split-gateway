'use strict';
function trialMetadata(db, account) {
  let row;
  let confirmed;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_trial_checks'").get()) {
    const email = String(account.email || '').trim().toLowerCase();
    row = db.prepare('SELECT * FROM account_trial_checks WHERE account_id = ? ORDER BY rowid DESC LIMIT 1').get(account.id);
    if (String(row?.checked_email || '').trim().toLowerCase() !== email) row = null;
    confirmed = db.prepare("SELECT * FROM account_trial_checks WHERE account_id = ? AND lower(trim(checked_email)) = ? AND state = 'completed' AND status IN ('eligible', 'ineligible') ORDER BY rowid DESC LIMIT 1").get(account.id, email);
  }
  return {
    post_rebind_trial_status: !row ? 'not_checked' : ['queued', 'running'].includes(row.state) ? 'checking' : row.status || 'error',
    post_rebind_trial_checked_at: row?.checked_at || null,
    post_rebind_trial_check_id: row?.id || null,
    post_rebind_trial_stage: row?.stage || null,
    post_rebind_trial_error_code: row?.error_code || null,
    post_rebind_trial_error_phase: row?.error_phase || null,
    post_rebind_trial_error_reason: row?.error_reason || null,
    post_rebind_trial_error_category: row?.error_category || null,
    post_rebind_trial_http_status: row?.http_status ?? null,
    post_rebind_trial_curl_code: row?.curl_code ?? null,
    post_rebind_trial_attempts: row?.attempt_count ?? null,
    post_rebind_trial_last_confirmed_status: confirmed?.status || null,
    post_rebind_trial_last_confirmed_email: confirmed?.checked_email || null,
    post_rebind_trial_last_confirmed_checked_at: confirmed?.checked_at || null,
    post_rebind_trial_amount_minor: row?.amount_minor ?? null,
    post_rebind_trial_currency: row?.currency || null,
  };
}
module.exports = { trialMetadata };
