// Durable Object SQLite helpers. The storage API is synchronous inside a Durable Object, which is
// what lets the ported handlers keep server.js's "read, compare, write with nothing awaited in
// between" without a lock: an object runs one event at a time and storage calls do not yield.

// A SQLite value is at most 2 MB; a profile's document can be larger (years of workouts), so a
// document is stored as numbered parts and joined on read.
const PART = 1_000_000;

export function createDocStore(sql, table) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (name TEXT NOT NULL, i INTEGER NOT NULL, part TEXT NOT NULL, PRIMARY KEY (name, i))`);
  return {
    /** The stored text, or null. */
    read(name) {
      const rows = sql.exec(`SELECT part FROM ${table} WHERE name = ? ORDER BY i`, name).toArray();
      return rows.length ? rows.map(r => r.part).join('') : null;
    },
    write(name, text) {
      sql.exec(`DELETE FROM ${table} WHERE name = ?`, name);
      for (let i = 0, n = 0; i < text.length || n === 0; i += PART, n++) {
        sql.exec(`INSERT INTO ${table} (name, i, part) VALUES (?, ?, ?)`, name, n, text.slice(i, i + PART));
      }
    },
    remove(name) { sql.exec(`DELETE FROM ${table} WHERE name = ?`, name); },
    size(name) {
      const r = sql.exec(`SELECT COALESCE(SUM(LENGTH(part)), 0) AS n FROM ${table} WHERE name = ?`, name).one();
      return Number(r.n) || 0;
    },
  };
}

/**
 * A Map that survives the object being evicted from memory: what server.js keeps in in-memory
 * Maps for minutes (passkey challenges, pairing codes, OAuth requests and codes) would otherwise
 * be lost whenever Cloudflare moves or idles the object between two steps of a sign-in.
 * Values are JSON. Entries with an `exp` (ms) are dropped once past it, on read and on sweep.
 */
export class PersistentMap {
  constructor(sql, name, { now = Date.now } = {}) {
    this.sql = sql; this.name = name; this.now = now;
    sql.exec(`CREATE TABLE IF NOT EXISTS pmap (m TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, exp INTEGER, seq INTEGER NOT NULL, PRIMARY KEY (m, k))`);
  }
  get size() { return Number(this.sql.exec('SELECT COUNT(*) AS n FROM pmap WHERE m = ?', this.name).one().n) || 0; }
  has(k) { return this.get(k) !== undefined; }
  get(k) {
    const r = this.sql.exec('SELECT v FROM pmap WHERE m = ? AND k = ?', this.name, String(k)).toArray()[0];
    return r ? JSON.parse(r.v) : undefined;
  }
  set(k, v) {
    const exp = v && typeof v === 'object' && Number.isFinite(v.exp) ? v.exp : null;
    this.sql.exec('INSERT OR REPLACE INTO pmap (m, k, v, exp, seq) VALUES (?, ?, ?, ?, ?)', this.name, String(k), JSON.stringify(v), exp, this.now());
    return this;
  }
  delete(k) {
    const had = this.has(k);
    this.sql.exec('DELETE FROM pmap WHERE m = ? AND k = ?', this.name, String(k));
    return had;
  }
  clear() { this.sql.exec('DELETE FROM pmap WHERE m = ?', this.name); }
  sweep() { this.sql.exec('DELETE FROM pmap WHERE m = ? AND exp IS NOT NULL AND exp < ?', this.name, this.now()); }
  *entries() {
    for (const r of this.sql.exec('SELECT k, v FROM pmap WHERE m = ? ORDER BY seq', this.name).toArray()) yield [r.k, JSON.parse(r.v)];
  }
  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(fn) { for (const [k, v] of this.entries()) fn(v, k, this); }
}
