// netlify/functions/qbo.js
// Serverless function that proxies QuickBooks Online API calls.
//
// QuickBooks issues a NEW refresh token every time one is used, and the previous one stops
// working after a short grace period. The newest token therefore has to live somewhere the
// function can read at runtime. Environment variables can't do that job: changes to them do
// not reach an already-deployed function until the next deploy. So the rotating token is kept
// in Netlify Blobs, and the QBO_REFRESH_TOKEN environment variable only acts as the starting
// ("seed") value. To re-seed by hand: generate a fresh token in the Intuit OAuth Playground,
// put it in QBO_REFRESH_TOKEN, and redeploy.

const { getStore, connectLambda } = require('@netlify/blobs');

const QBO_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

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

function openTokenStore(event) {
  try {
    if (typeof connectLambda === 'function') connectLambda(event);
    return getStore('qbo-tokens');
  } catch (e) {
    console.warn('Netlify Blobs unavailable, using the environment token only:', e.message);
    return null;
  }
}

// Use the saved token only if it descends from the environment token currently deployed.
// If someone replaces QBO_REFRESH_TOKEN by hand, the saved chain is ignored and restarts from it.
async function resolveRefreshToken(store, envToken) {
  if (!store) return envToken;
  try {
    const saved = await store.get('refresh', { type: 'json' });
    if (saved && saved.token && saved.seed === envToken) return saved.token;
  } catch (e) {
    console.warn('Could not read saved refresh token:', e.message);
  }
  return envToken;
}

async function saveRefreshToken(store, newRefreshToken, envToken) {
  if (!store || !newRefreshToken) return;
  try {
    await store.setJSON('refresh', {
      token: newRefreshToken,
      seed: envToken,
      savedAt: new Date().toISOString()
    });
    console.log('Rotated QuickBooks refresh token saved to Netlify Blobs');
  } catch (e) {
    console.warn('Could not save refresh token:', e.message);
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
    const envToken     = process.env.QBO_REFRESH_TOKEN;
    const realmId      = process.env.QBO_REALM_ID;

    if (!clientId || !clientSecret || !envToken || !realmId) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'QBO credentials not configured' }) };
    }

    const store = openTokenStore(event);
    const currentToken = await resolveRefreshToken(store, envToken);

    // Get fresh access token and new refresh token
    let tokens;
    try {
      tokens = await refreshAccessToken(clientId, clientSecret, currentToken);
    } catch (e) {
      if (currentToken === envToken) throw e;
      console.warn('Saved refresh token was rejected; retrying with the environment token');
      tokens = await refreshAccessToken(clientId, clientSecret, envToken);
    }
    const { accessToken, newRefreshToken } = tokens;

    // MUST be awaited: in a serverless function, un-awaited work is killed when the
    // handler returns.
    await saveRefreshToken(store, newRefreshToken, envToken);

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
