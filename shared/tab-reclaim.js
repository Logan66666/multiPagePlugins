(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.TabReclaim = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  function withDefaultProtocol(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return '';
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) {
      return value;
    }
    return `https://${value}`;
  }

  function toUrl(rawValue) {
    const candidate = withDefaultProtocol(rawValue);
    if (!candidate) return null;
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  }

  function normalizeOrigin(rawValue) {
    const parsed = toUrl(rawValue);
    return parsed ? parsed.origin : '';
  }

  function normalizeComparableUrl(rawValue) {
    const parsed = toUrl(rawValue);
    if (!parsed) return '';
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  }

  function isSignupPageUrl(parsed) {
    return parsed.hostname === 'auth0.openai.com'
      || parsed.hostname === 'auth.openai.com'
      || parsed.hostname === 'accounts.openai.com';
  }

  function isQqMailUrl(parsed) {
    return parsed.hostname === 'mail.qq.com' || parsed.hostname === 'wx.mail.qq.com';
  }

  function isMail163Url(parsed) {
    return parsed.hostname === 'mail.163.com';
  }

  function isDuckMailUrl(parsed) {
    return parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/email/settings/autofill';
  }

  function isTmailorUrl(parsed) {
    return parsed.hostname === 'tmailor.com';
  }

  function isInbucketMailboxUrl(parsed, settings) {
    const expectedOrigin = normalizeOrigin(settings?.inbucketHost);
    const expectedMailbox = String(settings?.inbucketMailbox || '').trim();
    if (!expectedOrigin || !expectedMailbox || parsed.origin !== expectedOrigin) {
      return false;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments[0] !== 'm') {
      return false;
    }

    return decodeURIComponent(segments[1]) === expectedMailbox;
  }

  function isVpsPanelUrl(parsed, settings) {
    const expected = normalizeComparableUrl(settings?.vpsUrl);
    if (!expected) return false;
    return normalizeComparableUrl(parsed.href) === expected;
  }

  function detectReclaimableSource(rawUrl, settings) {
    const parsed = toUrl(rawUrl);
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      return null;
    }

    if (isSignupPageUrl(parsed)) return 'signup-page';
    if (isQqMailUrl(parsed)) return 'qq-mail';
    if (isMail163Url(parsed)) return 'mail-163';
    if (isDuckMailUrl(parsed)) return 'duck-mail';
    if (isTmailorUrl(parsed)) return 'tmailor-mail';
    if (isInbucketMailboxUrl(parsed, settings)) return 'inbucket-mail';
    if (isVpsPanelUrl(parsed, settings)) return 'vps-panel';
    return null;
  }

  function getTabScore(tab) {
    if (Number.isFinite(tab?.lastAccessed)) {
      return tab.lastAccessed;
    }
    if (Number.isFinite(tab?.id)) {
      return tab.id;
    }
    return 0;
  }

  function buildReclaimableTabRegistry(tabs = [], settings = {}) {
    const registry = {};
    const scores = {};

    for (const tab of tabs) {
      if (!Number.isFinite(tab?.id)) continue;

      const source = detectReclaimableSource(tab.url, settings);
      if (!source) continue;

      const score = getTabScore(tab);
      if (!(source in scores) || score >= scores[source]) {
        scores[source] = score;
        registry[source] = { tabId: tab.id, ready: false };
      }
    }

    return registry;
  }

  return {
    buildReclaimableTabRegistry,
    detectReclaimableSource,
    normalizeComparableUrl,
    normalizeOrigin,
  };
});
