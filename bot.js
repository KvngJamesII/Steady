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
let reconnectAttempts = 0;
let lastSuccessfulPoll = Date.now();
let pollCount = 0;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000;
const HEALTH_CHECK_INTERVAL = 60000; // Check every 1 minute

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
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions'
      ]
    });

    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Authorization': createAuthHeader() });

    console.log('🔄 Navigating to API...');
    await page.goto(config.API_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    console.log('✅ Browser initialized and ready');
    reconnectAttempts = 0; // Reset reconnect counter on success
    return true;
  } catch (err) {
    console.error('❌ Failed to initialize browser:', err.message);
    return false;
  }
}

async function ensureBrowserActive() {
  try {
    if (!browser || !page) {
      console.log('⚠️ Browser not active, reinitializing...');
      return await initializeBrowser();
    }

    // Test if browser is still responsive
    await page.evaluate(() => true);
    return true;
  } catch (err) {
    console.error('⚠️ Browser not responsive:', err.message);
    if (browser) {
      await browser.close().catch(() => {});
    }
    browser = null;
    page = null;
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`🔄 Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
      await new Promise(r => setTimeout(r, RECONNECT_DELAY));
      return await initializeBrowser();
    } else {
      console.error('❌ Max reconnection attempts reached');
      return false;
    }
  }
}

async function fetchLatestSMS() {
  try {
    const browserActive = await ensureBrowserActive();
    if (!browserActive) {
      console.log('❌ Browser initialization failed, skipping this poll');
      return [];
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
      lastSuccessfulPoll = Date.now();
      return smsData.data;
    }
    
    if (smsData && !smsData.success) {
      if (smsData.status === 429) {
        console.log('⚠️ API Rate limit hit - waiting longer...');
      } else {
        console.log(smsData.status ? `⚠️ API status: ${smsData.status}` : `⚠️ Fetch error: ${smsData.error}`);
      }
    }
    return [];
  } catch (err) {
    console.error('❌ Error fetching SMS:', err.message);
    // Don't close browser here, let ensureBrowserActive handle it
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
        console.error(`❌ Failed to send to channel ${chatId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Failed to send Telegram message:', err.message);
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
      console.error(`❌ Failed to send to channel ${chatId}:`, err.message);
    }
  }
  return results;
}

async function pollSMSAPI() {
  if (isPolling) {
    console.log('⏭️ Skipping poll - previous poll still in progress');
    return;
  }
  
  isPolling = true;
  pollCount++;

  try {
    const now = new Date();
    const timeStr = now.toLocaleTimeString();
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📡 Poll #${pollCount} at ${timeStr}`);
    console.log(`🔍 Checking for new SMS messages...`);
    
    const messages = await fetchLatestSMS();
    
    if (messages.length) {
      console.log(`📬 Found ${messages.length} new SMS message(s)`);
      for (const sms of messages) {
        if ((sms.id || 0) > lastSmsId) {
          await sendOTPToTelegram(sms);
          lastSmsId = sms.id || lastSmsId;
        }
      }
    } else {
      console.log('📭 No new SMS messages');
    }
    
    console.log(`✅ Poll completed successfully`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  } catch (err) {
    console.error('❌ Polling error:', err.message);
  } finally {
    isPolling = false;
  }
}

// Health check function
async function performHealthCheck() {
  const timeSinceLastPoll = Date.now() - lastSuccessfulPoll;
  const minutesSinceLastPoll = Math.floor(timeSinceLastPoll / 60000);
  
  console.log(`\n🏥 Health Check:`);
  console.log(`   - Browser: ${browser ? '✅ Active' : '❌ Inactive'}`);
  console.log(`   - Last successful poll: ${minutesSinceLastPoll} minute(s) ago`);
  console.log(`   - Total polls: ${pollCount}`);
  console.log(`   - Last SMS ID: ${lastSmsId}\n`);
  
  // If no successful poll in 5 minutes, try to reconnect
  if (timeSinceLastPoll > 300000 && browser) {
    console.log('⚠️ No successful poll in 5 minutes, forcing reconnection...');
    if (browser) {
      await browser.close().catch(() => {});
    }
    browser = null;
    page = null;
    await ensureBrowserActive();
  }
}

// Create HTTP server for Render health checks
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const timeSinceLastPoll = Date.now() - lastSuccessfulPoll;
    const isHealthy = timeSinceLastPoll < 300000; // Healthy if polled within last 5 minutes
    
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isHealthy ? 'ok' : 'degraded',
      uptime: process.uptime(),
      lastSmsId: lastSmsId,
      browserActive: !!browser,
      activeChannels: config.TELEGRAM_CHAT_IDS.length,
      pollCount: pollCount,
      lastSuccessfulPoll: new Date(lastSuccessfulPoll).toISOString(),
      timeSinceLastPoll: `${Math.floor(timeSinceLastPoll / 1000)}s`,
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

  // Initialize Telegram bot
  bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

  // Bot commands
  bot.onText(/\/start/, (msg) => 
    bot.sendMessage(msg.chat.id, '🤖 OTP Bot active! Use /status to check connection.')
  );

  bot.onText(/\/status/, (msg) => {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const timeSinceLastPoll = Date.now() - lastSuccessfulPoll;
    const minutesSinceLastPoll = Math.floor(timeSinceLastPoll / 60000);
    
    const statusMessage = `📊 *Bot Status*
━━━━━━━━━━━━━━━━━━━━
✅ Status: ${browser ? 'Running' : 'Reconnecting...'}
🆔 Last SMS ID: ${lastSmsId}
⏱️ Poll Interval: ${config.POLL_INTERVAL/1000}s
🌐 Browser: ${browser ? 'Active ✅' : 'Inactive ❌'}
📡 Active Channels: ${config.TELEGRAM_CHAT_IDS.length}
📊 Total Polls: ${pollCount}
🕐 Last Poll: ${minutesSinceLastPoll}m ago
⏰ Uptime: ${hours}h ${minutes}m
━━━━━━━━━━━━━━━━━━━━`;
    
    bot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'Markdown' });
  });

  // Handle polling errors
  bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
      console.error('💥 Multiple instances detected! Stopping this instance...');
      process.exit(1);
    } else {
      console.error('⚠️ Telegram polling error:', error.code, error.message);
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
Use /status anytime you want to check connection status.

⏱️ Poll interval: ${config.POLL_INTERVAL/1000}s`;
    
    await sendToAllChannels(connectionMessage, { parse_mode: 'Markdown' });
    console.log('✅ Connection notification sent to all channels\n');
  }

  // Start polling immediately
  await pollSMSAPI();
  
  // Set up regular polling interval
  setInterval(pollSMSAPI, config.POLL_INTERVAL);
  
  // Set up health check interval
  setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);
  
  console.log('✅ All systems initialized and running\n');
}

// Graceful shutdown
async function shutdown() {
  console.log('\n🛑 Shutting down bot...');
  
  // Notify channels about shutdown
  if (bot) {
    const shutdownMessage = '⚠️ *Bot Shutting Down*\n\nThe OTP bot is being stopped.';
    await sendToAllChannels(shutdownMessage, { parse_mode: 'Markdown' }).catch(() => {});
    await bot.stopPolling();
  }
  
  if (browser) {
    await browser.close();
  }
  
  server.close();
  console.log('✅ Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  // Don't exit, try to recover
});

process.on('unhandledRejection', (err) => {
  console.error('💥 Unhandled Rejection:', err);
  // Don't exit, try to recover
});

// Start the bot
startBot();
