// CLB, bảng tin, họp mặt, chiến dịch. Mỗi route gọi một hàm SQL bằng quyền của
// người dùng; phân quyền (chủ nhiệm, phó nhóm, thành viên) nằm trong các hàm đó.

import { Router } from 'express';
import { ApiError, bool, num, optNum, optStr, readJson, rpc, str } from '../http.ts';

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

export const clubRoutes = Router();

clubRoutes.get('/', async (req, res) => res.json(await rpc(req, 'list_clubs')));

clubRoutes.post('/', async (req, res) => {
  const body = readJson(req);
  const id = await rpc<string>(req, 'create_club', {
    p_name: str(body, 'name', { max: 40 }).trim(),
    p_color: num(body, 'color'),
    ...settingsParams(body),
  });
  return res.status(201).json({ id });
});

clubRoutes.get('/by-code/:code', async (req, res) =>
  res.json(first(await rpc<unknown[]>(req, 'find_club_by_code', { p_invite_code: req.params.code }))),
);

// Xin vào, rời CLB -------------------------------------------------------------

clubRoutes.post('/join', async (req, res) => {
  const body = readJson(req);
  return res.json(
    await rpc(req, 'request_join', {
      p_club_id: optStr(body, 'club_id', 100),
      p_invite_code: optStr(body, 'invite_code', 20),
    }),
  );
});

clubRoutes.get('/join-request', async (req, res) => res.json(first(await rpc<unknown[]>(req, 'my_join_request'))));

clubRoutes.delete('/join-request', async (req, res) => {
  await rpc(req, 'cancel_join_request');
  return res.json({ ok: true });
});

clubRoutes.post('/leave', async (req, res) => {
  await rpc(req, 'leave_club');
  return res.json({ ok: true });
});

// CLB của mình -----------------------------------------------------------------

clubRoutes.get('/mine', async (req, res) => res.json(first(await rpc<unknown[]>(req, 'my_club'))));

clubRoutes.patch('/mine', async (req, res) => {
  await rpc(req, 'update_club', settingsParams(readJson(req)));
  return res.json({ ok: true });
});

clubRoutes.get('/mine/join-requests', async (req, res) => res.json(await rpc(req, 'club_join_requests')));

clubRoutes.post('/mine/join-requests/:id/approve', async (req, res) => {
  await rpc(req, 'approve_join_request', { p_request_id: req.params.id });
  return res.json({ ok: true });
});

clubRoutes.post('/mine/join-requests/:id/reject', async (req, res) => {
  await rpc(req, 'reject_join_request', { p_request_id: req.params.id });
  return res.json({ ok: true });
});

clubRoutes.delete('/mine/members/:userId', async (req, res) => {
  await rpc(req, 'remove_member', { p_user: req.params.userId });
  return res.json({ ok: true });
});

clubRoutes.put('/mine/members/:userId/role', async (req, res) => {
  const body = readJson(req);
  await rpc(req, 'set_member_role', { p_user: req.params.userId, p_role: str(body, 'role', { max: 20 }) });
  return res.json({ ok: true });
});

clubRoutes.get('/mine/posts', async (req, res) => res.json(await rpc(req, 'club_feed')));

clubRoutes.post('/mine/posts', async (req, res) => {
  const body = readJson(req);
  const id = await rpc<string>(req, 'create_post', {
    p_body: str(body, 'body', { max: 500, optional: true }),
    p_activity_id: optStr(body, 'run_id', 64),
  });
  return res.status(201).json({ id });
});

clubRoutes.get('/mine/meetups', async (req, res) => res.json(await rpc(req, 'club_meetups')));

clubRoutes.post('/mine/meetups', async (req, res) => {
  const body = readJson(req);
  const startsAt = Date.parse(str(body, 'starts_at', { max: 40 }));
  if (!Number.isFinite(startsAt)) throw new ApiError(400, 'invalid_starts_at');
  const id = await rpc<string>(req, 'create_meetup', {
    p_title: str(body, 'title', { max: 80 }),
    p_starts_at: new Date(startsAt).toISOString(),
    p_lat: num(body, 'lat'),
    p_lng: num(body, 'lng'),
    p_place: str(body, 'place', { max: 120, optional: true }),
    p_note: str(body, 'note', { max: 280, optional: true }),
  });
  return res.status(201).json({ id });
});

clubRoutes.get('/mine/campaigns', async (req, res) => res.json(await rpc(req, 'club_campaigns')));

clubRoutes.post('/mine/campaigns', async (req, res) => {
  const body = readJson(req);
  const id = await rpc<string>(req, 'start_campaign', {
    p_ward_id: str(body, 'ward_id', { max: 64 }),
    p_target_cells: Math.round(num(body, 'target_cells')),
    p_days: Math.round(num(body, 'days')),
  });
  return res.status(201).json({ id });
});

// Theo id CLB (đặt sau /mine để không bị nhầm "mine" là id) ----------------------

clubRoutes.get('/:id/members', async (req, res) => res.json(await rpc(req, 'club_members', { p_club_id: req.params.id })));

clubRoutes.get('/:id/territory', async (req, res) =>
  res.json(await rpc(req, 'club_territory', { p_club_id: req.params.id })),
);

// Bài viết, bình luận, họp mặt, chiến dịch theo id --------------------------------

export const clubItemRoutes = Router();

clubItemRoutes.delete('/posts/:id', async (req, res) => {
  await rpc(req, 'delete_post', { p_post_id: req.params.id });
  return res.json({ ok: true });
});

clubItemRoutes.get('/posts/:id/comments', async (req, res) =>
  res.json(await rpc(req, 'post_comments', { p_post_id: req.params.id })),
);

clubItemRoutes.post('/posts/:id/comments', async (req, res) => {
  const body = readJson(req);
  const id = await rpc<string>(req, 'create_comment', {
    p_post_id: req.params.id,
    p_body: str(body, 'body', { max: 500 }),
    p_reply_to: optStr(body, 'reply_to', 64),
  });
  return res.status(201).json({ id });
});

clubItemRoutes.post('/posts/:id/like', async (req, res) =>
  res.json(await rpc(req, 'toggle_like', { p_post_id: req.params.id })),
);

clubItemRoutes.delete('/comments/:id', async (req, res) => {
  await rpc(req, 'delete_comment', { p_comment_id: req.params.id });
  return res.json({ ok: true });
});

clubItemRoutes.post('/meetups/:id/rsvp', async (req, res) => {
  const body = readJson(req);
  await rpc(req, 'rsvp_meetup', { p_meetup_id: req.params.id, p_going: bool(body, 'going') });
  return res.json({ ok: true });
});

clubItemRoutes.delete('/meetups/:id', async (req, res) => {
  await rpc(req, 'delete_meetup', { p_meetup_id: req.params.id });
  return res.json({ ok: true });
});

clubItemRoutes.post('/campaigns/:id/cancel', async (req, res) => {
  await rpc(req, 'cancel_campaign', { p_campaign_id: req.params.id });
  return res.json({ ok: true });
});
