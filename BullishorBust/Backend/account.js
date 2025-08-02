// account.js
const express = require('express');
const { getAccountInfo } = require('./trade');
const router = express.Router();

router.get('/account', async (req, res) => {
  try {
    const account = await getAccountInfo();
    res.json(account);
  } catch (err) {
    console.error('Account route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };

