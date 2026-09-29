// Chạy: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHEST_EVERY, chestAt, dailyQuests, fnv1a, vnDay, vnDayStart } from '../src/game/daily.ts';

test('ngày theo giờ Việt Nam', () => {
  assert.equal(vnDay(Date.parse('2026-09-28T16:59:59Z')), '2026-09-28');
  assert.equal(vnDay(Date.parse('2026-09-28T17:00:00Z')), '2026-09-29');
  assert.equal(vnDayStart('2026-09-29'), '2026-09-28T17:00:00.000Z');
});

test('fnv1a khớp giá trị chuẩn (app Dart dùng cùng số này)', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('2026-09-28|100082:26612'), 1136020182);
});

test('khoảng 1/40 số ô có rương, 10-50 xu', () => {
  let chests = 0;
  const n = 20_000;
  for (let i = 0; i < n; i++) {
    const coins = chestAt('2026-09-28', `${100000 + (i % 200)}:${26000 + Math.floor(i / 200)}`);
    if (coins === null) continue;
    chests++;
    assert.ok([10, 20, 30, 40, 50].includes(coins));
  }
  assert.ok(Math.abs(chests - n / CHEST_EVERY) < n / CHEST_EVERY / 4, `${chests} rương`);
});

test('nhiệm vụ: 3 cái khác nhau, cố định trong ngày, đổi theo ngày', () => {
  const a = dailyQuests('u1', '2026-09-28').map((q) => q.key);
  assert.equal(new Set(a).size, 3);
  for (const d of ['2026-09-28', '2026-09-29', '2026-09-30']) {
    assert.equal(new Set(dailyQuests('u2', d).map((q) => q.metric)).size, 3, 'mỗi nhiệm vụ một loại');
  }
  assert.deepEqual(dailyQuests('u1', '2026-09-28').map((q) => q.key), a);
  const days = new Set(
    ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map((d) => dailyQuests('u1', d).map((q) => q.key).join()),
  );
  assert.ok(days.size > 1);
});
