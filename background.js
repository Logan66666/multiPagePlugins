// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('shared/email-addresses.js', 'shared/mail-provider-rotation.js', 'shared/tmailor-domains.js', 'shared/tmailor-api.js', 'shared/tmailor-errors.js', 'shared/tmailor-mailbox-strategy.js', 'shared/tmailor-verification-profiles.js', 'shared/flow-recovery.js', 'shared/content-script-queue.js', 'shared/login-verification-codes.js', 'data/names.js', 'shared/flow-runner.js', 'shared/runtime-errors.js', 'shared/auto-run.js', 'shared/auto-run-failure-stats.js', 'shared/duck-mail-errors.js', 'shared/sidepanel-settings.js', 'shared/tab-reclaim.js', 'shared/account-records.js');

const LOG_PREFIX = '[Infinitoai:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const OFFICIAL_SIGNUP_ENTRY_URL = 'https://platform.openai.com/login';
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const AUTO_RUN_HANDOFF_MESSAGE = 'Auto run handed off to manual continuation.';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const TMAILOR_API_CAPTCHA_COOLDOWN_MS = 3 * 60 * 1000;
const MAX_LOG_ENTRIES_PER_ROUND = 500;
const MAX_LOG_ROUNDS = 3;
const STEP5_MAX_PROFILE_RETRY_ATTEMPTS = 2;
const STEP6_MAX_OAUTH_RETRY_ATTEMPTS = 10;
const { getStepDelayAfter, runStepSequence } = FlowRunner;
const {
  buildMailPollRecoveryPlan,
  isMessageChannelClosedError,
  isReceivingEndMissingError,
  shouldRetryStep1WithFreshVpsPanel,
  shouldRetryStep3WithPlatformLoginRefresh,
  shouldRetryStep3WithFreshOauth,
  shouldRetryStep5WithProfileRefresh,
  shouldRetryStep6WithFreshOauth,
  shouldRetryStep7Through9FromStep6,
  shouldRetryStep8WithFreshOauth,
  shouldSkipStepResultLog,
} = RuntimeErrors;
const {
  DEFAULT_AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
  decorateAuthFailureWithEmailDomain,
  buildAutoRunLogSilenceErrorMessage,
  buildAutoRunStatusPayload,
  buildAutoRunFailureRecord,
  formatAutoRunLabel,
  getAutoRunActiveWatchdogAlarmName,
  getAutoRunPauseWatchdogAlarmName,
  getAutoRunPauseWatchdogDeadline,
  getAutoRunWatchdogLastLogEntry,
  isAutoRunLogSilenceError,
  shouldContinueAutoRunAfterWatchdog,
  shouldContinueAutoRunAfterError,
  shouldRearmPersistentAutoRunWatchdogFromLog,
  shouldUsePersistentAutoRunPauseWatchdog,
  shouldStartNextInfiniteRunAfterManualFlow,
  shouldSuspendAutoRunWatchdogDuringPause,
  summarizeAutoRunResult,
} = AutoRun;
const {
  normalizeAutoRunStats,
  recordAutoRunFailure,
  recordAutoRunSuccess,
  resetAutoRunFailureStats,
} = AutoRunFailureStats;
const { addDuckMailRetryHint } = DuckMailErrors;
const { isTmailorApiCaptchaError } = TmailorErrors;
const { getTmailorApiOnlyPollingMessage, shouldUseTmailorApiMailboxOnly } = TmailorMailboxStrategy;
const { buildManualTmailorCodeFetchConfig, getTmailorVerificationProfile } = TmailorVerificationProfiles;
const {
  createAccountRecord,
  normalizeAccountRecords,
  patchAccountRecord,
  shouldPersistAccountRecord,
  updateAccountRecordStatus,
} = AccountRecords;
const {
  buildContentScriptResponseTimeoutError,
  getContentScriptQueueTimeout,
  getContentScriptResponseTimeout,
  queueCommandForReinjection,
} = ContentScriptQueue;
const { mergeLoginVerificationCodeExclusions } = LoginVerificationCodes;
const { DEFAULT_EMAIL_SOURCE, generate33MailAddress, get33MailDomainForProvider, sanitizeEmailSource } = EmailAddresses;
const { chooseMailProviderForAutoRun, getConfiguredRotatableMailProviders, getNextMailProviderAvailabilityTimestamp, isRotatableMailProvider, pruneMailProviderUsage, recordMailProviderUsage } = MailProviderRotation;
const { DEFAULT_TMAILOR_DOMAIN_STATE, extractEmailDomain, isAllowedTmailorDomain, mergeTmailorDomainStates, normalizeTmailorDomainState, recordTmailorDomainFailure, recordTmailorDomainSuccess, shouldBlacklistTmailorDomainForError } = TmailorDomains;
const {
  checkTmailorApiConnectivity,
  createTmailorApiCaptchaCooldownUntil,
  fetchAllowedTmailorEmail,
  isTmailorApiCaptchaCooldownActive,
  pollTmailorVerificationCode,
} = TmailorApi;
const { buildReclaimableTabRegistry, shouldPrepareSameUrlTabForReuse, shouldReuseActiveTabOnCreate } = TabReclaim;
const {
  buildStep8RedirectHeartbeatMessage,
  getMailTabOpenUrlForStep,
  getStep6RecoveryReasonForUnexpectedAuthPage,
  isLocalhostCallbackUrl,
  shouldLogStep8RedirectHeartbeat,
  shouldNavigateMailTabOnStepStart,
} = FlowRecovery;
const {
  DEFAULT_AUTO_RUN_COUNT,
  DEFAULT_AUTO_RUN_INFINITE,
  DEFAULT_AUTO_ROTATE_MAIL_PROVIDER,
  PERSISTED_TOP_SETTING_KEYS,
  DEFAULT_EMAIL_SOURCE: DEFAULT_PERSISTED_EMAIL_SOURCE,
  normalizePersistentSettings,
  sanitizeAccountSuccessOnly,
  sanitizeAutoRunCount,
  sanitizeAutoRotateMailProvider,
  sanitizeEmailSource: sanitizePersistedEmailSource,
  sanitizeInfiniteAutoRun,
} = SidepanelSettings;

const RECLAIM_SOURCE_CONFIG = {
  'signup-page': {
    readyOnClaim: false,
    loadedMarker: '__MULTIPAGE_SIGNUP_PAGE_LOADED',
    inject: [
      'shared/verification-code.js',
      'shared/phone-verification.js',
      'shared/auth-fatal-errors.js',
      'shared/unsupported-email.js',
      'content/utils.js',
      'content/signup-page.js',
      'content/openai-auth-step3-flow.js',
      'content/openai-auth-step6-flow.js',
      'content/openai-auth-step2-handler.js',
      'content/openai-auth-step3-handler.js',
      'content/openai-auth-step5-handler.js',
      'content/openai-auth-step6-handler.js',
      'content/openai-auth-step8-handler.js',
      'content/openai-auth-actions-handler.js',
    ],
  },
  'qq-mail': {
    readyOnClaim: true,
  },
  'mail-163': {
    readyOnClaim: true,
  },
  'duck-mail': {
    readyOnClaim: false,
    loadedMarker: '__MULTIPAGE_DUCK_MAIL_LOADED',
    inject: ['content/utils.js', 'content/duck-mail.js'],
  },
  'tmailor-mail': {
    readyOnClaim: false,
    loadedMarker: '__MULTIPAGE_TMAILOR_MAIL_LOADED',
    inject: ['shared/mail-matching.js', 'shared/mail-freshness.js', 'shared/latest-mail.js', 'content/utils.js', 'content/tmailor-mail.js'],
  },
  'inbucket-mail': {
    readyOnClaim: false,
    loadedMarker: '__MULTIPAGE_INBUCKET_MAIL_LOADED',
    injectSource: 'inbucket-mail',
    inject: ['shared/mail-matching.js', 'shared/mail-freshness.js', 'shared/latest-mail.js', 'content/utils.js', 'content/inbucket-mail.js'],
  },
  'vps-panel': {
    readyOnClaim: false,
    loadedMarker: '__MULTIPAGE_VPS_PANEL_LOADED',
    inject: ['shared/flow-recovery.js', 'content/utils.js', 'content/vps-panel.js'],
  },
};

initializeSessionStorageAccess();

let automationWindowId = null;

function createLogRound(label = 'Current') {
  return {
    id: `log-round-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: String(label || 'Current'),
    logs: [],
  };
}

function buildInitialLogState(label = 'Current') {
  const round = createLogRound(label);
  return {
    logs: [],
    logRounds: [round],
    currentLogRoundId: round.id,
  };
}

function normalizeLogEntry(entry) {
  if (!entry || typeof entry.message !== 'string') {
    return null;
  }

  return {
    message: entry.message,
    level: typeof entry.level === 'string' ? entry.level : 'info',
    timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
  };
}

function normalizeLogRound(round, index = 0) {
  const logs = Array.isArray(round?.logs)
    ? round.logs
      .map(normalizeLogEntry)
      .filter(Boolean)
      .slice(-MAX_LOG_ENTRIES_PER_ROUND)
    : [];

  return {
    id: typeof round?.id === 'string' && round.id ? round.id : `log-round-legacy-${index}`,
    label: typeof round?.label === 'string' && round.label.trim() ? round.label.trim() : 'Current',
    logs,
  };
}

function getNormalizedLogHistory(state = {}) {
  const fallbackLogs = Array.isArray(state.logs)
    ? state.logs.map(normalizeLogEntry).filter(Boolean).slice(-MAX_LOG_ENTRIES_PER_ROUND)
    : [];

  let logRounds = Array.isArray(state.logRounds) && state.logRounds.length > 0
    ? state.logRounds.map((round, index) => normalizeLogRound(round, index)).filter(Boolean)
    : [];

  if (!logRounds.length) {
    const initial = createLogRound('Current');
    initial.logs = fallbackLogs;
    logRounds = [initial];
  }

  if (logRounds.length > MAX_LOG_ROUNDS) {
    logRounds = logRounds.slice(-MAX_LOG_ROUNDS);
  }

  let currentLogRoundId = typeof state.currentLogRoundId === 'string' ? state.currentLogRoundId : '';
  if (!logRounds.some((round) => round.id === currentLogRoundId)) {
    currentLogRoundId = logRounds[logRounds.length - 1].id;
  }

  const currentRound = logRounds.find((round) => round.id === currentLogRoundId) || logRounds[logRounds.length - 1];

  return {
    logRounds,
    currentLogRoundId,
    logs: currentRound.logs.slice(),
  };
}

async function ensureAutomationWindowId() {
  if (automationWindowId != null) {
    try {
      await chrome.windows.get(automationWindowId);
      return automationWindowId;
    } catch {
      automationWindowId = null;
    }
  }
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (entry.tabId) {
      try {
        const tab = await chrome.tabs.get(entry.tabId);
        automationWindowId = tab.windowId;
        return automationWindowId;
      } catch {}
    }
  }
  const win = await chrome.windows.getLastFocused();
  automationWindowId = win.id;
  return automationWindowId;
}


// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  currentRunStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  accountRecords: [],
  currentAccountRecordId: null,
  lastEmailTimestamp: null,
  lastTargetEmailAcquiredAt: null,
  lastSignupVerificationCode: '',
  rejectedSignupVerificationCodes: [],
  rejectedLoginVerificationCodes: [],
  localhostUrl: null,
  existingAccountLogin: false,
  flowStartTime: null,
  tabRegistry: {},
  ...buildInitialLogState(),
  vpsUrl: '',
  vpsCpaPassword: '',
  customPassword: '',
  mailProvider: '163', // 'qq' or '163'
  inbucketHost: '',
  inbucketMailbox: '',
  autoRunCount: DEFAULT_AUTO_RUN_COUNT,
  autoRunInfinite: DEFAULT_AUTO_RUN_INFINITE,
  autoRunStats: normalizeAutoRunStats({
    successfulRuns: 0,
    failedRuns: 0,
    totalSuccessfulDurationMs: 0,
    recentSuccessDurationsMs: [],
    recentSuccessEntries: [],
    failureBuckets: [],
  }),
  tmailorDomainState: DEFAULT_TMAILOR_DOMAIN_STATE,
  tmailorAccessToken: '',
  tmailorApiCaptchaCooldownUntil: 0,
  tmailorOutcomeRecorded: false,
  tmailorApiStatus: {
    ok: false,
    status: 'idle',
    message: 'TMailor API not checked yet.',
  },
  emailLease: null,
  autoRunActiveWatchdog: null,
  autoRunPauseWatchdog: null,
  mailProviderUsage: {
    '163': [],
    qq: [],
  },
};

const TMAILOR_DOMAIN_STATE_KEY = 'tmailorDomainState';
const AUTO_RUN_STATS_KEY = 'autoRunStats';
const ACCOUNT_RECORDS_KEY = 'accountRecords';
const AUTO_RUN_LOG_SILENCE_TIMEOUT_MS = DEFAULT_AUTO_RUN_LOG_SILENCE_TIMEOUT_MS;
let cachedTmailorDomainSeeds = null;
let autoRunStatsLoaded = false;
let autoRunStatsLoadPromise = null;

function applyAutoRunStatsCache(stats = {}) {
  const normalizedStats = normalizeAutoRunStats(stats);
  autoRunSuccessfulRuns = normalizedStats.successfulRuns;
  autoRunFailedRuns = normalizedStats.failedRuns;
  autoRunStatsState = normalizedStats;
  autoRunStatsLoaded = true;
  return normalizedStats;
}

async function loadPersistentTmailorDomainSeeds() {
  if (cachedTmailorDomainSeeds) {
    return cachedTmailorDomainSeeds;
  }

  try {
    const url = chrome.runtime.getURL('data/tmailor-domains.json');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load TMailor seeds: ${response.status}`);
    }
    cachedTmailorDomainSeeds = await response.json();
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to load TMailor domain seeds:', err?.message || err);
    cachedTmailorDomainSeeds = {};
  }

  return cachedTmailorDomainSeeds;
}

async function getState() {
  const persistentSettings = await getPersistentSettings();
  const [sessionState, tmailorDomainState, autoRunStats, accountRecords] = await Promise.all([
    chrome.storage.session.get(null),
    getPersistentTmailorDomainState(),
    getPersistentAutoRunStats(),
    getPersistentAccountRecords({ successOnly: persistentSettings.accountSuccessOnly }),
  ]);
  return { ...DEFAULT_STATE, ...sessionState, ...persistentSettings, tmailorDomainState, autoRunStats, accountRecords };
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function getPersistentAccountRecords(options = {}) {
  const [localState, sessionState] = await Promise.all([
    chrome.storage.local.get(ACCOUNT_RECORDS_KEY),
    chrome.storage.session.get(ACCOUNT_RECORDS_KEY),
  ]);

  const localStored = localState[ACCOUNT_RECORDS_KEY];
  const sessionStored = sessionState[ACCOUNT_RECORDS_KEY];
  const mergedRecords = normalizeAccountRecords(
    localStored !== undefined
      ? localStored
      : (sessionStored !== undefined ? sessionStored : DEFAULT_STATE.accountRecords),
    { successOnly: options.successOnly }
  );

  const localStoredJson = JSON.stringify(localStored || null);
  const sessionStoredJson = JSON.stringify(sessionStored || null);
  const mergedJson = JSON.stringify(mergedRecords);

  if (localStored === undefined && sessionStored !== undefined) {
    await chrome.storage.local.set({ [ACCOUNT_RECORDS_KEY]: mergedRecords });
  } else if (localStoredJson !== mergedJson || sessionStoredJson !== mergedJson) {
    await Promise.all([
      chrome.storage.local.set({ [ACCOUNT_RECORDS_KEY]: mergedRecords }),
      chrome.storage.session.set({ [ACCOUNT_RECORDS_KEY]: mergedRecords }),
    ]);
  }

  return mergedRecords;
}

async function setPersistentAccountRecords(nextRecords, options = {}) {
  const normalizedRecords = normalizeAccountRecords(nextRecords, { successOnly: options.successOnly });
  await Promise.all([
    chrome.storage.local.set({ [ACCOUNT_RECORDS_KEY]: normalizedRecords }),
    chrome.storage.session.set({ [ACCOUNT_RECORDS_KEY]: normalizedRecords }),
  ]);
  return normalizedRecords;
}

function isSuccessOnlyAccountRecordsEnabled(state = {}) {
  return state.accountSuccessOnly !== false;
}

async function getPersistentAutoRunStats() {
  const [localState, sessionState] = await Promise.all([
    chrome.storage.local.get(AUTO_RUN_STATS_KEY),
    chrome.storage.session.get(AUTO_RUN_STATS_KEY),
  ]);

  const localStored = localState[AUTO_RUN_STATS_KEY];
  const sessionStored = sessionState[AUTO_RUN_STATS_KEY];
  const mergedStats = normalizeAutoRunStats(
    localStored !== undefined
      ? localStored
      : (sessionStored !== undefined ? sessionStored : DEFAULT_STATE.autoRunStats)
  );

  const localStoredJson = JSON.stringify(localStored || null);
  const sessionStoredJson = JSON.stringify(sessionStored || null);
  const mergedJson = JSON.stringify(mergedStats);

  if (localStored === undefined && sessionStored !== undefined) {
    await chrome.storage.local.set({ [AUTO_RUN_STATS_KEY]: mergedStats });
  } else if (localStoredJson !== mergedJson || sessionStoredJson !== mergedJson) {
    await Promise.all([
      chrome.storage.local.set({ [AUTO_RUN_STATS_KEY]: mergedStats }),
      chrome.storage.session.set({ [AUTO_RUN_STATS_KEY]: mergedStats }),
    ]);
  }

  return applyAutoRunStatsCache(mergedStats);
}

async function setPersistentAutoRunStats(nextStats) {
  const normalizedStats = applyAutoRunStatsCache(nextStats);
  await Promise.all([
    chrome.storage.local.set({ [AUTO_RUN_STATS_KEY]: normalizedStats }),
    chrome.storage.session.set({ [AUTO_RUN_STATS_KEY]: normalizedStats }),
  ]);
  return normalizedStats;
}

async function ensureAutoRunStatsLoaded() {
  if (autoRunStatsLoaded) {
    return autoRunStatsState;
  }

  if (!autoRunStatsLoadPromise) {
    autoRunStatsLoadPromise = getPersistentAutoRunStats()
      .catch((err) => {
        console.warn(LOG_PREFIX, 'Failed to load persisted auto-run stats:', err?.message || err);
        return applyAutoRunStatsCache(DEFAULT_STATE.autoRunStats);
      })
      .finally(() => {
        autoRunStatsLoadPromise = null;
      });
  }

  return await autoRunStatsLoadPromise;
}

async function getPersistentTmailorDomainState() {
  const [localState, sessionState, seedConfig] = await Promise.all([
    chrome.storage.local.get(TMAILOR_DOMAIN_STATE_KEY),
    chrome.storage.session.get(TMAILOR_DOMAIN_STATE_KEY),
    loadPersistentTmailorDomainSeeds(),
  ]);

  const storedRaw = localState[TMAILOR_DOMAIN_STATE_KEY]
    || sessionState[TMAILOR_DOMAIN_STATE_KEY]
    || DEFAULT_TMAILOR_DOMAIN_STATE;
  const storedState = normalizeTmailorDomainState(storedRaw);

  const seedState = normalizeTmailorDomainState({
    whitelist: seedConfig?.whitelist,
    blacklist: seedConfig?.blacklist,
    stats: seedConfig?.stats,
    mode: seedConfig?.mode,
  });

  const mergedState = mergeTmailorDomainStates(seedState, storedState);

  const localStoredJson = JSON.stringify(localState[TMAILOR_DOMAIN_STATE_KEY] || null);
  const sessionStoredJson = JSON.stringify(sessionState[TMAILOR_DOMAIN_STATE_KEY] || null);
  const mergedJson = JSON.stringify(mergedState);

  if (localState[TMAILOR_DOMAIN_STATE_KEY] === undefined && sessionState[TMAILOR_DOMAIN_STATE_KEY] !== undefined) {
    await chrome.storage.local.set({ [TMAILOR_DOMAIN_STATE_KEY]: mergedState });
  } else if (localStoredJson !== mergedJson || sessionStoredJson !== mergedJson) {
    await Promise.all([
      chrome.storage.local.set({ [TMAILOR_DOMAIN_STATE_KEY]: mergedState }),
      chrome.storage.session.set({ [TMAILOR_DOMAIN_STATE_KEY]: mergedState }),
    ]);
  }

  return mergedState;
}

async function setPersistentTmailorDomainState(nextState) {
  const normalizedState = normalizeTmailorDomainState(nextState);
  await Promise.all([
    chrome.storage.local.set({ [TMAILOR_DOMAIN_STATE_KEY]: normalizedState }),
    chrome.storage.session.set({ [TMAILOR_DOMAIN_STATE_KEY]: normalizedState }),
  ]);
  return normalizedState;
}

async function getPersistentSettings() {
  const [localSettings, sessionSettings] = await Promise.all([
    chrome.storage.local.get(PERSISTED_TOP_SETTING_KEYS),
    chrome.storage.session.get(PERSISTED_TOP_SETTING_KEYS),
  ]);

  const mergedSettings = normalizePersistentSettings({
    ...sessionSettings,
    ...localSettings,
  });

  // One-time migration path from the previous session-only storage.
  if (Object.keys(localSettings).length === 0 && Object.keys(sessionSettings).length > 0) {
    await chrome.storage.local.set(mergedSettings);
  }

  return mergedSettings;
}

async function setPersistentSettings(updates) {
  const currentSettings = await getPersistentSettings();
  const nextSettings = normalizePersistentSettings({
    ...currentSettings,
    ...updates,
  });
  await Promise.all([
    chrome.storage.local.set(nextSettings),
    chrome.storage.session.set(nextSettings),
  ]);
  return nextSettings;
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => {});
}

async function setMailProviderState(mailProvider) {
  const nextProvider = isRotatableMailProvider(mailProvider) || mailProvider === 'inbucket'
    ? mailProvider
    : '163';
  await setPersistentSettings({ mailProvider: nextProvider });
  broadcastDataUpdate({ mailProvider: nextProvider });
  return nextProvider;
}

async function setEmailState(email, options = {}) {
  const trimmedEmail = String(email || '').trim();
  const currentState = trimmedEmail ? null : await getState();
  const nextTargetEmailAcquiredAt = trimmedEmail
    ? (Number.isFinite(options.lastTargetEmailAcquiredAt) ? options.lastTargetEmailAcquiredAt : Date.now())
    : (Number.isFinite(currentState?.lastTargetEmailAcquiredAt) ? currentState.lastTargetEmailAcquiredAt : null);
  await setState({
    email,
    lastSignupVerificationCode: '',
    rejectedSignupVerificationCodes: [],
    rejectedLoginVerificationCodes: [],
    lastTargetEmailAcquiredAt: nextTargetEmailAcquiredAt,
  });
  broadcastDataUpdate({ email, lastTargetEmailAcquiredAt: nextTargetEmailAcquiredAt });
}

async function setTmailorMailboxState(email, accessToken) {
  const nextTargetEmailAcquiredAt = Date.now();
  await setState({
    email,
    tmailorAccessToken: String(accessToken || '').trim(),
    tmailorApiCaptchaCooldownUntil: 0,
    tmailorOutcomeRecorded: false,
    lastSignupVerificationCode: '',
    rejectedSignupVerificationCodes: [],
    rejectedLoginVerificationCodes: [],
    lastTargetEmailAcquiredAt: nextTargetEmailAcquiredAt,
  });
  broadcastDataUpdate({ email, lastTargetEmailAcquiredAt: nextTargetEmailAcquiredAt });
}

async function setTmailorDomainState(nextState) {
  const normalizedState = await setPersistentTmailorDomainState(nextState);
  broadcastDataUpdate({ tmailorDomainState: normalizedState });
  return normalizedState;
}

async function setTmailorApiStatus(nextStatus) {
  const normalizedStatus = {
    ok: Boolean(nextStatus?.ok),
    status: typeof nextStatus?.status === 'string' ? nextStatus.status : 'idle',
    message: typeof nextStatus?.message === 'string' ? nextStatus.message : 'TMailor API not checked yet.',
  };
  await setState({ tmailorApiStatus: normalizedStatus });
  broadcastDataUpdate({ tmailorApiStatus: normalizedStatus });
  return normalizedStatus;
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

function normalizeRejectedVerificationCodes(codes = []) {
  const result = [];
  for (const code of codes || []) {
    const normalized = String(code || '').trim();
    if (/^\d{6}$/.test(normalized) && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function getRejectedVerificationCodeStateKey(step) {
  return Number(step) >= 7 ? 'rejectedLoginVerificationCodes' : 'rejectedSignupVerificationCodes';
}

function getRejectedVerificationCodesForStep(step, state = {}) {
  return normalizeRejectedVerificationCodes(state?.[getRejectedVerificationCodeStateKey(step)] || []);
}

async function rememberRejectedVerificationCode(step, code) {
  const normalized = String(code || '').trim();
  if (!/^\d{6}$/.test(normalized)) {
    return [];
  }
  const currentState = await getState();
  const key = getRejectedVerificationCodeStateKey(step);
  const nextCodes = normalizeRejectedVerificationCodes([...(currentState?.[key] || []), normalized]);
  await setState({ [key]: nextCodes });
  return nextCodes;
}

async function clearRejectedVerificationCodes(step) {
  const key = getRejectedVerificationCodeStateKey(step);
  await setState({ [key]: [] });
}

function findAccountRecordIndex(records, recordId) {
  if (!recordId) {
    return -1;
  }
  return records.findIndex((record) => record.id === recordId);
}

async function createOrReuseCurrentAccountRecord(payload = {}) {
  const state = await getState();
  const successOnly = isSuccessOnlyAccountRecordsEnabled(state);
  const records = normalizeAccountRecords(state.accountRecords, { successOnly });
  const email = String(payload.email || state.email || '').trim().toLowerCase();
  const password = String(payload.password || state.password || '').trim();
  const nextStatus = payload.status === undefined ? 'pending' : payload.status;
  const nextStatusDetail = String(payload.statusDetail || '').trim();

  if (!email || !password) {
    return null;
  }

  if (successOnly && !shouldPersistAccountRecord({ status: nextStatus }, { successOnly })) {
    await setState({ currentAccountRecordId: null });
    return null;
  }

  const basePatch = {
    email,
    password,
    emailSource: payload.emailSource || state.emailSource || '',
    mailProvider: payload.mailProvider || state.mailProvider || '',
    updatedAt: new Date().toISOString(),
  };
  const currentIndex = findAccountRecordIndex(records, state.currentAccountRecordId);
  let nextRecords = records.slice();
  let currentRecord = null;

  if (
    currentIndex >= 0
    && (records[currentIndex].status === 'pending' || nextStatus === 'success')
    && records[currentIndex].email === email
    && records[currentIndex].password === password
  ) {
    currentRecord = patchAccountRecord(records[currentIndex], {
      ...basePatch,
      status: nextStatus,
      statusDetail: nextStatusDetail,
    });
    nextRecords[currentIndex] = currentRecord;
  } else {
    currentRecord = createAccountRecord({
      ...basePatch,
      status: nextStatus,
      statusDetail: nextStatusDetail,
    });
    nextRecords.push(currentRecord);
  }

  nextRecords = await setPersistentAccountRecords(nextRecords, { successOnly });
  const nextCurrentAccountRecordId = nextRecords.some((record) => record.id === currentRecord.id)
    ? currentRecord.id
    : null;
  await setState({ currentAccountRecordId: nextCurrentAccountRecordId });
  broadcastDataUpdate({ accountRecords: nextRecords });
  return nextCurrentAccountRecordId ? currentRecord : null;
}

async function updateCurrentAccountRecord(updates = {}) {
  const state = await getState();
  const successOnly = isSuccessOnlyAccountRecordsEnabled(state);
  const records = normalizeAccountRecords(state.accountRecords, { successOnly });
  const currentIndex = findAccountRecordIndex(records, state.currentAccountRecordId);
  if (currentIndex < 0) {
    if (updates.status === 'success') {
      return await createOrReuseCurrentAccountRecord({
        email: state.email,
        password: state.password,
        emailSource: state.emailSource,
        mailProvider: state.mailProvider,
        status: updates.status,
        statusDetail: updates.statusDetail,
      });
    }
    return null;
  }

  const nextRecord = updates.status !== undefined || updates.statusDetail !== undefined
    ? updateAccountRecordStatus(records[currentIndex], updates)
    : patchAccountRecord(records[currentIndex], updates);
  const nextRecords = records.slice();
  nextRecords[currentIndex] = nextRecord;
  const normalizedRecords = await setPersistentAccountRecords(nextRecords, { successOnly });
  const nextCurrentAccountRecordId = normalizedRecords.some((record) => record.id === nextRecord.id)
    ? nextRecord.id
    : null;
  await setState({ currentAccountRecordId: nextCurrentAccountRecordId });
  broadcastDataUpdate({ accountRecords: normalizedRecords });
  return nextCurrentAccountRecordId ? nextRecord : null;
}

async function updateCurrentAccountRecordFromError(errorMessage) {
  const detail = String(errorMessage || '').trim();
  if (!detail) {
    return null;
  }
  return await updateCurrentAccountRecord({ statusDetail: detail });
}

async function resetState(options = {}) {
  const { preserveLogHistory = false } = options;
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const [prev, persistentBundle] = await Promise.all([
    chrome.storage.session.get([
      'seenCodes',
      'seenInbucketMailIds',
      'accounts',
      'tabRegistry',
      'logs',
      'logRounds',
      'currentLogRoundId',
      'tmailorOutcomeRecorded',
      'mailProviderUsage',
      'customPassword',
    ]),
    Promise.all([getPersistentSettings(), getPersistentTmailorDomainState(), getPersistentAutoRunStats(), getPersistentAccountRecords()]),
  ]);
  const [persistentSettings, tmailorDomainState, autoRunStats, accountRecords] = persistentBundle;
  const logHistoryState = preserveLogHistory
    ? getNormalizedLogHistory(prev)
    : buildInitialLogState();
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    ...persistentSettings,
    ...logHistoryState,
    tmailorDomainState,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: prev.accounts || [],
    accountRecords,
    currentAccountRecordId: null,
    tabRegistry: prev.tabRegistry || {},
    autoRunStats,
    tmailorOutcomeRecorded: false,
    mailProviderUsage: pruneMailProviderUsage(prev.mailProviderUsage || DEFAULT_STATE.mailProviderUsage),
    customPassword: prev.customPassword || '',
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  return await ensureTabRegistryRecovered();
}

async function closeAutoRunRoundTabs() {
  const sourcesToClose = [
    'signup-page',
    'qq-mail',
    'mail-163',
    'duck-mail',
    'tmailor-mail',
    'inbucket-mail',
  ];
  const registry = await getTabRegistry();
  const nextRegistry = { ...registry };
  const tabIdsToClose = [];

  for (const source of sourcesToClose) {
    const tabId = nextRegistry[source]?.tabId;
    if (!Number.isFinite(tabId)) {
      delete nextRegistry[source];
      continue;
    }
    tabIdsToClose.push(tabId);
    delete nextRegistry[source];
  }

  await setState({ tabRegistry: nextRegistry });

  if (!tabIdsToClose.length) {
    return;
  }

  try {
    await chrome.tabs.remove(tabIdsToClose);
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to close prior auto-run signup/mail tabs:', err?.message || err);
  }
}

async function registerTab(source, tabId) {
  const state = await getState();
  const registry = state.tabRegistry || {};
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  let registry = await ensureTabRegistryRecovered(source);
  let entry = registry[source];
  if (!entry) return false;

  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    delete registry[source];
    await setState({ tabRegistry: registry });
  }

  registry = await ensureTabRegistryRecovered(source);
  entry = registry[source];
  if (!entry) return false;

  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    delete registry[source];
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await ensureTabRegistryRecovered(source);
  return registry[source]?.tabId || null;
}

function isBrowserErrorPageTab(tab = {}) {
  const url = String(tab?.url || '').trim();
  const title = String(tab?.title || '').trim();
  const combined = `${title} ${url}`;
  if (!/https?:\/\/tmailor\.com/i.test(url)) {
    return false;
  }
  return /无法访问此网站|this site can'?t be reached|can't reach this page|ERR_[A-Z_]+/i.test(combined);
}

function getReclaimSourceConfig(source) {
  return RECLAIM_SOURCE_CONFIG[source] || { readyOnClaim: false };
}

async function isInjectedContentScriptLoaded(tabId, markerName) {
  if (!markerName) return false;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (name) => Boolean(window[name]),
      args: [markerName],
    });
    return Boolean(results?.[0]?.result);
  } catch (err) {
    console.warn(LOG_PREFIX, `Could not probe restored tab ${tabId} for ${markerName}:`, err?.message || err);
    return false;
  }
}

async function prepareReclaimedTab(source, tabId) {
  const config = getReclaimSourceConfig(source);

  if (!config.inject?.length) {
    return config.readyOnClaim;
  }

  const alreadyLoaded = await isInjectedContentScriptLoaded(tabId, config.loadedMarker);
  if (alreadyLoaded) {
    return true;
  }

  try {
    if (config.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [config.injectSource],
      });
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: config.inject,
    });
  } catch (err) {
    console.warn(LOG_PREFIX, `Failed to inject restored ${source} tab ${tabId}:`, err?.message || err);
  }

  return false;
}

async function ensureTabRegistryRecovered(requiredSource = null) {
  const state = await getState();
  const registry = state.tabRegistry || {};

  if (!requiredSource && Object.keys(registry).length > 0) {
    return registry;
  }

  if (requiredSource && registry[requiredSource]?.tabId) {
    return registry;
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to query tabs for reclaim:', err?.message || err);
    return registry;
  }

  const reclaimedRegistry = buildReclaimableTabRegistry(tabs, state);
  if (requiredSource && !reclaimedRegistry[requiredSource]) {
    return registry;
  }

  const nextRegistry = { ...registry };
  let changed = false;

  for (const [source, entry] of Object.entries(reclaimedRegistry)) {
    const ready = await prepareReclaimedTab(source, entry.tabId);
    const nextEntry = { tabId: entry.tabId, ready };
    const prevEntry = nextRegistry[source];
    if (!prevEntry || prevEntry.tabId !== nextEntry.tabId || prevEntry.ready !== nextEntry.ready) {
      nextRegistry[source] = nextEntry;
      changed = true;
      console.log(LOG_PREFIX, `Reclaimed restored tab: ${source} -> ${entry.tabId} (ready=${ready})`);
    }
  }

  if (changed) {
    await setState({ tabRegistry: nextRegistry });
    return nextRegistry;
  }

  return registry;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    if (timeout > 0) {
      timer = setTimeout(() => {
        pendingCommands.delete(source);
        const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
        console.error(LOG_PREFIX, err);
        if (source === 'tmailor-mail') {
          const messageType = String(message?.type || '').trim();
          const actionLabel = messageType === 'FETCH_TMAILOR_EMAIL'
            ? 'mailbox generation'
            : messageType === 'POLL_EMAIL'
              ? 'inbox polling'
              : 'mailbox work';
          void addLog(
            `TMailor: Content script did not become ready within ${Math.round(timeout / 1000)}s while waiting for ${actionLabel}. The page may still be loading, blocked by Cloudflare, or stalled in the browser.`,
            'warn'
          );
        }
        reject(new Error(err));
      }, timeout);
    }
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function sendContentScriptMessageWithTimeout(tabId, source, message, timeoutMs = 0) {
  const sendPromise = chrome.tabs.sendMessage(tabId, message);
  if (!(timeoutMs > 0)) {
    return sendPromise;
  }

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(buildContentScriptResponseTimeoutError(source, timeoutMs)));
    }, timeoutMs);
  });
  timeoutPromise.catch(() => {});

  return Promise.race([sendPromise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    if (source === 'tmailor-mail') {
      const messageType = String(pending.message?.type || '').trim();
      const actionLabel = messageType === 'FETCH_TMAILOR_EMAIL'
        ? 'mailbox generation'
        : messageType === 'POLL_EMAIL'
          ? 'inbox polling'
          : 'mailbox work';
      void addLog(`TMailor: Content script is ready. Dispatching queued command for ${actionLabel}...`, 'info');
    }
    const responseTimeout = getContentScriptResponseTimeout(source, pending.message?.type);
    sendContentScriptMessageWithTimeout(tabId, source, pending.message, responseTimeout)
      .then(pending.resolve)
      .catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
  }
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;
    const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

    const registry = await getTabRegistry();
    if (sameUrl) {
      const entry = registry[source] || null;
      await chrome.tabs.update(tabId, { active: true });
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

      if (shouldReloadOnReuse) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        await chrome.tabs.reload(tabId);

        await new Promise((resolve) => {
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
          const listener = (tid, info) => {
            if (tid === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timer);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }

      // For dynamically injected pages like the VPS panel, re-inject immediately.
      if (options.inject) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
        await new Promise(r => setTimeout(r, 500));
      }

      if (shouldPrepareSameUrlTabForReuse(entry, options)) {
        const ready = await prepareReclaimedTab(source, tabId);
        registry[source] = { tabId, ready };
        await setState({ tabRegistry: registry });
        console.log(LOG_PREFIX, `Revalidated same-URL tab ${source} (${tabId}) after reuse (ready=${ready})`);
      }

      return tabId;
    }

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, { url, active: true });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (VPS panel), re-inject after navigation
    if (options.inject) {
      if (options.injectSource) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [options.injectSource],
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    // Wait a bit for content script to inject and send READY
    await new Promise(r => setTimeout(r, 500));

    return tabId;
  }

  // Create new tab in the automation window
  const wid = await ensureAutomationWindowId();
  if (shouldReuseActiveTabOnCreate(source, options)) {
    const reusableActiveTab = await findReusableActiveTabForSource(source, wid);
    if (reusableActiveTab) {
      await chrome.tabs.update(reusableActiveTab.id, { url, active: true });
      console.log(LOG_PREFIX, `Reused active tab ${source} (${reusableActiveTab.id}) on create path`);

      await new Promise((resolve) => {
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
        const listener = (tabId, info) => {
          if (tabId === reusableActiveTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      if (options.inject) {
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId: reusableActiveTab.id },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId: reusableActiveTab.id },
          files: options.inject,
        });
      }

      return reusableActiveTab.id;
    }
  }

  const tab = await chrome.tabs.create({ url, active: true, windowId: wid });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    if (options.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [options.injectSource],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  return tab.id;
}

async function findReusableActiveTabForSource(source, windowId) {
  const activeTabs = await chrome.tabs.query({ active: true, windowId });
  const activeTab = activeTabs[0];
  if (!Number.isFinite(activeTab?.id)) {
    return null;
  }

  const activeUrl = String(activeTab.url || '').trim();
  if (!/^https?:\/\//i.test(activeUrl)) {
    return null;
  }

  const registry = await getTabRegistry();
  for (const [registeredSource, entry] of Object.entries(registry || {})) {
    if (entry?.tabId === activeTab.id && registeredSource !== source) {
      return null;
    }
  }

  return activeTab;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  throwIfStopped();
  const nextMessage = attachContentFlowControlSequence(message);
  const registry = await getTabRegistry();
  const entry = registry[source];
  const queueTimeout = getContentScriptQueueTimeout(source, nextMessage?.type);
  const queueWaitHint = queueTimeout > 0
    ? `${Math.round(queueTimeout / 1000)}s timeout`
    : 'no timeout while waiting for manual takeover or challenge handling';
  const responseTimeout = getContentScriptResponseTimeout(source, nextMessage?.type);

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    if (source === 'tmailor-mail') {
      const actionLabel = nextMessage?.type === 'FETCH_TMAILOR_EMAIL'
        ? 'mailbox generation'
        : nextMessage?.type === 'POLL_EMAIL'
          ? 'inbox polling'
          : 'mailbox work';
      await addLog(
        `TMailor: Waiting for mailbox content script to become ready before ${actionLabel} (${queueWaitHint})...`,
        'info'
      );
    }
    return queueCommand(source, nextMessage, queueTimeout);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    if (source === 'tmailor-mail') {
      await addLog(
        `TMailor: Mailbox tab is not alive right now. Waiting for it to reopen before retrying the queued command (${queueWaitHint})...`,
        'warn'
      );
    }
    return queueCommand(source, nextMessage, queueTimeout);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, nextMessage.type);
  try {
    return await sendContentScriptMessageWithTimeout(entry.tabId, source, nextMessage, responseTimeout);
  } catch (err) {
    const errorMessage = err?.message || String(err || '');
    const recoverableDisconnect =
      isReceivingEndMissingError(errorMessage) ||
      isMessageChannelClosedError(errorMessage);
    const config = getReclaimSourceConfig(source);

    if (!recoverableDisconnect || !config.inject?.length) {
      throw err;
    }

    console.warn(LOG_PREFIX, `${source} content script disconnected, attempting reinjection:`, errorMessage);
    await addLog(`${source} 内容脚本已断开，正在重新注入并重试...`, 'warn');
    throwIfStopped();

    const nextRegistry = { ...registry };
    nextRegistry[source] = { tabId: entry.tabId, ready: false };
    await setState({ tabRegistry: nextRegistry });

    const alreadyLoaded = await prepareReclaimedTab(source, entry.tabId);
    if (alreadyLoaded) {
      throwIfStopped();
      return await chrome.tabs.sendMessage(entry.tabId, nextMessage);
    }

    if (source === 'tmailor-mail') {
      await addLog(
        `TMailor: Content script disconnected. Waiting for reinjection and ready signal before retrying (${queueWaitHint})...`,
        'warn'
      );
    }
    return queueCommandForReinjection({
      source,
      message: nextMessage,
      timeout: queueTimeout,
      queueCommand,
      reinject: async () => {
        const readyImmediately = await prepareReclaimedTab(source, entry.tabId);
        return readyImmediately ? entry.tabId : null;
      },
      flushCommand,
    });
  }
}

// ============================================================
// Logging
// ============================================================

function broadcastLogHistoryUpdate(logHistoryState) {
  chrome.runtime.sendMessage({
    type: 'LOG_HISTORY_UPDATED',
    payload: {
      logRounds: logHistoryState.logRounds,
      currentLogRoundId: logHistoryState.currentLogRoundId,
    },
  }).catch(() => {});
}

async function startNewLogRound(label) {
  const state = await getState();
  const normalized = getNormalizedLogHistory(state);
  let logRounds = normalized.logRounds.map((round) => ({
    ...round,
    logs: round.logs.slice(),
  }));

  const latestRound = logRounds[logRounds.length - 1];
  if (latestRound && latestRound.id === normalized.currentLogRoundId && latestRound.logs.length === 0) {
    latestRound.label = String(label || latestRound.label || 'Current');
  } else {
    const nextRound = createLogRound(label);
    logRounds.push(nextRound);
    if (logRounds.length > MAX_LOG_ROUNDS) {
      logRounds = logRounds.slice(-MAX_LOG_ROUNDS);
    }
  }

  const currentRound = logRounds[logRounds.length - 1];
  const nextState = {
    logRounds,
    currentLogRoundId: currentRound.id,
    logs: currentRound.logs.slice(),
  };
  await setState(nextState);
  broadcastLogHistoryUpdate(nextState);
  return nextState;
}

async function clearLogHistory() {
  const nextState = buildInitialLogState();
  await setState(nextState);
  broadcastLogHistoryUpdate(nextState);
  return nextState;
}

function appendDebugDetail(userMessage, debugMessage) {
  const normalizedUserMessage = String(userMessage || '').trim();
  const normalizedDebugMessage = String(debugMessage || '').trim();
  if (!normalizedUserMessage) {
    return normalizedDebugMessage;
  }
  if (!normalizedDebugMessage || normalizedDebugMessage === normalizedUserMessage || /调试：/i.test(normalizedUserMessage)) {
    return normalizedUserMessage;
  }
  return `${normalizedUserMessage} | 调试：${normalizedDebugMessage}`;
}

function getFriendlyWarnErrorMessage(message, level = 'info') {
  const text = String(message || '').trim();
  if (!text || (level !== 'warn' && level !== 'error')) {
    return text;
  }

  const mappings = [
    {
      pattern: /signup auth page is temporarily unreachable\. waiting for the verification page to become responsive before polling the inbox/i,
      userMessage: '当前 auth 页面暂时无法访问，先等待验证页恢复响应后再查收邮件。',
    },
    {
      pattern: /signup auth page timed out before the verification email step\. refreshing the vps oauth link and replaying step 3/i,
      userMessage: '当前 auth 页面在进入邮箱验证码阶段前超时，准备刷新 VPS OAuth 链接并重试第 3 步。',
    },
    {
      pattern: /step \d+ blocked: signup auth page stayed unreachable before the verification email step\./i,
      userMessage: '注册验证页长时间无法访问，本轮无法继续查收邮箱验证码。',
    },
    {
      pattern: /step \d+ blocked: signup page never advanced past the credential form, so the verification email was probably not sent\./i,
      userMessage: '注册页长时间停留在邮箱或密码表单，系统判断验证码邮件大概率还没有发出。',
    },
    {
      pattern: /step \d+ blocked: email domain is unsupported on the auth page/i,
      userMessage: '当前邮箱域名暂不受支持，已加入黑名单，请切换新邮箱后重试。',
    },
    {
      pattern: /step \d+ blocked: auth page requires phone verification before the verification email step\./i,
      userMessage: '当前 auth 页面要求先完成手机号验证，暂时无法继续邮箱验证码流程。',
    },
    {
      pattern: /step \d+ blocked: auth page requires phone verification before profile completion\./i,
      userMessage: '当前 auth 页面要求先完成手机号验证，暂时无法继续填写资料。',
    },
    {
      pattern: /step 5 blocked: auth page did not become reachable again after profile submit\./i,
      userMessage: '资料提交后 auth 页面一直没有恢复响应，本轮无法确认是否提交成功。',
    },
    {
      pattern: /step 5 blocked: profile submit did not reach a stable next page\./i,
      userMessage: '资料提交后没有进入稳定的下一页，系统先按未成功处理。',
    },
    {
      pattern: /auth fatal error page detected after profile submit\./i,
      userMessage: '资料提交后出现 auth 致命错误页，本轮已停止。',
    },
    {
      pattern: /step 5: signup page navigated before the step-5 response returned\. continuing to wait for completion signal/i,
      userMessage: '第 5 步页面跳转过快，先继续等待完成信号。',
    },
    {
      pattern: /step 5: auth page already advanced beyond the profile form after the navigation interrupt\./i,
      userMessage: '第 5 步页面已经越过资料表单，后台改为直接按成功收口。',
    },
    {
      pattern: /step \d+: signup page command stalled on the current verification page\. trying to fill the current verification form with the same code before reloading/i,
      userMessage: '当前验证码页响应偏慢，先尝试在原页面直接补填同一份验证码。',
    },
    {
      pattern: /step \d+: current verification page rejected the code\. returning to inbox polling/i,
      userMessage: '当前验证码已被页面拒绝，返回邮箱继续查找最新验证码。',
    },
    {
      pattern: /step \d+: the current verification page kept the form visible after a direct same-page retry/i,
      userMessage: '当前验证码页重试后仍未推进，准备刷新当前页面再试一次。',
    },
  ];

  for (const { pattern, userMessage } of mappings) {
    if (pattern.test(text)) {
      return appendDebugDetail(userMessage, text);
    }
  }

  return text;
}

async function addLog(message, level = 'info') {
  const state = await getState();
  const entry = {
    message: getFriendlyWarnErrorMessage(message, level),
    level,
    timestamp: Date.now(),
  };
  const normalized = getNormalizedLogHistory(state);
  const logRounds = normalized.logRounds.map((round) => ({
    ...round,
    logs: round.logs.slice(),
  }));
  const currentRound = logRounds.find((round) => round.id === normalized.currentLogRoundId) || logRounds[logRounds.length - 1];

  currentRound.logs.push(entry);
  if (currentRound.logs.length > MAX_LOG_ENTRIES_PER_ROUND) {
    currentRound.logs.splice(0, currentRound.logs.length - MAX_LOG_ENTRIES_PER_ROUND);
  }

  await setState({
    logRounds,
    currentLogRoundId: currentRound.id,
    logs: currentRound.logs.slice(),
  });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'LOG_ENTRY',
    payload: {
      roundId: currentRound.id,
      entry,
    },
  }).catch(() => {});
  touchAutoRunWatchdog(entry);
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  const updates = {
    stepStatuses: statuses,
    currentStep: step,
  };
  if (status === 'running') {
    updates.currentRunStep = step;
  }
  await setState(updates);
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function isAutoRunHandoffError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === AUTO_RUN_HANDOFF_MESSAGE;
}

function clearStopRequest() {
  stopRequested = false;
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

function formatWaitDuration(waitMs) {
  const totalSeconds = Math.max(1, Math.ceil(waitMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

async function clickWithDebugger(tabId, rect, options = {}) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('Step 8 debugger fallback needs a valid button position.');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `Debugger attach failed during step 8 fallback: ${err.message}. ` +
      'If DevTools is open on the auth tab, close it and retry.'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);
    const approachX = Number.isFinite(options.approachX) ? Math.round(options.approachX) : x - 2;
    const approachY = Number.isFinite(options.approachY) ? Math.round(options.approachY) : y + 2;
    const holdMs = Math.max(60, Math.min(220, Number.isFinite(options.holdMs) ? Math.round(options.holdMs) : 110));

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: approachX,
      y: approachY,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function broadcastStopToContentScripts() {
  contentFlowControlSequence += 1;
  const stopMessage = {
    type: 'STOP_FLOW',
    source: 'background',
    payload: {},
    controlSequence: contentFlowControlSequence,
  };
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, stopMessage);
    } catch {}
  }
}

let stopRequested = false;
// Seed control messages from a time-based baseline so content scripts can
// clear stale STOP_FLOW state even if the background worker restarted.
let contentFlowControlSequence = Date.now() * 1000;

function attachContentFlowControlSequence(message = {}) {
  if (!message || typeof message !== 'object') {
    return message;
  }

  const existingSequence = Number.parseInt(String(message.controlSequence ?? '').trim(), 10);
  if (Number.isFinite(existingSequence) && existingSequence > 0) {
    return message;
  }

  contentFlowControlSequence += 1;
  return {
    ...message,
    controlSequence: contentFlowControlSequence,
  };
}

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === getAutoRunPauseWatchdogAlarmName()) {
      handlePersistentAutoRunPauseWatchdogAlarm().catch((err) => {
        console.error(LOG_PREFIX, 'Persistent auto-run pause watchdog failed:', err);
      });
      return;
    }

    if (alarm?.name === getAutoRunActiveWatchdogAlarmName()) {
      handlePersistentActiveAutoRunWatchdogAlarm().catch((err) => {
        console.error(LOG_PREFIX, 'Persistent auto-run active watchdog failed:', err);
      });
    }
  });
}

async function handlePersistentAutoRunPauseWatchdogAlarm() {
  const state = await getState();
  const context = getNormalizedAutoRunPauseWatchdogContext(state.autoRunPauseWatchdog);
  if (!context || !shouldUsePersistentAutoRunPauseWatchdog({
    phase: context.phase,
    infiniteMode: context.infiniteMode,
  })) {
    await clearPersistentAutoRunPauseWatchdog();
    return;
  }

  if (!state.autoRunning) {
    await clearPersistentAutoRunPauseWatchdog();
    return;
  }

  if (context.deadlineAt > Date.now() + 250) {
    if (chrome.alarms?.create) {
      await chrome.alarms.create(getAutoRunPauseWatchdogAlarmName(), { when: context.deadlineAt });
    }
    return;
  }

  const { error, lastLogEntry } = buildPausedAutoRunWatchdogError(state, context);

  if (resumeWaiter) {
    const waiter = resumeWaiter;
    resumeWaiter = null;
    await clearPersistentAutoRunPauseWatchdog();
    waiter.reject(error);
    return;
  }

  await finalizePersistentAutoRunWatchdogTimeout(error, state, context, lastLogEntry);
}

async function handlePersistentActiveAutoRunWatchdogAlarm() {
  const state = await getState();
  const context = getNormalizedAutoRunPauseWatchdogContext(state.autoRunActiveWatchdog);
  if (!context || context.phase !== 'running') {
    await clearPersistentAutoRunActiveWatchdog();
    return;
  }

  if (!state.autoRunning) {
    await clearPersistentAutoRunActiveWatchdog();
    return;
  }

  if (context.deadlineAt > Date.now() + 250) {
    if (chrome.alarms?.create) {
      await chrome.alarms.create(getAutoRunActiveWatchdogAlarmName(), { when: context.deadlineAt });
    }
    return;
  }

  const { error, lastLogEntry } = buildPausedAutoRunWatchdogError(state, context);

  await clearPersistentAutoRunActiveWatchdog();
  if (autoRunWatchdogReject) {
    autoRunWatchdogTriggered = true;
    clearAutoRunWatchdogTimer();
    autoRunWatchdogReject(error);
    autoRunWatchdogReject = null;
    return;
  }

  await finalizePersistentAutoRunWatchdogTimeout(error, state, context, lastLogEntry);
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`内容脚本已就绪：${message.source}（标签页 ${tabId}）`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      const currentState = await getState();
      const currentStepStatus = currentState?.stepStatuses?.[message.step];
      if (currentStepStatus === 'completed') {
        notifyStepComplete(message.step, message.payload);
        return { ok: true };
      }
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      try {
        if (message.step === 5) {
          await validateStep5CompletionBeforeAcceptingSuccess(message.payload);
        }
      } catch (err) {
        const latestState = await getState();
        const displayedError = decorateAuthFailureWithEmailDomain(err.message, latestState?.email);
        await setStepStatus(message.step, 'failed');
        await addLog(`第 ${message.step} 步失败：${displayedError}`, 'error');
        await updateCurrentAccountRecordFromError(displayedError);
        await recordTmailorOutcome('failure', { step: message.step, errorMessage: displayedError });
        notifyStepError(message.step, displayedError);
        return { ok: false, error: displayedError };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`第 ${message.step} 步已完成`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`第 ${message.step} 步已由用户停止`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        const currentState = await getState();
        const displayedError = decorateAuthFailureWithEmailDomain(message.error, currentState?.email);
        await setStepStatus(message.step, 'failed');
        await addLog(`第 ${message.step} 步失败：${displayedError}`, 'error');
        await updateCurrentAccountRecordFromError(displayedError);
        await recordTmailorOutcome('failure', { step: message.step, errorMessage: displayedError });
        notifyStepError(message.step, displayedError);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      const state = await getState();
      const logHistoryState = getNormalizedLogHistory(state);
      if (
        !Array.isArray(state.logRounds)
        || state.currentLogRoundId !== logHistoryState.currentLogRoundId
      ) {
        await setState(logHistoryState);
      }
      return {
        ...state,
        ...logHistoryState,
      };
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await addLog('流程已重置', 'info');
      return { ok: true };
    }

    case 'CLEAR_LOG_HISTORY': {
      const nextState = await clearLogHistory();
      return {
        ok: true,
        ...nextState,
      };
    }

    case 'CLEAR_ACCOUNT_RECORDS': {
      await setPersistentAccountRecords([]);
      await setState({ currentAccountRecordId: null });
      broadcastDataUpdate({ accountRecords: [] });
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        const state = await getState();
        if (isTmailorSource(state)) {
          await markTmailorOutcomePending(message.payload.email);
        } else {
          await setEmailState(message.payload.email);
        }
      }
      runManualFlow(step).catch(async (err) => {
        if (isStopError(err) || isAutoRunHandoffError(err)) {
          return;
        }
        await addLog(`手动续跑失败：${err.message}`, 'error');
      });
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      const totalRuns = message.payload?.totalRuns || 1;
      const infiniteMode = sanitizeInfiniteAutoRun(message.payload?.infiniteMode);
      startAutoRunLoop(totalRuns, infiniteMode);
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        const state = await getState();
        if (isTmailorSource(state)) {
          await markTmailorOutcomePending(message.payload.email);
        } else {
          await setEmailState(message.payload.email);
        }
      }
      const resumed = await resumeAutoRun();
      return { ok: true, resumed };
    }

    case 'SAVE_SETTING': {
      const sessionUpdates = {};
      const persistentUpdates = {};
      let nextTmailorDomainMode = undefined;

      if (message.payload.vpsUrl !== undefined) persistentUpdates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.vpsCpaPassword !== undefined) persistentUpdates.vpsCpaPassword = message.payload.vpsCpaPassword;
      if (message.payload.customPassword !== undefined) sessionUpdates.customPassword = message.payload.customPassword;
      if (message.payload.mailProvider !== undefined) persistentUpdates.mailProvider = message.payload.mailProvider;
      if (message.payload.emailSource !== undefined) persistentUpdates.emailSource = sanitizePersistedEmailSource(message.payload.emailSource);
      if (message.payload.mailDomainSettings !== undefined) persistentUpdates.mailDomainSettings = message.payload.mailDomainSettings;
      if (message.payload.inbucketHost !== undefined) persistentUpdates.inbucketHost = message.payload.inbucketHost;
      if (message.payload.inbucketMailbox !== undefined) persistentUpdates.inbucketMailbox = message.payload.inbucketMailbox;
      if (message.payload.autoRunCount !== undefined) persistentUpdates.autoRunCount = sanitizeAutoRunCount(message.payload.autoRunCount);
      if (message.payload.autoRunInfinite !== undefined) persistentUpdates.autoRunInfinite = sanitizeInfiniteAutoRun(message.payload.autoRunInfinite);
      if (message.payload.autoRotateMailProvider !== undefined) persistentUpdates.autoRotateMailProvider = sanitizeAutoRotateMailProvider(message.payload.autoRotateMailProvider);
      if (message.payload.accountSuccessOnly !== undefined) persistentUpdates.accountSuccessOnly = sanitizeAccountSuccessOnly(message.payload.accountSuccessOnly);
      if (message.payload.tmailorDomainMode !== undefined) nextTmailorDomainMode = message.payload.tmailorDomainMode;

      if (Object.keys(sessionUpdates).length > 0) {
        await setState(sessionUpdates);
      }
      if (Object.keys(persistentUpdates).length > 0) {
        const nextSettings = await setPersistentSettings(persistentUpdates);
        if (persistentUpdates.mailProvider !== undefined) {
          broadcastDataUpdate({ mailProvider: nextSettings.mailProvider });
        }
        if (persistentUpdates.accountSuccessOnly !== undefined) {
          const state = await getState();
          const nextAccountRecords = await setPersistentAccountRecords(state.accountRecords, {
            successOnly: nextSettings.accountSuccessOnly,
          });
          const nextCurrentAccountRecordId = nextAccountRecords.some((record) => record.id === state.currentAccountRecordId)
            ? state.currentAccountRecordId
            : null;
          await setState({ currentAccountRecordId: nextCurrentAccountRecordId });
          broadcastDataUpdate({
            accountSuccessOnly: nextSettings.accountSuccessOnly,
            accountRecords: nextAccountRecords,
          });
        }
      }
      if (nextTmailorDomainMode !== undefined) {
        const state = await getState();
        await setTmailorDomainState({
          ...state.tmailorDomainState,
          mode: nextTmailorDomainMode,
        });
      }
      return { ok: true };
    }

    case 'SAVE_TMAILOR_DOMAIN_STATE': {
      const payload = message.payload || {};
      const state = await getState();
      const mergedState = await setTmailorDomainState({
        ...state.tmailorDomainState,
        ...payload,
      });
      return { ok: true, tmailorDomainState: mergedState };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      const state = await getState();
      if (isTmailorSource(state)) {
        await markTmailorOutcomePending(message.payload.email);
      } else {
        await setEmailState(message.payload.email);
      }
      return { ok: true, email: message.payload.email };
    }

    case 'FETCH_DUCK_EMAIL': {
      clearStopRequest();
      const email = await fetchDuckEmail(message.payload || {});
      return { ok: true, email };
    }

    case 'FETCH_EMAIL_ADDRESS': {
      clearStopRequest();
      const email = await fetchEmailAddress(message.payload || {});
      const state = await getState();
      return {
        ok: true,
        email,
        emailSource: sanitizeEmailSource(state.emailSource),
        mailProvider: state.mailProvider,
      };
    }

    case 'CHECK_TMAILOR_API_STATUS': {
      const state = await getState();
      const result = await checkTmailorApiConnectivity({
        accessToken: state.tmailorAccessToken,
      });
      const status = await setTmailorApiStatus(result);
      return { ok: true, tmailorApiStatus: status };
    }

    case 'FETCH_TMAILOR_API_CODE': {
      const state = await getState();
      if (!state.tmailorAccessToken) {
        return { error: 'No TMailor API mailbox is cached yet. Generate or validate a TMailor mailbox first.' };
      }
      if (!state.email) {
        return { error: 'Current mailbox is empty. Save or generate a TMailor email first.' };
      }

      const fetchConfig = buildManualTmailorCodeFetchConfig({
        currentStep: state.currentStep,
        targetEmail: state.email,
        rejectedCodes: getRejectedVerificationCodesForStep(state.currentStep, state),
        signupCode: state.lastSignupVerificationCode,
      });

      await addLog(
        `Manual TMailor API code fetch: checking ${state.email} via API (step ${fetchConfig.step})...`,
        'info'
      );

      try {
        const result = await pollTmailorVerificationCode({
          accessToken: state.tmailorAccessToken,
          ...fetchConfig,
          throwIfStopped,
          sleep: sleepWithStop,
          onPollStart: async (event) => {
            await addLog(
              `Manual TMailor API code fetch: polling ${event.attempt}/${event.maxAttempts}...`,
              'info'
            );
          },
          onPollAttempt: async (event) => {
            const candidateLabel = event.candidateFound
              ? `matched ${event.matchedCount} candidate mail(s)`
              : 'no matching mail yet';
            await addLog(
              `Manual TMailor API code fetch: poll ${event.attempt}/${event.maxAttempts} (${candidateLabel}).`,
              'info'
            );
          },
          onRetry: async (event) => {
            const waitLabel = event.waitMs > 0 ? `, retrying in ${formatWaitDuration(event.waitMs)}` : ', retrying now';
            await addLog(
              `Manual TMailor API code fetch: ${event.stage} retry ${event.retryAttempt}/${event.maxRequestRetries} failed: ${event.error.message}${waitLabel}.`,
              'warn'
            );
          },
        });

        await addLog(
          `Manual TMailor API code fetch: got code ${result.code} for ${state.email}.`,
          'ok'
        );
        return { ok: true, code: result.code, step: fetchConfig.step, email: state.email };
      } catch (err) {
        await addLog(`手动获取 TMailor 验证码失败：${err.message}`, 'warn');
        return { error: err.message };
      }
    }

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    case 'DEBUGGER_CLICK_AT': {
      const tabId = sender.tab?.id;
      if (!tabId) {
        return { error: 'Debugger click failed: no sender tab available.' };
      }
      await clickWithDebugger(tabId, message.payload?.rect, {
        approachX: message.payload?.approachX,
        approachY: message.payload?.approachY,
        holdMs: message.payload?.holdMs,
      });
      return { ok: true };
    }

    case 'TMAILOR_CLOSE_POPUP_AD_TAB': {
      const senderTabId = sender.tab?.id;
      const windowId = sender.tab?.windowId;
      if (!Number.isFinite(senderTabId) || !Number.isFinite(windowId)) {
        return { ok: true, popupClosed: false, closedTabIds: [], closedUrls: [] };
      }
      const result = await closeTmailorPopupAdTabs(senderTabId, windowId);
      return {
        ok: true,
        ...result,
      };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(payload.email);
      await setState({ existingAccountLogin: Boolean(payload.existingAccountLogin) });
      await createOrReuseCurrentAccountRecord({
        email: payload.email,
      });
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
    case 9:
      await updateCurrentAccountRecord({
        status: 'success',
        statusDetail: '',
      });
      await recordTmailorOutcome('success', { step });
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;
let manualRunActive = false;

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

async function setAutoRunStats(successfulRunsOrStats, failedRuns) {
  await ensureAutoRunStatsLoaded();
  const nextStats = typeof successfulRunsOrStats === 'object' && successfulRunsOrStats !== null
    ? normalizeAutoRunStats(successfulRunsOrStats)
    : normalizeAutoRunStats({
        successfulRuns: successfulRunsOrStats,
        failedRuns,
        totalSuccessfulDurationMs: autoRunStatsState.totalSuccessfulDurationMs,
        recentSuccessDurationsMs: autoRunStatsState.recentSuccessDurationsMs,
        recentSuccessEntries: autoRunStatsState.recentSuccessEntries,
        failureBuckets: autoRunStatsState.failureBuckets,
      });

  await setPersistentAutoRunStats(nextStats);
  broadcastDataUpdate({ autoRunStats: nextStats });
  return nextStats;
}

function sendAutoRunStatus(phase, overrides = {}) {
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: buildAutoRunStatusPayload({
      phase,
      currentRun: autoRunCurrentRun,
      totalRuns: autoRunTotalRuns,
      infiniteMode: autoRunInfinite,
      successfulRuns: autoRunSuccessfulRuns,
      failedRuns: autoRunFailedRuns,
      totalSuccessfulDurationMs: autoRunStatsState.totalSuccessfulDurationMs,
      recentSuccessDurationsMs: autoRunStatsState.recentSuccessDurationsMs,
      recentSuccessEntries: autoRunStatsState.recentSuccessEntries,
      failureBuckets: autoRunStatsState.failureBuckets,
      ...overrides,
    }),
  }).catch(() => {});
}

async function handOffPausedAutoRunToManual(step) {
  if (!autoRunActive || !resumeWaiter) {
    return false;
  }

  manualHandoffRunContext = {
    currentRun: autoRunCurrentRun,
    totalRuns: autoRunTotalRuns,
    infiniteMode: autoRunInfinite,
    runLabel: formatAutoRunLabel({
      currentRun: autoRunCurrentRun,
      totalRuns: autoRunTotalRuns,
      infiniteMode: autoRunInfinite,
    }),
    startedAt: autoRunCurrentRunStartedAt,
    successMode: autoRunCurrentSuccessMode,
  };

  const waiter = resumeWaiter;
  resumeWaiter = null;
  autoRunActive = false;
  resetAutoRunWatchdog({ preserveLastLog: true });
  await clearPersistentAutoRunPauseWatchdog();

  await setState({ autoRunning: false });
  await addLog(`Auto run handed off to manual continuation from step ${step}`, 'info');
  waiter.reject(new Error(AUTO_RUN_HANDOFF_MESSAGE));
  sendAutoRunStatus('stopped');

  return true;
}

async function runManualFlow(startStep) {
  if (manualRunActive) {
    await addLog('手动续跑已在进行中，请勿重复启动。', 'warn');
    return;
  }

  if (autoRunActive && !resumeWaiter) {
    await addLog('自动运行仍在进行中，暂时不能启动手动续跑。', 'warn');
    return;
  }

  manualRunActive = true;
  let handedOffPausedAutoRun = false;
  let inheritedRunContext = null;

  try {
    handedOffPausedAutoRun = await handOffPausedAutoRunToManual(startStep);
    inheritedRunContext = manualHandoffRunContext;
    await addLog(`Manual continuation: step ${startStep} -> 9`, 'info');
    await runStepSequence({
      startStep,
      executeStepAndWait,
    });
    await addLog('手动续跑已完成（第 9 步）。', 'ok');
    if (handedOffPausedAutoRun && inheritedRunContext) {
      await ensureAutoRunStatsLoaded();
      await setAutoRunStats(recordAutoRunSuccess(autoRunStatsState, {
        durationMs: Math.max(0, Date.now() - (inheritedRunContext.startedAt || Date.now())),
        mode: autoRunCurrentSuccessMode || inheritedRunContext.successMode,
      }));
      sendAutoRunStatus('stopped', {
        currentRun: inheritedRunContext.currentRun,
        totalRuns: inheritedRunContext.totalRuns,
        infiniteMode: inheritedRunContext.infiniteMode,
      });
    }
  } catch (err) {
    if (handedOffPausedAutoRun && inheritedRunContext && !isStopError(err) && !isAutoRunHandoffError(err)) {
      await recordVisibleAutoRunFailure(err.message, inheritedRunContext);
      sendAutoRunStatus('stopped', {
        currentRun: inheritedRunContext.currentRun,
        totalRuns: inheritedRunContext.totalRuns,
        infiniteMode: inheritedRunContext.infiniteMode,
      });
    }
    throw err;
  } finally {
    manualRunActive = false;
    manualHandoffRunContext = null;

    const state = await getState();
    if (shouldStartNextInfiniteRunAfterManualFlow({
      autoRunInfinite: state.autoRunInfinite,
      stopRequested,
    })) {
      if (handedOffPausedAutoRun) {
        await waitForAutoRunTaskToSettle();
      }

      await addLog('Infinite mode is enabled. Starting the next run automatically...', 'info');
      startAutoRunLoop(
        sanitizeAutoRunCount(state.autoRunCount),
        true,
        handedOffPausedAutoRun && inheritedRunContext
          ? {
              preserveStats: true,
              startingRun: inheritedRunContext.currentRun + 1,
            }
          : {}
      );
    }
  }
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function abortCurrentAutoRunRound(options = {}) {
  const {
    logMessage = '',
    sendStoppedStatus = false,
  } = options;

  stopRequested = true;
  resetAutoRunWatchdog({ preserveLastLog: true });
  await clearPersistentAutoRunPauseWatchdog();
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  if (logMessage) {
    await addLog(logMessage, 'warn');
  }
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }

  await markRunningStepsStopped();
  autoRunActive = false;
  await setState({ autoRunning: false });
  if (sendStoppedStatus) {
    sendAutoRunStatus('stopped');
  }
}

async function requestStop() {
  if (stopRequested) return;

  await abortCurrentAutoRunRound({
    logMessage: 'Stop requested. Cancelling current operations...',
    sendStoppedStatus: true,
  });
}

async function closeTmailorPopupAdTabs(senderTabId, windowId) {
  if (!Number.isFinite(senderTabId) || !Number.isFinite(windowId)) {
    return { popupClosed: false, closedTabIds: [], closedUrls: [] };
  }

  const tabs = await chrome.tabs.query({ windowId });
  const popupTabs = tabs.filter((tab) => {
    if (!Number.isFinite(tab?.id) || tab.id === senderTabId) {
      return false;
    }
    if (tab.openerTabId !== senderTabId) {
      return false;
    }
    return !/^https:\/\/tmailor\.com(?:\/|$)/i.test(String(tab.url || ''));
  });

  if (popupTabs.length === 0) {
    return { popupClosed: false, closedTabIds: [], closedUrls: [] };
  }

  const closedTabIds = popupTabs.map((tab) => tab.id);
  const closedUrls = popupTabs.map((tab) => String(tab.url || '')).filter(Boolean);
  await chrome.tabs.remove(closedTabIds);
  try {
    await chrome.tabs.update(senderTabId, { active: true });
  } catch {}
  return {
    popupClosed: true,
    closedTabIds,
    closedUrls,
  };
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`第 ${step} 步开始执行`);
  await humanStepDelay();

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    const latestState = await getState();
    const currentStepStatus = latestState?.stepStatuses?.[step];
    const displayedError = decorateAuthFailureWithEmailDomain(err.message, latestState?.email);
    if (isStopError(err)) {
      if (!shouldSkipStepResultLog(currentStepStatus)) {
        await setStepStatus(step, 'stopped');
        await addLog(`第 ${step} 步已由用户停止`, 'warn');
      }
      throw err;
    }
    if (!shouldSkipStepResultLog(currentStepStatus)) {
      await setStepStatus(step, 'failed');
      await addLog(`第 ${step} 步失败：${displayedError}`, 'error');
    }
    throw new Error(displayedError);
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000, recoveryState = false) {
  throwIfStopped();
  const recoveredStep1VpsPanel = Boolean(recoveryState && recoveryState !== true && recoveryState.step1VpsPanel);
  const recoveredStep2PlatformLoginRetryCount = Math.max(0, Number.parseInt(String(recoveryState?.step2PlatformLoginRetryCount ?? 0), 10) || 0);
  const recoveredStep4CredentialStall = Boolean(recoveryState && recoveryState !== true && recoveryState.step4CredentialStall);
  const recoveredStep3PlatformLoginRefreshCount = Math.max(0, Number.parseInt(String(recoveryState?.step3PlatformLoginRefreshCount ?? 0), 10) || 0);
  const recoveredStep3TimeoutRetryCount = Math.max(0, Number.parseInt(String(recoveryState?.step3TimeoutRetryCount ?? 0), 10) || 0);
  const recoveredStep5ProfileRetryCount = Math.max(0, Number.parseInt(String(recoveryState?.step5ProfileRetryCount ?? 0), 10) || 0);
  const recoveredStep6OauthRetryCount = Math.max(0, Number.parseInt(String(recoveryState?.step6OauthRetryCount ?? 0), 10) || 0);
  const recoveredStep7Through9FromStep6 = Boolean(recoveryState && recoveryState !== true && recoveryState.step7Through9FromStep6);
  const recoveredStep8UnexpectedRedirect = Boolean(recoveryState && recoveryState !== true && recoveryState.step8UnexpectedRedirect);
  const completionPromise = waitForStepComplete(step, 120000);
  const executionPromise = (async () => {
    await executeStep(step);
    await completionPromise;
  })();
  executionPromise.catch(() => {});
  try {
    const watchdogPromise = autoRunActive ? getAutoRunWatchdogPromise() : null;
    if (watchdogPromise) {
      await Promise.race([executionPromise, watchdogPromise]);
    } else {
      await executionPromise;
    }
  } catch (err) {
    if (step === 1 && !recoveredStep1VpsPanel && shouldRetryStep1WithFreshVpsPanel(err)) {
      await recoverStep1VpsPanel(err);
      return await executeStepAndWait(step, delayAfter, { step1VpsPanel: true });
    }
    if (step === 2 && recoveredStep2PlatformLoginRetryCount < 10 && !isStopError(err)) {
      await recoverStep2PlatformLogin(err, {
        attempt: recoveredStep2PlatformLoginRetryCount + 1,
        maxAttempts: 10,
      });
      return await executeStepAndWait(step, delayAfter, {
        step2PlatformLoginRetryCount: recoveredStep2PlatformLoginRetryCount + 1,
      });
    }
    if (step === 4 && !recoveredStep4CredentialStall && shouldRetryStep4WithCurrentTmailorLease(err)) {
      await replayStep2AndStep3WithCurrentTmailorLease(err);
      return await executeStepAndWait(step, delayAfter, { step4CredentialStall: true });
    }
    if (step === 3 && recoveredStep3PlatformLoginRefreshCount < 3 && shouldRetryStep3WithPlatformLoginRefresh(err)) {
      await recoverStep3PlatformLogin(err, {
        attempt: recoveredStep3PlatformLoginRefreshCount + 1,
        maxAttempts: 3,
        reason: 'platform-login-refresh',
      });
      return await executeStepAndWait(step, delayAfter, {
        step3PlatformLoginRefreshCount: recoveredStep3PlatformLoginRefreshCount + 1,
      });
    }
    if (step === 3 && shouldRetryStep3WithFreshOauth(err)) {
      await recoverStep3PlatformLogin(err, {
        attempt: recoveredStep3TimeoutRetryCount + 1,
        reason: 'oauth-timeout',
      });
      return await executeStepAndWait(step, delayAfter, {
        step3TimeoutRetryCount: recoveredStep3TimeoutRetryCount + 1,
      });
    }
    if (step === 5 && recoveredStep5ProfileRetryCount < STEP5_MAX_PROFILE_RETRY_ATTEMPTS && shouldRetryStep5WithProfileRefresh(err)) {
      await recoverStep5ProfilePage(err, {
        attempt: recoveredStep5ProfileRetryCount + 1,
        maxAttempts: STEP5_MAX_PROFILE_RETRY_ATTEMPTS,
      });
      return await executeStepAndWait(step, delayAfter, {
        step5ProfileRetryCount: recoveredStep5ProfileRetryCount + 1,
      });
    }
    if (step === 6 && recoveredStep6OauthRetryCount < STEP6_MAX_OAUTH_RETRY_ATTEMPTS && shouldRetryStep6WithFreshOauth(err)) {
      await recoverStep6PlatformLogin(err, {
        attempt: recoveredStep6OauthRetryCount + 1,
        maxAttempts: STEP6_MAX_OAUTH_RETRY_ATTEMPTS,
        reason: 'fresh-oauth',
      });
      return await executeStepAndWait(step, delayAfter, {
        step6OauthRetryCount: recoveredStep6OauthRetryCount + 1,
      });
    }
    if (step === 8 && !recoveredStep8UnexpectedRedirect && shouldRetryStep8WithFreshOauth(err)) {
      await replaySteps6Through8WithCurrentAccount(
        'Step 8: Auth flow did not reach localhost and instead landed on another page. Refreshing the VPS OAuth link and replaying steps 6-8 with the same account...'
      );
      return;
    }
    if ([7, 8, 9].includes(step) && !recoveredStep7Through9FromStep6 && shouldRetryStep7Through9FromStep6(step, err)) {
      await replaySteps6ThroughTargetStepWithCurrentAccount(
        step,
        `Step ${step}: ${err?.message || String(err || `unknown step ${step} error`)} Replaying steps 6-${step} once with the current account because registration already succeeded...`,
        {
          step7Through9FromStep6: true,
        }
      );
      return;
    }
    throw err;
  }
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 1200));
  }
}

async function recoverStep1VpsPanel(error) {
  const state = await getState();
  const message = error?.message || String(error || 'unknown step 1 error');
  await addLog(
    `第 1 步：${message} 正在重开 VPS 面板并重试一次。`,
    'warn'
  );

  await reuseOrCreateTab('vps-panel', state.vpsUrl, {
    inject: ['shared/flow-recovery.js', 'content/utils.js', 'content/vps-panel.js'],
    reloadIfSameUrl: true,
  });
}

async function recoverStep2PlatformLogin(error, options = {}) {
  const message = error?.message || String(error || 'unknown step 2 error');
  const attempt = Math.max(1, Number.parseInt(String(options?.attempt ?? 1), 10) || 1);
  const maxAttempts = Math.max(attempt, Number.parseInt(String(options?.maxAttempts ?? attempt), 10) || attempt);
  await addLog(
    `第 2 步：${message} 正在重开 Platform 登录页并重试（${attempt}/${maxAttempts}）。`,
    'warn'
  );
  await reuseOrCreateTab('signup-page', OFFICIAL_SIGNUP_ENTRY_URL, {
    reuseActiveTabOnCreate: true,
    reloadIfSameUrl: true,
  });
}

function shouldRetryStep4WithCurrentTmailorLease(error) {
  const message = typeof error === 'string' ? error : error?.message || '';
  return /step 4 blocked: signup page never advanced past the credential form/i.test(message);
}

async function replayStep2AndStep3WithCurrentTmailorLease(error) {
  const state = await getState();
  const lease = getActiveTmailorEmailLease(state);
  if (!lease) {
    throw error;
  }

  const nextRecoveryAttempts = {
    ...lease.recoveryAttempts,
    step4: (Number.parseInt(String(lease.recoveryAttempts?.step4 ?? 0), 10) || 0) + 1,
  };
  await setTmailorEmailLease({ recoveryAttempts: nextRecoveryAttempts });
  await addLog(
    `第 4 步：${error?.message || String(error || 'unknown error')} 正在重开 Platform 登录页，并用当前租约邮箱 ${lease.email} 重放第 2-3 步一次。`,
    'warn'
  );

  await setEmailState(lease.email);
  if (lease.password) {
    await setPasswordState(lease.password);
  }

  await reuseOrCreateTab('signup-page', OFFICIAL_SIGNUP_ENTRY_URL, {
    reuseActiveTabOnCreate: true,
    reloadIfSameUrl: true,
  });
  await executeStepAndWait(2, 2000);

  const refreshedState = await getState();
  const refreshedLease = getActiveTmailorEmailLease(refreshedState) || lease;
  await setEmailState(refreshedLease.email);
  if (refreshedLease.password) {
    await setPasswordState(refreshedLease.password);
  }
  await executeStepAndWait(3, getStepDelayAfter(3));
}

async function fetchDuckEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await addLog(`Duck Mail: Opening autofill settings (${generateNew ? 'generate new' : 'reuse current'})...`);
  await reuseOrCreateTab('duck-mail', DUCK_AUTOFILL_URL);

  const result = await sendToContentScript('duck-mail', {
    type: 'FETCH_DUCK_EMAIL',
    source: 'background',
    payload: { generateNew },
  });

  if (result?.error) {
    throw new Error(addDuckMailRetryHint(result.error));
  }
  if (!result?.email) {
    throw new Error(addDuckMailRetryHint('Duck email not returned.'));
  }

  await setEmailState(result.email);
  await addLog(`Duck Mail 邮箱已${result.generated ? '生成' : '加载'}：${result.email}`, 'ok');
  return result.email;
}

function getCurrentEmailSource(state) {
  return sanitizeEmailSource(state?.emailSource ?? DEFAULT_PERSISTED_EMAIL_SOURCE ?? DEFAULT_EMAIL_SOURCE);
}

function getCurrentAutoRotateMailProvider(state) {
  return sanitizeAutoRotateMailProvider(state?.autoRotateMailProvider ?? DEFAULT_AUTO_ROTATE_MAIL_PROVIDER);
}

function getEmailSourceLabel(emailSource) {
  if (emailSource === '33mail') return '33mail';
  if (emailSource === 'tmailor') return 'TMailor';
  return 'Duck Mail';
}

function getEmailWaitHint(emailSource) {
  if (emailSource === '33mail') {
    return 'Configure the 33mail domain or generate an email manually, then continue';
  }
  if (emailSource === 'tmailor') {
    return 'Open TMailor and generate a supported mailbox, or switch to com+whitelist mode and continue';
  }
  return 'Fetch Duck email or paste manually, then continue';
}

function isTmailorSource(state) {
  return getCurrentEmailSource(state) === 'tmailor';
}

function isTmailorEmailAllowed(state, email) {
  return isAllowedTmailorDomain(state?.tmailorDomainState, extractEmailDomain(email));
}

function buildEmailLease(previousLease = null, updates = {}) {
  const previousRecoveryAttempts = previousLease?.recoveryAttempts && typeof previousLease.recoveryAttempts === 'object'
    ? previousLease.recoveryAttempts
    : {};

  return {
    source: 'tmailor',
    status: 'active',
    email: '',
    password: '',
    accessToken: '',
    invalidReason: '',
    createdAt: Number.isFinite(previousLease?.createdAt) ? previousLease.createdAt : Date.now(),
    recoveryAttempts: {
      step2: 0,
      step3: 0,
      step4: 0,
      ...previousRecoveryAttempts,
      ...(updates?.recoveryAttempts && typeof updates.recoveryAttempts === 'object' ? updates.recoveryAttempts : {}),
    },
    ...(previousLease && typeof previousLease === 'object' ? previousLease : {}),
    ...(updates && typeof updates === 'object' ? updates : {}),
  };
}

function getActiveTmailorEmailLease(state) {
  if (!isTmailorSource(state)) {
    return null;
  }

  const lease = state?.emailLease;
  if (!lease || typeof lease !== 'object') {
    return null;
  }
  if (lease.source !== 'tmailor' || lease.status !== 'active') {
    return null;
  }
  if (!String(lease.email || '').trim()) {
    return null;
  }

  return lease;
}

async function setTmailorEmailLease(updates = {}) {
  const state = await getState();
  const nextLease = buildEmailLease(state.emailLease, updates);
  await setState({ emailLease: nextLease });
  return nextLease;
}

function getTmailorOutcomeEmail(state) {
  const leaseEmail = getActiveTmailorEmailLease(state)?.email;
  if (leaseEmail) {
    return leaseEmail;
  }

  return state?.email || '';
}

async function markTmailorOutcomePending(email) {
  const nextTargetEmailAcquiredAt = String(email || '').trim() ? Date.now() : null;
  await setState({
    email,
    tmailorAccessToken: '',
    tmailorOutcomeRecorded: false,
    lastTargetEmailAcquiredAt: nextTargetEmailAcquiredAt,
  });
  await setTmailorEmailLease({
    email,
    accessToken: '',
    status: 'active',
    invalidReason: '',
  });
  broadcastDataUpdate({ email, lastTargetEmailAcquiredAt: nextTargetEmailAcquiredAt });
}

async function recordTmailorOutcome(result, context = {}) {
  const state = await getState();
  if (!isTmailorSource(state) || state.tmailorOutcomeRecorded) {
    return;
  }

  const outcomeEmail = getTmailorOutcomeEmail(state);
  const domain = extractEmailDomain(outcomeEmail);
  if (!domain) {
    return;
  }

  if (result === 'success') {
    const wasWhitelisted = state.tmailorDomainState.whitelist.includes(domain);
    const nextState = await setTmailorDomainState(recordTmailorDomainSuccess(state.tmailorDomainState, domain));
    await setState({ tmailorOutcomeRecorded: true });
    if (!wasWhitelisted && nextState.whitelist.includes(domain)) {
      await addLog(`TMailor 域名已加入白名单：${domain}`, 'ok');
    }
    return;
  }

  const errorMessage = context.errorMessage || '';
  const shouldBlacklist = shouldBlacklistTmailorDomainForError(state.tmailorDomainState, domain, errorMessage);
  const nextState = await setTmailorDomainState(recordTmailorDomainFailure(state.tmailorDomainState, domain, {
    blacklist: shouldBlacklist,
  }));
  await setState({ tmailorOutcomeRecorded: true });
  if (shouldBlacklist && nextState.blacklist.includes(domain)) {
    await addLog(`TMailor 域名已加入黑名单：${domain}`, 'warn');
  }
}

async function generate33MailEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;
  const state = await getState();
  const configuredProviders = getConfiguredRotatableMailProviders(state.mailDomainSettings);
  const preferredProvider = isRotatableMailProvider(state.mailProvider)
    ? state.mailProvider
    : '';
  const currentProvider = preferredProvider || configuredProviders[0] || '163';
  const currentDomain = get33MailDomainForProvider(state.mailDomainSettings, currentProvider);

  if (!generateNew && state.email) {
    return state.email;
  }

  if (currentProvider !== state.mailProvider) {
    await setMailProviderState(currentProvider);
  }

  const email = generate33MailAddress(currentDomain);
  const nextUsageState = recordMailProviderUsage(state.mailProviderUsage, currentProvider);
  await setState({ mailProviderUsage: nextUsageState });
  await setEmailState(email);
  await addLog(`33mail 已生成邮箱：${email}（通道 ${currentProvider}）`, 'ok');
  return email;
}

async function fetchTmailorEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;
  const state = await getState();
  const mailboxPageConfig = { source: 'tmailor-mail', url: 'https://tmailor.com/' };
  const now = Date.now();

  if (generateNew) {
    if (isTmailorApiCaptchaCooldownActive(state.tmailorApiCaptchaCooldownUntil, now)) {
      const waitMs = state.tmailorApiCaptchaCooldownUntil - now;
      await addLog(
        `TMailor API: Captcha cooldown is active for ${formatWaitDuration(waitMs)}. Skipping API mailbox creation and using the mailbox page flow instead.`,
        'warn'
      );
    } else {
      try {
        await addLog('TMailor: Requesting a new mailbox via API...', 'info');
        const result = await fetchAllowedTmailorEmail({
          domainState: state.tmailorDomainState,
          onAttempt: async (event) => {
            await addLog(
              `TMailor API: Refreshing mailbox attempt ${event.attempt}/${event.maxAttempts}...`,
              'info'
            );
          },
        });
        markAutoRunCurrentSuccessMode('api');
        await setTmailorMailboxState(result.email, result.accessToken);
        await setTmailorEmailLease({
          email: result.email,
          accessToken: result.accessToken,
          status: 'active',
          invalidReason: '',
        });
        await addLog(`TMailor API 邮箱已就绪：${result.email}（已保存令牌，后续可直接轮询收件箱）`, 'ok');
        return result.email;
      } catch (err) {
        if (isTmailorApiCaptchaError(err)) {
          const cooldownUntil = createTmailorApiCaptchaCooldownUntil({
            now,
            cooldownMs: TMAILOR_API_CAPTCHA_COOLDOWN_MS,
          });
          await setState({ tmailorApiCaptchaCooldownUntil: cooldownUntil });
          await addLog(`TMailor API 请求新邮箱失败：${err.message}`, 'warn');
          await addLog(
            `TMailor API: Pausing automatic mailbox API attempts for ${formatWaitDuration(TMAILOR_API_CAPTCHA_COOLDOWN_MS)} before retrying the API path.`,
            'warn'
          );
          await addLog('TMailor API 检测到验证码或封锁，准备打开邮箱页检查挑战，并先自动尝试处理。', 'warn');
        } else {
          await addLog(`TMailor API 请求新邮箱失败：${err.message}`, 'warn');
          await addLog('TMailor API 路径不可用，改走邮箱页面流程生成地址。', 'warn');
        }
      }
    }
  }

  throwIfStopped();
  await addLog(`TMailor: Opening mailbox page (${generateNew ? 'generate new' : 'reuse current'})...`);
  await reuseOrCreateTab(mailboxPageConfig.source, mailboxPageConfig.url);
  await addLog('TMailor: Mailbox page opened. Waiting for the content script handshake before starting mailbox automation...', 'info');

  const command = {
    type: 'FETCH_TMAILOR_EMAIL',
    source: 'background',
    payload: {
      generateNew,
      domainState: state.tmailorDomainState,
    },
  };
  let result = await sendToContentScript(mailboxPageConfig.source, command);

  if (result?.recovery === 'reload_mailbox') {
    await addLog('TMailor 邮箱页请求后台重载，准备重开后重试一次。', 'warn');
    await reviveMailTab(mailboxPageConfig);
    await sleepWithStop(1200);
    result = await sendToContentScript(mailboxPageConfig.source, command);
  }

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('TMailor email was not returned.');
  }

  await markTmailorOutcomePending(result.email);
  await addLog(`TMailor 邮箱已就绪：${result.email}`, 'ok');
  return result.email;
}

async function fetchEmailAddress(options = {}) {
  const state = await getState();
  const emailSource = getCurrentEmailSource(state);
  if (emailSource === '33mail') {
    return await generate33MailEmail(options);
  }
  if (emailSource === 'tmailor') {
    return await fetchTmailorEmail(options);
  }
  return await fetchDuckEmail(options);
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;
let autoRunInfinite = false;
let autoRunSuccessfulRuns = 0;
let autoRunFailedRuns = 0;
let autoRunStatsState = normalizeAutoRunStats(DEFAULT_STATE.autoRunStats);
let autoRunLastRotatedMailProvider = null;
let autoRunTask = null;
let manualHandoffRunContext = null;
let autoRunCurrentRunStartedAt = 0;
let autoRunCurrentSuccessMode = 'simulated';
let autoRunWatchdogTimer = null;
let autoRunWatchdogPromise = null;
let autoRunWatchdogReject = null;
let autoRunWatchdogGeneration = 0;
let autoRunWatchdogSuspended = false;
let autoRunWatchdogTriggered = false;
let autoRunWatchdogLastActivityAt = 0;
let autoRunWatchdogLastLogEntry = null;

function resetAutoRunCurrentSuccessMode() {
  autoRunCurrentSuccessMode = 'simulated';
}

function markAutoRunCurrentSuccessMode(mode) {
  if (String(mode || '').trim().toLowerCase() === 'api') {
    autoRunCurrentSuccessMode = 'api';
  }
}

function getNormalizedAutoRunPauseWatchdogContext(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const normalizedPhase = String(value.phase || '').trim().toLowerCase();
  if (!normalizedPhase) {
    return null;
  }

  const normalizedCurrentRun = Number.parseInt(String(value.currentRun ?? '').trim(), 10);
  const normalizedTotalRuns = value.totalRuns === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Number.parseInt(String(value.totalRuns ?? '').trim(), 10);
  const normalizedTimeoutMs = Number.parseInt(String(value.timeoutMs ?? '').trim(), 10);
  const normalizedDeadlineAt = Number.parseInt(String(value.deadlineAt ?? '').trim(), 10);
  const normalizedLastLogTimestamp = Number.parseInt(String(value.lastLogTimestamp ?? '').trim(), 10);

  return {
    phase: normalizedPhase,
    currentRun: Number.isFinite(normalizedCurrentRun) && normalizedCurrentRun > 0 ? normalizedCurrentRun : 0,
    totalRuns: normalizedTotalRuns === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : (Number.isFinite(normalizedTotalRuns) && normalizedTotalRuns > 0 ? normalizedTotalRuns : 0),
    infiniteMode: Boolean(value.infiniteMode),
    timeoutMs: Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0
      ? normalizedTimeoutMs
      : AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
    deadlineAt: Number.isFinite(normalizedDeadlineAt) && normalizedDeadlineAt > 0
      ? normalizedDeadlineAt
      : 0,
    lastLogMessage: typeof value.lastLogMessage === 'string' ? value.lastLogMessage : '',
    lastLogLevel: typeof value.lastLogLevel === 'string' ? value.lastLogLevel : '',
    lastLogTimestamp: Number.isFinite(normalizedLastLogTimestamp) && normalizedLastLogTimestamp > 0
      ? normalizedLastLogTimestamp
      : 0,
  };
}

function normalizeAutoRunWatchdogLogEntry(entry = null) {
  const message = String(entry?.message || '').trim();
  if (!message) {
    return null;
  }

  return {
    message,
    level: String(entry?.level || '').trim().toLowerCase() || 'info',
    timestamp: Number.isFinite(entry?.timestamp) ? entry.timestamp : Date.now(),
  };
}

async function clearPersistentAutoRunPauseWatchdog() {
  if (chrome.alarms?.clear) {
    await chrome.alarms.clear(getAutoRunPauseWatchdogAlarmName()).catch(() => {});
  }
  await setState({ autoRunPauseWatchdog: null });
}

async function clearPersistentAutoRunActiveWatchdog() {
  if (chrome.alarms?.clear) {
    await chrome.alarms.clear(getAutoRunActiveWatchdogAlarmName()).catch(() => {});
  }
  await setState({ autoRunActiveWatchdog: null });
}

async function armPersistentAutoRunPauseWatchdog(context = {}) {
  const timeoutMs = Number.isFinite(context.timeoutMs) && context.timeoutMs > 0
    ? context.timeoutMs
    : AUTO_RUN_LOG_SILENCE_TIMEOUT_MS;
  const deadlineAt = getAutoRunPauseWatchdogDeadline({
    timeoutMs,
    now: Date.now(),
  });
  const lastLogEntry = getAutoRunWatchdogLastLogEntry(
    context,
    normalizeAutoRunWatchdogLogEntry(context.lastLogEntry) || autoRunWatchdogLastLogEntry || null
  );
  const nextContext = {
    phase: String(context.phase || '').trim().toLowerCase(),
    currentRun: Number.parseInt(String(context.currentRun ?? '').trim(), 10) || 0,
    totalRuns: context.infiniteMode
      ? 0
      : (Number.parseInt(String(context.totalRuns ?? '').trim(), 10) || 0),
    infiniteMode: Boolean(context.infiniteMode),
    timeoutMs,
    deadlineAt,
  };
  if (lastLogEntry) {
    nextContext.lastLogMessage = lastLogEntry.message;
    nextContext.lastLogLevel = lastLogEntry.level;
    nextContext.lastLogTimestamp = lastLogEntry.timestamp;
  }

  await setState({ autoRunPauseWatchdog: nextContext });
  if (chrome.alarms?.create) {
    await chrome.alarms.create(getAutoRunPauseWatchdogAlarmName(), { when: deadlineAt });
  }
  return nextContext;
}

async function armPersistentAutoRunActiveWatchdog(context = {}) {
  const timeoutMs = Number.isFinite(context.timeoutMs) && context.timeoutMs > 0
    ? context.timeoutMs
    : AUTO_RUN_LOG_SILENCE_TIMEOUT_MS;
  const deadlineAt = getAutoRunPauseWatchdogDeadline({
    timeoutMs,
    now: Date.now(),
  });
  const lastLogEntry = getAutoRunWatchdogLastLogEntry(
    context,
    normalizeAutoRunWatchdogLogEntry(context.lastLogEntry) || autoRunWatchdogLastLogEntry || null
  );
  const nextContext = {
    phase: 'running',
    currentRun: Number.parseInt(String(context.currentRun ?? '').trim(), 10) || 0,
    totalRuns: context.infiniteMode
      ? 0
      : (Number.parseInt(String(context.totalRuns ?? '').trim(), 10) || 0),
    infiniteMode: Boolean(context.infiniteMode),
    timeoutMs,
    deadlineAt,
  };
  if (lastLogEntry) {
    nextContext.lastLogMessage = lastLogEntry.message;
    nextContext.lastLogLevel = lastLogEntry.level;
    nextContext.lastLogTimestamp = lastLogEntry.timestamp;
  }

  await setState({ autoRunActiveWatchdog: nextContext });
  if (chrome.alarms?.create) {
    await chrome.alarms.create(getAutoRunActiveWatchdogAlarmName(), { when: deadlineAt });
  }
  return nextContext;
}

function getLastVisibleAutoRunLogEntry(state = {}) {
  const normalized = getNormalizedLogHistory(state);
  const rounds = Array.isArray(normalized.logRounds) ? normalized.logRounds : [];
  const round = rounds.find((candidate) => candidate.id === normalized.currentLogRoundId) || rounds[rounds.length - 1];
  if (!round || !Array.isArray(round.logs) || !round.logs.length) {
    return null;
  }
  return round.logs[round.logs.length - 1] || null;
}

function buildPausedAutoRunWatchdogError(state = {}, context = {}) {
  const lastLogEntry = getAutoRunWatchdogLastLogEntry(
    context,
    getLastVisibleAutoRunLogEntry(state) || autoRunWatchdogLastLogEntry || null
  );
  return {
    lastLogEntry,
    error: new Error(buildAutoRunLogSilenceErrorMessage({
      timeoutMs: context.timeoutMs || AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
      lastLogMessage: lastLogEntry?.message || '',
      lastLogLevel: lastLogEntry?.level || '',
      lastLogTimestamp: lastLogEntry?.timestamp || 0,
      now: Date.now(),
    })),
  };
}

async function finalizePersistentAutoRunWatchdogTimeout(error, state = {}, context = {}, lastLogEntry = null) {
  await clearPersistentAutoRunActiveWatchdog();
  await clearPersistentAutoRunPauseWatchdog();
  resetAutoRunWatchdog({ preserveLastLog: true });
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  const currentRun = context.currentRun || autoRunCurrentRun || 0;
  const totalRuns = context.totalRuns === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : (context.totalRuns || autoRunTotalRuns || sanitizeAutoRunCount(state.autoRunCount));
  const infiniteMode = Boolean(context.infiniteMode);

  autoRunActive = false;
  autoRunCurrentRun = currentRun;
  autoRunTotalRuns = totalRuns;
  autoRunInfinite = infiniteMode;

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();
  resumeWaiter = null;

  await setState({ autoRunning: false, currentRunStep: 0 });
  const failureRecord = await recordVisibleAutoRunFailure(error.message, {
    currentRun,
    totalRuns,
    infiniteMode,
    lastLogEntry,
  });
  await addLog(failureRecord.logMessage, 'error');

  const shouldContinueAfterWatchdog = shouldContinueAutoRunAfterWatchdog({
    currentRun,
    totalRuns,
    infiniteMode,
  });

  if (shouldContinueAfterWatchdog) {
    clearStopRequest();
    await addLog(`=== 第 ${failureRecord.runLabel} 轮看门狗超时，准备自动开始下一轮... ===`, 'warn');
    sendAutoRunStatus('running', { currentRun });
    startAutoRunLoop(
      sanitizeAutoRunCount(state.autoRunCount),
      infiniteMode,
      {
        preserveStats: true,
        startingRun: currentRun + 1,
      }
    );
    return;
  }

  sendAutoRunStatus('stopped', {
    currentRun,
    totalRuns,
    infiniteMode,
    summaryMessage: failureRecord.logMessage,
  });
}

function clearAutoRunWatchdogTimer() {
  if (autoRunWatchdogTimer) {
    clearTimeout(autoRunWatchdogTimer);
    autoRunWatchdogTimer = null;
  }
}

function resetAutoRunWatchdog({ preserveLastLog = false } = {}) {
  clearAutoRunWatchdogTimer();
  void clearPersistentAutoRunActiveWatchdog().catch(() => {});
  autoRunWatchdogGeneration += 1;
  autoRunWatchdogPromise = null;
  autoRunWatchdogReject = null;
  autoRunWatchdogSuspended = false;
  autoRunWatchdogTriggered = false;
  autoRunWatchdogLastActivityAt = 0;
  if (!preserveLastLog) {
    autoRunWatchdogLastLogEntry = null;
  }
}

function ensureAutoRunWatchdogPromise() {
  if (autoRunWatchdogPromise) {
    return autoRunWatchdogPromise;
  }

  autoRunWatchdogPromise = new Promise((_, reject) => {
    autoRunWatchdogReject = reject;
  });
  autoRunWatchdogPromise.catch(() => {});
  return autoRunWatchdogPromise;
}

function scheduleAutoRunWatchdog() {
  clearAutoRunWatchdogTimer();
  if (!autoRunWatchdogPromise || autoRunWatchdogSuspended || autoRunWatchdogTriggered) {
    return;
  }

  const generation = autoRunWatchdogGeneration;
  autoRunWatchdogTimer = setTimeout(() => {
    if (generation !== autoRunWatchdogGeneration || autoRunWatchdogSuspended || autoRunWatchdogTriggered) {
      return;
    }

    const idleMs = Math.max(0, Date.now() - autoRunWatchdogLastActivityAt);
    if (idleMs < AUTO_RUN_LOG_SILENCE_TIMEOUT_MS) {
      scheduleAutoRunWatchdog();
      return;
    }

    autoRunWatchdogTriggered = true;
    clearAutoRunWatchdogTimer();
    const error = new Error(buildAutoRunLogSilenceErrorMessage({
      timeoutMs: AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
      lastLogMessage: autoRunWatchdogLastLogEntry?.message || '',
      lastLogLevel: autoRunWatchdogLastLogEntry?.level || '',
      lastLogTimestamp: autoRunWatchdogLastLogEntry?.timestamp || 0,
      now: Date.now(),
    }));
    if (autoRunWatchdogReject) {
      autoRunWatchdogReject(error);
      autoRunWatchdogReject = null;
    }
  }, AUTO_RUN_LOG_SILENCE_TIMEOUT_MS);
}

function startAutoRunWatchdog() {
  resetAutoRunWatchdog();
  ensureAutoRunWatchdogPromise();
  autoRunWatchdogLastActivityAt = Date.now();
  void armPersistentAutoRunActiveWatchdog({
    currentRun: autoRunCurrentRun,
    totalRuns: autoRunTotalRuns,
    infiniteMode: autoRunInfinite,
    timeoutMs: AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
  }).catch(() => {});
  scheduleAutoRunWatchdog();
}

function suspendAutoRunWatchdog() {
  if (!autoRunWatchdogPromise || autoRunWatchdogTriggered) {
    return;
  }

  autoRunWatchdogSuspended = true;
  clearAutoRunWatchdogTimer();
  void clearPersistentAutoRunActiveWatchdog().catch(() => {});
}

function resumeAutoRunWatchdog({ resetActivity = true } = {}) {
  if (!autoRunWatchdogPromise || autoRunWatchdogTriggered) {
    return;
  }

  autoRunWatchdogSuspended = false;
  if (resetActivity) {
    autoRunWatchdogLastActivityAt = Date.now();
  }
  void armPersistentAutoRunActiveWatchdog({
    currentRun: autoRunCurrentRun,
    totalRuns: autoRunTotalRuns,
    infiniteMode: autoRunInfinite,
    timeoutMs: AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
  }).catch(() => {});
  scheduleAutoRunWatchdog();
}

async function refreshPersistentAutoRunWatchdogFromState(entry = null) {
  const lastLogEntry = normalizeAutoRunWatchdogLogEntry(entry) || autoRunWatchdogLastLogEntry || null;
  const state = await getState();
  const context = getNormalizedAutoRunPauseWatchdogContext(state.autoRunActiveWatchdog);
  if (!shouldRearmPersistentAutoRunWatchdogFromLog({
    hasInMemoryWatchdog: Boolean(autoRunWatchdogPromise),
    watchdogTriggered: autoRunWatchdogTriggered,
    watchdogSuspended: autoRunWatchdogSuspended,
    autoRunning: Boolean(state.autoRunning),
    persistentWatchdogPhase: context?.phase || '',
  })) {
    return;
  }

  await armPersistentAutoRunActiveWatchdog({
    currentRun: context?.currentRun || autoRunCurrentRun,
    totalRuns: context?.totalRuns || autoRunTotalRuns,
    infiniteMode: context ? context.infiniteMode : autoRunInfinite,
    timeoutMs: context?.timeoutMs || AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
    lastLogEntry,
  });
}

function touchAutoRunWatchdog(entry = null) {
  const lastLogEntry = normalizeAutoRunWatchdogLogEntry(entry);
  autoRunWatchdogLastActivityAt = lastLogEntry?.timestamp || Date.now();
  if (lastLogEntry) {
    autoRunWatchdogLastLogEntry = lastLogEntry;
  }

  if (!autoRunWatchdogPromise || autoRunWatchdogTriggered) {
    if (!autoRunWatchdogSuspended) {
      void refreshPersistentAutoRunWatchdogFromState(lastLogEntry).catch(() => {});
    }
    return;
  }

  if (!autoRunWatchdogSuspended) {
    void armPersistentAutoRunActiveWatchdog({
      currentRun: autoRunCurrentRun,
      totalRuns: autoRunTotalRuns,
      infiniteMode: autoRunInfinite,
      timeoutMs: AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
      lastLogEntry,
    }).catch(() => {});
    scheduleAutoRunWatchdog();
  }
}

function getAutoRunWatchdogPromise() {
  return autoRunWatchdogPromise;
}

async function recordVisibleAutoRunFailure(errorMessage, overrides = {}) {
  await ensureAutoRunStatsLoaded();
  const state = await getState();
  const lastLogEntry = overrides.lastLogEntry || autoRunWatchdogLastLogEntry || null;
  const failureRecord = buildAutoRunFailureRecord({
    errorMessage,
    currentRun: overrides.currentRun ?? autoRunCurrentRun,
    totalRuns: overrides.totalRuns ?? autoRunTotalRuns,
    infiniteMode: overrides.infiniteMode ?? autoRunInfinite,
    step: overrides.step ?? 0,
    currentRunStep: overrides.currentRunStep ?? state.currentRunStep ?? 0,
    currentStep: overrides.currentStep ?? state.currentStep ?? 0,
    currentEmail: overrides.currentEmail ?? state.email ?? '',
    lastLogMessage: overrides.lastLogMessage ?? lastLogEntry?.message ?? '',
    lastLogLevel: overrides.lastLogLevel ?? lastLogEntry?.level ?? '',
    timestamp: overrides.timestamp ?? Date.now(),
  });

  await updateCurrentAccountRecordFromError(failureRecord.errorMessage);
  await setAutoRunStats(recordAutoRunFailure(autoRunStatsState, failureRecord));
  return failureRecord;
}

function startAutoRunLoop(totalRuns, infiniteMode = false, options = {}) {
  if (autoRunTask) {
    return autoRunTask;
  }

  const task = autoRunLoop(totalRuns, infiniteMode, options)
    .catch(async (err) => {
      console.error(LOG_PREFIX, 'Auto run crashed unexpectedly:', err);
      if (shouldContinueAutoRunAfterError(err)) {
        const failureRecord = await recordVisibleAutoRunFailure(err.message);
        sendAutoRunStatus('stopped', {
          currentRun: autoRunCurrentRun,
          summaryMessage: failureRecord.logMessage,
        });
      }
      await addLog(`自动运行异常中断：${err.message}`, 'error');
    })
    .finally(() => {
      resetAutoRunWatchdog({ preserveLastLog: true });
      if (autoRunTask === task) {
        autoRunTask = null;
      }
    });

  autoRunTask = task;
  return task;
}

async function waitForAutoRunTaskToSettle() {
  if (!autoRunTask) {
    return;
  }

  try {
    await autoRunTask;
  } catch {}
}

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns, infiniteMode = false, options = {}) {
  if (autoRunActive) {
    await addLog('自动运行已经在进行中。', 'warn');
    return;
  }

  const preserveStats = Boolean(options?.preserveStats);
  const startingRun = Math.max(1, Number.parseInt(String(options?.startingRun ?? 1), 10) || 1);

  clearStopRequest();
  autoRunActive = true;
  autoRunInfinite = Boolean(infiniteMode);
  autoRunTotalRuns = autoRunInfinite ? Number.POSITIVE_INFINITY : totalRuns;
  autoRunLastRotatedMailProvider = null;
  manualHandoffRunContext = null;
  autoRunCurrentRunStartedAt = 0;
  resetAutoRunCurrentSuccessMode();
  await clearPersistentAutoRunPauseWatchdog();
  startAutoRunWatchdog();
  await ensureAutoRunStatsLoaded();
  if (!preserveStats) {
    await setAutoRunStats(resetAutoRunFailureStats(autoRunStatsState));
  }
  await setState({ autoRunning: true });
  let handedOffToManual = false;
  let sessionSuccessfulRuns = 0;
  let sessionFailedRuns = 0;

  for (let run = startingRun; autoRunInfinite || run <= totalRuns; run++) {
    autoRunCurrentRun = run;
    const runTargetText = autoRunInfinite ? `${run}/∞` : `${run}/${totalRuns}`;

    try {
      // Reset everything at the start of each run (keep VPS/mail settings)
      let prevState = await getState();
      let emailSource = getCurrentEmailSource(prevState);
      let shouldRotateMailProvider = emailSource === '33mail' && getCurrentAutoRotateMailProvider(prevState);

      while (shouldRotateMailProvider) {
        const nextAvailableAt = getNextMailProviderAvailabilityTimestamp({
          mailDomainSettings: prevState.mailDomainSettings,
          usageState: prevState.mailProviderUsage,
        });
        if (!Number.isFinite(nextAvailableAt)) {
          break;
        }

        const waitMs = Math.max(0, nextAvailableAt - Date.now());
        if (waitMs <= 0) {
          break;
        }

        await addLog(
          `Auto run ${run}: all 33mail groups reached the 30-minute limit. Waiting ${formatWaitDuration(waitMs)} before retrying...`,
          'warn'
        );
        sendAutoRunStatus('waiting_rotation', {
          currentRun: run,
          waitUntilTimestamp: nextAvailableAt,
          waitReason: '33mail_limit_window',
        });
        suspendAutoRunWatchdog();
        try {
          await sleepWithStop(waitMs);
        } finally {
          resumeAutoRunWatchdog({ resetActivity: true });
        }

        prevState = await getState();
        emailSource = getCurrentEmailSource(prevState);
        shouldRotateMailProvider = emailSource === '33mail' && getCurrentAutoRotateMailProvider(prevState);
      }

      let activeMailProvider = prevState.mailProvider;

      if (shouldRotateMailProvider) {
        activeMailProvider = chooseMailProviderForAutoRun({
          autoRotateMailProvider: true,
          currentProvider: prevState.mailProvider,
          lastProvider: autoRunLastRotatedMailProvider,
          mailDomainSettings: prevState.mailDomainSettings,
          usageState: prevState.mailProviderUsage,
        });
        autoRunLastRotatedMailProvider = activeMailProvider;
        await setMailProviderState(activeMailProvider);
        await addLog(`Auto run ${run}: switched 33mail group to ${activeMailProvider.toUpperCase()}`, 'info');
      }

      const keepSettings = {
        vpsUrl: prevState.vpsUrl,
        mailProvider: activeMailProvider,
        inbucketHost: prevState.inbucketHost,
        inbucketMailbox: prevState.inbucketMailbox,
        autoRunCount: sanitizeAutoRunCount(prevState.autoRunCount),
        autoRunInfinite: sanitizeInfiniteAutoRun(prevState.autoRunInfinite),
        autoRunStats: prevState.autoRunStats || { successfulRuns: autoRunSuccessfulRuns, failedRuns: autoRunFailedRuns },
        mailProviderUsage: pruneMailProviderUsage(prevState.mailProviderUsage),
        autoRunning: true,
      };
      await closeAutoRunRoundTabs();
      await resetState({ preserveLogHistory: true });
      await setState(keepSettings);
      await startNewLogRound(`Run ${runTargetText}`);
      // Tell side panel to reset all UI
      chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
      await sleepWithStop(500);

      const runStartedAt = Date.now();
      autoRunCurrentRunStartedAt = runStartedAt;
      resetAutoRunCurrentSuccessMode();
      throwIfStopped();
      const currentState = await getState();
      const currentEmailSource = getCurrentEmailSource(currentState);
      await addLog(`=== 自动运行 ${runTargetText} — 阶段 1：刷新 ${getEmailSourceLabel(currentEmailSource)}，然后打开 Platform 登录页 ===`, 'info');
      sendAutoRunStatus('running', { currentRun: run });

      let emailReady = false;
      try {
        const nextEmail = await fetchEmailAddress({ generateNew: true });
      await addLog(`=== 第 ${runTargetText} 轮 — ${getEmailSourceLabel(currentEmailSource)} 已就绪：${nextEmail} ===`, 'ok');
        emailReady = true;
      } catch (err) {
        if (isStopError(err)) {
          throw err;
        }
        await addLog(`${getEmailSourceLabel(currentEmailSource)} 自动取号失败：${err.message}`, 'warn');
      }

      if (!emailReady) {
        await addLog(`=== 第 ${runTargetText} 轮已暂停：${getEmailWaitHint(currentEmailSource)} ===`, 'warn');
        sendAutoRunStatus('waiting_email', { currentRun: run });

        // Wait for RESUME_AUTO_RUN — sets a promise that resumeAutoRun resolves
        const shouldSuspendWatchdogDuringPause = shouldSuspendAutoRunWatchdogDuringPause({
          phase: 'waiting_email',
          infiniteMode: autoRunInfinite,
        });
        const shouldUsePersistentPauseWatchdog = shouldUsePersistentAutoRunPauseWatchdog({
          phase: 'waiting_email',
          infiniteMode: autoRunInfinite,
        });
        const resumePromise = waitForResume();
        if (shouldSuspendWatchdogDuringPause || shouldUsePersistentPauseWatchdog) {
          suspendAutoRunWatchdog();
          if (shouldUsePersistentPauseWatchdog) {
            await armPersistentAutoRunPauseWatchdog({
              phase: 'waiting_email',
              currentRun: run,
              totalRuns: autoRunTotalRuns,
              infiniteMode: autoRunInfinite,
              timeoutMs: AUTO_RUN_LOG_SILENCE_TIMEOUT_MS,
            });
          }
          try {
            await resumePromise;
          } finally {
            if (shouldUsePersistentPauseWatchdog) {
              await clearPersistentAutoRunPauseWatchdog();
            }
            resumeAutoRunWatchdog({ resetActivity: true });
          }
        } else {
          const watchdogPromise = autoRunActive ? getAutoRunWatchdogPromise() : null;
          if (watchdogPromise) {
            await Promise.race([resumePromise, watchdogPromise]);
          } else {
            await resumePromise;
          }
        }

        const resumedState = await getState();
        if (getCurrentEmailSource(resumedState) !== '33mail' && !resumedState.email) {
          throw new Error('Cannot resume: no email address.');
        }
      }

      await addLog(`=== 第 ${runTargetText} 轮 — 阶段 2：打开 Platform 登录页 ===`, 'info');
      sendAutoRunStatus('running', { currentRun: run });
      await executeStepAndWait(2, 2000);

      await addLog(`=== 第 ${runTargetText} 轮 — 阶段 3：请求验证码、验证、登录并完成流程 ===`, 'info');
      sendAutoRunStatus('running', { currentRun: run });

      const signupTabId = await getTabId('signup-page');
      if (signupTabId) {
        await chrome.tabs.update(signupTabId, { active: true });
      }

      await runStepSequence({
        startStep: 3,
        executeStepAndWait,
      });

      await addLog(`=== 第 ${runTargetText} 轮已完成！===`, 'ok');
      await ensureAutoRunStatsLoaded();
      await setAutoRunStats(recordAutoRunSuccess(autoRunStatsState, {
        durationMs: Math.max(0, Date.now() - runStartedAt),
        mode: autoRunCurrentSuccessMode,
      }));
      sessionSuccessfulRuns += 1;
      await setState({ currentRunStep: 0 });

    } catch (err) {
      if (isAutoRunLogSilenceError(err)) {
        const failureRecord = await recordVisibleAutoRunFailure(err.message, {
          currentRun: run,
          totalRuns: autoRunTotalRuns,
          infiniteMode: autoRunInfinite,
        });
        const shouldContinueAfterWatchdog = shouldContinueAutoRunAfterWatchdog({
          currentRun: run,
          totalRuns: autoRunTotalRuns,
          infiniteMode: autoRunInfinite,
        });
        sessionFailedRuns += 1;
        await addLog(failureRecord.logMessage, 'error');
        await setState({ currentRunStep: 0 });
        await abortCurrentAutoRunRound();
        if (shouldContinueAfterWatchdog) {
          clearStopRequest();
          autoRunActive = true;
          await setState({ autoRunning: true });
          startAutoRunWatchdog();
          await addLog(`=== 第 ${runTargetText} 轮看门狗超时，准备自动开始下一轮... ===`, 'warn');
          sendAutoRunStatus('running', { currentRun: run });
          continue;
        }
        clearStopRequest();
        break;
      } else if (isAutoRunHandoffError(err)) {
        handedOffToManual = true;
        await addLog(`Run ${runTargetText} handed off to manual continuation`, 'info');
        break;
      } else if (isStopError(err)) {
        await addLog(`第 ${runTargetText} 轮已由用户停止。`, 'warn');
        await setState({ currentRunStep: 0 });
        break;
      } else {
        const failureRecord = await recordVisibleAutoRunFailure(err.message, {
          currentRun: run,
          totalRuns: autoRunTotalRuns,
          infiniteMode: autoRunInfinite,
        });
        sessionFailedRuns += 1;
        await addLog(failureRecord.logMessage, 'error');
        await setState({ currentRunStep: 0 });
        if (autoRunInfinite || run < totalRuns) {
          if (/step 5 failed: .*unsupported_email|step 5 failed: auth fatal error page detected after profile submit\.|step 5 failed: could not find name input/i.test(err.message || '')) {
            await addLog(`第 ${runTargetText} 轮在第 5 步触发 TMailor 域名封锁，已标记失败并切换到下一轮。`, 'warn');
          }
          await addLog(`=== 第 ${runTargetText} 轮失败，准备自动开始下一轮... ===`, 'warn');
          sendAutoRunStatus('running', { currentRun: run });
          continue;
        }
      }
    }
  }

  const lastAttemptedRun = autoRunCurrentRun;
  const summary = summarizeAutoRunResult({
    totalRuns: autoRunTotalRuns,
    successfulRuns: autoRunSuccessfulRuns,
    failedRuns: autoRunFailedRuns,
    sessionSuccessfulRuns,
    sessionFailedRuns,
    lastAttemptedRun,
    stopRequested,
    handedOffToManual,
    infiniteMode: autoRunInfinite,
  });

  await addLog(summary.message, summary.phase === 'complete' ? 'ok' : 'warn');
  autoRunCurrentRunStartedAt = 0;
  resetAutoRunCurrentSuccessMode();
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: buildAutoRunStatusPayload({
      phase: summary.phase,
      currentRun: lastAttemptedRun,
      totalRuns: autoRunTotalRuns,
      infiniteMode: autoRunInfinite,
      successfulRuns: autoRunSuccessfulRuns,
      failedRuns: autoRunFailedRuns,
      totalSuccessfulDurationMs: autoRunStatsState.totalSuccessfulDurationMs,
      recentSuccessDurationsMs: autoRunStatsState.recentSuccessDurationsMs,
      recentSuccessEntries: autoRunStatsState.recentSuccessEntries,
      failureBuckets: autoRunStatsState.failureBuckets,
      summaryMessage: summary.message,
      summaryToast: summary.toastMessage,
    }),
  }).catch(() => {});

  autoRunActive = false;
  autoRunInfinite = false;
  resetAutoRunWatchdog({ preserveLastLog: true });
  await setState({ autoRunning: false });
  clearStopRequest();
}

function waitForResume() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  const state = await getState();
  if (getCurrentEmailSource(state) !== '33mail' && !state.email) {
    await addLog('无法继续：当前没有邮箱地址，请先在侧边栏填写或粘贴邮箱。', 'error');
    return false;
  }
  if (resumeWaiter) {
    resumeWaiter.resolve();
    resumeWaiter = null;
    return true;
  }
  await addLog('收到恢复自动运行请求，但当前没有处于暂停等待中的自动流程，允许回退到第 3 步继续。', 'warn');
  return false;
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  if (!state.vpsUrl) {
    throw new Error('No VPS URL configured. Enter VPS address in Side Panel first.');
  }
  await addLog(`Step 1: Opening VPS panel...`);
  await reuseOrCreateTab('vps-panel', state.vpsUrl, {
    inject: ['shared/flow-recovery.js', 'content/utils.js', 'content/vps-panel.js'],
    reloadIfSameUrl: true,
  });

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens the platform login entry, signup-page.js continues if needed)
// ============================================================

let step2NavigationReplayAttempted = false;

function isStep2PlatformSigningBridgePageState(pageState = {}) {
  const url = String(pageState?.url || '').trim();
  if (!/platform\.openai\.com\/(login|home|auth\/callback)/i.test(url)) {
    return false;
  }

  return !pageState?.hasVisibleCredentialInput
    && !pageState?.hasVisibleVerificationInput
    && !pageState?.hasVisibleProfileFormInput;
}

function isStep2RecoveredAuthPageReady(pageState = {}) {
  const url = String(pageState?.url || '').trim();
  const hasVisibleCredentialInput = Boolean(pageState?.hasVisibleCredentialInput);
  const hasVisibleVerificationInput = Boolean(pageState?.hasVisibleVerificationInput);
  const hasVisibleProfileFormInput = Boolean(pageState?.hasVisibleProfileFormInput);

  if (hasVisibleVerificationInput || hasVisibleProfileFormInput) {
    return true;
  }

  if (!hasVisibleCredentialInput) {
    return false;
  }

  if (/platform\.openai\.com\/login/i.test(url)) {
    return true;
  }

  if (/(?:auth|accounts)\.openai\.com\/(?:u\/signup\/|create-account)/i.test(url)) {
    return true;
  }

  return false;
}

function isStep2UnexpectedAuthLoginPageState(pageState = {}) {
  const url = String(pageState?.url || '').trim();
  return /(?:auth|accounts)\.openai\.com\/log-?in(?:[/?#]|$)/i.test(url)
    && !pageState?.hasVisibleVerificationInput
    && !pageState?.hasVisibleProfileFormInput;
}

async function executeStep2(state, options = {}) {
  const replayedAfterNavigationInterrupt = Boolean(options?.replayedAfterNavigationInterrupt);
  const preferSignupEntry = Boolean(options?.preferSignupEntry);
  if (!replayedAfterNavigationInterrupt) {
    step2NavigationReplayAttempted = false;
  }

  if (replayedAfterNavigationInterrupt) {
    await addLog(
      '第 2 步：导航打断后页面还卡在 signing bridge，正在重放 Platform 登录页步骤。',
      'warn'
    );
  }

  await addLog('第 2 步：正在打开 Platform 登录页...');
  await reuseOrCreateTab('signup-page', OFFICIAL_SIGNUP_ENTRY_URL, {
    reuseActiveTabOnCreate: true,
    reloadIfSameUrl: replayedAfterNavigationInterrupt,
  });

  try {
    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 2,
      source: 'background',
      payload: {
        preferSignupEntry,
      },
    });
  } catch (err) {
    const errorMessage = err?.message || String(err || '');
    if (isMessageChannelClosedError(errorMessage) || isReceivingEndMissingError(errorMessage)) {
      await addLog(
        '第 2 步：signup 页面在返回结果前已发生跳转，继续等待完成信号。',
        'warn'
      );
      await waitForStep2CompletionSignalOrAuthPageReady();
      return;
    }
    throw err;
  }
}

async function waitForStep2CompletionSignalOrAuthPageReady() {
  const timeoutMs = 15000;
  const start = Date.now();
  let lastHeartbeatAt = 0;

  while (Date.now() - start < timeoutMs) {
    const currentState = await getState();
    const currentStepStatus = currentState?.stepStatuses?.[2];

    if (currentStepStatus === 'completed' || currentStepStatus === 'failed' || currentStepStatus === 'stopped') {
      step2NavigationReplayAttempted = false;
      return;
    }

    const pageState = await getSignupAuthPageState();
    const authPageReady = isStep2RecoveredAuthPageReady(pageState);

    if (authPageReady) {
      await addLog(
        '第 2 步：导航打断后 auth 页面已就绪，改由后台兜底判定本步完成。',
        'warn'
      );
      step2NavigationReplayAttempted = false;
      await setStepStatus(2, 'completed');
      notifyStepComplete(2, { recoveredAfterNavigation: true });
      return;
    }

    if (isStep2UnexpectedAuthLoginPageState(pageState)) {
      if (!step2NavigationReplayAttempted) {
        step2NavigationReplayAttempted = true;
        await addLog(
          '第 2 步：导航打断后页面回退到了 auth.openai.com/log-in，准备重开 Platform 登录入口再试一次。',
          'warn'
        );
        await executeStep2(currentState, { replayedAfterNavigationInterrupt: true });
        return;
      }

      throw new Error(
        'Step 2 blocked: auth page fell back to auth.openai.com/log-in instead of the platform login entry after logout recovery.'
      );
    }

    const elapsedMs = Date.now() - start;
    if (isStep2PlatformSigningBridgePageState(pageState)) {
      if (elapsedMs - lastHeartbeatAt >= 5000) {
        lastHeartbeatAt = elapsedMs;
        await addLog(
          `Step 2: Still waiting for the platform signing bridge to settle after ${Math.max(1, Math.round(elapsedMs / 1000))}s. Current auth URL: ${pageState?.url || 'unknown'}`,
          'info'
        );
      }

      if (!step2NavigationReplayAttempted && elapsedMs >= 3000) {
        step2NavigationReplayAttempted = true;
        await addLog(
          '第 2 步：导航打断后页面仍卡在 Platform signing bridge，重注入后重放第 2 步一次。',
          'warn'
        );
        await executeStep2(currentState, { replayedAfterNavigationInterrupt: true });
        return;
      }
    }

    await sleepWithStop(250);
  }

  step2NavigationReplayAttempted = false;
  throw new Error('Step 2 blocked: signup auth page did not become ready again after navigation interruption.');
}

// ============================================================
// Step 3: Fill Email and request the signup one-time code (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  const emailSource = getCurrentEmailSource(state);
  const activeTmailorLease = getActiveTmailorEmailLease(state);
  let email = emailSource === 'tmailor' && activeTmailorLease?.email
    ? activeTmailorLease.email
    : state.email;

  if (emailSource === '33mail') {
    const currentDomain = get33MailDomainForProvider(state.mailDomainSettings, state.mailProvider || '163');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const matchesCurrentDomain = currentDomain && normalizedEmail.endsWith(`@${currentDomain}`);

    if (!matchesCurrentDomain) {
      email = await generate33MailEmail({ generateNew: true });
    }
  }

  if (emailSource === 'tmailor' && !isTmailorEmailAllowed(state, email)) {
    email = await fetchTmailorEmail({ generateNew: true });
  }

  if (!email) {
    throw new Error('No email address. Paste email in Side Panel first.');
  }

  const password = state.customPassword || state.password || generatePassword();
  await setEmailState(email);
  await setPasswordState(password);
  if (emailSource === 'tmailor') {
    await setTmailorEmailLease({
      email,
      password,
      accessToken: state.tmailorAccessToken || activeTmailorLease?.accessToken || '',
      status: 'active',
      invalidReason: '',
      recoveryAttempts: {
        ...(activeTmailorLease?.recoveryAttempts || {}),
        step3: (Number.parseInt(String(activeTmailorLease?.recoveryAttempts?.step3 ?? 0), 10) || 0) + 1,
      },
    });
  }

  // Save account record
  const accounts = state.accounts || [];
  const lastAccount = accounts[accounts.length - 1];
  if (!lastAccount || lastAccount.email !== email || lastAccount.password !== password) {
    accounts.push({ email, password, createdAt: new Date().toISOString() });
    await setState({ accounts });
  }
  await createOrReuseCurrentAccountRecord({
    email,
    password,
    emailSource,
    mailProvider: state.mailProvider,
  });

  await addLog(`第 3 步：正在填写邮箱 ${email}，点击 Continue，并请求一次性验证码...`);
  try {
    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 3,
      source: 'background',
      payload: { email, password },
    });
  } catch (err) {
    const errorMessage = err?.message || String(err || '');
    if (isMessageChannelClosedError(errorMessage) || isReceivingEndMissingError(errorMessage)) {
      await addLog(
        '第 3 步：signup 页面在返回结果前已发生跳转，继续等待完成信号。',
        'warn'
      );
      await waitForStep3CompletionSignalOrRecoveredAuthState();
      return;
    }
    throw err;
  }
}

function isExistingAccountLoginPasswordPageUrl(url = '') {
  return /(?:auth|accounts)\.openai\.com\/log-?in\/password/i.test(String(url || ''));
}

function isCanonicalEmailVerificationUrl(url = '') {
  return /(?:auth|accounts)\.openai\.com\/(?:account\/)?email-verification/i.test(String(url || ''));
}

function isStep3RecoveredAuthPageReady(pageState = {}) {
  if (pageState?.hasFatalError || pageState?.hasAuthOperationTimedOut || pageState?.isReachable === false) {
    return false;
  }

  if (pageState?.hasReadyVerificationPage || pageState?.hasReadyProfilePage) {
    return true;
  }

  if (pageState?.hasVisibleCredentialInput) {
    return false;
  }

  if (pageState?.hasVisibleVerificationInput || pageState?.hasVisibleProfileFormInput) {
    return true;
  }

  return Boolean(
    (isCanonicalEmailVerificationUrl(pageState?.url) && pageState?.hasReadyVerificationPage)
    || (isCanonicalAboutYouUrl(pageState?.url) && pageState?.hasReadyProfilePage)
  );
}

async function waitForStep3CompletionSignalOrRecoveredAuthState() {
  const timeoutMs = 15000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const currentState = await getState();
    const currentStepStatus = currentState?.stepStatuses?.[3];

    if (currentStepStatus === 'completed' || currentStepStatus === 'failed' || currentStepStatus === 'stopped') {
      return;
    }

    const pageState = await getSignupAuthPageState();

    if (isStep3RecoveredAuthPageReady(pageState)) {
      const payload = { recoveredAfterNavigation: true };
      await addLog(
        '第 3 步：导航打断后页面已越过凭证表单，改由后台兜底判定本步完成。',
        'warn'
      );
      await setStepStatus(3, 'completed');
      await handleStepData(3, payload);
      notifyStepComplete(3, payload);
      return;
    }

    if (
      pageState?.hasVisibleCredentialInput
      && isExistingAccountLoginPasswordPageUrl(pageState?.url)
      && !pageState?.hasVisibleSignupRegistrationChoice
    ) {
      const payload = {
        recoveredAfterNavigation: true,
        existingAccountLogin: true,
      };
      await addLog(
        '第 3 步：导航打断后已进入已有账号登录密码页，本步由后台兜底完成，并保留当前邮箱和密码继续登录。',
        'warn'
      );
      await setStepStatus(3, 'completed');
      await handleStepData(3, payload);
      notifyStepComplete(3, payload);
      return;
    }

    await sleepWithStop(250);
  }
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  if (getCurrentEmailSource(state) === 'tmailor') {
    return { source: 'tmailor-mail', url: 'https://tmailor.com/', label: 'TMailor' };
  }
  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  if (provider === 'inbucket') {
    const host = normalizeInbucketOrigin(state.inbucketHost);
    const mailbox = (state.inbucketMailbox || '').trim();
    if (!host) {
      return { error: 'Inbucket host is empty or invalid.' };
    }
    if (!mailbox) {
      return { error: 'Inbucket mailbox name is empty.' };
    }
    return {
      source: 'inbucket-mail',
      url: `${host}/m/${encodeURIComponent(mailbox)}/`,
      label: `Inbucket Mailbox (${mailbox})`,
      navigateOnReuse: true,
      inject: ['shared/mail-matching.js', 'shared/mail-freshness.js', 'shared/latest-mail.js', 'content/utils.js', 'content/inbucket-mail.js'],
      injectSource: 'inbucket-mail',
    };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

function normalizeInbucketOrigin(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    return '';
  }
}

async function clickResendOnSignupPage(step) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return;

  await chrome.tabs.update(signupTabId, { active: true });
  await sleepWithStop(500);

  try {
    await sendToContentScript('signup-page', {
      type: 'CLICK_RESEND_EMAIL',
      step,
      source: 'background',
    });
  } catch (err) {
    await addLog(`第 ${step} 步：已跳过“重发”点击，原因：${err.message}`, 'warn');
  }
}

async function ensureMailTabReady(mail, options = {}) {
  const alive = await isTabAlive(mail.source);
  const navigateIfUrlDiff = Boolean(options.navigateIfUrlDiff);
  if (alive) {
    const tabId = await getTabId(mail.source);
    const currentTab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (mail.source === 'tmailor-mail' && isBrowserErrorPageTab(currentTab)) {
      await addLog(`TMailor: Mailbox tab is stuck on a browser error page. Reopening the TMailor home page before continuing...`, 'warn');
      await reviveMailTab(mail);
      return;
    }
    if (mail.navigateOnReuse || navigateIfUrlDiff) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      await chrome.tabs.update(tabId, { active: true });
    }
    return;
  }

  await reuseOrCreateTab(mail.source, mail.url, {
    inject: mail.inject,
    injectSource: mail.injectSource,
  });
}

async function reviveMailTab(mail) {
  await reuseOrCreateTab(mail.source, mail.url, {
    reloadIfSameUrl: true,
    inject: mail.inject,
    injectSource: mail.injectSource,
  });
}

async function pollVerificationCodeFromMail(step, mail, payload) {
  const state = await getState();
  const useTmailorApiMailboxOnly = shouldUseTmailorApiMailboxOnly({
    mailSource: mail.source,
    accessToken: state.tmailorAccessToken,
  });

  if (mail.source === 'tmailor-mail' && state.tmailorAccessToken) {
    try {
      await addLog(`Step ${step}: Polling TMailor inbox via API for ${state.email || 'current mailbox'}...`, 'info');
      const apiResult = await pollTmailorVerificationCode({
        accessToken: state.tmailorAccessToken,
        step,
        senderFilters: payload?.senderFilters,
        subjectFilters: payload?.subjectFilters,
        filterAfterTimestamp: payload?.filterAfterTimestamp,
        excludeCodes: payload?.excludeCodes,
        targetEmail: payload?.targetEmail,
        maxAttempts: payload?.maxAttempts,
        intervalMs: payload?.intervalMs,
        throwIfStopped,
        sleep: sleepWithStop,
        onPollStart: async (event) => {
          await assertVerificationMailStepNotBlockedDuringPolling(step);
          await addLog(
            `Step ${step}: TMailor API 开始轮询 ${event.attempt}/${event.maxAttempts}...`,
            'info'
          );
        },
        onPollAttempt: async (event) => {
          await assertVerificationMailStepNotBlockedDuringPolling(step);
          const candidateLabel = event.candidateFound
            ? `发现 ${event.matchedCount} 封候选邮件`
            : '暂未发现匹配邮件';
          await addLog(
            `Step ${step}: TMailor API 轮询 ${event.attempt}/${event.maxAttempts}（${candidateLabel}）`,
            'info'
          );
        },
        onRetry: async (event) => {
          const waitLabel = event.waitMs > 0 ? `，${formatWaitDuration(event.waitMs)}后重试` : '，立即重试';
          await addLog(
            `Step ${step}: TMailor API ${event.stage} 暂时失败（轮询 ${event.pollAttempt}/${event.maxPollAttempts}，重试 ${event.retryAttempt}/${event.maxRequestRetries}）：${event.error.message}${waitLabel}`,
            'warn'
          );
        },
      });
      markAutoRunCurrentSuccessMode('api');
      await addLog(`第 ${step} 步：TMailor API 已返回验证码 ${apiResult.code}。`, 'ok');
      return apiResult;
    } catch (err) {
      await addLog(`第 ${step} 步：TMailor API 轮询收件箱失败：${err.message}`, 'warn');
      if (useTmailorApiMailboxOnly) {
        await addLog(`Step ${step}: ${getTmailorApiOnlyPollingMessage(state.email)}`, 'warn');
        throw err;
      }
      await addLog(`第 ${step} 步：改为使用 TMailor 页面 DOM 流程轮询收件箱。`, 'warn');
    }
  }

  let result;

  try {
    result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step,
      source: 'background',
      payload,
    });
  } catch (err) {
    const recoveryPlan = buildMailPollRecoveryPlan(err);
    if (recoveryPlan.length === 0) {
      throw err;
    }

    const disconnectReason = isReceivingEndMissingError(err) ? 'receiver missing' : 'message channel closed';

    for (const recoveryStep of recoveryPlan) {
      if (recoveryStep === 'soft-retry') {
        await addLog(
          `Step ${step}: Mail page connection was lost (${disconnectReason}). Waiting for the message detail page to finish loading and retrying...`,
          'warn'
        );
        await sleepWithStop(1500);
      } else if (recoveryStep === 'reload') {
        await addLog(
          `Step ${step}: Mail page did not recover after navigation. Reloading mailbox and retrying once...`,
          'warn'
        );
        await reviveMailTab(mail);
        await sleepWithStop(1200);
      }

      try {
        result = await sendToContentScript(mail.source, {
          type: 'POLL_EMAIL',
          step,
          source: 'background',
          payload,
        });
        break;
      } catch (retryErr) {
        if (recoveryStep === recoveryPlan[recoveryPlan.length - 1]) {
          throw retryErr;
        }
      }
    }
  }

  if (result?.error) {
    throw new Error(result.error);
  }

  if (result?.recovery === 'reload_mailbox') {
    await addLog(`第 ${step} 步：邮箱页请求后台重载（${result.reason || 'reload_mailbox'}），准备重开邮箱页并重试一次。`, 'warn');
    await reviveMailTab(mail);
    await sleepWithStop(1200);
    result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step,
      source: 'background',
      payload,
    });
  }

  if (result?.error) {
    throw new Error(result.error);
  }

  if (!result?.code) {
    throw new Error(`Step ${step}: No verification code returned from ${mail.label}.`);
  }

  return result;
}

async function submitVerificationCode(step, code) {
  return await submitVerificationCodeWithRecovery(step, code, { recovered: false });
}

function shouldRecoverSignupPageFillCodeError(error) {
  const message = typeof error === 'string' ? error : error?.message || '';
  return /content script on signup-page did not respond/i.test(message)
    || /message port closed|receiving end does not exist|tab was closed/i.test(message);
}

async function tryDirectVerificationCodeFillOnCurrentSignupPage(step, code) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    return { attempted: false, reason: 'missing-signup-tab' };
  }

  const signupTab = await chrome.tabs.get(signupTabId).catch(() => null);
  const currentUrl = String(signupTab?.url || '').trim();
  const pageState = await getSignupAuthPageState().catch(() => null);

  if (
    step === 4
    && (
      pageState?.hasReadyProfilePage
      || pageState?.hasVisibleProfileFormInput
      || isCanonicalAboutYouUrl(pageState?.url)
      || isStableStep5SuccessUrl(pageState?.url)
    )
  ) {
    await addLog(
      `第 ${step} 步：检测到页面已经到达 about-you/资料页，跳过验证码页补填重试。 | 调试：URL=${pageState?.url || currentUrl || 'unknown'}; profile=${Boolean(pageState?.hasVisibleProfileFormInput)}; readyProfile=${Boolean(pageState?.hasReadyProfilePage)}`,
      'info'
    );
    return {
      attempted: false,
      accepted: true,
      reason: 'profile-page-already-ready',
      url: pageState?.url || currentUrl,
    };
  }

  if (!/(?:auth|accounts)\.openai\.com\/(?:account\/)?email-verification/i.test(currentUrl)) {
    return {
      attempted: false,
      reason: 'not-verification-page',
      url: currentUrl,
    };
  }

  await addLog(
    `Step ${step}: Signup page command stalled on the current verification page. Trying to fill the current verification form with the same code before reloading...`,
    'warn'
  );

  const executionResults = await chrome.scripting.executeScript({
    target: { tabId: signupTabId },
    func: async (verificationCode) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const code = String(verificationCode || '').trim();
      const codeSelectors = [
        'input[name="code"]',
        'input[name="otp"]',
        'input[type="text"][maxlength="6"]',
        'input[aria-label*="code" i]',
        'input[placeholder*="code" i]',
        'input[inputmode="numeric"]',
      ];
      const submitButtonText = /verify|confirm|submit|continue|确认|验证|继续/i;
      const rejectionText = /incorrect code|invalid code|wrong code|code is invalid|验证码错误|验证码无效/i;

      const isVisible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect?.();
        const style = window.getComputedStyle?.(element);
        return Boolean(
          rect
          && rect.width > 0
          && rect.height > 0
          && style
          && style.visibility !== 'hidden'
          && style.display !== 'none'
        );
      };

      const dispatchInputValue = (input, value) => {
        if (!input) return;
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
        if (descriptor?.set) {
          descriptor.set.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const getVisibleVerificationInput = () => {
        for (const selector of codeSelectors) {
          const input = document.querySelector(selector);
          if (isVisible(input)) {
            return input;
          }
        }
        return null;
      };

      const getVisibleSingleDigitInputs = () =>
        Array.from(document.querySelectorAll('input[maxlength="1"]')).filter(isVisible);

      const hasVerificationInput = () =>
        Boolean(getVisibleVerificationInput()) || getVisibleSingleDigitInputs().length >= 6;

      const hasProfileInput = () =>
        Array.from(document.querySelectorAll(
          'input[name="name"], input[autocomplete="name"], input[placeholder*="全名"], input[name="age"], input[name="birthday"]'
        )).some(isVisible);

      const findSubmitButton = () => {
        const explicitSubmit = document.querySelector('button[type="submit"]');
        if (isVisible(explicitSubmit)) {
          return explicitSubmit;
        }

        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        return buttons.find((button) => isVisible(button) && submitButtonText.test(String(button.textContent || '').trim())) || null;
      };

      const submitByFallback = (input) => {
        const form = input?.form || input?.closest?.('form') || null;
        if (form?.requestSubmit) {
          form.requestSubmit();
          return true;
        }
        if (form?.submit) {
          form.submit();
          return true;
        }
        if (!input?.dispatchEvent) {
          return false;
        }
        input.focus?.();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        return true;
      };

      const startUrl = location.href;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (hasVerificationInput()) {
          break;
        }
        if (location.href !== startUrl || hasProfileInput()) {
          return { accepted: true, reason: 'page-already-advanced', url: location.href };
        }
        await sleep(250);
      }

      const singleInputs = getVisibleSingleDigitInputs();
      const primaryInput = getVisibleVerificationInput() || singleInputs[0] || null;
      if (!primaryInput && singleInputs.length < 6) {
        return { attempted: false, reason: 'missing-verification-input', url: location.href };
      }

      if (singleInputs.length >= 6) {
        for (let index = 0; index < 6 && index < singleInputs.length; index += 1) {
          dispatchInputValue(singleInputs[index], code[index] || '');
          await sleep(60);
        }
      } else if (primaryInput) {
        dispatchInputValue(primaryInput, code);
      }

      await sleep(250);

      const submitButton = findSubmitButton();
      if (submitButton) {
        for (let attempt = 0; attempt < 34; attempt += 1) {
          const ariaDisabled = submitButton.getAttribute?.('aria-disabled') === 'true';
          if (!submitButton.disabled && !ariaDisabled) {
            submitButton.click();
            break;
          }
          if (!hasVerificationInput()) {
            return { accepted: true, reason: 'page-advanced-before-click', url: location.href };
          }
          await sleep(150);
        }
      } else if (!submitByFallback(primaryInput)) {
        return { attempted: true, accepted: false, reason: 'missing-submit-action', url: location.href };
      }

      for (let attempt = 0; attempt < 24; attempt += 1) {
        const visibleText = String(document.body?.innerText || '');
        if (rejectionText.test(visibleText)) {
          return { attempted: true, retryInbox: true, reason: 'verification-code-rejected', url: location.href };
        }
        if (location.href !== startUrl || hasProfileInput()) {
          return { accepted: true, reason: 'page-advanced', url: location.href };
        }
        if (!hasVerificationInput()) {
          return { accepted: true, reason: 'verification-form-hidden', url: location.href };
        }
        await sleep(250);
      }

      return {
        attempted: true,
        accepted: false,
        reason: 'verification-form-still-visible',
        url: location.href,
      };
    },
    args: [code],
  }).catch(() => []);

  const result = executionResults?.[0]?.result || null;
  if (result?.accepted) {
    await addLog(
      `Step ${step}: Reused the current verification page with the same code successfully (${result.reason || 'page-advanced'}).`,
      'info'
    );
    return result;
  }

  if (result?.retryInbox) {
    await addLog(`第 ${step} 步：当前验证码已被页面拒绝，返回收件箱继续轮询。`, 'warn');
    return result;
  }

  if (result?.attempted) {
    await addLog(
      `Step ${step}: The current verification page kept the form visible after a direct same-page retry (${result.reason || 'unknown'}). Falling back to a one-time reload of the same URL...`,
      'warn'
    );
  }

  return result || { attempted: false, reason: 'direct-same-page-retry-unavailable', url: currentUrl };
}

async function recoverSignupPageFillCodeError(step, error) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw error;
  }

  const signupTab = await chrome.tabs.get(signupTabId).catch(() => null);
  if (!signupTab?.url) {
    throw error;
  }

  await addLog(
    `Step ${step}: ${error?.message || String(error || 'unknown error')} Reloading the current signup verification page and retrying the code submit once...`,
    'warn'
  );
  await reuseOrCreateTab('signup-page', signupTab.url, {
    reloadIfSameUrl: true,
  });
  await sleepWithStop(800);
}

async function submitVerificationCodeWithRecovery(step, code, options = {}) {
  const { recovered = false } = options;
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('Signup/auth page tab was closed. Cannot fill verification code.');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  let submitResult = null;
  const step4AdvanceMonitor = { finished: false };

  try {
    if (step === 4) {
      await addLog(`第 ${step} 步：已拿到验证码，正在切回 auth 页面并开始填写。`, 'info');
    }

    const submitResponsePromise = sendToContentScript('signup-page', {
      type: 'FILL_CODE',
      step,
      source: 'background',
      payload: { code },
    }).then(
      (result) => ({ kind: 'submit-response', result }),
      (error) => ({ kind: 'submit-error', error })
    );
    const step4AdvanceSignalPromise = step === 4
      ? waitForStep4VerificationAdvanceSignal(step, {
        shouldStop: () => step4AdvanceMonitor.finished,
      }).then((result) => result
        ? ({ kind: 'step4-advance-signal', result })
        : ({ kind: 'step4-advance-timeout' }))
      : null;
    const step4SlowFillRecoveryPromise = step === 4
      ? waitForStep4SlowCodeFillRecovery(step, code, {
        shouldStop: () => step4AdvanceMonitor.finished,
      }).then((result) => result
        ? ({ kind: 'step4-slow-fill-recovery', result })
        : ({ kind: 'step4-slow-fill-timeout' }))
      : null;

    const step4RecoveryRacers = [submitResponsePromise];
    if (step4AdvanceSignalPromise) {
      step4RecoveryRacers.push(step4AdvanceSignalPromise);
    }
    if (step4SlowFillRecoveryPromise) {
      step4RecoveryRacers.push(step4SlowFillRecoveryPromise);
    }

    const submitRaceResult = step4RecoveryRacers.length > 1
      ? await Promise.race(step4RecoveryRacers)
      : await submitResponsePromise;
    const finalSubmitRaceResult = (
      submitRaceResult?.kind === 'step4-advance-timeout'
      || submitRaceResult?.kind === 'step4-slow-fill-timeout'
    )
      ? await submitResponsePromise
      : submitRaceResult;
    step4AdvanceMonitor.finished = true;

    if (
      (finalSubmitRaceResult?.kind === 'step4-advance-signal' || finalSubmitRaceResult?.kind === 'step4-slow-fill-recovery')
      && (finalSubmitRaceResult?.result?.accepted || finalSubmitRaceResult?.result?.retryInbox)
    ) {
      return finalSubmitRaceResult.result;
    }

    if (finalSubmitRaceResult?.kind === 'submit-error') {
      throw finalSubmitRaceResult.error;
    }

    submitResult = finalSubmitRaceResult?.result || null;
  } catch (err) {
    step4AdvanceMonitor.finished = true;
    const message = err?.message || '';
    if (/message port closed|receiving end does not exist|tab was closed/i.test(message)) {
      await addLog(`Step ${step}: Signup page navigated before submit response; waiting for completion signal...`, 'info');
      return { accepted: true, reason: 'navigation-detached' };
    }
    if (!recovered && shouldRecoverSignupPageFillCodeError(err)) {
      const directRetryResult = await tryDirectVerificationCodeFillOnCurrentSignupPage(step, code);
      if (directRetryResult?.accepted || directRetryResult?.retryInbox) {
        return directRetryResult;
      }
      await recoverSignupPageFillCodeError(step, err);
      return await submitVerificationCodeWithRecovery(step, code, { recovered: true });
    }
    throw err;
  }

  if (submitResult?.error) {
    throw new Error(submitResult.error);
  }

  return submitResult || { accepted: true };
}

async function getSignupAuthPageState() {
  try {
    const pageState = await sendToContentScript('signup-page', {
      type: 'CHECK_AUTH_PAGE_STATE',
      source: 'background',
      payload: {},
    });
    if (pageState) {
      return {
        isReachable: true,
        requiresPhoneVerification: false,
        hasUnsupportedEmail: false,
        hasFatalError: false,
        hasAuthOperationTimedOut: false,
        hasVisibleCredentialInput: false,
        hasVisibleSignupRegistrationChoice: false,
        hasVisibleVerificationInput: false,
        hasVisibleProfileFormInput: false,
        hasReadyVerificationPage: false,
        hasReadyProfilePage: false,
        ...pageState,
      };
    }

    const fallbackState = await getSignupPageFallbackAuthState();
    if (fallbackState) {
      return fallbackState;
    }

    return {
      isReachable: true,
      requiresPhoneVerification: false,
      hasUnsupportedEmail: false,
      hasFatalError: false,
      hasAuthOperationTimedOut: false,
      hasVisibleCredentialInput: false,
      hasVisibleSignupRegistrationChoice: false,
      hasVisibleVerificationInput: false,
      hasVisibleProfileFormInput: false,
      hasReadyVerificationPage: false,
      hasReadyProfilePage: false,
    };
  } catch {
    const fallbackState = await getSignupPageFallbackAuthState();
    if (fallbackState) {
      return fallbackState;
    }

    return {
      isReachable: false,
      requiresPhoneVerification: false,
      hasUnsupportedEmail: false,
      hasFatalError: false,
      hasAuthOperationTimedOut: false,
      hasVisibleCredentialInput: false,
      hasVisibleSignupRegistrationChoice: false,
      hasVisibleVerificationInput: false,
      hasVisibleProfileFormInput: false,
      hasReadyVerificationPage: false,
      hasReadyProfilePage: false,
    };
  }
}

function isStableStep5SuccessUrl(url = '') {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    return false;
  }

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.hostname !== 'platform.openai.com') {
      return false;
    }

    if (/^\/auth\/callback$/i.test(parsed.pathname)) {
      return true;
    }

    return /^\/welcome$/i.test(parsed.pathname) && parsed.searchParams.get('step') === 'create';
  } catch {
    return /platform\.openai\.com\/auth\/callback/i.test(normalizedUrl)
      || /platform\.openai\.com\/welcome\?step=create/i.test(normalizedUrl);
  }
}

function isStep4VerificationAdvanceState(pageState = {}) {
  if (!pageState) {
    return false;
  }

  if (pageState?.hasReadyProfilePage || isStableStep5SuccessUrl(pageState?.url)) {
    return true;
  }

  return Boolean(
    pageState?.hasVisibleProfileFormInput
    && isCanonicalAboutYouUrl(pageState?.url)
  );
}

async function waitForStep4VerificationAdvanceSignal(step, options = {}) {
  const {
    timeoutMs = 15000,
    intervalMs = 1000,
    shouldStop = () => false,
  } = options;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) {
      return null;
    }

    const pageState = await getSignupAuthPageStateForRecoveryMonitor();
    if (isStep4VerificationAdvanceState(pageState)) {
      if (shouldStop()) {
        return null;
      }
      await addLog(
        `第 ${step} 步：检测到验证码提交流程后页面已进入资料页/创建成功页，提前按第 4 步成功处理。 | 调试：URL=${pageState?.url || 'unknown'}; profile=${Boolean(pageState?.hasVisibleProfileFormInput)}; readyProfile=${Boolean(pageState?.hasReadyProfilePage)}`,
        'info'
      );
      return {
        accepted: true,
        reason: 'step4-page-advance-signal',
        url: pageState?.url || '',
      };
    }
    await sleepWithStop(intervalMs);
  }

  return null;
}

async function waitForStep4SlowCodeFillRecovery(step, code, options = {}) {
  const {
    delayMs = 4000,
    shouldStop = () => false,
  } = options;

  await sleepWithStop(delayMs);
  if (shouldStop()) {
    return null;
  }

  const pageState = await getSignupAuthPageStateForRecoveryMonitor();
  if (shouldStop()) {
    return null;
  }

  const stillOnVerificationPage = Boolean(
    pageState?.hasReadyVerificationPage
    || pageState?.hasVisibleVerificationInput
    || isCanonicalEmailVerificationUrl(pageState?.url)
  );

  if (!stillOnVerificationPage) {
    return null;
  }

  await addLog(
    `第 ${step} 步：验证码已拿到，但 auth 验证页暂时没有开始响应，先直接在当前页补填一次验证码。 | 调试：URL=${pageState?.url || 'unknown'}; verification=${Boolean(pageState?.hasVisibleVerificationInput)}; readyVerification=${Boolean(pageState?.hasReadyVerificationPage)}`,
    'warn'
  );

  const directRetryResult = await tryDirectVerificationCodeFillOnCurrentSignupPage(step, code);
  if (directRetryResult?.accepted || directRetryResult?.retryInbox) {
    return directRetryResult;
  }

  return null;
}

async function getSignupPageFallbackAuthState() {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    return null;
  }

  const signupTab = await chrome.tabs.get(signupTabId).catch(() => null);
  const signupUrl = String(signupTab?.url || '').trim();
  if (!signupUrl) {
    return null;
  }

  if (isCanonicalEmailVerificationUrl(signupUrl)) {
    return {
      isReachable: true,
      requiresPhoneVerification: false,
      hasUnsupportedEmail: false,
      hasFatalError: false,
      hasAuthOperationTimedOut: false,
      hasVisibleCredentialInput: false,
      hasVisibleSignupRegistrationChoice: false,
      hasVisibleVerificationInput: false,
      hasVisibleProfileFormInput: false,
      hasReadyVerificationPage: true,
      hasReadyProfilePage: false,
      url: signupUrl,
    };
  }

  if (isCanonicalAboutYouUrl(signupUrl)) {
    return {
      isReachable: true,
      requiresPhoneVerification: false,
      hasUnsupportedEmail: false,
      hasFatalError: false,
      hasAuthOperationTimedOut: false,
      hasVisibleCredentialInput: false,
      hasVisibleSignupRegistrationChoice: false,
      hasVisibleVerificationInput: false,
      hasVisibleProfileFormInput: false,
      hasReadyVerificationPage: false,
      hasReadyProfilePage: true,
      url: signupUrl,
    };
  }

  if (!isStableStep5SuccessUrl(signupUrl)) {
    return null;
  }

  return {
    isReachable: true,
    requiresPhoneVerification: false,
    hasUnsupportedEmail: false,
    hasFatalError: false,
    hasAuthOperationTimedOut: false,
    hasVisibleCredentialInput: false,
    hasVisibleSignupRegistrationChoice: false,
    hasVisibleVerificationInput: false,
    hasVisibleProfileFormInput: false,
    hasReadyVerificationPage: false,
    hasReadyProfilePage: false,
    url: signupUrl,
  };
}

async function getSignupAuthPageStateForRecoveryMonitor() {
  const fallbackState = await getSignupPageFallbackAuthState().catch(() => null);
  if (fallbackState) {
    return fallbackState;
  }

  return await getSignupAuthPageState().catch(() => null);
}

function isCanonicalAboutYouUrl(url = '') {
  return /(?:auth|accounts)\.openai\.com\/about-you/i.test(String(url || ''));
}

async function waitForStep5AuthStateToSettle(timeoutMs = 12000) {
  const start = Date.now();
  let lastPageState = null;

  while (Date.now() - start < timeoutMs) {
    const pageState = await getSignupAuthPageState();
    lastPageState = pageState;

    if (pageState?.isReachable === false) {
      await sleepWithStop(250);
      continue;
    }

    return pageState;
  }

  return lastPageState || {
    isReachable: false,
    requiresPhoneVerification: false,
    hasUnsupportedEmail: false,
    hasFatalError: false,
    hasAuthOperationTimedOut: false,
    hasVisibleCredentialInput: false,
    hasVisibleSignupRegistrationChoice: false,
    hasVisibleVerificationInput: false,
    hasVisibleProfileFormInput: false,
    hasReadyVerificationPage: false,
    hasReadyProfilePage: false,
    url: '',
  };
}

async function validateStep5CompletionBeforeAcceptingSuccess(payload = {}) {
  if (payload?.skippedProfileForm) {
    return;
  }

  const pageState = await waitForStep5AuthStateToSettle();
  if (!pageState?.isReachable) {
    throw new Error('Step 5 blocked: auth page did not become reachable again after profile submit.');
  }

  if (pageState?.hasUnsupportedEmail) {
    throw new Error('Step 5 blocked: email domain is unsupported on the auth page.');
  }

  if (pageState?.hasFatalError) {
    throw new Error('Auth fatal error page detected after profile submit.');
  }

  if (
    pageState?.hasReadyProfilePage
    || pageState?.hasVisibleProfileFormInput
    || isCanonicalAboutYouUrl(pageState?.url)
  ) {
    throw new Error(`Step 5 blocked: profile submit did not reach a stable next page. URL: ${pageState?.url || 'unknown'}`);
  }
}

function getVerificationMailStepPollingBlocker(step, pageState = {}) {
  if (pageState?.requiresPhoneVerification) {
    return `Step ${step} blocked: auth page requires phone verification before the verification email step.`;
  }

  if (pageState?.hasUnsupportedEmail) {
    return `Step ${step} blocked: email domain is unsupported on the auth page.`;
  }

  return '';
}

async function assertVerificationMailStepNotBlockedDuringPolling(step) {
  const pageState = await getSignupAuthPageState();
  const blockerMessage = getVerificationMailStepPollingBlocker(step, pageState);
  if (blockerMessage) {
    throw new Error(blockerMessage);
  }
  return pageState;
}

async function ensureSignupPageReadyForVerification(state, step = 4) {
  const start = Date.now();
  const timeoutMs = 10000;
  let refreshedOauthAfterTimeout = false;
  let hasLoggedAmbiguousPageWait = false;
  let hasLoggedUnreachableWait = false;
  let hasLoggedStableLandingWait = false;
  let hasLoggedVerificationShortcutWait = false;
  let consecutiveVerificationShortcutSignals = 0;
  let lastPageState = null;

  while (Date.now() - start < timeoutMs) {
    const pageState = await getSignupAuthPageState();
    lastPageState = pageState;

    if (pageState?.isReachable === false) {
      if (!hasLoggedUnreachableWait) {
        hasLoggedUnreachableWait = true;
        await addLog(
          `Step ${step}: Signup auth page is temporarily unreachable. Waiting for the verification page to become responsive before polling the inbox...`,
          'warn'
        );
      }
      await sleepWithStop(1000);
      continue;
    }

    if (pageState?.hasAuthOperationTimedOut) {
      if (refreshedOauthAfterTimeout) {
        throw new Error('Step 4 blocked: signup auth page timed out again after refreshing the VPS OAuth link.');
      }

      await addLog(
        `第 ${step} 步：验证码邮件阶段前 auth 页面先超时了，正在刷新 VPS OAuth 链接并重放第 3 步。`,
        'warn'
      );
      refreshedOauthAfterTimeout = true;
      await recoverStep3OauthTimeout();
      await executeStepAndWait(3, getStepDelayAfter(3), true);
      state = await getState();
      continue;
    }

    if (pageState?.hasFatalError) {
      throw new Error(`Step ${step} blocked: auth page showed a fatal error before the verification email step.`);
    }

    const blockerMessage = getVerificationMailStepPollingBlocker(step, pageState);
    if (blockerMessage) {
      throw new Error(blockerMessage);
    }

    if (isStableStep5SuccessUrl(pageState?.url)) {
      if (!hasLoggedStableLandingWait) {
        hasLoggedStableLandingWait = true;
        await addLog(
          `第 ${step} 步：当前页面已经到达 https://platform.openai.com/welcome?step=create，跳过额外 auth 等待，直接继续查收邮件。 | 调试：URL=${pageState?.url || 'unknown'}`,
          'info'
        );
      }
      return state;
    }

    if (pageState?.hasReadyVerificationPage || pageState?.hasReadyProfilePage) {
      return state;
    }

    const hasVerificationShortcutSignal = Boolean(
      isCanonicalEmailVerificationUrl(pageState?.url)
      || pageState?.hasVisibleVerificationInput
    );
    consecutiveVerificationShortcutSignals = hasVerificationShortcutSignal
      ? consecutiveVerificationShortcutSignals + 1
      : 0;
    if (consecutiveVerificationShortcutSignals >= 2) {
      if (!hasLoggedVerificationShortcutWait) {
        hasLoggedVerificationShortcutWait = true;
        await addLog(
          `第 ${step} 步：当前页面已连续两次显示 email-verification 或验证码输入框，直接开始查收邮件。 | 调试：URL=${pageState?.url || 'unknown'}; verification=${Boolean(pageState?.hasVisibleVerificationInput)}; readyVerification=${Boolean(pageState?.hasReadyVerificationPage)}`,
          'info'
        );
      }
      return state;
    }

    if (pageState?.hasVisibleCredentialInput) {
      consecutiveVerificationShortcutSignals = 0;
      await addLog(`Step ${step}: Signup page is still on the credential form. Waiting before checking the inbox...`, 'info');
      await sleepWithStop(1000);
      continue;
    }

    if (pageState?.hasVisibleVerificationInput || pageState?.hasVisibleProfileFormInput) {
      if (!hasLoggedAmbiguousPageWait) {
        hasLoggedAmbiguousPageWait = true;
        await addLog(
          `Step ${step}: Auth page shows verification/profile inputs, but the surrounding page copy is not stable yet. Waiting for stronger page signals before checking the inbox...`,
          'info'
        );
      }
      await sleepWithStop(1000);
      continue;
    }

    return state;
  }

  await addLog(
    `第 ${step} 步：等待开始查收邮件前，signup auth 页面状态检查超时。URL=${lastPageState?.url || 'unknown'}; credential=${Boolean(lastPageState?.hasVisibleCredentialInput)}; verification=${Boolean(lastPageState?.hasVisibleVerificationInput)}; profile=${Boolean(lastPageState?.hasVisibleProfileFormInput)}; readyVerification=${Boolean(lastPageState?.hasReadyVerificationPage)}; readyProfile=${Boolean(lastPageState?.hasReadyProfilePage)}; fatal=${Boolean(lastPageState?.hasFatalError)}; phone=${Boolean(lastPageState?.requiresPhoneVerification)}.`,
    'warn'
  );
  if (lastPageState?.isReachable === false) {
    throw new Error(`Step ${step} blocked: signup auth page stayed unreachable before the verification email step.`);
  }
  throw new Error(`Step ${step} blocked: signup page never advanced past the credential form, so the verification email was probably not sent.`);
}

async function executeVerificationMailStep(step, state, options) {
  const {
    filterAfterTimestamp = 0,
    senderFilters,
    subjectFilters,
    resendAfterAttempts = 3,
    persistLastEmailTimestamp = false,
  } = options;

  const baseMail = getMailConfig(state);
  const mail = {
    ...baseMail,
    url: getMailTabOpenUrlForStep({
      step,
      mailSource: baseMail.source,
      defaultUrl: baseMail.url,
    }),
  };
  if (mail.error) throw new Error(mail.error);
  const useTmailorApiMailboxOnly = shouldUseTmailorApiMailboxOnly({
    mailSource: mail.source,
    accessToken: state.tmailorAccessToken,
  });
  if (useTmailorApiMailboxOnly) {
    await addLog(`Step ${step}: ${getTmailorApiOnlyPollingMessage(state.email)}`, 'info');
  } else {
    await addLog(`Step ${step}: Opening ${mail.label}...`);
    await ensureMailTabReady(mail, {
      navigateIfUrlDiff: shouldNavigateMailTabOnStepStart({
        step,
        mailSource: mail.source,
      }),
    });
  }

  const rejectedCodes = new Set(getRejectedVerificationCodesForStep(step, state));
  let currentFilterAfterTimestamp = filterAfterTimestamp;
  const maxInboxChecks = 4;
  let resendTriggered = false;

  for (let inboxCheck = 1; inboxCheck <= maxInboxChecks; inboxCheck++) {
    if (inboxCheck > 1) {
      await addLog(`Step ${step}: Still checking the inbox for a fresh verification email...`, 'info');
    }

    let result = null;

    try {
      result = await pollVerificationCodeFromMail(step, mail, {
        filterAfterTimestamp: currentFilterAfterTimestamp,
        senderFilters,
        subjectFilters,
        targetEmail: state.email,
        excludeCodes: step === 7
          ? mergeLoginVerificationCodeExclusions({
            signupCode: state.lastSignupVerificationCode,
            rejectedCodes: [...rejectedCodes],
          })
          : [...rejectedCodes],
        maxAttempts: 20,
        intervalMs: 3000,
      });
    } catch (err) {
      const errorMessage = err?.message || '';
      const noMailFound = /No matching verification email found/i.test(errorMessage);

      if (!noMailFound) {
        throw err;
      }

      const pageState = await getSignupAuthPageState();
      const blockerMessage = getVerificationMailStepPollingBlocker(step, pageState);
      if (blockerMessage) {
        throw new Error(blockerMessage);
      }

      if (!resendTriggered && inboxCheck >= resendAfterAttempts) {
        await addLog(`第 ${step} 步：连续检查 ${inboxCheck} 次仍没有新邮件，先触发一次重发，再继续检查。`, 'warn');
        await clickResendOnSignupPage(step);
        resendTriggered = true;
        continue;
      }

      if (inboxCheck >= maxInboxChecks) {
        throw err;
      }

      continue;
    }

    if (result.emailTimestamp) {
      currentFilterAfterTimestamp = Math.max(currentFilterAfterTimestamp || 0, result.emailTimestamp);
      if (persistLastEmailTimestamp) {
        await setState({ lastEmailTimestamp: result.emailTimestamp });
      }
    }

    await addLog(`Step ${step}: Got verification code: ${result.code}`);
    const submitResult = await submitVerificationCode(step, result.code);

    if (submitResult?.retryInbox) {
      rejectedCodes.add(result.code);
      await rememberRejectedVerificationCode(step, result.code);
      continue;
    }

    if (step === 4) {
      await clearRejectedVerificationCodes(step);
      await setState({ lastSignupVerificationCode: result.code });
    } else if (step >= 7) {
      await clearRejectedVerificationCodes(step);
    }

    if (submitResult?.accepted) {
      const currentState = await getState();
      if (currentState?.stepStatuses?.[step] !== 'completed') {
        const backgroundCompletionPayload = {
          backgroundVerifiedCompletion: true,
          reason: submitResult.reason || '',
          url: submitResult.url || '',
        };
        if (result.emailTimestamp) {
          backgroundCompletionPayload.emailTimestamp = result.emailTimestamp;
        }
        await setStepStatus(step, 'completed');
        await addLog(`第 ${step} 步已完成`, 'ok');
        await handleStepData(step, backgroundCompletionPayload);
        notifyStepComplete(step, backgroundCompletionPayload);
      }
    }

    return;
  }

  throw new Error(`Step ${step}: Verification code kept being rejected after ${maxInboxChecks} inbox refresh attempts.`);
}

async function executeStep4(state) {
  if (state.existingAccountLogin) {
    await addLog(
      'Step 4: Signup verification is not needed because step 3 already identified an existing-account login flow. Skipping inbox polling and keeping the current email/password for step 6...',
      'warn'
    );
    await setStepStatus(4, 'completed');
    notifyStepComplete(4, { skippedExistingAccountLogin: true });
    return;
  }

  const effectiveState = await ensureSignupPageReadyForVerification(state, 4);
  await executeVerificationMailStep(4, effectiveState, {
    filterAfterTimestamp: effectiveState.flowStartTime || 0,
    ...getTmailorVerificationProfile(4),
    resendAfterAttempts: 3,
    persistLastEmailTimestamp: true,
  });
}

async function ensureSignupPageReadyForProfile(state, step = 5) {
  const start = Date.now();
  const timeoutMs = 15000;
  let hasLoggedVerificationWait = false;
  let hasLoggedAmbiguousProfileWait = false;
  let hasLoggedProfileShortcut = false;
  let consecutiveProfileShortcutSignals = 0;
  let lastPageState = null;

  while (Date.now() - start < timeoutMs) {
    const pageState = await getSignupAuthPageState();
    lastPageState = pageState;

    if (pageState?.hasFatalError) {
      throw new Error(`Step ${step} blocked: auth page showed a fatal error before profile completion.`);
    }

    if (pageState?.requiresPhoneVerification) {
      throw new Error(`Step ${step} blocked: auth page requires phone verification before profile completion.`);
    }

    if (isStableStep5SuccessUrl(pageState?.url)) {
      return { ...state, ...pageState };
    }

    if (pageState?.hasReadyProfilePage) {
      return { ...state, ...pageState };
    }

    const hasProfileShortcutSignal = Boolean(
      isCanonicalAboutYouUrl(pageState?.url)
      && pageState?.hasVisibleProfileFormInput
    );
    consecutiveProfileShortcutSignals = hasProfileShortcutSignal
      ? consecutiveProfileShortcutSignals + 1
      : 0;
    if (consecutiveProfileShortcutSignals >= 2) {
      if (!hasLoggedProfileShortcut) {
        hasLoggedProfileShortcut = true;
        await addLog(
          `第 ${step} 步：当前页面已进入 about-you 资料页，且输入框已连续两次可见，直接开始填写资料。 | 调试：URL=${pageState?.url || 'unknown'}; profile=${Boolean(pageState?.hasVisibleProfileFormInput)}; readyProfile=${Boolean(pageState?.hasReadyProfilePage)}`,
          'info'
        );
      }
      return { ...state, ...pageState };
    }

    if (pageState?.hasReadyVerificationPage || pageState?.hasVisibleVerificationInput) {
      consecutiveProfileShortcutSignals = 0;
      if (!hasLoggedVerificationWait) {
        hasLoggedVerificationWait = true;
        await addLog(
          `Step ${step}: Verification page is still settling after step 4. Waiting for the profile form before filling name data...`,
          'info'
        );
      }
      await sleepWithStop(1000);
      continue;
    }

    if (pageState?.hasVisibleProfileFormInput) {
      if (!hasLoggedAmbiguousProfileWait) {
        hasLoggedAmbiguousProfileWait = true;
        await addLog(
          `Step ${step}: Profile inputs are present, but the page copy still looks transitional. Waiting for the final profile page before filling name data...`,
          'info'
        );
      }
      await sleepWithStop(1000);
      continue;
    }

    return { ...state, ...pageState };
  }

  if (lastPageState?.hasReadyVerificationPage || lastPageState?.hasVisibleVerificationInput) {
    await addLog(
      `Step ${step}: Verification page was still visible after waiting ${Math.round(timeoutMs / 1000)}s. Falling back to the existing profile-form detection flow...`,
      'warn'
    );
  }

  return { ...state, ...(lastPageState || {}) };
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  if (state.existingAccountLogin) {
    await addLog(
      'Step 5: Skipping profile completion because step 3 already identified an existing-account login flow.',
      'warn'
    );
    await setStepStatus(5, 'completed');
    notifyStepComplete(5, { skippedExistingAccountLogin: true });
    return;
  }

  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();
  const profileReadyState = await ensureSignupPageReadyForProfile(state, 5);

  if (isStableStep5SuccessUrl(profileReadyState?.url)) {
    const payload = {
      skippedProfileForm: true,
      recoveredFromWelcomeLanding: true,
      url: profileReadyState?.url || '',
    };
    await addLog(
      `第 5 步：当前页面已经到达 https://platform.openai.com/welcome?step=create，直接视为资料页已完成。 | 调试：URL=${profileReadyState?.url || 'unknown'}`,
      'warn'
    );
    await setStepStatus(5, 'completed');
    await handleStepData(5, payload);
    notifyStepComplete(5, payload);
    return;
  }

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  try {
    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 5,
      source: 'background',
      payload: { firstName, lastName, year, month, day },
    });
  } catch (err) {
    const errorMessage = err?.message || String(err || '');
    if (isMessageChannelClosedError(errorMessage) || isReceivingEndMissingError(errorMessage)) {
      await addLog(
        'Step 5: Signup page navigated before the step-5 response returned. Continuing to wait for completion signal...',
        'warn'
      );
      await waitForStep5CompletionSignalOrRecoveredAuthState();
      return;
    }
    throw err;
  }
}

async function recoverStep5ProfilePage(error, options = {}) {
  const message = error?.message || String(error || 'unknown step 5 error');
  const attempt = Math.max(0, Number.parseInt(String(options?.attempt ?? 0), 10) || 0);
  const maxAttempts = Math.max(attempt, Number.parseInt(String(options?.maxAttempts ?? 0), 10) || 0);
  const retryLabel = attempt > 0 && maxAttempts > 0
    ? ` (retry ${attempt}/${maxAttempts})`
    : attempt > 0
      ? ` (retry ${attempt})`
      : '';
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw error;
  }

  const signupTab = await chrome.tabs.get(signupTabId).catch(() => null);
  if (!signupTab?.url) {
    throw error;
  }

  await addLog(
    `Step 5: ${message} Reloading the current signup profile page and retrying step 5${retryLabel}...`,
    'warn'
  );
  await reuseOrCreateTab('signup-page', signupTab.url, {
    reloadIfSameUrl: true,
  });
}

async function waitForStep5CompletionSignalOrRecoveredAuthState() {
  const timeoutMs = 15000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const currentState = await getState();
    const currentStepStatus = currentState?.stepStatuses?.[5];

    if (currentStepStatus === 'completed' || currentStepStatus === 'failed' || currentStepStatus === 'stopped') {
      return;
    }

    const pageState = await getSignupAuthPageState();
    const advancedPastProfileForm = Boolean(
      isStableStep5SuccessUrl(pageState?.url)
      || (
        pageState?.url
        && !pageState?.hasVisibleProfileFormInput
        && !pageState?.hasReadyProfilePage
        && !isCanonicalAboutYouUrl(pageState?.url)
        && !pageState?.hasUnsupportedEmail
        && !pageState?.hasFatalError
      )
    );

    if (advancedPastProfileForm) {
      const payload = { recoveredAfterNavigation: true };
      // https://platform.openai.com/welcome?step=create is a stable post-profile landing page.
      await addLog(
        'Step 5: Auth page already advanced beyond the profile form after the navigation interrupt. Completing the step from the background fallback. Treating https://platform.openai.com/welcome?step=create as a stable post-profile landing page.',
        'warn'
      );
      await setStepStatus(5, 'completed');
      await handleStepData(5, payload);
      notifyStepComplete(5, { recoveredAfterNavigation: true });
      return;
    }

    await sleepWithStop(250);
  }
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function fetchFreshOauthUrlFromVps(state, options = {}) {
  const {
    logStep = 1,
    reason = 'Refreshing the VPS OAuth link...',
  } = options;

  if (!state.vpsUrl) {
    throw new Error('No VPS URL configured. Enter VPS address in Side Panel first.');
  }

  await addLog(`Step ${logStep}: ${reason}`, 'info');
  await reuseOrCreateTab('vps-panel', state.vpsUrl, {
    inject: ['shared/flow-recovery.js', 'content/utils.js', 'content/vps-panel.js'],
    reloadIfSameUrl: true,
  });

  const refreshResult = await sendToContentScript('vps-panel', {
    type: 'FETCH_OAUTH_URL',
    source: 'background',
    payload: { logStep },
  });

  const oauthUrl = String(refreshResult?.oauthUrl || '').trim();
  if (!oauthUrl) {
    throw new Error('VPS panel did not return a usable OAuth URL.');
  }

  await setState({ oauthUrl });
  broadcastDataUpdate({ oauthUrl });

  const latestState = await getState();
  return {
    ...latestState,
    oauthUrl,
  };
}

async function refreshOauthUrlBeforeStep6(state, reason = 'Refreshing the VPS OAuth link before login...') {
  return await fetchFreshOauthUrlFromVps(state, {
    logStep: 6,
    reason,
  });
}

async function recoverStep3OauthTimeout() {
  const state = await getState();
  await addLog(
    'Step 3: The signup page timed out before credentials could be submitted. Reopening the platform login page and retrying with the current email/password...',
    'warn'
  );

  const waitForSignupPage = waitForStepComplete(2, 120000);
  await executeStep2(state, { preferSignupEntry: true });
  await waitForSignupPage;
}

async function recoverStep3PlatformLogin(error, options = {}) {
  const state = await getState();
  const message = error?.message || String(error || 'unknown step 3 error');
  const attempt = Math.max(0, Number.parseInt(String(options?.attempt ?? 0), 10) || 0);
  const maxAttempts = Math.max(attempt, Number.parseInt(String(options?.maxAttempts ?? 0), 10) || 0);
  const retryLabel = attempt > 0 && maxAttempts > 0
    ? ` (retry ${attempt}/${maxAttempts})`
    : '';
  await addLog(
    `Step 3: ${message} Reopening the platform login page${retryLabel} and retrying with the current email/password...`,
    'warn'
  );

  const waitForSignupPage = waitForStepComplete(2, 120000);
  await executeStep2(state, { preferSignupEntry: true });
  await waitForSignupPage;
}

async function recoverStep6PlatformLogin(error, options = {}) {
  const state = await getState();
  const message = error?.message || String(error || 'unknown step 6 error');
  const attempt = Math.max(0, Number.parseInt(String(options?.attempt ?? 0), 10) || 0);
  const maxAttempts = Math.max(attempt, Number.parseInt(String(options?.maxAttempts ?? 0), 10) || 0);
  const retryLabel = attempt > 0 && maxAttempts > 0
    ? ` (retry ${attempt}/${maxAttempts})`
    : attempt > 0
      ? ` (retry ${attempt})`
      : '';
  const refreshCopy = 'Refreshing the VPS OAuth link and reopening the auth login page';
  await addLog(
    `Step 6: ${message} ${refreshCopy}${retryLabel} with the current email/password...`,
    'warn'
  );

  const refreshedState = await refreshOauthUrlBeforeStep6(
    state,
    'Refreshing the VPS OAuth link because the auth login page stalled before completion...'
  );
  if (!refreshedState.oauthUrl) {
    throw error;
  }

  await reuseOrCreateTab('signup-page', refreshedState.oauthUrl, {
    reuseActiveTabOnCreate: true,
    reloadIfSameUrl: true,
  });
}

async function executeStep6(state) {
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  const effectiveState = await refreshOauthUrlBeforeStep6(
    state,
    manualRunActive
      ? 'Manual run detected. Refreshing the VPS OAuth link before login...'
      : 'Refreshing the VPS OAuth link before login so the auth session stays fresh...'
  );

  if (!effectiveState.oauthUrl) {
    throw new Error('No OAuth URL is available for login. Refresh the VPS OAuth link and retry step 6.');
  }

  const effectivePassword = effectiveState.customPassword || effectiveState.password || '';

  await addLog(`Step 6: Opening OAuth URL for login...`);
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', effectiveState.oauthUrl, {
    reuseActiveTabOnCreate: true,
    reloadIfSameUrl: true,
  });

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  try {
    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 6,
      source: 'background',
      payload: { email: effectiveState.email, password: effectivePassword },
    });
  } catch (err) {
    const errorMessage = err?.message || String(err || '');
    if (isMessageChannelClosedError(errorMessage) || isReceivingEndMissingError(errorMessage)) {
      await addLog(
        'Step 6: Auth page navigated before the step-6 response returned. Continuing to wait for completion signal...',
        'warn'
      );
      await waitForStep6CompletionSignalOrRecoveredAuthState();
      return;
    }
    throw err;
  }
}

async function waitForStep6CompletionSignalOrRecoveredAuthState() {
  const timeoutMs = 15000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const currentState = await getState();
    const currentStepStatus = currentState?.stepStatuses?.[6];

    if (currentStepStatus === 'completed' || currentStepStatus === 'failed' || currentStepStatus === 'stopped') {
      return;
    }

    const signupTabId = await getTabId('signup-page');
    if (signupTabId) {
      try {
        const tab = await chrome.tabs.get(signupTabId);
        if (isLocalhostCallbackUrl(tab?.url)) {
          await addLog(
            'Step 6: Auth flow already redirected to localhost after the navigation interrupt. Completing the step from the background fallback.',
            'warn'
          );
          await setState({ localhostUrl: tab.url });
          broadcastDataUpdate({ localhostUrl: tab.url });
          await setStepStatus(6, 'completed');
          notifyStepComplete(6, {
            recoveredAfterNavigation: true,
            localhostUrl: tab.url,
          });
          return;
        }
      } catch {}
    }

    const pageState = await getSignupAuthPageState();
    const advancedPastLoginForm = Boolean(
      pageState?.hasVisibleVerificationInput
      || pageState?.hasReadyVerificationPage
      || (
        pageState?.url
        && !pageState?.hasVisibleCredentialInput
        && !isExistingAccountLoginPasswordPageUrl(pageState?.url)
        && !pageState?.requiresPhoneVerification
        && !pageState?.hasFatalError
        && !pageState?.hasAuthOperationTimedOut
      )
    );

    if (advancedPastLoginForm) {
      const payload = { recoveredAfterNavigation: true };
      await addLog(
        'Step 6: Auth page already advanced beyond the login form after the navigation interrupt. Completing the step from the background fallback.',
        'warn'
      );
      await setStepStatus(6, 'completed');
      notifyStepComplete(6, payload);
      return;
    }

    await sleepWithStop(250);
  }
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  const effectiveState = await ensureSignupPageReadyForVerification(state, 7);
  await executeVerificationMailStep(7, effectiveState, {
    filterAfterTimestamp: effectiveState.lastEmailTimestamp || effectiveState.flowStartTime || 0,
    ...getTmailorVerificationProfile(7),
    resendAfterAttempts: 3,
    persistLastEmailTimestamp: false,
  });
}

async function inspectSignupPageRecoveryState(expectedUrl) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    return {
      reason: '',
      url: '',
      title: '',
    };
  }

  try {
    const tab = await chrome.tabs.get(signupTabId);
    return {
      reason: getStep6RecoveryReasonForUnexpectedAuthPage({
        currentUrl: tab?.url,
        currentPageText: tab?.title,
        expectedUrl,
      }),
      url: tab?.url || '',
      title: tab?.title || '',
    };
  } catch {
    return {
      reason: '',
      url: '',
      title: '',
    };
  }
}

function buildStep8RecoveryErrorMessage(reason, context = {}) {
  const locationLabel = context.url || context.title || 'unknown page';
  return `Step 8 recoverable: auth flow landed on an unexpected page before localhost redirect (${reason}). Refresh the VPS OAuth link and retry with the same email and password. Current page: ${locationLabel}`;
}

async function retryStep8ConsentClickIfStillVisible(signupTabId, {
  currentUrl = '',
  elapsedMs = 0,
} = {}) {
  if (!signupTabId || !/auth\.openai\.com\/sign-in-with-chatgpt\/.+\/consent/i.test(String(currentUrl || ''))) {
    return false;
  }

  let clickResult = null;
  try {
    clickResult = await sendToContentScript('signup-page', {
      type: 'STEP8_FIND_AND_CLICK',
      source: 'background',
      payload: {},
    });
  } catch (err) {
    const message = err?.message || '';
    if (isMessageChannelClosedError(message) || isReceivingEndMissingError(message)) {
      return false;
    }
    throw err;
  }

  if (clickResult?.error) {
    return false;
  }

  if (!clickResult?.rect) {
    return false;
  }

  const seconds = Math.max(1, Math.round(Math.max(0, Number(elapsedMs) || 0) / 1000));
  if (clickResult?.hitTargetBlocked || elapsedMs >= 20000) {
    const submitFallbackUsed = await tryStep8ConsentSubmitFallback(signupTabId, {
      currentUrl,
      elapsedMs,
      hitTargetDescription: clickResult?.hitTargetDescription || '',
      triggeredByBlockedHitTarget: Boolean(clickResult?.hitTargetBlocked),
    });
    if (submitFallbackUsed) {
      return true;
    }
  }

  await addLog(
    `第 8 步：心跳检查时发现授权同意页在 ${seconds}s 后仍然可见，准备再次点击“继续”。`,
    'warn'
  );
  await clickWithDebugger(signupTabId, clickResult.rect);
  await addLog('Step 8: Heartbeat retry click dispatched, waiting for redirect...', 'info');
  return true;
}

async function tryStep8ConsentSubmitFallback(signupTabId, {
  currentUrl = '',
  elapsedMs = 0,
  hitTargetDescription = '',
  triggeredByBlockedHitTarget = false,
} = {}) {
  if (!signupTabId || !/auth\.openai\.com\/sign-in-with-chatgpt\/.+\/consent/i.test(String(currentUrl || ''))) {
    return false;
  }

  let submitResult = null;
  try {
    submitResult = await sendToContentScript('signup-page', {
      type: 'STEP8_TRY_SUBMIT',
      source: 'background',
      payload: {},
    });
  } catch (err) {
    const message = err?.message || '';
    if (isMessageChannelClosedError(message) || isReceivingEndMissingError(message)) {
      return false;
    }
    throw err;
  }

  if (!submitResult?.usedFallbackSubmit) {
    return false;
  }

  const seconds = Math.max(1, Math.round(Math.max(0, Number(elapsedMs) || 0) / 1000));
  const reasonSuffix = triggeredByBlockedHitTarget && hitTargetDescription
    ? ` because the consent button click point is covered by ${hitTargetDescription}`
    : '';
  await addLog(
    `第 8 步：心跳检查时发现授权同意页在 ${seconds}s 后仍然可见${reasonSuffix}，先尝试页内提交兜底，再决定是否继续走 debugger 点击。`,
    'warn'
  );
  await addLog(
    `Step 8: In-page consent submit fallback dispatched via ${submitResult.submitMethod || 'unknown method'}, waiting for redirect...`,
    'info'
  );
  return true;
}

async function replaySteps6Through8WithCurrentAccount(logMessage, recoveryState = {}) {
  return await replaySteps6ThroughTargetStepWithCurrentAccount(8, logMessage, {
    ...recoveryState,
    step8UnexpectedRedirect: true,
  });
}

async function replaySteps6ThroughTargetStepWithCurrentAccount(targetStep, logMessage, recoveryState = {}) {
  targetStep = Math.max(6, Number.parseInt(String(targetStep ?? '').trim(), 10) || 6);
  await addLog(logMessage, 'warn');
  await setState({ localhostUrl: null });
  broadcastDataUpdate({ localhostUrl: null });

  await executeStepAndWait(6, 2000);
  for (let replayStep = 7; replayStep <= targetStep; replayStep++) {
    await executeStepAndWait(
      replayStep,
      replayStep === 8 ? 1000 : 2000,
      replayStep === targetStep ? recoveryState : false
    );
  }

  return await getState();
}

// ============================================================
// Step 8: Complete OAuth (auto click + localhost listener)
// ============================================================

let webNavListener = null;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 6 first.');
  }

  const preflightRecoveryState = await inspectSignupPageRecoveryState(state.oauthUrl);
  if (preflightRecoveryState.reason === 'auth_server_error' || preflightRecoveryState.reason === 'unexpected_auth_redirect') {
    throw new Error(buildStep8RecoveryErrorMessage(preflightRecoveryState.reason, preflightRecoveryState));
  }

  // Check if the signup tab already redirected to localhost before listener setup
  const signupTabIdEarly = await getTabId('signup-page');
  if (signupTabIdEarly) {
    try {
      const tab = await chrome.tabs.get(signupTabIdEarly);
      if (tab.url && (tab.url.startsWith('http://localhost') || tab.url.startsWith('http://127.0.0.1'))) {
        await addLog(`第 8 步：已提前捕获到 localhost 回调：${tab.url}`, 'ok');
        await setState({ localhostUrl: tab.url });
        broadcastDataUpdate({ localhostUrl: tab.url });
        return;
      }
    } catch {}
  }

  await addLog('Step 8: Setting up localhost redirect listener...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let resolved = false;

    const isLocalhostUrl = (url) =>
      url && (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1'));

    const cleanupListeners = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        chrome.webNavigation.onCommitted.removeListener(webNavListener);
        chrome.webNavigation.onErrorOccurred.removeListener(webNavListener);
        webNavListener = null;
      }
    };

    const captureLocalhostUrl = (url) => {
      if (resolved) return;
      resolved = true;
      cleanupListeners();
      clearTimeout(timeout);
      setState({ localhostUrl: url }).then(() => {
        addLog(`第 8 步：已捕获 localhost 回调地址：${url}`, 'ok');
        setStepStatus(8, 'completed');
        notifyStepComplete(8, { localhostUrl: url });
        broadcastDataUpdate({ localhostUrl: url });
        resolve();
      });
    };

    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error('Localhost redirect not captured after 120s. Step 8 click may have been blocked.'));
    }, 120000);

    webNavListener = (details) => {
      if (details.frameId === 0 && isLocalhostUrl(details.url)) {
        console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
        captureLocalhostUrl(details.url);
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);
    chrome.webNavigation.onCommitted.addListener(webNavListener);
    chrome.webNavigation.onErrorOccurred.addListener(webNavListener);

    // After step 7, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We locate the button in-page, then click it through
    // the debugger Input API directly.
    (async () => {
      try {
        let signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('Step 8: Switched to auth page. Preparing debugger click...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('Step 8: Auth tab reopened. Preparing debugger click...');
        }

        const clickResult = await sendToContentScript('signup-page', {
          type: 'STEP8_FIND_AND_CLICK',
          source: 'background',
          payload: {},
        });

        if (clickResult?.error) {
          throw new Error(clickResult.error);
        }

        if (!resolved) {
          let dispatchedInitialSubmitFallback = false;
          if (clickResult?.hitTargetBlocked) {
            await addLog(
              `Step 8: Consent continue button is visible, but its click point is currently covered by ${clickResult.hitTargetDescription || 'another element'}. Trying an in-page submit fallback before the debugger click...`,
              'warn'
            );
            dispatchedInitialSubmitFallback = await tryStep8ConsentSubmitFallback(signupTabId, {
              currentUrl: clickResult?.url || state.oauthUrl,
              elapsedMs: 0,
              hitTargetDescription: clickResult?.hitTargetDescription || '',
              triggeredByBlockedHitTarget: true,
            });
          }

          if (!dispatchedInitialSubmitFallback) {
            await clickWithDebugger(signupTabId, clickResult?.rect);
            await addLog('Step 8: Debugger click dispatched, waiting for redirect...');
          }

          // Fallback: poll tab URL in case webNavigation listeners missed the redirect
          let unexpectedRedirectHits = 0;
          let lastHeartbeatElapsedMs = 0;
          const redirectWaitStartedAt = Date.now();
          for (let i = 0; i < 30 && !resolved; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const tab = await chrome.tabs.get(signupTabId);
              const elapsedMs = Math.max(0, Date.now() - redirectWaitStartedAt);
              if (shouldLogStep8RedirectHeartbeat({
                elapsedMs,
                lastHeartbeatElapsedMs,
              })) {
                lastHeartbeatElapsedMs = elapsedMs;
                await addLog(buildStep8RedirectHeartbeatMessage({
                  elapsedMs,
                  currentUrl: tab.url || '',
                }), 'info');
                await retryStep8ConsentClickIfStillVisible(signupTabId, {
                  currentUrl: tab.url || '',
                  elapsedMs,
                });
              }
              if (isLocalhostUrl(tab.url)) {
                captureLocalhostUrl(tab.url);
                break;
              }

              const recoveryState = await inspectSignupPageRecoveryState(state.oauthUrl);
              if (recoveryState.reason) {
                unexpectedRedirectHits = recoveryState.reason === 'unexpected_auth_redirect'
                  ? unexpectedRedirectHits + 1
                  : 2;

                if (unexpectedRedirectHits >= 2) {
                  throw new Error(buildStep8RecoveryErrorMessage(recoveryState.reason, recoveryState));
                }
              } else if (tab.url && !isLocalhostCallbackUrl(tab.url)) {
                unexpectedRedirectHits = 0;
              }

              const pageState = await getSignupAuthPageState();
              if (pageState?.hasFatalError) {
                throw new Error('Step 8 failed: auth page showed a fatal verification error.');
              }
              if (pageState?.requiresPhoneVerification) {
                throw new Error('Step 8 blocked: auth page still requires phone verification.');
              }
            } catch (err) {
              if (
                err?.message === 'Step 8 blocked: auth page still requires phone verification.'
                || /^Step 8 (failed|blocked|recoverable):/i.test(err?.message || '')
              ) {
                throw err;
              }
              break;
            }
          }
        }
      } catch (err) {
        clearTimeout(timeout);
        cleanupListeners();
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: VPS Verify (via vps-panel.js)
// ============================================================

async function executeStep9(state) {
  let effectiveState = state;

  if (!effectiveState.localhostUrl) {
    const recoveryState = await inspectSignupPageRecoveryState(effectiveState.oauthUrl);
    if (recoveryState.reason) {
      const detail = recoveryState.url || recoveryState.title || recoveryState.reason;
      effectiveState = await replaySteps6Through8WithCurrentAccount(
        `Step 9: Step 8 did not land on localhost and instead ended on ${detail}. Refreshing the VPS OAuth link and replaying steps 6-8 with the same account...`
      );
    }
  }

  if (!effectiveState.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }
  if (!effectiveState.vpsUrl) {
    throw new Error('VPS URL not set. Please enter VPS URL in the side panel.');
  }

  await addLog('Step 9: Opening VPS panel...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    // Create new tab in the automation window
    const wid = await ensureAutomationWindowId();
    const tab = await chrome.tabs.create({ url: effectiveState.vpsUrl, active: true, windowId: wid });
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }

  // Inject scripts directly and wait for them to be ready
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['shared/flow-recovery.js', 'content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 1000));

  // Send command directly — bypass queue/ready mechanism
  await addLog(`Step 9: Filling callback URL...`);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: { localhostUrl: effectiveState.localhostUrl },
  });

  if (response?.retryWithFreshOauth) {
    const refreshedState = await replaySteps6Through8WithCurrentAccount(
      `Step 9: VPS reported that the authorization link is no longer pending (${response.detail || response.reason || 'not pending'}). Refreshing OAuth and retrying steps 6-9 with the same account...`
    );
    const retryTabId = await getTabId('vps-panel') || tabId;
    const retryResponse = await chrome.tabs.sendMessage(retryTabId, {
      type: 'EXECUTE_STEP',
      step: 9,
      source: 'background',
      payload: { localhostUrl: refreshedState.localhostUrl },
    });

    if (retryResponse?.retryWithFreshOauth) {
      const message = 'Step 9 failed again because the authorization link is still not pending after refreshing OAuth. Retry from step 6 once more or inspect the VPS panel manually.';
      notifyStepError(9, message);
      throw new Error(message);
    }

    if (retryResponse?.error) {
      throw new Error(retryResponse.error);
    }

    return;
  }

  if (response?.error) {
    throw new Error(response.error);
  }
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
