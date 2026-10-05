# Vorth Backend

Node.js + Express + PostgreSQL API for the Vorth novel/comic reading
platform. The catalog starts **empty** — run `npm run db:seed -- --confirm`
if you want demo content.

> **Legal notice:** the `/legal` folder contains *template* Terms of
> Service, Privacy Policy, DMCA Policy, Copyright Guidelines, and
> Content Policy documents. They are functionally complete drafts,
> not legal advice, and have not been reviewed by an attorney. Have
> them reviewed by counsel — and register a DMCA designated agent
> with the U.S. Copyright Office — before operating this publicly.
> See `legal/DMCA_POLICY.md` for details.

## 1. Setup

```bash
cd vorth-backend
npm install
cp .env.example .env
# edit .env — at minimum set DATABASE_URL and JWT_SECRET
npm run dev        # node --watch, auto-restarts on change
# or
npm start          # plain node
```

Requires Node 18+ and a PostgreSQL database. Neon is supported through
`DATABASE_URL` and SSL by default.

If you were previously running an earlier prototype with mock books,
clear it with:

```bash
npm run db:wipe -- --confirm   # clear catalog data
npm run db:seed -- --confirm   # add demo users/series/chapters/reviews
npm run db:inspect             # print row counts (read-only)
```

`db:seed` is idempotent and refuses to run against `NODE_ENV=production`
without `FORCE=1`. Every demo account shares the password `vorthdemo123`, so
change or delete them before opening the site publicly.

```bash
npm run dmca:sweep-lapsed -- --dry-run   # what a restoration sweep would do
npm run dmca:sweep-lapsed                # restore content whose window lapsed
```

The sweep runs `connectDB()`, so it refuses a managed production database
unless `VORTH_ALLOW_SCHEMA_ON_PRODUCTION=1`. It is not scheduled on purpose:
§512(g)(2)(C) makes restoration permissive, and a job that fires unattended
could re-expose content a court order is keeping down. Always dry-run first —
it reports, per notice, both what it would put back and what it would leave
down and why.

### Deploying

[`../render.yaml`](../render.yaml) is a Render blueprint for a single web
service (the API also serves the frontend) plus a managed PostgreSQL 16.
Vorth owns its schema and applies it on boot, so there is no separate
migration step to keep in step.

Set `CLIENT_ORIGINS`, `PUBLIC_URL` and `SECURE_COOKIES` in the dashboard. For
more than one instance also set `RATE_LIMIT_STORE=postgres` and
`TRUST_PROXY=true`.

The schema change is purely additive - new tables plus one new column on
`users`, no drops or renames - so booting the new code against an existing
database upgrades it in place. `npm run db:verify-migration` proves this
against a replica.

## 2. Project structure

```
server.js                  entry point: connects DB, starts Express, registers cron jobs
src/
  app.js                   Express app: security middleware, routes, error handling
  config/
    env.js                 loads & validates environment variables
    db.js                      PostgreSQL connection and schema bootstrap
  models/
    _sql.js                Mongo-style filter/sort/update -> parameterised SQL
    _base.js               find/populate/save/deleteMany/aggregate
    User, Series, Chapter, Comment, ReadingProgress, Notification,
    DMCAReport, DMCACounterNotice, RefreshToken, AuthToken
  services/
    views.js                idempotent view counting
    uploads.js              orphan-upload pruning
    businessDays.js         business-day arithmetic for the DMCA response window
    storage.js              local / S3-compatible upload drivers
    mailer.js                console / SMTP email transport
  controllers/              request handlers, one file per resource
  routes/                   route definitions, mounted under /api in routes/index.js
  middleware/
    auth.js                 JWT verification (protect, optionalAuth, restrictTo)
    ownership.js             enforces "only the publishing creator can add chapters"
    upload.js                multer config for cover/page images
    rateLimiter.js           general + auth-specific rate limits
    errorHandler.js          centralized error formatting
  jobs/
    resetViews.js            cron: resets daily/weekly view counters (drives rankings)
  utils/                     asyncHandler, ApiError, generateToken, validate
scripts/
  wipeDatabase.js            clears Series/Chapter (and optionally Comment/User) collections
legal/                       Terms, Privacy, DMCA, Copyright, Content Policy templates
uploads/                     uploaded cover images & comic pages (served at /uploads/*)
```

## 3. Authentication

JWT bearer tokens for the API, plus a rotating **httpOnly refresh cookie**
for the session.

| Credential | Lives in | Lifetime | Notes |
|---|---|---|---|
| Access token | `Authorization: Bearer ...`, memory + `localStorage` | `JWT_EXPIRES_IN` | `toJSON()` strips it from responses |
| Refresh token | `httpOnly` cookie scoped to `/api/auth` | `REFRESH_TOKEN_DAYS` | **Unreadable by JavaScript** |

On `POST /api/auth/refresh` the presented refresh token is **revoked and
replaced**, so it is single-use. Only a SHA-256 hash of each token is
stored, so a database leak yields nothing replayable. The cookie is
`SameSite=Lax`, so it is not attached to cross-site subrequests.

The frontend refreshes transparently: a `401` triggers one refresh attempt
and a replay of the original request. Concurrent 401s share a single
refresh (`refreshInFlight`) so a burst of parallel requests cannot rotate
the token out from under itself.

Changing or resetting a password revokes **every** session for that account
and issues a fresh one for the current device.

Registration requires `agreedToTerms: true` and `ageConfirmed: true`.

### Email verification and password reset

Single-use, expiring tokens; only their hashes are stored. Set
`MAIL_TRANSPORT=smtp` plus `SMTP_*` to actually send mail - the default
`console` transport prints the message instead, and `PUBLIC_URL` is what
makes the links in it absolute.

`POST /api/auth/forgot-password` and `POST /api/auth/resend-verification`
answer **identically** whether or not the address exists, so neither can be
used to enumerate accounts.

## 3a. Configuration highlights

| Variable | Default | Why you would change it |
|---|---|---|
| `RATE_LIMIT_STORE` | `memory` | `postgres` shares counters across instances and survives a deploy |
| `TRUST_PROXY` | `false` | Set `true` behind a proxy, or every client shares one IP in the limiter |
| `STORAGE_DRIVER` | `local` | `s3` for AWS S3 / R2 / MinIO / B2, so uploads outlive a deploy |
| `SECURE_COOKIES` | `true` | Must stay `true` in production over HTTPS |
| `MAIL_TRANSPORT` | `console` | `smtp` to send; `disabled` to suppress |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | `true` blocks use until confirmed |

## 3b. Uploads

`src/services/storage.js` has two interchangeable drivers:

- **local** (default) - writes to `uploads/`, served by `express.static`.
- **s3** - any S3-compatible service. SigV4 presigned URLs are implemented
  with Node's `crypto`, so there is no SDK dependency. Set
  `S3_PUBLIC_BASE_URL` for a public bucket, or leave signing on to hand out
  short-lived presigned GETs. Object *deletion* is intentionally not
  implemented - configure a bucket lifecycle rule instead.

Object keys are flat and random (`20261002-<32 hex>.jpg`), which keeps the
public URL shape `/uploads/<name>` that the frontend allowlist validates.
Unreferenced uploads are pruned half-hourly (local driver only).
## 4. Ownership model

Anyone can browse and read the catalog without an account. Publishing
requires sign-in. **Only the account that published a series can add
chapters to it** — enforced server-side by the `requireSeriesOwner`
and `requireChapterOwner` middleware, not just hidden in the UI.

### Not every route that takes an id needs an ownership check

This is the mistake worth heading off, so it is spelled out.

Routes fall into two classes, and they want opposite answers.

**Routes whose target is somebody else's row** must load the row, compare it
to `req.user`, and refuse with 403 or 404. `requireSeriesOwner` and
`requireChapterOwner` do this, admins excepted.

**Routes scoped to the caller's own row by construction** have nothing to
compare, because the id in the path is not a reference to another user's
data — it is a value inside the caller's own JSONB. These are the library
routes:

| Route | What it touches |
|---|---|
| `DELETE /library/:seriesId` | filters `req.user.library` |
| `DELETE /library/downloads/:chapterId` | filters `req.user.downloads` |

`libraryRoutes.js` applies `protect` to every route, and neither handler ever
loads the series or chapter named in the path. `DELETE /library/downloads/:id`
with somebody else's chapter id is therefore a no-op that returns **200** and
the caller's own unchanged list.

**That 200 is correct. Do not "fix" it into a 403.**

Making these refuse would be a regression, not a repair:

- It breaks idempotency. A client retrying a delete after a dropped
  connection gets a 404 for something it legitimately removed, and then has
  to distinguish "gone" from "never yours".
- The check would have to load the row to compare it, which is the only
  thing these routes currently avoid doing.
- It protects nothing. The path id is compared against the caller's own
  array, so no other user's row is reachable in the first place.

The real hazard on these routes runs the other way, and it is the one worth
testing for: **writing to the wrong user's row.** A `save()` that persists
against a stale or shared model instance does not produce a 403 problem at
all — it silently hands the caller somebody else's downloads. That is a
correctness bug in the write path, not a missing guard, and no status code
would reveal it.

So the invariant to preserve when editing these handlers is: *the row
written is `req.user`'s row, and the response echoes only `req.user`'s
state.* `test/ownership.http.test.js` pins exactly that, in two lists that
are deliberately kept apart — `CASES` demands 403/404 from a stranger, and
`CALLER_SCOPED` demands a sub-400 answer plus an empty, caller-owned
payload. If you add a route, decide which list it belongs in before writing
the handler; if you change one of these handlers, that test is what will
tell you whether you broke something.

## 5. API reference

Base URL: `/api`

### Auth — `/auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account. Body: `displayName, username, email, password, agreedToTerms, ageConfirmed` |
| POST | `/auth/login` | — | Body: `identifier` (username or email), `password` |
| GET | `/auth/me` | ✓ | Current user |
| PATCH | `/auth/me` | ✓ | Update `displayName`/`bio` |
| PATCH | `/auth/me/password` | ✓ | Body: `currentPassword, newPassword`. Revokes other sessions |
| POST | `/auth/refresh` | cookie | Rotate the refresh token, return a new access token |
| POST | `/auth/logout` | — | Revoke the presented refresh token |
| POST | `/auth/logout-all` | ✓ | Revoke every session for the caller |
| POST | `/auth/forgot-password` | — | Body: `email`. Always the same response |
| POST | `/auth/reset-password` | — | Body: `token, newPassword`. Revokes all sessions |
| POST | `/auth/verify-email` | — | Body: `token` |
| POST | `/auth/resend-verification` | ✓ | Re-send the verification link |

### Series — `/series`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/series` | — | Browse/search. Query: `type, genre, status, tag, q, sort(popular|rating|newest|az), page, limit`. Response `count` is the total match count |
| GET | `/series/rankings` | — | Query: `range(daily|weekly|alltime)` |
| GET | `/series/mine` | ✓ | Every series the caller owns |
| GET | `/series/:id` | — | Full detail + chapter list + comment count |
| POST | `/series` | ✓ | Publish a series. Requires `rightsAttested: true` |
| PATCH | `/series/:id` | ✓ owner | Update series fields |
| DELETE | `/series/:id` | ✓ owner | Soft-delete |
| POST | `/series/:seriesId/chapters` | ✓ owner | Publish a chapter (novel: `paragraphs[]`, comic: `pages[]`) |
| GET | `/series/:seriesId/comments` | — | List reviews |
| POST | `/series/:seriesId/comments` | ✓ | Body: `rating(1-5), text, parent?` |

### Chapters — `/chapters`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/chapters/:id` | optional | Read a chapter. Counts a view at most once per reader per chapter per day |
| PATCH | `/chapters/:id` | ✓ owner | Edit |
| DELETE | `/chapters/:id` | ✓ owner | Soft-delete |

### Comments — `/comments`
| Method | Path | Auth | Description |
|---|---|---|---|
| DELETE | `/comments/:id` | ✓ author/admin | Remove a comment |

### Library — `/library` (all require auth)
| Method | Path | Description |
|---|---|---|
| GET | `/library` | Saved series, as full documents |
| POST | `/library/:seriesId` | Save |
| DELETE | `/library/:seriesId` | Unsave |
| GET | `/library/downloads` | Chapters marked offline, with `series` and `chapter` resolved |
| POST | `/library/downloads` | Body: `seriesId, chapterId` |
| DELETE | `/library/downloads/:chapterId` | Remove offline mark |

### Progress — `/progress` (all require auth)
| Method | Path | Description |
|---|---|---|
| GET | `/progress` | Full reading history |
| GET | `/progress/:seriesId` | Resume point for one series |
| PUT | `/progress/:seriesId` | Body: `chapterId, scrollPct?, page?, bookmarked?` |
| DELETE | `/progress/:seriesId` | Clear |

### Notifications — `/notifications` (all require auth)
| Method | Path | Description |
|---|---|---|
| GET | `/notifications` | List + unread count |
| PATCH | `/notifications/:id/read` | Mark one read |
| PATCH | `/notifications/read-all` | Mark all read |

### Uploads — `/uploads` (require auth)
| Method | Path | Description |
|---|---|---|
| POST | `/uploads/cover` | multipart field `cover` → `{ path }` |
| POST | `/uploads/pages` | multipart field `pages` (multiple) → `{ paths[] }` |

### DMCA — `/dmca`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/dmca` | — (public) | File a takedown notice |
| GET | `/dmca` | admin | List reports |
| GET | `/dmca/:id` | admin | Report detail |
| PATCH | `/dmca/:id` | admin | Resolve: `status(under_review|accepted|rejected), adminNotes?` — `accepted` soft-removes the target content |

### Admin — `/admin` (admin role required)
| Method | Path | Description |
|---|---|---|
| GET | `/admin/users` | List users (password column excluded) |
| PATCH | `/admin/users/:id/ban` | Body: `reason?` |
| PATCH | `/admin/users/:id/unban` | — |
| DELETE | `/admin/series/:id` | Moderation removal |
| DELETE | `/admin/comments/:id` | Moderation removal |

### Legal — `/legal`
| Method | Path | Description |
|---|---|---|
| GET | `/legal` | List available documents |
| GET | `/legal/:doc` | Serves `terms`, `privacy`, `dmca`, `copyright`, or `content` as markdown |

### Health
`GET /api/health` → `{ success, status: 'ok', time }`

## 6. Making the first admin user

There's no signup flow for admins on purpose. After registering a
normal account, promote it manually:

```js
-- PostgreSQL / Neon SQL console
UPDATE users SET role = 'admin' WHERE username = 'your_username';
```

## 8. Testing

```bash
npm test            # everything that needs no database and no browser
npm run test:unit   # the fast subset, named explicitly
npm run lint        # ESLint
npm run lint:fix    # ESLint, autofixable rules
npm run smoke       # require() every module - catches syntax/import errors
npm run test:http   # the real Express app over HTTP
npm run test:live   # executes the generated SQL against a real PostgreSQL
npm run test:browser # the XSS payloads replayed in a real browser
npm run test:e2e    # the real server, the real page, a real browser
npm run test:shutdown # SIGTERM drains in flight work, closes the pool, exits 0
npm run test:watch  # re-run on change
npm run test:coverage # the above, with a line/branch/function report
```

| Script | Needs | Covers |
|---|---|---|
| `test` | nothing | unit + HTTP + XSS + session + infrastructure |
| `test:unit` | nothing | the fast subset, listed by name |
| `test:http` | nothing | routing order, auth/ownership, validation chains, library shape |
| `test:browser` | Chromium already installed | the XSS payloads in a real browser's HTML parser, plus the outage toast |
| `test:browser:ci` | network access | the same, installing Chromium with its system dependencies first |
| `test:live` | PostgreSQL | every query against a real database |
| `test:shutdown` | PostgreSQL + a POSIX signal | that SIGTERM drains, closes the pool and stops the jobs rather than waiting to be killed. Skipped on Windows, which cannot deliver a signal to a child process, and skipped without `VORTH_LIVE_DB=1`, because server.js exits during startup when it cannot reach a database |
| `test:e2e` | PostgreSQL + Chromium | sign-up, publish, read, save, copyright claims, page weight |
| `test:coverage` | nothing | `test`, plus line/branch/function coverage of `src/` |
| `smoke` | nothing | `require()` every module |
| `lint` | nothing | ESLint |

`--coverage` is forwarded to each spawned `node --test` process rather than to
`test/run.js` itself: V8 coverage is collected per process, and every test file
already runs in its own, so a flag on the runner would measure only the runner.

**Read that percentage as a floor, not as the project.** `npm run test:coverage`
needs no database and no browser, so the live and end-to-end files skip
themselves and the report covers the unit suite alone. With `VORTH_LIVE_DB=1` and
`VORTH_E2E=1` set the whole suite reads **95.5% of statements, 84.8% of branches,
94.1% of functions**. The gap between the two runs is almost all controllers,
which is exactly what the skipped suites exist to exercise. The report says which
suites sat it out, so a low number is never silently mistaken for a real gap.

The lowest-covered area is `src/jobs` (87%): what remains is the `cron.schedule`
wiring itself, which has no value in being executed outside a scheduler. The job
*bodies* are named exports and both test files call them directly, against a
recording pool and against real PostgreSQL.

```bash
VORTH_LIVE_DB=1 VORTH_E2E=1 DATABASE_URL=postgresql://... npm run test:coverage
```

What each area covers within those scripts:

| Suite | Covers |
|---|---|
| `sqlBuilder` | SQL generation, operator validation, injection resistance |
| `models` | dirty tracking, batched populate, `deleteMany` filters, single-statement writes, atomic upsert, password stripping |
| `aggregate` | grouping by any column, compound keys, and the ungrouped case |
| `businessDays` | business-day arithmetic, against dates worked out by hand |
| `counterNotice` | the counter-notice flow: statutory statements, forwarded text, route ordering |
| `claims` | the publisher-facing claim markup, including that it escapes |
| `configDrift` | `.env.example` completeness, schema/model/verifier agreement, asset budgets |
| `nullFilter` | `$ne: null` and `$nin: [null]`, which compile to predicates matching nothing if wrong |
| `columnUpgrade` | that boot repairs a schema missing a column, and issues no `ALTER` when it does not |
| `session` | token hashing, cookie hardening, rotation, enumeration-equivalence |
| `infrastructure` | storage drivers, both rate-limit stores |
| `views` | view de-duplication |
| `xss` | escaping rules, plus a guard against reintroducing raw interpolation into `script.js` |
| `postgres.live` | executes every query against a real PostgreSQL |
| `postgres.serial` | the schema bootstrap, alone: the only tests that may issue DDL |
| `frontendOutage` | the offline toast, in a real browser, over a server that 404s `/api` |

The database is replaced by a recording double (`test/helpers/fakePool.js`)
that captures every statement, so the fast suites assert on the SQL actually
issued rather than on a reimplementation. `test:live` exists because a
double cannot catch a syntax error - it caught two during this work.

Tests are invoked through `test/run.js` rather than `node --test "test/*.test.js"`.
Node only expands that glob itself on 21+; on 20 and earlier the quoted pattern
is treated as a literal filename and the run dies with
`Could not find '.../test/*.test.js'`. Removing the quotes does not help either,
because npm runs scripts through cmd.exe on Windows and sh on Linux, so only one
of the two expands it. The runner resolves the file list in Node and passes
explicit paths, which behaves identically everywhere.

CI runs lint, the full suite, the browser regression, the live PostgreSQL
suite, the seed script's idempotency, and an upgrade from the previous
schema. It runs on Node 22 and deliberately supplies **no `.env`**, so the
suite is proven to pass without local configuration leaking in.

### Warning: a local `.env` may point at production

`DATABASE_URL` in a local `.env` is very often a real, remote, production
database. Anything that boots the app - a script, a REPL, a health check -
connects to it, and applying the schema is part of booting.

`connectDB()` refuses to run schema against a managed production host (Neon,
RDS, Azure, Cloud SQL, Supabase, PlanetScale, DigitalOcean, Xata,
CockroachDB) unless the process is deploying:

| Condition | Schema applied? |
|---|---|
| `NODE_ENV=production` | yes - this is a deployment |
| local host, or a non-managed remote | yes - this is development |
| managed production host, anything else | **refused** |
| any of the above plus `VORTH_ALLOW_SCHEMA_ON_PRODUCTION=1` | yes, deliberately |

`NODE_ENV=prod` is **not** `production` and is not honoured; guessing at a
near-miss would defeat the point. The refusal happens before the pool is
touched, so nothing is sent. `VORTH_SCHEMA_GUARD_DEBUG=1` logs the target and
the decision on every boot.

The rules live in `src/config/hostGuard.js` and are shared with the
destructive-test guard below, so the two cannot drift apart.

This guard exists because it was needed. A script run while building this
applied four new tables and two indexes to a live Neon database, because
`dotenv` had loaded that URL and nothing was checking. `test/hostGuard.test.js`
replays that exact incident and fails if it ever becomes possible again.

### Booting several instances at once

Applying the schema is **not** concurrency-safe. Every `CREATE INDEX` takes a
`ShareLock` on its table even when it creates nothing, and that conflicts with
the `RowExclusiveLock` any writer holds — so two processes applying the schema to
one database at the same time can deadlock against each other. It is not
hypothetical: the live suite deadlocked exactly this way, with `node --test`
running four files in parallel, each calling `connectDB()`.

Two things reduce the exposure:

- **Column upgrades are conditional.** `ADD COLUMN IF NOT EXISTS` also takes an
  `AccessExclusiveLock` even when the column exists, which was the worse half of
  the problem. Boot now reads `information_schema` first and issues only the
  `ALTER`s that are genuinely missing, so an up-to-date database takes no
  exclusive lock at all. `test/columnUpgrade.test.js` pins that.
- **`VORTH_SKIP_SCHEMA=1`** connects without touching the schema at all, for the
  case where the schema is already known good and only a connection is wanted.
  `test/run.js` sets it automatically for the live suite, after preparing the
  schema once. It is **not** a deployment mechanism — a real instance must be
  able to bring its own schema up, which is why the DDL lives in `connectDB()`
  rather than in a separate migration step.
  **A new test file that asserts boot applies the schema must delete that flag
  for the duration of the test, and must be named `*.serial.test.js`.**
  Otherwise `connectDB()` returns before issuing any DDL and the failure reads as
  "the production guard broke" rather than "the flag was still set"; and if it
  runs in the parallel pass it puts `CREATE INDEX` beside every other live
  file's `INSERT`, which deadlocks. `postgres.serial.test.js` and
  `columnUpgrade.serial.test.js` do both; `hostGuard.test.js` clears the flag
  against a stub pool that never reaches a server.
  `test/configDrift.test.js` fails if a file clears the flag and is neither.

`*.serial.test.js` files are run in a second pass, after every parallel file has
finished, and **one file per invocation** — `node --test` runs every file it is
handed concurrently, so passing the whole serial list to one run would put two
destructive files in the same database at the same time, which is the collision
the suffix exists to prevent.

For a rolling deploy where old and new instances overlap, deploy with
`VORTH_SKIP_SCHEMA=1` on the second and later instances, or accept a brief window
in which writes block behind `CREATE INDEX`. Both `CREATE TABLE IF NOT EXISTS`
and `CREATE INDEX IF NOT EXISTS` are individually correct; it is only running
them concurrently that is not.

### Warning: `test:live` refuses to touch a real database

`test:live` executes `DELETE` statements, and its serial pass executes DDL.
`DATABASE_URL` in a local `.env` is very often a **real, remote, production
database**, so the suite is gated by `test/helpers/liveGuard.js` and will not run
unless **both** hold:

1. `VORTH_LIVE_DB=1` is set explicitly, and
2. the target is local (`localhost`/`127.0.0.1`) **or** its database name
   contains `test`/`ci`/`tmp`/`local`/`dev`/`scratch`/`dummy`.

Known managed-production hosts (Neon, RDS, Azure, Cloud SQL, Supabase,
PlanetScale, DigitalOcean, Xata) are refused outright even with the opt-in.
`VORTH_LIVE_DB_ALLOW_REMOTE=1` overrides that last check for a shared
scratch database - never for production.

```bash
# PowerShell
$env:DATABASE_URL = 'postgresql://vorth:vorth@127.0.0.1:5432/vorth_test'
$env:VORTH_LIVE_DB = '1'
npm run test:live
```

The suite is also data-isolated: it never issues `TRUNCATE`, and every row
it creates is tagged with a per-run marker and deleted again in dependency
order. `scripts/inspectCounts.js` prints row counts for a database
(read-only) if you need to see what is in there.

### Migrations

The schema is applied on boot and is purely additive, so upgrading is just
starting the new code. There is no migration tool and no down-migration.

```bash
# In a throwaway database, never production:
npm run db:apply-legacy       # rebuild the PRE-UPGRADE schema (see below)
npm run db:verify-schema      # must FAIL here - that is the point
npm run db:verify-migration   # boots the current code against it, asserts nothing was lost
npm run db:verify-schema      # must now PASS
```

Two details worth knowing, because both were bugs first:

- `db:apply-legacy` is **pinned to commit `cfd488b`**, the last commit before
  the schema was extended. Reading `HEAD` instead would return the *current*
  schema, so the check would apply the new DDL and then assert the new DDL
  exists - passing while proving nothing. The script also fails loudly if the
  pinned commit ever turns out to already contain a post-upgrade table.
- `db:verify-schema` deliberately **does not boot the app first**. A boot
  re-creates any missing index, so verifying after one would silently repair
  the very thing being checked and the index assertions could never fail. It
  inspects the schema exactly as it stands.

CI runs the whole sequence against a real PostgreSQL, including the failing
step in the middle: if `db:verify-schema` passes on a pre-upgrade database,
the CI job reports an error, because a check that cannot fail proves nothing.
### Writing a test fixture that looks like a credential

If you add a test for a secret-detection rule, **do not write the sample secret
out as a literal string.** Assembled at runtime from fragments instead:

```js
const T = (...parts) => parts.join('');

// Assembled, not literal: a contiguous credential-shaped literal in a blob is
// indistinguishable from a real one, and hosted secret scanning will report it.
'Google API key': T('AI', 'zaSyA0123456789abcdefghijklmnopqrstuv'),
```

This is not hypothetical. Writing these out as plain strings caused GitHub's
secret scanning to flag this repository and ask the owner to rotate a Google API
key that never existed. The rule still matches — the regex runs against the
assembled string — and `test/secrets.test.js` asserts that this file contains no
credential-shaped value of its own, so it cannot quietly come back.

## 9. Known limitations / what's next

- **No payment/monetization** — out of scope for this pass.
  Content Policy violations — only DMCA has a formal intake right now.
- **DMCA counter-notices are implemented but not legally reviewed.** The flow is
  real, end to end:

  | Endpoint | Who | What |
  |---|---|---|
  | `POST /api/dmca` | anyone | file a takedown notice |
  | `GET /api/dmca/mine` | the publisher | takedowns against your own content, and the route to contest one |
  | `POST /api/dmca/:id/counter-notice` | anyone | contest an accepted takedown; captures the four §512(g)(3) statements and forwards them to the complainant |
  | `GET /api/dmca/counter-notices` | admin | the counter-notice queue |
  | `PATCH /api/dmca/counter-notices/:id` | admin | record a court action, a restoration, or a withdrawal |

  Accepting a takedown notifies the publisher, and the profile panel lists their
  claims with the response window. That window starts at 10 business days from
  the forward — the earliest bound §512(g)(2)(C) allows, so the clock only runs in
  the complainant's favour — and when it lapses the material may be restored via
  `npm run dmca:sweep-lapsed`.

  Restoration is deliberately *not* automatic: it is an operator-run sweep, and
  it only puts back content still removed because of *that* notice, so a moderator
  removal, a Content Policy report or a court order is never undone. The sweep
  reports what it declined to restore and why, because a sweep that restored
  nothing must not be mistakable for one with nothing to do. The sweep is
  batched: it takes at most `SWEEP_BATCH` (200) notices per pass and processes
  each independently, so a large backlog clears over several runs and a partly
  failing batch still advances.

  Before relying on any of it in production, have counsel review the process and
  register a DMCA designated agent with the U.S. Copyright Office. Public
  holidays are excluded from the window only if `DMCA_COUNTER_NOTICE_HOLIDAYS` is
  configured; weekends always are.
- **A removal recorded before `takedown_reason` existed cannot be restored
  automatically.** The guard that decides what a counter-notice may put back
  reads that column. Rows removed by a takedown accepted before this column was
  added have a null reason, so they are treated as "not ours" and stay down. That
  is the safe direction, but those need a deliberate backfill by an operator.
- **Search** is an indexed tsvector over title, author, artist and synopsis,
  with stemming, weighted relevance ranking and a GIN index. A substring
  second pass runs when the indexed pass finds nothing, so partial words
  still match without a sequential scan on the common path. `english` is a
  single dictionary: proper stemming per language is not supported, which is
  a deliberate simplification rather than an oversight.
- **Rate limiting** works, but the default `memory` store is per-process. Set
  `RATE_LIMIT_STORE=postgres` when running more than one instance.
- **`aggregate()`** supports `$match`, `$group`, `$sort`, `$skip`, `$limit` and
  `$project`. `$group._id` may be any column (`'$type'`), a compound key
  (`{ series: '$series', user: '$user' }`, reassembled into a nested `_id` in
  JavaScript since it has no single SQL expression), or `null` for one row over
  the whole match. Accumulators are `$sum`, `$avg`, `$min`, `$max` and
  `{$sum: 1}`. Anything else throws rather than returning quietly wrong numbers.
- **`last_daily_reset` and `last_weekly_reset` cannot record what they claim to.**
  They exist to say when a view counter was last reset, but both are
  `NOT NULL DEFAULT now()`, so a newly created series already carries both and a
  reset simply overwrites one timestamp with another. Nothing reads either column
  — not the API, not the frontend, not a script — so nothing is currently misled,
  but nothing would learn anything from them either. Either drop them or let them
  default to `NULL`; both are schema changes, so neither was made unilaterally.
  `test/jobs.live.test.js` asserts the present shape, so it fails if it changes.
- **`resetCounter` interpolates its `key` into SQL** and therefore validates it
  against a fixed set (`daily`, `weekly`) before issuing anything. Both call sites
  pass a literal so nothing was ever exposed; the check exists so the next call
  site cannot rely on that remaining true.
- **The schema check is a floor, not a ceiling.** `db:verify-schema` asserts
  13 tables, 4 columns, 9 UNIQUE constraints and 27 indexes. It cannot tell you
  about a column type or a constraint it does not know about.
- **List endpoints are capped, not paginated.** The moderation queues, the comment
  list for a series and the chapter list returned with a series have a ceiling
  (200 by default, 500 maximum, and `?limit=` is clamped to that maximum rather
  than trusted). They return the newest rows and no total count, so a client
  cannot tell "that is all of them" from "that is the first page" — they can tell
  it is a page. That is a deliberate bound against an unbounded read on a table
  that only grows, not a pagination contract; real pagination would need a cursor
  and a count, and nothing consumes those today.
- **Uploads default to local disk.** Set `STORAGE_DRIVER=s3` before running
  more than one instance, or files will not survive a redeploy.
- **Search does not do fuzzy matching or typo tolerance.** "starlit" will not
  find "Starlight" unless trigram similarity is added.
- **Object storage deletion is implemented but not life-cycle management.**
  `remove()` issues a signed DELETE, so a specific orphan can be removed on
  demand. A bucket lifecycle rule is still the right answer for objects that
  are simply abandoned, and you still need one — use a
  bucket lifecycle rule.
- The legal documents in `/legal` are templates — see the notice at
  the top of this file.
