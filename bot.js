const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const config = require('./config');

puppeteer.use(StealthPlugin());

let lastSmsId = 0;
let isPolling = false;
let browser = null;
let page = null;
let bot = null;

function createAuthHeader() {
  const credentials = `${config.API_USERNAME}:${config.API_PASSWORD}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

async function initializeBrowser() {
  try {
    console.log('🌐 Initializing browser...');

    let chromePath = '/usr/bin/google-chrome';

    if (!fs.existsSync(chromePath)) {
      console.log('⚠️ System Chrome not found, checking Puppeteer...');
      try {
        chromePath = puppeteer.executablePath();
        if (!fs.existsSync(chromePath)) throw new Error('Puppeteer Chrome missing');
        console.log('🧭 Using Puppeteer Chrome at:', chromePath);
      } catch {
        console.log('⚙️ Installing Chromium manually...');
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
        chromePath = puppeteer.executablePath();
        console.log('✅ Installed Chromium at:', chromePath);
      }
    } else {
      console.log('🧭 Using system Chrome at:', chromePath);
    }

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
    await page.setExtraHTTPHeaders({ 'Authorization': createAuthHeader() });

    console.log('🔄 Navigating to API...');
    await page.goto(config.API_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    console.log('✅ Browser initialized and ready');
    return true;
  } catch (err) {
    console.error('❌ Failed to initialize browser:', err.message);
    return false;
  }
}

async function fetchLatestSMS() {
  try {
    if (!page) {
      console.log('No browser page, initializing...');
      const success = await initializeBrowser();
      if (!success) return [];
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
    }
    
    if (smsData && !smsData.success) {
      if (smsData.status === 429) {
        console.log('⚠️ API Rate limit hit - waiting longer...');
      } else {
        console.log(smsData.status ? `API status: ${smsData.status}` : `Fetch error: ${smsData.error}`);
      }
    }
    return [];
  } catch (err) {
    console.error('Error fetching SMS:', err.message);
    if (browser) await browser.close().catch(() => {});
    browser = null; 
    page = null;
    return [];
  }
}

async function sendOTPToTelegram(sms) {
  try {
    const source = sms.source_addr || 'Unknown';
    const destination = sms.destination_addr || 'Unknown';
    let message = (sms.short_message || 'No content').replace(/\u0000/g, '');

    const formatted = `
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

    // Send to all channels
    for (const chatId of config.TELEGRAM_CHAT_IDS) {
      try {
        await bot.sendMessage(chatId, formatted, { parse_mode: 'Markdown' });
        console.log(`✓ Sent OTP from ${source} to channel ${chatId}`);
      } catch (err) {
        console.error(`Failed to send to channel ${chatId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
  }
}

async function sendToAllChannels(message, options = {}) {
  const results = [];
  for (const chatId of config.TELEGRAM_CHAT_IDS) {
    try {
      await bot.sendMessage(chatId, message, options);
      results.push({ chatId, success: true });
      console.log(`✓ Message sent to channel ${chatId}`);
    } catch (err) {
      results.push({ chatId, success: false, error: err.message });
      console.error(`Failed to send to channel ${chatId}:`, err.message);
    }
  }
  return results;
}

async function pollSMSAPI() {
  if (isPolling) return;
  isPolling = true;

  try {
    const messages = await fetchLatestSMS();
    if (messages.length) {
      console.log(`📬 Found ${messages.length} new SMS`);
      for (const sms of messages) {
        if ((sms.id || 0) > lastSmsId) {
          await sendOTPToTelegram(sms);
          lastSmsId = sms.id || lastSmsId;
        }
      }
    } else {
      console.log('📭 No new SMS messages');
    }
  } catch (err) {
    console.error('Polling error:', err.message);
  } finally {
    isPolling = false;
  }
}

// Create HTTP server for Render health checks
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      lastSmsId: lastSmsId,
      browserActive: !!browser,
      activeChannels: config.TELEGRAM_CHAT_IDS.length,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const PORT = process.env.PORT || 10000;

async function startBot() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Telegram OTP Bot Starting...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Start HTTP server first
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health check server running on port ${PORT}`);
  });

  // Initialize Telegram bot with webhook mode to avoid conflicts
  bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

  // Bot commands
  bot.onText(/\/start/, (msg) => 
    bot.sendMessage(msg.chat.id, '🤖 OTP Bot active!')
  );

  bot.onText(/\/status/, (msg) => {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const statusMessage = `📊 *Bot Status*
━━━━━━━━━━━━━━━━━━━━
✅ Status: Running
🆔 Last SMS ID: ${lastSmsId}
⏱️ Poll Interval: ${config.POLL_INTERVAL/1000}s
🌐 Browser: ${browser ? 'Active' : 'Not initialized'}
📡 Active Channels: ${config.TELEGRAM_CHAT_IDS.length}
⏰ Uptime: ${hours}h ${minutes}m
━━━━━━━━━━━━━━━━━━━━`;
    
    bot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'Markdown' });
  });

  // Handle polling errors
  bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
      console.error('💥 Multiple instances detected! Stopping this instance...');
      process.exit(1); // Exit to let Render restart with single instance
    } else {
      console.error('Telegram error:', error.code, error.message);
    }
  });

  console.log(`📡 Polling every ${config.POLL_INTERVAL/1000}s`);
  console.log(`💬 Forwarding to ${config.TELEGRAM_CHAT_IDS.length} channels:`);
  config.TELEGRAM_CHAT_IDS.forEach(id => console.log(`   - ${id}`));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Initialize browser and start polling
  const browserInitialized = await initializeBrowser();
  
  if (browserInitialized) {
    // Send connection success message to all channels
    const connectionMessage = `✅ *OTP Bot Connected*

The bot is now active and monitoring for OTPs.
Use /status anytime you want to check connection status.`;
    
    await sendToAllChannels(connectionMessage, { parse_mode: 'Markdown' });
    console.log('✅ Connection notification sent to all channels\n');
  }

  await pollSMSAPI();
  setInterval(pollSMSAPI, config.POLL_INTERVAL);
}

// Graceful shutdown
async function shutdown() {
  console.log('\n🛑 Shutting down bot...');
  if (bot) {
    await bot.stopPolling();
  }
  if (browser) {
    await browser.close();
  }
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the bot
startBot();
