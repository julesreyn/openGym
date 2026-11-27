# openGym on Cloudflare

This folder runs openGym on Cloudflare instead of Docker: one Worker, Durable Objects for the
data, R2 for photos, videos and the exercise media, and the remote MCP server at `/mcp`. It is a
port kept in a fork of [DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym), under
the same licence (AGPL-3.0-or-later). The rest of the repository is upstream openGym, changed as
little as possible, so it can keep being merged in.

The HTTP API is the same as `api/server.js`: the web app, the PWA and the Android and iPhone apps
work against it unchanged. A contract test checks this (see [Tests](#tests)).

## How it fits together

```
                       gym.quietware.dev (one origin: passkeys need it)
                                      │
                               Worker (src/index.js)
     ┌──────────────┬─────────────────┼───────────────────┬──────────────────────┐
  static assets   /api/*, /.well-known/*        /mcp                  /exercise-media/*
  (the built app)     │                          │ (src/mcp.js)         R2, signed in only
                      ▼                          │
              DirectoryDO "instance"  ◄──────────┘ same routes, in-process, with the ogt_ token
              db.json: users, passkeys, tokens, OAuth clients
              challenges, pairings, OAuth codes (SQLite)
                      │
                      ▼
              ProfileDO per profile: the synced document, compare-and-write
              R2 opengym-uploads: custom exercise photos and videos
```

- **`src/index.js`** routes a request: the app's files come from static assets, everything else
  goes to the code below. Unknown paths get `index.html` (the app's router takes them).
- **`src/directory.js`** is `api/server.js` ported to a Durable Object, with the same handlers
  and the same answers. It imports the upstream modules that hold the rules (`api/oauth.js`,
  `api/tokens.js`, `api/state-commit.js`, `api/session-token.js`, `api/rate-limit.js`,
  `api/sync-stamps.js`...) instead of copying them.
- **`src/profile.js`** holds one profile's document. A PUT checks the revision and writes in one
  step, so two devices writing at once get one 200 and one 409, as with the Node server.
- **`src/mcp.js`** is `mcp/src/http.js` on the web-standard transport: the same tools, stateless,
  scoped `ogt_` tokens only, and the OAuth 2.1 server of `api/oauth.js` for Claude's connector.
- **`src/media.js`** is `api/media.js` on R2.

### Why Durable Objects and not D1 or KV

openGym keeps each profile as one JSON document with a revision number, and the sync depends on
"write only if the revision is still the one I read". A Durable Object runs one request at a time
on its own SQLite, so that check and the write are atomic without locks or transactions over the
network. One object per profile spreads the load and keeps a profile's data in one place.
`db.json` (users, passkeys, tokens) is small and read on every request, so it lives in one
singleton object next to the sign-in state that has to survive between requests (WebAuthn
challenges, pairing codes, OAuth codes).

- **KV** is eventually consistent and allows 1,000 writes a day on the free plan: not usable
  for sync.
- **D1** would work, but every request would be a network round trip to the database, and the
  compare-and-write would need care that a Durable Object gives for free.
- **R2** is for blobs: photos and videos by their hash, and the licensed exercise media.

A SQLite value is limited to 2 MB, so documents are stored in chunks (`src/sqlstore.js`); a test
writes a document over 2 MB and reads it back.

## What is not ported

These answer the way the Node server does when the feature is switched off, or are absent:

- **Password sign-in.** scrypt does not fit the CPU budget of a request. Passkeys only.
- **OIDC sign-in, trainers, the shared library, the AI coach, integrations and webhooks.**
- **The admin screens and invites.** There is no way to invite someone, hence the sign-up step
  in the deployment below.
- **Web Push** (rest timer and reminder notifications from the server) and the watch relay. The
  phone apps keep their own local notifications.
- **The calendar feed** (`.ics`).
- **The audit log file.** Audit events go to the Worker's logs (Observability) as JSON lines.

Smaller differences:

- Rate limits are counted per Worker instance in memory, not across all of Cloudflare.
- Uploads: a body over 16 MB needs a `Content-Length` (the apps send one). Disk-space checks
  and the 14-day sweep of other profiles' unused media are not there; deleting a profile
  deletes its media.

## Deploying

You need the Cloudflare account where `gym.quietware.dev` lives (the `quietware.dev` zone),
Node 22, and `npx wrangler login` done once. The Workers Free plan is enough to start (see
[Free or Paid](#free-or-paid)).

1. **Install and test.**

   ```bash
   cd cf-app && npm ci && npm test
   ```

2. **Create the two R2 buckets**, in the EU jurisdiction as `wrangler.jsonc` says:

   ```bash
   npx wrangler r2 bucket create opengym-uploads --jurisdiction eu
   npx wrangler r2 bucket create opengym-exercise-media --jurisdiction eu
   ```

3. **Set the session secret.** It signs the session cookies and the phone tokens; changing it
   signs everyone out.

   ```bash
   openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
   ```

4. **Upload the exercise media** (the 180 px stills and clips from `catalogue/media`). The
   script checks the licence rule first (`scripts/catalogue/check-media.mjs`) and uploads
   nothing larger. `--dry-run` shows what it would send.

   ```bash
   node scripts/upload-exercise-media.mjs --dry-run
   node scripts/upload-exercise-media.mjs
   ```

5. **Build and deploy.** `npm run build` builds the frontend into `cf-app/dist` (and refuses to
   if exercise media ended up in it). The custom domain in `wrangler.jsonc` is created on the
   first deploy.

   ```bash
   npm run build
   npx wrangler deploy --var INVITE_ONLY:0
   ```

   `wrangler.jsonc` keeps sign-ups closed (`INVITE_ONLY` is `1`); this first deploy opens them
   for the one step below, so that a later deploy can never reopen them by accident.

6. **Create your profile at once.** Open https://gym.quietware.dev, sign up with a passkey. The
   first profile is the owner (`FIRST_USER_ADMIN=1`).

7. **Close sign-ups** by deploying again as `wrangler.jsonc` says. With invites not ported,
   nobody else can then sign up; until then anyone who finds the address can. The Durable
   Object that holds the accounts can keep the old settings for a few minutes after a deploy:
   wait until `curl -s https://gym.quietware.dev/api/config` says `"invite_only":true`.

   ```bash
   npx wrangler deploy
   ```

8. **Check it.** `curl https://gym.quietware.dev/api/health` answers `{"ok":true,...}`, and
   `npx wrangler tail` shows requests and audit events as they happen.

Settings live in `wrangler.jsonc` under `vars`, with the same names as the Docker setup
(docs/SELF_HOSTING.md): `ORIGIN` and `RP_ID` (the passkey's host, `gym.quietware.dev`; another
domain means changing both, and passkeys made under the old one stop working), `INVITE_ONLY`,
`MCP`, `SESSION_DAYS`, `MEDIA_UPLOADS`. The only secret is `SESSION_SECRET`.

### Moving a profile from a Docker server

Make a backup in Settings, Back up on the old server, then restore it on the new one after
signing up (Settings, Back up, Restore a backup). Passkeys are tied to the host name, so you make a new one on the new address.

## Connecting the phone app

The Android APK and the iPhone app pair with the server the way they do with Docker:

1. In a browser signed in at https://gym.quietware.dev: Settings, Account, **Pair the mobile
   app**. Confirm with your passkey; a code appears.
2. In the app: Settings, Account, **Connect to my server**. Enter `https://gym.quietware.dev`
   and the code.

The phone then syncs with a bearer token. "Sign out everywhere" in the browser ends it; pair
again to reconnect. Nothing on the phone is lost meanwhile.

## Adding openGym to Claude

The MCP server is at `https://gym.quietware.dev/mcp` and signs Claude in with OAuth, so there is
no token to copy.

1. In claude.ai: **Settings, Connectors, Add custom connector**.
2. Name it openGym, URL `https://gym.quietware.dev/mcp`, then **Add**, then **Connect**.
3. Claude opens openGym. Sign in with your passkey if asked, choose what Claude may see and
   change (workouts, routines, body weight; read or also write), and approve.

The connector appears in Settings, API tokens, where you can revoke it. The tools include:
search and list exercises, create, update and delete routines, workout history (by exercise and
by date), log a workout, personal records, estimated 1RM and body weight. Which ones Claude gets
depends on what you granted. A client that cannot do OAuth can use a token made by hand in
Settings, API tokens (`Authorization: Bearer ogt_...`).

## Free or Paid

One person's training log fits the free plan with room to spare. Figures from Cloudflare's
pricing pages in November 2026; check them before relying on them.

| | Workers Free | Workers Paid ($5 a month) |
|---|---|---|
| Requests | 100,000 a day | 10 million a month, then $0.30 per million |
| CPU per request | **10 ms** | 30 s by default, up to 5 min |
| Static asset requests | free, unlimited | free, unlimited |
| Durable Objects (SQLite) | 100,000 requests and 100,000 rows written a day, 5 GB stored | 1 million requests a month, 50 million rows written, then per use |
| R2 | 10 GB stored, 1 million writes and 10 million reads a month, no egress fees (both plans) | same, then per use |
| Worker size | 3 MB compressed (this one: about 0.8 MB) | 10 MB |

A sync is about three requests (the Worker, the directory, the profile), so a day of training
uses a few hundred. The limit to watch is the **10 ms of CPU** on the free plan: reading and
merging a large document (years of history, several MB) can go over it, and the request then
fails with error 1102. If that shows up in `wrangler tail`, Workers Paid removes it. Nothing in
the code needs to change.

## Tests

```bash
npm test
```

- `test/contract.worker.test.js` and `test/contract.node.test.mjs` run the same scripted session
  (`test/contract/scenario.js`: passkey sign-up and sign-in, sync with its 409, pairing, scoped
  tokens, OAuth discovery, CORS, CSRF, sign out everywhere) against the Worker and against the
  real `api/server.js`. Both must give `test/contract/contract.golden.json`: every status, the
  headers a client reads, and the shape of every body.
- `test/worker.worker.test.js`: concurrent writes, a document over 2 MB, the MCP tools, the
  exercise media behind a session, uploads in R2.
- `test/oauth.worker.test.js`: the claude.ai connector's whole sign-in.

The Worker tests run in workerd with `@cloudflare/vitest-plugin` and use a software passkey
(WebCrypto P-256), so the WebAuthn checks are the real ones, with `ORIGIN` and `RP_ID` taken from
the configuration.

### After merging upstream

```bash
UPDATE_GOLDEN=1 node --test test/contract.node.test.mjs
npm test
```

The first command records what the new `api/server.js` answers; the second shows where the
Worker now differs. A new route in `api/server.js` that the apps use needs porting to
`src/directory.js`.
