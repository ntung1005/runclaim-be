// Game hằng ngày: xu, rương đã mở, nhiệm vụ hôm nay.

import { Router } from 'express';
import { dailyQuests, SHIELD, SHIELD_BREAK_COST_PER_CELL, SHIELD_CROSSINGS, vnDay, vnDayStart, type DayStats } from '../game/daily.ts';
import { neighbors } from '../game/hex_grid.ts';
import { ApiError, dbError, readJson, str } from '../http.ts';
import type { Supabase } from '../supabase.ts';

export function gameRoutes(supa: Supabase) {
  const router = Router();
  const admin = supa.admin;

  /** Tổng hợp buổi chạy hợp lệ nộp trong ngày [day], cùng số rương đã mở. */
  async function dayStats(userId: string, day: string): Promise<DayStats> {
    const [runs, chests] = await Promise.all([
      admin
        .from('activities')
        .select('distance_m, cell_count, cells_captured, cells_stolen, loops')
        .eq('user_id', userId)
        .eq('flagged', false)
        .gte('created_at', vnDayStart(day)),
      admin.from('chest_pickups').select('cell_id', { count: 'exact', head: true }).eq('user_id', userId).eq('day', day),
    ]);
    if (runs.error) throw dbError(runs.error);
    if (chests.error) throw dbError(chests.error);
    const stats: DayStats = { meters: 0, cells: 0, captured: 0, stolen: 0, loops: 0, chests: chests.count ?? 0 };
    for (const r of runs.data) {
      stats.meters += r.distance_m;
      stats.cells += r.cell_count;
      stats.captured += r.cells_captured;
      stats.stolen += r.cells_stolen;
      stats.loops += r.loops;
    }
    return stats;
  }

  /** GET /game/today: {day, coins, chests_opened: [cell_id], quests: [...]} */
  router.get('/today', async (req, res) => {
    const userId = req.userId;
    const day = vnDay();
    const [stats, wallet, opened, claims] = await Promise.all([
      dayStats(userId, day),
      admin.from('wallets').select('coins').eq('user_id', userId).maybeSingle(),
      admin.from('chest_pickups').select('cell_id').eq('user_id', userId).eq('day', day),
      admin.from('quest_claims').select('quest_key').eq('user_id', userId).eq('day', day),
    ]);
    for (const r of [wallet, opened, claims]) if (r.error) throw dbError(r.error);
    const claimed = new Set((claims.data ?? []).map((r) => r.quest_key as string));
    return res.json({
      day,
      coins: wallet.data?.coins ?? 0,
      shield: {
        cost_per_cell: SHIELD.costPerCell,
        hours: SHIELD.hours,
        max_cells: SHIELD.maxCells,
        break_cost_per_cell: SHIELD_BREAK_COST_PER_CELL,
        break_crossings: SHIELD_CROSSINGS,
      },
      chests_opened: (opened.data ?? []).map((r) => r.cell_id),
      quests: dailyQuests(userId, day).map((q) => ({
        key: q.key,
        title: q.title,
        metric: q.metric,
        target: q.target,
        progress: Math.min(stats[q.metric], q.target),
        reward: q.reward,
        claimed: claimed.has(q.key),
      })),
    });
  });

  /** POST /game/quests/:key/claim → {coins} */
  router.post('/quests/:key/claim', async (req, res) => {
    const userId = req.userId;
    const day = vnDay();
    const quest = dailyQuests(userId, day).find((q) => q.key === req.params.key);
    if (!quest) throw new ApiError(404, 'quest_not_found');
    const stats = await dayStats(userId, day);
    if (stats[quest.metric] < quest.target) throw new ApiError(400, 'quest_not_done');
    const { data, error } = await admin.rpc('claim_quest', {
      p_user: userId,
      p_day: day,
      p_key: quest.key,
      p_coins: quest.reward,
    });
    if (error) throw dbError(error);
    if (data === null) throw new ApiError(409, 'quest_claimed');
    return res.json({ coins: data });
  });

  /**
   * POST /game/shield {cell_id}: khiên cho cả vùng liền nhau của mình chứa ô đó
   * (tối đa SHIELD.maxCells ô), trả SHIELD.costPerCell xu mỗi ô chưa có khiên.
   * → {coins, cells, until, cost}
   */
  router.post('/shield', async (req, res) => {
    const userId = req.userId;
    const cellId = str(readJson(req), 'cell_id', { max: 40 });
    const mine = await admin.from('cells').select('id').eq('owner_id', userId).limit(10_000);
    if (mine.error) throw dbError(mine.error);
    const owned = new Set(mine.data.map((r) => r.id as string));
    if (!owned.has(cellId)) throw new ApiError(403, 'not_cell_owner');

    const region = [cellId];
    const seen = new Set(region);
    for (let i = 0; i < region.length && region.length < SHIELD.maxCells; i++) {
      for (const n of neighbors(region[i])) {
        if (owned.has(n) && !seen.has(n) && region.length < SHIELD.maxCells) {
          seen.add(n);
          region.push(n);
        }
      }
    }
    const { data, error } = await admin.rpc('buy_shield', {
      p_user: userId,
      p_cells: region,
      p_cost: SHIELD.costPerCell,
      p_hours: SHIELD.hours,
    });
    if (error) throw dbError(error);
    return res.json(data);
  });

  /**
   * POST /game/shield/break {cell_id}: trả SHIELD_BREAK_COST_PER_CELL xu mỗi ô để xoá
   * khiên trên vùng liền nhau có khiên của người khác chứa ô đó (tối đa
   * SHIELD.maxCells ô). Sau đó vẫn phải chạy xuyên ô để chiếm. → {coins, cells, cost}
   */
  router.post('/shield/break', async (req, res) => {
    const userId = req.userId;
    const cellId = str(readJson(req), 'cell_id', { max: 40 });
    const now = new Date().toISOString();
    const cell = await admin.from('cells').select('owner_id').eq('id', cellId).gt('shield_until', now).maybeSingle();
    if (cell.error) throw dbError(cell.error);
    if (!cell.data) throw new ApiError(400, 'not_shielded');
    if (cell.data.owner_id === userId) throw new ApiError(403, 'own_shield');
    const theirs = await admin
      .from('cells')
      .select('id')
      .eq('owner_id', cell.data.owner_id)
      .gt('shield_until', now)
      .limit(10_000);
    if (theirs.error) throw dbError(theirs.error);
    const shielded = new Set(theirs.data.map((r) => r.id as string));

    const region = [cellId];
    const seen = new Set(region);
    for (let i = 0; i < region.length && region.length < SHIELD.maxCells; i++) {
      for (const n of neighbors(region[i])) {
        if (shielded.has(n) && !seen.has(n) && region.length < SHIELD.maxCells) {
          seen.add(n);
          region.push(n);
        }
      }
    }
    const { data, error } = await admin.rpc('break_shield', {
      p_user: userId,
      p_cells: region,
      p_cost: SHIELD_BREAK_COST_PER_CELL,
    });
    if (error) throw dbError(error);
    return res.json(data);
  });

  return router;
}

/** /me/devices: token FCM của thiết bị để nhận thông báo đẩy. */
export function deviceRoutes(supa: Supabase) {
  const router = Router();

  /** POST {token, platform}: đăng ký hoặc chuyển token sang tài khoản đang đăng nhập. */
  router.post('/', async (req, res) => {
    const body = readJson(req);
    const token = str(body, 'token', { max: 4096 });
    const platform = str(body, 'platform', { max: 20, optional: true });
    const { error } = await supa.admin
      .from('device_tokens')
      .upsert({ token, user_id: req.userId, platform, updated_at: new Date().toISOString() });
    if (error) throw dbError(error);
    return res.json({ ok: true });
  });

  /** DELETE {token}: khi đăng xuất. */
  router.delete('/', async (req, res) => {
    const token = str(readJson(req), 'token', { max: 4096 });
    const { error } = await supa.admin.from('device_tokens').delete().eq('token', token).eq('user_id', req.userId);
    if (error) throw dbError(error);
    return res.json({ ok: true });
  });

  return router;
}
