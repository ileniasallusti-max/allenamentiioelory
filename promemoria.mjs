// Va spostato in: netlify/functions/promemoria.mjs
// Gira ogni ora: manda i promemoria (5 mattina, 5 pomeriggio, 5 sera) a chi non ha ancora caricato la foto
import { load, save, today, romeHour, other, isTraining, posted, streak, computePenalties, push, SALTI_PER_PENITENZA } from "../../lib.mjs";

const SLOT = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 14: 5, 15: 6, 16: 7, 17: 8, 18: 9, 19: 10, 20: 11, 21: 12, 22: 13, 23: 14 };
const MSG = [
  "Buongiorno {n} ☀️ Oggi è giorno di allenamento",
  "La tua foto di oggi ti aspetta 📸",
  "{p} conta su di te 💪",
  "Hai già deciso quando ti alleni oggi?",
  "Anche 30 minuti valgono. Foto quando hai finito 📸",
  "Pausa finita? È ora di muoversi 🏋️",
  "Il tuo streak di {s} ti guarda 🔥",
  "Non dimenticare la foto di oggi 📸",
  "Mezz'ora basta. Vai!",
  "{p} vuole vedere la tua foto 👀",
  "Sera = ultima occasione per allenarti oggi ⏳",
  "Non far crollare lo streak 🔥",
  "Ricorda: {r} saltati di fila = penitenza 😈",
  "Mancano poche ore a mezzanotte ⏰",
  "Ultima chiamata! Carica la foto prima di mezzanotte 🚨"
];

export default async () => {
  const st = await load();
  if (!st) return;
  const t = today(), h = romeHour();
  const dead = { a: [], b: [] };

  // penitenze nuove → avviso a entrambi
  computePenalties(st);
  const news = st.penalties.filter((p) => !p.notified);
  for (const p of news) {
    for (const u of ["a", "b"]) {
      dead[u].push(...await push(st, u, { title: "🚨 Penitenza!", body: `${st.users[p.user].name} ha saltato ${SALTI_PER_PENITENZA} allenamenti di fila: ${p.text}` }));
    }
  }

  // avviso: 2 allenamenti saltati, ma c'è tempo per recuperare entro domenica
  const warned = st.warned || [];
  const newWarn = (st._pending || []).filter((w) => !warned.includes(w.id));
  for (const w of newWarn) {
    const n = st.users[w.user].name;
    dead[w.user].push(...await push(st, w.user, { title: "⚠️ Hai saltato " + SALTI_PER_PENITENZA + " allenamenti di fila", body: "Recuperali entro domenica allenandoti in un giorno di riposo, o scatta la penitenza 😈" }));
    const o = other(w.user);
    dead[o].push(...await push(st, o, { title: `⚠️ ${n} ha saltato ${SALTI_PER_PENITENZA} allenamenti`, body: "Ha tempo fino a domenica per recuperarli, poi penitenza 😈" }));
  }

  // promemoria foto
  if (SLOT[h] !== undefined) {
    for (const u of ["a", "b"]) {
      const user = st.users[u];
      const debt = (st._pending || []).filter((w) => w.user === u).reduce((s, w) => s + w.left, 0);
      if (!isTraining(user, t)) {
        // giorno di riposo con allenamenti da recuperare: 3 promemoria
        if (debt && !posted(st, t, u) && [2, 7, 12].includes(SLOT[h])) {
          dead[u].push(...await push(st, u, { title: "Allenamenti", body: `Oggi puoi recuperare 💪 Ti ${debt === 1 ? "manca 1 allenamento" : "mancano " + debt + " allenamenti"} entro domenica, o scatta la penitenza` }));
        }
        continue;
      }
      if (posted(st, t, u)) continue;
      const o = other(u);
      let body = MSG[SLOT[h]];
      if (posted(st, t, o) && SLOT[h] % 3 === 1) body = "{p} ha già caricato la sua foto 👀 Tocca a te";
      const s = streak(st, u).cur;
      body = body.replace("{n}", user.name).replace("{p}", st.users[o].name).replace("{s}", s + (s === 1 ? " giorno" : " giorni")).replace("{r}", String(SALTI_PER_PENITENZA));
      dead[u].push(...await push(st, u, { title: "Allenamenti", body }));
    }
  }

  // salvataggio sicuro: riparte dallo stato più recente
  const fresh = await load();
  computePenalties(fresh);
  for (const p of fresh.penalties) if (news.find((n) => n.id === p.id)) p.notified = true;
  for (const u of ["a", "b"]) fresh.subs[u] = (fresh.subs[u] || []).filter((s) => !dead[u].includes(s.endpoint));
  fresh.warned = [...new Set([...(fresh.warned || []), ...newWarn.map((w) => w.id)])].slice(-100);
  await save(fresh);
};

export const config = { schedule: "0 * * * *" };
