(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.SidepanelSettings = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  const DEFAULT_AUTO_RUN_COUNT = 1;
  const DEFAULT_AUTO_RUN_INFINITE = false;
  const DEFAULT_MAIL_PROVIDER = '163';
  const PERSISTED_TOP_SETTING_KEYS = [
    'vpsUrl',
    'mailProvider',
    'inbucketHost',
    'inbucketMailbox',
    'autoRunCount',
    'autoRunInfinite',
  ];

  function sanitizeAutoRunCount(value) {
    const numeric = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(numeric) || numeric < 1) {
      return DEFAULT_AUTO_RUN_COUNT;
    }
    return numeric;
  }

  function sanitizeInfiniteAutoRun(value) {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false' || normalized === '') return false;
    }
    return Boolean(value);
  }

  function sanitizeMailProvider(value) {
    return value === 'qq' || value === '163' || value === 'inbucket'
      ? value
      : DEFAULT_MAIL_PROVIDER;
  }

  function normalizePersistentSettings(value = {}) {
    return {
      vpsUrl: typeof value.vpsUrl === 'string' ? value.vpsUrl : '',
      mailProvider: sanitizeMailProvider(value.mailProvider),
      inbucketHost: typeof value.inbucketHost === 'string' ? value.inbucketHost : '',
      inbucketMailbox: typeof value.inbucketMailbox === 'string' ? value.inbucketMailbox : '',
      autoRunCount: sanitizeAutoRunCount(value.autoRunCount),
      autoRunInfinite: sanitizeInfiniteAutoRun(value.autoRunInfinite),
    };
  }

  return {
    DEFAULT_AUTO_RUN_COUNT,
    DEFAULT_AUTO_RUN_INFINITE,
    PERSISTED_TOP_SETTING_KEYS,
    normalizePersistentSettings,
    sanitizeAutoRunCount,
    sanitizeInfiniteAutoRun,
  };
});
