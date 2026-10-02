const env = require('../config/env');

/**
 * Outbound email.
 *
 * Deliberately transport-agnostic and dependency-free:
 *   - 'console'  logs the message (development default; never sends)
 *   - 'smtp'     sends via nodemailer if it is installed
 *   - 'disabled' logs a single warning and sends nothing
 *
 * If SMTP is selected but nodemailer is missing, the failure is loud rather
 * than silent — a site that thinks it sent password-reset mails but didn't is
 * worse than one that refuses to start.
 */

let warned = false;

async function sendViaSmtp(message) {
  let nodemailer;
  try {
    // Optional peer dependency: only loaded when SMTP is actually selected.
    nodemailer = require('nodemailer');
  } catch (_) {
    throw new Error(
      'MAIL_TRANSPORT=smtp requires the optional `nodemailer` dependency. '
      + 'Run: npm install nodemailer'
    );
  }

  if (!env.smtpHost) throw new Error('MAIL_TRANSPORT=smtp requires SMTP_HOST');

  const transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
  });

  return transporter.sendMail({
    from: env.mailFrom,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

function sendViaConsole(message) {
  const preview = message.text.replace(/\n{3,}/g, '\n\n');
  process.stdout.write(
    `\n[email:${message.to}] ${message.subject}\n${'-'.repeat(60)}\n${preview}\n${'-'.repeat(60)}\n\n`
  );
  return Promise.resolve({ transport: 'console' });
}

/**
 * @param {{to: string, subject: string, text: string, html?: string}} message
 * @returns {Promise<{transport: string}>}
 */
async function send(message) {
  if (!message || !message.to) throw new Error('send() requires a recipient');

  switch (env.mailTransport) {
    case 'smtp':
      return sendViaSmtp(message);
    case 'disabled':
      if (!warned) {
        process.stdout.write('[mail] MAIL_TRANSPORT=disabled — messages are not being sent.\n');
        warned = true;
      }
      return Promise.resolve({ transport: 'disabled' });
    case 'console':
    default:
      return sendViaConsole(message);
  }
}

function isRealDelivery() { return env.mailTransport === 'smtp'; }

/** Builds an absolute link, falling back to a relative path without PUBLIC_URL. */
function link(pathname) {
  return env.publicUrl ? `${env.publicUrl}${pathname}` : pathname;
}

module.exports = { send, isRealDelivery, link, env };