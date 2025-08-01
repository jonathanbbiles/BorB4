require('dotenv').config();
const axios = require('axios');

const {
  ALPACA_API_KEY: API_KEY,
  ALPACA_SECRET_KEY: SECRET_KEY,
  ALPACA_BASE_URL: BASE_URL,
  ALPACA_DATA_URL: DATA_URL,
} = process.env;

const HEADERS = {
  'APCA-API-KEY-ID': API_KEY,
  'APCA-API-SECRET-KEY': SECRET_KEY,
  'Content-Type': 'application/json',
};

const express = require('express');
const router = express.Router();

//const {
//  ALPACA_API_KEY: API_KEY,
//  ALPACA_SECRET_KEY: SECRET_KEY,
//  ALPACA_BASE_URL: BASE_URL,
//  ALPACA_DATA_URL: DATA_URL,
//} = process.env;

//const HEADERS = {
//  'APCA-API-KEY-ID': API_KEY,
//  'APCA-API-SECRET-KEY': SECRET_KEY,
//  'Content-Type': 'application/json',
//};
//console.log(`Alpaca credentials loaded for endpoint ${BASE_URL}`);

//if (!API_KEY || !SECRET_KEY || !BASE_URL) {
//  throw new Error('Missing Alpaca API credentials. Check your .env file.');
//}

const MIN_ORDER_NOTIONAL = 1; // Alpaca minimum order amount

// Offsets taker fees when calculating profit target
const FEE_BUFFER = 0.0025; // 0.25% taker fee
const TARGET_PROFIT = 0.0005; // 0.05% desired profit
const TOTAL_MARKUP = FEE_BUFFER + TARGET_PROFIT;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Places a limit buy order first, then a limit sell after the buy is filled.
async function placeLimitBuyThenSell(symbol, qty, limitPrice) {
  console.log('Attempting to place buy for', symbol);
  let buyOrder;
  try {
    const buyRes = await axios.post(
      `${BASE_URL}/v2/orders`,
      {
        symbol,
        qty,
        side: 'buy',
        type: 'limit',
        time_in_force: 'gtc', // crypto orders must be GTC
        limit_price: parseFloat(limitPrice),
      },
      { HEADERS }
    );
    console.log('Buy order response:', buyRes.);
    buyOrder = buyRes.;
  } catch (err) {
    console.error('Buy order failed:', err?.response?. || err.message);
    throw err;
  }


  // poll until the order is filled
  let filledOrder = buyOrder;
  for (let i = 0; i < 20; i++) {
    try {
      const check = await axios.get(`${BASE_URL}/v2/orders/${buyOrder.id}`, {
        HEADERS,
      });
      filledOrder = check.;
      if (filledOrder.status === 'filled') break;
    } catch (err) {
      console.error('Order status check failed:', err?.response?. || err.message);
      throw err;
    }
    await sleep(3000);
  }

  if (filledOrder.status !== 'filled') {
    throw new Error('Buy order not filled in time');
  }

  const avgPrice = parseFloat(filledOrder.filled_avg_price);
  // Mark up sell price to cover taker fees and capture desired profit
  const sellPrice = roundPrice(avgPrice * (1 + TOTAL_MARKUP));

  let sellRes;
  try {
    sellRes = await axios.post(
      `${BASE_URL}/v2/orders`,
      {
        symbol,
        qty: parseFloat(filledOrder.filled_qty),
        side: 'sell',
        type: 'limit',
        time_in_force: 'gtc', // match the buy order's time in force
        limit_price: parseFloat(sellPrice),
      },
      { HEADERS }
    );
  } catch (err) {
    console.error('Sell order failed:', err?.response?. || err.message);
    throw err;
  }

  return { buy: filledOrder, sell: sellRes. };
}

// Fetch latest trade price for a symbol
async function getLatestPrice(symbol) {
  try {
    const res = await axios.get(
      `${DATA_URL}/crypto/latest/trades?symbols=${symbol}`,
      { HEADERS }
    );
    const trade = res..trades && res..trades[symbol];
    if (!trade) throw new Error(`Price not available for ${symbol}`);
    return parseFloat(trade.p);
  } catch (err) {
    console.error('Price fetch failed:', err?.response?. || err.message);
    throw err;
  }
}

// Get portfolio value and buying power from the Alpaca account
async function getAccountInfo() {
  try {
    const res = await axios.get(`${BASE_URL}/v2/account`, { HEADERS });
    const portfolioValue = parseFloat(res.data.portfolio_value);
    const buyingPower = parseFloat(res.data.buying_power);
    const cash = parseFloat(res.data.cash);
    return {
      portfolioValue: isNaN(portfolioValue) ? 0 : portfolioValue,
      buyingPower: isNaN(buyingPower) ? 0 : buyingPower,
      cash: isNaN(cash) ? 0 : cash,
    };
  } catch (err) {
    console.error('Account info fetch failed:', err?.response?.data || err.message);
    throw err;
  }
}

// Round quantities to Alpaca's supported crypto precision
function roundQty(qty) {
  const factor = 1e6;
  return Math.floor(qty * factor) / factor;
}

// Round prices to six decimals
function roundPrice(price) {
  return parseFloat(Number(price).toFixed(6));
}

// Market buy using 10% of portfolio value then place a limit sell with markup
// covering taker fees and profit target
async function placeMarketBuyThenSell(symbol) {
  const [price, account] = await Promise.all([
    getLatestPrice(symbol),
    getAccountInfo(),
  ]);

  const portfolioValue = account.portfolioValue;
  const calculatedAllocation = portfolioValue * 0.1;
  const notional = Math.min(calculatedAllocation, account.cash);

  if (notional < MIN_ORDER_NOTIONAL) {
    console.log(`allocation_skipped_due_to_min_notional ${symbol}`);
    return { skipped: true };
  }

  const qty = roundQty(notional / price);
  if (qty <= 0) {
    console.log(`allocation_skipped_due_to_min_notional ${symbol}`);
    return { skipped: true };
  }

  console.log('Attempting to place buy for', symbol);
  console.log(`trade_executed ${symbol} for $${notional}`);

  let buyOrder;
  try {
    const buyRes = await axios.post(
      `${BASE_URL}/v2/orders`,
      {
        symbol,
        qty,
        side: 'buy',
        type: 'market',
        time_in_force: 'gtc',
      },
      { HEADERS }
    );
    console.log('Buy order response:', buyRes.data);
    buyOrder = buyRes.data;
  } catch (err) {
    console.error('Buy order failed:', err?.response?.data || err.message);
    await sleep(2000);
    try {
      const buyRes = await axios.post(
        `${BASE_URL}/v2/orders`,
        {
          symbol,
          qty,
          side: 'buy',
          type: 'market',
          time_in_force: 'gtc',
        },
        { HEADERS }
      );
      console.log('Buy order retry response:', buyRes.data);
      buyOrder = buyRes.data;
    } catch (retryErr) {
      console.error('Buy order retry failed:', retryErr?.response?.data || retryErr.message);
      throw retryErr;
    }
  }

  // Wait for fill
  let filled = buyOrder;
  for (let i = 0; i < 20; i++) {
    try {
      const chk = await axios.get(`${BASE_URL}/v2/orders/${buyOrder.id}`, {
        HEADERS,
      });
      filled = chk.data;
      if (filled.status === 'filled') break;
    } catch (err) {
      console.error('Order status check failed:', err?.response?.data || err.message);
      throw err;
    }
    await sleep(3000);
  }

  if (filled.status !== 'filled') {
    throw new Error('Buy order not filled in time');
  }

  // Wait 10 seconds before selling
  await sleep(10000);

  // Mark up sell price to cover taker fees and preserve desired profit margin
  const limitPrice = roundPrice(
    parseFloat(filled.filled_avg_price) * (1 + TOTAL_MARKUP)
  );

  try {
    const sellRes = await axios.post(
      `${BASE_URL}/v2/orders`,
      {
        symbol,
        qty: parseFloat(filled.filled_qty),
        side: 'sell',
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: parseFloat(limitPrice),
      },
      { HEADERS }
    );
    return { buy: filled, sell: sellRes.data };
  } catch (err) {
    console.error('Sell order failed:', err?.response?.data || err.message);
    return { buy: filled, sell: null, sellError: err.message };
  }
}

// Express routes
router.post('/trade', async (req, res) => {
  const { symbol } = req.body;
  try {
    const result = await placeMarketBuyThenSell(symbol);
    res.json(result);
  } catch (err) {
    console.error('Trade error:', err?.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/buy', async (req, res) => {
  const { symbol, qty, side, type, time_in_force, limit_price } = req.body;
  const order = { symbol, qty, side, type, time_in_force, limit_price };
  try {
    const response = await axios.post(`${BASE_URL}/v2/orders`, order, { HEADERS });
    res.json(response.data);
  } catch (error) {
    console.error('Buy error:', error?.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

  console.log('Attempting to place market buy for', symbol);
  try {
    const buyOrder = await axios.post(
      `${BASE_URL}/v2/orders`,
      {
        symbol,
        qty,
        side: 'buy',
        type: 'market',
        time_in_force: 'gtc',
      },
      { HEADERS }
    );

    console.log('Buy order placed:', buyOrder.data.id);

    // Wait for fill (simplified, production should use websockets or polling)
    await sleep(5000);

    console.log('Attempting to place market sell for', symbol);
    const sellOrder = await axios.post(
      `${BASE_URL}/v2/orders`,
      {
        symbol,
        qty,
        side: 'sell',
        type: 'market',
        time_in_force: 'gtc',
      },
      { HEADERS }
    );

    console.log('Sell order placed:', sellOrder.data.id);

    return { buyOrder: buyOrder.data, sellOrder: sellOrder.data };
  } catch (err) {
    console.error('Trade execution failed:', err?.response?.data || err.message);
    throw new Error('Trade failed: ' + (err.response?.data?.message || err.message));
  }
}

module.exports = {
  router,
  placeLimitBuyThenSell,
  placeMarketBuyThenSell,
};
