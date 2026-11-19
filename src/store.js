/*
 * ParaBene – the log of evaluated content (opt-in, `evalLogEnabled`).
 *
 * One record per evaluated text: what was judged, where, by what (keywords, the AI text model,
 * the AI image model), the verdict (hidden or shown) with the model's numbers, and the user's
 * correction if any. It is kept in IndexedDB (database "parabene", store "evaluations") in the
 * extension's own origin and never sent anywhere; the statistics page (stats/) reads it and the
 * panel exports it as a .jsonl file.
 *
 * Loaded by the service worker (the only writer of evaluations), the statistics page (which
 * writes the corrections) and the panel. Content scripts cannot open this database: they send
 * their verdicts to the service worker.
 *
 * Record:
 *   id        auto-incremented; a higher id is a newer record
 *   key       SHA-256 of what identifies the content, its site and its verdict (see keyText): the
 *             same text judged the same way on the same site again (a page reload) updates the
 *             record instead of adding one — `count` and `lastTime` tell how often and when last,
 *             `details` hold the numbers of the last evaluation
 *   time, lastTime   ISO timestamps of the first and the last evaluation
 *   url, host   the page's address without its query and fragment (see pageUrl), its host
 *   hidden    1 | 0 (a number, so it can be indexed)
 *   source    "keyword" | "ai";  media: "image" + image (address) for a verdict about a picture;
 *             a data: picture is recorded as its type and a fingerprint of its data (imageUrl)
 *   mode      "keywords" | "both" | "ai" at the time
 *   reason, category, fallback, details { score, threshold, probabilities, model }
 *   revealed  the user clicked "Show anyway";  learned: hidden but let through by a learned example
 *   text      the evaluated text (at most Config.LOG_MAX_TEXT characters)
 *   label     "hide" | "show": the user's correction (what the verdict should have been);
 *             absent when not corrected. Labelled records are not removed when the log is full.
 */
(function (root) {
  'use strict';

  const Config = root.ParaBeneConfig;
  const DB_NAME = 'parabene';
  const DB_VERSION = 1;
  const STORE = 'evaluations';
  const CHANNEL = 'parabene-log';

  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('key', 'key', { unique: true });
          store.createIndex('hidden', 'hidden');
          store.createIndex('label', 'label'); // only corrected records have the property
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another context wants to upgrade or delete the database: let it.
          db.onversionchange = () => {
            db.close();
            opening = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          opening = null;
          reject(request.error);
        };
      });
    }
    return opening;
  }

  function done(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function finished(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    });
  }

  /* ---------------- change notifications between the extension's pages ---------------- */

  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;

  function notify() {
    if (channel) channel.postMessage('changed');
  }

  /** Calls `callback` when another context has changed the log. Returns a function that stops it. */
  function subscribe(callback) {
    if (!channel) return () => {};
    const listener = () => callback();
    channel.addEventListener('message', listener);
    return () => channel.removeEventListener('message', listener);
  }

  /* ---------------- identity of a record ---------------- */

  /**
   * The same content on the same site with the same verdict is one record. The verdict is what
   * decided it, so a fallback to keywords, another mode, model, threshold or reason is a record of
   * its own and the statistics keep its numbers. The score is not part of it: the built-in model
   * gives the same text slightly different scores from one evaluation to the next (0.86, then 0.87,
   * depending on what else it judged), which would make one text many records; the record keeps
   * the score of its last evaluation (add). A picture verdict is identified by the picture.
   * "v3": records of the earlier identity ("v2", with the score) get the new key on update (rekey).
   */
  function keyText(entry) {
    const details = entry.details || {};
    const decimals = (value) => (typeof value === 'number' ? value.toFixed(2) : '');
    return [
      'v3',
      entry.host,
      entry.source,
      entry.hidden ? 'hidden' : 'shown',
      entry.fallback ? 'fallback' : '',
      entry.mode,
      entry.reason,
      entry.category,
      details.model || '',
      decimals(details.threshold),
      entry.image ? `image\n${entry.image}` : `text\n${entry.text}`,
    ].join('\n');
  }

  async function keyOf(entry) {
    const bytes = new TextEncoder().encode(keyText(entry));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Picture address for the log. A data: URL (it can be megabytes long) is replaced by its type and
   * a fingerprint of the whole URL, so two such pictures stay two records, e.g. "data:image/png#…".
   */
  function imageUrl(value) {
    const url = String(value || '');
    if (url.startsWith('data:')) return `${url.split(/[;,]/)[0].slice(0, 100)}#${fingerprint(url)}`;
    return url.slice(0, 1000);
  }

  /** A 53-bit hash of a string as hex (cyrb53): synchronous, as sanitize is. */
  function fingerprint(value) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }

  /**
   * Page address for the log: an HTTP(S) address without its query and fragment, which can carry
   * tokens, session ids or what was searched for; '' for anything else.
   */
  function pageUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return `${url.origin}${url.pathname}`.slice(0, 500);
    } catch (_) {
      return '';
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  function cleanDetails(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const details = {};
    for (const key of ['score', 'threshold']) {
      if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) details[key] = raw[key];
    }
    if (raw.probabilities && typeof raw.probabilities === 'object') {
      const probabilities = {};
      for (const [key, value] of Object.entries(raw.probabilities).slice(0, 12)) {
        if (typeof value === 'number' && Number.isFinite(value)) probabilities[String(key).slice(0, 40)] = value;
      }
      details.probabilities = probabilities;
    }
    if (typeof raw.model === 'string' && raw.model) details.model = raw.model.slice(0, 100);
    return Object.keys(details).length ? details : null;
  }

  /** Keeps only the known fields, with sane types and lengths (entries come from content scripts). */
  function sanitize(raw) {
    const url = pageUrl(raw.url);
    const entry = {
      time: typeof raw.time === 'string' && !Number.isNaN(Date.parse(raw.time)) ? raw.time : new Date().toISOString(),
      url,
      host: hostOf(url),
      hidden: raw.hidden === false || raw.hidden === 0 ? 0 : 1,
      source: raw.source === 'ai' ? 'ai' : 'keyword',
      mode: ['keywords', 'both', 'ai'].includes(raw.mode) ? raw.mode : 'keywords',
      reason: String(raw.reason || '').slice(0, 200),
      category: typeof raw.category === 'string' ? raw.category.slice(0, 40) : '',
      fallback: raw.fallback === true,
      revealed: raw.revealed === true,
      learned: raw.learned === true,
      text: String(raw.text || '').slice(0, Config.LOG_MAX_TEXT),
    };
    if (raw.image) {
      entry.media = 'image';
      entry.image = imageUrl(raw.image);
    }
    const details = cleanDetails(raw.details);
    if (details) entry.details = details;
    return entry;
  }

  /* ---------------- writing ---------------- */

  /**
   * Adds evaluations (already sanitized). One that is already recorded is counted again and keeps
   * the numbers of this evaluation. Then removes the oldest uncorrected records above
   * Config.LOG_MAX_ENTRIES.
   * Resolves with the number of new records.
   */
  async function add(entries) {
    if (entries.length === 0) return 0;
    const keyed = await Promise.all(entries.map(async (entry) => Object.assign({}, entry, { key: await keyOf(entry) })));
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const index = store.index('key');
    const seen = new Map(); // key → record handled earlier in this batch
    let added = 0;
    for (const entry of keyed) {
      const known = seen.get(entry.key) || (await done(index.get(entry.key)));
      if (known) {
        known.count = (known.count || 1) + 1;
        known.lastTime = entry.time;
        if (entry.details) known.details = entry.details;
        if (entry.learned) known.learned = true;
        if (known.id !== undefined) store.put(known);
        seen.set(entry.key, known);
      } else {
        const record = Object.assign({ count: 1, lastTime: entry.time }, entry);
        record.id = await done(store.add(record));
        seen.set(entry.key, record);
        added += 1;
      }
    }
    let excess = (await done(store.count())) - Config.LOG_MAX_ENTRIES;
    if (excess > 0) {
      await new Promise((resolve, reject) => {
        const cursorRequest = store.openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || excess <= 0) return resolve();
          if (!cursor.value.label) {
            cursor.delete();
            excess -= 1;
          }
          cursor.continue();
        };
      });
    }
    await finished(transaction);
    notify();
    return added;
  }

  /**
   * Marks the record of a hidden content the user chose to see ("Show anyway"): the newest hidden
   * record of that text (or picture) from that source on that site. The page does not send the
   * verdict's numbers back, so the record is found by its content, not by its key.
   */
  async function markRevealed(entry) {
    const same = (record) =>
      record.host === entry.host &&
      record.source === entry.source &&
      (entry.image ? record.image === entry.image : !record.image && record.text === entry.text);
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    const index = transaction.objectStore(STORE).index('hidden');
    let changed = false;
    await new Promise((resolve, reject) => {
      // Newest first: within one index value the records are in the order of their ids.
      const cursorRequest = index.openCursor(IDBKeyRange.only(1), 'prev');
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return resolve();
        if (!same(cursor.value)) return cursor.continue();
        if (!cursor.value.revealed) {
          cursor.update(Object.assign({}, cursor.value, { revealed: true }));
          changed = true;
        }
        resolve();
      };
    });
    await finished(transaction);
    if (changed) notify();
  }

  /**
   * On install and update. The first builds with this database recorded the full page address,
   * query and fragment included (they can hold tokens or searches): it is cut to what pageUrl
   * keeps. Does not create the database when there is none.
   */
  async function trimUrls() {
    if (typeof indexedDB.databases === 'function') {
      const names = (await indexedDB.databases()).map((info) => info.name);
      if (!names.includes(DB_NAME)) return;
    }
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    let changed = false;
    await new Promise((resolve, reject) => {
      const cursorRequest = transaction.objectStore(STORE).openCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return resolve();
        const url = pageUrl(cursor.value.url);
        if (url !== cursor.value.url) {
          cursor.update(Object.assign({}, cursor.value, { url, host: hostOf(url) }));
          changed = true;
        }
        cursor.continue();
      };
    });
    await finished(transaction);
    if (changed) notify();
  }

  /**
   * One record for records that now share a key: the oldest stays, with the counts added up, the
   * first and last times of them all, the numbers of the last evaluation, the newest correction,
   * and "revealed" / "learned" when any of them had it.
   */
  function merged(key, group) {
    const latest = group.reduce((a, b) => (String(b.lastTime || b.time) > String(a.lastTime || a.time) ? b : a));
    const record = Object.assign({}, group[0], {
      key,
      count: group.reduce((sum, item) => sum + (item.count || 1), 0),
      time: group.reduce((first, item) => (String(item.time) < String(first) ? item.time : first), group[0].time),
      lastTime: latest.lastTime || latest.time,
      revealed: group.some((item) => item.revealed === true),
      learned: group.some((item) => item.learned === true),
    });
    if (latest.details) record.details = latest.details;
    const corrected = group.filter((item) => item.label);
    if (corrected.length) {
      const last = corrected.reduce((a, b) => (String(b.labelTime || '') > String(a.labelTime || '') ? b : a));
      record.label = last.label;
      record.labelTime = last.labelTime;
    }
    return record;
  }

  /**
   * On install and update: gives every record the key keyText gives it now. Records of an earlier
   * identity (the score was part of it) that are the same content and verdict become one record
   * (merged). Runs before new evaluations are written (src/log.js); does nothing when every key is
   * current, and does not create the database when there is none.
   */
  async function rekey() {
    if (typeof indexedDB.databases === 'function') {
      const names = (await indexedDB.databases()).map((info) => info.name);
      if (!names.includes(DB_NAME)) return;
    }
    const db = await open();
    const records = await done(db.transaction(STORE).objectStore(STORE).getAll());
    // The keys are computed first: a transaction does not survive waiting for crypto.subtle.
    const groups = new Map(); // key → its records, oldest first
    for (const record of records) {
      const key = await keyOf(record);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    const changes = [...groups].filter(([key, group]) => group.length > 1 || group[0].key !== key);
    if (changes.length === 0) return;
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    // The merged records go first, so no new key meets the old record that still holds it.
    for (const [, group] of changes) for (const record of group.slice(1)) store.delete(record.id);
    for (const [key, group] of changes) store.put(merged(key, group));
    await finished(transaction);
    notify();
  }

  /** The user's correction: "hide" | "show", or null to take it back. Resolves with the record. */
  async function setLabel(id, label) {
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const record = await done(store.get(id));
    if (record) {
      if (label === 'hide' || label === 'show') {
        record.label = label;
        record.labelTime = new Date().toISOString();
      } else {
        delete record.label;
        delete record.labelTime;
      }
      store.put(record);
    }
    await finished(transaction);
    if (record) notify();
    return record || null;
  }

  async function clear() {
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    await finished(transaction);
    notify();
  }

  /* ---------------- reading ---------------- */

  /** All records, oldest first. */
  async function all() {
    const db = await open();
    return done(db.transaction(STORE).objectStore(STORE).getAll());
  }

  /** { total, hidden, shown, corrected } without reading the records. */
  async function counts() {
    const db = await open();
    const store = db.transaction(STORE).objectStore(STORE);
    const [total, hidden, corrected] = await Promise.all([
      done(store.count()),
      done(store.index('hidden').count(IDBKeyRange.only(1))),
      done(store.index('label').count()),
    ]);
    return { total, hidden, shown: total - hidden, corrected };
  }

  /**
   * The log as JSON Lines: a header with the extension version and the settings at export time,
   * then one evaluation per line ("type": "hidden" | "shown"; "label" when the user corrected it).
   */
  function toJsonl(records, settings, version) {
    const meta = {
      type: 'meta',
      extension: 'ParaBene',
      version,
      exportedAt: new Date().toISOString(),
      entries: records.length,
      settings: {
        aiEnabled: settings.aiEnabled,
        aiProtocol: settings.aiProtocol,
        aiModel: settings.aiProtocol === 'builtin' ? settings.aiModel : undefined,
        aiMode: settings.aiMode,
        aiSensitivity: settings.aiSensitivity,
        aiThreshold: Config.AI_SENSITIVITIES[settings.aiSensitivity],
        aiTopics: settings.aiTopics,
        aiImagesEnabled: settings.aiImagesEnabled,
        keywords: settings.keywords,
      },
    };
    const lines = records.map((record) => {
      const { id: _id, key: _key, hidden, ...rest } = record;
      return Object.assign({ type: hidden ? 'hidden' : 'shown' }, rest);
    });
    return [meta, ...lines].map((line) => JSON.stringify(line)).join('\n') + '\n';
  }

  root.ParaBeneStore = Object.freeze({
    sanitize,
    add,
    markRevealed,
    trimUrls,
    rekey,
    setLabel,
    clear,
    all,
    counts,
    subscribe,
    toJsonl,
  });
})(globalThis);
