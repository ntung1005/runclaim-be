# RunClaim BE

API server cho app [RunClaim](../runclaim_app). App chỉ gọi server này; server giữ secret key và làm mọi việc với Supabase (Auth, Postgres, PostGIS).

- Node 22.18 trở lên, TypeScript chạy thẳng bằng Node (type stripping, không cần build).
- [Express 5](https://expressjs.com), `@supabase/supabase-js`.
- Supabase local qua Supabase CLI (cần Docker).

## Chạy nhanh

```bash
cd runclaim_be
npm install
npm run db:start                 # Supabase local: Postgres, Auth, REST (lần đầu tải image Docker)
cp .env.example .env             # rồi điền 2 key lấy từ: npm run db:env (PUBLISHABLE_KEY, SECRET_KEY)
npm run dev                      # http://localhost:8787, tự khởi động lại khi sửa code
```

Kiểm tra: `curl localhost:8787/health` trả `{"ok":true}`.

Đổi schema: thêm file vào `supabase/migrations/` rồi `npx supabase migration up` (giữ dữ liệu) hoặc `npm run db:reset` (xoá sạch, nạp lại `supabase/seed.sql`).

## Biến môi trường (`.env`)

| Biến | Ý nghĩa |
|---|---|
| `SUPABASE_URL` | `http://127.0.0.1:54321` khi chạy local |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...`: đăng nhập, gọi RPC thay mặt người dùng |
| `SUPABASE_SECRET_KEY` | `sb_secret_...`: chỉ server giữ. Dùng cho `apply_activity`, tạo tài khoản, công cụ giả lập |
| `PORT` | Mặc định 8787 |
| `ENABLE_DEV_TOOLS` | `true` để bật `/dev/*`. **Không bật trên production** |
| `CORS_ORIGIN` | Origin được gọi từ trình duyệt (Flutter web). `*` khi phát triển |
| `AUTH_MAX_ATTEMPTS` | Số lần đăng nhập / đăng ký mỗi 5 phút cho một IP. Mặc định 10, để cao khi chạy e2e nhiều lần |
| `FCM_SERVICE_ACCOUNT` | Đường dẫn file JSON service account Firebase để gửi thông báo đẩy. Để trống: tắt thông báo |

## Tài khoản

Đăng nhập bằng **tên đăng nhập + mật khẩu**. Supabase Auth cần email nên server đổi tên đăng nhập thành email nội bộ `<tên>@users.chiemphuong.vn` (không gửi thư, không cần xác nhận). Người dùng không thấy email này.

- Tên đăng nhập: 3-20 ký tự `a-z 0-9 _`, không phân biệt hoa thường.
- Mật khẩu: 6-72 ký tự.
- Đăng nhập ẩn danh đã tắt (`supabase/config.toml`).
- Token là JWT của Supabase. Server kiểm tra chữ ký bằng `auth.getClaims` rồi gọi Supabase **bằng chính token đó**, nên RLS và `auth.uid()` trong các hàm SQL vẫn áp dụng như trước.

## API

Mọi route trừ `/health` và `/auth/{register,login,refresh}` cần `Authorization: Bearer <access_token>`. Lỗi trả về `{"error": "<mã>"}`, ví dụ `invalid_credentials`, `username_taken`, `club_not_found`, `not_club_admin`, `campaign_active`.

| Nhóm | Route |
|---|---|
| Tài khoản | `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` |
| Hồ sơ, cài đặt | `GET /me` (tài khoản, hồ sơ, cài đặt) · `PUT /me/profile` · `PATCH /me/settings` (gộp theo khoá) · `GET /me/standing` |
| Buổi chạy | `POST /runs` (điểm GPS thô, gửi lại cùng id là an toàn) · `GET /runs` (lịch sử của mình) |
| Lãnh thổ, xếp hạng | `GET /territory?min_lat&min_lng&max_lat&max_lng` · `GET /leaderboard` · `GET /feed` (bị cướp đất) |
| CLB | `GET/POST /clubs` · `GET /clubs/by-code/:code` · `POST /clubs/join` · `GET/DELETE /clubs/join-request` · `POST /clubs/leave` · `GET/PATCH /clubs/mine` · `GET /clubs/:id/members` · `GET /clubs/:id/territory` |
| Quản lý CLB | `GET /clubs/mine/join-requests` · `POST .../:id/approve` · `POST .../:id/reject` · `DELETE /clubs/mine/members/:userId` · `PUT /clubs/mine/members/:userId/role` |
| Bảng tin | `GET/POST /clubs/mine/posts` · `DELETE /posts/:id` · `GET/POST /posts/:id/comments` · `POST /posts/:id/like` · `DELETE /comments/:id` |
| Họp mặt, chiến dịch | `GET/POST /clubs/mine/meetups` · `POST /meetups/:id/rsvp` · `DELETE /meetups/:id` · `GET/POST /clubs/mine/campaigns` · `POST /campaigns/:id/cancel` |
| Game hằng ngày | `GET /game/today` (xu, rương đã mở, 3 nhiệm vụ hôm nay, giá khiên) · `POST /game/quests/:key/claim` · `POST /game/shield` (100 xu: khiên 24 giờ cho vùng liền nhau chứa ô) |
| Thông báo đẩy | `POST /me/devices` · `DELETE /me/devices` (token FCM). Server báo khi bị cướp ô nếu đặt `FCM_SERVICE_ACCOUNT` |
| Giả lập (`ENABLE_DEV_TOOLS`) | `POST /dev/rivals` · `POST /dev/rival-attack` · `POST /dev/join-applicant` · `POST /dev/coins` (+200 xu) · `POST /dev/shield-attack` (đối thủ thử phá khiên) |

### Công cụ giả lập

Đều ghi vào DB qua đúng đường của người chơi thật:

- `/dev/rivals {lat, lng}`: tạo 5 đối thủ demo (cùng id với `seed.sql`) nếu chưa có, mỗi người chiếm 25-75 ô quanh điểm đó bằng `apply_activity`. Không lấy ô của người thật.
- `/dev/rival-attack`: một đối thủ demo cướp một cụm ô của mình. Có `cell_events` nên hộp thư (`/feed`) hiện thông báo.
- `/dev/join-applicant`: tạo một runner giả xin vào CLB mình quản lý.
- Buổi chạy GPS giả lập và "Tạo lịch sử chạy mẫu" trên app đi qua `POST /runs` như buổi chạy thật, có cờ `simulated`.

## Cơ sở dữ liệu ([supabase/migrations](supabase/migrations))

| Bảng | Nội dung |
|---|---|
| `profiles` | Tên, CLB, vai trò trong CLB, màu. Liên kết với `auth.users` |
| `user_settings` | Cài đặt jsonb: chỉ số cá nhân, giả lập, kiểu bản đồ, lần đọc hộp thư |
| `clubs`, `wards` | CLB và phường (hiện là tâm phường demo) |
| `activities` | Buổi chạy: số liệu server tính, điểm GPS thô, `cell_ids`, `splits`, `simulated` |
| `cells`, `cell_events` | Ô lãnh thổ và lịch sử chiếm, cướp |
| `club_*` | Đơn xin vào, bảng tin, bình luận, cổ vũ, họp mặt, chiến dịch |

Nguyên tắc giữ nguyên từ trước:
- **Không tin app.** App gửi điểm GPS thô; server tự lọc, tính quãng đường, chống gian lận, tính ô ([src/game](src/game)).
- **Không ghi thẳng.** RLS chặn ghi `cells`, `activities`, `cell_events`. `apply_activity` chỉ service_role gọi được.
- **Gửi lại an toàn.** Buổi chạy có id do app sinh; gửi lại trả kết quả cũ.

## Kiểm thử

```bash
npm run typecheck
npm test          # logic: lưới ô, lọc GPS, vòng khép kín (dùng chung bộ vector với test của app)
npm run db:reset && npm run e2e   # cần DB sạch (ô Hồ Gươm do lần chạy e2e trước giữ thì A mới không cướp được) và npm run dev
```

Lưới ô và bộ lọc GPS có hai bản: TypeScript ở [src/game](src/game) và Dart ở app (`lib/core/hex_grid.dart`, `lib/core/loops.dart`, `lib/features/run/track_filter.dart`). App dùng bản Dart để hiện số liệu tạm thời khi đang chạy; số liệu chính thức luôn do server tính.

## Cấu trúc

```
src/
  server.ts            khởi động HTTP server (chạy trên máy, VPS…)
  app.ts               gắn middleware (CORS, JSON, xác thực), router, xử lý lỗi; điểm vào Vercel
  env.ts, supabase.ts  cấu hình, client Supabase (admin / theo người dùng)
  auth.ts              đăng ký, đăng nhập, làm mới token, middleware xác thực
  http.ts              lỗi API, đổi lỗi SQL thành mã lỗi, đọc tham số
  routes/              Express Router: me, runs, world (lãnh thổ, xếp hạng, hộp thư), clubs, game, dev
  game/                xử lý buổi chạy: hex_grid, loops, process_activity, submit_run
supabase/              config.toml, migrations, seed.sql
scripts/generate_seed.ts   sinh seed.sql (npm run seed)
test/                  unit test và e2e
```

## Deploy

1. Supabase thật: `npx supabase link --project-ref <ref>` rồi `npx supabase db push`. Tắt Anonymous sign-ins. Chỉ nạp phần CLB và phường trong `seed.sql`.
2. Chạy server ở bất kỳ nơi nào có Node 22 (Fly.io, Render, VPS…): `npm ci --omit=dev && node src/server.ts` với biến môi trường như trên, `ENABLE_DEV_TOOLS=false`, `CORS_ORIGIN` là domain web thật.
   Hoặc Vercel: import repo, Vercel tự nhận `src/app.ts`; đặt biến môi trường trong Project Settings rồi Redeploy.
3. Build app với `API_URL` trỏ tới server này.

Lưu ý khi lên production: mọi request đăng nhập tới Supabase Auth đều từ IP của server, nên giới hạn `sign_in_sign_ups` theo IP của Supabase áp dụng chung cho mọi người dùng. Cần nâng giới hạn đó trong Auth settings (server đã tự giới hạn theo IP + tên đăng nhập bằng `AUTH_MAX_ATTEMPTS`).
