const {
  createBusinessExternal,
  listBusinessesExternal,
  getBusinessExternal,
  useExternalPartnerApi,
  probePartnerApisOnStartup,
} = require('../services/aisensyPartnerApiClient');
const {
  createPartnerBusiness,
  findPartnerBusiness,
  buildCreateBusinessResponse,
} = require('../services/partnerBusinessService');
const { logPartnerApi } = require('../utils/partnerApiLogger');

exports.createBusiness = async (req, res) => {
  try {
    const partnerId = req.partnerId || req.params.partnerId;
    logPartnerApi('PARTNER_CREATE_BUSINESS_INBOUND', {
      method: req.method,
      url: req.originalUrl,
      partnerId,
      headers: {
        'x-aisensy-partner-api-key': req.headers['x-aisensy-partner-api-key'] ? '***' : undefined,
        authorization: req.headers.authorization ? '***' : undefined,
      },
      mode: useExternalPartnerApi() ? 'external' : 'local',
    }, req.body || null, { note: 'received on Waabizx server' });

    if (useExternalPartnerApi()) {
      const ext = await createBusinessExternal(req.body || {}, partnerId);
      const responseBody = ext.data;
      logPartnerApi('PARTNER_CREATE_BUSINESS_RESULT', {
        method: 'POST',
        url: req.originalUrl,
        partnerId,
        source: 'aisensy-external',
      }, req.body || null, responseBody);
      if (req.body?.password) {
        logPartnerApi('PARTNER_CREATE_BUSINESS_SAVE_THESE', {
          method: 'POST',
          url: req.originalUrl,
          partnerId,
          note: 'SAVE — needed for JWT (BASE64 email:password:project_ids[0])',
        }, {
          email: responseBody?.email || req.body.email,
          password: req.body.password,
          project_id: responseBody?.project_ids?.[0],
        }, responseBody);
      }
      await createPartnerBusiness(partnerId, req.body || {}).catch((e) => {
        logPartnerApi('PARTNER_CREATE_LOCAL_MIRROR_SKIP', {
          method: 'POST',
          url: req.originalUrl,
          partnerId,
        }, req.body || null, { reason: e.message });
      });
      return res.status(ext.status || 201).json(responseBody);
    }

    const created = await createPartnerBusiness(partnerId, req.body || {});
    logPartnerApi('PARTNER_CREATE_BUSINESS_RESULT', {
      method: 'POST',
      url: req.originalUrl,
      partnerId,
      source: 'local',
    }, req.body || null, created.response);
    logPartnerApi('PARTNER_CREATE_BUSINESS_SAVE_THESE', {
      method: 'POST',
      url: req.originalUrl,
      partnerId,
    }, {
      email: created.directApi.email,
      password: created.directApi.password,
      project_id: created.directApi.projectId,
      base64_key: created.directApi.base64Key,
    }, created.response);
    return res.status(201).json(created.response);
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    const body = { message: error.message || 'Failed to create business' };
    logPartnerApi('PARTNER_CREATE_BUSINESS_ERROR', {
      method: req.method,
      url: req.originalUrl,
      partnerId: req.partnerId || req.params.partnerId,
    }, req.body || null, body);
    return res.status(status).json(body);
  }
};

exports.listBusinesses = async (req, res) => {
  try {
    const partnerId = req.partnerId || req.params.partnerId;

    if (useExternalPartnerApi()) {
      try {
        const ext = await listBusinessesExternal(partnerId);
        return res.status(ext.status || 200).json(ext.data);
      } catch (error) {
        const status = Number(error.statusCode) || 500;
        if (status < 500) {
          return res.status(status).json({
            message: error.message || 'Failed to list businesses',
          });
        }

        const { PartnerBusiness } = require('../models');
        const rows = await PartnerBusiness.findAll({
          where: { partner_id: String(partnerId) },
          order: [['id', 'DESC']],
          limit: Math.min(Number(req.query.limit) || 100, 500),
        });
        const data = rows.map((row) => buildCreateBusinessResponse(row));
        logPartnerApi('PARTNER_LIST_BUSINESSES_FALLBACK', {
          method: 'GET',
          url: req.originalUrl,
          partnerId,
          source: 'local_fallback',
          externalStatus: status,
        }, null, {
          count: data.length,
          externalError: error.message,
        });
        return res.status(200).json({
          data,
          source: 'local_fallback',
          externalError: error.message,
        });
      }
    }

    const { PartnerBusiness } = require('../models');
    const rows = await PartnerBusiness.findAll({
      where: { partner_id: String(partnerId) },
      order: [['id', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 100, 500),
    });
    const data = rows.map((row) => buildCreateBusinessResponse(row));
    logPartnerApi('PARTNER_LIST_BUSINESSES', {
      method: 'GET',
      url: req.originalUrl,
      partnerId,
      source: 'local',
    }, null, { count: data.length });
    return res.status(200).json({ data });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ message: error.message || 'Failed to list businesses' });
  }
};

exports.getBusiness = async (req, res) => {
  try {
    const partnerId = req.partnerId || req.params.partnerId;
    const businessId = String(req.params.businessId || '').trim();

    if (useExternalPartnerApi()) {
      const ext = await getBusinessExternal(businessId, partnerId);
      return res.status(ext.status || 200).json(ext.data);
    }

    const row = await findPartnerBusiness(partnerId, businessId);
    if (!row) {
      return res.status(404).json({ message: 'Business not found' });
    }
    const responseBody = buildCreateBusinessResponse(row);
    logPartnerApi('PARTNER_GET_BUSINESS', {
      method: 'GET',
      url: req.originalUrl,
      partnerId,
      businessId,
      source: 'local',
    }, null, responseBody);
    return res.status(200).json(responseBody);
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ message: error.message || 'Failed to get business' });
  }
};

/** Manual probe — calls all 3 AiSensy Partner APIs and logs (GET list, GET one, optional POST). */
exports.probeExternalApis = async (req, res) => {
  try {
    const results = await probePartnerApisOnStartup();
    return res.json({ success: true, results });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
