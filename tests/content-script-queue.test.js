const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getContentScriptQueueTimeout,
  buildContentScriptResponseTimeoutError,
  getContentScriptResponseTimeout,
} = require('../shared/content-script-queue.js');

test('content script response timeout stays disabled for long-running TMailor mailbox flows', () => {
  assert.equal(getContentScriptResponseTimeout('tmailor-mail', 'FETCH_TMAILOR_EMAIL'), 0);
  assert.equal(getContentScriptResponseTimeout('tmailor-mail', 'POLL_EMAIL'), 0);
});

test('content script response timeout defaults to 60s for signup-page commands', () => {
  assert.equal(getContentScriptResponseTimeout('signup-page', 'EXECUTE_STEP'), 60000);
  assert.equal(
    buildContentScriptResponseTimeoutError('signup-page', 60000),
    'Content script on signup-page did not respond in 60s. Try refreshing the tab and retry.'
  );
});

test('signup-page and vps-panel queue timeouts are longer than the default to absorb slow reinjection', () => {
  assert.equal(getContentScriptQueueTimeout('signup-page', 'EXECUTE_STEP'), 30000);
  assert.equal(getContentScriptQueueTimeout('vps-panel', 'FETCH_OAUTH_URL'), 30000);
});
