// Add at the top of index.js after your imports
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { DateTime } = require('luxon'); // We'll add this package
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

// In-memory storage
let departures = [
  
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
    status: 'confirmed'
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
    status: 'confirmed'
  };
  
  bookings.push(booking);
  
  console.log('Bot booking created:', booking.bookingId);
  
  res.json({ success: true, message: 'Booking created via bot', booking });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'Swiss Virtual Airline API is running!',
    version: '1.0.0',
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
  console.log(`🔐 Required environment variables:`);
  console.log(`   - DISCORD_CLIENT_ID: ${process.env.DISCORD_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`   - DISCORD_CLIENT_SECRET: ${process.env.DISCORD_CLIENT_SECRET ? '✓' : '✗'}`);
  console.log(`   - BOT_SECRET_TOKEN: ${process.env.BOT_SECRET_TOKEN ? '✓' : '✗'}`);
});
