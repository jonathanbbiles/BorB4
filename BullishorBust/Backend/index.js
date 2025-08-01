require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { placeMarketBuyThenSell } = require('./trade');
const app = express();
app.use(express.json());

app.use(cors());
const API_KEY = process.env.ALPACA_API_KEY;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const BASE_URL = process.env.ALPACA_BASE_URL;
const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets/v1beta2';

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

// Sequentially place a limit buy order followed by a limit sell once filled
app.post('/trade', async (req, res) => {
  const { symbol } = req.body;
  try {
    const result = await placeMarketBuyThenSell(symbol);
    res.json(result);
  } catch (err) {
    console.error('Trade error:', err?.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/buy', async (req, res) => {
  const { symbol, qty, side, type, time_in_force, limit_price } = req.body;
  console.log('Received manual buy for:', symbol);
  const order = { symbol, qty, side, type, time_in_force, limit_price };
  console.log('Order payload:', order);

  try {
    const response = await axios.post(`${BASE_URL}/orders`, order, {
      headers,
    });
    console.log('Alpaca response:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Buy error:', error?.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
