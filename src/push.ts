// Thông báo đẩy qua Firebase Cloud Messaging (HTTP v1). Không cần thư viện:
// tự ký JWT của service account bằng node:crypto để lấy access token.
// Không đặt FCM_SERVICE_ACCOUNT thì mọi lệnh gửi bị bỏ qua.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HexGrid } from './game/hex_grid.ts';
import { GAME } from './game/config.ts';

export interface PushMessage {
  title: string;
  body: string;
  /** Dữ liệu kèm theo cho app (FCM chỉ nhận chuỗi). */
  data?: Record<string, string>;
}

export interface Push {
  /** Gửi tới mọi thiết bị của [userIds]. Không bao giờ ném lỗi: thông báo hỏng không được làm hỏng buổi chạy. */
  send(admin: SupabaseClient, userIds: string[], message: PushMessage): Promise<void>;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** [config]: nội dung JSON của service account, hoặc đường dẫn tới file JSON đó. */
export function createPush(config: string | undefined): Push | null {
  if (!config) return null;
  const account = JSON.parse(config.trim().startsWith('{') ? config : readFileSync(config, 'utf8')) as ServiceAccount;
  let cached: { token: string; exp: number } | null = null;

  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - 60 > now) return cached.token;
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${b64url(signature)}`,
      }),
    });
    if (!res.ok) throw new Error(`Lấy token FCM lỗi ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, exp: now + json.expires_in };
    return json.access_token;
  }

  return {
    async send(admin, userIds, message) {
      try {
        if (userIds.length === 0) return;
        const { data, error } = await admin.from('device_tokens').select('token').in('user_id', userIds);
        if (error) throw error;
        if (data.length === 0) return;
        const token = await accessToken();
        await Promise.all(data.map(async ({ token: device }) => {
          const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: {
                token: device,
                notification: { title: message.title, body: message.body },
                data: message.data ?? {},
                android: { priority: 'high' },
              },
            }),
          });
          // Token hết hạn, gỡ app: xoá để lần sau khỏi gửi.
          if (res.status === 404 || res.status === 400) {
            const text = await res.text();
            if (res.status === 404 || text.includes('UNREGISTERED') || text.includes('registration token')) {
              await admin.from('device_tokens').delete().eq('token', device);
            }
          } else if (!res.ok) {
            console.error('Gửi FCM lỗi', res.status, await res.text());
          }
        }));
      } catch (e) {
        console.error('Gửi thông báo lỗi', e);
      }
    },
  };
}

const grid = new HexGrid(GAME.hexSizeMeters);

/** Báo cho những người vừa bị buổi chạy [activityId] cướp ô. */
export async function notifyStolen(admin: SupabaseClient, push: Push | null, activityId: string, thiefId: string) {
  if (!push) return;
  try {
    const [events, thief] = await Promise.all([
      admin.from('cell_events').select('cell_id, previous_owner').eq('activity_id', activityId).not('previous_owner', 'is', null),
      admin.from('profiles').select('display_name').eq('id', thiefId).maybeSingle(),
    ]);
    if (events.error) throw events.error;
    const byOwner = new Map<string, string[]>();
    for (const e of events.data) {
      const owner = e.previous_owner as string;
      if (owner === thiefId) continue;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), e.cell_id as string]);
    }
    const name = thief.data?.display_name ?? 'Một runner';
    await Promise.all([...byOwner].map(([owner, cells]) => {
      const at = grid.center(cells[0]);
      return push.send(admin, [owner], {
        title: `${name} vừa cướp ${cells.length} ô của bạn!`,
        body: 'Chạy lại qua vùng đó nhiều hơn để giành lại. Phản công ngay!',
        data: { type: 'stolen', lat: String(at.lat), lng: String(at.lng) },
      });
    }));
  } catch (e) {
    console.error('Thông báo bị cướp lỗi', e);
  }
}
