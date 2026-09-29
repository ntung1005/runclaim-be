-- Game hằng ngày: ô phai màu theo thời gian, xu, rương, nhiệm vụ.

-- ---------------------------------------------------------------------------
-- 1. Ô phai màu: cứ 7 ngày chủ không chạy qua, số lần chạy của chủ giảm 1.
-- ---------------------------------------------------------------------------

alter table public.cell_scores add column last_run_at timestamptz not null default now();

-- Số lần chạy còn hiệu lực sau khi trừ phần phai theo thời gian.
create or replace function public.effective_runs(p_runs int, p_at timestamptz)
returns int
language sql stable
as $$
  select greatest(p_runs - floor(extract(epoch from now() - p_at) / (7 * 86400))::int, 0);
$$;

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
  v_prev_at timestamptz;
  v_mine int;
  v_theirs int;
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

    select owner_id, captured_at into v_prev, v_prev_at
      from public.cells where id = v_cell_id for update;

    -- Phần đã phai được trừ hẳn rồi mới cộng lần chạy này.
    insert into public.cell_scores (cell_id, user_id, runs, last_run_at)
      values (v_cell_id, p_user, 1, v_now)
      on conflict (cell_id, user_id) do update
        set runs = public.effective_runs(cell_scores.runs, cell_scores.last_run_at) + 1,
            last_run_at = v_now
      returning runs into v_mine;

    if v_prev is null or v_prev = p_user then
      v_theirs := 0;
    else
      -- Chủ chưa có điểm (dữ liệu seed) tính là 1 lần, chạy lúc chiếm ô.
      select coalesce(
          (select public.effective_runs(s.runs, s.last_run_at)
           from public.cell_scores s where s.cell_id = v_cell_id and s.user_id = v_prev),
          public.effective_runs(1, coalesce(v_prev_at, v_now)))
        into v_theirs;
    end if;

    if v_prev is distinct from p_user and v_mine > v_theirs then
      update public.cells
        set owner_id = p_user, captured_at = v_now, activity_id = v_id
        where id = v_cell_id;
      insert into public.cell_events (cell_id, activity_id, new_owner, previous_owner)
        values (v_cell_id, v_id, p_user, v_prev);
      v_captured := v_captured + 1;
      if v_prev is not null then
        v_stolen := v_stolen + 1;
      end if;
    elsif v_prev = p_user then
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

-- owner_runs, my_runs đã trừ phần phai. owner_idle_days: số ngày chủ chưa chạy qua ô.
drop function public.cells_in_bbox(float8, float8, float8, float8, int);
create function public.cells_in_bbox(
  min_lat float8, min_lng float8, max_lat float8, max_lng float8,
  max_rows int default 5000
)
returns table (
  id text, owner_id uuid, captured_at timestamptz,
  owner_name text, owner_color bigint, owner_club text,
  owner_runs int, my_runs int, owner_idle_days int
)
language sql stable
security definer
set search_path = public, extensions
as $$
  select c.id, c.owner_id, c.captured_at, p.display_name, p.color, p.club_id,
    public.effective_runs(coalesce(so.runs, 1), coalesce(so.last_run_at, c.captured_at, now())),
    coalesce(public.effective_runs(sm.runs, sm.last_run_at), 0),
    floor(extract(epoch from now() - coalesce(so.last_run_at, c.captured_at, now())) / 86400)::int
  from public.cells c
  join public.profiles p on p.id = c.owner_id
  left join public.cell_scores so on so.cell_id = c.id and so.user_id = c.owner_id
  left join public.cell_scores sm on sm.cell_id = c.id and sm.user_id = auth.uid()
  where c.center && st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)
  order by c.id
  limit least(greatest(max_rows, 1), 10000);
$$;
grant execute on function public.cells_in_bbox(float8, float8, float8, float8, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Xu, rương, nhiệm vụ. Chỉ server (service_role) đọc ghi: người chơi không
--    tự sửa được số xu.
-- ---------------------------------------------------------------------------

create table public.wallets (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  coins int not null default 0 check (coins >= 0)
);

-- Rương ở ô nào, ngày nào do server tính (src/game/daily.ts); bảng chỉ ghi ai đã mở.
create table public.chest_pickups (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  cell_id text not null,
  coins int not null,
  activity_id uuid references public.activities (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, day, cell_id)
);

create table public.quest_claims (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  quest_key text not null,
  coins int not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day, quest_key)
);

alter table public.wallets enable row level security;
alter table public.chest_pickups enable row level security;
alter table public.quest_claims enable row level security;

-- Mở các rương [{cell_id, coins}] (bỏ qua rương đã mở), cộng xu. Trả về các rương vừa mở.
create or replace function public.open_chests(p_user uuid, p_day date, p_activity uuid, p_chests jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opened jsonb;
  v_total int;
begin
  with ins as (
    insert into public.chest_pickups (user_id, day, cell_id, coins, activity_id)
    select p_user, p_day, x ->> 'cell_id', (x ->> 'coins')::int, p_activity
    from jsonb_array_elements(p_chests) x
    on conflict do nothing
    returning cell_id, coins
  )
  select coalesce(jsonb_agg(jsonb_build_object('cell_id', cell_id, 'coins', coins)), '[]'::jsonb),
         coalesce(sum(coins), 0)
    into v_opened, v_total
  from ins;

  if v_total > 0 then
    insert into public.wallets (user_id, coins) values (p_user, v_total)
      on conflict (user_id) do update set coins = wallets.coins + excluded.coins;
  end if;
  return v_opened;
end $$;

-- Nhận thưởng nhiệm vụ một lần. Trả về số xu sau khi nhận, null nếu đã nhận rồi.
create or replace function public.claim_quest(p_user uuid, p_day date, p_key text, p_coins int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coins int;
begin
  insert into public.quest_claims (user_id, day, quest_key, coins)
    values (p_user, p_day, p_key, p_coins)
    on conflict do nothing;
  if not found then
    return null;
  end if;
  insert into public.wallets (user_id, coins) values (p_user, p_coins)
    on conflict (user_id) do update set coins = wallets.coins + excluded.coins
    returning coins into v_coins;
  return v_coins;
end $$;

revoke all on function public.open_chests(uuid, date, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.claim_quest(uuid, date, text, int) from public, anon, authenticated;
grant execute on function public.open_chests(uuid, date, uuid, jsonb) to service_role;
grant execute on function public.claim_quest(uuid, date, text, int) to service_role;
