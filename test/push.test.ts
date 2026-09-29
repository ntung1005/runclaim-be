// Chạy: npm test
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPush } from '../src/push.ts';

test('không đặt service account thì tắt thông báo', () => {
  assert.equal(createPush(undefined), null);
});

test('ký JWT, gửi FCM tới từng thiết bị, xoá token đã chết', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const push = createPush(JSON.stringify({
    project_id: 'demo',
    client_email: 'bot@demo.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }))!;

  const deleted: string[] = [];
  const admin = {
    from: () => ({
      select: () => ({ in: async () => ({ data: [{ token: 'alive' }, { token: 'dead' }], error: null }) }),
      delete: () => ({ eq: async (_: string, token: string) => { deleted.push(token); return { error: null }; } }),
    }),
  } as unknown as SupabaseClient;

  const sent: { token: string; title: string; data: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://oauth2.googleapis.com')) {
      const jwt = new URLSearchParams(init.body as string).get('assertion')!;
      const [h, p, s] = jwt.split('.');
      assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
      assert.equal(JSON.parse(Buffer.from(p, 'base64url').toString()).iss, 'bot@demo.iam.gserviceaccount.com');
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    assert.equal(url, 'https://fcm.googleapis.com/v1/projects/demo/messages:send');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer tok');
    const { message } = JSON.parse(init.body as string);
    sent.push({ token: message.token, title: message.notification.title, data: message.data });
    return message.token === 'dead'
      ? new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 })
      : new Response('{}');
  }) as typeof fetch;
  try {
    await push.send(admin, ['u1'], { title: 'Bị cướp!', body: '...', data: { type: 'stolen' } });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(sent.map((m) => m.token).sort(), ['alive', 'dead']);
  assert.equal(sent[0].title, 'Bị cướp!');
  assert.equal(sent[0].data.type, 'stolen');
  assert.deepEqual(deleted, ['dead']);
});
