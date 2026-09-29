import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadEnv } from './env.ts';
import { createSupabase } from './supabase.ts';

const env = loadEnv();
const app = createApp(env, createSupabase(env));

serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`RunClaim BE chạy tại http://localhost:${info.port} (Supabase: ${env.supabaseUrl})`);
  if (env.devTools) console.log('Đã bật công cụ giả lập /dev/*');
});
