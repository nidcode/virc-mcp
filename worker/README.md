# worker — 本番版エントリ

Cloudflare Worker + Durable Object。**ツール定義とハンドラは `../core/tools.js`**
にあり、ローカル版（`../coach-memory/`）と共有しています。

```
src/index.js     HTTP MCP（/mcp）＋ 読み取りAPI（/api/graph, /api/node, /api/stats）
src/do.js        AthleteGraph — 選手1人 = 1 DO = 1 SQLite
src/do-store.js  store 契約 ← DO（Proxy で RPC に流すだけ）
public/index.html  グラフビューア（依存ゼロの canvas 力学レイアウト）
```

## ローカルで動かす

```bash
npm install
npx wrangler dev                              # localhost:8787
node ../coach-memory/tools/seed.js            # ウィキ → DO（全置換）
open http://localhost:8787/                   # グラフ
```

`SEED_APPEND=1` を付けると差分投入になります。

## Claude Code から繋ぐ

```bash
claude mcp add --transport http coach-graph http://localhost:8787/mcp
```

デプロイは `npx wrangler deploy` で、URL が変わるだけです。

## SQLite の作り

| テーブル | 用途 |
|---|---|
| `nodes` | ページ本体（`front` は frontmatter 相当の JSON） |
| `aliases` | id / ページ名 / エイリアス → id |
| `edges` | `core/edges.js` から導出。`put` のたびに全張り直し |
| `predictions` | 予測と答え合わせ |
| `fts` | FTS5 全文検索。**`tokenize='trigram'`**（日本語には必須） |
| `log` | 時系列 |

`downstream()` は再帰CTEで、汚染は順方向・依存は逆方向に辿ります。

## 未実装

- **認証。** いまは `?athlete=` か `x-athlete-id` ヘッダで DO を選ぶだけ。本番は OAuth が要る
- `index.md` / `log.md` の生成（DO では `log` テーブルに入るが markdown は出力しない）
- ビューアのラベル衝突回避（Sigma.js に置き換えれば入る）
