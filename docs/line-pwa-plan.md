# ヒビルカ：LINEを入口にした継続利用の仕様と実装

## 優先順位
継続率の実測データはまだないため、以下は現在の実装と利用者からの困りごとに基づく仮説。

|順番|機能|理由|今回|
|---|---|---|---|
|1|最初の1件を保存できる初回案内|登録後に何をすればよいかが明確になる。既存フォームを再利用できる|実装|
|2|保存後のホーム追加と端末別案内|使った直後に、次回開く入口を作る。既存PWAを改善するため費用が小さい|実装|
|3|LINE通知の継続運用と本人確認の強化|毎分送信は稼働済み。別の送信サーバーを増やす必要はない。LINEでの自動ログインは移行・本人確認を伴う|送信は既存を維持。自動ログインは次段階|

## 1. 初回案内
- 初めての個人アカウントで記録が0件の場合、「予定を入れる」「思い出を残す」を表示。
- 押すと該当する種類の既存フォームへ進む。日付・場所または内容・分類を入れて保存。
- 写真・LINE登録・ホーム追加・チュートリアル完了は開始の必須条件にしない。
- 「あとで」で閉じられる。閉じた状態はブラウザとFirebase UIDごとに保持する。
- 最初の保存後、ホーム追加／自分のLINE登録を案内する。予定の場合は既存の通知予約画面を先に表示する。
- 既存ユーザーの記録・承認・ログイン状態は変更しない。

## 2. リッチメニューの導線
LINE Official Account Managerではアクションを「リンク」に設定する。メッセージ送信アクションにしない。
現在の運用では以下のWeb URLを使用できる。

|ボタン名|URL|
|---|---|
|予定を見る|https://pocham4173.github.io/hibiruka/index/index/?tab=list&view=cal|
|予定・思い出を残す|https://pocham4173.github.io/hibiruka/index/index/?tab=rec|
|思い出を見る|https://pocham4173.github.io/hibiruka/index/index/?tab=list&view=mem|
|設定|https://pocham4173.github.io/hibiruka/index/index/?tab=set|
|使い方|https://pocham4173.github.io/hibiruka/index/index/?intro=1|
|ホームに追加|https://pocham4173.github.io/hibiruka/index/index/?intro=1&install=1|

既存セッションがあれば目的画面へ、初回は「はじめる」へ。開始時にも目的タブを保持する。
LIFFで同じtab/viewがliff.stateに包まれた場合も解釈する。inviteを含むリンクだけを招待承認へ進め、単なるLIFFメニューを招待と誤認しない。
ただしブラウザ間でFirebase匿名セッションは共有されない。別ブラウザで同じ記録を開く前にメール登録・ログインで引き継ぐ。
リッチメニューの管理画面への反映は今回行っていない。上記URLは設定用。

## 3. PWAの組込みコード
- manifest.webmanifest：既存のid/start_url/scopeを維持。192/512 PNG、standalone、予定と思い出のショートカット。
- install.js：beforeinstallpromptを保持し、タップ時だけprompt()を呼ぶ。1イベントにつき1回。appinstalled後は追加済み表示。
- Android Chrome：対応時はボタン→OSの確認。準備できない場合はメニューでの手順を開く。ChromeからChromeへ戻る誘導は表示しない。
- LINE内Android：Chromeで開くボタンと手順。別ブラウザへ移る前に記録の引き継ぎを案内する。
- iPhone：共有→ホーム画面に追加。OSの操作をWeb側で省略することはできない。
- sw.js：ネットワークを優先。公開オフライン案内とアイコンだけをキャッシュ。個人の予定・写真・招待URL・Firebase/LINEレスポンスはキャッシュしない。
- 古いキャッシュはヒビルカ専用名のものだけ削除。他のGitHub Pagesアプリのキャッシュは削除しない。
- オフライン時は案内と再読込みのみ。オフライン編集・写真保存・同期は今回含まない。保存済みの通知予約はサーバーで実行される。

実装ファイルは index/index/ 以下。HTMLには既にmanifestリンクとinstall.jsが組み込まれている。

## 4. LINE通知バックエンド
稼働中コード：line-worker/index.mjs、line-worker/firestore.mjs、scripts/line-engine.cjs。
Cloudflare Cron→Firestore予約→承認済み受信者・所有者照合→LINE Messaging API→受付結果を保存。
端末・Webページを閉じても動作する。1回最大2予約。3分リース、同一予約のリトライキーを使う。
Node.js用の同じ処理はscripts/send-line.cjsで利用できるが、旧GitHubの自動送信は停止済み。別のCloud Functionsや端末タイマーで二重送信を作らない。
LINEへの受付成功は端末への到着保証ではない。ブロック・配信上限・通信障害を区別して扱う。

## 5. LINEだけで自動識別する次段階の仕様（未実装）
今のFirebase匿名/メール認証を維持し、LINE認証は別途本人確認と既存記録の移行設計を完成させてから導入する。
1. LIFF init。未ログインなら利用者の操作からLINEログイン・同意へ。
2. liff.getIDToken()をHTTPSで自前認証サーバーへ渡す。getProfileのuserIdやgetDecodedIDTokenの内容だけを信用しない。
3. サーバーがLINEのPOST https://api.line.me/oauth2/v2.1/verifyへid_tokenと固定client_idを送り、有効性・対象チャンネル・subを確認。
4. LINE LoginチャンネルとMessaging APIが同じProviderであることを管理画面で確認する。
5. サーバー専用のLINE sub→Firebase UID対応表で既存利用者を識別。Firebase Adminでcustom tokenを発行。クライアントはsignInWithCustomTokenで既存UIDへログインする。
6. 既存匿名/メール利用者との結び付けは、現在のFirebase ID tokenとLINE ID tokenの両方を検証し、重複リンクをトランザクションで拒否する。LINEプロフィール名の一致で統合しない。
7. 同じ端末に他人の記録がある場合は無言で切り替えず、利用者に選択させる。ログアウト・紛失・解除の仕様も含める。
8. 招待承認時のlineUserIdもサーバー検証結果から記録する。現在のクライアント側プロフィール取得を、認証済みLINEアカウントの証明として流用しない。
このAPIを定期送信Workerの一般公開HTTPへ安易に追加しない。レート制限、許可Origin、トークンをログに残さない処理が必要。

## 受入条件・効果の確認
- 初回案内から予定/思い出それぞれを保存できる。
- 既存アカウント・招待承認・個人別保存の回帰テストが成功する。
- LIFFメニューは指定画面へ、招待は承認画面へ分岐する。
- Androidのnative promptは1回のみ。非対応では具体的な手順を表示する。
- 通信切断時に案内が表示され、個人データをキャッシュしない。
- Pixel/Chrome・iPhone/Safari・LINE内ブラウザの実機確認は別途必要。
- 導入後は「初回1件の保存まで進めたか」「翌週また使えたか」を利用者に確認。閲覧・個人記録の分析収集は今回追加しない。

参照：
https://developers.line.biz/en/docs/liff/using-user-profile/
https://developers.line.biz/en/reference/liff/
https://web.dev/articles/customize-install
https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
