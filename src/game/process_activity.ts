// Xử lý buổi chạy ở server: không tin số liệu app gửi lên, chỉ tin các điểm GPS
// thô rồi tự lọc, tự tính quãng đường và các ô chiếm được.
// Logic lọc khớp với runclaim_app/lib/features/run/track_filter.dart.

import { GAME } from './config.ts';
import { haversineMeters, HexGrid, type XY } from './hex_grid.ts';
import { loopCells } from './loops.ts';

export interface Sample {
  lat: number;
  lng: number;
  /** Thời điểm, milliseconds since epoch. */
  t: number;
  /** Sai số (mét). */
  acc?: number;
}

export interface ActivityInput {
  id: string;
  startedAt: string;
  endedAt: string;
  simulated: boolean;
  /** Mỗi lần tạm dừng là một đoạn mới. */
  segments: Sample[][];
}

/** Khu vực hoạt động của CLB: hình tròn quanh một tâm. */
export interface Area {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface ProcessedActivity {
  distanceM: number;
  /** Quãng đường hợp lệ nằm trong [Area] (tính theo trung điểm từng bước). 0 nếu không truyền area. */
  areaM: number;
  movingS: number;
  suspiciousM: number;
  flagged: boolean;
  /** Số vòng khép kín và số ô bên trong được thêm vào nhờ vòng. */
  loops: number;
  loopCells: number;
  /** Mọi ô đi qua. [crossings]: số lần chạy xuyên ô (ô trong vòng khép kín tính 1). Chỉ ô có crossings > 0 mới được chiếm. */
  cells: { id: string; lat: number; lng: number; crossings: number }[];
}

type Decision = 'ignore' | 'start' | 'tooClose' | 'accept' | 'suspicious';

export function evaluateSample(
  prev: Sample | null,
  next: Sample,
): { decision: Decision; distance: number; seconds: number } {
  if ((next.acc ?? 5) > GAME.maxAccuracyMeters) return { decision: 'ignore', distance: 0, seconds: 0 };
  if (!prev) return { decision: 'start', distance: 0, seconds: 0 };
  const seconds = (next.t - prev.t) / 1000;
  if (seconds <= 0) return { decision: 'ignore', distance: 0, seconds: 0 };
  const distance = haversineMeters(prev, next);
  if (distance < GAME.minPointDistanceMeters) return { decision: 'tooClose', distance: 0, seconds: 0 };
  const decision = distance / seconds > GAME.maxRunSpeedMps ? 'suspicious' : 'accept';
  return { decision, distance, seconds };
}

/** Trung điểm bước chạy nằm trong khu vực thì cả bước được tính. Khớp với run_processor.dart. */
export function stepInArea(a: Sample, b: Sample, area: Area): boolean {
  return haversineMeters({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, area) <= area.radiusM;
}

export function processActivity(input: ActivityInput, grid: HexGrid, area?: Area): ProcessedActivity {
  let distanceM = 0;
  let areaM = 0;
  let movingS = 0;
  let suspiciousM = 0;
  const cellIds = new Set<string>();
  // Các điểm hợp lệ liên tiếp, để tìm vòng. Đoạn nghi vấn cắt thành đoạn mới.
  const tracks: XY[][] = [];

  // Mỗi lần ở trong một ô, từ lúc vào tới lúc ra. Điểm xa nhất cách điểm vào đủ
  // crossMeters thì tính là một lần chạy xuyên ô.
  const crossMeters = 2 * grid.sizeMeters * GAME.crossRatio;
  const crossings = new Map<string, number>();
  let visit: { id: string; x: number; y: number; far: number } | null = null;
  const leave = () => {
    if (visit && visit.far >= crossMeters) crossings.set(visit.id, (crossings.get(visit.id) ?? 0) + 1);
    visit = null;
  };
  const at = (x: number, y: number) => {
    const id = grid.cellAtXY(x, y);
    if (visit?.id === id) {
      visit.far = Math.max(visit.far, Math.hypot(x - visit.x, y - visit.y));
    } else {
      leave();
      visit = { id, x, y, far: 0 };
    }
  };
  const walk = (a: XY, b: XY) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 10));
    for (let i = 1; i <= steps; i++) at(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  };

  for (const segment of input.segments) {
    let prev: Sample | null = null;
    let track: XY[] = [];
    tracks.push(track);
    for (const sample of segment) {
      const { decision, distance, seconds } = evaluateSample(prev, sample);
      switch (decision) {
        case 'ignore':
        case 'tooClose':
          break;
        case 'start': {
          cellIds.add(grid.cellAt(sample));
          const p = grid.project(sample);
          leave();
          at(p.x, p.y);
          track.push(p);
          prev = sample;
          break;
        }
        case 'accept': {
          for (const id of grid.cellsAlong(prev!, sample)) cellIds.add(id);
          const p = grid.project(sample);
          walk(track[track.length - 1], p);
          track.push(p);
          distanceM += distance;
          if (area && stepInArea(prev!, sample, area)) areaM += distance;
          movingS += seconds;
          prev = sample;
          break;
        }
        case 'suspicious':
          suspiciousM += distance;
          track = [grid.project(sample)];
          leave();
          at(track[0].x, track[0].y);
          tracks.push(track);
          prev = sample;
          break;
      }
    }
    leave();
  }

  const total = distanceM + suspiciousM;
  const flagged = total > 0 && suspiciousM / total > GAME.suspiciousRatioToInvalidate;

  const loop = loopCells(tracks, grid);
  let added = 0;
  for (const id of loop.cells) {
    if (!cellIds.has(id)) {
      cellIds.add(id);
      added++;
    }
    if (!crossings.has(id)) crossings.set(id, 1);
  }

  const cells = [...cellIds].sort().map((id) => ({ id, ...grid.center(id), crossings: crossings.get(id) ?? 0 }));
  return { distanceM, areaM, movingS, suspiciousM, flagged, loops: loop.loops, loopCells: added, cells };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type ValidationResult = { ok: true; value: ActivityInput } | { ok: false; error: string };

export function validateActivity(body: unknown, now = Date.now()): ValidationResult {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'invalid_body' };
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || !UUID_RE.test(b.id)) return { ok: false, error: 'invalid_id' };

  const startedAt = Date.parse(String(b.startedAt));
  const endedAt = Date.parse(String(b.endedAt));
  if (!isNum(startedAt) || !isNum(endedAt) || endedAt < startedAt) {
    return { ok: false, error: 'invalid_time_range' };
  }
  if (endedAt > now + 5 * 60_000) return { ok: false, error: 'time_in_future' };
  if (endedAt - startedAt > GAME.maxDurationHours * 3_600_000) {
    return { ok: false, error: 'too_long' };
  }

  if (!Array.isArray(b.segments)) return { ok: false, error: 'invalid_segments' };
  let count = 0;
  const segments: Sample[][] = [];
  for (const seg of b.segments) {
    if (!Array.isArray(seg)) return { ok: false, error: 'invalid_segments' };
    const samples: Sample[] = [];
    for (const s of seg) {
      const p = s as Record<string, unknown>;
      if (
        !isNum(p?.lat) || !isNum(p?.lng) || !isNum(p?.t) ||
        Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 ||
        (p.acc !== undefined && p.acc !== null && !isNum(p.acc))
      ) {
        return { ok: false, error: 'invalid_sample' };
      }
      if (p.t < startedAt - 60_000 || p.t > endedAt + 60_000) {
        return { ok: false, error: 'sample_out_of_range' };
      }
      samples.push({ lat: p.lat, lng: p.lng, t: p.t, acc: isNum(p.acc) ? p.acc : undefined });
      if (++count > GAME.maxSamples) return { ok: false, error: 'too_many_samples' };
    }
    segments.push(samples);
  }

  return {
    ok: true,
    value: {
      id: b.id.toLowerCase(),
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      simulated: b.simulated === true,
      segments,
    },
  };
}
