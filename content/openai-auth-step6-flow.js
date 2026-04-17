(function() {
if (window.__MULTIPAGE_OPENAI_AUTH_STEP6_FLOW_LOADED) {
  return;
}
window.__MULTIPAGE_OPENAI_AUTH_STEP6_FLOW_LOADED = true;

const authFlow = window.__MULTIPAGE_OPENAI_AUTH_FLOW__;
if (!authFlow) {
  throw new Error('OpenAI auth step 6 flow could not find the shared auth flow shell.');
}

async function step6_login(payload) {
  const { email, password } = payload;
  if (!email) throw new Error('No email provided for login.');

  log(`Step 6: Logging in with ${email}...`);
  const latestPageOauthUrl = await authFlow.resolveLatestPageOauthUrl();

  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('Could not find email input on login page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 6: Email filled');

  await sleep(500);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    await humanPause(400, 1100);
    simulateClick(submitBtn1);
    log('Step 6: Submitted email');
  }

  const passwordInput = await authFlow.waitForLoginPasswordField();
  if (passwordInput) {
    log('Step 6: Password field found, filling password...');
    await humanPause(550, 1450);
    fillInput(passwordInput, password);
    log('Step 6: Password filled');

    await sleep(500);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);

    if (submitBtn2) {
      await humanPause(450, 1200);
      simulateClick(submitBtn2);
      log('Step 6: Submitted password, waiting for login outcome...');
    }
    await authFlow.waitForLoginSubmissionOutcome();
    reportComplete(6, { needsOTP: true, ...(latestPageOauthUrl ? { oauthUrl: latestPageOauthUrl } : {}) });
    return;
  }

  log('Step 6: No password field. OTP flow or auto-redirect.');
  reportComplete(6, { needsOTP: true, ...(latestPageOauthUrl ? { oauthUrl: latestPageOauthUrl } : {}) });
}

Object.assign(authFlow, {
  step6_login,
});
})();
