// Nhận các điểm GPS thô của một buổi chạy, tự tính quãng đường, chống gian lận,
// rồi cập nhật lãnh thổ trong một transaction (hàm SQL apply_activity).
// Gửi lại cùng id là an toàn: trả về kết quả cũ, không chiếm đất lần hai.

import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../http.ts';
import { notifyStolen, type Push } from '../push.ts';
import { GAME } from './config.ts';
import { chestAt, vnDay } from './daily.ts';
import { HexGrid } from './hex_grid.ts';
import { processActivity, validateActivity } from './process_activity.ts';

export const grid = new HexGrid(GAME.hexSizeMeters);

const MAX_SPLITS = 500;

/** Thời gian từng km do app ghi khi chạy. Chỉ để hiển thị, không ảnh hưởng lãnh thổ. */
export function validateSplits(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SPLITS) throw new ApiError(422, 'invalid_splits');
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 86_400) {
      throw new ApiError(422, 'invalid_splits');
    }
  }
  return value.map((v) => Math.round(v * 10) / 10);
}

export async function submitRun(admin: SupabaseClient, userId: string, body: unknown, push: Push | null = null) {
  const parsed = validateActivity(body);
  if (!parsed.ok) throw new ApiError(422, parsed.error);
  const activity = parsed.value;
  const splits = validateSplits((body as Record<string, unknown>).splits);

  // Đơn xin vào CLB đang chờ: cần biết khu vực để đếm số mét chạy trong đó.
  const { data: pending } = await admin
    .from('club_join_requests')
    .select('id, clubs(center_lat, center_lng, radius_m)')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .maybeSingle();
  const club = (pending?.clubs ?? null) as
    | { center_lat: number | null; center_lng: number | null; radius_m: number }
    | null;
  const area = club?.center_lat != null && club.center_lng != null
    ? { lat: club.center_lat, lng: club.center_lng, radiusM: club.radius_m }
    : undefined;

  const result = processActivity(activity, grid, area);
  const cellIds = result.cells.map((c) => c.id);
  const { data, error } = await admin.rpc('apply_activity', {
    p_user: userId,
    p_activity: {
      id: activity.id,
      started_at: activity.startedAt,
      ended_at: activity.endedAt,
      simulated: activity.simulated,
      distance_m: result.distanceM,
      moving_s: result.movingS,
      suspicious_m: result.suspiciousM,
      flagged: result.flagged,
      loops: result.loops,
      loop_cells: result.loopCells,
      segments: activity.segments,
    },
    // Chỉ ô chạy xuyên qua mới tính lần chạy, chiếm hoặc phá khiên.
    p_cells: result.flagged ? [] : result.cells.filter((c) => c.crossings > 0),
  });

  if (error) {
    if (error.message.includes('profile_not_found')) throw new ApiError(409, 'profile_not_found');
    if (error.message.includes('activity_id_conflict')) throw new ApiError(409, 'activity_id_conflict');
    console.error('apply_activity lỗi', error);
    throw new ApiError(500, 'internal');
  }

  // Lưu các ô đi qua và splits để app đọc lại lịch sử. Chạy cả khi gửi lại
  // (duplicate) vì kết quả tính giống hệt, và để bù nếu lần trước lỗi ở bước này.
  const extra = await admin
    .from('activities')
    .update({ cell_ids: cellIds, splits })
    .eq('id', activity.id)
    .eq('user_id', userId);
  if (extra.error) {
    console.error('Lưu cell_ids lỗi', extra.error);
    throw new ApiError(500, 'internal');
  }

  // Cộng km vào đơn xin vào CLB. Lỗi ở bước này không làm hỏng buổi chạy.
  let join = null;
  if (area && !data.duplicate && !result.flagged && result.areaM > 0) {
    const advanced = await admin.rpc('advance_join_request', {
      p_user: userId,
      p_activity_id: activity.id,
      p_meters: result.areaM,
    });
    if (advanced.error) console.error('advance_join_request lỗi', advanced.error);
    join = advanced.data ?? null;
  }

  // Báo cho người bị cướp. Không chờ: thông báo chậm không làm chậm buổi chạy.
  if (!data.duplicate && data.stolen > 0) void notifyStolen(admin, push, activity.id, userId);

  // Rương trên các ô vừa đi qua (theo ngày nộp). Gửi lại thì không mở lần hai.
  let chests: { cell_id: string; coins: number }[] = [];
  if (!data.duplicate && !result.flagged) {
    const day = vnDay();
    const found = cellIds.flatMap((id) => {
      const coins = chestAt(day, id);
      return coins === null ? [] : [{ cell_id: id, coins }];
    });
    if (found.length > 0) {
      const opened = await admin.rpc('open_chests', {
        p_user: userId,
        p_day: day,
        p_activity: activity.id,
        p_chests: found,
      });
      if (opened.error) console.error('open_chests lỗi', opened.error);
      chests = opened.data ?? [];
    }
  }

  return {
    ...data,
    chests,
    area_m: result.areaM,
    join,
    loops: result.flagged ? 0 : result.loops,
    loop_cells: result.flagged ? 0 : result.loopCells,
    cell_ids: cellIds,
  };
}
