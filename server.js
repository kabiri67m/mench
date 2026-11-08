const http = require('http'), fs = require('fs');
const { WebSocketServer } = require('ws');

const html = fs.readFileSync(__dirname + '/index.html');
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/ping')) { r.writeHead(200); return r.end('ok'); }
  if (q.url.startsWith('/lb')) {
    const top = [...LB.values()].filter(e => e.w > 0).sort((a, b) => b.w - a.w || a.l - b.l).slice(0, 5);
    r.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return r.end(JSON.stringify(top));
  }
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(html);
});
const wss = new WebSocketServer({ server: srv });

const ab = (p, s) => (p * 10 + s) % 40;
const fresh = () => ({ started: false, turn: 0, dice: 0, win: -1, pcs: Array(16).fill(-1) });
const BN = ['ربات ۱', 'ربات ۲', 'ربات ۳', 'ربات ۴'];
const rooms = new Map(), LB = new Map();   // LB: جدول برترین بازیکنان                       // هر بازی یک اتاق مستقل دارد
const humans = R => R.P.filter(s => s.ws).length;
const mkRoom = (code, pub, diff) => ({ code, pub, diff, S: fresh(), chat: [], bt: null, dl: 0, t: Date.now(),
  P: [0, 1, 2, 3].map(() => ({ id: null, name: '', ws: null, w: 0, l: 0 })) });
function lbSet(id, n, w, l) {
  if (!id) return;
  const e = LB.get(id);
  if (!e || e.w + e.l <= w + l) LB.set(id, { n, w, l });
  if (LB.size > 2000) LB.delete(LB.keys().next().value);
}
function create(pub, diff) {
  if (rooms.size >= 300) return null;
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c;
  do { c = ''; for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)]; } while (rooms.has(c));
  const R = mkRoom(c, pub, diff == 'easy' ? 'easy' : 'normal'); rooms.set(c, R); return R;
}
const nm = (R, k) => R.P[k].ws ? R.P[k].name : BN[k];

function can(R, p, i, d) {
  const S = R.S, s = S.pcs[p * 4 + i]; let t;
  if (s < 0) { if (d != 6) return null; t = 0; }
  else { t = s + d; if (t > 43) return null; }
  for (let j = 0; j < 4; j++) if (j != i && S.pcs[p * 4 + j] == t) return null;
  if (t < 40) // خانه شروع هر بازیکن برای حریفان قفل است
    for (let q = 0; q < 4; q++) if (q != p)
      for (let j = 0; j < 4; j++) if (S.pcs[q * 4 + j] == 0 && ab(q, 0) == ab(p, t)) return null;
  return t;
}

function send(R, note, by, die) {
  R.t = Date.now();
  const left = R.dl ? Math.max(0, Math.round((R.dl - Date.now()) / 1000)) : 0;
  const extra = { n: humans(R), left, names: R.P.map((s, k) => nm(R, k)), bots: R.P.map(s => !s.ws), stats: R.P.map(s => [s.w, s.l]) };
  R.P.forEach((s, k) => s.ws && s.ws.readyState == 1 &&
    s.ws.send(JSON.stringify({ me: k, room: R.code, S: { ...R.S, ...extra }, chat: R.chat, note, by, die })));
}
function push(R, note, by, die) { sched(R); send(R, note, by, die); }

function doRoll(R, p) {
  const S = R.S, d = 1 + Math.floor(Math.random() * 6);
  let any = false;
  for (let i = 0; i < 4; i++) if (can(R, p, i, d) != null) any = true;
  if (any) { S.dice = d; return push(R); }
  if (d != 6) S.turn = (S.turn + 1) % 4;
  push(R, nm(R, p) + ' عدد ' + d + ' آورد؛ حرکت مجاز وجود نداشت' + (d == 6 ? ' و نوبت تکرار می‌شود.' : '.'), p, d);
}

function doMove(R, p, i) {
  const S = R.S, d = S.dice, t = can(R, p, i, d);
  if (t == null) return;
  S.pcs[p * 4 + i] = t;
  if (t < 40)
    for (let q = 0; q < 4; q++) if (q != p)
      for (let j = 0; j < 4; j++) {
        const s2 = S.pcs[q * 4 + j];
        if (s2 >= 0 && s2 < 40 && ab(q, s2) == ab(p, t)) S.pcs[q * 4 + j] = -1;
      }
  if ([0, 1, 2, 3].every(j => S.pcs[p * 4 + j] >= 40)) {
    S.win = p;
    R.P.forEach((s, k) => { if (s.ws) { k == p ? s.w++ : s.l++; lbSet(s.id, s.name, s.w, s.l); } });
  } else if (d != 6) S.turn = (S.turn + 1) % 4;
  S.dice = 0;
  push(R);
}

function botMove(R, p) {
  const S = R.S, ok = [];
  let b = -1, bs = -1;
  for (let i = 0; i < 4; i++) {
    const t = can(R, p, i, S.dice); if (t == null) continue;
    ok.push(i);
    const s = S.pcs[p * 4 + i]; let sc = s < 0 ? 50 : s;
    if (t >= 40) sc += 60;
    else for (let q = 0; q < 4; q++) if (q != p)
      for (let j = 0; j < 4; j++) {
        const s2 = S.pcs[q * 4 + j];
        if (s2 >= 0 && s2 < 40 && ab(q, s2) == ab(p, t)) sc += 100;
      }
    if (sc > bs) { bs = sc; b = i; }
  }
  return R.diff == 'easy' ? ok[Math.floor(Math.random() * ok.length)] : b;
}

// نوبت ربات‌ها و زمان‌سنج کاربران (۳۰ ثانیه؛ در صورت بی‌عملی حرکت خودکار انجام می‌شود)
const TURN = 30000;
function sched(R) {
  clearTimeout(R.bt); R.dl = 0;
  const S = R.S;
  if (!S.started || S.win >= 0 || !humans(R)) return;
  const p = S.turn, human = !!R.P[p].ws;
  if (human) R.dl = Date.now() + TURN;
  R.bt = setTimeout(() => {
    if (R.S !== S || S.win >= 0 || S.turn != p) return;
    if (S.dice) doMove(R, p, botMove(R, p)); else doRoll(R, p);
  }, human ? TURN : S.dice ? 1000 : 1400);
}

wss.on('connection', ws => {
  let R = null, me = -1;
  const err = t => ws.send(JSON.stringify({ err: t }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t == 'join') {
      const id = String(m.id).slice(0, 40);
      const name = String(m.name || '').trim().slice(0, 20) || 'کاربر';
      const pref = [0, 1, 2, 3].includes(+m.c) ? +m.c : 0;
      let room = null;
      if (m.mode == 'quick') {
        room = [...rooms.values()].filter(r => r.pub && r.S.win < 0 && humans(r) < 4)
          .sort((a, b) => humans(b) - humans(a))[0] || create(true, m.diff);
      } else if (m.mode == 'create') room = create(false, m.diff);
      else {
        const c = String(m.code || '').trim().toUpperCase().slice(0, 8);
        room = rooms.get(c);
        if (!room && m.re && c) { room = mkRoom(c, false, 'normal'); rooms.set(c, room); }
        if (!room) return err('کد بازی نامعتبر است.');
      }
      if (!room) return err('ظرفیت سرور تکمیل است؛ لطفاً بعداً تلاش کنید.');
      let k = room.P.findIndex(s => s.id === id);
      if (k < 0 && !room.P[pref].ws) k = pref;
      if (k < 0) k = room.P.findIndex(s => !s.ws && !s.id);
      if (k < 0) k = room.P.findIndex(s => !s.ws);
      if (k < 0) return err('ظرفیت این بازی تکمیل است.');
      if (R && R !== room && me >= 0 && R.P[me].ws === ws) { R.P[me].ws = null; push(R); }
      R = room;
      const old = R.P[k].ws;
      const w = Math.max(0, parseInt(m.w) || 0), l = Math.max(0, parseInt(m.l) || 0);
      const keep = R.P[k].id === id && R.P[k].w + R.P[k].l >= w + l;
      R.P[k] = { id, name, ws, w: keep ? R.P[k].w : w, l: keep ? R.P[k].l : l }; me = k;
      lbSet(id, name, R.P[k].w, R.P[k].l);
      if (old && old !== ws) old.close();
      return push(R);
    }
    if (!R || me < 0) return;
    const S = R.S;

    if (m.t == 'chat') {
      const text = String(m.text || '').trim().slice(0, 200);
      if (!text) return;
      R.chat.push({ f: me, n: R.P[me].name, text }); R.chat = R.chat.slice(-40);
      return send(R);
    }
    if (m.t == 'start') {
      if (!S.started && S.win < 0) { S.started = true; S.turn = Math.floor(Math.random() * 4); push(R); }
      return;
    }
    if (m.t == 'reset') { if (S.win >= 0) { R.S = fresh(); push(R); } return; }

    if (!S.started || S.turn != me || S.win >= 0) return;
    if (m.t == 'roll' && !S.dice) doRoll(R, me);
    if (m.t == 'move' && S.dice) doMove(R, me, +m.i);
  });

  ws.on('close', () => {
    if (R && me >= 0 && R.P[me].ws === ws) { R.P[me].ws = null; push(R); }
  });
});

// پاک‌سازی بازی‌های خالی و قدیمی (بیش از ۳۰ دقیقه بدون کاربر)
setInterval(() => {
  for (const [c, R] of rooms) if (!humans(R) && Date.now() - R.t > 30 * 60 * 1000) { clearTimeout(R.bt); rooms.delete(c); }
}, 5 * 60 * 1000);

srv.listen(process.env.PORT || 3000, () => console.log('server is running'));

// جلوگیری از خاموش شدن سرور در Render
const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF) setInterval(() => fetch(SELF + '/ping').catch(() => {}), 10 * 60 * 1000);
