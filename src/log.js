/*
 * ParaBene – the service worker's side of the log of evaluated content (opt-in, `evalLogEnabled`).
 *
 * Content scripts send every verdict (LOG_VERDICT) and every "Show anyway" (LOG_REVEALED); this
 * file writes them into the database (src/store.js) in batches, moves the log of versions up to
 * 1.0 into it once, and clears the log on request. Loaded by src/background.js, which only routes
 * the messages here (and only those of content scripts in normal windows).
 */
(function (root) {
  'use strict';

  const Config = root.ParaBeneConfig;
  const Store = root.ParaBeneStore;

  const FLUSH_MS = 1000;
  const queue = [];
  let timer = 0;
  /** Writes and clears run one after another. */
  let writing = Promise.resolve();

  /**
   * Entries arrive in bursts while a page loads — they are written to the database in batches.
   * `pageUrl` is the address of the sending tab as the browser reports it (sender.url); it is what
   * the entry records and what the excluded sites are checked against.
   */
  function add(type, entry, pageUrl) {
    if (!entry || typeof entry.text !== 'string') return;
    if (!entry.text && !(typeof entry.image === 'string' && entry.image)) return;
    queue.push({ type, entry: Object.assign({}, entry, { url: String(pageUrl || '') }) });
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    timer = 0;
    const batch = queue.splice(0);
    writing = writing
      .then(async () => {
        const { evalLogEnabled, excludedSites } = await Config.load();
        if (!evalLogEnabled) return;
        await moveOldLog();
        // In the order they happened: a "Show anyway" may follow its own verdict in one batch.
        const verdicts = [];
        for (const { type, entry } of batch) {
          // A site excluded while its entries waited in the queue: nothing more from it is written.
          if (Config.isSiteExcluded(excludedSites, Config.siteHost(entry.url))) continue;
          const clean = Store.sanitize(entry);
          if (type === Config.MSG.LOG_REVEALED) {
            if (verdicts.length) await Store.add(verdicts.splice(0));
            await Store.markRevealed(clean);
          } else {
            verdicts.push(clean);
          }
        }
        if (verdicts.length) await Store.add(verdicts);
      })
      .catch((err) => console.warn('[ParaBene] Failed to write the log:', err));
  }

  /**
   * Versions up to 1.0 kept the log of hidden content in chrome.storage.local: its entries are
   * moved into the database once and the old key is removed.
   */
  async function moveOldLog() {
    const key = Config.LOG_STORAGE_KEY;
    const old = (await chrome.storage.local.get(key))[key];
    if (old === undefined) return;
    if (Array.isArray(old) && old.length) {
      const entries = old
        .filter((entry) => entry && typeof entry.text === 'string')
        .map((entry) => Store.sanitize(Object.assign({}, entry, { hidden: true })));
      await Store.add(entries);
    }
    await chrome.storage.local.remove(key);
  }

  /**
   * On install and update. The switch of versions up to 1.0 (`logEnabled`) covered hidden content
   * only, so it does not turn on this log, which records everything evaluated: it is removed and
   * the user turns the new log on if they want it. The entries recorded with it are moved into the
   * database so they can be seen and cleared on the statistics page. Page addresses recorded in
   * full by earlier builds are cut to the address without query and fragment.
   */
  function migrate() {
    const moved = writing.then(async () => {
      await chrome.storage.local.remove(Config.LOG_OLD_SETTING);
      await moveOldLog();
      await Store.trimUrls();
      await Store.rekey(); // before the evaluations queued meanwhile are written with the new keys
    });
    writing = moved.catch((err) => console.warn('[ParaBene] Failed to move the old log:', err));
    return writing;
  }

  /**
   * "Clear log" from the statistics page. It runs in the same queue as the writes, so entries not
   * yet written are dropped too and a write in progress cannot follow the clearing.
   */
  function clear() {
    clearTimeout(timer);
    timer = 0;
    queue.length = 0;
    const cleared = writing.then(async () => {
      await chrome.storage.local.remove(Config.LOG_STORAGE_KEY);
      await Store.clear();
    });
    writing = cleared.catch((err) => console.warn('[ParaBene] Failed to clear the log:', err));
    return cleared;
  }

  root.ParaBeneLog = Object.freeze({ queue: add, migrate, clear });
})(globalThis);
