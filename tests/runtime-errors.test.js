const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMailPollRecoveryPlan,
  isMessageChannelClosedError,
  isReceivingEndMissingError,
} = require('../shared/runtime-errors.js');

test('detects closed message-channel errors from async listeners', () => {
  assert.equal(
    isMessageChannelClosedError('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'),
    true
  );
  assert.equal(
    isMessageChannelClosedError('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.'),
    true
  );
});

test('ignores unrelated runtime errors', () => {
  assert.equal(isMessageChannelClosedError('No matching verification email found after 60s'), false);
});

test('detects missing receiving-end errors from disconnected content scripts', () => {
  assert.equal(
    isReceivingEndMissingError('Could not establish connection. Receiving end does not exist.'),
    true
  );
});

test('ignores unrelated errors for missing receiving-end detector', () => {
  assert.equal(isReceivingEndMissingError('No matching verification email found after 60s'), false);
});

test('mail poll recovery plan soft-retries before reloading after navigation disconnects', () => {
  assert.deepEqual(
    buildMailPollRecoveryPlan('Could not establish connection. Receiving end does not exist.'),
    ['soft-retry', 'reload']
  );
  assert.deepEqual(
    buildMailPollRecoveryPlan('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'),
    ['soft-retry', 'reload']
  );
});

test('mail poll recovery plan ignores unrelated mailbox errors', () => {
  assert.deepEqual(buildMailPollRecoveryPlan('No matching verification email found after 60s'), []);
});
