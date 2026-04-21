const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('background copy reflects the email-first auto-run flow while keeping the platform login step', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /const OFFICIAL_SIGNUP_ENTRY_URL = 'https:\/\/platform\.openai\.com\/login';/i
  );
  assert.match(
    backgroundSource,
    /阶段 1：刷新 .*，然后打开 Platform 登录页/i
  );
  assert.match(
    backgroundSource,
    /阶段 2：打开 Platform 登录页/i
  );
  assert.match(
    backgroundSource,
    /第 2 步：正在打开 Platform 登录页/i
  );
  assert.match(
    backgroundSource,
    /reuseActiveTabOnCreate:\s*true/i
  );
  assert.match(
    backgroundSource,
    /正在填写邮箱 .*，点击 Continue，并请求一次性验证码/i
  );
  assert.doesNotMatch(
    backgroundSource,
    /Phase 1: Open platform login page/i
  );
});

test('shared and high-frequency warn-ok-error logs prefer Chinese user-facing copy', () => {
  const utilsSource = readProjectFile(path.join('content', 'utils.js'));
  const backgroundSource = readProjectFile('background.js');
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));
  const tmailorSource = readProjectFile(path.join('content', 'tmailor-mail.js'));
  const vpsSource = readProjectFile(path.join('content', 'vps-panel.js'));

  assert.match(utilsSource, /第 \$\{step\} 步执行完成/);
  assert.match(utilsSource, /第 \$\{step\} 步失败：/);

  assert.match(backgroundSource, /手动续跑失败：/);
  assert.match(backgroundSource, /手动续跑已完成（第 9 步）/);
  assert.match(backgroundSource, /自动运行已经在进行中/);
  assert.match(backgroundSource, /无法继续：当前没有邮箱地址/);
  assert.match(backgroundSource, /TMailor API 邮箱已就绪/);
  assert.match(backgroundSource, /TMailor 邮箱页请求后台重载，准备重开后重试一次/);

  assert.match(signupSource, /Platform 登录入口误入已登录会话，先执行登出/);
  assert.match(signupSource, /头像菜单首次点击未展开，改用底层指针点击重试/);
  assert.match(signupSource, /第 5 步：验证完成后一直没有出现姓名输入框，视为可跳过资料填写并继续登录流程/);

  assert.match(tmailorSource, /Cloudflare 验证已自动通过/);
  assert.match(tmailorSource, /临时邮箱已就绪/);
  assert.match(vpsSource, /VPS 返回 502，改为重新打开已配置的 OAuth 页面/);
  assert.match(vpsSource, /认证成功/);
});

test('background tracks when the current target mailbox was last acquired for side panel stats timers', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(backgroundSource, /lastTargetEmailAcquiredAt:\s*null,/);
  assert.match(
    backgroundSource,
    /async function setEmailState\(email,\s*options = \{\}\) \{[\s\S]*lastTargetEmailAcquiredAt:\s*nextTargetEmailAcquiredAt/,
  );
  assert.match(
    backgroundSource,
    /broadcastDataUpdate\(\{\s*email,\s*lastTargetEmailAcquiredAt:\s*nextTargetEmailAcquiredAt\s*\}\);/,
  );
});

test('side panel workflow labels describe the platform login and continue flow', () => {
  const sidepanelHtml = readProjectFile(path.join('sidepanel', 'sidepanel.html'));

  assert.match(sidepanelHtml, />Open Platform Login</);
  assert.match(sidepanelHtml, />Fill Email \/ Continue</);
  assert.doesNotMatch(sidepanelHtml, />Open Signup</);
  assert.doesNotMatch(sidepanelHtml, />Fill Email \/ Password</);
});

test('step 2 ignores navigation-driven signup page disconnects and keeps waiting for completion', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function executeStep2\(state,\s*options\s*=\s*\{\}\) \{[\s\S]*try \{[\s\S]*await sendToContentScript\('signup-page', \{[\s\S]*\}\);[\s\S]*\} catch \(err\) \{[\s\S]*isMessageChannelClosedError\([\s\S]*isReceivingEndMissingError\([\s\S]*waiting for completion signal[\s\S]*throw err;[\s\S]*\}[\s\S]*\}/i
  );
});

test('step 2 has an auth-page-ready fallback when the completion signal is lost during navigation', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function waitForStep2CompletionSignalOrAuthPageReady\(\) \{/i
  );
  assert.match(
    backgroundSource,
    /第 2 步：signup 页面在返回结果前已发生跳转，继续等待完成信号[\s\S]*await waitForStep2CompletionSignalOrAuthPageReady\(\);/i
  );
  assert.match(
    backgroundSource,
    /hasVisibleCredentialInput[\s\S]*notifyStepComplete\(2,\s*\{[\s\S]*recoveredAfterNavigation:\s*true[\s\S]*\}\)/i
  );
});

test('step 2 navigation fallback replays the signup step when the page is still stuck on the platform signing bridge', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /第 2 步：导航打断后页面仍卡在 Platform signing bridge，重注入后重放第 2 步一次[\s\S]*await executeStep2\(currentState,\s*\{\s*replayedAfterNavigationInterrupt:\s*true\s*\}\);/i
  );
});

test('step 2 emits heartbeat logs while waiting for the platform signing bridge to settle', () => {
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));

  assert.match(
    signupSource,
    /Platform entry is still waiting on the signing-in bridge after/i
  );
});

test('auth content scripts register step 3 and step 6 through dedicated handler files instead of the mixed router switch', () => {
  const manifestSource = readProjectFile('manifest.json');
  const backgroundSource = readProjectFile('background.js');
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));

  assert.match(manifestSource, /openai-auth-step3-handler\.js/i);
  assert.match(manifestSource, /openai-auth-step6-handler\.js/i);
  assert.match(backgroundSource, /openai-auth-step2-handler\.js/i);
  assert.match(backgroundSource, /openai-auth-step3-handler\.js/i);
  assert.match(backgroundSource, /openai-auth-step5-handler\.js/i);
  assert.match(backgroundSource, /openai-auth-step6-handler\.js/i);
  assert.match(backgroundSource, /openai-auth-step8-handler\.js/i);
  assert.match(backgroundSource, /openai-auth-actions-handler\.js/i);
  assert.match(signupSource, /getRegisteredStepMetadata/i);
  assert.doesNotMatch(
    signupSource,
    /switch \(message\.step\) \{[\s\S]*case 3: return await step3_fillEmailPassword\(message\.payload\);[\s\S]*case 6: return await step6_login\(message\.payload\);/i
  );
});

test('step 3 and step 6 implementations live in separate flow files while signup-page stays as the shared auth shell', () => {
  const manifestSource = readProjectFile('manifest.json');
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));
  const step3FlowSource = readProjectFile(path.join('content', 'openai-auth-step3-flow.js'));
  const step6FlowSource = readProjectFile(path.join('content', 'openai-auth-step6-flow.js'));

  assert.match(manifestSource, /openai-auth-step3-flow\.js/i);
  assert.match(manifestSource, /openai-auth-step6-flow\.js/i);
  assert.doesNotMatch(signupSource, /async function step3_fillEmailPassword\(/i);
  assert.doesNotMatch(signupSource, /async function step6_login\(/i);
  assert.match(step3FlowSource, /async function step3_fillEmailPassword\(/i);
  assert.match(step6FlowSource, /async function step6_login\(/i);
});

test('readme describes the platform signup-entry flow separately from the oauth login flow', () => {
  const readmeSource = readProjectFile('README.md');

  assert.match(readmeSource, /Platform Signup Entry Flow|平台注册入口流/i);
  assert.match(readmeSource, /OAuth Login Flow|OAuth 登录流/i);
  assert.match(readmeSource, /Step 2[\s\S]*Step 3[\s\S]*Step 4[\s\S]*Step 5/i);
  assert.match(readmeSource, /Step 6[\s\S]*Step 7[\s\S]*Step 8[\s\S]*Step 9/i);
});

test('platform chat logout recovery forces the flow back to the platform login entry', () => {
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));

  assert.match(
    signupSource,
    /async function logoutFromPlatformChatSessionIfNeeded\(\) \{[\s\S]*await clickPlatformLogoutAction\(logoutLabel\);[\s\S]*await waitForPlatformLogoutRedirect\(\);[\s\S]*await ensurePlatformLoginEntryAfterLogout\(\);[\s\S]*已登出当前 Platform 会话，并返回登录页/i
  );
  assert.match(
    signupSource,
    /async function ensurePlatformLoginEntryAfterLogout\([^)]*\) \{[\s\S]*location\.href = PLATFORM_LOGIN_ENTRY_URL;[\s\S]*Timed out waiting for the platform login entry after logout/i
  );
  assert.doesNotMatch(
    signupSource,
    /if \/\(auth\\\.openai\\\.com\\\/log-in\|platform\\\.openai\\\.com\\\/login\)\/i\.test\(location\.href\)\s*\{\s*return true;\s*\}/i
  );
});

test('step 2 treats platform home as a logout-capable logged-in shell instead of waiting forever on the signing bridge', () => {
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));

  assert.match(
    signupSource,
    /function isPlatformLoggedInShellPage\(\) \{[\s\S]*isPlatformChatSessionPage\(\)[\s\S]*isPlatformHomeRedirectPage\(\)/i
  );
  assert.match(
    signupSource,
    /async function logoutFromPlatformChatSessionIfNeeded\(\) \{[\s\S]*if \(!isPlatformLoggedInShellPage\(\)\) \{[\s\S]*return false;[\s\S]*\}/i
  );
});

test('tmailor success accounting falls back to the active lease email before reading the domain stats key', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /function getTmailorOutcomeEmail\(state\)[\s\S]*getActiveTmailorEmailLease\(state\)[\s\S]*leaseEmail[\s\S]*state\.email/i
  );
  assert.match(
    backgroundSource,
    /const outcomeEmail = getTmailorOutcomeEmail\(state\);[\s\S]*const domain = extractEmailDomain\(outcomeEmail\);/i
  );
});

test('step 2 retries up to 10 times by reopening the platform login page after non-navigation errors', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /const recoveredStep2PlatformLoginRetryCount = Math\.max\(0,\s*Number\.parseInt\(String\(recoveryState\?\.step2PlatformLoginRetryCount \?\? 0\),\s*10\) \|\| 0\);[\s\S]*if \(step === 2 && recoveredStep2PlatformLoginRetryCount < 10[\s\S]*await recoverStep2PlatformLogin\(err,\s*\{[\s\S]*maxAttempts:\s*10[\s\S]*\}\);[\s\S]*step2PlatformLoginRetryCount:\s*recoveredStep2PlatformLoginRetryCount \+ 1/i
  );
  assert.match(
    backgroundSource,
    /async function recoverStep2PlatformLogin\(error,\s*options = \{\}\) \{[\s\S]*正在重开 Platform 登录页并重试（\$\{attempt\}\/\$\{maxAttempts\}）[\s\S]*reuseOrCreateTab\('signup-page',\s*OFFICIAL_SIGNUP_ENTRY_URL,\s*\{[\s\S]*reloadIfSameUrl:\s*true[\s\S]*\}\);/i
  );
});

test('step 2 background fallback only completes once the platform login entry or signup flow is ready', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /function isStep2RecoveredAuthPageReady\(pageState = \{\}\) \{/i
  );
  assert.match(
    backgroundSource,
    /if \(hasVisibleVerificationInput \|\| hasVisibleProfileFormInput\) \{\s*return true;\s*\}/i
  );
  assert.match(
    backgroundSource,
    /if \(!hasVisibleCredentialInput\) \{\s*return false;\s*\}/i
  );
  assert.match(
    backgroundSource,
    /if \(\/platform\\\.openai\\\.com\\\/login\/i\.test\(url\)\) \{\s*return true;\s*\}/i
  );
  assert.match(
    backgroundSource,
    /if \(\/\(\?:auth\|accounts\)\\\.openai\\\.com\\\/\(\?:u\\\/signup\\\/\|create-account\)\/i\.test\(url\)\) \{\s*return true;\s*\}/i
  );
  assert.doesNotMatch(
    backgroundSource,
    /if \(\/\(\?:auth\|accounts\)\\\.openai\\\.com\\\/log-?in\/i\.test\(url\)\) \{\s*return true;\s*\}/i
  );
  assert.match(
    backgroundSource,
    /const authPageReady = isStep2RecoveredAuthPageReady\(pageState\);/i
  );
});

test('step 2 navigation fallback reopens the platform login entry when recovery lands on auth log-in', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /function isStep2UnexpectedAuthLoginPageState\(pageState = \{\}\) \{/i
  );
  assert.match(
    backgroundSource,
    /return \/\(\?:auth\|accounts\)\\\.openai\\\.com\\\/log-\?in\(\?:\[\/\?#\]\|\$\)\/i\.test\(url\)[\s\S]*&& !pageState\?\.hasVisibleVerificationInput[\s\S]*&& !pageState\?\.hasVisibleProfileFormInput/i
  );
  assert.match(
    backgroundSource,
    /第 2 步：导航打断后页面回退到了 auth\.openai\.com\/log-in，准备重开 Platform 登录入口再试一次/i
  );
  assert.match(
    backgroundSource,
    /await executeStep2\(currentState,\s*\{\s*replayedAfterNavigationInterrupt:\s*true\s*\}\);/i
  );
});

test('step 2 throws a recoverable error when the signup auth page never becomes ready again after navigation interruption', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function waitForStep2CompletionSignalOrAuthPageReady\(\) \{[\s\S]*throw new Error\('Step 2 blocked: signup auth page did not become ready again after navigation interruption\.'\);/i
  );
});

test('mail tab readiness revives a TMailor browser error page immediately instead of waiting forever for content readiness', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /function isBrowserErrorPageTab\(tab = \{\}\) \{/i
  );
  assert.match(
    backgroundSource,
    /无法访问此网站|this site can'?t be reached|ERR_QUIC_PROTOCOL_ERROR|ERR_/i
  );
  assert.match(
    backgroundSource,
    /async function ensureMailTabReady\(mail,\s*options = \{\}\) \{[\s\S]*if \(mail\.source === 'tmailor-mail' && isBrowserErrorPageTab\(currentTab\)\) \{[\s\S]*Mailbox tab is stuck on a browser error page[\s\S]*await reviveMailTab\(mail\);/i
  );
});

test('verification mail polling re-checks the auth page for phone verification blockers before retrying the inbox', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function executeVerificationMailStep\(step,\s*state,\s*options\)[\s\S]*if \(!noMailFound\) \{[\s\S]*throw err;[\s\S]*\}[\s\S]*const pageState = await getSignupAuthPageState\(\);[\s\S]*const blockerMessage = getVerificationMailStepPollingBlocker\(step,\s*pageState\);[\s\S]*if \(blockerMessage\) \{[\s\S]*throw new Error\(blockerMessage\);[\s\S]*\}[\s\S]*if \(!resendTriggered && inboxCheck >= resendAfterAttempts\)/i
  );
});

test('verification mail polling checks auth blockers during each inbox poll attempt and stops for phone or unsupported-email pages', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /function getVerificationMailStepPollingBlocker\(step,\s*pageState = \{\}\) \{[\s\S]*pageState\?\.requiresPhoneVerification[\s\S]*Step \$\{step\} blocked: auth page requires phone verification before the verification email step\.[\s\S]*pageState\?\.hasUnsupportedEmail[\s\S]*Step \$\{step\} blocked: email domain is unsupported on the auth page\.[\s\S]*return ''[\s\S]*async function assertVerificationMailStepNotBlockedDuringPolling\(step\) \{[\s\S]*const pageState = await getSignupAuthPageState\(\);[\s\S]*const blockerMessage = getVerificationMailStepPollingBlocker\(step,\s*pageState\);[\s\S]*if \(blockerMessage\) \{[\s\S]*throw new Error\(blockerMessage\);/i
  );
  assert.match(
    backgroundSource,
    /pollTmailorVerificationCode\(\{[\s\S]*onPollStart:\s*async \(event\) => \{[\s\S]*await assertVerificationMailStepNotBlockedDuringPolling\(step\);[\s\S]*\}[\s\S]*onPollAttempt:\s*async \(event\) => \{[\s\S]*await assertVerificationMailStepNotBlockedDuringPolling\(step\);/i
  );
});

test('step 1 retries once by reopening the vps panel after recoverable panel-load errors', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /if \(step === 1 && !recoveredStep1VpsPanel && shouldRetryStep1WithFreshVpsPanel\(err\)\)[\s\S]*await recoverStep1VpsPanel\(err\);[\s\S]*return await executeStepAndWait\(step,\s*delayAfter,\s*\{\s*step1VpsPanel:\s*true\s*\}\);/i
  );
  assert.match(
    backgroundSource,
    /async function recoverStep1VpsPanel\(error\) \{[\s\S]*正在重开 VPS 面板并重试一次[\s\S]*reuseOrCreateTab\('vps-panel',\s*state\.vpsUrl,\s*\{[\s\S]*reloadIfSameUrl:\s*true[\s\S]*\}\);/i
  );
});

test('step 4 replays step 2 and step 3 once with the current TMailor mailbox before failing the run', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /if \(step === 4 && !recoveredStep4CredentialStall && shouldRetryStep4WithCurrentTmailorLease\(err\)\)[\s\S]*await replayStep2AndStep3WithCurrentTmailorLease\(err\);[\s\S]*return await executeStepAndWait\(step,\s*delayAfter,\s*\{[\s\S]*step4CredentialStall:\s*true[\s\S]*\}\);/i
  );
  assert.match(
    backgroundSource,
    /async function replayStep2AndStep3WithCurrentTmailorLease\(error\) \{[\s\S]*getActiveTmailorEmailLease\([\s\S]*setEmailState\(lease\.email\)[\s\S]*executeStepAndWait\(2,\s*2000[\s\S]*executeStepAndWait\(3,\s*getStepDelayAfter\(3\)/i
  );
  assert.match(
    backgroundSource,
    /function shouldRetryStep4WithCurrentTmailorLease\(error\) \{[\s\S]*signup page never advanced past the credential form/i
  );
});

test('step 4 first retries the current verification page with the same code before falling back to a reload', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function submitVerificationCodeWithRecovery\(step,\s*code,\s*options\s*=\s*\{\}\) \{[\s\S]*tryDirectVerificationCodeFillOnCurrentSignupPage[\s\S]*recoverSignupPageFillCodeError[\s\S]*reloadIfSameUrl:\s*true/i
  );
});

test('signup auth page state distinguishes an unreachable tab from a real non-ready page', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function getSignupAuthPageState\(\) \{[\s\S]*if \(pageState\) \{[\s\S]*isReachable:\s*true[\s\S]*\.\.\.pageState[\s\S]*\}/i
  );
  assert.match(
    backgroundSource,
    /catch \{[\s\S]*const fallbackState = await getSignupPageFallbackAuthState\(\);[\s\S]*if \(fallbackState\) \{[\s\S]*return fallbackState;[\s\S]*\}[\s\S]*isReachable:\s*false[\s\S]*\}/i
  );
});

test('step 3 keeps waiting for completion when the signup auth page enters bfcache during navigation', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function executeStep3\(state\) \{[\s\S]*try \{[\s\S]*await sendToContentScript\('signup-page', \{[\s\S]*step:\s*3[\s\S]*\}\);[\s\S]*\} catch \(err\) \{[\s\S]*isMessageChannelClosedError\([\s\S]*isReceivingEndMissingError\([\s\S]*waitForStep3CompletionSignalOrRecoveredAuthState\(\);[\s\S]*throw err;[\s\S]*\}[\s\S]*\}/i
  );
  assert.match(
    backgroundSource,
    /async function waitForStep3CompletionSignalOrRecoveredAuthState\(\) \{/i
  );
  assert.match(
    backgroundSource,
    /if \(isStep3RecoveredAuthPageReady\(pageState\)\) \{[\s\S]*const payload = \{ recoveredAfterNavigation:\s*true \};[\s\S]*notifyStepComplete\(3,\s*payload\)/i
  );
  assert.match(
    backgroundSource,
    /pageState\?\.hasVisibleCredentialInput[\s\S]*isExistingAccountLoginPasswordPageUrl\(pageState\?\.url\)[\s\S]*!\s*pageState\?\.hasVisibleSignupRegistrationChoice[\s\S]*const payload = \{[\s\S]*recoveredAfterNavigation:\s*true,[\s\S]*existingAccountLogin:\s*true[\s\S]*\};[\s\S]*导航打断后已进入已有账号登录密码页[\s\S]*notifyStepComplete\(3,\s*payload\)/i
  );
});

test('step 3 background fallback only accepts stable post-credential signup pages', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /function isStep3RecoveredAuthPageReady\(pageState = \{\}\) \{/i
  );
  assert.match(
    backgroundSource,
    /if \(pageState\?\.hasReadyVerificationPage \|\| pageState\?\.hasReadyProfilePage\) \{\s*return true;\s*\}/i
  );
  assert.match(
    backgroundSource,
    /if \(pageState\?\.hasVisibleCredentialInput\) \{\s*return false;\s*\}/i
  );
  assert.match(
    backgroundSource,
    /if \(pageState\?\.hasVisibleVerificationInput \|\| pageState\?\.hasVisibleProfileFormInput\) \{\s*return true;\s*\}/i
  );
  assert.match(
    backgroundSource,
    /return Boolean\(\s*\(isCanonicalEmailVerificationUrl\(pageState\?\.url\)\s*&&\s*pageState\?\.hasReadyVerificationPage\)\s*\|\|\s*\(isCanonicalAboutYouUrl\(pageState\?\.url\)\s*&&\s*pageState\?\.hasReadyProfilePage\)\s*\);/i
  );
  assert.doesNotMatch(
    backgroundSource,
    /const advancedPastCredentialForm = Boolean\([\s\S]*pageState\?\.url[\s\S]*!\s*pageState\?\.hasVisibleCredentialInput/i
  );
});

test('step 4 direct verification retry first checks whether the auth page already advanced to about-you before warning about a stalled verification page', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function tryDirectVerificationCodeFillOnCurrentSignupPage\(step,\s*code\) \{[\s\S]*const pageState = await getSignupAuthPageState\(\)\.catch\(\(\) => null\);[\s\S]*step === 4[\s\S]*pageState\?\.hasReadyProfilePage[\s\S]*pageState\?\.hasVisibleProfileFormInput[\s\S]*isCanonicalAboutYouUrl\(pageState\?\.url\)[\s\S]*isStableStep5SuccessUrl\(pageState\?\.url\)[\s\S]*accepted:\s*true[\s\S]*reason:\s*'profile-page-already-ready'/i
  );
  assert.match(
    backgroundSource,
    /已经到达 about-you\/资料页，跳过验证码页补填重试/i
  );
});

test('step 4 background recovery polls for about-you or welcome-create before waiting for the content-script code-fill response to time out', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function waitForStep4VerificationAdvanceSignal\(step,\s*options = \{\}\) \{[\s\S]*timeoutMs\s*=\s*15000[\s\S]*intervalMs\s*=\s*1000/i
  );
  assert.match(
    backgroundSource,
    /hasReadyProfilePage[\s\S]*hasVisibleProfileFormInput[\s\S]*isCanonicalAboutYouUrl\(pageState\?\.url\)[\s\S]*isStableStep5SuccessUrl\(pageState\?\.url\)/i
  );
  assert.match(
    backgroundSource,
    /检测到验证码提交流程后页面已进入资料页\/创建成功页，提前按第 4 步成功处理/i
  );
  assert.match(
    backgroundSource,
    /const step4AdvanceSignalPromise = step === 4[\s\S]*waitForStep4VerificationAdvanceSignal\(step(?:,\s*\{)?/i
  );
  assert.match(
    backgroundSource,
    /const step4RecoveryRacers = \[submitResponsePromise\][\s\S]*step4RecoveryRacers\.push\(step4AdvanceSignalPromise\)[\s\S]*Promise\.race\(step4RecoveryRacers\)/i
  );
});

test('step 4 starts a direct same-page fill recovery when the verification code is already available but the signup page stays silent for a few seconds', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function waitForStep4SlowCodeFillRecovery\(step,\s*code,\s*options = \{\}\) \{[\s\S]*delayMs\s*=\s*4000/i
  );
  assert.match(
    backgroundSource,
    /hasReadyVerificationPage[\s\S]*hasVisibleVerificationInput[\s\S]*isCanonicalEmailVerificationUrl\(pageState\?\.url\)/i
  );
  assert.match(
    backgroundSource,
    /验证码已拿到，但 auth 验证页暂时没有开始响应，先直接在当前页补填一次验证码/i
  );
  assert.match(
    backgroundSource,
    /const step4SlowFillRecoveryPromise = step === 4[\s\S]*waitForStep4SlowCodeFillRecovery\(step,\s*code/i
  );
  assert.match(
    backgroundSource,
    /step4RecoveryRacers\.push\(step4SlowFillRecoveryPromise\)/i
  );
  assert.match(
    backgroundSource,
    /finalSubmitRaceResult\?\.kind === 'step4-slow-fill-recovery'[\s\S]*result\?\.accepted \|\| finalSubmitRaceResult\?\.result\?\.retryInbox/i
  );
});

test('step 4 recovery monitoring prefers canonical auth-url fallback signals before waiting on the slower signup-page probe', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function getSignupAuthPageStateForRecoveryMonitor\(\) \{[\s\S]*const fallbackState = await getSignupPageFallbackAuthState\(\)\.catch\(\(\) => null\);[\s\S]*if \(fallbackState\) \{[\s\S]*return fallbackState;[\s\S]*\}[\s\S]*return await getSignupAuthPageState\(\)\.catch\(\(\) => null\);/i
  );
  assert.match(
    backgroundSource,
    /async function waitForStep4VerificationAdvanceSignal\(step,\s*options = \{\}\) \{[\s\S]*getSignupAuthPageStateForRecoveryMonitor\(\)/i
  );
  assert.match(
    backgroundSource,
    /async function waitForStep4SlowCodeFillRecovery\(step,\s*code,\s*options = \{\}\) \{[\s\S]*getSignupAuthPageStateForRecoveryMonitor\(\)/i
  );
});

test('verification mail steps complete themselves from background recovery when the content-script completion signal is missing', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function executeVerificationMailStep\(step,\s*state,\s*options\) \{[\s\S]*const submitResult = await submitVerificationCode\(step,\s*result\.code\);[\s\S]*if \(submitResult\?\.accepted\) \{[\s\S]*const currentState = await getState\(\);[\s\S]*currentState\?\.stepStatuses\?\.\[step\]\s*!==\s*'completed'[\s\S]*backgroundVerifiedCompletion:\s*true[\s\S]*await setStepStatus\(step,\s*'completed'\);[\s\S]*await addLog\(`第 \$\{step\} 步已完成`, 'ok'\);[\s\S]*await handleStepData\(step,\s*backgroundCompletionPayload\);[\s\S]*notifyStepComplete\(step,\s*backgroundCompletionPayload\)/i
  );
});

test('step 3 keeps retrying the current email and password when the auth page repeatedly times out before credential submission completes', () => {
  const backgroundSource = readProjectFile('background.js');
  const runtimeErrorsSource = readProjectFile(path.join('shared', 'runtime-errors.js'));

  assert.match(
    runtimeErrorsSource,
    /function shouldRetryStep3WithFreshOauth[\s\S]*openai auth page timed out before credentials could be submitted[\s\S]*password was filled but the signup page never advanced past the credential form/i
  );
  assert.match(
    backgroundSource,
    /const recoveredStep3TimeoutRetryCount = Math\.max\(0,\s*Number\.parseInt\(String\(recoveryState\?\.step3TimeoutRetryCount \?\? 0\),\s*10\) \|\| 0\);/i
  );
  assert.match(
    backgroundSource,
    /if \(step === 3 && shouldRetryStep3WithFreshOauth\(err\)\) \{[\s\S]*recoverStep3PlatformLogin\(err,\s*\{[\s\S]*attempt:\s*recoveredStep3TimeoutRetryCount \+ 1[\s\S]*reason:\s*'oauth-timeout'[\s\S]*\}\);[\s\S]*step3TimeoutRetryCount:\s*recoveredStep3TimeoutRetryCount \+ 1/i
  );
});

test('step 3 retries platform-login stalls up to three times before failing the run', () => {
  const backgroundSource = readProjectFile('background.js');
  const runtimeErrorsSource = readProjectFile(path.join('shared', 'runtime-errors.js'));

  assert.match(
    runtimeErrorsSource,
    /function shouldRetryStep3WithPlatformLoginRefresh\(error\)[\s\S]*platform\\\.openai\\\.com\\\/login/i
  );
  assert.match(
    backgroundSource,
    /const recoveredStep3PlatformLoginRefreshCount = Math\.max\(0,\s*Number\.parseInt\(String\(recoveryState\?\.step3PlatformLoginRefreshCount \?\? 0\),\s*10\) \|\| 0\);/i
  );
  assert.match(
    backgroundSource,
    /if \(step === 3 && recoveredStep3PlatformLoginRefreshCount < 3 && shouldRetryStep3WithPlatformLoginRefresh\(err\)\)[\s\S]*return await executeStepAndWait\(step,\s*delayAfter,\s*\{[\s\S]*step3PlatformLoginRefreshCount:\s*recoveredStep3PlatformLoginRefreshCount \+ 1[\s\S]*\}\);/i
  );
});

test('step 3 recovery reopens step 2 in signup-entry mode before retrying credentials', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function recoverStep3PlatformLogin\(error,\s*options = \{\}\) \{[\s\S]*Reopening the platform login page[\s\S]*await executeStep2\(state,\s*\{[\s\S]*preferSignupEntry:\s*true[\s\S]*\}\);/i
  );
});

test('step 3 timeout recovery also reopens the platform login page in signup-entry mode', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function recoverStep3OauthTimeout\(\) \{[\s\S]*retrying with the current email\/password[\s\S]*await executeStep2\(state,\s*\{[\s\S]*preferSignupEntry:\s*true[\s\S]*\}\);/i
  );
});

test('step 6 retries recoverable auth-page stalls with a fresh oauth url up to 10 times', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /const STEP6_MAX_OAUTH_RETRY_ATTEMPTS = 10;/i
  );
  assert.match(
    backgroundSource,
    /if \(step === 6 && recoveredStep6OauthRetryCount < STEP6_MAX_OAUTH_RETRY_ATTEMPTS && shouldRetryStep6WithFreshOauth\(err\)\)[\s\S]*await recoverStep6PlatformLogin\(err,\s*\{[\s\S]*attempt:\s*recoveredStep6OauthRetryCount \+ 1[\s\S]*maxAttempts:\s*STEP6_MAX_OAUTH_RETRY_ATTEMPTS[\s\S]*\}\);[\s\S]*step6OauthRetryCount:\s*recoveredStep6OauthRetryCount \+ 1/i
  );
});

test('step 6 recovery refreshes the oauth link before reopening auth and logs retry counters', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function recoverStep6PlatformLogin\(error,\s*options = \{\}\) \{[\s\S]*retryLabel = attempt > 0 && maxAttempts > 0[\s\S]*retry \$\{attempt\}\/\$\{maxAttempts\}[\s\S]*await refreshOauthUrlBeforeStep6\(/i
  );
  assert.match(
    backgroundSource,
    /async function recoverStep6PlatformLogin\(error,\s*options = \{\}\) \{[\s\S]*Refreshing the VPS OAuth link and reopening the auth login page[\s\S]*await reuseOrCreateTab\('signup-page',\s*refreshedState\.oauthUrl/i
  );
});

test('step 6 ignores localhost redirect-driven signup page disconnects and keeps waiting for completion', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function executeStep6\(state\) \{[\s\S]*try \{[\s\S]*await sendToContentScript\('signup-page', \{[\s\S]*step:\s*6[\s\S]*\}\);[\s\S]*\} catch \(err\) \{[\s\S]*isMessageChannelClosedError\([\s\S]*isReceivingEndMissingError\([\s\S]*waitForStep6CompletionSignalOrRecoveredAuthState\(\);[\s\S]*throw err;[\s\S]*\}[\s\S]*\}/i
  );
});

test('step 6 refreshes the VPS OAuth link through a dedicated fetch path instead of reusing step 1 completion state', () => {
  const backgroundSource = readProjectFile('background.js');
  const vpsSource = readProjectFile(path.join('content', 'vps-panel.js'));

  assert.match(
    backgroundSource,
    /async function fetchFreshOauthUrlFromVps\(state,\s*options = \{\}\) \{[\s\S]*sendToContentScript\('vps-panel',\s*\{[\s\S]*type:\s*'FETCH_OAUTH_URL'[\s\S]*payload:\s*\{\s*logStep\s*\}/i
  );
  assert.doesNotMatch(
    backgroundSource,
    /async function fetchFreshOauthUrlFromVps\(state,\s*options = \{\}\) \{[\s\S]*waitForStepComplete\(1/i
  );
  assert.match(
    backgroundSource,
    /async function executeStep6\(state\) \{[\s\S]*await reuseOrCreateTab\('signup-page',\s*effectiveState\.oauthUrl,\s*\{[\s\S]*reuseActiveTabOnCreate:\s*true[\s\S]*reloadIfSameUrl:\s*true/i
  );
  assert.match(
    vpsSource,
    /if \(message\.type === 'EXECUTE_STEP' \|\| message\.type === 'FETCH_OAUTH_URL'\)/i
  );
  assert.match(
    vpsSource,
    /case 'FETCH_OAUTH_URL':[\s\S]*return await fetchOAuthUrlFromPanel\(/i
  );
});

test('step 6 prefers the manual custom password before falling back to the generated password', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /const effectivePassword = effectiveState\.customPassword \|\| effectiveState\.password \|\| '';/i
  );
  assert.match(
    backgroundSource,
    /payload:\s*\{\s*email:\s*effectiveState\.email,\s*password:\s*effectivePassword\s*\}/i
  );
});

test('step 6 background fallback completes when the auth flow already redirected to localhost', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function waitForStep6CompletionSignalOrRecoveredAuthState\(\) \{/i
  );
  assert.match(
    backgroundSource,
    /const signupTabId = await getTabId\('signup-page'\);[\s\S]*const tab = await chrome\.tabs\.get\(signupTabId\)[\s\S]*isLocalhostCallbackUrl\(tab\?\.url\)[\s\S]*setState\(\{\s*localhostUrl:\s*tab\.url\s*\}\)[\s\S]*notifyStepComplete\(6,\s*\{[\s\S]*recoveredAfterNavigation:\s*true[\s\S]*localhostUrl:\s*tab\.url[\s\S]*\}\)/i
  );
});

test('step 8 heartbeats retry the consent-page continue click when the auth page stalls on consent', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function retryStep8ConsentClickIfStillVisible\(/i
  );
  assert.match(
    backgroundSource,
    /shouldLogStep8RedirectHeartbeat\([\s\S]*await retryStep8ConsentClickIfStillVisible\(/i
  );
  assert.match(
    backgroundSource,
    /第 8 步：心跳检查时发现授权同意页在 .* 后仍然可见，准备再次点击“继续”/i
  );
});

test('step 8 falls back to an in-page consent submit when the continue button stays covered or consent keeps stalling', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function tryStep8ConsentSubmitFallback\(/i
  );
  assert.match(
    backgroundSource,
    /type:\s*'STEP8_TRY_SUBMIT'/i
  );
  assert.match(
    backgroundSource,
    /clickResult\?\.hitTargetBlocked[\s\S]*tryStep8ConsentSubmitFallback\(/i
  );
  assert.match(
    backgroundSource,
    /elapsedMs >= 20000[\s\S]*tryStep8ConsentSubmitFallback\(/i
  );
});

test('steps 7-9 replay from step 6 once before failing the run', () => {
  const backgroundSource = readProjectFile('background.js');
  const runtimeErrorsSource = readProjectFile(path.join('shared', 'runtime-errors.js'));

  assert.match(
    runtimeErrorsSource,
    /function shouldRetryStep7Through9FromStep6\(step,\s*error\)/i
  );
  assert.match(
    backgroundSource,
    /const recoveredStep7Through9FromStep6 = Boolean\(recoveryState && recoveryState !== true && recoveryState\.step7Through9FromStep6\);/i
  );
  assert.match(
    backgroundSource,
    /if \(\[7,\s*8,\s*9\]\.includes\(step\) && !recoveredStep7Through9FromStep6 && shouldRetryStep7Through9FromStep6\(step,\s*err\)\)[\s\S]*await replaySteps6ThroughTargetStepWithCurrentAccount\([\s\S]*return;/i
  );
  assert.match(
    backgroundSource,
    /async function replaySteps6ThroughTargetStepWithCurrentAccount\(targetStep,\s*logMessage,\s*recoveryState = \{\}\) \{[\s\S]*await executeStepAndWait\(6,\s*2000\);[\s\S]*for \(let replayStep = 7; replayStep <= targetStep; replayStep\+\+\)/i
  );
});

test('step 4 and step 5 skip signup-only work when step 3 already identified an existing account login flow', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /case 3:[\s\S]*existingAccountLogin/i
  );
  assert.match(
    backgroundSource,
    /async function executeStep4\(state\) \{[\s\S]*if \(state\.existingAccountLogin\)[\s\S]*Skipping inbox polling[\s\S]*notifyStepComplete\(4,\s*\{[\s\S]*skippedExistingAccountLogin:\s*true/i
  );
  assert.match(
    backgroundSource,
    /async function executeStep5\(state\) \{[\s\S]*if \(state\.existingAccountLogin\)[\s\S]*Skipping profile completion[\s\S]*notifyStepComplete\(5,\s*\{[\s\S]*skippedExistingAccountLogin:\s*true/i
  );
});

test('step 5 waits briefly for the page to leave verification and reach the profile form before filling name data', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function ensureSignupPageReadyForProfile\(state,\s*step = 5\) \{/i
  );
  assert.match(
    backgroundSource,
    /async function executeStep5\(state\) \{[\s\S]*await ensureSignupPageReadyForProfile\(state,\s*5\);[\s\S]*await sendToContentScript\('signup-page',\s*\{[\s\S]*step:\s*5[\s\S]*payload:\s*\{ firstName,\s*lastName,\s*year,\s*month,\s*day \}[\s\S]*\}\);/i
  );
});

test('step 5 exits immediately when the signup tab already reached the platform welcome create landing page', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function executeStep5\(state\) \{[\s\S]*const profileReadyState = await ensureSignupPageReadyForProfile\(state,\s*5\);[\s\S]*if \(isStableStep5SuccessUrl\(profileReadyState\?\.url\)\) \{[\s\S]*const payload = \{[\s\S]*recoveredFromWelcomeLanding:\s*true[\s\S]*\};[\s\S]*notifyStepComplete\(5,\s*payload\);[\s\S]*return;[\s\S]*\}[\s\S]*await sendToContentScript\('signup-page'/i
  );
});

test('step 5 completion is revalidated against the live auth page before the background accepts success', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function waitForStep5AuthStateToSettle\(timeoutMs = 12000\) \{/i
  );
  assert.match(
    backgroundSource,
    /waitForStep5AuthStateToSettle\(timeoutMs = 12000\) \{[\s\S]*if \(pageState\?\.isReachable === false\)[\s\S]*await sleepWithStop\(250\);[\s\S]*continue;/i
  );
  assert.match(
    backgroundSource,
    /async function validateStep5CompletionBeforeAcceptingSuccess\(payload = \{\}\) \{[\s\S]*const pageState = await waitForStep5AuthStateToSettle\(\);/i
  );
  assert.match(
    backgroundSource,
    /case 'STEP_COMPLETE': \{[\s\S]*if \(message\.step === 5\) \{[\s\S]*await validateStep5CompletionBeforeAcceptingSuccess\(message\.payload\);[\s\S]*\}[\s\S]*await setStepStatus\(message\.step,\s*'completed'\);/i
  );
  assert.match(
    backgroundSource,
    /validateStep5CompletionBeforeAcceptingSuccess\(payload = \{\}\) \{[\s\S]*const pageState = await waitForStep5AuthStateToSettle\(\);[\s\S]*pageState\?\.hasUnsupportedEmail[\s\S]*pageState\?\.hasReadyProfilePage[\s\S]*pageState\?\.hasVisibleProfileFormInput/i
  );
});

test('step 5 retries stalled signup-page communication by refreshing the current auth page up to 2 times', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /const STEP5_MAX_PROFILE_RETRY_ATTEMPTS = 2;/i
  );
  assert.match(
    backgroundSource,
    /const recoveredStep5ProfileRetryCount = Math\.max\(0,\s*Number\.parseInt\(String\(recoveryState\?\.step5ProfileRetryCount \?\? 0\),\s*10\) \|\| 0\);/i
  );
  assert.match(
    backgroundSource,
    /if \(step === 5 && recoveredStep5ProfileRetryCount < STEP5_MAX_PROFILE_RETRY_ATTEMPTS && shouldRetryStep5WithProfileRefresh\(err\)\)[\s\S]*await recoverStep5ProfilePage\(err,\s*\{[\s\S]*attempt:\s*recoveredStep5ProfileRetryCount \+ 1[\s\S]*maxAttempts:\s*STEP5_MAX_PROFILE_RETRY_ATTEMPTS[\s\S]*\}\);[\s\S]*step5ProfileRetryCount:\s*recoveredStep5ProfileRetryCount \+ 1/i
  );
  assert.match(
    backgroundSource,
    /async function recoverStep5ProfilePage\(error,\s*options = \{\}\) \{[\s\S]*Reloading the current signup profile page and retrying step 5[\s\S]*await reuseOrCreateTab\('signup-page',\s*signupTab\.url,\s*\{[\s\S]*reloadIfSameUrl:\s*true[\s\S]*\}\);/i
  );
});

test('background still resolves step waiters when a replayed step reports STEP_COMPLETE after the step was already marked completed', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /if \(currentStepStatus === 'completed'\) \{\s*notifyStepComplete\(message\.step,\s*message\.payload\);\s*return \{ ok: true \};\s*\}/i
  );
});

test('active auto-run watchdog uses a persistent alarm fallback so MV3 worker restarts do not disable stall detection', () => {
  const backgroundSource = readProjectFile('background.js');
  const autoRunSource = readProjectFile(path.join('shared', 'auto-run.js'));

  assert.match(
    autoRunSource,
    /AUTO_RUN_ACTIVE_WATCHDOG_ALARM_NAME = 'infinitoai-auto-run-active-watchdog'[\s\S]*function getAutoRunActiveWatchdogAlarmName\(\)/i
  );
  assert.match(
    backgroundSource,
    /chrome\.alarms\.onAlarm\.addListener\(\(alarm\) => \{[\s\S]*getAutoRunActiveWatchdogAlarmName\(\)[\s\S]*handlePersistentActiveAutoRunWatchdogAlarm\(\)/i
  );
  assert.match(
    backgroundSource,
    /function startAutoRunWatchdog\(\) \{[\s\S]*armPersistentAutoRunActiveWatchdog\(/i
  );
  assert.match(
    backgroundSource,
    /function touchAutoRunWatchdog\(entry = null\) \{[\s\S]*armPersistentAutoRunActiveWatchdog\(/i
  );
  assert.match(
    backgroundSource,
    /async function handlePersistentActiveAutoRunWatchdogAlarm\(\) \{[\s\S]*if \(autoRunWatchdogReject\) \{[\s\S]*autoRunWatchdogReject\(error\);[\s\S]*\}[\s\S]*await finalizePersistentAutoRunWatchdogTimeout\(/i
  );
});

test('step 5 keeps waiting for completion when the profile submit navigation disconnects before the content response returns', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function executeStep5\(state\) \{[\s\S]*try \{[\s\S]*await sendToContentScript\('signup-page', \{[\s\S]*step:\s*5[\s\S]*\}\);[\s\S]*\} catch \(err\) \{[\s\S]*isMessageChannelClosedError\([\s\S]*isReceivingEndMissingError\([\s\S]*waitForStep5CompletionSignalOrRecoveredAuthState\(\);[\s\S]*throw err;[\s\S]*\}[\s\S]*\}/i
  );
  assert.match(
    backgroundSource,
    /async function waitForStep5CompletionSignalOrRecoveredAuthState\(\) \{/i
  );
  assert.match(
    backgroundSource,
    /platform\.openai\.com\/welcome\?step=create[\s\S]*Step 5: Auth page already advanced beyond the profile form after the navigation interrupt[\s\S]*notifyStepComplete\(5,\s*\{[\s\S]*recoveredAfterNavigation:\s*true[\s\S]*\}\)/i
  );
});

test('step 5 background validation treats the platform welcome landing page as a successful fallback when the content script is temporarily unreachable', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /function isStableStep5SuccessUrl\(url = ''\) \{[\s\S]*parsed\.hostname !== 'platform\.openai\.com'/i
  );
  assert.match(
    backgroundSource,
    /function isStableStep5SuccessUrl\(url = ''\) \{[\s\S]*parsed\.searchParams\.get\('step'\) === 'create'/i
  );
  assert.match(
    backgroundSource,
    /async function getSignupPageFallbackAuthState\(\) \{[\s\S]*const signupTabId = await getTabId\('signup-page'\);[\s\S]*const signupTab = await chrome\.tabs\.get\(signupTabId\)\.catch\(\(\) => null\);[\s\S]*const signupUrl = String\(signupTab\?\.url \|\| ''\)\.trim\(\);[\s\S]*if \(!isStableStep5SuccessUrl\(signupUrl\)\) \{[\s\S]*return null;[\s\S]*\}[\s\S]*isReachable:\s*true[\s\S]*url:\s*signupUrl/i
  );
  assert.match(
    backgroundSource,
    /async function getSignupAuthPageState\(\) \{[\s\S]*catch \{[\s\S]*const fallbackState = await getSignupPageFallbackAuthState\(\);[\s\S]*if \(fallbackState\) \{[\s\S]*return fallbackState;[\s\S]*\}[\s\S]*return \{[\s\S]*isReachable:\s*false/i
  );
});

test('signup auth fallback state also recognizes email-verification and about-you urls when the content script is temporarily unreachable', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function getSignupPageFallbackAuthState\(\) \{[\s\S]*isCanonicalEmailVerificationUrl\(signupUrl\)[\s\S]*hasReadyVerificationPage:\s*true/i
  );
  assert.match(
    backgroundSource,
    /async function getSignupPageFallbackAuthState\(\) \{[\s\S]*isCanonicalAboutYouUrl\(signupUrl\)[\s\S]*hasReadyProfilePage:\s*true/i
  );
});

test('step 4 and step 5 page-readiness checks consume the stronger auth-page semantic signals', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function ensureSignupPageReadyForVerification\(state,\s*step = 4\) \{[\s\S]*hasReadyVerificationPage[\s\S]*hasReadyProfilePage/i
  );
  assert.match(
    backgroundSource,
    /async function ensureSignupPageReadyForProfile\(state,\s*step = 5\) \{[\s\S]*hasReadyProfilePage[\s\S]*hasReadyVerificationPage/i
  );
  assert.match(
    backgroundSource,
    /hasReadyVerificationPage:\s*false[\s\S]*hasReadyProfilePage:\s*false/i
  );
});

test('step 4 and step 7 readiness checks short-circuit when the signup tab already reached the platform welcome create landing page', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function ensureSignupPageReadyForVerification\(state,\s*step = 4\) \{[\s\S]*isStableStep5SuccessUrl\(pageState\?\.url\)[\s\S]*return state;/i
  );
});

test('step 4 cautiously fast-paths a stable email-verification landing after consecutive checks instead of waiting for full copy stabilization', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /let consecutiveVerificationShortcutSignals = 0;[\s\S]*isCanonicalEmailVerificationUrl\(pageState\?\.url\)\s*\|\|\s*pageState\?\.hasVisibleVerificationInput/i
  );
  assert.match(
    backgroundSource,
    /consecutiveVerificationShortcutSignals >= 2[\s\S]*return state;/i
  );
});

test('step 5 cautiously fast-paths a stable about-you profile form only after repeated url-plus-input checks', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /let consecutiveProfileShortcutSignals = 0;[\s\S]*isCanonicalAboutYouUrl\(pageState\?\.url\)[\s\S]*pageState\?\.hasVisibleProfileFormInput/i
  );
  assert.match(
    backgroundSource,
    /consecutiveProfileShortcutSignals >= 2[\s\S]*return \{ \.\.\.state,\s*\.\.\.pageState \};/i
  );
});

test('step 5 content submit outcome polls the stable welcome-create url once per second before falling back to broader next-page heuristics', () => {
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));

  assert.match(
    signupSource,
    /const STEP5_STABLE_URL_POLL_INTERVAL_MS = 1000;/i
  );
  assert.match(
    signupSource,
    /function getStableStep5LandingOutcome\(\) \{[\s\S]*isStablePostProfileLandingUrl\(\)[\s\S]*reason:\s*'stable-landing-url'/i
  );
  assert.match(
    signupSource,
    /async function waitForProfileSubmissionOutcome\(step,\s*timeout = STEP5_PROFILE_SUBMIT_OUTCOME_TIMEOUT_MS\) \{[\s\S]*let lastStableUrlPollAt = 0;[\s\S]*if \(Date\.now\(\) - lastStableUrlPollAt >= STEP5_STABLE_URL_POLL_INTERVAL_MS\) \{[\s\S]*const stableLandingOutcome = getStableStep5LandingOutcome\(\);[\s\S]*if \(stableLandingOutcome\) \{[\s\S]*return stableLandingOutcome;[\s\S]*\}[\s\S]*\}[\s\S]*if \(hasStableNextPageAfterProfileSubmit\(visibleText\)\)/i
  );
  assert.doesNotMatch(
    signupSource,
    /function hasStableNextPageAfterProfileSubmit\(text = getVisiblePageText\(\)\) \{[\s\S]*hasReadyVerificationPage\(text\)/i
  );
});

test('step 4 and step 5 warn or error copy is Chinese-friendly while keeping debug details inline', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /当前 auth 页面暂时无法访问，先等待验证页恢复响应后再查收邮件/i
  );
  assert.match(
    backgroundSource,
    /当前页面已经到达 https:\/\/platform\.openai\.com\/welcome\?step=create/i
  );
  assert.match(
    backgroundSource,
    /当前页面已进入 about-you 资料页，且输入框已连续两次可见/i
  );
  assert.match(
    backgroundSource,
    /调试：/i
  );
});

test('step 4 unreachable timeout uses a dedicated error instead of claiming the flow is still on the credential form', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /if \(lastPageState\?\.isReachable === false\) \{[\s\S]*Step \$\{step\} blocked: signup auth page stayed unreachable before the verification email step\./i
  );
});

test('step 7 checks the auth page blocker state before opening TMailor inbox polling', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function executeStep7\(state\) \{[\s\S]*const effectiveState = await ensureSignupPageReadyForVerification\(state,\s*7\);[\s\S]*await executeVerificationMailStep\(7,\s*effectiveState,\s*\{/i
  );
});

test('stopping auto-run prevents step 1 from continuing into TMailor fallback work after an in-flight API failure', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function fetchTmailorEmail\(options = \{\}\) \{[\s\S]*await addLog\('TMailor: Requesting a new mailbox via API\.\.\.',\s*'info'\);[\s\S]*catch \(err\) \{[\s\S]*\}[\s\S]*throwIfStopped\(\);[\s\S]*await addLog\(`TMailor: Opening mailbox page \(\$\{generateNew \? 'generate new' : 'reuse current'\}\)\.\.\.`\);/i
  );
});

test('auto run phase 1 rethrows stop requests instead of downgrading them into waiting-email pauses', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /let emailReady = false;[\s\S]*try \{[\s\S]*const nextEmail = await fetchEmailAddress\(\{ generateNew: true \}\);[\s\S]*\} catch \(err\) \{[\s\S]*if \(isStopError\(err\)\) \{\s*throw err;\s*\}[\s\S]*自动取号失败：\$\{err\.message\}/i
  );
});

test('background seeds content flow control sequences from a time-based baseline so fresh commands survive worker restarts', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /let contentFlowControlSequence = Date\.now\(\)\s*\*\s*1000;/i
  );
});

test('stopping auto-run prevents new content-script commands from being queued or dispatched', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function sendToContentScript\(source,\s*message\) \{[\s\S]*throwIfStopped\(\);[\s\S]*const nextMessage = attachContentFlowControlSequence\(message\);/i
  );
});

test('infinite auto run keeps per-run reset and log-round setup inside the retryable run catch', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /const runTargetText = autoRunInfinite \? `\$\{run\}\/∞` : `\$\{run\}\/\$\{totalRuns\}`;\r?\n\r?\n\s*try \{\r?\n\s*\/\/ Reset everything at the start of each run[\s\S]*await resetState\(\{ preserveLogHistory: true \}\);[\s\S]*await startNewLogRound\(`Run \$\{runTargetText\}`\);[\s\S]*await executeStepAndWait\(2,\s*2000\);/i
  );
});

test('auto run closes signup and mailbox tabs at each round boundary before rebuilding the run state', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /async function closeAutoRunRoundTabs\(\) \{[\s\S]*'signup-page'[\s\S]*'qq-mail'[\s\S]*'mail-163'[\s\S]*'duck-mail'[\s\S]*'tmailor-mail'[\s\S]*'inbucket-mail'[\s\S]*chrome\.tabs\.remove/i
  );
  assert.match(
    backgroundSource,
    /const keepSettings = \{[\s\S]*\};[\s\S]*await closeAutoRunRoundTabs\(\);[\s\S]*await resetState\(\{\s*preserveLogHistory:\s*true\s*\}\);/i
  );
});

test('auto run phase 2 uses a distinct email-source binding after the per-run setup block', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(
    backgroundSource,
    /const currentState = await getState\(\);\r?\n\s*const currentEmailSource = getCurrentEmailSource\(currentState\);[\s\S]*getEmailSourceLabel\(currentEmailSource\)/i
  );
});
