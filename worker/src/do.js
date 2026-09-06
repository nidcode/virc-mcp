// 選手1人 = 1 Durable Object = 1 SQLite。グラフとページ本文を同居させる。
import { deriveEdges, FORWARD_RELS, BACKWARD_RELS } from '../../core/edges.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', front TEXT NOT NULL DEFAULT '{}',
  body TEXT NOT NULL DEFAULT '', updated TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type, status);
CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT NOT NULL, PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY, owner TEXT, claim TEXT NOT NULL, criterion TEXT NOT NULL,
  review_on TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  observed TEXT, adjudicated_on TEXT, derived_lesson TEXT
);
CREATE INDEX IF NOT EXISTS idx_pred_due ON predictions(status, review_on);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, label, body, tokenize='trigram');
CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS log (ts TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT);
`;

const SKIP_ORPHAN = ['athlete_profile', 'question_queue', 'lint'];
const row = (r) => ({ id: r.id, type: r.type, label: r.label, status: r.status,
  front: JSON.parse(r.front || '{}'), body: r.body });

export class AthleteGraph {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => { for (const s of SCHEMA.split(';')) if (s.trim()) this.sql.exec(s); });
  }
  q(sql, ...b) { return this.sql.exec(sql, ...b).toArray(); }
  today() { return new Date().toISOString().slice(0, 10); }

  // --- 書き込み ---------------------------------------------------------
  put(node) {
    const front = { ...(node.front ?? {}), id: node.id, type: node.type, status: node.status ?? 'active' };
    this.q(`INSERT INTO nodes (id,type,label,status,front,body,updated) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET type=excluded.type,label=excluded.label,status=excluded.status,
              front=excluded.front,body=excluded.body,updated=excluded.updated`,
      node.id, node.type, node.label, front.status, JSON.stringify(front), node.body ?? '', this.today());
    this.q(`DELETE FROM aliases WHERE id=?`, node.id);
    for (const a of new Set([node.id, node.label, ...(front.aliases ?? [])]))
      if (a) this.q(`INSERT OR REPLACE INTO aliases VALUES (?,?)`, String(a), node.id);
    this.q(`DELETE FROM fts WHERE id=?`, node.id);
    this.q(`INSERT INTO fts (id,label,body) VALUES (?,?,?)`, node.id, node.label, node.body ?? '');
    this.rebuildEdges();          // 前方参照があるので毎回張り直す（この規模では無視できる）
  }
  rebuildEdges() {
    const alias = new Map(this.q(`SELECT alias,id FROM aliases`).map((a) => [a.alias, a.id]));
    this.q(`DELETE FROM edges`);
    for (const r of this.q(`SELECT id,type,label,status,front,body FROM nodes`)) {
      for (const { dst, rel } of deriveEdges(row(r))) {
        const t = alias.get(String(dst).trim()) ?? alias.get(String(dst).split('/').pop());
        if (t && t !== r.id) this.q(`INSERT OR IGNORE INTO edges VALUES (?,?,?)`, r.id, t, rel);
      }
    }
  }
  putPrediction(p) {
    this.q(`INSERT INTO predictions (id,owner,claim,criterion,review_on,status,observed,adjudicated_on,derived_lesson)
            VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,claim=excluded.claim,
              criterion=excluded.criterion,review_on=excluded.review_on,status=excluded.status,
              observed=excluded.observed,adjudicated_on=excluded.adjudicated_on,derived_lesson=excluded.derived_lesson`,
      p.id, p.owner ?? null, p.claim, p.criterion, p.review_on, p.status ?? 'pending',
      p.observed ?? null, p.adjudicated_on ?? null, p.derived_lesson ?? null);
  }
  log(kind, title, detail) {
    this.q(`INSERT INTO log VALUES (?,?,?,?)`, this.today(), kind, title, detail ?? null);
  }
  // ★短期記憶。新しい順に返す。lint は連投されがちなので直近1件だけ残して畳む。
  recentLog(limit = 8) {
    const rows = this.q(`SELECT rowid, ts, kind, title, detail FROM log ORDER BY rowid DESC LIMIT ?`, limit * 3);
    const out = [];
    let sawLint = false;
    for (const r of rows) {
      if (r.kind === 'lint') { if (sawLint) continue; sawLint = true; }
      out.push({ ts: r.ts, kind: r.kind, title: r.title, detail: r.detail });
      if (out.length >= limit) break;
    }
    return out;
  }
  nextId(prefix) {
    const ids = [...this.q(`SELECT id FROM nodes`).map((r) => r.id),
                 ...this.q(`SELECT id FROM predictions`).map((r) => r.id)];
    const re = new RegExp(`^${prefix}_(\\d+)$`);
    let max = 0;
    for (const id of ids) { const m = re.exec(id); if (m) max = Math.max(max, Number(m[1])); }
    return `${prefix}_${String(max + 1).padStart(2, '0')}`;
  }

  // --- 読み取り ---------------------------------------------------------
  markBriefing() {
    this.q(`INSERT OR REPLACE INTO config VALUES ('last_briefing', ?)`, new Date().toISOString());
  }
  lastBriefingAt() {
    const r = this.q(`SELECT v FROM config WHERE k='last_briefing'`)[0];
    return r ? r.v : null;
  }

  getSchema() {
    const r = this.q(`SELECT v FROM config WHERE k='schema'`)[0];
    return r ? r.v : null;
  }
  putSchema(md) { this.q(`INSERT OR REPLACE INTO config VALUES ('schema', ?)`, md); }

  listAll() { return this.q(`SELECT id,type,label,status,front,body FROM nodes`).map(row); }
  listByType(t) { return this.q(`SELECT id,type,label,status,front,body FROM nodes WHERE type=?`, t).map(row); }
  get(id) {
    const r = this.q(`SELECT id,type,label,status,front,body FROM nodes WHERE id=?`, id)[0];
    if (!r) return null;
    return { ...row(r),
      out: this.q(`SELECT dst,rel FROM edges WHERE src=?`, id),
      in:  this.q(`SELECT src,rel FROM edges WHERE dst=?`, id) };
  }
  listPredictions() { return this.q(`SELECT * FROM predictions`); }
  // ★撤回済みは既定で除外する。Query が古い結論を再利用しないため。
  search(q, limit = 10, type, includeRetracted = false) {
    const cols = `f.id, n.type, n.label, n.status, snippet(fts,2,'«','»','…',20) ctx`;
    const guard = includeRetracted ? '' : ` AND n.status <> 'retracted'`;
    return type
      ? this.q(`SELECT ${cols} FROM fts f JOIN nodes n ON n.id=f.id
                WHERE fts MATCH ? AND n.type=?${guard} ORDER BY rank LIMIT ?`, q, type, limit)
      : this.q(`SELECT ${cols} FROM fts f JOIN nodes n ON n.id=f.id
                WHERE fts MATCH ?${guard} ORDER BY rank LIMIT ?`, q, limit);
  }
  // ★ 再帰CTE：汚染は順方向、依存は逆方向
  downstream(id, maxDepth = 5) {
    const F = FORWARD_RELS.map((r) => `'${r}'`).join(','), B = BACKWARD_RELS.map((r) => `'${r}'`).join(',');
    return this.q(
      `WITH RECURSIVE d(id, depth, path, via) AS (
         SELECT ?, 0, ?, ''
         UNION
         SELECT e.dst, d.depth+1, d.path || ' > ' || e.dst, e.rel FROM edges e JOIN d ON e.src=d.id
          WHERE d.depth < ? AND e.rel IN (${F}) AND instr(d.path, e.dst)=0
         UNION
         SELECT e.src, d.depth+1, d.path || ' > ' || e.src, e.rel FROM edges e JOIN d ON e.dst=d.id
          WHERE d.depth < ? AND e.rel IN (${B}) AND instr(d.path, e.src)=0
       )
       SELECT d.id, d.depth, d.via, n.type, n.label, n.status, d.path
         FROM d JOIN nodes n ON n.id=d.id WHERE d.depth>0 ORDER BY d.depth, d.id`,
      id, id, maxDepth, maxDepth);
  }
  orphans() {
    const skip = SKIP_ORPHAN.map((s) => `'${s}'`).join(',');
    return this.q(`SELECT id,type,label FROM nodes n WHERE type NOT IN (${skip})
                     AND NOT EXISTS (SELECT 1 FROM edges WHERE dst=n.id)`);
  }
  graph() {
    return { nodes: this.q(`SELECT id,type,label,status,
               json_extract(front,'$.provenance.source') provenance,
               json_extract(front,'$.confidence') confidence,
               json_extract(front,'$.severity') severity FROM nodes`),
             edges: this.q(`SELECT src source, dst target, rel FROM edges`) };
  }
  stats() {
    return { nodes: this.q(`SELECT COUNT(*) c FROM nodes`)[0].c,
             edges: this.q(`SELECT COUNT(*) c FROM edges`)[0].c,
             predictions: Object.fromEntries(this.q(`SELECT status, COUNT(*) c FROM predictions GROUP BY status`)
               .map((r) => [r.status, r.c])) };
  }

  async fetch(req) {
    const op = new URL(req.url).pathname.split('/').pop();
    const body = req.method === 'POST' ? await req.json() : {};
    const J = (x) => new Response(JSON.stringify(x === undefined ? null : x),
      { headers: { 'content-type': 'application/json' } });
    if (op === 'seed') {
      if (body.reset !== false)         // 既定は全置換。差分投入したいときだけ reset:false
        for (const t of ['nodes','edges','aliases','predictions','fts']) this.q(`DELETE FROM ${t}`);
      if (body.schema) this.putSchema(body.schema);   // ★schema 層も一緒に運ぶ
      for (const n of body.nodes ?? []) this.put(n);
      for (const p of body.predictions ?? []) this.putPrediction(p);
      this.rebuildEdges();
      this.log('seed', `${(body.nodes ?? []).length} nodes`, null);
      return J(this.stats());
    }
    if (op === 'call') {
      const fn = this[body.fn];
      if (typeof fn !== 'function') return J({ error: `unknown op ${body.fn}` });
      return J(fn.apply(this, body.args ?? []));
    }
    return new Response('not found', { status: 404 });
  }
}
