require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { Sequelize } = require('sequelize');

const REAL_PHONE_ID = String(
  process.env.Phone_Number_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '1123034887566753'
).trim();
const REAL_WABA_ID = String(process.env.WABA_ID || '1863328674651171').trim();
const TO = String(process.env.AISENSY_DIRECT_API_PROBE_TO || '917397855291').replace(/\D/g, '');

async function regenJwt() {
  const email = process.env.AISENSY_DIRECT_API_EMAIL;
  const password = process.env.AISENSY_DIRECT_API_PASSWORD;
  const projectId = process.env.AISENSY_DIRECT_API_PROJECT_ID;
  const b = Buffer.from(`${email}:${password}:${projectId}`).toString('base64');
  const r = await axios.post(
    'https://backend.aisensy.com/direct-apis/t1/users/regenrate-token',
    { direct_api: true },
    { headers: { Authorization: `Bearer ${b}` }, validateStatus: () => true }
  );
  if (r.status >= 400) throw new Error(`regen failed: ${JSON.stringify(r.data)}`);
  return r.data?.users?.[0]?.token;
}

async function tryDbUpdate() {
  const seq = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    logging: false,
  });
  try {
    await seq.authenticate();
    const [before] = await seq.query(
      'SELECT id, projectId, phone_number_id, waba_id FROM whatsapp_accounts ORDER BY id DESC LIMIT 20'
    );
    console.log('whatsapp_accounts before:', JSON.stringify(before, null, 2));
    await seq.query(
      `UPDATE whatsapp_accounts
       SET phone_number_id = :phone, waba_id = :waba
       WHERE phone_number_id = '1308447152343213'`,
      { replacements: { phone: REAL_PHONE_ID, waba: REAL_WABA_ID } }
    );
    try {
      await seq.query(
        `UPDATE clients_whatsapp
         SET phone_number_id = :phone, waba_id = :waba
         WHERE phone_number_id = '1308447152343213'`,
        { replacements: { phone: REAL_PHONE_ID, waba: REAL_WABA_ID } }
      );
    } catch (_) {
      /* table may differ */
    }
    const [after] = await seq.query(
      'SELECT id, projectId, phone_number_id, waba_id FROM whatsapp_accounts WHERE phone_number_id = :phone',
      { replacements: { phone: REAL_PHONE_ID } }
    );
    console.log('whatsapp_accounts after (real phone):', JSON.stringify(after, null, 2));
  } catch (e) {
    console.warn('DB update skipped:', e.message);
  } finally {
    await seq.close();
  }
}

async function sendFromRealPhone(token) {
  const body = {
    messaging_product: 'whatsapp',
    phone_number_id: REAL_PHONE_ID,
    to: TO,
    type: 'template',
    template: {
      name: 'hello_world',
      language: { code: 'en_US' },
    },
  };
  const r = await axios.post('https://backend.aisensy.com/direct-apis/t1/messages', body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    validateStatus: () => true,
  });
  console.log('SEND from +91 phone_number_id', REAL_PHONE_ID, 'to', TO);
  console.log('status', r.status, JSON.stringify(r.data, null, 2));
  return r;
}

(async () => {
  console.log('Real phone_number_id:', REAL_PHONE_ID, '(+91 70286 11182 Waabizx)');
  await tryDbUpdate();
  const token = await regenJwt();
  await sendFromRealPhone(token);
  console.log(
    '\nCheck WhatsApp on',
    TO,
    'for chat from +91 70286 11182 (Waabizx), NOT +1 555.'
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
