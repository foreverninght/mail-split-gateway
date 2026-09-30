'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function port() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
}

for (const enabled of [false, true]) {
  test('main boots with rebind enabled=' + enabled + ' without initiating account work', { timeout: 15000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-startup-'));
    const number = await port();
    const child = spawn(process.execPath, ['src/main.js'], {
      cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(number), HOST: '127.0.0.1',
        MAIL_GATEWAY_DATA_DIR: directory,
        MAIL_GATEWAY_MASTER_KEY: Buffer.alloc(32, 17).toString('base64'),
        MAIL_GATEWAY_ADMIN_KEY: 'fixture-admin',
        MAIL_GATEWAY_REBIND_ENABLED: String(enabled),
        MAIL_GATEWAY_REBIND_PYTHON: 'fixture-python-must-not-run',
        MAIL_GATEWAY_REGISTRATION_PROXY_REFRESH_MS: '900000',
      },
    });
    let diagnostic = '';
    child.stdout.on('data', (data) => { diagnostic += data.toString(); });
    child.stderr.on('data', (data) => { diagnostic += data.toString(); });
    const stopped = new Promise((resolve) => child.once('close', resolve));
    t.after(async () => {
      child.kill();
      await stopped;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    let response;
    const base = 'http://127.0.0.1:' + number;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) assert.fail(diagnostic);
      try {
        response = await fetch(base + '/health');
        if (response.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(response?.status, 200, diagnostic);
    const headers = { 'x-api-key': 'fixture-admin' };
    const original = await fetch(base + '/api/admin/mailboxes', { headers });
    assert.equal(original.status, 200);
    assert.deepEqual((await original.json()).mailboxes, []);
    const jobs = await fetch(base + '/api/admin/rebind/jobs', { headers });
    assert.equal(jobs.status, enabled ? 200 : 404);
    if (enabled) assert.deepEqual((await jobs.json()).jobs, []);
    const proxies = await fetch(base + '/api/admin/rebind/proxies', { headers });
    assert.equal(proxies.status, enabled ? 200 : 404);
    if (enabled) {
      const body = await proxies.json();
      assert.equal(body.cooldownMs, 900000);
      assert.deepEqual(body.proxies, []);
      assert.equal(body.stats.total, 0);
    }
    assert.equal(diagnostic.includes('fixture-python-must-not-run'), false);
  });
}
