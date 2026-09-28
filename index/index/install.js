(() => {
  let installPrompt = null, installedHere = false;
  const installed = () => installedHere || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function update() {
    document.querySelectorAll('[data-install]').forEach(button => {
      button.textContent = installed() ? 'ホームに追加済み' : 'ホームに追加';
      button.disabled = installed();
    });
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    update();
  });
  window.addEventListener('appinstalled', () => { installedHere = true; installPrompt = null; update(); });
  const dialog = document.createElement('dialog');
  dialog.id = 'installGuide';
  dialog.setAttribute('aria-labelledby', 'installTitle');
  dialog.innerHTML = '<h2 id="installTitle">ホーム画面に追加</h2><p id="installSteps"></p><button type="button" class="btn sub" id="installCopy">アプリのURLをコピー</button><button type="button" class="btn navy" id="installClose">閉じる</button><p id="installMessage" role="status"></p>';
  document.body.append(dialog);
  const cleanUrl = new URL('./', location.href).href;
  document.getElementById('installClose').onclick = () => dialog.close();
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  document.getElementById('installCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(cleanUrl); document.getElementById('installMessage').textContent = 'コピーしました。ブラウザのアドレス欄に貼り付けて開いてください。'; }
    catch { document.getElementById('installMessage').textContent = cleanUrl; }
  };
  async function install(button) {
    if (installed()) return update();
    if (installPrompt) {
      const event = installPrompt; installPrompt = null;
      button.disabled = true;
      try {
        await event.prompt();
        await event.userChoice;
        return;
      } catch { /* Show browser-specific instructions below. */ }
      finally { button.disabled = false; update(); }
    }
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const inApp = /Line\/|FBAN|FBAV|Instagram|; wv\)/i.test(ua);
    document.getElementById('installSteps').textContent = inApp
      ? `この画面のメニューから「${ios ? 'Safari' : 'ブラウザ'}で開く」を選んでください。開けない場合は、下のURLをコピーして${ios ? 'Safari' : 'Chrome'}で開き、もう一度「ホームに追加」を押してください。`
      : ios ? 'Safariの共有ボタン（□↑）→「ホーム画面に追加」→「追加」を押してください。'
      : /Android/i.test(ua) ? 'ブラウザのメニュー（⋮ または ☰）→「ホーム画面に追加」または「アプリをインストール」を選んでください。'
      : 'ブラウザのメニューから「ヒビルカをインストール」または「アプリをインストール」を選んでください。';
    document.getElementById('installMessage').textContent = '';
    dialog.showModal();
  }
  document.querySelectorAll('[data-install]').forEach(button => { button.onclick = () => install(button); });
  update();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
