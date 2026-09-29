// Hồ sơ và cài đặt của người đang đăng nhập.

import { Router } from 'express';
import { ApiError, dbError, num, readJson, rpc, str } from '../http.ts';

/** Người mới luôn bắt đầu chạy tự do; vào CLB phải qua /clubs/join. */
export const FREE_AGENT_CLUB = 'tu-do';

export const meRoutes = Router();

meRoutes.get('/', async (req, res) => {
  const db = req.db;
  const [profile, settings] = await Promise.all([
    db.from('profiles').select('*').eq('id', req.userId).maybeSingle(),
    db.from('user_settings').select('data').eq('user_id', req.userId).maybeSingle(),
  ]);
  if (profile.error) throw dbError(profile.error);
  if (settings.error) throw dbError(settings.error);
  return res.json({
    user: { id: req.userId, username: req.username },
    profile: profile.data,
    settings: settings.data?.data ?? {},
  });
});

meRoutes.put('/profile', async (req, res) => {
  const body = readJson(req);
  const name = str(body, 'display_name', { max: 40 }).trim();
  if (!name) throw new ApiError(400, 'invalid_display_name');
  const color = num(body, 'color');
  if (!Number.isInteger(color) || color < 0 || color > 0xffffffff) throw new ApiError(400, 'invalid_color');

  const db = req.db;
  const existing = await db.from('profiles').select('id').eq('id', req.userId).maybeSingle();
  if (existing.error) throw dbError(existing.error);
  const query = existing.data
    ? db.from('profiles').update({ display_name: name, color }).eq('id', req.userId)
    : db.from('profiles').insert({ id: req.userId, display_name: name, color, club_id: FREE_AGENT_CLUB });
  const { data, error } = await query.select('*').single();
  if (error) throw dbError(error);
  return res.json(data);
});

meRoutes.patch('/settings', async (req, res) => {
  const patch = readJson(req);
  return res.json(await rpc(req, 'patch_my_settings', { p_patch: patch }));
});

meRoutes.get('/standing', async (req, res) => {
  const rows = await rpc<{ cells: number; rank: number }[]>(req, 'my_standing');
  return res.json(rows[0] ?? { cells: 0, rank: 0 });
});
