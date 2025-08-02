import 'dotenv/config';
export default {
  expo: {
    name: "bullish-or-bust",
    version: "1.0.0",
    extra: {
      EXPO_PUBLIC_BACKEND_URL: process.env.EXPO_PUBLIC_BACKEND_URL,
      EXPO_PUBLIC_ALPACA_KEY: process.env.ALPACA_API_KEY,
      EXPO_PUBLIC_ALPACA_SECRET: process.env.ALPACA_SECRET_KEY,
      EXPO_PUBLIC_ALPACA_BASE_URL: process.env.ALPACA_BASE_URL
    }
  }
};
