const mongoose = require('mongoose');
const config = require('./config');

// ============ SCHEMAS ============

const videoSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  fileId: { type: String, required: true },
  sizeMb: { type: Number, required: true },
  thumbnail: String,
  duration: Number,
  views: { type: Number, default: 0 },
  channelPosted: { type: Boolean, default: true },
  addedAt: { type: Date, default: Date.now, index: true }
});

const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true, index: true },
  username: String,
  firstName: String,
  totalVideosWatched: { type: Number, default: 0 },
  seenVideos: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Video' }],
  joinedAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

const scrapeQueueSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending', index: true },
  retries: { type: Number, default: 0 },
  addedAt: { type: Date, default: Date.now, index: true },
  error: String
});

// ============ MODELS ============

const Video = mongoose.model('Video', videoSchema);
const User = mongoose.model('User', userSchema);
const ScrapeQueue = mongoose.model('ScrapeQueue', scrapeQueueSchema);

// ============ DATABASE CONNECTION ============

const connectDB = async () => {
  try {
    await mongoose.connect(config.MONGO_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ MongoDB connected');
    
    // Create indexes
    await Video.createIndexes();
    await User.createIndexes();
    await ScrapeQueue.createIndexes();
    
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// ============ VIDEO FUNCTIONS ============

const addVideo = async (videoData) => {
  try {
    const video = new Video(videoData);
    await video.save();
    console.log(`✅ New video added: ${videoData.title.substring(0, 50)}`);
    return video;
  } catch (error) {
    if (error.code === 11000) {
      console.log(`⚠️ Video already exists: ${videoData.url}`);
      return null;
    }
    console.error('❌ Add video error:', error);
    return null;
  }
};

const videoExists = async (url) => {
  return await Video.exists({ url });
};

const getNextUnseenVideo = async (userId) => {
  const user = await User.findOne({ userId }).select('seenVideos');
  const seenIds = user?.seenVideos?.slice(-100) || [];
  
  let video = await Video.findOne({ _id: { $nin: seenIds } })
    .sort({ addedAt: -1 })
    .lean();
  
  // If all seen, reset
  if (!video) {
    await User.updateOne({ userId }, { $set: { seenVideos: [] } });
    video = await Video.findOne().sort({ addedAt: -1 }).lean();
  }
  
  return video;
};

const markVideoSeen = async (userId, videoId) => {
  await User.updateOne(
    { userId },
    {
      $push: {
        seenVideos: {
          $each: [videoId],
          $slice: -100 // Keep only last 100
        }
      },
      $inc: { totalVideosWatched: 1 },
      $set: { lastActive: new Date() }
    },
    { upsert: true }
  );
  
  await Video.updateOne({ _id: videoId }, { $inc: { views: 1 } });
};

const getTotalVideos = async () => {
  return await Video.estimatedDocumentCount();
};

// ============ USER FUNCTIONS ============

const addUser = async (userId, username, firstName) => {
  await User.updateOne(
    { userId },
    {
      $set: {
        username,
        firstName,
        lastActive: new Date()
      },
      $setOnInsert: {
        joinedAt: new Date(),
        totalVideosWatched: 0,
        seenVideos: []
      }
    },
    { upsert: true }
  );
};

const getUserStats = async (userId) => {
  return await User.findOne({ userId }).lean();
};

const getTotalUsers = async () => {
  return await User.estimatedDocumentCount();
};

// ============ SCRAPE QUEUE FUNCTIONS ============

const addToScrapeQueue = async (urls) => {
  const docs = urls.map(url => ({ url, status: 'pending' }));
  
  try {
    await ScrapeQueue.insertMany(docs, { ordered: false });
  } catch (error) {
    // Ignore duplicate errors
    if (error.code !== 11000) {
      console.error('Queue insert error:', error);
    }
  }
};

const getPendingBatch = async (limit = 5) => {
  const items = await ScrapeQueue.find({
    status: 'pending',
    retries: { $lt: 3 }
  })
    .sort({ addedAt: 1 })
    .limit(limit);
  
  if (items.length > 0) {
    const ids = items.map(item => item._id);
    await ScrapeQueue.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'processing' } }
    );
  }
  
  return items;
};

const markScrapeDone = async (queueId) => {
  await ScrapeQueue.deleteOne({ _id: queueId });
};

const markScrapeFailed = async (queueId, error) => {
  await ScrapeQueue.updateOne(
    { _id: queueId },
    {
      $set: { status: 'pending', error },
      $inc: { retries: 1 }
    }
  );
};

const cleanupOldQueue = async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await ScrapeQueue.deleteMany({ addedAt: { $lt: cutoff } });
};

// ============ STATS ============

const getGlobalStats = async () => {
  const totalVideos = await getTotalVideos();
  const totalUsers = await getTotalUsers();
  
  const viewsResult = await Video.aggregate([
    { $group: { _id: null, totalViews: { $sum: '$views' } } }
  ]);
  
  const totalViews = viewsResult[0]?.totalViews || 0;
  
  return { totalVideos, totalUsers, totalViews };
};

module.exports = {
  connectDB,
  addVideo,
  videoExists,
  getNextUnseenVideo,
  markVideoSeen,
  getTotalVideos,
  addUser,
  getUserStats,
  getTotalUsers,
  addToScrapeQueue,
  getPendingBatch,
  markScrapeDone,
  markScrapeFailed,
  cleanupOldQueue,
  getGlobalStats
};
