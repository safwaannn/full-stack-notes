/**
 * ============================================================================
 * sendEmail — one small wrapper around Nodemailer
 * ============================================================================
 *
 * WHAT NODEMAILER IS
 * ------------------
 * Node cannot send email by itself. Nodemailer speaks SMTP (Simple Mail
 * Transfer Protocol) — the same protocol Outlook or Gmail's servers use — and
 * hands your message to an email provider, which does the actual delivery.
 *
 * THE THREE STEPS (they never change)
 * -----------------------------------
 *   1. TRANSPORTER — the connection to the email service. "Who is going to
 *      deliver this for me, and what is my login there?"
 *   2. MAIL OPTIONS — the envelope and the letter: from, to, subject, body.
 *   3. sendMail()   — actually hand it over.
 *
 * WHY YOU SHOULD USE MAILTRAP IN DEVELOPMENT
 * ------------------------------------------
 * If you point this at real Gmail while testing, you will (a) spam real
 * inboxes, and (b) get your Gmail account flagged as suspicious very quickly —
 * Google allows only ~500/day and treats app traffic as risky. Mailtrap
 * (mailtrap.io) gives you a fake inbox: emails arrive in a web UI and are never
 * delivered to anyone. Perfect for testing password reset flows.
 *
 * Your config.env needs these four values (Mailtrap shows them on its
 * "SMTP Settings" page):
 *   EMAIL_HOST=sandbox.smtp.mailtrap.io
 *   EMAIL_PORT=2525
 *   EMAIL_USERNAME=<your mailtrap user>
 *   EMAIL_PASSWORD=<your mailtrap pass>
 *
 * ⚠️ NOTE ON THE FORGOT-PASSWORD ROUTE: if these credentials are wrong or
 * missing, `POST /forgotPassword` returns 500 "There was an error sending the
 * email". That is not a bug in your code — it means SMTP could not connect.
 * Check the terminal, the real reason is logged there.
 */
const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  // --- 1) THE TRANSPORTER --------------------------------------------------
  //
  // FIX: `process.env.EMAIL_PORT` is always a STRING ('2525'), because every
  // environment variable is a string. Nodemailer compares the port
  // numerically to decide whether to use implicit TLS, so a string can make it
  // pick the wrong connection mode and fail with a confusing timeout.
  // `* 1` converts it to a real number.
  const port = process.env.EMAIL_PORT * 1;

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port,
    // `secure: true` means "start the connection already encrypted" — that is
    // only correct on port 465. On 587 / 2525 the connection starts plain and
    // is upgraded to TLS afterwards (STARTTLS), so `secure` must be false.
    // Deriving it from the port removes a very common source of "connection
    // hangs forever" bugs.
    secure: port === 465,
    auth: {
      user: process.env.EMAIL_USERNAME,
      pass: process.env.EMAIL_PASSWORD,
    },
  });

  // --- 2) THE MAIL OPTIONS -------------------------------------------------
  const mailOptions = {
    // Real providers reject a `from` address on a domain you don't own. For
    // Mailtrap anything works. Moved into an env var so switching from a test
    // inbox to production doesn't require a code change.
    from: process.env.EMAIL_FROM || 'Safwan Ghare <hello@safwan.io>',
    to: options.email,
    subject: options.subject,
    text: options.message,
    // `html:` would be the rich version. Good practice is to send BOTH: `text`
    // for plain-text clients and spam filters, `html` for everyone else.
    html: options.html,
  };

  // --- 3) SEND -------------------------------------------------------------
  // We deliberately do NOT try/catch here. If sending fails we WANT the
  // rejection to bubble up, so the caller (authController.forgotPassword) can
  // clean up the reset token it just saved. Swallowing the error here would
  // leave a valid reset token in the database that nobody ever received.
  await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;
