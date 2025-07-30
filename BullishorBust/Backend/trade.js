require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.ALPACA_API_KEY;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const BASE_URL = 'https://paper-api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets/v1beta2';

const headers = {
  'APCA-API-KEY-ID': API_KEY,
  'APCA-API-SECRET-KEY': SECRET_KEY,
  'Content-Type': 'application/json',
};

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
  // submit the limit buy order
  console.log('Attempting to place buy for', symbol);
  const buyRes = await axios.post(
    `${BASE_URL}/v2/orders`,
    {
      symbol,
      qty,
      side: 'buy',
      type: 'limit',
      // crypto orders must be GTC
      time_in_force: 'gtc',
      limit_price: limitPrice,
    },
    { headers }
  );
  console.log('Buy order response:', buyRes.data);

  const buyOrder = buyRes.data;

  // poll until the order is filled
  let filledOrder = buyOrder;
  for (let i = 0; i < 20; i++) {
    const check = await axios.get(`${BASE_URL}/v2/orders/${buyOrder.id}`, {
      headers,
    });
    filledOrder = check.data;
    if (filledOrder.status === 'filled') break;
    await sleep(3000);
  }

  if (filledOrder.status !== 'filled') {
    throw new Error('Buy order not filled in time');
  }

  const avgPrice = parseFloat(filledOrder.filled_avg_price);
  // Mark up sell price to cover taker fees and capture desired profit
  const sellPrice = roundPrice(avgPrice * (1 + TOTAL_MARKUP));

  const sellRes = await axios.post(
    `${BASE_URL}/v2/orders`,
    {
      symbol,
      qty: filledOrder.filled_qty,
      side: 'sell',
      type: 'limit',
      // match the buy order's time in force
      time_in_force: 'gtc',
      limit_price: sellPrice,
    },
    { headers }
  );

  return { buy: filledOrder, sell: sellRes.data };
}

// Fetch latest trade price for a symbol
async function getLatestPrice(symbol) {
  const res = await axios.get(
    `${DATA_URL}/crypto/latest/trades?symbols=${symbol}`,
    { headers }
  );
  const trade = res.data.trades && res.data.trades[symbol];
  if (!trade) throw new Error(`Price not available for ${symbol}`);
  return parseFloat(trade.p);
}

// Get portfolio value and buying power from the Alpaca account
async function getAccountInfo() {
  const res = await axios.get(`${BASE_URL}/v2/account`, { headers });
  const portfolioValue = parseFloat(res.data.portfolio_value);
  const buyingPower = parseFloat(res.data.buying_power);
  const cash = parseFloat(res.data.cash);
  return {
    portfolioValue: isNaN(portfolioValue) ? 0 : portfolioValue,
    buyingPower: isNaN(buyingPower) ? 0 : buyingPower,
    cash: isNaN(cash) ? 0 : cash,
  };
}

// Round quantities to Alpaca's supported crypto precision
function roundQty(qty) {
  const factor = 1e6;
  return Math.floor(qty * factor) / factor;
}

// Round prices to two decimals
function roundPrice(price) {
  return parseFloat(Number(price).toFixed(2));
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

  const buyRes = await axios.post(
    `${BASE_URL}/v2/orders`,
    {
      symbol,
      qty,
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc',
    },
    { headers }
  );
  console.log('Buy order response:', buyRes.data);
  const buyOrder = buyRes.data;

  // Wait for fill
  let filled = buyOrder;
  for (let i = 0; i < 20; i++) {
    const chk = await axios.get(`${BASE_URL}/v2/orders/${buyOrder.id}`, {
      headers,
    });
    filled = chk.data;
    if (filled.status === 'filled') break;
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
        qty: filled.filled_qty,
        side: 'sell',
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: limitPrice,
      },
      { headers }
    );
    return { buy: filled, sell: sellRes.data };
  } catch (err) {
    console.error('Sell order failed:', err?.response?.data || err.message);
    return { buy: filled, sell: null, sellError: err.message };
  }
}

module.exports = {
  placeLimitBuyThenSell,
  placeMarketBuyThenSell,
};
