require('dotenv').config();

module.exports = {
  API_USERNAME: process.env.PANEL_USERNAME,
  API_PASSWORD: process.env.PANEL_PASSWORD,
  LOGIN_URL: process.env.LOGIN_URL || 'http://139.99.63.204/ints/login',
  SMS_REPORTS_URL: process.env.SMS_REPORTS_URL || 'http://139.99.63.204/ints/agent/SMSCDRReports',
  API_URL: process.env.API_URL || 'http://139.99.63.204/ints/agent/res/data_smscdr.php',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS: [
    '-1003420206708',
    '-1002826032710',
    '-1003341676290'
  ],
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 10000,
  MAX_PER_PAGE: parseInt(process.env.MAX_PER_PAGE) || 100
};
