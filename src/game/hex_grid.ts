// Bản port 1:1 của runclaim_app/lib/core/hex_grid.dart. App và server phải cho ra cùng id ô.
// Kiểm tra bằng test/process_activity.test.ts (BE) và test/hex_grid_test.dart (app)
// (cùng bộ vector).

export interface LatLng {
  lat: number;
  lng: number;
}

/** Toạ độ trên mặt phẳng Web Mercator (mét). */
export interface XY {
  x: number;
  y: number;
}

const EARTH_RADIUS = 6378137;
const SQRT3 = Math.sqrt(3);

// Dart roundToDouble() làm tròn .5 ra xa số 0; Math.round thì làm tròn lên.
const roundHalfAwayFromZero = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
const toInt = (v: number) => (v === 0 ? 0 : Math.trunc(v)); // tránh "-0"

export class HexGrid {
  readonly sizeMeters: number;

  constructor(sizeMeters: number) {
    this.sizeMeters = sizeMeters;
  }

  cellAt(p: LatLng): string {
    const m = project(p);
    return this.cellAtXY(m.x, m.y);
  }

  project(p: LatLng): XY {
    return project(p);
  }

  /** Các ô có tâm nằm trong đa giác (toạ độ Mercator). */
  cellsInPolygon(polygon: XY[]): string[] {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of polygon) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const size = this.sizeMeters;
    const rMin = Math.floor(minY / (1.5 * size)) - 1;
    const rMax = Math.ceil(maxY / (1.5 * size)) + 1;
    const cells: string[] = [];
    for (let r = rMin; r <= rMax; r++) {
      const qMin = Math.floor(minX / (size * SQRT3) - r / 2) - 1;
      const qMax = Math.ceil(maxX / (size * SQRT3) - r / 2) + 1;
      for (let q = qMin; q <= qMax; q++) {
        const x = size * SQRT3 * (q + r / 2);
        const y = size * 1.5 * r;
        if (pointInPolygon(x, y, polygon)) cells.push(`${toInt(q)}:${toInt(r)}`);
      }
    }
    return cells;
  }

  center(id: string): LatLng {
    const [q, r] = id.split(':').map(Number);
    const x = this.sizeMeters * SQRT3 * (q + r / 2);
    const y = this.sizeMeters * 1.5 * r;
    return unproject(x, y);
  }

  cellsAlong(a: LatLng, b: LatLng): Set<string> {
    const pa = project(a);
    const pb = project(b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(length / (this.sizeMeters / 3)));
    const cells = new Set<string>();
    for (let i = 0; i <= steps; i++) {
      cells.add(this.cellAtXY(pa.x + (dx * i) / steps, pa.y + (dy * i) / steps));
    }
    return cells;
  }

  /** Ô chứa điểm (toạ độ Mercator). */
  cellAtXY(x: number, y: number): string {
    const q = ((SQRT3 / 3) * x - y / 3) / this.sizeMeters;
    const r = ((2 / 3) * y) / this.sizeMeters;
    const s = -q - r;
    let rq = roundHalfAwayFromZero(q);
    let rr = roundHalfAwayFromZero(r);
    const rs = roundHalfAwayFromZero(s);
    const dq = Math.abs(rq - q);
    const dr = Math.abs(rr - r);
    const ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) {
      rq = -rr - rs;
    } else if (dr > ds) {
      rr = -rq - rs;
    }
    return `${toInt(rq)}:${toInt(rr)}`;
  }
}

export function pointInPolygon(x: number, y: number, polygon: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function project(p: LatLng): XY {
  const x = (EARTH_RADIUS * p.lng * Math.PI) / 180;
  const latRad = (p.lat * Math.PI) / 180;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return { x, y };
}

function unproject(x: number, y: number): LatLng {
  const lng = ((x / EARTH_RADIUS) * 180) / Math.PI;
  const lat = ((2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180) / Math.PI;
  return { lat, lng };
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 6 ô kề ô [id] ("q:r"). */
export function neighbors(id: string): string[] {
  const [q, r] = id.split(':').map(Number);
  return [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map(([dq, dr]) => `${q + dq}:${r + dr}`);
}
