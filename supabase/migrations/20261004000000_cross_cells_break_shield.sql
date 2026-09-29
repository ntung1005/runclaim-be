-- Ô to hơn (bán kính 60 m lên 100 m), phải chạy xuyên ô mới chiếm được, và phá khiên.
--
-- 1. Đổi lưới làm id ô cũ trỏ sai chỗ: xoá toàn bộ lãnh thổ (cell_scores,
--    cell_events xoá theo cascade) cùng cell_ids của buổi chạy cũ. Buổi chạy,
--    xu, rương, nhiệm vụ giữ nguyên.
-- 2. p_cells giờ chỉ gồm ô chạy xuyên qua, kèm crossings = số lần xuyên ô.
--    Ô có khiên cướp được nếu crossings >= 2.
-- 3. Khiên tính tiền theo từng ô (p_cost là giá mỗi ô).
-- 4. break_shield: trả gấp đôi giá khiên mỗi ô để xoá khiên của người khác.

delete from public.cells;
update public.activities set cell_ids = '{}' where cell_ids <> '{}';

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
  v_shield timestamptz;
  v_crossings int;
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
    v_crossings := coalesce((v_cell ->> 'crossings')::int, 1);
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

    select owner_id, captured_at, shield_until into v_prev, v_prev_at, v_shield
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

    -- Ô có khiên: vẫn cộng lần chạy nhưng chỉ cướp được khi chạy xuyên ô ít nhất
    -- 2 lần trong buổi này (SHIELD_CROSSINGS ở src/game/daily.ts). Cướp được thì
    -- khiên mất, không chuyển sang chủ mới.
    if v_prev is distinct from p_user and v_mine > v_theirs
        and (v_prev is null or v_shield is null or v_shield <= v_now or v_crossings >= 2) then
      update public.cells
        set owner_id = p_user, captured_at = v_now, activity_id = v_id, shield_until = null
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

-- Đặt khiên [p_hours] giờ cho các ô [p_cells] của mình chưa có khiên, trừ [p_cost]
-- xu mỗi ô. Không đủ xu thì huỷ cả (exception rollback phần update).
-- Trả về {coins, cells, until, cost}.
create or replace function public.buy_shield(p_user uuid, p_cells text[], p_cost int, p_hours int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coins int;
  v_count int;
  v_until timestamptz := now() + make_interval(hours => p_hours);
begin
  select coins into v_coins from public.wallets where user_id = p_user for update;

  update public.cells
    set shield_until = v_until
    where owner_id = p_user and id = any(p_cells)
      and (shield_until is null or shield_until <= now());
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'already_shielded';
  end if;
  if coalesce(v_coins, 0) < v_count * p_cost then
    raise exception 'not_enough_coins';
  end if;

  update public.wallets set coins = coins - v_count * p_cost where user_id = p_user
    returning coins into v_coins;
  return jsonb_build_object('coins', v_coins, 'cells', v_count, 'until', v_until, 'cost', v_count * p_cost);
end $$;

-- Xoá khiên còn hạn trên các ô [p_cells] của người khác, trừ [p_cost] xu mỗi ô.
-- Trả về {coins, cells, cost}.
create or replace function public.break_shield(p_user uuid, p_cells text[], p_cost int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coins int;
  v_count int;
begin
  select coins into v_coins from public.wallets where user_id = p_user for update;

  update public.cells
    set shield_until = null
    where id = any(p_cells) and owner_id <> p_user and shield_until > now();
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'not_shielded';
  end if;
  if coalesce(v_coins, 0) < v_count * p_cost then
    raise exception 'not_enough_coins';
  end if;

  update public.wallets set coins = coins - v_count * p_cost where user_id = p_user
    returning coins into v_coins;
  return jsonb_build_object('coins', v_coins, 'cells', v_count, 'cost', v_count * p_cost);
end $$;

revoke all on function public.break_shield(uuid, text[], int) from public, anon, authenticated;
grant execute on function public.break_shield(uuid, text[], int) to service_role;
