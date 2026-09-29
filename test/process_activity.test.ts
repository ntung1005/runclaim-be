// Chạy: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HexGrid, haversineMeters } from '../src/game/hex_grid.ts';
import { processActivity, validateActivity, type Sample } from '../src/game/process_activity.ts';

const grid = new HexGrid(60);
const t0 = Date.parse('2026-09-25T05:00:00Z');
const north = (m: number, s: number, acc = 5): Sample => ({
  lat: 21.0287 + m / 111320,
  lng: 105.8524,
  t: t0 + s * 1000,
  acc,
});

// Cùng bộ vector với test/hex_grid_test.dart để đảm bảo app và server khớp nhau.
export const HEX_VECTORS: [number, number, string][] = [
  [21.0287, 105.8524, '100079:26614'],
  [21.0368, 105.8346, '100055:26625'],
  [10.7725, 106.698, '107590:13404'],
  [-33.8688, 151.2093, '184256:-44569'],
  [51.5074, -0.1278, '-37423:74573'],
  [0, 0, '0:0'],
];

test('lưới ô khớp bộ vector dùng chung với app', () => {
  for (const [lat, lng, id] of HEX_VECTORS) {
    assert.equal(grid.cellAt({ lat, lng }), id, `${lat},${lng}`);
  }
});

test('tâm ô nằm trong chính ô đó, hai ô kề nhau cách ~97 m ở Hà Nội', () => {
  const id = grid.cellAt({ lat: 21.0287, lng: 105.8524 });
  assert.equal(grid.cellAt(grid.center(id)), id);
  const [q, r] = id.split(':').map(Number);
  const d = haversineMeters(grid.center(id), grid.center(`${q + 1}:${r}`));
  assert.ok(d > 90 && d < 105, `d=${d}`);
});

test('chạy 1 km hợp lệ: tính quãng đường và các ô', () => {
  const samples = Array.from({ length: 101 }, (_, i) => north(i * 10, i * 3));
  const r = processActivity({ id: 'x', startedAt: '', endedAt: '', simulated: false, segments: [samples] }, grid);
  assert.ok(Math.abs(r.distanceM - 1000) < 2, `distance=${r.distanceM}`);
  assert.equal(r.movingS, 300);
  assert.equal(r.flagged, false);
  assert.ok(r.cells.length >= 10);
});

test('đi xe máy phần lớn quãng đường: bị đánh dấu nghi vấn', () => {
  const samples = [north(0, 0), north(30, 10), north(1030, 100)]; // đoạn 2: 11 m/s
  const r = processActivity({ id: 'x', startedAt: '', endedAt: '', simulated: false, segments: [samples] }, grid);
  assert.equal(r.flagged, true);
  assert.ok(Math.abs(r.suspiciousM - 1000) < 2);
});

test('không nối đường qua chỗ tạm dừng', () => {
  const seg1 = [north(0, 0), north(30, 10)];
  const seg2 = [north(500, 400), north(530, 410)]; // cách 470 m nhưng là đoạn mới
  const r = processActivity({ id: 'x', startedAt: '', endedAt: '', simulated: false, segments: [seg1, seg2] }, grid);
  assert.ok(Math.abs(r.distanceM - 60) < 1, `distance=${r.distanceM}`);
  assert.equal(r.suspiciousM, 0);
});

test('validateActivity từ chối dữ liệu bất thường', () => {
  const base = {
    id: '6f1d2c1e-8a4b-4c3d-9e2f-1a2b3c4d5e6f',
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(t0 + 600_000).toISOString(),
    segments: [[north(0, 0), north(30, 10)]],
  };
  const now = t0 + 3_600_000;
  assert.equal(validateActivity(base, now).ok, true);
  assert.deepEqual(validateActivity({ ...base, id: 'abc' }, now), { ok: false, error: 'invalid_id' });
  assert.deepEqual(
    validateActivity({ ...base, segments: [[{ lat: 200, lng: 0, t: t0 }]] }, now),
    { ok: false, error: 'invalid_sample' },
  );
  assert.deepEqual(validateActivity(base, t0), { ok: false, error: 'time_in_future' });
});

// Cùng bộ số liệu với test "km trong khu vực CLB" ở test/club_management_test.dart.
test('km trong khu vực CLB: chỉ tính bước có trung điểm trong vòng tròn', () => {
  const samples = Array.from({ length: 101 }, (_, i) => north(i * 10, i * 3));
  const area = { lat: 21.0287, lng: 105.8524, radiusM: 500 };
  const r = processActivity({ id: 'x', startedAt: '', endedAt: '', simulated: false, segments: [samples] }, grid, area);
  assert.ok(Math.abs(r.distanceM - 1000) < 2);
  assert.ok(Math.abs(r.areaM - 500) < 11, `areaM=${r.areaM}`);
  const none = processActivity({ id: 'x', startedAt: '', endedAt: '', simulated: false, segments: [samples] }, grid);
  assert.equal(none.areaM, 0);
  const far = processActivity(
    { id: 'x', startedAt: '', endedAt: '', simulated: false, segments: [samples] }, grid,
    { lat: 21.1, lng: 105.9, radiusM: 500 },
  );
  assert.equal(far.areaM, 0);
});

test('chiếm ô phải chạy băng qua ô ít nhất 140 m, mỗi lượt xuyên tính một lần', () => {
  const big = new HexGrid(100);
  // Ô 0:0 có tâm ở (0, 0), đỉnh trên dưới ở y = ±100 m Mercator. Chạy theo trục bắc nam.
  const run = (ys: number[]) =>
    processActivity(
      {
        id: '00000000-0000-4000-8000-000000000001',
        startedAt: new Date(t0).toISOString(),
        endedAt: new Date(t0 + ys.length * 4000).toISOString(),
        simulated: true,
        segments: [ys.map((y, i) => ({ lat: (y / 6378137) * (180 / Math.PI), lng: 0, t: t0 + i * 4000 }))],
      },
      big,
    ).cells.find((c) => c.id === '0:0')?.crossings;
  const line = (from: number, to: number) => {
    const out: number[] = [];
    for (let i = 0; i <= Math.abs(to - from) / 10; i++) out.push(from + Math.sign(to - from) * i * 10);
    return out;
  };
  assert.equal(run(line(-150, -90)), 0, 'chỉ chạm mép ô');
  assert.equal(run(line(-150, 30)), 0, 'vào ô 130 m');
  assert.equal(run(line(-150, 50)), 1, 'vào ô 150 m');
  assert.equal(run(line(-150, 150)), 1, 'xuyên một lần');
  assert.equal(run([...line(-150, 150), ...line(140, -150)]), 2, 'đi rồi quay lại');
});
