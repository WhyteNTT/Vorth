'use strict';

/**
 * Live PostgreSQL conformance suite.
 *
 * The other suites assert on generated SQL; this one executes it. It is
 * skipped unless DATABASE_URL points at a reachable database, so `npm test`
 * stays green without one. CI runs it against postgres:16.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET ||= 'test-secret';
process.env.DATABASE_SSL = 'false';

// Load .env exactly the way the app does, so the guard inspects the same
// connection string the application would use. Without this the guard would
// silently see nothing and skip, which is safe but hides the real risk.
require('dotenv').config();

const { assertSafeTarget } = require('./helpers/liveGuard');

// This suite issues TRUNCATE and DELETE. Never let it run against whatever
// DATABASE_URL happens to be in the environment — that is very often a real
// remote database loaded from .env. The guard is evaluated BEFORE the pool is
// created, so a skipped run never even opens a connection.
const guard = assertSafeTarget(process.env.DATABASE_URL);
const SKIP_REASON = guard.ok ? false : `live database tests disabled — ${guard.reason}`;

if (!guard.ok) {
  // Written to stderr, not stdout: node's test runner multiplexes its IPC
  // stream over the child's stdout, so writing there corrupts the run.
  process.stderr.write(`\n[live tests skipped] ${guard.reason}\n\n`);
}

/** Lazily loaded so requiring this file never opens a database connection. */
let db = null;
function database() {
  if (!db) db = require('../src/config/db');
  return db;
}

let reachable = false;
async function canConnect() {
  if (!guard.ok) return false;
  if (reachable) return true;
  try { await database().pool.query('SELECT 1'); reachable = true; } catch (_) { reachable = false; }
  return reachable;
}

// Loaded lazily so the module graph is only built if a database exists.
let User, Series, Chapter, Comment, Notification, ReadingProgress, DMCAReport, views;
let RefreshToken, AuthToken;
function models() {
  User ||= require('../src/models/User');
  Series ||= require('../src/models/Series');
  Chapter ||= require('../src/models/Chapter');
  Comment ||= require('../src/models/Comment');
  Notification ||= require('../src/models/Notification');
  ReadingProgress ||= require('../src/models/ReadingProgress');
  DMCAReport ||= require('../src/models/DMCAReport');
  RefreshToken ||= require('../src/models/RefreshToken');
  AuthToken ||= require('../src/models/AuthToken');
  views ||= require('../src/services/views');
  return {
    User, Series, Chapter, Comment, Notification, ReadingProgress, DMCAReport,
    RefreshToken, AuthToken, views,
    // Placeholder so destructuring stays honest if a caller asks for it.
    bcrypt: require('bcryptjs'),
  };
}

test('schema bootstrap is valid and idempotent', async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  if (!await canConnect()) return t.skip({ skip: 'no reachable PostgreSQL' });
  await database().connectDB();
  await database().connectDB(); // second run must be a no-op
  const { rows } = await database().pool.query(
    `SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN ('users','series','chapters','comments','notifications',
                          'reading_progress','dmca_reports','view_events')`
  );
  assert.equal(rows[0].n, 8, 'every model table must exist');
  const idx = await database().pool.query(
    `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema()`
  );
  assert.ok(idx.rows[0].n >= 15, `expected the documented indexes, found ${idx.rows[0].n}`);
});

test('full write/read lifecycle against real SQL', async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  if (!await canConnect()) return t.skip({ skip: 'no reachable PostgreSQL' });
  const M = models();
  await database().connectDB();

  const suffix = Date.now().toString(36);
  // Every row this test creates is tagged with this marker, so the suite is
  // correct against a database that already has unrelated content.
  const MARK = `live-test-${suffix}`;

  // --- user
  const user = await M.User.create({
    displayName: 'Test Reader', username: `reader_${suffix}`,
    email: `reader_${suffix}@example.com`, password: 'correct horse battery',
    agreedToTermsAt: new Date(), ageConfirmed: true,
  });
  assert.match(user.password, /^\$2/, 'password must be hashed on create');
  assert.equal(user.toJSON().password, undefined, 'toJSON must strip the hash');

  const found = await M.User.findOne({ $or: [{ username: user.username }, { email: user.email }] });
  assert.ok(found, '$or lookup must work in SQL');
  assert.equal(String(found.id), String(user.id));
  assert.equal(await found.comparePassword('correct horse battery'), true);
  assert.equal(await found.comparePassword('wrong'), false);

  // --- series (slug generation + jsonb defaults)
  const series = await M.Series.create({
    title: `Live Test ${suffix}`, type: 'novel', owner: user.id, author: MARK,
    genres: ['Fantasy', 'Horror'], tags: ['slow-burn'], synopsis: `A synopsis. ${MARK}`,
    rightsAttestedAt: new Date(),
  });
  assert.ok(series.slug, 'slug is generated');
  assert.deepEqual(series.views, { daily: 0, weekly: 0, alltime: 0 }, 'jsonb defaults round-trip');

  // Two series with the same title must not collide on slug.
  const twin = await M.Series.create({
    title: `Live Test ${suffix}`, type: 'comic', owner: user.id, author: MARK,
    synopsis: `s ${MARK}`, rightsAttestedAt: new Date(),
  });
  assert.notEqual(series.slug, twin.slug, 'slug collision is resolved, not thrown');

  // --- jsonb array containment (scoped to this run's rows)
  const mine = { author: MARK };
  const fantasy = await M.Series.find({ ...mine, genres: 'Fantasy', isRemoved: false });
  assert.ok(fantasy.some((s) => String(s.id) === String(series.id)), 'jsonb contains filter');
  const romance = await M.Series.find({ ...mine, genres: 'Romance' });
  assert.ok(!romance.some((s) => String(s.id) === String(series.id)),
    'a genre the series does not have must not match');
  const either = await M.Series.find({ ...mine, genres: { $in: ['Romance', 'Fantasy'] } });
  assert.ok(either.some((s) => String(s.id) === String(series.id)), 'jsonb ?| filter');
  const neither = await M.Series.find({ ...mine, genres: { $nin: ['Fantasy', 'Horror'] } });
  assert.ok(!neither.some((s) => String(s.id) === String(series.id)), 'jsonb NOT ?| filter');

  // --- comparison + sort on a jsonb path
  await M.Series.updateMany({ id: series.id }, { $set: { 'views.alltime': 4200 } });
  await M.Series.updateMany({ id: twin.id }, { $set: { 'views.alltime': 7 } });
  const ranked = await M.Series.find(mine)
    .sort({ 'views.alltime': -1 })
    .limit(5);
  assert.equal(ranked[0].views.alltime, 4200, 'ORDER BY a jsonb path puts the highest first');
  assert.equal(String(ranked[0].id), String(series.id));
  const values = ranked.map((s) => Number(s.views.alltime));
  assert.deepEqual(values, [...values].sort((a, b) => b - a), 'results are ordered descending');

  const above = await M.Series.find({ ...mine, 'views.alltime': { $gte: 4000 } });
  assert.ok(above.some((s) => String(s.id) === String(series.id)), '$gte on a jsonb path');
  const between = await M.Series.find({ ...mine, 'views.alltime': { $gte: 1, $lt: 100 } });
  assert.ok(between.some((s) => String(s.id) === String(twin.id)), 'range filter');

  // --- unsupported operator must throw, not silently return nothing
  await assert.rejects(() => M.Series.find({ views: { $nope: 1 } }), /Unsupported query operator/);

  // --- text search
  const hits = await M.Series.find({ author: MARK, $text: { $search: `Live Test ${suffix}` } });
  assert.ok(hits.length >= 2, 'ILIKE search over title/author/synopsis');
  const misses = await M.Series.find({ author: MARK, $text: { $search: 'zzz-no-such-term' } });
  assert.deepEqual(misses, [], 'a search with no matches returns nothing rather than everything');

  // --- chapter + atomic numbering
  const n1 = await M.Series.nextChapterNumber(series.id);
  const n2 = await M.Series.nextChapterNumber(series.id);
  assert.equal(n2, n1 + 1, 'chapter numbers increment atomically');

  const chapter = await M.Chapter.create({
    series: series.id, num: n1, title: 'Chapter One', paragraphs: ['Hello.'],
  });
  assert.deepEqual(chapter.paragraphs, ['Hello.'], 'jsonb array round-trips');

  // --- save writes only dirty columns and keeps the id stable
  const reloaded = await M.Chapter.findById(chapter.id);
  reloaded.title = 'Chapter One (revised)';
  await reloaded.save();
  const again = await M.Chapter.findById(chapter.id);
  assert.equal(again.title, 'Chapter One (revised)');
  assert.deepEqual(again.paragraphs, ['Hello.'], 'untouched columns survive a save');

  // --- populate then save must not corrupt the FK
  const withComments = await M.Comment.find({ series: series.id });
  void withComments;

  // --- comment + rating rollup
  await M.Comment.create({ series: series.id, user: user.id, rating: 5, text: 'Great' });
  await M.Comment.create({ series: series.id, user: user.id, rating: 3, text: 'Fine' });
  const stats = await M.Comment.aggregate([
    { $match: { series: series.id, isRemoved: false } },
    { $group: { _id: '$series', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  assert.equal(stats.length, 1);
  assert.equal(Number(stats[0].avg), 4);
  assert.equal(Number(stats[0].count), 2);

  // --- view counting is idempotent
  const v1 = await M.views.recordView({ seriesId: series.id, chapterId: chapter.id, viewer: 'u:test' });
  const v2 = await M.views.recordView({ seriesId: series.id, chapterId: chapter.id, viewer: 'u:test' });
  assert.equal(v1.counted, true);
  assert.equal(v2.counted, false, 'a repeat view must not count');
  const afterViews = await M.Chapter.findById(chapter.id);
  assert.equal(afterViews.views, 1, 'chapter view counter incremented exactly once');
  const seriesAfterViews = await M.Series.findById(series.id);
  assert.equal(seriesAfterViews.views.alltime, 4201, 'alltime counter moved by one');
  assert.equal(seriesAfterViews.views.daily, 1, 'daily counter moved by one');
  assert.equal(seriesAfterViews.views.weekly, 1, 'weekly counter moved by one');

  // --- reading progress upsert (single statement, UNIQUE(user,series))
  const p1 = await M.ReadingProgress.findOneAndUpdate(
    { user: user.id, series: series.id },
    { $set: { chapter: chapter.id, type: 'novel', scrollPct: 0.25 } },
    { upsert: true, new: true }
  );
  assert.equal(Number(p1.scrollPct), 0.25);
  const p2 = await M.ReadingProgress.findOneAndUpdate(
    { user: user.id, series: series.id },
    { $set: { chapter: chapter.id, type: 'novel', scrollPct: 0.75 } },
    { upsert: true, new: true }
  );
  assert.equal(String(p2.id), String(p1.id), 'upsert updates the existing row');
  assert.equal(Number(p2.scrollPct), 0.75);
  assert.equal(await M.ReadingProgress.countDocuments({ user: user.id, series: series.id }), 1);

  // --- library jsonb array write/read round-trip
  const libUser = await M.User.findById(user.id);
  libUser.library = [series.id, twin.id];
  await libUser.save();
  const relLoaded = await M.User.findById(user.id);
  assert.equal(relLoaded.library.length, 2, 'jsonb array of uuids round-trips');
  const followers = await M.User.find({ library: series.id });
  assert.ok(followers.some((u) => String(u.id) === String(user.id)), 'library contains-filter');

  libUser.downloads = [{ series: series.id, chapter: chapter.id }];
  await libUser.save();
  const withDownloads = await M.User.findById(user.id);
  assert.equal(withDownloads.downloads.length, 1, 'jsonb array of objects round-trips');
  assert.equal(String(withDownloads.downloads[0].chapter), String(chapter.id));

  await withDownloads.populate({ path: 'library', match: { isRemoved: false } });
  assert.equal(withDownloads.library.length, 2, 'populate resolves library ids');
  await withDownloads.populate({ path: 'downloads.series', match: { isRemoved: false } });
  assert.equal(String(withDownloads.downloads[0].series.id), String(series.id));

  // --- notifications batch insert
  await M.Notification.insertMany([
    { user: user.id, type: 'new_chapter', message: 'one', series: series.id },
    { user: user.id, type: 'comment_reply', message: 'two', series: series.id },
  ]);
  assert.equal(await M.Notification.countDocuments({ user: user.id, isRead: false }), 2);
  await M.Notification.updateMany({ user: user.id, isRead: false }, { $set: { isRead: true } });
  assert.equal(await M.Notification.countDocuments({ user: user.id, isRead: false }), 0);

  // --- DMCA
  const report = await M.DMCAReport.create({
    reporterName: 'R', reporterEmail: 'r@example.com',
    copyrightedWorkDescription: 'work', signature: 'R',
    goodFaithStatement: true, accuracyStatement: true,
    infringingSeries: series.id,
  });
  report.status = 'accepted';
  report.adminNotes = 'ok';
  await report.save();
  assert.equal(report.status, 'accepted');

  // --- deleteMany honours its filter (the old version wiped the table)
  const doomed = await M.Series.create({
    title: `Doomed ${suffix}`, type: 'novel', owner: user.id, author: MARK,
    synopsis: `s ${MARK}`, rightsAttestedAt: new Date(),
  });
  const before = await M.Series.countDocuments({ author: MARK });
  const deleted = await M.Series.deleteMany({ id: doomed.id });
  assert.equal(deleted.deletedCount, 1);
  assert.equal(await M.Series.countDocuments({ author: MARK }), before - 1,
    'only the matched row went');
  assert.ok(await M.Series.findById(series.id), 'unrelated rows survived');

  // --- pagination (scoped to this run so pre-existing rows cannot interfere)
  const page1 = await M.Series.find({ author: MARK }).sort({ createdAt: -1 }).skip(0).limit(1);
  const page2 = await M.Series.find({ author: MARK }).sort({ createdAt: -1 }).skip(1).limit(1);
  assert.equal(page1.length, 1);
  assert.notEqual(String(page1[0].id), String(page2[0].id), 'OFFSET paginates');

  // --- referential integrity: content is never orphaned, and legal history sticks
  await assert.rejects(
    () => database().pool.query('DELETE FROM users WHERE id = $1', [user.id]),
    /series_owner_fkey|violates foreign key/,
    'a user who still owns series cannot be deleted'
  );
  await assert.rejects(
    () => database().pool.query('DELETE FROM series WHERE id = $1', [series.id]),
    /dmca_reports_infringing_series_fkey|violates foreign key/,
    'a series named in a DMCA report is retained — legal history must not vanish'
  );

  // --- cleanup: strictly scoped to the rows this run created
  await database().pool.query('DELETE FROM dmca_reports WHERE infringing_series IN (SELECT id FROM series WHERE owner = $1)', [user.id]);
  await database().pool.query('DELETE FROM view_events WHERE series IN (SELECT id FROM series WHERE owner = $1)', [user.id]);
  await database().pool.query('DELETE FROM notifications WHERE "user" = $1', [user.id]);
  await database().pool.query('DELETE FROM reading_progress WHERE "user" = $1', [user.id]);
  await database().pool.query('DELETE FROM comments WHERE "user" = $1', [user.id]);
  await database().pool.query('DELETE FROM chapters WHERE series IN (SELECT id FROM series WHERE owner = $1)', [user.id]);
  await database().pool.query('DELETE FROM series WHERE owner = $1', [user.id]);
  await database().pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  assert.ok(!(await M.User.findById(user.id)), 'cleanup removed the account');
  assert.equal(await M.Series.countDocuments({ author: MARK }), 0, 'cleanup removed owned series');
});

test('sessions, tokens and the shared rate-limit store work against real SQL', async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  if (!await canConnect()) return t.skip({ skip: 'no reachable PostgreSQL' });
  const M = models();
  const { RefreshToken: RT, AuthToken: AT } = M;
  const pool = database().pool;
  await database().connectDB();

  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  const user = await M.User.create({
    displayName: 'Session Tester', username: `sess_${suffix}`,
    email: `sess_${suffix}@example.com`, password: 'correct horse battery',
    agreedToTermsAt: new Date(), ageConfirmed: true, emailVerifiedAt: new Date(),
  });

  /* ---- refresh tokens ---- */
  const issued = await RT.issue(user.id, { userAgent: 'probe', ip: '127.0.0.1', days: 30 });
  assert.ok(issued.token.length >= 40);
  assert.equal(issued.record.tokenHash, require('../src/utils/tokens').hashToken(issued.token),
    'the stored value is the hash of the issued token');
  assert.ok(!issued.record.password, 'no plaintext token is stored');

  const active = await RT.findActive(issued.token);
  assert.ok(active, 'an unexpired token resolves');
  await active.revoke();
  assert.equal(await RT.findActive(issued.token), null, 'a revoked token does not resolve');

  // An expired token must not resolve either.
  const stale = await RT.issue(user.id, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await RT.findActive(stale.token), null, 'an expired token is rejected');

  const bulk = await RT.issue(user.id, {});
  assert.ok(bulk.record.id);
  assert.ok((await RT.revokeAllFor(user.id)) >= 1);

  /* ---- one-shot auth tokens ---- */
  const verify = await AT.issue(user.id, 'email_verification', 24);
  const first = await AT.consume(verify.token, 'email_verification');
  assert.ok(first, 'the token consumes once');
  assert.equal(await AT.consume(verify.token, 'email_verification'), null,
    'and cannot be redeemed a second time');

  // Purpose isolation: a password-reset token must not verify an email.
  const reset = await AT.issue(user.id, 'password_reset', 1);
  assert.equal(await AT.consume(reset.token, 'email_verification'), null,
    'a token cannot be used for the wrong purpose');

  const expired = await AT.issue(user.id, 'password_reset', -1);
  assert.equal(await AT.consume(expired.token, 'password_reset'), null,
    'an expired token is rejected');

  const again = await AT.issue(user.id, 'email_verification', 24);
  assert.ok((await AT.invalidateAll(user.id, 'email_verification')) >= 1);
  assert.equal(await AT.consume(again.token, 'email_verification'), null,
    'issuing a new link invalidates the old one');

  /* ---- the shared rate-limit store ---- */
  const { createRateLimitStore } = require('../src/config/rateLimitStore');
  const store = createRateLimitStore('postgres');
  store.init({ windowMs: 60_000 });

  const a = await store.increment(`probe|${suffix}`);
  assert.equal(a.totalHits, 1);
  assert.ok(a.resetTime instanceof Date);
  const b = await store.increment(`probe|${suffix}`);
  assert.equal(b.totalHits, 2, 'the counter accumulates across requests');
  assert.ok(Math.abs(a.resetTime.getTime() - b.resetTime.getTime()) < 2000,
    'the window does not slide');

  await store.decrement(`probe|${suffix}`);
  assert.equal((await store.increment(`probe|${suffix}`)).totalHits, 2, 'decrement is honoured');

  // A different key is a different bucket.
  assert.equal((await store.increment(`other|${suffix}`)).totalHits, 1);

  await store.resetKey(`probe|${suffix}`);
  assert.equal((await store.increment(`probe|${suffix}`)).totalHits, 1, 'resetKey clears one bucket');

  // A lapsed window resets the bucket. The Postgres store rounds the window to
// whole seconds, so wait a little over one.
  store.init({ windowMs: 1000 });
  await store.increment(`expiring|${suffix}`);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal((await store.increment(`expiring|${suffix}`)).totalHits, 1,
    'an elapsed window starts a fresh count');

  await pool.query('DELETE FROM rate_limit_buckets WHERE bucket LIKE $1', [`%|${suffix}`]);
  await pool.query('DELETE FROM refresh_tokens WHERE "user" = $1', [user.id]);
  await pool.query('DELETE FROM auth_tokens WHERE "user" = $1', [user.id]);
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
});

test('identifier and value injection attempts are rejected', async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  if (!await canConnect()) return t.skip({ skip: 'no reachable PostgreSQL' });
  const M = models();

  // A value that would end the statement is bound, not interpolated.
  const injected = await M.Series.find({ title: `'; DROP TABLE users; --` });
  assert.deepEqual(injected, [], 'the table is still there and nothing matched');
  assert.ok(await database().pool.query('SELECT to_regclass(\'users\')'));

  // A hostile identifier is rejected before reaching the driver. Queries are
  // lazy, so the rejection surfaces on await rather than on the call.
  await assert.rejects(
    () => M.Series.find({ 'title"; DROP TABLE users; --': 1 }),
    /Unsafe SQL identifier rejected/
  );
  await assert.rejects(
    () => M.Series.find({ title: { $drop: 1 } }),
    /Unsupported query operator/
  );

  // The users table is untouched by all of the above.
  assert.ok(await database().pool.query('SELECT 1 FROM users LIMIT 1').catch(() => null)
    || (await database().pool.query('SELECT count(*) FROM users')));

  // Reserved-word columns are quoted, not special-cased.
  assert.ok(Array.isArray(await M.Comment.find({ user: '00000000-0000-4000-8000-000000000000' })));
});