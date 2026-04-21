const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMailPollRecoveryPlan,
  isMessageChannelClosedError,
  isReceivingEndMissingError,
  shouldRetryStep1WithFreshVpsPanel,
  shouldRetryStep3WithPlatformLoginRefresh,
  shouldRetryStep3WithFreshOauth,
  shouldRetryStep5WithProfileRefresh,
  shouldRetryStep6WithFreshOauth,
  shouldRetryStep7Through9FromStep6,
  shouldRetryStep8WithFreshOauth,
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

test('step 3 oauth timeout errors trigger a fresh oauth retry plan', () => {
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 blocked: OpenAI auth page timed out before credentials could be submitted. Reopen the platform login page and retry with the same email and password.'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 blocked: auth issue page offered a "retry" recovery action. Reopen the platform login page and retry with the same email and password.'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 failed: Could not find email input field on signup page. URL: https://auth.openai.com/sign-in-with-chatgpt/codex/consent'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 failed: Could not find email input field on signup page. URL: https://platform.openai.com/signup'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 failed: Could not find email input field on signup page. URL: https://auth.openai.com/create-account/password'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 failed: Could not find passwordless-login button or password input after submitting email. URL: https://auth.openai.com/u/login/password'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 blocked: password was filled but the signup page never advanced past the credential form.'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 blocked: auth issue page offered a "return home" recovery link. Reopen the platform login page and retry with the same email and password.'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 failed: Auth fatal error page detected before the password input appeared.'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 failed: Auth fatal error page detected after step 3 password submit.'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Content script on signup-page did not respond in 15s. Try refreshing the tab and retry.'),
    true
  );
  assert.equal(
    shouldRetryStep3WithFreshOauth('Step 3 failed: Could not find email input field on signup page.'),
    false
  );
});

test('step 3 platform-login stall errors trigger the dedicated platform refresh retry plan', () => {
  assert.equal(
    shouldRetryStep3WithPlatformLoginRefresh('Step 3 failed: Could not find passwordless-login button or password input after submitting email. URL: https://platform.openai.com/login'),
    true
  );
  assert.equal(
    shouldRetryStep3WithPlatformLoginRefresh('Step 3 failed: Could not find email input field on signup page. URL: https://platform.openai.com/login'),
    true
  );
  assert.equal(
    shouldRetryStep3WithPlatformLoginRefresh('Step 3 failed: current auth page is not on the signup flow yet. URL: https://platform.openai.com/login'),
    true
  );
  assert.equal(
    shouldRetryStep3WithPlatformLoginRefresh('Step 3 failed: Could not find passwordless-login button or password input after submitting email. URL: https://auth.openai.com/u/login/password'),
    false
  );
});

test('step 3 platform-login retry plan also accepts blocked messages and query-string platform login urls', () => {
  assert.equal(
    shouldRetryStep3WithPlatformLoginRefresh('Step 3 blocked: current auth page is not on the signup flow yet. URL: https://platform.openai.com/login?redirect=%2Fhome'),
    true
  );
  assert.equal(
    shouldRetryStep3WithPlatformLoginRefresh('Step 3 blocked: Could not find email input field on signup page. URL: https://platform.openai.com/login#entry'),
    true
  );
});

test('step 1 panel load errors trigger a fresh vps-panel retry plan', () => {
  assert.equal(
    shouldRetryStep1WithFreshVpsPanel('Step 1 failed: Found Codex OAuth card but no login button inside it. URL: https://panel.example.com/oauth'),
    true
  );
  assert.equal(
    shouldRetryStep1WithFreshVpsPanel('Step 1 failed: Auth URL did not appear after clicking login. Check if VPS panel is logged in and Codex service is running. URL: https://panel.example.com/oauth'),
    true
  );
  assert.equal(
    shouldRetryStep1WithFreshVpsPanel('Step 1 failed: VPS panel returned 502 Bad Gateway.'),
    false
  );
});

test('step 6 auth-page stalls trigger a fresh oauth retry plan', () => {
  assert.equal(
    shouldRetryStep6WithFreshOauth('Step 6 recoverable: OpenAI auth page timed out before login could complete. Refresh the VPS OAuth link and retry with the same email and password.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Step 6 recoverable: auth issue page offered a "retry" recovery action. Refresh the VPS OAuth link and retry with the same email and password.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Step 6 failed: Could not find email input on login page. URL: https://auth.openai.com/sign-in-with-chatgpt/codex/consent'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Could not find email input on login page. URL: https://auth.openai.com/sign-in-with-chatgpt/codex/consent'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Step 6 failed: Login did not advance after password submit. Still on the password page.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Login did not advance after password submit. Still on the password page.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Step 6 recoverable: auth issue page offered a "return home" recovery link. Refresh the VPS OAuth link and retry with the same email and password.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Auth issue page offered a "return home" recovery link. Refresh the VPS OAuth link and retry with the same email and password.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Step 6 failed: Auth fatal error page detected after login submit.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Auth fatal error page detected after login submit.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Step 6 failed: Incorrect email address or password.'),
    false
  );
});

test('step 6 refresh retry plan treats vps-panel disconnects and queue timeouts as recoverable', () => {
  assert.equal(
    shouldRetryStep6WithFreshOauth('Content script on vps-panel did not respond in 15s. Try refreshing the tab and retry.'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('Frame with ID 0 is showing error page'),
    true
  );
  assert.equal(
    shouldRetryStep6WithFreshOauth('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'),
    true
  );
});

test('step 6 refresh retry plan treats an empty oauth url from vps-panel as recoverable', () => {
  assert.equal(
    shouldRetryStep6WithFreshOauth('VPS panel did not return a usable OAuth URL.'),
    true
  );
});

test('step 5 stalled profile-page communication errors trigger a refresh-and-refill retry plan', () => {
  assert.equal(
    shouldRetryStep5WithProfileRefresh('Content script on signup-page did not respond in 15s. Try refreshing the tab and retry.'),
    true
  );
  assert.equal(
    shouldRetryStep5WithProfileRefresh('Content script on signup-page did not respond in 60s. Try refreshing the tab and retry.'),
    true
  );
  assert.equal(
    shouldRetryStep5WithProfileRefresh('Could not establish connection. Receiving end does not exist.'),
    true
  );
  assert.equal(
    shouldRetryStep5WithProfileRefresh('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'),
    true
  );
  assert.equal(
    shouldRetryStep5WithProfileRefresh('Step 5 blocked: email domain is unsupported on the auth page.'),
    false
  );
});

test('step 8 unexpected auth redirect errors trigger a fresh oauth retry plan', () => {
  assert.equal(
    shouldRetryStep8WithFreshOauth('Step 8 recoverable: auth flow landed on an unexpected page before localhost redirect (unexpected_auth_redirect). Refresh the VPS OAuth link and retry with the same email and password.'),
    true
  );
  assert.equal(
    shouldRetryStep8WithFreshOauth('Step 8 failed: Could not find "继续" button on OAuth consent page.'),
    false
  );
});

test('steps 7-9 generally retry once from step 6 after recoverable failures', () => {
  assert.equal(
    shouldRetryStep7Through9FromStep6(7, 'Step 7 failed: Could not find verification code input. URL: https://auth.openai.com/email-verification'),
    true
  );
  assert.equal(
    shouldRetryStep7Through9FromStep6(8, 'Step 8 failed: Localhost redirect not captured after 120s. Step 8 click may have been blocked.'),
    true
  );
  assert.equal(
    shouldRetryStep7Through9FromStep6(9, 'Step 9 failed: Could not establish connection to VPS panel after filling callback URL.'),
    true
  );
  assert.equal(
    shouldRetryStep7Through9FromStep6(9, 'Step 9 failed: Could not find "提交回调 URL" button. URL: https://panel.example.com/management.html#/'),
    true
  );
});

test('steps 7-9 do not retry from step 6 for hard blockers or unrelated steps', () => {
  assert.equal(
    shouldRetryStep7Through9FromStep6(7, '第 7 步被拦截：当前 auth 页面要求手机号验证，请切换节点后重试。'),
    false
  );
  assert.equal(
    shouldRetryStep7Through9FromStep6(7, 'Step 7 failed: Verification form stayed visible after submit attempts. URL: https://auth.openai.com/add-phone'),
    false
  );
  assert.equal(
    shouldRetryStep7Through9FromStep6(8, 'Step 8 blocked: auth page still requires phone verification.'),
    false
  );
  assert.equal(
    shouldRetryStep7Through9FromStep6(9, 'VPS URL not set. Please enter VPS URL in the side panel.'),
    false
  );
  assert.equal(
    shouldRetryStep7Through9FromStep6(6, 'Step 6 failed: Login did not advance after password submit. Still on the password page.'),
    false
  );
});
