# ✨ AIで文章を作成

記録の「題名・日付・場所・分類・メモ」から、80〜120文字の思い出の文章を作る。

## しくみ
1. アプリ（GitHub Pages）が Firebase のIDトークンを付けて `https://hibiruka-line.okm-co.workers.dev/ai/memory-text` に送る。
2. Worker（`line-worker/ai.mjs`）がトークンの署名・プロジェクト・期限を確認する（Googleの公開鍵）。
3. 1人1日10回、全体で1日300回まで（`aiUsage` に回数を保存、アプリからは読めない）。
4. Claude API（`claude-haiku-4-5`）に、指示文（`SYSTEM_PROMPT`）と記録を `<記録>` で囲んで送る。
5. 返ってきた文章をアプリに表示。「メモに入れる」「もう一度作る」「やめる」、入れたあとは「元に戻す」。

APIキーは Worker の中だけにあり、アプリ（公開ページ）には入らない。

## 公開
GitHub Secrets に `ANTHROPIC_API_KEY` を追加し、`ヒビルカ送信の修正反映` を実行（または line-worker を変更して main に反映）。
キーがないあいだ、ボタンは「準備中」と表示するだけで、ほかの機能には影響しない。

## 費用の目安
Haiku 4.5 は入力 $1・出力 $5（100万トークンあたり）。1回はおよそ入力700・出力200トークンなので、約0.2円。上限300回/日でも1日約60円。
Anthropic Console で月の上限額（Spend limit）を設定しておく。
