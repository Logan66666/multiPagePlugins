(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.SidepanelLogCopy = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  function formatLogTime(entry = {}) {
    if (typeof entry.time === 'string' && entry.time.trim()) {
      return entry.time.trim();
    }

    const timestamp = entry.timestamp;
    const date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date(timestamp || '');
    if (Number.isNaN(date.getTime())) {
      return '--:--:--';
    }

    return date.toLocaleTimeString('en-US', { hour12: false });
  }

  function formatLogLevel(level) {
    const normalized = String(level || 'info').trim().toUpperCase();
    return normalized || 'INFO';
  }

  function formatLogStep(entry = {}) {
    if (Number.isFinite(entry.step)) {
      return `S${entry.step}`;
    }

    const stepMatch = String(entry.message || '').match(/Step (\d+)/i);
    return stepMatch ? `S${stepMatch[1]}` : '';
  }

  function buildLogRoundClipboardText(round = {}) {
    const label = typeof round.label === 'string' && round.label.trim()
      ? round.label.trim()
      : 'Current';
    const logs = Array.isArray(round.logs) ? round.logs : [];

    if (!logs.length) {
      return `# ${label}\n(No logs on this page)`;
    }

    const lines = [`# ${label}`];
    for (const entry of logs) {
      const time = formatLogTime(entry);
      const level = formatLogLevel(entry?.level);
      const step = formatLogStep(entry);
      const message = String(entry?.message || '').trim();
      const parts = [`[${time}]`, `[${level}]`];
      if (step) {
        parts.push(`[${step}]`);
      }
      parts.push(message || '(empty log message)');
      lines.push(parts.join(' '));
    }

    return lines.join('\n');
  }

  return {
    buildLogRoundClipboardText,
  };
});
