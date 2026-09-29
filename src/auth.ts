// Đăng ký, đăng nhập bằng tên đăng nhập + mật khẩu.
// Supabase Auth cần email, nên tên đăng nhập được đổi thành một email nội bộ
// (không gửi thư, không cần xác nhận). Người dùng không bao giờ thấy email này.

import type { Session } from '@supabase/supabase-js';
import { Hono, type MiddlewareHandler } from 'hono';
import { ApiError, readJson, type AppEnv } from './http.ts';
import type { Supabase } from './supabase.ts';

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const EMAIL_DOMAIN = 'users.chiemphuong.vn';
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 72;

export const usernameToEmail = (username: string) => `${username}@${EMAIL_DOMAIN}`;

export function parseCredentials(body: Record<string, unknown>): { username: string; password: string } {
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) throw new ApiError(400, 'invalid_username');
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new ApiError(400, 'weak_password');
  }
  return { username, password };
}

function sessionJson(session: Session, username: string) {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: { id: session.user.id, username },
  };
}

/** Giới hạn số lần thử đăng nhập theo IP + tên, chống dò mật khẩu. */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) throw new ApiError(429, 'too_many_attempts');
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
  }
}

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
}

export function authRoutes(supa: Supabase, maxAttempts: number) {
  const limiter = new AttemptLimiter(maxAttempts, 5 * 60_000);
  const app = new Hono<AppEnv>();

  const signIn = async (username: string, password: string) => {
    const { data, error } = await supa.newAuthClient().auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    if (error || !data.session) {
      if (error?.status === 429) throw new ApiError(429, 'too_many_attempts');
      if (error && error.status !== 400) {
        console.error('Đăng nhập lỗi', error);
        throw new ApiError(502, 'auth_unavailable');
      }
      throw new ApiError(401, 'invalid_credentials');
    }
    return sessionJson(data.session, username);
  };

  app.post('/register', async (c) => {
    const { username, password } = parseCredentials(await readJson(c));
    limiter.check(`register:${clientIp(c)}`);
    const { error } = await supa.admin.auth.admin.createUser({
      email: usernameToEmail(username),
      password,
      email_confirm: true,
      user_metadata: { username },
    });
    if (error) {
      if (error.code === 'email_exists' || error.status === 422) throw new ApiError(409, 'username_taken');
      if (error.code === 'weak_password') throw new ApiError(400, 'weak_password');
      console.error('Tạo tài khoản lỗi', error);
      throw new ApiError(502, 'auth_unavailable');
    }
    return c.json(await signIn(username, password), 201);
  });

  app.post('/login', async (c) => {
    const body = await readJson(c);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) throw new ApiError(401, 'invalid_credentials');
    limiter.check(`login:${clientIp(c)}:${username}`);
    return c.json(await signIn(username, password));
  });

  app.post('/refresh', async (c) => {
    const body = await readJson(c);
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    if (!refreshToken) throw new ApiError(401, 'invalid_refresh_token');
    const { data, error } = await supa.newAuthClient().auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) throw new ApiError(401, 'invalid_refresh_token');
    const username = String(data.session.user.user_metadata?.username ?? '');
    return c.json(sessionJson(data.session, username));
  });

  app.post('/logout', requireUser(supa), async (c) => {
    const token = c.req.header('Authorization')!.slice('Bearer '.length);
    // Thu hồi refresh token của phiên này. Lỗi ở đây không chặn app đăng xuất.
    const { error } = await supa.admin.auth.admin.signOut(token, 'local');
    if (error) console.warn('Thu hồi phiên lỗi', error.message);
    return c.json({ ok: true });
  });

  return app;
}

/** Xác thực JWT (chữ ký, hạn dùng), gắn userId và client Supabase của người dùng vào context. */
export function requireUser(supa: Supabase): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token) throw new ApiError(401, 'unauthorized');
    const { data, error } = await supa.anon.auth.getClaims(token);
    const claims = data?.claims;
    if (error || !claims?.sub || claims.role !== 'authenticated' || claims.is_anonymous) {
      throw new ApiError(401, 'unauthorized');
    }
    c.set('userId', claims.sub);
    c.set('username', String(claims.user_metadata?.username ?? ''));
    c.set('db', supa.asUser(token));
    await next();
  };
}
