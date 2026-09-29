// Rương và nhiệm vụ hằng ngày. Tất cả tính từ (ngày, id ô / người chơi) nên
// không cần bảng sinh rương. App tính rương y hệt để vẽ lên bản đồ:
// giữ khớp với runclaim_app/lib/core/daily.dart.

/** Khoảng 1/CHEST_EVERY số ô có rương mỗi ngày. */
export const CHEST_EVERY = 40;

/** Khiên: tiêu xu (tính theo từng ô) để vùng liền nhau của mình không bị cướp trong một thời gian. */
export const SHIELD = { costPerCell: 2, hours: 24, maxCells: 150 } as const;

/** Phá khiên của người khác: gấp đôi giá khiên mỗi ô. Hoặc chạy xuyên ô SHIELD_CROSSINGS lần trong một buổi. */
export const SHIELD_BREAK_COST_PER_CELL = SHIELD.costPerCell * 2;
export const SHIELD_CROSSINGS = 2;

/** Ngày theo giờ Việt Nam (UTC+7), dạng YYYY-MM-DD. Rương, nhiệm vụ đổi lúc 0h. */
export function vnDay(ms = Date.now()): string {
  return new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** 0h ngày [day] giờ Việt Nam, dạng ISO. */
export function vnDayStart(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 3_600_000).toISOString();
}

/** FNV-1a 32 bit trên chuỗi ASCII. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Số xu trong rương ở ô [cellId] ngày [day], null nếu ô không có rương. */
export function chestAt(day: string, cellId: string): number | null {
  const h = fnv1a(`${day}|${cellId}`);
  if (h % CHEST_EVERY !== 0) return null;
  return 10 + (Math.floor(h / CHEST_EVERY) % 5) * 10;
}

/** Tổng hợp các buổi chạy hợp lệ trong ngày, để tính tiến độ nhiệm vụ. */
export interface DayStats {
  meters: number;
  cells: number;
  captured: number;
  stolen: number;
  loops: number;
  chests: number;
}

export interface Quest {
  key: string;
  title: string;
  metric: keyof DayStats;
  target: number;
  reward: number;
}

export const QUEST_POOL: readonly Quest[] = [
  { key: 'run_3k', title: 'Chạy 3 km', metric: 'meters', target: 3000, reward: 30 },
  { key: 'run_5k', title: 'Chạy 5 km', metric: 'meters', target: 5000, reward: 50 },
  { key: 'cells_10', title: 'Chạy xuyên qua 10 ô', metric: 'cells', target: 10, reward: 30 },
  { key: 'capture_10', title: 'Chiếm 10 ô', metric: 'captured', target: 10, reward: 40 },
  { key: 'steal_3', title: 'Cướp 3 ô của đối thủ', metric: 'stolen', target: 3, reward: 60 },
  { key: 'loop_1', title: 'Khép kín 1 vòng', metric: 'loops', target: 1, reward: 50 },
  { key: 'chest_1', title: 'Mở 1 rương', metric: 'chests', target: 1, reward: 20 },
  { key: 'chest_3', title: 'Mở 3 rương', metric: 'chests', target: 3, reward: 60 },
];

/** [count] nhiệm vụ của [userId] trong ngày [day], mỗi cái một loại chỉ số, cố định trong ngày. */
export function dailyQuests(userId: string, day: string, count = 3): Quest[] {
  const sorted = [...QUEST_POOL].sort(
    (a, b) => fnv1a(`${userId}|${day}|${a.key}`) - fnv1a(`${userId}|${day}|${b.key}`),
  );
  const metrics = new Set<string>();
  return sorted.filter((q) => !metrics.has(q.metric) && metrics.add(q.metric)).slice(0, count);
}
