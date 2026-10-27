'use strict';
/**
 * ============================================================
 * Jatmiko Farm Layer — Frontend (js/app.js)
 * Arsitektur SPA statis (GitHub Pages) + REST API Google Apps Script (fetch POST); semua navigasi lewat navigateTo().
 * Token sesi disimpan di memori (App.token), TIDAK PERNAH di URL.
 * ============================================================
 */

const TZ = 'Asia/Jakarta';

// Logo aplikasi (logo orange Jatmiko, WebP 360px transparan) disimpan di img/logo.webp.
// Dipakai di layar muat, login, header, dan sidebar.
const APP_LOGO = 'img/logo.webp';

const App = {
  token: null, user: null, config: {}, floks: [], petugas: [], lastError: '',
  page: null, seq: 0, flokId: null, confirmFn: null, charts: {},
  input: { tanggal: null, ctx: null, form: null },
  obat: { tanggal: null, ctx: null, form: null },
  riwayat: { tab: 'harian', q: '', periode: 7, flok: '', data: null },
  dash: { hari: 7, groupBy: 'hari', flok: '', data: null },
  kelola: { tab: 'flok', data: null, edit: null },
  stok: { tab: 'BAHAN_BAKU', data: null, fItem: '', fJenis: '', hari: 30 }
};

// ════════════════════════════════════════════════════════
// BAGIAN 1: UTILITAS
// ════════════════════════════════════════════════════════

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* diabaikan */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* diabaikan */ } }
};

const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
function fInt(n) { return (n === null || n === undefined || isNaN(n)) ? '-' : nf0.format(n); }
function fDec(n, d) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function cap(s) { return s === 'PAGI' ? 'Pagi' : (s === 'SORE' ? 'Sore' : s); }

function hariIniWIB() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function jamWIB() { return new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }); }
function tglObj(s) { const p = String(s).split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
function tglPanjang(s) {
  if (!s) return '-';
  return tglObj(s).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function tglPendek(s) {
  if (!s) return '-';
  return tglObj(s).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const cfgNum = (k, d) => { const v = Number(String(App.config[k]).replace(',', '.')); return isFinite(v) ? v : d; };
const cfgList = k => String(App.config[k] || '').split(',').map(s => s.trim()).filter(Boolean);

function isOwner() { return !!App.user && App.user.peran === 'PEMILIK'; }
function roleLabel(p) { return p === 'PEMILIK' ? 'Pemilik' : 'Anak Kandang'; }
function activeFloks() { return App.floks.filter(f => f.status === 'AKTIF'); }
function currentFlok() {
  const a = activeFloks();
  if (!a.length) return null;
  let f = a.find(x => x.flok_id === App.flokId);
  if (!f) { f = a[0]; App.flokId = f.flok_id; }
  return f;
}
function syncFlok(f) {
  if (!f) return;
  const i = App.floks.findIndex(x => x.flok_id === f.flok_id);
  if (i >= 0) App.floks[i] = f; else App.floks.push(f);
}

// ── Toast ──
function toast(msg, type) {
  const icons = { success: 'bi-check-circle-fill', error: 'bi-exclamation-octagon-fill', warn: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill' };
  const t = type || 'info';
  const el = document.createElement('div');
  el.className = 'toast t-' + t;
  el.setAttribute('role', t === 'error' ? 'alert' : 'status');
  el.innerHTML = '<i class="bi ' + icons[t] + '"></i><span>' + esc(msg) + '</span>';
  $('#toastRoot').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, t === 'error' ? 5200 : 3200);
}

// ── Progres & tombol sibuk ──
let busyCount = 0;
function busy(delta) {
  busyCount = Math.max(0, busyCount + delta);
  $('#topProgress').classList.toggle('on', busyCount > 0);
}
function setBusyBtn(btn, on, text) {
  if (!btn) return;
  if (on) {
    if (btn.dataset.orig === undefined) btn.dataset.orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> ' + esc(text || 'Memproses...');
  } else {
    if (btn.dataset.orig !== undefined) { btn.innerHTML = btn.dataset.orig; delete btn.dataset.orig; }
    btn.disabled = false;
  }
}

// ── Pemanggil server ──
function api(fn) { return apiRaw(false, fn, Array.prototype.slice.call(arguments, 1)); }
let INFLIGHT = {};        // permintaan baca yang sedang jalan → dipakai bersama, tidak dikirim dua kali
let pendingWrites = 0;    // jumlah simpanan optimistis yang belum dikonfirmasi server
function apiRaw(senyap, fn, args) {
  const dk = /^get/.test(fn) ? fn + '|' + JSON.stringify(args) : '';
  if (!dk) INFLIGHT = {};   // ada penulisan → jangan pernah memakai bacaan yang mulai sebelum perubahan
  if (dk && INFLIGHT[dk]) {
    if (senyap) return INFLIGHT[dk];
    busy(1);
    return INFLIGHT[dk].then(r => { busy(-1); return r; }, e => { busy(-1); throw e; });
  }
  const p = apiKirim(senyap, fn, args);
  if (dk) {
    INFLIGHT[dk] = p;
    const bersih = () => { if (INFLIGHT[dk] === p) delete INFLIGHT[dk]; };
    p.then(bersih, bersih);
  }
  return p;
}
function apiKirim(senyap, fn, args) {
  if (!senyap) busy(1);
  const url = (typeof GAS_URL === 'string' ? GAS_URL : '').trim();
  if (!url || /XXXX|ISI_URL/.test(url)) {
    if (!senyap) busy(-1);
    return Promise.reject(new Error('GAS_URL belum diisi. Buka js/config.js lalu isi dengan URL /exec dari Apps Script.'));
  }
  const ctl = new AbortController();
  const tmo = setTimeout(() => ctl.abort(), 90000);
  return fetch(url, {
    method: 'POST',
    // text/plain = "simple request": tidak memicu preflight CORS yang tidak didukung Apps Script
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: fn, args: args }),
    redirect: 'follow',
    signal: ctl.signal
  })
    .then(r => {
      if (!r.ok) throw new Error('Server membalas HTTP ' + r.status);
      return r.text();
    })
    .then(txt => {
      let res;
      try { res = JSON.parse(txt); } catch (e) { throw new Error('Jawaban server bukan JSON (cek Deploy: Who has access = Anyone).'); }
      if (!senyap) busy(-1);
      if (res && res.success === false && res.message === 'SESI_HABIS') {
        forceLogout('Sesi berakhir. Silakan masuk kembali.');
        throw new Error('SESI_HABIS');
      }
      return res;
    })
    .catch(err => {
      if (!senyap && !(err && err.message === 'SESI_HABIS')) busy(-1);
      if (err && err.name === 'AbortError') throw new Error('Server terlalu lama menjawab. Coba lagi.');
      throw err;
    })
    .finally(() => clearTimeout(tmo));
}

/** Panggil server; bila gagal tampilkan toast (dengan penyebab sebenarnya) dan kembalikan null. */
async function call(fn, ...args) {
  try {
    const res = await api(fn, ...args);
    if (!res) {
      App.lastError = 'Server mengirim jawaban kosong (data tidak dapat dikirim ke browser).';
      toast(App.lastError, 'error');
      return null;
    }
    if (!res.success) {
      App.lastError = res.message || 'Terjadi kesalahan di server.';
      toast(App.lastError, 'error');
      return null;
    }
    App.lastError = '';
    if (!/^get/.test(fn)) swrClear();   // data berubah → cache baca tidak berlaku lagi
    return res;
  } catch (e) {
    if (e && e.message === 'SESI_HABIS') return null;
    const detail = String((e && e.message) || e || '').replace(/^(Error|Exception):\s*/i, '').slice(0, 180);
    App.lastError = detail;
    toast(/not found|tidak ditemukan/i.test(detail)
      ? 'Versi server belum diperbarui (fungsi tidak ditemukan). Deploy versi baru lalu muat ulang halaman.'
      : 'Gagal terhubung ke server' + (detail ? ': ' + detail : '. Periksa koneksi internet Anda.'), 'error');
    return null;
  }
}

// ── Cache baca: tampil instan dari cache, data diperbarui diam-diam di latar (stale-while-revalidate) ──
let SWR = {};          // kunci → { res, t }
let SWR_EPOCH = 0;     // naik setiap data berubah, agar jawaban basi tidak masuk cache
let swrTimer = null, pfTimer = null, pfId = 0;

/** Argumen pemanggilan tiap halaman. Dipakai renderer DAN pemuatan awal, jadi kuncinya selalu sama. */
function specs() {
  const f = currentFlok(), o = isOwner(), hari = hariIniWIB(), L = {};
  if (f) {
    L.input = ['getInputContext', App.token, f.flok_id, o ? (App.input.tanggal || hari) : hari];
    L.obat = ['getObatContext', App.token, f.flok_id, o ? (App.obat.tanggal || hari) : hari];
  }
  L.riwayat = ['getRiwayat', App.token, { hari: o ? App.riwayat.periode : 7, flok_id: App.riwayat.flok }];
  L.stok = ['getStok', App.token];
  if (o) {
    L.dashboard = ['getDashboard', App.token, { flok_id: App.dash.flok, hari: App.dash.hari, groupBy: App.dash.groupBy }];
    L.kelola = ['getKelola', App.token];
  }
  return L;
}
function swrKey(a) { return a[0] + '|' + JSON.stringify(a.slice(2)); }
function swrAda(a) { return !!SWR[swrKey(a)]; }
function swrSet(a, res) { SWR[swrKey(a)] = { res: res, t: Date.now() }; swrSimpan(); }
let tulisHalaman = null, tulisT = 0;
function swrClear() {
  // v4.1: data lama TIDAK dibuang (menu lain tetap tampil instan), hanya ditandai basi lalu disegarkan di latar.
  Object.keys(SWR).forEach(k => { if (SWR[k]) SWR[k].basi = true; });
  SWR_EPOCH++; INFLIGHT = {};
  tulisHalaman = App.page; tulisT = Date.now();
  swrSimpan();
  clearTimeout(pfTimer);
  pfTimer = setTimeout(() => prefetchHalaman(true), 250);
}
function swrSimpan() {
  clearTimeout(swrTimer);
  swrTimer = setTimeout(() => {
    if (!App.user) return;
    try {
      const j = JSON.stringify({ u: App.user.email, d: SWR });
      if (j.length < 900000) store.set('agl_swr', j);
    } catch (e) { /* diabaikan */ }
  }, 800);
}
function swrMuat() {
  try {
    const o = JSON.parse(store.get('agl_swr') || 'null');
    if (!o || !App.user || o.u !== App.user.email) return;
    Object.keys(o.d || {}).forEach(k => { if (Date.now() - o.d[k].t < 12 * 3600 * 1000 && !SWR[k]) SWR[k] = o.d[k]; });
  } catch (e) { /* diabaikan */ }
}
/** Pengguna sedang mengetik / membuka lembar: jangan menggambar ulang halaman dari bawah tangannya. */
function sibuk() {
  const ae = document.activeElement, c = $('#app-container');
  if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && c && c.contains(ae)) return true;
  const sr = $('#sheetRoot');
  if (sr && sr.firstChild) return true;
  const f = App.input && App.input.form;
  if (App.page === 'input' && f && (f.ta || f.tb || f.tbs || f.kg || f.pakan || f.catatan || f.mati || f.afkir)) return true;
  return false;
}
/**
 * Muat data halaman. Bila ada cache → paint() langsung (0 ms), lalu ambil data baru di latar dan paint ulang
 * hanya bila isinya berbeda. Tanpa cache → seperti biasa (skeleton + tunggu server). Mengembalikan true bila ada yang tampil.
 */
async function loadSWR(seq, a, paint, gagal) {
  const key = swrKey(a), epoch = SWR_EPOCH;
  let hit = SWR[key];
  // halaman yang baru saja diubah user: jangan tampilkan data lama sesaat (bisa membingungkan) — tunggu data baru
  if (hit && hit.basi && tulisHalaman === App.page && Date.now() - tulisT < 10000) hit = null;
  if (hit) paint(hit.res.data, false);
  let res;
  if (hit) {
    if (!hit.basi && Date.now() - hit.t < 8000) return true;   // masih sangat segar: tidak perlu tanya server lagi
    if (pendingWrites > 0) return true;                        // ada simpanan yang belum selesai: jangan timpa tampilan
    try { res = await api(...a); } catch (e) { return true; }   // gagal di latar: cache tetap tampil, tanpa toast
    if (!res || !res.success) return true;
  } else {
    res = await call(...a);
  }
  if (!res) { if (seq === App.seq && gagal) gagal(); return false; }
  kabarkanBersih(res.data);
  if (epoch === SWR_EPOCH) SWR[key] = { res: res, t: Date.now() };
  swrSimpan();
  if (seq !== App.seq) return true;
  if (hit && JSON.stringify(hit.res.data) === JSON.stringify(res.data)) return true;
  if (hit && sibuk()) return true;
  if (hit) { const ac = $('#app-container'); if (ac) ac.classList.add('no-anim'); }   // gambar ulang diam-diam, tanpa animasi masuk
  paint(res.data, true);
  return true;
}
/** Beri tahu bila server menghapus otomatis resep sekali pakai yang hasilnya sudah habis (hanya sekali per jawaban baru). */
function kabarkanBersih(d) {
  if (d && d.dibersihkan && d.dibersihkan.length) {
    toast('Resep ' + d.dibersihkan.map(n => '"' + n + '"').join(', ') + ' dihapus otomatis: pakan hasil produksinya sudah habis terpakai.', 'info');
    d.dibersihkan = [];
  }
}
/** Muat semua menu lain di latar (berurutan, senyap) sehingga berpindah menu terasa instan. */
async function prefetchHalaman(segera) {
  const id = ++pfId;
  await new Promise(r => setTimeout(r, segera ? 0 : 300));
  if (id !== pfId || !App.token || !App.user || pendingWrites > 0) return;
  const urut = isOwner() ? ['input', 'riwayat', 'stok', 'obat', 'kelola', 'dashboard'] : ['riwayat', 'obat', 'stok', 'input'];
  const L = specs(), perlu = [];
  urut.forEach(pg => {
    const a = L[pg];
    if (!a || pg === App.page) return;
    const h = SWR[swrKey(a)];
    if (h && !h.basi && Date.now() - h.t < 20000) return;
    perlu.push(a);
  });
  if (!perlu.length) return;
  // v4.1: 3 halaman per permintaan (BATCH), potongan dikirim paralel → semua menu siap dalam ±1 putaran jaringan
  const potong = [];
  for (let i = 0; i < perlu.length; i += 3) potong.push(perlu.slice(i, i + 3));
  const epoch = SWR_EPOCH;
  await Promise.all(potong.map(async grup => {
    try {
      const r = await apiRaw(true, 'getBatch', [App.token, grup.map(a => [a[0], a.slice(2)])]);
      if (!r || !r.success || !Array.isArray(r.data)) return;
      if (id !== pfId || epoch !== SWR_EPOCH || pendingWrites > 0) return;
      r.data.forEach((x, k) => {
        if (x && x.success === false && x.message === 'SESI_HABIS') { forceLogout('Sesi berakhir. Silakan masuk kembali.'); return; }
        if (x && x.success) { kabarkanBersih(x.data); SWR[swrKey(grup[k])] = { res: x, t: Date.now() }; }
      });
    } catch (e) { /* offline / gagal: cache lama tetap dipakai */ }
  }));
  swrSimpan();
}

// ── Lembar modal (bottom sheet) ──
function openSheet(title, html) {
  $('#sheetRoot').innerHTML =
    '<div class="sheet-backdrop" onclick="if(event.target===this)closeSheet()">' +
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
    '<div class="sheet-head"><h3>' + esc(title) + '</h3>' +
    '<button class="icon-btn" aria-label="Tutup" onclick="closeSheet()"><i class="bi bi-x-lg"></i></button></div>' +
    html + '</div></div>';
  document.body.classList.add('no-scroll');
}
function closeSheet() {
  const r = $('#sheetRoot');
  if (r) r.innerHTML = '';
  document.body.classList.remove('no-scroll');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function confirmSheet(o) {
  App.confirmFn = o.onOk;
  const rows = (o.rows || []).map(r => '<div class="sum-row"><span>' + esc(r[0]) + '</span><strong>' + esc(r[1]) + '</strong></div>').join('');
  openSheet(o.title,
    (o.note ? '<p class="sheet-note">' + esc(o.note) + '</p>' : '') +
    '<div class="sum">' + rows + '</div>' +
    '<div class="sheet-actions">' +
    '<button class="btn btn-soft" onclick="closeSheet()">' + esc(o.cancelText || 'Periksa Lagi') + '</button>' +
    '<button class="btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + '" id="confirmOkBtn" onclick="runConfirm()">' + esc(o.okText || 'Ya, Simpan') + '</button>' +
    '</div>');
}
async function runConfirm() {
  const fn = App.confirmFn;
  if (!fn) return;
  const btn = $('#confirmOkBtn');
  setBusyBtn(btn, true, 'Memproses...');
  try { await fn(); } finally { setBusyBtn(btn, false); }
}

function skeleton() {
  return '<div class="skel" style="height:150px"></div><div class="skel" style="height:72px"></div>' +
    '<div class="skel" style="height:190px"></div><div class="skel" style="height:150px"></div>';
}
function errorCard(msg, retry) {
  return '<section class="card empty"><i class="bi bi-wifi-off"></i><strong>' + esc(msg) + '</strong>' +
    '<p class="sm">Periksa koneksi internet lalu coba lagi.</p>' +
    (App.lastError ? '<p class="xs muted" style="margin-top:8px;word-break:break-word">Detail: ' + esc(App.lastError) + '</p>' : '') +
    '<button class="btn btn-primary" onclick="' + retry + '"><i class="bi bi-arrow-repeat"></i> Muat Ulang</button></section>';
}
function emptyFlokHtml() {
  return '<section class="card empty"><i class="bi bi-house-add"></i><strong>Belum ada flok aktif</strong>' +
    '<p class="sm">' + (isOwner() ? 'Tambahkan flok terlebih dahulu di menu Kelola.' : 'Hubungi pemilik kandang untuk menambahkan flok.') + '</p>' +
    (isOwner() ? '<button class="btn btn-primary" onclick="navigateTo(\'kelola\')">Buka Kelola</button>' : '') + '</section>';
}

// ── Tema ──
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  store.set('agl_theme', t);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' ? '#1B0D0C' : '#ff3a3a');
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  const sw = $('#themeSw');
  if (sw) sw.checked = next === 'dark';
  if (App.page === 'dashboard' && App.dash.data) paintDashboard();
}

// ════════════════════════════════════════════════════════
// BAGIAN 2: LOGIN, SESI, KERANGKA APLIKASI
// ════════════════════════════════════════════════════════

/** Pasang logo ke semua elemen .js-logo (layar muat, header, sidebar). */
function pasangLogo() {
  $$('.js-logo').forEach(el => { el.innerHTML = '<img src="' + APP_LOGO + '" alt="Logo Jatmiko Farm Layer">'; });
}

function renderLogin(msg) {
  $('#appShell').hidden = true;
  const v = $('#loginView');
  v.hidden = false;
  v.innerHTML =
    '<div class="login-wrap"><div class="login-card card">' +
    '<div class="login-logo"><img src="' + APP_LOGO + '" alt="Logo Jatmiko Farm Layer"></div>' +
    '<h1>Jatmiko Farm Layer</h1>' +
    '<p class="muted sm" style="margin-top:4px">Recording harian kandang layer</p>' +
    '<form onsubmit="doLogin(event)" novalidate>' +
    '<label class="lbl" for="lg_user">Username</label>' +
    '<input id="lg_user" class="input" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="mis. anakkandang">' +
    '<label class="lbl" for="lg_pin">PIN</label>' +
    '<div class="pin-wrap"><input id="lg_pin" class="input" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" placeholder="••••••">' +
    '<button type="button" class="icon-btn" aria-label="Tampilkan atau sembunyikan PIN" onclick="togglePin()"><i class="bi bi-eye" id="pinEye"></i></button></div>' +
    '<label class="check"><input type="checkbox" id="lg_remember" checked> Ingat saya di perangkat ini</label>' +
    '<div id="lg_err" class="form-error" role="alert" ' + (msg ? '' : 'hidden') + '>' + esc(msg || '') + '</div>' +
    '<button class="btn btn-primary btn-xl btn-block" id="lg_btn" type="submit">Masuk</button>' +
    '</form>' +
    '<p class="foot-note"><i class="bi bi-shield-lock"></i> Hanya akun yang didaftarkan pemilik yang dapat masuk.</p>' +
    '</div></div>';
}
function togglePin() {
  const i = $('#lg_pin');
  const show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  $('#pinEye').className = 'bi ' + (show ? 'bi-eye-slash' : 'bi-eye');
}
function showLoginErr(m) {
  const e = $('#lg_err');
  if (!e) return;
  e.textContent = m;
  e.hidden = false;
}

async function doLogin(ev) {
  ev.preventDefault();
  const u = $('#lg_user').value.trim();
  const p = $('#lg_pin').value.trim();
  $('#lg_err').hidden = true;
  if (!u || !p) { showLoginErr('Isi username dan PIN terlebih dahulu.'); return; }
  const btn = $('#lg_btn');
  const remember = $('#lg_remember').checked;
  setBusyBtn(btn, true, 'Memeriksa...');
  try {
    const res = await api('loginPin', u, p);
    if (!res.success) { showLoginErr(res.message); return; }
    App.token = res.data.token;
    if (remember) store.set('agl_token', App.token); else store.del('agl_token');
    await enterApp();
  } catch (e) {
    showLoginErr('Tidak dapat terhubung ke server. Periksa koneksi internet Anda.');
  } finally {
    setBusyBtn(btn, false);
  }
}

async function enterApp() {
  const res = await api('getBootstrap', App.token);
  if (!res.success) {
    App.token = null;
    store.del('agl_token');
    renderLogin(res.message === 'SESI_HABIS' ? '' : res.message);
    return;
  }
  tampilkanApp(res.data);
}

/** Pasang data awal, bangun kerangka aplikasi, buka halaman pertama, lalu muat menu lain di latar. */
function tampilkanApp(d) {
  App.user = d.user; App.config = d.config; App.floks = d.floks; App.petugas = d.petugas;
  store.set('agl_boot', JSON.stringify(d));
  $('#loginView').hidden = true;
  $('#loginView').innerHTML = '';
  $('#appShell').hidden = false;
  buildShell();
  swrMuat();
  navigateTo(isOwner() ? 'dashboard' : 'input');
  prefetchHalaman();
}

/** Buka ulang aplikasi: kerangka & data terakhir tampil seketika dari cache, server memverifikasi di latar. */
async function segarkanBoot() {
  try {
    const res = await api('getBootstrap', App.token);   // sesi habis → api() sendiri memaksa login ulang
    if (!res || !res.success) return;
    const d = res.data, peranBerubah = !App.user || App.user.peran !== d.user.peran;
    App.user = d.user; App.config = d.config; App.floks = d.floks; App.petugas = d.petugas;
    store.set('agl_boot', JSON.stringify(d));
    if (peranBerubah) { buildShell(); navigateTo(isOwner() ? 'dashboard' : 'input'); } else renderHeader();
  } catch (e) { /* offline: tetap pakai cache */ }
}

async function refreshBootstrap() {
  const res = await call('getBootstrap', App.token);
  if (!res) return;
  const d = res.data;
  App.user = d.user; App.config = d.config; App.floks = d.floks; App.petugas = d.petugas;
  store.set('agl_boot', JSON.stringify(d));
  renderHeader();
}

function resetAppState() {
  destroyCharts();
  App.floks = []; App.config = {}; App.petugas = []; App.flokId = null; App.page = null;
  App.input = { tanggal: null, ctx: null, form: null };
  App.obat = { tanggal: null, ctx: null, form: null };
  App.riwayat = { tab: 'harian', q: '', periode: 7, flok: '', data: null };
  App.dash = { hari: 7, groupBy: 'hari', flok: '', data: null };
  App.kelola = { tab: 'flok', data: null, edit: null };
  App.stok = { tab: 'BAHAN_BAKU', data: null, fItem: '', fJenis: '', hari: 30 };
}
function forceLogout(msg) {
  App.token = null; App.user = null;
  store.del('agl_token'); store.del('agl_boot'); store.del('agl_swr');
  SWR = {}; SWR_EPOCH++; pfId++;
  resetAppState();
  closeSheet();
  renderLogin(msg || '');
}
function logout() {
  const t = App.token;
  if (t) { apiRaw(true, 'logout', [t]).catch(() => { /* diabaikan */ }); }
  forceLogout('');
}

function navItems() {
  if (isOwner()) {
    return [
      { id: 'dashboard', label: 'Dashboard', icon: 'bi-graph-up-arrow' },
      { id: 'input', label: 'Input Harian', short: 'Input', icon: 'bi-pencil-square' },
      { id: 'riwayat', label: 'Riwayat', icon: 'bi-clock-history' },
      { id: 'obat', label: 'Obat & Vaksin', short: 'Obat/Vaksin', icon: 'bi-capsule' },
      { id: 'stok', label: 'Stok', icon: 'bi-box-seam' },
      { id: 'kelola', label: 'Kelola', icon: 'bi-sliders' }
    ];
  }
  return [
    { id: 'input', label: 'Input Harian', icon: 'bi-pencil-square' },
    { id: 'riwayat', label: 'Riwayat 7 Hari', icon: 'bi-clock-history' },
    { id: 'obat', label: 'Obat & Vaksin', icon: 'bi-capsule' },
    { id: 'stok', label: 'Stok', icon: 'bi-box-seam' },
    { id: 'profil', label: 'Profil', icon: 'bi-person-vcard' }
  ];
}

function buildShell() {
  const items = navItems();
  $('#bottomNav').innerHTML = items.map(i =>
    '<button class="bn-item" data-page="' + i.id + '" onclick="navigateTo(\'' + i.id + '\')" aria-label="' + esc(i.label) + '">' +
    '<span class="bn-ico"><i class="bi ' + i.icon + '"></i></span><span>' + esc(i.short || i.label) + '</span></button>').join('');
  const side = items.concat(isOwner() ? [{ id: 'profil', label: 'Profil', icon: 'bi-person-vcard' }] : []);
  $('#sideNav').innerHTML = side.map(i =>
    '<button class="sd-item" data-page="' + i.id + '" onclick="navigateTo(\'' + i.id + '\')"><i class="bi ' + i.icon + '"></i><span>' + esc(i.label) + '</span></button>').join('');
  renderHeader();
}

function renderHeader() {
  const f = activeFloks()[0];
  $('#hdrStatus').innerHTML = f
    ? '<span class="dot"></span> ' + esc(f.nama_flok) + ' • Aktif • <span id="hdrTime">' + jamWIB() + '</span> WIB'
    : '<span class="dot off"></span> Belum ada flok aktif';
  $('#hdrUser').textContent = App.user.nama;
  $('#hdrRole').textContent = roleLabel(App.user.peran);
}
setInterval(() => { const t = $('#hdrTime'); if (t) t.textContent = jamWIB(); }, 20000);

const PAGES = {
  dashboard: () => renderDashboard(), input: () => renderInput(), riwayat: () => renderRiwayat(),
  obat: () => renderObat(), stok: () => renderStok(), kelola: () => renderKelola(), profil: () => renderProfil()
};

/** SATU-SATUNYA cara berpindah halaman. Tidak mengubah URL. */
function navigateTo(page) {
  if (!PAGES[page]) return;
  if (!isOwner() && (page === 'dashboard' || page === 'kelola')) page = 'input';
  App.page = page;
  App.seq++;
  destroyCharts();
  closeSheet();
  $$('[data-page]').forEach(b => {
    const on = b.dataset.page === page;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#app-container').classList.toggle('narrow', page === 'input' || page === 'obat' || page === 'stok' || page === 'profil');
  window.scrollTo({ top: 0 });
  $('#app-container').classList.remove('no-anim');
  PAGES[page]();
}

// ════════════════════════════════════════════════════════
// BAGIAN 3: INPUT HARIAN
// ════════════════════════════════════════════════════════

function resetInputForm() { App.input.form = { ta: '', tb: '', tbs: '', butir: '', tray: '', lepas: '', kgt: '', mati: 0, afkir: 0, pakan: '', catatan: '' }; }

async function renderInput() {
  const seq = App.seq;
  const c = $('#app-container');
  const flok = currentFlok();
  if (!flok) { c.innerHTML = emptyFlokHtml(); return; }
  if (!App.input.form) resetInputForm();
  App.input.tanggal = isOwner() ? (App.input.tanggal || hariIniWIB()) : hariIniWIB();
  const a = specs().input;
  if (!swrAda(a)) c.innerHTML = skeleton();
  await loadSWR(seq, a, d => { App.input.ctx = d; syncFlok(d.flok); paintInput(); },
    () => { c.innerHTML = errorCard('Gagal memuat form input.', 'renderInput()'); });
}

function onFlokChange(id) { App.flokId = id; resetInputForm(); App.obat.ctx = null; if (App.page === 'obat') renderObat(); else renderInput(); }
function onTanggalChange(v) { if (!v) return; App.input.tanggal = v; renderInput(); }

function flokSelectHtml() {
  const a = activeFloks();
  if (a.length < 2) return '';
  return '<div class="card" style="padding:12px"><label class="lbl" for="selFlok" style="margin:0 0 6px">Pilih Flok</label>' +
    '<select id="selFlok" class="input" onchange="onFlokChange(this.value)">' +
    a.map(f => '<option value="' + esc(f.flok_id) + '"' + (f.flok_id === App.flokId ? ' selected' : '') + '>' + esc(f.nama_flok) + (f.strain ? ' — ' + esc(f.strain) : '') + '</option>').join('') +
    '</select></div>';
}

function faseLabel(umur) { return umur < 19 ? 'Fase Pra-produksi' : 'Layer Produktif'; }

function paintInput() {
  if (App.page !== 'input') return;
  const c = $('#app-container');
  const ctx = App.input.ctx;
  const flok = ctx.flok;
  const rec = ctx.catatan;

  const tglBlok = isOwner()
    ? '<input id="f_tanggal" class="input" type="date" style="min-height:40px;width:auto;font-size:13px" max="' + hariIniWIB() + '" min="' + esc(flok.tanggal_masuk) + '" value="' + esc(ctx.tanggal) + '" onchange="onTanggalChange(this.value)" aria-label="Tanggal pencatatan">'
    : '<span class="badge b-gold"><i class="bi bi-lock-fill"></i> Kunci Server</span>';

  const info =
    '<section class="card info-card">' +
    '<div class="row-between"><div class="row gap8"><i class="bi bi-calendar3 ico-pri"></i><strong>' + esc(tglPanjang(ctx.tanggal)) + '</strong></div>' + tglBlok + '</div>' +
    '<div class="flok-row"><div><div class="eyebrow">KANDANG AKTIF</div>' +
    '<h2 class="flok-name">' + esc(flok.nama_flok) + (flok.strain ? ' — ' + esc(flok.strain) : '') + '</h2>' +
    '<p class="muted sm">' + faseLabel(flok.umur_minggu) + ' • Umur ' + flok.umur_minggu + ' Minggu</p></div>' +
    '<div class="pop-box"><span>Populasi Hidup</span><strong>' + fInt(flok.populasi_sekarang) + '</strong><small>ekor</small></div></div></section>';

  const status = '<div class="status-strip ' + (rec ? 'ok' : 'wait') + '"><i class="bi ' + (rec ? 'bi-check-circle-fill' : 'bi-pencil-square') + '"></i>' +
    '<span>' + (rec ? 'Data ' + esc(tglPendek(ctx.tanggal)) + ' sudah tersimpan' : 'Rekap harian ' + esc(tglPendek(ctx.tanggal)) + ' belum diisi') + '</span></div>';

  c.innerHTML = flokSelectHtml() + info + status + (rec ? lockedCard(rec, ctx.tanggal) : formCards(flok));
  if (!rec) updateDerived();
}

function lockedCard(rec, tanggal) {
  const tot = rec.deplesi_mati + rec.deplesi_afkir;
  const rows = [
    ['Telur', fInt(rec.telur_butir) + ' butir'],
    ...(rec.telur_tray !== null && rec.telur_tray !== undefined && rec.telur_tray !== '' ? [['Eggtray', fInt(rec.telur_tray) + ' tray + ' + fInt(rec.telur_butir_lepas) + ' butir']] : []),
    ['Rincian grade', gradeTxt(rec) || (rec.telur_tray !== null && rec.telur_tray !== undefined && rec.telur_tray !== '' ? 'Tidak dirinci (input eggtray)' : 'Tidak dirinci (data lama)')],
    ...(rec.telur_a_kg !== null && rec.telur_a_kg !== undefined && gradeButirTxt(rec) ? [['Butir per grade', gradeButirTxt(rec)]] : []),
    ['Total berat telur', rec.telur_butir > 0 ? fDec(rec.telur_kg, 1) + ' kg' : '-'],
    ['Rata-rata bobot', rec.telur_butir > 0 ? fDec(rec.berat_telur_rata2_gram, 1) + ' gr' : '-'],
    ['Deplesi', tot + ' ekor (mati ' + rec.deplesi_mati + ', afkir ' + rec.deplesi_afkir + ')'],
    ['Pakan', fDec(rec.pakan_kg, 1) + ' kg']
  ].map(r => '<div class="sum-row"><span>' + esc(r[0]) + '</span><strong>' + esc(r[1]) + '</strong></div>').join('');
  return '<section class="card"><div class="card-head"><span class="ico-badge ok"><i class="bi bi-check-circle-fill"></i></span>' +
    '<div><h3>Rekap ' + esc(tglPendek(tanggal)) + ' sudah tersimpan</h3><p class="muted sm">Diinput ' + esc(rec.diinput_oleh) + ' • ' + esc((rec.waktu_input || '').slice(11, 16)) + ' WIB</p></div></div>' +
    '<div class="sum">' + rows + '</div>' +
    (rec.catatan ? '<p class="rec-note" style="margin-top:12px">' + esc(rec.catatan) + '</p>' : '') +
    '<p class="sheet-note" style="margin-top:12px">' +
    (isOwner() ? 'Untuk mengoreksi data ini, buka menu Riwayat atau Kelola → Edit → Data Harian.' : 'Rekap harian hanya diinput sekali per tanggal dan tidak dapat diubah. Hubungi pemilik kandang bila ada kesalahan input.') + '</p>' +
    (isOwner() ? '<button class="btn btn-soft btn-block" style="margin-top:12px" onclick="navigateTo(\'riwayat\')">Buka Riwayat</button>' : '') +
    '</section>';
}

function formCards(flok) {
  const F = App.input.form;
  const tags = cfgList('tag_kondisi').map(t => '<button type="button" class="chip" data-t="' + esc(t) + '" onclick="addTag(\'f_catatan\',this.dataset.t)">+ ' + esc(t) + '</button>').join('');
  return '' +
    // Telur (pemilik: grade kg + total butir manual; anak kandang: eggtray + butir lepas + total kg)
    (isOwner() ? telurPemilikCard(F) : telurAnakCard(F)) +
    // Bobot telur (aktual = total kg ÷ butir)
    '<section class="card"><div class="card-head"><span class="ico-badge pri"><i class="bi bi-speedometer2"></i></span>' +
    '<div><h3>Rata-rata Bobot Telur</h3><p class="muted sm">Standar ' + esc(flok.strain || 'strain') + ' umur ' + flok.umur_minggu + ' mgg: ' +
    (App.input.ctx && App.input.ctx.std_berat_gr ? fDec(App.input.ctx.std_berat_gr, 1) + ' gr' : fDec(cfgNum('berat_min', 61), 0) + '–' + fDec(cfgNum('berat_max', 64), 0) + ' gr') + ' • otomatis</p></div>' +
    '<span class="badge b-muted" id="d_beratBadge">Menunggu data</span></div>' +
    '<div class="avg-box" aria-live="polite"><strong id="d_avg">-</strong><span>gram / butir</span></div>' +
    '<p class="field-hint" id="d_avgFormula">Dihitung dari total kg ÷ jumlah butir.</p></section>' +
    // Deplesi
    '<section class="card"><div class="card-head"><span class="ico-badge coral"><i class="bi bi-heart-pulse"></i></span>' +
    '<div><h3>Deplesi Populasi</h3><p class="muted sm">Mati dan afkir fisik hari ini</p></div><span class="badge b-ok" id="d_deplBadge">0 Ekor</span></div>' +
    '<div class="depl-grid">' + deplBox('mati', 'MATI', F.mati) + deplBox('afkir', 'AFKIR', F.afkir) + '</div>' +
    '<p class="status-line" id="d_deplMsg"></p></section>' +
    // Pakan
    '<section class="card"><div class="card-head"><span class="ico-badge pri"><i class="bi bi-box-seam"></i></span>' +
    '<div><h3>Pakan Diberikan</h3><p class="muted sm" id="d_pakanCtx"></p></div></div>' +
    '<div class="stepper"><button type="button" class="step-btn minus" onclick="stepField(\'pakan\',-5,0)" aria-label="Kurangi 5 kilogram">−5</button>' +
    '<div class="input-unit"><input id="f_pakan" class="input" type="number" inputmode="decimal" min="0" step="0.5" placeholder="0" value="' + esc(F.pakan) + '" oninput="onFormInput()" aria-label="Pakan diberikan (kg)" style="text-align:center;padding-left:14px"><span>Kilogram</span></div>' +
    '<button type="button" class="step-btn plus" style="background:var(--pri-surface);color:var(--pri-ink)" onclick="stepField(\'pakan\',5,0)" aria-label="Tambah 5 kilogram">+5</button></div>' +
    '<div class="pakan-stats"><div><small>Pakan per Ekor</small><strong id="d_rasio">-</strong></div>' +
    '<div class="r"><small>Total Pakan</small><strong id="d_kum">-</strong></div></div></section>' +
    // Catatan
    '<section class="card"><div class="card-head"><span class="ico-badge sky"><i class="bi bi-journal-text"></i></span>' +
    '<div><h3>Catatan Kondisi Kandang</h3><p class="muted sm">Sentuh tag cepat untuk mengisi</p></div></div>' +
    '<div class="tags">' + tags + '</div>' +
    '<textarea id="f_catatan" class="input" maxlength="300" placeholder="Tuliskan catatan tambahan lapangan..." oninput="onFormInput()" aria-label="Catatan tambahan">' + esc(F.catatan) + '</textarea></section>' +
    '<div class="lock-note"><span class="dot"></span><span>Data aman: dikunci server &amp; langsung tersimpan ke Sheets</span><i class="bi bi-cloud-check"></i></div>' +
    '<div class="savebar"><button class="btn btn-primary btn-xl btn-block" onclick="submitInput()"><i class="bi bi-save"></i> Simpan Rekap Harian</button>' +
    '<div class="savebar-sub"><button class="link-btn" type="button" onclick="resetInputUi()"><i class="bi bi-arrow-counterclockwise"></i> Atur Ulang Form</button>' +
    (isOwner() ? '' : '<span>Diisi sekali per tanggal; tidak bisa diubah anak kandang</span>') + '</div></div>';
}

/** Kartu telur PEMILIK: berat (kg) per grade + total butir diisi manual. */
function telurPemilikCard(F) {
  return '<section class="card"><div class="card-head"><span class="ico-badge gold"><i class="bi bi-egg-fried"></i></span>' +
    '<div><h3>Hasil Telur Hari Ini</h3><p class="muted sm">Isi berat (kg) tiap grade dan total butir</p></div><span class="badge b-gold">Fokus Utama</span></div>' +
    '<div class="grade-grid">' + gradeBox('telurA', 'GRADE A', F.ta, 'var(--ok-text)', 5) + gradeBox('telurB', 'GRADE B', F.tb, 'var(--gold-text)', 1) + gradeBox('telurBS', 'BS', F.tbs, 'var(--coral-text)', 0.5) + '</div>' +
    '<div class="est" aria-live="polite"><i class="bi bi-egg-fried"></i><span>Total berat telur</span><strong id="d_totalTelur">0 kg</strong></div>' +
    '<label class="lbl" for="f_butir">Total Butir Telur</label>' +
    '<div class="stepper"><button type="button" class="step-btn minus" onclick="stepField(\'butir\',-10,0)" aria-label="Kurangi 10 butir">−10</button>' +
    '<div class="input-unit"><input id="f_butir" class="input" type="number" inputmode="numeric" min="0" step="1" placeholder="0" value="' + esc(F.butir) + '" oninput="onFormInput()" aria-label="Total butir telur" style="text-align:center;padding-left:14px"><span>Butir</span></div>' +
    '<button type="button" class="step-btn plus" onclick="stepField(\'butir\',10,0)" aria-label="Tambah 10 butir">+10</button></div>' +
    '<p class="field-hint" id="d_gradeMix">Hitung semua butir hari ini. Bobot per butir dihitung otomatis.</p></section>';
}
/** Kartu telur ANAK KANDANG: eggtray + butir lepas + total kg. */
function telurAnakCard(F) {
  const isi = cfgNum('butir_per_tray', 30) || 30;
  const box = (id, label, val, warna, step, desimal, unit) =>
    '<div class="grade-box"><label for="f_' + id + '" style="color:' + warna + '">' + label + '</label>' +
    '<input id="f_' + id + '" type="number" inputmode="' + (desimal ? 'decimal' : 'numeric') + '" min="0" step="' + (desimal ? '0.1' : '1') + '" placeholder="0" value="' + esc(val) + '" oninput="onFormInput()" aria-label="' + esc(label) + ' (' + unit + ')">' +
    '<div class="grade-btns"><button type="button" onclick="stepField(\'' + id + '\',-' + step + ',0)" aria-label="Kurangi ' + step + ' ' + unit + '">−' + step + '</button>' +
    '<button type="button" class="plus" onclick="stepField(\'' + id + '\',' + step + ',0)" aria-label="Tambah ' + step + ' ' + unit + '">+' + step + '</button></div></div>';
  return '<section class="card"><div class="card-head"><span class="ico-badge gold"><i class="bi bi-egg-fried"></i></span>' +
    '<div><h3>Hasil Telur Hari Ini</h3><p class="muted sm">Isi eggtray, butir lepas, dan total berat (kg)</p></div><span class="badge b-gold">Fokus Utama</span></div>' +
    '<div class="grade-grid">' + box('tray', 'EGGTRAY', F.tray, 'var(--ok-text)', 1, false, 'tray') + box('lepas', 'BUTIR LEPAS', F.lepas, 'var(--gold-text)', 1, false, 'butir') + box('kgt', 'TOTAL KG', F.kgt, 'var(--coral-text)', 1, true, 'kg') + '</div>' +
    '<div class="est" aria-live="polite"><i class="bi bi-egg-fried"></i><span>Total telur hari ini</span><strong id="d_totalTelur">0 butir</strong></div>' +
    '<p class="field-hint" id="d_gradeMix">1 eggtray = ' + fInt(isi) + ' butir. Timbang semua telur untuk total kg.</p></section>';
}

function gradeBox(id, label, val, warna, step) {
  const l = label.toLowerCase(), st = String(step).replace('.', ',');
  return '<div class="grade-box"><label for="f_' + id + '" style="color:' + warna + '">' + label + ' (kg)</label>' +
    '<input id="f_' + id + '" type="number" inputmode="decimal" min="0" step="0.1" placeholder="0" value="' + esc(val) + '" oninput="onFormInput()" aria-label="Berat telur ' + l + ' (kilogram)">' +
    '<div class="grade-btns"><button type="button" onclick="stepField(\'' + id + '\',-' + step + ',0)" aria-label="Kurangi ' + st + ' kilogram ' + l + '">−' + st + '</button>' +
    '<button type="button" class="plus" onclick="stepField(\'' + id + '\',' + step + ',0)" aria-label="Tambah ' + st + ' kilogram ' + l + '">+' + st + '</button></div></div>';
}
/** Rincian grade telur (teks). Data baru: kilogram; data lama: butir. Kosong bila belum dirinci. */
function gradeTxt(r) {
  if (!r) return '';
  if (r.telur_a_kg !== null && r.telur_a_kg !== undefined && r.telur_a_kg !== '')
    return 'A ' + fDec(r.telur_a_kg, 1) + ' kg • B ' + fDec(r.telur_b_kg, 1) + ' kg • BS ' + fDec(r.telur_bs_kg, 1) + ' kg';
  return gradeButirTxt(r);
}
function gradeButirTxt(r) {
  if (!r || r.telur_a === null || r.telur_a === undefined || r.telur_a === '') return '';
  return 'A ' + fInt(r.telur_a) + ' • B ' + fInt(r.telur_b) + ' • BS ' + fInt(r.telur_bs);
}
/** Membagi total butir ke grade sesuai porsi berat (sisa terbesar), sama dengan server: A + B + BS = total. */
function bagiButir(total, porsi) {
  const jml = porsi[0] + porsi[1] + porsi[2];
  if (!(jml > 0) || !(total > 0)) return { a: 0, b: 0, bs: 0 };
  const eks = porsi.map(x => total * x / jml);
  const d = eks.map(Math.floor);
  let sisa = total - (d[0] + d[1] + d[2]);
  const urut = [0, 1, 2].sort((i, j) => (eks[j] - d[j]) - (eks[i] - d[i]));
  for (let n = 0; sisa > 0 && n < 30; n++, sisa--) d[urut[n % 3]]++;
  return { a: d[0], b: d[1], bs: d[2] };
}

function deplBox(id, label, val) {
  const warna = id === 'mati' ? 'var(--coral-text)' : 'var(--gold-text)';
  return '<div class="depl-box"><label for="f_' + id + '" style="color:' + warna + '">' + label + '</label>' +
    '<div class="mini-stepper"><button type="button" class="mini" onclick="stepField(\'' + id + '\',-1,0)" aria-label="Kurangi ' + label.toLowerCase() + '">−</button>' +
    '<input id="f_' + id + '" type="number" inputmode="numeric" min="0" step="1" value="' + esc(val) + '" oninput="onFormInput()" aria-label="Jumlah ' + label.toLowerCase() + ' (ekor)">' +
    '<button type="button" class="mini" onclick="stepField(\'' + id + '\',1,0)" aria-label="Tambah ' + label.toLowerCase() + '">+</button></div><small>ekor</small></div>';
}

function numVal(id) {
  const el = $('#' + id);
  if (!el) return NaN;
  const v = String(el.value).trim().replace(',', '.');
  return v === '' ? NaN : Number(v);
}
function onFormInput() {
  const F = App.input.form;
  const g = id => { const e = $('#' + id); return e ? e.value : ''; };
  F.ta = g('f_telurA'); F.tb = g('f_telurB'); F.tbs = g('f_telurBS'); F.butir = g('f_butir');
  F.tray = g('f_tray'); F.lepas = g('f_lepas'); F.kgt = g('f_kgt');
  F.mati = $('#f_mati').value; F.afkir = $('#f_afkir').value;
  F.pakan = $('#f_pakan').value; F.catatan = $('#f_catatan').value;
  $$('.invalid').forEach(e => e.classList.remove('invalid'));
  updateDerived();
}
function stepField(id, delta, min) {
  const el = $('#f_' + id);
  let v = numVal('f_' + id);
  if (isNaN(v)) v = 0;
  el.value = Math.max(min, Math.round((v + delta) * 10) / 10);
  onFormInput();
}
function setField(id, val) { $('#f_' + id).value = val; onFormInput(); }
function addTag(id, text) {
  const el = $('#' + id);
  const t = String(text).trim();
  const cur = el.value.trim();
  if (cur.split(/\s*;\s*/).indexOf(t) >= 0) return;
  el.value = cur ? cur + '; ' + t : t;
  el.dispatchEvent(new Event('input'));
}
function resetInputUi() { resetInputForm(); paintInput(); }

function updateDerived() {
  const ctx = App.input.ctx;
  if (!ctx || !$('#d_totalTelur')) return;
  const pop = ctx.flok.populasi_sekarang;
  const std = ctx.std_berat_gr;
  let kg = 0, telur = 0;
  if (isOwner()) {
    const kA = numVal('f_telurA') || 0, kB = numVal('f_telurB') || 0, kBS = numVal('f_telurBS') || 0;
    kg = Math.round((kA + kB + kBS) * 100) / 100;
    const bIn = numVal('f_butir'); telur = isNaN(bIn) ? 0 : bIn;
    $('#d_totalTelur').textContent = fDec(kg, 1) + ' kg' + (telur > 0 ? ' • ' + fInt(telur) + ' butir' : '');
    const bt = bagiButir(telur, [kA, kB, kBS]);
    $('#d_gradeMix').textContent = (telur > 0 && kg > 0)
      ? 'Butir per grade: A ' + fInt(bt.a) + ' (' + fDec(kA / kg * 100, 1) + '%) • B ' + fInt(bt.b) + ' (' + fDec(kB / kg * 100, 1) + '%) • BS ' + fInt(bt.bs) + ' (' + fDec(kBS / kg * 100, 1) + '%)'
      : 'Hitung semua butir hari ini. Bobot per butir dihitung otomatis.';
  } else {
    const tray = numVal('f_tray') || 0, lepas = numVal('f_lepas') || 0, isi = cfgNum('butir_per_tray', 30) || 30;
    kg = numVal('f_kgt') || 0;
    telur = Math.round(tray * isi) + lepas;
    $('#d_totalTelur').textContent = fInt(tray) + ' tray + ' + fInt(lepas) + ' butir = ' + fInt(telur) + ' butir';
    $('#d_gradeMix').textContent = '1 eggtray = ' + fInt(isi) + ' butir • total berat ' + fDec(kg, 1) + ' kg';
  }
  const mati = numVal('f_mati') || 0, afkir = numVal('f_afkir') || 0, pakan = numVal('f_pakan');

  // Rata-rata bobot aktual = total kg × 1000 ÷ jumlah butir
  const berat = (telur > 0 && kg > 0) ? kg * 1000 / telur : NaN;
  $('#d_avg').textContent = isNaN(berat) ? '-' : fDec(berat, 1);
  $('#d_avgFormula').textContent = isNaN(berat) ? 'Dihitung dari total kg ÷ jumlah butir.'
    : fDec(kg, 1) + ' kg × 1000 ÷ ' + fInt(telur) + ' butir = ' + fDec(berat, 2) + ' gr/butir' + (std > 0 ? ' (standar ' + fDec(std, 1) + ' gr)' : '');
  const bmin = cfgNum('berat_min', 61), bmax = cfgNum('berat_max', 64);
  const bb = $('#d_beratBadge');
  if (isNaN(berat)) { bb.className = 'badge b-muted'; bb.textContent = 'Menunggu data'; }
  else if (berat < 30 || berat > 100) { bb.className = 'badge b-coral'; bb.textContent = 'Tidak wajar'; }
  else if (std > 0 ? Math.abs(berat - std) / std <= 0.03 : (berat >= bmin && berat <= bmax)) { bb.className = 'badge b-ok'; bb.textContent = 'Sesuai standar'; }
  else { bb.className = 'badge b-gold'; bb.textContent = 'Di luar standar'; }

  const tot = mati + afkir;
  const pct = pop > 0 ? tot / pop * 100 : 0;
  const ambang = cfgNum('ambang_deplesi_persen', 0.1);
  const warn = pct > ambang;
  const db = $('#d_deplBadge');
  db.className = 'badge ' + (warn ? 'b-coral' : 'b-ok');
  db.textContent = tot + ' Ekor (' + fDec(pct, 2) + '%)';
  const dm = $('#d_deplMsg');
  dm.className = 'status-line' + (warn ? ' warn' : '');
  dm.innerHTML = '<i class="bi ' + (warn ? 'bi-exclamation-triangle-fill' : 'bi-check-circle') + '"></i><span>' +
    (warn ? 'Deplesi ' + tot + ' ekor (' + fDec(pct, 2) + '%) melewati ambang ' + fDec(ambang, 2) + '%. Tulis penyebabnya di catatan.'
      : 'Status normal: ' + tot + ' ekor (' + fDec(pct, 2) + '%), ambang toleransi harian &lt; ' + fDec(ambang, 2) + '% (' + Math.floor(pop * ambang / 100) + ' ekor)') + '</span>';

  const targetTotal = pop * cfgNum('target_pakan_gram_per_ekor', 110) / 1000;
  $('#d_pakanCtx').textContent = 'Total pakan sehari • target ' + fDec(targetTotal, 0) + ' kg';
  const total = isNaN(pakan) ? 0 : pakan;
  const zak = cfgNum('zak_kg', 50) || 50;
  $('#d_rasio').textContent = fDec(pop > 0 ? total * 1000 / pop : 0, 1) + ' gr / ekor';
  $('#d_kum').textContent = fDec(total, 0) + ' Kg (' + fDec(total / zak, 1) + ' Zak)';
}

function submitInput() {
  const ctx = App.input.ctx, owner = isOwner();
  const pop = ctx.flok.populasi_sekarang, std = ctx.std_berat_gr;
  const mati = numVal('f_mati'), afkir = numVal('f_afkir'), pakan = numVal('f_pakan');
  const errs = [];
  const bulat = v => !isNaN(v) && v >= 0 && Number.isInteger(v);
  const angkaRaw = id => { const el = $('#' + id); return el ? el.value.trim() : ''; };
  const keAngka = x => x === '' ? 0 : Number(x.replace(',', '.'));
  let telur = 0, kgFinal = 0, gNum = [0, 0, 0], bt = { a: 0, b: 0, bs: 0 }, tray = 0, lepas = 0;
  const idBerat = owner ? 'f_telurA' : 'f_kgt', idButir = owner ? 'f_butir' : 'f_tray';
  if (owner) {
    // Pemilik: berat per grade (kg) + total butir manual
    const gId = ['f_telurA', 'f_telurB', 'f_telurBS'], gRaw = gId.map(angkaRaw);
    if (gRaw.every(x => x === '')) errs.push(['f_telurA', 'Isi berat telur per grade (Grade A, Grade B, BS) dalam kg. Boleh 0.']);
    else {
      gNum = gRaw.map(keAngka);
      gNum.forEach((v, i) => { if (isNaN(v) || v < 0) errs.push([gId[i], 'Berat telur harus angka 0 atau lebih (kg).']); });
      if (!errs.length) kgFinal = Math.round((gNum[0] + gNum[1] + gNum[2]) * 100) / 100;
    }
    const bRaw = angkaRaw('f_butir');
    if (bRaw === '') errs.push(['f_butir', 'Isi total butir telur hari ini (boleh 0).']);
    else { telur = keAngka(bRaw); if (!bulat(telur)) errs.push(['f_butir', 'Total butir harus bilangan bulat (0 atau lebih).']); }
  } else {
    // Anak kandang: eggtray + butir lepas + total kg
    const raw = ['f_tray', 'f_lepas', 'f_kgt'].map(angkaRaw);
    if (raw.every(x => x === '')) errs.push(['f_tray', 'Isi jumlah eggtray, butir lepas, dan total berat (kg). Boleh 0.']);
    else {
      tray = keAngka(raw[0]); lepas = keAngka(raw[1]); kgFinal = Math.round(keAngka(raw[2]) * 100) / 100;
      if (!bulat(tray)) errs.push(['f_tray', 'Eggtray harus bilangan bulat (0 atau lebih).']);
      if (!bulat(lepas)) errs.push(['f_lepas', 'Butir lepas harus bilangan bulat (0 atau lebih).']);
      if (isNaN(kgFinal) || kgFinal < 0) errs.push(['f_kgt', 'Total berat harus angka 0 atau lebih (kg).']);
      if (!errs.length) telur = Math.round(tray * (cfgNum('butir_per_tray', 30) || 30)) + lepas;
    }
  }
  if (!errs.length) {
    if (telur > 0 && !(kgFinal > 0)) errs.push([idBerat, 'Isi total berat telur (kg).']);
    else if (kgFinal > 0 && telur <= 0) errs.push([idButir, 'Jumlah butir masih 0, padahal berat telur terisi. Isi jumlah butirnya.']);
    else if (telur > 0) {
      const avg = kgFinal * 1000 / telur;
      if (avg < 30 || avg > 100) errs.push([idBerat, 'Rata-rata bobot ' + fDec(avg, 1) + ' gr/butir tidak wajar (harus 30–100 gr). Periksa jumlah butir atau total kg.']);
    }
    if (telur > pop) errs.push([idButir, 'Total telur (' + fInt(telur) + ' butir) melebihi populasi hidup (' + fInt(pop) + '). Periksa kembali.']);
  }
  if (!bulat(mati)) errs.push(['f_mati', 'Isi jumlah ayam mati (boleh 0).']);
  if (!bulat(afkir)) errs.push(['f_afkir', 'Isi jumlah ayam afkir (boleh 0).']);
  if (bulat(mati) && bulat(afkir) && mati + afkir > pop) errs.push(['f_mati', 'Deplesi melebihi populasi hidup.']);
  if (isNaN(pakan) || pakan < 0) errs.push(['f_pakan', 'Isi jumlah pakan (kg).']);
  if (errs.length) {
    toast(errs[0][1], 'error');
    errs.forEach(e => { const el = $('#' + e[0]); if (el) el.classList.add('invalid'); });
    const first = $('#' + errs[0][0]);
    first.focus();
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  if (owner) bt = bagiButir(telur, gNum);
  const beratFinal = telur > 0 ? kgFinal * 1000 / telur : 0;
  const barisTelur = owner
    ? [['Total butir', fInt(telur) + ' butir'], ['Total berat telur', fDec(kgFinal, 1) + ' kg'],
      ['Rincian grade', 'A ' + fDec(gNum[0], 1) + ' • B ' + fDec(gNum[1], 1) + ' • BS ' + fDec(gNum[2], 1) + ' kg'],
      ['Butir per grade', 'A ' + fInt(bt.a) + ' • B ' + fInt(bt.b) + ' • BS ' + fInt(bt.bs)]]
    : [['Eggtray', fInt(tray) + ' tray + ' + fInt(lepas) + ' butir'], ['Total butir', fInt(telur) + ' butir'], ['Total berat telur', fDec(kgFinal, 1) + ' kg']];
  confirmSheet({
    title: 'Cek Sebelum Simpan',
    note: owner ? '' : 'Setelah disimpan, data tidak dapat diubah oleh anak kandang. Pastikan angkanya benar.',
    rows: [
      ['Tanggal', tglPendek(ctx.tanggal)],
      ...barisTelur,
      ['Rata-rata bobot', telur > 0 ? fDec(beratFinal, 1) + ' gr/butir' + (std > 0 ? ' (std ' + fDec(std, 1) + ')' : '') : '-'],
      ['Deplesi', (mati + afkir) + ' ekor (mati ' + mati + ', afkir ' + afkir + ')'], ['Pakan', fDec(pakan, 1) + ' kg']
    ],
    okText: 'Ya, Simpan',
    onOk: async () => {
      const payload = Object.assign({
        flok_id: ctx.flok.flok_id, tanggal: owner ? ctx.tanggal : '',
        deplesi_mati: mati, deplesi_afkir: afkir, pakan_kg: pakan,
        catatan: $('#f_catatan').value.trim()
      }, owner
        ? { telur_a_kg: gNum[0], telur_b_kg: gNum[1], telur_bs_kg: gNum[2], telur_butir: telur }
        : { telur_tray: tray, telur_butir_lepas: lepas, telur_kg: kgFinal });
      const formLama = App.input.form, cacheLama = SWR[swrKey(specs().input)];
      const rec = {
        catatan_id: '', jumlah_catatan: 1, deplesi_mati: mati, deplesi_afkir: afkir, pakan_kg: pakan, telur_butir: telur,
        telur_a: owner ? bt.a : null, telur_b: owner ? bt.b : null, telur_bs: owner ? bt.bs : null,
        telur_a_kg: owner ? gNum[0] : null, telur_b_kg: owner ? gNum[1] : null, telur_bs_kg: owner ? gNum[2] : null,
        telur_tray: owner ? null : tray, telur_butir_lepas: owner ? null : lepas, telur_kg: kgFinal,
        berat_telur_rata2_gram: telur > 0 ? Math.round(beratFinal * 100) / 100 : 0,
        catatan: payload.catatan, diinput_oleh: App.user.nama, waktu_input: hariIniWIB() + ' ' + jamWIB()
      };
      const kunciInput = specs().input;
      pendingWrites++;
      closeSheet();
      toast('Tersimpan ✓', 'success');
      resetInputForm();
      swrSet(kunciInput, { success: true, data: { tanggal: ctx.tanggal, flok: ctx.flok, std_berat_gr: ctx.std_berat_gr, catatan: rec } });
      renderInput();
      call('simpanCatatanHarian', App.token, payload).then(res => {
        pendingWrites = Math.max(0, pendingWrites - 1);
        if (res) { syncFlok(res.data.flok); swrSet(specs().input, { success: true, data: { tanggal: ctx.tanggal, flok: res.data.flok, std_berat_gr: ctx.std_berat_gr, catatan: rec } }); return; }
        // gagal → kembalikan
        const k = swrKey(kunciInput);
        if (cacheLama) SWR[k] = cacheLama; else delete SWR[k];
        App.input.form = formLama;
        if (App.page === 'input') renderInput();
        toast('Simpan dibatalkan: ' + (App.lastError || 'server tidak merespons') + ' Data belum tersimpan, silakan kirim ulang.', 'error');
      });
    }
  });
}

// ════════════════════════════════════════════════════════
// BAGIAN 4: OBAT & VAKSIN
// ════════════════════════════════════════════════════════

const METODE_INFO = {
  'Tetes Mata': 'Intraokular', 'Air Minum': 'Water line', 'Suntik IM / SC': 'Otot dada / leher',
  'Spray Halus': 'Aerosol kandang', 'Campur Pakan': 'Dicampur ke pakan'
};
const METODE_VAKSIN = ['Tetes Mata', 'Air Minum', 'Suntik IM / SC', 'Spray Halus'];
const METODE_OBAT = ['Air Minum', 'Campur Pakan', 'Suntik IM / SC', 'Spray Halus'];

function resetObatForm(jenis) {
  App.obat.form = {
    jenis: jenis || 'VAKSIN', nama: '', metode: (jenis === 'OBAT' ? 'Air Minum' : 'Tetes Mata'),
    dosis: '1.0', waktu: Number(jamWIB().slice(0, 2)) < 12 ? 'PAGI' : 'SORE',
    petugas: App.user ? App.user.nama : '', lain: false, lainTeks: '', catatan: ''
  };
}

async function renderObat() {
  const seq = App.seq;
  const c = $('#app-container');
  const flok = currentFlok();
  if (!flok) { c.innerHTML = emptyFlokHtml(); return; }
  if (!App.obat.form) resetObatForm('VAKSIN');
  App.obat.tanggal = isOwner() ? (App.obat.tanggal || hariIniWIB()) : hariIniWIB();
  const a = specs().obat;
  if (!swrAda(a)) c.innerHTML = skeleton();
  await loadSWR(seq, a, d => { App.obat.ctx = d; syncFlok(d.flok); paintObat(); },
    () => { c.innerHTML = errorCard('Gagal memuat form obat & vaksin.', 'renderObat()'); });
}

function setObatJenis(j) { resetObatForm(j); paintObat(); }
function onObatTanggal(v) { if (!v) return; App.obat.tanggal = v; renderObat(); }

function paintObat() {
  if (App.page !== 'obat') return;
  const c = $('#app-container');
  const ctx = App.obat.ctx, flok = ctx.flok, F = App.obat.form;
  const vaksin = F.jenis === 'VAKSIN';
  const tglBlok = isOwner()
    ? '<input class="input" type="date" style="min-height:40px;width:auto;font-size:13px" max="' + hariIniWIB() + '" min="' + esc(flok.tanggal_masuk) + '" value="' + esc(ctx.tanggal) + '" onchange="onObatTanggal(this.value)" aria-label="Tanggal aplikasi">'
    : '<span class="badge b-gold"><i class="bi bi-lock-fill"></i> Terkunci Server</span>';
  const lv = ctx.last_vaksin;
  const info =
    '<section class="card info-card"><div class="row-between"><div class="row gap8"><i class="bi bi-calendar3 ico-pri"></i><strong>' + esc(tglPanjang(ctx.tanggal)) + '</strong></div>' + tglBlok + '</div>' +
    '<div class="flok-row"><div class="row gap8"><span class="ico-badge pri"><i class="bi bi-house-heart"></i></span><div>' +
    '<h2 class="flok-name">' + esc(flok.nama_flok) + '</h2><p class="muted sm">' + (flok.strain ? esc(flok.strain) + ' • ' : '') + 'Umur ' + flok.umur_minggu + ' Mgg</p></div></div>' +
    '<div class="pop-box"><span>Populasi Aktif</span><strong>' + fInt(flok.populasi_sekarang) + '</strong><small>ekor</small></div></div>' +
    '<div class="vaksin-note"><i class="bi bi-shield-check"></i><span>' + (lv
      ? 'Vaksin Terakhir: <b>' + esc(lv.nama_produk) + '</b> (Umur ' + lv.umur_minggu + ' Mgg • ' + lv.hari_lalu + ' hari lalu)'
      : 'Belum ada catatan vaksinasi untuk flok ini.') + '</span></div></section>';

  const tabs = '<div class="seg" role="tablist">' +
    '<button role="tab" class="' + (vaksin ? 'active' : '') + '" aria-selected="' + vaksin + '" onclick="setObatJenis(\'VAKSIN\')"><i class="bi bi-shield-plus"></i> Vaksinasi</button>' +
    '<button role="tab" class="' + (!vaksin ? 'active' : '') + '" aria-selected="' + !vaksin + '" onclick="setObatJenis(\'OBAT\')"><i class="bi bi-capsule"></i> Obat &amp; Vitamin</button></div>';

  const katalog = cfgList(vaksin ? 'katalog_vaksin' : 'katalog_obat')
    .map(t => '<button type="button" class="chip" data-t="' + esc(t) + '" onclick="pickProduk(this.dataset.t)">+ ' + esc(t) + '</button>').join('');
  const metodes = (vaksin ? METODE_VAKSIN : METODE_OBAT).map(m =>
    '<label class="radio-card"><input type="radio" name="metode" value="' + esc(m) + '"' + (F.metode === m ? ' checked' : '') + ' onchange="onObatInput()"><span><i class="rd"></i><div><strong>' + esc(m) + '</strong><small>' + esc(METODE_INFO[m]) + '</small></div></span></label>').join('');
  const tags = cfgList('tag_reaksi').map(t => '<button type="button" class="chip" data-t="' + esc(t) + '" onclick="addTag(\'o_catatan\',this.dataset.t)">+ ' + esc(t) + '</button>').join('');
  const tim = App.petugas.length ? App.petugas : [App.user.nama];
  const medis = cfgList('tenaga_medis');
  const opt = n => '<option value="' + esc(n) + '"' + (!F.lain && n === F.petugas ? ' selected' : '') + '>' + esc(n) + '</option>';
  const petugasOpt = '<optgroup label="Tim Kandang">' + tim.map(opt).join('') + '</optgroup>' +
    (medis.length ? '<optgroup label="Tenaga Medis">' + medis.map(opt).join('') + '</optgroup>' : '') +
    '<option value="__lain__"' + (F.lain ? ' selected' : '') + '>Lainnya (ketik nama)...</option>';

  const form =
    '<section class="card"><div class="card-head"><span class="ico-badge pri"><i class="bi bi-eyedropper"></i></span><div><h3>Nama Produk / ' + (vaksin ? 'Vaksin' : 'Obat') + '</h3></div><span class="badge b-pri">Katalog SIM</span></div>' +
    '<div class="chip-scroll">' + katalog + '</div>' +
    '<input id="o_nama" class="input" maxlength="100" placeholder="Ketik nama produk" value="' + esc(F.nama) + '" oninput="onObatInput()" aria-label="Nama produk"></section>' +
    '<section class="card"><div class="card-head"><span class="ico-badge sky"><i class="bi bi-droplet-half"></i></span><div><h3>Metode Pemberian</h3></div></div><div class="radio-grid" role="radiogroup" aria-label="Metode pemberian">' + metodes + '</div></section>' +
    '<section class="card"><div class="card-head"><span class="ico-badge gold"><i class="bi bi-123"></i></span><div><h3>Dosis per Ekor / Volume</h3></div><span class="badge b-muted">Standar Lab</span></div>' +
    '<div class="stepper"><button type="button" class="step-btn minus" onclick="stepDosis(-0.1)" aria-label="Kurangi dosis">−</button>' +
    '<div class="input-unit"><input id="o_dosis" class="input" type="number" inputmode="decimal" min="0.1" step="0.1" value="' + esc(F.dosis) + '" oninput="onObatInput()" style="text-align:center;padding-left:14px;font-size:26px" aria-label="Dosis per ekor"><span>dosis / ekor</span></div>' +
    '<button type="button" class="step-btn plus" onclick="stepDosis(0.1)" aria-label="Tambah dosis">+</button></div>' +
    '<div class="calc-card"><i class="bi bi-box2"></i><div class="grow"><small id="o_calcLbl"></small><strong id="o_calcVal"></strong></div><span class="badge b-gold" id="o_calcBadge"></span></div></section>' +
    '<section class="card"><div class="form-grid two"><div><label class="lbl" style="margin-top:0">Waktu Aplikasi</label>' +
    '<div class="seg sm" role="group" aria-label="Waktu aplikasi"><button type="button" class="' + (F.waktu === 'PAGI' ? 'active' : '') + '" onclick="setObatWaktu(\'PAGI\')"><i class="bi bi-sun"></i> Pagi</button><button type="button" class="' + (F.waktu === 'SORE' ? 'active' : '') + '" onclick="setObatWaktu(\'SORE\')"><i class="bi bi-sunset"></i> Sore</button></div></div>' +
    '<div><label class="lbl" for="o_petugas" style="margin-top:0">Petugas / Tim</label><select id="o_petugas" class="input" onchange="onPetugasChange()">' + petugasOpt + '</select>' +
    '<div id="o_lainWrap" style="margin-top:8px"' + (F.lain ? '' : ' hidden') + '><input id="o_petugas_lain" class="input" maxlength="60" placeholder="Nama petugas / tenaga medis" value="' + esc(F.lainTeks) + '" oninput="onObatInput()" aria-label="Nama petugas atau tenaga medis"></div></div></div></section>' +
    '<section class="card"><div class="card-head"><span class="ico-badge sky"><i class="bi bi-journal-check"></i></span><div><h3>Reaksi &amp; Catatan Batch</h3><p class="muted sm">Ketik atau sentuh tag</p></div></div>' +
    '<div class="tags">' + tags + '</div>' +
    '<textarea id="o_catatan" class="input" maxlength="300" placeholder="Catatan no. lot, expired date, atau kondisi spuit..." oninput="onObatInput()" aria-label="Catatan batch">' + esc(F.catatan) + '</textarea></section>' +
    '<div class="savebar"><button class="btn btn-primary btn-xl btn-block" onclick="submitObat()"><i class="bi bi-save"></i> Simpan Catatan ' + (vaksin ? 'Vaksin' : 'Obat') + '</button>' +
    '<div class="savebar-sub"><button class="link-btn" type="button" onclick="resetObatForm(App.obat.form.jenis);paintObat()"><i class="bi bi-arrow-counterclockwise"></i> Reset Form Isian</button></div></div>';

  c.innerHTML = flokSelectHtml() + info + tabs + form;
  updateObatCalc();
}

function pickProduk(t) { $('#o_nama').value = t; onObatInput(); }
function stepDosis(d) {
  const el = $('#o_dosis');
  let v = Number(String(el.value).replace(',', '.'));
  if (!isFinite(v)) v = 1;
  el.value = Math.max(0.1, Math.round((v + d) * 10) / 10).toFixed(1);
  onObatInput();
}
function setObatWaktu(w) { onObatInput(); App.obat.form.waktu = w; paintObat(); }
function onObatInput() {
  const F = App.obat.form;
  if (!$('#o_nama')) return;
  F.nama = $('#o_nama').value;
  F.dosis = $('#o_dosis').value;
  const sel = $('#o_petugas').value;
  F.lain = sel === '__lain__';
  $('#o_lainWrap').hidden = !F.lain;
  if (F.lain) { F.lainTeks = $('#o_petugas_lain').value; F.petugas = F.lainTeks.trim(); } else { F.petugas = sel; }
  F.catatan = $('#o_catatan').value;
  const m = document.querySelector('input[name="metode"]:checked');
  if (m) F.metode = m.value;
  updateObatCalc();
}
function onPetugasChange() {
  onObatInput();
  if (App.obat.form.lain) { const el = $('#o_petugas_lain'); if (el) el.focus(); }
}
function obatKebutuhan() {
  const pop = App.obat.ctx.flok.populasi_sekarang;
  const dosis = Number(String(App.obat.form.dosis).replace(',', '.'));
  const cad = cfgNum('cadangan_vaksin_persen', 2);
  const perVial = cfgNum('dosis_per_vial', 500) || 500;
  const need = isFinite(dosis) && dosis > 0 ? Math.ceil(pop * dosis * (1 + cad / 100)) : 0;
  return { pop, dosis, cad, perVial, need, vial: Math.ceil(need / perVial) };
}
function updateObatCalc() {
  if (!$('#o_calcVal')) return;
  const k = obatKebutuhan();
  const vaksin = App.obat.form.jenis === 'VAKSIN';
  $('#o_calcLbl').textContent = 'Kebutuhan Flok (' + fInt(k.pop) + ' Ekor)';
  $('#o_calcVal').textContent = vaksin
    ? '~' + fInt(k.need) + ' Dosis (' + k.vial + ' Vial @ ' + fInt(k.perVial) + ' ds)'
    : '~' + fInt(k.need) + ' dosis total';
  $('#o_calcBadge').textContent = '+' + fDec(k.cad, 0) + '% Cadangan';
}

function submitObat() {
  onObatInput();
  const O = App.obat, F = O.form, ctx = O.ctx;
  const k = obatKebutuhan();
  const err = (id, m) => { toast(m, 'error'); const el = $('#' + id); if (el) { el.classList.add('invalid'); el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } };
  if (!F.nama.trim()) { err('o_nama', 'Isi nama produk terlebih dahulu.'); return; }
  if (!(k.dosis > 0)) { err('o_dosis', 'Dosis per ekor harus lebih dari 0.'); return; }
  if (!F.petugas) { err(F.lain ? 'o_petugas_lain' : 'o_petugas', 'Isi nama petugas atau tenaga medis.'); return; }
  confirmSheet({
    title: 'Cek Sebelum Simpan',
    note: isOwner() ? '' : 'Setelah disimpan, data tidak dapat diubah oleh anak kandang.',
    rows: [
      ['Tanggal', tglPendek(ctx.tanggal)], ['Jenis', F.jenis === 'VAKSIN' ? 'Vaksinasi' : 'Obat & Vitamin'],
      ['Produk', F.nama.trim()], ['Metode', F.metode], ['Dosis', fDec(k.dosis, 1) + ' dosis / ekor'],
      ['Kebutuhan flok', '~' + fInt(k.need) + ' dosis'], ['Waktu', cap(F.waktu)], ['Petugas', F.petugas]
    ],
    onOk: async () => {
      const res = await call('simpanObatVaksin', App.token, {
        flok_id: ctx.flok.flok_id, tanggal: isOwner() ? ctx.tanggal : '', jenis: F.jenis, nama_produk: F.nama.trim(),
        metode: F.metode, dosis_per_ekor: k.dosis, waktu: F.waktu, petugas: F.petugas, catatan: F.catatan.trim()
      });
      if (!res) return;
      closeSheet();
      toast(res.message, 'success');
      resetObatForm(F.jenis);
      renderObat();
    }
  });
}

// ════════════════════════════════════════════════════════
// BAGIAN 5: RIWAYAT
// ════════════════════════════════════════════════════════

async function renderRiwayat() {
  const seq = App.seq;
  const c = $('#app-container');
  const R = App.riwayat;
  const a = specs().riwayat;
  if (!swrAda(a)) c.innerHTML = skeleton();
  await loadSWR(seq, a, d => { R.data = d; paintRiwayat(); },
    () => { c.innerHTML = errorCard('Gagal memuat riwayat.', 'renderRiwayat()'); });
}

function paintRiwayat() {
  if (App.page !== 'riwayat') return;
  const R = App.riwayat;
  const c = $('#app-container');
  const harian = R.tab === 'harian';
  const flokOpt = App.floks.length > 1
    ? '<select class="input" aria-label="Filter flok" onchange="App.riwayat.flok=this.value;renderRiwayat()"><option value="">Semua flok</option>' +
    App.floks.map(f => '<option value="' + esc(f.flok_id) + '"' + (R.flok === f.flok_id ? ' selected' : '') + '>' + esc(f.nama_flok) + '</option>').join('') + '</select>' : '';
  const periode = isOwner()
    ? '<select class="input" aria-label="Periode" onchange="App.riwayat.periode=Number(this.value);renderRiwayat()">' +
    [[7, '7 hari terakhir'], [30, '30 hari terakhir'], [90, '90 hari terakhir'], [0, 'Semua data']].map(p => '<option value="' + p[0] + '"' + (R.periode === p[0] ? ' selected' : '') + '>' + p[1] + '</option>').join('') + '</select>' : '';
  c.innerHTML =
    '<div class="dash-top"><h2>' + (isOwner() ? 'Riwayat Catatan' : 'Riwayat 7 Hari') + '</h2></div>' +
    '<div class="seg" role="tablist"><button role="tab" class="' + (harian ? 'active' : '') + '" onclick="App.riwayat.tab=\'harian\';paintRiwayat()"><i class="bi bi-egg-fried"></i> Harian</button>' +
    '<button role="tab" class="' + (!harian ? 'active' : '') + '" onclick="App.riwayat.tab=\'obat\';paintRiwayat()"><i class="bi bi-capsule"></i> Obat &amp; Vaksin</button></div>' +
    '<div class="card filter-card"><div class="search"><i class="bi bi-search"></i><input class="input" type="search" placeholder="Cari catatan, produk, atau petugas" value="' + esc(R.q) + '" oninput="App.riwayat.q=this.value;paintRiwayatList()" aria-label="Cari riwayat"></div>' +
    (periode || flokOpt ? '<div class="filter-grid">' + periode + flokOpt + '</div>' : '') + '</div>' +
    '<div id="riwayatList" class="page" style="gap:10px;animation:none"></div>';
  paintRiwayatList();
}

function paintRiwayatList() {
  const R = App.riwayat;
  const box = $('#riwayatList');
  if (!box || !R.data) return;
  const q = R.q.trim().toLowerCase();
  const owner = isOwner();
  let html = '';

  if (R.tab === 'harian') {
    const items = R.data.harian.filter(r =>
      (!q || (r.catatan + ' ' + r.diinput_oleh + ' ' + r.tanggal).toLowerCase().indexOf(q) >= 0));
    if (!items.length) { box.innerHTML = '<section class="card empty"><i class="bi bi-inbox"></i><strong>Belum ada catatan</strong><p class="sm">Catatan harian yang sesuai filter akan tampil di sini.</p></section>'; return; }
    let last = '';
    const totalTgl = {};
    items.forEach(r => { totalTgl[r.tanggal] = (totalTgl[r.tanggal] || 0) + r.telur_butir; });
    items.forEach(r => {
      if (r.tanggal !== last) {
        last = r.tanggal;
        html += '<div class="day-head"><strong>' + esc(tglPendek(r.tanggal)) + '</strong><span class="badge b-sky"><i class="bi bi-egg-fried"></i> ' + fInt(totalTgl[r.tanggal]) + ' butir</span></div>';
      }
      const tot = r.deplesi_mati + r.deplesi_afkir;
      html += '<article class="rec"><div class="rec-top"><span class="badge b-pri"><i class="bi bi-calendar-check"></i> ' + (r.sesi === 'PAGI' || r.sesi === 'SORE' ? cap(r.sesi) + ' (lama)' : 'Harian') + '</span>' +
        '<span class="meta">Umur ' + r.umur_minggu + ' Mgg • ' + esc(r.diinput_oleh) + ' • ' + esc((r.waktu_input || '').slice(11, 16)) + '</span>' +
        (owner ? '<div class="rec-actions"><button class="icon-btn sm" aria-label="Koreksi catatan" onclick="editCatatan(\'' + esc(r.catatan_id) + '\')"><i class="bi bi-pencil"></i></button>' +
          '<button class="icon-btn sm danger" aria-label="Hapus catatan" onclick="hapusItem(\'harian\',\'' + esc(r.catatan_id) + '\')"><i class="bi bi-trash3"></i></button></div>' : '') + '</div>' +
        '<div class="rec-grid"><div><small>Telur</small><strong>' + fInt(r.telur_butir) + '</strong></div>' +
        '<div><small>Rata² Bobot</small><strong>' + (r.telur_butir > 0 ? fDec(r.berat_telur_rata2_gram, 1) + ' g' : '-') + '</strong></div>' +
        '<div><small>Deplesi</small><strong>' + tot + '</strong></div>' +
        '<div><small>Pakan</small><strong>' + fDec(r.pakan_kg, 1) + ' kg</strong></div></div>' +
        '<p class="xs muted">' + (gradeTxt(r) ? gradeTxt(r) + ' • ' : '') + 'Total telur ' + fDec(r.telur_kg, 1) + ' kg' + (tot > 0 ? ' • Mati ' + r.deplesi_mati + ' • Afkir ' + r.deplesi_afkir : '') + '</p>' +
        (r.catatan ? '<p class="rec-note">' + esc(r.catatan) + '</p>' : '') +
        (r.diubah_oleh ? '<p class="xs muted"><i class="bi bi-pencil-square"></i> Dikoreksi ' + esc(r.diubah_oleh) + ' • ' + esc((r.waktu_ubah || '').slice(0, 16)) + '</p>' : '') + '</article>';
    });
  } else {
    const items = R.data.obat.filter(r =>
      (!q || (r.nama_produk + ' ' + r.petugas + ' ' + r.catatan + ' ' + r.metode).toLowerCase().indexOf(q) >= 0));
    if (!items.length) { box.innerHTML = '<section class="card empty"><i class="bi bi-inbox"></i><strong>Belum ada catatan obat/vaksin</strong><p class="sm">Catatan yang sesuai filter akan tampil di sini.</p></section>'; return; }
    let last = '';
    items.forEach(r => {
      if (r.tanggal !== last) { last = r.tanggal; html += '<div class="day-head"><strong>' + esc(tglPendek(r.tanggal)) + '</strong></div>'; }
      html += '<article class="rec"><div class="rec-top"><span class="badge ' + (r.jenis === 'VAKSIN' ? 'b-pri' : 'b-sky') + '"><i class="bi ' + (r.jenis === 'VAKSIN' ? 'bi-shield-plus' : 'bi-capsule') + '"></i> ' + (r.jenis === 'VAKSIN' ? 'Vaksin' : 'Obat') + '</span>' +
        '<span class="meta">Umur ' + r.umur_minggu + ' Mgg • ' + cap(r.waktu) + ' • ' + esc(r.petugas) + '</span>' +
        (owner ? '<div class="rec-actions"><button class="icon-btn sm danger" aria-label="Hapus catatan" onclick="hapusItem(\'obat\',\'' + esc(r.id) + '\')"><i class="bi bi-trash3"></i></button></div>' : '') + '</div>' +
        '<div><strong style="font-size:15px">' + esc(r.nama_produk) + '</strong><p class="sm muted">' + esc(r.dosis_cara) + ' • kebutuhan ~' + fInt(r.kebutuhan_dosis) + ' dosis</p></div>' +
        (r.catatan ? '<p class="rec-note">' + esc(r.catatan) + '</p>' : '') + '</article>';
    });
  }
  box.innerHTML = html;
}

/** Form tambah/koreksi rekap harian. Dipakai di Riwayat dan Kelola → Edit → Data Harian. */
function formHarian(o) {
  App.formHarian = o;
  const r = o.rec || { tanggal: hariIniWIB(), telur_butir: '', telur_kg: '', deplesi_mati: 0, deplesi_afkir: 0, pakan_kg: '', catatan: '' };
  const min = o.min ? ' min="' + esc(o.min) + '"' : '';
  // Berat per grade (kg). Data baru punya kg per grade; data lama diperkirakan dari butir × rata-rata bobot tercatat,
  // dan data yang belum dirinci sama sekali: seluruh berat diisi sementara sebagai Grade A.
  const adaKg = r.telur_a_kg !== null && r.telur_a_kg !== undefined && r.telur_a_kg !== '';
  const adaGrade = r.telur_a !== null && r.telur_a !== undefined && r.telur_a !== '';
  const lama = !!o.rec && !adaKg;
  const rata = r.telur_butir > 0 ? Number(r.telur_kg) / Number(r.telur_butir) : 0;
  const pembulatan = x => Math.round(x * 100) / 100;
  let gA = '', gB = '', gBS = '';
  if (adaKg) { gA = r.telur_a_kg; gB = r.telur_b_kg; gBS = r.telur_bs_kg; }
  else if (lama && adaGrade) { gA = pembulatan(r.telur_a * rata); gB = pembulatan(r.telur_b * rata); gBS = pembulatan(r.telur_bs * rata); }
  else if (lama) { gA = pembulatan(Number(r.telur_kg) || 0); gB = 0; gBS = 0; }
  o.std = r.std_berat_gr || o.std || null;
  openSheet(o.rec ? 'Koreksi Rekap Harian' : 'Tambah Rekap Harian',
    '<div class="form-grid two">' +
    '<div><label class="lbl" for="e_tgl">Tanggal</label><input id="e_tgl" class="input" type="date" max="' + hariIniWIB() + '"' + min + ' value="' + esc(r.tanggal) + '"></div>' +
    '<div><label class="lbl" for="e_pakan">Pakan (kg)</label><input id="e_pakan" class="input" type="number" inputmode="decimal" min="0" step="0.5" value="' + esc(r.pakan_kg) + '"></div>' +
    '<div><label class="lbl" for="e_ta">Telur Grade A (kg)</label><input id="e_ta" class="input" type="number" inputmode="decimal" min="0" step="0.1" value="' + esc(gA) + '" oninput="totalEdit()"></div>' +
    '<div><label class="lbl" for="e_tb">Telur Grade B (kg)</label><input id="e_tb" class="input" type="number" inputmode="decimal" min="0" step="0.1" value="' + esc(gB) + '" oninput="totalEdit()"></div>' +
    '<div><label class="lbl" for="e_tbs">Telur BS (kg)</label><input id="e_tbs" class="input" type="number" inputmode="decimal" min="0" step="0.1" value="' + esc(gBS) + '" oninput="totalEdit()"></div>' +
    '<div><label class="lbl" for="e_butir">Total butir telur</label><input id="e_butir" class="input" type="number" inputmode="numeric" min="0" step="1" value="' + esc(r.telur_butir) + '" oninput="totalEdit()"></div>' +
    '<div><label class="lbl" for="e_mati">Deplesi mati (ekor)</label><input id="e_mati" class="input" type="number" inputmode="numeric" min="0" step="1" value="' + esc(r.deplesi_mati) + '"></div>' +
    '<div><label class="lbl" for="e_afkir">Deplesi afkir (ekor)</label><input id="e_afkir" class="input" type="number" inputmode="numeric" min="0" step="1" value="' + esc(r.deplesi_afkir) + '"></div></div>' +
    '<p class="field-hint" id="e_total"></p>' +
    (lama ? '<p class="sheet-note" style="margin-top:10px">Data lama belum memiliki berat per grade. Berat diperkirakan dari butir × rata-rata bobot tercatat; silakan sesuaikan. Total butir mengikuti kolom \"Total butir telur\".</p>' : '') +
    '<label class="lbl" for="e_cat">Keterangan</label><textarea id="e_cat" class="input" maxlength="300">' + esc(r.catatan) + '</textarea>' +
    '<p class="field-hint">Bobot per butir = total kg ÷ total butir. HD%, FCR, dan kolom lain dihitung otomatis.</p>' +
    '<div class="sheet-actions"><button class="btn btn-soft" onclick="closeSheet()">Batal</button>' +
    '<button class="btn btn-primary" id="e_save" onclick="simpanFormHarian()">' + (o.rec ? 'Simpan Koreksi' : 'Simpan') + '</button></div>');
  totalEdit();
}
/** Ringkasan di form Tambah/Koreksi: total kg, total butir manual, bobot per butir, butir per grade. */
function totalEdit() {
  const k = ['e_ta', 'e_tb', 'e_tbs'].map(id => {
    const el = $('#' + id);
    const v = el ? Number(String(el.value).replace(',', '.')) : 0;
    return isFinite(v) && v > 0 ? v : 0;
  });
  const kg = Math.round((k[0] + k[1] + k[2]) * 100) / 100;
  const el = $('#e_total');
  if (!el) return;
  const eb = $('#e_butir'), butir = eb ? Number(String(eb.value).replace(',', '.')) : NaN;
  if (!(butir > 0)) { el.textContent = 'Total telur: ' + fDec(kg, 1) + ' kg. Isi total butir untuk menghitung bobot per butir.'; return; }
  const bt = bagiButir(butir, k);
  el.textContent = 'Total telur: ' + fDec(kg, 1) + ' kg • ' + fInt(butir) + ' butir • bobot ' + (kg > 0 ? fDec(kg * 1000 / butir, 1) + ' gr/butir' : '-') +
    (kg > 0 ? ' (A ' + fInt(bt.a) + ' • B ' + fInt(bt.b) + ' • BS ' + fInt(bt.bs) + ' butir)' : '');
}
async function simpanFormHarian() {
  const o = App.formHarian;
  const btn = $('#e_save');
  const v = k => $('#' + k).value;
  const ga = [v('e_ta'), v('e_tb'), v('e_tbs')];
  if (ga.every(x => String(x).trim() === '')) { toast('Isi berat telur per grade (Grade A, Grade B, BS) dalam kg. Boleh 0.', 'error'); return; }
  if (String(v('e_butir')).trim() === '') { toast('Isi total butir telur (boleh 0).', 'error'); return; }
  const payload = {
    tanggal: v('e_tgl'), telur_a_kg: ga[0], telur_b_kg: ga[1], telur_bs_kg: ga[2], telur_butir: v('e_butir'),
    deplesi_mati: v('e_mati'), deplesi_afkir: v('e_afkir'), pakan_kg: v('e_pakan'), catatan: v('e_cat').trim()
  };
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = o.rec
    ? await call('updateCatatanHarian', App.token, Object.assign({ catatan_id: o.rec.catatan_id }, payload))
    : await call('simpanCatatanHarian', App.token, Object.assign({ flok_id: o.flok_id }, payload));
  setBusyBtn(btn, false);
  if (!res) return;
  closeSheet();
  toast(res.message, 'success');
  await refreshBootstrap();
  if (o.balik === 'kelola') muatDataEdit(); else renderRiwayat();
}
function editCatatan(id) {
  const r = (App.riwayat.data.harian || []).find(x => x.catatan_id === id);
  if (r) formHarian({ flok_id: r.flok_id, rec: r, balik: 'riwayat' });
}
function hapusItem(jenis, id, balik) {
  confirmSheet({
    title: 'Hapus Catatan?', danger: true, cancelText: 'Batal', okText: 'Ya, Hapus',
    note: 'Catatan akan disembunyikan dari laporan dan populasi dihitung ulang. Data lama tetap tersimpan di Sheets sebagai arsip.',
    rows: [],
    onOk: async () => {
      const res = await call('hapusCatatan', App.token, jenis, id);
      if (!res) return;
      closeSheet();
      toast(res.message, 'success');
      await refreshBootstrap();
      if (balik === 'kelola') muatDataEdit(); else renderRiwayat();
    }
  });
}

// ════════════════════════════════════════════════════════
// BAGIAN 6: DASHBOARD & GRAFIK
// ════════════════════════════════════════════════════════

function destroyCharts() {
  Object.keys(App.charts).forEach(k => { try { App.charts[k].destroy(); } catch (e) { /* diabaikan */ } });
  App.charts = {};
}

async function renderDashboard() {
  const seq = App.seq;
  const c = $('#app-container');
  const D = App.dash;
  const a = specs().dashboard;
  if (!swrAda(a)) c.innerHTML = skeleton();
  await loadSWR(seq, a, d => {
    D.data = d;
    if (!D.flok) {   // pilihan flok otomatis: simpan juga di bawah kunci flok sebenarnya agar kunjungan berikutnya kena cache
      const asal = swrKey(a);
      D.flok = d.flok.flok_id;
      if (SWR[asal]) SWR[swrKey(specs().dashboard)] = SWR[asal];
    }
    paintDashboard();
  }, () => { c.innerHTML = errorCard('Gagal memuat dashboard.', 'renderDashboard()'); });
}

function paintDashboard() {
  if (App.page !== 'dashboard') return;
  destroyCharts();
  const D = App.dash, d = D.data, c = $('#app-container');
  const usia = d.groupBy === 'usia';
  const k = d.kpi, hi = k.hari_ini;
  const flokSel = App.floks.length > 1
    ? '<select class="input" style="min-height:44px;width:auto" aria-label="Pilih flok" onchange="App.dash.flok=this.value;renderDashboard()">' +
    App.floks.map(f => '<option value="' + esc(f.flok_id) + '"' + (f.flok_id === D.flok ? ' selected' : '') + '>' + esc(f.nama_flok) + '</option>').join('') + '</select>' : '';

  const kpi =
    '<div class="kpi-grid">' +
    kpiCard('Populasi Hidup', fInt(k.populasi_sekarang), 'dari ' + fInt(k.populasi_awal) + ' ekor awal', 'bi-people-fill', 'pri') +
    kpiCard('Hen-Day Hari Ini', hi.ada ? fDec(hi.hen_day, 1) + '%' : '—', hi.ada ? fInt(hi.telur) + ' butir • ' + fDec(hi.telur_kg, 1) + ' kg' : 'belum ada data', 'bi-egg-fried', 'gold') +
    kpiCard('Deplesi Hari Ini', hi.ada ? fInt(hi.deplesi) : '—', hi.ada ? fDec(hi.deplesi_pct, 2) + '% dari populasi' : 'belum ada data', 'bi-heart-pulse', 'coral') +
    kpiCard('Umur Ayam', k.umur_minggu + ' Mgg', d.flok.nama_flok + (d.flok.strain ? ' • ' + d.flok.strain : ''), 'bi-calendar-week', 'sky') + '</div>';

  const insight = '<section class="insight"><h3><i class="bi bi-stars"></i> Analisis Otomatis</h3><ul>' + d.insights.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul></section>';
  const chartCard = (id, judul, ket) => '<section class="card chart-card"><h3>' + judul + '</h3><span class="sm muted">' + ket + '</span><div class="chart-box"><canvas id="' + id + '" role="img" aria-label="' + esc(judul) + '"></canvas></div></section>';
  const pk = d.puncak;
  const warnaStatus = { DI_ATAS: 'b-ok', SESUAI: 'b-ok', SEDIKIT_DI_BAWAH: 'b-gold', DI_BAWAH: 'b-coral', JAUH_DI_BAWAH: 'b-coral', BELUM_ADA: 'b-muted', TANPA_STANDAR: 'b-muted' };
  const sel = v => v === null || v === undefined ? '—' : (v >= 0 ? '+' : '−') + fDec(Math.abs(v), 1);
  let puncakHtml = '';
  if (pk) {
    puncakHtml = '<section class="card pk-card"><div class="pk-head"><h3><i class="bi bi-graph-up-arrow"></i> Analisis Puncak Produksi</h3>' +
      '<span class="badge ' + (warnaStatus[pk.status] || 'b-muted') + '">' + esc(pk.status_label) + '</span></div>' +
      '<p class="sm muted" style="margin:2px 0 10px">Minggu ke-' + pk.umur_ref + (pk.berjalan ? ' (berjalan)' : '') + ' • ' + esc(pk.fase) + ' • standar: ' + esc(pk.standar_nama || '—') + '</p>' +
      '<div class="pk-grid">' +
      '<div><small>HD aktual</small><b>' + (pk.hd_aktual === null ? '—' : fDec(pk.hd_aktual, 1) + '%') + '</b></div>' +
      '<div><small>HD standar</small><b>' + (pk.hd_standar === null ? '—' : fDec(pk.hd_standar, 1) + '%') + '</b></div>' +
      '<div><small>Selisih</small><b>' + sel(pk.selisih_poin) + ' poin</b></div>' +
      '<div><small>Puncak flok</small><b>' + (pk.puncak_aktual === null ? '—' : fDec(pk.puncak_aktual, 1) + '%') + '</b><em>' + (pk.minggu_puncak_aktual ? 'mgg ' + pk.minggu_puncak_aktual : '') + '</em></div>' +
      '<div><small>Puncak standar</small><b>' + (pk.puncak_standar === null ? '—' : fDec(pk.puncak_standar, 1) + '%') + '</b><em>' + (pk.minggu_puncak_standar ? 'mgg ' + esc(pk.minggu_puncak_standar) : '') + '</em></div>' +
      '<div><small>Bobot telur</small><b>' + (pk.berat_aktual === null ? '—' : fDec(pk.berat_aktual, 1) + ' gr') + '</b><em>' + (pk.berat_standar === null ? '' : 'std ' + fDec(pk.berat_standar, 1)) + '</em></div>' +
      '</div>' +
      '<p class="pk-text">' + esc(pk.ringkasan) + '</p>' +
      (pk.saran.length ? '<ul class="pk-list">' + pk.saran.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      (pk.catatan.length ? '<p class="sm muted">' + pk.catatan.map(esc).join('<br>') + '</p>' : '') +
      '<p class="sm muted" style="margin-top:8px"><i class="bi bi-database-check"></i> ' + (pk.hd_aktual === null ? 'Belum ada data untuk disimpan.' : 'Tersimpan otomatis di sheet ANALISIS_PRODUKSI.') + '</p>' +
      (d.riwayat_puncak && d.riwayat_puncak.length ? '<details class="pk-riwayat"><summary>Riwayat analisis tersimpan (' + d.riwayat_puncak.length + ')</summary><div class="pk-rows">' +
        d.riwayat_puncak.map(r => '<div><span>Mgg ' + r.umur + (r.status_minggu === 'FINAL' ? '' : ' •') + '</span><b>' + fDec(r.hd_aktual, 1) + '%</b><span>' + (r.hd_standar === null ? '—' : 'std ' + fDec(r.hd_standar, 1) + '%') + '</span><span>' + esc(r.status) + '</span></div>').join('') +
        '</div></details>' : '') + '</section>';
  }
  const mg = d.mingguan;
  const mingguHtml = mg && mg.baris && mg.baris.length
    ? '<section class="card chart-card wide"><h3>Grafik Performa Layer: Standar vs Aktual</h3>' +
      '<span class="sm muted">Per minggu umur • standar: ' + esc(mg.standar_nama || '—') + ' • ketuk nama garis untuk menampilkan / menyembunyikan • data tersimpan di sheet REKAP_MINGGUAN</span>' +
      '<div class="chart-box tall"><canvas id="ch6" role="img" aria-label="Grafik performa layer standar vs aktual"></canvas></div></section>'
    : '';

  c.innerHTML =
    '<div class="dash-top"><h2>Analisis ' + esc(d.flok.nama_flok) + '</h2>' + flokSel + '</div>' +
    kpi + insight + puncakHtml + mingguHtml;
  drawCharts(d);
}

function kpiCard(label, val, sub, icon, warna) {
  return '<div class="kpi"><div class="kpi-top"><label>' + esc(label) + '</label><span class="ico-badge ' + warna + '" style="width:34px;height:34px;font-size:16px"><i class="bi ' + icon + '"></i></span></div>' +
    '<strong>' + esc(val) + '</strong><small>' + esc(sub) + '</small></div>';
}

function drawCharts(d) {
  if (typeof Chart === 'undefined') {
    $$('.chart-box').forEach(b => { b.innerHTML = '<p class="muted sm" style="padding:24px;text-align:center">Pustaka grafik gagal dimuat. Periksa koneksi internet lalu muat ulang.</p>'; });
    return;
  }
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const col = {
    muted: dark ? '#D2B8AE' : '#6B5648', grid: dark ? 'rgba(255,255,255,.1)' : 'rgba(43,20,16,.1)',
    soft: dark ? '#B3433F' : '#FFB8A8', pri: dark ? '#FF5A55' : '#ff3a3a', gold: '#FFC233',
    blue: dark ? '#60A5FA' : '#2563EB', green: dark ? '#4ADE80' : '#16A34A', rose: dark ? '#F472B6' : '#D6246E', amber: '#F59E0B'
  };
  Chart.defaults.font.family = "'Plus Jakarta Sans', system-ui, sans-serif";
  Chart.defaults.color = col.muted;
  const base = (extra) => Object.assign({
    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false, position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } } },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
      y: { grid: { color: col.grid }, beginAtZero: true }
    }
  }, extra || {});
  // Grafik performa mingguan (HD, bobot telur, Kg/1000, pakan, FCR, deplesi): standar vs aktual
  const mgg = d.mingguan;
  if (mgg && mgg.baris && mgg.baris.length && $('#ch6')) {
    const B = mgg.baris, lb = B.map(x => x.umur);
    const ds = (label, key, warna, extra) => Object.assign({ label, data: B.map(x => x[key]), borderColor: warna, backgroundColor: warna, tension: .3, pointRadius: 0, borderWidth: 2, spanGaps: true, yAxisID: 'y' }, extra || {});
    const act = { pointRadius: 3, pointStyle: 'rectRot', borderWidth: 2.5 };
    const o6 = base();
    o6.plugins.legend.display = true;
    o6.plugins.legend.position = 'bottom';
    o6.plugins.tooltip = { callbacks: { title: it => 'Umur ' + it[0].label + ' minggu' } };
    o6.scales.x = { grid: { color: col.grid }, title: { display: true, text: 'Usia (minggu)' }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 21 } };
    o6.scales.y = { grid: { color: col.grid }, beginAtZero: true, suggestedMax: 130, title: { display: true, text: 'Prod. telur (%) / bobot (gr) / Kg per 1000 / pakan (gr/ekor) / deplesi (%)' } };
    o6.scales.y2 = { position: 'right', min: 0, max: 5, grid: { drawOnChartArea: false }, title: { display: true, text: 'FCR' } };
    App.charts.ch6 = new Chart($('#ch6'), {
      type: 'line',
      data: {
        labels: lb, datasets: [
          ds('Konsumsi pakan (gr/ekor/hari)', 'pakan_gr', '#7C3AED', act),
          ds('% HH Std', 'hd_std', '#E11D48', { borderDash: [] }),
          ds('% HH Act', 'hd', '#2563EB', act),
          ds('Berat telur Std (gr)', 'berat_std', '#16A34A'),
          ds('Berat telur Act (gr)', 'berat', '#166534', act),
          ds('Kg/1000 Std', 'kg1000_std', '#7F1D1D'),
          ds('Kg/1000 Act', 'kg1000', '#B45309', act),
          ds('FCR Act', 'fcr', '#EAB308', Object.assign({ yAxisID: 'y2' }, act)),
          ds('FCR Cum', 'fcr_kum', '#CA8A04', { yAxisID: 'y2', borderDash: [6, 4] }),
          ds('% Deplesi Cum', 'dep_kum', '#F97316', act)
        ]
      },
      options: o6
    });
  }
}

// ════════════════════════════════════════════════════════
// BAGIAN 7: KELOLA (FLOK, PENGGUNA, PENGATURAN)
// ════════════════════════════════════════════════════════

async function renderKelola() {
  const seq = App.seq;
  const c = $('#app-container');
  const a = specs().kelola;
  if (!swrAda(a)) c.innerHTML = skeleton();
  await loadSWR(seq, a, d => { App.kelola.data = d; paintKelola(); },
    () => { c.innerHTML = errorCard('Gagal memuat menu Kelola.', 'renderKelola()'); });
}

function paintKelola() {
  if (App.page !== 'kelola') return;
  const K = App.kelola, d = K.data, c = $('#app-container');
  if (K.edit) { paintEditFlok(); return; }
  const tab = (id, label, icon) => '<button role="tab" class="' + (K.tab === id ? 'active' : '') + '" onclick="App.kelola.tab=\'' + id + '\';paintKelola()"><i class="bi ' + icon + '"></i> ' + label + '</button>';
  let body = '';

  if (K.tab === 'flok') {
    body = '<section class="card list-card"><div class="row-between"><h3 style="font-size:16px">Daftar Flok</h3><button class="btn btn-primary btn-sm" onclick="flokSheet()"><i class="bi bi-plus-lg"></i> Tambah</button></div>' +
      (d.floks.length ? d.floks.map(f => {
        const id = esc(f.flok_id);
        const aktif = f.status === 'AKTIF';
        return '<div class="item-row wrap"><span class="ico-badge ' + (aktif ? 'pri' : 'sky') + '"><i class="bi bi-house-heart"></i></span>' +
          '<div class="grow"><strong>' + esc(f.nama_flok) + (f.strain ? ' — ' + esc(f.strain) : '') + '</strong>' +
          '<span>' + esc([f.farm, f.lokasi, f.kandang].filter(Boolean).join(' • ') || 'Farm/lokasi/kandang belum diisi') + '</span>' +
          '<span>Chick in ' + esc(tglPendek(f.tanggal_masuk)) + ' • Umur ' + f.umur_minggu + ' Mgg</span>' +
          '<div class="item-badges"><span class="badge ' + (aktif ? 'b-ok' : 'b-muted') + '">' + (aktif ? 'Aktif' : 'Selesai') + '</span>' +
          '<span class="badge b-sky">' + fInt(f.populasi_sekarang) + ' / ' + fInt(f.populasi_awal) + ' ekor</span>' +
          '<span class="badge ' + (f.ada_sheet ? 'b-ok' : 'b-coral') + '"><i class="bi bi-file-earmark-spreadsheet"></i> ' + (f.ada_sheet ? 'Sheet: ' + esc(f.nama_sheet) : 'Sheet belum ada') + '</span></div></div>' +
          '<div class="item-actions">' +
          '<button class="btn btn-soft btn-sm" onclick="bukaEditFlok(\'' + id + '\')"><i class="bi bi-pencil"></i> Edit</button>' +
          '<button class="btn btn-soft btn-sm" onclick="updateSheetFlok(\'' + id + '\',this)"><i class="bi bi-arrow-repeat"></i> Update</button>' +
          '<button class="btn btn-soft btn-sm" onclick="unduhFlok(\'' + id + '\',this)"><i class="bi bi-download"></i> Unduh</button>' +
          '<button class="btn btn-soft btn-sm" onclick="toggleFlok(\'' + id + '\',\'' + (aktif ? 'SELESAI' : 'AKTIF') + '\')"><i class="bi ' + (aktif ? 'bi-archive' : 'bi-arrow-counterclockwise') + '"></i> ' + (aktif ? 'Tutup' : 'Aktifkan') + '</button>' +
          '<button class="btn btn-sm btn-dsoft" onclick="hapusFlokSheet(\'' + id + '\')"><i class="bi bi-trash3"></i> Hapus</button></div></div>';
      }).join('') : '<p class="muted sm">Belum ada flok.</p>') + '</section>' +
      '<p class="field-hint" style="padding:0 6px"><i class="bi bi-info-circle"></i> Setiap flok punya sheet &quot;Data Periode Produksi Harian&quot; di Google Sheets, terisi otomatis dari input harian lengkap dengan rumus dan baris akumulasi abu-abu tiap 7 hari. Koreksi data lewat menu Riwayat, bukan langsung di sheet. <b>Update</b> menyusun ulang sheet &amp; akumulasi, <b>Unduh</b> mengambil file Excel-nya.</p>';
  } else if (K.tab === 'pengguna') {
    body = '<section class="card list-card"><div class="row-between"><h3 style="font-size:16px">Pengguna</h3><button class="btn btn-primary btn-sm" onclick="userSheet(\'\')"><i class="bi bi-person-plus"></i> Tambah</button></div>' +
      d.users.map(u =>
        '<div class="item-row"><span class="ico-badge ' + (u.peran === 'PEMILIK' ? 'gold' : 'pri') + '"><i class="bi bi-person"></i></span>' +
        '<div class="grow"><strong>' + esc(u.nama) + '</strong><span>' + esc(u.email) + '</span>' +
        '<div class="item-badges"><span class="badge ' + (u.peran === 'PEMILIK' ? 'b-gold' : 'b-pri') + '">' + roleLabel(u.peran) + '</span>' +
        '<span class="badge ' + (u.status === 'AKTIF' ? 'b-ok' : 'b-coral') + '">' + (u.status === 'AKTIF' ? 'Aktif' : 'Nonaktif') + '</span></div></div>' +
        '<button class="icon-btn sm" aria-label="Edit pengguna" onclick="userSheet(\'' + esc(u.email) + '\')"><i class="bi bi-pencil"></i></button></div>').join('') + '</section>';
  } else {
    const cf = d.config;
    const f = (k, label, type, hint) => '<div><label class="lbl" for="c_' + k + '">' + label + '</label>' +
      (type === 'area' ? '<textarea id="c_' + k + '" class="input" maxlength="400">' + esc(cf[k]) + '</textarea>'
        : '<input id="c_' + k + '" class="input" ' + (type === 'num' ? 'type="number" inputmode="decimal" step="any" min="0"' : 'maxlength="60"') + ' value="' + esc(cf[k]) + '">') +
      (hint ? '<p class="field-hint">' + hint + '</p>' : '') + '</div>';
    body = '<section class="card"><h3 style="font-size:16px;margin-bottom:4px">Pengaturan Aplikasi</h3><p class="muted sm">Berlaku untuk semua pengguna.</p>' +
      '<div class="form-grid two">' +
      f('nama_kandang', 'Nama Farm (bawaan flok baru)', 'txt') +
      f('ambang_deplesi_persen', 'Ambang Deplesi Harian (%)', 'num', 'Di atas angka ini, peringatan merah muncul.') +
      f('target_pakan_gram_per_ekor', 'Target Pakan (gr/ekor/hari)', 'num') +
      f('zak_kg', 'Berat 1 Zak Pakan (kg)', 'num') +
      f('butir_per_tray', 'Isi 1 Eggtray (butir)', 'num', 'Dipakai di input eggtray portal anak kandang.') +
      f('berat_min', 'Bobot Telur Minimum (gr)', 'num') +
      f('berat_max', 'Bobot Telur Maksimum (gr)', 'num') +
      f('dosis_per_vial', 'Dosis per Vial Vaksin', 'num') +
      f('cadangan_vaksin_persen', 'Cadangan Vaksin (%)', 'num') + '</div>' +
      f('katalog_vaksin', 'Katalog Vaksin', 'area', 'Pisahkan dengan koma.') +
      f('katalog_obat', 'Katalog Obat & Vitamin', 'area', 'Pisahkan dengan koma.') +
      f('tag_kondisi', 'Tag Cepat Kondisi Kandang', 'area', 'Pisahkan dengan koma.') +
      f('tag_reaksi', 'Tag Cepat Reaksi Vaksin/Obat', 'area', 'Pisahkan dengan koma.') +
      f('tenaga_medis', 'Daftar Tenaga Medis', 'area', 'Muncul di pilihan Petugas / Tim pada form Obat & Vaksin. Pisahkan dengan koma, mis. drh. Andi (Dokter Hewan), Budi (Paramedis).') +
      '<button class="btn btn-primary btn-block" id="cfgSave" style="margin-top:16px" onclick="saveConfig()"><i class="bi bi-save"></i> Simpan Pengaturan</button></section>';
  }

  c.innerHTML = '<div class="dash-top"><h2>Kelola</h2></div>' +
    '<div class="seg" role="tablist">' + tab('flok', 'Flok', 'bi-house-heart') + tab('pengguna', 'Pengguna', 'bi-people') + tab('pengaturan', 'Pengaturan', 'bi-gear') + '</div>' + body;
}

async function updateSheetFlok(id, btn) {
  setBusyBtn(btn, true, 'Memperbarui...');
  const res = await call('sinkronSheetFlok', App.token, id);
  setBusyBtn(btn, false);
  if (!res) return;
  toast(res.message, 'success');
  const kel = await call('getKelola', App.token);
  if (kel) App.kelola.data = kel.data;
  paintKelola();
}

async function unduhFlok(id, btn) {
  setBusyBtn(btn, true, 'Menyiapkan...');
  const res = await call('unduhSheetFlok', App.token, id);
  setBusyBtn(btn, false);
  if (!res) return;
  try {
    const bin = atob(res.data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: res.data.mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = res.data.nama_file;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    toast('Mengunduh ' + res.data.nama_file, 'success');
  } catch (e) {
    toast('Browser memblokir unduhan. Buka aplikasi langsung (bukan di dalam halaman Blogger) lalu coba lagi.', 'error');
  }
}

function hapusFlokSheet(id) {
  const f = App.kelola.data.floks.find(x => x.flok_id === id);
  if (!f) return;
  openSheet('Hapus Flok',
    '<p class="sheet-note" style="background:var(--coral-surface);color:var(--coral-text)"><b>Tindakan ini tidak bisa dibatalkan dari aplikasi.</b> ' +
    'Sheet <b>' + esc(f.nama_sheet || f.nama_flok) + '</b> akan dihapus dan <b>' + fInt(f.jumlah_catatan) + ' catatan harian</b> flok ini disembunyikan dari aplikasi. ' +
    'Datanya tetap tersimpan sebagai arsip di sheet CATATAN_HARIAN (status DIHAPUS).</p>' +
    '<label class="lbl" for="h_konfirm">Ketik nama flok <b>' + esc(f.nama_flok) + '</b> untuk konfirmasi</label>' +
    '<input id="h_konfirm" class="input" autocomplete="off" autocapitalize="none" placeholder="' + esc(f.nama_flok) + '" oninput="cekHapusFlok(\'' + esc(id) + '\')">' +
    '<div class="sheet-actions"><button class="btn btn-soft" onclick="closeSheet()">Batal</button>' +
    '<button class="btn btn-danger" id="h_ok" disabled onclick="konfirmHapusFlok(\'' + esc(id) + '\')"><i class="bi bi-trash3"></i> Hapus Flok</button></div>');
}
function cekHapusFlok(id) {
  const f = App.kelola.data.floks.find(x => x.flok_id === id);
  const ok = f && $('#h_konfirm').value.trim().toLowerCase() === f.nama_flok.trim().toLowerCase();
  $('#h_ok').disabled = !ok;
}
async function konfirmHapusFlok(id) {
  const btn = $('#h_ok');
  setBusyBtn(btn, true, 'Menghapus...');
  const res = await call('hapusFlok', App.token, id, $('#h_konfirm').value);
  setBusyBtn(btn, false);
  if (!res) return;
  closeSheet();
  toast(res.message, 'success');
  if (App.flokId === id) App.flokId = null;
  App.kelola.edit = null;
  resetInputForm();
  App.input.ctx = null; App.obat.ctx = null;
  await refreshBootstrap();
  renderKelola();
}

/** Kolom isian flok (dipakai di modal Tambah dan di halaman Edit). */
function flokFormHtml(f, lock) {
  const dis = lock ? ' disabled' : '';
  return '<div class="form-grid two">' +
    '<div><label class="lbl" for="k_nama">Nama Flok</label><input id="k_nama" class="input" maxlength="40" value="' + esc(f.nama_flok) + '" placeholder="mis. Flok 02"><p class="field-hint">Dipakai sebagai nama sheet.</p></div>' +
    '<div><label class="lbl" for="k_strain">Strain</label><input id="k_strain" class="input" maxlength="40" value="' + esc(f.strain) + '" placeholder="mis. ISA Brown"></div>' +
    '<div><label class="lbl" for="k_farm">Farm</label><input id="k_farm" class="input" maxlength="60" value="' + esc(f.farm) + '" placeholder="Nama farm"></div>' +
    '<div><label class="lbl" for="k_lokasi">Lokasi</label><input id="k_lokasi" class="input" maxlength="80" value="' + esc(f.lokasi) + '" placeholder="mis. Sragen, Jawa Tengah"></div>' +
    '<div><label class="lbl" for="k_kandang">Kandang</label><input id="k_kandang" class="input" maxlength="60" value="' + esc(f.kandang) + '" placeholder="mis. Kandang A"></div>' +
    '<div><label class="lbl" for="k_tgl">Tanggal Chick In</label><input id="k_tgl" class="input" type="date" max="' + hariIniWIB() + '" value="' + esc(f.tanggal_masuk) + '"' + dis + '></div>' +
    '<div><label class="lbl" for="k_umur">Umur Saat Chick In (minggu)</label><input id="k_umur" class="input" type="number" inputmode="numeric" min="0" step="1" value="' + esc(f.umur_masuk_minggu) + '"' + dis + '><p class="field-hint">Isi 0 bila masuk sebagai DOC.</p></div>' +
    '<div><label class="lbl" for="k_pop">Populasi Awal (ekor)</label><input id="k_pop" class="input" type="number" inputmode="numeric" min="1" step="1" value="' + esc(f.populasi_awal) + '"' + dis + '></div></div>' +
    (lock ? '<p class="sheet-note" style="margin-top:12px">Tanggal chick in, umur saat chick in, dan populasi awal dikunci karena flok sudah punya catatan.</p>' : '');
}

/** Tambah flok baru (modal). */
function flokSheet() {
  const kosong = { nama_flok: '', strain: '', farm: App.config.nama_kandang || '', lokasi: '', kandang: '', tanggal_masuk: '', umur_masuk_minggu: 0, populasi_awal: '' };
  openSheet('Tambah Flok',
    flokFormHtml(kosong, false) +
    '<p class="field-hint" style="margin-top:10px">Sheet database flok ikut dibuat otomatis dengan nama sesuai nama flok.</p>' +
    '<div class="sheet-actions"><button class="btn btn-soft" onclick="closeSheet()">Batal</button><button class="btn btn-primary" id="k_save" onclick="saveFlok(\'\')">Simpan</button></div>');
}

async function saveFlok(id) {
  const btn = $('#k_save');
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = await call('simpanFlok', App.token, {
    flok_id: id, nama_flok: $('#k_nama').value, strain: $('#k_strain').value, farm: $('#k_farm').value,
    lokasi: $('#k_lokasi').value, kandang: $('#k_kandang').value, tanggal_masuk: $('#k_tgl').value,
    umur_masuk_minggu: $('#k_umur').value, populasi_awal: $('#k_pop').value
  });
  setBusyBtn(btn, false);
  if (!res) return;
  closeSheet();
  toast(res.message, 'success');
  await refreshBootstrap();
  renderKelola();
}

// ── Kelola → Edit flok: Info Flok + Data Harian (isi sheet database) ──
function bukaEditFlok(id) {
  App.kelola.edit = { id: id, tab: 'info', data: null, memuat: false, semua: false };
  window.scrollTo({ top: 0 });
  paintKelola();
}
function tutupEditFlok() {
  App.kelola.edit = null;
  window.scrollTo({ top: 0 });
  renderKelola();
}
function setTabEdit(t) { App.kelola.edit.tab = t; paintKelola(); }

async function muatDataEdit() {
  const E = App.kelola.edit;
  if (!E) return;
  const seq = App.seq;
  E.memuat = true;
  const res = await call('getDataSheetFlok', App.token, E.id);
  if (seq !== App.seq || App.kelola.edit !== E) return;
  E.memuat = false;
  E.data = res ? res.data : null;
  E.gagal = !res;
  paintKelola();
}

function paintEditFlok() {
  if (App.page !== 'kelola') return;
  const K = App.kelola, E = K.edit, c = $('#app-container');
  const f = K.data.floks.find(x => x.flok_id === E.id);
  if (!f) { K.edit = null; paintKelola(); return; }
  const id = esc(f.flok_id);
  const tab = (t, label, icon) => '<button role="tab" class="' + (E.tab === t ? 'active' : '') + '" aria-selected="' + (E.tab === t) + '" onclick="setTabEdit(\'' + t + '\')"><i class="bi ' + icon + '"></i> ' + label + '</button>';
  let body = '';

  if (E.tab === 'info') {
    body = '<section class="card">' + flokFormHtml(f, f.jumlah_catatan > 0) +
      '<p class="field-hint" style="margin-top:10px">Perubahan otomatis tampil di bagian atas sheet (Farm, Lokasi, Kandang, Populasi, Tgl. Chick In, Strain). Mengubah nama flok juga mengganti nama sheet.</p>' +
      '<button class="btn btn-primary btn-block" id="k_save" style="margin-top:14px" onclick="simpanEditFlok(\'' + id + '\')"><i class="bi bi-save"></i> Simpan Info Flok</button></section>';
  } else {
    if (!E.data && !E.gagal && !E.memuat) { E.memuat = true; muatDataEdit(); }
    if (E.gagal) {
      body = errorCard('Gagal memuat data harian.', 'muatDataEdit()');
    } else if (!E.data) {
      body = skeleton();
    } else {
      const hari = E.data.hari;
      const tampil = E.semua ? hari : hari.slice(0, 30);
      const im = E.data.impor || {};
      let banner = '';
      if (im.baru || im.diubah) {
        banner += '<div class="status-strip ok"><i class="bi bi-arrow-repeat"></i><span>Sheet dibaca: ' +
          [im.baru ? im.baru + ' baris baru' : '', im.diubah ? im.diubah + ' baris dikoreksi' : ''].filter(Boolean).join(' dan ') + ' sudah masuk ke aplikasi.</span></div>';
      }
      if (im.ditolak && im.ditolak.length) {
        banner += '<section class="card" style="border:1.5px solid var(--coral)"><strong style="color:var(--coral-text)"><i class="bi bi-exclamation-triangle-fill"></i> ' + im.ditolak.length + ' baris di sheet ditolak</strong>' +
          '<ul class="sm" style="margin:8px 0 0;padding-left:18px">' + im.ditolak.slice(0, 6).map(d => '<li>Baris ' + d.baris + ': ' + esc(d.alasan) + '</li>').join('') + '</ul>' +
          '<p class="field-hint">Baris tersebut dipindah ke tabel &quot;BARIS DITOLAK&quot; (kolom R–Y di sheet). Perbaiki, ketik ulang di tabel utama, lalu hapus dari tabel ditolak.</p></section>';
      } else if (im.ditolak_tersimpan) {
        banner += '<div class="status-strip wait"><i class="bi bi-exclamation-triangle-fill"></i><span>Masih ada ' + im.ditolak_tersimpan + ' baris ditolak di sheet (kolom R–Y). Perbaiki lalu hapus dari tabel itu.</span></div>';
      }
      body = banner + '<section class="card"><div class="row-between"><div><h3 style="font-size:16px">Isi Sheet "' + esc(E.data.nama_sheet || f.nama_flok) + '"</h3>' +
        '<p class="muted sm">' + hari.length + ' hari data • terhubung dua arah dengan sheet</p></div>' +
        '<button class="btn btn-primary btn-sm" onclick="tambahDataEdit()"><i class="bi bi-plus-lg"></i> Tambah</button></div>' +
        '<p class="field-hint" style="margin-top:8px"><i class="bi bi-info-circle"></i> Anda juga bisa mengetik atau menempel data langsung di sheet (kolom Tanggal, Deplesi, Butir, Kg telur, Pakan Kg, Keterangan). Buka tab ini atau tekan <b>Update Sheet</b> untuk membacanya ke aplikasi.</p></section>' +
        (hari.length ? tampil.map(h => {
          const satu = h.jumlah_catatan === 1;
          return '<article class="rec"><div class="rec-top"><span class="badge b-pri"><i class="bi bi-calendar-check"></i> ' + esc(tglPendek(h.tanggal)) + '</span>' +
            '<span class="meta">Usia ' + h.umur + ' minggu • Hidup ' + fInt(h.hidup) + '</span>' +
            (satu ? '<div class="rec-actions"><button class="icon-btn sm" aria-label="Koreksi data" onclick="editDataEdit(\'' + esc(h.catatan_id) + '\')"><i class="bi bi-pencil"></i></button>' +
              '<button class="icon-btn sm danger" aria-label="Hapus data" onclick="hapusItem(\'harian\',\'' + esc(h.catatan_id) + '\',\'kelola\')"><i class="bi bi-trash3"></i></button></div>' : '') + '</div>' +
            '<div class="rec-grid"><div><small>Butir</small><strong>' + fInt(h.telur) + '</strong></div>' +
            '<div><small>Kg Telur</small><strong>' + fDec(h.kg, 2) + '</strong></div>' +
            '<div><small>Deplesi</small><strong>' + (h.mati + h.afkir) + '</strong></div>' +
            '<div><small>Pakan Kg</small><strong>' + fDec(h.pakan, 1) + '</strong></div></div>' +
            '<p class="xs muted">' + (h.ak !== null && h.ak !== undefined ? 'A ' + fDec(h.ak, 1) + ' • B ' + fDec(h.bk, 1) + ' • BS ' + fDec(h.bsk, 1) + ' kg • ' : (h.a !== null && h.a !== undefined ? 'A ' + fInt(h.a) + ' • B ' + fInt(h.b) + ' • BS ' + fInt(h.bs) + ' btr • ' : '')) + 'HD ' + fDec(h.hd, 2) + '% • ' + fDec(h.gr_ekor, 2) + ' gr/ekor • ' + fDec(h.gr_btr, 2) + ' gr/btr • Kg/1000 ' + fDec(h.kg1000, 2) + ' • FCR ' + fDec(h.fcr, 2) + '</p>' +
            (h.catatan ? '<p class="rec-note">' + esc(h.catatan) + '</p>' : '') +
            (satu ? '' : '<p class="rec-note">Terdiri dari ' + h.jumlah_catatan + ' catatan lama. Buka menu Riwayat untuk koreksi.</p>') + '</article>';
        }).join('') : '<section class="card empty"><i class="bi bi-inbox"></i><strong>Belum ada data harian</strong><p class="sm">Tekan Tambah untuk mengisi rekap harian flok ini.</p></section>') +
        (!E.semua && hari.length > 30 ? '<button class="btn btn-soft btn-block" onclick="App.kelola.edit.semua=true;paintKelola()">Tampilkan semua (' + hari.length + ' hari)</button>' : '');
    }
  }

  c.innerHTML =
    '<div class="edit-head"><button class="icon-btn" aria-label="Kembali ke daftar flok" onclick="tutupEditFlok()"><i class="bi bi-arrow-left"></i></button>' +
    '<h2>Edit ' + esc(f.nama_flok) + '</h2></div>' +
    '<div class="item-actions" style="padding:0"><button class="btn btn-soft btn-sm" onclick="updateSheetFlok(\'' + id + '\',this)"><i class="bi bi-arrow-repeat"></i> Update Sheet</button>' +
    '<button class="btn btn-soft btn-sm" onclick="unduhFlok(\'' + id + '\',this)"><i class="bi bi-download"></i> Unduh</button>' +
    '<span class="badge ' + (f.ada_sheet ? 'b-ok' : 'b-coral') + '" style="align-self:center"><i class="bi bi-file-earmark-spreadsheet"></i> ' + (f.ada_sheet ? 'Sheet: ' + esc(f.nama_sheet) : 'Sheet belum ada') + '</span></div>' +
    '<div class="seg" role="tablist">' + tab('info', 'Info Flok', 'bi-info-circle') + tab('data', 'Data Harian', 'bi-table') + '</div>' + body;
}

async function simpanEditFlok(id) {
  const btn = $('#k_save');
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = await call('simpanFlok', App.token, {
    flok_id: id, nama_flok: $('#k_nama').value, strain: $('#k_strain').value, farm: $('#k_farm').value,
    lokasi: $('#k_lokasi').value, kandang: $('#k_kandang').value, tanggal_masuk: $('#k_tgl').value,
    umur_masuk_minggu: $('#k_umur').value, populasi_awal: $('#k_pop').value
  });
  setBusyBtn(btn, false);
  if (!res) return;
  toast(res.message, 'success');
  await refreshBootstrap();
  const kel = await call('getKelola', App.token);
  if (kel) App.kelola.data = kel.data;
  if (App.kelola.edit) App.kelola.edit.data = null;
  paintKelola();
}

function editFlokAktif() { return App.kelola.data.floks.find(x => x.flok_id === App.kelola.edit.id); }
function tambahDataEdit() {
  const f = editFlokAktif();
  formHarian({ flok_id: f.flok_id, rec: null, balik: 'kelola', min: f.tanggal_masuk });
}
function editDataEdit(catatanId) {
  const f = editFlokAktif();
  const h = App.kelola.edit.data.hari.find(x => x.catatan_id === catatanId);
  if (!h) return;
  formHarian({
    flok_id: f.flok_id, balik: 'kelola', min: f.tanggal_masuk,
    rec: { catatan_id: h.catatan_id, tanggal: h.tanggal, telur_butir: h.telur, telur_a: h.a, telur_b: h.b, telur_bs: h.bs, telur_a_kg: h.ak, telur_b_kg: h.bk, telur_bs_kg: h.bsk, std_berat_gr: h.std_berat_gr, telur_kg: h.kg, deplesi_mati: h.mati, deplesi_afkir: h.afkir, pakan_kg: h.pakan, catatan: h.catatan }
  });
}

function toggleFlok(id, status) {
  confirmSheet({
    title: status === 'SELESAI' ? 'Tutup Flok?' : 'Aktifkan Flok?', cancelText: 'Batal', okText: 'Ya, Lanjutkan', danger: status === 'SELESAI',
    note: status === 'SELESAI' ? 'Flok yang ditutup tidak muncul di form input. Data lama tetap tersimpan.' : 'Flok akan muncul kembali di form input.',
    rows: [],
    onOk: async () => {
      const res = await call('ubahStatusFlok', App.token, id, status);
      if (!res) return;
      closeSheet();
      toast(res.message, 'success');
      await refreshBootstrap();
      renderKelola();
    }
  });
}

function userSheet(email) {
  const u = email ? App.kelola.data.users.find(x => x.email === email) : { email: '', nama: '', peran: 'ANAK_KANDANG', status: 'AKTIF' };
  if (!u) return;
  openSheet(email ? 'Edit Pengguna' : 'Tambah Pengguna',
    '<div class="form-grid two">' +
    '<div><label class="lbl" for="u_email">Username</label><input id="u_email" class="input" maxlength="60" autocapitalize="none" value="' + esc(u.email) + '"' + (email ? ' disabled' : '') + ' placeholder="mis. budi"></div>' +
    '<div><label class="lbl" for="u_nama">Nama</label><input id="u_nama" class="input" maxlength="60" value="' + esc(u.nama) + '"></div>' +
    '<div><label class="lbl" for="u_peran">Peran</label><select id="u_peran" class="input"><option value="ANAK_KANDANG"' + (u.peran === 'ANAK_KANDANG' ? ' selected' : '') + '>Anak Kandang</option><option value="PEMILIK"' + (u.peran === 'PEMILIK' ? ' selected' : '') + '>Pemilik</option></select></div>' +
    '<div><label class="lbl" for="u_status">Status</label><select id="u_status" class="input"><option value="AKTIF"' + (u.status === 'AKTIF' ? ' selected' : '') + '>Aktif</option><option value="NONAKTIF"' + (u.status === 'NONAKTIF' ? ' selected' : '') + '>Nonaktif</option></select></div></div>' +
    '<label class="lbl" for="u_pin">' + (email ? 'PIN Baru (kosongkan jika tidak diubah)' : 'PIN (4–8 angka)') + '</label>' +
    '<input id="u_pin" class="input" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" placeholder="••••••">' +
    '<div class="sheet-actions"><button class="btn btn-soft" onclick="closeSheet()">Batal</button><button class="btn btn-primary" id="u_save" onclick="saveUser(\'' + esc(email) + '\')">Simpan</button></div>');
}
async function saveUser(email) {
  const btn = $('#u_save');
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = await call('simpanUser', App.token, {
    mode: email ? 'ubah' : 'baru', email: email || $('#u_email').value, nama: $('#u_nama').value,
    peran: $('#u_peran').value, status: $('#u_status').value, pin: $('#u_pin').value
  });
  setBusyBtn(btn, false);
  if (!res) return;
  closeSheet();
  toast(res.message, 'success');
  await refreshBootstrap();
  renderKelola();
}
async function saveConfig() {
  const keys = ['nama_kandang', 'ambang_deplesi_persen', 'target_pakan_gram_per_ekor', 'zak_kg', 'butir_per_tray', 'berat_min', 'berat_max', 'dosis_per_vial', 'cadangan_vaksin_persen', 'katalog_vaksin', 'katalog_obat', 'tag_kondisi', 'tag_reaksi', 'tenaga_medis'];
  const payload = {};
  keys.forEach(k => { const el = $('#c_' + k); if (el) payload[k] = el.value; });
  const btn = $('#cfgSave');
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = await call('simpanConfig', App.token, payload);
  setBusyBtn(btn, false);
  if (!res) return;
  toast(res.message, 'success');
  await refreshBootstrap();
  renderKelola();
}

// ════════════════════════════════════════════════════════
// BAGIAN 7B: STOK (BAHAN BAKU & PAKAN JADI)
// ════════════════════════════════════════════════════════

const STOK_KAT = { BAHAN_BAKU: 'Bahan Baku', PAKAN_JADI: 'Pakan Jadi' };
const STOK_JENIS_UI = {
  MASUK: { label: 'Masuk', badge: 'b-ok', icon: 'bi-box-arrow-in-down', tanda: '+' },
  KELUAR: { label: 'Keluar', badge: 'b-coral', icon: 'bi-box-arrow-up', tanda: '−' },
  KOREKSI: { label: 'Koreksi', badge: 'b-gold', icon: 'bi-clipboard-check', tanda: '±' },
  PRODUKSI: { label: 'Produksi', badge: 'b-sky', icon: 'bi-gear', tanda: '' },
  PAKAI_HARIAN: { label: 'Pakai Otomatis', badge: 'b-sky', icon: 'bi-arrow-repeat', tanda: '−' }
};
function fKg(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 });
}

async function renderStok(diam) {
  const seq = App.seq;
  const c = $('#app-container');
  const a = specs().stok;
  if (!swrAda(a) && (!diam || !App.stok.data)) c.innerHTML = skeleton();
  await loadSWR(seq, a, d => { App.stok.data = d; paintStok(); },
    () => { c.innerHTML = errorCard('Gagal memuat stok.', 'renderStok()'); });
}

function stokKpi(label, nilai, satuan, ikon, warna) {
  return '<div><small><span class="ico-badge ' + warna + '" style="width:22px;height:22px;border-radius:7px;font-size:12px"><i class="bi ' + ikon + '"></i></span>' + esc(label) + '</small>' +
    '<strong>' + esc(nilai) + (satuan ? ' <span>' + esc(satuan) + '</span>' : '') + '</strong></div>';
}

function paintStok() {
  if (App.page !== 'stok') return;
  const S = App.stok, d = S.data, c = $('#app-container');
  if (!d) return;
  const owner = isOwner();
  const pk = d.pakan;
  let info;
  const adaAuto = d.items.some(i => i.auto_harian && i.status === 'AKTIF');
  const tautan = adaAuto ? '' :
    '<div class="status-strip warn"><i class="bi bi-exclamation-triangle-fill"></i><span><strong>Pakan jadi belum terhubung ke Input Harian</strong>, jadi stoknya tidak berkurang otomatis. ' +
    (owner ? 'Buka tab Pakan, ketuk ikon pensil di barang pakan jadi, lalu centang "Berkurang otomatis dari Input Harian".' : 'Minta pemilik mengaktifkannya di tab Pakan.') + '</span></div>';
  if (pk.rata_harian) {
    const warn = d.ringkasan.pakan_jadi <= 0 || (pk.hari_cukup !== null && pk.hari_cukup <= 3);
    info = '<div class="status-strip ' + (warn ? 'warn' : 'ok') + '"><i class="bi ' + (warn ? 'bi-exclamation-triangle-fill' : 'bi-info-circle-fill') + '"></i><span>' +
      'Pemakaian pakan ±' + fKg(pk.rata_harian) + ' kg/hari (rata-rata ' + pk.hari_data + ' hari terakhir dari Input Harian). ' +
      (d.ringkasan.pakan_jadi > 0 ? 'Stok pakan jadi cukup ' + (pk.hari_cukup < 1 ? '<strong>kurang dari 1 hari</strong>' : '±<strong>' + fInt(pk.hari_cukup) + ' hari</strong>') + '.' : 'Stok pakan jadi ' + (d.ringkasan.pakan_jadi < 0 ? 'minus, catat stok masuk atau koreksi.' : 'kosong, segera isi.')) + '</span></div>';
  } else {
    info = '<div class="status-strip wait"><i class="bi bi-info-circle-fill"></i><span>Belum ada data pakan 7 hari terakhir dari Input Harian, perkiraan "cukup berapa hari" belum bisa dihitung.</span></div>';
  }
  const tab = (id, ikon, teks) => '<button role="tab" class="' + (S.tab === id ? 'active' : '') + '" onclick="App.stok.tab=\'' + id + '\';paintStok()"><i class="bi ' + ikon + '"></i> ' + teks + '</button>';
  c.innerHTML =
    '<div class="dash-top"><h2>Stok</h2>' +
    (owner ? '<button class="btn btn-primary btn-sm" onclick="formItemStok()"><i class="bi bi-plus-lg"></i> Barang Baru</button>' : '') + '</div>' +
    '<div class="stok-kpi">' +
    stokKpi('Bahan Baku', fKg(d.ringkasan.bahan_baku), 'kg', 'bi-basket', 'sky') +
    stokKpi('Pakan Jadi', fKg(d.ringkasan.pakan_jadi), 'kg', 'bi-bag-check', 'ok') +
    stokKpi('Perlu Restok', fInt(d.ringkasan.menipis), 'barang', 'bi-exclamation-triangle', d.ringkasan.menipis ? 'coral' : 'gold') + '</div>' +
    tautan + info +
    '<div class="seg sm" role="tablist">' + tab('BAHAN_BAKU', 'bi-basket', 'Bahan') + tab('PAKAN_JADI', 'bi-bag-check', 'Pakan') + tab('RESEP', 'bi-diagram-3', 'Resep') + tab('RIWAYAT', 'bi-clock-history', 'Riwayat') + '</div>' +
    '<div id="stokBody" class="page" style="gap:10px;animation:none"></div>';
  if (S.tab === 'RIWAYAT') renderStokRiwayat(); else if (S.tab === 'RESEP') paintResep(); else paintStokList();
}

function paintStokList() {
  const S = App.stok, d = S.data, box = $('#stokBody');
  if (!box) return;
  const owner = isOwner();
  const items = d.items.filter(i => i.kategori === S.tab)
    .sort((a, b) => (a.status === b.status ? a.nama.localeCompare(b.nama, 'id') : (a.status === 'AKTIF' ? -1 : 1)));
  if (!items.length) {
    box.innerHTML = '<section class="card empty"><i class="bi bi-box-seam"></i><strong>Belum ada ' + STOK_KAT[S.tab].toLowerCase() + '</strong>' +
      '<p class="sm">' + (owner ? 'Tambahkan barang dulu, lalu catat stok masuk dan keluar.' : 'Hubungi pemilik untuk menambahkan barang.') + '</p>' +
      (owner ? '<button class="btn btn-primary" onclick="formItemStok(null,\'' + S.tab + '\')">Tambah Barang</button>' : '') + '</section>';
    return;
  }
  box.innerHTML = items.map(i => {
    const aktif = i.status === 'AKTIF';
    return '<article class="stok-item' + (aktif ? '' : ' off') + (i.menipis ? ' low' : '') + '">' +
      '<div class="si-top"><div class="si-name"><strong>' + esc(i.nama) + '</strong>' +
      '<p class="xs muted">Masuk bulan ini ' + fKg(i.masuk_bulan) + ' kg • Keluar ' + fKg(i.keluar_bulan) + ' kg' + (i.stok_minimum > 0 ? ' • Min ' + fKg(i.stok_minimum) + ' kg' : '') + '</p></div>' +
      '<div class="si-qty"><b>' + fKg(i.stok) + '</b><small>kg</small></div></div>' +
      ((i.menipis || !aktif || i.auto_harian) ? '<div class="si-badges">' +
        (i.minus ? '<span class="badge b-coral"><i class="bi bi-exclamation-triangle-fill"></i> Stok minus: catat Masuk / Koreksi</span>'
          : (i.menipis ? '<span class="badge b-coral"><i class="bi bi-exclamation-triangle-fill"></i> Stok menipis</span>' : '')) +
        (i.auto_harian ? '<span class="badge b-sky"><i class="bi bi-arrow-repeat"></i> Berkurang otomatis dari Input Harian</span>' : '') +
        (!aktif ? '<span class="badge b-muted">Nonaktif</span>' : '') + '</div>' : '') +
      (i.auto_harian ? '<p class="xs muted">Terpakai otomatis ' + fKg(i.otomatis_bulan) + ' kg bulan ini • total ' + fKg(i.otomatis_total) + ' kg sejak ' + esc(tglPendek(i.auto_mulai)) + '</p>' : '') +
      '<div class="si-actions">' +
      (aktif ? '<button class="btn btn-soft btn-sm" onclick="formStok(\'' + esc(i.item_id) + '\',\'MASUK\')"><i class="bi bi-box-arrow-in-down"></i> Masuk</button>' +
        '<button class="btn btn-soft btn-sm" onclick="formStok(\'' + esc(i.item_id) + '\',\'KELUAR\')"><i class="bi bi-box-arrow-up"></i> Keluar</button>' : '') +
      (owner ? (aktif ? '<button class="icon-btn sm" aria-label="Koreksi stok (opname) ' + esc(i.nama) + '" onclick="formStok(\'' + esc(i.item_id) + '\',\'KOREKSI\')"><i class="bi bi-clipboard-check"></i></button>' : '') +
        '<button class="icon-btn sm" aria-label="Ubah barang ' + esc(i.nama) + '" onclick="formItemStok(\'' + esc(i.item_id) + '\')"><i class="bi bi-pencil"></i></button>' : '') +
      '</div></article>';
  }).join('') +
    '<p class="field-hint" style="text-align:center">Satuan stok: kg. ' + (owner ? 'Ikon <i class="bi bi-clipboard-check"></i> = koreksi hasil hitung fisik (opname).' : '') + '</p>';
}

async function renderStokRiwayat() {
  const S = App.stok, box = $('#stokBody');
  if (!box) return;
  const items = S.data.items;
  const filter =
    '<div class="card filter-card"><div class="filter-grid">' +
    '<select class="input" aria-label="Filter barang" onchange="App.stok.fItem=this.value;renderStokRiwayat()"><option value="">Semua barang</option>' +
    items.map(i => '<option value="' + esc(i.item_id) + '"' + (S.fItem === i.item_id ? ' selected' : '') + '>' + esc(i.nama) + '</option>').join('') + '</select>' +
    '<select class="input" aria-label="Filter jenis" onchange="App.stok.fJenis=this.value;renderStokRiwayat()"><option value="">Semua jenis</option>' +
    Object.keys(STOK_JENIS_UI).map(k => '<option value="' + k + '"' + (S.fJenis === k ? ' selected' : '') + '>' + STOK_JENIS_UI[k].label + '</option>').join('') + '</select>' +
    '<select class="input" aria-label="Periode" onchange="App.stok.hari=Number(this.value);renderStokRiwayat()">' +
    [[7, '7 hari'], [30, '30 hari'], [90, '90 hari'], [0, 'Semua']].map(x => '<option value="' + x[0] + '"' + (S.hari === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>' +
    '</div></div>';
  box.innerHTML = filter + '<div class="skel" style="height:90px"></div>';
  const res = await call('getRiwayatStok', App.token, { item_id: S.fItem, jenis: S.fJenis, hari: S.hari });
  if (App.page !== 'stok' || S.tab !== 'RIWAYAT') return;
  if (!res) { box.innerHTML = filter + errorCard('Gagal memuat riwayat stok.', 'renderStokRiwayat()'); return; }
  const trx = res.data.transaksi;
  const owner = isOwner();
  let html = filter;
  if (!trx.length) html += '<section class="card empty"><i class="bi bi-inbox"></i><strong>Belum ada mutasi stok</strong><p class="sm">Stok masuk, keluar, dan koreksi akan tampil di sini.</p></section>';
  let last = '';
  trx.forEach(t => {
    if (t.tanggal !== last) { last = t.tanggal; html += '<div class="day-head"><strong>' + esc(tglPendek(t.tanggal)) + '</strong></div>'; }
    const u = t.ref ? STOK_JENIS_UI.PRODUKSI : (STOK_JENIS_UI[t.jenis] || STOK_JENIS_UI.KOREKSI);
    const jml = (t.jenis === 'KELUAR' || t.jenis === 'PAKAI_HARIAN') ? -t.jumlah : t.jumlah;
    html += '<article class="rec"><div class="rec-top"><span class="badge ' + u.badge + '"><i class="bi ' + u.icon + '"></i> ' + u.label + '</span>' +
      '<span class="meta">' + esc(STOK_KAT[t.kategori] || '') + ' • ' + esc(t.diinput_oleh) + (t.otomatis ? '' : ' • ' + esc((t.waktu_input || '').slice(11, 16))) + '</span>' +
      (owner && !t.otomatis ? '<div class="rec-actions"><button class="icon-btn sm danger" aria-label="' + (t.ref ? 'Hapus produksi' : 'Hapus catatan stok') + '" onclick="' + (t.ref ? 'hapusProduksi(\'' + esc(t.ref) + '\')' : 'hapusStokTrx(\'' + esc(t.trx_id) + '\')') + '"><i class="bi bi-trash3"></i></button></div>' : '') + '</div>' +
      '<div class="si-top"><div class="si-name"><strong>' + esc(t.nama) + '</strong>' + (t.keterangan ? '<p class="xs muted">' + esc(t.keterangan) + '</p>' : '') + '</div>' +
      '<div class="si-qty ' + (jml < 0 ? 'neg' : 'pos') + '"><b>' + (jml > 0 ? '+' : '') + fKg(jml) + '</b><small>kg</small></div></div></article>';
  });
  if (res.data.total > trx.length) html += '<p class="field-hint" style="text-align:center">Menampilkan ' + trx.length + ' dari ' + res.data.total + ' mutasi terbaru. Persempit filter untuk melihat yang lain.</p>';
  box.innerHTML = html;
}

/** Form catat stok masuk / keluar / koreksi (opname). */
function formStok(itemId, jenis) {
  const it = App.stok.data.items.find(i => i.item_id === itemId);
  if (!it) return;
  const zak = App.stok.data.zak_kg || 50;
  App.stokForm = { it: it, jenis: jenis, zak: zak };
  const judul = { MASUK: 'Stok Masuk', KELUAR: 'Stok Keluar', KOREKSI: 'Koreksi Stok (Opname)' }[jenis];
  const ph = { MASUK: 'mis. beli dari toko, no. nota', KELUAR: 'mis. dipakai mixing, dikirim ke kandang', KOREKSI: 'mis. selisih hasil timbang' }[jenis];
  const tgl = isOwner()
    ? '<label class="lbl" for="s_tgl">Tanggal</label><input id="s_tgl" class="input" type="date" value="' + hariIniWIB() + '" max="' + hariIniWIB() + '">' : '';
  const isi = jenis === 'KOREKSI'
    ? '<label class="lbl" for="s_fisik">Stok fisik hasil hitung (kg)</label><input id="s_fisik" class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="0" oninput="hitungStokForm()">'
    : '<label class="lbl" for="s_jml">Jumlah</label><div class="stok-qty-row"><input id="s_jml" class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="0" oninput="hitungStokForm()">' +
      '<select id="s_sat" class="input" aria-label="Satuan" onchange="hitungStokForm()"><option value="kg">kg</option><option value="zak">zak</option></select></div>';
  openSheet(judul + ' • ' + it.nama,
    '<p class="sheet-note">Stok di sistem sekarang: <strong>' + fKg(it.stok) + ' kg</strong>' + (jenis === 'KOREKSI' ? '. Isi stok fisik sebenarnya, selisihnya dicatat otomatis.' : '') + '</p>' +
    tgl + isi + '<p class="field-hint" id="s_hint"></p>' +
    '<label class="lbl" for="s_ket">Keterangan (opsional)</label><input id="s_ket" class="input" maxlength="200" placeholder="' + esc(ph) + '">' +
    '<div class="sheet-actions"><button class="btn btn-soft" onclick="closeSheet()">Batal</button>' +
    '<button class="btn btn-primary" id="s_save" onclick="simpanStokForm()">Simpan</button></div>');
  setTimeout(() => { const el = $('#s_jml') || $('#s_fisik'); if (el) el.focus(); }, 80);
}

function stokKgDariForm() {
  const F = App.stokForm;
  const v = Number(String(($('#s_jml') || {}).value || '').replace(',', '.'));
  if (!isFinite(v) || v <= 0) return null;
  return ($('#s_sat') && $('#s_sat').value === 'zak') ? Math.round(v * F.zak * 100) / 100 : v;
}

function hitungStokForm() {
  const F = App.stokForm, h = $('#s_hint');
  if (!F || !h) return;
  h.className = 'field-hint';
  if (F.jenis === 'KOREKSI') {
    const f = Number(String($('#s_fisik').value).replace(',', '.'));
    if ($('#s_fisik').value === '' || !isFinite(f)) { h.textContent = ''; return; }
    const sel = Math.round((f - F.it.stok) * 100) / 100;
    h.textContent = sel === 0 ? 'Sama dengan stok di sistem, tidak perlu koreksi.' : 'Selisih ' + (sel > 0 ? '+' : '') + fKg(sel) + ' kg dari stok sistem.';
    return;
  }
  const kg = stokKgDariForm();
  if (kg === null) { h.textContent = ''; return; }
  const sisa = Math.round((F.it.stok + (F.jenis === 'KELUAR' ? -kg : kg)) * 100) / 100;
  const zakTxt = $('#s_sat').value === 'zak' ? fKg(kg / F.zak) + ' zak × ' + fKg(F.zak) + ' kg = ' + fKg(kg) + ' kg • ' : '';
  if (sisa < 0) { h.className = 'field-hint warn'; h.textContent = zakTxt + 'Melebihi stok! Stok hanya ' + fKg(F.it.stok) + ' kg.'; return; }
  h.textContent = zakTxt + 'Stok setelah dicatat: ' + fKg(sisa) + ' kg.';
}

async function simpanStokForm() {
  const F = App.stokForm;
  if (!F) return;
  const payload = { item_id: F.it.item_id, jenis: F.jenis, keterangan: ($('#s_ket').value || '').trim() };
  if ($('#s_tgl')) payload.tanggal = $('#s_tgl').value;
  if (F.jenis === 'KOREKSI') {
    const f = $('#s_fisik').value;
    if (f === '' || !isFinite(Number(String(f).replace(',', '.'))) || Number(String(f).replace(',', '.')) < 0) { toast('Isi stok fisik dengan angka 0 atau lebih.', 'error'); return; }
    payload.stok_fisik = String(f).replace(',', '.');
  } else {
    const kg = stokKgDariForm();
    if (kg === null) { toast('Isi jumlah lebih dari 0.', 'error'); return; }
    if (F.jenis === 'KELUAR' && kg > F.it.stok + 0.0001) { toast('Pengeluaran melebihi stok (' + fKg(F.it.stok) + ' kg).', 'error'); return; }
    payload.jumlah = kg;
    if ($('#s_sat').value === 'zak') {
      const zakN = Number(String($('#s_jml').value).replace(',', '.'));
      payload.keterangan = (payload.keterangan ? payload.keterangan + ' ' : '') + '(' + fKg(zakN) + ' zak)';
    }
  }
  const btn = $('#s_save');
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = await call('simpanTransaksiStok', App.token, payload);
  setBusyBtn(btn, false);
  if (!res) return;
  closeSheet();
  toast(res.message, 'success');
  renderStok(true);
}

// ── Resep campuran & produksi ──

function paintResep() {
  const S = App.stok, d = S.data, box = $('#stokBody');
  if (!box) return;
  const owner = isOwner();
  const rs = (d.resep || []).slice().sort((a, b) => (a.status === b.status ? a.nama_resep.localeCompare(b.nama_resep, 'id') : (a.status === 'AKTIF' ? -1 : 1)));
  let html = owner ? '<button class="btn btn-soft btn-block" onclick="formResep()"><i class="bi bi-plus-lg"></i> Resep Baru</button>' : '';
  if (!rs.length) {
    html += '<section class="card empty"><i class="bi bi-diagram-3"></i><strong>Belum ada resep</strong><p class="sm">' +
      (owner ? 'Buat resep campuran: pilih bahan baku dan takarannya. Saat produksi, bahan baku berkurang dan hasilnya masuk ke stok pakan jadi.' : 'Hubungi pemilik untuk membuat resep.') + '</p></section>';
  }
  html += rs.map(r => {
    const aktif = r.status === 'AKTIF';
    const bisa = aktif && r.hasil_aktif;
    return '<article class="stok-item' + (aktif ? '' : ' off') + '">' +
      '<div class="si-top"><div class="si-name"><strong>' + esc(r.nama_resep) + '</strong>' +
      '<p class="xs muted"><i class="bi bi-arrow-right"></i> ' + esc(r.nama_hasil) + ' • 1 batch = ' + fKg(r.hasil_kg_batch) + ' kg</p></div>' +
      '<div class="si-qty"><b>' + fKg(r.maks_hasil_kg) + '</b><small>kg bisa dibuat</small></div></div>' +
      '<ul class="resep-bahan">' + r.bahan.map(b =>
        '<li class="' + (b.stok < b.jumlah_kg ? 'low' : '') + '"><span>' + esc(b.nama) + '<small>' + fDec(r.total_bahan_kg > 0 ? b.jumlah_kg / r.total_bahan_kg * 100 : 0, 1) + '% • stok ' + fKg(b.stok) + ' kg</small></span><b>' + fKg(b.jumlah_kg) + ' kg</b></li>').join('') + '</ul>' +
      (!aktif || r.sekali_pakai ? '<div class="si-badges">' + (!aktif ? '<span class="badge b-muted">Nonaktif</span>' : '') + (r.sekali_pakai ? '<span class="badge b-gold"><i class="bi bi-1-circle"></i> Sekali pakai</span>' : '') + '</div>' : '') +
      '<div class="si-actions">' +
      (bisa ? '<button class="btn btn-primary btn-sm" onclick="produksiCepat(\'' + esc(r.resep_id) + '\', this)"><i class="bi bi-lightning-charge"></i> Produksi 1 Batch</button>' +
        '<button class="btn btn-soft btn-sm" onclick="formProduksi(\'' + esc(r.resep_id) + '\')"><i class="bi bi-sliders"></i> Atur Jumlah</button>' : '') +
      (owner ? '<button class="icon-btn sm" aria-label="Ubah resep ' + esc(r.nama_resep) + '" onclick="formResep(\'' + esc(r.resep_id) + '\')"><i class="bi bi-pencil"></i></button>' : '') +
      '</div></article>';
  }).join('');
  html += '<div class="day-head"><strong>Produksi terakhir (30 hari)</strong></div>' +
    '<div id="produksiList" class="page" style="gap:10px;animation:none"><div class="skel" style="height:70px"></div></div>';
  box.innerHTML = html;
  loadProduksi();
}

async function loadProduksi() {
  const res = await call('getProduksiStok', App.token, { hari: 30 });
  const box = $('#produksiList');
  if (!box || App.page !== 'stok' || App.stok.tab !== 'RESEP') return;
  if (!res) { box.innerHTML = '<p class="field-hint" style="text-align:center">Gagal memuat catatan produksi.</p>'; return; }
  const list = res.data.produksi;
  if (!list.length) { box.innerHTML = '<section class="card empty"><i class="bi bi-inbox"></i><strong>Belum ada produksi</strong><p class="sm">Produksi yang dicatat akan tampil di sini.</p></section>'; return; }
  const owner = isOwner();
  box.innerHTML = list.map(p =>
    '<article class="rec"><div class="rec-top"><span class="badge b-sky"><i class="bi bi-gear"></i> Produksi</span>' +
    '<span class="meta">' + esc(tglPendek(p.tanggal)) + ' • ' + esc(p.diinput_oleh) + '</span>' +
    (owner ? '<div class="rec-actions"><button class="icon-btn sm danger" aria-label="Hapus produksi" onclick="hapusProduksi(\'' + esc(p.prod_id) + '\')"><i class="bi bi-trash3"></i></button></div>' : '') + '</div>' +
    '<div class="si-top"><div class="si-name"><strong>' + esc(p.nama_resep) + '</strong>' +
    '<p class="xs muted">' + p.bahan.map(b => esc(b.nama) + ' ' + fKg(b.jumlah_kg) + ' kg').join(' • ') + '</p>' +
    (p.keterangan ? '<p class="xs muted">' + esc(p.keterangan) + '</p>' : '') + '</div>' +
    '<div class="si-qty pos"><b>+' + fKg(p.jumlah_hasil_kg) + '</b><small>kg ' + esc(p.nama_hasil) + '</small></div></div></article>').join('');
}

function hapusProduksi(id) {
  confirmSheet({
    title: 'Hapus Produksi?', danger: true, cancelText: 'Batal', okText: 'Ya, Hapus',
    note: 'Bahan baku dikembalikan ke stok dan pakan jadi hasil produksi ini dikurangi. Ditolak bila pakan jadi itu sudah terpakai. Catatan tetap tersimpan di Sheets sebagai arsip.',
    rows: [],
    onOk: async () => {
      const res = await call('hapusProduksiStok', App.token, id);
      if (!res) return;
      closeSheet();
      toast(res.message, 'success');
      renderStok(true);
    }
  });
}

/** Produksi 1 batch penuh sekali tap, tanpa konfirmasi: bahan baku berkurang dan pakan jadi langsung bertambah. */
async function produksiCepat(resepId, btn) {
  const r = (App.stok.data.resep || []).find(x => x.resep_id === resepId);
  if (!r || App.prodBusy) return;
  App.prodBusy = true;
  if (btn) setBusyBtn(btn, true, 'Memproses...');
  const res = await call('jalankanProduksi', App.token, { resep_id: r.resep_id, jumlah_hasil_kg: r.hasil_kg_batch });
  App.prodBusy = false;
  if (btn) setBusyBtn(btn, false);
  if (!res) return;
  toast(res.message, 'success');
  renderStok(true);
}

/** Form produksi: jumlah hasil dalam kg / zak / batch, dengan pratinjau pemakaian bahan. */
function formProduksi(resepId) {
  const r = (App.stok.data.resep || []).find(x => x.resep_id === resepId);
  if (!r) return;
  App.prodForm = { r: r, zak: App.stok.data.zak_kg || 50 };
  const tgl = isOwner()
    ? '<label class="lbl" for="pr_tgl">Tanggal</label><input id="pr_tgl" class="input" type="date" value="' + hariIniWIB() + '" max="' + hariIniWIB() + '">' : '';
  openSheet('Produksi • ' + r.nama_resep,
    '<p class="sheet-note">Hasil: <strong>' + esc(r.nama_hasil) + '</strong> • 1 batch = ' + fKg(r.hasil_kg_batch) + ' kg. Bahan baku dikurangi otomatis dan pakan jadi bertambah.</p>' +
    tgl +
    '<label class="lbl" for="pr_jml">Jumlah pakan jadi yang dihasilkan</label><div class="stok-qty-row">' +
    '<input id="pr_jml" class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="0" oninput="hitungProduksiForm()">' +
    '<select id="pr_sat" class="input" aria-label="Satuan" onchange="hitungProduksiForm()"><option value="kg">kg</option><option value="zak">zak</option><option value="batch">batch</option></select></div>' +
    '<div id="pr_prev" class="prod-prev"></div>' +
    '<label class="lbl" for="pr_ket">Keterangan (opsional)</label><input id="pr_ket" class="input" maxlength="150" placeholder="mis. batch pagi, gudang A">' +
    '<div class="sheet-actions"><button class="btn btn-soft" onclick="closeSheet()">Batal</button>' +
    '<button class="btn btn-primary" id="pr_save" onclick="simpanProduksiForm()">Produksi</button></div>');
  setTimeout(() => { const el = $('#pr_jml'); if (el) el.focus(); }, 80);
}

function kgProduksiForm() {
  const F = App.prodForm;
  const v = Number(String(($('#pr_jml') || {}).value || '').replace(',', '.'));
  if (!isFinite(v) || v <= 0) return null;
  const sat = $('#pr_sat').value;
  return Math.round(v * (sat === 'zak' ? F.zak : (sat === 'batch' ? F.r.hasil_kg_batch : 1)) * 100) / 100;
}

function hitungProduksiForm() {
  const F = App.prodForm, box = $('#pr_prev');
  if (!F || !box) return;
  const kg = kgProduksiForm();
  F.kurang = false;
  if (kg === null) { box.innerHTML = ''; return; }
  const f = kg / F.r.hasil_kg_batch;
  let html = '<div class="ok"><span>Hasil: ' + esc(F.r.nama_hasil) + ($('#pr_sat').value !== 'kg' ? ' (' + fKg(kg) + ' kg)' : '') + '</span><b>+' + fKg(kg) + ' kg</b></div>';
  F.r.bahan.forEach(b => {
    const perlu = Math.round(b.jumlah_kg * f * 100) / 100;
    const bad = perlu > b.stok + 0.0001;
    if (bad) F.kurang = true;
    html += '<div class="' + (bad ? 'bad' : '') + '"><span>' + esc(b.nama) + (bad ? ' • stok kurang (' + fKg(b.stok) + ' kg)' : '') + '</span><b>−' + fKg(perlu) + ' kg</b></div>';
  });
  box.innerHTML = html;
}

async function simpanProduksiForm() {
  const F = App.prodForm;
  if (!F) return;
  const kg = kgProduksiForm();
  if (kg === null) { toast('Isi jumlah pakan jadi lebih dari 0.', 'error'); return; }
  if (F.kurang) { toast('Stok salah satu bahan baku tidak cukup. Kurangi jumlah atau tambah stok bahan.', 'error'); return; }
  const payload = { resep_id: F.r.resep_id, jumlah_hasil_kg: kg, keterangan: ($('#pr_ket').value || '').trim() };
  if ($('#pr_tgl')) payload.tanggal = $('#pr_tgl').value;
  const btn = $('#pr_save');
  setBusyBtn(btn, true, 'Memproses...');
  const res = await call('jalankanProduksi', App.token, payload);
  setBusyBtn(btn, false);
  if (!res) return;
  closeSheet();
  toast(res.message, 'success');
  renderStok(true);
}

/** Form tambah / ubah resep (Pemilik). */
function formResep(resepId) {
  const d = App.stok.data;
  const hasilOpsi = d.items.filter(i => i.kategori === 'PAKAN_JADI' && i.status === 'AKTIF');
  if (!hasilOpsi.length) { toast('Tambahkan dulu barang Pakan Jadi sebagai hasil resep.', 'warn'); return; }
  if (!d.items.some(i => i.kategori === 'BAHAN_BAKU' && i.status === 'AKTIF')) { toast('Tambahkan dulu barang Bahan Baku.', 'warn'); return; }
  const r = resepId ? d.resep.find(x => x.resep_id === resepId) : null;
  App.resepForm = {
    id: r ? r.resep_id : '',
    bahan: r ? r.bahan.map(b => ({ item_id: b.item_id, jumlah: String(b.jumlah_kg) })) : [{ item_id: '', jumlah: '' }, { item_id: '', jumlah: '' }]
  };
  openSheet(r ? 'Ubah Resep' : 'Resep Baru',
    '<label class="lbl" for="rs_nama" style="margin-top:0">Nama resep</label><input id="rs_nama" class="input" maxlength="60" placeholder="mis. Layer Produksi" value="' + esc(r ? r.nama_resep : '') + '">' +
    '<label class="lbl" for="rs_hasil">Hasil (Pakan Jadi)</label><select id="rs_hasil" class="input">' +
    hasilOpsi.map(i => '<option value="' + esc(i.item_id) + '"' + (r && r.item_hasil_id === i.item_id ? ' selected' : '') + '>' + esc(i.nama) + '</option>').join('') + '</select>' +
    '<label class="lbl">Bahan baku &amp; takaran per 1 batch (kg)</label><div id="rs_rows"></div>' +
    '<button type="button" class="btn btn-soft btn-sm" onclick="tambahBarisResep()"><i class="bi bi-plus-lg"></i> Tambah bahan</button>' +
    '<p class="field-hint" id="rs_total" style="margin-top:8px"></p>' +
    '<label class="lbl" for="rs_batch">Hasil per batch (kg, opsional)</label><input id="rs_batch" class="input" type="number" inputmode="decimal" min="0" step="any" value="' + esc(r ? r.hasil_kg_batch : '') + '">' +
    '<p class="field-hint">Kosongkan bila hasil = total bahan (mis. total takaran 1.000 kg → 1 batch = 1.000 kg pakan jadi).</p>' +
    '<label class="check" style="margin-top:12px"><input type="checkbox" id="rs_sekali"' + (r && r.sekali_pakai ? ' checked' : '') + '> Sekali pakai</label>' +
    '<p class="field-hint">Resep ini otomatis terhapus dari daftar begitu pakan hasil produksinya habis terpakai (oleh Input Harian atau stok keluar). Catatan produksi dan riwayat stok tetap tersimpan. Biarkan kosong untuk resep yang dipakai berulang.</p>' +
    '<label class="check" style="margin-top:12px"><input type="checkbox" id="rs_langsung"' + (r ? '' : ' checked') + '> Langsung produksi 1 batch setelah disimpan</label>' +
    '<p class="field-hint">Total hasil resep langsung masuk ke stok pakan jadi dan bahan baku berkurang, tanpa konfirmasi lagi.</p>' +
    (r ? '<label class="lbl" for="rs_status">Status</label><select id="rs_status" class="input"><option value="AKTIF"' + (r.status === 'AKTIF' ? ' selected' : '') + '>Aktif</option>' +
      '<option value="NONAKTIF"' + (r.status !== 'AKTIF' ? ' selected' : '') + '>Nonaktif (tidak bisa diproduksi)</option></select>' : '') +
    '<div class="sheet-actions"><button class="btn btn-soft" onclick="closeSheet()">Batal</button>' +
    '<button class="btn btn-primary" id="rs_save" onclick="simpanResepForm()">Simpan</button></div>');
  paintResepRows();
}

function paintResepRows() {
  const F = App.resepForm, box = $('#rs_rows');
  if (!F || !box) return;
  const opsi = App.stok.data.items.filter(i => i.kategori === 'BAHAN_BAKU');
  box.innerHTML = F.bahan.map((b, i) =>
    '<div class="rs-row"><select class="input" aria-label="Bahan ' + (i + 1) + '" onchange="App.resepForm.bahan[' + i + '].item_id=this.value"><option value="">Pilih bahan...</option>' +
    opsi.map(o => '<option value="' + esc(o.item_id) + '"' + (b.item_id === o.item_id ? ' selected' : '') + '>' + esc(o.nama) + (o.status !== 'AKTIF' ? ' (nonaktif)' : '') + '</option>').join('') + '</select>' +
    '<input class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="kg" value="' + esc(b.jumlah) + '" aria-label="Jumlah bahan ' + (i + 1) + ' (kg)" oninput="App.resepForm.bahan[' + i + '].jumlah=this.value;totalResepForm()">' +
    '<button type="button" class="icon-btn sm danger" aria-label="Hapus bahan ' + (i + 1) + '" onclick="hapusBarisResep(' + i + ')"><i class="bi bi-x-lg"></i></button></div>').join('');
  totalResepForm();
}
function tambahBarisResep() { App.resepForm.bahan.push({ item_id: '', jumlah: '' }); paintResepRows(); }
function hapusBarisResep(i) {
  App.resepForm.bahan.splice(i, 1);
  if (!App.resepForm.bahan.length) App.resepForm.bahan.push({ item_id: '', jumlah: '' });
  paintResepRows();
}
function totalResepForm() {
  const F = App.resepForm;
  if (!F) return;
  const t = F.bahan.reduce((s, b) => s + (Number(String(b.jumlah).replace(',', '.')) || 0), 0);
  const el = $('#rs_total'), bt = $('#rs_batch');
  if (el) el.textContent = 'Total bahan per batch: ' + fKg(Math.round(t * 100) / 100) + ' kg';
  if (bt) bt.placeholder = t > 0 ? 'otomatis = ' + fKg(Math.round(t * 100) / 100) : '';
}

async function simpanResepForm() {
  const F = App.resepForm;
  if (!F) return;
  const nama = ($('#rs_nama').value || '').trim();
  if (nama.length < 2) { toast('Nama resep minimal 2 huruf.', 'error'); return; }
  const bahan = [];
  const dipakai = {};
  for (const b of F.bahan) {
    const kosong = !b.item_id && String(b.jumlah).trim() === '';
    if (kosong) continue;
    const j = Number(String(b.jumlah).replace(',', '.'));
    if (!b.item_id || !isFinite(j) || j <= 0) { toast('Lengkapi bahan dan jumlah kg (lebih dari 0) pada setiap baris.', 'error'); return; }
    if (dipakai[b.item_id]) { toast('Satu bahan tidak boleh muncul dua kali dalam satu resep.', 'error'); return; }
    dipakai[b.item_id] = 1;
    bahan.push({ item_id: b.item_id, jumlah_kg: j });
  }
  if (!bahan.length) { toast('Tambahkan minimal satu bahan baku.', 'error'); return; }
  const payload = {
    resep_id: F.id, nama_resep: nama, item_hasil_id: $('#rs_hasil').value, bahan: bahan,
    hasil_kg_batch: String($('#rs_batch').value || '').replace(',', '.'), status: $('#rs_status') ? $('#rs_status').value : 'AKTIF',
    sekali_pakai: !!($('#rs_sekali') && $('#rs_sekali').checked)
  };
  const btn = $('#rs_save');
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = await call('simpanResep', App.token, payload);
  setBusyBtn(btn, false);
  if (!res) return;
  const langsung = $('#rs_langsung') && $('#rs_langsung').checked;
  const status = payload.status;
  let kgBatch = Number(payload.hasil_kg_batch);
  if (!isFinite(kgBatch) || kgBatch <= 0) kgBatch = Math.round(bahan.reduce((t, b) => t + b.jumlah_kg, 0) * 100) / 100;
  closeSheet();
  toast(res.message, 'success');
  App.stok.tab = 'RESEP';
  if (langsung && status === 'AKTIF') {
    const pr = await call('jalankanProduksi', App.token, { resep_id: res.data.resep_id, jumlah_hasil_kg: kgBatch });
    if (pr) toast(pr.message, 'success');
    else toast('Resep tersimpan, tapi produksi belum jalan. Cek stok bahan baku lalu tekan Produksi 1 Batch.', 'warn');
  }
  renderStok(true);
}

/** Form tambah / ubah barang (Pemilik). */
function formItemStok(itemId, kategori) {
  const it = itemId ? App.stok.data.items.find(i => i.item_id === itemId) : null;
  App.stokItemEdit = it ? it.item_id : null;
  const kat = it ? it.kategori : (kategori || (App.stok.tab === 'PAKAN_JADI' ? 'PAKAN_JADI' : 'BAHAN_BAKU'));
  openSheet(it ? 'Ubah Barang' : 'Barang Baru',
    '<label class="lbl" for="i_kat" style="margin-top:0">Kategori</label>' +
    '<select id="i_kat" class="input" onchange="toggleAutoBox()"' + (it ? ' disabled' : '') + '>' + Object.keys(STOK_KAT).map(k => '<option value="' + k + '"' + (kat === k ? ' selected' : '') + '>' + STOK_KAT[k] + '</option>').join('') + '</select>' +
    '<label class="lbl" for="i_nama">Nama barang</label><input id="i_nama" class="input" maxlength="60" placeholder="mis. Jagung Giling" value="' + esc(it ? it.nama : '') + '">' +
    '<label class="lbl" for="i_min">Stok minimum (kg)</label><input id="i_min" class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="0 = tanpa peringatan" value="' + esc(it && it.stok_minimum ? it.stok_minimum : '') + '">' +
    '<p class="field-hint">Bila stok sama dengan atau di bawah angka ini, barang ditandai "Stok menipis".</p>' +
    '<div id="i_auto_box" class="auto-box"><label class="check"><input type="checkbox" id="i_auto" onchange="toggleAutoBox()"' + (it && it.auto_harian ? ' checked' : '') + '> Berkurang otomatis dari Input Harian</label>' +
    '<p class="field-hint">Pakan (kg) yang diisi di Input Harian otomatis mengurangi stok barang ini. Hanya satu barang yang bisa otomatis.</p>' +
    '<div id="i_auto_tgl"><label class="lbl" for="i_mulai">Dihitung mulai tanggal</label><input id="i_mulai" class="input" type="date" value="' + esc(it && it.auto_mulai ? it.auto_mulai : hariIniWIB()) + '" max="' + hariIniWIB() + '">' +
    '<p class="field-hint">Pakan sebelum tanggal ini tidak ikut mengurangi stok. Pastikan stok awal sudah dicatat lewat Masuk atau Koreksi.</p></div></div>' +
    (it ? '<label class="lbl" for="i_status">Status</label><select id="i_status" class="input"><option value="AKTIF"' + (it.status === 'AKTIF' ? ' selected' : '') + '>Aktif</option>' +
      '<option value="NONAKTIF"' + (it.status !== 'AKTIF' ? ' selected' : '') + '>Nonaktif (disembunyikan dari pencatatan)</option></select>' : '') +
    '<div class="sheet-actions"><button class="btn btn-soft" onclick="closeSheet()">Batal</button>' +
    '<button class="btn btn-primary" id="i_save" onclick="simpanItemStokForm()">Simpan</button></div>');
  toggleAutoBox();
}

/** Opsi "otomatis" hanya untuk Pakan Jadi; tanggal mulai tampil bila dicentang. */
function toggleAutoBox() {
  const box = $('#i_auto_box');
  if (!box) return;
  const pakan = $('#i_kat').value === 'PAKAN_JADI';
  box.hidden = !pakan;
  const tgl = $('#i_auto_tgl');
  if (tgl) tgl.hidden = !(pakan && $('#i_auto').checked);
}

async function simpanItemStokForm() {
  const nama = ($('#i_nama').value || '').trim();
  if (nama.length < 2) { toast('Nama barang minimal 2 huruf.', 'error'); return; }
  const payload = {
    item_id: App.stokItemEdit || '', kategori: $('#i_kat').value, nama: nama,
    stok_minimum: String($('#i_min').value || '').replace(',', '.'), status: $('#i_status') ? $('#i_status').value : 'AKTIF'
  };
  payload.auto_harian = $('#i_kat').value === 'PAKAN_JADI' && $('#i_auto').checked;
  if (payload.auto_harian) payload.auto_mulai = $('#i_mulai').value;
  const btn = $('#i_save');
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = await call('simpanItemStok', App.token, payload);
  setBusyBtn(btn, false);
  if (!res) return;
  closeSheet();
  toast(res.message, 'success');
  App.stok.tab = payload.kategori;
  renderStok(true);
}

function hapusStokTrx(id) {
  confirmSheet({
    title: 'Hapus Catatan Stok?', danger: true, cancelText: 'Batal', okText: 'Ya, Hapus',
    note: 'Saldo stok dihitung ulang. Catatan tetap tersimpan di Sheets sebagai arsip. Ditolak bila membuat stok menjadi minus.',
    rows: [],
    onOk: async () => {
      const res = await call('hapusTransaksiStok', App.token, id);
      if (!res) return;
      closeSheet();
      toast(res.message, 'success');
      const r = await call('getStok', App.token);
      if (r) App.stok.data = r.data;
      paintStok();
    }
  });
}

// ════════════════════════════════════════════════════════
// BAGIAN 8: PROFIL
// ════════════════════════════════════════════════════════

function renderProfil() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  $('#app-container').innerHTML =
    '<section class="card"><div class="profile-head"><div class="avatar"><i class="bi bi-person"></i></div><div>' +
    '<h2 style="font-size:20px;font-weight:800">' + esc(App.user.nama) + '</h2><p class="muted sm">' + esc(App.user.email) + '</p>' +
    '<span class="badge b-pri" style="margin-top:6px">' + roleLabel(App.user.peran) + '</span></div></div></section>' +
    '<section class="card"><div class="switch-row"><div><strong>Mode Gelap</strong><p class="muted sm">Lebih nyaman dipakai malam hari</p></div>' +
    '<label class="switch"><input type="checkbox" id="themeSw" ' + (dark ? 'checked' : '') + ' onchange="toggleTheme()" aria-label="Mode gelap"><span></span></label></div></section>' +
    '<section class="card"><div class="card-head"><span class="ico-badge gold"><i class="bi bi-key"></i></span><div><h3>Ganti PIN</h3><p class="muted sm">Setelah diganti, Anda perlu masuk kembali</p></div></div>' +
    '<label class="lbl" for="p_lama" style="margin-top:0">PIN Lama</label><input id="p_lama" class="input" type="password" inputmode="numeric" maxlength="8" autocomplete="current-password">' +
    '<label class="lbl" for="p_baru">PIN Baru (4–8 angka)</label><input id="p_baru" class="input" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password">' +
    '<label class="lbl" for="p_ulang">Ulangi PIN Baru</label><input id="p_ulang" class="input" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password">' +
    '<button class="btn btn-primary btn-block" id="p_save" style="margin-top:16px" onclick="savePin()">Ganti PIN</button></section>' +
    '<button class="btn btn-soft btn-block" onclick="logout()"><i class="bi bi-box-arrow-right"></i> Keluar</button>' +
    '<p class="foot-note">Jatmiko Farm Layer v4.3 • Zona waktu WIB</p>';
}
async function savePin() {
  const lama = $('#p_lama').value.trim(), baru = $('#p_baru').value.trim(), ulang = $('#p_ulang').value.trim();
  if (!lama || !baru) { toast('Isi PIN lama dan PIN baru.', 'error'); return; }
  if (!/^\d{4,8}$/.test(baru)) { toast('PIN baru harus 4–8 digit angka.', 'error'); return; }
  if (baru !== ulang) { toast('Konfirmasi PIN baru tidak sama.', 'error'); return; }
  const btn = $('#p_save');
  setBusyBtn(btn, true, 'Menyimpan...');
  const res = await call('gantiPinSendiri', App.token, lama, baru);
  setBusyBtn(btn, false);
  if (!res) return;
  forceLogout('PIN berhasil diganti. Silakan masuk dengan PIN baru.');
}

// ════════════════════════════════════════════════════════
// BAGIAN 9: INISIALISASI
// ════════════════════════════════════════════════════════

function hideBoot() {
  const b = $('#bootOverlay');
  if (!b) return;
  b.classList.add('out');
  setTimeout(() => { b.style.display = 'none'; }, 350);
}

pasangLogo();

document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(store.get('agl_theme') === 'dark' ? 'dark' : 'light');
  const t = store.get('agl_token');
  if (t) {
    App.token = t;
    let boot = null;
    try { boot = JSON.parse(store.get('agl_boot') || 'null'); } catch (e) { boot = null; }
    if (boot && boot.user && boot.floks) {
      tampilkanApp(boot);       // tampil seketika dari cache
      hideBoot();
      segarkanBoot();           // verifikasi sesi & data terbaru di latar
      return;
    }
    try { await enterApp(); } catch (e) { if ($('#loginView').hidden) renderLogin(); }
  } else {
    renderLogin();
  }
  hideBoot();
});

// ── v4.1: jaga server GAS tetap "hangat" & segarkan saat aplikasi dibuka kembali ──
(function () {
  let terakhirWarm = 0;
  function warm() {
    const url = (typeof GAS_URL === 'string' ? GAS_URL : '').trim();
    if (!url || /XXXX|ISI_URL/.test(url) || document.hidden) return;
    if (Date.now() - terakhirWarm < 60000) return;
    terakhirWarm = Date.now();
    try { fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'ping=1', { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); } catch (e) { /* diabaikan */ }
  }
  warm();                                     // saat halaman dibuka: bangunkan server sebelum user login/klik
  setInterval(warm, 4 * 60 * 1000);           // lalu tiap 4 menit selama tab terbuka
  let terakhirTampil = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { terakhirTampil = Date.now(); return; }
    warm();
    if (App.token && App.user && Date.now() - terakhirTampil > 60000) prefetchHalaman(true);   // balik ke aplikasi → data diperbarui diam-diam
  });
})();
