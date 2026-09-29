// Cấu hình đọc từ biến môi trường (file .env, xem .env.example).

export interface Env {
  supabaseUrl: string;
  /** Publishable key (sb_publishable_...): đăng nhập và gọi RPC thay mặt người dùng. */
  publishableKey: string;
  /** Secret key (sb_secret_...): chỉ BE giữ, dùng cho apply_activity và tạo tài khoản. */
  secretKey: string;
  port: number;
  /** Bật các API /dev/* (đối thủ demo, mô phỏng). Không bật trên production. */
  devTools: boolean;
  /** Origin được phép gọi API từ trình duyệt (Flutter web). */
  corsOrigin: string;
  /** Số lần đăng nhập / đăng ký tối đa mỗi 5 phút cho một IP (đăng nhập: IP + tên). */
  authMaxAttempts: number;
  /** Service account Firebase (JSON hoặc đường dẫn file) để gửi thông báo đẩy. Trống: tắt thông báo. */
  fcmServiceAccount?: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const required = (name: string) => {
    const value = source[name];
    if (!value) throw new Error(`Thiếu biến môi trường ${name} (xem .env.example)`);
    return value;
  };
  return {
    supabaseUrl: required('SUPABASE_URL'),
    publishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
    secretKey: required('SUPABASE_SECRET_KEY'),
    port: Number(source.PORT ?? 8787),
    devTools: source.ENABLE_DEV_TOOLS === 'true',
    corsOrigin: source.CORS_ORIGIN ?? '*',
    authMaxAttempts: Number(source.AUTH_MAX_ATTEMPTS ?? 10),
    fcmServiceAccount: source.FCM_SERVICE_ACCOUNT || undefined,
  };
}
