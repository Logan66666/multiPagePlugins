const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkTmailorApiConnectivity,
  fetchAllowedTmailorEmail,
  pollTmailorVerificationCode,
} = require('../shared/tmailor-api.js');
const { normalizeTmailorDomainState } = require('../shared/tmailor-domains.js');

function createJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('fetchAllowedTmailorEmail keeps requesting new mailboxes until the domain passes current rules', async () => {
  const calls = [];
  const attemptEvents = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (!options.method || options.method === 'GET') {
      return createJsonResponse({ ok: true });
    }

    const payload = JSON.parse(options.body);
    assert.equal(payload.action, 'newemail');

    const attempt = calls.filter((entry) => entry.options?.method === 'POST').length;
    if (attempt === 1) {
      return createJsonResponse({ msg: 'ok', email: 'first@blocked.com', accesstoken: 'token-1' });
    }
    if (attempt === 2) {
      return createJsonResponse({ msg: 'ok', email: 'second@example.net', accesstoken: 'token-2' });
    }
    return createJsonResponse({ msg: 'ok', email: 'third@fresh-allowed.com', accesstoken: 'token-3' });
  };

  const result = await fetchAllowedTmailorEmail({
    fetchImpl,
    domainState: normalizeTmailorDomainState({
      mode: 'com_only',
      blacklist: ['blocked.com'],
    }),
    maxAttempts: 3,
    onAttempt: async (event) => {
      attemptEvents.push(event);
    },
  });

  assert.equal(result.email, 'third@fresh-allowed.com');
  assert.equal(result.domain, 'fresh-allowed.com');
  assert.equal(result.accessToken, 'token-3');
  assert.equal(calls.filter((entry) => entry.options?.method === 'POST').length, 3);
  assert.deepEqual(
    attemptEvents.map((event) => ({ attempt: event.attempt, maxAttempts: event.maxAttempts })),
    [
      { attempt: 1, maxAttempts: 3 },
      { attempt: 2, maxAttempts: 3 },
      { attempt: 3, maxAttempts: 3 },
    ]
  );
});

test('fetchAllowedTmailorEmail retries up to 100 times by default and suggests switching to com+whitelist mode on failure', async () => {
  const attemptEvents = [];
  let postCalls = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (!options.method || options.method === 'GET') {
      return createJsonResponse({ ok: true });
    }

    postCalls += 1;
    return createJsonResponse({
      msg: 'ok',
      email: `blocked-${postCalls}@blocked.com`,
      accesstoken: `token-${postCalls}`,
    });
  };

  await assert.rejects(
    () => fetchAllowedTmailorEmail({
      fetchImpl,
      domainState: normalizeTmailorDomainState({
        mode: 'com_only',
        blacklist: ['blocked.com'],
      }),
      onAttempt: async (event) => {
        attemptEvents.push({ attempt: event.attempt, maxAttempts: event.maxAttempts });
      },
    }),
    /Switch to com\+whitelist mode and retry\./i
  );

  assert.equal(postCalls, 100);
  assert.equal(attemptEvents.length, 100);
  assert.deepEqual(attemptEvents[0], { attempt: 1, maxAttempts: 100 });
  assert.deepEqual(attemptEvents[99], { attempt: 100, maxAttempts: 100 });
});

test('pollTmailorVerificationCode returns the fresh ChatGPT code directly from inbox data', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  const fetchImpl = async (url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'listinbox') {
      return createJsonResponse({
        msg: 'ok',
        code: 'list-1',
        data: {
          item1: {
            id: 'mail-1',
            email_id: 'detail-1',
            subject: '你的 ChatGPT 代码为 344928',
            from: 'OpenAI',
            created_at: new Date(now).toISOString(),
          },
        },
      });
    }
    throw new Error(`Unexpected action: ${payload.action}`);
  };

  const result = await pollTmailorVerificationCode({
    fetchImpl,
    accessToken: 'token-1',
    step: 4,
    filterAfterTimestamp: now - 60_000,
    maxAttempts: 1,
    intervalMs: 0,
    now,
  });

  assert.equal(result.code, '344928');
  assert.equal(result.mailId, 'mail-1');
  assert.equal(result.listId, 'list-1');
});

test('pollTmailorVerificationCode falls back to the read API when inbox preview masks the code', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  const fetchImpl = async (url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'listinbox') {
      return createJsonResponse({
        msg: 'ok',
        code: 'list-2',
        data: {
          item1: {
            id: 'mail-2',
            email_id: 'detail-2',
            subject: '你的 ChatGPT 代码为 ******',
            from: 'OpenAI',
            created_at: new Date(now).toISOString(),
          },
        },
      });
    }
    if (payload.action === 'read') {
      return createJsonResponse({
        msg: 'ok',
        data: {
          subject: '你的 ChatGPT 代码为 ******',
          body: '输入此临时验证码以继续：551266',
        },
      });
    }
    throw new Error(`Unexpected action: ${payload.action}`);
  };

  const result = await pollTmailorVerificationCode({
    fetchImpl,
    accessToken: 'token-2',
    step: 4,
    filterAfterTimestamp: now - 60_000,
    maxAttempts: 1,
    intervalMs: 0,
    now,
  });

  assert.equal(result.code, '551266');
  assert.equal(result.mailId, 'mail-2');
  assert.equal(result.listId, 'list-2');
});

test('pollTmailorVerificationCode keeps retrying cached candidates when read times out after a successful listinbox', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  let listCalls = 0;
  let readCalls = 0;

  const fetchImpl = async (_url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'listinbox') {
      listCalls += 1;
      if (listCalls === 1) {
        return createJsonResponse({
          msg: 'ok',
          code: 'list-cache-a',
          data: {
            item1: {
              id: 'mail-cache-a',
              email_id: 'detail-cache-a',
              subject: 'Your ChatGPT code is ******',
              from: 'OpenAI',
              created_at: new Date(now).toISOString(),
            },
          },
        });
      }

      return createJsonResponse({
        msg: 'ok',
        code: 'list-cache-b',
        data: {},
      });
    }

    if (payload.action === 'read') {
      readCalls += 1;
      if (readCalls === 1) {
        return new Promise(() => {});
      }

      return createJsonResponse({
        msg: 'ok',
        data: {
          subject: 'Your ChatGPT code is ******',
          body: 'Use verification code 661245 to continue.',
        },
      });
    }

    throw new Error(`Unexpected action: ${payload.action}`);
  };

  const result = await pollTmailorVerificationCode({
    fetchImpl,
    accessToken: 'token-cache',
    step: 7,
    filterAfterTimestamp: now - 60_000,
    maxAttempts: 2,
    maxRequestRetries: 0,
    requestTimeoutMs: 5,
    intervalMs: 0,
    now,
  });

  assert.equal(result.code, '661245');
  assert.equal(result.mailId, 'mail-cache-a');
  assert.equal(result.listId, 'list-cache-b');
  assert.equal(listCalls, 2);
  assert.equal(readCalls, 2);
});

test('pollTmailorVerificationCode ignores non-matching subjects and eventually returns the matching code', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  let attempts = 0;
  const fetchImpl = async (url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'listinbox') {
      attempts += 1;
      if (attempts === 1) {
        return createJsonResponse({
          msg: 'ok',
          code: 'list-a',
          data: {
            item1: {
              id: 'mail-a',
              email_id: 'detail-a',
              subject: 'Your ChatGPT code is 112233',
              from: 'OpenAI',
              created_at: new Date(now).toISOString(),
            },
          },
        });
      }
      return createJsonResponse({
        msg: 'ok',
        code: 'list-b',
        data: {
          item2: {
            id: 'mail-b',
            email_id: 'detail-b',
            subject: '你的 ChatGPT 代码为 665544',
            from: 'OpenAI',
            created_at: new Date(now + 1000).toISOString(),
          },
        },
      });
    }
    throw new Error(`Unexpected action: ${payload.action}`);
  };

  const result = await pollTmailorVerificationCode({
    fetchImpl,
    accessToken: 'token-3',
    step: 4,
    filterAfterTimestamp: now - 60_000,
    maxAttempts: 2,
    intervalMs: 0,
    now,
  });

  assert.equal(result.code, '665544');
  assert.equal(result.mailId, 'mail-b');
});

test('pollTmailorVerificationCode skips excluded verification codes and waits for a fresh login code', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  let attempts = 0;

  const fetchImpl = async (url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'listinbox') {
      attempts += 1;
      if (attempts === 1) {
        return createJsonResponse({
          msg: 'ok',
          code: 'list-login-a',
          data: {
            item1: {
              id: 'mail-login-a',
              email_id: 'detail-login-a',
              subject: 'Your ChatGPT code is 112233',
              from: 'OpenAI',
              created_at: new Date(now).toISOString(),
            },
          },
        });
      }

      return createJsonResponse({
        msg: 'ok',
        code: 'list-login-b',
        data: {
          item2: {
            id: 'mail-login-b',
            email_id: 'detail-login-b',
            subject: 'Your ChatGPT code is 665544',
            from: 'OpenAI',
            created_at: new Date(now + 1000).toISOString(),
          },
        },
      });
    }
    throw new Error(`Unexpected action: ${payload.action}`);
  };

  const result = await pollTmailorVerificationCode({
    fetchImpl,
    accessToken: 'token-login',
    step: 7,
    filterAfterTimestamp: now - 60_000,
    excludeCodes: ['112233'],
    maxAttempts: 2,
    intervalMs: 0,
    now,
  });

  assert.equal(result.code, '665544');
  assert.equal(result.mailId, 'mail-login-b');
});

test('pollTmailorVerificationCode retries transient listinbox failures before succeeding', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  const sleeps = [];
  const retryEvents = [];
  let calls = 0;

  const fetchImpl = async (_url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action !== 'listinbox') {
      throw new Error(`Unexpected action: ${payload.action}`);
    }

    calls += 1;
    if (calls === 1) {
      throw new Error('socket hang up');
    }

    return createJsonResponse({
      msg: 'ok',
      code: 'list-retry-ok',
      data: {
        item1: {
          id: 'mail-retry-ok',
          email_id: 'detail-retry-ok',
          subject: '你的 ChatGPT 代码为 998877',
          from: 'OpenAI',
          created_at: new Date(now).toISOString(),
        },
      },
    });
  };

  const result = await pollTmailorVerificationCode({
    fetchImpl,
    accessToken: 'token-retry',
    step: 4,
    filterAfterTimestamp: now - 60_000,
    maxAttempts: 1,
    maxRequestRetries: 2,
    retryDelayMs: 1500,
    intervalMs: 0,
    now,
    sleep: async (ms) => { sleeps.push(ms); },
    onRetry: async (event) => { retryEvents.push(event); },
  });

  assert.equal(result.code, '998877');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1500]);
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].stage, 'listinbox');
  assert.match(retryEvents[0].error.message, /socket hang up/i);
});

test('pollTmailorVerificationCode times out a hanging listinbox request and retries', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  const retryEvents = [];
  let calls = 0;

  const fetchImpl = async (_url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action !== 'listinbox') {
      throw new Error(`Unexpected action: ${payload.action}`);
    }

    calls += 1;
    if (calls === 1) {
      return new Promise(() => {});
    }

    return createJsonResponse({
      msg: 'ok',
      code: 'list-timeout-ok',
      data: {
        item1: {
          id: 'mail-timeout-ok',
          email_id: 'detail-timeout-ok',
          subject: '你的 ChatGPT 代码为 443322',
          from: 'OpenAI',
          created_at: new Date(now).toISOString(),
        },
      },
    });
  };

  const result = await pollTmailorVerificationCode({
    fetchImpl,
    accessToken: 'token-timeout',
    step: 4,
    filterAfterTimestamp: now - 60_000,
    maxAttempts: 1,
    maxRequestRetries: 2,
    retryDelayMs: 1,
    requestTimeoutMs: 5,
    intervalMs: 0,
    now,
    onRetry: async (event) => { retryEvents.push(event); },
  });

  assert.equal(result.code, '443322');
  assert.equal(calls, 2);
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].stage, 'listinbox');
  assert.match(retryEvents[0].error.message, /timed out/i);
});

test('pollTmailorVerificationCode reports polling progress when the inbox is still empty', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  const progressEvents = [];
  let attempts = 0;

  const fetchImpl = async (_url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action !== 'listinbox') {
      throw new Error(`Unexpected action: ${payload.action}`);
    }

    attempts += 1;
    return createJsonResponse({
      msg: 'ok',
      code: `list-empty-${attempts}`,
      data: {},
    });
  };

  await assert.rejects(
    () => pollTmailorVerificationCode({
      fetchImpl,
      accessToken: 'token-empty',
      step: 4,
      filterAfterTimestamp: now - 60_000,
      maxAttempts: 2,
      intervalMs: 0,
      now,
      onPollAttempt: async (event) => { progressEvents.push(event); },
    }),
    /No matching verification email found/i
  );

  assert.equal(progressEvents.length, 2);
  assert.deepEqual(
    progressEvents.map((event) => ({
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      matchedCount: event.matchedCount,
      candidateFound: event.candidateFound,
    })),
    [
      { attempt: 1, maxAttempts: 2, matchedCount: 0, candidateFound: false },
      { attempt: 2, maxAttempts: 2, matchedCount: 0, candidateFound: false },
    ]
  );
});

test('pollTmailorVerificationCode reports poll start before a hanging listinbox request times out', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  const pollStartEvents = [];

  const fetchImpl = async (_url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action !== 'listinbox') {
      throw new Error(`Unexpected action: ${payload.action}`);
    }

    return await new Promise(() => {});
  };

  await assert.rejects(
    () => pollTmailorVerificationCode({
      fetchImpl,
      accessToken: 'token-hanging',
      step: 4,
      filterAfterTimestamp: now - 60_000,
      maxAttempts: 1,
      maxRequestRetries: 0,
      requestTimeoutMs: 5,
      intervalMs: 0,
      now,
      onPollStart: async (event) => { pollStartEvents.push(event); },
    }),
    /timed out/i
  );

  assert.deepEqual(
    pollStartEvents.map((event) => ({
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
    })),
    [
      { attempt: 1, maxAttempts: 1 },
    ]
  );
});

test('pollTmailorVerificationCode always fetches the full inbox instead of sending the incremental listid header', async () => {
  const now = new Date('2026-04-10T10:00:00.000Z').getTime();
  const listHeaders = [];

  const fetchImpl = async (_url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (payload.action !== 'listinbox') {
      throw new Error(`Unexpected action: ${payload.action}`);
    }

    listHeaders.push(options.headers || {});
    return createJsonResponse({
      msg: 'ok',
      code: `list-full-${listHeaders.length}`,
      data: listHeaders.length === 2
        ? {
          item1: {
            id: 'mail-full',
            email_id: 'detail-full',
            subject: '你的 ChatGPT 代码为 445566',
            from: 'OpenAI',
            created_at: new Date(now).toISOString(),
          },
        }
        : {},
    });
  };

  const result = await pollTmailorVerificationCode({
    fetchImpl,
    accessToken: 'token-full',
    step: 4,
    filterAfterTimestamp: now - 60_000,
    maxAttempts: 2,
    intervalMs: 0,
    now,
  });

  assert.equal(result.code, '445566');
  assert.deepEqual(listHeaders.map((headers) => Boolean(headers.listid)), [false, false]);
});

test('pollTmailorVerificationCode requires an access token', async () => {
  await assert.rejects(
    () => pollTmailorVerificationCode({ step: 4, maxAttempts: 1, intervalMs: 0 }),
    /requires an access token/i
  );
});

test('checkTmailorApiConnectivity reports api as reachable after warmup succeeds', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method || options.method === 'GET') {
      return createJsonResponse({ ok: true });
    }

    const payload = JSON.parse(options.body);
    assert.equal(payload.action, 'newemail');
    return createJsonResponse({ msg: 'ok', email: 'probe@example.com', accesstoken: 'probe-token' });
  };

  const result = await checkTmailorApiConnectivity({ fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.message, 'API is reachable.');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'POST');
});

test('checkTmailorApiConnectivity reports Cloudflare captcha when warmup succeeds but API is risk-blocked', async () => {
  const calls = [];
  const fetchImpl = async (_url, options = {}) => {
    calls.push(options.method || 'GET');
    if (!options.method || options.method === 'GET') {
      return createJsonResponse({ ok: true });
    }

    const payload = JSON.parse(options.body);
    assert.equal(payload.action, 'newemail');
    return createJsonResponse({ msg: 'error', code: 'errorcaptcha' });
  };

  const result = await checkTmailorApiConnectivity({ fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(result.message, /cloudflare captcha/i);
  assert.deepEqual(calls, ['GET', 'POST']);
});

test('checkTmailorApiConnectivity reports a temporary failure when warmup fails', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    async text() {
      return 'Service unavailable';
    },
  });

  const result = await checkTmailorApiConnectivity({ fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(result.message, /503/);
});
