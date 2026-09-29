-- Sprint 2: vòng khép kín, CLB thật, hộp thư bị cướp đất.

-- ---------------------------------------------------------------------------
-- 1. Vòng khép kín: lưu số vòng và số ô bên trong cho mỗi buổi chạy
-- ---------------------------------------------------------------------------

alter table public.activities
  add column loops int not null default 0,
  add column loop_cells int not null default 0;

-- Định nghĩa lại apply_activity để lưu thêm loops và loop_cells.
create or replace function public.apply_activity(p_user uuid, p_activity jsonb, p_cells jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := (p_activity ->> 'id')::uuid;
  v_existing public.activities%rowtype;
  v_cell jsonb;
  v_cell_id text;
  v_point geometry;
  v_ward text;
  v_prev uuid;
  v_captured int := 0;
  v_stolen int := 0;
  v_now timestamptz := now();
begin
  select * into v_existing from public.activities where id = v_id;
  if found then
    if v_existing.user_id <> p_user then
      raise exception 'activity_id_conflict';
    end if;
    return jsonb_build_object(
      'activity_id', v_existing.id,
      'distance_m', v_existing.distance_m,
      'moving_s', v_existing.moving_s,
      'suspicious_m', v_existing.suspicious_m,
      'flagged', v_existing.flagged,
      'captured', v_existing.cells_captured,
      'stolen', v_existing.cells_stolen,
      'duplicate', true
    );
  end if;

  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'profile_not_found';
  end if;

  insert into public.activities (
    id, user_id, started_at, ended_at, distance_m, moving_s, suspicious_m,
    flagged, simulated, segments, cell_count, loops, loop_cells
  ) values (
    v_id,
    p_user,
    (p_activity ->> 'started_at')::timestamptz,
    (p_activity ->> 'ended_at')::timestamptz,
    (p_activity ->> 'distance_m')::float8,
    (p_activity ->> 'moving_s')::float8,
    coalesce((p_activity ->> 'suspicious_m')::float8, 0),
    coalesce((p_activity ->> 'flagged')::boolean, false),
    coalesce((p_activity ->> 'simulated')::boolean, false),
    coalesce(p_activity -> 'segments', '[]'::jsonb),
    jsonb_array_length(p_cells),
    coalesce((p_activity ->> 'loops')::int, 0),
    coalesce((p_activity ->> 'loop_cells')::int, 0)
  );

  for v_cell in
    select value from jsonb_array_elements(p_cells) order by value ->> 'id'
  loop
    v_cell_id := v_cell ->> 'id';
    v_point := st_setsrid(
      st_makepoint((v_cell ->> 'lng')::float8, (v_cell ->> 'lat')::float8), 4326);

    if not exists (select 1 from public.cells where id = v_cell_id) then
      select w.id into v_ward
      from public.wards w
      where st_dwithin(w.center, v_point::geography, 2500)
      order by w.center <-> v_point::geography
      limit 1;

      insert into public.cells (id, center, ward_id)
      values (v_cell_id, v_point, v_ward)
      on conflict (id) do nothing;
    end if;

    select owner_id into v_prev from public.cells where id = v_cell_id for update;

    if v_prev is distinct from p_user then
      update public.cells
        set owner_id = p_user, captured_at = v_now, activity_id = v_id
        where id = v_cell_id;
      insert into public.cell_events (cell_id, activity_id, new_owner, previous_owner)
        values (v_cell_id, v_id, p_user, v_prev);
      v_captured := v_captured + 1;
      if v_prev is not null then
        v_stolen := v_stolen + 1;
      end if;
    else
      update public.cells
        set captured_at = v_now, activity_id = v_id
        where id = v_cell_id;
    end if;
  end loop;

  update public.activities
    set cells_captured = v_captured, cells_stolen = v_stolen
    where id = v_id;

  return jsonb_build_object(
    'activity_id', v_id,
    'distance_m', (p_activity ->> 'distance_m')::float8,
    'moving_s', (p_activity ->> 'moving_s')::float8,
    'suspicious_m', coalesce((p_activity ->> 'suspicious_m')::float8, 0),
    'flagged', coalesce((p_activity ->> 'flagged')::boolean, false),
    'captured', v_captured,
    'stolen', v_stolen,
    'duplicate', false
  );
end $$;

revoke all on function public.apply_activity(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_activity(uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. CLB thật
-- ---------------------------------------------------------------------------

alter table public.clubs
  add column invite_code text unique,
  -- CLB mở: ai cũng tham gia được từ danh sách. CLB người dùng tạo: vào bằng mã mời.
  add column is_open boolean not null default false,
  add column created_by uuid references public.profiles (id) on delete set null,
  add constraint clubs_name_length check (char_length(name) between 2 and 40);

-- Mã mời chỉ lộ cho thành viên (qua my_club). Người khác chỉ đọc được các cột công khai.
revoke select on public.clubs from anon, authenticated;
grant select (id, name, color, is_open, created_at) on public.clubs to anon, authenticated;

create or replace function public.generate_invite_code() returns text
language plpgsql set search_path = public as $$
declare
  -- Bỏ các ký tự dễ nhầm (0/O, 1/I/L).
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.clubs where invite_code = v_code);
  end loop;
  return v_code;
end $$;

-- CLB của người đang đăng nhập, kèm mã mời và số thành viên.
create or replace function public.my_club()
returns table (id text, name text, color bigint, is_open boolean, invite_code text,
               members bigint, cells bigint, is_owner boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.color, c.is_open, c.invite_code,
    (select count(*) from public.profiles m where m.club_id = c.id),
    (select count(*) from public.cells ce join public.profiles m on m.id = ce.owner_id
      where m.club_id = c.id),
    c.created_by = (select auth.uid())
  from public.clubs c
  join public.profiles p on p.club_id = c.id
  where p.id = (select auth.uid());
$$;

create or replace function public.create_club(p_name text, p_color bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := (select auth.uid());
  v_id text := 'c-' || replace(gen_random_uuid()::text, '-', '');
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from public.profiles where id = v_user) then
    raise exception 'profile_not_found';
  end if;
  if (select count(*) from public.clubs where created_by = v_user) >= 3 then
    raise exception 'too_many_clubs';
  end if;
  insert into public.clubs (id, name, color, invite_code, is_open, created_by)
    values (v_id, trim(p_name), p_color, public.generate_invite_code(), false, v_user);
  update public.profiles set club_id = v_id where id = v_user;
  return v_id;
end $$;

create or replace function public.join_club(p_club_id text default null, p_invite_code text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := (select auth.uid());
  v_club text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if p_invite_code is not null then
    select id into v_club from public.clubs where invite_code = upper(trim(p_invite_code));
  else
    select id into v_club from public.clubs where id = p_club_id and is_open;
  end if;
  if v_club is null then raise exception 'club_not_found'; end if;
  update public.profiles set club_id = v_club where id = v_user;
  if not found then raise exception 'profile_not_found'; end if;
  return v_club;
end $$;

create or replace function public.leave_club()
returns void
language sql security definer set search_path = public as $$
  update public.profiles set club_id = 'tu-do' where id = (select auth.uid());
$$;

-- Thành viên một CLB, sắp theo số ô đang giữ.
create or replace function public.club_members(p_club_id text)
returns table (player_id uuid, display_name text, color bigint, cells bigint)
language sql stable set search_path = public as $$
  select p.id, p.display_name, p.color,
    (select count(*) from public.cells c where c.owner_id = p.id)
  from public.profiles p
  where p.club_id = p_club_id
  order by 4 desc, p.display_name
  limit 200;
$$;

-- Danh sách CLB mở và CLB của mình, kèm số thành viên.
create or replace function public.list_clubs()
returns table (id text, name text, color bigint, is_open boolean, members bigint)
language sql stable set search_path = public as $$
  select c.id, c.name, c.color, c.is_open,
    (select count(*) from public.profiles p where p.club_id = c.id)
  from public.clubs c
  where c.is_open
     or c.id = (select club_id from public.profiles where id = (select auth.uid()))
  order by 5 desc, c.name;
$$;

-- Hồ sơ không được tự đổi club_id sang CLB kín (phải qua join_club với mã mời).
-- Chạy với quyền người gọi (không phải security definer): client gọi trực tiếp
-- có current_user = authenticated nên bị kiểm tra; RPC join_club/create_club/
-- leave_club chạy dưới quyền chủ hàm nên đi qua.
create or replace function public.guard_profile_club() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Khi insert, OLD là null nên mọi club_id đều được kiểm tra.
  if (tg_op = 'INSERT' or new.club_id is distinct from old.club_id)
     and current_user in ('authenticated', 'anon')
     and not exists (select 1 from public.clubs where id = new.club_id and is_open) then
    raise exception 'use_join_club';
  end if;
  return new;
end $$;

create trigger profiles_guard_club before insert or update on public.profiles
  for each row execute function public.guard_profile_club();

-- ---------------------------------------------------------------------------
-- 3. Hộp thư: ai đã cướp ô của mình
-- ---------------------------------------------------------------------------

-- Gộp theo buổi chạy của kẻ cướp: "X đã cướp N ô của bạn ở phường Y".
create or replace function public.my_feed(max_rows int default 50)
returns table (
  activity_id uuid, happened_at timestamptz, thief_id uuid, thief_name text,
  thief_color bigint, cells bigint, ward_name text, lat float8, lng float8
)
language sql stable security definer set search_path = public, extensions as $$
  select e.activity_id, max(e.created_at), e.new_owner, p.display_name, p.color,
    count(*), max(w.name),
    avg(st_y(c.center)), avg(st_x(c.center))
  from public.cell_events e
  join public.cells c on c.id = e.cell_id
  left join public.profiles p on p.id = e.new_owner
  left join public.wards w on w.id = c.ward_id
  where e.previous_owner = (select auth.uid())
    and e.new_owner is distinct from e.previous_owner
  group by e.activity_id, e.new_owner, p.display_name, p.color
  order by 2 desc
  limit least(greatest(max_rows, 1), 200);
$$;

-- ---------------------------------------------------------------------------
-- 4. Bảng xếp hạng người chơi trả kèm tên CLB (CLB kín không đọc được từ app)
-- ---------------------------------------------------------------------------

drop function if exists public.leaderboard_players(int);
create function public.leaderboard_players(max_rows int default 50)
returns table (player_id uuid, display_name text, club_id text, club_name text,
               color bigint, cells bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.club_id, cl.name, p.color, count(*) as cells
  from public.cells c
  join public.profiles p on p.id = c.owner_id
  left join public.clubs cl on cl.id = p.club_id
  group by p.id, cl.name
  order by cells desc, p.id
  limit least(greatest(max_rows, 1), 200);
$$;
