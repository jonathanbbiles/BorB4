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
* indicator) from minute data provided by CryptoCompare and then exposes
* manual and automatic trade actions against the Alpaca paper trading API.
*
* Key improvements over the original implementation:
*  - All network interactions are wrapped in try/catch blocks and return
*    sensible defaults on failure to ensure the UI never crashes because
*    of a bad response.
*  - A small concurrency guard prevents multiple overlapping refreshes
*    from running at the same time.  This is important because the
*    component refreshes itself on a timer when auto trading is enabled.
*  - We added a helper to check for open orders on a symbol before
*    attempting to place a new trade.  Without this guard duplicate buy
*    orders could be fired off if an earlier order was still pending.
*  - The refresh interval is stored in a ref and cleaned up properly when
*    the component unmounts or when auto trading is toggled off.
*  - A handful of comments have been sprinkled throughout the code to
*    explain why certain decisions were made.  Feel free to remove them
*    for production use.
*/

import Constants from 'expo-constants';

// API credentials are provided via Expo config extras.
const {
  ALPACA_API_KEY,
  ALPACA_SECRET_KEY,
  ALPACA_BASE_URL,
  ALPACA_DATA_URL,
} = Constants.expoConfig.extra || {};

// Helper to build Alpaca auth headers from Expo config
const getAlpacaHeaders = () => ({
  'APCA-API-KEY-ID': ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
  'Content-Type': 'application/json',
});

// Backend server for manual trade requests. Default to local dev server
// but allow override via Expo env var
// When running on a real device "localhost" will not resolve to your
// development machine. Use an Expo or ngrok tunnel URL instead.
// Backend server for trade requests
const BACKEND_URL = 'https://borb4.onrender.com';

// Crypto orders require GTC time in force
const CRYPTO_TIME_IN_FORCE = 'gtc';

// === Trading strategy constants ===
// Cooldown between trades on the same symbol (30 minutes)
const COOL_DOWN_MS = 30 * 60 * 1000;
// Limit buy buffer - 0.1% below current price
const BUY_LIMIT_BUFFER = 0.999;
// Minimum post-fee gain target for limit sells (0.15%)
const SELL_TARGET_MULTIPLIER = 1.0015;
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

// Full list of cryptocurrencies supported by Alpaca as of July 2025.
// Each entry defines the Alpaca symbol, the CryptoCompare base symbol
// used for pricing (cc), and a CoinGecko id.  The gecko id is not
// currently used in the app but is retained for possible future
// integrations.
const ALPACA_TOKENS = [
  { name: 'AAVE/USD', symbol: 'AAVEUSD', cc: 'AAVE', gecko: 'aave' },
  { name: 'AVAX/USD', symbol: 'AVAXUSD', cc: 'AVAX', gecko: 'avalanche-2' },
  { name: 'BAT/USD', symbol: 'BATUSD', cc: 'BAT', gecko: 'basic-attention-token' },
  { name: 'BCH/USD', symbol: 'BCHUSD', cc: 'BCH', gecko: 'bitcoin-cash' },
  { name: 'BTC/USD', symbol: 'BTCUSD', cc: 'BTC', gecko: 'bitcoin' },
  { name: 'CRV/USD', symbol: 'CRVUSD', cc: 'CRV', gecko: 'curve-dao-token' },
  { name: 'DOGE/USD', symbol: 'DOGEUSD', cc: 'DOGE', gecko: 'dogecoin' },
  { name: 'DOT/USD', symbol: 'DOTUSD', cc: 'DOT', gecko: 'polkadot' },
  { name: 'ETH/USD', symbol: 'ETHUSD', cc: 'ETH', gecko: 'ethereum' },
  { name: 'GRT/USD', symbol: 'GRTUSD', cc: 'GRT', gecko: 'the-graph' },
  { name: 'LINK/USD', symbol: 'LINKUSD', cc: 'LINK', gecko: 'chainlink' },
  { name: 'LTC/USD', symbol: 'LTCUSD', cc: 'LTC', gecko: 'litecoin' },
  { name: 'MKR/USD', symbol: 'MKRUSD', cc: 'MKR', gecko: 'maker' },
  { name: 'PEPE/USD', symbol: 'PEPEUSD', cc: 'PEPE', gecko: 'pepe' },
  { name: 'SHIB/USD', symbol: 'SHIBUSD', cc: 'SHIB', gecko: 'shiba-inu' },
  { name: 'SOL/USD', symbol: 'SOLUSD', cc: 'SOL', gecko: 'solana' },
  { name: 'SUSHI/USD', symbol: 'SUSHIUSD', cc: 'SUSHI', gecko: 'sushi' },
  { name: 'TRUMP/USD', symbol: 'TRUMPUSD', cc: 'TRUMP', gecko: 'maga' },
  { name: 'UNI/USD', symbol: 'UNIUSD', cc: 'UNI', gecko: 'uniswap' },
  { name: 'USDC/USD', symbol: 'USDCUSD', cc: 'USDC', gecko: 'usd-coin' },
  { name: 'USDG/USD', symbol: 'USDGUSD', cc: 'USDG', gecko: 'usdg' },
  { name: 'USDT/USD', symbol: 'USDTUSD', cc: 'USDT', gecko: 'tether' },
  { name: 'XRP/USD', symbol: 'XRPUSD', cc: 'XRP', gecko: 'ripple' },
  { name: 'XTZ/USD', symbol: 'XTZUSD', cc: 'XTZ', gecko: 'tezos' },
  { name: 'YFI/USD', symbol: 'YFIUSD', cc: 'YFI', gecko: 'yearn-finance' },
];

export default function App() {
  const [tracked] = useState(ALPACA_TOKENS);
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
  const [dailyChange, setDailyChange] = useState(0);
  const intervalRef = useRef(null);
  console.log(`Backend URL set to ${BACKEND_URL}`);

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

  // Calculate a simple Z-Score over the last `period` closes
  const calcZScore = (closes, period = 20) => {
    if (!Array.isArray(closes) || closes.length < period) return null;
    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance =
      slice.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return (slice[slice.length - 1] - mean) / std;
  };

  // Retrieve the current position for a given symbol.  Returns null if
  // nothing is held or if the request fails.
  const getPositionInfo = async (symbol) => {
    try {
      const res = await fetch(`${BACKEND_URL}/positions/${symbol}`);
      if (!res.ok) throw new Error(`Failed to fetch position info: ${res.statusText}`);
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
        `${BACKEND_URL}/orders?status=open&symbols=${symbol}`
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
      const res = await fetch(`${BACKEND_URL}/orders`, {
        method: 'POST',
        headers: getAlpacaHeaders(),
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
      const res = await fetch(`${BACKEND_URL}/orders/${pending.orderId}`);
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
      if (!pRes.ok || !hRes.ok) {
        throw new Error(`CryptoCompare refresh failed ${pRes.status}/${hRes.status}`);
      }
      const priceData = await pRes.json();
      const histoData
