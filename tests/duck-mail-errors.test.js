const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RETRY_HINT,
  addDuckMailRetryHint,
} = require('../shared/duck-mail-errors.js');

test('duck mail retry hint is appended once', () => {
  assert.equal(
    addDuckMailRetryHint('Timed out waiting for Duck address to appear.'),
    `Timed out waiting for Duck address to appear. ${RETRY_HINT}`
  );
});

test('duck mail retry hint is not duplicated', () => {
  assert.equal(
    addDuckMailRetryHint(`Timed out waiting for Duck address to appear. ${RETRY_HINT}`),
    `Timed out waiting for Duck address to appear. ${RETRY_HINT}`
  );
});
