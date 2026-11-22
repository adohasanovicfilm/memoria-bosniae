const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net, safeStorage } = require('electron');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const MB = global.MB || { root: __dirname, version: app.getVersion(), bundled: __dirname };
const dataDir = () => app.getPath('userData');
const dbPath = () => path.join(dataDir(), 'memoria-bosniae.json');

const UA = 'MEMORIA-BOSNIAE/3.1 (film archive; Ado Hasanovic)';
const posterDir = () => path.join(dataDir(), 'posteri');
const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function getJSON(url) {
  const r = await net.fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const goodImg = t => t && t.source && !/\.svg/i.test(t.source) && !/(flag|logo|icon|map)/i.test(t.source);
async function byTitles(lang, titles) {
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=600&titles=${encodeURIComponent(titles.join('|'))}`;
  const j = await getJSON(u);
  const q = j.query || {};
  const alias = {};
  (q.normalized || []).forEach(n => alias[n.from] = n.to);
  (q.redirects || []).forEach(n => alias[n.from] = n.to);
  const pages = {};
  Object.values(q.pages || {}).forEach(p => { pages[p.title] = p; });
  for (const t of titles) {
    let k = t, guard = 0;
    while (alias[k] && guard++ < 3) k = alias[k];
    const p = pages[k];
    if (p && !('missing' in p) && goodImg(p.thumbnail)) return p.thumbnail.source;
  }
  return null;
}
async function bySearch(lang, title, year) {
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(`${title} ${year || ''} film`)}&gsrlimit=6&prop=pageimages&piprop=thumbnail&pithumbsize=600`;
  const j = await getJSON(u);
  const list = Object.values((j.query || {}).pages || {}).sort((a, b) => a.index - b.index);
  const want = norm(title);
  const hit = list.find(p => norm(p.title).startsWith(want) && goodImg(p.thumbnail));
  return hit ? hit.thumbnail.source : null;
}
async function findPoster(f) {
  const names = [...new Set([f.naslovEn, f.naslov].filter(Boolean))];
  const y = f.godina || '';
  for (const lang of ['en', 'bs', 'hr', 'sr', 'it']) {
    for (const t of names) {
      const tries = [`${t} (${y} film)`, `${t} (film)`, `${t} (${y} documentary)`, `${t} (dokumentarni film)`, `${t} (${y}. film)`, t];
      try { const s = await byTitles(lang, tries); if (s) return s; } catch (e) { /* next */ }
    }
  }
  for (const lang of ['en', 'bs', 'hr']) {
    for (const t of names) { try { const s = await bySearch(lang, t, y); if (s) return s; } catch (e) { /* next */ } }
  }
  return null;
}
ipcMain.handle('mb:poster', async (_e, f) => {
  const dir = posterDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = String(f.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const hit = fs.readdirSync(dir).find(n => n.startsWith(id + '.') && !n.endsWith('.none'));
  if (hit) return pathToFileURL(path.join(dir, hit)).href;
  const none = path.join(dir, id + '.none');
  if (fs.existsSync(none) && Date.now() - fs.statSync(none).mtimeMs < 7 * 864e5) return null;
  try {
    const src = await findPoster(f);
    if (!src) { fs.writeFileSync(none, ''); return null; }
    const r = await net.fetch(src, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ext = (src.match(/\.(jpe?g|png|webp|gif)(?:$|\?)/i) || [, 'jpg'])[1].toLowerCase();
    const file = path.join(dir, `${id}.${ext}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return pathToFileURL(file).href;
  } catch (e) { return null; }
});
ipcMain.handle('mb:play', (_e, url, title) => {
  if (!/^https?:\/\//i.test(String(url))) return false;
  const w = new BrowserWindow({ width: 1280, height: 780, title: title || 'MEMORIA BOSNIAE', backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  w.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  w.loadURL(url);
  return true;
});
// ---- objava na GitHub Pages
const REPO = 'adohasanovicfilm/memoria-bosniae';
const ghFile = () => path.join(dataDir(), 'github.bin');
function readToken() {
  try {
    const b = fs.readFileSync(ghFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8');
  } catch (e) { return ''; }
}
function writeToken(t) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(ghFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : Buffer.from(t, 'utf8'), { mode: 0o600 });
}
async function gh(method, url, token, body) {
  const r = await net.fetch('https://api.github.com' + url, {
    method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
  return { status: r.status, ok: r.ok, j };
}
const blobSha = buf => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
let lastUser = '';
ipcMain.handle('mb:version', () => MB.version);
ipcMain.handle('mb:restart', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('mb:checkUpdate', () => checkUpdate(true));
ipcMain.handle('mb:tokenInfo', () => ({ has: !!readToken(), user: lastUser }));
ipcMain.handle('mb:setToken', async (_e, t) => {
  t = String(t || '').trim();
  try {
    const r = await gh('GET', `/repos/${REPO}`, t);
    if (!r.ok) return { ok: false, error: r.status === 404 ? 'ključ nema pristup repou memoria-bosniae' : 'GitHub kaže ' + r.status };
    if (r.j && r.j.permissions && !r.j.permissions.push) return { ok: false, error: 'ključ nema pravo pisanja (Contents: Read and write)' };
    writeToken(t);
    const u = await gh('GET', '/user', t); lastUser = (u.j && u.j.login) || '';
    return { ok: true };
  } catch (e) { return { ok: false, error: 'nema interneta' }; }
});
ipcMain.handle('mb:openExternal', (_e, url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(url); });
ipcMain.handle('mb:publish', async (_e, dataJson) => {
  const token = readToken();
  if (!token) return { ok: false, error: 'nema ključa' };
  const files = [
    ['data.json', Buffer.from(dataJson, 'utf8')],
    ['index.html', fs.readFileSync(path.join(MB.root, 'web.html'))],
    ['fonts.css', fs.readFileSync(path.join(MB.bundled, 'fonts.css'))],
    ['.nojekyll', Buffer.from('')],
    ...fs.readdirSync(path.join(MB.bundled, 'fonts')).map(n => ['fonts/' + n, fs.readFileSync(path.join(MB.bundled, 'fonts', n))])
  ];
  try {
    let changed = 0;
    for (const [p, buf] of files) {
      const cur = await gh('GET', `/repos/${REPO}/contents/${encodeURI(p)}`, token);
      const sha = cur.ok && cur.j && cur.j.sha;
      if (sha && sha === blobSha(buf)) continue;
      const put = await gh('PUT', `/repos/${REPO}/contents/${encodeURI(p)}`, token, { message: `Objava ${new Date().toISOString().slice(0, 16)}: ${p}`, content: buf.toString('base64'), ...(sha ? { sha } : {}) });
      if (!put.ok) return { ok: false, error: `${p}: GitHub ${put.status}` };
      changed++;
    }
    return { ok: true, changed };
  } catch (e) { return { ok: false, error: 'nema interneta' }; }
});

function resetPosters() {
  try { const d = posterDir(); fs.readdirSync(d).forEach(n => fs.unlinkSync(path.join(d, n))); } catch (e) { /* nothing */ }
  BrowserWindow.getAllWindows().forEach(w => w.webContents.reload());
}

function backup() {
  try {
    const dir = path.join(dataDir(), 'kopije');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(dir, `memoria-bosniae-${day}.json`);
    if (fs.existsSync(dbPath()) && !fs.existsSync(target)) fs.copyFileSync(dbPath(), target);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (e) { /* best effort */ }
}

ipcMain.handle('mb:load', () => {
  try { if (fs.existsSync(dbPath())) return fs.readFileSync(dbPath(), 'utf8'); } catch (e) { /* seed */ }
  try { return fs.readFileSync(path.join(MB.bundled, 'seed.json'), 'utf8'); } catch (e) { return null; }
});
ipcMain.handle('mb:save', (_e, text) => {
  JSON.parse(text);
  fs.mkdirSync(dataDir(), { recursive: true });
  backup();
  const tmp = dbPath() + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, dbPath());
  return true;
});
ipcMain.handle('mb:saveFile', async (e, name, content) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});

// ---- automatsko ažuriranje
let mainWin = null;
const UPD = 'https://raw.githubusercontent.com/adohasanovicfilm/memoria-bosniae/main/app/';
const cmpV = (a, b) => { a = String(a).split('.').map(Number); b = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
let updating = false, readyVersion = null;
async function checkUpdate(manual) {
  if (updating) return { ok: true, busy: true };
  if (readyVersion) { if (mainWin) mainWin.webContents.send('mb:updateReady', readyVersion); return { ok: true, ready: readyVersion }; }
  updating = true;
  try {
    const r = await net.fetch(UPD + 'version.json?t=' + Date.now(), { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = await r.json();
    if (!m.version || !m.files || cmpV(m.version, MB.version) <= 0) { updating = false; return { ok: true, latest: true, version: MB.version }; }
    const tmp = path.join(dataDir(), 'update.new');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const [f, hash] of Object.entries(m.files)) {
      if (!/^[a-zA-Z0-9._-]+$/.test(f)) throw new Error('ime fajla');
      const res = await net.fetch(UPD + encodeURIComponent(f) + '?t=' + Date.now(), { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(f + ' HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== hash) throw new Error('provjera nije prošla: ' + f);
      fs.writeFileSync(path.join(tmp, f), buf);
    }
    fs.cpSync(path.join(MB.bundled, 'fonts'), path.join(tmp, 'fonts'), { recursive: true });
    fs.copyFileSync(path.join(MB.bundled, 'fonts.css'), path.join(tmp, 'fonts.css'));
    fs.writeFileSync(path.join(tmp, 'version.json'), JSON.stringify(m));
    const dst = path.join(dataDir(), 'update');
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(tmp, dst);
    readyVersion = m.version;
    if (mainWin) mainWin.webContents.send('mb:updateReady', m.version);
    updating = false;
    return { ok: true, ready: m.version };
  } catch (e) {
    updating = false;
    return { ok: false, error: String(e.message || e) };
  }
}
setInterval(() => checkUpdate(false), 6 * 3600 * 1000);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'MEMORIA BOSNIAE ' + MB.version, backgroundColor: '#f6f7f5',
    webPreferences: { preload: path.join(MB.root, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => {
    if (!url.startsWith('file://')) { ev.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.loadFile(path.join(MB.root, 'index.html'));
  mainWin = win;
  setTimeout(() => checkUpdate(false), 4000);
}

const isMac = process.platform === 'darwin';
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(isMac ? [{ role: 'appMenu' }] : []),
  { role: 'editMenu' },
  { label: 'Prikaz', submenu: [{ role: 'reload', label: 'Osvježi' }, { role: 'togglefullscreen', label: 'Cijeli ekran' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  { role: 'windowMenu' },
  { label: 'Pomoć', submenu: [
    { label: 'Otvori folder s bazom i kopijama', click: () => shell.openPath(dataDir()) },
    { label: 'Ponovo potraži sve plakate', click: resetPosters },
    { label: 'Provjeri ažuriranja', click: async () => { const r = await checkUpdate(true); if (r.ready) return; dialog.showMessageBox({ message: r.ok ? `Imaš najnoviju verziju (${MB.version}).` : 'Provjera nije uspjela: ' + r.error }); } },
    { label: 'Otvori web stranicu', click: () => shell.openExternal('https://adohasanovicfilm.github.io/memoria-bosniae/') },
    { label: 'O aplikaciji', click: () => dialog.showMessageBox({ message: 'MEMORIA BOSNIAE', detail: 'The Film Archive of the Bosnian War and the Srebrenica Genocide\nVerzija ' + MB.version + '\n\n© 2026 Ado Hasanović. Sva prava zadržana.' }) }
  ] }
]));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
