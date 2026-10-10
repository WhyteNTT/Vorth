'use strict';

/**
 * The keep-warm endpoints, driven over HTTP.
 *
 * Two things here are not obvious from the heartbeat module alone:
 *
 *   - /api/keep-warm must be unauthenticated, because a Render cron job can only
 *     issue a plain GET. If this ever gains a guard, the real job stops recording
 *     and the site looks permanently unverified while appearing fine.
 *   - /api/keep-warm/status must be authenticated, and must refuse outright when
 *     no token is configured rather than falling open.
 *
 * The second is the one that matters most: an open status endpoint hands an
 * attacker a precise read on when the service was last touched.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakePool } = require('./helpers/fakePool');

const db = require('../src/config/db');
const env = require('../src/config/env');
const Base = require('../src/models/_base');

/**
 * Rows returned for the heartbeat upsert.
 *
 * Relative to now, not a fixed date. The endpoint reports the age of this stamp,
 * so a hardcoded one turns into a stale fixture the moment the calendar moves past
 * it - and it fails looking exactly like "the job stopped", which is the one
 * verdict this file is about.
 */
const PINGED_AT = new Date(Date.now() - 5000);

async function withServer(fake, fn) {
  Base._clearColumnCache();
  db.setPool(fake);
  const app = require('../src/app');
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const { port } = server.address();
  const call = async (path, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body, text };
  };
  try {
    return await fn({ call });
  } finally {
    await new Promise((r) => server.close(r));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

/** A pool that records every query, and answers the heartbeat upsert. */
function recordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/service_heartbeat/i.test(sql)) {
        if (/RETURNING/i.test(sql)) {
          return { rows: [{ last_ping_at: PINGED_AT, max_gap_seconds: 42 }], rowCount: 1 };
        }
        if (/max_gap_seconds FROM/i.test(sql)) return { rows: [{ max_gap_seconds: 42 }], rowCount: 1 };
        if (/last_ping_at FROM/i.test(sql)) return { rows: [{ last_ping_at: PINGED_AT }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

/* ================================================================== *
 * The ping: open by design
 * ================================================================== */

test('a plain GET to /api/keep-warm records a heartbeat', async () => {
  const fake = recordingPool();
  await withServer(fake, async ({ call }) => {
    const res = await call('/api/keep-warm');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, 'awake');

    const write = fake.queries.find((q) => /INSERT INTO service_heartbeat/i.test(q.sql));
    assert.ok(write, 'no heartbeat was written - the scheduled job would prove nothing');
    assert.equal(write.params[0], 'vorth-api');
    assert.equal(res.body.at, PINGED_AT.toISOString());
    // The largest gap is echoed, so one response reveals a lapse without a second call.
    assert.equal(res.body.maxGapSeconds, 42);
  });
});

test('the ping needs no token, because a Render cron job cannot send one', async () => {
  // This is the constraint the whole design turned on. A guard here would make the
  // real job silently useless.
  const fake = recordingPool();
  await withServer(fake, async ({ call }) => {
    const res = await call('/api/keep-warm', { 'X-Anything': 'ignored' });
    assert.equal(res.status, 200);
    assert.ok(fake.queries.some((q) => /INSERT INTO service_heartbeat/i.test(q.sql)));
  });
});

test('the ping still says awake when the heartbeat write fails', async () => {
  /*
   * The request arriving is what matters - it proves the instance was not asleep.
   * Returning 500 would make Render retry a job whose work is already done, and
   * would report the database as broken when only this one insert failed.
   */
  const fake = {
    async query(sql) {
      if (/service_heartbeat/i.test(String(sql))) throw new Error('deadlock');
      return { rows: [], rowCount: 0 };
    },
  };
  await withServer(fake, async ({ call }) => {
    const res = await call('/api/keep-warm');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'awake');
    assert.equal(res.body.recorded, false, 'it should admit the write did not happen');
  });
});

/* ================================================================== *
 * The status endpoint: closed by design
 * ================================================================== */

test('status is 401 without the token', async () => {
  const saved = env.keepWarmToken;
  env.keepWarmToken = 'the-secret';
  const fake = recordingPool();
  try {
    await withServer(fake, async ({ call }) => {
      for (const headers of [{}, { 'X-Keep-Warm-Token': 'wrong' }, { 'X-Keep-Warm-Token': 'the-secre' }]) {
        const res = await call('/api/keep-warm/status', headers);
        assert.equal(res.status, 401, `accepted ${JSON.stringify(headers)}`);
      }
      assert.equal(fake.queries.some((q) => /FROM service_heartbeat/i.test(q.sql)), false,
        'the heartbeat was read before the caller was authenticated');
    });
  } finally { env.keepWarmToken = saved; }
});

test('status answers for a caller that presents the token', async () => {
  const saved = env.keepWarmToken;
  env.keepWarmToken = 'the-secret';
  try {
    await withServer(recordingPool(), async ({ call }) => {
      const res = await call('/api/keep-warm/status', { 'X-Keep-Warm-Token': 'the-secret' });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.maxGapSeconds, 42);
      assert.equal(res.body.toleranceSeconds, 600);
    });
  } finally { env.keepWarmToken = saved; }
});

test('status refuses outright when no token is configured', async () => {
  /*
   * The important one. Falling open here would hand anyone a precise read on when
   * the service was last touched, which is exactly the reconnaissance an attacker
   * wants from a free-tier instance with known spin-down behaviour.
   */
  const saved = env.keepWarmToken;
  env.keepWarmToken = '';
  try {
    await withServer(recordingPool(), async ({ call }) => {
      const res = await call('/api/keep-warm/status');
      assert.equal(res.status, 503);
      assert.match(res.text, /KEEP_WARM_TOKEN/,
        'the refusal should say which variable to set - otherwise nobody knows what to do');
    });
  } finally { env.keepWarmToken = saved; }
});

test('status reports 503 when the job has lapsed, so a monitor can alert on it', async () => {
  /*
   * 503 rather than 200-with-ok:false. Most free uptime monitors alert on status
   * code alone, and a body they would have to parse is a body they will not.
   */
  const saved = env.keepWarmToken;
  env.keepWarmToken = 'the-secret';
  const fake = {
    async query(sql) {
      const s = String(sql);
      if (/max_gap_seconds FROM/i.test(s)) return { rows: [{ max_gap_seconds: 3600 }], rowCount: 1 };
      if (/last_ping_at FROM/i.test(s)) return { rows: [{ last_ping_at: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  try {
    await withServer(fake, async ({ call }) => {
      const res = await call('/api/keep-warm/status', { 'X-Keep-Warm-Token': 'the-secret' });
      assert.equal(res.status, 503, 'a monitor pointed here would not fire on a 200');
      assert.equal(res.body.success, false);
      assert.match(res.body.verdict, /lapsed at least once|may have stopped/i);
    });
  } finally { env.keepWarmToken = saved; }
});

test('status reports 503 when the heartbeat cannot be read', async () => {
  const saved = env.keepWarmToken;
  env.keepWarmToken = 'the-secret';
  const fake = {
    async query(sql) {
      if (/service_heartbeat/i.test(String(sql))) throw new Error('connection lost');
      return { rows: [], rowCount: 0 };
    },
  };
  try {
    await withServer(fake, async ({ call }) => {
      const res = await call('/api/keep-warm/status', { 'X-Keep-Warm-Token': 'the-secret' });
      assert.equal(res.status, 503, 'an unreadable heartbeat must not read as healthy');
    });
  } finally { env.keepWarmToken = saved; }
});

/* ================================================================== *
 * It stays out of the way
 * ================================================================== */

test('/api/health is unchanged and records nothing', async () => {
  /*
   * /api/health is polled by Render's own health check and by uptime monitors.
   * If it recorded heartbeats, those would look exactly like the scheduled job and
   * the check would never notice the job had stopped.
   */
  const fake = recordingPool();
  await withServer(fake, async ({ call }) => {
    const res = await call('/api/health');
    assert.equal(res.status, 200);
    assert.equal(fake.queries.some((q) => /service_heartbeat/i.test(q.sql)), false,
      'an ordinary health poll must not record a heartbeat');
    // Still exactly the documented keys - this endpoint is public.
    assert.deepEqual(Object.keys(res.body).sort(),
      ['database', 'status', 'success', 'time']);
  });
});

test('the keep-warm table is not something the models pretend to own', () => {
  // It is written by a raw query on purpose: it has no model, no columns to
  // hydrate, and nothing in the app reads a row. Asserted because a stray model
  // for it would make the drift check think the table is a modelled one.
  const fs = require('node:fs');
  const path = require('node:path');
  const models = path.join(__dirname, '..', 'src', 'models');
  for (const f of fs.readdirSync(models)) {
    const text = fs.readFileSync(path.join(models, f), 'utf8');
    assert.doesNotMatch(text, /service_heartbeat/,
      `${f} references service_heartbeat; it is meant to be a raw table`);
  }
});

test('the fake pool still answers health checks used elsewhere', async () => {
  // Guards the helper above: if createFakePool were used here it would not
  // recognise the heartbeat SQL, and the endpoint would silently stop recording.
  const fake = createFakePool({ rows: {} });
  await withServer(fake, async ({ call }) => {
    const res = await call('/api/health');
    assert.equal(res.status, 200, 'the generic fake pool cannot answer /api/health');
  });
});