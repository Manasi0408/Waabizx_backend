const axios = require("axios");

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;

const getPhoneData = async () => {
  try {
    const url = `https://graph.facebook.com/v19.0/${PHONE_ID}`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
    return response.data;
  } catch (error) {
    return null;
  }
};

module.exports = { getPhoneData };
