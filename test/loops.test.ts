// Chạy: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HexGrid } from '../src/game/hex_grid.ts';
import { detectLoops, polygonArea } from '../src/game/loops.ts';
import { processActivity, type Sample } from '../src/game/process_activity.ts';

const grid = new HexGrid(60);
const t0 = Date.parse('2026-09-25T05:00:00Z');
const LAT = 21.0287, LNG = 105.8524;

/** Tuyến chạy qua các điểm (đông, bắc) tính bằng mét, 8 m mỗi 3 giây. */
export function route(waypoints: [number, number][]): Sample[] {
  const mLat = 111320, mLng = 111320 * Math.cos((LAT * Math.PI) / 180);
  const out: Sample[] = [];
  let t = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [x0, y0] = waypoints[i], [x1, y1] = waypoints[i + 1];
    const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 8));
    for (let k = 0; k < steps; k++) {
      const x = x0 + ((x1 - x0) * k) / steps, y = y0 + ((y1 - y0) * k) / steps;
      out.push({ lat: LAT + y / mLat, lng: LNG + x / mLng, t: t0 + t * 3000, acc: 5 });
      t++;
    }
  }
  const [x, y] = waypoints[waypoints.length - 1];
  out.push({ lat: LAT + y / mLat, lng: LNG + x / mLng, t: t0 + t * 3000, acc: 5 });
  return out;
}

const input = (segments: Sample[][]) => ({ id: 'x', startedAt: '', endedAt: '', simulated: false, segments });
const SQUARE: [number, number][] = [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]];

// Kết quả mong đợi dùng chung với test/loops_test.dart.
export const SQUARE_EXPECTED = { loops: 1, loopCells: 9, totalCells: 30 };

test('vòng vuông 400 m: chiếm cả vùng bên trong', () => {
  const r = processActivity(input([route(SQUARE)]), grid);
  assert.equal(r.loops, SQUARE_EXPECTED.loops);
  assert.equal(r.loopCells, SQUARE_EXPECTED.loopCells);
  assert.equal(r.cells.length, SQUARE_EXPECTED.totalCells);
});

test('chạy thẳng hoặc chạy đi rồi quay lại cùng đường: không có vòng', () => {
  assert.equal(processActivity(input([route([[0, 0], [1000, 0]])]), grid).loops, 0);
  assert.equal(processActivity(input([route([[0, 0], [300, 0], [0, 0]])]), grid).loops, 0);
});

test('vòng bị cắt ngang bởi chỗ tạm dừng thì không tính', () => {
  const full = route(SQUARE);
  const half = Math.floor(full.length / 2);
  const r = processActivity(input([full.slice(0, half), full.slice(half)]), grid);
  assert.equal(r.loops, 0);
});

test('hai vòng liên tiếp được tính riêng', () => {
  const r = processActivity(input([route([...SQUARE, [-400, 0], [-400, -400], [0, -400], [0, 0]])]), grid);
  assert.equal(r.loops, 2);
});

test('vòng quá lớn (> 3 km²) bị bỏ qua', () => {
  const big: [number, number][] = [[0, 0], [2000, 0], [2000, 2000], [0, 2000], [0, 0]];
  const pts = route(big).map((s) => grid.project(s));
  assert.ok(polygonArea(pts) > 3_000_000);
  assert.equal(detectLoops(pts).length, 0);
});
