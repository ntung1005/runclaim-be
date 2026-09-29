// Hồ sơ và cài đặt của người đang đăng nhập.

import { Hono } from 'hono';
import { ApiError, dbError, num, readJson, rpc, str, type AppEnv } from '../http.ts';

/** Người mới luôn bắt đầu chạy tự do; vào CLB phải qua /clubs/join. */
export const FREE_AGENT_CLUB = 'tu-do';

export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/', async (c) => {
  const db = c.var.db;
  const [profile, settings] = await Promise.all([
    db.from('profiles').select('*').eq('id', c.var.userId).maybeSingle(),
    db.from('user_settings').select('data').eq('user_id', c.var.userId).maybeSingle(),
  ]);
  if (profile.error) throw dbError(profile.error);
  if (settings.error) throw dbError(settings.error);
  return c.json({
    user: { id: c.var.userId, username: c.var.username },
    profile: profile.data,
    settings: settings.data?.data ?? {},
  });
});

meRoutes.put('/profile', async (c) => {
  const body = await readJson(c);
  const name = str(body, 'display_name', { max: 40 }).trim();
  if (!name) throw new ApiError(400, 'invalid_display_name');
  const color = num(body, 'color');
  if (!Number.isInteger(color) || color < 0 || color > 0xffffffff) throw new ApiError(400, 'invalid_color');

  const db = c.var.db;
  const existing = await db.from('profiles').select('id').eq('id', c.var.userId).maybeSingle();
  if (existing.error) throw dbError(existing.error);
  const query = existing.data
    ? db.from('profiles').update({ display_name: name, color }).eq('id', c.var.userId)
    : db.from('profiles').insert({ id: c.var.userId, display_name: name, color, club_id: FREE_AGENT_CLUB });
  const { data, error } = await query.select('*').single();
  if (error) throw dbError(error);
  return c.json(data);
});

meRoutes.patch('/settings', async (c) => {
  const patch = await readJson(c);
  return c.json(await rpc(c, 'patch_my_settings', { p_patch: patch }));
});

meRoutes.get('/standing', async (c) => {
  const rows = await rpc<{ cells: number; rank: number }[]>(c, 'my_standing');
  return c.json(rows[0] ?? { cells: 0, rank: 0 });
});
