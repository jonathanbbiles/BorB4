# Bullish or Bust! Backend

This Node.js backend handles Alpaca API trades via a `/buy` endpoint.
It also exposes `/ping` and `/ping-alpaca` health check routes.

## Setup

The server includes CORS support so it can be called from Expo Go.

1. `npm install`
2. Create a `.env` file with your Alpaca API keys.
3. `npm start`
