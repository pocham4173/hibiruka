// 公開サイトキー（秘密鍵ではありません）。Firebase/Google Cloudで登録してから設定します。
// 空欄の間は未導入状態です。設定後は正規通信を確認してからFirestoreの強制適用を有効にします。
(function(root) {
  const config = Object.freeze({ siteKey: '' });
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
  else root.HibirukaAppCheckConfig = config;
})(typeof globalThis !== 'undefined' ? globalThis : this);
