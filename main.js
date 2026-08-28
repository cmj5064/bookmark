const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { Client } = require('@notionhq/client');
const path = require('path');
const fs = require('fs');

let win;

const DEFAULT_NOTION_PAGE_ID = '3b9b2ed5673d806f980ac70b7f9b39a0';
const NOTION_VERSION = '2022-06-28';

// ── 사용자 데이터 파일 저장 (localStorage 대신 실제 파일에 저장해서 유실 방지) ──
function getDataFilePath() {
  return path.join(app.getPath('userData'), 'bookmark-data.json');
}

function getBookmarkDir() {
  const dir = app.isPackaged
    ? path.join(app.getPath('userData'), '.bookmark')
    : path.join(__dirname, '.bookmark');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getNotionConfigPath() {
  return path.join(app.getPath('userData'), 'notion.json');
}

function readNotionConfig() {
  try {
    const p = getNotionConfigPath();
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return {
        token: cfg.token || '',
        pageId: (cfg.pageId || DEFAULT_NOTION_PAGE_ID).trim() || DEFAULT_NOTION_PAGE_ID,
      };
    }
  } catch (e) {}
  return { token: '', pageId: DEFAULT_NOTION_PAGE_ID };
}

function formatNotionId(id) {
  const hex = String(id || '').replace(/-/g, '').trim();
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return String(id || '').trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

ipcMain.handle('data:load', () => {
  try {
    const p = getDataFilePath();
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (e) {}
  return null;
});

ipcMain.on('data:save', (event, json) => {
  try {
    const p = getDataFilePath();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, p); // 원자적 교체: 저장 도중 앱이 죽어도 기존 파일이 깨지지 않음
  } catch (e) {}
});

ipcMain.handle('csv:loadDefault', () => {
  const dir = getBookmarkDir();
  const files = fs.readdirSync(dir).filter((f) => /\.csv$/i.test(f));
  return {
    dir,
    files: files.map((name) => ({
      name,
      text: fs.readFileSync(path.join(dir, name), 'utf-8'),
    })),
  };
});

ipcMain.handle('csv:pickFiles', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'CSV 불러오기',
    defaultPath: getBookmarkDir(),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePaths.length) return [];
  return result.filePaths.map((p) => ({
    name: path.basename(p),
    text: fs.readFileSync(p, 'utf-8'),
  }));
});

ipcMain.handle('notion:getConfig', () => readNotionConfig());

ipcMain.handle('notion:saveConfig', (_e, cfg) => {
  const next = {
    token: (cfg && cfg.token) || '',
    pageId: ((cfg && cfg.pageId) || DEFAULT_NOTION_PAGE_ID).trim() || DEFAULT_NOTION_PAGE_ID,
  };
  fs.writeFileSync(getNotionConfigPath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
});

ipcMain.handle('notion:test', async () => {
  try {
    const { token, pageId } = readNotionConfig();
    if (!token) return { ok: false, error: 'Integration 토큰을 먼저 저장해 주세요.' };
    const info = await inspectNotionTarget(token, pageId);
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: notionErrorMessage(e) };
  }
});

ipcMain.handle('notion:import', async () => {
  try {
    const { token, pageId } = readNotionConfig();
    if (!token) return { ok: false, error: 'Integration 토큰을 먼저 저장해 주세요.' };
    const bookmarks = await importFromNotion(token, pageId);
    return { ok: true, bookmarks };
  } catch (e) {
    return { ok: false, error: notionErrorMessage(e) };
  }
});

function notionErrorMessage(e) {
  if (!e) return '노션 요청에 실패했어요.';
  const body = e.body || e;
  if (body && body.message) return body.message;
  if (e.code === 'object_not_found') {
    return '페이지를 찾을 수 없어요. Integration을 해당 페이지에 연결(공유)했는지 확인해 주세요.';
  }
  if (e.code === 'unauthorized') return '토큰이 올바르지 않아요.';
  return e.message || '노션 요청에 실패했어요.';
}

function makeClient(token) {
  return new Client({ auth: token, notionVersion: NOTION_VERSION });
}

function plainText(arr) {
  return (arr || []).map((t) => t.plain_text || '').join('').trim();
}

function extractValue(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title': return plainText(prop.title);
    case 'rich_text': return plainText(prop.rich_text);
    case 'url': return prop.url || '';
    case 'select': return (prop.select && prop.select.name) || '';
    case 'multi_select': return (prop.multi_select || []).map((s) => s.name).filter(Boolean).join('/');
    case 'status': return (prop.status && prop.status.name) || '';
    case 'date': return (prop.date && prop.date.start) || '';
    case 'number': return prop.number == null ? '' : String(prop.number);
    case 'checkbox': return prop.checkbox ? 'Y' : '';
    case 'email': return prop.email || '';
    case 'phone_number': return prop.phone_number || '';
    case 'files': {
      const f = (prop.files || [])[0];
      if (!f) return '';
      return (f.file && f.file.url) || (f.external && f.external.url) || '';
    }
    case 'formula':
      return prop.formula ? extractValue({ ...prop.formula, type: prop.formula.type }) : '';
    default:
      return '';
  }
}

function extractTags(prop) {
  if (!prop) return [];
  if (prop.type === 'multi_select') return (prop.multi_select || []).map((s) => s.name).filter(Boolean);
  if (prop.type === 'select' && prop.select) return [prop.select.name];
  const raw = extractValue(prop);
  return raw ? raw.split(/[/;,|]/).map((s) => s.trim()).filter(Boolean) : [];
}

function findProp(properties, names) {
  const entries = Object.entries(properties || {});
  const lowerNames = names.map((n) => n.toLowerCase());
  for (const n of lowerNames) {
    const hit = entries.find(([k]) => k.toLowerCase() === n);
    if (hit) return hit[1];
  }
  for (const n of lowerNames) {
    const hit = entries.find(([k]) => k.toLowerCase().includes(n));
    if (hit) return hit[1];
  }
  return null;
}

function titleFromProperties(properties) {
  for (const prop of Object.values(properties || {})) {
    if (prop && prop.type === 'title') return plainText(prop.title);
  }
  return '';
}

function coverUrl(page) {
  if (!page || !page.cover) return '';
  if (page.cover.type === 'external') return (page.cover.external && page.cover.external.url) || '';
  if (page.cover.type === 'file') return (page.cover.file && page.cover.file.url) || '';
  return '';
}

function notionPageUrl(id) {
  return 'https://www.notion.so/' + String(id).replace(/-/g, '');
}

function pageToBookmark(page) {
  const properties = page.properties || {};
  const title = titleFromProperties(properties)
    || extractValue(findProp(properties, ['Name', 'Title', '제목', '이름', '이름 없음']));
  const url = extractValue(findProp(properties, ['URL', 'url', 'Link', '링크', '주소', 'Website', '사이트']))
    || (typeof page.url === 'string' && !page.url.includes('notion.so') ? page.url : '');
  const content = extractValue(findProp(properties, ['내용', 'Description', '설명', '메모', 'Note', 'Summary'])) || title;
  const author = extractValue(findProp(properties, ['작성자', 'Author', '작가', '출처', 'Source', '계정']));
  const date = extractValue(findProp(properties, ['날짜', 'Date', 'Created', '생성', '추가']))
    || (page.created_time || '').slice(0, 10);
  const image = extractValue(findProp(properties, ['이미지', 'Image', 'Cover', '썸네일', 'Thumbnail'])) || coverUrl(page);
  const tags = extractTags(findProp(properties, ['태그', 'Tags', 'Tag', '분류', '카테고리']));
  const postUrl = url || notionPageUrl(page.id);
  return {
    id: page.id,
    source: 'notion',
    sourceId: page.id,
    tags,
    author,
    handle: '',
    content,
    imageUrl: image,
    hasVideo: false,
    date,
    postUrl,
    links: [],
    folderId: null,
  };
}

function blockToBookmark(block, url, caption) {
  return {
    id: block.id,
    source: 'notion',
    sourceId: block.id,
    tags: [],
    author: '',
    handle: '',
    content: caption || url,
    imageUrl: '',
    hasVideo: false,
    date: (block.created_time || '').slice(0, 10),
    postUrl: url,
    links: [],
    folderId: null,
  };
}

async function queryAllDatabasePages(client, databaseId) {
  const pages = [];
  let cursor;
  do {
    const res = await client.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function walkBlocks(client, blockId, out) {
  let cursor;
  do {
    const res = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of res.results) {
      if (block.type === 'child_database') {
        out.databaseIds.push(block.id);
      } else if (block.type === 'link_to_page' && block.link_to_page && block.link_to_page.type === 'database_id' && block.link_to_page.database_id) {
        out.databaseIds.push(block.link_to_page.database_id);
      } else if (block.type === 'bookmark' && block.bookmark && block.bookmark.url) {
        out.blockBookmarks.push(blockToBookmark(block, block.bookmark.url, plainText(block.bookmark.caption)));
      } else if (block.type === 'link_preview' && block.link_preview && block.link_preview.url) {
        out.blockBookmarks.push(blockToBookmark(block, block.link_preview.url, ''));
      } else if (block.type === 'embed' && block.embed && block.embed.url) {
        out.blockBookmarks.push(blockToBookmark(block, block.embed.url, plainText(block.embed.caption)));
      }
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        await walkBlocks(client, block.id, out);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
}

async function inspectNotionTarget(token, rawId) {
  const client = makeClient(token);
  const id = formatNotionId(rawId);
  try {
    const db = await client.databases.retrieve({ database_id: id });
    const title = (Array.isArray(db.title) ? plainText(db.title) : '') || titleFromProperties(db.properties) || '데이터베이스';
    return { kind: 'database', title };
  } catch (e) {
    if (!(e && (e.code === 'object_not_found' || e.status === 404 || e.code === 'validation_error'))) throw e;
  }
  const page = await client.pages.retrieve({ page_id: id });
  const out = { databaseIds: [], blockBookmarks: [] };
  await walkBlocks(client, id, out);
  out.databaseIds = [...new Set(out.databaseIds)];
  return {
    kind: 'page',
    title: titleFromProperties(page.properties) || '페이지',
    databaseCount: out.databaseIds.length,
    blockCount: out.blockBookmarks.length,
  };
}

async function importFromNotion(token, rawId) {
  const client = makeClient(token);
  const id = formatNotionId(rawId);
  const bookmarks = [];
  const seen = new Set();
  const pushAll = (list) => {
    for (const bm of list) {
      if (!bm || !bm.postUrl || seen.has(bm.postUrl)) continue;
      seen.add(bm.postUrl);
      bookmarks.push(bm);
    }
  };

  let asDatabase = false;
  try {
    await client.databases.retrieve({ database_id: id });
    asDatabase = true;
  } catch (e) {
    asDatabase = false;
  }

  if (asDatabase) {
    const pages = await queryAllDatabasePages(client, id);
    pushAll(pages.map(pageToBookmark));
    return bookmarks;
  }

  await client.pages.retrieve({ page_id: id });
  const out = { databaseIds: [], blockBookmarks: [] };
  await walkBlocks(client, id, out);
  out.databaseIds = [...new Set(out.databaseIds)];
  pushAll(out.blockBookmarks);
  for (const dbId of out.databaseIds) {
    const pages = await queryAllDatabasePages(client, dbId);
    pushAll(pages.map(pageToBookmark));
  }
  return bookmarks;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // 외부 링크는 기본 브라우저로 열기
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  getBookmarkDir();
  createWindow();

  // 업데이트 확인 (앱 시작 3초 후)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── 업데이트 이벤트 ──────────────────────────────────────
autoUpdater.on('update-available', (info) => {
  win.webContents.send('update-available', info.version);
});

autoUpdater.on('update-not-available', () => {
  // 조용히 무시
});

autoUpdater.on('download-progress', (progress) => {
  win.webContents.send('update-progress', Math.floor(progress.percent));
});

autoUpdater.on('update-downloaded', () => {
  win.webContents.send('update-downloaded');
});

autoUpdater.on('error', () => {
  // 조용히 무시
});

// 렌더러에서 "지금 설치" 요청을 받으면 재시작 후 업데이트
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});
