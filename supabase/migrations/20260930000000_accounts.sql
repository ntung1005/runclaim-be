-- Tài khoản tên đăng nhập + mật khẩu, mọi dữ liệu người chơi lưu trên server.
-- App không gọi Supabase trực tiếp nữa: mọi request đi qua BE (runclaim_be/src),
-- BE dùng token của người dùng nên RLS và auth.uid() vẫn áp dụng như cũ.

-- ---------------------------------------------------------------------------
-- 1. Buổi chạy: lưu thêm các ô đi qua và tốc độ từng km để app hiện lại lịch sử
--    từ server (trước đây chỉ có trên máy).
-- ---------------------------------------------------------------------------

alter table public.activities
  add column cell_ids text[] not null default '{}',
  add column splits jsonb not null default '[]';

-- ---------------------------------------------------------------------------
-- 2. Cài đặt của người chơi: chỉ số cá nhân, giả lập, kiểu bản đồ, lần cuối mở
--    hộp thư. Lưu dạng jsonb để app thêm khoá mới không cần migration.
-- ---------------------------------------------------------------------------

create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "read own settings" on public.user_settings
  for select to authenticated using (user_id = (select auth.uid()));

create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- Gộp [p_patch] vào cài đặt hiện có (khoá mới ghi đè khoá cũ). Trả về bản đầy đủ.
create or replace function public.patch_my_settings(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_data jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;
  if jsonb_typeof(p_patch) <> 'object' or pg_column_size(p_patch) > 16384 then
    raise exception 'invalid_settings';
  end if;
  insert into public.user_settings (user_id, data) values (v_user, p_patch)
  on conflict (user_id) do update set data = public.user_settings.data || excluded.data
  returning data into v_data;
  return v_data;
end $$;

revoke all on function public.patch_my_settings(jsonb) from public, anon;
grant execute on function public.patch_my_settings(jsonb) to authenticated;
