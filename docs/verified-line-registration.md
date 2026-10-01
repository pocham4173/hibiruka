# LINE登録のサーバー本人確認（公開準備中）

現時点では未公開。既存の送信Worker・通知予約・登録済み送信先は変更しない。

## 変更

ブラウザーはFirebase IDトークンとLIFFアクセストークンを専用APIへ送る。APIはGoogleでFirebaseトークンを検証し、LINEでアクセストークンの発行先チャネル、有効期限、profile権限を検証する。LINEから取得した本人のプロフィールだけを招待に保存する。クライアント指定のLINEユーザーIDや名前は受け付けない。

招待の承認はトランザクションで一度だけ行う。同じ本人・同じFirebase利用者による再試行は成功扱いとし、他の利用者による上書きは拒否する。新しいFirestoreルールではブラウザーによる直接承認を拒否する。

## 公開前に必要な情報

LINE DevelopersのヒビルカのLINEログインチャネル → 基本設定 → チャネルIDを確認する。LIFF IDの数字部分から推測しない。Messaging APIチャネルとLINEログインチャネルが同じプロバイダーに属することも確認する。必要なのは公開識別子であり、チャネルシークレットやアクセストークンをチャットに貼らない。

## 検証・公開順序

1. このブランチのCIで実際の既存ルールから移行候補を作り、エミュレーターで既存保存機能・アクセス分離・偽の承認拒否を確認する。Workerはdry-runのみ。
2. 確認したLINE_LOGIN_CHANNEL_IDと既存の安全な秘密情報設定を使用し、line-auth/deploy.cjsで専用hibiruka-auth Workerを先に公開する。通知Workerは変更しない。
3. 実際のLINEログインで本人確認を検証する。通知の実送信は別の確認項目であり、このAPIは通知を送らない。
4. API稼働を確認後にフロントエンドを公開し、その後準備済みルールを反映する。古い画面からの直接登録は拒否されるため再読み込み案内を確認する。UIをAPIより先に公開しない。
5. iPhone・Androidで招待承認と再試行を確認する。既存の予約・記録を維持する。

既存登録は遡って本人確認済みとは扱わない。新規承認にverificationVersionとlineVerifiedAtを記録する。失敗時にクライアント直接書き込みへ戻すフォールバックは設けない。

参考: https://developers.line.biz/en/docs/liff/using-user-profile/ 、https://firebase.google.com/docs/reference/rest/auth/
