# LINE定期送信の切替

## 状態
2026-09-29 19:22 JST、GitHub Actions run 36555163852で15テスト・ビルド・Cloudflare配置に成功。hibiruka-lineはSENDING_ENABLED=falseの確認専用状態。既存のGitHub定期送信は継続。run 36555430787で実Cronの成功記録を読み取り確認中。新WorkerによるLINE送信はまだ有効化していない。画面や既存予約の移行は不要。

旧送信を残したまま自動有効化する案は、自動承認審査が二重通知リスクを理由に拒否した。起動用ワークフローは保存・実行されていない。次の切替は旧経路停止・実行中ジョブ確認を含めて行う。承認拒否を迂回しない。

## 仕組み
Cloudflare Cronが毎分、Firestoreの既存・個人別予約を直接確認。GitHub Actionsのジョブ起動を待たずにLINEへ送る。日本時間の予約文字列、所有者と承認済み送信先の照合、3分の送信リース、予約固有のLINEリトライキーを既存処理と共有する。一般公開された送信HTTP APIは作らない。

無料WorkersのCPU制限を考慮し、各コレクションから最大4予定、1回につき最大2予約を処理。多数の同時予約や再試行では遅れが生じる。正確な秒単位の配信や端末への到達を保証しない。無料枠内での実際のCPU使用量は本番観測で確認する必要がある。Cloudflareプラン・Firebase課金プランは変更しない。毎分の確認では最低2クエリ/分と状態保存1回/分が発生するため、既存利用と合わせてFirestoreの無料枠を確認する。

## 接続・切替
1. Cloudflareアカウントに対象を限定した「Workers Scripts: Edit」「Account Settings: Read」のAPIトークンを作成。GitHubのこのリポジトリのActions Secretsに `CLOUDFLARE_API_TOKEN` を登録。アカウントIDは利用者の画像で確認済みの非秘密識別子をワークフローに設定済み。チャットやコードに鍵を貼らない。
2. 変更をmainへ反映してから「LINE定期送信の検査と切替」を手動実行。enable_sendingはfalse。既存のFirebase・LINE SecretsをWorkerの暗号化シークレットへ設定し、確認だけのCronを公開する。ヒビルカ以外のプロジェクト・LINEアカウントなら停止する。
3. Cron反映には最大15分程度かかる。Firestoreの管理用 `schedulerStatus/cloudflare` の checkedAt/ok/version を確認。これは一般利用者から読めない管理状態。失敗時はCloudflareログとCPU制限を調べ、有料へ自動変更しない。
4. 切替前に旧GitHub scheduleを停止し、実行中の送信がないことを確認する。同じ検証済みコミットでenable_sending=trueを実行。直近3分以内の確認成功・同一バージョンがなければ有効化を拒否する。予約済みの通知のみ送る。
5. 起動時刻、LINEの受付結果、ユーザーが許可した予約の実際の到着、CPU使用量を確認する。切替後に旧GitHub scheduleが停止していることを再確認する。共有リースと同一LINEリトライキーにより重複受付を防ぐ。
6. 失敗時はenable_sending=falseで戻す。GitHub送信を停止済みならscheduleを復元する。

LINEのリトライキーの有効期間や配信上限、通信障害は別途適用される。LINE受付成功は端末への到達の証明ではない。

## 検査
`node --test tests/line.test.cjs tests/worker.test.mjs`
`npm ci --prefix line-worker && npm run build --prefix line-worker`

本番のLINEへのテスト送信は未実施。
