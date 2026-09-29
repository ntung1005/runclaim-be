// Buổi chạy: nộp điểm GPS thô để tính lãnh thổ, đọc lại lịch sử của mình.

import { Router } from 'express';
import { submitRun } from '../game/submit_run.ts';
import { dbError, readJson } from '../http.ts';
import type { Push } from '../push.ts';
import type { Supabase } from '../supabase.ts';

interface RawSample {
  lat: number;
  lng: number;
}

/** Điểm GPS thô → [[lat, lng]] làm tròn 6 chữ số (~10 cm), đủ để vẽ đường chạy. */
export function toPolyline(segments: unknown): number[][][] {
  if (!Array.isArray(segments)) return [];
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return segments.map((seg) =>
    Array.isArray(seg) ? (seg as RawSample[]).map((s) => [round(s.lat), round(s.lng)]) : [],
  );
}

export function runRoutes(supa: Supabase, push: Push | null = null) {
  const router = Router();

  router.post('/', async (req, res) => res.json(await submitRun(supa.admin, req.userId, readJson(req), push)));

  router.get('/', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 500);
    const { data, error } = await req.db
      .from('activities')
      .select(
        'id, started_at, ended_at, distance_m, moving_s, suspicious_m, flagged, simulated, ' +
          'segments, cell_ids, cells_captured, cells_stolen, loops, loop_cells, splits',
      )
      .eq('user_id', req.userId)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw dbError(error);
    return res.json(
      (data as unknown as Record<string, unknown>[]).map((r) => ({ ...r, segments: toPolyline(r.segments) })),
    );
  });

  return router;
}
