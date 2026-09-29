-- PostgREST trả tối đa max_rows (1000) dòng mỗi request, nên khu vực có hơn
-- 1000 ô bị cắt ngẫu nhiên. Sắp xếp theo id để BE tải theo trang (Range) ổn định.

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
  order by c.id
  limit least(greatest(max_rows, 1), 10000);
$$;
