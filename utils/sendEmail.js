const nodemailer = require('nodemailer');

const isSmtpConfigured = () =>
  Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.SMTP_FROM
  );

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const sendOTPEmail = async (to, otp, purpose = 'registration') => {
  if (!isSmtpConfigured()) {
    throw new Error('Email transport is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM in .env');
  }

  const isPasswordReset = purpose === 'password_reset';
  const subject = isPasswordReset ? 'Your password reset OTP' : 'Your OTP Code';
  const title = isPasswordReset ? 'Waabizx Password Reset' : 'Waabizx Email Verification';
  const textLine = isPasswordReset
    ? `Your Waabizx password reset code is ${otp}. It is valid for 10 minutes. Do not share this code.`
    : `Your Waabizx registration code is ${otp}. It is valid for 10 minutes. Do not share this code.`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text: textLine,
    html: `
      <h2>${title}</h2>
      <p>Your OTP is:</p>
      <h1>${otp}</h1>
      <p>This code expires in 10 minutes.</p>
    `,
  });
};

module.exports = sendOTPEmail;
