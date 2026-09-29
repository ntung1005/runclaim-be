import type { Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Lỗi trả về cho app dạng {"error": code}. code là chuỗi a-z_ để app dịch ra câu thông báo. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface AppEnv {
  Variables: {
    userId: string;
    username: string;
    /** Client Supabase mang token của người dùng đang gọi. */
    db: SupabaseClient;
  };
}

export type AppContext = Context<AppEnv>;

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body');
  }
  return body as Record<string, unknown>;
}

const CODE_RE = /^[a-z_]+$/;

/**
 * Đổi lỗi của Postgres thành [ApiError]. Hàm SQL báo lỗi nghiệp vụ bằng
 * `raise exception 'club_not_found'`..., giữ nguyên mã đó cho app.
 */
export function dbError(error: { message: string; code?: string }): ApiError {
  const message = error.message ?? '';
  if (CODE_RE.test(message)) {
    if (message.endsWith('_not_found')) return new ApiError(404, message);
    if (message.startsWith('not_')) return new ApiError(403, message);
    return new ApiError(400, message);
  }
  // 22P02: sai định dạng (uuid...), 23514: vi phạm check, 22023: tham số sai.
  if (error.code === '22P02' || error.code === '23514' || error.code === '22023') {
    return new ApiError(400, 'invalid_input');
  }
  console.error('Lỗi cơ sở dữ liệu', error);
  return new ApiError(500, 'internal');
}

/** Gọi hàm SQL bằng quyền của người dùng đang gọi. */
export async function rpc<T = unknown>(c: AppContext, fn: string, params?: Record<string, unknown>): Promise<T> {
  const { data, error } = await c.var.db.rpc(fn, params);
  if (error) throw dbError(error);
  return data as T;
}

// Đọc tham số ------------------------------------------------------------------

export function str(body: Record<string, unknown>, key: string, { max = 500, optional = false } = {}): string {
  const v = body[key];
  if (v === undefined || v === null) {
    if (optional) return '';
    throw new ApiError(400, `missing_${key}`);
  }
  if (typeof v !== 'string' || v.length > max) throw new ApiError(400, `invalid_${key}`);
  return v;
}

export function optStr(body: Record<string, unknown>, key: string, max = 500): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) throw new ApiError(400, `invalid_${key}`);
  return v;
}

export function num(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError(400, `invalid_${key}`);
  return v;
}

export function optNum(body: Record<string, unknown>, key: string): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  return num(body, key);
}

export function bool(body: Record<string, unknown>, key: string): boolean {
  const v = body[key];
  if (typeof v !== 'boolean') throw new ApiError(400, `invalid_${key}`);
  return v;
}

export function queryNum(c: Context, key: string): number {
  const v = Number(c.req.query(key));
  if (!Number.isFinite(v)) throw new ApiError(400, `invalid_${key}`);
  return v;
}
