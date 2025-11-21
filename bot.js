const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const fs = require('fs');
const http = require('http');
const config = require('./config');

let sentMessageHashes = new Set();
let isPolling = false;
let browser = null;
let page = null;
let bot = null;
let reconnectAttempts = 0;
let lastSuccessfulPoll = Date.now();
let pollCount = 0;
let telegramRetryAttempts = 0;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000;
const HEALTH_CHECK_INTERVAL = 60000;
const TELEGRAM_MAX_RETRY_ATTEMPTS = 3;
const TELEGRAM_RETRY_DELAY = 30000;
const MESSAGES_FILE = './sent-messages.json';
const MAX_STORED_HASHES = 1000;

function loadSentMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
      const hashes = JSON.parse(data);
      sentMessageHashes = new Set(hashes);
      console.log(`📂 Loaded ${sentMessageHashes.size} previously sent message hashes`);
    }
  } catch (err) {
    console.error('⚠️ Could not load sent messages file:', err.message);
    sentMessageHashes = new Set();
  }
}

function saveSentMessages() {
  try {
    const hashArray = Array.from(sentMessageHashes).slice(-MAX_STORED_HASHES);
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(hashArray, null, 2));
  } catch (err) {
    console.error('⚠️ Could not save sent messages file:', err.message);
  }
}

async function solveMathCaptcha(page) {
  try {
    // Use Promise-based delay instead of deprecated waitForTimeout
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const result = await page.evaluate(() => {
      // Get all text elements
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent.trim();
        if (!text) continue;
        
        // Multiple regex patterns to catch different formats
        let match = text.match(/(\d+)\s*\+\s*(\d+)/);
        if (match) {
          return parseInt(match[1]) + parseInt(match[2]);
        }
        
        match = text.match(/(\d+)\s*plus\s*(\d+)/i);
        if (match) {
          return parseInt(match[1]) + parseInt(match[2]);
        }
        
        // Try simpler pattern: just look for "number + number"
        match = text.match(/(\d+)\s*[\+plus]\s*(\d+)/i);
        if (match) {
          return parseInt(match[1]) + parseInt(match[2]);
        }
      }
      
      return null;
    });
    
    if (result) {
      console.log('🧮 Math captcha solved:', result);
    } else {
      console.log('⚠️ Could not find math captcha');
    }
    
    return result;
  } catch (err) {
    console.log('⚠️ Captcha solver error:', err.message);
    return null;
  }
}

async function initializeBrowser() {
  try {
    console.log('🌐 Initializing browser...');

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-component-update',
        '--disable-web-security',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });

    page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set extra headers
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive'
    });
    
    // Disable cache
    await page.setCacheEnabled(false);

    // Remove webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    console.log('🔐 Logging into panel...');
    
    // Navigate to login page with retry logic
    let navigationSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(config.LOGIN_URL, { 
          waitUntil: 'networkidle2', 
          timeout: 30000 
        });
        navigationSuccess = true;
        break;
      } catch (navErr) {
        console.log(`⚠️ Navigation attempt ${attempt} failed: ${navErr.message}`);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    if (!navigationSuccess) {
      throw new Error('Failed to navigate to login page after 3 attempts');
    }
    
    // Wait for login form
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Solve captcha
    const captchaAnswer = await solveMathCaptcha(page);
    if (!captchaAnswer) {
      throw new Error('Could not solve math captcha');
    }
    
    // Fill login form
    await page.waitForSelector('input[name="username"]', { timeout: 5000 });
    await page.type('input[name="username"]', config.API_USERNAME);
    await page.type('input[name="password"]', config.API_PASSWORD);
    await page.type('input[name="capt"]', captchaAnswer.toString());
    
    // Submit form
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
      page.keyboard.press('Enter')
    ]);
    
    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
      throw new Error('Login failed - still on login page');
    }
    
    console.log('✅ Logged in successfully');
    console.log('📊 Navigating to SMS reports page...');
    
    await page.goto(config.SMS_REPORTS_URL, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('✅ Browser initialized and logged in');
    reconnectAttempts = 0;
    return true;
  } catch (err) {
    console.error('❌ Failed to initialize browser:', err.message);
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      page = null;
    }
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
      await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
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

    const today = new Date();
    const startDate = new Date(today);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);
    
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    const fdate1 = formatDate(startDate);
    const fdate2 = formatDate(endDate);

    let responseData = null;
    const responsePromise = new Promise((resolve) => {
      const handler = async (response) => {
        const url = response.url();
        if (url.includes('data_smscdr.php')) {
          try {
            const data = await response.json();
            resolve(data);
            page.off('response', handler);
          } catch (err) {
            console.error('⚠️ Error parsing SMS response:', err.message);
          }
        }
      };
      page.on('response', handler);
      
      setTimeout(() => {
        page.off('response', handler);
        resolve(null);
      }, 15000);
    });

    // Navigate with more lenient settings
    try {
      await page.goto(config.SMS_REPORTS_URL, { 
        waitUntil: 'networkidle2', 
        timeout: 30000 
      });
    } catch (navErr) {
      console.log('⚠️ Navigation warning (continuing):', navErr.message);
    }
    
    // Wait for page to load
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Trigger data reload
    await page.evaluate((date1, date2) => {
      if (typeof jQuery !== 'undefined' && jQuery.fn.dataTable) {
        try {
          const table = jQuery('table').DataTable();
          if (table) {
            table.ajax.reload();
          }
        } catch (e) {
          console.log('Table reload failed:', e);
        }
      }
    }, fdate1, fdate2);

    responseData = await responsePromise;

    if (responseData && responseData.aaData) {
      lastSuccessfulPoll = Date.now();
      const crypto = require('crypto');
      const messages = responseData.aaData
        .filter((row) => {
          // Filter out rows with no meaningful content
          const hasMessage = row[5] && row[5].trim().length > 0;
          const hasSource = row[3] && row[3].trim().length > 0 && row[3] !== 'Unknown';
          const hasDestination = row[2] && row[2].trim().length > 0 && row[2] !== 'Unknown';
          
          return hasMessage && (hasSource || hasDestination);
        })
        .map((row) => {
          const msgData = `${row[0]}_${row[2]}_${row[3]}_${row[5]}`;
          const hash = crypto.createHash('md5').update(msgData).digest('hex');
          
          return {
            hash: hash,
            date: row[0] || '',
            destination_addr: row[2] || '',
            source_addr: row[3] || '',
            client: row[4] || '',
            short_message: row[5] || ''
          };
        });
      
      console.log(`📊 Fetched ${responseData.aaData.length} total records, ${messages.length} valid messages`);
      return messages;
    }
    
    console.log('⚠️ No SMS data received from panel');
    return [];
  } catch (err) {
    console.error('❌ Error fetching SMS:', err.message);
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
      let newCount = 0;
      for (const sms of messages) {
        if (!sentMessageHashes.has(sms.hash)) {
          await sendOTPToTelegram(sms);
          sentMessageHashes.add(sms.hash);
          newCount++;
          
          if (sentMessageHashes.size > MAX_STORED_HASHES) {
            const hashArray = Array.from(sentMessageHashes);
            sentMessageHashes = new Set(hashArray.slice(-500));
          }
        }
      }
      
      if (newCount > 0) {
        console.log(`📬 Sent ${newCount} new SMS message(s)`);
        saveSentMessages();
      } else {
        console.log('📭 No new SMS messages');
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

async function performHealthCheck() {
  const timeSinceLastPoll = Date.now() - lastSuccessfulPoll;
  const minutesSinceLastPoll = Math.floor(timeSinceLastPoll / 60000);
  
  console.log(`\n🏥 Health Check:`);
  console.log(`   - Browser: ${browser ? '✅ Active' : '❌ Inactive'}`);
  console.log(`   - Last successful poll: ${minutesSinceLastPoll} minute(s) ago`);
  console.log(`   - Total polls: ${pollCount}`);
  console.log(`   - Messages tracked: ${sentMessageHashes.size}\n`);
  
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

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const timeSinceLastPoll = Date.now() - lastSuccessfulPoll;
    const isHealthy = timeSinceLastPoll < 300000;
    
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isHealthy ? 'ok' : 'degraded',
      uptime: process.uptime(),
      messagesTracked: sentMessageHashes.size,
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

const PORT = process.env.PORT || 8000;

async function startBot() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Telegram OTP Bot Starting...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  loadSentMessages();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health check server running on port ${PORT}`);
  });

  bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

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
📨 Messages Tracked: ${sentMessageHashes.size}
⏱️ Poll Interval: ${config.POLL_INTERVAL/1000}s
🌐 Browser: ${browser ? 'Active ✅' : 'Inactive ❌'}
📡 Active Channels: ${config.TELEGRAM_CHAT_IDS.length}
📊 Total Polls: ${pollCount}
🕐 Last Poll: ${minutesSinceLastPoll}m ago
⏰ Uptime: ${hours}h ${minutes}m
━━━━━━━━━━━━━━━━━━━━`;
    
    bot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'Markdown' });
  });

  bot.on('polling_error', async (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
      telegramRetryAttempts++;
      console.error(`💥 Multiple instances detected! (Attempt ${telegramRetryAttempts}/${TELEGRAM_MAX_RETRY_ATTEMPTS})`);
      
      if (telegramRetryAttempts >= TELEGRAM_MAX_RETRY_ATTEMPTS) {
        console.error('❌ Max retry attempts reached. Stopping...');
        process.exit(1);
      } else {
        console.log(`⏳ Waiting ${TELEGRAM_RETRY_DELAY/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, TELEGRAM_RETRY_DELAY));
        telegramRetryAttempts = 0;
      }
    } else {
      console.error('⚠️ Telegram polling error:', error.code, error.message);
    }
  });

  console.log(`📡 Polling every ${config.POLL_INTERVAL/1000}s`);
  console.log(`💬 Forwarding to ${config.TELEGRAM_CHAT_IDS.length} channels:`);
  config.TELEGRAM_CHAT_IDS.forEach(id => console.log(`   - ${id}`));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browserInitialized = await initializeBrowser();
  
  if (browserInitialized) {
    // Mark all existing messages as already sent before starting polling
    console.log('🔄 Fetching existing messages to mark as already sent...');
    const existingMessages = await fetchLatestSMS();
    
    if (existingMessages.length > 0) {
      existingMessages.forEach(sms => {
        sentMessageHashes.add(sms.hash);
      });
      saveSentMessages();
      console.log(`✅ Marked ${existingMessages.length} existing messages as already sent`);
    } else {
      console.log('✅ No existing messages found');
    }
    
    const connectionMessage = `✅ *OTP Bot Connected*

The bot is now active and monitoring for OTPs.
Use /status anytime to check connection status.

⏱️ Poll interval: ${config.POLL_INTERVAL/1000}s`;
    
    await sendToAllChannels(connectionMessage, { parse_mode: 'Markdown' });
    console.log('✅ Connection notification sent to all channels\n');
  }

  await pollSMSAPI();
  setInterval(pollSMSAPI, config.POLL_INTERVAL);
  setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);
  
  console.log('✅ All systems initialized and running\n');
}

async function shutdown() {
  console.log('\n🛑 Shutting down bot...');
  
  saveSentMessages();
  console.log('💾 Saved message hashes');
  
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

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('💥 Unhandled Rejection:', err);
});

startBot();
