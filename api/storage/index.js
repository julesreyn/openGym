// Where an instance keeps its accounts and its profiles' documents: the StorageAdapter.
//
// Two implementations:
//   storage/fs.js        DATA_DIR on disk (db.json, state-<uid>.json). Synchronous, which is what
//                        makes server.js's read-compare-write atomic in one Node process.
//   cf-app/src/storage   Durable Objects on Cloudflare (one for the accounts, one per profile).
//                        Asynchronous; each object runs its own read-compare-write in one turn.
//
// The shape both follow (methods return a value, or a Promise of it when `sync` is false):
//
//   loadDb()                    -> the accounts document ({ users, creds, subs, invites, ... })
//   saveDb(db)                  -> writes it whole
//   readState(uid)              -> the profile's document, or null (missing or unreadable)
//   readStateStrict(uid)        -> the document, null when there is none, UNREADABLE when it cannot be read
//   writeState(uid, text)       -> stores the document's JSON text (planCommit in state-commit.js makes it)
//   deleteState(uid)            -> removes it (account deletion)
//   kind, sync                  -> 'fs' | 'cloudflare', and whether the methods return values directly
//
// Uploaded media are not part of it: media.js keeps them on disk, the Cloudflare port in R2.

export const UNREADABLE = Symbol.for('opengym.state-unreadable');

export const emptyDb = () => ({ users: [], creds: [], subs: [], invites: [] });
