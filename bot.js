const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const config = require('./config');

puppeteer.use(StealthPlugin());

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

let lastSmsId = 0;
let isPolling = false;
let browser = null;
let page = null;

function createAuthHeader() {
  const credentials = `${config.API_USERNAME}:${config.API_PASSWORD}`;
  const base64Credentials = Buffer.from(credentials).toString('base64');
  return `Basic ${base64Credentials}`;
}

async function initializeBrowser() {
  try {
    console.log('🌐 Initializing browser...');

    // ✅ make sure Puppeteer uses the right Chrome binary
    const chromePath = puppeteer.executablePath();

    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'Authorization': createAuthHeader()
    });

    console.log('🔄 Navigating to API and solving Cloudflare challenge...');
    await page.goto(config.API_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('✓ Browser initialized and ready');
    return true;
  } catch (error) {
    console.error('Failed to initialize browser:', error.message);
    return false;
  }
}

async function fetchLatestSMS() {
  try {
    if (!page) {
      console.log('No browser page available, initializing...');
      const success = await initializeBrowser();
      if (!success) {
        console.log('Failed to initialize browser, will retry next poll');
        return [];
      }
    }

    const url = lastSmsId > 0
      ? `${config.API_URL}?per-page=${config.MAX_PER_PAGE}&id=${lastSmsId}`
      : `${config.API_URL}?per-page=${config.MAX_PER_PAGE}`;

    const smsData = await page.evaluate(async (apiUrl, authHeader) => {
      try {
        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json'
          }
        });

        if (response.ok) {
          return { success: true, data: await response.json() };
        } else {
          return { success: false, status: response.status, statusText: response.statusText };
        }
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, url, createAuthHeader());

    if (smsData && smsData.success && Array.isArray(smsData.data)) {
      return smsData.data;
    } else if (smsData && !smsData.success) {
      console.log(smsData.status ? `API returned status: ${smsData.status}` : `Fetch Error: ${smsData.error}`);
      return [];
    } else {
      console.log('Unexpected response format');
      return [];
    }
  } catch (error) {
    console.error('Error fetching SMS:', error.message);
    if (browser) await browser.close().catch(() => {});
    browser = null;
    page = null;
    return [];
  }
}

async function sendOTPToTelegram(smsData) {
  try {
    console.log('SMS Data received:', JSON.stringify(smsData, null, 2));
    const source = smsData.source_addr || 'Unknown Source';
    const destination = smsData.destination_addr || 'Unknown Destination';
    let message = smsData.short_message || 'No content';
    message = message.replace(/\u0000/g, '');

    const formattedMessage = `
🔔 *NEW OTP RECEIVED*
━━━━━━━━━━━━━━━━━━━━

📤 *Source:* \`${source}\`
📱 *Destination:* \`${destination}\`

💬 *Message:*
\`\`\`
${message}
\`\`\`

━━━━━━━━━━━━━━━━━━━━
⏰ _${new Date().toLocaleString()}_
`;

    await bot.sendMessage(config.TELEGRAM_CHAT_ID, formattedMessage, { parse_mode: 'Markdown' });
    console.log(`✓ Sent OTP from ${source} to Telegram group`);
  } catch (error) {
    console.error('Failed to send message to Telegram:', error.message);
  }
}

async function pollSMSAPI() {
  if (isPolling) {
    console.log('Already polling, skipping...');
    return;
  }

  isPolling = true;

  try {
    const smsMessages = await fetchLatestSMS();
    if (smsMessages.length > 0) {
      console.log(`📬 Found ${smsMessages.length} new SMS message(s)`);
      for (const sms of smsMessages) {
        const smsId = sms.id || 0;
        if (smsId > lastSmsId) {
          await sendOTPToTelegram(sms);
          lastSmsId = smsId;
        }
      }
      console.log(`Updated last SMS ID to: ${lastSmsId}`);
    } else {
      console.log('No new SMS messages');
    }
  } catch (error) {
    console.error('Error during SMS polling:', error.message);
  } finally {
    isPolling = false;
  }
}

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error.code, error.message);
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🤖 OTP Bot is active and monitoring for new SMS messages!');
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const statusMessage = `📊 Bot Status:\n✅ Running\n🆔 Last SMS ID: ${lastSmsId}\n⏱️ Poll Interval: ${config.POLL_INTERVAL / 1000}s\n🌐 Browser: ${browser ? 'Active' : 'Not initialized'}`;
  bot.sendMessage(chatId, statusMessage);
});

async function startBot() {
  console.log('🚀 Telegram OTP Bot started!');
  console.log(`📡 Polling SMS API every ${config.POLL_INTERVAL / 1000} seconds`);
  console.log(`💬 Forwarding to: ${config.TELEGRAM_CHAT_ID}`);
  await initializeBrowser();
  pollSMSAPI();
  setInterval(pollSMSAPI, config.POLL_INTERVAL);
}

startBot();

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down bot...');
  if (browser) await browser.close();
  process.exit();
});
