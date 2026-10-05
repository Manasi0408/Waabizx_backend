const DemoBooking = require('../models/DemoBooking');
const WebsiteLead = require('../models/WebsiteLead');
const { getDemoBookingFormOptions, getWebsiteLeadFormOptions } = require('../utils/demoBookingOptions');

const pick = (obj, keys) => {
  for (const key of keys) {
    if (obj?.[key] != null && String(obj[key]).trim() !== '') {
      return String(obj[key]).trim();
    }
  }
  return '';
};

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));

/** CRM forms sometimes send "Country: India | Industry: Finance | ..." in subject/message */
function parsePipeDelimitedLeadText(text) {
  const result = {};
  const raw = String(text || '').trim();
  if (!raw) return result;

  const segments = raw.includes('|') ? raw.split('|') : [raw];
  for (const segment of segments) {
    const part = String(segment || '').trim();
    if (!part) continue;
    const match = part.match(/^([^:]{2,80}):\s*(.+)$/);
    if (!match) continue;
    const label = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (!value) continue;

    if (/company size|employees|team size/.test(label)) result.company_size = value;
    else if (/^country$|country name/.test(label)) result.country = value;
    else if (/industry|your industry/.test(label)) result.industry = value;
    else if (/heard about|how did you hear/.test(label)) result.heard_about = value;
    else if (/subject|topic/.test(label)) result.subject = value;
    else if (/message|comment|note/.test(label)) result.message = value;
  }
  return result;
}

function isPipeDelimitedMetadata(text) {
  const raw = String(text || '').trim();
  if (!raw.includes('|') || !raw.includes(':')) return false;
  const parsed = parsePipeDelimitedLeadText(raw);
  return Boolean(parsed.country || parsed.industry || parsed.heard_about || parsed.company_size);
}

function mergeLeadFields(base = {}, parsed = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(parsed)) {
    const v = String(value || '').trim();
    if (v && !String(out[key] || '').trim()) out[key] = v;
  }
  return out;
}

function normalizeWebsiteLeadRow(lead) {
  const row = lead?.toJSON ? lead.toJSON() : { ...lead };
  const fromSubject = parsePipeDelimitedLeadText(row.subject);
  const fromMessage = parsePipeDelimitedLeadText(row.message);
  const fromDescriptions = parsePipeDelimitedLeadText(row.descriptions);

  const merged = mergeLeadFields(row, mergeLeadFields(fromSubject, mergeLeadFields(fromMessage, fromDescriptions)));

  let subject = String(row.subject || '').trim();
  if (isPipeDelimitedMetadata(subject)) {
    subject = String(fromSubject.subject || merged.subject || '').trim();
  }

  let message = String(row.message || '').trim();
  if (isPipeDelimitedMetadata(message) && !merged.message) {
    message = '';
  }

  return {
    ...merged,
    subject,
    message,
    country: merged.country || '',
    industry: merged.industry || '',
    heard_about: merged.heard_about || '',
    company_size: merged.company_size || '',
  };
}

/** Public — dropdown options for Book Demo form (countries, industries, etc.) */
exports.getDemoBookingFormOptions = async (req, res) => {
  try {
    return res.json({
      success: true,
      ...getDemoBookingFormOptions(),
    });
  } catch (error) {
    console.error('getDemoBookingFormOptions error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to load form options' });
  }
};

/** Public — Schedule a Free Demo form */
exports.createDemoBooking = async (req, res) => {
  try {
    await DemoBooking.ensureSchema();
    const body = req.body || {};
    const full_name = pick(body, ['full_name', 'fullName', 'name']);
    const email = pick(body, ['email', 'work_email', 'workEmail']);
    const phone = pick(body, ['phone', 'phone_number', 'phoneNumber', 'mobile']);
    const company_size = pick(body, ['company_size', 'companySize', 'employee_count']);
    const country = pick(body, ['country', 'country_name', 'countryName']);
    const industry = pick(body, ['industry', 'your_industry', 'yourIndustry']);
    const heard_about = pick(body, [
      'heard_about',
      'heardAbout',
      'heard_about_us',
      'heardAboutUs',
      'how_did_you_hear',
      'howDidYouHear',
    ]);
    const interest = pick(body, [
      'interest',
      'interests',
      'what_would_you_like',
      'whatWouldYouLike',
      'what_would_you_like_to_waabizx',
      'whatWouldYouLikeToWaabizx',
    ]);
    const descriptions = pick(body, ['descriptions', 'description', 'notes']);

    if (!full_name) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Valid work email is required' });
    }
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    const booking = await DemoBooking.create({
      full_name,
      email: email.toLowerCase(),
      phone,
      company_size: company_size || '',
      country: country || '',
      industry: industry || '',
      heard_about: heard_about || '',
      interest: interest || '',
      descriptions: descriptions || '',
      status: 'new',
    });

    return res.status(201).json({
      success: true,
      message: 'Demo booking received',
      booking,
    });
  } catch (error) {
    console.error('createDemoBooking error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to save demo booking',
    });
  }
};

/** Super Admin — list demo_bookings */
exports.listDemoBookings = async (req, res) => {
  try {
    await DemoBooking.ensureSchema();
    const bookings = await DemoBooking.findAll({
      order: [['id', 'DESC']],
      limit: 1000,
    });
    return res.json({ success: true, bookings });
  } catch (error) {
    console.error('listDemoBookings error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load demo bookings',
    });
  }
};

/** Super Admin — update status / descriptions */
exports.updateDemoBooking = async (req, res) => {
  try {
    await DemoBooking.ensureSchema();
    const id = Number(req.params.id);
    const booking = await DemoBooking.findByPk(id);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Demo booking not found' });
    }
    const updates = {};
    if (req.body?.status != null) updates.status = String(req.body.status).toLowerCase();
    if (req.body?.descriptions != null) updates.descriptions = String(req.body.descriptions);
    await booking.update(updates);
    return res.json({ success: true, booking });
  } catch (error) {
    console.error('updateDemoBooking error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update demo booking',
    });
  }
};

/** Public — dropdown options for website contact / register form */
exports.getWebsiteLeadFormOptions = async (req, res) => {
  try {
    return res.json({
      success: true,
      ...getWebsiteLeadFormOptions(),
    });
  } catch (error) {
    console.error('getWebsiteLeadFormOptions error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to load form options' });
  }
};

/** Public — Get in Touch / Send Message form */
exports.createWebsiteLead = async (req, res) => {
  try {
    await WebsiteLead.ensureSchema();
    const body = req.body || {};
    const full_name = pick(body, ['full_name', 'fullName', 'name']);
    const email = pick(body, ['email', 'email_address', 'emailAddress']);
    const phone = pick(body, ['phone', 'phone_number', 'phoneNumber', 'mobile', 'mobile_no', 'mobileNo']);
    let country = pick(body, ['country', 'country_name', 'countryName']);
    let industry = pick(body, ['industry', 'your_industry', 'yourIndustry']);
    let heard_about = pick(body, [
      'heard_about',
      'heardAbout',
      'heard_about_us',
      'heardAboutUs',
      'how_did_you_hear',
      'howDidYouHear',
      'how_did_you_hear_about_us',
      'howDidYouHearAboutUs',
    ]);
    let company_size = pick(body, ['company_size', 'companySize', 'employee_count', 'employees']);
    let subject = pick(body, ['subject']);
    let message = pick(body, ['message', 'body', 'content', 'address']);
    const descriptions = pick(body, ['descriptions', 'description', 'notes']);

    const parsed = mergeLeadFields(
      parsePipeDelimitedLeadText(subject),
      mergeLeadFields(parsePipeDelimitedLeadText(message), parsePipeDelimitedLeadText(descriptions))
    );
    country = country || parsed.country || '';
    industry = industry || parsed.industry || '';
    heard_about = heard_about || parsed.heard_about || '';
    company_size = company_size || parsed.company_size || '';
    if (parsed.subject && !subject) subject = parsed.subject;
    if (parsed.message && !message) message = parsed.message;
    if (isPipeDelimitedMetadata(subject)) subject = parsed.subject || '';
    if (isPipeDelimitedMetadata(message) && !parsed.message) message = '';

    if (!full_name) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Valid email is required' });
    }
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    const lead = await WebsiteLead.create({
      full_name,
      email: email.toLowerCase(),
      phone,
      country: country || '',
      industry: industry || '',
      heard_about: heard_about || '',
      company_size: company_size || '',
      subject: subject || '',
      message: message || '',
      descriptions: descriptions || '',
      status: 'new',
    });

    return res.status(201).json({
      success: true,
      message: 'Message received',
      lead: normalizeWebsiteLeadRow(lead),
    });
  } catch (error) {
    console.error('createWebsiteLead error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to save website lead' });
  }
};

/** Super Admin — list website_leads */
exports.listWebsiteLeads = async (req, res) => {
  try {
    await WebsiteLead.ensureSchema();
    const leads = await WebsiteLead.findAll({
      order: [['id', 'DESC']],
      limit: 1000,
    });
    return res.json({ success: true, leads: leads.map((l) => normalizeWebsiteLeadRow(l)) });
  } catch (error) {
    console.error('listWebsiteLeads error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to load website leads' });
  }
};

/** Super Admin — update status / descriptions */
exports.updateWebsiteLead = async (req, res) => {
  try {
    await WebsiteLead.ensureSchema();
    const id = Number(req.params.id);
    const lead = await WebsiteLead.findByPk(id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Website lead not found' });
    }
    const updates = {};
    if (req.body?.status != null) updates.status = String(req.body.status).toLowerCase();
    if (req.body?.descriptions != null) updates.descriptions = String(req.body.descriptions);
    await lead.update(updates);
    return res.json({ success: true, lead: normalizeWebsiteLeadRow(lead) });
  } catch (error) {
    console.error('updateWebsiteLead error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update website lead' });
  }
};
