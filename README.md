# Vorth

Vorth is a novel and comic reading platform with a static browser frontend and
an Express/PostgreSQL backend.

## Project layout

- [`vorth-backend/`](./vorth-backend/) - Node.js API, authentication, catalog,
  uploads, moderation, and legal/DMCA endpoints. Auth: JWT bearer tokens with
  rotating refresh cookies. Data: PostgreSQL via `pg`.
- [`vorth-frontend/`](./vorth-frontend/) - static browser frontend. No build
  step; plain ES2020 plus one helper module (`lib/safe.js`).

> The backend was migrated from MongoDB to PostgreSQL in commit `8d50135`.
> There is no Mongoose layer - see
> [`vorth-backend/README.md`](./vorth-backend/README.md) for how the query
> builder works.

## Run locally

1. Configure [`vorth-backend/.env.example`](./vorth-backend/.env.example) as
   `vorth-backend/.env`, including a `DATABASE_URL` and a long `JWT_SECRET`.
2. `npm install` and `npm run dev` from `vorth-backend/`.
3. Optionally seed demo content: `npm run db:seed -- --confirm`.
4. Open the frontend from a local static server, or use the API's static
   serving when running the backend.

The database schema and indexes are created automatically on first connect, so
there is no separate migration step.

## Deploying

[`render.yaml`](./render.yaml) is a Render blueprint: one web service (the API
serves the frontend too) plus a managed PostgreSQL 16. Fill in
`CLIENT_ORIGINS`, `PUBLIC_URL` and `SECURE_COOKIES`; for more than one instance
also set `RATE_LIMIT_STORE=postgres` and `TRUST_PROXY=true`.

## Tests

```bash
cd vorth-backend
npm test        # unit + HTTP + XSS + session + infrastructure suites
npm run lint    # ESLint
npm run smoke   # assert every module loads
npm run test:live   # against a real PostgreSQL (see the guard below)
```

CI runs lint, the full suite, the browser-level XSS regression, the live
PostgreSQL suite, the seed script's idempotency, and an upgrade from the
previous schema. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

> **Warning:** `npm run test:live` issues DELETE statements and is **refused
> unless** `VORTH_LIVE_DB=1` is set *and* the target is local or has a
> disposable database name. Managed production hosts (Neon, RDS, Azure,
> Supabase, PlanetScale) are rejected outright, even with the opt-in set.
> See `test/helpers/liveGuard.js`.

## Security notes

- Creator-supplied fields (`genres`, `tags`, `coverImage`, comic `pages`) are
  validated server-side against a strict allowlist *and* escaped on render.
  Artwork is applied through the CSSOM, never interpolated into an HTML
  attribute. [`vorth-frontend/lib/safe.js`](./vorth-frontend/lib/safe.js) holds
  these rules and is unit tested, then replayed in a real browser.
- Password hashes are stripped by `toJSON()`, so a stray `res.json(user)`
  cannot leak one.
- Session refresh tokens are stored hashed, rotated on every use, and
  delivered in an `httpOnly` `SameSite=Lax` cookie scoped to `/api/auth` -
  unreadable by JavaScript. Password resets revoke every session for the
  account.
- Password reset and verification links are single-use; the one-shot guard is
  in the SQL `WHERE` clause, so concurrent redemption cannot both succeed.