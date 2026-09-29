// Công cụ giả lập để test (chỉ bật khi ENABLE_DEV_TOOLS=true). Mọi thứ được ghi
// vào DB qua đúng đường của người chơi thật: đối thủ demo chiếm, cướp ô bằng
// apply_activity nên có buổi chạy, cell_events và thông báo trong hộp thư.

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { neighbors } from '../game/hex_grid.ts';
import { grid } from '../game/submit_run.ts';
import { ApiError, dbError, num, readJson } from '../http.ts';
import { notifyStolen, type Push } from '../push.ts';
import type { Supabase } from '../supabase.ts';
import { FREE_AGENT_CLUB } from './me.ts';

/** Khớp với seed.sql (scripts/generate_seed.ts) và demoRivals ở app. */
export const RIVALS = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Linh Hồ Tây', club: 'ho-tay', color: 0xff1e88e5 },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Minh Sub4', club: 'hn-runners', color: 0xffe53935 },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Trang Pace 5', club: 'hn-runners', color: 0xfffb8c00 },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Đức Trail', club: 'saigon-chay', color: 0xff43a047 },
  { id: '00000000-0000-4000-8000-000000000005', name: 'An Night Run', club: FREE_AGENT_CLUB, color: 0xff8e24aa },
] as const;

const APPLICANT_NAMES = ['Hà Pace 6', 'Quân Tempo', 'Mai Long Run', 'Tuấn Interval', 'Vy Easy Run'];
const PLAYER_COLORS = [0xffff5722, 0xff00acc1, 0xffffc107, 0xff7cb342, 0xffd81b60, 0xff5e35b1, 0xff3949ab, 0xff6d4c41];

const pick = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];

/** Tạo tài khoản (không đăng nhập được: mật khẩu ngẫu nhiên) và hồ sơ cho người chơi giả. */
async function ensurePlayer(
  admin: SupabaseClient,
  p: { id?: string; email: string; name: string; club: string; color: number },
): Promise<string> {
  if (p.id) {
    const found = await admin.from('profiles').select('id').eq('id', p.id).maybeSingle();
    if (found.error) throw dbError(found.error);
    if (found.data) return p.id;
  }
  const created = await admin.auth.admin.createUser({
    id: p.id,
    email: p.email,
    password: randomUUID(),
    email_confirm: true,
    user_metadata: { demo: true },
  });
  // Đã có tài khoản nhưng chưa có hồ sơ (ví dụ lần trước lỗi giữa chừng).
  if (created.error && !(p.id && created.error.code === 'email_exists')) {
    console.error('Tạo người chơi demo lỗi', created.error);
    throw new ApiError(500, 'internal');
  }
  const id = created.data.user?.id ?? p.id!;
  const profile = await admin
    .from('profiles')
    .upsert({ id, display_name: p.name, club_id: p.club, color: p.color });
  if (profile.error) throw dbError(profile.error);
  return id;
}

const ensureRivals = (admin: SupabaseClient) =>
  Promise.all(
    RIVALS.map((r, i) => ensurePlayer(admin, { ...r, email: `rival${i + 1}@demo.chiemphuong.vn` })),
  );

/** Đối thủ "chạy" qua [cellIds]: ghi buổi chạy giả lập và chiếm ô như người thật. */
async function rivalCapture(admin: SupabaseClient, rivalId: string, cellIds: string[]) {
  const activityId = randomUUID();
  const end = Date.now() - Math.floor(Math.random() * 3_600_000);
  const { data, error } = await admin.rpc('apply_activity', {
    p_user: rivalId,
    p_activity: {
      id: activityId,
      started_at: new Date(end - cellIds.length * 20_000).toISOString(),
      ended_at: new Date(end).toISOString(),
      simulated: true,
      distance_m: cellIds.length * 60,
      moving_s: cellIds.length * 20,
      segments: [],
    },
    p_cells: [...cellIds].sort().map((id) => ({ id, ...grid.center(id) })),
  });
  if (error) throw dbError(error);
  return { ...(data as { captured: number; stolen: number }), activityId };
}

export function devRoutes(supa: Supabase, enabled: boolean, push: Push | null = null) {
  const router = Router();
  const admin = supa.admin;

  router.use((_req, _res, next) => {
    if (!enabled) throw new ApiError(404, 'dev_tools_disabled');
    next();
  });

  /** 5 đối thủ demo chiếm mỗi người 25-75 ô quanh {lat, lng}. Không đụng vào ô của người thật. */
  router.post('/rivals', async (req, res) => {
    const body = readJson(req);
    const origin = grid.cellAt({ lat: num(body, 'lat'), lng: num(body, 'lng') });
    const [oq, or] = origin.split(':').map(Number);
    const rivalIds = await ensureRivals(admin);
    const rivalSet = new Set<string>(rivalIds);

    const walks = rivalIds.map(() => {
      let cell = `${oq + Math.floor(Math.random() * 30) - 15}:${or + Math.floor(Math.random() * 30) - 15}`;
      const cells = new Set<string>();
      const count = 25 + Math.floor(Math.random() * 50);
      for (let i = 0; i < count; i++) {
        cells.add(cell);
        cell = pick(neighbors(cell));
      }
      return cells;
    });

    const all = [...new Set(walks.flatMap((w) => [...w]))];
    const owned = await admin.from('cells').select('id, owner_id').in('id', all);
    if (owned.error) throw dbError(owned.error);
    const taken = new Set(
      owned.data.filter((r) => r.owner_id && !rivalSet.has(r.owner_id)).map((r) => r.id as string),
    );

    let cells = 0;
    for (const [i, walk] of walks.entries()) {
      const free = [...walk].filter((id) => !taken.has(id));
      if (free.length === 0) continue;
      cells += (await rivalCapture(admin, rivalIds[i], free)).captured;
    }
    return res.json({ rivals: rivalIds.length, cells });
  });

  /** Một đối thủ demo cướp một cụm ô của mình. Hộp thư (my_feed) sẽ có thông báo. */
  router.post('/rival-attack', async (req, res) => {
    const mine = await admin.from('cells').select('id').eq('owner_id', req.userId).limit(5000);
    if (mine.error) throw dbError(mine.error);
    const ids = new Set(mine.data.map((r) => r.id as string));
    if (ids.size === 0) return res.json({ stolen: 0 });

    const start = pick([...ids]);
    const targets = [start, ...neighbors(start)].filter((id) => ids.has(id));
    const rivalIds = await ensureRivals(admin);
    // Phải chạy qua nhiều lần hơn chủ ô mới cướp được.
    const rival = pick(rivalIds);
    for (let i = 0; i < 20; i++) {
      const result = await rivalCapture(admin, rival, targets);
      if (result.stolen === 0) continue;
      void notifyStolen(admin, push, result.activityId, rival);
      return res.json({ stolen: result.stolen });
    }
    return res.json({ stolen: 0 });
  });

  /** Cộng xu để thử tiêu (mua khiên) không cần chạy. {amount?} mặc định 200. → {coins} */
  router.post('/coins', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = typeof body.amount === 'number' ? Math.round(body.amount) : 200;
    if (amount <= 0 || amount > 10_000) throw new ApiError(400, 'invalid_amount');
    const current = await admin.from('wallets').select('coins').eq('user_id', req.userId).maybeSingle();
    if (current.error) throw dbError(current.error);
    const coins = (current.data?.coins ?? 0) + amount;
    const { error } = await admin.from('wallets').upsert({ user_id: req.userId, coins });
    if (error) throw dbError(error);
    return res.json({ coins });
  });

  /**
   * Một đối thủ demo chạy 5 lần qua các ô đang có khiên của mình để thử phá khiên.
   * → {shielded: số ô có khiên bị tấn công, stolen: số ô bị cướp (0 nếu khiên hiệu lực)}
   */
  router.post('/shield-attack', async (req, res) => {
    const mine = await admin
      .from('cells')
      .select('id')
      .eq('owner_id', req.userId)
      .gt('shield_until', new Date().toISOString())
      .limit(7);
    if (mine.error) throw dbError(mine.error);
    const targets = mine.data.map((r) => r.id as string);
    if (targets.length === 0) return res.json({ shielded: 0, stolen: 0 });
    const rival = pick(await ensureRivals(admin));
    let stolen = 0;
    for (let i = 0; i < 5; i++) stolen += (await rivalCapture(admin, rival, targets)).stolen;
    return res.json({ shielded: targets.length, stolen });
  });

  /** Một runner giả xin vào CLB mình quản lý, đã chạy được 20-80% số km yêu cầu. */
  router.post('/join-applicant', async (req, res) => {
    const me = await admin
      .from('profiles')
      .select('club_id, club_role, clubs!profiles_club_id_fkey(join_km, join_days)')
      .eq('id', req.userId)
      .maybeSingle();
    if (me.error) throw dbError(me.error);
    if (!me.data || !['owner', 'admin'].includes(me.data.club_role)) throw new ApiError(403, 'not_club_admin');
    const club = me.data.clubs as unknown as { join_km: number; join_days: number };

    const name = pick(APPLICANT_NAMES);
    const userId = await ensurePlayer(admin, {
      email: `applicant-${randomUUID()}@demo.chiemphuong.vn`,
      name,
      club: FREE_AGENT_CLUB,
      color: pick(PLAYER_COLORS),
    });
    const required = Math.max(Number(club.join_km), 1) * 1000;
    const request = await admin.from('club_join_requests').insert({
      club_id: me.data.club_id,
      user_id: userId,
      required_m: required,
      progress_m: Math.round(required * (0.2 + Math.random() * 0.6)),
      expires_at: new Date(Date.now() + club.join_days * 86_400_000).toISOString(),
    });
    if (request.error) throw dbError(request.error);
    return res.status(201).json({ name });
  });

  return router;
}
