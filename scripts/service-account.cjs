const { createPrivateKey } = require('node:crypto');

const invalid = 'FIREBASE_SERVICE_ACCOUNTの形式が正しくありません。FirebaseのサービスアカウントJSONを、最初の { から最後の } までSecretsに保存してください（秘密鍵をチャットに貼らないでください）。';

function parseServiceAccount(raw) {
  let value = String(raw || '').trim().replace(/^\uFEFF/, '');
  value = value.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  const candidates = [value];
  // A common copy mistake is omitting only the outer object braces.
  if (/^"(?:type|project_id|private_key_id|private_key|client_email)"\s*:/.test(value)) {
    candidates.push('{' + value.replace(/,\s*$/, '') + '}');
    if (value.endsWith('}')) candidates.push('{' + value);
  } else if (value.startsWith('{') && !value.endsWith('}')) {
    candidates.push(value.replace(/,\s*$/, '') + '}');
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 100) {
    candidates.push(Buffer.from(value, 'base64').toString('utf8'));
  }
  for (const candidate of candidates) {
    try {
      let parsed = JSON.parse(candidate);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      if (!parsed || parsed.type !== 'service_account' || typeof parsed.project_id !== 'string' || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') continue;
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      createPrivateKey(parsed.private_key);
      return parsed;
    } catch { /* Never surface JSON.parse errors: they can include secret text. */ }
  }
  throw new Error(invalid);
}
module.exports = { parseServiceAccount };
