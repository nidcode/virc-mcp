// ノードからエッジを導出する唯一の場所。ファイル版・DO版の両方がこれを使う。
import type { WikiNode, EdgeRel } from './types.ts';

export const EDGE_FIELDS: Record<string, EdgeRel> = {
  applies: 'applies',
  constraints_reviewed: 'reviewed',
  supersedes: 'supersedes',
  downstream_contamination: 'contaminated',
  evidence_refs: 'evidenced_by',   // ★根拠関係。撤回の波及がここを通る
  supports: 'evidenced_by',
};

/** node → [{dst, rel}]（dst は id またはエイリアス。解決は呼び出し側） */
export function deriveEdges(node: Pick<WikiNode, 'front' | 'body'>): Array<{ dst: string; rel: EdgeRel }> {
  const out: Array<{ dst: string; rel: EdgeRel }> = [];
  const front = (node.front ?? {}) as Record<string, unknown>;
  for (const [field, rel] of Object.entries(EDGE_FIELDS))
    for (const t of (front[field] as string[] | undefined) ?? []) out.push({ dst: String(t), rel });
  for (const m of (node.body ?? '').matchAll(/\[\[([^\]|]+)/g))
    out.push({ dst: m[1].trim(), rel: 'mentions' });
  return out;
}

/** 影響方向の定義。汚染は順方向、依存は逆方向に辿る。 */
export const FORWARD_RELS: EdgeRel[] = ['contaminated', 'supersedes'];
export const BACKWARD_RELS: EdgeRel[] = ['applies', 'reviewed', 'evidenced_by'];
