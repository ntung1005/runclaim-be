// Điểm vào cho Vercel: export app Express, Vercel tự chạy như serverless function.
// Chạy trên máy thì dùng server.ts.

import { createApp } from './app.ts';
import { loadEnv } from './env.ts';
import { createSupabase } from './supabase.ts';

const env = loadEnv();

export default createApp(env, createSupabase(env));
