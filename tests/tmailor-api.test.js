const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
  });

  assert.equal(result.email, 'third@fresh-allowed.com');
  assert.equal(result.domain, 'fresh-allowed.com');
  assert.equal(result.accessToken, 'token-3');
  assert.equal(calls.filter((entry) => entry.options?.method === 'POST').length, 3);
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

test('pollTmailorVerificationCode requires an access token', async () => {
  await assert.rejects(
    () => pollTmailorVerificationCode({ step: 4, maxAttempts: 1, intervalMs: 0 }),
    /requires an access token/i
  );
});
