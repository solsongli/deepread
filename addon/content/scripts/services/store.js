/*
 * Local persistence: <Zotero data dir>/deepread.sqlite
 * One row per PDF attachment (keyed by "<libraryID>_<itemKey>", stable across devices),
 * holding the deep-read results as JSON. Parse artifacts (MinerU output) live under
 * <Zotero data dir>/deepread/mineru/<attachmentKey>/.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, PathUtils, IOUtils */

DeepRead.Store = {
  SCHEMA_VERSION: 1,
  db: null,

  JSON_FIELDS: ["hierarchical_data", "article_summary", "block_mapping", "sections", "user_state", "content_list", "explanations", "figure_guides", "questions"],
  TEXT_FIELDS: ["result_dir", "language", "markdown"],

  async init() {
    this.db = new Zotero.DBConnection("deepread");
    // Close cleanly on app quit: Zotero treats a leftover -wal file as an unclean shutdown and
    // runs a blocking integrity check (with a progress popup) on the next start.
    if (!this._shutdownListenerAdded) {
      this._shutdownListenerAdded = true;
      Zotero.addShutdownListener(() => this.close());
    }
    await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS version (
      schema TEXT PRIMARY KEY,
      version INT NOT NULL
    )`);
    await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS papers (
      attachment_key TEXT PRIMARY KEY,
      item_id INTEGER,
      result_dir TEXT,
      language TEXT,
      content_list TEXT,
      hierarchical_data TEXT,
      article_summary TEXT,
      block_mapping TEXT,
      sections TEXT,
      markdown TEXT,
      user_state TEXT,
      explanations TEXT,
      figure_guides TEXT,
      questions TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`);
    // Migrate databases created before these columns existed.
    for (const column of ["explanations", "figure_guides", "questions"]) {
      const has = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM pragma_table_info('papers') WHERE name = '${column}'`);
      if (!Number(has)) await this.db.queryAsync(`ALTER TABLE papers ADD COLUMN ${column} TEXT`);
    }
    await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS chats (
      attachment_key TEXT PRIMARY KEY,
      messages TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`);
    await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS comparison_cache (
      attachment_key TEXT NOT NULL, slot TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (attachment_key, slot)
    )`);
    await this.db.queryAsync(
      "INSERT OR REPLACE INTO version (schema, version) VALUES ('deepread', ?)",
      [this.SCHEMA_VERSION]
    );
  },

  async close() {
    if (this.db) {
      try {
        await this.db.closeDatabase();
      }
      catch (e) {
        DeepRead.log("store close failed", String(e));
      }
      this.db = null;
    }
  },

  resultRoot() {
    return PathUtils.join(Zotero.DataDirectory.dir, "deepread", "mineru");
  },

  async resultDirFor(attachmentKey) {
    const dir = PathUtils.join(this.resultRoot(), attachmentKey);
    await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
    return dir;
  },

  _decodeRow(row) {
    if (!row) return null;
    const out = { attachment_key: row.attachment_key, item_id: row.item_id, updated_at: row.updated_at };
    for (const field of this.TEXT_FIELDS) {
      out[field] = row[field] ?? null;
    }
    for (const field of this.JSON_FIELDS) {
      const raw = row[field];
      if (raw === null || raw === undefined || raw === "") {
        out[field] = null;
        continue;
      }
      try {
        out[field] = JSON.parse(raw);
      }
      catch (e) {
        DeepRead.log(`corrupt JSON in papers.${field} for ${row.attachment_key}`);
        out[field] = null;
      }
    }
    return out;
  },

  async getPaper(attachmentKey) {
    const fields = ["attachment_key", "item_id", "updated_at", ...this.TEXT_FIELDS, ...this.JSON_FIELDS];
    const rows = await this.db.queryAsync(`SELECT ${fields.join(", ")} FROM papers WHERE attachment_key = ?`, [attachmentKey]);
    return rows && rows.length ? this._decodeRow(rows[0]) : null;
  },

  /** Upsert only the given fields. JSON fields are serialized here. */
  async savePaper(attachmentKey, itemID, fields) {
    const columns = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      if (this.JSON_FIELDS.includes(key)) {
        columns.push(key);
        values.push(value === null || value === undefined ? null : JSON.stringify(value));
      }
      else if (this.TEXT_FIELDS.includes(key)) {
        columns.push(key);
        values.push(value ?? null);
      }
      else {
        throw new Error(`DeepRead.Store: unknown field ${key}`);
      }
    }
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(
        "INSERT OR IGNORE INTO papers (attachment_key, item_id) VALUES (?, ?)",
        [attachmentKey, itemID]
      );
      if (columns.length) {
        const assignments = columns.map((c) => `${c} = ?`).join(", ");
        await this.db.queryAsync(
          `UPDATE papers SET ${assignments}, item_id = ?, updated_at = strftime('%s', 'now') WHERE attachment_key = ?`,
          [...values, itemID, attachmentKey]
        );
      }
    });
  },

  async deletePaper(attachmentKey) {
    await this.deleteComparisonData(attachmentKey);
    await this.db.queryAsync("DELETE FROM papers WHERE attachment_key = ?", [attachmentKey]);
    await this.db.queryAsync("DELETE FROM chats WHERE attachment_key = ?", [attachmentKey]);
    const dir = PathUtils.join(this.resultRoot(), attachmentKey);
    try {
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    }
    catch (e) {
      DeepRead.log("failed to remove result dir", dir, String(e));
    }
  },

  async hasComparisonData(key) {
    return !!(await this.db.valueQueryAsync("SELECT 1 FROM comparison_cache WHERE attachment_key=? LIMIT 1", [key]));
  },

  async deleteComparisonData(key) {
    await this.db.queryAsync("DELETE FROM comparison_cache WHERE attachment_key=?", [key]);
  },

  async comparisonData(key, fingerprint, slot) {
    if (!fingerprint) return null;
    const raw = await this.db.valueQueryAsync("SELECT payload FROM comparison_cache WHERE attachment_key=? AND fingerprint=? AND slot=?", [key, fingerprint, slot]);
    return raw ? JSON.parse(raw) : null;
  },

  async saveComparisonData(key, fingerprint, slot, data) {
    if (fingerprint) await this.db.queryAsync("INSERT OR REPLACE INTO comparison_cache (attachment_key, fingerprint, slot, payload) VALUES (?, ?, ?, ?)",
      [key, fingerprint, slot, JSON.stringify(data)]);
  },

  async getChat(attachmentKey) {
    const raw = await this.db.valueQueryAsync("SELECT messages FROM chats WHERE attachment_key = ?", [attachmentKey]);
    if (!raw) return [];
    try {
      const messages = JSON.parse(raw);
      return Array.isArray(messages) ? messages : [];
    }
    catch (e) {
      return [];
    }
  },

  async saveChat(attachmentKey, messages) {
    await this.db.queryAsync(
      `INSERT INTO chats (attachment_key, messages, updated_at) VALUES (?, ?, strftime('%s', 'now'))
       ON CONFLICT(attachment_key) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
      [attachmentKey, JSON.stringify(messages || [])]
    );
  },
};
