// Toàn bộ API của app. App Flutter chỉ nói chuyện với server này; server giữ
// secret key và gọi Supabase.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes, requireUser } from './auth.ts';
import type { Env } from './env.ts';
import { ApiError, type AppEnv } from './http.ts';
import { clubItemRoutes, clubRoutes } from './routes/clubs.ts';
import { devRoutes } from './routes/dev.ts';
import { deviceRoutes, gameRoutes } from './routes/game.ts';
import { createPush } from './push.ts';
import { meRoutes } from './routes/me.ts';
import { runRoutes } from './routes/runs.ts';
import { worldRoutes } from './routes/world.ts';
import type { Supabase } from './supabase.ts';

export function createApp(env: Env, supa: Supabase) {
  const app = new Hono<AppEnv>();

  app.use(cors({
    origin: env.corsOrigin,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code }, err.status as 400);
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/auth', authRoutes(supa, env.authMaxAttempts));

  const push = createPush(env.fcmServiceAccount);
  if (!push) console.log('Chưa đặt FCM_SERVICE_ACCOUNT: tắt thông báo đẩy');

  const user = requireUser(supa);
  for (const path of ['/me/*', '/me', '/runs/*', '/runs', '/territory', '/leaderboard', '/feed',
    '/clubs/*', '/clubs', '/posts/*', '/comments/*', '/meetups/*', '/campaigns/*', '/dev/*', '/game/*']) {
    app.use(path, user);
  }
  app.route('/me/devices', deviceRoutes(supa));
  app.route('/me', meRoutes);
  app.route('/runs', runRoutes(supa, push));
  app.route('/', worldRoutes);
  app.route('/clubs', clubRoutes);
  app.route('/', clubItemRoutes);
  app.route('/dev', devRoutes(supa, env.devTools, push));
  app.route('/game', gameRoutes(supa));

  return app;
}
