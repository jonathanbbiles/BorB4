import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  Switch,
  Alert,
} from 'react-native';

/*
 * This component implements a simple crypto trading dashboard for Alpaca.  It
 * tracks a predefined list of crypto pairs, calculates a handful of
 * technical indicators (RSI, MACD and a simple linear‐regression trend
 * indicator) from minute data provided by CoinGecko and then exposes
 * manual and automatic trade actions against the Alpaca paper trading API.
 *
 * This version addresses a critical bug in the buy logic.  In prior
 * iterations the notional used for a market buy order was derived from
 * the raw target allocation rather than the adjusted allocation that
 * accounted for safety margins and buffers.  As a result, the app would
 * occasionally request more notional value than the account’s available
 * cash, leading to order rejections.  The fix ensures that the final
 * notional is based off of the protected allocation and never exceeds
 * the appropriate buying power for crypto trades.
 *
 * In addition, crypto trades rely on settled cash only.  Alpaca
 * exposes a `non_marginable_buying_power` attribute which reflects the
 * amount of cash that can be used to purchase crypto.  According to
 * Alpaca’s support documentation, securities transactions take two
 * business days to settle, so cash resulting from an equity sale may
 * not be immediately available for crypto orders.  We therefore use
 * `non_marginable_buying_power` (falling back to `buying_power` or
 * `cash` if it’s unavailable) when computing how much capital can be
 * allocated to a crypto purchase【247783379990709†L355-L359】.
 *
 * Finally, Alpaca automatically applies a 2 % price collar to market
 * orders to protect users from rapid price movements.  To ensure that
 * our notional requests never overshoot the available cash after this
 * collar is applied, we incorporate an extra buffer into the
 * allocation calculation.  Specifically, the safety factor reduces
 * the prospective allocation by an amount greater than the collar
 * (3 % total) which, combined with a small fixed safety margin, keeps
 * the eventual limit price well within the account’s buying power.
 */

// API credentials are expected to be provided via environment variables.
// If they are missing the app will still run but trading requests will fail.
// For temporary testing we hardcode the credentials. Remove before committing
// to production.
const ALPACA_KEY = 'PKGY01ABISEXQJZX5L7M';
const ALPACA_SECRET = 'PwJAEwLnLnsf7qAVvFutE8VIMgsAgvi7PMkMcCca';
const ALPACA_BASE_URL = 'https://paper-api.alpaca.markets/v2';

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json',
};

// Crypto orders require GTC time in force
const CRYPTO_TIME_IN_FORCE = 'gtc';

// === Trading strategy constants ===
// Cooldown between trades on the same symbol (30 minutes)
const COOL_DOWN_MS = 30 * 60 * 1000;
// Limit buy buffer - 0.1% below current price
const BUY_LIMIT_BUFFER = 0.999;
// Profit target for limit sells increased to offset fees (1.75%)
const PROFIT_TARGET_PERCENT = 0.0175;
// Stop loss if price falls 2.5% from entry
const STOP_LOSS_PERCENT = 0.025;

// Refresh interval used throughout the app
const REFRESH_INTERVAL_MS = 60000;

// Track per-position metadata such as entry timestamp and price
let positionMeta = {};
// Track pending limit buy orders for retry logic
let pendingLimitOrders = {};

// Track tokens that ran out of funds this cycle
let perSymbolFundsLock = {};
// Track timestamp of last trade per symbol
let lastTradeTime = {};

// Allow components to subscribe to log entries so they can display them
let logSubscriber = null;
export const registerLogSubscriber = (fn) => {
  logSubscriber = fn;
};

// Simple logger to trace trade attempts.
// It timestamps each event and prints to the console.
// Optionally send logs to your own endpoint or save to device storage.
// Adapt `sendToServer` as needed, or remove it if you don't have a server.
const logTradeAction = async (type, symbol, details = {}) => {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, symbol, ...details };
  // Always log locally to the Metro/Device console
  console.log('[TRADE LOG]', entry);
  // If a subscriber is registered, forward the entry
  if (typeof logSubscriber === 'function') {
    try {
      logSubscriber(entry);
    } catch (err) {
      console.warn('Log subscriber error:', err);
    }
  }
  // Example: Send log to your server (optional)
  // try {
  //   await fetch('https://yourloggingendpoint.example.com/log', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(entry),
  //   });
  // } catch (err) {
  //   console.warn('Failed to send log:', err.message);
  // }
};

// List of crypto pairs we want to follow. Each entry defines the
// Alpaca symbol, the CryptoCompare base symbol used for pricing (cc),
// and the CoinGecko id.
const ORIGINAL_TOKENS = [
  { name: 'BTC/USD', symbol: 'BTCUSD', cc: 'BTC', gecko: 'bitcoin' },
  { name: 'ETH/USD', symbol: 'ETHUSD', cc: 'ETH', gecko: 'ethereum' },
  { name: 'SOL/USD', symbol: 'SOLUSD', cc: 'SOL', gecko: 'solana' },
  { name: 'LTC/USD', symbol: 'LTCUSD', cc: 'LTC', gecko: 'litecoin' },
  { name: 'BCH/USD', symbol: 'BCHUSD', cc: 'BCH', gecko: 'bitcoin-cash' },
  { name: 'DOGE/USD', symbol: 'DOGEUSD', cc: 'DOGE', gecko: 'dogecoin' },
  { name: 'AVAX/USD', symbol: 'AVAXUSD', cc: 'AVAX', gecko: 'avalanche-2' },
  { name: 'ADA/USD', symbol: 'ADAUSD', cc: 'ADA', gecko: 'cardano' },
  { name: 'AAVE/USD', symbol: 'AAVEUSD', cc: 'AAVE', gecko: 'aave' },
  { name: 'UNI/USD', symbol: 'UNIUSD', cc: 'UNI', gecko: 'uniswap' },
  { name: 'MATIC/USD', symbol: 'MATICUSD', cc: 'MATIC', gecko: 'matic-network' },
  { name: 'LINK/USD', symbol: 'LINKUSD', cc: 'LINK', gecko: 'chainlink' },
  { name: 'SHIB/USD', symbol: 'SHIBUSD', cc: 'SHIB', gecko: 'shiba-inu' },
  { name: 'XRP/USD', symbol: 'XRPUSD', cc: 'XRP', gecko: 'ripple' },
  { name: 'USDT/USD', symbol: 'USDTUSD', cc: 'USDT', gecko: 'tether' },
  { name: 'USDC/USD', symbol: 'USDCUSD', cc: 'USDC', gecko: 'usd-coin' },
  { name: 'TRX/USD', symbol: 'TRXUSD', cc: 'TRX', gecko: 'tron' },
  { name: 'ETC/USD', symbol: 'ETCUSD', cc: 'ETC', gecko: 'ethereum-classic' },
];

export default function App() {
  const [tracked] = useState(ORIGINAL_TOKENS);
  const [data, setData] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  // Auto trading is always enabled
  const autoTrade = true;
  const [hideOthers, setHideOthers] = useState(false);
  const [notification, setNotification] = useState(null);
  const [logHistory, setLogHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [portfolioValue, setPortfolioValue] = useState(0);
  const [dailyChangePercent, setDailyChangePercent] = useState(0);
  const intervalRef = useRef(null);

  // Subscribe to log events and keep only the most recent five entries
  useEffect(() => {
    registerLogSubscriber((entry) => {
      setLogHistory((prev) => [entry, ...prev].slice(0, 5));
    });
  }, []);

  // Helper to update the toast notification. Notifications last five seconds
  // to give users ample time to read them.
  const showNotification = (message) => {
    setNotification(message);
    setTimeout(() => setNotification(null), 5000);
  };

  // Basic RSI implementation using a simple moving average of gains and
  // losses.  Returns null if insufficient data is provided.
  const calcRSI = (closes, period = 14) => {
    if (!Array.isArray(closes) || closes.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const delta = closes[i] - closes[i - 1];
      if (delta > 0) gains += delta; else losses -= delta;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  };

  // Determine whether prices are trending up or down by performing a
  // least-squares linear regression over the last 30 closes.  The magic
  // numbers here were chosen heuristically: slopes above 0.02 are treated
  // as up, below -0.02 as down.  The slope is also returned so callers
  // can decide if the market is trending strongly.
  const getTrendSymbol = (closes) => {
    const N = 30;
    if (!Array.isArray(closes) || closes.length < N) {
      return { symbol: '🟰', slope: 0 };
    }
    const x = Array.from({ length: N }, (_, i) => i);
    const y = closes.slice(-N);
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const slope = (N * sumXY - sumX * sumY) / (N * sumX2 - sumX * sumX);
    const symbol = slope > 0.02 ? '⬆️' : slope < -0.02 ? '⬇️' : '🟰';
    return { symbol, slope };
  };

  // Compute the MACD line (difference between two EMAs) and its signal
  // line (EMA of the MACD line).  If there is insufficient data this
  // function returns {macd: null, signal: null}.
  const calcMACD = (closes, short = 12, long = 26, signalPeriod = 9) => {
    if (!Array.isArray(closes) || closes.length < long + signalPeriod) {
      return { macd: null, signal: null };
    }
    const kShort = 2 / (short + 1);
    const kLong = 2 / (long + 1);
    const kSig = 2 / (signalPeriod + 1);
    let emaShort = closes[0];
    let emaLong = closes[0];
    const macdLine = [];
    closes.forEach((price) => {
      emaShort = price * kShort + emaShort * (1 - kShort);
      emaLong = price * kLong + emaLong * (1 - kLong);
      macdLine.push(emaShort - emaLong);
    });
    let signal = macdLine[0];
    for (let i = 1; i < macdLine.length; i++) {
      signal = macdLine[i] * kSig + signal * (1 - kSig);
    }
    return { macd: macdLine[macdLine.length - 1], signal };
  };

  // Retrieve the current position for a given symbol.  Returns null if
  // nothing is held or if the request fails.
  const getPositionInfo = async (symbol) => {
    try {
      const res = await fetch(`${ALPACA_BASE_URL}/positions/${symbol}`, {
        headers: HEADERS,
      });
      if (!res.ok) return null;
      const info = await res.json();
      const qty = parseFloat(info.qty);
      const basis = parseFloat(info.avg_entry_price);
      const available = parseFloat(
        info.qty_available ?? info.available ?? info.qty
      );
      if (isNaN(available) || available <= 0) return null;
      return {
        qty: parseFloat(Number(qty).toFixed(6)),
        basis,
        available,
      };
    } catch (err) {
      console.error('getPositionInfo error:', err);
      return null;
    }
  };

  // Check for any open orders on the given symbol.  Alpaca allows
  // filtering the orders list by symbol using the `symbols` query
  // parameter.  If this call fails we optimistically return an empty
  // array so that the trade logic continues.
  const getOpenOrders = async (symbol) => {
    try {
      const res = await fetch(
        `${ALPACA_BASE_URL}/orders?status=open&symbols=${symbol}`,
        { headers: HEADERS }
      );
      if (!res.ok) {
        const txt = await res.text();
        console.warn(`getOpenOrders failed ${res.status}:`, txt);
        return [];
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('getOpenOrders error:', err);
      return [];
    }
  };

  // Force close a position at market price
  const closePositionMarket = async (symbol, qty) => {
    if (!qty || qty <= 0) return;
    const order = {
      symbol,
      qty,
      side: 'sell',
      type: 'market',
      time_in_force: CRYPTO_TIME_IN_FORCE,
    };
    logTradeAction('forced_exit_attempt', symbol, { qty });
    try {
      const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(order),
      });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { raw }; }
      if (res.ok && data.id) {
        logTradeAction('forced_exit_success', symbol, { id: data.id });
        showNotification(`🚨 Forced exit ${symbol}`);
        delete positionMeta[symbol];
      } else {
        const msg = data?.message || raw;
        logTradeAction('forced_exit_failed', symbol, { status: res.status, reason: msg });
        showNotification(`❌ Forced exit failed ${symbol}`);
      }
    } catch (err) {
      logTradeAction('forced_exit_error', symbol, { error: err.message });
    }
  };

  // Verify a limit buy filled, otherwise retry with market buy
  const verifyLimitBuyFilled = async (symbol, ccSymbol) => {
    const pending = pendingLimitOrders[symbol];
    if (!pending) return;
    try {
      const res = await fetch(`${ALPACA_BASE_URL}/orders/${pending.orderId}`, { headers: HEADERS });
      const data = await res.json();
      if (data.status === 'filled') {
        delete pendingLimitOrders[symbol];
        return;
      }
    } catch (err) {
      // if check fails just exit
      return;
    }

    // Fetch fresh data to confirm signal validity
    try {
      const priceUrl = `https://min-api.cryptocompare.com/data/price?fsym=${ccSymbol}&tsyms=USD`;
      const histoUrl = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${ccSymbol}&tsym=USD&limit=52&aggregate=15`;
      const [pRes, hRes] = await Promise.all([fetch(priceUrl), fetch(histoUrl)]);
      const priceData = await pRes.json();
      const histoData = await hRes.json();
      const price = priceData?.USD;
      const bars = Array.isArray(histoData?.Data?.Data) ? histoData.Data.Data : [];
      const closes = bars.map((b) => b.close).filter((c) => typeof c === 'number');
      const r = calcRSI(closes);
      const rPrev = calcRSI(closes.slice(0, -1));
      const macd = calcMACD(closes);
      const macdPrev = calcMACD(closes.slice(0, -1));
      const trend = getTrendSymbol(closes);
      const signalValid =
        macd.macd != null &&
        macd.signal != null &&
        macdPrev.macd != null &&
        macdPrev.signal != null &&
        r != null &&
        rPrev != null &&
        macd.macd > macd.signal &&
        macd.macd - macd.signal > macdPrev.macd - macdPrev.signal &&
        r > 45 && r > rPrev &&
        trend.slope > 0.015;

      if (signalValid) {
        // cancel existing limit
        await fetch(`${ALPACA_BASE_URL}/orders/${pending.orderId}`, { method: 'DELETE', headers: HEADERS });
        const order = {
          symbol,
          notional: pending.notional,
          side: 'buy',
          type: 'market',
          time_in_force: CRYPTO_TIME_IN_FORCE,
        };
        const res2 = await fetch(`${ALPACA_BASE_URL}/orders`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(order),
        });
        const raw = await res2.text();
        let data2;
        try { data2 = JSON.parse(raw); } catch { data2 = { raw }; }
        if (res2.ok && data2.id) {
          logTradeAction('buy_retry_market', symbol, { id: data2.id });
          showNotification(`🔄 Market buy retry ${symbol}`);
          lastTradeTime[symbol] = Date.now();
          positionMeta[symbol] = { entryTimestamp: Date.now(), entryPrice: price };
          delete pendingLimitOrders[symbol];
          setTimeout(() => placeLimitSell(symbol), 5000);
        } else {
          logTradeAction('buy_retry_failed', symbol, { reason: data2.message || raw });
        }
      } else {
        // Signal no longer valid - just cancel the limit
        await fetch(`${ALPACA_BASE_URL}/orders/${pending.orderId}`, { method: 'DELETE', headers: HEADERS });
        delete pendingLimitOrders[symbol];
        logTradeAction('buy_cancel_signal_lost', symbol, {});
      }
    } catch (err) {
      logTradeAction('buy_retry_error', symbol, { error: err.message });
    }
  };

  // Place a limit sell order using the latest position information from
  // Alpaca. The function silently skips if the quantity is zero or below
  // Alpaca's minimum trade size (~$1 notional). Logs and notifications are
  // emitted for every attempt.
  const placeLimitSell = async (symbol, currentPrice = null, currentRsi = null) => {
    // Always re-fetch the position to ensure we have the live balance
    const position = await getPositionInfo(symbol);
    if (!position) {
      logTradeAction('sell_skip_reason', symbol, {
        reason: 'no position held',
      });
      console.log(`[SELL SKIPPED] No position held for ${symbol}`);
      return;
    }

    const qtyRaw = parseFloat(position.available);
    const basis = parseFloat(position.basis);
    if (!qtyRaw || qtyRaw <= 0 || !basis || basis <= 0) {
      logTradeAction('sell_skip_reason', symbol, {
        reason: 'invalid qty or basis',
        availableQty: qtyRaw,
        basisPrice: basis,
      });
      console.log(
        `[SELL SKIPPED] Invalid qty or basis for ${symbol}: qty=${qtyRaw}, basis=${basis}`
      );
      return;
    }

    const qty = Math.floor(qtyRaw * 1e6) / 1e6;

    // Set default meta if missing
    if (!positionMeta[symbol]) {
      positionMeta[symbol] = { entryTimestamp: Date.now(), entryPrice: basis };
    }

    const meta = positionMeta[symbol];
    const ageMs = Date.now() - meta.entryTimestamp;
    const priceDiff = currentPrice && meta.entryPrice ? (currentPrice - meta.entryPrice) / meta.entryPrice : null;
    if (
      ageMs > 2 * 60 * 60 * 1000 &&
      priceDiff != null &&
      Math.abs(priceDiff) < 0.005 &&
      currentRsi != null &&
      currentRsi < 50
    ) {
      await closePositionMarket(symbol, qty);
      logTradeAction('forced_exit_age', symbol, { ageMs, priceDiff });
      return;
    }
    logTradeAction('sell_qty_confirm', symbol, {
      qtyRequested: qty,
      qtyAvailable: Math.floor(position.available * 1e6) / 1e6,
    });
    console.log(
      `[SELL QTY CONFIRM] ${symbol} available=${(
        Math.floor(position.available * 1e6) / 1e6
      )} qty=${qty.toFixed(6)}`
    );
    // Skip if the notional value is below Alpaca's minimum ($1)
    const notional = Math.floor(qty * basis * 1e6) / 1e6;
    if (notional < 1) {
      logTradeAction('sell_skip', symbol, {
        availableQty: qty,
        basisPrice: basis,
        notionalValue: notional,
        reason: 'notional below $1',
      });
      logTradeAction('sell_skip_reason', symbol, {
        reason: 'notional below $1',
        availableQty: qty,
        basisPrice: basis,
        notionalValue: notional,
      });
      console.log(
        `[SELL SKIPPED] ${symbol} notional $${notional.toFixed(6)} below $1`
      );
      showNotification(`❌ Skip ${symbol}: $${notional.toFixed(6)} < $1`);
      return;
    }

    const limit_price = (basis * (1 + PROFIT_TARGET_PERCENT)).toFixed(5); // 1.25% profit target

    const stop_price = (basis * (1 - STOP_LOSS_PERCENT)).toFixed(5);

    const limitSell = {
      symbol,
      qty,
      side: 'sell',
      type: 'limit',
      time_in_force: CRYPTO_TIME_IN_FORCE,
      limit_price,
    };

    const stopLoss = {
      symbol,
      qty,
      side: 'sell',
      type: 'stop',
      time_in_force: CRYPTO_TIME_IN_FORCE,
      stop_price,
    };

    logTradeAction('sell_attempt', symbol, {
      qty,
      basis,
      limit_price,
      stop_price,
    });
    showNotification(`📤 Sell: ${symbol} @ $${limit_price} x${qty.toFixed(6)}`);

    try {
      const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(limitSell),
      });

      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }

      if (res.ok && data.id) {
        logTradeAction('sell_success', symbol, { orderId: data.id, qty });
        showNotification(`✅ Sell Placed: ${symbol} @ $${limit_price}`);
        console.log(`[SELL SUCCESS] ${symbol}`, data);

        // Place stop-loss order after limit sell
        try {
          const stopRes = await fetch(`${ALPACA_BASE_URL}/orders`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify(stopLoss),
          });
          const stopRaw = await stopRes.text();
          let stopData;
          try {
            stopData = JSON.parse(stopRaw);
          } catch {
            stopData = { raw: stopRaw };
          }
          if (stopRes.ok && stopData.id) {
            logTradeAction('stop_success', symbol, { orderId: stopData.id, stop_price });
          } else {
            const msg = stopData?.message || JSON.stringify(stopData);
            logTradeAction('stop_failed', symbol, { status: stopRes.status, reason: msg });
          }
        } catch (err) {
          logTradeAction('stop_error', symbol, { error: err.message });
        }
      } else {
        const msg = data?.message || JSON.stringify(data);
        logTradeAction('sell_failed', symbol, { status: res.status, reason: msg });
        console.warn(`[SELL FAILED] ${symbol}:`, msg);
        showNotification(`❌ Sell Failed: ${symbol} - ${msg}`);
      }
    } catch (err) {
      logTradeAction('sell_error', symbol, { error: err.message });
      console.error(`[SELL EXCEPTION] ${symbol}:`, err.message);
      showNotification(`❌ Sell Error: ${symbol} - ${err.message}`);
    }
  };

  // Place a market buy order for the given symbol.  Will allocate up to
  // 10% of the current portfolio to the trade but never more than the
  // available cash. Duplicate buys are prevented via the perSymbolFundsLock
  // map and via checking for open orders on the symbol.  After a
  // successful buy the function will automatically place a limit sell
  // once the position settles.
  const placeOrder = async (symbol, ccSymbol = symbol, isManual = false, slope = 0) => {
    // Cooldown check per symbol
    const now = Date.now();
    if (lastTradeTime[symbol] && now - lastTradeTime[symbol] < COOL_DOWN_MS) {
      logTradeAction('cooldown_skip', symbol, {
        last: lastTradeTime[symbol],
      });
      console.log(`⏳ Cooldown active for ${symbol}`);
      return;
    }
    // Check for open orders FIRST
    const openOrders = await getOpenOrders(symbol);
    if (openOrders.length > 0) {
      logTradeAction('skip_open_orders', symbol, { openOrders });
      console.log(`🔁 Skipping ${symbol} - already has open orders`);
      return;
    }

    // Check if already held and only skip if the notional value is above $1
    const held = await getPositionInfo(symbol);
    if (held && held.available * held.basis > 1) {
      logTradeAction('skip_held_position', symbol, { held });
      showNotification(`💼 Held: ${symbol} x${held.qty} @ $${held.basis}`);
      console.log(`💼 Skipping ${symbol} - position already held`);
      logTradeAction('buy_attempt_skipped', symbol, {
        reason: 'position already held',
        held,
      });
      return;
    }

    logTradeAction('buy_attempt', symbol, { isManual });

    try {
      // Fetch current market price from CryptoCompare
      const priceRes = await fetch(
        `https://min-api.cryptocompare.com/data/price?fsym=${ccSymbol}&tsyms=USD`
      );
      const priceData = await priceRes.json();
      const price = priceData?.USD;

      if (!price || isNaN(price)) {
        throw new Error('Invalid price data');
      }

      // Get Alpaca account info
      const accountRes = await fetch(`${ALPACA_BASE_URL}/account`, {
        headers: HEADERS,
      });
      const accountData = await accountRes.json();

      // Use non_marginable_buying_power when available.  Crypto
      // purchases can only be funded from settled cash, which is
      // reflected in non_marginable_buying_power【247783379990709†L355-L359】.
      // Fall back to buying_power or cash if the field is absent.
      const cashRaw =
        accountData.non_marginable_buying_power ??
        accountData.buying_power ??
        accountData.cash;
      const cash = parseFloat(cashRaw || 0);
      const portfolioValue = parseFloat(
        accountData.equity ?? accountData.portfolio_value ?? '0'
      );

      logTradeAction('cash_available', symbol, { cash });

      // Safety margin and factors.  The price collar for market
      // orders is 2 %, so we reduce our allocation by a slightly
      // larger factor (3 %) to remain safely within buying power.
      const SAFETY_MARGIN = 1; // prevents over-request by $1 buffer
      const PRICE_COLLAR_PERCENT = 0.02;
      const EXTRA_BUFFER = 0.01;
      const SAFETY_FACTOR = 1 - PRICE_COLLAR_PERCENT - EXTRA_BUFFER; // e.g. 0.97

      // Determine the maximum allocation based on portfolio size and trend slope
      const targetAllocation = portfolioValue * (slope >= 0.05 ? 0.05 : 0.1);
      // Use the smaller of target allocation or available cash minus a safety margin
      let allocation = Math.min(targetAllocation, cash - SAFETY_MARGIN);

      // Apply safety factor so the notional never exceeds cash even after
      // Alpaca's price collar is applied.  This reduces the allocation
      // by a bit more than the collar so that rounding and slippage
      // still leave room.
      allocation *= SAFETY_FACTOR;

      // Final guard to ensure allocation never exceeds cash
      if (allocation > cash) {
        allocation = Math.floor(cash * 100) / 100;
      }

      // Ensure allocation is never negative
      if (allocation <= 0) {
        logTradeAction('allocation_skipped', symbol, {
          reason: 'safety margin exceeded available cash',
          cash,
          targetAllocation,
          allocation,
        });
        return;
      }

      // Calculate the final notional by rounding down to two decimals
      let notional = Math.floor(allocation * 100) / 100;

      // Confirm final allocation details
      logTradeAction('allocation_check', symbol, {
        cash,
        targetAllocation,
        allocation,
        finalNotional: notional,
        safetyMargin: SAFETY_MARGIN,
        safetyFactor: SAFETY_FACTOR,
      });

      logTradeAction('notional_final', symbol, { notional });

      // Skip trades that do not meet the minimum $1 notional
      if (notional < 1) {
        logTradeAction('skip_small_order', symbol, {
          reason: 'insufficient cash',
          targetAllocation,
          allocation,
          cash,
        });
        return;
      }

      // If the requested notional exceeds available cash, cap to cash
      if (notional > cash) {
        logTradeAction('notional_exceeds_cash', symbol, {
          requested: notional,
          cash,
        });
        notional = Math.floor(cash * 100) / 100;
        logTradeAction('notional_capped', symbol, { notional });
      }

      // Skip trades below Alpaca's $1 minimum after capping
      if (notional < 1) {
        logTradeAction('skip_small_order', symbol, {
          reason: 'notional below alpaca minimum after adjustment',
          notional,
          cash,
        });
        return;
      }

      const limit_price = parseFloat((price * BUY_LIMIT_BUFFER).toFixed(5));
      const qty = Math.floor((notional / limit_price) * 1e6) / 1e6;
      logTradeAction('buy_limit_details', symbol, { limit_price, qty });

      const order = {
        symbol,
        qty,
        side: 'buy',
        type: 'limit',
        time_in_force: CRYPTO_TIME_IN_FORCE,
        limit_price,
      };

      const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(order),
      });

      const raw = await res.text();
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        result = { raw };
      }

      if (res.ok && result.id) {
        logTradeAction('buy_success', symbol, {
          id: result.id,
          qty,
          limit_price,
        });
        showNotification(`✅ Buy ${symbol} ${qty} @ $${limit_price}`);
        lastTradeTime[symbol] = now;
        positionMeta[symbol] = { entryTimestamp: now, entryPrice: limit_price };
        pendingLimitOrders[symbol] = { orderId: result.id, notional, createdAt: now, cc: ccSymbol };
        setTimeout(() => verifyLimitBuyFilled(symbol, ccSymbol), REFRESH_INTERVAL_MS * 2);
        setTimeout(() => placeLimitSell(symbol), 5000);
      } else {
        logTradeAction('buy_failed', symbol, {
          status: res.status,
          reason: result.message || raw,
        });
        showNotification(`❌ Buy Failed ${symbol}: ${result.message || raw}`);
      }
    } catch (err) {
      logTradeAction('buy_error', symbol, { error: err.message });
      showNotification(`❌ Buy Error ${symbol}: ${err.message}`);
    }
  };

  // Refresh all token data.  When auto trading is enabled this will also
  // attempt to place buy orders on tokens whose MACD has crossed above
  // its signal line.
  const loadData = async () => {
    if (isLoading) return; // Prevent overlapping refreshes
    setIsLoading(true);
    // Log whenever a refresh cycle begins
    logTradeAction('refresh', 'all');
    perSymbolFundsLock = {}; // Reset funds lock each cycle
    try {
      const res = await fetch('https://paper-api.alpaca.markets/v2/account', { headers: HEADERS });
      const account = await res.json();
      const equity = parseFloat(account.equity ?? '0');
      const lastEquity = parseFloat(account.last_equity ?? '0');
      const change = lastEquity ? ((equity - lastEquity) / lastEquity) * 100 : 0;
      if (!isNaN(equity)) setPortfolioValue(equity);
      if (!isNaN(change)) setDailyChangePercent(change);
    } catch (err) {
      console.error('[ALPACA ACCOUNT FAILED]', err);
    }
    const results = [];
    for (const asset of tracked) {
      const token = {
        ...asset,
        price: null,
        rsi: null,
        macd: null,
        signal: null,
        signalDiff: null,
        trend: '🟰',
        isTrendingMarket: false,
        slope: 0,
        entryReady: false,
        watchlist: false,
        missingData: false,
        error: null,
        time: new Date().toLocaleTimeString(),
      };
      try {
        // Fetch price and historical data from CryptoCompare in parallel
        const priceUrl = `https://min-api.cryptocompare.com/data/price?fsym=${asset.cc}&tsyms=USD`;
        const histoUrl = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${asset.cc}&tsym=USD&limit=52&aggregate=15`;

        const [priceRes, histoRes] = await Promise.all([fetch(priceUrl), fetch(histoUrl)]);
        const priceData = await priceRes.json();
        const histoData = await histoRes.json();

        // Price
        if (typeof priceData?.USD === 'number') {
          token.price = priceData.USD;
        }

        const bars = Array.isArray(histoData?.Data?.Data) ? histoData.Data.Data : [];
        const closes = bars.map((bar) => bar.close).filter((c) => typeof c === 'number');
        if (closes.length >= 20) {
          const r = calcRSI(closes);
          const rPrev = calcRSI(closes.slice(0, -1));
          const macdRes = calcMACD(closes);
          token.rsi = r != null ? r.toFixed(1) : null;
          token.macd = macdRes.macd;
          token.signal = macdRes.signal;
          token.signalDiff =
            token.macd != null && token.signal != null
              ? token.macd - token.signal
              : null;
          const prev = calcMACD(closes.slice(0, -1));
          const histCurr =
            token.macd != null && token.signal != null ? token.macd - token.signal : null;
          const histPrev =
            prev.macd != null && prev.signal != null ? prev.macd - prev.signal : null;
          token.entryReady =
            token.macd != null &&
            token.signal != null &&
            prev.macd != null &&
            prev.signal != null &&
            r != null &&
            rPrev != null &&
            token.macd > token.signal &&
            histCurr != null &&
            histPrev != null &&
            histCurr > histPrev &&
            r > 45 &&
            r > rPrev &&
            trendRes.slope > 0.015;
          token.watchlist =
            token.macd != null &&
            token.signal != null &&
            prev.macd != null &&
            token.macd > prev.macd &&
            token.macd <= token.signal;
        }
        const trendRes = getTrendSymbol(closes);
        token.trend = trendRes.symbol;
        token.slope = trendRes.slope;
        token.isTrendingMarket = trendRes.slope > 0.04 || trendRes.slope < -0.04;
        logTradeAction('trend_state', asset.symbol, {
          slope: trendRes.slope,
          trending: token.isTrendingMarket,
          symbol: trendRes.symbol,
        });
        token.missingData = token.price == null || closes.length < 20;
        // Automatically place sell for any held positions
        const held = await getPositionInfo(asset.symbol);
        if (held) {
          await placeLimitSell(asset.symbol, token.price, parseFloat(token.rsi));
        }
        // Auto trade: verify entry conditions and trend state
        if (token.entryReady && token.isTrendingMarket) {
          logTradeAction('entry_ready_confirmed', asset.symbol, {
            trending: token.isTrendingMarket,
          });
          await placeOrder(asset.symbol, asset.cc, false, token.slope);
        } else {
          logTradeAction('entry_skipped', asset.symbol, {
            entryReady: token.entryReady,
            trending: token.isTrendingMarket,
          });
        }
      } catch (err) {
        console.error(`Failed to load ${asset.symbol}:`, err);
        token.error = err.message;
        token.missingData = true;
        showNotification('⚠️ Load Failed: ' + asset.symbol);
      }
      results.push(token);
    }
    setData(results);
    setRefreshing(false);
    setIsLoading(false);
  };

  // Start the refresh interval on mount. Clear any existing interval before
  // creating a new one to avoid overlaps.
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    intervalRef.current = setInterval(loadData, REFRESH_INTERVAL_MS);
    // Clean up on unmount
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Kick off a data load on mount
  useEffect(() => {
    loadData();
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const renderCard = (asset) => {
    const borderColor = asset.entryReady ? 'green' : asset.watchlist ? '#FFA500' : 'red';
    const cardStyle = [
      styles.card,
      { borderLeftColor: borderColor },
      asset.watchlist && !asset.entryReady && styles.cardWatchlist,
    ];
    return (
      <View key={asset.symbol} style={cardStyle}>
        <Text style={styles.symbol}>
          {asset.name} ({asset.symbol})
        </Text>
        {asset.entryReady && (
          <Text style={styles.entryReady}>✅ ENTRY READY</Text>
        )}
        {asset.watchlist && !asset.entryReady && (
          <Text style={styles.watchlist}>🟧 WATCHLIST</Text>
        )}
        {asset.price != null && <Text>Price: ${asset.price}</Text>}
        {asset.rsi != null && <Text>RSI: {asset.rsi}</Text>}
        <Text>Trend: {asset.trend}</Text>
        {asset.missingData && (
          <Text style={styles.missing}>⚠️ Missing data</Text>
        )}
        {asset.error && (
          <Text style={styles.error}>❌ Not tradable: {asset.error}</Text>
        )}
        <Text>{asset.time}</Text>
        <TouchableOpacity onPress={() => placeOrder(asset.symbol, asset.cc, true, asset.slope)}>
          <Text style={styles.buyButton}>Manual BUY</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const PortfolioSummary = () => {
    const changeColor = dailyChangePercent >= 0 ? 'green' : 'red';
    const valueText = `$${portfolioValue.toFixed(2)}`;
    const percentText = `${dailyChangePercent >= 0 ? '+' : ''}${dailyChangePercent.toFixed(2)}%`;
    return (
      <View style={styles.portfolioSummary}>
        <Text style={[styles.portfolioText, darkMode && styles.titleDark]}>Portfolio: {valueText}</Text>
        <Text style={[styles.portfolioChange, { color: changeColor }]}>{percentText}</Text>
      </View>
    );
  };

  // Sort tokens by signal difference descending, falling back to
  // alphabetical sort to create stable ordering.  Null values sort
  // last.
  const bySignal = (a, b) => {
    const diffA = a.signalDiff ?? -Infinity;
    const diffB = b.signalDiff ?? -Infinity;
    if (diffA === diffB) return a.symbol.localeCompare(b.symbol);
    return diffB - diffA;
  };

  const entryReadyTokens = data.filter((t) => t.entryReady).sort(bySignal);
  const watchlistTokens = data.filter((t) => !t.entryReady && t.watchlist).sort(bySignal);
  const otherTokens = data.filter((t) => !t.entryReady && !t.watchlist).sort(bySignal);

  return (
    <ScrollView
      contentContainerStyle={[styles.container, darkMode && styles.containerDark]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.row}>
        <Switch value={darkMode} onValueChange={setDarkMode} />
        <Switch value={hideOthers} onValueChange={setHideOthers} />
        <Text style={[styles.title, darkMode && styles.titleDark]}>🎭 Bullish or Bust!</Text>
      </View>
      <PortfolioSummary />
      <Text style={styles.sectionHeader}>✅ Entry Ready</Text>
      {entryReadyTokens.length > 0 ? (
        <View style={styles.cardGrid}>{entryReadyTokens.map(renderCard)}</View>
      ) : (
        <Text style={styles.noData}>No Entry Ready tokens</Text>
      )}
      <Text style={styles.sectionHeader}>🟧 Watchlist</Text>
      {watchlistTokens.length > 0 ? (
        <View style={styles.cardGrid}>{watchlistTokens.map(renderCard)}</View>
      ) : (
        <Text style={styles.noData}>No Watchlist tokens</Text>
      )}
      {!hideOthers && (
        <>
          <Text style={styles.sectionHeader}>❌ Others</Text>
          {otherTokens.length > 0 ? (
            <View style={styles.cardGrid}>{otherTokens.map(renderCard)}</View>
          ) : (
            <Text style={styles.noData}>No other tokens</Text>
          )}
        </>
      )}
      {logHistory.length > 0 && (
        <View style={styles.logPanel}>
          {logHistory.map((log, idx) => (
            <Text key={idx} style={styles.logText}>
              {`${log.timestamp.split('T')[1].slice(0,8)} ${log.type} ${log.symbol}`}
            </Text>
          ))}
        </View>
      )}
      {notification && (
        <View
          style={{
            position: 'absolute',
            bottom: 40,
            left: 20,
            right: 20,
            padding: 12,
            backgroundColor: '#333',
            borderRadius: 8,
            zIndex: 999,
          }}
        >
          <Text style={{ color: '#fff', textAlign: 'center' }}>{notification}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, paddingTop: 40, paddingHorizontal: 10, backgroundColor: '#fff' },
  containerDark: { backgroundColor: '#121212' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  title: { fontSize: 18, fontWeight: 'bold', color: '#000' },
  titleDark: { color: '#fff' },
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  card: {
    width: '48%',
    backgroundColor: '#f0f0f0',
    padding: 10,
    borderRadius: 6,
    borderLeftWidth: 5,
    marginBottom: 10,
  },
  cardWatchlist: {
    borderColor: '#FFA500',
    borderWidth: 2,
  },
  symbol: { fontSize: 15, fontWeight: 'bold', color: '#005eff' },
  error: { color: 'red', fontSize: 12 },
  buyButton: { color: '#0066cc', marginTop: 8, fontWeight: 'bold' },
  noData: { textAlign: 'center', marginTop: 20, fontStyle: 'italic', color: '#777' },
  entryReady: { color: 'green', fontWeight: 'bold' },
  watchlist: { color: '#FFA500', fontWeight: 'bold' },
  waiting: { alignItems: 'center', marginTop: 20 },
  sectionHeader: { fontSize: 16, fontWeight: 'bold', marginBottom: 5, marginTop: 10 },
  missing: { color: 'red', fontStyle: 'italic' },
  logPanel: {
    position: 'absolute',
    bottom: 90,
    left: 20,
    right: 20,
    backgroundColor: '#222',
    padding: 8,
    borderRadius: 8,
    zIndex: 998,
  },
  logText: { color: '#fff', fontSize: 12 },
  portfolioSummary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  portfolioText: { fontSize: 15, fontWeight: '500', color: '#000' },
  portfolioChange: { fontSize: 15, fontWeight: '500' },
});