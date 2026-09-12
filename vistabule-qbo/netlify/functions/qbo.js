// netlify/functions/qbo.js
// Serverless function that proxies QuickBooks Online API calls
// Auto-saves new refresh token to Netlify environment variables after each call

const QBO_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const NETLIFY_SITE_ID = 'meek-lebkuchen-d6bebd';
// Read from an environment variable instead of hardcoding (see security note).
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
  });
  const data = await response.json();
  if (!data.access_token) throw new Error('Failed to refresh token: ' + JSON.stringify(data));
  return { accessToken: data.access_token, newRefreshToken: data.refresh_token };
}

async function saveRefreshToken(newRefreshToken) {
  try {
    if (!NETLIFY_TOKEN) { console.warn('NETLIFY_TOKEN not set — cannot auto-save refresh token'); return; }
    // Get site ID first
    const sitesRes = await fetch('https://api.netlify.com/api/v1/sites?filter=all', {
      headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}` }
    });
    const sites = await sitesRes.json();
    const site = sites.find(s => s.name === NETLIFY_SITE_ID || s.id.startsWith('meek'));
    if (!site) { console.warn('Could not find site ID'); return; }

    const siteId = site.id;

    // Update the environment variable
    const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/env/QBO_REFRESH_TOKEN`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${NETLIFY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        key: 'QBO_REFRESH_TOKEN',
        values: [{ value: newRefreshToken, context: 'all' }]
      })
    });
    if (res.ok) {
      console.log('Refresh token auto-saved to Netlify successfully');
    } else {
      const err = await res.text();
      console.warn('Failed to save refresh token:', err);
    }
  } catch(e) {
    console.warn('Error saving refresh token:', e.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      },
      body: ''
    };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const clientId     = process.env.QBO_CLIENT_ID;
    const clientSecret = process.env.QBO_CLIENT_SECRET;
    const refreshToken = process.env.QBO_REFRESH_TOKEN;
    const realmId      = process.env.QBO_REALM_ID;

    if (!clientId || !clientSecret || !refreshToken || !realmId) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'QBO credentials not configured' }) };
    }

    // Get fresh access token and new refresh token
    const { accessToken, newRefreshToken } = await refreshAccessToken(clientId, clientSecret, refreshToken);

    // Auto-save the new refresh token to Netlify.
    // MUST be awaited: in a serverless function, un-awaited work is killed when the
    // handler returns, which is why the rotated token was never being persisted.
    if (newRefreshToken && newRefreshToken !== refreshToken) {
      await saveRefreshToken(newRefreshToken);
    }

    const query = event.queryStringParameters || {};
    const report = query.report || 'ProfitAndLoss';

    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const startDate = query.start || `${now.getFullYear()}-01-01`;
    const endDate   = query.end   || today;

    let results = {};

    if (report === 'all') {
      const safelyFetch = async (fn) => {
        try { return await fn(); }
        catch(e) { console.warn('QBO fetch failed:', e.message); return null; }
      };

      const [pl, bs, ar, ap] = await Promise.all([
        safelyFetch(() => fetchQBOReport(accessToken, realmId, 'ProfitAndLoss', startDate, endDate)),
        safelyFetch(() => fetchQBOReport(accessToken, realmId, 'BalanceSheet', startDate, endDate)),
        safelyFetch(() => fetchAgedReport(accessToken, realmId, 'AgedReceivables', today)),
        safelyFetch(() => fetchAgedReport(accessToken, realmId, 'AgedPayables', today))
      ]);

      let openInvoices = [];
      try {
        const invQuery = `SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 100`;
        const invUrl = `${QBO_BASE}/${realmId}/query?query=${encodeURIComponent(invQuery)}&minorversion=65`;
        const invRes = await fetch(invUrl, {
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
        });
        if (invRes.ok) {
          const invData = await invRes.json();
          openInvoices = invData?.QueryResponse?.Invoice || [];
        }
      } catch(e) {
        console.warn('Invoice query failed:', e.message);
      }

      results = { profitAndLoss: pl, balanceSheet: bs, arAging: ar, apAging: ap, openInvoices };

    } else {
      results = await fetchQBOReport(accessToken, realmId, report, startDate, endDate);
    }

    return { statusCode: 200, headers, body: JSON.stringify(results) };

  } catch (err) {
    console.error('QBO function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

async function fetchQBOReport(accessToken, realmId, reportName, startDate, endDate) {
  const plParams = reportName === 'ProfitAndLoss' ? '&summarize_column_by=Month&accounting_method=Accrual' : '';
  const url = `${QBO_BASE}/${realmId}/reports/${reportName}?start_date=${startDate}&end_date=${endDate}&minorversion=65${plParams}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`QBO ${reportName} failed: ${response.status} ${err}`);
  }
  return response.json();
}

async function fetchAgedReport(accessToken, realmId, reportName, asOfDate) {
  const url = `${QBO_BASE}/${realmId}/reports/${reportName}?as_of_date=${asOfDate}&minorversion=65`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`QBO ${reportName} failed: ${response.status} ${err}`);
  }
  return response.json();
}
