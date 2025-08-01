# Bullish or Bust! Backend

This Node.js backend handles Alpaca API trades via a `/buy` endpoint.
It also exposes `/ping` and `/ping-alpaca` health check routes.

## Setup

The server includes CORS support so it can be called from Expo Go.

1. `npm install`
2. Create a `.env` file with your Alpaca API credentials:
   ```
   ALPACA_API_KEY=AKP4CYCLABN0QHC7GVH4
   ALPACA_SECRET_KEY=PwJAEwLnLnsf7qAVvFutE8VIMgsAgvi7PMkMcCca
   ALPACA_BASE_URL=https://api.alpaca.markets
   ALPACA_DATA_URL=https://data.alpaca.markets/v1beta2
   ```
3. `npm start`
