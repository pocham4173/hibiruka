# LINE定期送信の運用

## 現在の状態
2026-09-29 19:36 JST、Cloudflare Worker `hibiruka-line` の送信を有効化。
GitHub Actions run 36556474335 が19:36・19:37・19:38の実Cron成功を確認した。
3回とも sent=0 / failed=0。対象予約がなかったため、端末への実到着は未検証。

旧GitHub `.github/workflows/notify.yml` のscheduleは削除済み。
同ワークフローは手動実行時も接続確認のみ（VALIDATE_ONLY=true）。
切替前に旧ワークフローが実行中・待機中でないことをAPIで確認した。
画面・予定・送信先の再登録は不要。まいにこのWorkerは変更していない。

## バージョンと検証
- Workerコード: 14e7c354a0db3b62ec005b7fd3649f35663feba2
- 稼働中Cloudflare Version: cd96b878-60ff-4a2d-b845-3ae47aa1318c
- 配置・15テスト・ビルド成功: run 36555163852
- 送信しないCronの実行確認: run 36555430787
- 旧送信停止後の有効化・3回の連続稼働確認: run 36556474335
- 個人別権限検査成功: run 36556329517
- マージ: PR #2

## 仕組み
毎分、FirestoreのeventsとpersonalEventsにある予約を確認。
承認済み送信先と所有者を検証し、3分のリースとLINEの予約固有リトライキーを利用する。
Firestore RESTの更新時刻条件により競合を検出する。HTTP送信エンドポイントは公開しない。
1回最大2予約、各コレクション最大4予定。多数の同時予約や通信障害では遅れが発生する。
LINE受付成功は端末への到達の証明ではない。

## 接続情報
GitHub Actions Secret `CLOUDFLARE_API_TOKEN` を利用。
アカウントIDは利用者の画面で確認した非秘密の識別子をワークフローへ設定。
既存のFIREBASE_SERVICE_ACCOUNT・LINE_CHANNEL_ACCESS_TOKENをWorkerの暗号化シークレットに設定。
ヒビルカのFirebaseプロジェクト・LINE公式アカウント以外には接続しない。
Cloudflare・Firebaseの料金プランは変更していない。
無料枠での負荷時CPU、Firestore利用量、実通知到着は継続確認が必要。

## 今後の更新・停止
通常のline-worker.ymlは手動実行で確認モードから配置する。
更新した同一バージョンの直近Cron成功がなければ送信有効化を拒否する。
初回起動用line-worker-activate.ymlは固定した検証済みコミットを利用する一度限りの作業記録。
再実行して通常更新に流用しない。
停止時は送信しない確認モードへ配置し、enabled=falseのheartbeatを確認する。
旧GitHub送信を復元する場合も新旧を同時に稼働させず、停止確認後に行う。

管理用状態はFirestoreのschedulerStatus/cloudflare（一般利用者は読み取り不可）。
