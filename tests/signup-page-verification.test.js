const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AuthFatalErrors = require('../shared/auth-fatal-errors.js');

function createContext({
  href = 'https://auth.openai.com/email-verification',
  bodyText = '',
  waitForElementImpl,
  waitForElementByTextImpl,
  querySelectorImpl,
  querySelectorAllImpl,
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
    Date,
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
        reportCompleteImpl(step, payload);
      }
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
  const scriptPath = path.join(__dirname, '..', 'content', 'signup-page.js');
  const code = fs.readFileSync(scriptPath, 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context, { filename: scriptPath });
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
    'Step 7 blocked: phone number is required on the auth page. Please change node and retry.'
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

test('step 2 completes immediately when the auth log-in page is already showing the email form', async () => {
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

  assert.equal(response?.ok, true);
  assert.deepEqual(context.__errors, []);
  assert.deepEqual(context.__completions, [
    {
      step: 2,
      payload: undefined,
    },
  ]);
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
    href: 'https://platform.openai.com/login',
    bodyText: 'Build on the OpenAI API Platform',
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
      context.location.href = 'https://platform.openai.com/login/password';
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

test('step 3 fills the password before the first continue click when the password field is already visible', async () => {
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
    href: 'https://platform.openai.com/login',
    bodyText: '创建密码 继续',
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
  context.fillInput = (_target, value) => {
    filledValues.push(value);
  };
  context.simulateClick = (target) => {
    clickedTargets.push(target);
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
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /auth\.openai\.com\/log-in/i.test(context.location.href)) {
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
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /auth\.openai\.com\/log-in/i.test(context.location.href)) {
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
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /auth\.openai\.com\/log-in/i.test(context.location.href)) {
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
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /auth\.openai\.com\/log-in/i.test(context.location.href)) {
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
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /auth\.openai\.com\/log-in/i.test(context.location.href)) {
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
      if (/sign\s*up|register|create\s*account|注册/i.test(String(pattern)) && /auth\.openai\.com\/log-in/i.test(context.location.href)) {
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
  assert.deepEqual(context.__completions, []);
  assert.deepEqual(context.__errors, [
    {
      step: 6,
      message: response.error,
    },
  ]);
});


test('step 6 reports the latest page oauth url when it differs from the saved panel value', async () => {
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
    if (message?.type === 'GET_STATE') {
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
    runtimeMessages.some((message) => message?.type === 'GET_STATE'),
    'expected step 6 to read the saved oauth url before deciding whether to override it'
  );
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
