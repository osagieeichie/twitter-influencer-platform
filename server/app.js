// app.js - Main server file
// Save this file as: server/app.js

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Serve static files from public directory
app.use(express.static('public'));

// Serve the frontend at root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// MongoDB connection
const mongoUri = process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/twitter-platform';
console.log('Connecting to MongoDB:', mongoUri ? 'Connected' : 'No URI found');
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  twitterHandle: { type: String, required: true, unique: true },
  isVerified: { type: Boolean, default: false },
  verificationCode: { type: String },
  restPeriodUntil: { type: Date, default: Date.now },
  totalEarnings: { type: Number, default: 0 },
  performanceScore: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Campaign Schema
const campaignSchema = new mongoose.Schema({
  title: { type: String, required: true },
  brand: { type: String, required: true },
  budget: { type: Number, required: true },
  description: { type: String, required: true },
  hashtags: [String],
  mentions: [String],
  targetAudience: String,
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
  assignments: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['post', 'reply', 'retweet', 'quote'] },
    content: String,
    completed: { type: Boolean, default: false },
    assignedAt: { type: Date, default: Date.now },
    completedAt: Date,
    performance: {
      likes: { type: Number, default: 0 },
      retweets: { type: Number, default: 0 },
      replies: { type: Number, default: 0 }
    },
    earnings: { type: Number, default: 0 }
  }],
  totalEngagement: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Campaign = mongoose.model('Campaign', campaignSchema);

// Helper function to get Puppeteer config
function getPuppeteerConfig() {
  const config = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ]
  };

  // Only set executablePath for local development
  if (process.env.NODE_ENV !== 'production' && process.env.PUPPETEER_EXECUTABLE_PATH) {
    config.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  return config;
}

// Twitter Scraping Functions
async function verifyTwitterHandle(username, verificationCode) {
  let browser;
  try {
    console.log(`Verifying Twitter handle: @${username} with code: ${verificationCode}`);
    
    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();
    
    // Set user agent to avoid bot detection
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(`https://twitter.com/${username}`, {
      waitUntil: 'networkidle0',
      timeout: 45000
    });
    
    // Wait for content to load
    await page.waitForTimeout(5000);
    
    // Try multiple selectors for the bio
    let bio = '';
    
    try {
      const bioSelectors = [
        '[data-testid="UserDescription"]',
        '[data-testid="UserDescription"] span',
        '.css-901oao.r-18jsvk2.r-37j5jr.r-a023e6.r-16dba41.r-rjixqe.r-bcqeeo.r-qvutc0',
        '.css-901oao.css-16my406.r-poiln3.r-bcqeeo.r-qvutc0',
        'div[dir="ltr"] span'
      ];
      
      for (const selector of bioSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          bio = await page.$eval(selector, el => el.textContent || el.innerText || '');
          if (bio.trim()) {
            console.log(`Found bio with selector ${selector}: ${bio.substring(0, 100)}...`);
            break;
          }
        } catch (e) {
          console.log(`Selector ${selector} not found, trying next...`);
        }
      }
      
      // If still no bio, search the entire page
      if (!bio.trim()) {
        bio = await page.evaluate(() => {
          const possibleBioElements = document.querySelectorAll('span, div, p');
          for (let el of possibleBioElements) {
            const text = el.textContent || '';
            if (text.includes('VERIFY_')) {
              return text;
            }
          }
          return document.body.textContent || '';
        });
      }
      
    } catch (error) {
      console.error('Error finding bio:', error);
      bio = await page.evaluate(() => document.body.textContent || '');
    }
    
    console.log(`Bio content (first 200 chars): ${bio.substring(0, 200)}...`);
    console.log(`Looking for verification code: ${verificationCode}`);
    
    const isVerified = bio.includes(verificationCode);
    console.log(`Verification result: ${isVerified}`);
    
    return isVerified;
    
  } catch (error) {
    console.error('Error verifying Twitter handle:', error);
    return false;
  } finally {
    if (browser) await browser.close();
  }
}

async function getUserTweets(username, limit = 10) {
  let browser;
  try {
    browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();
    
    await page.goto(`https://twitter.com/${username}`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Wait for tweets to load
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 });
    
    const tweets = await page.evaluate((limit) => {
      const tweetElements = document.querySelectorAll('[data-testid="tweet"]');
      const results = [];
      
      for (let i = 0; i < Math.min(tweetElements.length, limit); i++) {
        const tweet = tweetElements[i];
        const textElement = tweet.querySelector('[lang]');
        const timeElement = tweet.querySelector('time');
        
        results.push({
          text: textElement ? textElement.textContent : '',
          timestamp: timeElement ? timeElement.getAttribute('datetime') : '',
          likes: 0, // Would need more complex scraping for accurate numbers
          retweets: 0,
          replies: 0
        });
      }
      
      return results;
    }, limit);
    
    return tweets;
  } catch (error) {
    console.error('Error getting user tweets:', error);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// Utility Functions
function generateVerificationCode() {
  return 'VERIFY_' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function assignCampaignRoles(eligibleUsers, campaignId) {
  const assignments = [];
  const roles = ['post', 'reply', 'retweet', 'quote'];
  const roleDistribution = { post: 0.2, reply: 0.3, retweet: 0.3, quote: 0.2 };
  
  roles.forEach(role => {
    const roleCount = Math.max(1, Math.floor(eligibleUsers.length * roleDistribution[role]));
    const selectedUsers = eligibleUsers
      .sort(() => 0.5 - Math.random())
      .slice(0, roleCount);
    
    selectedUsers.forEach(user => {
      assignments.push({
        userId: user._id,
        role: role,
        assignedAt: new Date(),
        content: generateRoleContent(role)
      });
    });
  });
  
  return assignments;
}

function generateRoleContent(role) {
  const templates = {
    post: "Create an original post about the campaign topic with provided hashtags",
    reply: "Reply to posts from other campaign participants with engaging comments",
    retweet: "Retweet posts from campaign participants to amplify reach",
    quote: "Quote tweet with your own commentary to add value to the conversation"
  };
  return templates[role];
}

function calculateEarnings(performance, baseRate = 0.50) {
  const { likes, retweets, replies } = performance;
  const engagementScore = (likes * 1) + (retweets * 2) + (replies * 3);
  const earnings = baseRate + (engagementScore * 0.02);
  return Math.min(earnings, 25.00); // Cap at $25 per assignment
}

// Middleware for authentication
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.userId = user.userId;
    next();
  });
};

// API Routes

// User Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, twitterHandle } = req.body;
    
    // Check if user exists
    const existingUser = await User.findOne({ 
      $or: [{ email }, { twitterHandle }] 
    });
    
    if (existingUser) {
      return res.status(400).json({ 
        error: 'Email or Twitter handle already registered' 
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Generate verification code
    const verificationCode = generateVerificationCode();
    
    // Create user
    const user = new User({
      email,
      password: hashedPassword,
      twitterHandle: twitterHandle.replace('@', ''),
      verificationCode
    });
    
    await user.save();
    
    res.status(201).json({
      message: 'User registered successfully',
      verificationCode,
      instructions: `Please add "${verificationCode}" to your Twitter bio, then click verify.`
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Verify Twitter Handle
app.post('/api/auth/verify-twitter', async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.isVerified) {
      return res.status(400).json({ error: 'Already verified' });
    }
    
    // Verify Twitter handle
    const isVerified = await verifyTwitterHandle(user.twitterHandle, user.verificationCode);
    
    if (isVerified) {
      user.isVerified = true;
      user.verificationCode = undefined;
      await user.save();
      
      res.json({ message: 'Twitter handle verified successfully!' });
    } else {
      res.status(400).json({ 
        error: 'Verification code not found in Twitter bio. Please ensure you\'ve added it correctly.' 
      });
    }
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Simple manual verification (backup method)
app.post('/api/auth/verify-twitter-simple', async (req, res) => {
  try {
    const { email, verificationCode } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.verificationCode === verificationCode) {
      user.isVerified = true;
      user.verificationCode = undefined;
      await user.save();
      
      res.json({ message: 'Twitter handle verified successfully!' });
    } else {
      res.status(400).json({ error: 'Verification code does not match' });
    }
  } catch (error) {
    console.error('Manual verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// User Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    if (!user.isVerified) {
      return res.status(400).json({ 
        error: 'Please verify your Twitter handle first',
        verificationCode: user.verificationCode
      });
    }
    
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );
    
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        twitterHandle: user.twitterHandle,
        totalEarnings: user.totalEarnings,
        performanceScore: user.performanceScore
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Create Campaign (for brands/admins)
app.post('/api/campaigns/create', authenticateToken, async (req, res) => {
  try {
    const { title, brand, budget, description, hashtags, mentions, targetAudience, duration } = req.body;
    
    const campaign = new Campaign({
      title,
      brand,
      budget,
      description,
      hashtags: hashtags || [],
      mentions: mentions || [],
      targetAudience,
      endDate: new Date(Date.now() + (duration * 24 * 60 * 60 * 1000)) // duration in days
    });
    
    await campaign.save();
    
    res.status(201).json({
      message: 'Campaign created successfully',
      campaign: campaign
    });
  } catch (error) {
    console.error('Campaign creation error:', error);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// Get Available Campaigns
app.get('/api/campaigns/available', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    // Find campaigns where user is not in rest period and hasn't participated
    const campaigns = await Campaign.find({
      isActive: true,
      endDate: { $gt: new Date() },
      'assignments.userId': { $ne: req.userId }
    }).select('-assignments');
    
    // Filter campaigns based on user's rest period
    const availableCampaigns = campaigns.filter(campaign => 
      new Date(user.restPeriodUntil) < new Date()
    );
    
    res.json(availableCampaigns);
  } catch (error) {
    console.error('Fetch campaigns error:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// Join Campaign
app.post('/api/campaigns/join/:campaignId', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const campaign = await Campaign.findById(req.params.campaignId);
    
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    // Check if user is in rest period
    if (new Date(user.restPeriodUntil) > new Date()) {
      return res.status(400).json({ 
        error: 'You are in rest period until ' + user.restPeriodUntil.toDateString() 
      });
    }
    
    // Check if user already participated
    const existingAssignment = campaign.assignments.find(
      assignment => assignment.userId.toString() === req.userId
    );
    
    if (existingAssignment) {
      return res.status(400).json({ error: 'Already participating in this campaign' });
    }
    
    // Assign role randomly
    const roles = ['post', 'reply', 'retweet', 'quote'];
    const assignedRole = roles[Math.floor(Math.random() * roles.length)];
    
    // Add assignment
    campaign.assignments.push({
      userId: req.userId,
      role: assignedRole,
      content: generateRoleContent(assignedRole),
      assignedAt: new Date()
    });
    
    await campaign.save();
    
    // Set rest period (2 days for now)
    user.restPeriodUntil = new Date(Date.now() + (2 * 24 * 60 * 60 * 1000));
    await user.save();
    
    res.json({
      message: 'Successfully joined campaign',
      assignment: {
        role: assignedRole,
        content: generateRoleContent(assignedRole),
        campaign: campaign.title
      }
    });
  } catch (error) {
    console.error('Join campaign error:', error);
    res.status(500).json({ error: 'Failed to join campaign' });
  }
});

// Get User's Assignments
app.get('/api/assignments/my', authenticateToken, async (req, res) => {
  try {
    const campaigns = await Campaign.find({
      'assignments.userId': req.userId
    }).populate('assignments.userId', 'twitterHandle');
    
    const userAssignments = [];
    
    campaigns.forEach(campaign => {
      campaign.assignments.forEach(assignment => {
        if (assignment.userId._id.toString() === req.userId) {
          userAssignments.push({
            campaignId: campaign._id,
            campaignTitle: campaign.title,
            brand: campaign.brand,
            role: assignment.role,
            content: assignment.content,
            completed: assignment.completed,
            assignedAt: assignment.assignedAt,
            performance: assignment.performance,
            earnings: assignment.earnings
          });
        }
      });
    });
    
    res.json(userAssignments);
  } catch (error) {
    console.error('Fetch assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Mark Assignment as Completed
app.post('/api/assignments/complete/:campaignId', authenticateToken, async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.campaignId);
    
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    const assignment = campaign.assignments.find(
      a => a.userId.toString() === req.userId
    );
    
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    
    if (assignment.completed) {
      return res.status(400).json({ error: 'Assignment already completed' });
    }
    
    assignment.completed = true;
    assignment.completedAt = new Date();
    
    await campaign.save();
    
    res.json({ message: 'Assignment marked as completed' });
  } catch (error) {
    console.error('Complete assignment error:', error);
    res.status(500).json({ error: 'Failed to complete assignment' });
  }
});

// Get User Dashboard Stats
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    // Get user's campaign participation stats
    const campaigns = await Campaign.find({
      'assignments.userId': req.userId
    });
    
    let totalAssignments = 0;
    let completedAssignments = 0;
    let totalEngagement = 0;
    
    campaigns.forEach(campaign => {
      campaign.assignments.forEach(assignment => {
        if (assignment.userId.toString() === req.userId) {
          totalAssignments++;
          if (assignment.completed) {
            completedAssignments++;
            totalEngagement += assignment.performance.likes + 
                              assignment.performance.retweets + 
                              assignment.performance.replies;
          }
        }
      });
    });
    
    const completionRate = totalAssignments > 0 ? 
      (completedAssignments / totalAssignments * 100).toFixed(1) : 0;
    
    res.json({
      user: {
        twitterHandle: user.twitterHandle,
        totalEarnings: user.totalEarnings,
        performanceScore: user.performanceScore
      },
      stats: {
        totalAssignments,
        completedAssignments,
        completionRate: completionRate + '%',
        totalEngagement,
        restPeriodUntil: user.restPeriodUntil,
        canParticipate: new Date(user.restPeriodUntil) < new Date()
      }
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// Debug endpoint to see what Twitter scraper finds
app.get('/api/debug/twitter/:username', async (req, res) => {
  try {
    const username = req.params.username;
    console.log(`Debug: Checking Twitter profile for @${username}`);
    
    const browser = await puppeteer.launch(getPuppeteerConfig());
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    
    await page.goto(`https://twitter.com/${username}`, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    await page.waitForTimeout(5000);
    
    // Get all page text
    const pageText = await page.evaluate(() => document.body.textContent || document.body.innerText || '');
    
    await browser.close();
    
    res.json({
      username: username,
      pageText: pageText.substring(0, 2000), // First 2000 characters
      containsVerify: pageText.includes('VERIFY_'),
      message: 'Check if your verification code appears in the page text above'
    });
    
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'Twitter Platform API is running',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health Check: ${process.env.NODE_ENV === 'production' ? 'https://your-app.railway.app' : 'http://localhost:' + PORT}/api/health`);
  console.log(`🌐 Frontend: ${process.env.NODE_ENV === 'production' ? 'https://your-app.railway.app' : 'http://localhost:' + PORT}`);
});

module.exports = app;
