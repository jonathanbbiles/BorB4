require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();

const {
  ALPACA_API_KEY: API_KEY,
  ALPACA_SECRET_KEY: SECRET_KEY,
  ALPACA_BASE_URL: BASE_URL,
} = process.env;

const headers = {
  'APCA-API-KEY-ID': API_KEY,
  'APCA-API-SECRET-KEY': SECRET_KEY,
  'Content-Type': 'application/json',
};

router.get('/account', async (req, res) => {
  try {
    const { data } = await axios.get(`${BASE_URL}/v2/account`, { headers });
    res.json(data);
  } catch (err) {
    console.error('Account fetch failed:', err?.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

router.get('/positions/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    const { data } = await axios.get(`${BASE_URL}/v2/positions/${symbol}`, { headers });
    res.json(data);
  } catch (err) {
    console.error('Position fetch failed:', err?.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

router.get('/orders', async (req, res) => {
  const query = req.originalUrl.split('?')[1] || '';
  try {
    const { data } = await axios.get(`${BASE_URL}/v2/orders${query ? '?' + query : ''}`, { headers });
    res.json(data);
  } catch (err) {
    console.error('Orders fetch failed:', err?.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

router.get('/orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data } = await axios.get(`${BASE_URL}/v2/orders/${id}`, { headers });
    res.json(data);
  } catch (err) {
    console.error('Order fetch failed:', err?.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

router.delete('/orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data } = await axios.delete(`${BASE_URL}/v2/orders/${id}`, { headers });
    res.json(data);
  } catch (err) {
    console.error('Order delete failed:', err?.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

router.post('/orders', async (req, res) => {
  try {
    const { data } = await axios.post(`${BASE_URL}/v2/orders`, req.body, { headers });
    res.json(data);
  } catch (err) {
    console.error('Order creation failed:', err?.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

module.exports = { router };
