import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.ts';

const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/**
 * PostgREST so `iat` của JWT với đồng hồ của nó theo giây, nên token dùng ngay
 * trong giây vừa cấp đôi khi bị từ chối (PGRST303 "JWT issued at future").
 * Gặp lỗi này thì đợi rồi thử lại một lần.
 */
export const retryFreshJwt: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;
  const body = await res.clone().text();
  if (!body.includes('PGRST303')) return res;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  return fetch(input, init);
};

export interface Supabase {
  /** Quyền service_role: bỏ qua RLS. Chỉ dùng cho việc app không được tự làm. */
  admin: SupabaseClient;
  /** Client công khai dùng chung, để xác thực JWT (có cache JWKS). */
  anon: SupabaseClient;
  /** Client mới cho mỗi lần đăng nhập, để phiên của người này không lẫn sang người khác. */
  newAuthClient(): SupabaseClient;
  /** Gọi RPC, đọc bảng thay mặt người dùng: RLS và auth.uid() áp dụng như app gọi thẳng. */
  asUser(accessToken: string): SupabaseClient;
}

export function createSupabase(env: Env): Supabase {
  const make = (key: string, accessToken?: string) =>
    createClient(env.supabaseUrl, key, {
      auth: noSession,
      global: accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` }, fetch: retryFreshJwt }
        : undefined,
    });
  return {
    admin: make(env.secretKey),
    anon: make(env.publishableKey),
    newAuthClient: () => make(env.publishableKey),
    asUser: (token) => make(env.publishableKey, token),
  };
}
