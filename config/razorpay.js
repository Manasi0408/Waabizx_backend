/**
 * Razorpay credentials and payment amounts from backend/.env
 *
 * Required:
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 *
 * Optional:
 *   WHATSAPP_ONBOARDING_PAYMENT_AMOUNT  (INR, default 999)
 */

const Razorpay = require('razorpay');

const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim() || null;
const keySecret =
  String(process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET || '').trim() || null;

const whatsappOnboardingAmount = () => {
  const fromEnv = Number(process.env.WHATSAPP_ONBOARDING_PAYMENT_AMOUNT);
  return Number.isFinite(fromEnv) && fromEnv >= 100 ? fromEnv : 999;
};

let cachedInstance = null;

const getRazorpayInstance = () => {
  if (!keyId || !keySecret) return null;
  if (!cachedInstance) {
    cachedInstance = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return cachedInstance;
};

const isRazorpayConfigured = () => Boolean(keyId && keySecret);

module.exports = {
  keyId,
  keySecret,
  whatsappOnboardingAmount,
  getRazorpayInstance,
  isRazorpayConfigured,
};
