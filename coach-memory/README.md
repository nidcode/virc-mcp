# coach-memory — ローカル版エントリ

stdio MCP サーバー。記憶は `../coach/` の markdown に置きます。

**ツール定義とハンドラは `../core/tools.js`** にあり、本番版（`../worker/`）と共有しています。
このディレクトリにあるのはストレージアダプタと入口だけです。

```
server.js            stdio MCP（薄い。core を呼ぶだけ）
lib/fs-store.js      store 契約 ← markdown ファイル
lib/wiki.js          frontmatter 付き markdown の読み書き、index/log の維持
tools/seed.js        ウィキ → 起動中の Worker(DO) に全置換で投入
prompts/extract.md   会話ログ → ウィキ の抽出手順（provenance 判定つき）
schema.yaml          型定義（オントロジー）
```

## CLI

```bash
node server.js --briefing    # 会話冒頭の注入内容
node server.js --lint        # 健康診断
node server.js --index       # index.md を再生成
```

`COACH_WIKI` でウィキの場所を差し替えられます（テスト時はコピーを指す）。

## ツール

| ツール | 役割 |
|---|---|
| `get_coach_briefing` | 会話冒頭。禁則・基準値・撤回済み・要回収 |
| `record_decision` | 提案を記録。**反証条件と absolute 禁則の確認が無いと拒否** |
| `file_analysis` | 良い分析をページとして残す |
| `remember` | 気づいたことをその場で記録（検証なし） |
| `log_session` | ★セッションの生ログを raw/ に追記。書き込み専用・要約しない |
| `record_memory` | 禁則・反応モデル・エンティティを作る |
| `record_outcome` | 予測の答え合わせ（4値） |
| `retract_claim` | 撤回。削除せず理由を残し、波及候補を提示 |
| `update_page` | 既存ページの更新 |
| `get_history` | あるテーマの過去の判断・予測・結果を時系列で返す |
| `graph_downstream` | 誤りの波及範囲を辿る |
| `tendency_record` | 反応モデルの実績（的中率） |
| `lint_wiki` | 未回収の予測・孤立ページ・未検証の基準値 |
| `search_wiki` | 全文検索 |
| `get_page` | 本文＋入出リンク |

詳細と store 契約は [`../core/README.md`](../core/README.md)。
ウィキの思想と規約は [`../coach/CLAUDE.md`](../coach/CLAUDE.md)。
