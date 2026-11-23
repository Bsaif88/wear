import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = +env.PORT || 3000;
const DATA = env.DATA_DIR || '/data';
const KEY = env.ANTHROPIC_API_KEY || '';
const API = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const MODEL = env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const PASS = env.APP_PASSCODE || '';
const PLACE = {
  name: env.PLACE_NAME || 'Safwa',
  lat: +env.PLACE_LAT || 26.65,
  lon: +env.PLACE_LON || 49.96,
  tz: env.PLACE_TZ || 'Asia/Riyadh',
};
const WHO = env.STYLE_FOR || "men's";
const ALLOW_PRIVATE = env.ALLOW_PRIVATE_FETCH === '1'; // tests only
const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const FASHN = (env.FASHN_API_KEY || '').trim();
const FASHN_BASE = (env.FASHN_BASE_URL || 'https://api.fashn.ai').replace(/\/$/, '');
const TRY_MODE = ['fast', 'balanced', 'quality'].includes(env.TRYON_MODE) ? env.TRYON_MODE : 'balanced';
const TRY_DAILY = +env.TRYON_DAILY_STEPS || 40;
const CATS = ['top', 'bottom', 'outer', 'shoes', 'full', 'accessory'];

/* ---------- storage ---------- */
let db = { items: [], trends: null };
async function load() {
  await fs.mkdir(path.join(DATA, 'img'), { recursive: true });
  try {
    db = JSON.parse(await fs.readFile(path.join(DATA, 'db.json'), 'utf8'));
  } catch {}
  db.items ||= [];
  for (const it of db.items) {
    if (it.status === 'analyzing' || it.status === 'finding') {
      it.status = 'error';
      it.error = 'Interrupted. Tap "Find photo" to retry.';
    }
  }
}
let saving = Promise.resolve();
function save() {
  saving = saving
    .then(async () => {
      const f = path.join(DATA, 'db.json');
      await fs.writeFile(f + '.tmp', JSON.stringify(db));
      await fs.rename(f + '.tmp', f);
    })
    .catch((e) => console.error('save failed', e));
  return saving;
}

/* ---------- auth ---------- */
const token = PASS ? crypto.createHmac('sha256', PASS).update('wear-v1').digest('hex') : '';
function authed(req) {
  if (!token) return false;
  const c = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith('sid='));
  if (!c) return false;
  const v = Buffer.from(c.slice(4));
  const t = Buffer.from(token);
  return v.length === t.length && crypto.timingSafeEqual(v, t);
}
const tries = new Map();
function limited(ip) {
  const now = Date.now();
  const r = tries.get(ip) || { n: 0, t: now };
  if (now - r.t > 60_000) {
    r.n = 0;
    r.t = now;
  }
  r.n++;
  tries.set(ip, r);
  return r.n > 6;
}
function requireAuth(req, res, next) {
  if (authed(req)) return next();
  res.status(401).json({ error: 'Sign in required' });
}

/* ---------- claude ---------- */
async function claude({ system, content, tools, max_tokens = 1500 }) {
  if (!KEY) throw new Error('ANTHROPIC_API_KEY is not set on the server');
  let messages = [{ role: 'user', content }];
  for (let i = 0; i < 5; i++) {
    const r = await fetch(API + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens, system, messages, ...(tools ? { tools } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    if (j.stop_reason === 'pause_turn') {
      messages = [...messages, { role: 'assistant', content: j.content }];
      continue;
    }
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  throw new Error('Claude did not finish');
}
function parseJson(t) {
  const m = /\{[\s\S]*\}/.exec(t || '');
  if (!m) throw new Error('No JSON in reply');
  return JSON.parse(m[0]);
}
const today = () =>
  new Date().toLocaleDateString('en-GB', { timeZone: PLACE.tz, day: 'numeric', month: 'long', year: 'numeric' });

/* ---------- safe fetching of third-party pages/images ---------- */
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}
async function assertPublic(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:' && !(ALLOW_PRIVATE && url.protocol === 'http:')) throw new Error('https only');
  if (ALLOW_PRIVATE) return url;
  const addrs = await dns.lookup(url.hostname, { all: true });
  for (const a of addrs) if (isPrivate(a.address)) throw new Error('blocked address');
  return url;
}
async function fetchSafe(u, { accept = '*/*', max = 3_000_000 } = {}) {
  let cur = u;
  for (let i = 0; i < 5; i++) {
    const url = await assertPublic(cur);
    const r = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': UA, accept, 'accept-language': 'en' },
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      cur = new URL(r.headers.get('location'), url).href;
      continue;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    const chunks = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.length;
      if (n > max) throw new Error('too big');
      chunks.push(c);
    }
    return { buf: Buffer.concat(chunks), url: cur };
  }
  throw new Error('too many redirects');
}
function sniff(buf) {
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function pickImages(html, base) {
  const out = [];
  for (const m of html.match(/<meta[^>]+>/gi) || []) {
    const p = /(?:property|name)=["'](og:image(?::secure_url)?|twitter:image(?::src)?)["']/i.exec(m);
    const c = /content=["']([^"']+)["']/i.exec(m);
    if (p && c) out.push(c[1].replace(/&amp;/g, '&'));
  }
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'image') {
        const vs = Array.isArray(v) ? v : [v];
        for (const x of vs) {
          if (typeof x === 'string') out.push(x);
          else if (x && typeof x.url === 'string') out.push(x.url);
        }
      } else walk(v);
    }
  };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1])); } catch {}
  }
  const abs = [];
  for (const s of out) {
    try { abs.push(new URL(s, base).href); } catch {}
  }
  return [...new Set(abs)].slice(0, 6);
}

/* ---------- item pipeline ---------- */
const imgFile = (id, kind, ext) => `${id}-${kind}.${ext}`;
const queue = [];
let running = 0;
function enqueue(fn) {
  queue.push(fn);
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const fn = queue.shift();
    running++;
    fn().catch((e) => console.error('job', e)).finally(() => { running--; pump(); });
  }
}

async function analyze(it) {
  const file = path.join(DATA, 'img', it.own.split('/').pop());
  const buf = await fs.readFile(file);
  const media = sniff(buf) === 'png' ? 'image/png' : sniff(buf) === 'webp' ? 'image/webp' : 'image/jpeg';
  const text = await claude({
    system: `You catalogue a ${WHO} wardrobe from phone photos. Be precise and honest: only name a brand or model when a logo, label, or distinctive design makes it genuinely identifiable.`,
    content: [
      { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } },
      {
        type: 'text',
        text: `Describe the single clothing item in this photo. Reply with ONLY JSON:
{"name":"short natural name e.g. 'Navy slim-fit oxford shirt'","category":"top|bottom|outer|shoes|full|accessory (full = thobe or one-piece)","colors":["main colour first"],"pattern":"solid|striped|checked|...","fabric":"best guess","brand":"string or null","modelName":"string or null","warmth":1-5 (1 = very light, 5 = heavy),"formality":1-5 (1 = sporty, 5 = formal),"searchQuery":"what to type into a shop search to find this exact product","exactConfidence":0-1 (how likely the exact product can be identified)}`,
      },
    ],
    max_tokens: 700,
  });
  const a = parseJson(text);
  a.category = CATS.includes(a.category) ? a.category : 'top';
  a.colors = Array.isArray(a.colors) && a.colors.length ? a.colors.map(String).slice(0, 4) : ['unknown'];
  a.warmth = Math.min(5, Math.max(1, Math.round(+a.warmth || 3)));
  a.formality = Math.min(5, Math.max(1, Math.round(+a.formality || 3)));
  a.name = String(a.name || 'Clothing item').slice(0, 80);
  return a;
}

async function findPhoto(it) {
  const a = it.analysis;
  const desc = [a.brand, a.modelName, a.name, a.colors.join('/'), a.pattern, a.fabric].filter(Boolean).join(', ');
  const text = await claude({
    system: 'You find official product pages. Use web search. Never invent URLs: only return pages you actually found.',
    content: `Today is ${today()}. Find the product page (brand website or a reputable retailer) for this item so I can use its official studio photo.
Item described from my own photo: ${desc}
Search hint: ${a.searchQuery || a.name}
If the brand is not identifiable, find the closest visually matching specific product and mark it "similar".
Reply with ONLY JSON: {"matchType":"exact"|"similar","candidates":[{"url":"https://...","title":"..."}]}
Up to 4 individual product pages (not search or category pages), best first. Use "exact" only if brand AND model/style clearly match.`,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
    max_tokens: 1500,
  });
  const r = parseJson(text);
  const cands = (r.candidates || []).filter((c) => c && typeof c.url === 'string').slice(0, 4);
  for (const c of cands) {
    try {
      const page = await fetchSafe(c.url, { accept: 'text/html', max: 2_500_000 });
      const imgs = pickImages(page.buf.toString('utf8'), page.url);
      for (const src of imgs) {
        try {
          const im = await fetchSafe(src, { accept: 'image/*', max: 6_000_000 });
          const ext = sniff(im.buf);
          if (!ext || im.buf.length < 8000) continue;
          const name = imgFile(it.id, 'cat', ext);
          await fs.writeFile(path.join(DATA, 'img', name), im.buf);
          return {
            img: '/img/' + name,
            url: c.url,
            title: String(c.title || '').slice(0, 120),
            matchType: r.matchType === 'exact' ? 'exact' : 'similar',
            host: new URL(c.url).hostname.replace(/^www\./, ''),
          };
        } catch {}
      }
    } catch {}
  }
  return null;
}

async function runItem(id, { skipAnalyze = false } = {}) {
  const it = db.items.find((x) => x.id === id);
  if (!it) return;
  try {
    if (!skipAnalyze || !it.analysis) {
      it.status = 'analyzing';
      it.error = null;
      await save();
      it.analysis = await analyze(it);
      it.name = it.analysis.name;
      it.category = it.analysis.category;
    }
    it.status = 'finding';
    await save();
    let cat = null;
    try {
      cat = await findPhoto(it);
    } catch (e) {
      console.error('findPhoto', e.message);
      it.error = 'Could not search for an official photo.';
    }
    it.catalog = cat;
    if (cat && cat.matchType === 'exact') it.usePhoto = 'catalog';
    else if (!cat && !it.error) it.error = 'No official photo found. Using your photo.';
    it.status = 'ready';
  } catch (e) {
    console.error("runItem", e.message);
    it.status = 'error';
    it.error = /ANTHROPIC_API_KEY/.test(e.message) ? e.message : 'Could not analyse this photo. Tap "Find photo" to retry.';
  }
  await save();
}

const shape = (it) => ({
  id: it.id,
  name: it.name || 'Analysing…',
  category: it.category || 'top',
  colors: it.analysis?.colors || [],
  brand: it.analysis?.brand || null,
  warmth: it.analysis?.warmth || 3,
  formality: it.analysis?.formality || 3,
  status: it.status,
  error: it.error || null,
  own: it.own,
  catalog: it.catalog || null,
  cutout: it.cutout || null,
  usePhoto: it.usePhoto === 'catalog' && it.catalog ? 'catalog' : it.usePhoto === 'cutout' && it.cutout ? 'cutout' : 'own',
  lastWorn: it.lastWorn || null,
  created: it.created,
});

/* ---------- trends & weather ---------- */
let trendsBusy = null;
async function refreshTrends() {
  if (trendsBusy) return trendsBusy;
  trendsBusy = (async () => {
    const text = await claude({
      system: 'You are a fashion trend analyst. Use web search and report only what you actually found.',
      content: `Today is ${today()}. Search the web for the latest ${WHO} fashion trends right now (current season). The wearer lives in ${PLACE.name}, Saudi Arabia: very hot and humid most of the year, air-conditioned interiors, smart-casual and modest dress norms, thobes for formal and social occasions.
Reply with ONLY JSON: {"summary":"2 sentences","trends":[{"name":"short trend name","note":"how to wear it in a hot climate, one sentence"}],"colors":["trending colours"],"avoid":["what looks dated now"]}
Give 5 to 7 trends.`,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      max_tokens: 1800,
    });
    const t = parseJson(text);
    t.updated = new Date().toISOString();
    db.trends = t;
    await save();
    return t;
  })().finally(() => { trendsBusy = null; });
  return trendsBusy;
}

let wCache = { t: 0, v: null };
async function getWeather() {
  if (Date.now() - wCache.t < 20 * 60_000 && wCache.v) return wCache.v;
  const u =
    `https://api.open-meteo.com/v1/forecast?latitude=${PLACE.lat}&longitude=${PLACE.lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=${encodeURIComponent(PLACE.tz)}&forecast_days=1`;
  const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error('weather ' + r.status);
  const j = await r.json();
  const v = {
    place: PLACE.name,
    temp: Math.round(j.current.temperature_2m),
    feels: Math.round(j.current.apparent_temperature),
    humidity: Math.round(j.current.relative_humidity_2m),
    wind: Math.round(j.current.wind_speed_10m),
    high: Math.round(j.daily.temperature_2m_max[0]),
    low: Math.round(j.daily.temperature_2m_min[0]),
    rain: j.daily.precipitation_probability_max[0] ?? 0,
    code: j.current.weather_code,
  };
  wCache = { t: Date.now(), v };
  return v;
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));

app.get('/api/me', (req, res) =>
  res.json({ authed: authed(req), setup: { passcode: !!PASS, key: !!KEY, tryon: !!FASHN }, place: PLACE.name }),
);
app.post('/api/login', (req, res) => {
  if (!PASS) return res.status(503).json({ error: 'Server needs APP_PASSCODE set in Coolify.' });
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  const given = crypto.createHmac('sha256', PASS).update('wear-v1').digest('hex');
  const sent = crypto.createHmac('sha256', String(req.body?.code || '')).update('wear-v1').digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(sent))) return res.status(401).json({ error: 'Wrong passcode' });
  res.setHeader('Set-Cookie', `sid=${token}; Max-Age=15552000; Path=/; HttpOnly; Secure; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/img/:file', requireAuth, (req, res) => {
  if (!/^[a-z0-9-]+\.(jpg|png|webp)$/.test(req.params.file)) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(DATA, 'img', req.params.file), (e) => e && !res.headersSent && res.sendStatus(404));
});

app.use('/api', requireAuth);

app.get('/api/items', (req, res) => res.json(db.items.map(shape).sort((a, b) => b.created - a.created)));

app.post('/api/items', async (req, res) => {
  const m = /^data:image\/(?:jpeg|png|webp);base64,(.+)$/.exec(String(req.body?.image || ''));
  if (!m) return res.status(400).json({ error: 'Send a photo' });
  const buf = Buffer.from(m[1], 'base64');
  const ext = sniff(buf);
  if (!ext) return res.status(400).json({ error: 'Unsupported image' });
  if (db.items.length >= 500) return res.status(400).json({ error: 'Library is full' });
  const id = crypto.randomBytes(6).toString('hex');
  const name = imgFile(id, 'own', ext);
  await fs.writeFile(path.join(DATA, 'img', name), buf);
  const it = { id, status: 'analyzing', own: '/img/' + name, created: Date.now() };
  db.items.push(it);
  await save();
  enqueue(() => runItem(id));
  res.status(202).json(shape(it));
});

app.patch('/api/items/:id', async (req, res) => {
  const it = db.items.find((x) => x.id === req.params.id);
  if (!it) return res.sendStatus(404);
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) it.name = b.name.trim().slice(0, 80);
  if (CATS.includes(b.category)) it.category = b.category;
  if (b.usePhoto === 'own' || (b.usePhoto === 'catalog' && it.catalog) || (b.usePhoto === 'cutout' && it.cutout)) it.usePhoto = b.usePhoto;
  await save();
  res.json(shape(it));
});

app.delete('/api/items/:id', async (req, res) => {
  const i = db.items.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.sendStatus(404);
  const [it] = db.items.splice(i, 1);
  for (const p of [it.own, it.catalog?.img, it.cutout]) if (p) fs.unlink(path.join(DATA, 'img', p.split('/').pop())).catch(() => {});
  await save();
  res.json({ ok: true });
});

app.post('/api/items/:id/refind', async (req, res) => {
  const it = db.items.find((x) => x.id === req.params.id);
  if (!it) return res.sendStatus(404);
  if (it.status === 'analyzing' || it.status === 'finding') return res.json(shape(it));
  it.status = it.analysis ? 'finding' : 'analyzing';
  it.error = null;
  await save();
  enqueue(() => runItem(it.id, { skipAnalyze: true }));
  res.json(shape(it));
});

app.get('/api/weather', async (req, res) => {
  try {
    res.json(await getWeather());
  } catch {
    res.json(null);
  }
});

app.get('/api/trends', async (req, res) => {
  try {
    const age = db.trends ? Date.now() - Date.parse(db.trends.updated) : Infinity;
    if (!db.trends || req.query.refresh === '1') return res.json(await refreshTrends());
    if (age > 6 * 86400_000) refreshTrends().catch((e) => console.error('trends', e.message));
    res.json(db.trends);
  } catch (e) {
    console.error('trends', e.message);
    res.json(db.trends || null);
  }
});

app.post('/api/outfits', async (req, res) => {
  const items = db.items.filter((x) => x.status === 'ready' && x.analysis);
  if (items.length < 3) return res.status(400).json({ error: 'Add at least 3 pieces first (a top, a bottom, shoes).' });
  const occasion = ['casual', 'work', 'formal', 'evening'].includes(req.body?.occasion) ? req.body.occasion : 'casual';
  let w = req.body?.weather;
  if (!w || typeof w.temp !== 'number') w = await getWeather().catch(() => null);
  const now = Date.now();
  const lib = items.slice(0, 150).map((x) => ({
    id: x.id,
    name: x.name,
    category: x.category,
    colors: x.analysis.colors,
    pattern: x.analysis.pattern,
    warmth: x.analysis.warmth,
    formality: x.analysis.formality,
    worn_days_ago: x.lastWorn ? Math.floor((now - x.lastWorn) / 86400_000) : null,
  }));
  try {
    const text = await claude({
      system: `You are a sharp personal stylist for a ${WHO} wardrobe in ${PLACE.name}, Saudi Arabia. Only use items from the library, by id.`,
      content: `Today is ${today()}.
Weather: ${w ? `${w.temp}°C (feels ${w.feels}°C), humidity ${w.humidity}%, high ${w.high}°C, rain chance ${w.rain}%` : 'unknown, assume hot and dry'}.
Occasion: ${occasion}.
Current trends: ${db.trends ? JSON.stringify({ trends: db.trends.trends, colors: db.trends.colors, avoid: db.trends.avoid }) : 'not loaded; use general current style knowledge'}.
Library: ${JSON.stringify(lib)}

Make 3 distinct outfits. Rules: one item per slot (top, bottom, shoes, optional outer/accessory), or a 'full' piece (thobe) with shoes and optional accessory. Match warmth to the weather (outer layers rarely needed in heat unless indoors AC or evening). Match formality to the occasion. Harmonise colours (neutrals pair with anything; max 2 strong colours). Avoid items worn in the last 3 days (worn_days_ago < 3) unless nothing else works. Use current trends where they genuinely fit.
Reply with ONLY JSON: {"looks":[{"title":"3-5 words","itemIds":["id",...],"why":"one or two sentences: why it suits today's weather and occasion","trend":"matching trend name or null"}]}`,
      max_tokens: 1500,
    });
    const ids = new Set(items.map((x) => x.id));
    const looks = (parseJson(text).looks || [])
      .map((l) => ({
        title: String(l.title || 'Look').slice(0, 60),
        why: String(l.why || '').slice(0, 300),
        trend: l.trend ? String(l.trend).slice(0, 60) : null,
        itemIds: (l.itemIds || []).filter((i, k, a) => ids.has(i) && a.indexOf(i) === k).slice(0, 6),
      }))
      .filter((l) => l.itemIds.length >= 2)
      .slice(0, 3);
    if (!looks.length) throw new Error('No usable looks');
    res.json({ looks, weather: w });
  } catch (e) {
    console.error('outfits', e.message);
    res.status(502).json({ error: /ANTHROPIC_API_KEY/.test(e.message) ? e.message : 'Could not style you right now. Try again.' });
  }
});

/* ---------- virtual try-on (FASHN, the provider OpenTryOn wraps) ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toUri = (buf) => `data:image/${sniff(buf) === 'jpg' ? 'jpeg' : sniff(buf)};base64,${buf.toString('base64')}`;
const readImg = (p) => fs.readFile(path.join(DATA, 'img', p.split('/').pop()));
async function fashn(model_name, inputs, waitMs = 240_000) {
  if (!FASHN) throw new Error('FASHN_API_KEY is not set on the server');
  const h = { authorization: 'Bearer ' + FASHN, 'content-type': 'application/json' };
  const r = await fetch(FASHN_BASE + '/v1/run', { method: 'POST', headers: h, body: JSON.stringify({ model_name, inputs }), signal: AbortSignal.timeout(60_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error(`FASHN ${r.status}: ${String(d.message || d.error?.message || JSON.stringify(d.error || d)).slice(0, 200)}`);
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(1500);
    const s = await fetch(`${FASHN_BASE}/v1/status/${d.id}`, { headers: h, signal: AbortSignal.timeout(30_000) });
    const j = await s.json().catch(() => ({}));
    if (j.status === 'completed') {
      const out = (j.output || [])[0];
      if (!out) throw new Error('FASHN returned no image');
      return out;
    }
    if (['failed', 'canceled', 'cancelled', 'time_out'].includes(j.status))
      throw new Error('FASHN ' + j.status + ': ' + String(j.error?.message || j.error?.name || '').slice(0, 160));
  }
  throw new Error('FASHN timed out');
}
const outBuf = async (out) =>
  out.startsWith('data:') ? Buffer.from(out.split(',')[1], 'base64') : (await fetchSafe(out, { max: 12_000_000 })).buf;
const usedPath = (it) => (it.usePhoto === 'catalog' && it.catalog ? it.catalog.img : it.usePhoto === 'cutout' && it.cutout ? it.cutout : it.own);

app.get('/api/profile', (req, res) => res.json({ photo: db.me?.photo || null, tryon: !!FASHN, dailySteps: TRY_DAILY }));
app.post('/api/profile/photo', async (req, res) => {
  const m = /^data:image\/(?:jpeg|png|webp);base64,(.+)$/.exec(String(req.body?.image || ''));
  const buf = m && Buffer.from(m[1], 'base64');
  const ext = buf && sniff(buf);
  if (!ext) return res.status(400).json({ error: 'Send a photo' });
  const name = `me-${Date.now().toString(36)}.${ext}`;
  await fs.writeFile(path.join(DATA, 'img', name), buf);
  if (db.me?.photo) fs.unlink(path.join(DATA, 'img', db.me.photo.split('/').pop())).catch(() => {});
  db.me = { photo: '/img/' + name };
  await save();
  res.json({ photo: db.me.photo });
});

app.post('/api/items/:id/cutout', async (req, res) => {
  const it = db.items.find((x) => x.id === req.params.id);
  if (!it) return res.sendStatus(404);
  if (!FASHN) return res.status(400).json({ error: 'Try-on is not set up on the server.' });
  try {
    const out = await fashn('background-remove', { image: toUri(await readImg(it.own)), return_base64: true }, 120_000);
    const buf = await outBuf(out);
    const ext = sniff(buf);
    if (!ext) throw new Error('bad image');
    const name = imgFile(it.id, 'cut', ext);
    await fs.writeFile(path.join(DATA, 'img', name), buf);
    it.cutout = '/img/' + name;
    it.usePhoto = 'cutout';
    await save();
    res.json(shape(it));
  } catch (e) {
    console.error('cutout', e.message);
    res.status(502).json({ error: 'Could not clean up this photo right now.' });
  }
});

const jobs = new Map();
const SLOT = ['full', 'top', 'bottom', 'outer', 'shoes', 'accessory'];
app.post('/api/tryon', async (req, res) => {
  if (!FASHN) return res.status(400).json({ error: 'Try-on is not set up on the server yet.' });
  if (!db.me?.photo) return res.status(400).json({ error: 'Add your photo first.' });
  const ids = [...new Set(Array.isArray(req.body?.itemIds) ? req.body.itemIds : [])];
  const its = ids.map((i) => db.items.find((x) => x.id === i)).filter(Boolean)
    .sort((a, b) => SLOT.indexOf(a.category) - SLOT.indexOf(b.category)).slice(0, 5);
  if (!its.length) return res.status(400).json({ error: 'Nothing to try on.' });
  const key = crypto.createHash('sha1').update([db.me.photo, ...its.map((i) => i.id + ':' + usedPath(i))].join('|')).digest('hex').slice(0, 16);
  db.tryons ||= {};
  const hit = db.tryons[key];
  if (hit && (await fs.stat(path.join(DATA, 'img', hit.img.split('/').pop())).catch(() => null)))
    return res.json({ id: key, status: 'done', step: its.length, total: its.length, img: hit.img });
  const cutoff = Date.now() - 86400_000;
  db.tryLog = (db.tryLog || []).filter((t) => t > cutoff);
  if (db.tryLog.length + its.length > TRY_DAILY)
    return res.status(429).json({ error: `Daily try-on limit reached (${TRY_DAILY} garment steps). It resets after 24 hours.` });
  const old = jobs.get(key);
  const view = (j) => ({ id: j.id, status: j.status, step: j.step, total: j.total, img: j.img, error: j.error });
  if (old && old.status === 'working') return res.status(202).json(view(old));
  const job = { id: key, status: 'working', step: 0, total: its.length, img: null, error: null };
  jobs.set(key, job);
  enqueue(async () => {
    try {
      let person = toUri(await readImg(db.me.photo));
      for (const it of its) {
        job.step++;
        db.tryLog.push(Date.now());
        const out = await fashn('tryon-max', {
          model_image: person,
          product_image: toUri(await readImg(usedPath(it))),
          prompt: 'Dress the person in this garment. Keep their face, body, pose, background and all other clothing exactly the same.',
          resolution: '1k',
          generation_mode: TRY_MODE,
          return_base64: true,
        });
        const buf = await outBuf(out);
        if (!sniff(buf)) throw new Error('bad image');
        person = toUri(buf);
        job.last = buf;
      }
      const ext = sniff(job.last);
      const name = `tryon-${key}.${ext}`;
      await fs.writeFile(path.join(DATA, 'img', name), job.last);
      job.last = null;
      db.tryons[key] = { img: '/img/' + name, created: Date.now() };
      job.img = '/img/' + name;
      job.status = 'done';
      await save();
    } catch (e) {
      console.error('tryon', e.message);
      job.status = 'error';
      job.error = 'Try-on failed. ' + (/limit|credit|402|429/i.test(e.message) ? 'The try-on service may be out of credits.' : 'Please try again.');
      job.last = null;
    }
  });
  res.status(202).json(view(job));
});
app.get('/api/tryon/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (j) return res.json({ id: j.id, status: j.status, step: j.step, total: j.total, img: j.img, error: j.error });
  const h = db.tryons?.[req.params.id];
  if (h) return res.json({ id: req.params.id, status: 'done', img: h.img });
  res.status(404).json({ error: 'Not found' });
});

app.post('/api/worn', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const now = Date.now();
  for (const it of db.items) if (ids.includes(it.id)) it.lastWorn = now;
  await save();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

await load();
app.listen(PORT, () => console.log(`wear on :${PORT} (data ${DATA}, key ${KEY ? 'set' : 'MISSING'}, passcode ${PASS ? 'set' : 'MISSING'})`));
