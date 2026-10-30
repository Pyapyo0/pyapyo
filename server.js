// Kuis Kelas Online - server tanpa dependensi (hanya Node.js bawaan).
// Jalankan: node server.js   (Node 14 ke atas)
const http = require('http'), fs = require('fs'), path = require('path');
const os = require('os'), zlib = require('zlib'), crypto = require('crypto'), util = require('util');
const gzipAsync = util.promisify(zlib.gzip);

const PORT = +process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const rooms = new Map();
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const nk = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const rnd = n => crypto.randomBytes(n).toString('hex');

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CHARS[crypto.randomInt(CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const frame = (event, data) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
// droppable = frame yang boleh dilewati kalau HP/koneksi siswa sedang lambat (stats & ping selalu diganti yang terbaru)
function sseRaw(res, str, droppable) {
  try { if (droppable && res.writableLength > 32768) return; res.write(str); } catch (e) {}
}
function sse(res, event, data) { sseRaw(res, frame(event, data), false); }
function json(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (body.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); res.end(zlib.gzipSync(body));
  } else { res.writeHead(code, h); res.end(body); }
}
function readBody(req, limit) {
  return new Promise((ok, no) => {
    let n = 0; const a = [];
    req.on('data', c => { n += c.length; if (n > limit) { no(new Error('too big')); req.destroy(); } else a.push(c); });
    req.on('end', () => { try { ok(a.length ? JSON.parse(Buffer.concat(a).toString('utf8')) : {}); } catch (e) { no(e); } });
    req.on('error', no);
  });
}
function hostOf(q) {
  const r = rooms.get(String(q.code || '').toUpperCase());
  return r && r.key === q.key ? r : null;
}
function stuOf(q) {
  const r = rooms.get(String(q.code || '').toUpperCase());
  const s = r && r.students.get(q.sid);
  return s && s.token === q.token ? { r, s } : null;
}
function toHost(r, event, data) {
  if (r.host) sse(r.host, event, data);
  else { r.buf.push([event, data]); if (r.buf.length > 300) r.buf.shift(); }
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push('http://' + i.address + ':' + PORT);
  return out;
}
const fcache = new Map();
function file(req, res, name) {
  const fp = path.join(PUB, name);
  const out = c => {
    const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (/gzip/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); res.end(c.gz); }
    else { res.writeHead(200, h); res.end(c.raw); }
  };
  fs.stat(fp, (e, st) => {
    if (e) { res.writeHead(404); return res.end('File ' + name + ' tidak ditemukan'); }
    const c = fcache.get(name);
    if (c && c.m === st.mtimeMs) return out(c);
    fs.readFile(fp, (e2, d) => {
      if (e2) { res.writeHead(404); return res.end('File ' + name + ' tidak ditemukan'); }
      zlib.gzip(d, { level: 6 }, (e3, gz) => { const n = { m: st.mtimeMs, raw: d, gz: gz || d }; fcache.set(name, n); out(n); });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = Object.fromEntries(u.searchParams);
  try {
    if (req.method === 'GET') {
      if (p === '/' || p === '/siswa') return file(req, res, 'siswa.html');
      if (p === '/guru') return file(req, res, 'guru.html');
      if (p === '/api/info') return json(req, res, 200, { urls: lanUrls(), port: PORT });
      if (p === '/api/room') {
        const r = rooms.get(String(q.code || '').toUpperCase());
        if (!r || !r.meta) return json(req, res, 404, { error: 'Kode kelas tidak ditemukan' });
        return json(req, res, 200, { title: r.meta.title, roster: r.meta.roster || [], ended: r.ended });
      }
      if (p === '/api/q') {
        const x = stuOf(q), i = +q.i, it = x && x.r.items && x.r.items[i];
        if (!it) return json(req, res, 404, { error: 'Soal tidak ada' });
        const qc = x.r.qc || (x.r.qc = new Map());
        let e = qc.get(i);
        if (!e) {
          const raw = Buffer.from(JSON.stringify(it));
          e = { raw, gzp: raw.length > 1024 ? gzipAsync(raw, { level: 6 }) : null };
          qc.set(i, e);
        }
        const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=300', Vary: 'Accept-Encoding' };
        if (e.gzp && /gzip/.test(req.headers['accept-encoding'] || '')) {
          const gz = await e.gzp; h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(gz);
        }
        res.writeHead(200, h); return res.end(e.raw);
      }
      if (p === '/api/host/events') {
        const r = hostOf(q); if (!r) { res.writeHead(403); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        if (r.host) try { r.host.end(); } catch (e) {}
        r.host = res; sse(res, 'hello', {});
        r.buf.splice(0).forEach(m => sse(res, m[0], m[1]));
        r.students.forEach(s => { if (s.res) sse(res, 'join', { sid: s.sid, name: s.name }); });
        req.on('close', () => { if (r.host === res) r.host = null; });
        return;
      }
      if (p === '/api/student/events') {
        const x = stuOf(q); if (!x) { res.writeHead(403); return res.end(); }
        const { r, s } = x;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        if (s.res) try { s.res.end(); } catch (e) {}
        s.res = res; sse(res, 'hello', { ended: r.ended });
        toHost(r, 'join', { sid: s.sid, name: s.name });
        req.on('close', () => { if (s.res === res) { s.res = null; s.seen = Date.now(); toHost(r, 'leave', { sid: s.sid, name: s.name }); } });
        return;
      }
      res.writeHead(404); return res.end('Tidak ditemukan');
    }
    if (req.method === 'POST') {
      const b = await readBody(req, p === '/api/host/quiz' ? 200 * 1024 * 1024 : p === '/api/host/send' ? 20 * 1024 * 1024 : 256 * 1024);
      if (p === '/api/host/create') {
        const code = newCode(), key = rnd(12);
        rooms.set(code, { code, key, host: null, buf: [], students: new Map(), meta: null, items: null, ended: false, t: Date.now() });
        return json(req, res, 200, { code, key });
      }
      if (p === '/api/host/quiz') {
        const r = hostOf(b); if (!r) return json(req, res, 403, { error: 'Akses ditolak' });
        r.meta = b.meta || {}; r.items = b.items || []; r.qc = new Map(); r.t = Date.now();
        return json(req, res, 200, { ok: true });
      }
      if (p === '/api/host/send') {
        const r = hostOf(b); if (!r) return json(req, res, 403, { error: 'Akses ditolak' });
        r.t = Date.now();
        for (const m of b.msgs || []) {
          const str = frame(m.event, m.data), drop = m.event === 'stats';
          if (m.to === 'all') r.students.forEach(s => s.res && sseRaw(s.res, str, drop));
          else { const s = r.students.get(m.to); if (s && s.res) sseRaw(s.res, str, false); }
        }
        return json(req, res, 200, { ok: true });
      }
      if (p === '/api/host/end') {
        const r = hostOf(b); if (!r) return json(req, res, 403, { error: 'Akses ditolak' });
        r.ended = true; setTimeout(() => rooms.delete(r.code), 15 * 60 * 1000);
        return json(req, res, 200, { ok: true });
      }
      if (p === '/api/join') {
        const r = rooms.get(String(b.code || '').toUpperCase());
        if (!r || !r.meta) return json(req, res, 404, { error: 'Kode kelas tidak ditemukan. Cek lagi kodenya.' });
        if (r.ended) return json(req, res, 409, { error: 'Kuis ini sudah selesai.' });
        let name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        if (!name) return json(req, res, 400, { error: 'Isi namamu dulu.' });
        const roster = r.meta.roster || [];
        if (roster.length) {
          const f = roster.find(n => nk(n) === nk(name));
          if (!f) return json(req, res, 400, { error: 'Nama tidak ada di daftar kelas.' });
          name = f;
        }
        for (const s of r.students.values()) {
          if (nk(s.name) !== nk(name)) continue;
          if (b.token && b.token === s.token) return json(req, res, 200, { sid: s.sid, token: s.token, name: s.name, meta: r.meta });
          if (s.res) return json(req, res, 409, { error: 'Nama itu sedang dipakai. Pakai nama lain (mis. tambah inisial).' });
          s.token = rnd(12); // ambil alih nama yang sedang terputus
          return json(req, res, 200, { sid: s.sid, token: s.token, name: s.name, meta: r.meta });
        }
        const s = { sid: rnd(6), token: rnd(12), name, res: null, seen: Date.now() };
        r.students.set(s.sid, s);
        return json(req, res, 200, { sid: s.sid, token: s.token, name: s.name, meta: r.meta });
      }
      if (p === '/api/act') {
        const x = stuOf(b); if (!x) return json(req, res, 403, { error: 'Sesi tidak valid' });
        if (!['pesan', 'lepas', 'jawab', 'pilih'].includes(b.type)) return json(req, res, 400, { error: 'Aksi tidak dikenal' });
        toHost(x.r, b.type, { sid: x.s.sid, name: x.s.name, data: b.data || {} });
        return json(req, res, 200, { ok: true });
      }
      res.writeHead(404); return res.end();
    }
    res.writeHead(405); res.end();
  } catch (e) {
    try { json(req, res, 400, { error: 'Permintaan tidak valid' }); } catch (x) {}
  }
});

setInterval(() => {
  rooms.forEach(r => {
    const pg = frame('ping', {});
    r.students.forEach(s => s.res && sseRaw(s.res, pg, true));
    if (r.host) sse(r.host, 'ping', {});
    if (Date.now() - r.t > 12 * 3600 * 1000 && !r.host) rooms.delete(r.code);
  });
}, 15000);

server.on('connection', sock => { sock.setNoDelay(true); sock.setKeepAlive(true, 30000); });
server.keepAliveTimeout = 65000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n=== Kuis Kelas Online ===');
  console.log('Halaman guru  : http://localhost:' + PORT + '/guru');
  const l = lanUrls();
  console.log('Siswa buka    : ' + (l.length ? l.map(x => x + '/').join('  atau  ') : 'http://IP-LAPTOP:' + PORT + '/'));
  console.log('(laptop dan HP siswa harus di WiFi yang sama)\n');
});
