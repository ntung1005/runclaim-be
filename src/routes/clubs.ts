// CLB, bảng tin, họp mặt, chiến dịch. Mỗi route gọi một hàm SQL bằng quyền của
// người dùng; phân quyền (chủ nhiệm, phó nhóm, thành viên) nằm trong các hàm đó.

import { Hono } from 'hono';
import { ApiError, bool, num, optNum, optStr, readJson, rpc, str, type AppEnv } from '../http.ts';

const first = <T>(rows: T[]) => rows[0] ?? null;

/** Khu vực và điều kiện gia nhập, dùng chung cho tạo và sửa CLB. */
function settingsParams(body: Record<string, unknown>) {
  const lat = optNum(body, 'lat');
  const lng = optNum(body, 'lng');
  if ((lat === null) !== (lng === null)) throw new ApiError(400, 'invalid_area');
  return {
    p_description: str(body, 'description', { max: 280, optional: true }),
    p_lat: lat,
    p_lng: lng,
    p_radius_m: Math.round(optNum(body, 'radius_m') ?? 2000),
    p_join_km: optNum(body, 'join_km') ?? 0,
    p_join_days: Math.round(optNum(body, 'join_days') ?? 14),
    p_is_open: body.is_open === undefined ? false : bool(body, 'is_open'),
  };
}

export const clubRoutes = new Hono<AppEnv>();

clubRoutes.get('/', async (c) => c.json(await rpc(c, 'list_clubs')));

clubRoutes.post('/', async (c) => {
  const body = await readJson(c);
  const id = await rpc<string>(c, 'create_club', {
    p_name: str(body, 'name', { max: 40 }).trim(),
    p_color: num(body, 'color'),
    ...settingsParams(body),
  });
  return c.json({ id }, 201);
});

clubRoutes.get('/by-code/:code', async (c) =>
  c.json(first(await rpc<unknown[]>(c, 'find_club_by_code', { p_invite_code: c.req.param('code') }))),
);

// Xin vào, rời CLB -------------------------------------------------------------

clubRoutes.post('/join', async (c) => {
  const body = await readJson(c);
  return c.json(
    await rpc(c, 'request_join', {
      p_club_id: optStr(body, 'club_id', 100),
      p_invite_code: optStr(body, 'invite_code', 20),
    }),
  );
});

clubRoutes.get('/join-request', async (c) => c.json(first(await rpc<unknown[]>(c, 'my_join_request'))));

clubRoutes.delete('/join-request', async (c) => {
  await rpc(c, 'cancel_join_request');
  return c.json({ ok: true });
});

clubRoutes.post('/leave', async (c) => {
  await rpc(c, 'leave_club');
  return c.json({ ok: true });
});

// CLB của mình -----------------------------------------------------------------

clubRoutes.get('/mine', async (c) => c.json(first(await rpc<unknown[]>(c, 'my_club'))));

clubRoutes.patch('/mine', async (c) => {
  await rpc(c, 'update_club', settingsParams(await readJson(c)));
  return c.json({ ok: true });
});

clubRoutes.get('/mine/join-requests', async (c) => c.json(await rpc(c, 'club_join_requests')));

clubRoutes.post('/mine/join-requests/:id/approve', async (c) => {
  await rpc(c, 'approve_join_request', { p_request_id: c.req.param('id') });
  return c.json({ ok: true });
});

clubRoutes.post('/mine/join-requests/:id/reject', async (c) => {
  await rpc(c, 'reject_join_request', { p_request_id: c.req.param('id') });
  return c.json({ ok: true });
});

clubRoutes.delete('/mine/members/:userId', async (c) => {
  await rpc(c, 'remove_member', { p_user: c.req.param('userId') });
  return c.json({ ok: true });
});

clubRoutes.put('/mine/members/:userId/role', async (c) => {
  const body = await readJson(c);
  await rpc(c, 'set_member_role', { p_user: c.req.param('userId'), p_role: str(body, 'role', { max: 20 }) });
  return c.json({ ok: true });
});

clubRoutes.get('/mine/posts', async (c) => c.json(await rpc(c, 'club_feed')));

clubRoutes.post('/mine/posts', async (c) => {
  const body = await readJson(c);
  const id = await rpc<string>(c, 'create_post', {
    p_body: str(body, 'body', { max: 500, optional: true }),
    p_activity_id: optStr(body, 'run_id', 64),
  });
  return c.json({ id }, 201);
});

clubRoutes.get('/mine/meetups', async (c) => c.json(await rpc(c, 'club_meetups')));

clubRoutes.post('/mine/meetups', async (c) => {
  const body = await readJson(c);
  const startsAt = Date.parse(str(body, 'starts_at', { max: 40 }));
  if (!Number.isFinite(startsAt)) throw new ApiError(400, 'invalid_starts_at');
  const id = await rpc<string>(c, 'create_meetup', {
    p_title: str(body, 'title', { max: 80 }),
    p_starts_at: new Date(startsAt).toISOString(),
    p_lat: num(body, 'lat'),
    p_lng: num(body, 'lng'),
    p_place: str(body, 'place', { max: 120, optional: true }),
    p_note: str(body, 'note', { max: 280, optional: true }),
  });
  return c.json({ id }, 201);
});

clubRoutes.get('/mine/campaigns', async (c) => c.json(await rpc(c, 'club_campaigns')));

clubRoutes.post('/mine/campaigns', async (c) => {
  const body = await readJson(c);
  const id = await rpc<string>(c, 'start_campaign', {
    p_ward_id: str(body, 'ward_id', { max: 64 }),
    p_target_cells: Math.round(num(body, 'target_cells')),
    p_days: Math.round(num(body, 'days')),
  });
  return c.json({ id }, 201);
});

// Theo id CLB (đặt sau /mine để không bị nhầm "mine" là id) ----------------------

clubRoutes.get('/:id/members', async (c) => c.json(await rpc(c, 'club_members', { p_club_id: c.req.param('id') })));

clubRoutes.get('/:id/territory', async (c) =>
  c.json(await rpc(c, 'club_territory', { p_club_id: c.req.param('id') })),
);

// Bài viết, bình luận, họp mặt, chiến dịch theo id --------------------------------

export const clubItemRoutes = new Hono<AppEnv>();

clubItemRoutes.delete('/posts/:id', async (c) => {
  await rpc(c, 'delete_post', { p_post_id: c.req.param('id') });
  return c.json({ ok: true });
});

clubItemRoutes.get('/posts/:id/comments', async (c) =>
  c.json(await rpc(c, 'post_comments', { p_post_id: c.req.param('id') })),
);

clubItemRoutes.post('/posts/:id/comments', async (c) => {
  const body = await readJson(c);
  const id = await rpc<string>(c, 'create_comment', {
    p_post_id: c.req.param('id'),
    p_body: str(body, 'body', { max: 500 }),
    p_reply_to: optStr(body, 'reply_to', 64),
  });
  return c.json({ id }, 201);
});

clubItemRoutes.post('/posts/:id/like', async (c) =>
  c.json(await rpc(c, 'toggle_like', { p_post_id: c.req.param('id') })),
);

clubItemRoutes.delete('/comments/:id', async (c) => {
  await rpc(c, 'delete_comment', { p_comment_id: c.req.param('id') });
  return c.json({ ok: true });
});

clubItemRoutes.post('/meetups/:id/rsvp', async (c) => {
  const body = await readJson(c);
  await rpc(c, 'rsvp_meetup', { p_meetup_id: c.req.param('id'), p_going: bool(body, 'going') });
  return c.json({ ok: true });
});

clubItemRoutes.delete('/meetups/:id', async (c) => {
  await rpc(c, 'delete_meetup', { p_meetup_id: c.req.param('id') });
  return c.json({ ok: true });
});

clubItemRoutes.post('/campaigns/:id/cancel', async (c) => {
  await rpc(c, 'cancel_campaign', { p_campaign_id: c.req.param('id') });
  return c.json({ ok: true });
});
