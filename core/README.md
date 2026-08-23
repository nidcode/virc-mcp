# core — 共有レイヤー

**ツール定義とハンドラの唯一の実装。** ローカル版（markdown ファイル）と本番版
（Cloudflare Durable Object）はここを共有し、違いは `store` の実装だけです。

```
core/tools.js   TOOLS（12個）+ dispatch(store, name, args)
core/edges.js   ノード → エッジの導出（両バックエンドが使う唯一の定義）

coach-memory/lib/fs-store.js   ローカル: ../coach/wiki の markdown
worker/src/do-store.js         本番: Durable Object の SQLite

coach-memory/server.js         stdio MCP  ← fsStore
worker/src/index.js            HTTP MCP   ← doStore
```

## store 契約

すべて async（同期実装でも可）。

| メソッド | 返り値 |
|---|---|
| `today()` | `'YYYY-MM-DD'` |
| `listAll()` / `listByType(type)` | `[node]` |
| `get(id)` | `node & {out:[{dst,rel}], in:[{src,rel}]}` |
| `put(node, opts?)` | upsert。エッジは `deriveEdges` から自動で張る |
| `nextId(prefix)` | `'d_16'` など |
| `search(query, limit, type?)` | `[{id,type,label,ctx}]` |
| `listPredictions()` / `putPrediction(p)` | |
| `downstream(id, maxDepth)` | `[{id,depth,via,type,label,status,path}]` |
| `orphans()` | `[{id,type,label}]` |
| `log(kind,title,detail)` / `stats()` | |

`node` の形は `{id, type, label, status, front, body}`。
`front` が frontmatter 相当で、型固有の属性はすべてここに入ります。

## エッジの導出

`core/edges.js` が唯一の定義です。frontmatter の関係フィールドと本文の `[[リンク]]` から導きます。

| frontmatter | rel |
|---|---|
| `applies` | `applies` |
| `constraints_reviewed` | `reviewed` |
| `supersedes` | `supersedes` |
| `downstream_contamination` | `contaminated` |
| 本文 `[[x]]` | `mentions` |

**影響の伝播方向**: 汚染（`contaminated` / `supersedes`）は順方向、
依存（`applies` / `reviewed`）は逆方向に辿ります。`graph_downstream` はこの両方を辿ります。

## 差分テスト

両バックエンドが同じ出力を返すことを確認できます。

```bash
node scratch/diff.js      # 読み取り6件
node scratch/wdiff.js DIR # 書き込み4件（DIR はウィキのコピー）
```

現状: 読み取り 6/6・書き込み 4/4 で一致（id の採番のみ独立）。

## 新しいツールを足すとき

`core/tools.js` の `TOOLS` に定義を足し、`dispatch` の `H` にハンドラを書く。
**両バックエンドに同時に反映されます。** store 契約に無い操作が必要になったときだけ、
両アダプタに実装を足してください。
