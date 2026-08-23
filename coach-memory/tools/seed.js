// ローカルのウィキ → 起動中の Worker(DO) に投入する。
import fs from 'node:fs';
import path from 'node:path';
import * as W from '../lib/wiki.js';

const URL_ = process.env.WORKER_URL || 'http://localhost:8787';
const pages = W.listPages();
const label = (p) => (p.body.match(/^#\s+(.+)$/m) ?? [, p.front.id])[1];
const nodes = pages.map((p) => ({
  id: p.front.id, type: p.front.type, label: label(p), status: p.front.status ?? 'active',
  provenance: p.front.provenance?.source ?? null, confidence: p.front.confidence ?? null,
  severity: p.front.severity ?? null, valid_until: p.front.valid_until ?? null,
  date: p.front.date ?? p.front.updated ?? null, front: p.front, body: p.body,
}));
// エッジは DO 側が core/edges.js から導出するので送らない
const predictions = W.predictions().map((p) => ({
  id: p.id, owner: p.owner, claim: p.claim, criterion: p.adjudication_criterion,
  review_on: p.review_on, status: p.status ?? 'pending', observed: p.observed ?? null }));

const res = await fetch(`${URL_}/api/seed`, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nodes, predictions,
    schema: [path.join(W.ROOT, 'CLAUDE.md'), path.join(W.ROOT, '..', 'schema', 'CLAUDE.md')]
      .filter(fs.existsSync).map((f) => fs.readFileSync(f, 'utf8'))[0],   // ★schema 層
    reset: process.env.SEED_APPEND !== '1' }) });
if (!res.ok) { console.error(`HTTP ${res.status}`, await res.text()); process.exit(1); }
console.log(`seeded → ${URL_}`);
console.log(JSON.stringify(await res.json(), null, 1));
