(function() {
if (window.__MULTIPAGE_TMAILOR_MAIL_LOADED) {
  console.log('[Infinitoai:tmailor-mail] Content script already loaded on', location.href);
  return;
}
window.__MULTIPAGE_TMAILOR_MAIL_LOADED = true;

const TMAILOR_PREFIX = '[Infinitoai:tmailor-mail]';
const getStepMailMatchProfile = MailMatching?.getStepMailMatchProfile || function() {
  return null;
};
const isExpectedVerificationMailDetail = MailMatching?.isExpectedVerificationMailDetail || function() {
  return true;
};
const hasSignupVerificationMailDetail = MailMatching?.hasSignupVerificationMailDetail || function() {
  return false;
};
const hasLoginVerificationMailDetail = MailMatching?.hasLoginVerificationMailDetail || function() {
  return false;
};
const matchesSubjectPatterns = MailMatching?.matchesSubjectPatterns || function() {
  return true;
};
const normalizeText = MailMatching?.normalizeText || function(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
};
const { isMailFresh, parseMailTimestampCandidates } = MailFreshness;
const EMAIL_REGEX = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const DEFAULT_CLOUDFLARE_TIMEOUT_MS = 30000;
const MAX_CLOUDFLARE_CHECKBOX_ATTEMPTS = 12;
const TMAILOR_SKIP_READY_COUNTDOWN = 25;
const MAILBOX_PATROL_HEARTBEAT_MS = 15000;
const CLOUDFLARE_PROGRESS_HEARTBEAT_MS = 10000;
const CLOUDFLARE_TURNSTILE_HOTSPOTS = [
  { xRatio: 0.12, yOffset: 0 },
  { xRatio: 0.16, yOffset: -6 },
  { xRatio: 0.16, yOffset: 6 },
  { xRatio: 0.12, yOffset: -8 },
  { xRatio: 0.14, yOffset: 8 },
  { xRatio: 0.18, yOffset: -4 },
  { xRatio: 0.14, yOffset: 4 },
  { xRatio: 0.16, yOffset: 0 },
];

console.log(TMAILOR_PREFIX, 'Content script loaded on', location.href);
log(`TMailor content script loaded on ${location.href}. Waiting for mailbox commands...`, 'info');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_TMAILOR_EMAIL') {
    resetStopState(message.controlSequence);
    fetchTmailorEmail(message.payload).then(sendResponse).catch((err) => {
      if (isStopError(err)) {
        log('TMailor：已由用户停止。', 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'POLL_EMAIL') {
    resetStopState(message.controlSequence);
    handlePollEmail(message.step, message.payload).then(sendResponse).catch((err) => {
      if (isStopError(err)) {
        log(`第 ${message.step} 步：已由用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

function normalizeDomain(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function extractDomain(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return '';
  }
  return normalizeDomain(normalized.slice(atIndex + 1));
}

function isAllowedDomain(domainState, domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return false;
  }

  const mode = String(domainState?.mode || 'com_only').trim().toLowerCase();
  const whitelist = new Set((domainState?.whitelist || []).map(normalizeDomain));
  const blacklist = new Set((domainState?.blacklist || []).map(normalizeDomain));
  if (whitelist.has(normalized)) {
    return true;
  }
  if (mode === 'whitelist_only') {
    return false;
  }
  return /\.com$/i.test(normalized) && !blacklist.has(normalized);
}

function isElementVisible(el) {
  if (!el || !document.contains(el)) return false;
  let current = el;
  while (current) {
    const style = window.getComputedStyle ? window.getComputedStyle(current) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
      return false;
    }
    current = current.parentElement || null;
  }
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return !rect || (rect.width > 0 && rect.height > 0);
}

function describeElementForLog(el, label = '') {
  if (!el) {
    return label ? `${label}: <missing>` : '<missing>';
  }

  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  const summary = [
    String(el.tagName || '').toUpperCase() || 'UNKNOWN',
    el.id ? `#${el.id}` : '',
    typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().replace(/\s+/g, '.')}`
      : '',
  ].filter(Boolean).join('');
  const text = normalizeText(el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '');
  const rectText = rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)
    ? ` @(${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)})`
    : '';
  const textSuffix = text ? ` text="${text.slice(0, 80)}"` : '';
  return `${label ? `${label}: ` : ''}${summary || '<unknown>'}${rectText}${textSuffix}`;
}

function findButtonByText(patterns) {
  const selectors = 'button, [role="button"], a, summary';
  const buttons = Array.from(document.querySelectorAll(selectors)).filter(isElementVisible);
  return buttons.find((button) => patterns.some((pattern) => pattern.test(button.textContent || ''))) || null;
}

function findNewEmailButton() {
  const idButton = document.querySelector('#btnNewEmail');
  if (isElementVisible(idButton)) {
    return idButton;
  }
  return findButtonByText([/new\s*email/i]);
}

function findRefreshInboxButton() {
  const refreshButton = document.querySelector('#refresh-inboxs');
  if (isElementVisible(refreshButton)) {
    return refreshButton;
  }
  return findButtonByText([/^refresh$/i, /\brefresh\b/i]);
}

let mailboxInterruptionSweepActive = false;

async function runMailboxInterruptionSweep(options = {}) {
  if (mailboxInterruptionSweepActive) {
    return false;
  }

  const {
    reason = '',
    includeCloudflare = true,
    monetizationTimeoutMs = 15000,
    interstitialTimeoutMs = 5000,
    cloudflareTimeoutMs = DEFAULT_CLOUDFLARE_TIMEOUT_MS,
  } = options;

  mailboxInterruptionSweepActive = true;
  try {
    assertNoFatalMailboxError();

    const handledMonetizationAd = await handleMonetizationVideoAd(monetizationTimeoutMs);
    if (handledMonetizationAd) {
      if (reason) {
        log(`TMailor: Interruption sweep handled a mailbox blocker during ${reason}`, 'info');
      }
      return true;
    }

    const handledInterstitialAd = await handleDismissibleInterstitialAd(interstitialTimeoutMs);
    if (handledInterstitialAd) {
      if (reason) {
        log(`TMailor: Interruption sweep handled a mailbox blocker during ${reason}`, 'info');
      }
      return true;
    }

    const handledSkipNotice = await handleMailDetailSkipNotice(6000);
    if (handledSkipNotice) {
      if (reason) {
        log(`TMailor: Interruption sweep handled a mailbox blocker during ${reason}`, 'info');
      }
      return true;
    }

    if (includeCloudflare) {
      const clearedCloudflare = await ensureCloudflareChallengeClearedOrThrow(cloudflareTimeoutMs);
      if (clearedCloudflare) {
        if (reason) {
          log(`TMailor: Interruption sweep handled a mailbox blocker during ${reason}`, 'info');
        }
        return true;
      }
    }

    assertNoManualTakeoverBlockers();
    return false;
  } finally {
    mailboxInterruptionSweepActive = false;
  }
}

async function sleepWithMailboxPatrol(durationMs, options = {}) {
  const totalMs = Math.max(0, Number(durationMs) || 0);
  if (!totalMs) {
    return;
  }

  const sliceMs = Math.max(50, Number.isFinite(options.sliceMs) ? options.sliceMs : 250);
  const reason = String(options.reason || '').trim();
  const start = Date.now();
  let nextHeartbeatAt = reason ? MAILBOX_PATROL_HEARTBEAT_MS : Number.POSITIVE_INFINITY;
  let remainingMs = totalMs;

  while (remainingMs > 0) {
    throwIfStopped();
    const chunkMs = Math.min(sliceMs, remainingMs);
    await sleep(chunkMs);
    remainingMs -= chunkMs;

    await runMailboxInterruptionSweep(options);

    if (reason) {
      const elapsedMs = Math.max(0, Date.now() - start);
      if (elapsedMs >= nextHeartbeatAt) {
        log(`TMailor: Still ${reason} (${Math.round(elapsedMs / 1000)}s elapsed)`, 'info');
        while (elapsedMs >= nextHeartbeatAt) {
          nextHeartbeatAt += MAILBOX_PATROL_HEARTBEAT_MS;
        }
      }
    }
  }
}

function findCloudflareConfirmButton() {
  const idButton = document.querySelector('#btnNewEmailForm');
  if (isElementVisible(idButton)) {
    return idButton;
  }
  return findButtonByText([/confirm/i]);
}

function findCloudflareCheckboxTargetCandidate() {
  const iframe = findVisibleCloudflareChallengeIframe();
  if (isElementVisible(iframe)) {
    return { target: iframe, source: 'iframe' };
  }

  const visibleChallengeContainer = findVisibleCloudflareChallengeContainer();
  if (visibleChallengeContainer) {
    return { target: visibleChallengeContainer, source: 'turnstile-container' };
  }

  const textTarget = Array.from(document.querySelectorAll('label, button, div, span')).find((el) => {
    if (!isElementVisible(el)) {
      return false;
    }
    const text = normalizeText(el.textContent || '');
    return /请验证您是真人|verify you are human|i am human|not a robot/i.test(text);
  });

  return textTarget ? { target: textTarget, source: 'text-fallback' } : null;
}

function findCloudflareCheckboxTarget() {
  return findCloudflareCheckboxTargetCandidate()?.target || null;
}

function findVisibleCloudflareChallengeContainer() {
  const fullPageWrapper = document.querySelector('.main-wrapper[role="main"]');
  const hasTurnstileResponse = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][id$="_response"]');
  if (isElementVisible(fullPageWrapper) && hasTurnstileResponse) {
    return fullPageWrapper;
  }

  const directSelector = [
    '.cf-turnstile',
    '.html-captcha',
    '[class*="cf-turnstile"]',
    '[class*="turnstile"]',
  ].join(', ');
  const directMatch = document.querySelector(directSelector);
  if (isElementVisible(directMatch)) {
    return directMatch;
  }

  const responseInput = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][id$="_response"]');
  if (!responseInput) {
    return null;
  }

  let current = responseInput.parentElement || null;
  while (current) {
    if (!isElementVisible(current)) {
      return null;
    }
    if (looksLikeCloudflareChallengeShell(current)) {
      return current;
    }
    current = current.parentElement || null;
  }

  return null;
}

function looksLikeCloudflareChallengeShell(element) {
  if (!element) {
    return false;
  }

  const hintText = normalizeText([
    element.id,
    element.className,
    element.getAttribute?.('data-testid'),
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
  ].filter(Boolean).join(' ')).toLowerCase();

  if (/cf-turnstile|turnstile|cloudflare|captcha|challenge/.test(hintText)) {
    return true;
  }

  const visibleText = normalizeText(element.textContent || '').toLowerCase();
  return /verify you are human|verify that you are not a robot|please confirm you are not a robot|i am human|not a robot|cloudflare/i.test(visibleText);
}

function findVisibleCloudflareChallengeIframe() {
  const iframe = document.querySelector(
    'iframe[src*="challenges.cloudflare.com"], ' +
    'iframe[title*="Cloudflare"], ' +
    'iframe[title*="security challenge"], ' +
    'iframe[title*="Widget containing"], ' +
    'iframe[title*="安全质询"], ' +
    'iframe[title*="Cloudflare 安全质询"]'
  );
  return isElementVisible(iframe) ? iframe : null;
}

function hasCloudflareChallengeText() {
  const bodyText = normalizeText(document.body?.innerText || '');
  return /please verify that you are not a robot|请验证您不是机器人|cloudflare/i.test(bodyText);
}

function getSoftCloudflareFirewallText() {
  const currentEmailInput = getCurrentMailboxInput();
  if (!currentEmailInput) {
    return '';
  }

  return normalizeText([
    currentEmailInput.value,
    currentEmailInput.getAttribute?.('title'),
    currentEmailInput.getAttribute?.('placeholder'),
    currentEmailInput.getAttribute?.('aria-label'),
  ].filter(Boolean).join(' '));
}

function hasSoftCloudflareFirewallMessage() {
  const text = getSoftCloudflareFirewallText();
  return /please confirm you are not a robot|performing the operation too fast/i.test(text);
}

function getCloudflareResponseTokenLength() {
  const input = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][id$="_response"]');
  return String(input?.value || '').trim().length;
}

function bumpHeartbeatWindow(nextHeartbeatAt, elapsedMs, intervalMs = CLOUDFLARE_PROGRESS_HEARTBEAT_MS) {
  let next = Math.max(intervalMs, Number(nextHeartbeatAt) || intervalMs);
  while (elapsedMs >= next) {
    next += intervalMs;
  }
  return next;
}

function hasCloudflareVisualSuccessIndicator() {
  const text = normalizeText(document.body?.innerText || '');
  return /(?:^|\s)(?:success|verified|verification succeeded)(?:!|$)|成功!?/i.test(text);
}

function hasCloudflareAutoVerifyingIndicator() {
  const text = normalizeText(document.body?.innerText || '');
  return /正在验证|验证中|verifying(?:\.\.\.)?|verification in progress|checking/i.test(text)
    && !hasCloudflareVisualSuccessIndicator();
}

function hasCloudflareChallengeShell() {
  return Boolean(findVisibleCloudflareChallengeContainer() || findVisibleCloudflareChallengeIframe());
}

function describeCloudflareChallengeForLog() {
  const wrapper = document.querySelector('.main-wrapper[role="main"]');
  const hiddenInput = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][id$="_response"]');
  const iframe = findVisibleCloudflareChallengeIframe();
  const container = findVisibleCloudflareChallengeContainer();
  const tokenLength = getCloudflareResponseTokenLength();

  if (isElementVisible(wrapper) && hiddenInput) {
    return `full-page challenge (${describeElementForLog(wrapper, 'wrapper')}; hiddenInput=#${hiddenInput.id || 'cf-turnstile-response'}; tokenLength=${tokenLength})`;
  }
  if (iframe) {
    return `iframe challenge (${describeElementForLog(iframe, 'iframe')}; tokenLength=${tokenLength})`;
  }
  if (container) {
    return `container challenge (${describeElementForLog(container, 'container')}; tokenLength=${tokenLength})`;
  }
  if (hiddenInput) {
    return `hidden-input challenge (input#${hiddenInput.id || 'cf-turnstile-response'}; tokenLength=${tokenLength})`;
  }
  if (hasSoftCloudflareFirewallMessage()) {
    return `soft-firewall challenge (${describeElementForLog(getCurrentMailboxInput(), 'currentEmail')}; text="${getSoftCloudflareFirewallText().slice(0, 120)}")`;
  }
  return 'challenge shell present, but no specific target was identified';
}

function getCurrentMailboxInput() {
  const input = document.querySelector('input[name="currentEmailAddress"]');
  return isElementVisible(input) ? input : null;
}

function getCurrentMailboxInputValue() {
  const input = getCurrentMailboxInput();
  return input ? String(input.value || input.getAttribute?.('value') || '').trim() : '';
}

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function getExpectedMailboxEmail(payload = {}) {
  return normalizeEmailAddress(payload?.targetEmail || payload?.expectedEmail || '');
}

function checkExpectedMailboxEmail(payload = {}) {
  const expectedEmail = getExpectedMailboxEmail(payload);
  if (!expectedEmail) {
    return null;
  }

  const pageEmail = normalizeEmailAddress(getCurrentMailboxInputValue());
  if (!pageEmail || pageEmail === expectedEmail) {
    return null;
  }

  log(`TMailor：当前页面邮箱 ${pageEmail} 与面板邮箱 ${expectedEmail} 不一致，刷新前先请求后台重开邮箱页。`, 'warn');
  return {
    recovery: 'reload_mailbox',
    reason: 'mailbox_email_mismatch',
    expectedEmail,
    pageEmail,
  };
}

function getMailboxReloadRecovery(error, options = {}) {
  const message = String(error?.message || error || '');
  if (!message) {
    return null;
  }

  if (/Cloudflare challenge detected on TMailor/i.test(message)) {
    if (options.cloudflareLog) {
      log(options.cloudflareLog, 'warn');
    }
    return {
      recovery: 'reload_mailbox',
      reason: 'cloudflare_challenge',
      error: message,
    };
  }

  if (/TMailor page did not finish loading mailbox controls/i.test(message)) {
    if (options.timeoutLog) {
      log(options.timeoutLog, 'warn');
    }
    return {
      recovery: 'reload_mailbox',
      reason: 'mailbox_controls_timeout',
      error: message,
    };
  }

  return null;
}

async function waitForMailboxControlsWithRecovery(timeout, options = {}) {
  try {
    await waitForMailboxControls(timeout);
    return null;
  } catch (error) {
    const recovery = getMailboxReloadRecovery(error, options);
    if (recovery) {
      return recovery;
    }
    throw error;
  }
}

function getPostConfirmMailboxRecoveryState() {
  const challengeTextVisible = hasCloudflareChallengeText();
  const currentEmailInput = getCurrentMailboxInput();
  const currentEmailValue = getCurrentMailboxInputValue();
  const newEmailButton = findNewEmailButton();
  const refreshButton = findRefreshInboxButton();
  const mailboxInputReady = Boolean(currentEmailInput && !currentEmailInput.disabled);
  const hasMailboxEmail = Boolean(currentEmailValue && EMAIL_REGEX.test(currentEmailValue));
  const controlsReady = Boolean(newEmailButton || refreshButton);
  const recovered = !challengeTextVisible && mailboxInputReady && (controlsReady || hasMailboxEmail);

  return {
    recovered,
    challengeTextVisible,
    mailboxInputReady,
    hasMailboxEmail,
    controlsReady,
    currentEmailValue,
    newEmailButton,
    refreshButton,
  };
}

function describePostConfirmMailboxRecoveryState(state) {
  return [
    `challengeTextVisible=${state.challengeTextVisible}`,
    `mailboxInputReady=${state.mailboxInputReady}`,
    `hasMailboxEmail=${state.hasMailboxEmail}`,
    `controlsReady=${state.controlsReady}`,
    `email=${state.currentEmailValue || 'none'}`,
  ].join('; ');
}

function detectTmailorPageState() {
  if (isFatalMailboxErrorVisible()) {
    return {
      kind: 'fatal_server_error',
      element: getCurrentMailboxInput(),
      message: 'An error occurred on the server. Please try again later',
    };
  }

  const monetizationDialog = findMonetizationVideoDialog();
  if (monetizationDialog) {
    return {
      kind: 'monetization_video_ad',
      element: monetizationDialog,
    };
  }

  const adBox = findInterstitialAdBox();
  if (adBox) {
    return {
      kind: 'blocking_ad',
      element: adBox,
    };
  }

  const wrapper = document.querySelector('.main-wrapper[role="main"]');
  const hiddenTurnstileResponse = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][id$="_response"]');
  if (isElementVisible(wrapper) && hiddenTurnstileResponse && /正在进行安全验证|security verification|performance and security by cloudflare|enable javascript and cookies to continue/i.test(normalizeText(document.body?.innerText || ''))) {
    return {
      kind: 'cloudflare_full_page',
      element: wrapper,
    };
  }

  const turnstileContainer = findVisibleCloudflareChallengeContainer();
  const confirmButton = findCloudflareConfirmButton();
  if (turnstileContainer || confirmButton) {
    return {
      kind: 'cloudflare_turnstile',
      element: turnstileContainer || confirmButton,
      confirmButton,
    };
  }

  const currentEmail = getCurrentMailboxInputValue();
  const displayedEmail = collectDisplayedEmails().find((candidate) => candidate.email);
  const refreshButton = findRefreshInboxButton();
  const newEmailButton = findNewEmailButton();
  const currentInputEmailMatch = currentEmail.match(EMAIL_REGEX);

  if ((displayedEmail?.email || currentInputEmailMatch?.[0]) && refreshButton) {
    return {
      kind: 'mailbox_ready',
      email: (displayedEmail?.email || currentInputEmailMatch?.[0] || '').toLowerCase(),
      element: getCurrentMailboxInput() || refreshButton,
    };
  }

  if (currentEmail && /please confirm you are not a robot|performing the operation too fast/i.test(currentEmail)) {
    return {
      kind: 'cloudflare_turnstile',
      element: getCurrentMailboxInput(),
      confirmButton,
    };
  }

  if (getCurrentMailboxInput() && newEmailButton) {
    return {
      kind: 'mailbox_idle',
      element: getCurrentMailboxInput(),
    };
  }

  return {
    kind: 'unknown',
    element: null,
  };
}

function isElementDisabled(el) {
  if (!el) {
    return true;
  }

  if (el.disabled === true) {
    return true;
  }

  const ariaDisabled = normalizeText(el.getAttribute?.('aria-disabled') || '');
  return ariaDisabled === 'true';
}

function getElementCenterRect(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    return null;
  }

  const rect = el.getBoundingClientRect();
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return {
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

function getCloudflareCheckboxRect(target, attemptNumber = 1) {
  if (!target || typeof target.getBoundingClientRect !== 'function') {
    return null;
  }

  const rect = target.getBoundingClientRect();
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const targetSummary = `${String(target.tagName || '').toUpperCase()} ${String(target.className || '')} ${String(target.id || '')}`.toLowerCase();
  const looksLikeTurnstile = /cf-turnstile|turnstile|cloudflare|html-captcha|iframe/.test(targetSummary);
  if (!looksLikeTurnstile) {
    const centerRect = getElementCenterRect(target);
    if (!centerRect) {
      return null;
    }
    return {
      ...centerRect,
      holdMs: 110,
      approachX: centerRect.centerX - 3,
      approachY: centerRect.centerY + 2,
      hotspotLabel: 'center',
      lane: 'generic',
      targetBox: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    };
  }

  const hotspot = CLOUDFLARE_TURNSTILE_HOTSPOTS[Math.max(0, (attemptNumber - 1) % CLOUDFLARE_TURNSTILE_HOTSPOTS.length)];
  const offsetX = Math.max(26, Math.min(rect.width * hotspot.xRatio, 54));
  const centerY = rect.top + (rect.height / 2);
  const clampedCenterY = Math.min(rect.top + rect.height - 12, Math.max(rect.top + 12, centerY + hotspot.yOffset));
  return {
    centerX: rect.left + offsetX,
    centerY: clampedCenterY,
    holdMs: 90 + (Math.max(0, (attemptNumber - 1) % 3) * 25),
    approachX: rect.left + Math.max(18, offsetX - 8),
    approachY: Math.min(rect.top + rect.height - 12, Math.max(rect.top + 12, clampedCenterY + ((attemptNumber % 2 === 0) ? -3 : 3))),
    hotspotLabel: `lane-${hotspot.xRatio.toFixed(2)}-${hotspot.yOffset >= 0 ? '+' : ''}${hotspot.yOffset}`,
    lane: 'turnstile-left-checkbox',
    targetBox: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
  };
}

async function requestDebuggerClickAt(rect) {
  const response = await chrome.runtime.sendMessage({
    type: 'DEBUGGER_CLICK_AT',
    source: 'tmailor-mail',
    payload: {
      rect,
      approachX: Number.isFinite(rect?.approachX) ? rect.approachX : undefined,
      approachY: Number.isFinite(rect?.approachY) ? rect.approachY : undefined,
      holdMs: Number.isFinite(rect?.holdMs) ? rect.holdMs : undefined,
    },
  });

  if (response?.error) {
    throw new Error(response.error);
  }
}

function isIgnoredCloseControl(el) {
  if (!el) {
    return false;
  }

  const ignoredContainer = typeof el.closest === 'function'
    ? el.closest('#google-anno-sa, [id^="google-anno-"]')
    : null;
  if (ignoredContainer) {
    return true;
  }

  const ariaLabel = normalizeText(el.getAttribute?.('aria-label') || '');
  return /close\s+shopping\s+anchor/i.test(ariaLabel);
}

function findBlockingAdCloseButton() {
  const dismissClose = document.querySelector('#dismiss-button-element > div');
  if (isElementVisible(dismissClose)) {
    const dismissRoot = typeof dismissClose.closest === 'function'
      ? dismissClose.closest('#dismiss-button-element, button, [role="button"], a')
      : null;
    if (isElementVisible(dismissRoot)) {
      return dismissRoot;
    }
    return dismissClose;
  }

  const dismissRoot = document.querySelector('#dismiss-button-element');
  if (isElementVisible(dismissRoot)) {
    return dismissRoot;
  }

  const selectors = 'button, [role="button"], a, summary';
  const buttons = Array.from(document.querySelectorAll(selectors)).filter(isElementVisible);
  return buttons.find((button) => {
    if (isIgnoredCloseControl(button)) {
      return false;
    }

    const text = normalizeText(button.textContent || button.getAttribute?.('aria-label') || '');
    return /^close$/i.test(text) || /\bclose\b/i.test(text);
  }) || null;
}

function findInterstitialAdBox() {
  const adBox = document.querySelector('#ad_position_box');
  return isElementVisible(adBox) ? adBox : null;
}

function hasBlockingInterstitialOverlay() {
  return Boolean(findInterstitialAdBox() || findBlockingAdCloseButton());
}

const REJECTED_VERIFICATION_DETAIL_STORAGE_KEY = '__MULTIPAGE_TMAILOR_REJECTED_VERIFICATION_DETAILS__';
const REJECTED_VERIFICATION_DETAIL_MAX_AGE_MS = 15 * 60 * 1000;
let rejectedVerificationDetailMemoryCache = {};

function getRejectedVerificationDetailStorage() {
  try {
    if (window?.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {}
  return null;
}

function normalizeRejectedVerificationDetailCache(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [key, entry] of Object.entries(rawValue)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    normalized[key] = {
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
      codes: Array.from(new Set((Array.isArray(entry.codes) ? entry.codes : [])
        .map((value) => String(value || '').trim())
        .filter((value) => /^\d{6}$/.test(value)))),
      mailIds: Array.from(new Set((Array.isArray(entry.mailIds) ? entry.mailIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean))),
    };
  }
  return normalized;
}

function loadRejectedVerificationDetailCache() {
  const storage = getRejectedVerificationDetailStorage();
  if (storage) {
    try {
      return normalizeRejectedVerificationDetailCache(JSON.parse(storage.getItem(REJECTED_VERIFICATION_DETAIL_STORAGE_KEY) || '{}'));
    } catch {}
  }
  return normalizeRejectedVerificationDetailCache(rejectedVerificationDetailMemoryCache);
}

function saveRejectedVerificationDetailCache(cache) {
  const normalizedCache = normalizeRejectedVerificationDetailCache(cache);
  rejectedVerificationDetailMemoryCache = normalizedCache;
  const storage = getRejectedVerificationDetailStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(REJECTED_VERIFICATION_DETAIL_STORAGE_KEY, JSON.stringify(normalizedCache));
  } catch {}
}

function pruneRejectedVerificationDetailCache(cache) {
  const now = Date.now();
  const nextCache = {};
  for (const [key, entry] of Object.entries(normalizeRejectedVerificationDetailCache(cache))) {
    if (now - entry.updatedAt > REJECTED_VERIFICATION_DETAIL_MAX_AGE_MS) {
      continue;
    }
    if (!entry.codes.length && !entry.mailIds.length) {
      continue;
    }
    nextCache[key] = entry;
  }
  return nextCache;
}

function buildRejectedVerificationDetailCacheKey(step, payload = {}) {
  const numericStep = Number.parseInt(String(step ?? 0), 10) || 0;
  const targetEmail = String(payload?.targetEmail || '').trim().toLowerCase();
  return `${numericStep}:${targetEmail}`;
}

function getRememberedRejectedVerificationDetails(step, payload = {}) {
  const numericStep = Number.parseInt(String(step ?? 0), 10) || 0;
  if (numericStep !== 7) {
    return { codes: [], mailIds: [] };
  }

  const nextCache = pruneRejectedVerificationDetailCache(loadRejectedVerificationDetailCache());
  saveRejectedVerificationDetailCache(nextCache);
  const entry = nextCache[buildRejectedVerificationDetailCacheKey(step, payload)] || {};
  return {
    codes: Array.isArray(entry.codes) ? entry.codes.slice() : [],
    mailIds: Array.isArray(entry.mailIds) ? entry.mailIds.slice() : [],
  };
}

function rememberRejectedVerificationDetail(step, payload = {}, detail = {}) {
  const numericStep = Number.parseInt(String(step ?? 0), 10) || 0;
  if (numericStep !== 7) {
    return;
  }

  const code = String(detail?.code || '').trim();
  const mailId = String(detail?.mailId || '').trim();
  if (!/^\d{6}$/.test(code) && !mailId) {
    return;
  }

  const cache = pruneRejectedVerificationDetailCache(loadRejectedVerificationDetailCache());
  const key = buildRejectedVerificationDetailCacheKey(step, payload);
  const currentEntry = cache[key] || { updatedAt: Date.now(), codes: [], mailIds: [] };
  if (/^\d{6}$/.test(code)) {
    currentEntry.codes = Array.from(new Set([...(currentEntry.codes || []), code]));
  }
  if (mailId) {
    currentEntry.mailIds = Array.from(new Set([...(currentEntry.mailIds || []), mailId]));
  }
  currentEntry.updatedAt = Date.now();
  cache[key] = currentEntry;
  saveRejectedVerificationDetailCache(cache);
}

function clearRememberedRejectedVerificationDetails(step, payload = {}) {
  const cache = pruneRejectedVerificationDetailCache(loadRejectedVerificationDetailCache());
  delete cache[buildRejectedVerificationDetailCacheKey(step, payload)];
  saveRejectedVerificationDetailCache(cache);
}

function findMailDetailSkipButton() {
  const directMatch = document.querySelector('button[name="skip"]');
  if (isElementVisible(directMatch)) {
    return directMatch;
  }

  const buttons = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(isElementVisible);
  return buttons.find((button) => {
    const metaText = normalizeText([
      button.textContent,
      button.getAttribute?.('aria-label'),
      button.getAttribute?.('title'),
      button.getAttribute?.('name'),
    ].filter(Boolean).join(' ')).toLowerCase();
    return /\bskip\b/.test(metaText);
  }) || null;
}

function getMailDetailSkipCountdown(button) {
  if (!button) {
    return null;
  }

  const countdownNode = typeof button.querySelector === 'function'
    ? button.querySelector('.show-coundown')
    : null;
  const countdownText = normalizeText(countdownNode?.textContent || button.textContent || '');
  const countdownMatch = countdownText.match(/\b(\d{1,3})\b/);
  if (!countdownMatch) {
    return null;
  }

  const countdown = Number.parseInt(countdownMatch[1], 10);
  return Number.isFinite(countdown) ? countdown : null;
}

async function handleMailDetailSkipNotice(timeoutMs = 6000) {
  const start = Date.now();
  let clickedSkip = false;
  let loggedNoticeDetected = false;
  let lastWaitingCountdown = null;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const skipButton = findMailDetailSkipButton();
    if (!skipButton) {
      return clickedSkip;
    }

    const countdown = getMailDetailSkipCountdown(skipButton);
    if (!loggedNoticeDetected) {
      loggedNoticeDetected = true;
      log(
        `TMailor: Mail detail Skip notice detected (${describeElementForLog(skipButton, 'skip')}${Number.isFinite(countdown) ? `; countdown=${countdown}` : ''})`,
        'info'
      );
    }

    if (!Number.isFinite(countdown) || countdown <= TMAILOR_SKIP_READY_COUNTDOWN) {
      log(
        `TMailor: Mail detail Skip is ready${Number.isFinite(countdown) ? ` at countdown ${countdown}` : ''}, clicking Skip (${describeElementForLog(skipButton, 'skip')})`,
        'info'
      );
      simulateClick(skipButton);
      clickedSkip = true;
      await sleep(900);
      continue;
    }

    if (lastWaitingCountdown !== countdown) {
      lastWaitingCountdown = countdown;
      log(
        `TMailor: Mail detail Skip countdown is ${countdown}. Waiting until it reaches ${TMAILOR_SKIP_READY_COUNTDOWN} before clicking.`,
        'info'
      );
    }

    await sleep(250);
  }

  return clickedSkip;
}

async function handleDismissibleInterstitialAd(timeoutMs = 4000) {
  const start = Date.now();
  let loggedWaiting = false;
  let clickedClose = false;
  let loggedOverlayDetected = false;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const adBox = findInterstitialAdBox();
    if (!adBox) {
      return clickedClose;
    }

    const closeButton = findBlockingAdCloseButton();
    if (!loggedOverlayDetected) {
      loggedOverlayDetected = true;
      log(`TMailor: Blocking ad overlay detected (${describeElementForLog(adBox, 'overlay')})`, 'info');
    }
    if (closeButton) {
      log(`TMailor: Blocking overlay detected, clicking Close (${describeElementForLog(closeButton, 'close')})`, 'info');
      simulateClick(closeButton);
      clickedClose = true;
      await sleep(900);
      continue;
    }

    if (!loggedWaiting) {
      loggedWaiting = true;
      log('TMailor: Waiting for the ad overlay Close button to appear after detecting the overlay', 'info');
    }

    await sleep(500);
  }

  return clickedClose;
}

function findMonetizationVideoDialog() {
  const selectors = [
    'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog',
    '.fc-monetization-dialog.fc-dialog',
  ];

  for (const selector of selectors) {
    const dialog = document.querySelector(selector);
    if (isElementVisible(dialog)) {
      return dialog;
    }
  }

  return null;
}

function findMonetizationVideoPlayButton() {
  const selector = 'body > div.fc-message-root > div.fc-monetization-dialog-container > div.fc-monetization-dialog.fc-dialog > div > div.fc-list-container > button';
  const exactMatch = document.querySelector(selector);
  if (isElementVisible(exactMatch)) {
    return exactMatch;
  }

  const dialog = findMonetizationVideoDialog();
  if (!dialog || typeof dialog.querySelectorAll !== 'function') {
    return findButtonByText([/view a short ad/i, /watch.*ad/i, /short ad/i]);
  }

  return Array.from(dialog.querySelectorAll('button, [role="button"], a')).find((button) => {
    if (!isElementVisible(button)) {
      return false;
    }
    return /view a short ad|watch.*ad|short ad/i.test(normalizeText(button.textContent || ''));
  }) || null;
}

function findMonetizationVideoCloseButton() {
  const exactMatch = document.querySelector('#dismiss-button-element > div');
  if (isElementVisible(exactMatch)) {
    const dismissRoot = typeof exactMatch.closest === 'function'
      ? exactMatch.closest('#dismiss-button-element, button, [role="button"], a')
      : null;
    if (isElementVisible(dismissRoot)) {
      return dismissRoot;
    }
    return exactMatch;
  }

  const closeRoot = document.querySelector('#dismiss-button-element');
  if (isElementVisible(closeRoot)) {
    return closeRoot;
  }

  return null;
}

async function handleMonetizationVideoAd(timeoutMs = 20000) {
  const start = Date.now();
  let clickedPlay = false;
  let loggedPlay = false;
  let loggedWaitingForClose = false;
  let loggedDialogDetected = false;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const dialog = findMonetizationVideoDialog();
    if (dialog && !loggedDialogDetected) {
      loggedDialogDetected = true;
      log(`TMailor: Monetization video dialog detected (${describeElementForLog(dialog, 'dialog')})`, 'info');
    }
    const playButton = findMonetizationVideoPlayButton();
    if (playButton) {
      if (!loggedPlay) {
        loggedPlay = true;
        log(`TMailor: Monetization video ad overlay detected, clicking Play (${describeElementForLog(playButton, 'play')})`, 'info');
      }
      simulateClick(playButton);
      clickedPlay = true;
      await sleep(1200);
      continue;
    }

    const closeButton = findMonetizationVideoCloseButton();
    if (closeButton) {
      log(`TMailor: Monetization video ad finished, clicking Close (${describeElementForLog(closeButton, 'close')})`, 'info');
      simulateClick(closeButton);
      await sleep(1200);
      return true;
    }

    const dialogVisible = Boolean(dialog);
    if (!dialogVisible && !clickedPlay) {
      return false;
    }

    if (clickedPlay && !loggedWaitingForClose) {
      loggedWaitingForClose = true;
      log('TMailor: Waiting for the monetization ad Close button to appear', 'info');
    }

    await sleep(1000);
  }

  if (clickedPlay || findMonetizationVideoDialog() || findMonetizationVideoCloseButton()) {
    log('TMailor：等待超时后，变现视频广告仍在阻挡邮箱页面。', 'warn');
  }
  return false;
}

function isCloudflareChallengeVisible() {
  return hasCloudflareChallengeText() || hasCloudflareChallengeShell() || hasSoftCloudflareFirewallMessage();
}

function isFatalMailboxErrorVisible() {
  const bodyText = normalizeText(document.body?.innerText || '');
  if (/an error occurred on the server\.\s*please try again later/i.test(bodyText)) {
    return true;
  }

  const currentEmailInput = document.querySelector('input[name="currentEmailAddress"]');
  if (!isElementVisible(currentEmailInput)) {
    return false;
  }

  const inputText = normalizeText([
    currentEmailInput.value,
    currentEmailInput.getAttribute?.('title'),
    currentEmailInput.getAttribute?.('placeholder'),
    currentEmailInput.getAttribute?.('aria-label'),
  ].filter(Boolean).join(' '));

  return Boolean(currentEmailInput.disabled) && /an error occurred on the server\.\s*please try again later/i.test(inputText);
}

function assertNoFatalMailboxError() {
  if (isFatalMailboxErrorVisible()) {
    throw new Error('TMailor server error detected while refreshing the mailbox. The node or current network path may be unstable. Change node first; if it still fails across nodes, try again later.');
  }
}

function assertNoManualTakeoverBlockers() {
  if (hasBlockingInterstitialOverlay()) {
    throw new Error('Blocking overlay detected on TMailor. Temporary failure, please take over manually.');
  }

  if (isCloudflareChallengeVisible()) {
    throw new Error('Cloudflare challenge detected on TMailor. Temporary failure, please take over manually.');
  }
}

async function dismissBlockingOverlay(timeoutMs = 4000) {
  const handledInterstitialAd = await handleDismissibleInterstitialAd(timeoutMs);
  if (handledInterstitialAd) {
    log('TMailor：遮挡层已成功关闭。', 'ok');
    return true;
  }

  const start = Date.now();
  let sawCloseButton = false;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const closeButton = findBlockingAdCloseButton();
    if (!closeButton) {
      if (sawCloseButton) {
        log('TMailor：遮挡层已成功关闭。', 'ok');
      }
      return false;
    }

    sawCloseButton = true;
    log(`TMailor: Blocking overlay detected, clicking Close (${describeElementForLog(closeButton, 'close')})`, 'info');
    simulateClick(closeButton);
    await sleep(600);

    if (!findBlockingAdCloseButton()) {
      log('TMailor：遮挡层已成功关闭。', 'ok');
      return true;
    }
  }

  if (sawCloseButton) {
    log('TMailor：重试等待结束后，遮挡层仍然可见。', 'warn');
  }
  return false;
}

async function ensureCloudflareChallengeClearedOrThrow(timeoutMs = DEFAULT_CLOUDFLARE_TIMEOUT_MS) {
  const start = Date.now();
  const observeBeforeCheckboxMs = 5000;
  const postConfirmProbeMs = Math.max(2500, Math.min(12000, Math.max(timeoutMs, 4000)));
  const postConfirmRetryDelayMs = postConfirmProbeMs >= 11000
    ? 8000
    : Math.max(0, postConfirmProbeMs - 3000);
  let nextPostConfirmHeartbeatAt = CLOUDFLARE_PROGRESS_HEARTBEAT_MS;
  if (hasBlockingInterstitialOverlay()) {
    throw new Error('Blocking overlay detected on TMailor. Temporary failure, please take over manually.');
  }
  if (!isCloudflareChallengeVisible()) {
    return false;
  }

  log('TMailor：Cloudflare 验证正在阻挡邮箱，先尝试自动处理。', 'warn');
  const handled = await waitForCloudflareConfirm(timeoutMs, {
    observeBeforeCheckboxMs,
  });
  if (handled) {
    if (!isCloudflareChallengeVisible()) {
      log('TMailor：Cloudflare 验证已自动通过。', 'ok');
      return true;
    }

    const graceStart = Date.now();
    let retriedConfirm = false;
    log(`TMailor: Cloudflare verification was submitted. Probing mailbox recovery for up to ${postConfirmProbeMs}ms before manual takeover...`, 'info');
    while (Date.now() - graceStart < postConfirmProbeMs) {
      throwIfStopped();
      const postConfirmElapsedMs = Math.max(0, Date.now() - graceStart);
      if (!isCloudflareChallengeVisible()) {
        log('TMailor：Cloudflare 验证在 Confirm 后的缓冲期内已通过。', 'ok');
        return true;
      }

      if (postConfirmElapsedMs >= nextPostConfirmHeartbeatAt) {
        const responseTokenLength = getCloudflareResponseTokenLength();
        const confirmButton = findCloudflareConfirmButton();
        log(
          `TMailor: Cloudflare challenge still blocking the mailbox after Confirm (${Math.round(postConfirmElapsedMs / 1000)}s elapsed; tokenLength=${responseTokenLength}; confirm=${confirmButton ? (isElementDisabled(confirmButton) ? 'disabled' : 'enabled') : 'missing'})`,
          'info'
        );
        nextPostConfirmHeartbeatAt = bumpHeartbeatWindow(nextPostConfirmHeartbeatAt, postConfirmElapsedMs);
      }

      const recoveryState = getPostConfirmMailboxRecoveryState();
      if (recoveryState.recovered) {
        log(
          `TMailor: Mailbox controls recovered after Confirm even though the challenge shell is still mounted (${describePostConfirmMailboxRecoveryState(recoveryState)}). Treating the challenge as cleared.`,
          'ok'
        );
        return true;
      }

      if (!retriedConfirm && postConfirmRetryDelayMs > 0 && Date.now() - graceStart >= postConfirmRetryDelayMs) {
        const responseTokenLength = getCloudflareResponseTokenLength();
        const confirmButton = findCloudflareConfirmButton();
        if (responseTokenLength > 0 && confirmButton && !isElementDisabled(confirmButton)) {
          retriedConfirm = true;
          log(
            `TMailor: Post-confirm probe reached ${postConfirmRetryDelayMs}ms without mailbox recovery. Token still exists, so retrying Confirm once (${describeElementForLog(confirmButton, 'confirm')}).`,
            'warn'
          );
          simulateClick(confirmButton);
          await sleep(1200);
          continue;
        }
      }

      await sleep(250);
    }

    if (!isCloudflareChallengeVisible()) {
      log('TMailor：Cloudflare 验证在 Confirm 后的缓冲期内已通过。', 'ok');
      return true;
    }

    const recoveryState = getPostConfirmMailboxRecoveryState();
    if (recoveryState.recovered) {
      log(
        `TMailor: Mailbox controls recovered after Confirm even though the challenge shell is still mounted (${describePostConfirmMailboxRecoveryState(recoveryState)}). Treating the challenge as cleared.`,
        'ok'
      );
      return true;
    }
  }

  if (handled) {
    log('TMailor：Cloudflare 自动尝试已执行，但挑战外壳仍然可见。', 'warn');
  } else {
    log('TMailor：Cloudflare 自动尝试超时，挑战仍未解除。', 'warn');
  }

  throw new Error('Cloudflare challenge detected on TMailor. Automatic verification did not complete, please take over manually.');
}

async function waitForCloudflareConfirm(timeoutMs = DEFAULT_CLOUDFLARE_TIMEOUT_MS, options = {}) {
  const start = Date.now();
  const gracePeriodMs = Math.min(1500, timeoutMs);
  const delayedConfirmRetryMs = 6000;
  const enabledConfirmTimeoutFallbackMs = 10000;
  const textFallbackGraceMs = 1800;
  const visualSuccessFallbackMs = 5000;
  const autoVerificationWaitMs = 12000;
  const observeBeforeCheckboxMs = Math.max(0, Number.isFinite(options?.observeBeforeCheckboxMs) ? options.observeBeforeCheckboxMs : 0);
  let sawChallenge = false;
  let challengeResolvedAt = 0;
  let lastCheckboxAttemptAt = 0;
  let firstCheckboxAttemptAt = 0;
  let lastConfirmAttemptAt = 0;
  let loggedChallengeDetected = false;
  let loggedConfirmDisabled = false;
  let loggedWaitingForCheckbox = false;
  let loggedWaitingForVerificationResult = false;
  let loggedPrematureConfirm = false;
  let hasAttemptedCheckboxClick = false;
  let loggedChallengeDetails = false;
  let loggedResponseTokenDetected = false;
  let lastCheckboxSource = '';
  let checkboxAttemptCount = 0;
  let confirmAttemptCount = 0;
  let lastDiagnosticSignature = '';
  let lastDiagnosticLogAt = 0;
  let loggedTextFallbackDelay = false;
  let visualSuccessFallbackUsed = false;
  let loggedNoTokenThreshold = false;
  let loggedAutoVerifyingWait = false;
  let sawAutoVerifyingIndicator = false;
  let loggedObserveBeforeCheckbox = false;
  let nextProgressHeartbeatAt = CLOUDFLARE_PROGRESS_HEARTBEAT_MS;

  function hasVerificationCompletionSignal(tokenLength) {
    return Number(tokenLength) > 0;
  }

  function getConfirmState(confirmButton) {
    if (!confirmButton) {
      return 'missing';
    }
    return isElementDisabled(confirmButton) ? 'disabled' : 'enabled';
  }

  function buildDiagnosticMessage(reason, {
    challengeTextVisible,
    challengeShellVisible,
    responseTokenLength,
    confirmButton,
    checkboxCandidate,
  }) {
    const elapsed = Date.now() - start;
    const candidateSource = checkboxCandidate?.source || 'none';
    const parts = [
      `elapsed=${elapsed}ms`,
      `tokenLength=${responseTokenLength}`,
      `challengeTextVisible=${challengeTextVisible}`,
      `challengeShellVisible=${challengeShellVisible}`,
      `confirm=${getConfirmState(confirmButton)}`,
      `attemptedCheckbox=${hasAttemptedCheckboxClick}`,
      `checkboxAttempts=${checkboxAttemptCount}`,
      `confirmAttempts=${confirmAttemptCount}`,
      `lastPath=${lastCheckboxSource || 'none'}`,
      `candidatePath=${candidateSource}`,
    ];
    if (checkboxCandidate?.target) {
      parts.push(describeElementForLog(checkboxCandidate.target, 'candidate'));
    }
    return `TMailor: Cloudflare ${reason} (${parts.join('; ')})`;
  }

  function logConfirmDecision(reason, {
    challengeTextVisible,
    challengeShellVisible,
    responseTokenLength,
    confirmButton,
  }) {
    log(`TMailor: Cloudflare confirm decision (reason=${reason}; tokenLength=${responseTokenLength}; challengeTextVisible=${challengeTextVisible}; challengeShellVisible=${challengeShellVisible}; confirm=${getConfirmState(confirmButton)}; checkboxAttempts=${checkboxAttemptCount}; confirmAttempts=${confirmAttemptCount}; lastPath=${lastCheckboxSource || 'none'}${confirmButton ? `; ${describeElementForLog(confirmButton, 'confirm')}` : ''})`, 'info');
    log(
      `TMailor: Cloudflare Confirm trigger: reason=${reason}; token=${responseTokenLength > 0 ? 'yes' : 'no'}; tokenLength=${responseTokenLength}; visualSuccess=${hasCloudflareVisualSuccessIndicator() ? 'yes' : 'no'}; autoVerifyingSeen=${sawAutoVerifyingIndicator ? 'yes' : 'no'}; checkboxClicked=${hasAttemptedCheckboxClick ? 'yes' : 'no'}; challengeTextVisible=${challengeTextVisible ? 'yes' : 'no'}; challengeShellVisible=${challengeShellVisible ? 'yes' : 'no'}; confirm=${getConfirmState(confirmButton)}`,
      'info'
    );
  }

  async function tryClickConfirmAfterVerification(reason) {
    const responseTokenLength = getCloudflareResponseTokenLength();
    if (!hasVerificationCompletionSignal(responseTokenLength)) {
      return false;
    }
    const challengeTextVisible = hasCloudflareChallengeText();
    const challengeShellVisible = hasCloudflareChallengeShell();
    const confirmButton = findCloudflareConfirmButton();
    if (!confirmButton || isElementDisabled(confirmButton)) {
      return false;
    }
    if (reason === 'delayed-retry') {
      lastConfirmAttemptAt = Date.now();
    }
    logConfirmDecision(reason, {
      challengeTextVisible,
      challengeShellVisible,
      responseTokenLength,
      confirmButton,
    });
    log(`TMailor: Cloudflare ${reason === 'post-click-check' ? 'verification finished right after the checkbox click, clicking Confirm' : 'retry window reached after checkbox verification, clicking Confirm'} (${describeElementForLog(confirmButton, 'confirm')}${lastCheckboxSource ? `; path=${lastCheckboxSource}` : ''})`, 'info');
    confirmAttemptCount += 1;
    simulateClick(confirmButton);
    await sleep(1200);
    if (lastCheckboxSource) {
      log(`TMailor: Cloudflare verification path: ${lastCheckboxSource}`, 'info');
    }
    return true;
  }

  function maybeLogDiagnosticState({
    challengeTextVisible,
    challengeShellVisible,
    responseTokenLength,
    confirmButton,
    checkboxCandidate,
  }) {
    const signature = [
      challengeTextVisible ? '1' : '0',
      challengeShellVisible ? '1' : '0',
      responseTokenLength,
      getConfirmState(confirmButton),
      checkboxCandidate?.source || 'none',
      lastCheckboxSource || 'none',
      hasAttemptedCheckboxClick ? '1' : '0',
      checkboxAttemptCount,
      confirmAttemptCount,
    ].join('|');
    const now = Date.now();
    if (signature === lastDiagnosticSignature && now - lastDiagnosticLogAt < 2000) {
      return;
    }
    lastDiagnosticSignature = signature;
    lastDiagnosticLogAt = now;
    log(buildDiagnosticMessage('state update', {
      challengeTextVisible,
      challengeShellVisible,
      responseTokenLength,
      confirmButton,
      checkboxCandidate,
    }), 'info');
  }

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const challengeTextVisible = hasCloudflareChallengeText();
    const challengeShellVisible = hasCloudflareChallengeShell();
    const challengeVisible = challengeTextVisible || challengeShellVisible;
    const responseTokenLength = getCloudflareResponseTokenLength();
    const elapsedMs = Math.max(0, Date.now() - start);

    if (!challengeVisible) {
      if (sawChallenge) {
        if (!challengeResolvedAt) {
          challengeResolvedAt = Date.now();
          log('TMailor: Cloudflare challenge is no longer visible', 'info');
        }
        const confirmButton = findCloudflareConfirmButton();
        if (confirmButton && !isElementDisabled(confirmButton)) {
          logConfirmDecision('challenge-hidden', {
            challengeTextVisible,
            challengeShellVisible,
            responseTokenLength,
            confirmButton,
          });
          confirmAttemptCount += 1;
          log('TMailor: Cloudflare verification detected, clicking Confirm', 'info');
          simulateClick(confirmButton);
          await sleep(1200);
          return true;
        }
        await sleep(200);
        continue;
      }
      if (Date.now() - start >= gracePeriodMs) {
        return false;
      }
      await sleep(200);
      continue;
    }

    if (!challengeTextVisible && sawChallenge && (hasAttemptedCheckboxClick || loggedConfirmDisabled) && hasVerificationCompletionSignal(responseTokenLength)) {
      const confirmButton = findCloudflareConfirmButton();
      if (confirmButton && !isElementDisabled(confirmButton)) {
        if (!challengeResolvedAt) {
          challengeResolvedAt = Date.now();
          log('TMailor: Cloudflare challenge shell remains, but verification looks complete', 'info');
        }
        logConfirmDecision('verification-signal', {
          challengeTextVisible,
          challengeShellVisible,
          responseTokenLength,
          confirmButton,
        });
        log(`TMailor: Cloudflare verification detected (tokenLength=${responseTokenLength}), clicking Confirm${lastCheckboxSource ? ` (path=${lastCheckboxSource})` : ''}`, 'info');
        confirmAttemptCount += 1;
        simulateClick(confirmButton);
        await sleep(1200);
        if (lastCheckboxSource) {
          log(`TMailor: Cloudflare verification path: ${lastCheckboxSource}`, 'info');
        }
        return true;
      }
    }

    if (responseTokenLength > 0 && !loggedResponseTokenDetected) {
      loggedResponseTokenDetected = true;
      log(`TMailor: Cloudflare response token detected (length=${responseTokenLength}). Waiting for a stable confirm decision...`, 'info');
    }

    if (
      sawAutoVerifyingIndicator
      && !hasAttemptedCheckboxClick
      && !hasVerificationCompletionSignal(responseTokenLength)
      && hasCloudflareVisualSuccessIndicator()
    ) {
      const confirmButton = findCloudflareConfirmButton();
      if (confirmButton && !isElementDisabled(confirmButton)) {
        visualSuccessFallbackUsed = true;
        log('TMailor: Cloudflare challenge auto-verified without a checkbox click. Clicking Confirm after the visual success signal...', 'info');
        logConfirmDecision('visual-success-auto', {
          challengeTextVisible,
          challengeShellVisible,
          responseTokenLength,
          confirmButton,
        });
        confirmAttemptCount += 1;
        simulateClick(confirmButton);
        await sleep(1200);
        return true;
      }
    }

    if (
      !hasAttemptedCheckboxClick
      && !hasVerificationCompletionSignal(responseTokenLength)
      && hasCloudflareAutoVerifyingIndicator()
      && Date.now() - start < autoVerificationWaitMs
    ) {
      sawAutoVerifyingIndicator = true;
      if (!loggedAutoVerifyingWait) {
        loggedAutoVerifyingWait = true;
        log('TMailor: Cloudflare is auto-verifying in the background. Waiting for a success signal before touching the checkbox...', 'info');
      }
      await sleep(250);
      continue;
    }

    if (
      observeBeforeCheckboxMs > 0
      && !hasAttemptedCheckboxClick
      && !hasVerificationCompletionSignal(responseTokenLength)
      && Date.now() - start < observeBeforeCheckboxMs
    ) {
      if (!loggedObserveBeforeCheckbox) {
        loggedObserveBeforeCheckbox = true;
        log(`TMailor: Observation window is active for the first ${observeBeforeCheckboxMs}ms. Waiting before the first checkbox click...`, 'info');
      }
      await sleep(250);
      continue;
    }

    if (hasAttemptedCheckboxClick && hasVerificationCompletionSignal(responseTokenLength) && Date.now() - lastConfirmAttemptAt >= delayedConfirmRetryMs) {
      if (await tryClickConfirmAfterVerification('delayed-retry')) {
        return true;
      }
    }

    if (
      hasAttemptedCheckboxClick
      && !visualSuccessFallbackUsed
      && !hasVerificationCompletionSignal(responseTokenLength)
      && firstCheckboxAttemptAt
      && Date.now() - firstCheckboxAttemptAt >= visualSuccessFallbackMs
      && hasCloudflareVisualSuccessIndicator()
    ) {
      const confirmButton = findCloudflareConfirmButton();
      if (confirmButton && !isElementDisabled(confirmButton)) {
        visualSuccessFallbackUsed = true;
        log('TMailor：Cloudflare 组件显示已成功，但 5000ms 内仍未观察到 token，改用 Confirm 作为兜底。', 'warn');
        logConfirmDecision('visual-success-fallback', {
          challengeTextVisible,
          challengeShellVisible,
          responseTokenLength,
          confirmButton,
        });
        confirmAttemptCount += 1;
        simulateClick(confirmButton);
        await sleep(1200);
        if (lastCheckboxSource) {
          log(`TMailor: Cloudflare verification path: ${lastCheckboxSource}`, 'info');
        }
        return true;
      }
    }

    if (
      hasAttemptedCheckboxClick
      && !hasVerificationCompletionSignal(responseTokenLength)
      && firstCheckboxAttemptAt
      && Date.now() - firstCheckboxAttemptAt >= enabledConfirmTimeoutFallbackMs
      && checkboxAttemptCount <= 2
      && confirmAttemptCount === 0
    ) {
      const confirmButton = findCloudflareConfirmButton();
      if (confirmButton && !isElementDisabled(confirmButton)) {
        log(
          `TMailor: Cloudflare checkbox attempts have been running for ${enabledConfirmTimeoutFallbackMs}ms without a token, but Confirm is enabled. Trying Confirm as a fallback...`,
          'warn'
        );
        logConfirmDecision('enabled-confirm-timeout-fallback', {
          challengeTextVisible,
          challengeShellVisible,
          responseTokenLength,
          confirmButton,
        });
        confirmAttemptCount += 1;
        lastConfirmAttemptAt = Date.now();
        simulateClick(confirmButton);
        await sleep(1200);
        if (lastCheckboxSource) {
          log(`TMailor: Cloudflare verification path: ${lastCheckboxSource}`, 'info');
        }
        return true;
      }
    }

    sawChallenge = true;
    challengeResolvedAt = 0;
    if (!loggedChallengeDetected) {
      loggedChallengeDetected = true;
      log('TMailor: Cloudflare challenge detected, waiting for verification controls', 'info');
    }
    if (!loggedChallengeDetails) {
      loggedChallengeDetails = true;
      log(`TMailor: Cloudflare challenge details: ${describeCloudflareChallengeForLog()}`, 'info');
    }
    const confirmButton = findCloudflareConfirmButton();
    if (confirmButton && !isElementDisabled(confirmButton) && !loggedPrematureConfirm) {
      loggedPrematureConfirm = true;
      log(`TMailor: Cloudflare Confirm button is already enabled, but verification is still pending (${describeElementForLog(confirmButton, 'confirm')})`, 'info');
    }

    if (confirmButton && isElementDisabled(confirmButton) && !loggedConfirmDisabled) {
      loggedConfirmDisabled = true;
      log(`TMailor: Cloudflare Confirm button is still disabled, waiting for checkbox verification (${describeElementForLog(confirmButton, 'confirm')})`, 'info');
    }

    const checkboxCandidate = findCloudflareCheckboxTargetCandidate();
    maybeLogDiagnosticState({
      challengeTextVisible,
      challengeShellVisible,
      responseTokenLength,
      confirmButton,
      checkboxCandidate,
    });

    if (elapsedMs >= nextProgressHeartbeatAt) {
      log(
        `TMailor: Cloudflare challenge still blocking the mailbox (${Math.round(elapsedMs / 1000)}s elapsed; tokenLength=${responseTokenLength}; confirm=${getConfirmState(confirmButton)}; checkboxAttempts=${checkboxAttemptCount}; confirmAttempts=${confirmAttemptCount})`,
        'info'
      );
      nextProgressHeartbeatAt = bumpHeartbeatWindow(nextProgressHeartbeatAt, elapsedMs);
    }

    if (
      hasAttemptedCheckboxClick
      && !hasVerificationCompletionSignal(responseTokenLength)
      && checkboxAttemptCount >= MAX_CLOUDFLARE_CHECKBOX_ATTEMPTS
    ) {
      if (!loggedNoTokenThreshold) {
        loggedNoTokenThreshold = true;
        log(
          `TMailor: Cloudflare auto-attempt reached ${MAX_CLOUDFLARE_CHECKBOX_ATTEMPTS} checkbox clicks without receiving a token. Pausing further checkbox clicks and waiting for a late verification signal or timeout...`,
          'warn'
        );
      }
      await sleep(250);
      continue;
    }

    if (Date.now() - lastCheckboxAttemptAt >= 1500) {
      const checkboxTarget = checkboxCandidate?.target || null;
      const checkboxSource = checkboxCandidate?.source || 'unknown';
      if (checkboxSource === 'text-fallback' && !challengeShellVisible && Date.now() - start < textFallbackGraceMs) {
        if (!loggedTextFallbackDelay) {
          loggedTextFallbackDelay = true;
          log(`TMailor: Cloudflare fallback text appeared before the widget. Waiting briefly for the real checkbox container before using ${checkboxSource}...`, 'info');
        }
        await sleep(250);
        continue;
      }
      const nextAttemptNumber = checkboxAttemptCount + 1;
      const checkboxRect = getCloudflareCheckboxRect(checkboxTarget, nextAttemptNumber);
      if (checkboxRect) {
        lastCheckboxAttemptAt = Date.now();
        if (!firstCheckboxAttemptAt) {
          firstCheckboxAttemptAt = lastCheckboxAttemptAt;
        }
        hasAttemptedCheckboxClick = true;
        lastCheckboxSource = checkboxSource;
        checkboxAttemptCount += 1;
        log(
          `TMailor: Cloudflare checkbox hotspot (attempt ${checkboxAttemptCount}/${MAX_CLOUDFLARE_CHECKBOX_ATTEMPTS}; source=${checkboxSource}; lane=${checkboxRect.lane || 'unknown'}; hotspot=${checkboxRect.hotspotLabel || 'default'}; targetBox=${Math.round(checkboxRect.targetBox?.left || 0)},${Math.round(checkboxRect.targetBox?.top || 0)} ${Math.round(checkboxRect.targetBox?.width || 0)}x${Math.round(checkboxRect.targetBox?.height || 0)}; click=${Math.round(checkboxRect.centerX)},${Math.round(checkboxRect.centerY)}; approach=${Math.round(checkboxRect.approachX || checkboxRect.centerX)},${Math.round(checkboxRect.approachY || checkboxRect.centerY)}; hold=${Math.round(checkboxRect.holdMs || 0)}ms)`,
          'info'
        );
        log(`TMailor: Cloudflare checkbox detected via ${checkboxSource}, clicking verification area (${describeElementForLog(checkboxTarget, 'target')}; center=${Math.round(checkboxRect.centerX)},${Math.round(checkboxRect.centerY)})`, 'info');

        try {
          await requestDebuggerClickAt(checkboxRect);
        } catch (err) {
          if (String(checkboxTarget.tagName || '').toUpperCase() === 'IFRAME') {
            throw err;
          }
          log(`TMailor：Debugger 点击 Cloudflare 容器失败，改用 DOM 点击兜底：${err?.message || err}`, 'warn');
          simulateClick(checkboxTarget);
        }

        if (!loggedWaitingForVerificationResult) {
          loggedWaitingForVerificationResult = true;
          log('TMailor: Cloudflare checkbox click dispatched. Waiting for the challenge to report success before clicking Confirm...', 'info');
        }
        if (await tryClickConfirmAfterVerification('post-click-check')) {
          return true;
        }
        await sleep(1600);
        if (await tryClickConfirmAfterVerification('post-click-check')) {
          return true;
        }
        continue;
      }

      if (!loggedWaitingForCheckbox) {
        loggedWaitingForCheckbox = true;
        log(`TMailor: Waiting for Cloudflare checkbox to render. Current challenge details: ${describeCloudflareChallengeForLog()}`, 'info');
      }
    }

    await sleep(250);
  }

  if (sawChallenge) {
    const challengeTextVisible = hasCloudflareChallengeText();
    const challengeShellVisible = hasCloudflareChallengeShell();
    const responseTokenLength = getCloudflareResponseTokenLength();
    const confirmButton = findCloudflareConfirmButton();
    const checkboxCandidate = findCloudflareCheckboxTargetCandidate();
    log(buildDiagnosticMessage('timeout summary', {
      challengeTextVisible,
      challengeShellVisible,
      responseTokenLength,
      confirmButton,
      checkboxCandidate,
    }), 'warn');
    log('TMailor：在 Confirm 可点击前，Cloudflare 验证已超时。', 'warn');
  }
  return false;
}

function findDomainOptions(domainState) {
  const selectors = 'button, [role="button"], li, label, div, span';
  const options = [];
  const seen = new Set();

  for (const el of document.querySelectorAll(selectors)) {
    if (!isElementVisible(el)) continue;
    const text = normalizeText(el.textContent || '');
    if (!text || text.length > 80) continue;
    const domainMatch = text.match(/[a-z0-9.-]+\.[a-z]{2,}/i);
    if (!domainMatch) continue;

    const domain = normalizeDomain(domainMatch[0]);
    if (!isAllowedDomain(domainState, domain) || seen.has(domain)) continue;
    seen.add(domain);
    options.push({ domain, element: el });
  }

  return options;
}

function collectDisplayedEmails() {
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (email, score) => {
    const normalized = String(email || '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalized) || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push({ email: normalized, score });
  };

  for (const input of document.querySelectorAll('input, textarea')) {
    if (!isElementVisible(input)) continue;
    const value = String(input.value || input.getAttribute('value') || '').trim();
    const match = value.match(EMAIL_REGEX);
    if (match) {
      pushCandidate(match[0], 100);
    }
  }

  for (const el of document.querySelectorAll('button, [role="button"], span, div, p, strong, h1, h2, h3')) {
    if (!isElementVisible(el)) continue;
    const text = normalizeText(el.textContent || '');
    if (!text || text.length > 160) continue;
    const match = text.match(EMAIL_REGEX);
    if (match) {
      const bonus = /copy|email|mailbox|address/i.test(text) ? 20 : 0;
      pushCandidate(match[0], 40 + bonus);
    }
  }

  const bodyMatch = (document.body?.innerText || '').match(EMAIL_REGEX);
  if (bodyMatch) {
    pushCandidate(bodyMatch[0], 10);
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates;
}

async function waitForMailboxControls(timeout = 20000) {
  const start = Date.now();
  let lastStateKind = '';
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (/emailid=/i.test(location.href)) {
      return;
    }
    const state = detectTmailorPageState();
    if (state.kind !== lastStateKind) {
      lastStateKind = state.kind;
      log(`TMailor: Page state detected: ${state.kind}${state.email ? ` (${state.email})` : ''}${state.element ? ` (${describeElementForLog(state.element, 'element')})` : ''}`, 'info');
    }
    assertNoFatalMailboxError();
    const handledMonetizationAd = await handleMonetizationVideoAd(15000);
    if (handledMonetizationAd) {
      continue;
    }
    const handledInterstitialAd = await handleDismissibleInterstitialAd(5000);
    if (handledInterstitialAd) {
      continue;
    }
    await ensureCloudflareChallengeClearedOrThrow(Math.min(DEFAULT_CLOUDFLARE_TIMEOUT_MS, Math.max(1000, timeout - (Date.now() - start))));
    assertNoManualTakeoverBlockers();
    const refreshedState = detectTmailorPageState();
    if (refreshedState.kind === 'mailbox_idle' || refreshedState.kind === 'mailbox_ready') {
      return;
    }
    if (findNewEmailButton() || findRefreshInboxButton() || collectDisplayedEmails().length > 0) {
      return;
    }
    await sleep(250);
  }
  throw new Error('TMailor page did not finish loading mailbox controls.');
}

async function maybeChooseAllowedDomain(domainState) {
  const chooserText = /choose a domain for your new email address/i.test(document.body?.innerText || '');
  if (!chooserText) {
    return false;
  }

  const options = findDomainOptions(domainState);
  if (options.length === 0) {
    return false;
  }

  simulateClick(options[0].element);
  log(`TMailor: Selected allowed domain ${options[0].domain}`);
  await sleepWithMailboxPatrol(1200, { reason: 'applying the selected mailbox domain' });
  return true;
}

async function fetchTmailorEmail(payload = {}) {
  const {
    generateNew = true,
    domainState = {},
  } = payload || {};

  const initialRecovery = await waitForMailboxControlsWithRecovery(20000, {
    cloudflareLog: 'TMailor：首次处理邮箱挑战失败，准备请求后台重开邮箱页后重试。',
    timeoutLog: 'TMailor：邮箱页长时间未恢复可用状态，准备请求后台重开邮箱页后重试。',
  });
  if (initialRecovery) {
    return initialRecovery;
  }

  const tryCurrentEmail = () => {
    const emails = collectDisplayedEmails();
    for (const candidate of emails) {
      if (isAllowedDomain(domainState, extractDomain(candidate.email))) {
        return candidate.email;
      }
    }
    return '';
  };

  if (!generateNew) {
    const currentEmail = tryCurrentEmail();
    if (currentEmail) {
      return { ok: true, email: currentEmail, domain: extractDomain(currentEmail), generated: false };
    }
  }

  let previousEmail = tryCurrentEmail();

  const maxGenerateAttempts = 100;

  for (let attempt = 1; attempt <= maxGenerateAttempts; attempt++) {
    assertNoFatalMailboxError();
    const newEmailButton = findNewEmailButton();
    if (!newEmailButton) {
      throw new Error('Could not find the TMailor "New Email" button.');
    }
    simulateClick(newEmailButton);
    log(`TMailor: Clicked New Email (${attempt}/${maxGenerateAttempts})`);
    let clearedCloudflare = false;
    try {
      clearedCloudflare = await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
    } catch (err) {
      const recovery = getMailboxReloadRecovery(err, {
        cloudflareLog: 'TMailor：生成邮箱时 Cloudflare 自动处理失败，准备请求后台重开邮箱页后重试。',
      });
      if (recovery) {
        return recovery;
      } else {
        throw err;
      }
    }
    assertNoManualTakeoverBlockers();
    await sleepWithMailboxPatrol(
      clearedCloudflare ? 3200 : 1200,
      {
        reason: 'waiting for the new mailbox to generate',
        includeCloudflare: !clearedCloudflare,
      }
    );

    await maybeChooseAllowedDomain(domainState);
    await sleepWithMailboxPatrol(800, { reason: 'waiting for the mailbox domain selection to settle' });
    assertNoFatalMailboxError();

    const currentEmail = tryCurrentEmail();
    const domain = extractDomain(currentEmail);

    if (currentEmail && currentEmail !== previousEmail && isAllowedDomain(domainState, domain)) {
      log(`TMailor：临时邮箱已就绪 ${currentEmail}`, 'ok');
      return { ok: true, email: currentEmail, domain, generated: true };
    }

    if (currentEmail && domain) {
      log(`TMailor: Skipping unsupported domain ${domain}`, 'info');
      previousEmail = currentEmail;
    }
  }

  throw new Error('TMailor did not generate a whitelisted or non-blacklisted .com mailbox in time. Switch to com+whitelist mode and retry.');
}

function extractVerificationCode(text) {
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

function buildRowId(element, fallbackIndex) {
  return (
    element.getAttribute('data-uuid')
    || element.getAttribute('data-id')
    || element.getAttribute('data-mail-id')
    || element.getAttribute('data-message-id')
    || element.id
    || element.getAttribute('href')
    || `${fallbackIndex}:${normalizeText(element.textContent || '').slice(0, 120)}`
  );
}

function findMailRows() {
  const selectors = [
    '[data-uuid]',
    '[data-mail-id]',
    '[data-message-id]',
    '[data-id]',
    'tr',
    '[role="row"]',
    'li',
    'article',
    '.mail-item',
    '.message-item',
    '.mail-list-item',
    '.inbox-item',
  ];

  const rows = [];
  const seen = new Set();

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isElementVisible(element)) continue;
      if (seen.has(element)) continue;
      const text = normalizeText(element.textContent || '');
      if (!text || text.length < 6 || text.length > 600) continue;
      if (/new\s*email|refresh|inbox|forward email|temporary email/i.test(text) && !/\b\d{6}\b/.test(text)) {
        continue;
      }
      seen.add(element);
      rows.push(element);
    }
  }

  return rows.filter((element) => {
    return !rows.some((other) => other !== element && typeof element.contains === 'function' && element.contains(other));
  });
}

function parseMailRow(element, index) {
  const rawText = String(element?.textContent || '');
  const combinedText = normalizeText(rawText);
  const textLines = rawText.split(/\n+/).map((line) => normalizeText(line)).filter(Boolean);
  const subject = textLines[1] || textLines[0] || '';
  const sender = textLines[0] || '';
  const timestamp = parseMailTimestampCandidates(textLines, { now: Date.now() });

  return {
    id: buildRowId(element, index),
    element,
    sender,
    subject,
    combinedText,
    timestamp,
  };
}

function findMailboxIdleEntryTarget() {
  const currentEmailInput = getCurrentMailboxInput();
  let current = currentEmailInput?.parentElement || null;
  while (current) {
    if ((current.id === 'EmailDetail' || current.id === 'homeEmail') && isElementVisible(current)) {
      return current;
    }
    current = current.parentElement || null;
  }

  const detailContainer = document.querySelector('#EmailDetail');
  if (isElementVisible(detailContainer)) {
    return detailContainer;
  }

  const homeContainer = document.querySelector('#homeEmail');
  if (isElementVisible(homeContainer)) {
    return homeContainer;
  }

  return currentEmailInput && isElementVisible(currentEmailInput) ? currentEmailInput : null;
}

async function nudgeMailboxIdleEntryAfterRefresh() {
  const pageState = detectTmailorPageState();
  if (pageState.kind !== 'mailbox_idle') {
    return false;
  }

  if (findMailRows().length > 0) {
    return false;
  }

  const target = findMailboxIdleEntryTarget();
  if (!target) {
    return false;
  }

  log('TMailor: Refreshed into the mailbox home container without inbox rows. Clicking it once to trigger the mailbox challenge flow.', 'info');
  simulateClick(target);
  await sleepWithMailboxPatrol(800, { reason: 'waiting for the mailbox home container click to settle' });
  return true;
}

async function refreshInbox(payload = {}) {
  const mismatch = checkExpectedMailboxEmail(payload);
  if (mismatch) {
    return mismatch;
  }

  assertNoFatalMailboxError();
  await handleMonetizationVideoAd(15000);
  await handleDismissibleInterstitialAd(5000);
  await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
  assertNoManualTakeoverBlockers();

  const refreshButton = findRefreshInboxButton();
  if (refreshButton) {
    simulateClick(refreshButton);
    await sleepWithMailboxPatrol(1200, { reason: 'refreshing the inbox view' });
    const postRefreshMismatch = checkExpectedMailboxEmail(payload);
    if (postRefreshMismatch) {
      return postRefreshMismatch;
    }
    assertNoFatalMailboxError();
    await handleMonetizationVideoAd(15000);
    await handleDismissibleInterstitialAd(5000);
    await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
    assertNoManualTakeoverBlockers();
    const postRefreshRecovery = await waitForMailboxControlsWithRecovery(12000, {
      cloudflareLog: 'TMailor：刷新邮箱时 Cloudflare 自动处理失败，准备请求后台重开邮箱页后重试。',
      timeoutLog: 'TMailor：刷新后的邮箱页长时间未恢复可用状态，准备请求后台重开邮箱页后重试。',
    });
    if (postRefreshRecovery) {
      return postRefreshRecovery;
    }
    const nudgedIdleMailbox = await nudgeMailboxIdleEntryAfterRefresh();
    if (nudgedIdleMailbox) {
      const postNudgeMismatch = checkExpectedMailboxEmail(payload);
      if (postNudgeMismatch) {
        return postNudgeMismatch;
      }
      assertNoFatalMailboxError();
      await handleMonetizationVideoAd(15000);
      await handleDismissibleInterstitialAd(5000);
      await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
      assertNoManualTakeoverBlockers();
      const postNudgeRecovery = await waitForMailboxControlsWithRecovery(12000, {
        cloudflareLog: 'TMailor：触发邮箱首页容器后的 Cloudflare 自动处理失败，准备请求后台重开邮箱页后重试。',
        timeoutLog: 'TMailor：触发邮箱首页容器后页面长时间未恢复可用状态，准备请求后台重开邮箱页后重试。',
      });
      if (postNudgeRecovery) {
        return postNudgeRecovery;
      }
    }
    return;
  }

  const inboxButton = findButtonByText([/inbox/i]);
  if (inboxButton) {
    simulateClick(inboxButton);
    await sleepWithMailboxPatrol(900, { reason: 'returning to the inbox view' });
    const postInboxMismatch = checkExpectedMailboxEmail(payload);
    if (postInboxMismatch) {
      return postInboxMismatch;
    }
    assertNoFatalMailboxError();
    await handleMonetizationVideoAd(15000);
    await handleDismissibleInterstitialAd(5000);
    await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
    assertNoManualTakeoverBlockers();
    const postInboxRecovery = await waitForMailboxControlsWithRecovery(12000, {
      cloudflareLog: 'TMailor：返回收件箱时 Cloudflare 自动处理失败，准备请求后台重开邮箱页后重试。',
      timeoutLog: 'TMailor：返回收件箱后页面长时间未恢复可用状态，准备请求后台重开邮箱页后重试。',
    });
    if (postInboxRecovery) {
      return postInboxRecovery;
    }
  }
}

async function settleMailDetailInterruptions() {
  assertNoFatalMailboxError();
  const handledMonetizationAd = await handleMonetizationVideoAd(15000);
  if (handledMonetizationAd) {
    log('TMailor: Mail detail view resumed after closing a monetization ad', 'info');
  }
  const handledInterstitialAd = await handleDismissibleInterstitialAd(5000);
  if (handledInterstitialAd) {
    log('TMailor: Mail detail view resumed after closing an interstitial overlay', 'info');
  }
  const handledSkipNotice = await handleMailDetailSkipNotice(6000);
  if (handledSkipNotice) {
    log('TMailor: Mail detail view resumed after clicking Skip on the countdown notice', 'info');
  }
  await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
  assertNoManualTakeoverBlockers();
}

async function clickMailRow(row) {
  const target = findMailRowOpenTarget(row?.element);
  simulateClick(target || row.element);
  await sleepWithMailboxPatrol(1000, { reason: 'opening a matched inbox row' });
}

function findMailRowOpenTarget(element) {
  if (!element || typeof element.querySelector !== 'function') {
    return null;
  }

  return element.querySelector('a[href*="emailid="], a.temp-subject, a.temp-sender');
}

function findCodeInPageText() {
  const detailSelectors = [
    'h1',
    '#bodyCell',
    'table.main',
    'td#bodyCell p',
    'td#bodyCell',
  ];

  for (const selector of detailSelectors) {
    const element = document.querySelector(selector);
    const code = extractVerificationCode(element?.textContent || '');
    if (code) {
      return code;
    }
  }

  return extractVerificationCode(document.body?.innerText || '');
}

function getCurrentDetailPageText() {
  const detailSelectors = [
    'h1',
    '#bodyCell',
    'td#bodyCell p',
    'td#bodyCell',
    'table.main h1',
    'table.main p',
    'table.main td',
  ];
  const chunks = [];
  const seen = new Set();

  for (const selector of detailSelectors) {
    const element = document.querySelector(selector);
    const text = normalizeText(element?.textContent || '');
    if (text && !seen.has(text)) {
      seen.add(text);
      chunks.push(text);
    }
  }

  return normalizeText(chunks.join(' '));
}

function shouldReturnToInboxAfterDetailRead(step) {
  return step === 4 || step === 7;
}

function shouldInspectDetailBeforeAcceptingCode(step) {
  return Number.parseInt(String(step ?? 0), 10) === 7;
}

function buildStep7DetailDecisionLog(detail = {}, step = 0) {
  const detailText = normalizeText(detail?.detailText || '');
  const snippet = detailText.slice(0, 220);
  const sanitizedSnippet = snippet.replace(/"/g, '\\"');
  const signupIntent = hasSignupVerificationMailDetail(step, detailText) ? 'yes' : 'no';
  const loginIntent = hasLoginVerificationMailDetail(step, detailText) ? 'yes' : 'no';
  const reason = String(detail?.rejectedReason || 'accepted').trim() || 'accepted';
  const code = String(detail?.code || '').trim() || 'none';
  const mailId = String(detail?.mailId || '').trim() || 'none';
  return `reason=${reason}; code=${code}; signupIntent=${signupIntent}; loginIntent=${loginIntent}; mailId=${mailId}; snippet="${sanitizedSnippet}"`;
}

async function waitForStep7DetailTextToSettle(timeoutMs = 1800, intervalMs = 250) {
  let latestDetailText = normalizeText(getCurrentDetailPageText());
  if (hasLoginVerificationMailDetail(7, latestDetailText)) {
    return latestDetailText;
  }
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleepWithMailboxPatrol(intervalMs, { reason: 'waiting for the step 7 mail detail text to settle' });
    const nextDetailText = normalizeText(getCurrentDetailPageText());
    if (nextDetailText) {
      latestDetailText = nextDetailText;
    }
    if (hasLoginVerificationMailDetail(7, nextDetailText)) {
      return nextDetailText;
    }
  }

  return latestDetailText;
}

async function returnToInboxFromDetailPage(payload = {}, reason = 'returning to the inbox view from a mail detail page') {
  const startedOnDetailPage = /emailid=/i.test(location.href);
  const refreshResult = await refreshInbox(payload);
  if (!startedOnDetailPage || !/emailid=/i.test(location.href)) {
    return refreshResult || null;
  }

  if (window.history && typeof window.history.back === 'function') {
    window.history.back();
    await sleepWithMailboxPatrol(900, { reason });
    const mismatch = checkExpectedMailboxEmail(payload);
    if (mismatch) {
      return mismatch;
    }
    assertNoFatalMailboxError();
    await handleMonetizationVideoAd(15000);
    await handleDismissibleInterstitialAd(5000);
    await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
    assertNoManualTakeoverBlockers();
    await waitForMailboxControlsWithRecovery(12000, {
      cloudflareLog: 'TMailor：从详情页返回收件箱时 Cloudflare 自动处理失败，准备请求后台重开邮箱页后重试。',
      timeoutLog: 'TMailor：从详情页返回收件箱后页面长时间未恢复可用状态，准备请求后台重开邮箱页后重试。',
    });
  }

  return refreshResult || null;
}

async function readCodeFromVisibleDetailPage(step, payload = {}, options = {}) {
  if (options.requireDetailUrl && !/emailid=/i.test(location.href)) {
    return null;
  }

  const code = findCodeInPageText();
  if (!code) {
    return null;
  }

  const {
    senderFilters = [],
    subjectFilters = [],
    targetEmail = '',
  } = payload;
  let detailText = getCurrentDetailPageText();
  if (shouldInspectDetailBeforeAcceptingCode(step)) {
    detailText = await waitForStep7DetailTextToSettle();
  }
  const detailLower = detailText.toLowerCase();
  const subjectProfile = getStepMailMatchProfile(step);
  const targetLocal = String(targetEmail || '').split('@')[0].trim().toLowerCase();
  const senderMatch = senderFilters.some((value) => detailLower.includes(String(value).toLowerCase()));
  const subjectMatch = subjectFilters.some((value) => detailLower.includes(String(value).toLowerCase()));
  const targetMatch = targetLocal && detailLower.includes(targetLocal);
  const stepSpecificSubjectMatch = matchesSubjectPatterns(detailText, subjectProfile);
  const explicitLoginIntent = hasLoginVerificationMailDetail(step, detailText);

  if (!(stepSpecificSubjectMatch || (!subjectProfile && (senderMatch || subjectMatch || targetMatch)))) {
    return null;
  }

  if (explicitLoginIntent) {
    return {
      code,
      detailText,
      emailTimestamp: 0,
      mailId: location.href,
    };
  }

  if (!isExpectedVerificationMailDetail(step, detailText)) {
    return {
      code,
      detailText,
      rejectedReason: hasSignupVerificationMailDetail(step, detailText) ? 'signup_intent' : 'detail_intent_mismatch',
      emailTimestamp: 0,
      mailId: location.href,
    };
  }

  return {
    code,
    detailText,
    emailTimestamp: 0,
    mailId: location.href,
  };
}

async function readCodeFromCurrentDetailPage(step, payload = {}) {
  return readCodeFromVisibleDetailPage(step, payload, { requireDetailUrl: true });
}

async function waitForCodeInPage(timeoutMs = 4000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    await settleMailDetailInterruptions();
    const code = findCodeInPageText();
    if (code) {
      return code;
    }
    await sleep(intervalMs);
  }
  return null;
}

async function readCodeFromMailRow(row, step = 0, payload = {}) {
  let code = extractVerificationCode(row?.combinedText || '');
  if (code && !shouldInspectDetailBeforeAcceptingCode(step)) {
    return code;
  }

  log(`TMailor: Opening matched inbox row (${row?.sender || 'unknown sender'} | ${row?.subject || 'unknown subject'})`, 'info');
  await clickMailRow(row);
  await settleMailDetailInterruptions();
  code = await waitForCodeInPage(8000, 250);
  if (code) {
    const detailResult = await readCodeFromVisibleDetailPage(step, payload, { requireDetailUrl: false });
    if (detailResult?.rejectedReason === 'signup_intent') {
      rememberRejectedVerificationDetail(step, payload, detailResult);
      log(`Step ${step}: TMailor detail mail looked like a signup verification email. Returning to inbox and fetching another mail.`, 'info');
      log(`Step ${step}: TMailor detail rejection details: ${buildStep7DetailDecisionLog(detailResult, step)}`, 'info');
      await returnToInboxFromDetailPage(payload, 'returning to the inbox view after rejecting a signup-style mail detail');
      return null;
    }
    if (detailResult?.code) {
      return detailResult.code;
    }
    return shouldInspectDetailBeforeAcceptingCode(step) ? null : code;
  }

  log('TMailor: Mail detail opened but the verification code did not become visible in time. Leaving the detail page untouched so the next mailbox command can recover safely.', 'info');

  return null;
}

async function handlePollEmail(step, payload) {
  const {
    senderFilters = [],
    subjectFilters = [],
    maxAttempts = 20,
    intervalMs = 3000,
    filterAfterTimestamp = 0,
    excludeCodes = [],
    targetEmail = '',
  } = payload || {};

  const initialRecovery = await waitForMailboxControlsWithRecovery(20000, {
    cloudflareLog: 'TMailor：轮询邮件前 Cloudflare 自动处理失败，准备请求后台重开邮箱页后重试。',
    timeoutLog: 'TMailor：邮箱页长时间未恢复可用状态，准备请求后台重开邮箱页后重试。',
  });
  if (initialRecovery) {
    return initialRecovery;
  }

  const subjectProfile = getStepMailMatchProfile(step);
  const rememberedRejectedDetails = getRememberedRejectedVerificationDetails(step, payload);
  const excludedCodeSet = new Set([...(excludeCodes || []), ...rememberedRejectedDetails.codes]);
  const excludedMailIdSet = new Set(rememberedRejectedDetails.mailIds);
  const now = Date.now();
  const existingRowIds = new Set(findMailRows().map((element, index) => buildRowId(element, index)));
  const targetLocal = String(targetEmail || '').split('@')[0].trim().toLowerCase();
  const fallbackAfter = 4;
  const syncRememberedRejectedDetails = () => {
    const latestRejectedDetails = getRememberedRejectedVerificationDetails(step, payload);
    for (const code of latestRejectedDetails.codes) {
      excludedCodeSet.add(code);
    }
    for (const mailId of latestRejectedDetails.mailIds) {
      excludedMailIdSet.add(mailId);
    }
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    assertNoFatalMailboxError();
    if (attempt > 1) {
      let refreshResult = null;
      try {
        refreshResult = await refreshInbox(payload);
      } catch (error) {
        const recovery = getMailboxReloadRecovery(error, {
          cloudflareLog: 'TMailor：刷新邮箱时 Cloudflare 自动处理失败，准备请求后台重开邮箱页后重试。',
          timeoutLog: 'TMailor：刷新后的邮箱页长时间未恢复可用状态，准备请求后台重开邮箱页后重试。',
        });
        if (recovery) {
          return recovery;
        }
        throw error;
      }
      if (refreshResult?.recovery) {
        return refreshResult;
      }
    }

    const currentDetailResult = await readCodeFromCurrentDetailPage(step, payload);
    if (currentDetailResult?.rejectedReason === 'signup_intent') {
      rememberRejectedVerificationDetail(step, payload, currentDetailResult);
      syncRememberedRejectedDetails();
      log(`Step ${step}: Current TMailor detail mail looked like a signup verification email. Returning to inbox and refetching.`, 'info');
      log(`Step ${step}: Current TMailor detail rejection details: ${buildStep7DetailDecisionLog(currentDetailResult, step)}`, 'info');
      await returnToInboxFromDetailPage(payload, 'returning to the inbox view after rejecting the current signup-style mail detail');
    } else if (currentDetailResult?.mailId && excludedMailIdSet.has(currentDetailResult.mailId)) {
      rememberRejectedVerificationDetail(step, payload, currentDetailResult);
      syncRememberedRejectedDetails();
      log(`Step ${step}: Current TMailor detail mail was already rejected earlier in this mailbox session. Returning to inbox and refetching.`, 'info');
      await returnToInboxFromDetailPage(payload, 'returning to the inbox view after skipping a previously rejected mail detail');
    } else if (currentDetailResult && excludedCodeSet.has(currentDetailResult.code)) {
      rememberRejectedVerificationDetail(step, payload, currentDetailResult);
      syncRememberedRejectedDetails();
      log(`Step ${step}: Current TMailor detail mail uses an excluded code (${currentDetailResult.code}). Returning to inbox and waiting for a fresh mail.`, 'info');
      await returnToInboxFromDetailPage(payload, 'returning to the inbox view after rejecting an excluded verification code');
    } else if (currentDetailResult) {
      clearRememberedRejectedVerificationDetails(step, payload);
      return {
        ok: true,
        ...currentDetailResult,
      };
    }

    const useFallback = attempt > fallbackAfter;
    const rows = findMailRows().map(parseMailRow);
    const candidateMatches = rows.filter((row) => {
      if (excludedMailIdSet.has(row.id)) {
        return false;
      }
      const previewCode = extractVerificationCode(row.combinedText || '');
      if (previewCode && excludedCodeSet.has(previewCode)) {
        return false;
      }

      const combinedLower = row.combinedText.toLowerCase();
      const senderMatch = senderFilters.some((value) => combinedLower.includes(String(value).toLowerCase()));
      const subjectMatch = subjectFilters.some((value) => combinedLower.includes(String(value).toLowerCase()));
      const stepSpecificSubjectMatch = matchesSubjectPatterns(`${row.subject} ${row.combinedText}`, subjectProfile);
      const targetMatch = targetLocal && combinedLower.includes(targetLocal);

      if (!(stepSpecificSubjectMatch || (!subjectProfile && (senderMatch || subjectMatch || targetMatch)))) {
        return false;
      }

      const looksNewEnough = !existingRowIds.has(row.id) || stepSpecificSubjectMatch || targetMatch;
      const effectiveTimestamp = row.timestamp || (!useFallback && looksNewEnough ? Date.now() : 0);
      return isMailFresh(effectiveTimestamp, { now, filterAfterTimestamp });
    });

    for (const latestMatch of candidateMatches) {
      const code = await readCodeFromMailRow(latestMatch, step, payload);

      if (!code) {
        syncRememberedRejectedDetails();
        log(`Step ${step}: TMailor matched an email but the code is not visible yet or the detail intent did not match.`, 'info');
      } else if (excludedCodeSet.has(code)) {
        log(`Step ${step}: TMailor code is excluded: ${code}`, 'info');
      } else {
        clearRememberedRejectedVerificationDetails(step, payload);
        return {
          ok: true,
          code,
          emailTimestamp: latestMatch.timestamp || Date.now(),
          mailId: latestMatch.id,
        };
      }
    }

    if (attempt < maxAttempts) {
      await sleepWithMailboxPatrol(intervalMs, { reason: `waiting for the next inbox poll (${attempt + 1}/${maxAttempts})` });
    }
  }

  throw new Error(`Step ${step}: No matching verification email found on TMailor after ${maxAttempts} attempts.`);
}

window.__MULTIPAGE_TMAILOR_TEST_HOOKS = {
  assertNoFatalMailboxError,
  assertNoManualTakeoverBlockers,
  clickMailRow,
  clearRememberedRejectedVerificationDetails,
  detectTmailorPageState,
  dismissBlockingOverlay,
  ensureCloudflareChallengeClearedOrThrow,
  fetchTmailorEmail,
  handleMailDetailSkipNotice,
  handleMonetizationVideoAd,
  readCodeFromMailRow,
  readCodeFromCurrentDetailPage,
  handlePollEmail,
  waitForCodeInPage,
  extractVerificationCode,
  findMailRowOpenTarget,
  findMailRows,
  findCodeInPageText,
  getCloudflareCheckboxRect,
  parseMailRow,
  rememberRejectedVerificationDetail,
  runMailboxInterruptionSweep,
  sleepWithMailboxPatrol,
  nudgeMailboxIdleEntryAfterRefresh,
  waitForCloudflareConfirm,
  waitForMailboxControls,
};

})();
