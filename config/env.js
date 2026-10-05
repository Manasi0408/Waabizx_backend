// Production env for WhatsApp SaaS / Meta onboarding
module.exports = {
  PORT: process.env.PORT || 3002,
  APP_ID: process.env.APP_ID || process.env.META_APP_ID,
  APP_SECRET: process.env.APP_SECRET || process.env.META_APP_SECRET || process.env.META_APPSECRET,
  REDIRECT_URI: process.env.REDIRECT_URI || process.env.META_REDIRECT_URI,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || process.env.Verify_Token,
  META_CONFIG_ID: process.env.META_CONFIG_ID || '1616537092881932',
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET,
  WHATSAPP_ONBOARDING_PAYMENT_AMOUNT: Number(process.env.WHATSAPP_ONBOARDING_PAYMENT_AMOUNT) || 999,
};
