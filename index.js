const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { DateTime } = require('luxon');
const app = express();
const PORT = process.env.PORT || 3000;

// Helper function to convert time string to ISO timestamp for today
function timeToISO(timeString, timezone = 'Europe/Zurich') {
    const [hours, minutes] = timeString.split(':');
    const now = DateTime.now().setZone(timezone);
    const flightTime = now.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });
    return flightTime.toISO();
}

// Middleware
app.use(cors());
app.use(express.json());

// ==================== REWARDS TIER CONFIGURATION ====================
const REWARDS_TIERS = [
  { name: 'Standard', minPoints: 0, maxPoints: 19, role: 'CLUB • Swiss Standard', color: '#ff8d8d' },
  { name: 'Bronze', minPoints: 20, maxPoints: 59, role: 'CLUB • Swiss Bronze', color: '#CD7F32' },
  { name: 'Silver', minPoints: 60, maxPoints: 149, role: 'CLUB • Swiss Silver', color: '#C0C0C0' },
  { name: 'Gold', minPoints: 150, maxPoints: Infinity, role: 'CLUB • Swiss Gold', color: '#FFD700' },
];

function getTierByPoints(points) {
  return REWARDS_TIERS.find(tier => points >= tier.minPoints && points <= tier.maxPoints) || REWARDS_TIERS[0];
}

function getProgressToNextTier(points) {
  const currentTier = getTierByPoints(points);
  const currentTierIndex = REWARDS_TIERS.indexOf(currentTier);
  
  if (currentTierIndex === REWARDS_TIERS.length - 1) {
    return { isMaxTier: true, progress: 100, pointsNeeded: 0 };
  }
  
  const nextTier = REWARDS_TIERS[currentTierIndex + 1];
  const pointsInCurrentTier = points - currentTier.minPoints;
  const pointsNeededForNextTier = nextTier.minPoints - currentTier.minPoints;
  const progress = Math.floor((pointsInCurrentTier / pointsNeededForNextTier) * 100);
  const pointsNeeded = nextTier.minPoints - points;
  
  return { isMaxTier: false, progress, pointsNeeded, nextTier };
}

// In-memory storage
let departures = [];
let users = {}; // Store users by Discord ID
let bookings = []; // Store all bookings
let tokens = {}; // Store auth tokens
let rewardsAccounts = {}; // userId -> { points, flightsCompleted, tier, lastFlightDate }

// ==================== REWARDS HELPER FUNCTIONS ====================

function getRewardsAccount(userId) {
  if (!rewardsAccounts[userId]) {
    rewardsAccounts[userId] = {
      userId,
      points: 0,
      flightsCompleted: 0,
      tier: 'Standard',
      lastFlightDate: null,
      joinDate: new Date().toISOString()
    };
  }
  return rewardsAccounts[userId];
}

function updateRewardsAccount(userId, updates) {
  const account = getRewardsAccount(userId);
  Object.assign(account, updates);
  
  // Update tier based on points
  const newTier = getTierByPoints(account.points);
  account.tier = newTier.name;
  
  return account;
}

// ==================== DEPARTURES ENDPOINTS ====================

app.get('/api/departures', (req, res) => {
  res.json(departures);
});

app.post('/api/departures', (req, res) => {
  departures = req.body;
  res.json({ success: true, message: 'Departures updated', count: departures.length });
});

app.post('/api/departures/add', (req, res) => {
  const flight = req.body;

  if (flight.scheduledTime && !flight.scheduledTime.includes('T')) {
    flight.scheduledTime = timeToISO(flight.scheduledTime);
  }
  if (flight.estimatedTime && !flight.estimatedTime.includes('T')) {
    flight.estimatedTime = timeToISO(flight.estimatedTime);
  }

  departures.push(flight);
  res.json({ success: true, message: 'Flight added', flight });
});

app.put('/api/departures/:flightNumber', (req, res) => {
  const flightNumber = req.params.flightNumber;
  const index = departures.findIndex(f => f.flightNumber === flightNumber);
  
  if (index !== -1) {
    departures[index] = { ...departures[index], ...req.body };
    res.json({ success: true, message: 'Flight updated', flight: departures[index] });
  } else {
    res.status(404).json({ success: false, message: 'Flight not found' });
  }
});

app.delete('/api/departures/:flightNumber', (req, res) => {
  const flightNumber = req.params.flightNumber;
  const initialLength = departures.length;
  departures = departures.filter(f => f.flightNumber !== flightNumber);
  
  if (departures.length < initialLength) {
    res.json({ success: true, message: 'Flight deleted' });
  } else {
    res.status(404).json({ success: false, message: 'Flight not found' });
  }
});

// ==================== AUTH ENDPOINTS ====================

app.post('/api/auth/discord', async (req, res) => {
  const { code, redirectUri } = req.body;
  
  console.log('Auth request received:', { hasCode: !!code, redirectUri });
  
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    if (tokenData.error) {
      console.error('Discord token error:', tokenData);
      return res.status(400).json({ success: false, message: tokenData.error_description || 'Auth failed' });
    }
    
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    
    const userData = await userResponse.json();
    
    console.log('User authenticated:', userData.username);
    
    users[userData.id] = {
      id: userData.id,
      username: userData.username,
      discriminator: userData.discriminator,
      avatar: userData.avatar
    };
    
    // Initialize rewards account if it doesn't exist
    getRewardsAccount(userData.id);
    
    const authToken = crypto.randomBytes(32).toString('hex');
    tokens[authToken] = userData.id;
    
    console.log('Token generated for user:', userData.username);
    
    res.json({
      success: true,
      token: authToken,
      user: users[userData.id]
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ success: false, message: 'Authentication failed' });
  }
});

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    console.log('No authorization header');
    return res.status(401).json({ success: false, message: 'No authorization header' });
  }
  
  const token = authHeader.replace('Bearer ', '');
  const userId = tokens[token];
  
  if (!userId || !users[userId]) {
    console.log('Invalid token or user not found');
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
  
  req.user = users[userId];
  console.log('Token verified for user:', req.user.username);
  next();
}

// ==================== BOOKING ENDPOINTS ====================

app.post('/api/bookings', verifyToken, (req, res) => {
  const { flightNumber } = req.body;
  
  console.log('Booking request:', { flightNumber, user: req.user.username });
  
  const flight = departures.find(f => f.flightNumber === flightNumber);
  if (!flight) {
    return res.status(404).json({ success: false, message: 'Flight not found' });
  }
  
  const booking = {
    bookingId: `SW${Date.now()}`,
    flightNumber,
    userId: req.user.id,
    userName: req.user.username,
    bookedAt: new Date().toISOString(),
    status: 'confirmed',
    pointsAwarded: false
  };
  
  bookings.push(booking);
  
  console.log('Booking created:', booking.bookingId);
  
  res.json({ success: true, message: 'Booking created', booking });
});

app.get('/api/bookings/:userId', verifyToken, (req, res) => {
  const userId = req.params.userId;
  const userBookings = bookings.filter(b => b.userId === userId);
  console.log(`Fetching bookings for user ${userId}:`, userBookings.length);
  res.json(userBookings);
});

app.get('/api/bookings', (req, res) => {
  res.json(bookings);
});

app.delete('/api/bookings/:bookingId', verifyToken, (req, res) => {
  const bookingId = req.params.bookingId;
  const initialLength = bookings.length;
  bookings = bookings.filter(b => b.bookingId !== bookingId);
  
  if (bookings.length < initialLength) {
    res.json({ success: true, message: 'Booking cancelled' });
  } else {
    res.status(404).json({ success: false, message: 'Booking not found' });
  }
});

// ==================== REWARDS ENDPOINTS ====================

// GET user rewards account
app.get('/api/rewards/:userId', verifyToken, (req, res) => {
  const userId = req.params.userId;
  const account = getRewardsAccount(userId);
  const progress = getProgressToNextTier(account.points);
  
  res.json({
    success: true,
    account,
    progress,
    tier: getTierByPoints(account.points)
  });
});

// GET leaderboard
app.get('/api/rewards/leaderboard', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  
  const sortedAccounts = Object.values(rewardsAccounts)
    .sort((a, b) => b.points - a.points);
  
  const totalPages = Math.ceil(sortedAccounts.length / perPage);
  const startIndex = (page - 1) * perPage;
  const pageAccounts = sortedAccounts.slice(startIndex, startIndex + perPage);
  
  const leaderboard = pageAccounts.map((account, index) => ({
    ...account,
    rank: startIndex + index + 1,
    tier: getTierByPoints(account.points)
  }));
  
  res.json({
    success: true,
    leaderboard,
    page,
    totalPages,
    total: sortedAccounts.length
  });
});

// POST - Award points (admin only)
app.post('/api/rewards/award', verifyToken, (req, res) => {
  const { userId, points, isFlightCompletion, reason } = req.body;
  
  // In production, check if req.user is admin
  const ADMIN_IDS = ['882901706587910144'];
  if (!ADMIN_IDS.includes(req.user.id)) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  
  const account = getRewardsAccount(userId);
  const oldTier = getTierByPoints(account.points);
  
  const updates = {
    points: account.points + points
  };
  
  if (isFlightCompletion) {
    updates.flightsCompleted = account.flightsCompleted + 1;
    updates.lastFlightDate = new Date().toISOString();
  }
  
  const updatedAccount = updateRewardsAccount(userId, updates);
  const newTier = getTierByPoints(updatedAccount.points);
  
  console.log(`Points awarded: ${points} to user ${userId}`, { reason, isFlightCompletion });
  
  res.json({
    success: true,
    message: 'Points awarded',
    account: updatedAccount,
    tierChanged: oldTier.name !== newTier.name,
    oldTier,
    newTier
  });
});

// POST - Complete flight and award points
app.post('/api/rewards/complete-flight', verifyToken, (req, res) => {
  const { bookingId, points } = req.body;
  const defaultPoints = points || 5;
  
  const booking = bookings.find(b => b.bookingId === bookingId && b.userId === req.user.id);
  
  if (!booking) {
    return res.status(404).json({ success: false, message: 'Booking not found' });
  }
  
  if (booking.pointsAwarded) {
    return res.status(400).json({ success: false, message: 'Points already awarded for this flight' });
  }
  
  const account = getRewardsAccount(req.user.id);
  const oldTier = getTierByPoints(account.points);
  
  const updatedAccount = updateRewardsAccount(req.user.id, {
    points: account.points + defaultPoints,
    flightsCompleted: account.flightsCompleted + 1,
    lastFlightDate: new Date().toISOString()
  });
  
  booking.pointsAwarded = true;
  booking.pointsEarned = defaultPoints;
  
  const newTier = getTierByPoints(updatedAccount.points);
  
  console.log(`Flight completed: ${bookingId}, ${defaultPoints} points awarded to ${req.user.username}`);
  
  res.json({
    success: true,
    message: 'Flight completed and points awarded',
    pointsEarned: defaultPoints,
    account: updatedAccount,
    tierChanged: oldTier.name !== newTier.name,
    oldTier,
    newTier
  });
});

// GET all tiers info
app.get('/api/rewards/tiers', (req, res) => {
  res.json({
    success: true,
    tiers: REWARDS_TIERS
  });
});

// ==================== DISCORD BOT ENDPOINTS ====================

app.post('/api/bot/book', (req, res) => {
  const { flightNumber, discordId, username, botToken } = req.body;
  
  console.log('Bot booking request:', { flightNumber, discordId, username });
  
  if (botToken !== process.env.BOT_SECRET_TOKEN) {
    console.log('Invalid bot token');
    return res.status(401).json({ success: false, message: 'Invalid bot token' });
  }
  
  const flight = departures.find(f => f.flightNumber === flightNumber);
  if (!flight) {
    return res.status(404).json({ success: false, message: 'Flight not found' });
  }
  
  const booking = {
    bookingId: `SW${Date.now()}`,
    flightNumber,
    userId: discordId,
    userName: username,
    bookedAt: new Date().toISOString(),
    status: 'confirmed',
    pointsAwarded: false
  };
  
  bookings.push(booking);
  
  // Initialize rewards account if needed
  getRewardsAccount(discordId);
  
  console.log('Bot booking created:', booking.bookingId);
  
  res.json({ success: true, message: 'Booking created via bot', booking });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'Swiss Virtual Airline API is running!',
    version: '2.0.0',
    features: ['Departures', 'Bookings', 'Rewards System', 'Discord Integration'],
    endpoints: {
      departures: {
        'GET /api/departures': 'Get all departures',
        'POST /api/departures/add': 'Add a flight',
        'PUT /api/departures/:flightNumber': 'Update a flight',
        'DELETE /api/departures/:flightNumber': 'Delete a flight'
      },
      auth: {
        'POST /api/auth/discord': 'Authenticate with Discord'
      },
      bookings: {
        'POST /api/bookings': 'Create a booking (requires auth)',
        'GET /api/bookings/:userId': 'Get user bookings (requires auth)',
        'GET /api/bookings': 'Get all bookings',
        'DELETE /api/bookings/:bookingId': 'Cancel booking (requires auth)'
      },
      rewards: {
        'GET /api/rewards/:userId': 'Get user rewards account (requires auth)',
        'GET /api/rewards/leaderboard': 'Get rewards leaderboard',
        'POST /api/rewards/award': 'Award points (admin only)',
        'POST /api/rewards/complete-flight': 'Complete flight and earn points (requires auth)',
        'GET /api/rewards/tiers': 'Get all tier information'
      },
      bot: {
        'POST /api/bot/book': 'Bot creates booking (requires bot token)'
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`✈️  Swiss API with Rewards System running on port ${PORT}`);
  console.log(`🔐 Required environment variables:`);
  console.log(`   - DISCORD_CLIENT_ID: ${process.env.DISCORD_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`   - DISCORD_CLIENT_SECRET: ${process.env.DISCORD_CLIENT_SECRET ? '✓' : '✗'}`);
  console.log(`   - BOT_SECRET_TOKEN: ${process.env.BOT_SECRET_TOKEN ? '✓' : '✗'}`);
  console.log(`🎯 Rewards System Tiers:`, REWARDS_TIERS.map(t => `${t.name} (${t.minPoints}-${t.maxPoints === Infinity ? '∞' : t.maxPoints})`).join(', '));
});
