(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.TmailorApi = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  const DEFAULT_BASE_URL = 'https://tmailor.com';
  const DEFAULT_HEADERS = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
  };

  function getDeps() {
    const holder = typeof globalThis !== 'undefined' ? globalThis : self;
    return {
      TmailorDomains: holder.TmailorDomains || null,
      MailMatching: holder.MailMatching || null,
      MailFreshness: holder.MailFreshness || null,
      LatestMail: holder.LatestMail || null,
    };
  }

  function loadNodeDeps() {
    if (typeof require !== 'function') {
      return {};
    }

    try {
      return {
        TmailorDomains: require('./tmailor-domains.js'),
        MailMatching: require('./mail-matching.js'),
        MailFreshness: require('./mail-freshness.js'),
        LatestMail: require('./latest-mail.js'),
      };
    } catch {
      return {};
    }
  }

  const deps = { ...loadNodeDeps(), ...getDeps() };
  const TmailorDomains = deps.TmailorDomains;
  const MailMatching = deps.MailMatching;
  const MailFreshness = deps.MailFreshness;
  const LatestMail = deps.LatestMail;

  const extractEmailDomain = TmailorDomains?.extractEmailDomain || function(email) {
    const normalized = String(email || '').trim().toLowerCase();
    const atIndex = normalized.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === normalized.length - 1) {
      return '';
    }
    return normalized.slice(atIndex + 1);
  };

  const isAllowedTmailorDomain = TmailorDomains?.isAllowedTmailorDomain || function(_state, domain) {
    return /\.com$/i.test(String(domain || ''));
  };

  const getStepMailMatchProfile = MailMatching?.getStepMailMatchProfile || function() {
    return null;
  };

  const matchesSubjectPatterns = MailMatching?.matchesSubjectPatterns || function() {
    return true;
  };

  const normalizeText = MailMatching?.normalizeText || function(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  };

  const isMailFresh = MailFreshness?.isMailFresh || function() {
    return true;
  };

  const parseMailTimestampCandidates = MailFreshness?.parseMailTimestampCandidates || function(values) {
    const first = Array.isArray(values) ? values[0] : 0;
    return Number(first) || 0;
  };

  const findLatestMatchingItem = LatestMail?.findLatestMatchingItem || function(items, predicate) {
    for (const item of items || []) {
      if (predicate(item)) return item;
    }
    return null;
  };

  function getFetch(fetchImpl) {
    const resolved = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!resolved) {
      throw new Error('Fetch implementation is not available.');
    }
    return resolved;
  }

  function buildApiUrl(baseUrl) {
    const normalizedBaseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    return normalizedBaseUrl + '/api';
  }

  async function parseJsonResponse(response) {
    const text = await response.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok) {
      throw new Error('TMailor API request failed (' + response.status + ').');
    }

    if (!json || typeof json !== 'object') {
      throw new Error('TMailor API returned an invalid JSON payload.');
    }

    return json;
  }

  async function callTmailorApi(options) {
    const config = options || {};
    const doFetch = getFetch(config.fetchImpl);
    const response = await doFetch(buildApiUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        ...(config.headers || {}),
      },
      body: JSON.stringify({
        action: config.action,
        fbToken: null,
        ...(config.payload || {}),
      }),
      signal: config.signal,
    });

    return await parseJsonResponse(response);
  }

  async function warmupTmailorSession(options) {
    const config = options || {};
    const doFetch = getFetch(config.fetchImpl);
    const normalizedBaseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const response = await doFetch(normalizedBaseUrl + '/', {
      method: 'GET',
      headers: DEFAULT_HEADERS,
      signal: config.signal,
    });

    if (!response.ok) {
      throw new Error('TMailor homepage request failed (' + response.status + ').');
    }
  }

  function extractVerificationCode(text) {
    const normalized = String(text || '');
    const matchCn = normalized.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
    if (matchCn) return matchCn[1];

    const matchEn = normalized.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
    if (matchEn) return matchEn[1] || matchEn[2];

    const match6 = normalized.match(/\b(\d{6})\b/);
    if (match6) return match6[1];

    return '';
  }

  function normalizeInboxMessages(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return Object.values(data);
  }

  function parseMessageTimestamp(message, now) {
    return parseMailTimestampCandidates([
      message?.created_at,
      message?.create,
      message?.sort,
      message?.date,
      message?.time,
    ], { now: now });
  }

  function shouldMatchMessage(step, message, options) {
    const config = options || {};
    const senderFilters = config.senderFilters || [];
    const subjectFilters = config.subjectFilters || [];
    const filterAfterTimestamp = config.filterAfterTimestamp || 0;
    const now = Number.isFinite(config.now) ? config.now : Date.now();
    const targetEmail = config.targetEmail || '';

    const subjectProfile = getStepMailMatchProfile(step);
    const subject = normalizeText(message?.subject || '');
    const from = normalizeText(message?.from || message?.sender || '');
    const body = normalizeText(message?.body || message?.text || '');
    const combined = normalizeText(from + ' ' + subject + ' ' + body);
    const combinedLower = combined.toLowerCase();
    const timestamp = parseMessageTimestamp(message, now);
    const targetLocal = String(targetEmail).split('@')[0].trim().toLowerCase();

    const senderMatch = senderFilters.some((value) => combinedLower.includes(String(value).toLowerCase()));
    const subjectMatch = subjectFilters.some((value) => combinedLower.includes(String(value).toLowerCase()));
    const stepSpecificSubjectMatch = matchesSubjectPatterns(subject + ' ' + combined, subjectProfile);
    const targetMatch = targetLocal && combinedLower.includes(targetLocal);

    if (!(stepSpecificSubjectMatch || (!subjectProfile && (senderMatch || subjectMatch || targetMatch)))) {
      return null;
    }

    if (!isMailFresh(timestamp, { now: now, filterAfterTimestamp: filterAfterTimestamp })) {
      return null;
    }

    return {
      id: message?.id || message?.mail_id || message?.email_code || '',
      emailToken: message?.email_id || message?.email_token || '',
      subject: subject,
      from: from,
      combinedText: combined,
      timestamp: timestamp,
    };
  }

  async function readTmailorMessage(options) {
    const config = options || {};
    const data = await callTmailorApi({
      action: 'read',
      payload: {
        accesstoken: config.accessToken,
        curentToken: config.accessToken,
        email_code: config.message?.id || config.message?.mailId || config.message?.email_code,
        email_token: config.message?.emailToken || config.message?.email_id || config.message?.email_token,
      },
      fetchImpl: config.fetchImpl,
      baseUrl: config.baseUrl,
      signal: config.signal,
    });

    if (data.msg !== 'ok') {
      throw new Error('TMailor read failed: ' + (data.code || data.msg || 'unknown_error'));
    }

    return data.data || {};
  }

  async function fetchAllowedTmailorEmail(options) {
    const config = options || {};
    const maxAttempts = Number.isFinite(config.maxAttempts) ? config.maxAttempts : 25;

    await warmupTmailorSession({
      fetchImpl: config.fetchImpl,
      baseUrl: config.baseUrl,
      signal: config.signal,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const data = await callTmailorApi({
        action: 'newemail',
        payload: {
          curentToken: null,
        },
        fetchImpl: config.fetchImpl,
        baseUrl: config.baseUrl,
        signal: config.signal,
      });

      if (data.msg !== 'ok') {
        throw new Error('TMailor newemail failed: ' + (data.code || data.msg || 'unknown_error'));
      }

      const email = String(data.email || '').trim().toLowerCase();
      const domain = extractEmailDomain(email);
      const accessToken = String(data.accesstoken || '').trim();

      if (email && accessToken && isAllowedTmailorDomain(config.domainState || {}, domain)) {
        return {
          email: email,
          domain: domain,
          accessToken: accessToken,
          createdAt: Number(data.create) || Number(data.sort) || 0,
          generated: true,
        };
      }
    }

    throw new Error('TMailor API did not generate a whitelisted or non-blacklisted .com mailbox in time.');
  }

  async function pollTmailorVerificationCode(options) {
    const config = options || {};
    const maxAttempts = Number.isFinite(config.maxAttempts) ? config.maxAttempts : 20;
    const intervalMs = Number.isFinite(config.intervalMs) ? config.intervalMs : 3000;
    const now = Number.isFinite(config.now) ? config.now : Date.now();
    const excludedCodeSet = new Set(config.excludeCodes || []);
    const sleep = typeof config.sleep === 'function'
      ? config.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    if (!config.accessToken) {
      throw new Error('TMailor API polling requires an access token.');
    }

    let lastListId = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const data = await callTmailorApi({
        action: 'listinbox',
        payload: {
          accesstoken: config.accessToken,
          curentToken: config.accessToken,
        },
        headers: lastListId ? { listid: lastListId } : {},
        fetchImpl: config.fetchImpl,
        baseUrl: config.baseUrl,
        signal: config.signal,
      });

      if (data.msg !== 'ok') {
        throw new Error('TMailor inbox poll failed: ' + (data.code || data.msg || 'unknown_error'));
      }

      if (data.code) {
        lastListId = String(data.code);
      }

      const messages = normalizeInboxMessages(data.data)
        .map((message) => ({
          raw: message,
          parsed: shouldMatchMessage(config.step, message, {
            senderFilters: config.senderFilters,
            subjectFilters: config.subjectFilters,
            filterAfterTimestamp: config.filterAfterTimestamp,
            now: now,
            targetEmail: config.targetEmail,
          }),
        }))
        .filter((entry) => entry.parsed)
        .map((entry) => ({ ...entry.raw, ...entry.parsed }));

      const latestMatch = findLatestMatchingItem(messages, (message) => Boolean(message));

      if (latestMatch) {
        let code = extractVerificationCode(latestMatch.subject + ' ' + latestMatch.combinedText);

        if (!code) {
          const detail = await readTmailorMessage({
            fetchImpl: config.fetchImpl,
            baseUrl: config.baseUrl,
            accessToken: config.accessToken,
            message: latestMatch,
            signal: config.signal,
          });
          code = extractVerificationCode(
            String(detail.subject || '') + ' ' + String(detail.text || '') + ' ' + String(detail.body || '')
          );
        }

        if (code && !excludedCodeSet.has(code)) {
          return {
            code: code,
            emailTimestamp: latestMatch.timestamp || now,
            mailId: latestMatch.id,
            listId: lastListId,
          };
        }
      }

      if (attempt < maxAttempts && intervalMs > 0) {
        await sleep(intervalMs);
      }
    }

    throw new Error(
      'Step ' + config.step + ': No matching verification email found on TMailor API after ' + maxAttempts + ' attempts.'
    );
  }

  return {
    DEFAULT_BASE_URL: DEFAULT_BASE_URL,
    buildApiUrl: buildApiUrl,
    callTmailorApi: callTmailorApi,
    extractVerificationCode: extractVerificationCode,
    fetchAllowedTmailorEmail: fetchAllowedTmailorEmail,
    normalizeInboxMessages: normalizeInboxMessages,
    parseJsonResponse: parseJsonResponse,
    parseMessageTimestamp: parseMessageTimestamp,
    pollTmailorVerificationCode: pollTmailorVerificationCode,
    readTmailorMessage: readTmailorMessage,
    shouldMatchMessage: shouldMatchMessage,
    warmupTmailorSession: warmupTmailorSession,
  };
});
