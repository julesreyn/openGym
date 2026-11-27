// The filesystem StorageAdapter (storage/index.js): what server.js has always done with DATA_DIR.
// db.json (+ db.json.bak) for the accounts, state-<uid>.json for each profile, written durably.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';
import { UNREADABLE, emptyDb } from './index.js';

export function createFsStorage(dataDir) {
  const dbFile = path.join(dataDir, 'db.json');
  const stateFile = uid => path.join(dataDir, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');

  // Every account, passkey and invite. Only a missing file starts empty: an unreadable one (a write
  // cut short by a power loss, a damaged restore) used to boot with no users at all, and the first
  // save then replaced it — every profile locked out, every training history orphaned, and with
  // FIRST_USER_ADMIN the first visitor made admin. Now the damaged file is kept aside and the copy
  // saveDb keeps of each version it writes (db.json.bak) is used; with neither readable the server
  // refuses to start, saying why, rather than start as a new instance.
  function loadDb() {
    let raw;
    try { raw = fs.readFileSync(dbFile, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return emptyDb(); throw e; }
    const parse = text => { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); return v; };
    try { return parse(raw); } catch (err) {
      const aside = `${dbFile}.unreadable-${Date.now()}`;
      try { fs.copyFileSync(dbFile, aside); } catch { /* the original stays where it is anyway */ }
      console.error(`db.json cannot be read (${err.message}); kept a copy as ${path.basename(aside)}`);
      try {
        const bak = parse(fs.readFileSync(dbFile + '.bak', 'utf8'));
        console.error('db.json: using db.json.bak, the copy of the last save');
        return bak;
      } catch {
        console.error('db.json: no readable db.json.bak either. Refusing to start: restore db.json from a backup.');
        process.exit(1);
      }
    }
  }

  // 0600: db.json holds passkey credential material. Once the new version is on disk, a second
  // copy of it goes to db.json.bak, the same durable way: loadDb falls back to it. A write cut
  // short leaves the previous db.json.bak whole (temporary file and rename).
  function saveDb(db) {
    const text = JSON.stringify(db, null, 2);
    atomicWrite(dbFile, text, 0o600);
    try { atomicWrite(dbFile + '.bak', text, 0o600); }
    catch (e) { console.error('db.json.bak could not be written', e.message); }
  }

  function readState(uid) {
    try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
  }
  function readStateStrict(uid) {
    let raw;
    try { raw = fs.readFileSync(stateFile(uid), 'utf8'); }
    catch (e) { return e.code === 'ENOENT' ? null : UNREADABLE; }
    try { return JSON.parse(raw); } catch { return UNREADABLE; }
  }
  const writeState = (uid, text) => atomicWrite(stateFile(uid), text);
  function deleteState(uid) {
    try { fs.unlinkSync(stateFile(uid)); } catch { /* already gone */ }
  }

  return { kind: 'fs', sync: true, loadDb, saveDb, readState, readStateStrict, writeState, deleteState, stateFile, dbFile };
}
