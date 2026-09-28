(() => {
  let installPrompt = null, installedHere = false;
  const installed = () => installedHere || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function update() {
    document.querySelectorAll('[data-install]').forEach(button => {
      button.textContent = installed() ? 'ホームに追加済み' : 'ホームに追加';
      button.disabled = installed();
      if (button.closest('.install-shortcut')) button.closest('.install-shortcut').hidden = installed();
    });
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    update();
    document.getElementById('installNative').hidden = false;
  });
  window.addEventListener('appinstalled', () => { installedHere = true; installPrompt = null; update(); });
  const dialog = document.createElement('dialog');
  dialog.id = 'installGuide';
  dialog.setAttribute('aria-labelledby', 'installTitle');
  dialog.innerHTML = '<h2 id="installTitle">ホーム画面に追加</h2><ol id="installSteps"></ol><button type="button" class="btn navy" id="installNative" hidden>追加する</button><a class="btn navy" id="installChrome" hidden>Chromeで開いて追加する</a><button type="button" class="btn sub" id="installCopy">アプリのURLをコピー</button><button type="button" class="btn navy" id="installClose">閉じる</button><p id="installMessage" role="status"></p>';
  document.body.append(dialog);
  const cleanUrl = new URL('./', location.href).href;
  const chrome = document.getElementById('installChrome');
  const installUrl = new URL(cleanUrl); installUrl.searchParams.set('install', '1');
  chrome.href = 'intent://' + installUrl.host + installUrl.pathname + installUrl.search + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(installUrl.href) + ';end';
  document.getElementById('installNative').onclick = function () { install(this); };
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
        const choice = await event.userChoice;
        if (choice.outcome === 'accepted') { dialog.close(); }
        return;
      } catch { /* Show browser-specific instructions below. */ }
      finally { button.disabled = false; update(); }
    }
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const inApp = /Line\/|FBAN|FBAV|Instagram|; wv\)/i.test(ua);
    const android = /Android/i.test(ua);
    chrome.hidden = !android || !inApp;
    document.getElementById('installNative').hidden = !installPrompt;
    const steps = inApp
      ? ios ? ['画面のメニューから「Safariで開く」を押す', 'Safariの共有（□↑）から「ホーム画面に追加」を押す']
        : ['下の「Chromeで開いて追加する」を押す', '開いた画面で「ホームに追加」を押す']
      : ios ? ['共有ボタン（□↑）を押す', '「ホーム画面に追加」→「追加」を押す']
      : android ? ['ブラウザのメニュー（⋮ または ☰）を押す', '「ホーム画面に追加」または「アプリをインストール」→「追加」を押す']
      : ['ブラウザのメニューを開く', '「ヒビルカをインストール」を選ぶ'];
    const list = document.getElementById('installSteps'); list.replaceChildren();
    steps.forEach(text => { const li = document.createElement('li'); li.textContent = text; list.append(li); });
    document.getElementById('installMessage').textContent = '';
    if (!dialog.open) dialog.showModal();
  }
  document.querySelectorAll('[data-install]').forEach(button => { button.onclick = () => install(button); });
  update();
  if (new URLSearchParams(location.search).has('install') && !installed()) install(document.querySelector('[data-install]'));
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
