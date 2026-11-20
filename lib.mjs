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
export async function save(st) { await store().setJSON("state", st); }

export function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

export function streak(st, u) {
  const user = st.users[u], s0 = start(user), t = today();
  let run = 0, best = 0;
  if (!s0) return { cur: 0, best: 0 };
  for (let d = s0; d <= t; d = addDays(d, 1)) {
    if (!isTraining(user, d)) continue;
    if (posted(st, d, u)) { run++; best = Math.max(best, run); }
    else if (d < t) run = 0;
  }
  return { cur: run, best };
}

export function computePenalties(st) {
  const t = today(); st.penalties = st.penalties || []; const created = [];
  for (const u of ["a", "b"]) {
    const user = st.users[u], s0 = start(user);
    if (!s0) continue;
    let run = 0;
    for (let d = s0; d < t; d = addDays(d, 1)) {
      if (!isTraining(user, d)) continue;
      if (posted(st, d, u)) { run = 0; continue; }
      run++;
      if (run === SALTI_PER_PENITENZA) {
        run = 0;
        const id = u + "_" + d;
        if (!st.penalties.find((p) => p.id === id)) {
          const p = { id, user: u, date: d, text: (st.list && st.list.length ? st.list : PENITENZE)[hash(id) % (st.list && st.list.length ? st.list : PENITENZE).length], done: false, notified: false };
          st.penalties.push(p); created.push(p);
        }
      }
    }
  }
  return created;
}

function status(st, u, d, t) {
  const user = st.users[u], s0 = start(user);
  if (!s0 || d < s0) return "none";
  const tr = isTraining(user, d), dn = posted(st, d, u);
  if (d > t) return tr ? "future" : "rest";
  if (dn) return "done";
  if (d === t) return tr ? "todo" : "rest";
  return tr ? "miss" : "rest";
}

export function publicState(st) {
  const t = today(), users = {};
  for (const u of ["a", "b"]) {
    const user = st.users[u], s0 = start(user), sk = streak(st, u);
    const mon = addDays(t, -wd(t) - 21), grid = [];
    for (let i = 0; i < 28; i++) { const d = addDays(mon, i); grid.push({ d, s: status(st, u, d, t) }); }
    let sch = 0, dn = 0;
    for (let d = t.slice(0, 8) + "01"; d <= t; d = addDays(d, 1)) {
      if (!s0 || d < s0 || !isTraining(user, d)) continue;
      const done = posted(st, d, u);
      if (d < t || done) { sch++; if (done) dn++; }
    }
    users[u] = {
      name: user.name,
      days: user.sched.length ? user.sched[user.sched.length - 1].days : null,
      todayTraining: isTraining(user, t),
      streak: sk.cur, best: sk.best,
      month: sch ? Math.round((dn / sch) * 100) : null,
      grid
    };
  }
  const album = Object.keys(st.posts).filter((d) => d <= t).sort().reverse().slice(0, 90).map((d) => ({ d, p: st.posts[d] }));
  const open = st.penalties.filter((p) => !p.done);
  const done = st.penalties.filter((p) => p.done).slice(-10).reverse();
  return { created: true, today: t, users, album, penalties: { open, done }, list: st.list && st.list.length ? st.list : PENITENZE, rule: SALTI_PER_PENITENZA };
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
