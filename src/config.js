require('dotenv').config();

module.exports = {
  // Bot Configuration
  BOT_TOKEN: process.env.BOT_TOKEN,
  MONGO_URI: process.env.MONGO_URI,
  
  // Channel Configuration
  CHANNEL_USERNAME: process.env.CHANNEL_USERNAME || '@YourChannel',
  CHANNEL_ID: process.env.CHANNEL_ID,
  
  // Admin IDs
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
  
  // Scraper Settings
  SOURCE_SITE: process.env.SOURCE_SITE || 'https://1080p.4free.asia',
  MAX_SIZE_MB: parseInt(process.env.MAX_SIZE_MB || '200'),
  SCRAPE_INTERVAL_MIN: parseInt(process.env.SCRAPE_INTERVAL_MIN || '15'),
  MAX_PAGES: parseInt(process.env.MAX_PAGES || '3'),
  CONCURRENT_DOWNLOADS: parseInt(process.env.CONCURRENT_DOWNLOADS || '2'),
  
  // Paths
  TEMP_DIR: process.env.TEMP_DIR || '/tmp/videos',
  
  // Performance Settings
  CHUNK_SIZE: 512 * 1024, // 512KB chunks
  TIMEOUT: 45000, // 45 seconds
  MAX_RETRIES: 2,
  
  // HTTP Headers for scraping
  HEADERS: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://1080p.4free.asia/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive'
  }
};
