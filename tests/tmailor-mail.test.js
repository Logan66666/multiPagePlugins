const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createContext() {
  const listeners = [];
  const state = {
    bodyText: 'OpenAI verification code is ******',
    sleepCalls: 0,
    clicked: 0,
    lastClicked: null,
    logs: [],
  };

  const context = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    location: { href: 'https://tmailor.com/' },
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          state.runtimeMessages = state.runtimeMessages || [];
          state.runtimeMessages.push(message);
          const response = { ok: true };
          if (typeof callback === 'function') {
            callback(response);
          }
          return Promise.resolve(response);
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
      },
    },
    LatestMail: {
      findLatestMatchingItem(items, predicate) {
        for (const item of items) {
          if (predicate(item)) return item;
        }
        return null;
      },
    },
    MailMatching: {
      getStepMailMatchProfile() {
        return null;
      },
      matchesSubjectPatterns() {
        return false;
      },
      normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
      },
    },
    MailFreshness: {
      isMailFresh() {
        return true;
      },
      parseMailTimestampCandidates() {
        return Date.now();
      },
    },
    resetStopState() {},
    isStopError() {
      return false;
    },
    throwIfStopped() {},
    log(message, level = 'info') {
      state.logs.push({ message, level });
    },
    reportError() {},
    sleep: async () => {
      state.sleepCalls += 1;
      if (state.sleepCalls === 2) {
        state.bodyText = 'OpenAI verification code is 123456';
      }
    },
    simulateClick(target) {
      state.clicked += 1;
      state.lastClicked = target;
    },
    document: null,
    Date,
    setTimeout,
    clearTimeout,
  };

  context.document = {
    body: {
      get innerText() {
        return state.bodyText;
      },
      set innerText(value) {
        state.bodyText = value;
      },
    },
    contains() {
      return true;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  context.window = context;
  context.top = context;
  context.getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
  });
  context.__state = state;
  context.__listeners = listeners;
  return context;
}

function loadTmailorScript(context) {
  const scriptPath = path.join(__dirname, '..', 'content', 'tmailor-mail.js');
  const code = fs.readFileSync(scriptPath, 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context, { filename: scriptPath });
}

test('tmailor opens the mail detail when the list preview masks the verification code', async () => {
  const context = createContext();
  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.readCodeFromMailRow, 'expected tmailor test hooks to expose readCodeFromMailRow');

  const row = {
    combinedText: 'OpenAI verification code is ******',
    element: {
      getAttribute() {
        return null;
      },
      getBoundingClientRect() {
        return { width: 120, height: 24 };
      },
      textContent: 'OpenAI verification code is ******',
    },
  };

  const code = await hooks.readCodeFromMailRow(row);

  assert.equal(code, '123456');
  assert.equal(context.__state.clicked, 1);
});

test('tmailor prefers the nested email detail link when opening a mailbox row', async () => {
  const context = createContext();
  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.clickMailRow, 'expected tmailor test hooks to expose clickMailRow');

  const detailLink = {
    matches(selector) {
      return selector === 'a[href*="emailid="]';
    },
    getBoundingClientRect() {
      return { width: 80, height: 18 };
    },
  };

  const row = {
    element: {
      querySelector(selector) {
        return selector.includes('a[href*="emailid="]') ? detailLink : null;
      },
      getBoundingClientRect() {
        return { width: 120, height: 24 };
      },
    },
  };

  await hooks.clickMailRow(row);

  assert.equal(context.__state.clicked, 1);
  assert.equal(context.__state.lastClicked, detailLink);
});

test('tmailor extracts the verification code from stable detail selectors before falling back to body text', () => {
  const context = createContext();
  context.document.querySelector = (selector) => {
    if (selector === 'h1') {
      return { textContent: '你的 ChatGPT 代码为 344928' };
    }
    if (selector === '#bodyCell') {
      return {
        textContent: '输入此临时验证码以继续：344928 如果并非你本人尝试创建 ChatGPT 帐户，请忽略此电子邮件。',
      };
    }
    return null;
  };
  context.document.body.innerText = 'masked ******';

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.findCodeInPageText, 'expected tmailor test hooks to expose findCodeInPageText');

  assert.equal(hooks.findCodeInPageText(), '344928');
});

test('tmailor can return the code directly when the mailbox is already on the email detail page', async () => {
  const context = createContext();
  context.location.href = 'https://tmailor.com/inbox?emailid=7409508e-a0c4-4c26-8e80-41f92d283225';
  context.document.querySelector = (selector) => {
    if (selector === 'h1') {
      return { textContent: '你的 ChatGPT 代码为 344928' };
    }
    if (selector === '#bodyCell') {
      return { textContent: '输入此临时验证码以继续：344928' };
    }
    return null;
  };
  context.MailMatching.getStepMailMatchProfile = () => ({
    include: [/你的\s*chatgpt\s*代码为/i],
    exclude: [],
  });
  context.MailMatching.matchesSubjectPatterns = (text, profile) => {
    return profile.include.some((pattern) => pattern.test(String(text || '')));
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.readCodeFromCurrentDetailPage, 'expected tmailor test hooks to expose readCodeFromCurrentDetailPage');

  const result = hooks.readCodeFromCurrentDetailPage(4, {
    senderFilters: ['openai', 'noreply'],
    subjectFilters: ['验证', 'code'],
    targetEmail: 'abc123@mikrotikvn.com',
  });

  assert.equal(result.code, '344928');
  assert.equal(result.emailTimestamp, 0);
  assert.equal(result.mailId, 'https://tmailor.com/inbox?emailid=7409508e-a0c4-4c26-8e80-41f92d283225');
});

test('tmailor can open an already visible matching inbox row on the first attempt instead of waiting for refresh-only fallback', async () => {
  const context = createContext();
  context.MailMatching.getStepMailMatchProfile = () => ({
    include: [/你的\s*chatgpt\s*代码为/i],
    exclude: [],
  });
  context.MailMatching.matchesSubjectPatterns = (text, profile) => {
    return profile.include.some((pattern) => pattern.test(String(text || '')));
  };

  const mailRow = {
    tagName: 'TR',
    textContent: 'OpenAI\n你的 ChatGPT 代码为 ******\n刚刚',
    getAttribute(name) {
      if (name === 'data-id') return 'mail-row-1';
      return null;
    },
    querySelector(selector) {
      if (selector.includes('a[href*="emailid="]')) {
        return null;
      }
      return null;
    },
    getBoundingClientRect() {
      return { width: 240, height: 44 };
    },
  };

  let queryCount = 0;
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [{ textContent: 'Refresh', getBoundingClientRect() { return { width: 80, height: 24 }; } }];
    }
    if (selector === 'tr') {
      queryCount += 1;
      return [mailRow];
    }
    return [];
  };
  context.document.querySelector = (selector) => {
    if (selector === 'h1') {
      return queryCount > 1 ? { textContent: '你的 ChatGPT 代码为 223344' } : null;
    }
    if (selector === '#bodyCell') {
      return queryCount > 1 ? { textContent: '输入此临时验证码以继续：223344' } : null;
    }
    return null;
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.handlePollEmail, 'expected tmailor test hooks to expose handlePollEmail');

  const result = await hooks.handlePollEmail(4, {
    subjectFilters: ['验证', 'code'],
    senderFilters: ['openai'],
    targetEmail: 'abc123@mikfarm.com',
    maxAttempts: 1,
    intervalMs: 0,
    filterAfterTimestamp: 0,
  });

  assert.equal(result.code, '223344');
  assert.equal(context.__state.clicked, 1);
});

test('tmailor waits for Cloudflare confirm when the verification page appears', async () => {
  const context = createContext();
  context.document.body.innerText = 'Please verify that you are not a robot.';
  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    getBoundingClientRect() {
      return { width: 80, height: 24 };
    },
  };
  let challengeVisible = true;
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [confirmButton];
    }
    return [];
  };
  context.sleep = async () => {
    if (challengeVisible) {
      challengeVisible = false;
      context.document.body.innerText = '';
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm();

  assert.equal(handled, true);
  assert.equal(context.__state.clicked, 1);
  assert.equal(context.__state.lastClicked?.id, 'btnNewEmailForm');
});

test('tmailor does not trust an enabled Confirm button while the Cloudflare challenge is still visible', async () => {
  const context = createContext();
  context.document.body.innerText = 'Please verify that you are not a robot.';
  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute() {
      return 'false';
    },
    getBoundingClientRect() {
      return { width: 80, height: 24 };
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [confirmButton];
    }
    return [];
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(800);

  assert.equal(handled, false);
  assert.equal(context.__state.clicked, 0);
  assert.ok(
    context.__state.logs.some((entry) => /Confirm button looks clickable before challenge clears/i.test(entry.message)),
    'expected a premature confirm warning log'
  );
});

test('tmailor waits for the challenge checkbox before clicking Confirm', async () => {
  const context = createContext();
  context.document.body.innerText = 'Please verify that you are not a robot.';
  let challengeVisible = true;

  const checkboxFrame = {
    tagName: 'IFRAME',
    src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/123',
    title: 'Widget containing a Cloudflare security challenge',
    getBoundingClientRect() {
      return { left: 120, top: 240, width: 280, height: 80 };
    },
  };

  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: true,
    getAttribute(name) {
      if (name === 'aria-disabled') {
        return this.disabled ? 'true' : 'false';
      }
      return null;
    },
    getBoundingClientRect() {
      return { width: 80, height: 24 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector.includes('iframe[src*="challenges.cloudflare.com"]')) {
      return checkboxFrame;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [confirmButton];
    }
    return [];
  };
  context.chrome.runtime.sendMessage = (message, callback) => {
    context.__state.runtimeMessages = context.__state.runtimeMessages || [];
    context.__state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      confirmButton.disabled = false;
      challengeVisible = false;
      context.document.body.innerText = '';
    }
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm();

  assert.equal(handled, true);
  assert.equal(context.__state.runtimeMessages?.[0]?.type, 'DEBUGGER_CLICK_AT');
  assert.equal(context.__state.runtimeMessages?.[0]?.payload?.rect?.centerX, 260);
  assert.equal(context.__state.runtimeMessages?.[0]?.payload?.rect?.centerY, 280);
  assert.equal(context.__state.clicked, 1);
  assert.equal(context.__state.lastClicked?.id, 'btnNewEmailForm');
  assert.ok(
    context.__state.logs.some((entry) => /Cloudflare challenge detected/i.test(entry.message)),
    'expected a Cloudflare challenge log'
  );
  assert.ok(
    context.__state.logs.some((entry) => /Cloudflare checkbox detected/i.test(entry.message)),
    'expected a checkbox click log'
  );
  assert.ok(
    context.__state.logs.some((entry) => /clicking Confirm/i.test(entry.message)),
    'expected a confirm click log'
  );
});

test('tmailor closes blocking ads before continuing mailbox actions', async () => {
  const context = createContext();
  const closeButton = {
    tagName: 'BUTTON',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 88, height: 28 };
    },
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      if (context.__state.clicked > 0) {
        return [];
      }
      return [closeButton];
    }
    return [];
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.dismissBlockingOverlay, 'expected tmailor to expose dismissBlockingOverlay');

  const handled = await hooks.dismissBlockingOverlay();

  assert.equal(handled, true);
  assert.equal(context.__state.clicked, 1);
  assert.equal(context.__state.lastClicked?.textContent, 'Close');
  assert.ok(
    context.__state.logs.some((entry) => /Blocking overlay detected, clicking Close/i.test(entry.message)),
    'expected an overlay click log'
  );
  assert.ok(
    context.__state.logs.some((entry) => /Blocking overlay closed successfully/i.test(entry.message)),
    'expected an overlay success log'
  );
});

test('tmailor ignores the google side-rail notification close control', async () => {
  const context = createContext();
  const googleCloseButton = {
    tagName: 'BUTTON',
    textContent: 'Close',
    closest(selector) {
      if (selector === '#google-anno-sa, [id^="google-anno-"]') {
        return { id: 'google-anno-sa' };
      }
      return null;
    },
    getBoundingClientRect() {
      return { width: 88, height: 28 };
    },
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [googleCloseButton];
    }
    return [];
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.dismissBlockingOverlay, 'expected tmailor to expose dismissBlockingOverlay');

  const handled = await hooks.dismissBlockingOverlay(50);

  assert.equal(handled, false);
  assert.equal(context.__state.clicked, 0);
  assert.equal(context.__state.lastClicked, null);
});

test('tmailor detects fatal server errors and suggests changing node', async () => {
  const context = createContext();
  context.document.body.innerText = 'An error occurred on the server. Please try again later';
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.assertNoFatalMailboxError, 'expected tmailor to expose assertNoFatalMailboxError');

  assert.throws(
    () => hooks.assertNoFatalMailboxError(),
    /TMailor server error detected while refreshing the mailbox\. Please change node and retry\./i
  );
});
