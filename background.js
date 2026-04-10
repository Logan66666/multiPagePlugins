// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('shared/email-addresses.js', 'shared/mail-provider-rotation.js', 'shared/tmailor-domains.js', 'shared/tmailor-api.js', 'data/names.js', 'shared/flow-runner.js', 'shared/runtime-errors.js', 'shared/auto-run.js', 'shared/duck-mail-errors.js', 'shared/sidepanel-settings.js', 'shared/tab-reclaim.js');

const LOG_PREFIX = '[MultiPage:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const AUTO_RUN_HANDOFF_MESSAGE = 'Auto run handed off to manual continuation.';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const { runStepSequence } = FlowRunner;
const { buildMailPollRecoveryPlan, isMessageChannelClosedError, isReceivingEndMissingError, shouldSkipStepResultLog } = RuntimeErrors;
const { buildAutoRunStatusPayload, shouldContinueAutoRunAfterError, summarizeAutoRunResult } = AutoRun;
const { addDuckMailRetryHint } = DuckMailErrors;
const { DEFAULT_EMAIL_SOURCE, generate33MailAddress, get33MailDomainForProvider, sanitizeEmailSource } = EmailAddresses;
const { chooseMailProviderForAutoRun, getConfiguredRotatableMailProviders, getNextMailProviderAvailabilityTimestamp, isRotatableMailProvider, pruneMailProviderUsage, recordMailProviderUsage } = MailProviderRotation;
const { DEFAULT_TMAILOR_DOMAIN_STATE, extractEmailDomain, isAllowedTmailorDomain, mergeTmailorDomainStates, normalizeTmailorDomainState, recordTmailorDomainFailure, recordTmailorDomainSuccess, shouldBlacklistTmailorDomainForError } = TmailorDomains;
const { fetchAllowedTmailorEmail, pollTmailorVerificationCode } = TmailorApi;
const { buildReclaimableTabRegistry } = TabReclaim;
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
    inject: ['content/utils.js', 'content/vps-panel.js'],
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
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  lastEmailTimestamp: null,
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
  autoRunStats: {
    successfulRuns: 0,
    failedRuns: 0,
  },
  tmailorDomainState: DEFAULT_TMAILOR_DOMAIN_STATE,
  tmailorAccessToken: '',
  tmailorOutcomeRecorded: false,
  mailProviderUsage: {
    '163': [],
    qq: [],
  },
};

const TMAILOR_DOMAIN_STATE_KEY = 'tmailorDomainState';
let cachedTmailorDomainSeeds = null;

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
  const [sessionState, persistentSettings, tmailorDomainState] = await Promise.all([
    chrome.storage.session.get(null),
    getPersistentSettings(),
    getPersistentTmailorDomainState(),
  ]);
  return { ...DEFAULT_STATE, ...sessionState, ...persistentSettings, tmailorDomainState };
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

  if (localState[TMAILOR_DOMAIN_STATE_KEY] === undefined && sessionState[TMAILOR_DOMAIN_STATE_KEY] !== undefined) {
    await chrome.storage.local.set({ [TMAILOR_DOMAIN_STATE_KEY]: mergedState });
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
  await setState({ email });
  broadcastDataUpdate({ email });
}

async function setTmailorMailboxState(email, accessToken) {
  await setState({
    email,
    tmailorAccessToken: String(accessToken || '').trim(),
    tmailorOutcomeRecorded: false,
  });
  broadcastDataUpdate({ email });
}

async function setTmailorDomainState(nextState) {
  const normalizedState = await setPersistentTmailorDomainState(nextState);
  broadcastDataUpdate({ tmailorDomainState: normalizedState });
  return normalizedState;
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
      'autoRunStats',
      'tmailorOutcomeRecorded',
      'mailProviderUsage',
      'customPassword',
    ]),
    Promise.all([getPersistentSettings(), getPersistentTmailorDomainState()]),
  ]);
  const [persistentSettings, tmailorDomainState] = persistentBundle;
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    ...persistentSettings,
    tmailorDomainState,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    autoRunStats: prev.autoRunStats || DEFAULT_STATE.autoRunStats,
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
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
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

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  try {
    return await chrome.tabs.sendMessage(entry.tabId, message);
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

    return queueCommand(source, message);
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
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
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

async function clickWithDebugger(tabId, rect) {
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

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
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
        await setStepStatus(message.step, 'failed');
        await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
        await recordTmailorOutcome('failure', { step: message.step, errorMessage: message.error });
        notifyStepError(message.step, message.error);
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
      autoRunLoop(totalRuns, infiniteMode);  // fire-and-forget
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
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
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

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    case 'DEBUGGER_CLICK_AT': {
      const tabId = sender.tab?.id;
      if (!tabId) {
        return { error: 'Debugger click failed: no sender tab available.' };
      }
      await clickWithDebugger(tabId, message.payload?.rect);
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

async function setAutoRunStats(successfulRuns, failedRuns) {
  const nextStats = {
    successfulRuns: Math.max(0, Number.parseInt(String(successfulRuns ?? 0), 10) || 0),
    failedRuns: Math.max(0, Number.parseInt(String(failedRuns ?? 0), 10) || 0),
  };
  autoRunSuccessfulRuns = nextStats.successfulRuns;
  autoRunFailedRuns = nextStats.failedRuns;
  await setState({ autoRunStats: nextStats });
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
      ...overrides,
    }),
  }).catch(() => {});
}

async function handOffPausedAutoRunToManual(step) {
  if (!autoRunActive || !resumeWaiter) {
    return false;
  }

  const waiter = resumeWaiter;
  resumeWaiter = null;
  autoRunActive = false;

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

  try {
    await handOffPausedAutoRunToManual(startStep);
    await addLog(`Manual continuation: step ${startStep} -> 9`, 'info');
    await runStepSequence({
      startStep,
      executeStepAndWait,
    });
    await addLog('Manual continuation completed through step 9', 'ok');
  } finally {
    manualRunActive = false;
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

async function requestStop() {
  if (stopRequested) return;

  stopRequested = true;
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog('Stop requested. Cancelling current operations...', 'warn');
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
  sendAutoRunStatus('stopped');
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
      await addLog(`Step ${step} failed: ${err.message}`, 'error');
    }
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  throwIfStopped();
  const promise = waitForStepComplete(step, 120000);
  await executeStep(step);
  await promise;
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
    return 'Open TMailor and generate a supported mailbox, then continue';
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

  if (generateNew) {
    try {
      await addLog('TMailor: Requesting a new mailbox via API...', 'info');
      const result = await fetchAllowedTmailorEmail({
        domainState: state.tmailorDomainState,
      });
      await setTmailorMailboxState(result.email, result.accessToken);
      await addLog(`TMailor API: Mailbox ready ${result.email} (token saved for API inbox polling).`, 'ok');
      return result.email;
    } catch (err) {
      await addLog(`TMailor API: New mailbox request failed: ${err.message}`, 'warn');
      await addLog('TMailor: Falling back to the mailbox page flow for address generation.', 'warn');
    }
  }

  await addLog(`TMailor: Opening mailbox page (${generateNew ? 'generate new' : 'reuse current'})...`);
  await reuseOrCreateTab('tmailor-mail', 'https://tmailor.com/');

  const result = await sendToContentScript('tmailor-mail', {
    type: 'FETCH_TMAILOR_EMAIL',
    source: 'background',
    payload: {
      generateNew,
      domainState: state.tmailorDomainState,
    },
  });

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
let autoRunLastRotatedMailProvider = null;

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns, infiniteMode = false) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  clearStopRequest();
  autoRunActive = true;
  autoRunInfinite = Boolean(infiniteMode);
  autoRunTotalRuns = autoRunInfinite ? Number.POSITIVE_INFINITY : totalRuns;
  autoRunLastRotatedMailProvider = null;
  await setAutoRunStats(0, 0);
  await setState({ autoRunning: true });
  let handedOffToManual = false;

  for (let run = 1; autoRunInfinite || run <= totalRuns; run++) {
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
      await sleepWithStop(waitMs);

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
    await addLog(`=== Auto Run ${runTargetText} — Phase 1: Get OAuth link & open signup ===`, 'info');

    try {
      throwIfStopped();
      sendAutoRunStatus('running', { currentRun: run });

      await executeStepAndWait(1, 2000);
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
        await waitForResume();

        const resumedState = await getState();
        if (getCurrentEmailSource(resumedState) !== '33mail' && !resumedState.email) {
          await addLog('Cannot resume: no email address.', 'error');
          break;
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
      await setAutoRunStats(autoRunSuccessfulRuns + 1, autoRunFailedRuns);

    } catch (err) {
      if (isAutoRunHandoffError(err)) {
        handedOffToManual = true;
        await addLog(`Run ${runTargetText} handed off to manual continuation`, 'info');
        break;
      } else if (isStopError(err)) {
        await addLog(`Run ${runTargetText} stopped by user`, 'warn');
        break;
      } else {
        await setAutoRunStats(autoRunSuccessfulRuns, autoRunFailedRuns + 1);
        await addLog(`Run ${runTargetText} failed: ${err.message}`, 'error');
        if (autoRunInfinite || run < totalRuns) {
          if (/step 5 failed: .*unsupported_email|step 5 failed: auth fatal error page detected after profile submit\./i.test(err.message || '')) {
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
    lastAttemptedRun,
    stopRequested,
    handedOffToManual,
    infiniteMode: autoRunInfinite,
  });

  await addLog(summary.message, summary.phase === 'complete' ? 'ok' : 'warn');
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: buildAutoRunStatusPayload({
      phase: summary.phase,
      currentRun: lastAttemptedRun,
      totalRuns: autoRunTotalRuns,
      infiniteMode: autoRunInfinite,
      successfulRuns: autoRunSuccessfulRuns,
      failedRuns: autoRunFailedRuns,
      summaryMessage: summary.message,
      summaryToast: summary.toastMessage,
    }),
  }).catch(() => {});

  autoRunActive = false;
  autoRunInfinite = false;
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
    return;
  }
  if (resumeWaiter) {
    resumeWaiter.resolve();
    resumeWaiter = null;
  }
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
    inject: ['content/utils.js', 'content/vps-panel.js'],
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
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog(`Step 2: Opening auth URL...`);
  await reuseOrCreateTab('signup-page', state.oauthUrl);

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

  const password = state.customPassword || generatePassword();
  await setPasswordState(password);

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email, password, createdAt: new Date().toISOString() });
  await setState({ accounts });

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

async function ensureMailTabReady(mail) {
  const alive = await isTabAlive(mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
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
      });
      await addLog(`Step ${step}: TMailor API returned verification code ${apiResult.code}.`, 'ok');
      return apiResult;
    } catch (err) {
      await addLog(`Step ${step}: TMailor API inbox polling failed: ${err.message}`, 'warn');
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
    return pageState || { requiresPhoneVerification: false, hasFatalError: false };
  } catch {
    return { requiresPhoneVerification: false, hasFatalError: false };
  }
}

async function executeVerificationMailStep(step, state, options) {
  const {
    filterAfterTimestamp = 0,
    senderFilters,
    subjectFilters,
    clickResendFirst = true,
    persistLastEmailTimestamp = false,
  } = options;

  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);
  await addLog(`Step ${step}: Opening ${mail.label}...`);
  await ensureMailTabReady(mail);

  const rejectedCodes = new Set();
  let currentFilterAfterTimestamp = filterAfterTimestamp;
  const maxInboxChecks = 4;

  for (let inboxCheck = 1; inboxCheck <= maxInboxChecks; inboxCheck++) {
    if (inboxCheck === 1 && clickResendFirst) {
      await clickResendOnSignupPage(step);
    } else if (inboxCheck > 1) {
      await addLog(`Step ${step}: Verification code was rejected. Refreshing inbox without resending...`, 'warn');
    }

    const result = await pollVerificationCodeFromMail(step, mail, {
      filterAfterTimestamp: currentFilterAfterTimestamp,
      senderFilters,
      subjectFilters,
      targetEmail: state.email,
      excludeCodes: [...rejectedCodes],
      maxAttempts: 20,
      intervalMs: 3000,
    });

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

    return;
  }

  throw new Error(`Step ${step}: Verification code kept being rejected after ${maxInboxChecks} inbox refresh attempts.`);
}

async function executeStep4(state) {
  await executeVerificationMailStep(4, state, {
    filterAfterTimestamp: state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'duckduckgo', 'forward'],
    subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
    clickResendFirst: true,
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

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  await addLog(`Step 6: Opening OAuth URL for login...`);
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  await executeVerificationMailStep(7, state, {
    filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'],
    subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
    clickResendFirst: true,
    persistLastEmailTimestamp: false,
  });
}

// ============================================================
// Step 8: Complete OAuth (auto click + localhost listener)
// ============================================================

let webNavListener = null;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
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
          for (let i = 0; i < 30 && !resolved; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const tab = await chrome.tabs.get(signupTabId);
              if (isLocalhostUrl(tab.url)) {
                captureLocalhostUrl(tab.url);
                break;
              }

              const pageState = await getSignupAuthPageState();
              if (pageState?.hasFatalError) {
                throw new Error('Step 8 failed: auth page showed a fatal verification error.');
              }
              if (pageState?.requiresPhoneVerification) {
                throw new Error('Step 8 blocked: auth page still requires phone verification.');
              }
            } catch (err) {
              if (err?.message === 'Step 8 blocked: auth page still requires phone verification.') {
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
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }
  if (!state.vpsUrl) {
    throw new Error('VPS URL not set. Please enter VPS URL in the side panel.');
  }

  await addLog('Step 9: Opening VPS panel...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    // Create new tab in the automation window
    const wid = await ensureAutomationWindowId();
    const tab = await chrome.tabs.create({ url: state.vpsUrl, active: true, windowId: wid });
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
    files: ['content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 1000));

  // Send command directly — bypass queue/ready mechanism
  await addLog(`Step 9: Filling callback URL...`);
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
