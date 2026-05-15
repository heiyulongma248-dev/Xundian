// 寻典网页版 — IndexedDB 持久化层
//
// 用一个轻量自封的 Promise-API（不引入 Dexie，省一份 CDN 依赖；
// 浏览器 IndexedDB 原生 API 难用主要是回调式，封一层就好）。
//
// 三个对象库：
//   books    主键 file_id，{file_id, handle, author, title, doc_type, place, publisher, year, folder}
//   folders  主键 name，{name}
//   caches   主键 file_id，{file_id, pages, page_count, low_quality_pages, signature}
//   settings 主键 'singleton'，{key: 'singleton', threshold, ctx_weight, top_k}
//
// 注意：FileSystemFileHandle 在 Chromium 里可以被 structured-clone 进 IndexedDB
//      —— 这正是网页版"记得 PDF 在哪儿"的关键。

'use strict';

const DB_NAME = 'xundian';
const DB_VERSION = 1;
const STORE_BOOKS = 'books';
const STORE_FOLDERS = 'folders';
const STORE_CACHES = 'caches';
const STORE_SETTINGS = 'settings';

const SETTINGS_KEY = 'singleton';

class XunDianDB {
  constructor() {
    this._db = null;
    this._openPromise = null;
  }

  open() {
    if (this._openPromise) return this._openPromise;
    this._openPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_BOOKS)) {
          db.createObjectStore(STORE_BOOKS, { keyPath: 'file_id' });
        }
        if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
          db.createObjectStore(STORE_FOLDERS, { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains(STORE_CACHES)) {
          db.createObjectStore(STORE_CACHES, { keyPath: 'file_id' });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
    return this._openPromise;
  }

  async _tx(stores, mode = 'readonly') {
    const db = await this.open();
    return db.transaction(stores, mode);
  }

  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // —— books ——

  async listBooks() {
    const tx = await this._tx([STORE_BOOKS]);
    return await this._req(tx.objectStore(STORE_BOOKS).getAll());
  }

  async getBook(fileId) {
    const tx = await this._tx([STORE_BOOKS]);
    return await this._req(tx.objectStore(STORE_BOOKS).get(fileId));
  }

  async putBook(book) {
    const tx = await this._tx([STORE_BOOKS], 'readwrite');
    await this._req(tx.objectStore(STORE_BOOKS).put(book));
  }

  async deleteBook(fileId) {
    const tx = await this._tx([STORE_BOOKS, STORE_CACHES], 'readwrite');
    await this._req(tx.objectStore(STORE_BOOKS).delete(fileId));
    await this._req(tx.objectStore(STORE_CACHES).delete(fileId));
  }

  // —— folders ——

  async listFolders() {
    const tx = await this._tx([STORE_FOLDERS]);
    return await this._req(tx.objectStore(STORE_FOLDERS).getAll());
  }

  async putFolder(name) {
    const tx = await this._tx([STORE_FOLDERS], 'readwrite');
    await this._req(tx.objectStore(STORE_FOLDERS).put({ name }));
  }

  async renameFolder(oldName, newName) {
    const tx = await this._tx([STORE_FOLDERS, STORE_BOOKS], 'readwrite');
    const folders = tx.objectStore(STORE_FOLDERS);
    const books = tx.objectStore(STORE_BOOKS);
    await this._req(folders.delete(oldName));
    await this._req(folders.put({ name: newName }));
    // 顺便把书的 folder 字段更新
    const allBooks = await this._req(books.getAll());
    for (const b of allBooks) {
      if (b.folder === oldName) {
        b.folder = newName;
        await this._req(books.put(b));
      }
    }
  }

  async deleteFolder(name) {
    const tx = await this._tx([STORE_FOLDERS, STORE_BOOKS], 'readwrite');
    const folders = tx.objectStore(STORE_FOLDERS);
    const books = tx.objectStore(STORE_BOOKS);
    await this._req(folders.delete(name));
    const allBooks = await this._req(books.getAll());
    let affected = 0;
    for (const b of allBooks) {
      if (b.folder === name) {
        b.folder = null;
        await this._req(books.put(b));
        affected += 1;
      }
    }
    return affected;
  }

  async updateBookFolders(fileIds, folder) {
    const tx = await this._tx([STORE_BOOKS, STORE_FOLDERS], 'readwrite');
    const books = tx.objectStore(STORE_BOOKS);
    if (folder) {
      // 自动登记新文件夹
      await this._req(tx.objectStore(STORE_FOLDERS).put({ name: folder }));
    }
    let affected = 0;
    for (const fid of fileIds) {
      const b = await this._req(books.get(fid));
      if (b) {
        b.folder = folder || null;
        await this._req(books.put(b));
        affected += 1;
      }
    }
    return affected;
  }

  // —— caches ——

  async getCache(fileId) {
    const tx = await this._tx([STORE_CACHES]);
    return await this._req(tx.objectStore(STORE_CACHES).get(fileId));
  }

  async putCache(record) {
    // record: { file_id, pages, page_count, low_quality_pages, signature }
    const tx = await this._tx([STORE_CACHES], 'readwrite');
    await this._req(tx.objectStore(STORE_CACHES).put(record));
  }

  async deleteCache(fileId) {
    const tx = await this._tx([STORE_CACHES], 'readwrite');
    await this._req(tx.objectStore(STORE_CACHES).delete(fileId));
  }

  async clearCaches(fileIds) {
    const tx = await this._tx([STORE_CACHES], 'readwrite');
    const store = tx.objectStore(STORE_CACHES);
    let cleared = 0;
    for (const fid of fileIds) {
      await this._req(store.delete(fid));
      cleared += 1;
    }
    return cleared;
  }

  // —— settings ——

  async getSettings() {
    const tx = await this._tx([STORE_SETTINGS]);
    const rec = await this._req(tx.objectStore(STORE_SETTINGS).get(SETTINGS_KEY));
    if (!rec) return null;
    const { key, ...rest } = rec;
    return rest;
  }

  async putSettings(settings) {
    const tx = await this._tx([STORE_SETTINGS], 'readwrite');
    await this._req(tx.objectStore(STORE_SETTINGS).put({ key: SETTINGS_KEY, ...settings }));
  }
}

window.db = new XunDianDB();

// —— 高级辅助：拼接出 app.js 期望的 "book 对象" 结构 ——
// 桌面版 list_books 返回的对象字段：
//   file_id, pdf_path, author, title, doc_type, place, publisher, year,
//   page_offset, folder, exists, parsed, page_count, low_quality_pages
// 网页版 pdf_path 没有了（FS handle 没有公开路径），但保留字段名，值用 handle.name 替代显示。
window.dbHelpers = {
  async getBooksForUI() {
    const [books, caches] = await Promise.all([
      window.db.listBooks(),
      (async () => {
        // 一次拿全部 caches
        const tx = await window.db._tx([STORE_CACHES]);
        return await window.db._req(tx.objectStore(STORE_CACHES).getAll());
      })(),
    ]);
    const cacheBy = new Map(caches.map((c) => [c.file_id, c]));
    return books.map((b) => {
      const c = cacheBy.get(b.file_id);
      return {
        file_id: b.file_id,
        pdf_path: b.handle ? b.handle.name : '(浏览器内部)',
        handle_name: b.handle ? b.handle.name : '',
        author: b.author || 'XX',
        title: b.title || (b.file_id || '').replace(/\.pdf$/i, ''),
        doc_type: b.doc_type || 'M',
        place: b.place || 'XX',
        publisher: b.publisher || 'XX出版社',
        year: b.year || '0000',
        // 新增 4 字段（默认空串，按"留空"语义）
        role: b.role || '',
        country: b.country || '',
        translator: b.translator || '',
        edition: b.edition || '',
        page_offset: b.page_offset != null ? b.page_offset : null,
        folder: b.folder || null,
        // 运行时字段
        exists: !!b.handle,    // 在网页版里有 handle 就视为存在；
                               // 真实的"文件是否还在"由用户首次读时才知道
        parsed: !!c,
        page_count: c ? c.page_count : 0,
        low_quality_pages: c ? c.low_quality_pages : 0,
      };
    });
  },

  async getBooksMeta() {
    const books = await window.db.listBooks();
    const out = {};
    for (const b of books) {
      out[b.file_id] = {
        author: b.author || 'XX',
        title: b.title || (b.file_id || '').replace(/\.pdf$/i, ''),
        doc_type: b.doc_type || 'M',
        place: b.place || 'XX',
        publisher: b.publisher || 'XX出版社',
        year: b.year || '0000',
        // 新增 4 字段
        role: b.role || '',
        country: b.country || '',
        translator: b.translator || '',
        edition: b.edition || '',
      };
    }
    return out;
  },

  // 取若干本书的解析缓存，返回 {file_id: pages_array}
  async getBooksPagesData(fileIds) {
    const out = {};
    for (const fid of fileIds) {
      const c = await window.db.getCache(fid);
      if (c && c.pages) out[fid] = c.pages;
    }
    return out;
  },
};

// —— 让 Python 端能直接调（用于 parse_books_batch 写缓存） ——
window.saveBookCache = async function saveBookCache(record) {
  // record 可能是 PyProxy（dict_converter 未生效时）/ Map / Object —— 统一规整
  if (record && typeof record.toJs === 'function') {
    record = record.toJs({ dict_converter: Object.fromEntries });
  }
  if (record instanceof Map) {
    record = Object.fromEntries(record);
  }
  if (!record || !record.file_id) return false;
  // pages 内嵌的元素也可能是 Map → 递归扁平化
  if (Array.isArray(record.pages)) {
    record.pages = record.pages.map((p) => (p instanceof Map ? Object.fromEntries(p) : p));
  }
  await window.db.putCache({
    file_id: record.file_id,
    pages: record.pages || [],
    page_count: record.page_count || (record.pages ? record.pages.length : 0),
    low_quality_pages: record.low_quality_pages || 0,
    signature: record.signature || null,
  });
  return true;
};
