// Dữ liệu chung của mọi người chơi: lãnh thổ, bảng xếp hạng, hộp thư bị cướp đất.

import { Router } from 'express';
import { ApiError, dbError, queryNum, rpc } from '../http.ts';

/** Bằng max_rows của PostgREST: mỗi request trả tối đa ngần này dòng. */
const PAGE = 1000;
/** Bằng mặc định max_rows của cells_in_bbox. */
const MAX_CELLS = 5000;

export const worldRoutes = Router();

/** GET /territory?min_lat=&min_lng=&max_lat=&max_lng= */
worldRoutes.get('/territory', async (req, res) => {
  const bbox = {
    min_lat: queryNum(req, 'min_lat'),
    min_lng: queryNum(req, 'min_lng'),
    max_lat: queryNum(req, 'max_lat'),
    max_lng: queryNum(req, 'max_lng'),
  };
  if (bbox.min_lat > bbox.max_lat || bbox.min_lng > bbox.max_lng) throw new ApiError(400, 'invalid_bbox');
  // Tải theo trang (hàm SQL sắp xếp theo id nên các trang không trùng, không sót).
  const cells: unknown[] = [];
  while (cells.length < MAX_CELLS) {
    const { data, error } = await req.db
      .rpc('cells_in_bbox', { ...bbox, max_rows: MAX_CELLS })
      .range(cells.length, cells.length + PAGE - 1);
    if (error) throw dbError(error);
    cells.push(...(data as unknown[]));
    if ((data as unknown[]).length < PAGE) break;
  }
  return res.json(cells);
});

worldRoutes.get('/leaderboard', async (req, res) => {
  const [players, clubs, wards, standing] = await Promise.all([
    rpc(req, 'leaderboard_players'),
    rpc(req, 'leaderboard_clubs'),
    rpc(req, 'leaderboard_wards'),
    rpc<{ cells: number; rank: number }[]>(req, 'my_standing'),
  ]);
  return res.json({ players, clubs, wards, standing: standing[0] ?? { cells: 0, rank: 0 } });
});

worldRoutes.get('/feed', async (req, res) => res.json(await rpc(req, 'my_feed')));
