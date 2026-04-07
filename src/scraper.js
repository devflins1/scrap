const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PQueue = require('p-queue').default;
const config = require('./config');
const db = require('./database');

// Create temp directory
if (!fs.existsSync(config.TEMP_DIR)) {
  fs.mkdirSync(config.TEMP_DIR, { recursive: true });
}

// Queue for concurrent downloads
const downloadQueue = new PQueue({ concurrency: config.CONCURRENT_DOWNLOADS });

// ============ HOMEPAGE SCRAPING ============

const getVideoLinks = async () => {
  const urls = new Set();
  
  try {
    for (let page = 1; page <= config.MAX_PAGES; page++) {
      const url = page === 1 
        ? config.SOURCE_SITE 
        : `${config.SOURCE_SITE}/page/${page}/`;
      
      console.log(`🔍 Scraping page ${page}...`);
      
      const { data } = await axios.get(url, {
        headers: config.HEADERS,
        timeout: config.TIMEOUT
      });
      
      // Extract video links using regex (faster than cheerio for this)
      const regex = /href="(https:\/\/1080p\.4free\.asia\/\d{4}\/\d{2}\/[^"]+)"/g;
      let match;
      
      while ((match = regex.exec(data)) !== null) {
        urls.add(match[1]);
      }
      
      console.log(`📄 Page ${page}: Found ${urls.size} total links so far`);
      
      await sleep(1000); // Polite scraping
    }
  } catch (error) {
    console.error('❌ Homepage scraping error:', error.message);
  }
  
  return Array.from(urls);
};

// ============ SINGLE VIDEO SCRAPING ============

const scrapeVideoInfo = async (url) => {
  try {
    const { data } = await axios.get(url, {
      headers: config.HEADERS,
      timeout: config.TIMEOUT
    });
    
    // Extract title
    const titleMatch = data.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch 
      ? titleMatch[1].split('–')[0].trim().substring(0, 100)
      : 'Unknown Video';
    
    // Extract video URL
    let videoMatch = data.match(/source src="(https?:\/\/[^"]+\.mp4[^"]*)"/);
    if (!videoMatch) {
      videoMatch = data.match(/"file":"(https?:\/\/[^"]+\.mp4)"/);
    }
    
    if (!videoMatch) {
      return null;
    }
    
    const directUrl = videoMatch[1].replace(/\\\//g, '/');
    
    // Check file size via HEAD request
    const headResponse = await axios.head(directUrl, {
      headers: config.HEADERS,
      timeout: 15000
    });
    
    const sizeBytes = parseInt(headResponse.headers['content-length'] || 0);
    const sizeMb = sizeBytes / (1024 * 1024);
    
    if (sizeMb > config.MAX_SIZE_MB || sizeMb < 1) {
      console.log(`⚠️ Skipped (size ${sizeMb.toFixed(1)}MB): ${title}`);
      return null;
    }
    
    // Extract thumbnail (optional)
    const thumbMatch = data.match(/poster="([^"]+)"/);
    const thumbnail = thumbMatch ? thumbMatch[1] : null;
    
    return {
      url,
      title,
      directUrl,
      sizeMb,
      thumbnail
    };
    
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.log(`⏱️ Timeout: ${url}`);
    } else {
      console.error(`❌ Scrape error: ${error.message}`);
    }
    return null;
  }
};

// ============ DOWNLOAD & UPLOAD ============

const downloadVideo = async (directUrl, filepath) => {
  const writer = fs.createWriteStream(filepath);
  
  const response = await axios({
    url: directUrl,
    method: 'GET',
    headers: config.HEADERS,
    responseType: 'stream',
    timeout: 300000 // 5 minutes
  });
  
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

const uploadToTelegram = async (bot, filepath, videoInfo) => {
  const caption = `🎬 ${videoInfo.title}\n📦 ${videoInfo.sizeMb.toFixed(1)} MB\n\n${config.CHANNEL_USERNAME}`;
  
  const message = await bot.telegram.sendVideo(
    config.CHANNEL_ID,
    { source: filepath },
    {
      caption,
      supports_streaming: true,
      connect_timeout: 120000,
      timeout: 120000
    }
  );
  
  return message.video;
};

const processVideo = async (bot, videoInfo) => {
  const fileHash = crypto.createHash('md5').update(videoInfo.url).digest('hex').substring(0, 10);
  const filepath = path.join(config.TEMP_DIR, `${fileHash}.mp4`);
  
  try {
    console.log(`⬇️ Downloading: ${videoInfo.title.substring(0, 40)}`);
    
    await downloadVideo(videoInfo.directUrl, filepath);
    
    console.log(`📤 Uploading: ${videoInfo.title.substring(0, 40)}`);
    
    const video = await uploadToTelegram(bot, filepath, videoInfo);
    
    // Save to database
    await db.addVideo({
      url: videoInfo.url,
      title: videoInfo.title,
      fileId: video.file_id,
      sizeMb: videoInfo.sizeMb,
      thumbnail: videoInfo.thumbnail,
      duration: video.duration || 0,
      channelPosted: true
    });
    
    console.log(`✅ Done: ${videoInfo.title.substring(0, 40)}`);
    
    return true;
    
  } catch (error) {
    console.error(`❌ Process error: ${error.message}`);
    return false;
    
  } finally {
    // Cleanup
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        console.error('Cleanup error:', e.message);
      }
    }
  }
};

// ============ BATCH PROCESSING ============

const processBatch = async (bot, queueItems) => {
  for (const item of queueItems) {
    try {
      // Check if already exists
      const exists = await db.videoExists(item.url);
      if (exists) {
        await db.markScrapeDone(item._id);
        continue;
      }
      
      // Scrape video info
      const videoInfo = await scrapeVideoInfo(item.url);
      
      if (!videoInfo) {
        await db.markScrapeFailed(item._id, 'Failed to scrape video info');
        continue;
      }
      
      // Add to download queue (respects concurrency limit)
      await downloadQueue.add(async () => {
        const success = await processVideo(bot, videoInfo);
        
        if (success) {
          await db.markScrapeDone(item._id);
        } else {
          await db.markScrapeFailed(item._id, 'Download/upload failed');
        }
      });
      
    } catch (error) {
      console.error(`Batch item error: ${error.message}`);
      await db.markScrapeFailed(item._id, error.message);
    }
  }
  
  // Wait for all downloads to complete
  await downloadQueue.onIdle();
};

// ============ MAIN SCRAPER CYCLE ============

const scraperCycle = async (bot) => {
  try {
    console.log('🔄 Starting scraper cycle...');
    
    // Get video links from homepage
    const videoUrls = await getVideoLinks();
    console.log(`📊 Found ${videoUrls.length} video URLs`);
    
    if (videoUrls.length === 0) {
      return;
    }
    
    // Add to queue
    await db.addToScrapeQueue(videoUrls);
    
    // Process queue in batches
    while (true) {
      const batch = await db.getPendingBatch(5);
      
      if (batch.length === 0) {
        break;
      }
      
      console.log(`📦 Processing batch of ${batch.length} videos`);
      await processBatch(bot, batch);
      
      await sleep(2000);
    }
    
    console.log('✅ Scraper cycle completed');
    
  } catch (error) {
    console.error('❌ Scraper cycle error:', error);
  }
};

// ============ AUTO SCRAPER LOOP ============

const startAutoScraper = (bot) => {
  console.log(`🤖 Auto scraper started (interval: ${config.SCRAPE_INTERVAL_MIN} min)`);
  
  const runCycle = async () => {
    try {
      await scraperCycle(bot);
      
      // Cleanup old queue
      await db.cleanupOldQueue();
      
    } catch (error) {
      console.error('Loop error (auto-restarting):', error);
    }
    
    // Schedule next cycle
    setTimeout(runCycle, config.SCRAPE_INTERVAL_MIN * 60 * 1000);
  };
  
  // Start first cycle after 10 seconds
  setTimeout(runCycle, 10000);
};

// ============ CLEANUP LOOP ============

const startCleanupLoop = () => {
  setInterval(() => {
    try {
      if (fs.existsSync(config.TEMP_DIR)) {
        const files = fs.readdirSync(config.TEMP_DIR);
        files.forEach(file => {
          const filepath = path.join(config.TEMP_DIR, file);
          fs.unlinkSync(filepath);
        });
        if (files.length > 0) {
          console.log(`🧹 Cleaned ${files.length} temp files`);
        }
      }
    } catch (error) {
      console.error('Cleanup error:', error.message);
    }
  }, 60 * 60 * 1000); // Every hour
};

// ============ HELPER ============

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  startAutoScraper,
  startCleanupLoop
};
