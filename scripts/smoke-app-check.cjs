// 手動の本番診断専用。既存の管理者資格情報で一時クライアントを検証する。
// 公開アプリから読み込まず、トークン発行用の公開URLも設けない。
const APP_ID = '1:781222934569:web:fec15f161c7ac2afad4438';
function smokeAppCheck(admin, { now = Date.now, enabled = !!require('../index/index/app-check-config.js').siteKey } = {}) {
  let cached, pending;
  async function getToken() {
    if (cached && cached.expireTimeMillis > now() + 60000) return cached;
    if (!pending) pending = (async () => {
      const issuedAt = now();
      try {
        const result = await admin.appCheck().createToken(APP_ID, { ttlMillis: 1800000 });
        if (!result.token || !Number.isFinite(result.ttlMillis) || result.ttlMillis <= 60000) throw Error();
        cached = { token: result.token, expireTimeMillis: issuedAt + result.ttlMillis };
        return cached;
      } catch { throw Error('診断用App Checkトークンを取得できません。Firebase側の設定と管理者の権限を確認してください。'); }
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    appId: APP_ID,
    activate(client) { if (enabled) client.appCheck().activate({ getToken }, false); },
    getToken,
    async headers() { return enabled ? { 'X-Firebase-AppCheck': (await getToken()).token } : {}; }
  };
}
module.exports = { smokeAppCheck };
