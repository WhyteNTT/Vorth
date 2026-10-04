'use strict';

/**
 * The mailer, which nothing else exercises.
 *
 * Password reset and email verification both depend on it, and both swallow
 * their send in a try/catch so that an outage cannot break the request. That is
 * the right behaviour and it has an uncomfortable consequence: if the mailer
 * silently does nothing, no test anywhere fails, no request errors, and the only
 * symptom is that nobody can sign in. Every route that mails is green either way.
 *
 * So the transport selection itself is the thing under test - in particular that
 * selecting SMTP without the optional dependency fails loudly, which is the
 * difference between "reset is broken" and "nobody knows reset is broken".
 */

process.env.MAIL_TRANSPORT = 'console';
process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.JWT_SECRET ||= 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const mailer = require('../src/services/mailer');
const env = require('../src/config/env');

const MESSAGE = {
  to: 'reader@example.com',
  subject: 'Reset your Vorth password',
  text: 'Hi Alice,\n\nUse the link below.\n\nhttps://vorth.example/reset?token=abc\n',
};

/** Runs `fn` with a chosen transport and env, restoring whatever was there. */
async function withEnv(overrides, fn) {
  const real = {};
  for (const [k, v] of Object.entries(overrides)) {
    real[k] = env[k];
    env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(real)) env[k] = v;
  }
}

/** Captures everything written to stdout for the duration of `fn`. */
async function captureStdout(fn) {
  const chunks = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    const result = await fn();
    return { result, output: chunks.join('') };
  } finally {
    process.stdout.write = real;
  }
}

/** Makes `require('nodemailer')` resolve to `fake` for the duration of `fn`. */
async function withNodemailer(fake, fn) {
  const realLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'nodemailer') {
      if (fake === null) {
        const err = new Error("Cannot find module 'nodemailer'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return fake;
    }
    return realLoad.call(this, request, ...rest);
  };
  try {
    return await fn();
  } finally {
    Module._load = realLoad;
  }
}

/* ------------------------------------------------------------------ *
 * Fail fast
 * ------------------------------------------------------------------ */

test('send refuses to run without a recipient', async () => {
  // Silently doing nothing here would mean a verification link is issued, the
  // caller is told it is on its way, and no mail exists.
  for (const bad of [undefined, null, {}, { subject: 'x' }, { to: '' }]) {
    await assert.rejects(
      () => mailer.send(bad),
      /recipient/,
      `send(${JSON.stringify(bad)}) did not refuse a message with no recipient`
    );
  }
});

/* ------------------------------------------------------------------ *
 * disabled
 * ------------------------------------------------------------------ */

test('the disabled transport warns exactly once, not once per message', async () => {
  /*
   * `warned` is module-level state, so this test depends on running before any
   * other disabled send in the file - which it does, by declaration order.
   * The failure it guards against is log spam: a busy site with reset disabled
   * would otherwise print a warning per request.
   */
  await withEnv({ mailTransport: 'disabled' }, async () => {
    const { output } = await captureStdout(async () => {
      for (let i = 0; i < 5; i += 1) await mailer.send(MESSAGE);
    });
    const warnings = output.match(/not being sent/g) || [];
    assert.equal(warnings.length, 1,
      `the disabled transport warned ${warnings.length} times for five messages`);
  });
});

test('the disabled transport reports that nothing was sent', async () => {
  await withEnv({ mailTransport: 'disabled' }, async () => {
    const { result } = await captureStdout(async () => mailer.send(MESSAGE));
    assert.deepEqual(result, { transport: 'disabled' });
  });
});

/* ------------------------------------------------------------------ *
 * console
 * ------------------------------------------------------------------ */

test('the console transport prints the message and claims nothing was sent', async () => {
  await withEnv({ mailTransport: 'console' }, async () => {
    const { result, output } = await captureStdout(async () => mailer.send(MESSAGE));

    assert.deepEqual(result, { transport: 'console' });
    assert.match(output, /email:reader@example\.com/);
    assert.match(output, /Reset your Vorth password/);
    assert.match(output, /https:\/\/vorth\.example\/reset\?token=abc/);
  });
});

test('the console transport collapses runs of blank lines', async () => {
  // Mail templates are built by joining an array with '\n', which leaves runs of
  // blank lines wherever an entry was empty. Uncollapsed, the preview is mostly
  // whitespace and the actual link is hard to find.
  await withEnv({ mailTransport: 'console' }, async () => {
    const { output } = await captureStdout(() => mailer.send({
      ...MESSAGE,
      text: 'Hi Alice,\n\n\n\n\nUse the link.\n\n\n\nThanks.\n',
    }));
    assert.doesNotMatch(output, /\n{3}/, 'three or more consecutive newlines survived');
    assert.match(output, /Hi Alice,\n\nUse the link\.\n\nThanks\./);
  });
});

/* ------------------------------------------------------------------ *
 * smtp
 * ------------------------------------------------------------------ */

test('selecting SMTP without nodemailer fails loudly and says how to fix it', async () => {
  /*
   * This is the failure the whole file exists for. nodemailer is an optional peer
   * dependency and is not installed. If SMTP is selected without it and we
   * degrade quietly, the site serves password reset that reaches nobody and
   * reports success at every layer above.
   */
  await withEnv({ mailTransport: 'smtp', smtpHost: 'smtp.example.com' }, async () => {
    await withNodemailer(null, async () => {
      await assert.rejects(() => mailer.send(MESSAGE), (err) => {
        assert.match(err.message, /nodemailer/);
        assert.match(err.message, /npm install nodemailer/,
          'the error does not say how to fix it');
        return true;
      });
    });
  });
});

test('SMTP without a host is refused rather than attempted', async () => {
  await withEnv({ mailTransport: 'smtp', smtpHost: '' }, async () => {
    await withNodemailer({ createTransport: () => ({ sendMail: async () => ({}) }) }, async () => {
      await assert.rejects(() => mailer.send(MESSAGE), /SMTP_HOST/);
    });
  });
});

test('an SMTP send reaches the transport with the right message', async () => {
  const sent = [];
  const fake = {
    createTransport(config) {
      sent.push({ config });
      return { sendMail: async (mail) => ({ sent: true, mail }) };
    },
  };

  await withEnv({
    mailTransport: 'smtp',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'postmaster',
    smtpPass: 'hunter2',
    mailFrom: 'Vorth <no-reply@vorth.example>',
  }, async () => {
    const result = await withNodemailer(fake, () => mailer.send(MESSAGE));

    assert.equal(sent.length, 1, 'the transport was not configured exactly once');
    const { config } = sent[0];
    assert.equal(config.host, 'smtp.example.com');
    assert.equal(config.port, 587);
    assert.equal(config.secure, false);
    assert.deepEqual(config.auth, { user: 'postmaster', pass: 'hunter2' });

    assert.equal(result.sent, true);
    assert.equal(result.mail.to, MESSAGE.to);
    assert.equal(result.mail.subject, MESSAGE.subject);
    assert.equal(result.mail.text, MESSAGE.text);
    assert.equal(result.mail.from, 'Vorth <no-reply@vorth.example>');
  });
});

test('an SMTP relay with no credentials is not given empty ones', async () => {
  // auth: {user: undefined, pass: undefined} makes nodemailer attempt AUTH and
  // fail, or send the password as the literal string "undefined".
  const configs = [];
  const fake = {
    createTransport(config) {
      configs.push(config);
      return { sendMail: async () => ({}) };
    },
  };

  await withEnv({
    mailTransport: 'smtp', smtpHost: 'localhost', smtpPort: 25,
    smtpUser: '', smtpPass: '', smtpSecure: false,
  }, async () => {
    await withNodemailer(fake, () => mailer.send(MESSAGE));
  });

  assert.equal(configs.length, 1);
  assert.equal(configs[0].auth, undefined,
    'empty credentials were passed as an auth object rather than omitted');
});

test('an unknown transport falls back to console rather than sending nothing', async () => {
  // Fail towards something visible. Silently dropping mail is the one outcome
  // nobody notices.
  await withEnv({ mailTransport: 'carrier-pigeon' }, async () => {
    const { result, output } = await captureStdout(async () => mailer.send(MESSAGE));
    assert.deepEqual(result, { transport: 'console' });
    assert.match(output, /Reset your Vorth password/);
  });
});

test('a rejection from the transport propagates to the caller', async () => {
  // The routes wrap this in try/catch and log, so a swallowed rejection here
  // would be the difference between a logged outage and a silent one.
  const fake = {
    createTransport: () => ({ sendMail: async () => { throw new Error('421 too many connections'); } }),
  };

  await withEnv({ mailTransport: 'smtp', smtpHost: 'smtp.example.com', smtpSecure: true }, async () => {
    await withNodemailer(fake, async () => {
      await assert.rejects(() => mailer.send(MESSAGE), /421 too many connections/);
    });
  });
});

/* ------------------------------------------------------------------ *
 * isRealDelivery and link
 * ------------------------------------------------------------------ */

test('only SMTP counts as real delivery', () => {
  /*
   * This is the flag a caller uses to decide whether to warn a user that a link
   * will never arrive. If it were true for console or disabled, a development
   * instance would let someone believe a password reset works.
   */
  for (const [transport, expected] of [
    ['smtp', true], ['console', false], ['disabled', false], ['', false],
  ]) {
    env.mailTransport = transport;
    assert.equal(mailer.isRealDelivery(), expected,
      `isRealDelivery() said otherwise for ${transport || '(unset)'}`);
  }
  env.mailTransport = 'console';
});

test('a link is absolute when PUBLIC_URL is known and relative when it is not', () => {
  env.publicUrl = 'https://vorth.example';
  assert.equal(mailer.link('/reset-password?token=a'), 'https://vorth.example/reset-password?token=a');

  env.publicUrl = '';
  // A relative link is unusable in an email client. Returning one silently ships
  // a mail whose button goes nowhere, so this asserts the fallback is visible.
  assert.equal(mailer.link('/reset-password?token=a'), '/reset-password?token=a');
  env.publicUrl = 'https://vorth.example';
});

test('the mailer exports the env it reads, not a copy', () => {
  // Tests and callers configure through this object; a snapshot would silently
  // stop responding to configuration changes.
  assert.equal(mailer.env, env);
});