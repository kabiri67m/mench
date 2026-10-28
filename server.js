const http = require('http'), fs = require('fs');
const { WebSocketServer } = require('ws');

const path = require('path');
const html = fs.readFileSync(__dirname + '/index.html');
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const srv = http.createServer((q, r) => {
  let name = '';
  try { name = path.basename(decodeURIComponent(q.url.split('?')[0])); } catch {}
  const type = TYPES[path.extname(name).toLowerCase()];
  if (type && name.startsWith('photo')) {          // فقط عکس‌هایی که اسمشون photo... شروع می‌شه
    return fs.readFile(path.join(__dirname, name), (e, d) => {
      if (e) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      r.end(d);
    });
  }
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(html);
});
const wss = new WebSocketServer({ server: srv });

const ab = (p, s) => (p * 20 + s) % 40;
const fresh = () => ({ turn: 0, dice: 0, win: -1, pcs: Array(8).fill(-1) });
let S = fresh();
let chat = [];
const P = [{ id: null, name: '', ws: null }, { id: null, name: '', ws: null }];

function can(p, i, d) {
  const s = S.pcs[p * 4 + i]; let t;
  if (s < 0) { if (d != 6) return null; t = 0; }
  else { t = s + d; if (t > 43) return null; }
  for (let j = 0; j < 4; j++) if (j != i && S.pcs[p * 4 + j] == t) return null;
  return t;
}

function push(note) {
  const n = P.filter(p => p.ws).length;
  const names = P.map(p => p.name);
  P.forEach((p, k) => p.ws && p.ws.readyState == 1 &&
    p.ws.send(JSON.stringify({ me: k, S: { ...S, n, names }, chat, note })));
}

wss.on('connection', ws => {
  let me = -1;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t == 'join') {
      const id = String(m.id).slice(0, 40);
      const name = String(m.name || '').trim().slice(0, 20) || 'عشقم';
      let k = P.findIndex(p => p.id === id);          // خودش برگشته
      if (k < 0) k = P.findIndex(p => !p.ws);         // جای خالی
      if (k < 0) return ws.send(JSON.stringify({ err: 'این اتاق فقط برای دو نفره 💕' }));
      const old = P[k].ws;
      P[k] = { id, name, ws }; me = k;
      if (old && old !== ws) old.close();
      return push();
    }

    if (me < 0) return;

    if (m.t == 'chat') {
      const text = String(m.text || '').trim().slice(0, 200);
      if (!text) return;
      chat.push({ f: me, text, t: Date.now() });
      chat = chat.slice(-40);
      return push();
    }

    if (m.t == 'reset') {
      if (S.win >= 0) { S = fresh(); push(); }
      return;
    }

    if (P.filter(p => p.ws).length < 2 || S.turn != me || S.win >= 0) return;

    if (m.t == 'roll' && !S.dice) {
      const d = 1 + Math.floor(Math.random() * 6);
      let any = false;
      for (let i = 0; i < 4; i++) if (can(me, i, d) != null) any = true;
      if (any) { S.dice = d; push(); }
      else { S.turn = 1 - me; push('تاس ' + d + ' آمد — حرکتی نبود!'); }
    }

    if (m.t == 'move' && S.dice) {
      const i = +m.i, d = S.dice, t = can(me, i, d);
      if (t == null) return;
      S.pcs[me * 4 + i] = t;
      if (t < 40) {
        const o = 1 - me;
        for (let j = 0; j < 4; j++) {
          const s2 = S.pcs[o * 4 + j];
          if (s2 >= 0 && s2 < 40 && ab(o, s2) == ab(me, t)) S.pcs[o * 4 + j] = -1;
        }
      }
      if ([0, 1, 2, 3].every(j => S.pcs[me * 4 + j] >= 40)) S.win = me;
      S.turn = d == 6 ? me : 1 - me;
      S.dice = 0;
      push();
    }
  });

  ws.on('close', () => {
    if (me >= 0 && P[me].ws === ws) { P[me].ws = null; push(); }
  });
});

srv.listen(process.env.PORT || 3000, () => console.log('server is running'));
