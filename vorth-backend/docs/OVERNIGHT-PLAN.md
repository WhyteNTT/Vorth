# Overnight plan — outcome

This started as a plan and finished as a record of what the code actually needed.
The plan is kept because the reasoning is useful, but the phase table below is
what happened, not what was predicted.

**Start:** `df3da60`, 88.34% statements / 83.08% branches / 89.52% functions.
**After the eight phases:** `f75dcce`, 94.22% / 84.81% / 92.12%.
**Now:** **96.64% / 85.99% / 93.66%**, live suite, end-to-end and browser included.

The second figure is a second pass, and it exists because the honest answer to "is
everything automatable done?" was *no*. Re-running the four things the phases had
promised but skipped found three product bugs and, more usefully, several guards
that were passing while verifying nothing. Those are recorded under
[What the second pass found](#what-the-second-pass-found).

## What each phase actually found

| Phase | Predicted | Found |
|---|---|---|
| 1. Controllers | coverage gaps | Coverage gaps, plus a guard in `protect` that **nothing tested** — removing the `isBanned` check broke no existing test, so a suspended account kept working until its token expired |
| 2. Services / middleware | weak error handling, mailer | A **500 returned the raw Postgres message and a full stack**. The frontend hid it, so it looked fine; curl did not. Also found the first test-double defects |
| 3. Security | route matrix, secrets | The matrix (which resolves `router.use(protect)`, unlike the hand-written version that reported 34 false positives). Ownership proved behaviourally after the static version proved it could not be. Secrets scanner — written, not installed, because the accident it targets happened here |
| 4. Accessibility | violations | 4 unnamed filters, two views opening with two `h1`s. `axe-core` would have been the better tool; the limit of what was written is stated in the file |
| 5. Data access | unbounded reads | 14. Three admin queues that only grow, two public reads anyone can make, and the sweep reading its entire backlog into memory on a cron wakeup |
| 6. Operational | — | Shutdown closed the listener but not the pool or the jobs, and `server.close()` was unbounded. Fixed, and the fix was itself wrong once — caught in Linux |
| 7. Supply chain | npm audit, licences | 5 advisories, all dev-only. nodemon **removed** rather than upgraded. CI actions were mutable tags and there was no `permissions` block |
| 8. Consolidation | — | Numbers re-derived from a run; limitations reconciled against the code |

## What the phases did not do, and why

- **`src/jobs` is 39% covered.** The cron callbacks only run on a schedule. The
  counter-notice sweep is exercised by `dmca:sweep-lapsed`; the view-counter resets
  are not exercised outside a real clock tick. Reported rather than chased.
- **The secrets scanner is not entropy analysis.** It matches credential *shapes*.
  A secret that does not match a known shape would not be found. Stated in the file.
- **The static ownership check cannot prove enforcement.** Replacing the guard in
  `requireChapterOwner` with `if (false)` leaves "owner" and "req.user" in the
  file and it passes. `ownership.http.test.js` is the proof; the static check is a
  tripwire for omission only. Both say so.

## Three things worth keeping

**Mutation testing is what found the real defects.** Every guard in this work was
proven by introducing the defect it exists to catch. The `isBanned` guard, the
traversal guard, the rotation revocation, the OR-in-the-double, the update echo,
the shutdown drain: none of them were wrong in a way that a passing test would
have shown.

**Three of the bugs were in the test harness.** OR evaluated as AND. `UPDATE ...
RETURNING` returned a blank row, so every `save()` wiped the document it had just
written. My first fix for that was wrong too — it returned the *first* row rather
than the row the `WHERE` clause matched, so a save re-hydrated a document with
somebody else's data. A double that is confidently wrong is worse than no double.

**A test that races a 2.2-second animation is not a slow test.** The outage test
failed once in three runs with the correct message sitting in the element. Raising
its timeout to 90s did not help, which killed the contention theory and pointed at
the real cause. It now records every state the toast passes through, via an
observer installed before any document exists.

## What the second pass found

Asked whether everything automatable had actually been done, the honest answer was
no. Four things the phases had promised and skipped:

### Three product bugs

| Area | Finding |
|---|---|
| Moderation | `target: 'comment'` removed the chapter **and** series. Each branch excluded only one target, so a moderator removing one comment took down the whole serial. Also, `all` skipped the comment entirely. |
| `GET /api/reports/:id` | Returned **500, always**. `refFor` maps populate paths through a hand-written table that knew the DMCA controller's field names but not the Content Policy report's `reportedSeries` / `reportedChapter` / `reportedComment`. It had never worked; the route had no test. |
| Rate limits | Uploads had the **loosest** limit of any expensive route — 60 files × 8 MB per request behind a 300-per-15-minute general limit, which is 144 GB per IP per window onto local disk, with no disk ceiling and no per-user accounting anywhere in the schema. Auth was capped at 20, DMCA at 5. |

### Guards that were passing while verifying nothing

The more useful half. These were found by asking what each check was actually
looking at, not by reading the assertions:

- The rate-limit audit keyed routes `authRoutes.js:POST /login` and looked them up
  with `startsWith('authRoutes:')`. Never matches. Every per-route assertion
  matched zero rows and reported "found 0" as though that were a finding.
- It derived mount paths from filenames: `uploadRoutes` → `upload`, while the real
  mount is `uploads`. It was never bound to the upload test that actually broke.
- The orphan-sweep count used `WHERE title IN (SELECT … WHERE title = …)` — a
  tautology that matches whatever is there.
- `uploads.js` captured `UPLOAD_DIR` at require time, so the sweep could not be
  pointed at a scratch directory. The first attempt at those tests ran against the
  real uploads directory; they were removed and rewritten rather than trusted.

A guard that watches nothing looks exactly like a guard that passes. Each of these
now asserts it is attached to something, or asserts the count of things it found.

### The end-to-end suite was failing on itself

It passed five runs, failed on the sixth, then seven of the next seven. Nothing
deleted what it created, so each run left a series behind. `renderBrowse` asks for
`limit: 24` sorted by `views.alltime` descending; every leftover ties at 0, so past
the twenty-fourth row PostgreSQL's tie-break decides the order and the new series
falls off page 1. Confirmed at the database: 24 of 48 rows.

The cleanup took four attempts and the first three deleted nothing — two because
every statement was wrapped in `.catch(() => {})`, one because the SQL referenced a
`user` column on a table that has none. Each looked like it had worked. An after-hook
assertion now counts what is left and fails if it is non-zero; it is what turned the
third attempt's silent SQL error into a named failure.

### Also

- **Query plans**, promised in Phase 5 and never run. `EXPLAIN (ANALYZE, BUFFERS)`
  against real PostgreSQL on the hot paths, seed 4000 rows deep enough that the
  planner has a reason to prefer an index. Dropping `idx_series_listing` or
  `idx_series_search` is caught.
- **The health endpoint's DB-down path**, untested and the branch that decides
  whether a broken instance stays in rotation.
- **CORS origin handling** — `app.js` sat at 40% branch, and the uncovered half was
  the callback that decides whether a browser may read a response.
- **The orphan-upload sweep**, which is the other half of the upload rate limit and
  the only thing bounding the upload directory. Five mutations caught, one per guard.

## Not automatable — still needs a person

- **Backend deployment.** Render → New → Blueprint → `WhyteNTT/Vorth`. Needs a
  GitHub OAuth click; no credential-free path exists from here.
- **DMCA designated agent registration.** A legal filing with the U.S. Copyright
  Office. Takes days.
- **Counsel review** of the counter-notice process. The statute is explicit about
  deadlines and statements, which is why they are implemented. Explicit is not the
  same as correct for this deployment.