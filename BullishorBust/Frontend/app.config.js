import 'dotenv/config';

export default ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    EXPO_PUBLIC_ALPACA_KEY: process.env.ALPACA_API_KEY,
    EXPO_PUBLIC_ALPACA_SECRET: process.env.ALPACA_SECRET_KEY,
    EXPO_PUBLIC_ALPACA_BASE_URL: process.env.ALPACA_BASE_URL,
    EXPO_PUBLIC_ALPACA_DATA_URL: process.env.ALPACA_DATA_URL,
    EXPO_PUBLIC_BACKEND_URL: process.env.EXPO_PUBLIC_BACKEND_URL,
  },
});
