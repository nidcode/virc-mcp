// ローカル版アダプタ: markdown ファイル（../coach/wiki）を store 契約に合わせる。
import fs from 'node:fs';
import path from 'node:path';
import * as W from './wiki.js';
import { deriveEdges, FORWARD_RELS, BACKWARD_RELS } from '../../core/edges.ts';
import { TYPE_DIR } from '../../core/tools.ts';
import type {
  Store, WikiNode, NodeWithEdges, NodeType, TypedNode, Front, Edge, EdgeRel,
  Prediction, SearchHit, OrphanRow, DownstreamRow, Stats, PutOptions, GraphView,
  DecisionFront, EmbeddedPrediction,
} from '../../core/types.ts';

interface Page { file: string; rel: string; front: Front; body: string }

const label = (p: Page): string => (p.body.match(/^#\s+(.+)$/m) ?? [, p.front.id])[1];
const toNode = (p: Page): WikiNode & { rel: string; file: string } => ({ id: p.front.id, type: p.front.type, label: label(p),
  status: p.front.status ?? 'active', front: p.front, body: p.body, rel: p.rel, file: p.file });

function resolver(pages: Page[]) {
  const m = new Map<string, string>();
  for (const p of pages) {
    const base = p.rel.replace(/\.md$/, '');
    for (const k of [p.front.id, base, base.split('/').pop(), ...(p.front.aliases ?? [])])
      if (k) m.set(String(k), p.front.id);
  }
  return (k: string) => m.get(String(k).trim());
}

function allEdges(): Edge[] {
  const pages = W.listPages();
  const res = resolver(pages);
  const out: Edge[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    for (const { dst, rel } of deriveEdges(toNode(p))) {
      const t = res(dst);
      if (!t || t === p.front.id) continue;
      const k = `${p.front.id}|${t}|${rel}`;
      if (!seen.has(k)) { seen.add(k); out.push({ src: p.front.id, dst: t, rel }); }
    }
  }
  return out;
}

export const fsStore = {
  today: (): string => W.today(),
  listAll: (): WikiNode[] => W.listPages().map(toNode),
  // 実行時は type で絞っているので、型は絞り込み済みとして扱う
  listByType: <T extends NodeType>(t: T): Array<TypedNode<T>> =>
    W.listPages(t).map(toNode) as unknown as Array<TypedNode<T>>,

  get(id: string): NodeWithEdges | null {
    const p = W.listPages().find((x) => x.front.id === id);
    if (!p) return null;
    const E = allEdges();
    return { ...toNode(p),
      out: E.filter((e) => e.src === id).map((e) => ({ dst: e.dst, rel: e.rel })),
      in:  E.filter((e) => e.dst === id).map((e) => ({ src: e.src, rel: e.rel })) };
  },

  put(node: WikiNode, opts: PutOptions = {}): void {
    const existing = W.listPages().find((x) => x.front.id === node.id);
    const front = { ...(node.front ?? {}), id: node.id, type: node.type, status: node.status ?? 'active' };
    if (existing) { W.savePage({ file: existing.file, front, body: node.body }); return; }
    const dir = TYPE_DIR[node.type] ?? '.';
    const name = opts.name ?? `${node.id}-${W.slug(node.label)}`;
    W.createPage(dir, name, front, node.body);
  },

  nextId: (p: string): string => W.nextId(p),

  search(q: string, limit = 10, type?: NodeType, includeRetracted = false): SearchHit[] {
    const needle = q.toLowerCase();
    return W.listPages(type)
      // ★撤回済みは既定で除外する。Query が古い結論を再利用しないため。
      .filter((p: Page) => includeRetracted || p.front.status !== 'retracted')
      .filter((p: Page) =>
        (p.rel + JSON.stringify(p.front) + p.body).toLowerCase().includes(needle))
      .slice(0, limit).map((p: Page) => {
        const i = p.body.toLowerCase().indexOf(needle);
        const ctx = (i >= 0 ? p.body.slice(Math.max(0, i - 100), i + 160) : p.body.slice(0, 160));
        return { id: p.front.id, type: p.front.type, label: label(p),
          status: p.front.status ?? 'active', ctx: ctx.replace(/\n+/g, ' ') };
      });
  },

  listPredictions(): Prediction[] {
    return W.predictions().map((p) => ({ id: p.id, owner: p.owner, claim: p.claim,
      criterion: p.adjudication_criterion, review_on: p.review_on,
      status: p.status ?? 'pending', observed: p.observed ?? null }));
  },

  putPrediction(p: Prediction): void {
    for (const page of W.listPages()) {
      // 予測は decision（単数）と athlete_profile / decision（複数）の両方に載りうる
      const front = page.front as DecisionFront;
      const single = front.prediction?.id === p.id;
      const arr = (front.predictions ?? []).find((x: EmbeddedPrediction) => x.id === p.id);
      if (single || arr) {
        const t = (single ? front.prediction : arr) as EmbeddedPrediction;
        Object.assign(t, { claim: p.claim, adjudication_criterion: p.criterion, review_on: p.review_on,
          status: p.status, observed: p.observed ?? null,
          ...(p.adjudicated_on ? { adjudicated_on: p.adjudicated_on } : {}),
          ...(p.derived_lesson ? { derived_lesson: p.derived_lesson } : {}) });
        W.savePage(page);
        return;
      }
    }
    // 所有ページが未作成（record_decision の put 直後）なら、そちらの frontmatter に既に入っている
  },

  downstream(id: string, maxDepth = 5): DownstreamRow[] {
    const E = allEdges();
    const nodes = new Map<string, WikiNode>(W.listPages().map((p: Page) => [p.front.id, toNode(p)]));
    const out: DownstreamRow[] = [];
    const seen = new Set<string>([id]);
    let cur: Array<{ id: string; path: string }> = [{ id, path: id }];
    for (let d = 1; d <= maxDepth && cur.length; d++) {
      const next: Array<{ id: string; path: string }> = [];
      for (const c of cur) {
        for (const e of E) {
          let to: string | null = null;
          if (e.src === c.id && FORWARD_RELS.includes(e.rel)) to = e.dst;
          else if (e.dst === c.id && BACKWARD_RELS.includes(e.rel)) to = e.src;
          if (!to || seen.has(to)) continue;
          const n = nodes.get(to);
          if (!n) continue;
          seen.add(to);
          const p = `${c.path} > ${to}`;
          out.push({ id: to, depth: d, via: e.rel, type: n.type, label: n.label, status: n.status ?? 'active', path: p });
          next.push({ id: to, path: p });
        }
      }
      cur = next;
    }
    return out;
  },

  graph(): GraphView {
    const pages = W.listPages();
    return {
      nodes: pages.map((p: Page) => ({
        id: p.front.id, type: p.front.type, label: label(p),
        status: p.front.status ?? 'active',
        provenance: p.front.provenance?.source ?? null,
        confidence: (p.front as any).confidence ?? null,
        severity: (p.front as any).severity ?? null,
      })),
      edges: allEdges().map((e) => ({ source: e.src, target: e.dst, rel: e.rel })),
    };
  },

  orphans(): OrphanRow[] {
    const E = allEdges();
    const linked = new Set(E.map((e) => e.dst));
    return W.listPages().filter((p) =>
      !['athlete_profile', 'question_queue', 'lint'].includes(p.front.type) && !linked.has(p.front.id))
      .map((p) => ({ id: p.front.id, type: p.front.type, label: label(p) }));
  },

  getSchema(): string | null {
    // 実体（このウィキ）の live copy を優先。無ければ製品の既定テンプレート。
    // 本番の DO も config.schema に live copy を持ち、seed で既定が入る。同じ意味論。
    for (const f of [path.join(W.ROOT, 'CLAUDE.md'),
                     path.join(W.ROOT, '..', 'schema', 'CLAUDE.md')])
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    return null;
  },

  log: (kind: string, title: string, detail?: string | null): void => W.appendLog(kind, title, detail),

  stats(): Stats {
    const pages = W.listPages();
    return { nodes: pages.length, edges: allEdges().length,
      predictions: W.predictions().reduce((a: Record<string, number>, p: any) =>
        (a[p.status] = (a[p.status] || 0) + 1, a), {}) };
  },

  reindex: (): number => W.rebuildIndex(),
} satisfies Store;   // ★契約を型で強制する
