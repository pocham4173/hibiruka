(function(root) {
  'use strict';
  function start(firebase, config) {
    const siteKey = String(config?.siteKey || '').trim();
    if (!siteKey) return 'not-configured';
    if (typeof firebase?.appCheck !== 'function') return 'unavailable';
    try {
      const provider = new firebase.appCheck.ReCaptchaEnterpriseProvider(siteKey);
      firebase.appCheck().activate(provider, true);
      // SDK起動と、Firebase側の強制適用・トークン検証成功は別。
      return 'started';
    } catch { return 'unavailable'; }
  }
  const api = { start };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HibirukaAppCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
