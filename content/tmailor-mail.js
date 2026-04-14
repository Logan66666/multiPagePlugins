(function() {
if (window.__MULTIPAGE_TMAILOR_MAIL_LOADED) {
  console.log('[Infinito.AI:tmailor-mail] Content script already loaded on', location.href);
  return;
}
window.__MULTIPAGE_TMAILOR_MAIL_LOADED = true;

const TMAILOR_PREFIX = '[Infinito.AI:tmailor-mail]';
const { findLatestMatchingItem } = LatestMail;
const { getStepMailMatchProfile, matchesSubjectPatterns, normalizeText } = MailMatching;
const { isMailFresh, parseMailTimestampCandidates } = MailFreshness;
const EMAIL_REGEX = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const DEFAULT_CLOUDFLARE_TIMEOUT_MS = 18000;
const MAX_CLOUDFLARE_CHECKBOX_ATTEMPTS = 8;
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
    resetStopState();
    fetchTmailorEmail(message.payload).then(sendResponse).catch((err) => {
      if (isStopError(err)) {
        log('TMailor: Stopped by user.', 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    handlePollEmail(message.step, message.payload).then(sendResponse).catch((err) => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
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
  let remainingMs = totalMs;

  while (remainingMs > 0) {
    throwIfStopped();
    const chunkMs = Math.min(sliceMs, remainingMs);
    await sleep(chunkMs);
    remainingMs -= chunkMs;

    await runMailboxInterruptionSweep(options);
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
    log('TMailor: Monetization video ad is still blocking the mailbox after the wait timeout', 'warn');
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
  if (isCloudflareChallengeVisible()) {
    throw new Error('Cloudflare challenge detected on TMailor. Temporary failure, please take over manually.');
  }

  if (findBlockingAdCloseButton()) {
    throw new Error('Blocking overlay detected on TMailor. Temporary failure, please take over manually.');
  }
}

async function dismissBlockingOverlay(timeoutMs = 4000) {
  const handledInterstitialAd = await handleDismissibleInterstitialAd(timeoutMs);
  if (handledInterstitialAd) {
    log('TMailor: Blocking overlay closed successfully', 'ok');
    return true;
  }

  const start = Date.now();
  let sawCloseButton = false;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const closeButton = findBlockingAdCloseButton();
    if (!closeButton) {
      if (sawCloseButton) {
        log('TMailor: Blocking overlay closed successfully', 'ok');
      }
      return false;
    }

    sawCloseButton = true;
    log(`TMailor: Blocking overlay detected, clicking Close (${describeElementForLog(closeButton, 'close')})`, 'info');
    simulateClick(closeButton);
    await sleep(600);

    if (!findBlockingAdCloseButton()) {
      log('TMailor: Blocking overlay closed successfully', 'ok');
      return true;
    }
  }

  if (sawCloseButton) {
    log('TMailor: Blocking overlay is still visible after retry timeout', 'warn');
  }
  return false;
}

async function ensureCloudflareChallengeClearedOrThrow(timeoutMs = DEFAULT_CLOUDFLARE_TIMEOUT_MS) {
  const start = Date.now();
  if (!isCloudflareChallengeVisible()) {
    return false;
  }

  log('TMailor: Cloudflare challenge is blocking the mailbox, attempting automatic verification first', 'warn');
  const handled = await waitForCloudflareConfirm(timeoutMs);
  if (handled) {
    if (!isCloudflareChallengeVisible()) {
      log('TMailor: Cloudflare challenge cleared automatically', 'ok');
      return true;
    }

    const elapsed = Date.now() - start;
    const remainingBudget = Math.max(0, timeoutMs - elapsed);
    const postConfirmGraceMs = Math.min(5000, Math.max(2500, remainingBudget));
    const graceStart = Date.now();
    log(`TMailor: Cloudflare verification was submitted. Waiting up to ${postConfirmGraceMs}ms for the challenge shell to disappear...`, 'info');
    while (Date.now() - graceStart < postConfirmGraceMs) {
      throwIfStopped();
      if (!isCloudflareChallengeVisible()) {
        log('TMailor: Cloudflare challenge cleared during the post-confirm grace window', 'ok');
        return true;
      }
      await sleep(250);
    }
    if (!isCloudflareChallengeVisible()) {
      log('TMailor: Cloudflare challenge cleared during the post-confirm grace window', 'ok');
      return true;
    }
  }

  if (handled) {
    log('TMailor: Cloudflare auto-attempt ran, but the challenge shell is still visible', 'warn');
  } else {
    log('TMailor: Cloudflare auto-attempt timed out before the challenge cleared', 'warn');
  }

  throw new Error('Cloudflare challenge detected on TMailor. Automatic verification did not complete, please take over manually.');
}

async function waitForCloudflareConfirm(timeoutMs = DEFAULT_CLOUDFLARE_TIMEOUT_MS) {
  const start = Date.now();
  const gracePeriodMs = Math.min(1500, timeoutMs);
  const delayedConfirmRetryMs = 6000;
  const textFallbackGraceMs = 1800;
  const visualSuccessFallbackMs = 5000;
  const autoVerificationWaitMs = 12000;
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
        log('TMailor: Cloudflare widget reports a visual success state, but no token was observed after 5000ms. Trying Confirm as a fallback...', 'warn');
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
          log(`TMailor: Debugger click failed on Cloudflare container, falling back to DOM click: ${err?.message || err}`, 'warn');
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
    log('TMailor: Cloudflare verification timed out before Confirm became clickable', 'warn');
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

  try {
    await waitForMailboxControls();
  } catch (err) {
    const message = String(err?.message || err);
    if (/Cloudflare challenge detected on TMailor/i.test(message)) {
      log('TMailor: Initial mailbox challenge handling failed. Requesting a background mailbox reload before retrying...', 'warn');
      return {
        recovery: 'reload_mailbox',
        error: message,
      };
    } else {
      throw err;
    }
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
      const message = String(err?.message || err);
      if (/Cloudflare challenge detected on TMailor/i.test(message)) {
        log('TMailor: Cloudflare auto-attempt failed during mailbox generation. Requesting a background mailbox reload before retrying...', 'warn');
        return {
          recovery: 'reload_mailbox',
          error: message,
        };
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
      log(`TMailor: Ready mailbox ${currentEmail}`, 'ok');
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

async function refreshInbox() {
  assertNoFatalMailboxError();
  await handleMonetizationVideoAd(15000);
  await handleDismissibleInterstitialAd(5000);
  await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
  assertNoManualTakeoverBlockers();

  const refreshButton = findRefreshInboxButton();
  if (refreshButton) {
    simulateClick(refreshButton);
    await sleepWithMailboxPatrol(1200, { reason: 'refreshing the inbox view' });
    assertNoFatalMailboxError();
    await handleMonetizationVideoAd(15000);
    await handleDismissibleInterstitialAd(5000);
    await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
    assertNoManualTakeoverBlockers();
    return;
  }

  const inboxButton = findButtonByText([/inbox/i]);
  if (inboxButton) {
    simulateClick(inboxButton);
    await sleepWithMailboxPatrol(900, { reason: 'returning to the inbox view' });
    assertNoFatalMailboxError();
    await handleMonetizationVideoAd(15000);
    await handleDismissibleInterstitialAd(5000);
    await ensureCloudflareChallengeClearedOrThrow(DEFAULT_CLOUDFLARE_TIMEOUT_MS);
    assertNoManualTakeoverBlockers();
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
  const detailSelectors = ['h1', '#bodyCell', 'table.main', 'td#bodyCell', 'body'];
  const chunks = [];

  for (const selector of detailSelectors) {
    const element = document.querySelector(selector);
    const text = normalizeText(element?.textContent || '');
    if (text) {
      chunks.push(text);
    }
  }

  return normalizeText(chunks.join(' '));
}

function shouldReturnToInboxAfterDetailRead(step) {
  return step === 4 || step === 7;
}

function readCodeFromCurrentDetailPage(step, payload = {}) {
  if (!/emailid=/i.test(location.href)) {
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
  const detailText = getCurrentDetailPageText();
  const detailLower = detailText.toLowerCase();
  const subjectProfile = getStepMailMatchProfile(step);
  const targetLocal = String(targetEmail || '').split('@')[0].trim().toLowerCase();
  const senderMatch = senderFilters.some((value) => detailLower.includes(String(value).toLowerCase()));
  const subjectMatch = subjectFilters.some((value) => detailLower.includes(String(value).toLowerCase()));
  const targetMatch = targetLocal && detailLower.includes(targetLocal);
  const stepSpecificSubjectMatch = matchesSubjectPatterns(detailText, subjectProfile);

  if (!(stepSpecificSubjectMatch || (!subjectProfile && (senderMatch || subjectMatch || targetMatch)))) {
    return null;
  }

  return {
    code,
    emailTimestamp: 0,
    mailId: location.href,
  };
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

async function readCodeFromMailRow(row, step = 0) {
  let code = extractVerificationCode(row?.combinedText || '');
  if (code) {
    return code;
  }

  log(`TMailor: Opening matched inbox row (${row?.sender || 'unknown sender'} | ${row?.subject || 'unknown subject'})`, 'info');
  await clickMailRow(row);
  await settleMailDetailInterruptions();
  code = await waitForCodeInPage(8000, 250);
  if (code) {
    return code;
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

  await waitForMailboxControls();

  const subjectProfile = getStepMailMatchProfile(step);
  const excludedCodeSet = new Set(excludeCodes);
  const now = Date.now();
  const existingRowIds = new Set(findMailRows().map((element, index) => buildRowId(element, index)));
  const targetLocal = String(targetEmail || '').split('@')[0].trim().toLowerCase();
  const fallbackAfter = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    assertNoFatalMailboxError();
    if (attempt > 1) {
      await refreshInbox();
    }

    const currentDetailResult = readCodeFromCurrentDetailPage(step, payload);
    if (currentDetailResult && !excludedCodeSet.has(currentDetailResult.code)) {
      return {
        ok: true,
        ...currentDetailResult,
      };
    }

    const useFallback = attempt > fallbackAfter;
    const rows = findMailRows().map(parseMailRow);
    const latestMatch = findLatestMatchingItem(rows, (row) => {
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

    if (latestMatch) {
      const code = await readCodeFromMailRow(latestMatch, step);

      if (!code) {
        log(`Step ${step}: TMailor matched an email but the code is not visible yet.`, 'info');
      } else if (excludedCodeSet.has(code)) {
        log(`Step ${step}: TMailor code is excluded: ${code}`, 'info');
      } else {
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
  detectTmailorPageState,
  dismissBlockingOverlay,
  ensureCloudflareChallengeClearedOrThrow,
  fetchTmailorEmail,
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
  runMailboxInterruptionSweep,
  waitForCloudflareConfirm,
  waitForMailboxControls,
};

})();
