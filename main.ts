/**
 * VK Play payment backend for Deno Deploy (workers.dev is blocked in RU,
 * deno.dev works).
 *
 *   POST /create-payment  { productId, uid } -> { url, merchantParam }
 *   GET  /callback        VK Play -> partner, answer {"status":"ok"}
 *
 * Environment variables (Deno Deploy -> Project -> Settings -> Environment Variables):
 *   VKPLAY_SECRET   — "Секрет для API игр" from the VK Play dashboard
 *   VKPLAY_GMRID    — 52062
 *   ALLOWED_ORIGIN  — https://vadim2451782.github.io
 *
 * KV: Deno.openKv() is built in, no setup needed.
 */

const PRODUCTS: Record<string, { coins: number; price: number; title: string }> = {
  coins_100: { coins: 100, price: 49, title: '100 монет' },
  coins_500: { coins: 500, price: 199, title: '500 монет' },
  coins_1200: { coins: 1200, price: 449, title: '1200 монет' },
};

// Deno KV is available on Deno Deploy; locally it needs --unstable-kv, so fall
// back to an in-memory map instead of failing to boot.
let kv: { get(key: string[]): Promise<{ value: unknown }>; set(key: string[], value: unknown): Promise<unknown> } | null = null;
try {
  kv = await Deno.openKv();
} catch {
  console.warn('Deno KV unavailable, using in-memory store (dedup only within one instance)');
}
const memory = new Map<string, unknown>();

async function readTid(tid: string): Promise<boolean> {
  const key = ['tid', tid];
  if (kv) return Boolean((await kv.get(key)).value);
  return memory.has(key.join(':'));
}

async function writeTid(tid: string, record: unknown): Promise<void> {
  const key = ['tid', tid];
  if (kv) {
    await kv.set(key, record);
    return;
  }
  memory.set(key.join(':'), record);
}

/* ------------------------------------------------------------------ md5 */

function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bits = len * 8;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 8, bits >>> 0, true);
  view.setUint32(withPad.length - 4, Math.floor(bits / 0x100000000), true);

  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < withPad.length; offset += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i += 1) M[i] = view.getUint32(offset + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i += 1) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const hex = (n: number) => n.toString(16).padStart(8, '0').match(/../g)!.reverse().join('');
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/* --------------------------------------------------------------- helpers */

const SECRET = Deno.env.get('VKPLAY_SECRET') || '';
const GMRID = Deno.env.get('VKPLAY_GMRID') || '52062';
const ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';

function sign(params: Record<string, string>): string {
  const keys = Object.keys(params).filter((key) => key !== 'sign').sort();
  return md5(keys.map((key) => `${key}=${params[key]}`).join('') + SECRET);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
    },
  });
}

/* ---------------------------------------------------------------- routes */

Deno.serve(async (request) => {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': ORIGIN,
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      },
    });
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, secret: SECRET ? 'set' : 'missing', gmrid: GMRID });
  }

  if (request.method === 'POST' && url.pathname === '/create-payment') {
    const body = await request.json().catch(() => ({}));
    const product = PRODUCTS[body.productId];
    const uid = Number(body.uid);
    if (!product) return json({ error: 'unknown_product' }, 400);
    if (!Number.isFinite(uid) || uid <= 0) return json({ error: 'no_uid' }, 400);

    const merchantParam = {
      uid,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0',
      amount: product.price,
      currency: 'RUB',
      item_id: body.productId,
      description: product.title.slice(0, 50),
    };
    const merchantJson = JSON.stringify(merchantParam);
    const signature = sign({ merchant_param: merchantJson });
    const form = new URLSearchParams({ merchant_param: merchantJson });
    const response = await fetch(
      `https://vkplay.ru/app/${GMRID}/billing/client?sign=${signature}`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form },
    );
    const data = await response.json().catch(() => ({}));
    if (!data.url) return json({ error: data.errmsg || 'billing_error' }, 502);
    return json({ url: data.url, merchantParam });
  }

  if (request.method === 'GET' && url.pathname === '/callback') {
    const params = {
      uid: url.searchParams.get('uid') || '',
      sum: url.searchParams.get('sum') || '',
      tid: url.searchParams.get('tid') || '',
      merchant_param: url.searchParams.get('merchant_param') || '{}',
    };
    if (sign(params) !== (url.searchParams.get('sign') || '')) {
      return json({ status: 'error', errcode: 1, errmsg: 'bad sign' });
    }

    let product = null;
    try {
      product = PRODUCTS[JSON.parse(params.merchant_param).item_id] || null;
    } catch {
      product = null;
    }
    if (!product || Number(params.sum) !== product.price) {
      return json({ status: 'error', errcode: 2, errmsg: 'bad sum' });
    }

    if (await readTid(params.tid)) return json({ status: 'ok' });
    await writeTid(params.tid, { uid: params.uid, sum: params.sum, merchant: params.merchant_param, at: Date.now() });
    return json({ status: 'ok' });
  }

  return json({ error: 'not_found' }, 404);
});
