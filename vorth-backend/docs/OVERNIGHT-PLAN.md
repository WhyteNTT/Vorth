# Overnight plan — everything automatable, with review gates

Written from measured evidence, not from imagination. The coverage figures below
are real (`npm run test:coverage`, c8-merged across every spawned test process).

**Baseline at `df3da60`:** 88.34% statements / 83.08% branches / 89.52%
functions. Unit 318 pass / 0 fail, live 42 + 5 serial, e2e 6/6, browser 3/3,
lint clean, smoke 59/59 — Windows and Node 24.

The coverage number is a **floor**. `npm run test:coverage` needs no database or
browser, so the live and end-to-end files skip themselves and the unit suite alone
reads 81.52%. The runner reports which suites sat it out. The gap between 81.52%
and 88.34% is almost entirely controllers, which is exactly what those skipped
suites exist to exercise — so the low controller numbers below are the honest
starting point, not a crisis.

## Phase 1 — Controllers: the largest measured gap

`src/controllers` at 76.06%. Worst first, by statement coverage:

| File | Stmts | Funcs | Why it matters |
|---|---|---|---|
| `commentController.js` | 36.5% | **0%** | rating + notification fan-out; no function is exercised at all |
| `notificationController.js` | 48.57% | 100% | unread counting and read-all |
| `chapterController.js` | 51.06% | 100% | chapter numbering, the `UNIQUE(series,num)` constraint |
| `uploadController.js` | 52.83% | 100% | file handling, the most abusable surface |
| `progressController.js` | 55.31% | 100% | per-user read state |
| `authController.js` | 67.33% | 100% | register/login/refresh/verify/reset |
| `reportController.js` | 69.02% | 100% | content reports and takedowns |
| `adminController.js` | 70.68% | 100% | moderation, ban/unban |
| `accountController.js` | 78.1% | **50%** | deletion and export |
| `libraryController.js` | 80.88% | 100% | saves and downloads |

Work: HTTP-level tests for each, asserting status, authorisation, ownership and
side effects against the recording double, plus live tests where the behaviour is
in SQL.

## Phase 2 — Services and middleware

| File | Stmts | Branch | Funcs | Why it matters |
|---|---|---|---|---|
| `mailer.js` | 63.52% | 70% | 60% | password reset and verification cannot work without it |
| `errorHandler.js` | 69.38% | **30.76%** | 100% | decides what a reader is shown on failure |
| `ownership.js` | 66.66% | 83.33% | 100% | the authorisation boundary |
| `app.js` | 90.29% | **40%** | 100% | middleware order is load-bearing (CSP/connect-src already bit once) |
| `upload.js` | 76.31% | 100% | **0%** | no function exercised |
| `rateLimiter.js` | 92.77% | 77.77% | 60% | key generators |
| `rateLimitStore.js` | 97.11% | 100% | 78.57% | shared counters across instances |

### REVIEW GATE 1 — full suite, lint, smoke, live, e2e, browser, coverage delta

## Phase 3 — Security: authorisation, secrets, abuse surface

- A **route authorisation matrix** that resolves file-level `router.use(protect)`
  *and* inline guards, and asserts the effective access level of all ~62 routes
  against an explicit reviewed allowlist. A hand-written version of this reported
  34 unguarded routes, all false, because it could not see `router.use`.
- **Ownership audit**: every mutating route verified to check the caller owns the
  target, not merely that they are authenticated.
- **Abuse surface**: rate limits per route class; unbounded inputs; enumeration
  resistance on login/reset/verify.
- **Secrets**: a committed-scanner for high-entropy strings, connection strings and
  private keys. Written in-repo rather than adding gitleaks — one less dependency
  for a check this small, and the repo has form: a `.env` holding a production
  database URL caused a real incident.

## Phase 4 — Accessibility and frontend robustness

- `axe-core` against the real page: landing, browse, detail, reader, profile,
  sign-in, and the signed-in states the e2e flow reaches. Violations fixed, not
  suppressed.
- Keyboard: focus order, focus trapping in overlays, focus restoration on close,
  visible focus rings.
- `prefers-reduced-motion` honoured by anything that moves.
- Console cleanliness and unhandled-rejection behaviour on every view.

### REVIEW GATE 2 — full suite, lint, smoke, live, e2e, browser, coverage delta

## Phase 5 — Performance and data access

- **Unbounded reads**: every `find()` without a `limit`; every list endpoint's
  pagination ceiling.
- **Query plans** for the hot paths against real PostgreSQL, with `EXPLAIN
  (ANALYZE, BUFFERS)`, checking index use rather than assuming it.
- **N+1**: populate paths and per-row queries.
- The JSONB `views` counters and the `tsvector` search path specifically.

## Phase 6 — Operational readiness

- Structured logging with request correlation; no secrets or personal data in logs.
- `/api/health` depth: liveness vs readiness, and what each actually proves.
- Graceful shutdown: in-flight requests, pool drain, job deregistration.
- Error responses: no stack traces, no internal identifiers, correct status codes.
- Preflight: every finding must name a real remediation.

### REVIEW GATE 3 — full suite, lint, smoke, live, e2e, browser, coverage delta

## Phase 7 — Supply chain

- `npm audit` (currently clean) kept clean, and license compatibility checked for
  every dependency including transitives.
- Lockfile integrity and the `npm ci` guarantee.
- CI: pin action versions, least privilege, no secret leakage into logs.
- Render blueprint validated by parsing, not by reading.

## Phase 8 — Consolidation

- Every number quoted in the README re-derived from a run, not remembered.
- Limitations section reconciled against the code, again.
- Final coverage report and an honest statement of what remains untested and why.

### REVIEW GATE 4 (final) — full suite, lint, smoke, live, e2e, browser, schema check, coverage

## Not automatable — needs a person

- **Backend deployment.** Render → New + → Blueprint → `WhyteNTT/Vorth`. The user
  must click through GitHub OAuth; no credential-free path exists from here.
- **DMCA designated agent registration.** A legal filing with the U.S. Copyright
  Office. Takes days. The flow is implemented and reviewed-by-machine, not by a
  lawyer.
- **Counsel review** of the counter-notice process. The statute is explicit about
  deadlines and statements, which is why they are implemented; explicit is not the
  same as correct for this deployment.
