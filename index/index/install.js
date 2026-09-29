(() => {
  let installPrompt = null, installedHere = false, prompting = false;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const inApp = /Line\/|FBAN|FBAV|Instagram|; wv\)/i.test(ua);
  const androidChrome = android && /Chrome\//i.test(ua) && !/SamsungBrowser|EdgA|OPR\//i.test(ua) && !inApp;
  const installed = () => installedHere || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const cleanUrl = new URL('./', location.href).href;
  // Public introduction only: never carry invite tokens or personal page parameters to another browser.
  const installUrl = new URL(cleanUrl); installUrl.search = '?intro=1&install=1';
  const chromeUrl = 'intent://' + installUrl.host + installUrl.pathname + installUrl.search + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(installUrl.href) + ';end';
  const dialog = document.createElement('dialog');
  dialog.id = 'installGuide';
  dialog.setAttribute('aria-labelledby', 'installTitle');
  dialog.innerHTML = '<h2 id="installTitle">ホーム画面に追加</h2><p id="installStatus" role="status"></p><button type="button" class="btn navy" id="installNative" hidden>ホームに追加する</button><a class="btn navy" id="installChrome" hidden>Chromeで開く</a><p id="installTransfer" hidden>別のブラウザで同じ記録を開くには、先にヒビルカの設定でメールを登録し、移動先でログインしてください。</p><details id="installFallback"><summary>ボタンで追加できないとき</summary><ol id="installSteps"></ol><button type="button" class="btn sub" id="installCopy">追加用リンクをコピー</button></details><button type="button" class="btn sub" id="installClose">閉じる</button><p id="installMessage" role="status"></p>';
  document.body.append(dialog);
  const native = document.getElementById('installNative');
  const chrome = document.getElementById('installChrome');
  chrome.href = chromeUrl;
  function update() {
    const done = installed();
    document.querySelectorAll('[data-install]').forEach(button => {
      button.textContent = done ? 'ホームに追加済み' : android && !androidChrome && !installPrompt ? 'Chromeで開いてホームに追加' : 'ホームに追加';
      button.disabled = done || prompting;
      if (button.closest('.install-shortcut')) button.closest('.install-shortcut').hidden = done;
    });
    document.querySelectorAll('[data-install-hint]').forEach(el => {
      el.textContent = done ? 'この端末では、ホームのアイコンから開けます。' : android ? 'Google PixelなどのAndroidにも対応。上のボタンから進めます。' : 'ホームにアイコンを置くと、次からすぐ開けます。';
    });
    native.hidden = done || !installPrompt;
    native.disabled = prompting;
    chrome.hidden = done || !!installPrompt || !android || androidChrome;
    document.getElementById("installTransfer").hidden = !inApp || document.getElementById("app")?.classList.contains("hidden") !== false;
    document.getElementById('installStatus').textContent = done ? 'ホーム画面への追加が完了しました。' : installPrompt ? '下のボタンを押して、スマホの確認画面で「インストール」を押してください。' : androidChrome ? '追加ボタンの準備ができると、この画面に表示されます。出ない場合は「ボタンで追加できないとき」を開いてください。' : android ? 'Chromeで開くと、ホームへの追加に進めます。' : ios ? 'iPhoneは共有ボタン（□↑）から追加します。' : 'ブラウザのメニューから追加できます。';
    document.getElementById('installFallback').hidden = done || !!installPrompt;
    if (done && dialog.open) dialog.close();
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); installPrompt = event;
    document.getElementById('installFallback').open = false;
    update();
  });
  window.addEventListener('appinstalled', () => { installedHere = true; installPrompt = null; update(); });
  function showGuide() {
    const steps = ios
      ? inApp ? ['画面のメニューから「Safariで開く」を押す', 'Safariの共有（□↑）から「ホーム画面に追加」→「追加」を押す']
        : ['共有ボタン（□↑）を押す', '「ホーム画面に追加」→「追加」を押す']
      : android ? ['Chromeの右上の「⋮」を押す', '「ホーム画面に追加」または「アプリをインストール」を選び、確認する']
      : ['ブラウザのメニューを開く', '「ヒビルカをインストール」を選ぶ'];
    const list = document.getElementById('installSteps'); list.replaceChildren();
    steps.forEach(text => { const li = document.createElement('li'); li.textContent = text; list.append(li); });
    document.getElementById('installFallback').open = (ios || androidChrome) && !installPrompt;
    update();
    if (!installed() && !dialog.open) dialog.showModal();
  }
  async function install() {
    if (installed() || prompting) return update();
    if (installPrompt) {
      const event = installPrompt; installPrompt = null; prompting = true; update();
      try {
        // Called directly from a tap: retain the browser's required user gesture.
        await event.prompt();
        const choice = await event.userChoice;
        if (choice.outcome === 'accepted') { if (dialog.open) dialog.close(); }
        else { showGuide(); document.getElementById('installMessage').textContent = '追加を見送りました。あとからブラウザのメニューでも追加できます。'; }
      } catch {
        showGuide(); document.getElementById('installMessage').textContent = '確認画面を開けませんでした。下の追加方法をお試しください。';
        document.getElementById('installFallback').open = true;
      } finally { prompting = false; update(); }
      return;
    }
    document.getElementById('installMessage').textContent = '';
    if (android && !androidChrome) {
      showGuide(); // Remains available if this browser cannot open the external app.
      // The explicit Chrome button lets the user read the account-transfer note first.
      return;
    }
    showGuide();
  }
  native.onclick = install;
  document.getElementById('installClose').onclick = () => dialog.close();
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  document.getElementById('installCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(installUrl.href); document.getElementById('installMessage').textContent = 'コピーしました。Chromeで開くか、追加したい人に送れます。'; }
    catch { document.getElementById('installMessage').textContent = installUrl.href; }
  };
  document.querySelectorAll('[data-install]').forEach(button => { button.onclick = install; });
  update();
  // Open the guide without attempting an external-app launch or native prompt without a tap.
  if (new URLSearchParams(location.search).has('install') && !installed()) showGuide();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
