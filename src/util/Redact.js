'use strict';

const sensitive =
  /token|secret|password|authorization|cookie|ticket|captcha_key|captcha_rqdata|captcha_rqtoken|mfaCode|TOTPKey/i;

function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitive.test(key) || (key === 'data' && value.mfa_type) ? '[REDACTED]' : redact(item, seen),
    ]),
  );
}

redact.path = value =>
  typeof value === 'string'
    ? value
        .replace(/(\/webhooks\/[^/]+\/)[^/?]+/g, '$1[REDACTED]')
        .replace(/([?&](?:token|authorization|code)=)[^&]+/gi, '$1[REDACTED]')
    : value;

module.exports = redact;
