import { createApp } from './app.ts';
import { loadEnv } from './env.ts';
import { createSupabase } from './supabase.ts';

const env = loadEnv();
const app = createApp(env, createSupabase(env));

app.listen(env.port, '0.0.0.0', () => {
  console.log(`RunClaim BE chạy tại http://localhost:${env.port} (Supabase: ${env.supabaseUrl})`);
  if (env.devTools) console.log('Đã bật công cụ giả lập /dev/*');
});
