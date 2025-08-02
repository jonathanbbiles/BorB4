// Default to the live Alpaca endpoint if no environment variable is set.
// Using the correct base URL avoids accidental requests to localhost which
// would obviously fail the connectivity test.
const BASE_URL = process.env.ALPACA_BASE_URL || 'https://api.alpaca.markets';
(async () => {
  try {
    const ping = await fetch(`${BASE_URL}/ping`);
    console.log('/ping', ping.status);
    if (ping.status >= 200 && ping.status < 300) {
      console.log('Network OK');
    } else {
      console.error('Ping returned', ping.status);
    }
  } catch (err) {
    console.error('Ping failed:', err.message);
  }
})();
