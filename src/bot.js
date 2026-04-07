const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./database');
const { startAutoScraper, startCleanupLoop } = require('./scraper');

// Validate environment variables
if (!config.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required!');
  process.exit(1);
}

if (!config.MONGO_URI) {
  console.error('❌ MONGO_URI is required!');
  process.exit(1);
}

if (!config.CHANNEL_ID) {
  console.error('❌ CHANNEL_ID is required!');
  process.exit(1);
}

// Initialize bot
const bot = new Telegraf(config.BOT_TOKEN);

// ============ KEYBOARDS ============

const mainKeyboard = () => {
  const channelLink = config.CHANNEL_USERNAME.startsWith('@') 
    ? config.CHANNEL_USERNAME.substring(1)
    : config.CHANNEL_USERNAME;
    
  return Markup.inlineKeyboard([
    [Markup.button.callback('▶️ Next Video', 'next')],
    [
      Markup.button.callback('📊 Stats', 'stats'),
      Markup.button.url('📢 Channel', `https://t.me/${channelLink}`)
    ]
  ]);
};

// ============ COMMANDS ============

bot.start(async (ctx) => {
  try {
    const user = ctx.from;
    await db.addUser(user.id, user.username, user.first_name);
    
    const stats = await db.getGlobalStats();
    
    await ctx.reply(
      `🎬 *Welcome to Video Bot!*\n\n` +
      `📹 Total Videos: ${stats.totalVideos}\n` +
      `👥 Total Users: ${stats.totalUsers}\n` +
      `👁 Total Views: ${stats.totalViews}\n\n` +
      `Click "Next Video" to watch 👇`,
      {
        parse_mode: 'Markdown',
        ...mainKeyboard()
      }
    );
  } catch (error) {
    console.error('Start command error:', error.message);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

bot.command('admin', async (ctx) => {
  try {
    if (!config.ADMIN_IDS.includes(ctx.from.id)) {
      return;
    }
    
    const stats = await db.getGlobalStats();
    
    await ctx.reply(
      `🔐 *Admin Panel*\n\n` +
      `📹 Total Videos: ${stats.totalVideos}\n` +
      `👥 Total Users: ${stats.totalUsers}\n` +
      `👁 Total Views: ${stats.totalViews}\n\n` +
      `🤖 Bot is running on Render.com\n` +
      `⏰ Scrape interval: ${config.SCRAPE_INTERVAL_MIN} min`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Admin command error:', error.message);
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *How to use this bot:*\n\n` +
    `1️⃣ Click "Next Video" button\n` +
    `2️⃣ Watch the video\n` +
    `3️⃣ Click again for next video\n\n` +
    `🔄 New videos added automatically every ${config.SCRAPE_INTERVAL_MIN} minutes\n\n` +
    `📢 Join our channel: ${config.CHANNEL_USERNAME}`,
    { parse_mode: 'Markdown' }
  );
});

// ============ CALLBACK HANDLERS ============

bot.action('next', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    
    const video = await db.getNextUnseenVideo(ctx.from.id);
    
    if (!video) {
      await ctx.answerCbQuery(
        '⏳ No videos available yet!\nBot is scraping... Check back in a few minutes!', 
        { show_alert: true }
      );
      return;
    }
    
    const caption = 
      `🎬 ${video.title}\n` +
      `📦 ${video.sizeMb.toFixed(1)} MB\n` +
      `👁 ${video.views} views\n\n` +
      `${config.CHANNEL_USERNAME}`;
    
    await ctx.telegram.sendVideo(
      ctx.chat.id,
      video.fileId,
      {
        caption,
        supports_streaming: true,
        ...mainKeyboard()
      }
    );
    
    await db.markVideoSeen(ctx.from.id, video._id);
    
    // Delete the button message
    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore if message already deleted
    }
    
  } catch (error) {
    console.error('Next video error:', error.message);
    
    if (error.message.includes('file_id')) {
      await ctx.answerCbQuery(
        '❌ Video file not found. Bot will scrape new videos soon!',
        { show_alert: true }
      );
    } else {
      await ctx.answerCbQuery(
        '❌ Error sending video. Please try again!',
        { show_alert: true }
      );
    }
  }
});

bot.action('stats', async (ctx) => {
  try {
    const stats = await db.getGlobalStats();
    const userStats = await db.getUserStats(ctx.from.id);
    
    const message = 
      `📊 *Global Stats*\n` +
      `📹 Videos: ${stats.totalVideos}\n` +
      `👥 Users: ${stats.totalUsers}\n` +
      `👁 Views: ${stats.totalViews}\n\n` +
      `*Your Stats*\n` +
      `🎬 Watched: ${userStats?.totalVideosWatched || 0} videos`;
    
    await ctx.answerCbQuery(message, { show_alert: true });
  } catch (error) {
    console.error('Stats error:', error.message);
    await ctx.answerCbQuery('📊 Stats not available', { show_alert: true });
  }
});

// ============ ERROR HANDLING ============

bot.catch((err, ctx) => {
  console.error(`❌ Error for ${ctx.updateType}:`, err);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
});

// ============ START BOT ============

const start = async () => {
  try {
    console.log('🚀 Starting bot...');
    
    // Connect to database
    await db.connectDB();
    
    // Start background tasks
    startAutoScraper(bot);
    startCleanupLoop();
    
    // Launch bot
    await bot.launch();
    
    console.log('✅ Bot is running successfully!');
    console.log(`📢 Channel: ${config.CHANNEL_USERNAME}`);
    console.log(`⏰ Scrape interval: ${config.SCRAPE_INTERVAL_MIN} minutes`);
    console.log(`📦 Max video size: ${config.MAX_SIZE_MB} MB`);
    
    // Graceful shutdown
    process.once('SIGINT', () => {
      console.log('Stopping bot (SIGINT)...');
      bot.stop('SIGINT');
    });
    
    process.once('SIGTERM', () => {
      console.log('Stopping bot (SIGTERM)...');
      bot.stop('SIGTERM');
    });
    
  } catch (error) {
    console.error('❌ Startup error:', error.message);
    process.exit(1);
  }
};

// Start the bot
start();
