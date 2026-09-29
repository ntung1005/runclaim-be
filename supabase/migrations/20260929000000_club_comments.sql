-- Bảng tin CLB: bình luận (có trả lời một bình luận khác) và cổ vũ (thích).
-- Như các bảng CLB khác: bật RLS, không có policy, chỉ truy cập qua RPC.

create table public.club_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.club_posts (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  -- Bình luận được trả lời (cùng bài). Bình luận gốc bị xoá thì giữ bình luận trả lời.
  reply_to uuid references public.club_post_comments (id) on delete set null,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index club_post_comments_post_idx on public.club_post_comments (post_id, created_at);

create table public.club_post_likes (
  post_id uuid not null references public.club_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.club_post_comments enable row level security;
alter table public.club_post_likes enable row level security;

-- Bài phải thuộc CLB của người gọi. Trả về club_id của bài.
create or replace function public._my_post_club(p_post_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_me record;
  v_club text;
begin
  select * into v_me from public._me();
  select club_id into v_club from public.club_posts where id = p_post_id;
  if v_club is null or v_club <> v_me.club_id then raise exception 'post_not_found'; end if;
  return v_club;
end $$;
revoke all on function public._my_post_club(uuid) from public, anon, authenticated;

-- Bảng tin kèm số cổ vũ, số bình luận và mình đã cổ vũ chưa.
drop function if exists public.club_feed(int);
create function public.club_feed(max_rows int default 50)
returns table (id uuid, kind text, body text, data jsonb, created_at timestamptz,
               author_id uuid, author_name text, author_color bigint,
               like_count bigint, comment_count bigint, i_liked boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me();
  if v_me.club_id = 'tu-do' then return; end if;
  return query
    select po.id, po.kind, po.body, po.data, po.created_at, a.id, a.display_name, a.color,
      (select count(*) from public.club_post_likes l where l.post_id = po.id),
      (select count(*) from public.club_post_comments c where c.post_id = po.id),
      exists (select 1 from public.club_post_likes l where l.post_id = po.id and l.user_id = v_me.user_id)
    from public.club_posts po left join public.profiles a on a.id = po.author_id
    where po.club_id = v_me.club_id
    order by po.created_at desc
    limit least(greatest(max_rows, 1), 200);
end $$;

create or replace function public.post_comments(p_post_id uuid)
returns table (id uuid, body text, created_at timestamptz, author_id uuid, author_name text,
               author_color bigint, reply_to uuid, reply_to_name text)
language plpgsql security definer set search_path = public as $$
begin
  perform public._my_post_club(p_post_id);
  return query
    select c.id, c.body, c.created_at, a.id, a.display_name, a.color, c.reply_to, ra.display_name
    from public.club_post_comments c
    left join public.profiles a on a.id = c.author_id
    left join public.club_post_comments r on r.id = c.reply_to
    left join public.profiles ra on ra.id = r.author_id
    where c.post_id = p_post_id
    order by c.created_at
    limit 500;
end $$;

create or replace function public.create_comment(p_post_id uuid, p_body text, p_reply_to uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := (select auth.uid());
  v_id uuid;
begin
  perform public._my_post_club(p_post_id);
  if char_length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty_post'; end if;
  if p_reply_to is not null and not exists (
    select 1 from public.club_post_comments where id = p_reply_to and post_id = p_post_id
  ) then
    raise exception 'comment_not_found';
  end if;
  insert into public.club_post_comments (post_id, author_id, reply_to, body)
    values (p_post_id, v_user, p_reply_to, left(trim(p_body), 500))
    returning id into v_id;
  return v_id;
end $$;

-- Tác giả, chủ nhiệm hoặc phó nhóm xoá được bình luận.
create or replace function public.delete_comment(p_comment_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me record;
begin
  select * into v_me from public._me();
  delete from public.club_post_comments c
    using public.club_posts po
    where c.id = p_comment_id and po.id = c.post_id and po.club_id = v_me.club_id
      and (c.author_id = v_me.user_id or v_me.club_role in ('owner', 'admin'));
  if not found then raise exception 'not_allowed'; end if;
end $$;

-- Bật / tắt cổ vũ. Trả về {liked, count}.
create or replace function public.toggle_like(p_post_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := (select auth.uid());
  v_liked boolean;
begin
  perform public._my_post_club(p_post_id);
  delete from public.club_post_likes where post_id = p_post_id and user_id = v_user;
  v_liked := not found;
  if v_liked then
    insert into public.club_post_likes (post_id, user_id) values (p_post_id, v_user);
  end if;
  return jsonb_build_object(
    'liked', v_liked,
    'count', (select count(*) from public.club_post_likes where post_id = p_post_id)
  );
end $$;
