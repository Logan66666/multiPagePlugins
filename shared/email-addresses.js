(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.EmailAddresses = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  const DEFAULT_EMAIL_SOURCE = 'tmailor';
  const DEFAULT_33MAIL_DOMAIN_SETTINGS = Object.freeze({
    '163': { emailDomain: '' },
    qq: { emailDomain: '' },
    inbucket: { emailDomain: '' },
  });

  function sanitizeEmailSource(value) {
    return value === '33mail' || value === 'duck' || value === 'tmailor'
      ? value
      : DEFAULT_EMAIL_SOURCE;
  }

  function createDefault33MailDomainSettings() {
    return {
      '163': { emailDomain: '' },
      qq: { emailDomain: '' },
      inbucket: { emailDomain: '' },
    };
  }

  function normalizeEmailDomain(domain) {
    return String(domain || '').trim().replace(/^@+/, '').toLowerCase();
  }

  function normalize33MailDomainSettings(value = {}) {
    const settings = createDefault33MailDomainSettings();

    for (const provider of Object.keys(settings)) {
      settings[provider].emailDomain = normalizeEmailDomain(value?.[provider]?.emailDomain);
    }

    return settings;
  }

  function get33MailDomainForProvider(settings, provider) {
    const normalizedSettings = normalize33MailDomainSettings(settings);
    return normalizedSettings[provider]?.emailDomain || '';
  }

  function pickRandomItem(items, randomFn) {
    return items[Math.floor(randomFn() * items.length)] || items[0];
  }

  function generate33MailAddress(domain, options = {}) {
    const normalizedDomain = normalizeEmailDomain(domain);
    if (!normalizedDomain) {
      throw new Error('No 33mail domain configured. Enter the 33mail domain in the side panel first.');
    }

    const randomFn = typeof options.randomFn === 'function' ? options.randomFn : Math.random;
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const consonants = ['l', 'm', 'n', 'r', 's', 't', 'v', 'z', 'b', 'd', 'f', 'g', 'h', 'k', 'p'];
    const vowels = ['a', 'e', 'i', 'o', 'u'];
    const digits = '0123456789';
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

    let localPart = '';
    for (let i = 0; i < 4; i++) {
      localPart += pickRandomItem(consonants, randomFn);
      localPart += pickRandomItem(vowels, randomFn);
    }
    localPart += digits[Math.floor(randomFn() * digits.length)];
    localPart += digits[Math.floor(randomFn() * digits.length)];
    localPart += now.toString(36).slice(-3);

    // Add one extra random suffix char so multiple addresses generated in the same millisecond still diverge.
    localPart += alphabet[Math.floor(randomFn() * alphabet.length)];

    return `${localPart}@${normalizedDomain}`;
  }

  return {
    DEFAULT_EMAIL_SOURCE,
    DEFAULT_33MAIL_DOMAIN_SETTINGS,
    createDefault33MailDomainSettings,
    generate33MailAddress,
    get33MailDomainForProvider,
    normalize33MailDomainSettings,
    normalizeEmailDomain,
    sanitizeEmailSource,
  };
});
