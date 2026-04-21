(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.ContentScriptQueue = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  function buildContentScriptResponseTimeoutError(source, timeoutMs) {
    const normalizedSource = String(source || '').trim() || 'unknown';
    const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    return `Content script on ${normalizedSource} did not respond in ${Math.round(normalizedTimeoutMs / 1000)}s. Try refreshing the tab and retry.`;
  }

  function getContentScriptQueueTimeout(source, messageType) {
    const normalizedSource = String(source || '').trim();
    const normalizedType = String(messageType || '').trim();

    if (normalizedSource === 'tmailor-mail') {
      if (normalizedType === 'FETCH_TMAILOR_EMAIL') {
        return 0;
      }
      if (normalizedType === 'POLL_EMAIL') {
        return 0;
      }
      return 0;
    }

    if (normalizedSource === 'signup-page' && normalizedType === 'EXECUTE_STEP') {
      return 30000;
    }

    if (normalizedSource === 'vps-panel') {
      return 30000;
    }

    return 15000;
  }

  function getContentScriptResponseTimeout(source, messageType) {
    const normalizedSource = String(source || '').trim();
    const normalizedType = String(messageType || '').trim();

    if (normalizedSource === 'tmailor-mail') {
      if (normalizedType === 'FETCH_TMAILOR_EMAIL' || normalizedType === 'POLL_EMAIL') {
        return 0;
      }
      return 0;
    }

    return 60000;
  }

  async function queueCommandForReinjection(options = {}) {
    const queueCommand = typeof options.queueCommand === 'function'
      ? options.queueCommand
      : (() => Promise.reject(new Error('queueCommandForReinjection requires queueCommand.')));
    const reinject = typeof options.reinject === 'function'
      ? options.reinject
      : (async () => null);
    const flushCommand = typeof options.flushCommand === 'function'
      ? options.flushCommand
      : (() => {});

    const source = options.source;
    const message = options.message;
    const timeout = Number.isFinite(options.timeout) ? options.timeout : 0;

    const queuedPromise = queueCommand(source, message, timeout);
    const readyTabId = await reinject();
    if (readyTabId != null) {
      flushCommand(source, readyTabId);
    }
    return await queuedPromise;
  }

  return {
    buildContentScriptResponseTimeoutError,
    getContentScriptQueueTimeout,
    getContentScriptResponseTimeout,
    queueCommandForReinjection,
  };
});
