# Overnight plan — outcome

This started as a plan and finished as a record of what the code actually needed.
The plan is kept because the reasoning is useful, but the phase table below is
what happened, not what was predicted.

**Start:** `df3da60`, 88.34% statements / 83.08% branches / 89.52% functions.
**End:** `f75dcce`, **94.22% / 84.81% / 92.12%**. Both CI jobs green.

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

## Not automatable — still needs a person

- **Backend deployment.** Render → New → Blueprint → `WhyteNTT/Vorth`. Needs a
  GitHub OAuth click; no credential-free path exists from here.
- **DMCA designated agent registration.** A legal filing with the U.S. Copyright
  Office. Takes days.
- **Counsel review** of the counter-notice process. The statute is explicit about
  deadlines and statements, which is why they are implemented. Explicit is not the
  same as correct for this deployment.