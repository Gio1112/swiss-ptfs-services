const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage
let departures = [
  {
    flightNumber: 'LX 8',
    destination: 'New York JFK',
    scheduledTime: '10:15',
    estimatedTime: '10:15',
    gate: 'A22',
    status: 'On Time',
    terminal: 'E'
  },
  {
    flightNumber: 'LX 160',
    destination: 'London Heathrow',
    scheduledTime: '11:45',
    estimatedTime: '11:50',
    gate: 'B18',
    status: 'Delayed',
    terminal: 'A'
  }
];

let users = {}; // Store users by Discord ID
let bookings = []; // Store all bookings
let tokens = {}; // Store auth tokens

// ==================== DEPARTURES ENDPOINTS ====================

// GET all departures
app.get('/api/departures', (req, res) => {
  res.json(departures);
});

// POST - Replace all departures
app.post('/api/departures', (req, res) => {
  departures = req.body;
  res.json({ success: true, message: 'Departures updated', count: departures.length });
});

// POST - Add a single flight
app.post('/api/departures/add', (req, res) => {
  departures.push(req.body);
  res.json({ success: true, message: 'Flight added', flight: req.body });
});

// PUT - Update a specific flight
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

// DELETE - Remove a flight
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

// POST - Discord OAuth (called from website)
app.post('/api/auth/discord', async (req, res) => {
  const { code, redirectUri } = req.body;
  
  try {
    // Exchange code for access token
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
    
    // Get user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    
    const userData = await userResponse.json();
    
    // Store user
    users[userData.id] = {
      id: userData.id,
      username: userData.username,
      discriminator: userData.discriminator,
      avatar: userData.avatar
    };
    
    // Generate auth token
    const authToken = crypto.randomBytes(32).toString('hex');
    tokens[authToken] = userData.id;
    
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

// Middleware to verify auth token
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const userId = tokens[token];
  
  if (!userId || !users[userId]) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  
  req.user = users[userId];
  next();
}

// ==================== BOOKING ENDPOINTS ====================

// POST - Create a booking
app.post('/api/bookings', verifyToken, (req, res) => {
  const { flightNumber, userId, userName } = req.body;
  
  // Check if flight exists
  const flight = departures.find(f => f.flightNumber === flightNumber);
  if (!flight) {
    return res.status(404).json({ success: false, message: 'Flight not found' });
  }
  
  // Create booking
  const booking = {
    bookingId: `SW${Date.now()}`,
    flightNumber,
    userId,
    userName,
    bookedAt: new Date().toISOString(),
    status: 'confirmed'
  };
  
  bookings.push(booking);
  
  res.json({ success: true, message: 'Booking created', booking });
});

// GET - Get user's bookings
app.get('/api/bookings/:userId', verifyToken, (req, res) => {
  const userId = req.params.userId;
  const userBookings = bookings.filter(b => b.userId === userId);
  res.json(userBookings);
});

// GET - Get all bookings (for Discord bot)
app.get('/api/bookings', (req, res) => {
  res.json(bookings);
});

// DELETE - Cancel a booking
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

// ==================== DISCORD BOT ENDPOINTS ====================

// POST - Bot can create bookings on behalf of users
app.post('/api/bot/book', (req, res) => {
  const { flightNumber, discordId, username, botToken } = req.body;
  
  // Simple bot authentication
  if (botToken !== process.env.BOT_SECRET_TOKEN) {
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
    status: 'confirmed'
  };
  
  bookings.push(booking);
  
  res.json({ success: true, message: 'Booking created via bot', booking });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Swiss PTFS API is running!',
    endpoints: {
      'GET /api/departures': 'Get all departures',
      'POST /api/departures': 'Replace all departures',
      'POST /api/departures/add': 'Add a single flight',
      'PUT /api/departures/:flightNumber': 'Update a specific flight',
      'DELETE /api/departures/:flightNumber': 'Delete a specific flight',
      'POST /api/auth/discord': 'Authenticate with Discord',
      'POST /api/bookings': 'Create a booking (requires auth)',
      'GET /api/bookings/:userId': 'Get user bookings (requires auth)',
      'POST /api/bot/book': 'Bot creates booking',
      'GET /api/bookings': 'Get all bookings'
    }
  });
});

app.listen(PORT, () => {
  console.log(`✈️  Swiss API running on port ${PORT}`);
  console.log(`🔐 Make sure to set these environment variables:`);
  console.log(`   - DISCORD_CLIENT_ID`);
  console.log(`   - DISCORD_CLIENT_SECRET`);
  console.log(`   - BOT_SECRET_TOKEN`);
});
