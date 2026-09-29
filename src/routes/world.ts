// Dữ liệu chung của mọi người chơi: lãnh thổ, bảng xếp hạng, hộp thư bị cướp đất.

import { Hono } from 'hono';
import { ApiError, dbError, queryNum, rpc, type AppEnv } from '../http.ts';

/** Bằng max_rows của PostgREST: mỗi request trả tối đa ngần này dòng. */
const PAGE = 1000;
/** Bằng mặc định max_rows của cells_in_bbox. */
const MAX_CELLS = 5000;

export const worldRoutes = new Hono<AppEnv>();

/** GET /territory?min_lat=&min_lng=&max_lat=&max_lng= */
worldRoutes.get('/territory', async (c) => {
  const bbox = {
    min_lat: queryNum(c, 'min_lat'),
    min_lng: queryNum(c, 'min_lng'),
    max_lat: queryNum(c, 'max_lat'),
    max_lng: queryNum(c, 'max_lng'),
  };
  if (bbox.min_lat > bbox.max_lat || bbox.min_lng > bbox.max_lng) throw new ApiError(400, 'invalid_bbox');
  // Tải theo trang (hàm SQL sắp xếp theo id nên các trang không trùng, không sót).
  const cells: unknown[] = [];
  while (cells.length < MAX_CELLS) {
    const { data, error } = await c.var.db
      .rpc('cells_in_bbox', { ...bbox, max_rows: MAX_CELLS })
      .range(cells.length, cells.length + PAGE - 1);
    if (error) throw dbError(error);
    cells.push(...(data as unknown[]));
    if ((data as unknown[]).length < PAGE) break;
  }
  return c.json(cells);
});

worldRoutes.get('/leaderboard', async (c) => {
  const [players, clubs, wards, standing] = await Promise.all([
    rpc(c, 'leaderboard_players'),
    rpc(c, 'leaderboard_clubs'),
    rpc(c, 'leaderboard_wards'),
    rpc<{ cells: number; rank: number }[]>(c, 'my_standing'),
  ]);
  return c.json({ players, clubs, wards, standing: standing[0] ?? { cells: 0, rank: 0 } });
});

worldRoutes.get('/feed', async (c) => c.json(await rpc(c, 'my_feed')));
