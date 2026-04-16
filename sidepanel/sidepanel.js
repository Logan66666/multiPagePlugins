// sidepanel/sidepanel.js — Side Panel logic

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',  // ✓
  failed: '\u2717',     // ✗
  stopped: '\u25A0',    // ■
};

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const btnCopyOauthUrl = document.getElementById('btn-copy-oauth-url');
const btnCopyLocalhostUrl = document.getElementById('btn-copy-localhost-url');
const btnCopyEmail = document.getElementById('btn-copy-email');
const btnCopyPassword = document.getElementById('btn-copy-password');
const btnFetchEmail = document.getElementById('btn-fetch-email');
const btnTogglePassword = document.getElementById('btn-toggle-password');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
const stepsProgress = document.getElementById('steps-progress');
const btnAutoRun = document.getElementById('btn-auto-run');
const autoContinueBar = document.getElementById('auto-continue-bar');
const autoContinueHint = document.getElementById('auto-continue-hint');
const btnCopyLogRound = document.getElementById('btn-copy-log-round');
const btnLogRoundPrev = document.getElementById('btn-log-round-prev');
const btnLogRoundNext = document.getElementById('btn-log-round-next');
const displayLogRound = document.getElementById('display-log-round');
const btnLogScrollBottom = document.getElementById('btn-log-scroll-bottom');
const inputVpsUrl = document.getElementById('input-vps-url');
const btnToggleVpsUrl = document.getElementById('btn-toggle-vps-url');
const runSuccessStats = document.getElementById('run-success-stats');
const runFailureStats = document.getElementById('run-failure-stats');
const runSuccessDetails = document.getElementById('run-success-details');
const runFailureDetails = document.getElementById('run-failure-details');
const rowMailProvider = document.getElementById('row-mail-provider');
const selectMailProvider = document.getElementById('select-mail-provider');
const selectEmailSource = document.getElementById('select-email-source');
const row33MailSettings = document.getElementById('row-33mail-settings');
const row33MailRotate = document.getElementById('row-33mail-rotate');
const input33MailDomain163 = document.getElementById('input-33mail-domain-163');
const input33MailDomainQq = document.getElementById('input-33mail-domain-qq');
const inputAutoRotateMailProvider = document.getElementById('input-auto-rotate-mail-provider');
const rowInbucketHost = document.getElementById('row-inbucket-host');
const inputInbucketHost = document.getElementById('input-inbucket-host');
const rowInbucketMailbox = document.getElementById('row-inbucket-mailbox');
const inputInbucketMailbox = document.getElementById('input-inbucket-mailbox');
const inputRunCount = document.getElementById('input-run-count');
const inputRunInfinite = document.getElementById('input-run-infinite');
  const rowTmailorDomains = document.getElementById('row-tmailor-domains');
  const summaryTmailorWhitelist = document.getElementById('summary-tmailor-whitelist');
  const summaryTmailorBlacklist = document.getElementById('summary-tmailor-blacklist');
  const tbodyTmailorWhitelist = document.getElementById('tbody-tmailor-whitelist');
  const tbodyTmailorBlacklist = document.getElementById('tbody-tmailor-blacklist');
  const selectTmailorDomainMode = document.getElementById('select-tmailor-domain-mode');
  const tmailorApiStatus = document.getElementById('tmailor-api-status');
  const btnTmailorApiCode = document.getElementById('btn-tmailor-api-code');
const mailDomainGroups = [...document.querySelectorAll('.mail-domain-group')];
const mailDomainInputs = {
  '163': input33MailDomain163,
  qq: input33MailDomainQq,
};
const DEFAULT_AUTO_RUN_COUNT = 1;
const {
  DEFAULT_EMAIL_SOURCE,
  createDefault33MailDomainSettings,
  normalize33MailDomainSettings,
  sanitizeEmailSource,
} = EmailAddresses;
const {
  buildTopSettingPayload,
  getAutoContinueHint,
  getEmailInputPlaceholder,
} = SidepanelSettings;
const { shouldDisableStepButton, shouldEnableStopButton } = ManualStepControls;
const { buildLogRoundClipboardText } = SidepanelLogCopy;
const { isLogNearBottom, shouldShowScrollToBottomButton } = SidepanelLogScroll;
const {
  buildRunFailureSummaryHtml,
  buildRunStatsDetailsHtml,
  buildRunSuccessDetailsHtml,
  buildRunSuccessSummaryHtml,
  normalizeDisplayedAutoRunStats,
} = SidepanelRunStats;
const { pickTmailorCandidate } = TmailorInput;
const {
  buildTmailorRejectedDomainMessage,
  getClipboardReadDeniedMessage,
  getNoTmailorEmailFoundMessage,
  getTmailorValidationSuccessAction,
  shouldExecuteStep3AfterValidation,
  shouldAttemptAutoRunResumeFromInput,
  shouldFallbackToStep3AfterResume,
  shouldRetryTmailorFetchAfterValidationFailure,
} = TmailorPasteFeedback;
  const {
    normalizeTmailorDomainState,
    sanitizeTmailorDomainMode,
    DEFAULT_TMAILOR_DOMAIN_MODE,
    TMAILOR_DOMAIN_MODES,
    validateTmailorEmail,
  } = TmailorDomains;
  const TMAILOR_DOMAIN_MODE_LABELS = {
    whitelist_only: '工作模式：仅白名单',
    com_only: '撞库模式：com域名+白名单',
  };
const { buildToastKey, canonicalizeToastMessage, getToastDuration, shouldSuppressToastMessage } = ToastFeedback;
  let mailDomainSettingsState = createDefault33MailDomainSettings();
  let tmailorDomainState = normalizeTmailorDomainState();
  let tmailorApiStatusState = { ok: false, status: 'idle', message: 'TMailor API not checked yet.' };
  let autoRunPhaseState = 'idle';
  let keepLogPinnedToBottom = true;
  let logRoundsState = [];
  let selectedLogRoundId = '';
  let followLatestLogRound = true;
  renderTmailorModeOptions();

const ACTION_ICONS = {
  copy: `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2"></rect>
      <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"></path>
    </svg>
  `,
  fetch: `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v4"></path>
      <path d="M12 17v4"></path>
      <path d="M4.93 4.93l2.83 2.83"></path>
      <path d="M16.24 16.24l2.83 2.83"></path>
      <path d="M3 12h4"></path>
      <path d="M17 12h4"></path>
      <path d="M4.93 19.07l2.83-2.83"></path>
      <path d="M16.24 7.76l2.83-2.83"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `,
  pasteCheck: `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 4h8"></path>
      <path d="M9 2h6v4H9z"></path>
      <path d="M7 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8"></path>
      <path d="M14 16l2 2 4-4"></path>
    </svg>
  `,
  busy: `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3.2-6.9"></path>
      <path d="M21 3v6h-6"></path>
    </svg>
  `,
  apiCode: `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2"></rect>
      <path d="M3 8l9 6 9-6"></path>
      <path d="M8 12h2"></path>
      <path d="M8 16h4"></path>
    </svg>
  `,
  eye: `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `,
  eyeOff: `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 3l18 18"></path>
      <path d="M10.6 10.6A3 3 0 0 0 14.4 14.4"></path>
      <path d="M9.88 5.09A10.94 10.94 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-3.08 3.81"></path>
      <path d="M6.61 6.61A17.33 17.33 0 0 0 2 12s3.5 7 10 7a10.94 10.94 0 0 0 5.39-1.61"></path>
    </svg>
  `,
};

// ============================================================
// Toast Notifications
// ============================================================

const toastContainer = document.getElementById('toast-container');
const activeToasts = new Map();

const TOAST_ICONS = {
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showToast(message, type = 'error', duration, options = {}) {
  if (shouldSuppressToastMessage(message, type)) {
    return null;
  }

  const resolvedDuration = getToastDuration(type, duration);
  const toastKey = buildToastKey(message, type);
  const existing = activeToasts.get(toastKey);
  const displayMessage = options.canonicalizeDisplay
    ? canonicalizeToastMessage(message)
    : message;

  if (existing?.toast?.parentNode) {
    existing.messageEl.textContent = displayMessage;
    scheduleToastDismiss(existing.toast, resolvedDuration);
    return existing.toast;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || ''}<span class="toast-msg">${escapeHtml(displayMessage)}</span><button class="toast-close">&times;</button>`;
  toast.dataset.toastKey = toastKey;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  activeToasts.set(toastKey, {
    toast,
    messageEl: toast.querySelector('.toast-msg'),
  });
  toastContainer.appendChild(toast);
  scheduleToastDismiss(toast, resolvedDuration);
  return toast;
}

function scheduleToastDismiss(toast, duration) {
  if (toast._dismissTimer) {
    clearTimeout(toast._dismissTimer);
    toast._dismissTimer = null;
  }
  if (duration > 0) {
    toast._dismissTimer = setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  if (toast._dismissTimer) {
    clearTimeout(toast._dismissTimer);
    toast._dismissTimer = null;
  }
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => {
    const toastKey = toast.dataset.toastKey;
    if (toastKey && activeToasts.get(toastKey)?.toast === toast) {
      activeToasts.delete(toastKey);
    }
    toast.remove();
  }, { once: true });
}

// ============================================================
// State Restore on load
// ============================================================

function normalizeLogRounds(rounds = [], fallbackLogs = []) {
  const normalizedRounds = Array.isArray(rounds) && rounds.length > 0
    ? rounds.map((round, index) => ({
      id: typeof round?.id === 'string' && round.id ? round.id : `log-round-${index + 1}`,
      label: typeof round?.label === 'string' && round.label.trim() ? round.label.trim() : 'Current',
      logs: Array.isArray(round?.logs) ? round.logs.slice() : [],
    }))
    : [];

  if (normalizedRounds.length > 0) {
    return normalizedRounds;
  }

  return [{
    id: 'log-round-current',
    label: 'Current',
    logs: Array.isArray(fallbackLogs) ? fallbackLogs.slice() : [],
  }];
}

function getSelectedLogRoundIndex() {
  const index = logRoundsState.findIndex((round) => round.id === selectedLogRoundId);
  return index >= 0 ? index : Math.max(0, logRoundsState.length - 1);
}

function getSelectedLogRound() {
  if (!logRoundsState.length) {
    return null;
  }

  return logRoundsState[getSelectedLogRoundIndex()] || logRoundsState[logRoundsState.length - 1];
}

function getLatestLogRound() {
  return logRoundsState[logRoundsState.length - 1] || null;
}

function updateLogRoundControls() {
  const selectedIndex = getSelectedLogRoundIndex();
  const selectedRound = getSelectedLogRound();
  const roundCount = logRoundsState.length;

  if (btnCopyLogRound) {
    btnCopyLogRound.disabled = roundCount <= 0;
  }
  if (btnLogRoundPrev) {
    btnLogRoundPrev.disabled = roundCount <= 1 || selectedIndex <= 0;
  }
  if (btnLogRoundNext) {
    btnLogRoundNext.disabled = roundCount <= 1 || selectedIndex >= roundCount - 1;
  }
  if (displayLogRound) {
    const label = selectedRound?.label || 'Current';
    displayLogRound.textContent = roundCount > 0 ? `${label} (${selectedIndex + 1}/${roundCount})` : 'Current';
  }
}

function renderSelectedLogRound() {
  clearLogArea();
  const round = getSelectedLogRound();
  if (round) {
    for (const entry of round.logs) {
      appendLog(entry);
    }
  }
  scrollLogToBottom(true);
  updateLogRoundControls();
}

function setLogHistory(rounds, currentLogRoundId) {
  const previousSelectedLogRoundId = selectedLogRoundId;
  const normalizedRounds = normalizeLogRounds(rounds);
  const latestRound = normalizedRounds[normalizedRounds.length - 1] || null;
  const preferredCurrentRoundId = normalizedRounds.some((round) => round.id === currentLogRoundId)
    ? currentLogRoundId
    : latestRound?.id || '';

  logRoundsState = normalizedRounds;

  if (!followLatestLogRound && previousSelectedLogRoundId && normalizedRounds.some((round) => round.id === previousSelectedLogRoundId)) {
    selectedLogRoundId = previousSelectedLogRoundId;
  } else {
    selectedLogRoundId = preferredCurrentRoundId || latestRound?.id || '';
  }

  followLatestLogRound = selectedLogRoundId === (latestRound?.id || '');
  renderSelectedLogRound();
}

async function refreshLogHistoryFromBackground() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
    if (state.logRounds) {
      setLogHistory(state.logRounds, state.currentLogRoundId);
    } else if (state.logs) {
      setLogHistory([{
        id: 'log-round-current',
        label: 'Current',
        logs: state.logs,
      }], 'log-round-current');
    }
  } catch (err) {
    console.error('Failed to refresh log history:', err);
  }
}

function handleIncomingLogEntry(payload) {
  const entry = payload?.entry || payload;
  if (!entry || typeof entry.message !== 'string') {
    return;
  }

  const latestRound = getLatestLogRound();
  const roundId = payload?.roundId || latestRound?.id || 'log-round-current';
  let round = logRoundsState.find((candidate) => candidate.id === roundId);

  if (!round) {
    const fallbackRounds = logRoundsState.slice(-2);
    round = {
      id: roundId,
      label: latestRound?.label || 'Current',
      logs: [],
    };
    logRoundsState = [...fallbackRounds, round];
  }

  round.logs.push(entry);
  if (round.logs.length > 500) {
    round.logs.splice(0, round.logs.length - 500);
  }

  const newestRound = getLatestLogRound();
  if (selectedLogRoundId === roundId) {
    appendLog(entry);
  } else {
    updateLogRoundControls();
  }

  followLatestLogRound = selectedLogRoundId === (newestRound?.id || '');
}

async function restoreState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });

    setDisplayValue(displayOauthUrl, state.oauthUrl);
    setDisplayValue(displayLocalhostUrl, state.localhostUrl);
    if (state.email) {
      inputEmail.value = state.email;
    }
    syncPasswordField(state);
    if (state.vpsUrl) {
      inputVpsUrl.value = state.vpsUrl;
    }
    if (state.mailProvider) {
      selectMailProvider.value = state.mailProvider;
    }
    selectEmailSource.value = sanitizeEmailSource(state.emailSource);
    mailDomainSettingsState = normalize33MailDomainSettings(state.mailDomainSettings);
    tmailorDomainState = normalizeTmailorDomainState(state.tmailorDomainState);
    tmailorApiStatusState = state.tmailorApiStatus || tmailorApiStatusState;
    inputAutoRotateMailProvider.checked = Boolean(state.autoRotateMailProvider);
    if (state.inbucketHost) {
      inputInbucketHost.value = state.inbucketHost;
    }
    if (state.inbucketMailbox) {
      inputInbucketMailbox.value = state.inbucketMailbox;
    }
    inputRunCount.value = String(state.autoRunCount || DEFAULT_AUTO_RUN_COUNT);
    inputRunInfinite.checked = Boolean(state.autoRunInfinite);

    if (state.stepStatuses) {
      for (const [step, status] of Object.entries(state.stepStatuses)) {
        updateStepUI(Number(step), status);
      }
    }

    if (state.logRounds) {
      setLogHistory(state.logRounds, state.currentLogRoundId);
    } else if (state.logs) {
      setLogHistory([{
        id: 'log-round-current',
        label: 'Current',
        logs: state.logs,
      }], 'log-round-current');
    }

    updateAutoRunStatsDisplay(state.autoRunStats);
    updateStatusDisplay(state);
    updateProgressCounter();
    updateMailProviderUI();
    updateEmailSourceUI();
    renderTmailorDomainTables();
    renderTmailorApiStatus();
    updateRunModeUI();
    syncLogScrollUi();
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

function syncPasswordField(state) {
  inputPassword.value = state.customPassword || state.password || '';
}

function updateAutoRunStatsDisplay(stats = {}) {
  const normalizedStats = normalizeDisplayedAutoRunStats(stats);
  if (runSuccessStats) {
    runSuccessStats.innerHTML = buildRunSuccessSummaryHtml(normalizedStats);
  }
  if (runFailureStats) {
    runFailureStats.innerHTML = buildRunFailureSummaryHtml(normalizedStats);
  }
  if (runSuccessDetails) {
    runSuccessDetails.innerHTML = buildRunSuccessDetailsHtml(normalizedStats);
  }
  if (runFailureDetails) {
    runFailureDetails.innerHTML = buildRunStatsDetailsHtml(normalizedStats);
  }
}

function updateMailProviderUI() {
  const source = sanitizeEmailSource(selectEmailSource.value);
  const useInbucket = selectMailProvider.value === 'inbucket';
  rowMailProvider.style.display = source === 'tmailor' ? 'none' : '';
  rowInbucketHost.style.display = useInbucket ? '' : 'none';
  rowInbucketMailbox.style.display = useInbucket ? '' : 'none';
}

function getEmailSourceLabel() {
  if (selectEmailSource.value === '33mail') return '33mail';
  if (selectEmailSource.value === 'tmailor') return 'TMailor';
  return 'Duck';
}

function getCurrentProviderLabel() {
  if (selectMailProvider.value === 'qq') return 'QQ';
  if (selectMailProvider.value === 'inbucket') return 'Inbucket';
  return '163';
}

function update33MailGroupUI() {
  input33MailDomain163.value = mailDomainSettingsState['163']?.emailDomain || '';
  input33MailDomainQq.value = mailDomainSettingsState.qq?.emailDomain || '';

  mailDomainGroups.forEach((group) => {
    const provider = group.dataset.provider;
    group.classList.toggle('active', provider === selectMailProvider.value);
  });
}

function updateEmailSourceUI() {
  const emailSource = sanitizeEmailSource(selectEmailSource.value);
  const is33Mail = emailSource === '33mail';
  const isTmailor = emailSource === 'tmailor';
  const currentProvider = selectMailProvider.value;
  const isGroupedMailProvider = currentProvider === '163' || currentProvider === 'qq';

  row33MailSettings.style.display = is33Mail ? '' : 'none';
  row33MailRotate.style.display = is33Mail ? '' : 'none';
  rowTmailorDomains.style.display = isTmailor ? '' : 'none';
  update33MailGroupUI();
  updateMailProviderUI();
  renderTmailorApiStatus();
  renderTmailorApiCodeButton(false);

  inputEmail.placeholder = getEmailInputPlaceholder({
    emailSource,
    mailProvider: currentProvider,
    autoRotateMailProvider: inputAutoRotateMailProvider.checked,
  });
  renderFetchButton(false);
  autoContinueHint.textContent = getAutoContinueHint({
    emailSource,
    mailProvider: currentProvider,
    autoRotateMailProvider: inputAutoRotateMailProvider.checked,
  });

  if (isTmailor) {
    void refreshTmailorApiStatus();
  }
}

function createDomainRowHtml(domain, stats) {
  const successCount = Math.max(0, Number.parseInt(String(stats?.successCount ?? 0), 10) || 0);
  const failureCount = Math.max(0, Number.parseInt(String(stats?.failureCount ?? 0), 10) || 0);
  return `
    <tr>
      <td>${escapeHtml(domain)}</td>
      <td class="num">${successCount}</td>
      <td class="num">${failureCount}</td>
    </tr>
  `;
}

  function renderDomainRows(tbody, domains) {
    if (domains.length === 0) {
      tbody.innerHTML = '<tr><td class="empty" colspan="3">暂无数据</td></tr>';
      return;
    }

    tbody.innerHTML = domains
      .map((domain) => createDomainRowHtml(domain, tmailorDomainState.stats?.[domain] || {}))
      .join('');
  }

  function renderTmailorModeOptions() {
    if (!selectTmailorDomainMode) {
      return;
    }

    selectTmailorDomainMode.innerHTML = TMAILOR_DOMAIN_MODES
      .map((mode) => `<option value="${mode}">${TMAILOR_DOMAIN_MODE_LABELS[mode] || mode}</option>`)
      .join('');
  }

  async function persistTmailorDomainMode(rawMode) {
    if (!selectTmailorDomainMode) {
      return;
    }

    const nextMode = sanitizeTmailorDomainMode(rawMode);
    if (nextMode === tmailorDomainState.mode) {
      selectTmailorDomainMode.value = nextMode;
      return;
    }

    tmailorDomainState = normalizeTmailorDomainState({
      ...tmailorDomainState,
      mode: nextMode,
    });

    selectTmailorDomainMode.value = nextMode;
    renderTmailorDomainTables();

    try {
      await chrome.runtime.sendMessage({
        type: 'SAVE_TMAILOR_DOMAIN_STATE',
        source: 'sidepanel',
        payload: { mode: nextMode },
      });
    } catch (err) {
      console.error('Failed to save TMailor domain mode:', err);
    }
  }

  function renderTmailorDomainTables() {
    const normalizedState = normalizeTmailorDomainState(tmailorDomainState);
    tmailorDomainState = normalizedState;
    if (selectTmailorDomainMode) {
      selectTmailorDomainMode.value = normalizedState.mode;
    }

    const whitelistDomains = [...normalizedState.whitelist].sort((left, right) => left.localeCompare(right));
  const blacklistDomains = [...normalizedState.blacklist].sort((left, right) => left.localeCompare(right));
  const whitelistTotals = whitelistDomains.reduce((acc, domain) => {
    const stats = normalizedState.stats?.[domain] || {};
    acc.success += Math.max(0, Number.parseInt(String(stats.successCount ?? 0), 10) || 0);
    acc.failure += Math.max(0, Number.parseInt(String(stats.failureCount ?? 0), 10) || 0);
    return acc;
  }, { success: 0, failure: 0 });
  const blacklistTotals = blacklistDomains.reduce((acc, domain) => {
    const stats = normalizedState.stats?.[domain] || {};
    acc.success += Math.max(0, Number.parseInt(String(stats.successCount ?? 0), 10) || 0);
    acc.failure += Math.max(0, Number.parseInt(String(stats.failureCount ?? 0), 10) || 0);
    return acc;
  }, { success: 0, failure: 0 });

  summaryTmailorWhitelist.textContent = `白名单域名 (${whitelistDomains.length}) · 成 ${whitelistTotals.success} / 败 ${whitelistTotals.failure}`;
  summaryTmailorBlacklist.textContent = `黑名单域名 (${blacklistDomains.length}) · 成 ${blacklistTotals.success} / 败 ${blacklistTotals.failure}`;

  renderDomainRows(tbodyTmailorWhitelist, whitelistDomains);
  renderDomainRows(tbodyTmailorBlacklist, blacklistDomains);
}

function updateRunModeUI() {
  inputRunCount.disabled = btnAutoRun.disabled || inputRunInfinite.checked;
  inputRunCount.title = inputRunInfinite.checked ? 'Ignored in infinite mode' : 'Number of runs';
}

function renderFetchButton(isBusy = false) {
  const emailSource = sanitizeEmailSource(selectEmailSource.value);
  const idleIcon = emailSource === 'tmailor' ? ACTION_ICONS.pasteCheck : ACTION_ICONS.fetch;
  btnFetchEmail.innerHTML = isBusy ? ACTION_ICONS.busy : idleIcon;
  btnFetchEmail.classList.toggle('is-busy', isBusy);
  btnFetchEmail.title = isBusy
    ? emailSource === 'tmailor'
      ? 'Pasting and validating email...'
      : 'Generating or fetching email...'
    : emailSource === 'tmailor'
      ? 'Paste and validate email'
      : emailSource === '33mail'
      ? 'Generate email'
      : 'Fetch email';
  btnFetchEmail.setAttribute('aria-label', btnFetchEmail.title);
}

function renderPasswordToggleButton() {
  const hidden = inputPassword.type === 'password';
  btnTogglePassword.innerHTML = hidden ? ACTION_ICONS.eye : ACTION_ICONS.eyeOff;
  btnTogglePassword.title = hidden ? 'Show password' : 'Hide password';
  btnTogglePassword.setAttribute('aria-label', btnTogglePassword.title);
}

function renderVpsToggleButton() {
  const hidden = inputVpsUrl.type === 'password';
  btnToggleVpsUrl.innerHTML = hidden ? ACTION_ICONS.eye : ACTION_ICONS.eyeOff;
  btnToggleVpsUrl.title = hidden ? 'Show VPS URL' : 'Hide VPS URL';
  btnToggleVpsUrl.setAttribute('aria-label', btnToggleVpsUrl.title);
}

function renderTmailorApiStatus() {
  if (!tmailorApiStatus) {
    return;
  }

  const status = tmailorApiStatusState?.status || 'idle';
  const message = tmailorApiStatusState?.message || 'TMailor API not checked yet.';
  tmailorApiStatus.className = `tmailor-api-status tmailor-api-status-${status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'idle'}`;
  tmailorApiStatus.textContent = message;
}

function renderTmailorApiCodeButton(isBusy = false) {
  if (!btnTmailorApiCode) {
    return;
  }

  const isTmailor = sanitizeEmailSource(selectEmailSource.value) === 'tmailor';
  btnTmailorApiCode.innerHTML = isBusy ? ACTION_ICONS.busy : ACTION_ICONS.apiCode;
  btnTmailorApiCode.classList.toggle('is-busy', isBusy);
  btnTmailorApiCode.disabled = !isTmailor || isBusy;
  btnTmailorApiCode.title = isBusy
    ? 'Fetching current mailbox code via API...'
    : 'Fetch current mailbox code via API';
  btnTmailorApiCode.setAttribute('aria-label', btnTmailorApiCode.title);
}

async function refreshTmailorApiStatus() {
  try {
    tmailorApiStatusState = { ok: false, status: 'idle', message: 'Checking TMailor API...' };
    renderTmailorApiStatus();
    const response = await chrome.runtime.sendMessage({ type: 'CHECK_TMAILOR_API_STATUS', source: 'sidepanel' });
    tmailorApiStatusState = response?.tmailorApiStatus || { ok: false, status: 'error', message: 'TMailor API check failed.' };
  } catch (err) {
    tmailorApiStatusState = { ok: false, status: 'error', message: `TMailor API check failed: ${err.message}` };
  }

  renderTmailorApiStatus();
}

async function copyFieldValue(input, emptyMessage, successMessage) {
  const value = input.value.trim();
  if (!value) {
    showToast(emptyMessage, 'warn', 2500);
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage, 'success', 2200);
  } catch (err) {
    showToast(`Copy failed: ${err.message}`, 'error');
  }
}

async function copyTextValue(value, successMessage, failureMessage = '') {
  try {
    await navigator.clipboard.writeText(String(value || ''));
    showToast(successMessage, 'success', 2500);
    return true;
  } catch (err) {
    const fallbackMessage = failureMessage
      ? `${failureMessage}: ${err.message}`
      : `Current code: ${value} (clipboard unavailable: ${err.message})`;
    showToast(fallbackMessage, 'warn', 4200);
    return false;
  }
}

function setDisplayValue(element, value, fallbackText = 'Waiting...') {
  const nextValue = String(value || '').trim();
  const hasValue = Boolean(nextValue);
  element.classList.toggle('has-value', hasValue);
  if ('value' in element) {
    element.value = hasValue ? nextValue : '';
    if ('placeholder' in element) {
      element.placeholder = fallbackText;
    }
    return;
  }
  element.textContent = hasValue ? nextValue : fallbackText;
}

function renderStaticActionButtons() {
  btnCopyOauthUrl.innerHTML = ACTION_ICONS.copy;
  btnCopyLocalhostUrl.innerHTML = ACTION_ICONS.copy;
  btnCopyEmail.innerHTML = ACTION_ICONS.copy;
  btnCopyPassword.innerHTML = ACTION_ICONS.copy;
  if (btnCopyLogRound) {
    btnCopyLogRound.innerHTML = ACTION_ICONS.copy;
  }
  renderTmailorApiCodeButton(false);
}

function formatAutoRunWaitUntil(waitUntilTimestamp) {
  if (!Number.isFinite(waitUntilTimestamp)) return '';
  const remainingMs = Math.max(0, waitUntilTimestamp - Date.now());
  const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

// ============================================================
// UI Updates
// ============================================================

function updateStepUI(step, status) {
  const statusEl = document.querySelector(`.step-status[data-step="${step}"]`);
  const row = document.querySelector(`.step-row[data-step="${step}"]`);

  if (statusEl) statusEl.textContent = STATUS_ICONS[status] || '';
  if (row) {
    row.className = `step-row ${status}`;
  }

  updateButtonStates();
  updateProgressCounter();
}

function updateProgressCounter() {
  let completed = 0;
  document.querySelectorAll('.step-row').forEach(row => {
    if (row.classList.contains('completed')) completed++;
  });
  stepsProgress.textContent = `${completed} / 9`;
}

function updateButtonStates() {
  const statuses = {};
  document.querySelectorAll('.step-row').forEach(row => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else if (row.classList.contains('stopped')) statuses[step] = 'stopped';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');

  for (let step = 1; step <= 9; step++) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    if (!btn) continue;
    btn.disabled = shouldDisableStepButton({ anyRunning, step, statuses });
  }

  updateStopButtonState(shouldEnableStopButton({
    anyRunning,
    autoContinueVisible: autoContinueBar.style.display !== 'none',
    autoRunPhase: autoRunPhaseState,
    statuses,
  }));
}

function updateStopButtonState(active) {
  btnStop.disabled = !active;
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;

  statusBar.className = 'status-bar';

  const running = Object.entries(state.stepStatuses).find(([, s]) => s === 'running');
  if (running) {
    displayStatus.textContent = `Step ${running[0]} running...`;
    statusBar.classList.add('running');
    return;
  }

  const failed = Object.entries(state.stepStatuses).find(([, s]) => s === 'failed');
  if (failed) {
    displayStatus.textContent = `Step ${failed[0]} failed`;
    statusBar.classList.add('failed');
    return;
  }

  const stopped = Object.entries(state.stepStatuses).find(([, s]) => s === 'stopped');
  if (stopped) {
    displayStatus.textContent = `Step ${stopped[0]} stopped`;
    statusBar.classList.add('stopped');
    return;
  }

  const lastCompleted = Object.entries(state.stepStatuses)
    .filter(([, s]) => s === 'completed')
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastCompleted === 9) {
    displayStatus.textContent = 'All steps completed!';
    statusBar.classList.add('completed');
  } else if (lastCompleted) {
    displayStatus.textContent = `Step ${lastCompleted} done`;
  } else {
    displayStatus.textContent = 'Ready';
  }
}

function appendLog(entry) {
  const shouldPinAfterAppend = keepLogPinnedToBottom || isLogNearBottom(getLogScrollMetrics());
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const levelLabel = entry.level.toUpperCase();
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;

  const stepMatch = entry.message.match(/Step (\d)/);
  const stepNum = stepMatch ? stepMatch[1] : null;

  let html = `<span class="log-time">${time}</span> `;
  html += `<span class="log-level log-level-${entry.level}">${levelLabel}</span> `;
  if (stepNum) {
    html += `<span class="log-step-tag step-${stepNum}">S${stepNum}</span>`;
  }
  html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;

  line.innerHTML = html;
  logArea.appendChild(line);
  if (shouldPinAfterAppend) {
    scrollLogToBottom(true);
    return;
  }

  syncLogScrollUi();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getLogScrollMetrics() {
  return {
    scrollTop: logArea.scrollTop,
    clientHeight: logArea.clientHeight,
    scrollHeight: logArea.scrollHeight,
    hasLogs: logArea.childElementCount > 0,
  };
}

function syncLogScrollUi() {
  if (!btnLogScrollBottom) {
    return;
  }

  const shouldShow = shouldShowScrollToBottomButton(getLogScrollMetrics());
  btnLogScrollBottom.hidden = !shouldShow;
  btnLogScrollBottom.classList.toggle('visible', shouldShow);
}

function scrollLogToBottom(force = false) {
  if (!force && !keepLogPinnedToBottom) {
    syncLogScrollUi();
    return;
  }

  logArea.scrollTop = logArea.scrollHeight;
  keepLogPinnedToBottom = true;
  syncLogScrollUi();
}

function clearLogArea() {
  logArea.innerHTML = '';
  keepLogPinnedToBottom = true;
  syncLogScrollUi();
}

function setMailDomainForProvider(provider, value) {
  mailDomainSettingsState = normalize33MailDomainSettings({
    ...mailDomainSettingsState,
    [provider]: { emailDomain: value },
  });
}

async function fetchEmailAddress(options = {}) {
  const {
    manageButtonState = true,
    suppressErrorToast = false,
  } = options;

  if (manageButtonState) {
    btnFetchEmail.disabled = true;
    renderFetchButton(true);
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_EMAIL_ADDRESS',
      source: 'sidepanel',
      payload: { generateNew: true },
    });

    if (response?.error) {
      throw new Error(response.error);
    }
    if (!response?.email) {
      throw new Error('Email address was not returned.');
    }

    if (response.mailProvider) {
      selectMailProvider.value = response.mailProvider;
      updateMailProviderUI();
      updateEmailSourceUI();
    }
    inputEmail.value = response.email;
    if (autoContinueBar.style.display !== 'none' && response.email) {
      await chrome.runtime.sendMessage({
        type: 'SAVE_EMAIL',
        source: 'sidepanel',
        payload: { email: response.email },
      });
      await resumeAutoRunFromEmail(response.email);
      return response.email;
    }
    const providerLabel = response.mailProvider === 'qq'
      ? 'QQ'
      : response.mailProvider === '163'
        ? '163'
        : getCurrentProviderLabel();
    const isGeneratedSource = response.emailSource === '33mail' || response.emailSource === 'tmailor';
    showToast(
      `${isGeneratedSource ? 'Ready' : 'Fetched'} ${response.email}${response.emailSource === '33mail' ? ` · ${providerLabel}` : ''}`,
      'success',
      3500
    );
    return response.email;
  } catch (err) {
    if (!suppressErrorToast) {
      showToast(`${getEmailSourceLabel()} error: ${err.message}`, 'error');
    }
    throw err;
  } finally {
    if (manageButtonState) {
      btnFetchEmail.disabled = false;
      renderFetchButton(false);
    }
  }
}

async function pasteAndValidateTmailorEmail() {
  btnFetchEmail.disabled = true;
  renderFetchButton(true);

  try {
    inputEmail.value = '';
    const inputText = '';
    let clipboardText = '';
    let clipboardReadDenied = false;
    if (!inputText) {
      try {
        clipboardText = await navigator.clipboard.readText();
      } catch {
        clipboardReadDenied = true;
      }
    }

    const picked = pickTmailorCandidate(inputText, clipboardText, { preferClipboard: true });
    const candidate = picked.candidate;
    const validation = validateTmailorEmail(tmailorDomainState, candidate);

    if (!validation.ok) {
      if (validation.reason === 'invalid_email') {
        throw new Error(!inputText && clipboardReadDenied
          ? getClipboardReadDeniedMessage()
          : getNoTmailorEmailFoundMessage());
      }

      if (shouldRetryTmailorFetchAfterValidationFailure(validation)) {
        inputEmail.value = '';
        await chrome.runtime.sendMessage({
          type: 'SAVE_EMAIL',
          source: 'sidepanel',
          payload: { email: '' },
        });

        showToast(
          buildTmailorRejectedDomainMessage(validation.domain, tmailorDomainState.mode),
          'warn',
          2800
        );

        try {
          const freshEmail = await fetchEmailAddress({
            manageButtonState: false,
            suppressErrorToast: true,
          });
          return freshEmail;
        } catch (fetchErr) {
          throw new Error(`自动请求新的 TMailor 邮箱失败：${fetchErr.message}`);
        }
      }

      throw new Error(buildTmailorRejectedDomainMessage(validation.domain, tmailorDomainState.mode));
    }

    inputEmail.value = validation.email;
    await chrome.runtime.sendMessage({
      type: 'SAVE_EMAIL',
      source: 'sidepanel',
      payload: { email: validation.email },
    });

    const successAction = getTmailorValidationSuccessAction({
      autoContinueVisible: autoContinueBar.style.display !== 'none',
    });

    let resumeSucceeded = false;
    if (successAction === 'resume_auto_run') {
      resumeSucceeded = await resumeAutoRunFromEmail(validation.email);
      if (resumeSucceeded) {
        return validation.email;
      }
    }

    if (shouldExecuteStep3AfterValidation({ successAction, resumeSucceeded })) {
      await persistCurrentTopSettings();
      await chrome.runtime.sendMessage({
        type: 'EXECUTE_STEP',
        source: 'sidepanel',
        payload: { step: 3, email: validation.email },
      });
      showToast(`Accepted ${validation.email}${picked.source === 'input' ? ' · from input' : ''} · starting step 3`, 'success', 3000);
    }

    return validation.email;
  } catch (err) {
    showToast(`Paste check failed: ${err.message}`, 'error');
    throw err;
  } finally {
    btnFetchEmail.disabled = false;
    renderFetchButton(false);
  }
}

function syncPasswordToggleLabel() {
  renderPasswordToggleButton();
  renderVpsToggleButton();
}

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    await persistCurrentTopSettings();
    if (step === 3) {
      const email = inputEmail.value.trim();
      if (!['33mail', 'tmailor'].includes(sanitizeEmailSource(selectEmailSource.value)) && !email) {
        showToast('Please paste email address or use Auto first', 'warn');
        return;
      }
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: email ? { step, email } : { step } });
    } else {
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
    }
  });
});

btnFetchEmail.addEventListener('click', async () => {
  await persistCurrentTopSettings();
  if (sanitizeEmailSource(selectEmailSource.value) === 'tmailor') {
    await pasteAndValidateTmailorEmail().catch(() => {});
    return;
  }
  await fetchEmailAddress().catch(() => {});
});

if (btnTmailorApiCode) {
  btnTmailorApiCode.addEventListener('click', async () => {
    renderTmailorApiCodeButton(true);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_TMAILOR_API_CODE',
        source: 'sidepanel',
      });

      if (response?.error) {
        throw new Error(response.error);
      }
      if (!response?.code) {
        throw new Error('No verification code was returned.');
      }

      const copied = await copyTextValue(
        response.code,
        `API code ${response.code} copied`
      );
      if (!copied) {
        showToast(`API code ${response.code}`, 'success', 3000);
      }
    } catch (err) {
      showToast(`API code fetch failed: ${err.message}`, 'error');
    } finally {
      renderTmailorApiCodeButton(false);
    }
  });
}

btnCopyOauthUrl.addEventListener('click', async () => {
  await copyFieldValue(displayOauthUrl, 'OAuth URL is empty', 'OAuth URL copied');
});

btnCopyLocalhostUrl.addEventListener('click', async () => {
  await copyFieldValue(displayLocalhostUrl, 'Callback URL is empty', 'Callback URL copied');
});

btnCopyEmail.addEventListener('click', async () => {
  await copyFieldValue(inputEmail, 'Email is empty', 'Email copied');
});

btnCopyPassword.addEventListener('click', async () => {
  await copyFieldValue(inputPassword, 'Password is empty', 'Password copied');
});

if (btnCopyLogRound) {
  btnCopyLogRound.addEventListener('click', async () => {
    const selectedRound = getSelectedLogRound();
    if (!selectedRound) {
      showToast('No log page available to copy', 'warn', 2500);
      return;
    }

    const copied = await copyTextValue(
      buildLogRoundClipboardText(selectedRound),
      'Current page logs copied',
      'Copy logs failed'
    );
    if (!copied) return;
  });
}

btnTogglePassword.addEventListener('click', () => {
  inputPassword.type = inputPassword.type === 'password' ? 'text' : 'password';
  syncPasswordToggleLabel();
});

btnToggleVpsUrl.addEventListener('click', () => {
  inputVpsUrl.type = inputVpsUrl.type === 'password' ? 'text' : 'password';
  renderVpsToggleButton();
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_FLOW', source: 'sidepanel', payload: {} });
  showToast('Stopping...', 'warn', 2200);
});

// Auto Run
btnAutoRun.addEventListener('click', async () => {
  const totalRuns = parseInt(inputRunCount.value) || 1;
  const infiniteMode = inputRunInfinite.checked;
  await persistCurrentTopSettings({ autoRunCount: totalRuns, autoRunInfinite: infiniteMode });
  btnAutoRun.disabled = true;
  inputRunInfinite.disabled = true;
  updateRunModeUI();
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Running...';
  await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns, infiniteMode } });
});

// Reset
btnReset.addEventListener('click', async () => {
  if (confirm('Reset all steps and data?')) {
    await chrome.runtime.sendMessage({ type: 'RESET', source: 'sidepanel' });
    setDisplayValue(displayOauthUrl, '');
    setDisplayValue(displayLocalhostUrl, '');
    inputEmail.value = '';
    inputPassword.value = '';
    displayStatus.textContent = 'Ready';
    statusBar.className = 'status-bar';
    await refreshLogHistoryFromBackground();
    document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
    document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
    btnAutoRun.disabled = false;
    inputRunInfinite.disabled = false;
    btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
    autoContinueBar.style.display = 'none';
    updateStopButtonState(false);
    updateButtonStates();
    updateProgressCounter();
    updateRunModeUI();
  }
});

if (btnLogRoundPrev) {
  btnLogRoundPrev.addEventListener('click', () => {
    const currentIndex = getSelectedLogRoundIndex();
    if (currentIndex <= 0) {
      return;
    }
    selectedLogRoundId = logRoundsState[currentIndex - 1].id;
    followLatestLogRound = selectedLogRoundId === (getLatestLogRound()?.id || '');
    renderSelectedLogRound();
  });
}

if (btnLogRoundNext) {
  btnLogRoundNext.addEventListener('click', () => {
    const currentIndex = getSelectedLogRoundIndex();
    if (currentIndex >= logRoundsState.length - 1) {
      return;
    }
    selectedLogRoundId = logRoundsState[currentIndex + 1].id;
    followLatestLogRound = selectedLogRoundId === (getLatestLogRound()?.id || '');
    renderSelectedLogRound();
  });
}

logArea.addEventListener('scroll', () => {
  keepLogPinnedToBottom = isLogNearBottom(getLogScrollMetrics());
  syncLogScrollUi();
});

if (btnLogScrollBottom) {
  btnLogScrollBottom.addEventListener('click', () => {
    scrollLogToBottom(true);
  });
}

async function saveTopSetting(payload) {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload,
  });
}

function collectTopSettingPayload(overrides = {}) {
  return buildTopSettingPayload({
    vpsUrl: inputVpsUrl.value,
    mailProvider: selectMailProvider.value,
    emailSource: selectEmailSource.value,
    mailDomainSettings: mailDomainSettingsState,
    inbucketHost: inputInbucketHost.value,
    inbucketMailbox: inputInbucketMailbox.value,
    autoRunCount: inputRunCount.value,
    autoRunInfinite: inputRunInfinite.checked,
    autoRotateMailProvider: inputAutoRotateMailProvider.checked,
    ...overrides,
  });
}

async function persistCurrentTopSettings(overrides = {}) {
  await saveTopSetting(collectTopSettingPayload(overrides));
}

async function resumeAutoRunFromEmail(email) {
  const trimmedEmail = String(email || '').trim();
  const resumeResult = await chrome.runtime.sendMessage({
    type: 'RESUME_AUTO_RUN',
    source: 'sidepanel',
    payload: trimmedEmail ? { email: trimmedEmail } : {},
  });

  if (!shouldFallbackToStep3AfterResume(resumeResult)) {
    autoContinueBar.style.display = 'none';
    showToast(`Accepted ${trimmedEmail} · resumed`, 'success', 3000);
    return true;
  }

  await persistCurrentTopSettings();
  await chrome.runtime.sendMessage({
    type: 'EXECUTE_STEP',
    source: 'sidepanel',
    payload: trimmedEmail ? { step: 3, email: trimmedEmail } : { step: 3 },
  });
  autoContinueBar.style.display = 'none';
  showToast(`Accepted ${trimmedEmail} · starting step 3`, 'success', 3000);
  return true;
}

// Save settings on change
inputEmail.addEventListener('change', async () => {
  const email = inputEmail.value.trim();
  if (email) {
    await chrome.runtime.sendMessage({ type: 'SAVE_EMAIL', source: 'sidepanel', payload: { email } });
    if (shouldAttemptAutoRunResumeFromInput({
      autoContinueVisible: autoContinueBar.style.display !== 'none',
      email,
    })) {
      await resumeAutoRunFromEmail(email);
    }
  }
});

inputVpsUrl.addEventListener('input', async () => {
  const vpsUrl = inputVpsUrl.value.trim();
  await saveTopSetting({ vpsUrl });
});

inputPassword.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { customPassword: inputPassword.value },
  });
});

selectMailProvider.addEventListener('change', async () => {
  updateMailProviderUI();
  updateEmailSourceUI();
  await saveTopSetting({ mailProvider: selectMailProvider.value });
});

selectEmailSource.addEventListener('change', async () => {
  updateEmailSourceUI();
  await saveTopSetting({ emailSource: selectEmailSource.value });
});

Object.entries(mailDomainInputs).forEach(([provider, input]) => {
  input.addEventListener('input', async () => {
    setMailDomainForProvider(provider, input.value.trim());
    updateEmailSourceUI();
    await saveTopSetting({ mailDomainSettings: mailDomainSettingsState });
  });
});

inputAutoRotateMailProvider.addEventListener('change', async () => {
  updateEmailSourceUI();
  await saveTopSetting({ autoRotateMailProvider: inputAutoRotateMailProvider.checked });
});

inputInbucketMailbox.addEventListener('change', async () => {
  await saveTopSetting({ inbucketMailbox: inputInbucketMailbox.value.trim() });
});

inputInbucketHost.addEventListener('change', async () => {
  await saveTopSetting({ inbucketHost: inputInbucketHost.value.trim() });
});

  inputRunCount.addEventListener('input', async () => {
    const count = parseInt(inputRunCount.value, 10);
    await saveTopSetting({ autoRunCount: Number.isFinite(count) && count > 0 ? count : DEFAULT_AUTO_RUN_COUNT });
  });

  inputRunInfinite.addEventListener('change', async () => {
    updateRunModeUI();
    await saveTopSetting({ autoRunInfinite: inputRunInfinite.checked });
  });

  if (selectTmailorDomainMode) {
    selectTmailorDomainMode.addEventListener('change', () => {
      void persistTmailorDomainMode(selectTmailorDomainMode.value);
    });
  }

// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      handleIncomingLogEntry(message.payload);
      if (message.payload?.entry?.level === 'error' && !shouldSuppressToastMessage(message.payload.entry.message, 'error')) {
        showToast(message.payload.entry.message, 'error', undefined, { canonicalizeDisplay: true });
      } else if (message.payload?.level === 'error' && !shouldSuppressToastMessage(message.payload.message, 'error')) {
        showToast(message.payload.message, 'error', undefined, { canonicalizeDisplay: true });
      }
      break;

    case 'LOG_HISTORY_UPDATED':
      setLogHistory(message.payload?.logRounds || [], message.payload?.currentLogRoundId || '');
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(updateStatusDisplay);
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
          syncPasswordField(state);
          if (state.oauthUrl) {
            setDisplayValue(displayOauthUrl, state.oauthUrl);
          }
          if (state.localhostUrl) {
            setDisplayValue(displayLocalhostUrl, state.localhostUrl);
          }
        });
      }
      break;
    }

    case 'AUTO_RUN_RESET': {
      // Full UI reset for next run
      setDisplayValue(displayOauthUrl, '');
      setDisplayValue(displayLocalhostUrl, '');
      inputEmail.value = '';
      inputPassword.value = '';
      displayStatus.textContent = 'Ready';
      statusBar.className = 'status-bar';
      refreshLogHistoryFromBackground();
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      updateStopButtonState(false);
      updateProgressCounter();
      break;
    }

    case 'DATA_UPDATED': {
      if (message.payload.email) {
        inputEmail.value = message.payload.email;
      }
      if (message.payload.password !== undefined) {
        inputPassword.value = message.payload.password || '';
      }
      if (message.payload.mailProvider) {
        selectMailProvider.value = message.payload.mailProvider;
        updateMailProviderUI();
        updateEmailSourceUI();
      }
      if (message.payload.tmailorDomainState) {
        tmailorDomainState = normalizeTmailorDomainState(message.payload.tmailorDomainState);
        renderTmailorDomainTables();
      }
      if (message.payload.tmailorApiStatus) {
        tmailorApiStatusState = message.payload.tmailorApiStatus;
        renderTmailorApiStatus();
      }
      if (message.payload.autoRunStats) {
        updateAutoRunStatsDisplay(message.payload.autoRunStats);
      }
      if (message.payload.oauthUrl) {
        setDisplayValue(displayOauthUrl, message.payload.oauthUrl);
      }
      if (message.payload.localhostUrl) {
        setDisplayValue(displayLocalhostUrl, message.payload.localhostUrl);
      }
      break;
    }

    case 'AUTO_RUN_STATUS': {
      const { phase, currentRun, totalRuns, infiniteMode, summaryToast, waitUntilTimestamp } = message.payload;
      autoRunPhaseState = phase || 'idle';
      updateAutoRunStatsDisplay(message.payload);
      const runLabel = infiniteMode
        ? ` (${currentRun}/∞)`
        : totalRuns > 1 ? ` (${currentRun}/${totalRuns})` : '';
      switch (phase) {
        case 'waiting_email':
          autoContinueBar.style.display = 'flex';
          btnAutoRun.innerHTML = `Paused${runLabel}`;
          updateStopButtonState(true);
          break;
        case 'running':
          btnAutoRun.innerHTML = `Running${runLabel}`;
          updateStopButtonState(true);
          break;
        case 'waiting_rotation': {
          const waitLabel = formatAutoRunWaitUntil(waitUntilTimestamp);
          btnAutoRun.innerHTML = `Waiting${runLabel}`;
          updateStopButtonState(true);
          if (waitLabel) {
            showToast(`33mail 达到上限，约 ${waitLabel} 后继续`, 'warn', 3600);
          }
          break;
        }
        case 'complete':
          autoRunPhaseState = 'idle';
          btnAutoRun.disabled = false;
          inputRunInfinite.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          updateButtonStates();
          updateRunModeUI();
          if (summaryToast) {
            showToast(summaryToast, 'success', 4200);
          }
          break;
        case 'stopped':
          autoRunPhaseState = 'idle';
          btnAutoRun.disabled = false;
          inputRunInfinite.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          updateButtonStates();
          updateRunModeUI();
          if (summaryToast) {
            showToast(summaryToast, 'warn', 3600);
          }
          break;
      }
      break;
    }
  }
});

// ============================================================
// Theme Toggle
// ============================================================

const btnTheme = document.getElementById('btn-theme');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('multipage-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('multipage-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Init
// ============================================================

initTheme();
renderStaticActionButtons();
renderTmailorApiStatus();
restoreState().then(() => {
  syncPasswordToggleLabel();
  updateButtonStates();
  updateRunModeUI();
  syncLogScrollUi();
});
