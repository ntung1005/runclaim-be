// Phát hiện vòng khép kín trên đường chạy và các ô nằm bên trong.
// Bản port 1:1 ở runclaim_app/lib/core/loops.dart. Test đối chiếu: test/loops.test.ts (BE) và
// test/loops_test.dart (app) dùng cùng tuyến chạy và cùng kết quả mong đợi.

import { GAME } from './config.ts';
import type { HexGrid, XY } from './hex_grid.ts';

export interface LoopResult {
  loops: number;
  /** Ô bên trong các vòng (có thể trùng với ô trên đường chạy). */
  cells: string[];
}

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/** Diện tích đa giác (m² Mercator), công thức shoelace. */
export function polygonArea(poly: XY[]): number {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(sum) / 2;
}

/**
 * Tìm các vòng trên một đoạn chạy (các điểm đã được chấp nhận, theo thứ tự).
 * Vòng = quay lại gần một điểm cũ (≤ loopCloseMeters) sau khi đã chạy ít nhất
 * loopMinMeters. Ưu tiên vòng lớn nhất. Sau mỗi vòng, bắt đầu tìm lại từ điểm
 * đóng vòng để các vòng không chồng lên nhau.
 */
export function detectLoops(points: XY[]): XY[][] {
  const close = GAME.loopCloseMeters;
  const loops: XY[][] = [];
  const cumulative: number[] = [];
  let buckets = new Map<string, number[]>();
  const bucketOf = (p: XY): [number, number] => [Math.floor(p.x / close), Math.floor(p.y / close)];

  for (let j = 0; j < points.length; j++) {
    cumulative.push(j === 0 ? 0 : cumulative[j - 1] + dist(points[j - 1], points[j]));
    const [bx, by] = bucketOf(points[j]);

    let best = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of buckets.get(`${bx + dx}:${by + dy}`) ?? []) {
          if (
            cumulative[j] - cumulative[i] >= GAME.loopMinMeters &&
            dist(points[i], points[j]) <= close &&
            (best < 0 || i < best)
          ) {
            best = i;
          }
        }
      }
    }

    if (best >= 0) {
      const polygon = points.slice(best, j + 1);
      const area = polygonArea(polygon);
      if (area >= GAME.loopMinAreaM2 && area <= GAME.loopMaxAreaM2) {
        loops.push(polygon);
        buckets = new Map();
      }
    }

    const key = `${bx}:${by}`;
    const list = buckets.get(key);
    if (list) list.push(j);
    else buckets.set(key, [j]);
  }
  return loops;
}

export function loopCells(segments: XY[][], grid: HexGrid): LoopResult {
  const cells = new Set<string>();
  let loops = 0;
  for (const segment of segments) {
    for (const polygon of detectLoops(segment)) {
      loops++;
      for (const id of grid.cellsInPolygon(polygon)) {
        if (cells.size >= GAME.loopMaxCells) break;
        cells.add(id);
      }
    }
  }
  return { loops, cells: [...cells] };
}
