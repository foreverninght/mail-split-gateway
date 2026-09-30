'use strict';

function rebindHistory(db, accountId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rebind_jobs'").get()) return [];
  return db.prepare(`
    SELECT jobs.id AS job_id, jobs.original_email, jobs.new_email AS target_email,
      jobs.state, jobs.stage, jobs.last_error, jobs.created_at,
      jobs.encrypted_result IS NOT NULL AS verified,
      (SELECT MIN(created_at) FROM rebind_events WHERE job_id = jobs.id AND event = 'result_persisted') AS verified_at,
      CASE WHEN jobs.state = 'completed' THEN
        (SELECT MAX(created_at) FROM rebind_events WHERE job_id = jobs.id AND event = 'completed')
      END AS completed_at,
      aliases.state AS alias_state,
      EXISTS(SELECT 1 FROM rebind_alias_claims WHERE job_id = jobs.id AND released_at IS NULL) AS claimed
    FROM rebind_jobs AS jobs LEFT JOIN aliases ON aliases.id = jobs.alias_id
    WHERE jobs.account_id = ? ORDER BY jobs.created_at DESC, jobs.rowid DESC
  `).all(accountId).map(({ verified, alias_state, claimed, ...row }) => ({
    ...row,
    verified_at: verified ? row.verified_at : null,
    verified: Boolean(verified),
    cleanup_pending: Boolean(verified && row.state !== 'completed'),
    mailbox_receiving: row.state === 'preparation_failed' && (!alias_state || alias_state === 'create_failed') ? 'not_applicable'
      : alias_state === 'deleted' ? 'released'
      : !alias_state || ['creating', 'create_failed', 'create_unknown', 'deleting', 'delete_unknown'].includes(alias_state) ? 'unknown'
        : claimed || (verified && row.state !== 'completed') ? 'protected' : 'unknown',
  }));
}

function rebindMetadata(account, history) {
  const latest = history[0];
  const verified = history.find((job) => job.verified);
  const status = !latest || latest.state === 'preparation_failed' ? 'original' : latest.verified ? 'rebound'
    : ['queued', 'running'].includes(latest.state) ? 'rebinding' : 'needs_review';
  return {
    rebind_status: status,
    original_email: history.at(-1)?.original_email || account.email,
    rebound_at: verified?.verified_at || null,
    last_rebind_job_id: latest?.job_id || null,
    credential_ready: status === 'original' || status === 'rebound',
    cleanup_pending: history.some((job) => job.cleanup_pending),
    current_mailbox_category: verified ? 'mail' : account.mailbox_category,
    mailbox_receiving: latest?.mailbox_receiving || 'not_applicable',
  };
}

module.exports = { rebindHistory, rebindMetadata };
