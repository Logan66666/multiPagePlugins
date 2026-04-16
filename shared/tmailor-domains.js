(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.TmailorDomains = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  const DEFAULT_TMAILOR_DOMAIN_MODE = 'whitelist_only';
  const TMAILOR_DOMAIN_MODES = Object.freeze(['com_only', 'whitelist_only']);

  function normalizeDomain(value) {
    return String(value || '')
      .trim()
      .replace(/^@+/, '')
      .toLowerCase();
  }

  function normalizeDomainList(values = []) {
    const seen = new Set();
    const normalized = [];

    for (const value of values || []) {
      const domain = normalizeDomain(value);
      if (!domain || seen.has(domain)) {
        continue;
      }
      seen.add(domain);
      normalized.push(domain);
    }

    return normalized;
  }

  function normalizeStatsEntry(value = {}) {
    const successCount = Math.max(0, Number.parseInt(String(value.successCount ?? 0), 10) || 0);
    const failureCount = Math.max(0, Number.parseInt(String(value.failureCount ?? 0), 10) || 0);
    return { successCount, failureCount };
  }

  function cloneStats(source = {}) {
    const cloned = {};
    for (const [domainKey, entry] of Object.entries(source || {})) {
      const domain = normalizeDomain(domainKey);
      if (!domain) {
        continue;
      }
      cloned[domain] = normalizeStatsEntry(entry);
    }
    return cloned;
  }

  function sanitizeTmailorDomainMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (TMAILOR_DOMAIN_MODES.includes(normalized)) {
      return normalized;
    }
    return DEFAULT_TMAILOR_DOMAIN_MODE;
  }

  function loadFallbackTmailorSeedData() {
    return {
      whitelist: [
        'mikrotikvn.com',
        'mikfarm.com',
        'libinit.com',
        'fbhotro.com',
        'beelsil.com',
        'emailracc.com',
        'sonphuongthinh.com',
        'dulich84.com',
        'coffeejadore.com',
        'accclone.com',
        'emailcoffeehouse.com',
      ],
      blacklist: [
        'benphim.com',
        'groklan.com',
        'haibabon.com',
        'hetzez.com',
        'img-free.com',
        'nickmxh.com',
        'pippoc.com',
        'phimib.com',
        'storebanme.com',
        'topdatamaster.com',
        'vinakop.com',
      ],
      stats: {
        'benphim.com': { successCount: 0, failureCount: 1 },
        'groklan.com': { successCount: 0, failureCount: 1 },
        'haibabon.com': { successCount: 0, failureCount: 1 },
        'hetzez.com': { successCount: 0, failureCount: 1 },
        'img-free.com': { successCount: 0, failureCount: 1 },
        'nickmxh.com': { successCount: 0, failureCount: 1 },
        'pippoc.com': { successCount: 0, failureCount: 1 },
        'phimib.com': { successCount: 0, failureCount: 1 },
        'storebanme.com': { successCount: 0, failureCount: 1 },
        'topdatamaster.com': { successCount: 0, failureCount: 1 },
        'vinakop.com': { successCount: 0, failureCount: 1 },
      },
      mode: DEFAULT_TMAILOR_DOMAIN_MODE,
    };
  }

  function getGlobalHolder() {
    if (typeof globalThis !== 'undefined') return globalThis;
    if (typeof self !== 'undefined') return self;
    return {};
  }

  function loadTmailorSeedData() {
    const holder = getGlobalHolder();
    if (holder.__TMAILOR_DOMAIN_SEEDS__) {
      return holder.__TMAILOR_DOMAIN_SEEDS__;
    }

    let sourceData = null;
    if (typeof require === 'function') {
      try {
        sourceData = require('../data/tmailor-domains.json');
      } catch {
        sourceData = null;
      }
    }

    if (!sourceData) {
      sourceData = loadFallbackTmailorSeedData();
    }

    const seeds = {
      whitelist: normalizeDomainList(sourceData.whitelist),
      blacklist: normalizeDomainList(sourceData.blacklist),
      stats: cloneStats(sourceData.stats),
      mode: sanitizeTmailorDomainMode(sourceData.mode),
    };

    holder.__TMAILOR_DOMAIN_SEEDS__ = seeds;
    return seeds;
  }

  const TMAILOR_DOMAIN_SEEDS = loadTmailorSeedData();
  const DEFAULT_TMAILOR_WHITELIST = Object.freeze([...TMAILOR_DOMAIN_SEEDS.whitelist]);
  const DEFAULT_TMAILOR_BLACKLIST = Object.freeze([...TMAILOR_DOMAIN_SEEDS.blacklist]);
  const DEFAULT_TMAILOR_STATS = Object.freeze(cloneStats(TMAILOR_DOMAIN_SEEDS.stats));
  const DEFAULT_TMAILOR_DOMAIN_STATE = Object.freeze({
    whitelist: DEFAULT_TMAILOR_WHITELIST,
    blacklist: DEFAULT_TMAILOR_BLACKLIST,
    stats: DEFAULT_TMAILOR_STATS,
    mode: TMAILOR_DOMAIN_SEEDS.mode || DEFAULT_TMAILOR_DOMAIN_MODE,
  });

  function extractEmailDomain(email) {
    const normalized = String(email || '').trim().toLowerCase();
    const atIndex = normalized.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === normalized.length - 1) {
      return '';
    }
    return normalizeDomain(normalized.slice(atIndex + 1));
  }

  function normalizeTmailorDomainState(value = {}) {
    const blacklist = normalizeDomainList(value.blacklist);
    const blacklistSet = new Set(blacklist);
    const whitelist = normalizeDomainList([
      ...DEFAULT_TMAILOR_WHITELIST,
      ...(Array.isArray(value.whitelist) ? value.whitelist : []),
    ]).filter((domain) => !blacklistSet.has(domain));
    const stats = cloneStats(DEFAULT_TMAILOR_STATS);

    for (const [domainKey, entry] of Object.entries(value.stats || {})) {
      const domain = normalizeDomain(domainKey);
      if (!domain) {
        continue;
      }
      stats[domain] = normalizeStatsEntry(entry);
    }

    const mode = sanitizeTmailorDomainMode(value.mode ?? DEFAULT_TMAILOR_DOMAIN_STATE.mode);

    return {
      whitelist,
      blacklist,
      stats,
      mode,
    };
  }

  function isWhitelistedTmailorDomain(state, domain) {
    const normalizedState = normalizeTmailorDomainState(state);
    const normalizedDomain = normalizeDomain(domain);
    return Boolean(normalizedDomain) && normalizedState.whitelist.includes(normalizedDomain);
  }

  function isBlacklistedTmailorDomain(state, domain) {
    const normalizedState = normalizeTmailorDomainState(state);
    const normalizedDomain = normalizeDomain(domain);
    return Boolean(normalizedDomain) && normalizedState.blacklist.includes(normalizedDomain);
  }

  function isAllowedTmailorDomain(state, domain) {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
      return false;
    }
    const normalizedState = normalizeTmailorDomainState(state);
    if (normalizedState.mode === 'whitelist_only') {
      return normalizedState.whitelist.includes(normalizedDomain);
    }
    if (normalizedState.whitelist.includes(normalizedDomain)) {
      return true;
    }
    return /\.com$/i.test(normalizedDomain) && !normalizedState.blacklist.includes(normalizedDomain);
  }

  function validateTmailorEmail(state, rawEmail) {
    const email = String(rawEmail || '').trim().toLowerCase();
    const domain = extractEmailDomain(email);
    const isEmailShapeValid = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);

    if (!isEmailShapeValid || !domain) {
      return {
        ok: false,
        email: '',
        domain,
        reason: 'invalid_email',
      };
    }

    if (!isAllowedTmailorDomain(state, domain)) {
      return {
        ok: false,
        email,
        domain,
        reason: 'domain_not_allowed',
      };
    }

    return {
      ok: true,
      email,
      domain,
      reason: '',
    };
  }

  function mergeTmailorDomainStates(...states) {
    let mergedMode = DEFAULT_TMAILOR_DOMAIN_MODE;
    let mergedWhitelist = [];
    let mergedBlacklist = [];
    let mergedStats = {};

    for (const state of states) {
      const normalizedState = normalizeTmailorDomainState(state);
      mergedMode = sanitizeTmailorDomainMode(normalizedState.mode);
      mergedWhitelist = normalizeDomainList([...mergedWhitelist, ...normalizedState.whitelist]);
      mergedBlacklist = normalizeDomainList([...mergedBlacklist, ...normalizedState.blacklist]);
      mergedStats = {
        ...mergedStats,
        ...cloneStats(normalizedState.stats),
      };
    }

    const mergedBlacklistSet = new Set(mergedBlacklist);
    mergedWhitelist = mergedWhitelist.filter((domain) => !mergedBlacklistSet.has(domain));

    return normalizeTmailorDomainState({
      mode: mergedMode,
      whitelist: mergedWhitelist,
      blacklist: mergedBlacklist,
      stats: mergedStats,
    });
  }

  function upsertStats(stats, domain, patch) {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
      return stats;
    }

    const current = normalizeStatsEntry(stats[normalizedDomain] || {});
    return {
      ...stats,
      [normalizedDomain]: normalizeStatsEntry({
        successCount: current.successCount + (patch.successCount || 0),
        failureCount: current.failureCount + (patch.failureCount || 0),
      }),
    };
  }

  function recordTmailorDomainSuccess(state, domain) {
    const normalizedState = normalizeTmailorDomainState(state);
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
      return normalizedState;
    }

    const whitelistSet = new Set(normalizedState.whitelist);
    if (/\.com$/i.test(normalizedDomain)) {
      whitelistSet.add(normalizedDomain);
    }

    return normalizeTmailorDomainState({
      whitelist: [...whitelistSet],
      blacklist: normalizedState.blacklist.filter((item) => item !== normalizedDomain),
      stats: upsertStats(normalizedState.stats, normalizedDomain, { successCount: 1 }),
      mode: normalizedState.mode,
    });
  }

  function recordTmailorDomainFailure(state, domain, options = {}) {
    const normalizedState = normalizeTmailorDomainState(state);
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
      return normalizedState;
    }

    const blacklistSet = new Set(normalizedState.blacklist);
    if (options.blacklist) {
      blacklistSet.add(normalizedDomain);
    }

    return normalizeTmailorDomainState({
      whitelist: normalizedState.whitelist,
      blacklist: [...blacklistSet],
      stats: upsertStats(normalizedState.stats, normalizedDomain, { failureCount: 1 }),
      mode: normalizedState.mode,
    });
  }

  function moveTmailorDomainToBlacklist(state, domain) {
    const normalizedState = normalizeTmailorDomainState(state);
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
      return normalizedState;
    }

    const blacklistSet = new Set(normalizedState.blacklist);
    blacklistSet.add(normalizedDomain);

    return normalizeTmailorDomainState({
      whitelist: normalizedState.whitelist.filter((item) => item !== normalizedDomain),
      blacklist: [...blacklistSet],
      stats: normalizedState.stats,
      mode: normalizedState.mode,
    });
  }

  function clearTmailorDomainStats(state, domains = [], metric = '') {
    const normalizedState = normalizeTmailorDomainState(state);
    const normalizedMetric = String(metric || '').trim().toLowerCase();
    if (!['success', 'failure'].includes(normalizedMetric)) {
      return normalizedState;
    }

    const targetDomains = new Set(normalizeDomainList(domains));
    if (targetDomains.size === 0) {
      return normalizedState;
    }

    const nextStats = cloneStats(normalizedState.stats);
    for (const domain of targetDomains) {
      const current = normalizeStatsEntry(nextStats[domain] || {});
      nextStats[domain] = normalizedMetric === 'success'
        ? { successCount: 0, failureCount: current.failureCount }
        : { successCount: current.successCount, failureCount: 0 };
    }

    return normalizeTmailorDomainState({
      whitelist: normalizedState.whitelist,
      blacklist: normalizedState.blacklist,
      stats: nextStats,
      mode: normalizedState.mode,
    });
  }

  function shouldBlacklistTmailorDomainForError(state, domain, errorMessage) {
    const normalizedDomain = normalizeDomain(domain);
    const message = String(errorMessage || '').trim().toLowerCase();

    if (!normalizedDomain || !/\.com$/i.test(normalizedDomain)) {
      return false;
    }
    const normalizedState = normalizeTmailorDomainState(state);
    if (normalizedState.whitelist.includes(normalizedDomain)) {
      return false;
    }

    const matchesEmailUnsupported =
      message.includes('email domain is unsupported') ||
      message.includes('unsupported email') ||
      message.includes('unsupported_email');
    const matchesPhoneVerification =
      message.includes('phone number is required on the auth page') ||
      message.includes('phone verification') ||
      message.includes('auth page still requires phone verification') ||
      message.includes('/add-phone') ||
      (message.includes('verification form stayed visible after submit attempts') && message.includes('add-phone'));
    const matchesFatal = message.includes('auth fatal error page detected after profile submit');
    const matchesMissingNameInput = message.includes('could not find name input');

    return matchesEmailUnsupported || matchesPhoneVerification || matchesFatal || matchesMissingNameInput;
  }

  return {
    DEFAULT_TMAILOR_DOMAIN_STATE,
    DEFAULT_TMAILOR_DOMAIN_MODE,
    DEFAULT_TMAILOR_STATS,
    DEFAULT_TMAILOR_WHITELIST,
    TMAILOR_DOMAIN_MODES,
    clearTmailorDomainStats,
    cloneStats,
    extractEmailDomain,
    isAllowedTmailorDomain,
    isBlacklistedTmailorDomain,
    isWhitelistedTmailorDomain,
    mergeTmailorDomainStates,
    moveTmailorDomainToBlacklist,
    normalizeDomain,
    normalizeDomainList,
    normalizeStatsEntry,
    normalizeTmailorDomainState,
    recordTmailorDomainFailure,
    recordTmailorDomainSuccess,
    sanitizeTmailorDomainMode,
    shouldBlacklistTmailorDomainForError,
    validateTmailorEmail,
  };
});
