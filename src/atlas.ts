// Atlas: every building in the study area lifted out and laid in a true-scale grid, in reference order.
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';
import type { Bldg, SiteModel } from './model';
import type { XY } from './geo';

export interface AtlasLayout {
  offsets: Map<number, XY>; // building idx -> translation in local metres
  rank: Map<number, number>; // 0..1 order, for staggering the animation
  labels: { idx: number; text: string; at: XY }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function layoutAtlas(bs: Bldg[], gap = 14): AtlasLayout {
  const items = bs
    .slice()
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .map((b) => {
      const xs = b.polys.flatMap((p) => p[0].map((q) => q[0]));
      const ys = b.polys.flatMap((p) => p[0].map((q) => q[1]));
      const minX = Math.min(...xs), minY = Math.min(...ys);
      // Slots are at least 22 m wide so every reference has room under its building.
      return { b, minX, minY, w: Math.max(...xs) - minX, slot: Math.max(22, Math.max(...xs) - minX), h: Math.max(...ys) - minY };
    });
  const label = 10; // room under each building for its reference
  const total = items.reduce((s, it) => s + (it.slot + gap) * (it.h + gap + label), 0);
  const rowW = Math.max(Math.sqrt(total) * 1.3, ...items.map((it) => it.slot + gap));

  const offsets = new Map<number, XY>(), rank = new Map<number, number>();
  const labels: AtlasLayout['labels'] = [];
  let x = 0, y = 0, rowH = 0;
  items.forEach((it, i) => {
    if (x > 0 && x + it.slot > rowW) {
      x = 0;
      y -= rowH + gap + label;
      rowH = 0;
    }
    // Building sits in [x, x+w] × [y-h, y]; the label goes just below it.
    offsets.set(it.b.idx, [x - it.minX, y - it.h - it.minY]);
    labels.push({ idx: it.b.idx, text: it.b.ref, at: [x, y - it.h - 3] });
    rank.set(it.b.idx, items.length > 1 ? i / (items.length - 1) : 0);
    x += it.slot + gap;
    rowH = Math.max(rowH, it.h);
  });
  const height = -(y - rowH);
  // Centre the sheet on the site.
  const cx = rowW / 2, cy = -height / 2;
  for (const [k, v] of offsets) offsets.set(k, [v[0] - cx, v[1] - cy]);
  for (const l of labels) l.at = [l.at[0] - cx, l.at[1] - cy];
  return { offsets, rank, labels, bounds: { minX: -cx - gap, maxX: rowW - cx + gap, minY: -height - cy - label - gap, maxY: -cy + gap } };
}

/** Move a building's lng/lat geometry by a local-metre offset. */
export function translateFeature(f: Feature<Polygon | MultiPolygon>, d: XY, m: SiteModel): Feature<Polygon | MultiPolygon> {
  const dx = d[0] / m.frame.kx, dy = d[1] / m.frame.ky;
  const mv = (p: Position) => [p[0] + dx, p[1] + dy];
  const g = f.geometry;
  const geometry =
    g.type === 'Polygon'
      ? { type: 'Polygon' as const, coordinates: g.coordinates.map((r) => r.map(mv)) }
      : { type: 'MultiPolygon' as const, coordinates: g.coordinates.map((p) => p.map((r) => r.map(mv))) };
  return { ...f, geometry };
}

export const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
