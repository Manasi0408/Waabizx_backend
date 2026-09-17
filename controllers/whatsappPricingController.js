const {
  listAdminWhatsappPricing,
  saveAdminWhatsappPricing,
} = require('../services/wccCountryPricingService');
const {
  getMessageCost,
  saveExchangeRates,
  listExchangeRates,
} = require('../services/whatsappPricingService');
const { getWalletCurrencyForOwner } = require('../services/wccCountryPricingService');

exports.getAdminWhatsappPricing = async (req, res) => {
  try {
    const payload = await listAdminWhatsappPricing();
    return res.json({
      success: true,
      ...payload,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load country WCC pricing',
      error: error.message,
    });
  }
};

exports.updateAdminWhatsappPricing = async (req, res) => {
  try {
    const body = req.body || {};
    if (Array.isArray(body.exchangeRates) && body.exchangeRates.length) {
      await saveExchangeRates(body.exchangeRates);
    }
    const payload = await saveAdminWhatsappPricing(body);
    return res.json({
      success: true,
      message: 'Country WCC pricing updated',
      ...payload,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to update country WCC pricing',
    });
  }
};

exports.getAdminExchangeRates = async (req, res) => {
  try {
    const exchangeRates = await listExchangeRates();
    return res.json({ success: true, exchangeRates });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load exchange rates',
    });
  }
};

exports.updateAdminExchangeRates = async (req, res) => {
  try {
    const exchangeRates = await saveExchangeRates(req.body?.exchangeRates || req.body?.rates || []);
    return res.json({
      success: true,
      message: 'Exchange rates updated',
      exchangeRates,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to update exchange rates',
    });
  }
};

exports.testWccPrice = async (req, res) => {
  try {
    const countryCode = req.body?.countryCode || req.body?.country_code || 'IN';
    const category = req.body?.category || 'UTILITY';
    const walletCurrency =
      req.body?.walletCurrency ||
      req.body?.wallet_currency ||
      (await getWalletCurrencyForOwner(req.user?.id)) ||
      'INR';

    const result = await getMessageCost({
      countryCode,
      category,
      walletCurrency,
    });

    return res.json({
      success: true,
      countryCode: result.countryCode,
      category: result.category,
      originalPrice: result.originalPrice,
      originalCurrency: result.originalCurrency,
      walletPrice: result.walletPrice,
      walletCurrency: result.walletCurrency,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to calculate test price',
    });
  }
};
