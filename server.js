const http = require('http'), fs = require('fs');
const { WebSocketServer } = require('ws');

const html = fs.readFileSync(__dirname + '/index.html');
const srv = http.createServer((q, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(html);
});
const wss = new WebSocketServer({ server: srv });
const rooms = {};
const ab = (p, s) => (p * 20 + s) % 40;

// مقصد حرکت مهره i بازیکن p با تاس d (یا null اگه نشه)
function can(S, p, i, d) {
  const s = S.pcs[p * 4 + i]; let t;
  if (s < 0) { if (d != 6) return null; t = 0; }
  else { t = s + d; if (t > 43) return null; }
  for (let j = 0; j < 4; j++) if (j != i && S.pcs[p * 4 + j] == t) return null;
  return t;
}

function send(R, note) {
  const n = R.ws.filter(Boolean).length;
  R.ws.forEach((w, k) => w && w.readyState == 1 &&
    w.send(JSON.stringify({ me: k, S: { ...R.S, n }, note })));
}

wss.on('connection', ws => {
  let R = null, me = -1;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t == 'join') {
      const c = String(m.code).slice(0, 30);
      const room = rooms[c] = rooms[c] || { code: c, ws: [null, null],
        S: { turn: 0, dice: 0, win: -1, pcs: Array(8).fill(-1) } };
      const slot = room.ws.findIndex(w => !w);
      if (slot < 0) return ws.send(JSON.stringify({ err: 'اتاق پر است' }));
      R = room; me = slot; R.ws[me] = ws;
      return send(R);
    }

    if (!R) return;
    const S = R.S;
    if (R.ws.filter(Boolean).length < 2 || S.turn != me || S.win >= 0) return;

    if (m.t == 'roll' && !S.dice) {
      const d = 1 + Math.floor(Math.random() * 6);
      let any = false;
      for (let i = 0; i < 4; i++) if (can(S, me, i, d) != null) any = true;
      if (any) { S.dice = d; send(R); }
      else { S.turn = 1 - me; send(R, 'تاس ' + d + ' آمد — حرکتی نبود!'); }
    }

    if (m.t == 'move' && S.dice) {
      const i = +m.i, d = S.dice, t = can(S, me, i, d);
      if (t == null) return;
      S.pcs[me * 4 + i] = t;
      if (t < 40) { // زدن مهره حریف
        const o = 1 - me;
        for (let j = 0; j < 4; j++) {
          const s2 = S.pcs[o * 4 + j];
          if (s2 >= 0 && s2 < 40 && ab(o, s2) == ab(me, t)) S.pcs[o * 4 + j] = -1;
        }
      }
      if ([0, 1, 2, 3].every(j => S.pcs[me * 4 + j] >= 40)) S.win = me;
      S.turn = d == 6 ? me : 1 - me;
      S.dice = 0;
      send(R);
    }
  });

  ws.on('close', () => {
    if (R && R.ws[me] === ws) {
      R.ws[me] = null;
      if (!R.ws[0] && !R.ws[1]) delete rooms[R.code]; else send(R);
    }
  });
});

srv.listen(process.env.PORT || 3000, () => console.log('server is running'));
