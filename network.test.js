const BASE_URL = process.backend.env.ALPACA_BASE_URL || 'http://localhost:3000';
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
