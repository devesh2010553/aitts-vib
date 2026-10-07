/**
 * AIITS Email Utility
 * Uses multiple fallback methods to guarantee delivery:
 * 1. Brevo (Sendinblue) SMTP - 300 free emails/day, port 587, works on Render
 * 2. Gmail with explicit port 587 + TLS (not 465 which Render blocks)
 * 3. Resend.com HTTP API - no SMTP port needed at all
 *
 * SET IN RENDER ENVIRONMENT:
 * Option A (Recommended - Brevo):
 *   EMAIL_PROVIDER=brevo
 *   BREVO_USER=your@email.com      (your Brevo login email)
 *   BREVO_PASS=your-smtp-key       (from Brevo dashboard > SMTP & API > SMTP Keys)
 *
 * Option B (Gmail port 587):
 *   EMAIL_PROVIDER=gmail
 *   EMAIL_USER=your@gmail.com
 *   EMAIL_PASS=xxxx xxxx xxxx xxxx  (Gmail App Password - 16 chars)
 *
 * Option C (Resend HTTP API - best, no ports):
 *   EMAIL_PROVIDER=resend
 *   RESEND_API_KEY=re_xxxxxxxxxxxx  (from resend.com dashboard)
 *   EMAIL_FROM=noreply@yourdomain.com  (must verify domain on Resend)
 */

const nodemailer = require('nodemailer');

function buildHtml(name, otp, expiry) {
  return '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #e0d0a0;border-radius:12px;overflow:hidden">' +
    '<div style="background:linear-gradient(135deg,#b8860b,#e6c200);padding:20px 24px;text-align:center">' +
    '<h1 style="margin:0;color:#0a0a1a;font-size:22px;font-weight:900;letter-spacing:3px">AIITS</h1>' +
    '<p style="margin:4px 0 0;color:rgba(0,0,0,0.65);font-size:11px">ALL INDIA TOPICWISE TEST SERIES &bull; MS Chauhan &bull; Vibrant Academy</p>' +
    '</div>' +
    '<div style="background:#fff;padding:32px 24px">' +
    '<h2 style="color:#b8860b;margin:0 0 10px;font-size:18px">Hello, ' + name + '!</h2>' +
    '<p style="color:#555;margin:0 0 20px;font-size:14px;line-height:1.6">Use this OTP to reset your AIITS password. It expires in <strong>' + expiry + ' minutes</strong>.</p>' +
    '<div style="font-size:38px;font-weight:900;color:#b8860b;letter-spacing:14px;text-align:center;padding:20px;background:#fffbee;border-radius:10px;margin-bottom:20px;border:2px dashed #d4a017;word-break:break-all">' + otp + '</div>' +
    '<p style="color:#999;font-size:12px;margin:0;border-top:1px solid #f0e8d0;padding-top:16px">If you did not request this, ignore this email. Never share your OTP with anyone.</p>' +
    '</div>' +
    '<div style="background:#fafaf8;padding:12px 24px;text-align:center;border-top:1px solid #e0d0a0">' +
    '<p style="color:#aaa;font-size:11px;margin:0">&copy; 2026 AIITS by MS Chauhan | HOD, Vibrant Academy</p>' +
    '</div></div>';
}

function buildText(name, otp, expiry) {
  return 'Hello ' + name + ',\n\nYour AIITS OTP is: ' + otp + '\n\nExpires in ' + expiry + ' minutes.\nDo not share this with anyone.\n\n- AIITS by MS Chauhan, Vibrant Academy';
}

// METHOD 1: Brevo (Sendinblue) SMTP - most reliable on Render
async function sendViaBrevo(to, otp, name, expiry) {
  const user = process.env.BREVO_USER || process.env.EMAIL_USER;
  const pass = process.env.BREVO_PASS;
  if (!user || !pass) throw new Error('BREVO_USER and BREVO_PASS not set');

  const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: { user, pass },
    connectionTimeout: 15000,
    greetingTimeout:   10000,
    socketTimeout:     20000
  });

  const info = await transporter.sendMail({
    from: '"AIITS Vibrant Academy" <' + user + '>',
    to,
    subject: 'AIITS Password Reset OTP',
    text: buildText(name, otp, expiry),
    html: buildHtml(name, otp, expiry)
  });
  console.log('[EMAIL:Brevo] Sent to', to, '| ID:', info.messageId);
  return info;
}

// METHOD 2: Gmail with port 587 STARTTLS (not 465 which Render blocks)
async function sendViaGmail(to, otp, name, expiry) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) throw new Error('EMAIL_USER and EMAIL_PASS not set');

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,          // Use STARTTLS (not SSL) — port 587
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 20000,
    greetingTimeout:   15000,
    socketTimeout:     30000
  });

  const info = await transporter.sendMail({
    from: '"AIITS Vibrant Academy" <' + user + '>',
    to,
    subject: 'AIITS Password Reset OTP',
    text: buildText(name, otp, expiry),
    html: buildHtml(name, otp, expiry)
  });
  console.log('[EMAIL:Gmail] Sent to', to, '| ID:', info.messageId);
  return info;
}

// METHOD 3: Resend HTTP API (no SMTP ports at all - always works)
async function sendViaResend(to, otp, name, expiry) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  const fromEmail = process.env.EMAIL_FROM || 'noreply@aiits.in';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'AIITS Vibrant Academy <' + fromEmail + '>',
      to: [to],
      subject: 'AIITS Password Reset OTP',
      text: buildText(name, otp, expiry),
      html: buildHtml(name, otp, expiry)
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error('Resend error: ' + (data.message || JSON.stringify(data)));
  console.log('[EMAIL:Resend] Sent to', to, '| ID:', data.id);
  return data;
}

// MAIN EXPORT: tries providers in order, falls back automatically
exports.sendOTPEmail = async (to, otp, name) => {
  const expiry  = parseInt(process.env.OTP_EXPIRY) || 10;
  const provider = (process.env.EMAIL_PROVIDER || 'auto').toLowerCase();

  const errors = [];

  // Try specified provider first
  if (provider === 'brevo' || provider === 'auto') {
    if (process.env.BREVO_PASS || (provider === 'brevo')) {
      try { return await sendViaBrevo(to, otp, name, expiry); }
      catch (e) { errors.push('Brevo: ' + e.message); console.error('[EMAIL] Brevo failed:', e.message); }
    }
  }

  if (provider === 'resend' || provider === 'auto') {
    if (process.env.RESEND_API_KEY || (provider === 'resend')) {
      try { return await sendViaResend(to, otp, name, expiry); }
      catch (e) { errors.push('Resend: ' + e.message); console.error('[EMAIL] Resend failed:', e.message); }
    }
  }

  if (provider === 'gmail' || provider === 'auto') {
    if (process.env.EMAIL_USER || (provider === 'gmail')) {
      try { return await sendViaGmail(to, otp, name, expiry); }
      catch (e) { errors.push('Gmail: ' + e.message); console.error('[EMAIL] Gmail failed:', e.message); }
    }
  }

  // All failed
  throw new Error(
    'All email methods failed. Errors: ' + errors.join(' | ') +
    '\n\nFix: Go to Render dashboard > Environment and set one of:\n' +
    '  Option A (Brevo - recommended): BREVO_USER + BREVO_PASS\n' +
    '  Option B (Resend): RESEND_API_KEY\n' +
    '  Option C (Gmail): EMAIL_USER + EMAIL_PASS (App Password)'
  );
};

exports.generateOTP = () => String(Math.floor(100000 + Math.random() * 900000));
