// Logica condivisa (usata dalle funzioni Netlify)
import { getStore } from "@netlify/blobs";
import webpush from "web-push";

export const TZ = "Europe/Rome";
export const SALTI_PER_PENITENZA = 2;

export const PENITENZE = [
  "Niente dolci per 3 giorni",
  "Niente fast food e cibo spazzatura per una settimana",
  "Niente serie e Netflix per 3 sere",
  "Sveglia alle 6:30 e allenamento prima di tutto, domani",
  "Doppio allenamento il giorno dopo",
  "Pulisci tu tutta la casa questa settimana",
  "Lavi i piatti per 5 giorni di fila",
  "L'altro decide cosa mangi per 2 giorni",
  "Doccia fredda per 3 mattine",
  "Fai tu la spesa per 2 settimane",
  "Niente aperitivo né alcol nel weekend",
  "50 burpees davanti all'altro, subito",
  "Il telefono lo tiene l'altro per una sera intera",
  "Porti tu fuori la spazzatura per 2 settimane"
];

export const store = () => getStore({ name: "allenamenti", consistency: "strong" });
export const photos = () => getStore({ name: "foto", consistency: "strong" });

export function today(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function romeHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d)) % 24;
}
export function addDays(s, n) {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const wd = (s) => (new Date(s + "T12:00:00Z").getUTCDay() + 6) % 7; // 0 = lunedì
export const other = (u) => (u === "a" ? "b" : "a");

export function daysFor(user, s) {
  let cur = null;
  for (const v of user.sched || []) if (v.from <= s) cur = v;
  return cur ? cur.days : null;
}
export const isTraining = (user, s) => { const d = daysFor(user, s); return !!d && d.includes(wd(s)); };
export const start = (user) => (user.sched && user.sched.length ? user.sched[0].from : null);
export const posted = (st, d, u) => !!(st.posts[d] && st.posts[d][u]);

export async function load() { return (await store().get("state", { type: "json" })) || null; }
export async function save(st) { const { _pending, ...rest } = st; await store().setJSON("state", rest); }

export function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

export const weekStart = (s) => addDays(s, -wd(s));
export const weekEnd = (s) => addDays(weekStart(s), 6);
const listOf = (st) => (st.list && st.list.length ? st.list : PENITENZE);

// allenamenti saltati recuperati con una foto in un giorno di riposo della stessa settimana
export function recovered(st, u) {
  const user = st.users[u], s0 = start(user), t = today(), rec = new Set();
  if (!s0) return rec;
  let queue = [], wk = null;
  for (let d = s0; d <= t; d = addDays(d, 1)) {
    const w = weekStart(d);
    if (w !== wk) { wk = w; queue = []; }
    const tr = isTraining(user, d), p = posted(st, d, u);
    if (tr) { if (!p && d < t) queue.push(d); }
    else if (p && queue.length) rec.add(queue.shift());
  }
  return rec;
}

export function streak(st, u) {
  const user = st.users[u], s0 = start(user), t = today(), rec = recovered(st, u);
  let run = 0, best = 0;
  if (!s0) return { cur: 0, best: 0 };
  for (let d = s0; d <= t; d = addDays(d, 1)) {
    if (!isTraining(user, d)) continue;
    if (posted(st, d, u) || rec.has(d)) { run++; best = Math.max(best, run); }
    else if (d < t) run = 0;
  }
  return { cur: run, best };
}

// analizza i salti: crea le penitenze scadute e restituisce gli avvisi ancora recuperabili
export function computePenalties(st) {
  const t = today(), tw = weekStart(t); st.penalties = st.penalties || []; const created = [], pending = [];
  for (const u of ["a", "b"]) {
    const user = st.users[u], s0 = start(user);
    if (!s0) continue;
    const rec = recovered(st, u);
    let run = [];
    for (let d = s0; d < t; d = addDays(d, 1)) {
      if (!isTraining(user, d)) continue;
      if (posted(st, d, u)) { run = []; continue; }
      run.push(d);
      if (run.length === SALTI_PER_PENITENZA) {
        const group = run; run = [];
        const open = group.filter((x) => !rec.has(x));
        if (!open.length) continue; // recuperati tutti
        const stillTime = open.every((x) => weekStart(x) === tw);
        const id = u + "_" + group[group.length - 1];
        if (stillTime) { pending.push({ id, user: u, left: open.length, deadline: weekEnd(t), days: group }); continue; }
        if (!st.penalties.find((p) => p.id === id)) {
          const L = listOf(st);
          const p = { id, user: u, date: group[group.length - 1], text: L[hash(id) % L.length], done: false, notified: false };
          st.penalties.push(p); created.push(p);
        }
      }
    }
  }
  st._pending = pending;
  return created;
}

function status(st, u, d, t, rec) {
  const user = st.users[u], s0 = start(user);
  if (!s0 || d < s0) return "none";
  const tr = isTraining(user, d), dn = posted(st, d, u);
  if (d > t) return tr ? "future" : "rest";
  if (dn) return "done";
  if (d === t) return tr ? "todo" : "rest";
  if (tr && rec.has(d)) return "rec";
  return tr ? "miss" : "rest";
}

export function publicState(st) {
  const t = today(), users = {};
  computePenalties(st);
  for (const u of ["a", "b"]) {
    const user = st.users[u], s0 = start(user), sk = streak(st, u), rec = recovered(st, u);
    const mon = addDays(t, -wd(t) - 21), grid = [];
    for (let i = 0; i < 28; i++) { const d = addDays(mon, i); grid.push({ d, s: status(st, u, d, t, rec) }); }
    let sch = 0, dn = 0;
    for (let d = t.slice(0, 8) + "01"; d <= t; d = addDays(d, 1)) {
      if (!s0 || d < s0 || !isTraining(user, d)) continue;
      const done = posted(st, d, u) || rec.has(d);
      if (d < t || done) { sch++; if (done) dn++; }
    }
    const pend = st._pending.filter((p) => p.user === u);
    users[u] = {
      name: user.name,
      days: user.sched.length ? user.sched[user.sched.length - 1].days : null,
      todayTraining: isTraining(user, t),
      streak: sk.cur, best: sk.best,
      month: sch ? Math.round((dn / sch) * 100) : null,
      debt: pend.length ? { left: pend.reduce((s, p) => s + p.left, 0), deadline: pend[0].deadline } : null,
      grid
    };
  }
  const album = Object.keys(st.posts).filter((d) => d <= t).sort().reverse().slice(0, 90).map((d) => ({ d, p: st.posts[d] }));
  const open = st.penalties.filter((p) => !p.done);
  const done = st.penalties.filter((p) => p.done).slice(-10).reverse();
  return { created: true, today: t, users, album, penalties: { open, done }, list: listOf(st), rule: SALTI_PER_PENITENZA };
}

export async function ensureVapid(st) {
  if (!st.vapid) { st.vapid = webpush.generateVAPIDKeys(); await save(st); }
  return st.vapid;
}

// invia una notifica a tutti i dispositivi di un utente; ritorna gli endpoint non più validi
export async function push(st, u, payload) {
  const subs = (st.subs && st.subs[u]) || [], dead = [];
  if (!subs.length || !st.vapid) return dead;
  webpush.setVapidDetails("mailto:noreply@allenamenti.app", st.vapid.publicKey, st.vapid.privateKey);
  for (const s of subs) {
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600, urgency: "high" }); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(s.endpoint); }
  }
  st.subs[u] = subs.filter((s) => !dead.includes(s.endpoint));
  return dead;
}
