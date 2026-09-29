-- Sprint 3: quản lý CLB.
-- Khu vực hoạt động (tâm + bán kính), điều kiện gia nhập (chạy đủ km trong khu
-- vực), vai trò chủ nhiệm / phó nhóm, bảng tin, họp mặt, chiến dịch xâm lấn.
-- Nguyên tắc giữ như cũ: client không đọc, ghi thẳng các bảng mới; mọi thao tác
-- đi qua RPC security definer có kiểm tra quyền.

-- ---------------------------------------------------------------------------
-- 1. CLB: khu vực, điều kiện gia nhập. Hồ sơ: vai trò trong CLB
-- ---------------------------------------------------------------------------

alter table public.clubs
  add column description text not null default '' check (char_length(description) <= 280),
  add column center_lat double precision,
  add column center_lng double precision,
  add column radius_m int not null default 2000 check (radius_m between 300 and 20000),
  -- 0: vào ngay, không cần chạy.
  add column join_km numeric(5, 1) not null default 0 check (join_km between 0 and 200),
  add column join_days int not null default 14 check (join_days between 1 and 60),
  add constraint clubs_center_pair check ((center_lat is null) = (center_lng is null));

grant select (description, center_lat, center_lng, radius_m, join_km, join_days)
  on public.clubs to anon, authenticated;

alter table public.profiles
  add column club_role text not null default 'member'
    check (club_role in ('owner', 'admin', 'member')),
  add column club_joined_at timestamptz not null default now();

update public.profiles p set club_role = 'owner'
  from public.clubs c
  where c.id = p.club_id and c.created_by = p.id;

-- CLB demo (seed.sql tạo khi reset; câu lệnh này cập nhật DB đã có sẵn).
update public.clubs set center_lat = 21.0287, center_lng = 105.8524, radius_m = 2000
  where id = 'hn-runners';
update public.clubs set center_lat = 21.0550, center_lng = 105.8190, radius_m = 2500, join_km = 3
  where id = 'ho-tay';
update public.clubs set center_lat = 10.7725, center_lng = 106.6980, radius_m = 2000, join_km = 3
  where id = 'saigon-chay';

-- Client chỉ được tự vào CLB mở không có điều kiện, và không được tự đổi vai trò.
create or replace function public.guard_profile_club() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (tg_op = 'INSERT' or new.club_id is distinct from old.club_id)
     and not exists (
       select 1 from public.clubs where id = new.club_id and is_open and join_km = 0
     ) then
    raise exception 'use_join_club';
  end if;
  if (tg_op = 'INSERT' and new.club_role <> 'member')
     or (tg_op = 'UPDATE' and new.club_role is distinct from old.club_role) then
    raise exception 'role_is_managed';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Bảng mới. Bật RLS, không có policy: chỉ truy cập qua RPC.
-- ---------------------------------------------------------------------------

create table public.club_join_requests (
  id uuid primary key default gen_random_uuid(),
  club_id text not null references public.clubs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  required_m double precision not null,
  progress_m double precision not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'joined', 'cancelled', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz
);
-- Mỗi người chỉ có một đơn đang chờ.
create unique index club_join_requests_one_pending
  on public.club_join_requests (user_id) where status = 'pending';
create index club_join_requests_club_idx on public.club_join_requests (club_id, status);

-- Buổi chạy đã được cộng vào đơn, để nộp lại cùng buổi không cộng hai lần.
create table public.club_join_request_runs (
  request_id uuid not null references public.club_join_requests (id) on delete cascade,
  activity_id uuid not null references public.activities (id) on delete cascade,
  meters double precision not null,
  primary key (request_id, activity_id)
);

create table public.club_posts (
  id uuid primary key default gen_random_uuid(),
  club_id text not null references public.clubs (id) on delete cascade,
  -- null: tin hệ thống.
  author_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('text', 'run', 'join', 'leave', 'meetup', 'campaign')),
  body text not null default '' check (char_length(body) <= 500),
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index club_posts_club_idx on public.club_posts (club_id, created_at desc);

create table public.club_meetups (
  id uuid primary key default gen_random_uuid(),
  club_id text not null references public.clubs (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  title text not null check (char_length(title) between 2 and 80),
  starts_at timestamptz not null,
  lat double precision not null,
  lng double precision not null,
  place text not null default '' check (char_length(place) <= 120),
  note text not null default '' check (char_length(note) <= 280),
  created_at timestamptz not null default now()
);
create index club_meetups_club_idx on public.club_meetups (club_id, starts_at);

create table public.club_meetup_rsvps (
  meetup_id uuid not null references public.club_meetups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (meetup_id, user_id)
);

create table public.club_campaigns (
  id uuid primary key default gen_random_uuid(),
  club_id text not null references public.clubs (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  target_ward_id text not null references public.wards (id),
  target_cells int not null check (target_cells between 1 and 2000),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  cancelled boolean not null default false,
  created_at timestamptz not null default now()
);
create index club_campaigns_club_idx on public.club_campaigns (club_id, ends_at desc);

alter table public.club_join_requests enable row level security;
alter table public.club_join_request_runs enable row level security;
alter table public.club_posts enable row level security;
alter table public.club_meetups enable row level security;
alter table public.club_meetup_rsvps enable row level security;
alter table public.club_campaigns enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Hàm nội bộ (không gọi được từ client)
-- ---------------------------------------------------------------------------

-- CLB và vai trò của người đang đăng nhập. Ném lỗi nếu chưa đăng nhập.
create or replace function public._me(out user_id uuid, out club_id text, out club_role text)
language plpgsql stable security definer set search_path = public as $$
begin
  user_id := (select auth.uid());
  if user_id is null then raise exception 'not_authenticated'; end if;
  select p.club_id, p.club_role into club_id, club_role from public.profiles p where p.id = user_id;
  if not found then raise exception 'profile_not_found'; end if;
end $$;

-- Như _me nhưng yêu cầu là chủ nhiệm hoặc phó nhóm của một CLB người dùng tạo.
create or replace function public._me_admin(out user_id uuid, out club_id text, out club_role text)
language plpgsql stable security definer set search_path = public as $$
begin
  select m.user_id, m.club_id, m.club_role into user_id, club_id, club_role from public._me() m;
  if club_role not in ('owner', 'admin') then raise exception 'not_club_admin'; end if;
end $$;

create or replace function public._post(p_club text, p_author uuid, p_kind text, p_body text, p_data jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into public.club_posts (club_id, author_id, kind, body, data)
  values (p_club, p_author, p_kind, left(coalesce(p_body, ''), 500), coalesce(p_data, '{}'));
$$;

-- Rời CLB hiện tại. Chủ nhiệm rời đi thì trao quyền cho phó nhóm (hoặc thành
-- viên lâu nhất). Không đổi club_id: người gọi tự cập nhật tiếp.
create or replace function public._leave_current(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_club text;
  v_role text;
  v_next uuid;
begin
  select club_id, club_role into v_club, v_role from public.profiles where id = p_user;
  if v_club is null or v_club = 'tu-do' then return; end if;
  if v_role = 'owner' then
    select id into v_next from public.profiles
      where club_id = v_club and id <> p_user
      order by (club_role = 'admin') desc, club_joined_at
      limit 1;
    if v_next is not null then
      update public.profiles set club_role = 'owner' where id = v_next;
      update public.clubs set created_by = v_next where id = v_club;
    end if;
  end if;
  perform public._post(v_club, p_user, 'leave', '');
end $$;

create or replace function public._join(p_user uuid, p_club text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select club_id from public.profiles where id = p_user) = p_club then return; end if;
  perform public._leave_current(p_user);
  update public.profiles
    set club_id = p_club, club_role = 'member', club_joined_at = now()
    where id = p_user;
  update public.club_join_requests
    set status = case when club_id = p_club then 'joined' else 'cancelled' end, resolved_at = now()
    where user_id = p_user and status = 'pending';
  if p_club <> 'tu-do' then
    perform public._post(p_club, p_user, 'join', '');
  end if;
end $$;

-- Đơn quá hạn chuyển sang expired (làm lười mỗi khi đọc).
create or replace function public._expire_requests()
returns void language sql security definer set search_path = public as $$
  update public.club_join_requests set status = 'expired', resolved_at = now()
  where status = 'pending' and expires_at < now();
$$;

revoke all on function public._me() from public, anon, authenticated;
revoke all on function public._me_admin() from public, anon, authenticated;
revoke all on function public._post(text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public._leave_current(uuid) from public, anon, authenticated;
revoke all on function public._join(uuid, text) from public, anon, authenticated;
revoke all on function public._expire_requests() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Xem CLB
-- ---------------------------------------------------------------------------

drop function if exists public.my_club();
create function public.my_club()
returns table (id text, name text, color bigint, is_open boolean, invite_code text,
               members bigint, cells bigint, is_owner boolean, role text, description text,
               center_lat float8, center_lng float8, radius_m int, join_km numeric, join_days int)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.color, c.is_open, c.invite_code,
    (select count(*) from public.profiles m where m.club_id = c.id),
    (select count(*) from public.cells ce join public.profiles m on m.id = ce.owner_id
      where m.club_id = c.id),
    p.club_role = 'owner', p.club_role, c.description,
    c.center_lat, c.center_lng, c.radius_m, c.join_km, c.join_days
  from public.clubs c
  join public.profiles p on p.club_id = c.id
  where p.id = (select auth.uid());
$$;

drop function if exists public.list_clubs();
create function public.list_clubs()
returns table (id text, name text, color bigint, is_open boolean, members bigint, cells bigint,
               description text, center_lat float8, center_lng float8, radius_m int,
               join_km numeric, join_days int)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.color, c.is_open,
    (select count(*) from public.profiles p where p.club_id = c.id),
    (select count(*) from public.cells ce join public.profiles m on m.id = ce.owner_id
      where m.club_id = c.id),
    c.description, c.center_lat, c.center_lng, c.radius_m, c.join_km, c.join_days
  from public.clubs c
  where c.is_open
     or c.id = (select club_id from public.profiles where id = (select auth.uid()))
  order by 5 desc, c.name;
$$;

-- Xem trước CLB kín bằng mã mời (để biết điều kiện trước khi xin vào).
create or replace function public.find_club_by_code(p_invite_code text)
returns table (id text, name text, color bigint, is_open boolean, members bigint, cells bigint,
               description text, center_lat float8, center_lng float8, radius_m int,
               join_km numeric, join_days int)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.color, c.is_open,
    (select count(*) from public.profiles p where p.club_id = c.id),
    (select count(*) from public.cells ce join public.profiles m on m.id = ce.owner_id
      where m.club_id = c.id),
    c.description, c.center_lat, c.center_lng, c.radius_m, c.join_km, c.join_days
  from public.clubs c
  where c.invite_code = upper(trim(p_invite_code));
$$;

drop function if exists public.club_members(text);
create function public.club_members(p_club_id text)
returns table (player_id uuid, display_name text, color bigint, cells bigint, role text)
language sql stable set search_path = public as $$
  select p.id, p.display_name, p.color,
    (select count(*) from public.cells c where c.owner_id = p.id),
    p.club_role
  from public.profiles p
  where p.club_id = p_club_id
  order by case p.club_role when 'owner' then 0 when 'admin' then 1 else 2 end, 4 desc, p.display_name
  limit 200;
$$;

-- Lãnh thổ CLB: tổng số ô, số ô trong khu vực hoạt động, các phường giữ nhiều nhất.
create or replace function public.club_territory(p_club_id text)
returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  with owned as (
    select c.id, c.center, c.ward_id
    from public.cells c join public.profiles p on p.id = c.owner_id
    where p.club_id = p_club_id
  ), club as (
    select * from public.clubs where id = p_club_id
  )
  select jsonb_build_object(
    'cells', (select count(*) from owned),
    'in_area', (
      select count(*) from owned o, club k
      where k.center_lat is not null
        and st_dwithin(o.center::geography,
                       st_setsrid(st_makepoint(k.center_lng, k.center_lat), 4326)::geography,
                       k.radius_m)
    ),
    'wards', coalesce((
      select jsonb_agg(jsonb_build_object('ward_id', x.ward_id, 'name', x.name, 'cells', x.n)
                       order by x.n desc)
      from (
        select o.ward_id, w.name, count(*) as n
        from owned o join public.wards w on w.id = o.ward_id
        group by o.ward_id, w.name
        order by n desc
        limit 5
      ) x
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Tạo, sửa CLB
-- ---------------------------------------------------------------------------

drop function if exists public.create_club(text, bigint);
create function public.create_club(
  p_name text, p_color bigint,
  p_description text default '',
  p_lat float8 default null, p_lng float8 default null, p_radius_m int default 2000,
  p_join_km numeric default 0, p_join_days int default 14,
  p_is_open boolean default false
)
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
  insert into public.clubs (id, name, color, invite_code, is_open, created_by, description,
                            center_lat, center_lng, radius_m, join_km, join_days)
    values (v_id, trim(p_name), p_color, public.generate_invite_code(), coalesce(p_is_open, false),
            v_user, coalesce(trim(p_description), ''), p_lat, p_lng, p_radius_m, p_join_km, p_join_days);
  perform public._leave_current(v_user);
  update public.profiles set club_id = v_id, club_role = 'owner', club_joined_at = now()
    where id = v_user;
  update public.club_join_requests set status = 'cancelled', resolved_at = now()
    where user_id = v_user and status = 'pending';
  return v_id;
end $$;

create or replace function public.update_club(
  p_description text, p_lat float8, p_lng float8, p_radius_m int,
  p_join_km numeric, p_join_days int, p_is_open boolean
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_club text;
begin
  select club_id into v_club from public._me_admin();
  update public.clubs set
    description = coalesce(trim(p_description), ''),
    center_lat = p_lat, center_lng = p_lng, radius_m = p_radius_m,
    join_km = p_join_km, join_days = p_join_days, is_open = coalesce(p_is_open, false)
  where id = v_club and created_by is not null;
  if not found then raise exception 'club_not_editable'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Gia nhập: xin vào, chạy đủ km trong khu vực thì tự vào
-- ---------------------------------------------------------------------------

-- Trả về {status: 'joined' | 'pending', club_id, request_id?}.
create or replace function public.request_join(p_club_id text default null, p_invite_code text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
  v_club public.clubs%rowtype;
  v_request uuid;
begin
  select * into v_me from public._me();
  if p_invite_code is not null then
    select * into v_club from public.clubs where invite_code = upper(trim(p_invite_code));
  else
    select * into v_club from public.clubs where id = p_club_id and is_open;
  end if;
  if v_club.id is null then raise exception 'club_not_found'; end if;

  if v_me.club_id = v_club.id then
    return jsonb_build_object('status', 'joined', 'club_id', v_club.id);
  end if;
  if v_club.join_km = 0 then
    perform public._join(v_me.user_id, v_club.id);
    return jsonb_build_object('status', 'joined', 'club_id', v_club.id);
  end if;

  update public.club_join_requests set status = 'cancelled', resolved_at = now()
    where user_id = v_me.user_id and status = 'pending';
  insert into public.club_join_requests (club_id, user_id, required_m, expires_at)
    values (v_club.id, v_me.user_id, v_club.join_km * 1000, now() + make_interval(days => v_club.join_days))
    returning id into v_request;
  return jsonb_build_object('status', 'pending', 'club_id', v_club.id, 'request_id', v_request);
end $$;

-- Giữ cho app cũ: vào thẳng nếu CLB không có điều kiện.
create or replace function public.join_club(p_club_id text default null, p_invite_code text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb := public.request_join(p_club_id, p_invite_code);
begin
  if v_result ->> 'status' <> 'joined' then raise exception 'join_requirement'; end if;
  return v_result ->> 'club_id';
end $$;

create or replace function public.leave_club()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public._me();
  perform public._join(v_user, 'tu-do');
end $$;

create or replace function public.my_join_request()
returns table (id uuid, club_id text, club_name text, club_color bigint,
               center_lat float8, center_lng float8, radius_m int,
               required_m float8, progress_m float8, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform public._expire_requests();
  return query
    select r.id, c.id, c.name, c.color, c.center_lat, c.center_lng, c.radius_m,
      r.required_m, r.progress_m, r.created_at, r.expires_at
    from public.club_join_requests r join public.clubs c on c.id = r.club_id
    where r.user_id = (select auth.uid()) and r.status = 'pending';
end $$;

create or replace function public.cancel_join_request()
returns void
language sql security definer set search_path = public as $$
  update public.club_join_requests set status = 'cancelled', resolved_at = now()
  where user_id = (select auth.uid()) and status = 'pending';
$$;

-- Đơn đang chờ của CLB mình (chỉ chủ nhiệm, phó nhóm).
create or replace function public.club_join_requests()
returns table (id uuid, user_id uuid, display_name text, color bigint,
               required_m float8, progress_m float8, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_club text;
begin
  select m.club_id into v_club from public._me_admin() m;
  perform public._expire_requests();
  return query
    select r.id, p.id, p.display_name, p.color, r.required_m, r.progress_m, r.created_at, r.expires_at
    from public.club_join_requests r join public.profiles p on p.id = r.user_id
    where r.club_id = v_club and r.status = 'pending'
    order by r.progress_m / r.required_m desc, r.created_at;
end $$;

-- Duyệt thẳng, không cần chạy đủ km ("thêm thành viên").
create or replace function public.approve_join_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_club text;
  v_user uuid;
begin
  select m.club_id into v_club from public._me_admin() m;
  select user_id into v_user from public.club_join_requests
    where id = p_request_id and club_id = v_club and status = 'pending';
  if v_user is null then raise exception 'request_not_found'; end if;
  perform public._join(v_user, v_club);
end $$;

create or replace function public.reject_join_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_club text;
begin
  select m.club_id into v_club from public._me_admin() m;
  update public.club_join_requests set status = 'rejected', resolved_at = now()
    where id = p_request_id and club_id = v_club and status = 'pending';
  if not found then raise exception 'request_not_found'; end if;
end $$;

-- Gọi từ edge function sau khi ghi buổi chạy: cộng số mét chạy trong khu vực
-- CLB vào đơn đang chờ. Chỉ tính buổi kết thúc sau lúc xin và bắt đầu trước hạn.
create or replace function public.advance_join_request(p_user uuid, p_activity_id uuid, p_meters float8)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_request public.club_join_requests%rowtype;
  v_activity public.activities%rowtype;
begin
  perform public._expire_requests();
  select * into v_request from public.club_join_requests
    where user_id = p_user and status = 'pending' for update;
  if not found then return null; end if;
  select * into v_activity from public.activities where id = p_activity_id and user_id = p_user;
  if not found or v_activity.flagged
     or v_activity.ended_at < v_request.created_at
     or v_activity.started_at > v_request.expires_at
     or coalesce(p_meters, 0) <= 0 then
    return null;
  end if;

  insert into public.club_join_request_runs (request_id, activity_id, meters)
    values (v_request.id, p_activity_id, least(p_meters, v_activity.distance_m))
    on conflict do nothing;
  if not found then return null; end if;

  update public.club_join_requests
    set progress_m = progress_m + least(p_meters, v_activity.distance_m)
    where id = v_request.id
    returning * into v_request;

  if v_request.progress_m >= v_request.required_m then
    perform public._join(p_user, v_request.club_id);
  end if;

  return jsonb_build_object(
    'request_id', v_request.id,
    'club_id', v_request.club_id,
    'club_name', (select name from public.clubs where id = v_request.club_id),
    'progress_m', v_request.progress_m,
    'required_m', v_request.required_m,
    'joined', v_request.progress_m >= v_request.required_m
  );
end $$;

revoke all on function public.advance_join_request(uuid, uuid, float8) from public, anon, authenticated;
grant execute on function public.advance_join_request(uuid, uuid, float8) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Thành viên: xoá khỏi CLB, phân quyền
-- ---------------------------------------------------------------------------

create or replace function public.remove_member(p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
  v_target_role text;
begin
  select * into v_me from public._me_admin();
  select club_role into v_target_role from public.profiles
    where id = p_user and club_id = v_me.club_id;
  if v_target_role is null or p_user = v_me.user_id then raise exception 'member_not_found'; end if;
  if v_target_role = 'owner' or (v_target_role = 'admin' and v_me.club_role <> 'owner') then
    raise exception 'not_allowed';
  end if;
  perform public._join(p_user, 'tu-do');
end $$;

create or replace function public.set_member_role(p_user uuid, p_role text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me_admin();
  if v_me.club_role <> 'owner' then raise exception 'not_allowed'; end if;
  if p_role not in ('admin', 'member') then raise exception 'invalid_role'; end if;
  update public.profiles set club_role = p_role
    where id = p_user and club_id = v_me.club_id and club_role <> 'owner';
  if not found then raise exception 'member_not_found'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Bảng tin
-- ---------------------------------------------------------------------------

create or replace function public.club_feed(max_rows int default 50)
returns table (id uuid, kind text, body text, data jsonb, created_at timestamptz,
               author_id uuid, author_name text, author_color bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_club text;
begin
  select m.club_id into v_club from public._me() m;
  if v_club = 'tu-do' then return; end if;
  return query
    select po.id, po.kind, po.body, po.data, po.created_at, a.id, a.display_name, a.color
    from public.club_posts po left join public.profiles a on a.id = po.author_id
    where po.club_id = v_club
    order by po.created_at desc
    limit least(greatest(max_rows, 1), 200);
end $$;

-- Đăng bài chữ, hoặc chia sẻ một buổi chạy của mình (số liệu lấy từ server).
create or replace function public.create_post(p_body text default '', p_activity_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
  v_activity public.activities%rowtype;
  v_id uuid;
begin
  select * into v_me from public._me();
  if v_me.club_id = 'tu-do' then raise exception 'not_in_club'; end if;
  if p_activity_id is not null then
    select * into v_activity from public.activities
      where id = p_activity_id and user_id = v_me.user_id and not flagged;
    if not found then raise exception 'activity_not_found'; end if;
    insert into public.club_posts (club_id, author_id, kind, body, data)
      values (v_me.club_id, v_me.user_id, 'run', left(coalesce(trim(p_body), ''), 500),
              jsonb_build_object('activity_id', v_activity.id,
                                 'distance_m', v_activity.distance_m,
                                 'moving_s', v_activity.moving_s,
                                 'cells', v_activity.cells_captured,
                                 'stolen', v_activity.cells_stolen,
                                 'started_at', v_activity.started_at))
      returning id into v_id;
  else
    if char_length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty_post'; end if;
    insert into public.club_posts (club_id, author_id, kind, body)
      values (v_me.club_id, v_me.user_id, 'text', left(trim(p_body), 500))
      returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.delete_post(p_post_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me();
  delete from public.club_posts
    where id = p_post_id and club_id = v_me.club_id
      and (author_id = v_me.user_id or v_me.club_role in ('owner', 'admin'));
  if not found then raise exception 'not_allowed'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Họp mặt
-- ---------------------------------------------------------------------------

create or replace function public.create_meetup(
  p_title text, p_starts_at timestamptz, p_lat float8, p_lng float8,
  p_place text default '', p_note text default ''
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
  v_id uuid;
begin
  select * into v_me from public._me_admin();
  if p_starts_at < now() - interval '1 hour' then raise exception 'meetup_in_past'; end if;
  insert into public.club_meetups (club_id, created_by, title, starts_at, lat, lng, place, note)
    values (v_me.club_id, v_me.user_id, trim(p_title), p_starts_at, p_lat, p_lng,
            coalesce(trim(p_place), ''), coalesce(trim(p_note), ''))
    returning id into v_id;
  insert into public.club_meetup_rsvps (meetup_id, user_id) values (v_id, v_me.user_id);
  perform public._post(v_me.club_id, v_me.user_id, 'meetup', trim(p_title),
    jsonb_build_object('meetup_id', v_id, 'starts_at', p_starts_at, 'place', coalesce(trim(p_place), '')));
  return v_id;
end $$;

-- Buổi họp mặt sắp tới (và vừa diễn ra trong 3 giờ) của CLB mình.
create or replace function public.club_meetups()
returns table (id uuid, title text, starts_at timestamptz, lat float8, lng float8,
               place text, note text, host_name text, going bigint, i_am_going boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me();
  return query
    select m.id, m.title, m.starts_at, m.lat, m.lng, m.place, m.note, h.display_name,
      (select count(*) from public.club_meetup_rsvps r where r.meetup_id = m.id),
      exists (select 1 from public.club_meetup_rsvps r where r.meetup_id = m.id and r.user_id = v_me.user_id)
    from public.club_meetups m left join public.profiles h on h.id = m.created_by
    where m.club_id = v_me.club_id and m.starts_at > now() - interval '3 hours'
    order by m.starts_at
    limit 20;
end $$;

create or replace function public.rsvp_meetup(p_meetup_id uuid, p_going boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me();
  if not exists (select 1 from public.club_meetups where id = p_meetup_id and club_id = v_me.club_id) then
    raise exception 'meetup_not_found';
  end if;
  if p_going then
    insert into public.club_meetup_rsvps (meetup_id, user_id) values (p_meetup_id, v_me.user_id)
      on conflict do nothing;
  else
    delete from public.club_meetup_rsvps where meetup_id = p_meetup_id and user_id = v_me.user_id;
  end if;
end $$;

create or replace function public.delete_meetup(p_meetup_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me_admin();
  delete from public.club_meetups where id = p_meetup_id and club_id = v_me.club_id;
  if not found then raise exception 'meetup_not_found'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Chiến dịch xâm lấn
-- ---------------------------------------------------------------------------

-- Số ô ở phường mục tiêu mà thành viên chiếm (từ người ngoài CLB) trong thời
-- gian chiến dịch và vẫn đang giữ.
create or replace function public._campaign_progress(p_campaign public.club_campaigns)
returns bigint
language sql stable security definer set search_path = public as $$
  select count(distinct e.cell_id)
  from public.cell_events e
  join public.cells c on c.id = e.cell_id
  join public.profiles holder on holder.id = c.owner_id
  where c.ward_id = p_campaign.target_ward_id
    and holder.club_id = p_campaign.club_id
    and e.new_owner = c.owner_id
    and e.created_at between p_campaign.starts_at and p_campaign.ends_at
    and not exists (
      select 1 from public.profiles prev
      where prev.id = e.previous_owner and prev.club_id = p_campaign.club_id
    );
$$;
revoke all on function public._campaign_progress(public.club_campaigns) from public, anon, authenticated;

create or replace function public.start_campaign(p_ward_id text, p_target_cells int, p_days int)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
  v_id uuid;
  v_ward text;
begin
  select * into v_me from public._me_admin();
  if p_days not between 1 and 30 then raise exception 'invalid_duration'; end if;
  select name into v_ward from public.wards where id = p_ward_id;
  if v_ward is null then raise exception 'ward_not_found'; end if;
  if exists (select 1 from public.club_campaigns
             where club_id = v_me.club_id and not cancelled and ends_at > now()) then
    raise exception 'campaign_active';
  end if;
  insert into public.club_campaigns (club_id, created_by, target_ward_id, target_cells, ends_at)
    values (v_me.club_id, v_me.user_id, p_ward_id, p_target_cells, now() + make_interval(days => p_days))
    returning id into v_id;
  perform public._post(v_me.club_id, v_me.user_id, 'campaign', v_ward,
    jsonb_build_object('campaign_id', v_id, 'ward_id', p_ward_id, 'target_cells', p_target_cells,
                       'ends_at', now() + make_interval(days => p_days)));
  return v_id;
end $$;

create or replace function public.club_campaigns()
returns table (id uuid, ward_id text, ward_name text, target_cells int, progress bigint,
               starts_at timestamptz, ends_at timestamptz, cancelled boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me();
  return query
    select k.id, k.target_ward_id, w.name, k.target_cells, public._campaign_progress(k),
      k.starts_at, k.ends_at, k.cancelled
    from public.club_campaigns k join public.wards w on w.id = k.target_ward_id
    where k.club_id = v_me.club_id
    order by k.ends_at desc
    limit 10;
end $$;

create or replace function public.cancel_campaign(p_campaign_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me_admin();
  update public.club_campaigns set cancelled = true
    where id = p_campaign_id and club_id = v_me.club_id and not cancelled and ends_at > now();
  if not found then raise exception 'campaign_not_found'; end if;
end $$;
