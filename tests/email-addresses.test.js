const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_EMAIL_SOURCE,
  createDefault33MailDomainSettings,
  generate33MailAddress,
  get33MailDomainForProvider,
  normalize33MailDomainSettings,
  normalizeEmailDomain,
  sanitizeEmailSource,
} = require('../shared/email-addresses.js');

test('sanitizeEmailSource keeps known sources and falls back to tmailor', () => {
  assert.equal(sanitizeEmailSource('duck'), 'duck');
  assert.equal(sanitizeEmailSource('33mail'), '33mail');
  assert.equal(sanitizeEmailSource('tmailor'), 'tmailor');
  assert.equal(sanitizeEmailSource('qq'), DEFAULT_EMAIL_SOURCE);
  assert.equal(sanitizeEmailSource(undefined), DEFAULT_EMAIL_SOURCE);
});

test('normalize33MailDomainSettings keeps provider domains and ignores invalid values', () => {
  assert.deepEqual(
    normalize33MailDomainSettings({
      '163': { domain: 'bad-shape' },
      qq: { emailDomain: 'Mail.QQ.COM' },
      inbucket: { emailDomain: '@box.test ' },
    }),
    {
      '163': { emailDomain: '' },
      qq: { emailDomain: 'mail.qq.com' },
      inbucket: { emailDomain: 'box.test' },
    }
  );

  assert.deepEqual(createDefault33MailDomainSettings(), {
    '163': { emailDomain: '' },
    qq: { emailDomain: '' },
    inbucket: { emailDomain: '' },
  });
});

test('get33MailDomainForProvider returns normalized active provider domain', () => {
  const settings = normalize33MailDomainSettings({
    '163': { emailDomain: 'alpha.33mail.com' },
    qq: { emailDomain: 'beta.33mail.com' },
  });

  assert.equal(get33MailDomainForProvider(settings, '163'), 'alpha.33mail.com');
  assert.equal(get33MailDomainForProvider(settings, 'qq'), 'beta.33mail.com');
  assert.equal(get33MailDomainForProvider(settings, 'inbucket'), '');
});

test('generate33MailAddress builds a deterministic random alias when helpers are injected', () => {
  const randomValues = [0.5, 0.2, 0.8, 0.1, 0.3, 0.6, 0.4, 0.7];
  let randomIndex = 0;
  const email = generate33MailAddress(' @demo.33mail.com ', {
    randomFn: () => {
      const value = randomValues[randomIndex % randomValues.length];
      randomIndex += 1;
      return value;
    },
    now: 1712668800000,
  });

  assert.equal(normalizeEmailDomain('@Demo.33MAIL.com '), 'demo.33mail.com');
  assert.equal(email, 'zehasovo527pc2@demo.33mail.com');
});

test('generate33MailAddress keeps aliases readable without a fixed machine-like prefix', () => {
  const email = generate33MailAddress('demo.33mail.com', {
    randomFn: () => 0.42,
    now: 1712668800123,
  });

  assert.match(email, /^[a-z]{8}\d{2}[0-9a-z]{4}@demo\.33mail\.com$/);
  assert.doesNotMatch(email, /^sf/i);
});
