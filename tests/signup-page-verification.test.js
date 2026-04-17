const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AuthFatalErrors = require('../shared/auth-fatal-errors.js');

function createContext({
  href = 'https://auth.openai.com/email-verification',
  bodyText = '',
  DateImpl = Date,
  waitForElementImpl,
  waitForElementByTextImpl,
  querySelectorImpl,
  querySelectorAllImpl,
  elementFromPointImpl,
  reportCompleteImpl,
} = {}) {
  const listeners = [];
  const errors = [];
  const completions = [];

  class StubEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }

  const context = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    location: { href },
    document: {
      body: { innerText: bodyText },
      documentElement: {},
      querySelector(selector) {
        return querySelectorImpl ? querySelectorImpl(selector) : null;
      },
      querySelectorAll(selector) {
        return querySelectorAllImpl ? querySelectorAllImpl(selector) : [];
      },
      elementFromPoint(x, y) {
        if (elementFromPointImpl) {
          return elementFromPointImpl(x, y);
        }
        return null;
      },
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
        sendMessage() {
          return Promise.resolve({ ok: true });
        },
      },
    },
    VerificationCode: {
      isVerificationCodeRejectedText() {
        return false;
      },
      isVerificationRetryStateText(text) {
        return /retry/i.test(text);
      },
    },
    PhoneVerification: {
      isPhoneVerificationRequiredText() {
        return false;
      },
      getPhoneVerificationBlockedMessage(step) {
        return `Step ${step} blocked: phone verification is required on the auth page.`;
      },
    },
    AuthFatalErrors: {
      isAuthOperationTimedOutText() {
        return false;
      },
      getAuthOperationTimedOutMessage(step) {
        return `Step ${step} blocked: OpenAI auth page timed out before credentials could be submitted. Reopen the platform login page and retry with the same email and password.`;
      },
      isAuthFatalErrorText() {
        return false;
      },
      isUnsupportedCountryRegionTerritoryText() {
        return false;
      },
      getUnsupportedCountryRegionTerritoryMessage(step) {
        return `Step ${step} blocked: unsupported country or region.`;
      },
    },
    UnsupportedEmail: {
      isUnsupportedEmailText() {
        return false;
      },
      isUnsupportedEmailBlockingStep() {
        return false;
      },
      getUnsupportedEmailBlockedMessage(step) {
        return `Step ${step} blocked`;
      },
    },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    Event: StubEvent,
    MouseEvent: StubEvent,
    KeyboardEvent: StubEvent,
    InputEvent: StubEvent,
    setTimeout,
    clearTimeout,
    Date: DateImpl,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
      };
    },
    resetStopState() {},
    isStopError() {
      return false;
    },
    log() {},
    reportComplete(step, payload) {
      completions.push({ step, payload });
      if (typeof reportCompleteImpl === 'function') {
        return reportCompleteImpl(step, payload);
      }
      return undefined;
    },
    reportError(step, message) {
      errors.push({ step, message });
    },
    throwIfStopped() {},
    sleep() {
      return Promise.resolve();
    },
    humanPause() {
      return Promise.resolve();
    },
    simulateClick() {},
    fillInput() {},
    waitForElement(selector) {
      if (waitForElementImpl) {
        return waitForElementImpl(selector);
      }
      return Promise.reject(new Error('missing'));
    },
    waitForElementByText(selector, pattern) {
      if (waitForElementByTextImpl) {
        return waitForElementByTextImpl(selector, pattern);
      }
      return Promise.reject(new Error('missing'));
    },
    isElementVisible() {
      return true;
    },
  };

  context.window = context;
  context.top = context;
  context.__listeners = listeners;
  context.__errors = errors;
  context.__completions = completions;
  return context;
}

function loadSignupPage(context) {
  loadSignupPageBundle(context);
}

function loadSignupPageBundle(context) {
  const scriptPaths = [
    path.join(__dirname, '..', 'content', 'signup-page.js'),
    path.join(__dirname, '..', 'content', 'openai-auth-step3-flow.js'),
    path.join(__dirname, '..', 'content', 'openai-auth-step6-flow.js'),
    path.join(__dirname, '..', 'content', 'openai-auth-step2-handler.js'),
    path.join(__dirname, '..', 'content', 'openai-auth-step3-handler.js'),
    path.join(__dirname, '..', 'content', 'openai-auth-step5-handler.js'),
    path.join(__dirname, '..', 'content', 'openai-auth-step6-handler.js'),
    path.join(__dirname, '..', 'content', 'openai-auth-step8-handler.js'),
    path.join(__dirname, '..', 'content', 'openai-auth-actions-handler.js'),
  ];
  vm.createContext(context);
  for (const scriptPath of scriptPaths) {
    const code = fs.readFileSync(scriptPath, 'utf8');
    vm.runInContext(code, context, { filename: scriptPath });
  }
}

test('step 7 fails the round when email verification page has retry text but no code input', async () => {
  const context = createContext({
    bodyText: 'Something went wrong. Please retry.',
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 7, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.match(
    response?.error || '',
    /retry state before the code input appeared/i
  );
  assert.deepEqual(context.__errors, [
    {
      step: 7,
      message: response.error,
    },
  ]);
});

test('auth content bundle registers step-specific handlers for signup and oauth login separately', () => {
  const context = createContext({
    VerificationCode: { isVerificationCodeRejectedText() { return false; }, isVerificationRetryStateText() { return false; } },
    PhoneVerification: { isPhoneVerificationRequiredText() { return false; }, getPhoneVerificationBlockedMessage() { return ''; } },
    AuthFatalErrors: { isAuthOperationTimedOutText() { return false; }, getAuthOperationTimedOutMessage() { return ''; }, isAuthFatalErrorText() { return false; }, isUnsupportedCountryRegionTerritoryText() { return false; }, getUnsupportedCountryRegionTerritoryMessage() { return ''; } },
    UnsupportedEmail: { isUnsupportedEmailText() { return false; }, isUnsupportedEmailBlockingStep() { return false; }, getUnsupportedEmailBlockedMessage() { return ''; } },
    resetStopState() {},
    isStopError() { return false; },
    log() {},
    reportError() {},
  });

  loadSignupPageBundle(context);

  const registry = context.__MULTIPAGE_OPENAI_AUTH_FLOW__;
  assert.ok(registry, 'expected auth flow registry to be exposed');
  assert.deepEqual(
    JSON.parse(JSON.stringify(registry.getRegisteredStepMetadata())),
    [
      { step: 2, name: 'platform-signup-entry' },
      { step: 3, name: 'signup-credentials' },
      { step: 5, name: 'signup-profile' },
      { step: 6, name: 'oauth-login' },
      { step: 8, name: 'oauth-consent' },
    ]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(registry.getRegisteredActionMetadata())),
    [
      { type: 'CHECK_AUTH_PAGE_STATE', name: 'auth-page-state' },
      { type: 'CLICK_RESEND_EMAIL', name: 'resend-email' },
      { type: 'FILL_CODE', name: 'verification-code' },
      { type: 'STEP8_FIND_AND_CLICK', name: 'oauth-consent-click' },
      { type: 'STEP8_TRY_SUBMIT', name: 'oauth-consent-submit' },
    ]
  );
});

test('step 7 reports the phone-verification blocker without auth-domain decoration before the code input appears', async () => {
  const context = createContext({
    href: 'https://accounts.openai.com/account/email-verification',
    bodyText: 'Verify your phone number to continue',
  });
  context.PhoneVerification = require('../shared/phone-verification.js');
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 7, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(
    response?.error,
    '第 7 步被拦截：当前 auth 页面要求手机号验证，请切换节点后重试。'
  );
  assert.deepEqual(context.__errors, [
    {
      step: 7,
      message: response.error,
    },
  ]);
});

test('step 7 reports the phone-verification blocker when the verification submit lands on add-phone', async () => {
  const codeInput = {
    inputMode: 'numeric',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };
  const submitButton = {
    textContent: '继续',
    disabled: false,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: 'Check your inbox and enter the 6-digit code',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="code"]' || selector === 'input[inputmode="numeric"]') {
        return [codeInput];
      }
      return [];
    },
  });
  context.PhoneVerification = require('../shared/phone-verification.js');
  context.fillInput = () => {};
  context.simulateClick = (target) => {
    if (target === submitButton) {
      context.location.href = 'https://auth.openai.com/add-phone';
      context.document.body.innerText = 'Continue';
    }
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 7, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(
    response?.error,
    '第 7 步被拦截：当前 auth 页面要求手机号验证，请切换节点后重试。'
  );
  assert.deepEqual(context.__errors, [
    {
      step: 7,
      message: response.error,
    },
  ]);
});

test('step 2 stops immediately and asks to change node when oauth page shows unsupported country or region', async () => {
  const context = createContext({
    href: 'https://auth.openai.com/api/oauth/authorize?client_id=test-client',
    bodyText: JSON.stringify({
      error: {
        code: 'unsupported_country_region_territory',
        message: 'Country, region, or territory not supported',
        param: null,
        type: 'request_forbidden',
      },
    }),
  });
  context.AuthFatalErrors = AuthFatalErrors;
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(
    response?.error,
    'Step 2 blocked: OpenAI does not support the current country, region, or territory. Please change node and retry.'
  );
  assert.deepEqual(context.__errors, [
    {
      step: 2,
      message: response.error,
    },
  ]);
  assert.deepEqual(context.__completions, []);
});

test('step 2 completes immediately when the platform login page is already showing the email form', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 160, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'Build on the OpenAI API Platform',
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="email"]') {
        return [emailInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 still accepts the platform login email form when recovery prefers a signup entry', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 160, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'Build on the OpenAI API Platform',
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="email"]') {
        return [emailInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: { preferSignupEntry: true } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 logs out from platform home when the account menu is already available there', async () => {
  let fakeNow = 0;
  class FakeDate extends Date {
    static now() {
      fakeNow += 2500;
      return fakeNow;
    }
  }

  let menuOpen = false;
  let loggedOut = false;

  const emailInput = {
    getBoundingClientRect() {
      return { width: 180, height: 42 };
    },
  };
  const accountMenuButton = {
    className: '',
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'aria-expanded') return menuOpen ? 'true' : 'false';
      if (name === 'data-state') return menuOpen ? 'open' : 'closed';
      return null;
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };
  const logoutLabel = {
    className: 'wU7SW',
    textContent: 'Log out',
    getBoundingClientRect() {
      return { width: 120, height: 32 };
    },
    dispatchEvent() {},
    focus() {},
    closest() {
      return this;
    },
  };

  const context = createContext({
    href: 'https://platform.openai.com/home',
    bodyText: 'OpenAI Platform',
    DateImpl: FakeDate,
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="email"]') {
        return loggedOut ? [emailInput] : [];
      }
      if (selector === 'button[aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"][aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"]') {
        return loggedOut ? [] : [accountMenuButton];
      }
      if (selector === 'button, [role="menuitem"], [role="button"], a, div, span') {
        return loggedOut ? [] : (menuOpen ? [logoutLabel] : [accountMenuButton]);
      }
      return [];
    },
  });
  context.simulateClick = (target) => {
    if (target === accountMenuButton) {
      menuOpen = true;
      return;
    }
    if (target === logoutLabel) {
      menuOpen = false;
      loggedOut = true;
      context.location.href = 'https://platform.openai.com/login';
    }
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 refuses the auth log-in email form and asks the background to reopen the platform login entry', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 180, height: 42 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/log-in',
    bodyText: 'Welcome back',
    querySelectorAllImpl(selector) {
      if (selector === 'input[id*="email"]') {
        return [emailInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(
    response?.error,
    'Step 2 recoverable: auth login page appeared instead of the platform login entry. Reopen https://platform.openai.com/login and retry.'
  );
  assert.deepEqual(context.__errors, [
    {
      step: 2,
      message: response.error,
    },
  ]);
  assert.deepEqual(context.__completions, []);
});

test('step 2 treats the dedicated #login-email field as a direct-entry login form', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 200, height: 44 };
    },
  };

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'Build on the OpenAI API Platform',
    querySelectorAllImpl(selector) {
      if (selector === 'input#login-email') {
        return [emailInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 refuses autocomplete=username inputs on auth log-in pages and asks the background to reopen platform login', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 200, height: 44 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/log-in',
    bodyText: '欢迎回来',
    querySelectorAllImpl(selector) {
      if (selector === 'input[autocomplete="username"]') {
        return [emailInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(
    response?.error,
    'Step 2 recoverable: auth login page appeared instead of the platform login entry. Reopen https://platform.openai.com/login and retry.'
  );
  assert.deepEqual(context.__errors, [
    {
      step: 2,
      message: response.error,
    },
  ]);
  assert.deepEqual(context.__completions, []);
});

test('step 2 waits for the completion signal before clicking a register link that navigates away', async () => {
  const registerButton = {
    textContent: '注册',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };

  let completionAcked = false;
  let clickedBeforeAck = false;

  const context = createContext({
    href: 'https://auth.openai.com/log-in',
    bodyText: '欢迎回来 还没有帐户？请注册',
    waitForElementByTextImpl(_selector, pattern) {
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern))) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
    reportCompleteImpl() {
      return new Promise((resolve) => {
        setTimeout(() => {
          completionAcked = true;
          resolve();
        }, 10);
      });
    },
  });
  context.simulateClick = (target) => {
    assert.equal(target, registerButton);
    clickedBeforeAck = !completionAcked;
    context.location.href = 'https://auth.openai.com/u/signup/identifier';
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.equal(clickedBeforeAck, false);
  assert.equal(completionAcked, true);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 re-checks for the direct credential form before failing when no register button is found', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 200, height: 44 };
    },
  };
  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'Build on the OpenAI API Platform',
    waitForElementByTextImpl() {
      return Promise.reject(new Error('missing'));
    },
    waitForElementImpl() {
      return Promise.reject(new Error('missing'));
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input#login-email') {
        return [emailInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 prefers the direct platform login email form over clicking register during signup-entry recovery', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 200, height: 44 };
    },
  };
  const registerButton = {
    textContent: '注册',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  let clickedTarget = null;

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'Build on the OpenAI API Platform Sign up',
    waitForElementByTextImpl(_selector, pattern) {
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern))) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input#login-email') {
        return [emailInput];
      }
      return [];
    },
  });
  context.simulateClick = (target) => {
    clickedTarget = target;
    context.location.href = 'https://auth.openai.com/u/signup/identifier';
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: { preferSignupEntry: true } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.ok, true);
  assert.equal(clickedTarget, null);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 3 submits the email first and then switches to passwordless login when the OTP button appears', async () => {
  const state = {
    stage: 'email',
  };

  const emailInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const continueButton = {
    textContent: 'Continue',
    getBoundingClientRect() {
      return { width: 240, height: 48 };
    },
  };
  const otpButton = {
    textContent: '使用一次性验证码登录',
    value: 'passwordless_login_send_otp',
    getBoundingClientRect() {
      return { width: 240, height: 48 };
    },
  };

  const filledValues = [];
  const clickedTargets = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/signup/identifier',
    bodyText: 'Create your account',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]' && state.stage === 'email') {
        return continueButton;
      }
      if (selector.includes('button[name="intent"][value="passwordless_login_send_otp"]') && state.stage === 'password') {
        return otpButton;
      }
      return null;
    },
    waitForElementByTextImpl(_selector, pattern) {
      if (/使用一次性验证码登录|one-time code|otp/i.test(String(pattern)) && state.stage === 'password') {
        return Promise.resolve(otpButton);
      }
      return Promise.reject(new Error('missing'));
    },
  });
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === continueButton) {
      state.stage = 'password';
      context.location.href = 'https://auth.openai.com/u/signup/password';
      context.document.body.innerText = '输入密码 使用一次性验证码登录';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(filledValues, ['demo@example.com']);
  assert.deepEqual(clickedTargets, [continueButton, otpButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions)),
    [
      {
        step: 3,
        payload: {
          email: 'demo@example.com',
          usesOneTimeCode: true,
        },
      },
    ]
  );
});

test('step 3 skips refilling the identifier when the signup password page is already visible', async () => {
  const usernameInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const continueButton = {
    textContent: '继续',
    getBoundingClientRect() {
      return { width: 240, height: 48 };
    },
  };

  const filledValues = [];
  const clickedTargets = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/signup/password',
    bodyText: '创建密码 继续',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(usernameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="username"]') {
        return [usernameInput];
      }
      if (selector === 'input[type="password"]') {
        return [passwordInput];
      }
      return [];
    },
  });
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === continueButton) {
      context.location.href = 'https://auth.openai.com/email-verification';
      context.document.body.innerText = 'Enter verification code';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(filledValues, ['secret-pass']);
  assert.deepEqual(clickedTargets, [continueButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions)),
    [
      {
        step: 3,
        payload: {
          email: 'demo@example.com',
        },
      },
    ]
  );
});

test('step 3 only completes after the password fallback submit actually advances the signup page', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const passwordInput = {
    dispatchEvent(event) {
      if (event?.type === 'keydown' && event?.key === 'Enter') {
        context.location.href = 'https://auth.openai.com/email-verification';
        context.document.body.innerText = 'Enter verification code';
      }
      return true;
    },
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };

  const filledValues = [];
  const completionUrls = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/signup/password',
    bodyText: '创建密码',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl() {
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]') {
        return [passwordInput];
      }
      return [];
    },
    reportCompleteImpl(_step, _payload) {
      completionUrls.push(context.location.href);
    },
  });
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(filledValues, ['secret-pass']);
  assert.deepEqual(completionUrls, ['https://auth.openai.com/email-verification']);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions)),
    [
      {
        step: 3,
        payload: {
          email: 'demo@example.com',
        },
      },
    ]
  );
});

test('step 3 preserves the current account when email submit falls into the auth login password page', async () => {
  const state = {
    stage: 'email',
  };

  const emailInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const continueButton = {
    textContent: 'Continue',
    getBoundingClientRect() {
      return { width: 240, height: 48 };
    },
  };

  const filledValues = [];
  const clickedTargets = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/signup/identifier',
    bodyText: 'Create your account',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]' && state.stage === 'password') {
        return [passwordInput];
      }
      return [];
    },
  });
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === continueButton) {
      state.stage = 'password';
      context.location.href = 'https://auth.openai.com/log-in/password';
      context.document.body.innerText = 'Welcome back 输入密码';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(filledValues, ['demo@example.com']);
  assert.deepEqual(clickedTargets, [continueButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions)),
    [
      {
        step: 3,
        payload: {
          email: 'demo@example.com',
          existingAccountLogin: true,
        },
      },
    ]
  );
});

test('step 3 clicks register instead of treating the login password page as an existing-account flow when the page still offers signup', async () => {
  const state = {
    stage: 'email',
  };

  const emailInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const continueButton = {
    textContent: '继续',
    getBoundingClientRect() {
      return { width: 240, height: 48 };
    },
  };
  const registerButton = {
    tagName: 'A',
    textContent: '请注册',
    getBoundingClientRect() {
      return { width: 160, height: 32 };
    },
    closest() {
      return null;
    },
  };
  const signupContinueButton = {
    textContent: '继续',
    getBoundingClientRect() {
      return { width: 240, height: 48 };
    },
  };

  const filledValues = [];
  const clickedTargets = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/signup/identifier',
    bodyText: 'Create your account',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        if (state.stage === 'email') {
          return continueButton;
        }
        if (state.stage === 'signup-password') {
          return signupContinueButton;
        }
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]' && (state.stage === 'login-password' || state.stage === 'signup-password')) {
        return [passwordInput];
      }
      if (selector === 'a, button, [role="button"], [role="link"], span' && state.stage === 'login-password') {
        return [registerButton];
      }
      return [];
    },
  });
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === continueButton) {
      state.stage = 'login-password';
      context.location.href = 'https://auth.openai.com/log-in/password';
      context.document.body.innerText = '输入密码 还没有帐户？请注册';
      return;
    }
    if (target === registerButton) {
      state.stage = 'signup-password';
      context.location.href = 'https://auth.openai.com/create-account/password';
      context.document.body.innerText = '创建密码 继续';
      return;
    }
    if (target === signupContinueButton) {
      context.location.href = 'https://auth.openai.com/email-verification';
      context.document.body.innerText = 'Enter verification code';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(filledValues, ['demo@example.com', 'secret-pass']);
  assert.deepEqual(clickedTargets, [continueButton, registerButton, signupContinueButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions)),
    [
      {
        step: 3,
        payload: {
          email: 'demo@example.com',
        },
      },
    ]
  );
});

test('step 3 refuses to start typing until the auth page is actually on the signup flow', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };

  const filledValues = [];
  const context = createContext({
    href: 'https://platform.openai.com/home',
    bodyText: 'Build on the OpenAI API Platform',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
  });
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.match(response?.error || '', /current auth page is not on the signup flow yet/i);
  assert.deepEqual(filledValues, []);
  assert.deepEqual(context.__completions, []);
});

test('step 3 treats the platform login url as a direct email-first signup entry', async () => {
  const state = {
    onSignupPage: false,
  };
  const clickedTargets = [];
  const filledValues = [];
  const emailInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const continueButton = {
    textContent: '继续',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'Build on the OpenAI API Platform Sign up',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      if (selector === 'input[type="password"]') {
        return Promise.resolve(passwordInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(_selector, pattern) {
      if (/continue|next|submit|继续|下一步/i.test(String(pattern))) {
        return Promise.resolve(continueButton);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input#login-email' && !state.onSignupPage) {
        return [emailInput];
      }
      if (selector === 'input[type="email"]' && !state.onSignupPage) {
        return [emailInput];
      }
      if (selector === 'input[name="email"]' && !state.onSignupPage) {
        return [emailInput];
      }
      if (selector === 'input[type="password"]' && state.onSignupPage) {
        return [passwordInput];
      }
      return [];
    },
  });
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === continueButton) {
      if (!state.onSignupPage) {
        state.onSignupPage = true;
        context.location.href = 'https://auth.openai.com/u/signup/password';
        context.document.body.innerText = '创建密码 继续';
        return;
      }
      state.onSignupPage = false;
      context.location.href = 'https://auth.openai.com/u/signup/email-verification';
      context.document.body.innerText = 'Check your inbox for a verification code';
    }
  };
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.equal(clickedTargets[0], continueButton);
  assert.ok(filledValues.includes('demo@example.com'));
  assert.ok(filledValues.includes('secret-pass'));
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0]?.step, 3);
  assert.equal(context.__completions[0]?.payload?.email, 'demo@example.com');
});

test('auth page state reports when the login password page still exposes a signup path', async () => {
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const registerButton = {
    tagName: 'A',
    textContent: '请注册',
    innerText: '请注册',
    getBoundingClientRect() {
      return { width: 120, height: 32 };
    },
    closest() {
      return null;
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/log-in/password',
    bodyText: '输入密码 还没有帐户？请注册',
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]') {
        return [passwordInput];
      }
      if (selector === 'a, button, [role="button"], [role="link"], span') {
        return [registerButton];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'CHECK_AUTH_PAGE_STATE', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.hasVisibleCredentialInput, true);
  assert.equal(response?.hasVisibleSignupRegistrationChoice, true);
});

test('step 2 continues through the create-account session-ended landing page by clicking the visible login button', async () => {
  const loginButton = {
    textContent: '登录',
    getBoundingClientRect() {
      return { width: 240, height: 52 };
    },
  };
  let clickedTarget = null;

  const context = createContext({
    href: 'https://auth.openai.com/create-account',
    bodyText: '你的会话已结束 登录以继续，或在不登录的情况下使用 ChatGPT.com',
    waitForElementByTextImpl(_selector, pattern) {
      if (/登录|log\s*in|continue/i.test(String(pattern))) {
        return Promise.resolve(loginButton);
      }
      return Promise.reject(new Error('missing'));
    },
  });
  context.simulateClick = (target) => {
    clickedTarget = target;
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.ok, true);
  assert.equal(clickedTarget, loginButton);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 logs out first when platform login redirects into an already-signed-in chat session', async () => {
  const state = {
    menuOpen: false,
  };

  const avatarButton = {
    tagName: 'BUTTON',
    textContent: 'A',
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'aria-expanded') return state.menuOpen ? 'true' : 'false';
      if (name === 'data-state') return state.menuOpen ? 'open' : 'closed';
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
  };
  const logoutLabel = {
    textContent: 'Log out',
    getBoundingClientRect() {
      return { width: 120, height: 32 };
    },
    closest() {
      return null;
    },
    parentElement: null,
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/chat',
    bodyText: 'API dashboard',
    waitForElementImpl(selector) {
      if (selector.includes('aria-haspopup="menu"') || selector.includes('button[id^="radix-"')) {
        return Promise.resolve(avatarButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(_selector, pattern) {
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /platform\.openai\.com\/login/i.test(context.location.href)) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorAllImpl(selector) {
      if (
        selector === 'button[aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"][aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"]'
      ) {
        return [avatarButton];
      }
      if (selector === 'button, [role="menuitem"], [role="button"], a, div, span') {
        return state.menuOpen ? [logoutLabel] : [];
      }
      return [];
    },
  });
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === avatarButton) {
      state.menuOpen = true;
      context.document.body.innerText = 'Account menu Log out';
      return;
    }
    if (target === logoutLabel) {
      state.menuOpen = false;
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
      return;
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [avatarButton, logoutLabel, registerButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 waits for platform login to finish redirecting through home before logging out of chat', async () => {
  const state = {
    menuOpen: false,
    avatarReady: false,
  };

  const avatarButton = {
    tagName: 'BUTTON',
    textContent: 'A',
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'aria-expanded') return state.menuOpen ? 'true' : 'false';
      if (name === 'data-state') return state.menuOpen ? 'open' : 'closed';
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
  };
  const logoutLabel = {
    textContent: 'Log out',
    getBoundingClientRect() {
      return { width: 120, height: 32 };
    },
    closest() {
      return null;
    },
    parentElement: null,
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'Loading platform login...',
    waitForElementImpl(selector) {
      if ((selector.includes('aria-haspopup="menu"') || selector.includes('button[id^="radix-"')) && state.avatarReady) {
        return Promise.resolve(avatarButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(_selector, pattern) {
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /platform\.openai\.com\/login/i.test(context.location.href)) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorAllImpl(selector) {
      if (
        selector === 'button[aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"][aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"]'
      ) {
        return state.avatarReady ? [avatarButton] : [];
      }
      if (selector === 'button, [role="menuitem"], [role="button"], a, div, span') {
        return state.menuOpen ? [logoutLabel] : [];
      }
      return [];
    },
  });
  context.sleep = async () => {
    if (/platform\.openai\.com\/login/i.test(context.location.href)) {
      context.location.href = 'https://platform.openai.com/home';
      context.document.body.innerText = 'Loading platform home...';
      return;
    }
    if (/platform\.openai\.com\/home/i.test(context.location.href)) {
      context.location.href = 'https://platform.openai.com/chat';
      context.document.body.innerText = 'API dashboard';
      state.avatarReady = true;
    }
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === avatarButton) {
      state.menuOpen = true;
      context.document.body.innerText = 'Account menu Log out';
      return;
    }
    if (target === logoutLabel) {
      state.menuOpen = false;
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
      return;
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [avatarButton, logoutLabel, registerButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 recovers from the stale platform signing-in callback by returning home and reopening platform login', async () => {
  const state = {
    issueVisible: false,
  };

  const returnHomeLink = {
    textContent: '返回首页',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/auth/callback?code=stale',
    bodyText: 'OpenAI Platform API Docs Signing in...',
    waitForElementByTextImpl(_selector, pattern) {
      const normalizedPattern = String(pattern);
      if (/返回首页|return home|back to home|home/i.test(normalizedPattern) && state.issueVisible) {
        return Promise.resolve(returnHomeLink);
      }
      if (/sign\s*up|register|create\s*account|注册/i.test(normalizedPattern) && /platform\.openai\.com\/login/i.test(context.location.href)) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
  });
  context.sleep = async () => {
    if (/platform\.openai\.com\/auth\/callback/i.test(context.location.href) && !state.issueVisible) {
      state.issueVisible = true;
      context.location.href = 'https://platform.openai.com/login';
      context.document.body.innerText = '糟糕! We ran into an issue while authenticating you. If this issue persists, please contact us through our help center at https://help.openai.com. 返回首页';
    }
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === returnHomeLink) {
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
      return;
    }
    if (target === registerButton) {
      context.location.href = 'https://auth.openai.com/u/signup/identifier';
      context.document.body.innerText = 'Create your account';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [returnHomeLink, registerButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 waits for the invalid_state issue page and clicks return home before reopening platform login', async () => {
  const state = {
    issueVisible: false,
    recovered: false,
    now: 0,
  };

  const returnHomeLink = {
    textContent: '返回首页',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/auth/callback?code=stale',
    bodyText: 'OpenAI Platform API Docs Signing in...',
    waitForElementByTextImpl(_selector, pattern) {
      const normalizedPattern = String(pattern);
      if (/返回首页|return home|back to home|home/i.test(normalizedPattern) && state.issueVisible) {
        return Promise.resolve(returnHomeLink);
      }
      if (/sign\s*up|register|create\s*account|注册/i.test(normalizedPattern) && state.recovered && /platform\.openai\.com\/login/i.test(context.location.href)) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
  });
  context.Date = {
    now() {
      return state.now;
    },
  };
  context.sleep = async () => {
    state.now += 250;
    if (!state.issueVisible && state.now >= 40000) {
      state.issueVisible = true;
      context.location.href = 'https://platform.openai.com/login';
      context.document.body.innerText = '糟糕，出错了！ 验证过程中出错 (invalid_state)。 请重试。 返回首页';
    }
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === returnHomeLink) {
      state.recovered = true;
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
      return;
    }
    if (target === registerButton) {
      context.location.href = 'https://auth.openai.com/u/signup/identifier';
      context.document.body.innerText = 'Create your account';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [returnHomeLink, registerButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 recovers from the auth issue page when it appears after the initial platform settle window', async () => {
  const state = {
    issueVisible: false,
    recovered: false,
    now: 0,
  };

  const returnHomeLink = {
    textContent: '返回首页',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'OpenAI Platform API Docs',
    waitForElementByTextImpl(_selector, pattern) {
      const normalizedPattern = String(pattern);
      if (/返回首页|return home|back to home|home/i.test(normalizedPattern) && state.issueVisible) {
        return Promise.resolve(returnHomeLink);
      }
      if (/sign\s*up|register|create\s*account|注册/i.test(normalizedPattern)) {
        if (state.recovered && /platform\.openai\.com\/login/i.test(context.location.href)) {
          return Promise.resolve(registerButton);
        }
        state.issueVisible = true;
        context.document.body.innerText = '糟糕! We ran into an issue while authenticating you. If this issue persists, please contact us through our help center at https://help.openai.com. 返回首页';
        return Promise.reject(new Error('missing'));
      }
      return Promise.reject(new Error('missing'));
    },
  });
  context.Date = {
    now() {
      state.now += 5000;
      return state.now;
    },
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === returnHomeLink) {
      state.recovered = true;
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
      return;
    }
    if (target === registerButton) {
      context.location.href = 'https://auth.openai.com/u/signup/identifier';
      context.document.body.innerText = 'Create your account';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [returnHomeLink, registerButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
});

test('step 2 retries the platform avatar with a low-level pointer sequence when the first click does not open the menu', async () => {
  const state = {
    menuOpen: false,
    pointerPrimed: false,
  };

  const avatarButton = {
    tagName: 'BUTTON',
    textContent: 'S',
    dispatchEvent(event) {
      if (event?.type === 'pointerdown') {
        state.pointerPrimed = true;
      }
      if (event?.type === 'click' && state.pointerPrimed) {
        state.menuOpen = true;
        context.document.body.innerText = 'Account menu Log out';
      }
      return true;
    },
    focus() {},
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'aria-expanded') return state.menuOpen ? 'true' : 'false';
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
  };
  const logoutLabel = {
    textContent: 'Log out',
    getBoundingClientRect() {
      return { width: 120, height: 32 };
    },
    closest() {
      return null;
    },
    parentElement: null,
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/chat',
    bodyText: 'API dashboard',
    waitForElementImpl(selector) {
      if (selector.includes('aria-haspopup="menu"') || selector.includes('button[id^="radix-"')) {
        return Promise.resolve(avatarButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(_selector, pattern) {
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /platform\.openai\.com\/login/i.test(context.location.href)) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorAllImpl(selector) {
      if (
        selector === 'button[aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"][aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"]'
      ) {
        return [avatarButton];
      }
      if (selector === 'button, [role="menuitem"], [role="button"], a, div, span') {
        return state.menuOpen ? [logoutLabel] : [];
      }
      return [];
    },
  });
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === logoutLabel) {
      state.menuOpen = false;
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [avatarButton, logoutLabel, registerButton]);
  assert.equal(state.pointerPrimed, true);
  assert.deepEqual(context.__errors, []);
});

test('step 2 opens the responsive platform shell menu before clicking the avatar logout menu', async () => {
  const state = {
    shellMenuOpen: false,
    menuOpen: false,
  };

  const shellMenuButton = {
    tagName: 'BUTTON',
    className: 'p9Ilg',
    textContent: '',
    querySelector(selector) {
      if (selector === '[data-top="true"]') return { dataset: { top: 'true' } };
      if (selector === '[data-bottom="true"]') return { dataset: { bottom: 'true' } };
      return null;
    },
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
  };
  const avatarButton = {
    tagName: 'BUTTON',
    textContent: 'S',
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'aria-expanded') return state.menuOpen ? 'true' : 'false';
      if (name === 'data-state') return state.menuOpen ? 'open' : 'closed';
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
  };
  const logoutLabel = {
    textContent: 'Log out',
    getBoundingClientRect() {
      return { width: 120, height: 32 };
    },
    closest() {
      return null;
    },
    parentElement: null,
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/chat',
    bodyText: 'API dashboard',
    waitForElementImpl(selector) {
      if ((selector.includes('aria-haspopup="menu"') || selector.includes('button[id^="radix-"')) && state.shellMenuOpen) {
        return Promise.resolve(avatarButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(_selector, pattern) {
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /platform\.openai\.com\/login/i.test(context.location.href)) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[aria-haspopup="menu"], button[id^="radix-"], button[data-state]') {
        return state.shellMenuOpen ? avatarButton : null;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (
        selector === 'button[aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"][aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"]'
      ) {
        return state.shellMenuOpen ? [avatarButton] : [];
      }
      if (selector === 'button') {
        return state.shellMenuOpen ? [shellMenuButton, avatarButton] : [shellMenuButton];
      }
      if (selector === 'button, [role="menuitem"], [role="button"], a, div, span') {
        return state.menuOpen ? [logoutLabel] : [];
      }
      return [];
    },
  });
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === shellMenuButton) {
      state.shellMenuOpen = true;
      context.document.body.innerText = 'Responsive shell menu Account avatar';
      return;
    }
    if (target === avatarButton) {
      state.menuOpen = true;
      context.document.body.innerText = 'Responsive shell menu Account menu Log out';
      return;
    }
    if (target === logoutLabel) {
      state.menuOpen = false;
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [shellMenuButton, avatarButton, logoutLabel, registerButton]);
  assert.deepEqual(context.__errors, []);
});

test('step 2 clicks the radix logout menu item container instead of the inner logout label text node', async () => {
  const state = {
    menuOpen: false,
  };

  const avatarButton = {
    tagName: 'BUTTON',
    textContent: 'S',
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'aria-expanded') return state.menuOpen ? 'true' : 'false';
      if (name === 'data-state') return state.menuOpen ? 'open' : 'closed';
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
  };
  const logoutItemRoot = {
    tagName: 'DIV',
    id: 'radix-:r10:',
    getAttribute(name) {
      if (name === 'id') return 'radix-:r10:';
      return null;
    },
    getBoundingClientRect() {
      return { width: 180, height: 40 };
    },
  };
  const logoutItemWrapper = {
    tagName: 'DIV',
    className: '_86hTd',
    parentElement: logoutItemRoot,
    closest(selector) {
      if (selector.includes('[id^="radix-"]')) {
        return logoutItemRoot;
      }
      return null;
    },
  };
  const logoutLabel = {
    tagName: 'DIV',
    className: 'wU7SW',
    textContent: 'Log out',
    parentElement: logoutItemWrapper,
    getBoundingClientRect() {
      return { width: 120, height: 32 };
    },
    closest(selector) {
      if (selector.includes('[id^="radix-"]')) {
        return logoutItemRoot;
      }
      return null;
    },
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/chat',
    bodyText: 'API dashboard',
    waitForElementImpl(selector) {
      if (selector.includes('aria-haspopup="menu"') || selector.includes('button[id^="radix-"')) {
        return Promise.resolve(avatarButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(_selector, pattern) {
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /platform\.openai\.com\/login/i.test(context.location.href)) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorAllImpl(selector) {
      if (
        selector === 'button[aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"][aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"]'
      ) {
        return [avatarButton];
      }
      if (selector === 'button, [role="menuitem"], [role="button"], a, div, span') {
        return state.menuOpen ? [logoutLabel] : [];
      }
      return [];
    },
  });
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === avatarButton) {
      state.menuOpen = true;
      context.document.body.innerText = 'Account menu Log out';
      return;
    }
    if (target === logoutItemRoot) {
      state.menuOpen = false;
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
      return;
    }
    if (target === logoutLabel || target === logoutItemWrapper) {
      return;
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [avatarButton, logoutItemRoot, registerButton]);
  assert.deepEqual(context.__errors, []);
});

test('step 2 ignores broad account summary nodes that merely contain logout text and clicks the exact logout item', async () => {
  const state = {
    menuOpen: false,
  };

  const avatarButton = {
    tagName: 'BUTTON',
    textContent: 'S',
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'aria-expanded') return state.menuOpen ? 'true' : 'false';
      if (name === 'data-state') return state.menuOpen ? 'open' : 'closed';
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
  };
  const noisySummarySpan = {
    tagName: 'SPAN',
    textContent: 'Sarah Martin manwea@sonphuongthinh.com Terms & policies Help Log out',
    className: '',
    parentElement: null,
    getBoundingClientRect() {
      return { width: 320, height: 80 };
    },
    closest() {
      return null;
    },
  };
  const logoutItemRoot = {
    tagName: 'DIV',
    id: 'radix-:r1f:',
    getAttribute(name) {
      if (name === 'id') return 'radix-:r1f:';
      return null;
    },
    getBoundingClientRect() {
      return { width: 180, height: 40 };
    },
  };
  const logoutItemWrapper = {
    tagName: 'DIV',
    className: '_86hTd',
    parentElement: logoutItemRoot,
    closest(selector) {
      if (selector.includes('[id^="radix-"]')) {
        return logoutItemRoot;
      }
      return null;
    },
  };
  const logoutLabel = {
    tagName: 'DIV',
    className: 'wU7SW',
    textContent: 'Log out',
    parentElement: logoutItemWrapper,
    getBoundingClientRect() {
      return { width: 120, height: 32 };
    },
    closest(selector) {
      if (selector.includes('[id^="radix-"]')) {
        return logoutItemRoot;
      }
      return null;
    },
  };
  const registerButton = {
    textContent: 'Sign up',
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const clickedTargets = [];

  const context = createContext({
    href: 'https://platform.openai.com/chat',
    bodyText: 'API dashboard',
    waitForElementImpl(selector) {
      if (selector.includes('aria-haspopup="menu"') || selector.includes('button[id^="radix-"')) {
        return Promise.resolve(avatarButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(_selector, pattern) {
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /platform\.openai\.com\/login/i.test(context.location.href)) {
        return Promise.resolve(registerButton);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorAllImpl(selector) {
      if (
        selector === 'button[aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"][aria-haspopup="menu"]'
        || selector === 'button[id^="radix-"]'
      ) {
        return [avatarButton];
      }
      if (selector === 'button, [role="menuitem"], [role="button"], a, div, span') {
        return state.menuOpen ? [noisySummarySpan, logoutLabel] : [];
      }
      return [];
    },
  });
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === avatarButton) {
      state.menuOpen = true;
      context.document.body.innerText = 'Account menu Sarah Martin Log out';
      return;
    }
    if (target === logoutItemRoot) {
      state.menuOpen = false;
      context.location.href = 'https://auth.openai.com/log-in';
      context.document.body.innerText = 'Welcome back Log in Sign up';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 2, payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(clickedTargets, [avatarButton, logoutItemRoot, registerButton]);
  assert.deepEqual(context.__errors, []);
});

test('step 3 reports an auth timeout page instead of a missing email field when the oauth session expired', async () => {
  const context = createContext({
    href: 'https://auth.openai.com/u/signup/identifier',
    bodyText: '糟糕，出错了！ Operation timed out',
  });
  context.AuthFatalErrors = {
    ...AuthFatalErrors,
    isAuthFatalErrorText: AuthFatalErrors.isAuthFatalErrorText,
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(
    response?.error,
    'Step 3 blocked: OpenAI auth page timed out before credentials could be submitted. Reopen the platform login page and retry with the same email and password.'
  );
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 3,
      message: response.error,
    },
  ]);
});

test('step 3 keeps filling the credential form when stale timeout copy is visible but the inputs are still actionable', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const continueButton = {
    textContent: '继续',
    getBoundingClientRect() {
      return { width: 240, height: 48 };
    },
  };

  const filledValues = [];
  const clickedTargets = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/signup/password',
    bodyText: '糟糕，出错了！ Operation timed out 创建密码 继续',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]') {
        return [passwordInput];
      }
      return [];
    },
  });
  context.AuthFatalErrors = AuthFatalErrors;
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === continueButton) {
      context.location.href = 'https://auth.openai.com/email-verification';
      context.document.body.innerText = 'Enter verification code';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(filledValues, ['secret-pass']);
  assert.deepEqual(clickedTargets, [continueButton]);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions)),
    [
      {
        step: 3,
        payload: {
          email: 'demo@example.com',
        },
      },
    ]
  );
});

test('step 3 reopens platform login instead of filling password when platform continue lands on an operation timeout state', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };
  const continueButton = {
    textContent: 'Continue',
    getBoundingClientRect() {
      return { width: 240, height: 48 };
    },
  };

  const filledValues = [];
  const clickedTargets = [];
  const state = {
    passwordVisible: false,
  };

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: 'Build on the OpenAI API Platform Continue',
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="email"]') {
        return [emailInput];
      }
      if (selector === 'input[type="password"]') {
        return state.passwordVisible ? [passwordInput] : [];
      }
      return [];
    },
  });
  context.AuthFatalErrors = AuthFatalErrors;
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === continueButton) {
      state.passwordVisible = true;
      context.document.body.innerText = '糟糕，出错了！ Operation timed out 创建密码 Continue';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(
    response?.error,
    'Step 3 blocked: OpenAI auth page timed out before credentials could be submitted. Reopen the platform login page and retry with the same email and password.'
  );
  assert.deepEqual(filledValues, ['demo@example.com']);
  assert.deepEqual(clickedTargets, [continueButton]);
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 3,
      message: response.error,
    },
  ]);
});

test('step 3 completes immediately when reinjected on the email-verification page after credentials were already submitted', async () => {
  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: 'Enter verification code',
  });
  context.AuthFatalErrors = AuthFatalErrors;
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 3, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions)),
    [
      {
        step: 3,
        payload: {
          email: 'demo@example.com',
        },
      },
    ]
  );
  assert.deepEqual(context.__errors, []);
});

test('auth page state exposes operation timeout pages before inbox polling begins', async () => {
  const context = createContext({
    href: 'https://auth.openai.com/u/signup/password',
    bodyText: '糟糕，出错了！ Operation timed out',
  });
  context.AuthFatalErrors = AuthFatalErrors;
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'CHECK_AUTH_PAGE_STATE', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.hasAuthOperationTimedOut, true);
  assert.equal(response?.hasFatalError, true);
});

test('auth page state ignores stale timeout copy while the credential form is still actionable', async () => {
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 220, height: 42 };
    },
  };

  const context = createContext({
    href: 'https://platform.openai.com/login',
    bodyText: '糟糕，出错了！ Operation timed out 创建密码 继续',
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]') {
        return [passwordInput];
      }
      return [];
    },
  });
  context.AuthFatalErrors = AuthFatalErrors;
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'CHECK_AUTH_PAGE_STATE', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.hasVisibleCredentialInput, true);
  assert.equal(response?.hasAuthOperationTimedOut, false);
  assert.equal(response?.hasFatalError, false);
});

test('auth page state reports when signup is still on the credential form', async () => {
  const emailInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };
  const passwordInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/u/signup/password',
    bodyText: '输入密码',
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="email"]') {
        return [emailInput];
      }
      if (selector === 'input[type="password"]') {
        return [passwordInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'CHECK_AUTH_PAGE_STATE', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.hasVisibleCredentialInput, true);
  assert.equal(response?.hasVisibleVerificationInput, false);
  assert.equal(response?.hasVisibleProfileFormInput, false);
});

test('auth page state requires email-verification context before promoting the profile form as ready', async () => {
  const codeInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };
  const nameInput = {
    getBoundingClientRect() {
      return { width: 220, height: 40 };
    },
  };
  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送到电子邮件地址的验证码 重新发送电子邮件',
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="code"]') {
        return [codeInput];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return [codeInput, ageInput];
      }
      if (selector === 'input[name="name"]') {
        return [nameInput];
      }
      if (selector === 'input[name="age"]') {
        return [ageInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'CHECK_AUTH_PAGE_STATE', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.hasVisibleVerificationInput, true);
  assert.equal(response?.hasVisibleProfileFormInput, true);
  assert.equal(response?.hasReadyVerificationPage, true);
  assert.equal(response?.hasReadyProfilePage, false);
});

test('auth page state still treats the canonical email-verification url as ready when footer copy overlaps with profile wording', async () => {
  const codeInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: 'Enter the 6-digit code we emailed you. By continuing, you agree to the Terms and Privacy Policy.',
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="code"]') {
        return [codeInput];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return [codeInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'CHECK_AUTH_PAGE_STATE', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.hasVisibleVerificationInput, true);
  assert.equal(response?.hasVisibleCredentialInput, false);
  assert.equal(response?.hasReadyVerificationPage, true);
  assert.equal(response?.hasReadyProfilePage, false);
});

test('auth page state promotes the about-you style profile form only when profile copy is visible', async () => {
  const nameInput = {
    getBoundingClientRect() {
      return { width: 220, height: 40 };
    },
  };
  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 点击“完成帐户创建”，即表示你同意我们的条款并已阅读我们的隐私政策。 完成帐户创建',
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return [nameInput];
      }
      if (selector === 'input[name="age"]') {
        return [ageInput];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return [ageInput];
      }
      return [];
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'CHECK_AUTH_PAGE_STATE', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.equal(response?.hasVisibleProfileFormInput, true);
  assert.equal(response?.hasReadyProfilePage, true);
  assert.equal(response?.hasReadyVerificationPage, false);
});

test('step 7 does not treat a post-submit retry page as accepted when the code input disappears', async () => {
  const state = {
    bodyText: 'Enter the 6-digit code',
    hideInputsAfterSubmit: false,
  };
  const submitButton = {};
  const codeInput = {};

  const context = createContext({
    bodyText: state.bodyText,
    waitForElementImpl(selector) {
      if (/input/.test(selector)) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error('missing'));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (state.hideInputsAfterSubmit) {
        return [];
      }
      if (selector.includes('input')) {
        return [{}];
      }
      return [];
    },
  });
  context.fillInput = () => {};
  context.simulateClick = () => {
    state.bodyText = 'Something went wrong. Please retry.';
    context.document.body.innerText = state.bodyText;
    state.hideInputsAfterSubmit = true;
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 7, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 2000);
  });

  assert.match(
    response?.error || '',
    /retry state after submitting the verification code/i
  );
});

test('step 6 fails instead of completing when the login page shows incorrect email or password', async () => {
  const state = {
    bodyText: '输入密码',
    passwordVisible: true,
    submitCount: 0,
  };

  const createVisibleElement = () => ({
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  });

  const emailInput = createVisibleElement();
  const passwordInput = createVisibleElement();
  const submitButton = createVisibleElement();
  const logs = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/login/password',
    bodyText: state.bodyText,
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]' && state.passwordVisible) {
        return [passwordInput];
      }
      return [];
    },
  });

  context.fillInput = () => {};
  context.log = (message) => {
    logs.push(String(message || ''));
  };
  context.simulateClick = () => {
    state.submitCount += 1;
    if (state.submitCount === 2) {
      state.bodyText = 'Incorrect email address or password';
      context.document.body.innerText = state.bodyText;
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 6, payload: { email: 'demo@example.com', password: 'wrong-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.match(response?.error || '', /incorrect email address or password/i);
  assert.ok(
    logs.includes('Step 6: Password filled'),
    `expected redacted password log, got ${JSON.stringify(logs)}`
  );
  assert.ok(
    !logs.some((entry) => entry.includes('wrong-pass')),
    `expected password to stay out of logs, got ${JSON.stringify(logs)}`
  );
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 6,
      message: response.error,
    },
  ]);
});

test('step 6 logs a detailed fatal auth snapshot before failing after login submit', async () => {
  const state = {
    bodyText: '输入密码',
    passwordVisible: true,
    submitCount: 0,
  };

  const createVisibleElement = () => ({
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  });

  const emailInput = createVisibleElement();
  const passwordInput = createVisibleElement();
  const submitButton = createVisibleElement();
  const logs = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/login/password',
    bodyText: state.bodyText,
    waitForElementImpl(selector) {
      if (selector.includes('type=\"email\"') || selector.includes('name=\"email\"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type=\"submit\"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type=\"password\"]' && state.passwordVisible) {
        return [passwordInput];
      }
      return [];
    },
  });
  context.AuthFatalErrors = AuthFatalErrors;
  context.log = (message) => {
    logs.push(String(message || ''));
  };
  context.fillInput = () => {};
  context.simulateClick = () => {
    state.submitCount += 1;
    if (state.submitCount === 2) {
      state.bodyText = 'Oops, something went wrong. Something went wrong during verification. Please try again.';
      context.document.body.innerText = state.bodyText;
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 6, payload: { email: 'demo@example.com', password: 'fatal-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.error, 'Auth fatal error page detected after login submit.');
  assert.ok(
    logs.some((entry) => /Step 6: Fatal auth state after login submit\./i.test(entry) && /Oops, something went wrong/i.test(entry)),
    `expected fatal auth snapshot log, got ${JSON.stringify(logs)}`
  );
});

test('step 6 clicks the return-home recovery link on auth issue pages before failing recoverably', async () => {
  const state = {
    bodyText: '输入密码',
    passwordVisible: true,
    submitCount: 0,
  };

  const createVisibleElement = (textContent = '') => ({
    textContent,
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  });

  const emailInput = createVisibleElement();
  const passwordInput = createVisibleElement();
  const submitButton = createVisibleElement('继续');
  const returnHomeLink = createVisibleElement('返回首页');
  const clickedTargets = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/login/password',
    bodyText: state.bodyText,
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(selector, pattern) {
      if (selector === 'button' && /continue|log\s*in|submit|sign\s*in|登录|继续/i.test(String(pattern))) {
        return Promise.resolve(submitButton);
      }
      if (/返回首页|return home|back to home|home/i.test(String(pattern)) && state.submitCount >= 2) {
        return Promise.resolve(returnHomeLink);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]' && state.passwordVisible) {
        return [passwordInput];
      }
      return [];
    },
  });

  context.fillInput = () => {};
  context.simulateClick = (target) => {
    clickedTargets.push(target);
    if (target === submitButton) {
      state.submitCount += 1;
      if (state.submitCount === 2) {
        state.bodyText = '糟糕! We ran into an issue while authenticating you. If this issue persists, please contact us through our help center at https://help.openai.com. 返回首页';
        context.document.body.innerText = state.bodyText;
      }
      return;
    }
    if (target === returnHomeLink) {
      context.location.href = 'https://auth.openai.com/';
      context.document.body.innerText = 'Home';
    }
  };

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 6, payload: { email: 'demo@example.com', password: 'fatal-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(
    response?.error,
    'Step 6 recoverable: auth issue page offered a "return home" recovery link. Refresh the VPS OAuth link and retry with the same email and password.'
  );
  assert.ok(
    clickedTargets.includes(returnHomeLink),
    `expected return-home click, got ${clickedTargets.length} clicks`
  );
});


test('step 6 reports the latest page oauth url while using sanitized runtime state', async () => {
  const state = {
    bodyText: '输入密码',
    passwordVisible: false,
  };

  const emailInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };

  const oauthAnchor = {
    href: 'https://auth.openai.com/api/oauth/authorize?client_id=page-newer',
    textContent: 'Continue to OpenAI',
    getBoundingClientRect() {
      return { width: 160, height: 30 };
    },
  };

  const runtimeMessages = [];

  const context = createContext({
    href: 'https://auth.openai.com/u/login/identifier',
    bodyText: state.bodyText,
    waitForElementImpl(selector) {
      if (selector.includes('type="email"') || selector.includes('name="email"')) {
        return Promise.resolve(emailInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return null;
      }
      if (selector === 'a[href*="/api/oauth/authorize"]') {
        return oauthAnchor;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[type="password"]' && state.passwordVisible) {
        return [{}];
      }
      if (selector === 'a[href*="/api/oauth/authorize"]') {
        return [oauthAnchor];
      }
      return [];
    },
  });

  context.chrome.runtime.sendMessage = (message) => {
    runtimeMessages.push(message);
    if (message?.type === 'GET_RUNTIME_STATE') {
      return Promise.resolve({ oauthUrl: 'https://auth.openai.com/api/oauth/authorize?client_id=panel-old' });
    }
    return Promise.resolve({ ok: true });
  };
  context.fillInput = () => {};
  context.simulateClick = () => {};

  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'EXECUTE_STEP', step: 6, payload: { email: 'demo@example.com', password: 'secret-pass' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 6);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions[0].payload)),
    {
      needsOTP: true,
      oauthUrl: 'https://auth.openai.com/api/oauth/authorize?client_id=page-newer',
    }
  );
  assert.ok(
    runtimeMessages.some((message) => message?.type === 'GET_RUNTIME_STATE'),
    'expected step 6 to use sanitized runtime state before deciding whether to override the oauth url'
  );
});

test('step 8 exposes fresh debugger click coordinates when the consent page is still visible', async () => {
  const continueButton = {
    textContent: '继续',
    disabled: false,
    getAttribute(name) {
      return name === 'aria-disabled' ? 'false' : null;
    },
    scrollIntoView() {},
    focus() {},
    getBoundingClientRect() {
      return { left: 40, top: 80, width: 160, height: 48 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
    bodyText: '使用 ChatGPT 登录到 Codex 继续',
    waitForElementImpl(selector) {
      if (selector.includes('button[type="submit"]')) {
        return Promise.resolve(continueButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'STEP8_FIND_AND_CLICK', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.equal(response?.buttonText, '继续');
  assert.equal(response?.url, 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent');
  assert.deepEqual(
    JSON.parse(JSON.stringify(response?.rect)),
    {
      left: 40,
      top: 80,
      width: 160,
      height: 48,
      centerX: 120,
      centerY: 104,
    }
  );
});

test('step 8 reports when the consent continue button click point is covered', async () => {
  const overlay = {
    tagName: 'DIV',
    textContent: 'Loading overlay',
  };
  const continueButton = {
    textContent: '继续',
    disabled: false,
    getAttribute(name) {
      return name === 'aria-disabled' ? 'false' : null;
    },
    contains(node) {
      return node === this;
    },
    scrollIntoView() {},
    focus() {},
    getBoundingClientRect() {
      return { left: 40, top: 80, width: 160, height: 48 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
    bodyText: '使用 ChatGPT 登录到 Codex 继续',
    elementFromPointImpl() {
      return overlay;
    },
    waitForElementImpl(selector) {
      if (selector.includes('button[type="submit"]')) {
        return Promise.resolve(continueButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'STEP8_FIND_AND_CLICK', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.equal(response?.hitTargetBlocked, true);
  assert.match(response?.hitTargetDescription || '', /DIV/i);
  assert.match(response?.hitTargetDescription || '', /Loading overlay/i);
});

test('step 8 can trigger an in-page consent submit fallback when the consent page stays visible', async () => {
  let requestSubmitCalls = 0;
  const form = {
    requestSubmit(button) {
      requestSubmitCalls += 1;
      assert.equal(button, continueButton);
    },
  };
  const continueButton = {
    textContent: '继续',
    disabled: false,
    form,
    getAttribute(name) {
      return name === 'aria-disabled' ? 'false' : null;
    },
    contains(node) {
      return node === this;
    },
    scrollIntoView() {},
    focus() {},
    getBoundingClientRect() {
      return { left: 40, top: 80, width: 160, height: 48 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
    bodyText: '使用 ChatGPT 登录到 Codex 继续',
    waitForElementImpl(selector) {
      if (selector.includes('button[type="submit"]')) {
        return Promise.resolve(continueButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'STEP8_TRY_SUBMIT', source: 'background', payload: {} },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.equal(response?.usedFallbackSubmit, true);
  assert.equal(response?.submitMethod, 'requestSubmit');
  assert.equal(requestSubmitCalls, 1);
});

test('step 4 does not report success when the verification form stays visible with a disabled continue button', async () => {
  const state = {
    inputVisible: true,
  };

  const codeInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
    form: null,
  };

  const continueButton = {
    textContent: '继续',
    disabled: true,
    getAttribute(name) {
      return name === 'aria-disabled' ? 'true' : null;
    },
    dispatchEvent() {},
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送的验证码',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector.includes('input[name="code"]') && state.inputVisible) {
        return [codeInput];
      }
      return [];
    },
  });
  context.fillInput = () => {};
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 4, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.match(response?.error || '', /verification form stayed visible after submit attempts/i);
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 4,
      message: response.error,
    },
  ]);
});

test('step 4 still succeeds when the verification form auto-submits before the continue button becomes clickable', async () => {
  const state = {
    inputVisible: true,
    sleepCalls: 0,
  };

  const codeInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
    form: null,
  };

  const continueButton = {
    textContent: '继续',
    disabled: true,
    getAttribute(name) {
      return name === 'aria-disabled' ? 'true' : null;
    },
    dispatchEvent() {},
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送的验证码',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector.includes('input[name="code"]') && state.inputVisible) {
        return [codeInput];
      }
      return [];
    },
  });
  context.fillInput = () => {};
  context.sleep = () => {
    state.sleepCalls += 1;
    if (state.sleepCalls >= 2) {
      state.inputVisible = false;
      context.document.body.innerText = 'Welcome';
    }
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 4, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 4);
});

test('step 4 waits through delayed verification acceptance before failing the run', async () => {
  let fakeNow = 0;
  const codeInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
    form: null,
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送的验证码',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return null;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector.includes('input[name="code"]') && fakeNow < 12000) {
        return [codeInput];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    if (fakeNow >= 12000) {
      context.document.body.innerText = 'Welcome';
    }
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 4, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 4);
});

test('step 4 tolerates slower delayed acceptance when the continue button stays disabled', async () => {
  let fakeNow = 0;
  const codeInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
    form: null,
  };

  const continueButton = {
    textContent: '继续',
    disabled: true,
    getAttribute(name) {
      return name === 'aria-disabled' ? 'true' : null;
    },
    dispatchEvent() {},
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送的验证码',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector.includes('input[name="code"]') && fakeNow < 24000) {
        return [codeInput];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    if (fakeNow >= 24000) {
      context.document.body.innerText = 'Welcome';
    }
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 4, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 4);
});

test('step 4 succeeds when the page switches to the profile form on the same url', async () => {
  let fakeNow = 0;
  const codeInput = {
    inputMode: 'numeric',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
    form: null,
  };
  const ageInput = {
    inputMode: 'numeric',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };
  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送的验证码',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl() {
      return null;
    },
    querySelectorAllImpl(selector) {
      const profileVisible = fakeNow >= 1000;
      if (selector === 'input[name="code"]') {
        return profileVisible ? [] : [codeInput];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return profileVisible ? [ageInput] : [codeInput];
      }
      if (selector === 'input[name="name"]') {
        return profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    if (fakeNow >= 1000) {
      context.document.body.innerText = 'Create your account';
    }
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 4, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 4);
});

test('step 4 succeeds when the page already reached about-you before the profile copy becomes stable', async () => {
  let fakeNow = 0;
  const codeInput = {
    inputMode: 'numeric',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };
  const submitButton = {
    textContent: '继续',
    disabled: false,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const ageInput = {
    inputMode: 'numeric',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };
  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送的验证码',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      const onAboutYou = /about-you/i.test(context.location.href);
      if (selector === 'input[name="code"]') {
        return onAboutYou ? [] : [codeInput];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return onAboutYou ? [ageInput] : [codeInput];
      }
      if (selector === 'input[name="name"]') {
        return onAboutYou ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return onAboutYou ? [ageInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    return Promise.resolve();
  };
  context.simulateClick = (target) => {
    if (target === submitButton) {
      context.location.href = 'https://auth.openai.com/about-you';
      context.document.body.innerText = '检查您的收件箱 输入我们刚刚发送的验证码';
    }
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 4, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 4);
});

test('step 4 succeeds on about-you when the profile form only exposes placeholder-based name and birthday fields', async () => {
  let fakeNow = 0;
  const codeInput = {
    inputMode: 'numeric',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };
  const submitButton = {
    textContent: '继续',
    disabled: false,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const placeholderNameInput = {
    placeholder: '全名',
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
  };
  const birthdayInput = {
    inputMode: 'numeric',
    placeholder: '生日日期',
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送的验证码',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      const onAboutYou = /about-you/i.test(context.location.href);
      if (selector === 'input[name="code"]') {
        return onAboutYou ? [] : [codeInput];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return onAboutYou ? [birthdayInput] : [codeInput];
      }
      if (selector === 'input[name="name"]') {
        return [];
      }
      if (selector === 'input[name="age"]') {
        return [];
      }
      if (selector === 'input[name="birthday"]') {
        return [];
      }
      if (selector.includes('input[placeholder*="全名"]')) {
        return onAboutYou ? [placeholderNameInput] : [];
      }
      if (selector.includes('input[placeholder*="生日"]')) {
        return onAboutYou ? [birthdayInput] : [];
      }
      if (selector.includes('input[placeholder*="日期"]')) {
        return onAboutYou ? [birthdayInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    return Promise.resolve();
  };
  context.simulateClick = (target) => {
    if (target === submitButton) {
      context.location.href = 'https://auth.openai.com/about-you';
      context.document.body.innerText = '确认一下你的年龄 这有助于我们根据隐私政策个性化你的使用体验并提供适合的设置 全名 生日日期 点击“继续”，即表示您同意我们的条款并已阅读我们的隐私政策。';
    }
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 4, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 4);
});

test('step 4 accepts a fast about-you redirect even when the page only exposes a numeric age field at first', async () => {
  let fakeNow = 0;
  const codeInput = {
    inputMode: 'numeric',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };
  const submitButton = {
    textContent: '继续',
    disabled: false,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 160, height: 44 };
    },
  };
  const ageOnlyInput = {
    inputMode: 'numeric',
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/email-verification',
    bodyText: '检查您的收件箱 输入我们刚刚发送的验证码',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="code"]')) {
        return Promise.resolve(codeInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      const onAboutYou = /about-you/i.test(context.location.href);
      if (selector === 'input[name="code"]') {
        return onAboutYou ? [] : [codeInput];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return onAboutYou ? [ageOnlyInput] : [codeInput];
      }
      if (selector === 'input[name="name"]') {
        return [];
      }
      if (selector === 'input[name="age"]') {
        return [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    return Promise.resolve();
  };
  context.simulateClick = (target) => {
    if (target === submitButton) {
      context.location.href = 'https://auth.openai.com/about-you';
      context.document.body.innerText = '你的年龄是多少？ 年龄';
    }
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'FILL_CODE', step: 4, payload: { code: '123456' } },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 4);
});

test('step 5 completes and lets the flow continue when the profile form never appears after verification', async () => {
  const context = createContext({
    href: 'https://auth.openai.com/u/signup/continue',
    bodyText: 'Welcome back',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.reject(new Error('missing'));
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
  });
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__completions)),
    [
      {
        step: 5,
        payload: {
          skippedProfileForm: true,
          reason: 'missing_name_input',
        },
      },
    ]
  );
});

test('step 5 fills the welcome-create full name field when the page uses an English name placeholder', async () => {
  const state = {
    profileVisible: true,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: 'Continue',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };

  const fills = [];

  const context = createContext({
    href: 'https://platform.openai.com/welcome?step=create',
    bodyText: 'Create your account',
    waitForElementImpl(selector) {
      if (selector.includes('input[placeholder*="name" i]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (!state.profileVisible) {
        return [];
      }
      if (
        selector === 'input[name="name"]'
        || selector === 'input[name="name"], input[name="full_name"], input[placeholder*="全名"], input[placeholder*="name" i], input[autocomplete="name"], input[id*="name" i]:not([type="hidden"])'
        || selector === 'input[name="name"], input[name="age"], input[name="birthday"], [role="spinbutton"][data-type="year"], [role="spinbutton"][data-type="month"], [role="spinbutton"][data-type="day"]'
      ) {
        return [nameInput, ageInput];
      }
      return [];
    },
  });
  context.fillInput = (input, value) => {
    fills.push({ input, value: String(value) });
  };
  context.simulateClick = () => {
    state.profileVisible = false;
    context.document.body.innerText = 'Welcome';
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 5);
  assert.equal(
    fills.some((entry) => entry.input === nameInput && entry.value === 'Logan Lee'),
    true
  );
});

test('step 5 treats the welcome-create landing without birthday or age inputs as an already-completed post-profile page', async () => {
  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const fills = [];

  const context = createContext({
    href: 'https://platform.openai.com/welcome?step=create',
    bodyText: 'Create your account Welcome',
    waitForElementImpl(selector) {
      if (selector.includes('input[placeholder*="name" i]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl() {
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"], input[name="age"], input[name="birthday"], [role="spinbutton"][data-type="year"], [role="spinbutton"][data-type="month"], [role="spinbutton"][data-type="day"]') {
        return [nameInput];
      }
      return [];
    },
  });
  context.fillInput = (input, value) => {
    fills.push({ input, value: String(value) });
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 5);
  assert.equal(fills.length, 0);
});

test('step 5 does not report success when the profile form disappears but the page still looks like about-you', async () => {
  let fakeNow = 0;
  const state = {
    profileVisible: true,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: '完成帐户创建',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 点击“完成帐户创建”，即表示你同意我们的条款并已阅读我们的隐私政策。 完成帐户创建',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    return Promise.resolve();
  };
  context.simulateClick = () => {
    state.profileVisible = false;
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.match(response?.error || '', /profile submit did not reach a stable next page/i);
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 5,
      message: response.error,
    },
  ]);
});

test('step 5 does not treat the about-you primary button styling as an oauth consent success signal before submit', async () => {
  let fakeNow = 0;

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const styledPrimaryButton = {
    className: '_primary_3rdp0_107',
    textContent: '',
    getAttribute() {
      return null;
    },
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 点击“完成帐户创建”，即表示你同意我们的条款并已阅读我们的隐私政策。',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]') {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return null;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return [nameInput];
      }
      if (selector === 'input[name="age"]') {
        return [ageInput];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return [ageInput];
      }
      if (selector === 'button, [role="button"], input[type="submit"]') {
        return [styledPrimaryButton];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.match(response?.error || '', /submit button did not appear|stable next page/i);
  assert.deepEqual(context.__completions, []);
});

test('step 5 succeeds after profile submit when the page reaches the oauth consent continue button', async () => {
  const state = {
    profileVisible: true,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: '完成帐户创建',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const continueButton = {
    textContent: '继续',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 完成帐户创建',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl(selector, pattern) {
      if (selector === 'button' && /继续|Continue/.test(String(pattern)) && !state.profileVisible) {
        return Promise.resolve(continueButton);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return state.profileVisible ? submitButton : continueButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.fillInput = () => {};
  context.simulateClick = (target) => {
    if (target === submitButton) {
      state.profileVisible = false;
      context.document.body.innerText = '使用 ChatGPT 登录到 Codex 继续';
      return;
    }
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 5);
});

test('step 5 fails the round when profile submit lands on unsupported-email before the page copy becomes visible', async () => {
  const UnsupportedEmail = require('../shared/unsupported-email.js');
  const state = {
    profileVisible: true,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: '完成帐户创建',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 完成帐户创建',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.UnsupportedEmail = UnsupportedEmail;
  context.fillInput = () => {};
  context.simulateClick = () => {
    state.profileVisible = false;
    context.location.href = 'https://auth.openai.com/unsupported-email';
    context.document.body.innerText = '';
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(
    response?.error,
    'Step 5 blocked: email domain is unsupported on the auth page.'
  );
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 5,
      message: 'Step 5 blocked: email domain is unsupported on the auth page.',
    },
  ]);
});

test('step 5 does not report success when unsupported_email appears shortly after the profile form disappears on about-you', async () => {
  let fakeNow = 0;
  const UnsupportedEmail = require('../shared/unsupported-email.js');
  const state = {
    profileVisible: true,
    errorVisible: false,
    clickAt: null,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: '完成帐户创建',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 完成帐户创建',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.UnsupportedEmail = UnsupportedEmail;
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    if (!state.errorVisible && state.clickAt != null && fakeNow - state.clickAt >= 2200) {
      state.errorVisible = true;
      context.document.body.innerText = '糟糕，出错了！ 验证过程中出错 (unsupported_email)。请重试。';
    }
    return Promise.resolve();
  };
  context.simulateClick = () => {
    state.clickAt = fakeNow;
    state.profileVisible = false;
    context.document.body.innerText = '';
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(
    response?.error,
    'Step 5 blocked: email domain is unsupported on the auth page.'
  );
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 5,
      message: 'Step 5 blocked: email domain is unsupported on the auth page.',
    },
  ]);
});

test('step 5 does not report success when unsupported_email appears several seconds after submit on about-you', async () => {
  let fakeNow = 0;
  const UnsupportedEmail = require('../shared/unsupported-email.js');
  const state = {
    profileVisible: true,
    errorVisible: false,
    clickAt: null,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: '完成帐户创建',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 完成帐户创建',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.UnsupportedEmail = UnsupportedEmail;
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    if (!state.errorVisible && state.clickAt != null && fakeNow - state.clickAt >= 4200) {
      state.errorVisible = true;
      context.document.body.innerText = '糟糕，出错了！ 验证过程中出错 (unsupported_email)。请重试。';
    }
    return Promise.resolve();
  };
  context.simulateClick = () => {
    state.clickAt = fakeNow;
    state.profileVisible = false;
    context.document.body.innerText = '';
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(
    response?.error,
    'Step 5 blocked: email domain is unsupported on the auth page.'
  );
  assert.deepEqual(context.__completions, []);
});

test('step 5 does not report success when the page stays blank on about-you after submit', async () => {
  let fakeNow = 0;
  const state = {
    profileVisible: true,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: '完成帐户创建',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 完成帐户创建',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    return Promise.resolve();
  };
  context.simulateClick = () => {
    state.profileVisible = false;
    context.document.body.innerText = '';
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.match(response?.error || '', /profile submit did not reach a stable next page/i);
  assert.deepEqual(context.__completions, []);
});

test('step 5 succeeds when submit redirects to the platform auth callback url', async () => {
  const state = {
    profileVisible: true,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: '完成帐户创建',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 完成帐户创建',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.fillInput = () => {};
  context.simulateClick = () => {
    state.profileVisible = false;
    context.location.href = 'https://platform.openai.com/auth/callback?code=abc&scope=openid&state=xyz';
    context.document.body.innerText = '';
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 5);
});

test('step 5 waits for a slower auth callback redirect before reporting success', async () => {
  let fakeNow = 0;
  const state = {
    profileVisible: true,
    clickAt: null,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const submitButton = {
    textContent: '完成帐户创建',
    dispatchEvent() {},
    getBoundingClientRect() {
      return { width: 140, height: 40 };
    },
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄 完成帐户创建',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return state.profileVisible ? submitButton : null;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    if (state.clickAt != null && fakeNow - state.clickAt >= 8500) {
      context.location.href = 'https://platform.openai.com/auth/callback?code=slow&scope=openid&state=late';
    }
    return Promise.resolve();
  };
  context.simulateClick = () => {
    state.clickAt = fakeNow;
    state.profileVisible = false;
    context.document.body.innerText = '';
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.equal(context.__completions.length, 1);
  assert.equal(context.__completions[0].step, 5);
});

test('step 5 confirms the recovered post-profile url on a second check before skipping the profile form', async () => {
  let fakeNow = 0;
  const state = {
    switchedToLanding: false,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '全名',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return null;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return [nameInput];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    if (!state.switchedToLanding && fakeNow >= 1000) {
      state.switchedToLanding = true;
      context.location.href = 'https://platform.openai.com/welcome?step=create';
      context.document.body.innerText = '';
    }
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'James',
          lastName: 'Rodriguez',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.equal(context.__completions.length, 1);
  assert.ok(fakeNow < 3000, `expected recovered landing detection to avoid the old 10s wait, got ${fakeNow}ms`);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__completions[0])), {
    step: 5,
    payload: {
      recoveredAfterNavigation: true,
      skippedProfileForm: true,
      reason: 'stable_post_profile_landing_without_birthday_input',
    },
  });
});

test('step 5 also skips quickly when the stable landing url appears before the name input shows up', async () => {
  let fakeNow = 0;
  let switchedToLanding = false;

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '正在跳转',
    waitForElementImpl() {
      return Promise.reject(new Error('missing'));
    },
    querySelectorImpl() {
      return null;
    },
    querySelectorAllImpl() {
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    if (!switchedToLanding && fakeNow >= 1000) {
      switchedToLanding = true;
      context.location.href = 'https://platform.openai.com/welcome?step=create';
      context.document.body.innerText = '';
    }
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'John',
          lastName: 'Martin',
          year: 2002,
          month: 2,
          day: 5,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.equal(response?.ok, true);
  assert.ok(fakeNow < 3000, `expected stable landing to short-circuit the name-input wait, got ${fakeNow}ms`);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__completions)), [
    {
      step: 5,
      payload: {
        recoveredAfterNavigation: true,
        skippedProfileForm: true,
        reason: 'stable_post_profile_landing_without_name_input',
      },
    },
  ]);
});

test('step 5 does not skip the profile form when the recovered page still never reaches a stable success url', async () => {
  let fakeNow = 0;

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '全名',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    querySelectorImpl(selector) {
      if (selector === 'button[type="submit"]') {
        return null;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return [nameInput];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'James',
          lastName: 'Rodriguez',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.match(response?.error || '', /Could not find birthday or age input|submit button did not appear|stable next page/i);
  assert.equal(context.__completions.length, 0);
});

test('step 5 does not report success when the submit button never appears and the page stays on about-you', async () => {
  let fakeNow = 0;
  const state = {
    profileVisible: true,
  };

  const nameInput = {
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const ageInput = {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    dispatchEvent() {},
    focus() {},
  };

  const context = createContext({
    href: 'https://auth.openai.com/about-you',
    bodyText: '你的年龄是多少？ 全名 年龄',
    waitForElementImpl(selector) {
      if (selector.includes('input[name="name"]')) {
        return Promise.resolve(nameInput);
      }
      return Promise.reject(new Error(`missing: ${selector}`));
    },
    waitForElementByTextImpl() {
      return Promise.reject(new Error('missing'));
    },
    querySelectorImpl(selector) {
      if (selector === 'input[name="age"]' && state.profileVisible) {
        return ageInput;
      }
      if (selector === 'button[type="submit"]') {
        return null;
      }
      return null;
    },
    querySelectorAllImpl(selector) {
      if (selector === 'input[name="name"]') {
        return state.profileVisible ? [nameInput] : [];
      }
      if (selector === 'input[name="age"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      if (selector === 'input[inputmode="numeric"]') {
        return state.profileVisible ? [ageInput] : [];
      }
      return [];
    },
  });
  context.Date = class extends Date {
    static now() {
      return fakeNow;
    }
  };
  context.fillInput = () => {};
  context.sleep = (ms = 0) => {
    fakeNow += Math.max(1, Number(ms) || 0);
    return Promise.resolve();
  };
  loadSignupPage(context);

  const listener = context.__listeners[0];
  assert.ok(listener, 'expected signup-page to register a runtime listener');

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: 'EXECUTE_STEP',
        step: 5,
        payload: {
          firstName: 'Logan',
          lastName: 'Lee',
          year: 1995,
          month: 8,
          day: 21,
        },
      },
      {},
      (result) => resolve(result)
    );
    assert.equal(keepAlive, true);
    setTimeout(() => reject(new Error('timeout waiting for response')), 3000);
  });

  assert.match(response?.error || '', /submit button did not appear|stable next page/i);
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 5,
      message: response.error,
    },
  ]);
});
