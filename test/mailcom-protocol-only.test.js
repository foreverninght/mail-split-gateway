'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('split-mailbox modules cannot depend on browser automation', () => {
  const projectRoot = path.join(__dirname, '..');
  const mailcomDir = path.join(projectRoot, 'src', 'mailcom');
  const files = [
    ...fs.readdirSync(mailcomDir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join(mailcomDir, name)),
    path.join(projectRoot, 'src', 'services', 'gateway-service.js'),
    path.join(projectRoot, 'src', 'services', 'mailbox-poller.js'),
  ];
  const forbidden = [
    /require\(['"]playwright['"]\)/,
    /from\s+['"]playwright['"]/,
    /chromium\.launch\(/,
    /\.newContext\(/,
    /page\.(?:goto|click|fill|locator)\(/,
  ];

  for (const filename of files) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path.relative(projectRoot, filename)} must remain protocol-only`);
    }
  }
});
