(function() {
if (window.__MULTIPAGE_TMAILOR_MAIL_LOADED) {
  console.log('[MultiPage:tmailor-mail] Content script already loaded on', location.href);
  return;
}
window.__MULTIPAGE_TMAILOR_MAIL_LOADED = true;

const TMAILOR_PREFIX = '[MultiPage:tmailor-mail]';
const { findLatestMatchingItem } = LatestMail;
const { getStepMailMatchProfile, matchesSubjectPatterns, normalizeText } = MailMatching;
const { isMailFresh, parseMailTimestampCandidates } = MailFreshness;
const EMAIL_REGEX = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;

console.log(TMAILOR_PREFIX, 'Content script loaded on', location.href);

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
  const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
    return false;
  }
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return !rect || (rect.width > 0 && rect.height > 0);
}

function findButtonByText(patterns) {
  const selectors = 'button, [role="button"], a, summary';
  const buttons = Array.from(document.querySelectorAll(selectors)).filter(isElementVisible);
  return buttons.find((button) => patterns.some((pattern) => pattern.test(button.textContent || ''))) || null;
}

function findCloudflareConfirmButton() {
  const idButton = document.querySelector('#btnNewEmailForm');
  if (isElementVisible(idButton)) {
    return idButton;
  }
  return findButtonByText([/confirm/i]);
}

function findCloudflareCheckboxTarget() {
  const iframe = document.querySelector(
    'iframe[src*="challenges.cloudflare.com"], ' +
    'iframe[title*="Cloudflare"], ' +
    'iframe[title*="security challenge"], ' +
    'iframe[title*="Widget containing"]'
  );
  if (isElementVisible(iframe)) {
    return iframe;
  }

  const textTarget = Array.from(document.querySelectorAll('label, button, div, span')).find((el) => {
    if (!isElementVisible(el)) {
      return false;
    }
    const text = normalizeText(el.textContent || '');
    return /请验证您是真人|verify you are human|i am human|not a robot/i.test(text);
  });

  return textTarget || null;
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

async function requestDebuggerClickAt(rect) {
  const response = await chrome.runtime.sendMessage({
    type: 'DEBUGGER_CLICK_AT',
    source: 'tmailor-mail',
    payload: { rect },
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

function isCloudflareChallengeVisible() {
  const bodyText = normalizeText(document.body?.innerText || '');
  return /please verify that you are not a robot/i.test(bodyText);
}

function isFatalMailboxErrorVisible() {
  const bodyText = normalizeText(document.body?.innerText || '');
  return /an error occurred on the server\.\s*please try again later/i.test(bodyText);
}

function assertNoFatalMailboxError() {
  if (isFatalMailboxErrorVisible()) {
    throw new Error('TMailor server error detected while refreshing the mailbox. Please change node and retry.');
  }
}

async function dismissBlockingOverlay(timeoutMs = 4000) {
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
    log('TMailor: Blocking overlay detected, clicking Close', 'info');
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

async function waitForCloudflareConfirm(timeoutMs = 12000) {
  const start = Date.now();
  const gracePeriodMs = Math.min(1500, timeoutMs);
  let sawChallenge = false;
  let challengeResolvedAt = 0;
  let lastCheckboxAttemptAt = 0;
  let loggedChallengeDetected = false;
  let loggedConfirmDisabled = false;
  let loggedWaitingForCheckbox = false;
  let loggedPrematureConfirm = false;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const challengeVisible = isCloudflareChallengeVisible();

    if (!challengeVisible) {
      if (sawChallenge) {
        if (!challengeResolvedAt) {
          challengeResolvedAt = Date.now();
          log('TMailor: Cloudflare challenge is no longer visible', 'info');
        }
        const confirmButton = findCloudflareConfirmButton();
        if (confirmButton && !isElementDisabled(confirmButton)) {
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

    sawChallenge = true;
    challengeResolvedAt = 0;
    if (!loggedChallengeDetected) {
      loggedChallengeDetected = true;
      log('TMailor: Cloudflare challenge detected, waiting for verification controls', 'info');
    }
    const confirmButton = findCloudflareConfirmButton();
    if (confirmButton && !isElementDisabled(confirmButton) && !loggedPrematureConfirm) {
      loggedPrematureConfirm = true;
      log('TMailor: Cloudflare Confirm button looks clickable before challenge clears, waiting for verification to finish', 'info');
    }

    if (confirmButton && isElementDisabled(confirmButton) && !loggedConfirmDisabled) {
      loggedConfirmDisabled = true;
      log('TMailor: Cloudflare Confirm button is still disabled, waiting for checkbox verification', 'info');
    }

    if (Date.now() - lastCheckboxAttemptAt >= 1500) {
      const checkboxTarget = findCloudflareCheckboxTarget();
      const checkboxRect = getElementCenterRect(checkboxTarget);
      if (checkboxRect) {
        lastCheckboxAttemptAt = Date.now();
        log('TMailor: Cloudflare checkbox detected, waiting for challenge and clicking verification area', 'info');

        if (String(checkboxTarget.tagName || '').toUpperCase() === 'IFRAME') {
          await requestDebuggerClickAt(checkboxRect);
        } else {
          simulateClick(checkboxTarget);
        }

        await sleep(1600);
        continue;
      }

      if (!loggedWaitingForCheckbox) {
        loggedWaitingForCheckbox = true;
        log('TMailor: Waiting for Cloudflare checkbox to render', 'info');
      }
    }

    await sleep(250);
  }

  if (sawChallenge) {
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
  while (Date.now() - start < timeout) {
    throwIfStopped();
    assertNoFatalMailboxError();
    if (await dismissBlockingOverlay()) {
      await sleep(250);
      continue;
    }
    if (isCloudflareChallengeVisible()) {
      await waitForCloudflareConfirm();
      await sleep(250);
      continue;
    }
    const newEmailBtn = findButtonByText([/new\s*email/i]);
    const refreshBtn = findButtonByText([/refresh/i]);
    if (newEmailBtn || refreshBtn || collectDisplayedEmails().length > 0) {
      await waitForCloudflareConfirm(2500);
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
  await sleep(1200);
  return true;
}

async function fetchTmailorEmail(payload = {}) {
  const {
    generateNew = true,
    domainState = {},
  } = payload || {};

  await waitForMailboxControls();

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

  const newEmailButton = findButtonByText([/new\s*email/i]);
  if (!newEmailButton) {
    throw new Error('Could not find the TMailor "New Email" button.');
  }

  let previousEmail = tryCurrentEmail();

  for (let attempt = 1; attempt <= 25; attempt++) {
    assertNoFatalMailboxError();
    simulateClick(newEmailButton);
    log(`TMailor: Clicked New Email (${attempt}/25)`);
    await waitForCloudflareConfirm();
    await sleep(1200);

    await maybeChooseAllowedDomain(domainState);
    await sleep(800);
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

  throw new Error('TMailor did not generate a whitelisted or non-blacklisted .com mailbox in time.');
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

  return rows;
}

function parseMailRow(element, index) {
  const combinedText = normalizeText(element.textContent || '');
  const textLines = combinedText.split(/\n+/).map((line) => normalizeText(line)).filter(Boolean);
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
  await dismissBlockingOverlay();

  const refreshButton = findButtonByText([/refresh/i]);
  if (refreshButton) {
    simulateClick(refreshButton);
    await sleep(1200);
    assertNoFatalMailboxError();
    await dismissBlockingOverlay();
    await waitForCloudflareConfirm(2500);
    return;
  }

  const inboxButton = findButtonByText([/inbox/i]);
  if (inboxButton) {
    simulateClick(inboxButton);
    await sleep(900);
    assertNoFatalMailboxError();
    await dismissBlockingOverlay();
    await waitForCloudflareConfirm(2500);
  }
}

async function clickMailRow(row) {
  const target = findMailRowOpenTarget(row?.element);
  simulateClick(target || row.element);
  await sleep(1000);
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
    const code = findCodeInPageText();
    if (code) {
      return code;
    }
    await sleep(intervalMs);
  }
  return null;
}

function findMailboxBackButton() {
  return findButtonByText([/back/i, /inbox/i, /messages/i, /mailbox/i]);
}

async function leaveMailDetailView() {
  const backButton = findMailboxBackButton();
  if (backButton) {
    simulateClick(backButton);
    await sleep(900);
    return true;
  }

  if (window.history && typeof window.history.back === 'function') {
    window.history.back();
    await sleep(900);
    return true;
  }

  return false;
}

async function readCodeFromMailRow(row) {
  let code = extractVerificationCode(row?.combinedText || '');
  if (code) {
    return code;
  }

  await clickMailRow(row);
  code = await waitForCodeInPage(5000, 250);
  if (code) {
    return code;
  }

  const leftDetailView = await leaveMailDetailView();
  if (leftDetailView) {
    code = await waitForCodeInPage(2500, 250);
    if (code) {
      return code;
    }
  }

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
      const code = await readCodeFromMailRow(latestMatch);

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
      await sleep(intervalMs);
    }
  }

  throw new Error(`Step ${step}: No matching verification email found on TMailor after ${maxAttempts} attempts.`);
}

window.__MULTIPAGE_TMAILOR_TEST_HOOKS = {
  assertNoFatalMailboxError,
  clickMailRow,
  dismissBlockingOverlay,
  readCodeFromMailRow,
  readCodeFromCurrentDetailPage,
  handlePollEmail,
  waitForCodeInPage,
  extractVerificationCode,
  findMailRowOpenTarget,
  findCodeInPageText,
  waitForCloudflareConfirm,
};

})();
