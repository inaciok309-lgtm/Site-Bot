// =============================================================
// Site do bot no Netlify — uma única Netlify Function (v2) que cuida de:
//   /auth/*   login com Discord (OAuth2)
//   /api/*    API usada pela página
//   /bridge/* o bot (na Discloud) busca pedidos e devolve resultados
// Netlify não mantém memória entre chamadas, então sessões e a fila de pedidos
// ficam no Netlify Blobs.
// =============================================================
import crypto from 'node:crypto';

const INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=1550943648366067752&permissions=84992&scope=bot';
const DISCORD_API = 'https://discord.com/api/v10';
const BAYGON_USER_ID = '1495890474840621197';
const SESSION_TTL = 24 * 60 * 60 * 1000;
const BOT_OFFLINE_AFTER = 120 * 1000;
const FAST_POLL_MS = 1500;
const ACTIVE_WINDOW = 120 * 1000;
const WAIT_FIRST = 8000;   // espera dentro de uma chamada (limite padrão do Netlify: 10 s)
const WAIT_JOB = 4000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createHandler({ getStore }) {
  const store = () => getStore({ name: 'bot-site', consistency: 'strong' });

  const json = (status, obj, cookies) => {
    const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    for (const c of cookies || []) h.append('Set-Cookie', c);
    return new Response(JSON.stringify(obj), { status, headers: h });
  };
  const redirect = (location, cookies) => {
    const h = new Headers({ Location: location });
    for (const c of cookies || []) h.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers: h });
  };
  const parseCookies = (req) => {
    const out = {};
    for (const part of String(req.headers.get('cookie') || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  };
  const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  async function readJson(req, limit) {
    const text = await req.text();
    if (text.length > limit) throw new HttpError(413, 'Corpo grande demais.');
    if (!text) return {};
    try { return JSON.parse(text); } catch (e) { throw new HttpError(400, 'JSON inválido.'); }
  }

  // ---------- sessões (no Blobs) ----------
  async function getSession(req) {
    const sid = parseCookies(req).sid;
    if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
    const s = await store().get('session/' + sid, { type: 'json' });
    if (!s) return null;
    if (s.exp < Date.now()) { await store().delete('session/' + sid); return null; }
    return s;
  }
  async function requireSession(req) {
    const s = await getSession(req);
    if (!s) throw new HttpError(401, 'Faça login.');
    return s;
  }

  // ---------- ponte com o bot ----------
  async function botMeta() { return (await store().get('meta/bot', { type: 'json' })) || null; }

  async function waitResult(id, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const r = await store().get('result/' + id, { type: 'json' });
      if (r) { await store().delete('result/' + id); return r; }
      if (Date.now() + 450 > end) return null;
      await sleep(450);
    }
  }
  function jobResponse(r, id) {
    if (!r) return json(202, { pending: true, jobId: id });
    if (r.status >= 400) throw new HttpError(r.status, (r.data && r.data.error) || 'Erro no bot.');
    return json(200, r.data);
  }
  async function callBot(type, userId, params) {
    const meta = await botMeta();
    if (!meta || Date.now() - meta.lastPoll > BOT_OFFLINE_AFTER) throw new HttpError(503, 'O bot está offline no momento. Tente de novo em instantes.');
    const id = userId + '.' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    await store().setJSON('pending/' + id, { id, type, userId, params, t: now });
    await store().setJSON('meta/lastJob', { t: now });
    return jobResponse(await waitResult(id, WAIT_FIRST), id);
  }
  const bridgeOk = (req) => {
    const key = process.env.BRIDGE_KEY || '';
    const h = (v) => crypto.createHash('sha256').update(v).digest();
    return key.length > 0 && crypto.timingSafeEqual(h(String(req.headers.get('authorization') || '').replace(/^Bearer /, '')), h(key));
  };

  async function bridgePoll(req) {
    const body = await readJson(req, 100 * 1024);
    const s = store(), now = Date.now();
    const guildIds = Array.isArray(body.guildIds) ? body.guildIds.map(String).sort() : [];
    const meta = await botMeta();
    if (!meta || now - meta.lastPoll > 20000 || meta.guildIds.join() !== guildIds.join()) await s.setJSON('meta/bot', { guildIds, lastPoll: now });

    const { blobs } = await s.list({ prefix: 'pending/' });
    const jobs = [];
    for (const b of blobs.slice(0, 10)) {
      const j = await s.get(b.key, { type: 'json' });
      await s.delete(b.key);
      if (j && now - j.t < 120000) jobs.push(j);
    }
    if (Math.random() < 0.03) { // faxina de resultados esquecidos
      const old = await s.list({ prefix: 'result/' });
      for (const b of old.blobs) { const r = await s.get(b.key, { type: 'json' }); if (!r || now - r.t > 600000) await s.delete(b.key); }
    }
    const last = (await s.get('meta/lastJob', { type: 'json' })) || { t: 0 };
    const idle = Math.min(60, Math.max(3, parseInt(process.env.BRIDGE_IDLE_SECONDS, 10) || 10)) * 1000;
    return json(200, { jobs, nextPollMs: jobs.length || now - last.t < ACTIVE_WINDOW ? FAST_POLL_MS : idle });
  }

  // ---------- rotas ----------
  async function route(req) {
    const url = new URL(req.url);
    const p = url.pathname, method = req.method;
    const SITE_URL = (process.env.SITE_URL || url.origin).replace(/\/+$/, '');
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1550943648366067752';
    const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

    // ----- ponte (só o bot) -----
    if (p.startsWith('/bridge/')) {
      if (method !== 'POST' || !bridgeOk(req)) throw new HttpError(401, 'Não autorizado.');
      if (p === '/bridge/poll') return bridgePoll(req);
      if (p === '/bridge/result') {
        const body = await readJson(req, 4 * 1024 * 1024);
        if (typeof body.id !== 'string' || !/^\d+\.[a-f0-9]{16}$/.test(body.id)) throw new HttpError(400, 'id inválido.');
        await store().setJSON('result/' + body.id, { status: Number(body.status) || 500, data: body.data || {}, t: Date.now() });
        return json(200, { ok: true });
      }
      throw new HttpError(404, 'Rota não encontrada.');
    }

    // ----- OAuth2 -----
    if (method === 'GET' && p === '/auth/login') {
      if (!CLIENT_SECRET) throw new HttpError(500, 'DISCORD_CLIENT_SECRET não configurado no Netlify.');
      const state = crypto.randomBytes(16).toString('hex');
      const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: SITE_URL + '/auth/callback', scope: 'identify guilds', state, prompt: 'none' });
      return redirect('https://discord.com/oauth2/authorize?' + q, [cookie('oauth_state', state, 600)]);
    }
    if (method === 'GET' && p === '/auth/callback') {
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state || parseCookies(req).oauth_state !== state) return redirect('/?erro=login');
      try {
        const tokenRes = await fetch(DISCORD_API + '/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: SITE_URL + '/auth/callback' })
        });
        if (!tokenRes.ok) throw new Error('token ' + tokenRes.status);
        const auth = { Authorization: 'Bearer ' + (await tokenRes.json()).access_token };
        const [uRes, gRes] = await Promise.all([fetch(DISCORD_API + '/users/@me', { headers: auth }), fetch(DISCORD_API + '/users/@me/guilds', { headers: auth })]);
        if (!uRes.ok || !gRes.ok) throw new Error('perfil/servidores');
        const user = await uRes.json();
        const guilds = (await gRes.json()).filter(g => {
          const perms = BigInt(g.permissions || '0');
          return g.owner || (perms & 0x8n) !== 0n || (perms & 0x20n) !== 0n;
        }).map(g => ({ id: g.id, name: g.name, icon: g.icon }));
        const sid = crypto.randomBytes(32).toString('hex');
        await store().setJSON('session/' + sid, { user: { id: user.id, username: user.global_name || user.username, avatar: user.avatar }, guilds, exp: Date.now() + SESSION_TTL });
        return redirect('/', [cookie('sid', sid, SESSION_TTL / 1000), cookie('oauth_state', '', 0)]);
      } catch (err) {
        console.error('[site] Falha no login:', err.message);
        return redirect('/?erro=login');
      }
    }

    // ----- API da página -----
    if (p.startsWith('/api/')) {
      if (method !== 'GET' && req.headers.get('x-requested-with') !== 'fetch') throw new HttpError(403, 'Requisição bloqueada.');
      const body = method === 'GET' ? {} : await readJson(req, 100 * 1024);

      if (method === 'GET' && p === '/api/public') {
        const s = await getSession(req), meta = await botMeta();
        return json(200, { inviteUrl: INVITE_URL, user: s ? s.user : null, isBaygon: !!s && s.user.id === BAYGON_USER_ID, botOnline: !!meta && Date.now() - meta.lastPoll <= BOT_OFFLINE_AFTER });
      }
      if (method === 'POST' && p === '/api/logout') {
        const sid = parseCookies(req).sid;
        if (sid && /^[a-f0-9]{64}$/.test(sid)) await store().delete('session/' + sid);
        return json(200, { ok: true }, [cookie('sid', '', 0)]);
      }
      if (method === 'GET' && p === '/api/guilds') {
        const s = await requireSession(req), meta = await botMeta();
        const inBot = new Set(meta ? meta.guildIds : []);
        return json(200, { guilds: s.guilds.map(g => ({ ...g, botIn: inBot.has(g.id), inviteUrl: INVITE_URL + '&guild_id=' + g.id + '&disable_guild_select=true' })) });
      }

      let m;
      if ((m = p.match(/^\/api\/job\/(\d+\.[a-f0-9]{16})$/)) && method === 'GET') {
        const s = await requireSession(req);
        if (!m[1].startsWith(s.user.id + '.')) throw new HttpError(403, 'Sem permissão.');
        return jobResponse(await waitResult(m[1], WAIT_JOB), m[1]);
      }
      const needGuild = async (id) => {
        const s = await requireSession(req);
        if (!s.guilds.some(g => g.id === id)) throw new HttpError(403, 'Você não gerencia este servidor.');
        return s;
      };
      if ((m = p.match(/^\/api\/guild\/(\d+)$/)) && method === 'GET') {
        const s = await needGuild(m[1]);
        return callBot('guild-get', s.user.id, { guildId: m[1] });
      }
      if ((m = p.match(/^\/api\/guild\/(\d+)\/config\/(\w+)$/)) && method === 'PUT') {
        const s = await needGuild(m[1]);
        return callBot('guild-save', s.user.id, { guildId: m[1], section: m[2], data: body });
      }
      if ((m = p.match(/^\/api\/guild\/(\d+)\/ticket-publish$/)) && method === 'POST') {
        const s = await needGuild(m[1]);
        return callBot('ticket-publish', s.user.id, { guildId: m[1], channelId: body.channelId });
      }
      if ((m = p.match(/^\/api\/baygon\/([\w-]+)$/))) {
        const s = await requireSession(req);
        if (s.user.id !== BAYGON_USER_ID) throw new HttpError(403, 'Sem permissão.');
        return callBot('baygon', s.user.id, { route: m[1], body, query: Object.fromEntries(url.searchParams.entries()) });
      }
      throw new HttpError(404, 'Rota não encontrada.');
    }
    throw new HttpError(404, 'Não encontrado.');
  }

  return async (req) => {
    try { return await route(req); }
    catch (err) {
      if (!(err instanceof HttpError)) console.error('[site] Erro:', err);
      return json(err instanceof HttpError ? err.status : 500, { error: err instanceof HttpError ? err.message : 'Erro interno.' });
    }
  };
}

// Handler real: carrega o @netlify/blobs só quando precisa
const handler = createHandler({
  getStore: (opts) => {
    let real;
    const lazy = async () => (real ||= (await import('@netlify/blobs')).getStore(opts));
    return {
      get: async (k, o) => (await lazy()).get(k, o),
      setJSON: async (k, v) => (await lazy()).setJSON(k, v),
      delete: async (k) => (await lazy()).delete(k),
      list: async (o) => (await lazy()).list(o)
    };
  }
});

export default async (req) => handler(req);
export const config = { path: ['/api/*', '/auth/*', '/bridge/*'] };
