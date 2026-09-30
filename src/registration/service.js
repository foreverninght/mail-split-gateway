'use strict';

const { generateTotp } = require('../security/totp');
const {
  BATCH_EVENTS,
  BATCH_STATES,
  TASK_EVENTS,
  TASK_STATES,
} = require('./state-machine');
const { SubmissionUnknownError, ControlProxyChallengeError } = require('../ifnexora/worker');
const {
  REGISTRATION_PROXIES_PER_MAILBOX,
  MIN_REGISTRATION_PROXIES_PER_MAILBOX,
  MAX_REGISTRATION_PROXIES_PER_MAILBOX,
} = require('./proxy-policy');

const IC_PICKUP_PREPARE_CONCURRENCY = 4;

function publicBatch(batch) {
  if (!batch) return null;
  const { encrypted_external_session: _session, ...safe } = batch;
  return safe;
}

function publicTask(task) {
  const { encrypted_web_api: _webApi, ...safe } = task;
  return safe;
}

function externalTaskIsRunning(task) {
  return !['completed', 'failed', 'skipped', 'cancelled'].includes(String(task.status || '').toLowerCase());
}

function externalTaskCanReveal(task) {
  return String(task?.status || '').toLowerCase() === 'completed'
    && task?.terminal_code === 'register_completed';
}

function revealedMfaEnabled(result) {
  const mfa = result?.mfa;
  if (!mfa || typeof mfa !== 'object') return false;
  const secret = mfa.secret || mfa.totp_secret || mfa.totpSecret || mfa.manual_entry_key;
  return mfa.status === 'enabled'
    && mfa.factor_type === 'totp'
    && mfa.active_factor_present === true
    && mfa.mutation_started === true
    && mfa.mutation_rejected === false
    && typeof secret === 'string'
    && secret.length > 0;
}

function revealedTrialEligible(result) {
  return result?.trial_qualification === 'observed_eligible';
}

function isMailboxCapacityConflict(error) {
  const detail = String(error?.message || error || '');
  return /HTTP\s*409\b|request-conflict|["']status["']\s*:\s*409\b/i.test(detail);
}

function isExternalBatchExpired(error) {
  return /\b(?:batch|tasks)\s+410\b|external_result_expired_http_410/i.test(String(error?.message || error));
}

class RegistrationService {
  constructor({ store, gatewayService, icMailboxService = null, externalWorker, secretBox, logger = console }) {
    this.store = store;
    this.gatewayService = gatewayService;
    this.icMailboxService = icMailboxService;
    this.externalWorker = externalWorker;
    this.secretBox = secretBox;
    this.logger = logger;
    this.queue = Promise.resolve();
    this.running = new Set();
  }

  createBatch(
    count,
    proxiesPerMailbox = REGISTRATION_PROXIES_PER_MAILBOX,
    { mailboxCategory = 'mail', mailboxProvider = '' } = {},
  ) {
    const requested = Number(count);
    const perMailbox = Number(proxiesPerMailbox);
    if (!Number.isInteger(perMailbox)
      || perMailbox < MIN_REGISTRATION_PROXIES_PER_MAILBOX
      || perMailbox > MAX_REGISTRATION_PROXIES_PER_MAILBOX) {
      throw new Error(`每个邮箱的注册代理数必须在 ${MIN_REGISTRATION_PROXIES_PER_MAILBOX}-${MAX_REGISTRATION_PROXIES_PER_MAILBOX} 之间`);
    }
    if (!['mail', 'ic'].includes(mailboxCategory)) throw new Error('邮箱大类必须是 mail 或 ic');
    const provider = String(mailboxProvider || '').trim().toLowerCase();
    if (mailboxCategory === 'ic') {
      if (!this.icMailboxService) throw new Error('IC 邮箱服务未配置');
      const available = this.icMailboxService.countAvailable(provider);
      if (available < requested) throw new Error(`可用 IC 邮箱不足：需要 ${requested} 个，当前 ${available} 个`);
    } else if (provider) {
      throw new Error('mail 分裂邮箱任务不能选择 IC 取件来源');
    }
    const controlStats = this.store.controlProxyStats();
    if (controlStats.available < 1 && controlStats.consumed < 1) throw new Error('没有可用的公共站请求代理');
    this.store.refreshCooledProxies();
    const proxyStats = this.store.proxyStats();
    const requiredProxies = requested * perMailbox;
    if ((proxyStats.available > 0 && proxyStats.available < requiredProxies)
      || (proxyStats.available < 1 && proxyStats.consumed < 1)) {
      throw new Error(`注册代理不足：需要 ${requiredProxies} 条`);
    }
    const batch = this.store.createBatch(count, {
      proxiesPerMailbox: perMailbox,
      mailboxCategory,
      mailboxProvider: provider,
    });
    this.enqueue(batch.id);
    return publicBatch(batch);
  }

  enqueue(batchId) {
    if (this.running.has(batchId)) return;
    this.running.add(batchId);
    this.queue = this.queue
      .catch(() => {})
      .then(() => this.runBatch(batchId))
      .catch((error) => this.logger.error(`registration batch ${batchId} stopped`, error))
      .finally(() => this.running.delete(batchId));
  }

  recoverAfterRestart() {
    const states = [BATCH_STATES.QUEUED, BATCH_STATES.CREATING_ALIASES,
      BATCH_STATES.ALLOCATING_PROXIES, BATCH_STATES.SUBMITTING,
      BATCH_STATES.ACCEPTED, BATCH_STATES.RUNNING];
    const resumable = this.store.db.prepare(`
      SELECT id FROM registration_batches
      WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at ASC, id ASC
    `).all(...states);
    for (const batch of resumable) this.enqueue(batch.id);
    return resumable.length;
  }

  async runBatch(batchId) {
    let batch = this.store.getBatch(batchId);
    if (!batch) throw new Error('registration batch not found');
    if ([BATCH_STATES.CREATING_ALIASES, BATCH_STATES.ALLOCATING_PROXIES].includes(batch.state)) {
      const detail = 'registration_interrupted_before_submission';
      this.store.setBatchError(batch.id, detail);
      this.store.markBatchProxies(batch.id, 'consumed', detail);
      this.store.markBatchControlProxy(batch.id, 'consumed', detail);
      await this.releaseAllMailboxes(batch.id, detail);
      if (this.store.listTasks(batch.id).every((task) => task.state === TASK_STATES.RELEASED)) {
        this.store.transitionBatch(batch.id, BATCH_EVENTS.FAIL, { lastError: detail });
      }
      return publicBatch(this.store.getBatch(batch.id));
    }
    if (batch.state === BATCH_STATES.SUBMITTING) {
      const detail = 'submission_outcome_unknown_after_restart';
      this.store.markBatchProxies(batch.id, 'quarantined', detail);
      this.store.markBatchControlProxy(batch.id, 'quarantined', detail);
      this.markIcBatchUsed(batch.id, detail);
      this.store.transitionBatch(batch.id, BATCH_EVENTS.SUBMIT_UNCERTAIN, { lastError: detail });
      return publicBatch(this.store.getBatch(batch.id));
    }
    if (batch.state === BATCH_STATES.QUEUED) {
      await this.prepareAndSubmit(batch);
      batch = this.store.getBatch(batchId);
    }
    if ([BATCH_STATES.ACCEPTED, BATCH_STATES.RUNNING].includes(batch.state)) {
      if (isExternalBatchExpired(batch.last_error)) {
        await this.expireExternalBatch(batch.id);
        return publicBatch(this.store.getBatch(batch.id));
      }
      await this.monitorAndCollect(batch);
    }
    return publicBatch(this.store.getBatch(batchId));
  }

  async createExactAliases(batch) {
    const mailboxes = this.gatewayService.listMailboxes().filter((mailbox) => !mailbox.creation_blocked);
    if (!mailboxes.length) throw new Error('没有可用主邮箱');
    const states = await Promise.all(mailboxes.map(async (mailbox) => {
      await this.gatewayService.ensureMailboxReady(mailbox.id);
      const synced = await this.gatewayService.syncMailbox(mailbox.id);
      return { mailbox, capacity: Math.max(0, 9 - synced.remoteAliases.length) };
    }));
    const existingTasks = this.store.listTasks(batch.id);
    let remaining = batch.requested_count - existingTasks.length;
    if (remaining < 0) throw new Error('批次已有分裂邮箱数量超过请求数量');

    const lanes = states
      .filter((state) => state.capacity > 0)
      .map((state) => ({ ...state, remainingCapacity: state.capacity }))
      .sort((left, right) => right.capacity - left.capacity
        || left.mailbox.email.localeCompare(right.mailbox.email));
    const created = [];
    let nextSlot = existingTasks.length + 1;

    while (remaining > 0) {
      const round = lanes.filter((lane) => lane.remainingCapacity > 0).slice(0, remaining);
      if (!round.length) throw new Error(`可用主邮箱容量不足：还缺少 ${remaining} 个分裂邮箱`);

      const outcomes = await Promise.all(round.map(async (lane) => ({
        lane,
        results: await this.gatewayService.createBatch(lane.mailbox.id, 1),
      })));
      for (const { lane, results } of outcomes) {
        lane.remainingCapacity -= 1;
        const result = results[0];
        if (!result?.ok) {
          if (isMailboxCapacityConflict(result?.error)) {
            lane.remainingCapacity = 0;
            continue;
          }
          throw new Error(`创建分裂邮箱失败：${result?.error || '没有返回创建结果'}`);
        }
        created.push(result);
        this.store.createTask({
          batchId: batch.id,
          slot: nextSlot,
          aliasId: result.alias.id,
          email: result.alias.email,
          webApi: result.webApi,
        });
        nextSlot += 1;
        remaining -= 1;
      }
    }
    return created;
  }

  async createExactIcMailboxes(batch) {
    const existingTasks = this.store.listTasks(batch.id);
    const remaining = batch.requested_count - existingTasks.length;
    if (remaining < 0) throw new Error('批次已有 IC 邮箱数量超过请求数量');
    if (!remaining) return [];
    const allocated = this.icMailboxService.allocateForRegistration(remaining, {
      pickupHostname: batch.mailbox_provider,
    });
    let nextSlot = existingTasks.length + 1;
    try {
      for (const result of allocated) {
        this.store.createTask({
          batchId: batch.id,
          slot: nextSlot,
          mailboxCategory: 'ic',
          icMailboxId: result.mailbox.id,
          email: result.mailbox.email,
          webApi: result.webApi,
        });
        nextSlot += 1;
      }
      for (let index = 0; index < allocated.length; index += IC_PICKUP_PREPARE_CONCURRENCY) {
        const group = allocated.slice(index, index + IC_PICKUP_PREPARE_CONCURRENCY);
        const outcomes = await Promise.allSettled(group.map((result) =>
          this.icMailboxService.prepareRegistrationPickup(result.mailbox.id)));
        const failed = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failed) throw failed.reason;
      }
      return allocated;
    } catch (error) {
      for (const result of allocated) {
        this.icMailboxService.markRegistrationUsed(
          result.mailbox.id,
          `registration_preparation_failed:${String(error.message || error).slice(0, 300)}`,
        );
      }
      throw error;
    }
  }

  async prepareBatchMailboxes(batch) {
    return batch.mailbox_category === 'ic'
      ? await this.createExactIcMailboxes(batch)
      : this.createExactAliases(batch);
  }

  markIcBatchRunning(batchId) {
    for (const task of this.store.listTasks(batchId)) {
      if (task.mailbox_category === 'ic') this.icMailboxService.markRegistrationRunning(task.ic_mailbox_id);
    }
  }

  markIcBatchUsed(batchId, detail = '') {
    for (const task of this.store.listTasks(batchId)) {
      if (task.mailbox_category === 'ic') this.icMailboxService.markRegistrationUsed(task.ic_mailbox_id, detail);
    }
  }

  async prepareAndSubmit(batch) {
    let proxiesReserved = false;
    let controlProxyReserved = false;
    let accepted = false;
    let preparedControlSession = null;
    const discardPreparedControlSession = async () => {
      if (!preparedControlSession) return;
      const session = preparedControlSession.controlSession;
      preparedControlSession = null;
      if (typeof this.externalWorker.discardControlSession === 'function') {
        await this.externalWorker.discardControlSession(session);
      } else if (session?.context?.close) {
        await session.context.close().catch(() => {});
      }
    };
    try {
      this.store.transitionBatch(batch.id, BATCH_EVENTS.START);
      await this.prepareBatchMailboxes(batch);
      this.store.transitionBatch(batch.id, BATCH_EVENTS.ALIASES_CREATED);
      let controlProxy = this.store.reserveControlProxy(batch.id);
      controlProxyReserved = true;
      if (typeof this.externalWorker.testControlProxy !== 'function') {
        throw new Error('公共站请求代理预检未配置');
      }
      const precheckCurrentProxy = async () => {
        while (true) {
          try {
            const precheck = await this.externalWorker.testControlProxy(controlProxy);
            if (!precheck?.controlSession) {
              throw new Error('公共站请求代理预检没有返回可复用的实时会话');
            }
            return precheck;
          } catch (error) {
            const detail = String(error?.message || error).slice(0, 1000);
            this.logger.warn(`公共站请求代理预检失败，轮换到本轮下一条代理：${detail}`);
            const replacement = this.store.rotateBatchControlProxy(batch.id, detail);
            if (!replacement) {
              throw new Error(`公共站请求代理预检失败，当前代理轮次已用完：${detail}`);
            }
            controlProxy = replacement;
          }
        }
      };
      preparedControlSession = await precheckCurrentProxy();
      const proxies = this.store.reserveProxies(
        batch.id,
        batch.requested_count * batch.proxies_per_mailbox,
      );
      proxiesReserved = true;
      this.store.transitionBatch(batch.id, BATCH_EVENTS.PROXIES_ALLOCATED);
      let submission;
      while (!submission) {
        const submissionSession = preparedControlSession;
        preparedControlSession = null;
        try {
          submission = await this.externalWorker.submit({
            mailboxes: this.store.taskSubmissionLines(batch.id),
        proxies,
        proxiesPerMailbox: batch.proxies_per_mailbox,
            controlProxy,
            storageState: submissionSession.storageState,
            controlSession: submissionSession.controlSession,
          });
        } catch (error) {
          if (!(error instanceof ControlProxyChallengeError)) throw error;
          const detail = String(error?.message || error).slice(0, 1000);
          this.logger.warn(`公共站验证资源连接失败，轮换到本轮下一条请求代理：${detail}`);
          const replacement = this.store.rotateBatchControlProxy(batch.id, detail);
          if (!replacement) {
            throw new Error(`公共站验证资源连接失败，当前代理轮次已用完：${detail}`);
          }
          controlProxy = replacement;
          preparedControlSession = await precheckCurrentProxy();
        }
      }
      accepted = true;
      this.markIcBatchRunning(batch.id);
      this.store.setExternalBatch(batch.id, {
        externalBatchId: submission.externalBatchId,
        encryptedSession: this.secretBox.seal(JSON.stringify(submission.storageState)),
      });
      this.store.markBatchProxies(batch.id, 'consumed');
      for (const task of this.store.listTasks(batch.id)) {
        this.store.transitionTask(task.id, TASK_EVENTS.SUBMIT);
      }
      this.store.transitionBatch(batch.id, BATCH_EVENTS.SUBMIT_ACCEPTED, {
        detail: `ifnexora batch ${submission.externalBatchId}`,
      });
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        if (error.storageState) {
          this.store.setExternalSession(batch.id, this.secretBox.seal(JSON.stringify(error.storageState)));
        }
        if (proxiesReserved) this.store.markBatchProxies(batch.id, 'quarantined', error.message);
        if (controlProxyReserved) this.store.markBatchControlProxy(batch.id, 'quarantined', error.message);
        this.markIcBatchUsed(batch.id, 'submission_outcome_unknown');
        this.store.transitionBatch(batch.id, BATCH_EVENTS.SUBMIT_UNCERTAIN, { lastError: error.message });
        return;
      }
      if (accepted) {
        this.markIcBatchUsed(batch.id, 'submission_accepted');
        if (proxiesReserved) this.store.markBatchProxies(batch.id, 'consumed', error.message);
        if (controlProxyReserved) this.store.markBatchControlProxy(batch.id, 'quarantined', error.message);
        const current = this.store.getBatch(batch.id);
        if (current?.state === BATCH_STATES.SUBMITTING) {
          this.store.transitionBatch(batch.id, BATCH_EVENTS.SUBMIT_UNCERTAIN, { lastError: String(error.message || error) });
        } else {
          this.store.setBatchError(batch.id, String(error.message || error));
        }
        return;
      }
      if (proxiesReserved && !accepted) {
        this.store.markBatchProxies(batch.id, 'consumed', String(error.message || error));
      }
      if (controlProxyReserved && !accepted) {
        const detail = error instanceof ControlProxyChallengeError ? error.message : String(error.message || error);
        this.store.markBatchControlProxy(batch.id, 'consumed', detail);
      }
      await this.releaseAllMailboxes(batch.id, String(error.message || error));
      const current = this.store.getBatch(batch.id);
      if (current && ![BATCH_STATES.FAILED, BATCH_STATES.SUBMIT_UNKNOWN].includes(current.state)) {
        this.store.transitionBatch(batch.id, BATCH_EVENTS.FAIL, { lastError: String(error.message || error) });
      }
      throw error;
    } finally {
      await discardPreparedControlSession();
    }
  }

  async monitorAndCollect(batch) {
    const storageState = batch.encrypted_external_session
      ? JSON.parse(this.secretBox.open(batch.encrypted_external_session)) : undefined;
    const controlProxy = this.requireBatchControlProxy(batch.id);
    try {
      const final = await this.externalWorker.poll({
        externalBatchId: batch.external_batch_id,
        storageState,
        controlProxy,
        onUpdate: async (snapshot) => {
          this.store.setExternalSession(batch.id, this.secretBox.seal(JSON.stringify(snapshot.storageState)));
          let currentBatch = this.store.getBatch(batch.id);
          if (currentBatch.state === BATCH_STATES.ACCEPTED) {
            currentBatch = this.store.transitionBatch(batch.id, BATCH_EVENTS.EXTERNAL_STARTED);
          }
          for (const externalTask of snapshot.tasks) {
            const local = this.store.listTasks(batch.id).find((task) => task.slot === Number(externalTask.slot));
            if (local?.state === TASK_STATES.SUBMITTED && externalTaskIsRunning(externalTask)) {
              this.store.transitionTask(local.id, TASK_EVENTS.START, { externalTaskId: externalTask.task_id });
            }
          }
          await this.collectFinishedTasks(
            batch.id,
            snapshot.tasks,
            snapshot.storageState,
            controlProxy,
            snapshot.reveal,
          );
          return this.store.listTasks(batch.id).every((task) => task.state === TASK_STATES.RELEASED);
        },
      });
      const currentBatch = this.store.getBatch(batch.id);
      if ([BATCH_STATES.ACCEPTED, BATCH_STATES.RUNNING].includes(currentBatch.state)) {
        this.store.transitionBatch(batch.id, BATCH_EVENTS.EXTERNAL_FINISHED);
      }
      await this.collectResults(batch.id, final.tasks, final.storageState);
    } catch (error) {
      this.store.setBatchError(batch.id, String(error.message || error));
      if (isExternalBatchExpired(error)) {
        await this.expireExternalBatch(batch.id);
        return;
      }
      throw error;
    }
  }

  async expireExternalBatch(batchId) {
    const expirationError = 'external_result_expired_http_410';
    this.store.setBatchError(batchId, expirationError);
    for (const current of this.store.listTasks(batchId)) {
      let task = current;
      if ([TASK_STATES.SUBMITTED, TASK_STATES.RUNNING, TASK_STATES.REGISTERED, TASK_STATES.QUALIFIED].includes(task.state)) {
        task = this.store.transitionTask(task.id, TASK_EVENTS.FAIL, {
          lastError: expirationError,
        });
      }
      if ([TASK_STATES.UNQUALIFIED, TASK_STATES.MFA_FAILED, TASK_STATES.FAILED, TASK_STATES.SAVED].includes(task.state)) {
        try {
          await this.finalizeTaskMailbox(batchId, task);
        } catch (error) {
          this.store.setTaskError(task.id, String(error.message || error));
        }
      }
    }
    this.store.setBatchError(batchId, expirationError);
    this.store.markBatchControlProxy(batchId, 'consumed', expirationError);
    if (!this.store.listTasks(batchId).every((task) => task.state === TASK_STATES.RELEASED)) return;
    let batch = this.store.getBatch(batchId);
    if (batch.qualified_count > 0) {
      if ([BATCH_STATES.ACCEPTED, BATCH_STATES.RUNNING].includes(batch.state)) {
        batch = this.store.transitionBatch(batchId, BATCH_EVENTS.EXTERNAL_FINISHED, {
          detail: expirationError,
          lastError: expirationError,
        });
      }
      if (batch.state === BATCH_STATES.COLLECTING_RESULTS) {
        this.store.transitionBatch(batchId, BATCH_EVENTS.COMPLETE_PARTIAL, {
          lastError: expirationError,
        });
      }
    } else if ([BATCH_STATES.ACCEPTED, BATCH_STATES.RUNNING, BATCH_STATES.COLLECTING_RESULTS].includes(batch.state)) {
      this.store.transitionBatch(batchId, BATCH_EVENTS.FAIL, { lastError: expirationError });
    }
  }

  async collectFinishedTasks(batchId, externalTasks, storageState, controlProxy, revealResult) {
    const localTasks = this.store.listTasks(batchId);
    const finished = externalTasks.filter((external) => !externalTaskIsRunning(external));
    for (const external of finished) {
      const local = localTasks.find((task) => Number(task.slot) === Number(external.slot));
      if (!local || local.state === TASK_STATES.RELEASED) continue;
      // Reveal requests share one external session and control proxy. Processing
      // them serially avoids concurrent browser launches stalling that session.
      await this.collectTaskResult(batchId, local, external, storageState, controlProxy, revealResult);
    }
  }

  async collectTaskResult(batchId, localTask, external, storageState, controlProxy, revealResult) {
    const batch = this.store.getBatch(batchId);
    let task = this.store.getTask(localTask.id);
    if (task.state === TASK_STATES.RELEASED) return task;
    try {
      if (!external) throw new Error(`ifnexora did not return slot ${task.slot}`);
      const summaryFields = {
        externalTaskId: external.task_id,
        mfaStatus: external.mfa_status,
        trialQualification: external.trial_qualification,
        terminalCode: external.terminal_code,
        lastError: external.failure_class || '',
      };
      if (externalTaskIsRunning(external)) return task;
      const canReveal = externalTaskCanReveal(external);
      if ([TASK_STATES.SUBMITTED, TASK_STATES.RUNNING].includes(task.state)) {
        task = canReveal
          ? this.store.transitionTask(task.id, TASK_EVENTS.REGISTER, summaryFields)
          : this.store.transitionTask(task.id, TASK_EVENTS.FAIL, summaryFields);
      }
      if ([TASK_STATES.REGISTERED, TASK_STATES.QUALIFIED].includes(task.state) && !canReveal) {
        task = this.store.transitionTask(task.id, TASK_EVENTS.FAIL, summaryFields);
      }
      if (canReveal && [TASK_STATES.REGISTERED, TASK_STATES.QUALIFIED].includes(task.state)) {
        const revealed = revealResult
          ? await revealResult(task.slot)
          : await this.externalWorker.reveal({
            externalBatchId: batch.external_batch_id,
            slot: task.slot,
            storageState,
            controlProxy,
          });
        const resultFields = {
          ...summaryFields,
          mfaStatus: revealed?.mfa?.status || 'missing',
          trialQualification: revealed?.trial_qualification || 'unknown',
        };
        if (task.state === TASK_STATES.REGISTERED) {
          if (!revealedMfaEnabled(revealed)) {
            task = this.store.transitionTask(task.id, TASK_EVENTS.MFA_FAIL, {
              ...resultFields,
              lastError: 'revealed_mfa_not_confirmed',
            });
          } else if (task.mailbox_category === 'mail' && !revealedTrialEligible(revealed)) {
            task = this.store.transitionTask(task.id, TASK_EVENTS.REJECT_QUALIFICATION, {
              ...resultFields,
              lastError: 'revealed_trial_not_eligible',
            });
          } else {
            task = this.store.transitionTask(task.id, TASK_EVENTS.QUALIFY, resultFields);
          }
        }
        if (task.state === TASK_STATES.QUALIFIED) {
          this.store.saveQualifiedAccount(task.id, revealed);
          task = this.store.transitionTask(task.id, TASK_EVENTS.SAVE, resultFields);
        }
      }
    } catch (error) {
      task = this.store.getTask(localTask.id);
      if ([TASK_STATES.REGISTERED, TASK_STATES.QUALIFIED].includes(task.state)) {
        this.store.setTaskError(task.id, String(error.message || error));
        return this.store.getTask(task.id);
      }
      if ([TASK_STATES.SUBMITTED, TASK_STATES.RUNNING].includes(task.state)) {
        task = this.store.transitionTask(task.id, TASK_EVENTS.FAIL, { lastError: String(error.message || error) });
      }
    }

    task = this.store.getTask(localTask.id);
    if (![TASK_STATES.UNQUALIFIED, TASK_STATES.MFA_FAILED, TASK_STATES.FAILED, TASK_STATES.SAVED].includes(task.state)) {
      return task;
    }
    return this.finalizeTaskMailbox(batchId, task);
  }

  async finalizeTaskMailbox(batchId, task) {
    if (task.mailbox_category === 'ic') {
      this.icMailboxService.markRegistrationUsed(task.ic_mailbox_id, `registration_batch:${batchId}`);
      if (this.store.getTask(task.id).state !== TASK_STATES.RELEASED) {
        return this.store.transitionTask(task.id, TASK_EVENTS.RELEASE);
      }
    } else {
      const released = await this.gatewayService.releaseAlias(task.alias_id, `registration_batch:${batchId}`);
      if (released?.state === 'deleted' && this.store.getTask(task.id).state !== TASK_STATES.RELEASED) {
        return this.store.transitionTask(task.id, TASK_EVENTS.RELEASE);
      }
      if (released?.state !== 'deleted') {
        this.store.setBatchError(batchId, `分裂邮箱 ${task.email} 删除失败：${released?.last_error || released?.state}`);
      }
    }
    return this.store.getTask(task.id);
  }

  async collectResults(batchId, externalTasks, storageState) {
    const batch = this.store.getBatch(batchId);
    const controlProxy = this.requireBatchControlProxy(batchId);
    for (const localTask of this.store.listTasks(batchId)) {
      const external = externalTasks.find((task) => Number(task.slot) === Number(localTask.slot));
      await this.collectTaskResult(batchId, localTask, external, storageState, controlProxy);
    }
    const tasks = this.store.listTasks(batchId);
    const qualified = this.store.listQualifiedAccounts().filter((account) => tasks.some((task) => task.id === account.task_id)).length;
    const allReleased = tasks.every((task) => task.state === TASK_STATES.RELEASED);
    this.store.transitionBatch(
      batchId,
      qualified === batch.requested_count && allReleased ? BATCH_EVENTS.COMPLETE : BATCH_EVENTS.COMPLETE_PARTIAL,
    );
    this.store.markBatchControlProxy(batchId, 'consumed');
  }

  async releaseAllMailboxes(batchId, failure = '') {
    for (const task of this.store.listTasks(batchId)) {
      if (task.mailbox_category === 'ic') {
        this.icMailboxService.markRegistrationUsed(task.ic_mailbox_id, `failed_registration_batch:${batchId}`);
        let current = this.store.getTask(task.id);
        if (current.state === TASK_STATES.ALIAS_READY) {
          current = this.store.transitionTask(task.id, TASK_EVENTS.FAIL, { lastError: failure });
        }
        if (current.state === TASK_STATES.FAILED) this.store.transitionTask(task.id, TASK_EVENTS.RELEASE);
        continue;
      }
      const released = await this.gatewayService.releaseAlias(task.alias_id, `failed_registration_batch:${batchId}`).catch(() => null);
      if (released?.state === 'deleted' && this.store.getTask(task.id).state !== TASK_STATES.RELEASED) {
        const current = this.store.getTask(task.id);
        if (current.state === TASK_STATES.ALIAS_READY) this.store.transitionTask(task.id, TASK_EVENTS.RELEASE);
      }
    }
  }

  listBatches() {
    return this.store.listBatches().map(publicBatch);
  }

  getBatch(id) {
    const batch = publicBatch(this.store.getBatch(id));
    if (!batch) return null;
    return { ...batch, tasks: this.store.listTasks(id).map(publicTask), events: this.store.listEvents(id) };
  }

  async reconcileUnknown(id) {
    const batch = this.store.getBatch(id);
    if (!batch) return null;
    if (batch.state !== BATCH_STATES.SUBMIT_UNKNOWN) throw new Error('batch does not require submission reconciliation');
    if (!batch.encrypted_external_session) throw new Error('this legacy unknown batch has no browser session to reconcile');
    const storageState = JSON.parse(this.secretBox.open(batch.encrypted_external_session));
    const active = await this.externalWorker.findActive({
      storageState,
      controlProxy: this.requireBatchControlProxy(id),
    });
    this.store.setExternalSession(id, this.secretBox.seal(JSON.stringify(active.storageState)));
    if (active.active && active.batchId) {
      this.store.setExternalBatch(id, {
        externalBatchId: active.batchId,
        encryptedSession: this.secretBox.seal(JSON.stringify(active.storageState)),
      });
      this.store.reconcileQuarantinedProxies(id, 'consumed');
      this.store.markBatchControlProxy(id, 'reserved');
      for (const task of this.store.listTasks(id)) {
        if (task.state === TASK_STATES.ALIAS_READY) this.store.transitionTask(task.id, TASK_EVENTS.SUBMIT);
      }
      const accepted = this.store.transitionBatch(id, BATCH_EVENTS.RECONCILE_ACCEPTED, {
        detail: `reconciled ifnexora batch ${active.batchId}`,
      });
      this.enqueue(id);
      return publicBatch(accepted);
    }
    if (active.available) {
      this.store.reconcileQuarantinedProxies(id, 'available');
      this.store.markBatchControlProxy(id, 'consumed');
      await this.releaseAllMailboxes(id);
      return publicBatch(this.store.transitionBatch(id, BATCH_EVENTS.FAIL, {
        lastError: 'reconciliation confirmed that no external batch was created',
      }));
    }
    throw new Error(`ifnexora cannot reconcile submission: ${active.reason || 'unknown state'}`);
  }

  importProxies(value, options) {
    return this.store.importProxies(value, options);
  }

  importControlProxies(value, options) {
    return this.store.importControlProxies(value, options);
  }

  requireBatchControlProxy(batchId) {
    const endpoint = this.store.batchControlProxyEndpoint(batchId);
    if (!endpoint) throw new Error('注册批次没有绑定公共站请求代理');
    return endpoint;
  }

  proxyOverview(options) {
    this.store.refreshCooledProxies();
    return { stats: this.store.proxyStats(), cooldownMs: this.store.registrationProxyRefreshMs, ...this.store.listProxies(options) };
  }

  controlProxyOverview(options) {
    return { stats: this.store.controlProxyStats(), cooldownMs: 0, ...this.store.listControlProxies(options) };
  }

  listQualifiedAccounts() {
    return this.store.listQualifiedAccounts();
  }

  getQualifiedAccountRebindHistory(id) {
    return this.store.getQualifiedAccountRebindHistory(id);
  }

  revealQualifiedAccount(id) {
    const metadata = this.store.getQualifiedAccount(id);
    if (!metadata) return null;
    if (metadata.credential_ready === false) {
      throw Object.assign(new Error('account credentials require confirmation'), {
        statusCode: 409, code: 'ACCOUNT_CREDENTIALS_UNCONFIRMED',
      });
    }
    const account = this.store.getQualifiedAccount(id, { reveal: true });
    if (!account) return null;
    return { ...account, totp: generateTotp(account.totpSecret) };
  }

  async close() {
    await this.externalWorker.close();
    await this.queue.catch(() => {});
  }
}

module.exports = {
  RegistrationService,
  isMailboxCapacityConflict,
  isExternalBatchExpired,
  revealedMfaEnabled,
  revealedTrialEligible,
  externalTaskIsRunning,
  publicBatch,
  publicTask,
};
