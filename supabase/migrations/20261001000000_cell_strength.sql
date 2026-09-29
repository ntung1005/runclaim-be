-- Ai chạy qua một ô nhiều lần nhất thì giữ ô đó. Người chạy ít hơn (hoặc bằng)
-- chủ hiện tại không cướp được. "Nhiều" = số buổi chạy đi qua ô.

create table public.cell_scores (
  cell_id text not null references public.cells (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  runs int not null default 0,
  primary key (cell_id, user_id)
);
alter table public.cell_scores enable row level security;

-- Dữ liệu cũ: đếm từ lịch sử chạy.
insert into public.cell_scores (cell_id, user_id, runs)
select c.id, a.user_id, count(*)
from public.activities a
cross join lateral unnest(a.cell_ids) as u(cell_id)
join public.cells c on c.id = u.cell_id
where not a.flagged
group by c.id, a.user_id;

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

    select owner_id into v_prev from public.cells where id = v_cell_id for update;

    insert into public.cell_scores (cell_id, user_id, runs)
      values (v_cell_id, p_user, 1)
      on conflict (cell_id, user_id) do update set runs = cell_scores.runs + 1
      returning runs into v_mine;

    if v_prev is null or v_prev = p_user then
      v_theirs := 0;
    else
      -- Chủ chưa có điểm (dữ liệu seed) tính là 1 lần.
      select coalesce(max(runs), 1) into v_theirs
      from public.cell_scores where cell_id = v_cell_id and user_id = v_prev;
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

-- Trả thêm số lần chủ đã chạy qua ô (owner_runs) và số lần của người xem
-- (my_runs), để app biết cần chạy thêm bao nhiêu lần mới cướp được.
drop function public.cells_in_bbox(float8, float8, float8, float8, int);
create function public.cells_in_bbox(
  min_lat float8, min_lng float8, max_lat float8, max_lng float8,
  max_rows int default 5000
)
returns table (
  id text, owner_id uuid, captured_at timestamptz,
  owner_name text, owner_color bigint, owner_club text,
  owner_runs int, my_runs int
)
language sql stable
security definer
set search_path = public, extensions
as $$
  select c.id, c.owner_id, c.captured_at, p.display_name, p.color, p.club_id,
    coalesce(so.runs, 1), coalesce(sm.runs, 0)
  from public.cells c
  join public.profiles p on p.id = c.owner_id
  left join public.cell_scores so on so.cell_id = c.id and so.user_id = c.owner_id
  left join public.cell_scores sm on sm.cell_id = c.id and sm.user_id = auth.uid()
  where c.center && st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)
  order by c.id
  limit least(greatest(max_rows, 1), 10000);
$$;
grant execute on function public.cells_in_bbox(float8, float8, float8, float8, int) to anon, authenticated;
