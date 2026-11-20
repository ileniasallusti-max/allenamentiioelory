// Va spostato in: netlify/functions/api.mjs
import { createHash } from "node:crypto";
import { load, save, today, addDays, other, publicState, computePenalties, ensureVapid, push, photos } from "../../lib.mjs";

const H = (s) => createHash("sha256").update("allenamenti:" + s).digest("hex");
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const okDays = (d) => Array.isArray(d) && d.length > 0 && d.every((x) => Number.isInteger(x) && x >= 0 && x <= 6);
const clean = (s) => String(s || "").trim().slice(0, 30);

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const pin = body.pin ?? url.searchParams.get("pin");
  let st = await load();

  if (route === "create") {
    if (st) return json({ error: "exists" }, 409);
    if (!pin || String(pin).length < 4) return json({ error: "Il codice deve avere almeno 4 caratteri" }, 400);
    if (!clean(body.nameA) || !clean(body.nameB)) return json({ error: "Mancano i nomi" }, 400);
    if (!okDays(body.days)) return json({ error: "Scegli almeno un giorno" }, 400);
    st = {
      pin: H(pin), created: today(),
      users: { a: { name: clean(body.nameA), sched: [{ from: today(), days: body.days }] }, b: { name: clean(body.nameB), sched: [] } },
      posts: {}, penalties: [], subs: { a: [], b: [] }
    };
    await save(st);
    return json(publicState(st));
  }

  if (!st) return json({ created: false });
  if (!pin || H(pin) !== st.pin) return json({ error: "Codice sbagliato" }, 401);
  const u = body.user ?? url.searchParams.get("user");

  switch (route) {
    case "state": {
      if (computePenalties(st).length) await save(st);
      return json(publicState(st));
    }
    case "names": {
      return json({ a: st.users.a.name, b: st.users.b.name, needDays: { a: !st.users.a.sched.length, b: !st.users.b.sched.length } });
    }
    case "days": {
      if (!["a", "b"].includes(u) || !okDays(body.days)) return json({ error: "Dati non validi" }, 400);
      const user = st.users[u];
      const from = user.sched.length ? addDays(today(), 1) : today();
      user.sched = user.sched.filter((v) => v.from < from);
      user.sched.push({ from, days: [...new Set(body.days)].sort() });
      await save(st);
      return json(publicState(st));
    }
    case "photo": {
      if (!["a", "b"].includes(u)) return json({ error: "Utente non valido" }, 400);
      const m = /^data:image\/\w+;base64,(.+)$/.exec(body.image || "");
      if (!m) return json({ error: "Foto non valida" }, 400);
      const buf = Buffer.from(m[1], "base64");
      if (buf.length > 4.5 * 1024 * 1024) return json({ error: "Foto troppo grande" }, 400);
      const t = today();
      await photos().set(`${t}_${u}`, buf);
      st = await load();
      const first = !(st.posts[t] && st.posts[t][u]);
      st.posts[t] = st.posts[t] || {};
      st.posts[t][u] = { time: new Date().toISOString() };
      await save(st);
      if (first) {
        const o = other(u);
        const n = st.users[u].name;
        const dead = await push(st, o, { title: `💪 ${n} si è allenat${/a$/i.test(n) ? "a" : "o"}`, body: posted(st, t, o) ? "Ha caricato la foto: guardatevi a vicenda!" : "Ha caricato la foto. Carica la tua per vederla 👀" });
        if (dead.length) await save(st);
      }
      return json(publicState(st));
    }
    case "photo-get": {
      const d = url.searchParams.get("d");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "") || !["a", "b"].includes(u)) return new Response("no", { status: 400 });
      const buf = await photos().get(`${d}_${u}`, { type: "arrayBuffer" });
      if (!buf) return new Response("not found", { status: 404 });
      return new Response(buf, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000" } });
    }
    case "vapid": {
      const v = await ensureVapid(st);
      return json({ key: v.publicKey });
    }
    case "sub": {
      if (!["a", "b"].includes(u) || !body.sub || !body.sub.endpoint) return json({ error: "Dati non validi" }, 400);
      st.subs = st.subs || { a: [], b: [] };
      st.subs[u] = (st.subs[u] || []).filter((s) => s.endpoint !== body.sub.endpoint).concat(body.sub);
      await save(st);
      return json({ ok: true });
    }
    case "test": {
      await ensureVapid(st);
      const dead = await push(st, u, { title: "Notifiche attive ✓", body: "Da adesso ti ricordo io di caricare la foto 💪" });
      if (dead.length) await save(st);
      return json({ ok: true, devices: (st.subs[u] || []).length });
    }
    case "list": {
      const list = Array.isArray(body.list) ? body.list.map((x) => String(x || "").trim().slice(0, 90)).filter(Boolean).slice(0, 40) : [];
      if (!list.length) return json({ error: "Serve almeno una penitenza" }, 400);
      st.list = list;
      await save(st);
      return json(publicState(st));
    }
    case "penalty": {
      const p = st.penalties.find((x) => x.id === body.id);
      if (!p) return json({ error: "Non trovata" }, 404);
      p.done = true; p.doneAt = today();
      await save(st);
      return json(publicState(st));
    }
    default:
      return json({ error: "not found" }, 404);
  }
};

function posted(st, d, u) { return !!(st.posts[d] && st.posts[d][u]); }

export const config = { path: "/api/*" };
