// Kiểm thử end-to-end: gọi API của BE như app thật, BE ghi vào Supabase local.
// Cần: `npm run db:start` và BE đang chạy (`npm run dev`). Chạy: npm run e2e
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const base = process.env.BE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const step = (name: string) => console.log(`✓ ${name}`);

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

async function call(token: string | null, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

/** Người chơi: đăng ký tài khoản mới, có hàm gọi API sẵn token. */
async function newPlayer(name: string, { profile = true } = {}) {
  const username = `e2e_${randomUUID().slice(0, 8)}`;
  const reg = await call(null, 'POST', '/auth/register', { username, password: 'matkhau123' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const token: string = reg.data.access_token;
  const api = (method: string, path: string, body?: unknown) => call(token, method, path, body);
  if (profile) {
    const r = await api('PUT', '/me/profile', { display_name: name, color: 0xff00897b });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  return { id: reg.data.user.id as string, username, token, api, session: reg.data };
}

const ok = (r: Res) => {
  assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
};

// ---------------------------------------------------------------------------
// Tài khoản
// ---------------------------------------------------------------------------

const A = await newPlayer('E2E Runner', { profile: false });
assert.equal((await call(null, 'POST', '/auth/register', { username: A.username, password: 'khac12345' })).status, 409);
assert.equal((await call(null, 'POST', '/auth/register', { username: 'A b', password: 'matkhau123' })).data.error, 'invalid_username');
assert.equal((await call(null, 'POST', '/auth/register', { username: 'ngan_qua', password: '123' })).data.error, 'weak_password');
step('đăng ký: trùng tên (409), tên sai định dạng, mật khẩu yếu bị từ chối');

let r = await call(null, 'POST', '/auth/login', { username: A.username, password: 'sai-mat-khau' });
assert.equal(r.status, 401);
r = await call(null, 'POST', '/auth/login', { username: A.username.toUpperCase(), password: 'matkhau123' });
assert.equal(r.status, 200);
assert.equal(r.data.user.id, A.id);
const refreshed = ok(await call(null, 'POST', '/auth/refresh', { refresh_token: r.data.refresh_token }));
assert.ok(refreshed.access_token);
assert.equal(refreshed.user.username, A.username);
assert.equal((await call(null, 'GET', '/me')).status, 401);
assert.equal((await call('khong-phai-jwt', 'GET', '/me')).status, 401);
step('đăng nhập (không phân biệt hoa thường), sai mật khẩu 401, làm mới token, chặn request không có token');

let me = ok(await A.api('GET', '/me'));
assert.equal(me.user.username, A.username);
assert.equal(me.profile, null);
step('tài khoản mới chưa có hồ sơ');

const t0 = Date.now() - 20 * 60_000;
const run = (segments: unknown[], id = randomUUID()) => ({
  id,
  startedAt: new Date(t0).toISOString(),
  endedAt: new Date(t0 + 15 * 60_000).toISOString(),
  simulated: true,
  segments,
});
// ~950 m về phía bắc, 8 m mỗi 3 giây.
const jog = Array.from({ length: 120 }, (_, i) => ({
  lat: 21.0287 + (i * 8) / 111320, lng: 105.8534, t: t0 + i * 3000, acc: 5,
}));
const body = { ...run([jog]), splits: [330.5] };

r = await A.api('POST', '/runs', body);
assert.equal(r.status, 409);
assert.equal(r.data.error, 'profile_not_found');
step('chưa có hồ sơ thì không nộp được buổi chạy');

ok(await A.api('PUT', '/me/profile', { display_name: 'E2E Runner', color: 0xffff5722 }));
me = ok(await A.api('GET', '/me'));
assert.equal(me.profile.display_name, 'E2E Runner');
assert.equal(me.profile.club_id, 'tu-do');
step('tạo hồ sơ: bắt đầu ở "Tự do"');

ok(await A.api('PATCH', '/me/settings', { personal_params: { weight: 58, goal: 25 }, map_style: 'dark' }));
const settings = ok(await A.api('PATCH', '/me/settings', { sim: { enabled: true, route: 'loop', speed: 30 } }));
assert.deepEqual(settings.personal_params, { weight: 58, goal: 25 });
assert.equal(settings.sim.speed, 30);
assert.equal(ok(await A.api('GET', '/me')).settings.map_style, 'dark');
step('cài đặt (chỉ số cá nhân, giả lập, kiểu bản đồ) lưu trên server, gộp theo khoá');

// Phòng thủ nhiều lớp: dùng thẳng token với Supabase vẫn bị RLS chặn.
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false },
  global: { headers: { Authorization: `Bearer ${A.token}` } },
});
const direct = await sb.from('cells').insert({ id: '1:1', owner_id: A.id, center: 'POINT(0 0)' });
assert.ok(direct.error, 'không được ghi thẳng vào cells');
const rpcDirect = await sb.rpc('apply_activity', { p_user: A.id, p_activity: {}, p_cells: [] });
assert.ok(rpcDirect.error, 'không được gọi apply_activity');
const otherSettings = await sb.from('user_settings').select('*');
assert.ok(otherSettings.data!.every((s) => s.user_id === A.id), 'chỉ đọc được cài đặt của mình');
const anon = await createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false },
}).auth.signInAnonymously();
assert.ok(anon.error, 'đăng nhập ẩn danh đã tắt');
step('RLS chặn ghi lãnh thổ trực tiếp; tắt đăng nhập ẩn danh');

// ---------------------------------------------------------------------------
// Buổi chạy, lãnh thổ
// ---------------------------------------------------------------------------

const first = ok(await A.api('POST', '/runs', body));
assert.equal(first.flagged, false);
assert.ok(first.captured > 0);
assert.ok(Math.abs(first.distance_m - 950) < 10);
step(`nộp buổi chạy: ${Math.round(first.distance_m)} m, chiếm ${first.captured} ô`);

const again = ok(await A.api('POST', '/runs', body));
assert.equal(again.duplicate, true);
assert.equal(again.captured, first.captured);
step('nộp lại cùng id không chiếm đất lần hai');

let history = ok(await A.api('GET', '/runs'));
assert.equal(history.length, 1);
assert.equal(history[0].id, body.id);
assert.deepEqual(history[0].splits, [330.5]);
assert.equal(history[0].cell_ids.length, first.cell_ids.length);
assert.equal(history[0].segments[0].length, jog.length);
assert.deepEqual(history[0].segments[0][0], [21.0287, 105.8534]);
step('lịch sử chạy đọc từ server: ô, splits, đường chạy');

const bbox = ok(await A.api('GET', '/territory?min_lat=21.0&min_lng=105.82&max_lat=21.06&max_lng=105.88'));
assert.equal(bbox.filter((c: { owner_id: string }) => c.owner_id === A.id).length, first.captured);
assert.equal((await A.api('GET', '/territory?min_lat=abc')).status, 400);
step('lãnh thổ theo khung nhìn');

const board = ok(await A.api('GET', '/leaderboard'));
assert.equal(Number(board.standing.cells), first.captured);
assert.ok(board.players.length > 0 && board.clubs.length > 0 && board.wards.length > 0);
step('bảng xếp hạng');

const car = Array.from({ length: 30 }, (_, i) => ({
  lat: 21.02 + (i * 150) / 111320, lng: 105.84, t: t0 + i * 10_000, acc: 5,
}));
const carRun = ok(await A.api('POST', '/runs', run([car])));
assert.equal(carRun.flagged, true);
assert.equal(carRun.captured, 0);
step('đi xe máy bị đánh dấu nghi vấn, không chiếm ô');

r = await A.api('POST', '/runs', { ...body, id: 'not-a-uuid' });
assert.equal(r.status, 422);
r = await A.api('POST', '/runs', { ...run([jog]), splits: ['x'] });
assert.equal(r.status, 422);
step('dữ liệu sai định dạng bị từ chối (422)');

// Vòng vuông 400 m ở chỗ trống (phía tây Hồ Tây), 8 m mỗi 3 giây.
const mLng = 111320 * Math.cos((21.0287 * Math.PI) / 180);
const square = (lat0: number, lng0: number, startT: number) => {
  const wp = [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]];
  const out = [];
  let k = 0;
  for (let i = 0; i < wp.length - 1; i++) {
    const [x0, y0] = wp[i], [x1, y1] = wp[i + 1];
    for (let s = 0; s < 50; s++) {
      out.push({ lat: lat0 + (y0 + ((y1 - y0) * s) / 50) / 111320, lng: lng0 + (x0 + ((x1 - x0) * s) / 50) / mLng, t: startT + k++ * 3000, acc: 5 });
    }
  }
  out.push({ lat: lat0, lng: lng0, t: startT + k * 3000, acc: 5 });
  return out;
};
const loopRun = ok(await A.api('POST', '/runs', run([square(21.06, 105.80, t0)])));
assert.equal(loopRun.loops, 1);
assert.ok(loopRun.loop_cells > 0);
step(`vòng khép kín: ${loopRun.loops} vòng, +${loopRun.loop_cells} ô bên trong, tổng ${loopRun.captured} ô`);

// ---------------------------------------------------------------------------
// CLB
// ---------------------------------------------------------------------------

const created = ok(await A.api('POST', '/clubs', { name: 'E2E Club', color: 0xff00acc1 }));
const clubId: string = created.id;
const myClub = ok(await A.api('GET', '/clubs/mine'));
assert.equal(myClub.id, clubId);
assert.equal(myClub.invite_code.length, 6);
assert.equal(myClub.role, 'owner');
const leaked = await sb.from('clubs').select('invite_code').eq('id', clubId);
assert.ok(leaked.error, 'mã mời không được lộ qua bảng clubs');
step(`tạo CLB kín, mã mời ${myClub.invite_code} chỉ thành viên thấy`);

const B = await newPlayer('Kẻ cướp');
assert.equal((await B.api('POST', '/clubs/join', { invite_code: 'ZZZZZZ' })).data.error, 'club_not_found');
assert.equal(ok(await B.api('GET', `/clubs/by-code/${myClub.invite_code}`)).id, clubId);
const joined = ok(await B.api('POST', '/clubs/join', { invite_code: myClub.invite_code.toLowerCase() }));
assert.equal(joined.status, 'joined');
assert.equal(ok(await A.api('GET', `/clubs/${clubId}/members`)).length, 2);
step('B tham gia bằng mã mời (không phân biệt hoa thường), CLB có 2 thành viên');

ok(await B.api('POST', '/clubs/leave'));
assert.equal(ok(await B.api('POST', '/clubs/join', { club_id: 'hn-runners' })).status, 'joined');
const gated = ok(await B.api('POST', '/clubs/join', { club_id: 'ho-tay' }));
assert.equal(gated.status, 'pending', 'CLB có điều kiện phải xin vào');
assert.equal(ok(await B.api('GET', '/clubs/join-request')).club_id, 'ho-tay');
ok(await B.api('DELETE', '/clubs/join-request'));
assert.equal(ok(await B.api('GET', '/clubs/join-request')), null);
assert.equal((await B.api('POST', '/clubs/join', { club_id: clubId })).status, 404, 'CLB kín không vào được bằng id');
const listed = ok(await B.api('GET', '/clubs'));
assert.ok(listed.some((c: { id: string }) => c.id === 'ho-tay') && !listed.some((c: { id: string }) => c.id === clubId));
step('rời CLB, vào CLB mở; CLB có điều kiện tạo đơn chờ; CLB kín không hiện trong danh sách');

// B chạy lại đúng đường của A 1 lần: bằng số lần của A nên không cướp được.
const tie = ok(await B.api('POST', '/runs', run([jog])));
assert.equal(tie.stolen, 0, 'chạy ít hơn hoặc bằng chủ ô thì không cướp được');
step('B chạy qua bằng số lần của A: không cướp được ô nào');

// Hộp thư: B chạy lần 2, nhiều hơn A -> A thấy "Kẻ cướp đã cướp N ô".
const steal = ok(await B.api('POST', '/runs', run([jog])));
assert.ok(steal.stolen > 0);
const feed = ok(await A.api('GET', '/feed'));
const item = feed.find((f: { thief_id: string }) => f.thief_id === B.id);
assert.ok(item, 'A phải thấy thông báo bị cướp');
assert.equal(Number(item.cells), steal.stolen);
assert.equal(item.ward_name, 'Hoàn Kiếm');
step(`hộp thư: "${item.thief_name} đã cướp ${item.cells} ô của bạn ở phường ${item.ward_name}"`);

// Quản lý CLB ----------------------------------------------------------------

const now = Date.now();
// Chạy về phía bắc từ (lat0, lng0), 8 m mỗi 3 giây, kết thúc đúng lúc gọi hàm.
const northRun = (lat0: number, lng0: number, meters: number) => {
  const n = Math.round(meters / 8);
  const start = Date.now() - n * 3000;
  return Array.from({ length: n + 1 }, (_, i) => ({ lat: lat0 + (i * 8) / 111320, lng: lng0, t: start + i * 3000, acc: 5 }));
};
const runNow = (segment: { t: number }[], id = randomUUID()) => ({
  id, startedAt: new Date(segment[0].t).toISOString(), endedAt: new Date(segment.at(-1)!.t).toISOString(),
  simulated: true, segments: [segment],
});

ok(await A.api('PATCH', '/clubs/mine', {
  description: 'CLB e2e', lat: 21.0287, lng: 105.8524, radius_m: 1500, join_km: 1, join_days: 7, is_open: false,
}));
const club = ok(await A.api('GET', '/clubs/mine'));
assert.equal(Number(club.join_km), 1);
assert.equal(club.radius_m, 1500);
step('chủ nhiệm đặt khu vực (Hồ Gươm, 1,5 km) và điều kiện: chạy 1 km');

const C = await newPlayer('Runner C');
assert.equal(ok(await C.api('POST', '/clubs/join', { invite_code: myClub.invite_code })).status, 'pending');
const sbC = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false },
  global: { headers: { Authorization: `Bearer ${C.token}` } },
});
const directRole = await sbC.from('profiles').update({ club_role: 'admin' }).eq('id', C.id);
assert.match(directRole.error?.message ?? '', /role_is_managed/, 'không được tự đổi vai trò');
const forged = await sbC.rpc('advance_join_request', { p_user: C.id, p_activity_id: randomUUID(), p_meters: 5000 });
assert.ok(forged.error, 'client không được tự cộng km');
step('C xin vào bằng mã mời: đơn chờ; không tự đổi vai trò, không tự cộng km');

const outside = ok(await C.api('POST', '/runs', runNow(northRun(21.06, 105.80, 600))));
assert.equal(outside.join, null, 'chạy ngoài khu vực không được tính');
const firstIn = runNow(northRun(21.0287, 105.8524, 600));
let res1 = ok(await C.api('POST', '/runs', firstIn));
assert.equal(res1.join.joined, false);
assert.ok(Math.abs(res1.join.progress_m - 600) < 20, `progress ${res1.join.progress_m}`);
const dup = ok(await C.api('POST', '/runs', firstIn));
assert.equal(dup.duplicate, true);
assert.equal(dup.join, null, 'nộp lại không cộng km lần hai');
res1 = ok(await C.api('POST', '/runs', runNow(northRun(21.0240, 105.8500, 600))));
assert.equal(res1.join.joined, true);
const cClub = ok(await C.api('GET', '/clubs/mine'));
assert.equal(cClub.id, clubId);
assert.equal(cClub.role, 'member');
let posts = ok(await A.api('GET', '/clubs/mine/posts'));
assert.ok(posts.some((p: { kind: string; author_id: string }) => p.kind === 'join' && p.author_id === C.id));
step(`C chạy ${Math.round(res1.join.progress_m)} m trong khu vực: tự vào CLB, bảng tin báo "đã gia nhập"`);

ok(await A.api('PUT', `/clubs/mine/members/${C.id}/role`, { role: 'admin' }));
const roles = Object.fromEntries(
  ok(await A.api('GET', `/clubs/${clubId}/members`)).map((m: { player_id: string; role: string }) => [m.player_id, m.role]),
);
assert.equal(roles[C.id], 'admin');
r = await C.api('DELETE', `/clubs/mine/members/${A.id}`);
assert.equal(r.data.error, 'not_allowed', 'phó nhóm không xoá được chủ nhiệm');
step('chủ nhiệm đặt C làm phó nhóm; phó nhóm không xoá được chủ nhiệm');

const D = await newPlayer('Runner D');
ok(await D.api('POST', '/clubs/join', { invite_code: myClub.invite_code }));
const pendingList = ok(await C.api('GET', '/clubs/mine/join-requests'));
assert.equal(pendingList.length, 1);
assert.equal(pendingList[0].user_id, D.id);
assert.ok((await D.api('GET', '/clubs/mine/join-requests')).status >= 400, 'người ngoài không xem được đơn');
ok(await C.api('POST', `/clubs/mine/join-requests/${pendingList[0].id}/approve`));
assert.equal(ok(await D.api('GET', '/clubs/mine')).id, clubId);
step('D xin vào, phó nhóm C duyệt thẳng (thêm thành viên)');

const postId = ok(await C.api('POST', '/clubs/mine/posts', { body: 'Sáng mai 5h Tháp Rùa nhé!' })).id;
assert.equal((await D.api('DELETE', `/posts/${postId}`)).data.error, 'not_allowed', 'thành viên không xoá bài người khác');
ok(await C.api('POST', '/clubs/mine/posts', { body: 'Buổi sáng đẹp', run_id: firstIn.id }));
posts = ok(await D.api('GET', '/clubs/mine/posts'));
const runPost = posts.find((p: { kind: string }) => p.kind === 'run');
assert.ok(Math.abs(runPost.data.distance_m - 600) < 20);
ok(await A.api('DELETE', `/posts/${postId}`));
step('bảng tin: đăng bài, chia sẻ buổi chạy (số liệu từ server), chủ nhiệm xoá bài');

const meetupId = ok(await A.api('POST', '/clubs/mine/meetups', {
  title: 'Chạy chung cuối tuần', starts_at: new Date(now + 2 * 86400_000).toISOString(),
  lat: 21.0287, lng: 105.8524, place: 'Tháp Rùa',
})).id;
ok(await D.api('POST', `/meetups/${meetupId}/rsvp`, { going: true }));
const meetups = ok(await D.api('GET', '/clubs/mine/meetups'));
assert.equal(Number(meetups[0].going), 2);
assert.equal(meetups[0].i_am_going, true);
r = await D.api('POST', '/clubs/mine/meetups', {
  title: 'Không được', starts_at: new Date(now + 86400_000).toISOString(), lat: 21, lng: 105,
});
assert.equal(r.data.error, 'not_club_admin');
step('họp mặt: chủ nhiệm tạo, D tham gia (2 người); thành viên thường không tạo được');

ok(await A.api('POST', '/clubs/mine/campaigns', { ward_id: 'hn-tay-ho', target_cells: 5, days: 7 }));
r = await A.api('POST', '/clubs/mine/campaigns', { ward_id: 'hn-ba-dinh', target_cells: 5, days: 7 });
assert.equal(r.data.error, 'campaign_active');
ok(await D.api('POST', '/runs', runNow(northRun(21.066, 105.823, 500))));
const campaign = ok(await A.api('GET', '/clubs/mine/campaigns'))[0];
assert.equal(campaign.ward_name, 'Tây Hồ');
assert.ok(Number(campaign.progress) > 0, 'chiến dịch phải có tiến độ');
step(`chiến dịch xâm lấn Tây Hồ: D chiếm ${campaign.progress}/${campaign.target_cells} ô; không mở 2 chiến dịch cùng lúc`);

const territory = ok(await A.api('GET', `/clubs/${clubId}/territory`));
assert.ok(territory.cells > 0 && territory.in_area > 0 && territory.in_area < territory.cells);
step(`lãnh thổ CLB: ${territory.cells} ô, ${territory.in_area} ô trong khu vực`);

ok(await A.api('POST', '/clubs/leave'));
assert.equal(ok(await C.api('GET', '/clubs/mine')).role, 'owner');
step('chủ nhiệm rời CLB: quyền chuyển cho phó nhóm C');

// Bình luận, trả lời, cổ vũ. Lúc này C là chủ nhiệm, D là thành viên, A đã rời CLB.
const talkPost = ok(await C.api('POST', '/clubs/mine/posts', { body: 'Chủ nhật chạy 15 km nhé!' })).id;
const dComment = ok(await D.api('POST', `/posts/${talkPost}/comments`, { body: 'Mấy giờ vậy?' })).id;
ok(await C.api('POST', `/posts/${talkPost}/comments`, { body: '5h ở Tháp Rùa', reply_to: dComment }));
const thread = ok(await D.api('GET', `/posts/${talkPost}/comments`));
assert.equal(thread.length, 2);
assert.equal(thread[1].reply_to, dComment);
assert.equal(thread[1].reply_to_name, 'Runner D');
assert.deepEqual(ok(await D.api('POST', `/posts/${talkPost}/like`)), { liked: true, count: 1 });
const feedPost = ok(await D.api('GET', '/clubs/mine/posts')).find((p: { id: string }) => p.id === talkPost);
assert.equal(Number(feedPost.like_count), 1);
assert.equal(Number(feedPost.comment_count), 2);
assert.equal((await A.api('POST', `/posts/${talkPost}/comments`, { body: 'Người ngoài' })).data.error, 'post_not_found');
assert.equal((await D.api('DELETE', `/comments/${thread[1].id}`)).data.error, 'not_allowed');
ok(await C.api('DELETE', `/comments/${dComment}`));
const afterDelete = ok(await C.api('GET', `/posts/${talkPost}/comments`));
assert.equal(afterDelete.length, 1);
assert.equal(afterDelete[0].reply_to, null, 'bình luận trả lời còn lại khi gốc bị xoá');
assert.deepEqual(ok(await D.api('POST', `/posts/${talkPost}/like`)), { liked: false, count: 0 });
step('bảng tin: bình luận, trả lời đúng người, cổ vũ; người ngoài không bình luận được');

// ---------------------------------------------------------------------------
// Công cụ giả lập: đều ghi vào DB
// ---------------------------------------------------------------------------

// A còn giữ các ô của vòng khép kín ở phía tây Hồ Tây: đặt đối thủ demo ngay đó.
const wide = '/territory?min_lat=21.0&min_lng=105.78&max_lat=21.1&max_lng=105.88';
const cellsOf = (rows: { id: string; owner_id: string }[], owner: string) =>
  rows.filter((c) => c.owner_id === owner).map((c) => c.id).sort();
const mineBefore = cellsOf(ok(await A.api('GET', wide)), A.id);
assert.ok(mineBefore.length > 0);
const rivals = ok(await A.api('POST', '/dev/rivals', { lat: 21.0618, lng: 105.8019 }));
assert.equal(rivals.rivals, 5);
assert.ok(rivals.cells > 0);
const around = ok(await A.api('GET', wide));
assert.ok(around.some((c: { owner_name: string }) => c.owner_name === 'Linh Hồ Tây'));
assert.deepEqual(cellsOf(around, A.id), mineBefore, 'đối thủ demo không lấy ô của người thật');
step(`đối thủ demo quanh đây: chiếm ${rivals.cells} ô, không đụng ô của người thật`);

const feedBefore = ok(await A.api('GET', '/feed')).length;
const attack = ok(await A.api('POST', '/dev/rival-attack'));
assert.ok(attack.stolen > 0);
assert.equal(ok(await A.api('GET', '/feed')).length, feedBefore + 1);
step(`đối thủ phản công: cướp ${attack.stolen} ô, hộp thư có thông báo mới`);

assert.equal((await D.api('POST', '/dev/join-applicant')).data.error, 'not_club_admin');
const applicant = ok(await C.api('POST', '/dev/join-applicant'));
const applicants = ok(await C.api('GET', '/clubs/mine/join-requests'));
assert.ok(applicants.some((a: { display_name: string }) => a.display_name === applicant.name));
step(`runner giả "${applicant.name}" xin vào CLB, chủ nhiệm thấy đơn`);

history = ok(await C.api('GET', '/runs'));
assert.equal(history.length, 3, 'C chạy 3 buổi (buổi gửi lại không tính)');
assert.ok(history.every((h: { simulated: boolean }) => h.simulated));
step('buổi chạy giả lập được lưu trong lịch sử trên server');

ok(await A.api('POST', '/auth/logout'));
assert.equal((await call(null, 'POST', '/auth/refresh', { refresh_token: A.session.refresh_token })).status, 401);
step('đăng xuất thu hồi refresh token');

console.log('\nTất cả kiểm thử end-to-end đều qua.');
