(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.RuntimeErrors = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  function isMessageChannelClosedError(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    return /message channel closed before a response was received|message channel is closed/i.test(message);
  }

  function isReceivingEndMissingError(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    return /could not establish connection\.\s*receiving end does not exist/i.test(message);
  }

  function buildMailPollRecoveryPlan(error) {
    if (isMessageChannelClosedError(error) || isReceivingEndMissingError(error)) {
      return ['soft-retry', 'reload'];
    }
    return [];
  }

  function shouldSkipStepResultLog(status) {
    return status === 'failed' || status === 'stopped';
  }

  function shouldRetryStep1WithFreshVpsPanel(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    return /step 1 failed: found codex oauth card but no login button inside it/i.test(message)
      || /step 1 failed: auth url did not appear after clicking login/i.test(message);
  }

  function shouldRetryStep3WithPlatformLoginRefresh(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    return /step 3 (?:failed|blocked): could not find passwordless-login button or password input after submitting email\.\s*url:\s*https:\/\/platform\.openai\.com\/login(?:[/?#]\S*)?/i.test(message)
      || /step 3 (?:failed|blocked): could not find email input field on signup page\.\s*url:\s*https:\/\/platform\.openai\.com\/login(?:[/?#]\S*)?/i.test(message)
      || /step 3 (?:failed|blocked): current auth page is not on the signup flow yet\.\s*url:\s*https:\/\/platform\.openai\.com\/login(?:[/?#]\S*)?/i.test(message);
  }

  function shouldRetryStep3WithFreshOauth(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    return /(?:step 3 blocked:\s*)?openai auth page timed out before credentials could be submitted/i.test(message)
      || /(?:step 3 blocked:\s*)?auth issue page offered a "retry" recovery action\./i.test(message)
      || /(?:step 3 blocked:\s*)?auth issue page offered a "return home" recovery link\./i.test(message)
      || /(?:step 3 failed:\s*)?auth fatal error page detected before the password input appeared\./i.test(message)
      || /(?:step 3 failed:\s*)?auth fatal error page detected after step 3 password submit\./i.test(message)
      || /(?:step 3 failed:\s*)?could not find email input field on signup page\.\s*url:\s*https:\/\/auth\.openai\.com\/sign-in-with-chatgpt\/[^/\s?#]+\/consent(?:[/?#]\S*)?/i.test(message)
      || /(?:step 3 failed:\s*)?could not find email input field on signup page\.\s*url:\s*https:\/\/auth\.openai\.com\/create-account\/password(?:[/?#]\S*)?/i.test(message)
      || /(?:step 3 failed:\s*)?could not find email input field on signup page\.\s*url:\s*https:\/\/platform\.openai\.com\/signup(?:[/?#]\S*)?/i.test(message)
      || /(?:step 3 failed:\s*)?could not find passwordless-login button or password input after submitting email\.\s*url:\s*https:\/\/(?:auth|accounts)\.openai\.com\/\S+/i.test(message)
      || /content script on signup-page did not respond in \d+s\. try refreshing the tab and retry\./i.test(message)
      || /(?:step 3 blocked:\s*)?password was filled but no submit action was available on the signup form\.\s*url:\s*https:\/\/(?:auth|accounts|platform)\.openai\.com\/\S+/i.test(message)
      || /(?:step 3 blocked:\s*)?password was filled but the signup page never advanced past the credential form/i.test(message);
  }

  function shouldRetryStep6WithFreshOauth(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    return /(?:step 6 recoverable:\s*)?openai auth page timed out before login could complete\./i.test(message)
      || /(?:step 6 failed:\s*)?could not find email input on login page\.\s*url:\s*https:\/\/(?:auth|accounts)\.openai\.com\/\S+/i.test(message)
      || /(?:step 6 recoverable:\s*)?auth issue page offered a "retry" recovery action\./i.test(message)
      || /(?:step 6 recoverable:\s*)?auth issue page offered a "return home" recovery link\./i.test(message)
      || /(?:step 6 failed:\s*)?auth fatal error page detected after login submit\./i.test(message)
      || /(?:step 6 failed:\s*)?login did not advance after password submit\. still on the password page\./i.test(message)
      || /vps panel did not return a usable oauth url\./i.test(message)
      || /content script on vps-panel did not respond in \d+s\. try refreshing the tab and retry\./i.test(message)
      || /frame with id 0 is showing error page/i.test(message)
      || isMessageChannelClosedError(message)
      || isReceivingEndMissingError(message);
  }

  function shouldRetryStep5WithProfileRefresh(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    return /content script on signup-page did not respond in \d+s\. try refreshing the tab and retry\./i.test(message)
      || /could not establish connection\.\s*receiving end does not exist/i.test(message)
      || /message channel closed before a response was received|message channel is closed/i.test(message);
  }

  function shouldRetryStep8WithFreshOauth(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    return /step 8 recoverable: auth flow landed on an unexpected page before localhost redirect/i.test(message);
  }

  function shouldRetryStep7Through9FromStep6(step, error) {
    const normalizedStep = Number.parseInt(String(step ?? '').trim(), 10);
    if (![7, 8, 9].includes(normalizedStep)) {
      return false;
    }

    const message = typeof error === 'string' ? error : error?.message || '';
    if (!message) {
      return false;
    }

    if (
      /phone verification|phone number is required|当前 auth 页面要求手机号验证|请切换节点后重试/i.test(message)
      || /verification form stayed visible after submit attempts\.\s*url:\s*https:\/\/(?:auth|accounts)\.openai\.com\/add-phone(?:[/?#]\S*)?/i.test(message)
    ) {
      return false;
    }

    if (/vps url not set|flow stopped by user|auto run handed off to manual continuation/i.test(message)) {
      return false;
    }

    return true;
  }

  return {
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
    shouldSkipStepResultLog,
  };
});
