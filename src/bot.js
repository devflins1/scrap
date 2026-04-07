const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./database');
const { startAutoScraper, startCleanupLoop } = require('./scraper');

// Initialize bot
const bot = new Telegraf(config.BOT_TOKEN);

// ============ KEYBOARDS ============

const mainKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('▶️ Next Video', 'next')],
    [
      Markup.button.callback('📊 Stats', 'stats'),
      Markup.button.url('📢 Channel', `https://t.me/${config.CHANNEL_USERNAME.replace('@', '')}`)
    ]
  ]);
};

// ============ COMMANDS ============

bot.start(async (ctx) => {
  const user = ctx.from;
  await db.addUser(user.id, user.username, user.first_name);
  
  const stats = await db.getGlobalStats();
  
  await ctx.reply(
    `🎬 *Welcome to Video Bot!*\n\n` +
    `📹 Videos: ${stats.totalVideos}\n` +
    `👥 Users: ${stats.totalUsers}\n` +
    `👁 Views: ${stats.totalViews}\n\n` +
    `Click Next Video to watch 👇`,
    {
      parse_mode: 'Markdown',
      ...mainKeyboard()
    }
  );
});

bot.command('admin', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) {
    return;
  }
  
  const stats = await db.getGlobalStats();
  
  await ctx.reply(
    `🔐 *Admin Panel*\n\n` +
    `📹 Total Videos: ${stats.totalVideos}\n` +
    `👥 Total Users: ${stats.totalUsers}\n` +
    `👁 Total Views: ${stats.totalViews}`,
    { parse_mode: 'Markdown' }
  );
});

// ============ CALLBACKS ============

bot.action('next', async (ctx) => {
  await ctx.answerCbQuery();
  
  const video = await db.getNextUnseenVideo(ctx.from.id);
  
  if (!video) {
    await ctx.answerCbQuery('⏳ No videos yet! Bot is scraping...', { show_alert: true });
    return;
  }
  
  try {
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
    await ctx.deleteMessage().catch(() => {});
    
  } catch (error) {
    console.error('Send video error:', error);
    await ctx.answerCbQuery('❌ Error sending video!', { show_alert: true });
  }
});

bot.action('stats', async (ctx) => {
  const stats = await db.getGlobalStats();
  
  await ctx.answerCbQuery(
    `📊 Videos: ${stats.totalVideos} | Users: ${stats.totalUsers} | Views: ${stats.totalViews}`,
    { show_alert: true }
  );
});

// ============ ERROR HANDLING ============

bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// ============ START BOT ============

const start = async () => {
  try {
    // Connect to database
    await db.connectDB();
    
    // Start background tasks
    startAutoScraper(bot);
    startCleanupLoop();
    
    // Launch bot
    await bot.launch();
    console.log('🚀 Bot is running!');
    
    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
  } catch (error) {
    console.error('❌ Startup error:', error);
    process.exit(1);
  }
};

start();
