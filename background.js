// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('shared/email-addresses.js', 'shared/mail-provider-rotation.js', 'shared/tmailor-domains.js', 'shared/tmailor-api.js', 'shared/tmailor-errors.js', 'shared/tmailor-mailbox-strategy.js', 'shared/tmailor-verification-profiles.js', 'shared/flow-recovery.js', 'shared/content-script-queue.js', 'shared/login-verification-codes.js', 'data/names.js', 'shared/flow-runner.js', 'shared/runtime-errors.js', 'shared/auto-run.js', 'shared/auto-run-failure-stats.js', 'shared/duck-mail-errors.js', 'shared/sidepanel-settings.js', 'shared/tab-reclaim.js');

const LOG_PREFIX = '[Infinitoai:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const OFFICIAL_SIGNUP_ENTRY_URL = 'https://auth.openai.com/create-account';
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const AUTO_RUN_HANDOFF_MESSAGE = 'Auto run handed off to manual continuation.';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const TMAILOR_API_CAPTCHA_COOLDOWN_MS = 3 * 60 * 1000;
const { getStepDelayAfter, runStepSequence } = FlowRunner;
const {
  buildMailPollRecoveryPlan,
  isMessageChannelClosedError,
  isReceivingEndMissingError,
  shouldRetryStep3WithFreshOauth,
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
  isAutoRunLogSilenceError,
  shouldContinueAutoRunAfterWatchdog,
  shouldContinueAutoRunAfterError,
  shouldStartNextInfiniteRunAfterManualFlow,
  summarizeAutoRunResult,
} = AutoRun;
  shouldSuspendAutoRunWatchdogDuringPause,
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
const { buildReclaimableTabRegistry, shouldPrepareSameUrlTabForReuse } = TabReclaim;
const {
  getMailTabOpenUrlForStep,
  getStep6RecoveryReasonForUnexpectedAuthPage,
  isLocalhostCallbackUrl,
  shouldNavigateMailTabOnStepStart,
} = FlowRecovery;
const {
  DEFAULT_AUTO_RUN_COUNT,
  DEFAULT_AUTO_RUN_INFINITE,
  DEFAULT_AUTO_ROTATE_MAIL_PROVIDER,
  PERSISTED_TOP_SETTING_KEYS,
  DEFAULT_EMAIL_SOURCE: DEFAULT_PERSISTED_EMAIL_SOURCE,
  normalizePersistentSettings,
  sanitizeAutoRunCount,
  sanitizeAutoRotateMailProvider,
  sanitizeEmailSource: sanitizePersistedEmailSource,
  sanitizeInfiniteAutoRun,
} = SidepanelSettings;

const RECLAIM_SOURCE_CONFIG = {
  'signup-page': {
    readyOnClaim: false,
    loadedMarker: '__MULTIPAGE_SIGNUP_PAGE_LOADED',
    inject: ['shared/verification-code.js', 'shared/phone-verification.js', 'shared/auth-fatal-errors.js', 'shared/unsupported-email.js', 'content/utils.js', 'content/signup-page.js'],
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
  lastEmailTimestamp: null,
  lastSignupVerificationCode: '',
  localhostUrl: null,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
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
  mailProviderUsage: {
    '163': [],
    qq: [],
  },
};

const TMAILOR_DOMAIN_STATE_KEY = 'tmailorDomainState';
const AUTO_RUN_STATS_KEY = 'autoRunStats';
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
  const [sessionState, persistentSettings, tmailorDomainState, autoRunStats] = await Promise.all([
    chrome.storage.session.get(null),
    getPersistentSettings(),
    getPersistentTmailorDomainState(),
    getPersistentAutoRunStats(),
  ]);
  return { ...DEFAULT_STATE, ...sessionState, ...persistentSettings, tmailorDomainState, autoRunStats };
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

async function setEmailState(email) {
  await setState({ email, lastSignupVerificationCode: '' });
  broadcastDataUpdate({ email });
}

async function setTmailorMailboxState(email, accessToken) {
  await setState({
    email,
    tmailorAccessToken: String(accessToken || '').trim(),
    tmailorApiCaptchaCooldownUntil: 0,
    tmailorOutcomeRecorded: false,
    lastSignupVerificationCode: '',
  });
  broadcastDataUpdate({ email });
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

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const [prev, persistentBundle] = await Promise.all([
    chrome.storage.session.get([
      'seenCodes',
      'seenInbucketMailIds',
      'accounts',
      'tabRegistry',
      'tmailorOutcomeRecorded',
      'mailProviderUsage',
      'customPassword',
    ]),
    Promise.all([getPersistentSettings(), getPersistentTmailorDomainState(), getPersistentAutoRunStats()]),
  ]);
  const [persistentSettings, tmailorDomainState, autoRunStats] = persistentBundle;
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    ...persistentSettings,
    tmailorDomainState,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: prev.accounts || [],
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

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
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

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  const queueTimeout = getContentScriptQueueTimeout(source, message?.type);
  const queueWaitHint = queueTimeout > 0
    ? `${Math.round(queueTimeout / 1000)}s timeout`
    : 'no timeout while waiting for manual takeover or challenge handling';
  const responseTimeout = getContentScriptResponseTimeout(source, message?.type);

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    if (source === 'tmailor-mail') {
      const actionLabel = message?.type === 'FETCH_TMAILOR_EMAIL'
        ? 'mailbox generation'
        : message?.type === 'POLL_EMAIL'
          ? 'inbox polling'
          : 'mailbox work';
      await addLog(
        `TMailor: Waiting for mailbox content script to become ready before ${actionLabel} (${queueWaitHint})...`,
        'info'
      );
    }
    return queueCommand(source, message, queueTimeout);
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
    return queueCommand(source, message, queueTimeout);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  try {
    return await sendContentScriptMessageWithTimeout(entry.tabId, source, message, responseTimeout);
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
    await addLog(`${source} content script disconnected, reinjecting and retrying...`, 'warn');

    const nextRegistry = { ...registry };
    nextRegistry[source] = { tabId: entry.tabId, ready: false };
    await setState({ tabRegistry: nextRegistry });

    const alreadyLoaded = await prepareReclaimedTab(source, entry.tabId);
    if (alreadyLoaded) {
      return await chrome.tabs.sendMessage(entry.tabId, message);
    }

    if (source === 'tmailor-mail') {
      await addLog(
        `TMailor: Content script disconnected. Waiting for reinjection and ready signal before retrying (${queueWaitHint})...`,
        'warn'
      );
    }
    return queueCommandForReinjection({
      source,
      message,
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

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
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
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
}

let stopRequested = false;

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

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`Step ${message.step} stopped by user`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        const currentState = await getState();
        const displayedError = decorateAuthFailureWithEmailDomain(message.error, currentState?.email);
        await setStepStatus(message.step, 'failed');
        await addLog(`Step ${message.step} failed: ${displayedError}`, 'error');
        await recordTmailorOutcome('failure', { step: message.step, errorMessage: displayedError });
        notifyStepError(message.step, displayedError);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await addLog('Flow reset', 'info');
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
        await addLog(`Manual continuation failed: ${err.message}`, 'error');
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
      if (message.payload.customPassword !== undefined) sessionUpdates.customPassword = message.payload.customPassword;
      if (message.payload.mailProvider !== undefined) persistentUpdates.mailProvider = message.payload.mailProvider;
      if (message.payload.emailSource !== undefined) persistentUpdates.emailSource = sanitizePersistedEmailSource(message.payload.emailSource);
      if (message.payload.mailDomainSettings !== undefined) persistentUpdates.mailDomainSettings = message.payload.mailDomainSettings;
      if (message.payload.inbucketHost !== undefined) persistentUpdates.inbucketHost = message.payload.inbucketHost;
      if (message.payload.inbucketMailbox !== undefined) persistentUpdates.inbucketMailbox = message.payload.inbucketMailbox;
      if (message.payload.autoRunCount !== undefined) persistentUpdates.autoRunCount = sanitizeAutoRunCount(message.payload.autoRunCount);
      if (message.payload.autoRunInfinite !== undefined) persistentUpdates.autoRunInfinite = sanitizeInfiniteAutoRun(message.payload.autoRunInfinite);
      if (message.payload.autoRotateMailProvider !== undefined) persistentUpdates.autoRotateMailProvider = sanitizeAutoRotateMailProvider(message.payload.autoRotateMailProvider);
      if (message.payload.tmailorDomainMode !== undefined) nextTmailorDomainMode = message.payload.tmailorDomainMode;

      if (Object.keys(sessionUpdates).length > 0) {
        await setState(sessionUpdates);
      }
      if (Object.keys(persistentUpdates).length > 0) {
        const nextSettings = await setPersistentSettings(persistentUpdates);
        if (persistentUpdates.mailProvider !== undefined) {
          broadcastDataUpdate({ mailProvider: nextSettings.mailProvider });
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
        await addLog(`Manual TMailor API code fetch failed: ${err.message}`, 'warn');
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

  await setState({ autoRunning: false });
  await addLog(`Auto run handed off to manual continuation from step ${step}`, 'info');
  waiter.reject(new Error(AUTO_RUN_HANDOFF_MESSAGE));
  sendAutoRunStatus('stopped');

  return true;
}

async function runManualFlow(startStep) {
  if (manualRunActive) {
    await addLog('Manual continuation already in progress', 'warn');
    return;
  }

  if (autoRunActive && !resumeWaiter) {
    await addLog('Cannot start manual continuation while auto run is active', 'warn');
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
    await addLog('Manual continuation completed through step 9', 'ok');
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

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);
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
    if (isStopError(err)) {
      if (!shouldSkipStepResultLog(currentStepStatus)) {
        await setStepStatus(step, 'stopped');
        await addLog(`Step ${step} stopped by user`, 'warn');
      }
      throw err;
    }
    if (!shouldSkipStepResultLog(currentStepStatus)) {
      await setStepStatus(step, 'failed');
    const displayedError = decorateAuthFailureWithEmailDomain(err.message, latestState?.email);
      await addLog(`Step ${step} failed: ${displayedError}`, 'error');
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
  const recoveredStep3Timeout = recoveryState === true || Boolean(recoveryState?.step3Timeout);
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
    if (step === 3 && !recoveredStep3Timeout && shouldRetryStep3WithFreshOauth(err)) {
      await recoverStep3OauthTimeout();
      return await executeStepAndWait(step, delayAfter, { step3Timeout: true });
    }
    if (step === 8 && !recoveredStep8UnexpectedRedirect && shouldRetryStep8WithFreshOauth(err)) {
      await replaySteps6Through8WithCurrentAccount(
        'Step 8: Auth flow did not reach localhost and instead landed on another page. Refreshing the VPS OAuth link and replaying steps 6-8 with the same account...'
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
  await addLog(`Duck Mail: ${result.generated ? 'Generated' : 'Loaded'} ${result.email}`, 'ok');
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

async function markTmailorOutcomePending(email) {
  await setState({
    email,
    tmailorAccessToken: '',
    tmailorOutcomeRecorded: false,
  });
  broadcastDataUpdate({ email });
}

async function recordTmailorOutcome(result, context = {}) {
  const state = await getState();
  if (!isTmailorSource(state) || state.tmailorOutcomeRecorded) {
    return;
  }

  const domain = extractEmailDomain(state.email);
  if (!domain) {
    return;
  }

  if (result === 'success') {
    const wasWhitelisted = state.tmailorDomainState.whitelist.includes(domain);
    const nextState = await setTmailorDomainState(recordTmailorDomainSuccess(state.tmailorDomainState, domain));
    await setState({ tmailorOutcomeRecorded: true });
    if (!wasWhitelisted && nextState.whitelist.includes(domain)) {
      await addLog(`TMailor: Added ${domain} to the whitelist after a successful run.`, 'ok');
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
    await addLog(`TMailor: Added ${domain} to the blacklist after a blocked run.`, 'warn');
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
  await addLog(`33mail: Generated ${email} for ${currentProvider}`, 'ok');
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
        await addLog(`TMailor API: Mailbox ready ${result.email} (token saved for API inbox polling).`, 'ok');
        return result.email;
      } catch (err) {
        if (isTmailorApiCaptchaError(err)) {
          const cooldownUntil = createTmailorApiCaptchaCooldownUntil({
            now,
            cooldownMs: TMAILOR_API_CAPTCHA_COOLDOWN_MS,
          });
          await setState({ tmailorApiCaptchaCooldownUntil: cooldownUntil });
          await addLog(`TMailor API: New mailbox request failed: ${err.message}`, 'warn');
          await addLog(
            `TMailor API: Pausing automatic mailbox API attempts for ${formatWaitDuration(TMAILOR_API_CAPTCHA_COOLDOWN_MS)} before retrying the API path.`,
            'warn'
          );
          await addLog('TMailor API reported a captcha/block. Opening the mailbox page to inspect the challenge and auto-attempt it before manual takeover.', 'warn');
        } else {
          await addLog(`TMailor API: New mailbox request failed: ${err.message}`, 'warn');
          await addLog('TMailor: Falling back to the mailbox page flow for address generation.', 'warn');
        }
      }
    }
  }

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
    await addLog('TMailor: Mailbox page requested a background reload. Reopening the mailbox page and retrying once...', 'warn');
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
  await addLog(`TMailor: Ready ${result.email}`, 'ok');
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

function clearAutoRunWatchdogTimer() {
  if (autoRunWatchdogTimer) {
    clearTimeout(autoRunWatchdogTimer);
    autoRunWatchdogTimer = null;
  }
}

function resetAutoRunWatchdog({ preserveLastLog = false } = {}) {
  clearAutoRunWatchdogTimer();
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
  scheduleAutoRunWatchdog();
}

function suspendAutoRunWatchdog() {
  if (!autoRunWatchdogPromise || autoRunWatchdogTriggered) {
    return;
  }

  autoRunWatchdogSuspended = true;
  clearAutoRunWatchdogTimer();
}

function resumeAutoRunWatchdog({ resetActivity = true } = {}) {
  if (!autoRunWatchdogPromise || autoRunWatchdogTriggered) {
    return;
  }

  autoRunWatchdogSuspended = false;
  if (resetActivity) {
    autoRunWatchdogLastActivityAt = Date.now();
  }
  scheduleAutoRunWatchdog();
}

function touchAutoRunWatchdog(entry = null) {
  if (!autoRunWatchdogPromise || autoRunWatchdogTriggered) {
    return;
  }

  autoRunWatchdogLastActivityAt = Number.isFinite(entry?.timestamp) ? entry.timestamp : Date.now();
  if (entry && typeof entry.message === 'string' && entry.message.trim()) {
    autoRunWatchdogLastLogEntry = {
      message: entry.message,
      level: entry.level || 'info',
      timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
    };
  }

  if (!autoRunWatchdogSuspended) {
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
      await addLog(`Auto run crashed unexpectedly: ${err.message}`, 'error');
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
    await addLog('Auto run already in progress', 'warn');
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
    await resetState();
    await setState(keepSettings);
    // Tell side panel to reset all UI
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await sleepWithStop(500);

    const runTargetText = autoRunInfinite ? `${run}/∞` : `${run}/${totalRuns}`;
    const runStartedAt = Date.now();
    autoRunCurrentRunStartedAt = runStartedAt;
    resetAutoRunCurrentSuccessMode();
      await addLog(`=== Auto Run ${runTargetText} — Phase 1: Open official signup ===`, 'info');

    try {
      throwIfStopped();
      sendAutoRunStatus('running', { currentRun: run });

      await executeStepAndWait(2, 2000);

      const currentState = await getState();
      const emailSource = getCurrentEmailSource(currentState);
      let emailReady = false;
      try {
        const nextEmail = await fetchEmailAddress({ generateNew: true });
        await addLog(`=== Run ${runTargetText} — ${getEmailSourceLabel(emailSource)} ready: ${nextEmail} ===`, 'ok');
        emailReady = true;
      } catch (err) {
        await addLog(`${getEmailSourceLabel(emailSource)} auto-fetch failed: ${err.message}`, 'warn');
      }

      if (!emailReady) {
        await addLog(`=== Run ${runTargetText} PAUSED: ${getEmailWaitHint(emailSource)} ===`, 'warn');
        sendAutoRunStatus('waiting_email', { currentRun: run });

        // Wait for RESUME_AUTO_RUN — sets a promise that resumeAutoRun resolves
        const shouldSuspendWatchdogDuringPause = shouldSuspendAutoRunWatchdogDuringPause({
          phase: 'waiting_email',
          infiniteMode: autoRunInfinite,
        });
        const resumePromise = waitForResume();
        if (shouldSuspendWatchdogDuringPause) {
          suspendAutoRunWatchdog();
          try {
            await resumePromise;
          } finally {
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

      await addLog(`=== Run ${runTargetText} — Phase 2: Register, verify, login, complete ===`, 'info');
      sendAutoRunStatus('running', { currentRun: run });

      const signupTabId = await getTabId('signup-page');
      if (signupTabId) {
        await chrome.tabs.update(signupTabId, { active: true });
      }

      await runStepSequence({
        startStep: 3,
        executeStepAndWait,
      });

      await addLog(`=== Run ${runTargetText} COMPLETE! ===`, 'ok');
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
          await addLog(`=== Run ${runTargetText} watchdog timeout. Starting next run automatically... ===`, 'warn');
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
        await addLog(`Run ${runTargetText} stopped by user`, 'warn');
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
            await addLog(`Run ${runTargetText}: TMailor domain was blocked during step 5. Marked as failed and moving to the next run.`, 'warn');
          }
          await addLog(`=== Run ${runTargetText} failed. Starting next run automatically... ===`, 'warn');
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
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return false;
  }
  if (resumeWaiter) {
    resumeWaiter.resolve();
    resumeWaiter = null;
    return true;
  }
  await addLog('Auto run resume was requested, but no paused auto-run waiter is active. Falling back to step 3 is allowed.', 'warn');
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
// Step 2: Open Signup Page (Background opens the official signup entry, signup-page.js continues if needed)
// ============================================================

async function executeStep2(state) {
  await addLog(`Step 2: Opening official signup page...`);
  await reuseOrCreateTab('signup-page', OFFICIAL_SIGNUP_ENTRY_URL);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  const emailSource = getCurrentEmailSource(state);
  let email = state.email;

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

  // Save account record
  const accounts = state.accounts || [];
  const lastAccount = accounts[accounts.length - 1];
  if (!lastAccount || lastAccount.email !== email || lastAccount.password !== password) {
    accounts.push({ email, password, createdAt: new Date().toISOString() });
    await setState({ accounts });
  }

  await addLog(
    `Step 3: Filling email ${email}, password ${state.customPassword ? 'customized' : 'generated'} (${password.length} chars)`
  );
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email, password },
  });
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
    await addLog(`Step ${step}: Resend click skipped: ${err.message}`, 'warn');
  }
}

async function ensureMailTabReady(mail, options = {}) {
  const alive = await isTabAlive(mail.source);
  const navigateIfUrlDiff = Boolean(options.navigateIfUrlDiff);
  if (alive) {
    if (mail.navigateOnReuse || navigateIfUrlDiff) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(mail.source);
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
          await addLog(
            `Step ${step}: TMailor API 开始轮询 ${event.attempt}/${event.maxAttempts}...`,
            'info'
          );
        },
        onPollAttempt: async (event) => {
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
      await addLog(`Step ${step}: TMailor API returned verification code ${apiResult.code}.`, 'ok');
      return apiResult;
    } catch (err) {
      await addLog(`Step ${step}: TMailor API inbox polling failed: ${err.message}`, 'warn');
      if (useTmailorApiMailboxOnly) {
        await addLog(`Step ${step}: ${getTmailorApiOnlyPollingMessage(state.email)}`, 'warn');
        throw err;
      }
      await addLog(`Step ${step}: Falling back to the TMailor page DOM flow for inbox polling.`, 'warn');
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

  if (!result?.code) {
    throw new Error(`Step ${step}: No verification code returned from ${mail.label}.`);
  }

  return result;
}

async function submitVerificationCode(step, code) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('Signup/auth page tab was closed. Cannot fill verification code.');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  let submitResult = null;

  try {
    submitResult = await sendToContentScript('signup-page', {
      type: 'FILL_CODE',
      step,
      source: 'background',
      payload: { code },
    });
  } catch (err) {
    const message = err?.message || '';
    if (/message port closed|receiving end does not exist|tab was closed/i.test(message)) {
      await addLog(`Step ${step}: Signup page navigated before submit response; waiting for completion signal...`, 'info');
      return { accepted: true, reason: 'navigation-detached' };
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
    return pageState || {
      requiresPhoneVerification: false,
      hasFatalError: false,
      hasAuthOperationTimedOut: false,
      hasVisibleCredentialInput: false,
      hasVisibleVerificationInput: false,
      hasVisibleProfileFormInput: false,
    };
  } catch {
    return {
      requiresPhoneVerification: false,
      hasFatalError: false,
      hasAuthOperationTimedOut: false,
      hasVisibleCredentialInput: false,
      hasVisibleVerificationInput: false,
      hasVisibleProfileFormInput: false,
    };
  }
}

async function ensureSignupPageReadyForVerification(state, step = 4) {
  const start = Date.now();
  const timeoutMs = 10000;
  let refreshedOauthAfterTimeout = false;

  while (Date.now() - start < timeoutMs) {
    const pageState = await getSignupAuthPageState();

    if (pageState?.hasAuthOperationTimedOut) {
      if (refreshedOauthAfterTimeout) {
        throw new Error('Step 4 blocked: signup auth page timed out again after refreshing the VPS OAuth link.');
      }

      await addLog(
        `Step ${step}: Signup auth page timed out before the verification email step. Refreshing the VPS OAuth link and replaying step 3...`,
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

    if (pageState?.requiresPhoneVerification) {
      throw new Error(`Step ${step} blocked: auth page requires phone verification before the verification email step.`);
    }

    if (pageState?.hasVisibleVerificationInput || pageState?.hasVisibleProfileFormInput) {
      return state;
    }

    if (pageState?.hasVisibleCredentialInput) {
      await addLog(`Step ${step}: Signup page is still on the credential form. Waiting before checking the inbox...`, 'info');
      await sleepWithStop(1000);
      continue;
    }

    return state;
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

  const rejectedCodes = new Set();
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

      if (!resendTriggered && inboxCheck >= resendAfterAttempts) {
        await addLog(`Step ${step}: No new email after ${inboxCheck} inbox checks. Triggering resend once, then checking again...`, 'warn');
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
      continue;
    }

    if (step === 4) {
      await setState({ lastSignupVerificationCode: result.code });
    }

    return;
  }

  throw new Error(`Step ${step}: Verification code kept being rejected after ${maxInboxChecks} inbox refresh attempts.`);
}

async function executeStep4(state) {
  const effectiveState = await ensureSignupPageReadyForVerification(state, 4);
  await executeVerificationMailStep(4, effectiveState, {
    filterAfterTimestamp: effectiveState.flowStartTime || 0,
    ...getTmailorVerificationProfile(4),
    resendAfterAttempts: 3,
    persistLastEmailTimestamp: true,
  });
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function refreshOauthUrl(state, stepLabel, reason) {
  await addLog(`${stepLabel}: ${reason}`, 'info');
  const waitForRefresh = waitForStepComplete(1, 120000);
  await executeStep1(state);
  const refreshPayload = await waitForRefresh;
  const latestState = await getState();
  return {
    ...latestState,
    oauthUrl: refreshPayload?.oauthUrl || latestState.oauthUrl || '',
  };
}

async function refreshOauthUrlBeforeStep6(state, reason = 'Refreshing the VPS OAuth link before login...') {
  return await refreshOauthUrl(state, 'Step 6', reason);
}

async function recoverStep3OauthTimeout() {
  const state = await getState();
  await addLog(
    'Step 3: The signup page timed out before credentials could be submitted. Reopening the official signup page and retrying once with the current email/password...',
    'warn'
  );

  const waitForSignupPage = waitForStepComplete(2, 120000);
  await executeStep2(state);
  await waitForSignupPage;
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

  await addLog(`Step 6: Opening OAuth URL for login...`);
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', effectiveState.oauthUrl);

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: effectiveState.email, password: effectiveState.password },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  await executeVerificationMailStep(7, state, {
    filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
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

async function replaySteps6Through8WithCurrentAccount(logMessage, recoveryState = {}) {
  await addLog(logMessage, 'warn');
  await setState({ localhostUrl: null });
  broadcastDataUpdate({ localhostUrl: null });

  await executeStepAndWait(6, 2000);
  await executeStepAndWait(7, 2000);
  await executeStepAndWait(8, 1000, {
    ...recoveryState,
    step8UnexpectedRedirect: true,
  });

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
        await addLog(`Step 8: Localhost redirect already captured: ${tab.url}`, 'ok');
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
        addLog(`Step 8: Captured localhost URL: ${url}`, 'ok');
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
          await clickWithDebugger(signupTabId, clickResult?.rect);
          await addLog('Step 8: Debugger click dispatched, waiting for redirect...');

          // Fallback: poll tab URL in case webNavigation listeners missed the redirect
          let unexpectedRedirectHits = 0;
          for (let i = 0; i < 30 && !resolved; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const tab = await chrome.tabs.get(signupTabId);
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
