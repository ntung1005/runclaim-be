-- Run Claim: schema giai đoạn 1.
-- Nguyên tắc: client chỉ đọc lãnh thổ và sửa hồ sơ của mình. Mọi thay đổi lãnh
-- thổ đi qua edge function submit-activity -> apply_activity (service_role).

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Bảng
-- ---------------------------------------------------------------------------

create table public.clubs (
  id text primary key,
  name text not null,
  color bigint not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  club_id text not null references public.clubs (id),
  color bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- TODO: thay tâm phường bằng ranh giới thật (geometry(MultiPolygon)).
create table public.wards (
  id text primary key,
  name text not null,
  city text not null,
  center extensions.geography(Point, 4326) not null
);

create table public.activities (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  distance_m double precision not null,
  moving_s double precision not null,
  suspicious_m double precision not null default 0,
  flagged boolean not null default false,
  simulated boolean not null default false,
  source text not null default 'app',
  -- Điểm GPS thô. Chỉ chủ buổi chạy đọc được (RLS).
  segments jsonb not null,
  cell_count int not null default 0,
  cells_captured int not null default 0,
  cells_stolen int not null default 0,
  created_at timestamptz not null default now()
);
create index activities_user_started_idx on public.activities (user_id, started_at desc);

-- id là toạ độ axial "q:r" của lưới lục giác (xem functions/_shared/hex_grid.ts).
create table public.cells (
  id text primary key,
  owner_id uuid references public.profiles (id) on delete set null,
  center extensions.geometry(Point, 4326) not null,
  ward_id text references public.wards (id),
  captured_at timestamptz,
  activity_id uuid references public.activities (id) on delete set null
);
create index cells_center_gix on public.cells using gist (center);
create index cells_owner_idx on public.cells (owner_id);
create index cells_ward_idx on public.cells (ward_id);

-- Lịch sử chiếm, cướp ô. Dùng để hoàn tác buổi chạy gian lận và gửi thông báo.
create table public.cell_events (
  id bigint generated always as identity primary key,
  cell_id text not null references public.cells (id) on delete cascade,
  activity_id uuid references public.activities (id) on delete set null,
  new_owner uuid references public.profiles (id) on delete set null,
  previous_owner uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index cell_events_previous_owner_idx on public.cell_events (previous_owner, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.clubs enable row level security;
alter table public.profiles enable row level security;
alter table public.wards enable row level security;
alter table public.activities enable row level security;
alter table public.cells enable row level security;
alter table public.cell_events enable row level security;

create policy "clubs are public" on public.clubs for select using (true);
create policy "wards are public" on public.wards for select using (true);
create policy "cells are public" on public.cells for select using (true);
create policy "profiles are public" on public.profiles for select using (true);

create policy "insert own profile" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy "update own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "read own activities" on public.activities
  for select to authenticated using (user_id = (select auth.uid()));

create policy "read own cell events" on public.cell_events
  for select to authenticated
  using (new_owner = (select auth.uid()) or previous_owner = (select auth.uid()));

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Ghi nhận buổi chạy và cập nhật lãnh thổ (chỉ service_role)
-- ---------------------------------------------------------------------------

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
  -- Idempotent: app có thể gửi lại khi mất mạng.
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
    flagged, simulated, segments, cell_count
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
    jsonb_array_length(p_cells)
  );

  -- Khoá theo thứ tự id để hai buổi chạy đồng thời không deadlock.
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
-- Truy vấn cho app
-- ---------------------------------------------------------------------------

-- Lãnh thổ trong khung nhìn bản đồ, kèm thông tin chủ ô để vẽ màu.
create or replace function public.cells_in_bbox(
  min_lat float8, min_lng float8, max_lat float8, max_lng float8,
  max_rows int default 5000
)
returns table (
  id text, owner_id uuid, captured_at timestamptz,
  owner_name text, owner_color bigint, owner_club text
)
language sql stable
set search_path = public, extensions
as $$
  select c.id, c.owner_id, c.captured_at, p.display_name, p.color, p.club_id
  from public.cells c
  join public.profiles p on p.id = c.owner_id
  where c.center && st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)
  limit least(greatest(max_rows, 1), 10000);
$$;

create or replace function public.leaderboard_players(max_rows int default 50)
returns table (player_id uuid, display_name text, club_id text, color bigint, cells bigint)
language sql stable
set search_path = public
as $$
  select p.id, p.display_name, p.club_id, p.color, count(*) as cells
  from public.cells c
  join public.profiles p on p.id = c.owner_id
  group by p.id
  order by cells desc, p.id
  limit least(greatest(max_rows, 1), 200);
$$;

create or replace function public.leaderboard_clubs()
returns table (club_id text, name text, color bigint, cells bigint, members bigint)
language sql stable
set search_path = public
as $$
  select cl.id, cl.name, cl.color, count(*) as cells, count(distinct c.owner_id) as members
  from public.cells c
  join public.profiles p on p.id = c.owner_id
  join public.clubs cl on cl.id = p.club_id
  group by cl.id
  order by cells desc, cl.id;
$$;

create or replace function public.leaderboard_wards()
returns table (
  ward_id text, name text, city text, total_cells bigint,
  king_id uuid, king_name text, king_color bigint, king_cells bigint
)
language sql stable
set search_path = public
as $$
  with counts as (
    select c.ward_id, c.owner_id, count(*) as n
    from public.cells c
    where c.ward_id is not null and c.owner_id is not null
    group by c.ward_id, c.owner_id
  ), ranked as (
    select *,
      row_number() over (partition by ward_id order by n desc, owner_id) as rn,
      sum(n) over (partition by ward_id) as total
    from counts
  )
  select w.id, w.name, w.city, r.total::bigint, r.owner_id, p.display_name, p.color, r.n
  from ranked r
  join public.wards w on w.id = r.ward_id
  left join public.profiles p on p.id = r.owner_id
  where r.rn = 1
  order by r.total desc, w.id;
$$;

-- Số ô và hạng của người đang đăng nhập.
create or replace function public.my_standing()
returns table (cells bigint, rank bigint)
language sql stable
set search_path = public
as $$
  with counts as (
    select owner_id, count(*) as n from public.cells
    where owner_id is not null group by owner_id
  ), ranked as (
    select owner_id, n, rank() over (order by n desc) as r from counts
  )
  select
    coalesce((select n from ranked where owner_id = (select auth.uid())), 0),
    coalesce((select r from ranked where owner_id = (select auth.uid())), 0);
$$;
