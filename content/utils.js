// content/utils.js — Shared utilities for all content scripts

var __MULTIPAGE_UTILS_STATE = globalThis.__MULTIPAGE_UTILS_STATE || (globalThis.__MULTIPAGE_UTILS_STATE = {
  flowStopped: false,
  stopListenerRegistered: false,
  readyReported: false,
});

var SCRIPT_SOURCE = (() => {
  if (window.__MULTIPAGE_SOURCE) return window.__MULTIPAGE_SOURCE;
  const url = location.href;
  if (url.includes('auth0.openai.com') || url.includes('auth.openai.com') || url.includes('accounts.openai.com')) return 'signup-page';
  if (url.includes('mail.qq.com')) return 'qq-mail';
  if (url.includes('mail.163.com')) return 'mail-163';
  if (url.includes('duckduckgo.com/email/settings/autofill')) return 'duck-mail';
  if (url.includes('tmailor.com')) return 'tmailor-mail';
  if (url.includes('chatgpt.com')) return 'chatgpt';
  // VPS panel — detected dynamically since URL is configurable
  return 'vps-panel';
})();

var LOG_PREFIX = `[MultiPage:${SCRIPT_SOURCE}]`;
var STOP_ERROR_MESSAGE = 'Flow stopped by user.';

if (!__MULTIPAGE_UTILS_STATE.stopListenerRegistered) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STOP_FLOW') {
      __MULTIPAGE_UTILS_STATE.flowStopped = true;
      console.warn(LOG_PREFIX, STOP_ERROR_MESSAGE);
    }
  });
  __MULTIPAGE_UTILS_STATE.stopListenerRegistered = true;
}

function resetStopState() {
  __MULTIPAGE_UTILS_STATE.flowStopped = false;
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function throwIfStopped() {
  if (__MULTIPAGE_UTILS_STATE.flowStopped) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

/**
 * Wait for a DOM element to appear.
 * @param {string} selector - CSS selector
 * @param {number} timeout - Max wait time in ms (default 10000)
 * @returns {Promise<Element>}
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();

    const existing = document.querySelector(selector);
    if (existing) {
      console.log(LOG_PREFIX, `Found immediately: ${selector}`);
      log(`Found element: ${selector}`);
      resolve(existing);
      return;
    }

    console.log(LOG_PREFIX, `Waiting for: ${selector} (timeout: ${timeout}ms)`);
    log(`Waiting for selector: ${selector}...`);

    let settled = false;
    let stopTimer = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(stopTimer);
    };

    const observer = new MutationObserver(() => {
      if (__MULTIPAGE_UTILS_STATE.flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      const el = document.querySelector(selector);
      if (el) {
        cleanup();
        console.log(LOG_PREFIX, `Found after wait: ${selector}`);
        log(`Found element: ${selector}`);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      cleanup();
      const msg = `Timeout waiting for ${selector} after ${timeout}ms on ${location.href}`;
      console.error(LOG_PREFIX, msg);
      reject(new Error(msg));
    }, timeout);

    const pollStop = () => {
      if (settled) return;
      if (__MULTIPAGE_UTILS_STATE.flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      stopTimer = setTimeout(pollStop, 100);
    };
    pollStop();
  });
}

/**
 * Wait for an element matching a text pattern among multiple candidates.
 * @param {string} containerSelector - Selector for candidate elements
 * @param {RegExp} textPattern - Regex to match against textContent
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<Element>}
 */
function waitForElementByText(containerSelector, textPattern, timeout = 10000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();

    function search() {
      const candidates = document.querySelectorAll(containerSelector);
      for (const el of candidates) {
        if (textPattern.test(el.textContent)) {
          return el;
        }
      }
      return null;
    }

    const existing = search();
    if (existing) {
      console.log(LOG_PREFIX, `Found by text immediately: ${containerSelector} matching ${textPattern}`);
      log(`Found element by text: ${textPattern}`);
      resolve(existing);
      return;
    }

    console.log(LOG_PREFIX, `Waiting for text match: ${containerSelector} / ${textPattern}`);
    log(`Waiting for element with text: ${textPattern}...`);

    let settled = false;
    let stopTimer = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(stopTimer);
    };

    const observer = new MutationObserver(() => {
      if (__MULTIPAGE_UTILS_STATE.flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      const el = search();
      if (el) {
        cleanup();
        console.log(LOG_PREFIX, `Found by text after wait: ${textPattern}`);
        log(`Found element by text: ${textPattern}`);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      cleanup();
      const msg = `Timeout waiting for text "${textPattern}" in "${containerSelector}" after ${timeout}ms on ${location.href}`;
      console.error(LOG_PREFIX, msg);
      reject(new Error(msg));
    }, timeout);

    const pollStop = () => {
      if (settled) return;
      if (__MULTIPAGE_UTILS_STATE.flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      stopTimer = setTimeout(pollStop, 100);
    };
    pollStop();
  });
}

/**
 * React-compatible form filling.
 * Sets value via native setter and dispatches input + change events.
 * @param {HTMLInputElement} el
 * @param {string} value
 */
function fillInput(el, value) {
  throwIfStopped();
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(LOG_PREFIX, `Filled input ${el.name || el.id || el.type} with: ${value}`);
  log(`Filled input [${el.name || el.id || el.type || 'unknown'}]`);
}

/**
 * Fill a select element by setting its value and triggering change.
 * @param {HTMLSelectElement} el
 * @param {string} value
 */
function fillSelect(el, value) {
  throwIfStopped();
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(LOG_PREFIX, `Selected value ${value} in ${el.name || el.id}`);
  log(`Selected [${el.name || el.id || 'unknown'}] = ${value}`);
}

/**
 * Send a log message to Side Panel via Background.
 * @param {string} message
 * @param {string} level - 'info' | 'ok' | 'warn' | 'error'
 */
function log(message, level = 'info') {
  chrome.runtime.sendMessage({
    type: 'LOG',
    source: SCRIPT_SOURCE,
    step: null,
    payload: { message, level, timestamp: Date.now() },
    error: null,
  });
}

/**
 * Report that this content script is loaded and ready.
 */
function reportReady() {
  console.log(LOG_PREFIX, 'Content script ready');
  chrome.runtime.sendMessage({
    type: 'CONTENT_SCRIPT_READY',
    source: SCRIPT_SOURCE,
    step: null,
    payload: {},
    error: null,
  });
}

/**
 * Report step completion.
 * @param {number} step
 * @param {Object} data - Step output data
 */
function reportComplete(step, data = {}) {
  console.log(LOG_PREFIX, `Step ${step} completed`, data);
  log(`Step ${step} completed successfully`, 'ok');
  chrome.runtime.sendMessage({
    type: 'STEP_COMPLETE',
    source: SCRIPT_SOURCE,
    step,
    payload: data,
    error: null,
  });
}

/**
 * Report step error.
 * @param {number} step
 * @param {string} errorMessage
 */
function reportError(step, errorMessage) {
  console.error(LOG_PREFIX, `Step ${step} failed: ${errorMessage}`);
  chrome.runtime.sendMessage({
    type: 'STEP_ERROR',
    source: SCRIPT_SOURCE,
    step,
    payload: {},
    error: errorMessage,
  });
}

/**
 * Simulate a click with proper event dispatching.
 * @param {Element} el
 */
function simulateClick(el) {
  throwIfStopped();
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  console.log(LOG_PREFIX, `Clicked: ${el.tagName} ${el.textContent?.slice(0, 30) || ''}`);
  log(`Clicked [${el.tagName}] "${el.textContent?.trim().slice(0, 30) || ''}"`);
}

/**
 * Wait a specified number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function tick() {
      if (__MULTIPAGE_UTILS_STATE.flowStopped) {
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      if (Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(100, Math.max(25, ms - (Date.now() - start))));
    }

    tick();
  });
}

async function humanPause(min = 250, max = 850) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleep(duration);
}

// Auto-report ready on load
// Skip ready signal from child iframes of mail pages to avoid overwriting the top frame's registration
var _isMailChildFrame = (SCRIPT_SOURCE === 'qq-mail' || SCRIPT_SOURCE === 'mail-163' || SCRIPT_SOURCE === 'inbucket-mail') && window !== window.top;
if (!_isMailChildFrame && !__MULTIPAGE_UTILS_STATE.readyReported) {
  __MULTIPAGE_UTILS_STATE.readyReported = true;
  reportReady();
}
