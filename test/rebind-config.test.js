'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/main');

test('rebind remains opt-in and leaves legacy defaults unchanged', () => {
  const config = loadConfig({});
  assert.equal(config.rebindEnabled, false);
  assert.equal(config.port, 3110);
  assert.equal(config.rebindPythonPath, 'python3');
  assert.equal(config.rebindTimeoutMs, 300000);
  assert.equal(Object.hasOwn(config, 'rebindProxy'), false);
  assert.equal(config.registrationProxyRefreshMs, 1800000);
});

test('rebind runtime settings are explicit without changing registration proxy policy', () => {
  const config = loadConfig({
    MAIL_GATEWAY_REBIND_ENABLED: 'true',
    MAIL_GATEWAY_REBIND_PYTHON: '/opt/rebind/venv/bin/python',
    MAIL_GATEWAY_REBIND_TIMEOUT_MS: '180000',
    MAIL_GATEWAY_REBIND_PROXY: 'http://fixture.test:8080',
  });
  assert.equal(config.rebindEnabled, true);
  assert.equal(config.rebindPythonPath, '/opt/rebind/venv/bin/python');
  assert.equal(config.rebindTimeoutMs, 180000);
  assert.equal(Object.hasOwn(config, 'rebindProxy'), false);
  assert.equal(loadConfig({ MAIL_GATEWAY_REGISTRATION_PROXY_REFRESH_MS: '900000' }).registrationProxyRefreshMs, 900000);
  assert.equal(config.registrationProxyRefreshMs, 1800000);
  assert.equal(loadConfig({ MAIL_GATEWAY_REBIND_ENABLED: 'false' }).rebindEnabled, false);
});
