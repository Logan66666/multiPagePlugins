(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.DuckMailErrors = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  const RETRY_HINT = '建议切换节点后再试。';

  function addDuckMailRetryHint(message) {
    const text = String(message || '').trim();
    if (!text) {
      return RETRY_HINT;
    }
    if (text.includes(RETRY_HINT)) {
      return text;
    }
    return `${text} ${RETRY_HINT}`;
  }

  return {
    RETRY_HINT,
    addDuckMailRetryHint,
  };
});
