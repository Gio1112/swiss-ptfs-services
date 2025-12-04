const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for departures
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
  },
  {
    flightNumber: 'LX 180',
    destination: 'Paris CDG',
    scheduledTime: '12:30',
    estimatedTime: '12:30',
    gate: 'D45',
    status: 'Boarding',
    terminal: 'E'
  },
  {
    flightNumber: 'LX 64',
    destination: 'Tokyo Narita',
    scheduledTime: '13:20',
    estimatedTime: '13:20',
    gate: 'E32',
    status: 'On Time',
    terminal: 'E'
  }
];

// GET endpoint - Frontend fetches this
app.get('/api/departures', (req, res) => {
  res.json(departures);
});

// POST endpoint - Replace all departures
app.post('/api/departures', (req, res) => {
  departures = req.body;
  res.json({ success: true, message: 'Departures updated', count: departures.length });
});

// POST endpoint - Add a single flight
app.post('/api/departures/add', (req, res) => {
  departures.push(req.body);
  res.json({ success: true, message: 'Flight added', flight: req.body });
});

// PUT endpoint - Update a specific flight
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

// DELETE endpoint - Remove a flight
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

app.get('/', (req, res) => {
  res.json({ 
    message: 'Swiss Virtual Airline API is running!',
    endpoints: {
      'GET /api/departures': 'Get all departures',
      'POST /api/departures': 'Replace all departures',
      'POST /api/departures/add': 'Add a single flight',
      'PUT /api/departures/:flightNumber': 'Update a specific flight',
      'DELETE /api/departures/:flightNumber': 'Delete a specific flight'
    }
  });
});

app.listen(PORT, () => {
  console.log(`✈️  Swiss API running on port ${PORT}`);
});
