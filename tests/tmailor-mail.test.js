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
    historyBackCalls: 0,
  };

  const context = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    location: { href: 'https://tmailor.com/' },
    history: {
      back() {
        state.historyBackCalls += 1;
      },
    },
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

test('tmailor clears a blocking interstitial ad while waiting for the code on the mail detail page', async () => {
  const context = createContext();
  const state = context.__state;
  state.detailCodeVisible = false;
  state.interstitialVisible = true;

  const adBox = {
    id: 'ad_position_box',
    getBoundingClientRect() {
      return { width: 480, height: 320 };
    },
  };
  const dismissClose = {
    tagName: 'DIV',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 80, height: 30 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === '#ad_position_box') {
      return state.interstitialVisible ? adBox : null;
    }
    if (selector === '#dismiss-button-element > div') {
      return state.interstitialVisible ? dismissClose : null;
    }
    if (selector === 'h1') {
      return state.detailCodeVisible ? { textContent: 'OpenAI verification code is 654321' } : null;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return state.interstitialVisible ? [dismissClose] : [];
    }
    return [];
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === dismissClose) {
      state.interstitialVisible = false;
      state.detailCodeVisible = true;
    }
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCodeInPage, 'expected tmailor test hooks to expose waitForCodeInPage');

  const code = await hooks.waitForCodeInPage(1200, 50);

  assert.equal(code, '654321');
  assert.equal(state.lastClicked, dismissClose);
});

test('tmailor clears a monetization video ad after opening a mail row before reading the detail code', async () => {
  const context = createContext();
  const state = context.__state;
  state.dialogVisible = false;
  state.adVisible = false;
  state.closeVisible = false;
  state.detailOpened = false;

  const playButton = {
    tagName: 'BUTTON',
    textContent: 'View a short ad',
    getBoundingClientRect() {
      return { width: 120, height: 36 };
    },
  };
  const monetizationDialog = {
    getBoundingClientRect() {
      return { width: 480, height: 320 };
    },
  };
  const adCloseButton = {
    tagName: 'DIV',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 80, height: 30 };
    },
  };
  const rowTarget = {
    getBoundingClientRect() {
      return { width: 120, height: 24 };
    },
  };

  const row = {
    combinedText: 'OpenAI verification code is ******',
    element: rowTarget,
  };

  context.document.querySelector = (selector) => {
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog') {
      return state.dialogVisible ? monetizationDialog : null;
    }
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog > div > div.fc-list-container > button') {
      return state.dialogVisible ? playButton : null;
    }
    if (selector === '#dismiss-button-element > div') {
      return state.adVisible && state.closeVisible ? adCloseButton : null;
    }
    if (selector === 'h1') {
      return state.detailOpened && !state.dialogVisible && !state.adVisible
        ? { textContent: 'OpenAI verification code is 112233' }
        : null;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      if (state.dialogVisible) return [playButton];
      if (state.adVisible && state.closeVisible) return [adCloseButton];
      return [];
    }
    return [];
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === rowTarget) {
      state.detailOpened = true;
      state.dialogVisible = true;
    }
    if (target === playButton) {
      state.dialogVisible = false;
      state.adVisible = true;
    }
    if (target === adCloseButton) {
      state.adVisible = false;
      state.closeVisible = false;
    }
  };
  context.sleep = async () => {
    state.sleepCalls += 1;
    if (state.adVisible && state.sleepCalls >= 2) {
      state.closeVisible = true;
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.readCodeFromMailRow, 'expected tmailor test hooks to expose readCodeFromMailRow');

  const code = await hooks.readCodeFromMailRow(row);

  assert.equal(code, '112233');
  assert.equal(state.clicked, 3);
  assert.equal(state.lastClicked, adCloseButton);
  assert.ok(
    state.logs.some((entry) => /Monetization video ad overlay detected, clicking Play/i.test(entry.message)),
    'expected a detail-page monetization play log'
  );
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

test('tmailor preserves sender and subject lines when parsing a multiline inbox row', () => {
  const context = createContext();
  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.parseMailRow, 'expected tmailor test hooks to expose parseMailRow');

  const rowElement = {
    textContent: 'OpenAI\nYour ChatGPT code is ******\n1 minute ago',
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 240, height: 44 };
    },
  };

  const row = hooks.parseMailRow(rowElement, 0);

  assert.equal(row.sender, 'OpenAI');
  assert.equal(row.subject, 'Your ChatGPT code is ******');
});

test('tmailor ignores an outer wrapper when it only contains a real inbox row descendant', () => {
  const context = createContext();
  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.findMailRows, 'expected tmailor test hooks to expose findMailRows');

  const actualRow = {
    tagName: 'TR',
    textContent: 'OpenAI\nYour ChatGPT code is ******\nJust now',
    getAttribute(name) {
      if (name === 'data-mail-id') return 'mail-row-1';
      return null;
    },
    contains() {
      return false;
    },
    getBoundingClientRect() {
      return { width: 260, height: 48 };
    },
  };

  const wrapper = {
    tagName: 'DIV',
    textContent: 'OpenAI\nYour ChatGPT code is ******\nJust now',
    getAttribute(name) {
      if (name === 'data-id') return 'wrapper-1';
      return null;
    },
    contains(node) {
      return node === actualRow;
    },
    getBoundingClientRect() {
      return { width: 280, height: 120 };
    },
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-id]') return [wrapper];
    if (selector === '[data-mail-id]') return [actualRow];
    return [];
  };

  const rows = hooks.findMailRows();

  assert.equal(rows.length, 1);
  assert.equal(rows[0], actualRow);
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

test('tmailor keeps waiting when the mail detail opens successfully but the verification code renders slowly', async () => {
  const context = createContext();
  const state = context.__state;
  state.bodyText = 'OpenAI verification code is ******';
  let now = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  context.document.querySelector = () => null;
  context.sleep = async () => {
    state.sleepCalls += 1;
    now += 250;
    if (state.sleepCalls >= 23) {
      state.bodyText = 'OpenAI verification code is 778899';
    }
  };

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

  assert.equal(code, '778899');
});

test('tmailor keeps the current detail page open after step 4 reads the code', async () => {
  const context = createContext();
  const state = context.__state;
  context.location.href = 'https://tmailor.com/inbox?emailid=detail-123';
  state.bodyText = '你的 ChatGPT 代码为 ******';

  const detailLink = {
    href: 'https://tmailor.com/inbox?emailid=detail-123',
    getBoundingClientRect() {
      return { width: 120, height: 24 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'h1') {
      return { textContent: '你的 ChatGPT 代码为 009087' };
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [];
    }
    return [];
  };
  context.sleep = async () => {};

  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.readCodeFromMailRow, 'expected tmailor test hooks to expose readCodeFromMailRow');

  const row = {
    combinedText: '你的 ChatGPT 代码为 ******',
    element: {
      getAttribute() {
        return null;
      },
      querySelector(selector) {
        if (selector.includes('a[href*="emailid="]')) {
          return detailLink;
        }
        return null;
      },
      getBoundingClientRect() {
        return { width: 120, height: 24 };
      },
      textContent: '你的 ChatGPT 代码为 ******',
    },
  };

  const code = await hooks.readCodeFromMailRow(row, 4);

  assert.equal(code, '009087');
  assert.equal(context.location.href, 'https://tmailor.com/inbox?emailid=detail-123');
  assert.equal(state.historyBackCalls, 0);
});

test('tmailor step 7 reads the code from the mail detail page without navigating home', async () => {
  const context = createContext();
  const state = context.__state;
  context.location.href = 'https://tmailor.com/inbox?emailid=detail-456';
  state.bodyText = 'Your ChatGPT code is ******';

  const detailLink = {
    href: 'https://tmailor.com/inbox?emailid=detail-456',
    getBoundingClientRect() {
      return { width: 120, height: 24 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'h1') {
      return { textContent: 'Your ChatGPT code is 665544' };
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.sleep = async () => {};

  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.readCodeFromMailRow, 'expected tmailor test hooks to expose readCodeFromMailRow');

  const row = {
    combinedText: 'Your ChatGPT code is ******',
    element: {
      getAttribute() {
        return null;
      },
      querySelector(selector) {
        if (selector.includes('a[href*="emailid="]')) {
          return detailLink;
        }
        return null;
      },
      getBoundingClientRect() {
        return { width: 120, height: 24 };
      },
      textContent: 'Your ChatGPT code is ******',
    },
  };

  const code = await hooks.readCodeFromMailRow(row, 7);

  assert.equal(code, '665544');
  assert.equal(context.location.href, 'https://tmailor.com/inbox?emailid=detail-456');
  assert.equal(state.historyBackCalls, 0);
});

test('tmailor step 7 keeps waiting for the detail code after the detail url appears', async () => {
  const context = createContext();
  const sleepCalls = [];
  let detailOpened = false;

  context.location.href = 'https://tmailor.com/';
  context.document.querySelector = (selector) => {
    if (selector === 'h1' && detailOpened) {
      return { textContent: 'Your ChatGPT code is 443322' };
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.sleep = async (ms = 0) => {
    sleepCalls.push(ms);
    if (!detailOpened && sleepCalls.reduce((sum, value) => sum + value, 0) >= 1000) {
      detailOpened = true;
      context.location.href = 'https://tmailor.com/inbox?emailid=detail-delayed-home';
    }
  };

  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.readCodeFromMailRow, 'expected tmailor test hooks to expose readCodeFromMailRow');

  const row = {
    combinedText: 'Your ChatGPT code is ******',
    element: {
      getAttribute() {
        return null;
      },
      querySelector() {
        return null;
      },
      getBoundingClientRect() {
        return { width: 120, height: 24 };
      },
      textContent: 'Your ChatGPT code is ******',
    },
  };

  const code = await hooks.readCodeFromMailRow(row, 7);

  assert.equal(code, '443322');
  assert.equal(context.location.href, 'https://tmailor.com/inbox?emailid=detail-delayed-home');
  assert.equal(sleepCalls.reduce((sum, value) => sum + value, 0), 1000);
});

test('tmailor handlePollEmail can resume on the mail detail page after reinjection without forcing a home navigation', async () => {
  const context = createContext();
  const state = context.__state;
  context.location.href = 'https://tmailor.com/inbox?emailid=detail-reinject-step7';
  state.bodyText = 'Your ChatGPT code is 112233';
  let rowQueryCount = 0;

  context.document.querySelector = (selector) => {
    if (selector === 'h1') {
      return { textContent: 'Your ChatGPT code is 112233' };
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [];
    }
    if (selector === 'tr') {
      rowQueryCount += 1;
      if (context.location.href === 'https://tmailor.com/' && rowQueryCount >= 1) {
        return [{
          textContent: 'noreply@tm.openai.com\nYour ChatGPT code is 112233\n10:00',
          getAttribute() {
            return null;
          },
          getBoundingClientRect() {
            return { width: 120, height: 24 };
          },
        }];
      }
    }
    return [];
  };
  context.sleep = async () => {};

  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.handlePollEmail, 'expected tmailor test hooks to expose handlePollEmail');

  const result = await hooks.handlePollEmail(7, {
    subjectFilters: ['ChatGPT code'],
    senderFilters: ['openai'],
    targetEmail: 'nga16eu@fbhotro.com',
    maxAttempts: 2,
    intervalMs: 0,
    filterAfterTimestamp: 0,
  });

  assert.equal(result.code, '112233');
  assert.equal(context.location.href, 'https://tmailor.com/inbox?emailid=detail-reinject-step7');
  assert.equal(state.historyBackCalls, 0);
});

test('tmailor leaves the detail page untouched when the code does not become visible in time', async () => {
  const context = createContext();
  const state = context.__state;
  context.location.href = 'https://tmailor.com/inbox?emailid=detail-stuck';
  state.bodyText = '你的 ChatGPT 代码为 ******';

  context.document.querySelector = (selector) => {
    if (selector === 'h1') {
      return { textContent: '你的 ChatGPT 代码为 ******' };
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.sleep = async () => {};

  loadTmailorScript(context);

  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.readCodeFromMailRow, 'expected tmailor test hooks to expose readCodeFromMailRow');

  const row = {
    combinedText: '你的 ChatGPT 代码为 ******',
    element: {
      getAttribute() {
        return null;
      },
      getBoundingClientRect() {
        return { width: 120, height: 24 };
      },
      textContent: '你的 ChatGPT 代码为 ******',
    },
  };

  const code = await hooks.readCodeFromMailRow(row, 4);

  assert.equal(code, null);
  assert.equal(context.location.href, 'https://tmailor.com/inbox?emailid=detail-stuck');
  assert.equal(state.historyBackCalls, 0);
});

test('tmailor clicks the dismiss button root when the visible Close text is only a child node', async () => {
  const context = createContext();
  const state = context.__state;
  state.dialogVisible = false;
  state.adVisible = true;
  state.closeVisible = true;

  const dismissRoot = {
    id: 'dismiss-button-element',
    tagName: 'BUTTON',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 88, height: 32 };
    },
  };
  const dismissLabel = {
    tagName: 'DIV',
    textContent: 'Close',
    closest(selector) {
      if (selector === '#dismiss-button-element, button, [role="button"], a') {
        return dismissRoot;
      }
      return null;
    },
    getBoundingClientRect() {
      return { width: 64, height: 20 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === '#dismiss-button-element > div') {
      return dismissLabel;
    }
    if (selector === '#dismiss-button-element') {
      return dismissRoot;
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === dismissRoot) {
      state.adVisible = false;
      state.closeVisible = false;
    }
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.handleMonetizationVideoAd, 'expected tmailor to expose handleMonetizationVideoAd');

  const handled = await hooks.handleMonetizationVideoAd(100);

  assert.equal(handled, true);
  assert.equal(state.lastClicked, dismissRoot);
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

test('tmailor detects the idle mailbox state before a new email is generated', () => {
  const context = createContext();
  const currentEmailInput = {
    tagName: 'INPUT',
    value: '',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-label') {
        return 'Your Temp Mail Address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 420, top: 420, width: 520, height: 64 };
    },
  };
  const newEmailButton = {
    tagName: 'BUTTON',
    id: 'btnNewEmail',
    textContent: 'New Email',
    disabled: false,
    getAttribute(name) {
      if (name === 'title') {
        return 'Create a new email address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 470, top: 550, width: 150, height: 56 };
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === 'input[name="currentEmailAddress"]') {
      return currentEmailInput;
    }
    if (selector === '#btnNewEmail') {
      return newEmailButton;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [newEmailButton];
    }
    return [];
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.detectTmailorPageState, 'expected tmailor to expose detectTmailorPageState');

  const state = hooks.detectTmailorPageState();

  assert.equal(state.kind, 'mailbox_idle');
});

test('tmailor detects the ready mailbox state when an email and refresh button are visible', () => {
  const context = createContext();
  const currentEmailInput = {
    tagName: 'INPUT',
    value: 'ngzwcnvc@tiksofi.uk',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-label') {
        return 'Your Temp Mail Address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 420, top: 420, width: 520, height: 64 };
    },
  };
  const newEmailButton = {
    tagName: 'BUTTON',
    id: 'btnNewEmail',
    textContent: 'New Email',
    disabled: false,
    getBoundingClientRect() {
      return { left: 470, top: 550, width: 150, height: 56 };
    },
  };
  const refreshButton = {
    tagName: 'BUTTON',
    id: 'refresh-inboxs',
    textContent: 'Refresh',
    disabled: false,
    getAttribute(name) {
      if (name === 'title' || name === 'aria-label') {
        return 'Refresh';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 930, top: 830, width: 82, height: 24 };
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === 'input[name="currentEmailAddress"]') {
      return currentEmailInput;
    }
    if (selector === '#btnNewEmail') {
      return newEmailButton;
    }
    if (selector === '#refresh-inboxs') {
      return refreshButton;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [newEmailButton, refreshButton];
    }
    return [];
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.detectTmailorPageState, 'expected tmailor to expose detectTmailorPageState');

  const state = hooks.detectTmailorPageState();

  assert.equal(state.kind, 'mailbox_ready');
  assert.equal(state.email, 'ngzwcnvc@tiksofi.uk');
});

test('tmailor ignores a stale hidden turnstile response when the mailbox itself is already visible', () => {
  const context = createContext();
  context.document.body.innerText = 'Your Temp Mail Address Copy this address and use it for OTPs, sign-ups, and verifications.';

  const mailboxSection = {
    tagName: 'SECTION',
    id: 'actionEmailAddressHome',
    className: 'tm-max-box mx-auto',
    parentElement: null,
    getBoundingClientRect() {
      return { left: 140, top: 392, width: 740, height: 330 };
    },
    get textContent() {
      return context.document.body.innerText;
    },
  };
  const hiddenResponseInput = {
    tagName: 'INPUT',
    value: 'x'.repeat(517),
    parentElement: mailboxSection,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };
  const currentEmailInput = {
    tagName: 'INPUT',
    value: 'ngzwcnvc@tiksofi.uk',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-label') {
        return 'Your Temp Mail Address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 180, top: 420, width: 360, height: 44 };
    },
  };
  const newEmailButton = {
    tagName: 'BUTTON',
    id: 'btnNewEmail',
    textContent: 'New Email',
    getBoundingClientRect() {
      return { left: 180, top: 500, width: 120, height: 40 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'input[name="currentEmailAddress"]') {
      return currentEmailInput;
    }
    if (selector === '#btnNewEmail') {
      return newEmailButton;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return hiddenResponseInput;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [newEmailButton];
    }
    return [];
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.detectTmailorPageState, 'expected tmailor to expose detectTmailorPageState');

  const state = hooks.detectTmailorPageState();

  assert.equal(state.kind, 'mailbox_idle');
});

test('tmailor ignores hidden new-email firewall markup until the dialog is actually shown', () => {
  const context = createContext();
  context.document.body.innerText = 'Your Temp Mail Address Copy this address and use it for OTPs, sign-ups, and verifications. New Email Reuse Email';

  const hiddenFirewallRoot = {
    tagName: 'DIV',
    id: 'newEmailFW',
    className: 'hidden',
    parentElement: null,
    getAttribute(name) {
      if (name === 'aria-hidden') {
        return 'true';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };
  const hiddenCaptchaShell = {
    tagName: 'DIV',
    className: 'cf-turnstile',
    parentElement: hiddenFirewallRoot,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 300, height: 80 };
    },
  };
  const hiddenResponseInput = {
    tagName: 'INPUT',
    value: '',
    parentElement: hiddenCaptchaShell,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };
  const hiddenConfirmButton = {
    tagName: 'BUTTON',
    id: 'btnNewEmailForm',
    textContent: 'Confirm',
    parentElement: hiddenFirewallRoot,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 120, height: 40 };
    },
    getAttribute(name) {
      if (name === 'title') {
        return 'Create a new email address';
      }
      return null;
    },
  };
  const currentEmailInput = {
    tagName: 'INPUT',
    value: '',
    disabled: false,
    parentElement: null,
    getAttribute(name) {
      if (name === 'aria-label') {
        return 'Your Temp Mail Address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 180, top: 420, width: 360, height: 44 };
    },
  };
  const newEmailButton = {
    tagName: 'BUTTON',
    id: 'btnNewEmail',
    textContent: 'New Email',
    parentElement: null,
    getBoundingClientRect() {
      return { left: 180, top: 500, width: 120, height: 40 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'input[name="currentEmailAddress"]') {
      return currentEmailInput;
    }
    if (selector === '#btnNewEmail') {
      return newEmailButton;
    }
    if (selector === '#btnNewEmailForm') {
      return hiddenConfirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('cf-turnstile-response')) {
      return hiddenCaptchaShell;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [newEmailButton, hiddenConfirmButton];
    }
    return [];
  };
  context.getComputedStyle = (element) => {
    if (element === hiddenFirewallRoot) {
      return {
        display: 'none',
        visibility: 'hidden',
        opacity: '0',
      };
    }
    return {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    };
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.detectTmailorPageState, 'expected tmailor to expose detectTmailorPageState');

  const state = hooks.detectTmailorPageState();

  assert.equal(state.kind, 'mailbox_idle');
});

test('tmailor ignores hidden firewall copy inherited through a visible mailbox section ancestor', () => {
  const context = createContext();

  const mailboxSection = {
    tagName: 'SECTION',
    id: 'actionEmailAddressHome',
    className: 'tm-max-box mx-auto',
    parentElement: null,
    get textContent() {
      return [
        'Your Temp Mail Address',
        'Copy this address and use it for OTPs, sign-ups, and verification emails.',
        'Please verify that you are not a robot.',
        'Confirm',
      ].join(' ');
    },
    getBoundingClientRect() {
      return { left: 140, top: 366, width: 740, height: 330 };
    },
  };
  const hiddenFirewallRoot = {
    tagName: 'DIV',
    id: 'newEmailFW',
    className: 'hidden',
    parentElement: mailboxSection,
    getAttribute(name) {
      if (name === 'aria-hidden') {
        return 'true';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };
  const hiddenCaptchaShell = {
    tagName: 'DIV',
    className: 'html-captcha',
    parentElement: hiddenFirewallRoot,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };
  const hiddenResponseInput = {
    tagName: 'INPUT',
    value: '',
    parentElement: hiddenCaptchaShell,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };
  const currentEmailInput = {
    tagName: 'INPUT',
    value: '',
    disabled: false,
    parentElement: mailboxSection,
    getAttribute(name) {
      if (name === 'aria-label') {
        return 'Your Temp Mail Address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 180, top: 420, width: 360, height: 44 };
    },
  };
  const newEmailButton = {
    tagName: 'BUTTON',
    id: 'btnNewEmail',
    textContent: 'New Email',
    parentElement: mailboxSection,
    getBoundingClientRect() {
      return { left: 180, top: 500, width: 120, height: 40 };
    },
  };

  context.document.body.innerText = 'Your Temp Mail Address Copy this address and use it for OTPs, sign-ups, and verification emails. New Email';
  context.document.querySelector = (selector) => {
    if (selector === 'input[name="currentEmailAddress"]') {
      return currentEmailInput;
    }
    if (selector === '#btnNewEmail') {
      return newEmailButton;
    }
    if (selector.includes('cf-turnstile-response')) {
      return hiddenResponseInput;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [newEmailButton];
    }
    return [];
  };
  context.getComputedStyle = (element) => {
    if (element === hiddenFirewallRoot || element === hiddenCaptchaShell || element === hiddenResponseInput) {
      return {
        display: 'none',
        visibility: 'hidden',
        opacity: '0',
      };
    }
    return {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    };
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.detectTmailorPageState, 'expected tmailor to expose detectTmailorPageState');

  const state = hooks.detectTmailorPageState();

  assert.equal(state.kind, 'mailbox_idle');
});

test('tmailor detects the in-page turnstile challenge state when Cloudflare confirm is embedded in the mailbox view', () => {
  const context = createContext();
  context.document.body.innerText = 'Create New Email Please verify that you are not a robot. Confirm Inbox Refresh';
  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 560, top: 460, width: 300, height: 80 };
    },
  };
  const confirmButton = {
    tagName: 'BUTTON',
    id: 'btnNewEmailForm',
    textContent: 'Confirm',
    disabled: true,
    getAttribute(name) {
      if (name === 'title') {
        return 'Create a new email address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 650, top: 550, width: 123, height: 42 };
    },
  };
  const currentEmailInput = {
    tagName: 'INPUT',
    value: 'We detected that you are performing the operation too fast, please confirm you are not a robot.',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-label') {
        return 'Your Temp Mail Address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('cf-turnstile-response')) {
      return turnstileContainer;
    }
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === 'input[name="currentEmailAddress"]') {
      return currentEmailInput;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [confirmButton];
    }
    return [];
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.detectTmailorPageState, 'expected tmailor to expose detectTmailorPageState');

  const state = hooks.detectTmailorPageState();

  assert.equal(state.kind, 'cloudflare_turnstile');
});

test('tmailor detects the full-page Cloudflare waiting room separately from the in-page turnstile flow', () => {
  const context = createContext();
  context.document.body.innerText = 'tmailor.com 正在进行安全验证 本网站使用安全服务防护恶意自动程序。';
  const wrapper = {
    tagName: 'DIV',
    id: '',
    className: 'main-wrapper lang-zh-cn',
    getAttribute(name) {
      if (name === 'role') {
        return 'main';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1200, height: 900 };
    },
  };
  const responseInput = {
    tagName: 'INPUT',
    id: 'cf-chl-widget-123_response',
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === '.main-wrapper[role="main"]') {
      return wrapper;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return responseInput;
    }
    return null;
  };
  context.document.querySelectorAll = () => [];

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.detectTmailorPageState, 'expected tmailor to expose detectTmailorPageState');

  const state = hooks.detectTmailorPageState();

  assert.equal(state.kind, 'cloudflare_full_page');
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
    context.__state.logs.some((entry) => /Confirm button is already enabled, but verification is still pending/i.test(entry.message)),
    'expected a premature confirm warning log'
  );
});

test('tmailor waits for the challenge checkbox before clicking Confirm', async () => {
  const context = createContext();
  context.document.body.innerText = 'Please verify that you are not a robot.';
  let challengeVisible = true;
  let responseToken = '';

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
      return challengeVisible ? checkboxFrame : null;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: responseToken };
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
      responseToken = 'verified-token';
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
  assert.equal(context.__state.runtimeMessages?.[0]?.payload?.rect?.centerX, 153.6);
  assert.equal(context.__state.runtimeMessages?.[0]?.payload?.rect?.centerY, 280);
  assert.equal(context.__state.clicked, 1);
  assert.equal(context.__state.lastClicked?.id, 'btnNewEmailForm');
  assert.ok(
    context.__state.logs.some((entry) => /Cloudflare challenge detected/i.test(entry.message)),
    'expected a Cloudflare challenge log'
  );
  assert.ok(
    context.__state.logs.some((entry) => /Cloudflare checkbox detected via iframe/i.test(entry.message)),
    'expected a checkbox click log'
  );
  assert.ok(
    context.__state.logs.some((entry) => /checkbox click dispatched\. Waiting for the challenge to report success/i.test(entry.message)),
    'expected a post-checkbox wait log'
  );
  assert.ok(
    context.__state.logs.some((entry) => /clicking Confirm/i.test(entry.message)),
    'expected a confirm click log'
  );
});

test('tmailor retries Confirm after checkbox success when the challenge shell stays visible', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  let responseToken = '';
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };
  context.document.body.innerText = 'Please verify that you are not a robot.';

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
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: responseToken };
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      responseToken = 'verified-token';
    }
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
    if (now >= 6000) {
      confirmButton.disabled = false;
      responseToken = 'verified-token';
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(9000);

  assert.equal(handled, true);
  assert.ok(state.runtimeMessages?.some((entry) => entry.type === 'DEBUGGER_CLICK_AT'));
  assert.equal(state.clicked, 1);
  assert.equal(state.lastClicked?.id, 'btnNewEmailForm');
  assert.ok(
    state.logs.some((entry) => /clicking Confirm/i.test(entry.message)),
    'expected a delayed confirm click log'
  );
  assert.ok(
    state.logs.some((entry) => /Cloudflare verification path: iframe/i.test(entry.message)),
    'expected a verification path log'
  );
  assert.ok(
    state.logs.some((entry) => /Cloudflare confirm decision \(reason=(delayed-retry|post-click-check);.*tokenLength=/i.test(entry.message)),
    'expected a confirm decision diagnostic log'
  );
});

test('tmailor does not click Confirm while the turnstile shell is still visible with an empty response token', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile',
    getBoundingClientRect() {
      return { left: 360, top: 463, width: 300, height: 80 };
    },
  };

  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') {
        return 'false';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 449, top: 555, width: 122, height: 41 };
    },
  };

  context.document.body.innerText = '';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return turnstileContainer;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: '' };
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      responseToken = 'verified-token';
    }
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(2500);

  assert.equal(handled, false);
  assert.ok(state.runtimeMessages?.some((entry) => entry.type === 'DEBUGGER_CLICK_AT'));
  assert.equal(state.clicked, 0);
  assert.ok(
    !state.logs.some((entry) => /retrying Confirm/i.test(entry.message)),
    'should not retry Confirm while the response token is still empty'
  );
});

test('tmailor logs Cloudflare state snapshots and a timeout summary when verification never produces a token', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 381, top: 464, width: 300, height: 80 };
    },
  };

  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') {
        return 'false';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 470, top: 556, width: 123, height: 42 };
    },
  };

  context.document.body.innerText = '';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return turnstileContainer;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: '' };
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(4000);

  assert.equal(handled, false);
  assert.ok(
    state.logs.some((entry) => /Cloudflare state update .*tokenLength=0.*confirm=enabled.*candidatePath=turnstile-container/i.test(entry.message)),
    'expected a Cloudflare state snapshot log'
  );
  assert.ok(
    state.logs.some((entry) => /Cloudflare timeout summary .*tokenLength=0.*lastPath=turnstile-container/i.test(entry.message)),
    'expected a Cloudflare timeout summary log'
  );
});

test('tmailor rotates turnstile hotspots within the checkbox lane and stops additional clicks after 8 no-token attempts', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 186, top: 529, width: 300, height: 80 };
    },
  };

  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') {
        return 'false';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 275, top: 621, width: 122, height: 41 };
    },
  };

  context.document.body.innerText = 'Create New Email Please verify that you are not a robot. Confirm';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return turnstileContainer;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: '' };
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(18000);

  assert.equal(handled, false);
  const clickMessages = (state.runtimeMessages || []).filter((entry) => entry.type === 'DEBUGGER_CLICK_AT');
  assert.equal(clickMessages.length, 8);
  const points = clickMessages.map((entry) => ({
    x: Math.round(entry.payload.rect.centerX),
    y: Math.round(entry.payload.rect.centerY),
  }));
  assert.ok(points.every((point) => point.x >= 214 && point.x <= 240), 'expected hotspot x positions to stay inside the left checkbox lane');
  assert.ok(points.every((point) => point.y >= 561 && point.y <= 577), 'expected hotspot y positions to stay near the checkbox centerline');
  assert.ok(new Set(points.map((point) => `${point.x},${point.y}`)).size > 1, 'expected hotspot rotation across retries');
  assert.ok(
    state.logs.some((entry) => /Cloudflare checkbox hotspot \(attempt 8\/8/i.test(entry.message)),
    'expected the 8th hotspot attempt log'
  );
  assert.ok(
    state.logs.some((entry) => /Cloudflare auto-attempt reached 8 checkbox clicks without receiving a token/i.test(entry.message)),
    'expected a no-token threshold log'
  );
});

test('tmailor can still click Confirm when the verification token appears during a slow late checkbox click', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  let responseToken = '';
  let clickCount = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 101, top: 572, width: 300, height: 80 };
    },
  };

  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') {
        return 'false';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 190, top: 664, width: 123, height: 42 };
    },
  };

  context.document.body.innerText = 'Create New Email Please verify that you are not a robot. Confirm';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return turnstileContainer;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: responseToken };
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      clickCount += 1;
      now += 5000;
      if (clickCount >= 2) {
        responseToken = 'verified-token';
      }
    }
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(12000);

  assert.equal(handled, true);
  assert.equal(state.lastClicked?.id, 'btnNewEmailForm');
  assert.ok(
    state.logs.some((entry) => /Cloudflare confirm decision \(reason=post-click-check;.*tokenLength=14/i.test(entry.message)),
    'expected a post-click confirm decision log'
  );
  assert.ok(
    state.logs.some((entry) => /Cloudflare Confirm trigger: reason=post-click-check; token=yes; tokenLength=14; visualSuccess=no; autoVerifyingSeen=no; checkboxClicked=yes/i.test(entry.message)),
    'expected a readable confirm trigger log that shows the token-driven path'
  );
});

test('tmailor can use a visual-success fallback to click Confirm after 5 seconds without a token', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 101, top: 472, width: 300, height: 80 };
    },
  };
  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') return 'false';
      return null;
    },
    getBoundingClientRect() {
      return { left: 190, top: 564, width: 123, height: 42 };
    },
  };

  context.document.body.innerText = 'Please verify that you are not a robot. 成功!';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return turnstileContainer;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: '' };
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === confirmButton) {
      context.document.body.innerText = '';
    }
  };
  context.sleep = async (ms = 0) => {
    now += ms;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(12000);

  assert.equal(handled, true);
  assert.equal(state.lastClicked?.id, 'btnNewEmailForm');
  assert.ok(
    state.logs.some((entry) => /Cloudflare confirm decision \(reason=visual-success-fallback;/i.test(entry.message)),
    'expected a visual success fallback confirm decision log'
  );
});

test('tmailor waits for an auto-verifying challenge to turn into visual success before clicking Confirm without touching the checkbox', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 101, top: 472, width: 300, height: 80 };
    },
  };
  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') return 'false';
      return null;
    },
    getBoundingClientRect() {
      return { left: 190, top: 564, width: 123, height: 42 };
    },
  };

  context.document.body.innerText = 'Please verify that you are not a robot. 正在验证...';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return turnstileContainer;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: '' };
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === confirmButton) {
      context.document.body.innerText = '';
    }
  };
  context.sleep = async (ms = 0) => {
    now += ms;
    if (now >= 10000 && /正在验证/.test(context.document.body.innerText)) {
      context.document.body.innerText = 'Please verify that you are not a robot. 成功!';
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(15000);

  assert.equal(handled, true);
  assert.equal(state.lastClicked?.id, 'btnNewEmailForm');
  assert.ok(
    !(state.runtimeMessages || []).some((message) => message?.type === 'DEBUGGER_CLICK_AT'),
    'should not touch the checkbox when Cloudflare auto-verifies on its own'
  );
});

test('tmailor prefers the visible Cloudflare iframe over the outer turnstile container for checkbox clicks', async () => {
  const context = createContext();
  const state = context.__state;
  let challengeVisible = true;

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 360, top: 463, width: 300, height: 80 };
    },
  };

  const iframe = {
    tagName: 'IFRAME',
    src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/123',
    title: 'Widget containing a Cloudflare security challenge',
    getAttribute(name) {
      if (name === 'src') return this.src;
      if (name === 'title') return this.title;
      return null;
    },
    getBoundingClientRect() {
      return { left: 405, top: 478, width: 210, height: 50 };
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
      return { left: 449, top: 555, width: 122, height: 41 };
    },
  };

  context.document.body.innerText = 'Please verify that you are not a robot.';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return challengeVisible ? turnstileContainer : null;
    }
    if (selector.includes('iframe[src*="challenges.cloudflare.com"]') || selector.includes('iframe[title*="Cloudflare"]') || selector.includes('iframe[title*="Widget containing"]')) {
      return challengeVisible ? iframe : null;
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      challengeVisible = false;
      confirmButton.disabled = false;
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

  const handled = await hooks.waitForCloudflareConfirm(1500);

  assert.equal(handled, true);
  const clickMessage = (state.runtimeMessages || []).find((entry) => entry.type === 'DEBUGGER_CLICK_AT');
  assert.ok(clickMessage, 'expected a debugger click request for the turnstile');
  assert.equal(Math.round(clickMessage.payload.rect.centerX), 431);
  assert.equal(Math.round(clickMessage.payload.rect.centerY), 503);
  assert.ok(
    state.logs.some((entry) => /Cloudflare checkbox detected via iframe/i.test(entry.message)),
    'expected an iframe path log'
  );
});

test('tmailor logs text-fallback when the challenge is only inferred from outer verification copy', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const outerDialog = {
    tagName: 'DIV',
    id: 'newEmailFW',
    className: 'w-full p-4 tm-max-box',
    textContent: 'Create New Email Please verify that you are not a robot.',
    getBoundingClientRect() {
      return { left: 161, top: 367, width: 740, height: 256 };
    },
  };

  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: true,
    getAttribute(name) {
      if (name === 'aria-disabled') {
        return 'true';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 470, top: 556, width: 123, height: 42 };
    },
  };

  context.document.body.innerText = 'Please verify that you are not a robot.';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return null;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [confirmButton];
    }
    if (selector === 'label, button, div, span') {
      return [outerDialog, confirmButton];
    }
    return [];
  };
  context.chrome.runtime.sendMessage = (message, callback) => {
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(3600);

  assert.equal(handled, false);
  assert.ok(
    state.logs.some((entry) => /Cloudflare checkbox detected via text-fallback/i.test(entry.message)),
    'expected a text-fallback path log'
  );
});

test('tmailor waits briefly for a real turnstile container before falling back to outer verification copy', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 100000;
  let challengeVisible = true;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const outerDialog = {
    tagName: 'DIV',
    id: 'newEmailFW',
    className: 'w-full p-4 tm-max-box',
    textContent: 'Create New Email Please verify that you are not a robot.',
    getBoundingClientRect() {
      return { left: 0, top: 85, width: 502, height: 288 };
    },
  };

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 101, top: 198, width: 300, height: 80 };
    },
  };

  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') {
        return 'false';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 190, top: 290, width: 123, height: 42 };
    },
  };

  context.document.body.innerText = 'Please verify that you are not a robot.';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return challengeVisible && now >= 101500 ? turnstileContainer : null;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return { value: '' };
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [confirmButton];
    }
    if (selector === 'label, button, div, span') {
      return [outerDialog, confirmButton];
    }
    return [];
  };
  context.chrome.runtime.sendMessage = (message, callback) => {
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      challengeVisible = false;
      context.document.body.innerText = '';
    }
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  const handled = await hooks.waitForCloudflareConfirm(5000);

  assert.equal(handled, true);
  assert.ok(
    !state.logs.some((entry) => /Cloudflare checkbox detected via text-fallback/i.test(entry.message)),
    'should wait for the turnstile container instead of clicking the outer text fallback immediately'
  );
  assert.ok(
    state.logs.some((entry) => /Cloudflare checkbox detected via turnstile-container/i.test(entry.message)),
    'expected the real turnstile container path log'
  );
});

test('tmailor can click a Cloudflare turnstile container when the iframe is hidden inside a closed shadow root', async () => {
  const context = createContext();
  let challengeVisible = true;

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile',
    getBoundingClientRect() {
      return { left: 80, top: 140, width: 300, height: 80 };
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
    if (selector.includes('.cf-turnstile') || selector.includes('.html-captcha') || selector.includes('cf-turnstile-response')) {
      return challengeVisible ? turnstileContainer : null;
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
      challengeVisible = false;
      confirmButton.disabled = false;
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
  assert.equal(context.__state.runtimeMessages?.[0]?.payload?.rect?.centerX, 116);
  assert.equal(context.__state.runtimeMessages?.[0]?.payload?.rect?.centerY, 180);
  assert.equal(context.__state.clicked, 1);
  assert.equal(context.__state.lastClicked?.id, 'btnNewEmailForm');
  assert.ok(
    context.__state.logs.some((entry) => /Cloudflare checkbox detected via turnstile-container/i.test(entry.message)),
    'expected a turnstile-container path log'
  );
});

test('tmailor treats a visible turnstile container as a manual takeover blocker even without body text', () => {
  const context = createContext();
  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile',
    getBoundingClientRect() {
      return { left: 60, top: 120, width: 300, height: 80 };
    },
  };

  context.document.body.innerText = '';
  context.document.querySelector = (selector) => {
    if (selector.includes('.cf-turnstile') || selector.includes('.html-captcha') || selector.includes('cf-turnstile-response')) {
      return turnstileContainer;
    }
    return null;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.assertNoManualTakeoverBlockers, 'expected tmailor to expose assertNoManualTakeoverBlockers');

  assert.throws(
    () => hooks.assertNoManualTakeoverBlockers(),
    /Cloudflare challenge detected on TMailor\. Temporary failure, please take over manually\./i
  );
});

test('tmailor treats the currentEmailAddress soft firewall message as a manual takeover blocker even when the turnstile shell is not visible', () => {
  const context = createContext();
  const currentEmailInput = {
    tagName: 'INPUT',
    value: 'We detected that you are performing the operation too fast, please confirm you are not a robot.',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-label') {
        return 'Your Temp Mail Address';
      }
      if (name === 'title') {
        return 'We detected that you are performing the operation too fast, please confirm you are not a robot.';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 32, top: 96, width: 320, height: 64 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'input[name="currentEmailAddress"]') {
      return currentEmailInput;
    }
    return null;
  };
  context.document.querySelectorAll = () => [];

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.assertNoManualTakeoverBlockers, 'expected tmailor to expose assertNoManualTakeoverBlockers');

  assert.throws(
    () => hooks.assertNoManualTakeoverBlockers(),
    /Cloudflare challenge detected on TMailor\. Temporary failure, please take over manually\./i
  );
});

test('tmailor logs full-page Cloudflare challenge details when the response input is present on the waiting page', async () => {
  const context = createContext();
  context.document.body.innerText = 'tmailor.com 正在进行安全验证 本网站使用安全服务防护恶意自动程序。';

  const wrapper = {
    tagName: 'DIV',
    id: '',
    className: 'main-wrapper lang-zh-cn',
    getAttribute(name) {
      if (name === 'role') {
        return 'main';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1200, height: 900 };
    },
  };
  const responseInput = {
    tagName: 'INPUT',
    id: 'cf-chl-widget-123_response',
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === '.main-wrapper[role="main"]') {
      return wrapper;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return responseInput;
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForCloudflareConfirm, 'expected tmailor to expose waitForCloudflareConfirm');

  await hooks.waitForCloudflareConfirm(50);

  assert.ok(
    context.__state.logs.some((entry) => /Cloudflare challenge details: full-page challenge/i.test(entry.message)),
    'expected a full-page Cloudflare diagnostic log'
  );
  assert.ok(
    context.__state.logs.some((entry) => /Cloudflare checkbox detected via /i.test(entry.message)),
    'expected a checkbox click attempt log'
  );
});

test('tmailor targets the left-side turnstile checkbox area instead of the middle of the widget', async () => {
  const context = createContext();
  const state = context.__state;
  const iframe = {
    tagName: 'IFRAME',
    src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/123',
    title: 'Widget containing a Cloudflare security challenge',
    getAttribute(name) {
      if (name === 'src') return this.src;
      if (name === 'title') return this.title;
      return null;
    },
    getBoundingClientRect() {
      return { left: 120, top: 260, width: 300, height: 65 };
    },
  };
  const confirmButton = {
    tagName: 'BUTTON',
    id: 'btnNewEmailForm',
    disabled: false,
    textContent: 'Confirm',
    getAttribute(name) {
      if (name === 'title') return 'Create a new email address';
      return null;
    },
    getBoundingClientRect() {
      return { left: 200, top: 360, width: 120, height: 42 };
    },
  };

  let challengeVisible = true;
  context.document.body.innerText = 'Please verify that you are not a robot.';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector.includes('iframe[src*="challenges.cloudflare.com"]') || selector.includes('iframe[title*="Cloudflare"]') || selector.includes('iframe[title*="Widget containing"]')) {
      return challengeVisible ? iframe : null;
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
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

  const handled = await hooks.waitForCloudflareConfirm(1200);

  assert.equal(handled, true);
  const clickMessage = (state.runtimeMessages || []).find((entry) => entry.type === 'DEBUGGER_CLICK_AT');
  assert.ok(clickMessage, 'expected a debugger click request for the turnstile');
  assert.equal(Math.round(clickMessage.payload.rect.centerY), 293);
  assert.equal(Math.round(clickMessage.payload.rect.centerX), 156);
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
    context.__state.logs.some((entry) => /close: BUTTON/i.test(entry.message)),
    'expected the overlay click log to include the close-button details'
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

test('tmailor plays and closes the monetization video ad overlay', async () => {
  const context = createContext();
  const state = context.__state;
  state.dialogVisible = true;
  state.adVisible = false;
  state.closeVisible = false;

  const monetizationDialog = {
    getBoundingClientRect() {
      return { width: 480, height: 320 };
    },
  };
  const playButton = {
    tagName: 'BUTTON',
    textContent: 'View a short ad',
    getBoundingClientRect() {
      return { width: 120, height: 36 };
    },
  };
  const adCloseButton = {
    tagName: 'DIV',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 80, height: 30 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog') {
      return state.dialogVisible ? monetizationDialog : null;
    }
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog > div > div.fc-list-container > button') {
      return state.dialogVisible ? playButton : null;
    }
    if (selector === '#dismiss-button-element > div') {
      return state.adVisible && state.closeVisible ? adCloseButton : null;
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === playButton) {
      state.dialogVisible = false;
      state.adVisible = true;
    }
    if (target === adCloseButton) {
      state.adVisible = false;
      state.closeVisible = false;
    }
  };
  context.sleep = async () => {
    state.sleepCalls += 1;
    if (state.adVisible && state.sleepCalls >= 2) {
      state.closeVisible = true;
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.handleMonetizationVideoAd, 'expected tmailor to expose handleMonetizationVideoAd');

  const handled = await hooks.handleMonetizationVideoAd();

  assert.equal(handled, true);
  assert.equal(state.clicked, 2);
  assert.equal(state.lastClicked, adCloseButton);
  assert.ok(
    state.logs.some((entry) => /video ad overlay detected, clicking Play/i.test(entry.message)),
    'expected a play log'
  );
  assert.ok(
    state.logs.some((entry) => /play: BUTTON/i.test(entry.message)),
    'expected the play log to include element details'
  );
  assert.ok(
    state.logs.some((entry) => /video ad finished, clicking Close/i.test(entry.message)),
    'expected a close log'
  );
});

test('tmailor waitForMailboxControls auto-handles the monetization video ad before continuing', async () => {
  const context = createContext();
  const state = context.__state;
  state.dialogVisible = true;
  state.adVisible = false;
  state.closeVisible = false;
  state.controlsVisible = false;

  const monetizationDialog = {
    getBoundingClientRect() {
      return { width: 480, height: 320 };
    },
  };
  const playButton = {
    tagName: 'BUTTON',
    textContent: 'View a short ad',
    getBoundingClientRect() {
      return { width: 120, height: 36 };
    },
  };
  const adCloseButton = {
    tagName: 'DIV',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 80, height: 30 };
    },
  };
  const newEmailButton = {
    tagName: 'BUTTON',
    textContent: 'New Email',
    getBoundingClientRect() {
      return { width: 88, height: 28 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog') {
      return state.dialogVisible ? monetizationDialog : null;
    }
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog > div > div.fc-list-container > button') {
      return state.dialogVisible ? playButton : null;
    }
    if (selector === '#dismiss-button-element > div') {
      return state.adVisible && state.closeVisible ? adCloseButton : null;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return state.controlsVisible ? [newEmailButton] : [];
    }
    return [];
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === playButton) {
      state.dialogVisible = false;
      state.adVisible = true;
    }
    if (target === adCloseButton) {
      state.adVisible = false;
      state.closeVisible = false;
      state.controlsVisible = true;
    }
  };
  context.sleep = async () => {
    state.sleepCalls += 1;
    if (state.adVisible && state.sleepCalls >= 2) {
      state.closeVisible = true;
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForMailboxControls, 'expected tmailor test hooks to expose waitForMailboxControls');

  await assert.doesNotReject(() => hooks.waitForMailboxControls(1500));
  assert.equal(state.controlsVisible, true);
  assert.equal(state.lastClicked, adCloseButton);
});

test('tmailor patrol handles a monetization dialog that appears during the row-open wait', async () => {
  const context = createContext();
  const state = context.__state;
  state.dialogVisible = false;
  state.adVisible = false;
  state.closeVisible = false;

  const rowTarget = {
    getBoundingClientRect() {
      return { width: 120, height: 24 };
    },
  };
  const monetizationDialog = {
    getBoundingClientRect() {
      return { width: 480, height: 320 };
    },
  };
  const playButton = {
    tagName: 'BUTTON',
    textContent: 'View a short ad',
    getBoundingClientRect() {
      return { width: 120, height: 36 };
    },
  };
  const adCloseButton = {
    tagName: 'DIV',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 80, height: 30 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog') {
      return state.dialogVisible ? monetizationDialog : null;
    }
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog > div > div.fc-list-container > button') {
      return state.dialogVisible ? playButton : null;
    }
    if (selector === '#dismiss-button-element > div') {
      return state.adVisible && state.closeVisible ? adCloseButton : null;
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === rowTarget) {
      state.rowOpened = true;
    }
    if (target === playButton) {
      state.dialogVisible = false;
      state.adVisible = true;
    }
    if (target === adCloseButton) {
      state.adVisible = false;
      state.closeVisible = false;
    }
  };
  context.sleep = async () => {
    state.sleepCalls += 1;
    if (state.rowOpened && !state.dialogVisible && !state.adVisible && state.sleepCalls === 1) {
      state.dialogVisible = true;
    }
    if (state.adVisible && state.sleepCalls >= 3) {
      state.closeVisible = true;
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.clickMailRow, 'expected tmailor test hooks to expose clickMailRow');

  await hooks.clickMailRow({ element: rowTarget });

  assert.equal(state.clicked, 3);
  assert.equal(state.lastClicked, adCloseButton);
  assert.ok(
    state.logs.some((entry) => /Interruption sweep handled a mailbox blocker during opening a matched inbox row/i.test(entry.message)),
    'expected a patrol log after handling the mid-run dialog'
  );
});

test('tmailor patrol does not re-enter while an interruption handler is already running', async () => {
  const context = createContext();
  const state = context.__state;
  state.dialogVisible = true;
  state.adVisible = false;
  state.closeVisible = false;
  state.nestedSweepResults = [];
  let hooks = null;

  const monetizationDialog = {
    getBoundingClientRect() {
      return { width: 480, height: 320 };
    },
  };
  const playButton = {
    tagName: 'BUTTON',
    textContent: 'View a short ad',
    getBoundingClientRect() {
      return { width: 120, height: 36 };
    },
  };
  const adCloseButton = {
    tagName: 'DIV',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 80, height: 30 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog') {
      return state.dialogVisible ? monetizationDialog : null;
    }
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-list-container > button') {
      return state.dialogVisible ? playButton : null;
    }
    if (selector === 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog > div > div.fc-list-container > button') {
      return state.dialogVisible ? playButton : null;
    }
    if (selector === '#dismiss-button-element > div') {
      return state.adVisible && state.closeVisible ? adCloseButton : null;
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === playButton) {
      state.dialogVisible = false;
      state.adVisible = true;
    }
    if (target === adCloseButton) {
      state.adVisible = false;
      state.closeVisible = false;
    }
  };
  context.sleep = async () => {
    state.sleepCalls += 1;
    if (hooks && state.sleepCalls === 1) {
      state.nestedSweepResults.push(await hooks.runMailboxInterruptionSweep({ reason: 'nested test sweep', includeCloudflare: false }));
    }
    if (state.adVisible && state.sleepCalls >= 2) {
      state.closeVisible = true;
    }
  };

  loadTmailorScript(context);
  hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.runMailboxInterruptionSweep, 'expected tmailor test hooks to expose runMailboxInterruptionSweep');

  const handled = await hooks.runMailboxInterruptionSweep({ reason: 'top-level test sweep', includeCloudflare: false });

  assert.equal(handled, true);
  assert.deepEqual(state.nestedSweepResults, [false]);
  assert.equal(state.clicked, 2);
});

test('tmailor closes the ad_position_box overlay with the dismiss button selector', async () => {
  const context = createContext();
  const state = context.__state;
  state.interstitialVisible = true;

  const adBox = {
    id: 'ad_position_box',
    getBoundingClientRect() {
      return { width: 480, height: 320 };
    },
  };
  const dismissClose = {
    tagName: 'DIV',
    textContent: 'Close',
    getBoundingClientRect() {
      return { width: 80, height: 30 };
    },
  };

  context.document.querySelector = (selector) => {
    if (selector === '#ad_position_box') {
      return state.interstitialVisible ? adBox : null;
    }
    if (selector === '#dismiss-button-element > div') {
      return state.interstitialVisible ? dismissClose : null;
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === dismissClose) {
      state.interstitialVisible = false;
    }
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.dismissBlockingOverlay, 'expected tmailor to expose dismissBlockingOverlay');

  const handled = await hooks.dismissBlockingOverlay(100);

  assert.equal(handled, true);
  assert.equal(state.lastClicked, dismissClose);
  assert.ok(
    state.logs.some((entry) => /Blocking overlay detected, clicking Close/i.test(entry.message)),
    'expected an interstitial close log'
  );
});

test('tmailor waitForMailboxControls auto-attempts Cloudflare before allowing manual takeover', async () => {
  const context = createContext();
  const state = context.__state;
  let challengeVisible = true;
  let controlsVisible = false;

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile',
    getBoundingClientRect() {
      return { left: 80, top: 140, width: 300, height: 80 };
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
  const newEmailButton = {
    id: 'btnNewEmail',
    tagName: 'BUTTON',
    textContent: 'New Email',
    getBoundingClientRect() {
      return { width: 88, height: 28 };
    },
  };
  const currentEmailInput = {
    tagName: 'INPUT',
    value: '',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-label') {
        return 'Your Temp Mail Address';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 420, top: 420, width: 520, height: 64 };
    },
  };

  context.document.body.innerText = 'Please verify that you are not a robot.';
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '#btnNewEmail') {
      return controlsVisible ? newEmailButton : null;
    }
    if (selector === 'input[name="currentEmailAddress"]') {
      return controlsVisible ? currentEmailInput : null;
    }
    if (selector.includes('.cf-turnstile') || selector.includes('.html-captcha') || selector.includes('cf-turnstile-response')) {
      return challengeVisible ? turnstileContainer : null;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      const items = [];
      if (challengeVisible) items.push(confirmButton);
      if (controlsVisible) items.push(newEmailButton);
      return items;
    }
    return [];
  };
  context.chrome.runtime.sendMessage = (message, callback) => {
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      challengeVisible = false;
      controlsVisible = true;
      confirmButton.disabled = false;
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
  assert.ok(hooks?.waitForMailboxControls, 'expected tmailor test hooks to expose waitForMailboxControls');

  await assert.doesNotReject(() => hooks.waitForMailboxControls(500));
  assert.equal(state.runtimeMessages?.[0]?.type, 'DEBUGGER_CLICK_AT');
  assert.ok(
    state.logs.some((entry) => /attempting automatic verification first/i.test(entry.message)),
    'expected an auto-attempt log before manual takeover'
  );
  assert.ok(
    state.logs.some((entry) => /challenge cleared automatically/i.test(entry.message)),
    'expected an automatic-clear success log'
  );
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
    /TMailor server error detected while refreshing the mailbox\. The node or current network path may be unstable\. Change node first; if it still fails across nodes, try again later\./i
  );
});

test('tmailor detects fatal server errors from the disabled currentEmailAddress input state', async () => {
  const context = createContext();
  const fatalInput = {
    disabled: true,
    value: 'An error occurred on the server. Please try again later',
    title: 'An error occurred on the server. Please try again later',
    getAttribute(name) {
      if (name === 'title') return this.title;
      if (name === 'aria-label') return 'Your Temp Mail Address';
      return null;
    },
    getBoundingClientRect() {
      return { width: 280, height: 64 };
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === 'input[name="currentEmailAddress"]') {
      return fatalInput;
    }
    return null;
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.assertNoFatalMailboxError, 'expected tmailor to expose assertNoFatalMailboxError');

  assert.throws(
    () => hooks.assertNoFatalMailboxError(),
    /TMailor server error detected while refreshing the mailbox\. The node or current network path may be unstable\. Change node first; if it still fails across nodes, try again later\./i
  );
});

test('tmailor stops and asks for manual takeover when a Cloudflare challenge is visible', async () => {
  const context = createContext();
  context.document.body.innerText = 'Please verify that you are not a robot.';
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForMailboxControls, 'expected tmailor test hooks to expose waitForMailboxControls');

  await assert.rejects(
    () => hooks.waitForMailboxControls(100),
    /Cloudflare challenge detected on TMailor\. Automatic verification did not complete, please take over manually\./i
  );
  assert.ok(
    context.__state.logs.some((entry) => /attempting automatic verification first/i.test(entry.message)),
    'expected an auto-attempt log before manual takeover'
  );
});

test('tmailor stops and asks for manual takeover when a blocking ad close button is visible', async () => {
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
      return [closeButton];
    }
    return [];
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.waitForMailboxControls, 'expected tmailor test hooks to expose waitForMailboxControls');

  await assert.rejects(
    () => hooks.waitForMailboxControls(100),
    /Blocking overlay detected on TMailor\. Temporary failure, please take over manually\./i
  );
});

test('tmailor fetch email asks background to reload the mailbox when Cloudflare confirm times out but the challenge is still visible', async () => {
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
      return [
        { textContent: 'New Email', getBoundingClientRect() { return { width: 88, height: 28 }; } },
        confirmButton,
      ];
    }
    return [];
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.fetchTmailorEmail, 'expected tmailor to expose fetchTmailorEmail');

  const result = await hooks.fetchTmailorEmail({ generateNew: true, domainState: {} });

  assert.equal(result?.recovery, 'reload_mailbox');
  assert.match(String(result?.error || ''), /Cloudflare challenge detected on TMailor/i);
});

test('tmailor waits longer for the mailbox to appear after a successful Cloudflare clear instead of clicking New Email again immediately', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  let responseToken = '';
  let challengeVisible = false;
  let newEmailClicks = 0;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const currentEmailInput = {
    value: 'oldbox@fbhotro.com',
    getAttribute(name) {
      if (name === 'aria-label') return 'Your Temp Mail Address';
      if (name === 'value') return this.value;
      return null;
    },
    getBoundingClientRect() {
      return { left: 250, top: 441, width: 520, height: 64 };
    },
  };
  const newEmailButton = {
    id: 'btnNewEmail',
    tagName: 'BUTTON',
    textContent: 'New Email',
    getBoundingClientRect() {
      return { left: 300, top: 520, width: 140, height: 40 };
    },
  };
  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') return 'false';
      return null;
    },
    getBoundingClientRect() {
      return { left: 449, top: 555, width: 122, height: 41 };
    },
  };
  const turnstileFrame = {
    tagName: 'IFRAME',
    src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/456',
    title: 'Widget containing a Cloudflare security challenge',
    getAttribute(name) {
      if (name === 'src') return this.src;
      if (name === 'title') return this.title;
      return null;
    },
    getBoundingClientRect() {
      return { left: 405, top: 478, width: 210, height: 50 };
    },
  };
  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 360, top: 463, width: 300, height: 80 };
    },
  };

  context.document.body = {
    get innerText() {
      return challengeVisible
        ? 'Create New Email Please verify that you are not a robot. Confirm'
        : 'Your Temp Mail Address New Email';
    },
    set innerText(value) {
      state.bodyText = value;
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmail') return newEmailButton;
    if (selector === '#btnNewEmailForm') return challengeVisible ? confirmButton : null;
    if (selector === 'input[name="currentEmailAddress"]') return currentEmailInput;
    if (selector.includes('iframe[src*="challenges.cloudflare.com"]') || selector.includes('iframe[title*="Cloudflare"]') || selector.includes('iframe[title*="Widget containing"]')) {
      return challengeVisible ? turnstileFrame : null;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return challengeVisible ? turnstileContainer : null;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return challengeVisible || responseToken ? { value: responseToken } : null;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return challengeVisible ? [newEmailButton, confirmButton] : [newEmailButton];
    }
    if (selector === 'input, textarea') {
      return [currentEmailInput];
    }
    return [];
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === newEmailButton) {
      newEmailClicks += 1;
      if (newEmailClicks === 1) {
        challengeVisible = true;
      }
    }
    if (target === confirmButton) {
      responseToken = 'verified-token';
      challengeVisible = false;
    }
  };
  context.chrome.runtime.sendMessage = (message, callback) => {
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      responseToken = 'verified-token';
    }
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
    if (!challengeVisible && responseToken && now >= 3000) {
      currentEmailInput.value = 'freshbox@fbhotro.com';
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.fetchTmailorEmail, 'expected tmailor to expose fetchTmailorEmail');

  const result = await hooks.fetchTmailorEmail({ generateNew: true, domainState: {} });

  assert.equal(result.email, 'freshbox@fbhotro.com');
  assert.equal(newEmailClicks, 1);
});

test('tmailor allows extra post-confirm grace time when the Cloudflare shell clears a bit after Confirm', async () => {
  const context = createContext();
  let now = 0;
  let responseToken = '';
  let confirmClickedAt = null;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') {
        return 'false';
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 190, top: 664, width: 123, height: 42 };
    },
  };
  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 101, top: 572, width: 300, height: 80 };
    },
  };

  function isChallengeVisible() {
    if (confirmClickedAt == null) {
      return true;
    }
    return now - confirmClickedAt < 2600;
  }

  context.document.body = {
    get innerText() {
      return isChallengeVisible()
        ? 'Create New Email Please verify that you are not a robot. Confirm'
        : 'Your Temp Mail Address New Email';
    },
    set innerText(value) {
      context.__state.bodyText = value;
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return isChallengeVisible() ? confirmButton : null;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return isChallengeVisible() ? turnstileContainer : null;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return isChallengeVisible() || responseToken ? { value: responseToken } : null;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return isChallengeVisible() ? [confirmButton] : [];
    }
    return [];
  };
  context.chrome.runtime.sendMessage = (message, callback) => {
    context.__state.runtimeMessages = context.__state.runtimeMessages || [];
    context.__state.runtimeMessages.push(message);
    if (message.type === 'DEBUGGER_CLICK_AT') {
      responseToken = 'verified-token';
    }
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.simulateClick = (target) => {
    context.__state.clicked += 1;
    context.__state.lastClicked = target;
    if (target === confirmButton) {
      confirmClickedAt = now;
      responseToken = 'verified-token';
    }
  };
  context.sleep = async (ms = 0) => {
    now += ms;
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.ensureCloudflareChallengeClearedOrThrow, 'expected tmailor to expose ensureCloudflareChallengeClearedOrThrow');

  const cleared = await hooks.ensureCloudflareChallengeClearedOrThrow(12000);

  assert.equal(cleared, true);
  assert.ok(
    context.__state.logs.some((entry) => /Cloudflare challenge cleared during the post-confirm grace window/i.test(entry.message)),
    'expected a post-confirm grace success log'
  );
});

test('tmailor default Cloudflare timeout allows a token that appears after 13 seconds', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  let responseToken = '';
  let challengeVisible = true;
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const turnstileContainer = {
    tagName: 'DIV',
    className: 'cf-turnstile h-[80px] flex items-center justify-center',
    getBoundingClientRect() {
      return { left: 186, top: 529, width: 300, height: 80 };
    },
  };
  const confirmButton = {
    id: 'btnNewEmailForm',
    tagName: 'BUTTON',
    textContent: 'Confirm',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') return 'false';
      return null;
    },
    getBoundingClientRect() {
      return { left: 275, top: 621, width: 122, height: 41 };
    },
  };

  context.document.body = {
    get innerText() {
      return challengeVisible ? 'Please verify that you are not a robot. Confirm' : '';
    },
    set innerText(value) {
      state.bodyText = value;
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmailForm') {
      return confirmButton;
    }
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return challengeVisible ? turnstileContainer : null;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      return challengeVisible || responseToken ? { value: responseToken } : null;
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
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === confirmButton) {
      challengeVisible = false;
    }
  };
  context.sleep = async (ms = 0) => {
    now += ms;
    if (!responseToken && now >= 13000) {
      responseToken = 'verified-token-after-13s';
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.ensureCloudflareChallengeClearedOrThrow, 'expected tmailor to expose ensureCloudflareChallengeClearedOrThrow');

  const cleared = await hooks.ensureCloudflareChallengeClearedOrThrow();

  assert.equal(cleared, true);
  assert.equal(state.lastClicked?.id, 'btnNewEmailForm');
});

test('tmailor asks background to reload the mailbox instead of self-refreshing during generation recovery', async () => {
  const context = createContext();
  const state = context.__state;
  let now = 0;
  let phase = 'first-challenge';
  let newEmailClicks = 0;
  const challengeFailures = [];
  context.Date = class extends Date {
    static now() {
      return now;
    }
  };

  const currentEmailInput = {
    value: 'oldbox@fbhotro.com',
    getAttribute(name) {
      if (name === 'aria-label') return 'Your Temp Mail Address';
      if (name === 'value') return this.value;
      return null;
    },
    getBoundingClientRect() {
      return { left: 250, top: 441, width: 520, height: 64 };
    },
  };
  const newEmailButton = {
    id: 'btnNewEmail',
    tagName: 'BUTTON',
    textContent: 'New Email',
    getBoundingClientRect() {
      return { left: 300, top: 520, width: 140, height: 40 };
    },
  };

  function challengeVisible() {
    return phase === 'first-challenge' || phase === 'second-challenge';
  }

  context.document.body = {
    get innerText() {
      if (phase === 'ready' || phase === 'idle' || phase === 'home-after-refresh') {
        return 'Your Temp Mail Address New Email';
      }
      if (phase === 'second-challenge') {
        return 'Please verify that you are not a robot. 成功!';
      }
      return 'Create New Email Please verify that you are not a robot. Confirm';
    },
    set innerText(value) {
      state.bodyText = value;
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmail') return newEmailButton;
    if (selector === '#btnNewEmailForm') {
      return challengeVisible() ? {
        id: 'btnNewEmailForm',
        tagName: 'BUTTON',
        textContent: 'Confirm',
        disabled: false,
        getAttribute(name) {
          if (name === 'aria-disabled') return 'false';
          return null;
        },
        getBoundingClientRect() {
          return { left: 190, top: 564, width: 123, height: 42 };
        },
      } : null;
    }
    if (selector === 'input[name="currentEmailAddress"]') return currentEmailInput;
    if (selector === '.cf-turnstile' || selector.includes('.cf-turnstile') || selector.includes('.html-captcha')) {
      return challengeVisible() ? {
        tagName: 'DIV',
        className: 'cf-turnstile h-[80px] flex items-center justify-center',
        getBoundingClientRect() {
          return { left: 101, top: 472, width: 300, height: 80 };
        },
      } : null;
    }
    if (selector.includes('input[name="cf-turnstile-response"]')) {
      if (phase === 'second-challenge') {
        return { value: '' };
      }
      return challengeVisible() ? { value: '' } : null;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return challengeVisible()
        ? [newEmailButton, context.document.querySelector('#btnNewEmailForm')]
        : [newEmailButton];
    }
    if (selector === 'input, textarea') {
      return [currentEmailInput];
    }
    return [];
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target?.id === 'btnNewEmail') {
      newEmailClicks += 1;
      if (newEmailClicks === 1) {
        phase = 'first-challenge';
      } else {
        phase = 'second-challenge';
      }
    }
    if (target?.id === 'btnNewEmailForm' && phase === 'second-challenge') {
      phase = 'ready';
      currentEmailInput.value = 'freshbox@fbhotro.com';
    }
  };
  Object.defineProperty(context.location, 'href', {
    get() {
      return state._href || 'https://tmailor.com/';
    },
    set(value) {
      state._href = value;
      state.locationChanges = state.locationChanges || [];
      state.locationChanges.push(value);
      if (value === 'https://tmailor.com/') {
        phase = 'home-after-refresh';
      }
    },
    configurable: true,
  });
  context.chrome.runtime.sendMessage = (message, callback) => {
    state.runtimeMessages = state.runtimeMessages || [];
    state.runtimeMessages.push(message);
    const response = { ok: true };
    if (typeof callback === 'function') {
      callback(response);
    }
    return Promise.resolve(response);
  };
  context.sleep = async (ms = 0) => {
    now += ms;
    if (phase === 'home-after-refresh' && now >= 1500) {
      phase = 'idle';
    }
    if (phase === 'first-challenge' && now >= 13000) {
      challengeFailures.push('first');
    }
  };

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.fetchTmailorEmail, 'expected tmailor to expose fetchTmailorEmail');

  const result = await hooks.fetchTmailorEmail({ generateNew: true, domainState: {} });

  assert.equal(result?.recovery, 'reload_mailbox');
  assert.match(String(result?.error || ''), /Cloudflare challenge detected on TMailor/i);
  assert.equal((state.locationChanges || []).length, 0);
  assert.ok(
    state.logs.some((entry) => /Requesting a background mailbox reload before retrying/i.test(entry.message)),
    'expected a background-reload handoff log'
  );
});

test('tmailor mailbox generation retries 100 times and suggests switching to com+whitelist mode when every domain is unsupported', async () => {
  const context = createContext();
  const state = context.__state;
  let newEmailClicks = 0;

  const currentEmailInput = {
    value: 'oldbox@blocked.com',
    getAttribute(name) {
      if (name === 'aria-label') return 'Your Temp Mail Address';
      if (name === 'value') return this.value;
      return null;
    },
    getBoundingClientRect() {
      return { left: 250, top: 441, width: 520, height: 64 };
    },
  };
  const newEmailButton = {
    id: 'btnNewEmail',
    tagName: 'BUTTON',
    textContent: 'New Email',
    getBoundingClientRect() {
      return { left: 300, top: 520, width: 140, height: 40 };
    },
  };

  context.document.body = {
    get innerText() {
      return 'Your Temp Mail Address New Email';
    },
    set innerText(value) {
      state.bodyText = value;
    },
  };
  context.document.querySelector = (selector) => {
    if (selector === '#btnNewEmail') return newEmailButton;
    if (selector === 'input[name="currentEmailAddress"]') return currentEmailInput;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"], a, summary') {
      return [newEmailButton];
    }
    if (selector === 'input, textarea') {
      return [currentEmailInput];
    }
    return [];
  };
  context.simulateClick = (target) => {
    state.clicked += 1;
    state.lastClicked = target;
    if (target === newEmailButton) {
      newEmailClicks += 1;
      currentEmailInput.value = `blocked-${newEmailClicks}@blocked.com`;
    }
  };
  context.sleep = async () => {};

  loadTmailorScript(context);
  const hooks = context.__MULTIPAGE_TMAILOR_TEST_HOOKS;
  assert.ok(hooks?.fetchTmailorEmail, 'expected tmailor to expose fetchTmailorEmail');

  await assert.rejects(
    () => hooks.fetchTmailorEmail({
      generateNew: true,
      domainState: {
        mode: 'com_only',
        blacklist: ['blocked.com'],
      },
    }),
    /Switch to com\+whitelist mode and retry\./i
  );

  assert.equal(newEmailClicks, 100);
  assert.ok(
    state.logs.some((entry) => /Clicked New Email \(100\/100\)/i.test(entry.message)),
    'expected the mailbox flow to retry through the 100th attempt'
  );
});
