import app, { env } from './app.ts';

app.listen(env.port, '0.0.0.0', () => {
  console.log(`RunClaim BE chạy tại http://localhost:${env.port} (Supabase: ${env.supabaseUrl})`);
  if (env.devTools) console.log('Đã bật công cụ giả lập /dev/*');
});
