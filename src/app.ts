// Toàn bộ API của app. App Flutter chỉ nói chuyện với server này; server giữ
// secret key và gọi Supabase.

import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { authRoutes, requireUser } from './auth.ts';
import type { Env } from './env.ts';
import { ApiError } from './http.ts';
import { clubItemRoutes, clubRoutes } from './routes/clubs.ts';
import { devRoutes } from './routes/dev.ts';
import { deviceRoutes, gameRoutes } from './routes/game.ts';
import { createPush } from './push.ts';
import { meRoutes } from './routes/me.ts';
import { runRoutes } from './routes/runs.ts';
import { worldRoutes } from './routes/world.ts';
import type { Supabase } from './supabase.ts';

/** Các nhánh cần đăng nhập. Ngoài /health và /auth, mọi route đều nằm dưới đây. */
const PROTECTED = ['/me', '/runs', '/territory', '/leaderboard', '/feed',
  '/clubs', '/posts', '/comments', '/meetups', '/campaigns', '/dev', '/game'];

export function createApp(env: Env, supa: Supabase) {
  const app = express();
  app.disable('x-powered-by');

  app.use(cors({
    origin: env.corsOrigin,
    allowedHeaders: ['Authorization', 'Content-Type'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));
  // Buổi chạy dài gửi nhiều điểm GPS: mặc định 100kb của express.json không đủ.
  app.use(express.json({ type: () => true, limit: '10mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/auth', authRoutes(supa, env.authMaxAttempts));

  const push = createPush(env.fcmServiceAccount);
  if (!push) console.log('Chưa đặt FCM_SERVICE_ACCOUNT: tắt thông báo đẩy');

  app.use(PROTECTED, requireUser(supa));
  app.use('/me/devices', deviceRoutes(supa));
  app.use('/me', meRoutes);
  app.use('/runs', runRoutes(supa, push));
  app.use('/', worldRoutes);
  app.use('/clubs', clubRoutes);
  app.use('/', clubItemRoutes);
  app.use('/dev', devRoutes(supa, env.devTools, push));
  app.use('/game', gameRoutes(supa));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);

  return app;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.code });
  // Lỗi của express.json(): body không phải JSON hoặc quá lớn.
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  console.error(err);
  res.status(500).json({ error: 'internal' });
};
