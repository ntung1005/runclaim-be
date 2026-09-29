// Sinh supabase/seed.sql: CLB, phường demo, 5 đối thủ demo có lãnh thổ quanh Hồ Gươm.
// Chạy: npm run seed
// Dữ liệu khớp với runclaim_app/lib/data/demo_data.dart và lib/data/wards.dart của app.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME } from '../src/game/config.ts';
import { HexGrid } from '../src/game/hex_grid.ts';

// [id, tên, màu, mô tả, tâm khu vực (lat, lng) hoặc null, bán kính (m), số km phải chạy để vào].
// Khớp với demoClubs, demoClubRules trong lib/data/demo_data.dart.
const clubs = [
  ['hn-runners', 'HN Runners', 0xffe53935, 'CLB chạy quanh Hồ Gươm, vào ngay không cần điều kiện.', 21.0287, 105.8524, 2000, 0],
  ['ho-tay', 'Hồ Tây Runners', 0xff1e88e5, 'Chạy vòng Hồ Tây mỗi sáng. Chạy 3 km quanh hồ để vào CLB.', 21.055, 105.819, 2500, 3],
  ['saigon-chay', 'Sài Gòn Chạy', 0xff43a047, 'Runner trung tâm Sài Gòn. Chạy 3 km quanh chợ Bến Thành để vào CLB.', 10.7725, 106.698, 2000, 3],
  ['tu-do', 'Tự do', 0xff757575, '', null, null, 2000, 0],
] as const;

const wards = [
  ['hn-hoan-kiem', 'Hoàn Kiếm', 'Hà Nội', 21.0287, 105.8524],
  ['hn-cua-nam', 'Cửa Nam', 'Hà Nội', 21.0245, 105.8435],
  ['hn-ba-dinh', 'Ba Đình', 'Hà Nội', 21.0368, 105.8346],
  ['hn-ngoc-ha', 'Ngọc Hà', 'Hà Nội', 21.04, 105.82],
  ['hn-giang-vo', 'Giảng Võ', 'Hà Nội', 21.026, 105.82],
  ['hn-van-mieu', 'Văn Miếu - Quốc Tử Giám', 'Hà Nội', 21.027, 105.834],
  ['hn-o-cho-dua', 'Ô Chợ Dừa', 'Hà Nội', 21.017, 105.827],
  ['hn-hai-ba-trung', 'Hai Bà Trưng', 'Hà Nội', 21.011, 105.855],
  ['hn-tay-ho', 'Tây Hồ', 'Hà Nội', 21.068, 105.823],
  ['hcm-ben-thanh', 'Bến Thành', 'TP.HCM', 10.7725, 106.698],
  ['hcm-sai-gon', 'Sài Gòn', 'TP.HCM', 10.78, 106.702],
  ['hcm-tan-dinh', 'Tân Định', 'TP.HCM', 10.789, 106.69],
  ['hcm-ban-co', 'Bàn Cờ', 'TP.HCM', 10.772, 106.68],
] as const;

const rivals = [
  ['00000000-0000-4000-8000-000000000001', 'Linh Hồ Tây', 'ho-tay', 0xff1e88e5],
  ['00000000-0000-4000-8000-000000000002', 'Minh Sub4', 'hn-runners', 0xffe53935],
  ['00000000-0000-4000-8000-000000000003', 'Trang Pace 5', 'hn-runners', 0xfffb8c00],
  ['00000000-0000-4000-8000-000000000004', 'Đức Trail', 'saigon-chay', 0xff43a047],
  ['00000000-0000-4000-8000-000000000005', 'An Night Run', 'tu-do', 0xff8e24aa],
] as const;

// PRNG có seed để seed.sql không đổi giữa các lần sinh.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const grid = new HexGrid(GAME.hexSizeMeters);
const random = mulberry32(42);
const nextInt = (n: number) => Math.floor(random() * n);
const neighbors = (id: string) => {
  const [cq, cr] = id.split(':').map(Number);
  return [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map(([dq, dr]) => `${cq + dq}:${cr + dr}`);
};

const origin = grid.cellAt({ lat: 21.0287, lng: 105.8524 });
const [oq, or] = origin.split(':').map(Number);
const owners = new Map<string, string>();
for (const [id] of rivals) {
  let cell = `${oq + nextInt(30) - 15}:${or + nextInt(30) - 15}`;
  const count = 25 + nextInt(50);
  for (let i = 0; i < count; i++) {
    if (!owners.has(cell)) owners.set(cell, id);
    const n = neighbors(cell);
    cell = n[nextInt(n.length)];
  }
}

const lines: string[] = [
  '-- File sinh tự động bởi scripts/generate_seed.ts. Không sửa tay.',
  '',
  '-- 4 CLB mở mặc định. CLB có join_km > 0 phải chạy đủ km trong khu vực mới vào được.',
  'insert into public.clubs (id, name, color, is_open, description, center_lat, center_lng, radius_m, join_km) values',
  clubs
    .map(([id, name, color, description, lat, lng, radius, joinKm]) =>
      `  (${q(id)}, ${q(name)}, ${color}, true, ${q(description)}, ${lat ?? 'null'}, ${lng ?? 'null'}, ${radius}, ${joinKm})`)
    .join(',\n') + ';',
  '',
  'insert into public.wards (id, name, city, center) values',
  wards
    .map(([id, name, city, lat, lng]) =>
      `  (${q(id)}, ${q(name)}, ${q(city)}, extensions.st_setsrid(extensions.st_makepoint(${lng}, ${lat}), 4326)::extensions.geography)`)
    .join(',\n') + ';',
  '',
  '-- Đối thủ demo (chỉ dùng cho môi trường local/staging).',
  'insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,',
  '  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,',
  "  confirmation_token, recovery_token, email_change_token_new, email_change, is_anonymous) values",
  rivals
    .map(([id], i) =>
      `  ('00000000-0000-0000-0000-000000000000', ${q(id)}, 'authenticated', 'authenticated', 'rival${i + 1}@demo.chiemphuong.vn', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false)`)
    .join(',\n') + ';',
  '',
  'insert into public.profiles (id, display_name, club_id, color) values',
  rivals.map(([id, name, club, color]) => `  (${q(id)}, ${q(name)}, ${q(club)}, ${color})`).join(',\n') + ';',
  '',
  'insert into public.cells (id, owner_id, center, ward_id, captured_at)',
  'select v.id, v.owner_id::uuid, v.center,',
  '  (select w.id from public.wards w',
  '    where extensions.st_dwithin(w.center, v.center::extensions.geography, 2500)',
  '    order by w.center operator(extensions.<->) v.center::extensions.geography limit 1),',
  "  now() - (v.hours_ago || ' hours')::interval",
  'from (values',
  [...owners.entries()]
    .map(([cellId, ownerId]) => {
      const c = grid.center(cellId);
      return `  (${q(cellId)}, ${q(ownerId)}, extensions.st_setsrid(extensions.st_makepoint(${c.lng.toFixed(7)}, ${c.lat.toFixed(7)}), 4326), ${nextInt(72)})`;
    })
    .join(',\n'),
  ') as v(id, owner_id, center, hours_ago);',
  '',
];

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'seed.sql');
writeFileSync(out, lines.join('\n'));
console.log(`Wrote ${out}: ${owners.size} cells`);
