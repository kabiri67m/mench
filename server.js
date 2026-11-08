const http = require('http'), fs = require('fs');
const { WebSocketServer } = require('ws');

const html = fs.readFileSync(__dirname + '/index.html');
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/ping')) { r.writeHead(200); return r.end('ok'); }
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(html);
});
const wss = new WebSocketServer({ server: srv });

// چهار صندلی: هر صندلی خالی توسط ربات بازی می‌شود
const ab = (p, s) => (p * 10 + s) % 40;
const fresh = () => ({ turn: 0, dice: 0, win: -1, pcs: Array(16).fill(-1) });
const BN = ['ربات ۱', 'ربات ۲', 'ربات ۳', 'ربات ۴'];
const P = [0, 1, 2, 3].map(() => ({ id: null, name: '', ws: null, w: 0, l: 0 }));
let S = fresh(), chat = [], bt = null;

// مقصد حرکت مهره i بازیکن p با تاس d (یا null)
function can(p, i, d) {
  const s = S.pcs[p * 4 + i]; let t;
  if (s < 0) { if (d != 6) return null; t = 0; }
  else { t = s + d; if (t > 43) return null; }
  for (let j = 0; j < 4; j++) if (j != i && S.pcs[p * 4 + j] == t) return null;
  if (t < 40) // خانه شروع هر بازیکن برای حریفان قفل است
    for (let q = 0; q < 4; q++) if (q != p)
      for (let j = 0; j < 4; j++) if (S.pcs[q * 4 + j] == 0 && ab(q, 0) == ab(p, t)) return null;
  return t;
}
const nm = k => P[k].ws ? P[k].name : BN[k];

function push(note, by, die) {
  const n = P.filter(s => s.ws).length;
  const extra = { n, names: P.map((s, k) => nm(k)), bots: P.map(s => !s.ws), stats: P.map(s => [s.w, s.l]) };
  P.forEach((s, k) => s.ws && s.ws.readyState == 1 &&
    s.ws.send(JSON.stringify({ me: k, S: { ...S, ...extra }, chat, note, by, die })));
  sched();
}

function doRoll(p) {
  const d = 1 + Math.floor(Math.random() * 6);
  let any = false;
  for (let i = 0; i < 4; i++) if (can(p, i, d) != null) any = true;
  if (any) { S.dice = d; return push(); }
  if (d != 6) S.turn = (S.turn + 1) % 4;
  push(nm(p) + ' عدد ' + d + ' آورد؛ حرکت مجاز وجود نداشت' + (d == 6 ? ' و نوبت تکرار می‌شود.' : '.'), p, d);
}

function doMove(p, i) {
  const d = S.dice, t = can(p, i, d);
  if (t == null) return;
  S.pcs[p * 4 + i] = t;
  if (t < 40) // زدن مهره حریف
    for (let q = 0; q < 4; q++) if (q != p)
      for (let j = 0; j < 4; j++) {
        const s2 = S.pcs[q * 4 + j];
        if (s2 >= 0 && s2 < 40 && ab(q, s2) == ab(p, t)) S.pcs[q * 4 + j] = -1;
      }
  if ([0, 1, 2, 3].every(j => S.pcs[p * 4 + j] >= 40)) {
    S.win = p;
    P.forEach((s, k) => { if (s.ws) k == p ? s.w++ : s.l++; });
  } else if (d != 6) S.turn = (S.turn + 1) % 4;
  S.dice = 0;
  push();
}

function bestMove(p) {
  let b = -1, bs = -1;
  for (let i = 0; i < 4; i++) {
    const t = can(p, i, S.dice); if (t == null) continue;
    const s = S.pcs[p * 4 + i]; let sc = s < 0 ? 50 : s;
    if (t >= 40) sc += 60;
    else for (let q = 0; q < 4; q++) if (q != p)
      for (let j = 0; j < 4; j++) {
        const s2 = S.pcs[q * 4 + j];
        if (s2 >= 0 && s2 < 40 && ab(q, s2) == ab(p, t)) sc += 100;
      }
    if (sc > bs) { bs = sc; b = i; }
  }
  return b;
}

// نوبت ربات‌ها (فقط وقتی حداقل یک کاربر واقعی متصل است)
function sched() {
  clearTimeout(bt);
  if (S.win >= 0 || !P.some(s => s.ws) || P[S.turn].ws) return;
  bt = setTimeout(() => {
    const p = S.turn;
    if (S.win >= 0 || P[p].ws) return;
    if (S.dice) doMove(p, bestMove(p)); else doRoll(p);
  }, S.dice ? 1000 : 1400);
}

wss.on('connection', ws => {
  let me = -1;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t == 'join') {
      const id = String(m.id).slice(0, 40);
      const name = String(m.name || '').trim().slice(0, 20) || 'کاربر';
      let k = P.findIndex(s => s.id === id);
      if (k < 0) k = P.findIndex(s => !s.ws && !s.id);
      if (k < 0) k = P.findIndex(s => !s.ws);
      if (k < 0) return ws.send(JSON.stringify({ err: 'تمامی صندلی‌ها اشغال است.' }));
      const old = P[k].ws;
      const w = Math.max(0, parseInt(m.w) || 0), l = Math.max(0, parseInt(m.l) || 0);
      const keep = P[k].id === id && P[k].w + P[k].l >= w + l;
      P[k] = { id, name, ws, w: keep ? P[k].w : w, l: keep ? P[k].l : l }; me = k;
      if (old && old !== ws) old.close();
      return push();
    }
    if (me < 0) return;

    if (m.t == 'chat') {
      const text = String(m.text || '').trim().slice(0, 200);
      if (!text) return;
      chat.push({ f: me, n: P[me].name, text }); chat = chat.slice(-40);
      return push();
    }
    if (m.t == 'reset') { if (S.win >= 0) { S = fresh(); push(); } return; }

    if (S.turn != me || S.win >= 0) return;
    if (m.t == 'roll' && !S.dice) doRoll(me);
    if (m.t == 'move' && S.dice) doMove(me, +m.i);
  });

  ws.on('close', () => {
    if (me >= 0 && P[me].ws === ws) { P[me].ws = null; push(); }
  });
});

srv.listen(process.env.PORT || 3000, () => console.log('server is running'));

// جلوگیری از خاموش شدن سرور در Render
const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF) setInterval(() => fetch(SELF + '/ping').catch(() => {}), 10 * 60 * 1000);
