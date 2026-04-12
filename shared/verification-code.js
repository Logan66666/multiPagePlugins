(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.VerificationCode = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  const REJECT_PATTERNS = [
    /验证码错误/i,
    /验证码有误/i,
    /代码不正确/i,
    /输入的代码有误/i,
    /无效(?:的)?验证码/i,
    /verification\s*code\s*(?:is\s*)?invalid/i,
    /invalid\s*verification\s*code/i,
    /incorrect\s*code/i,
    /wrong\s*code/i,
    /code\s+you\s+entered\s+is\s+incorrect/i,
    /code\s+does(?:\s+not|'t)\s+match/i,
  ];
  const RETRY_STATE_PATTERNS = [
    /\bretry\b/i,
    /try\s+again/i,
    /请重试/i,
    /重新尝试/i,
    /验证失败/i,
  ];

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function isVerificationCodeRejectedText(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }

    return REJECT_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  function isVerificationRetryStateText(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }

    return RETRY_STATE_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  return {
    isVerificationCodeRejectedText,
    isVerificationRetryStateText,
  };
});
