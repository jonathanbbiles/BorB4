require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { router: tradeRouter } = require('./trade');
const app = express();
app.use(express.json());

app.use(cors());
app.use('/api', tradeRouter);
const {
  ALPACA_API_KEY: API_KEY,
  ALPACA_SECRET_KEY: SECRET_KEY,
  ALPACA_BASE_URL: BASE_URL,
  ALPACA_DATA_URL: DATA_URL = 'https://data.alpaca.markets/v1beta2',
} = process.env;

const headers = {
  'APCA-API-KEY-ID': API_KEY,
  'APCA-API-SECRET-KEY': SECRET_KEY,
  'Content-Type': 'application/json',
};
console.log(`Alpaca credentials loaded for endpoint ${BASE_URL}`);

// Simple health check endpoint so the mobile app can verify connectivity
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// Verify Alpaca API connectivity and credentials
app.get('/ping-alpaca', async (req, res) => {
  try {
    await axios.get(`${BASE_URL}/account`, { headers });
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Ping Alpaca failed:', err?.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
