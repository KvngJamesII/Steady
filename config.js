require('dotenv').config();

module.exports = {
  API_USERNAME: process.env.API_USERNAME,
  API_PASSWORD: process.env.API_PASSWORD,
  API_URL: process.env.API_URL || 'https://d-group.stats.direct/rest/sms',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '@otpgrouptempno',
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 10000,
  MAX_PER_PAGE: parseInt(process.env.MAX_PER_PAGE) || 100
};
