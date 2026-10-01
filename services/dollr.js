const axios = require('axios');

const BASE_URL = process.env.DOLLR_API_BASE_URL || 'https://api.heydollr.app';
let tokenCache = null;

const getValue = (payload, key) => payload?.[key] ?? payload?.data?.[key];

const requestToken = async () => {
  if (!process.env.DOLLR_CLIENT_ID || !process.env.DOLLR_CLIENT_SECRET) {
    throw new Error('Dollr credentials are not configured');
  }

  if (tokenCache && tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokenCache.token;
  }

  const response = await axios.post(`${BASE_URL}/v1/jwt/client/obtain/token`, {
    client_id: process.env.DOLLR_CLIENT_ID,
    client_secret: process.env.DOLLR_CLIENT_SECRET,
  }, { timeout: 15000 });

  const token = getValue(response.data, 'access_token');
  const expiresInMinutes = Number(getValue(response.data, 'expires_in') || 60);
  if (!token) throw new Error('Dollr did not return an access token');

  tokenCache = {
    token,
    expiresAt: Date.now() + Math.max(expiresInMinutes - 5, 1) * 60 * 1000,
  };
  return token;
};

const call = async (method, path, data, params) => {
  const token = await requestToken();
  try {
    const response = await axios({
      method,
      url: `${BASE_URL}${path}`,
      data,
      params,
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    const status = error.response?.status || 'unknown';
    const responseData = error.response?.data;

    console.error(`[Dollr] ${method} ${path} failed`);
    console.error(`[Dollr] HTTP status: ${status}`);
    console.error(
      '[Dollr] Response:',
      JSON.stringify(responseData, null, 2)
    );

    if (Array.isArray(responseData?.detail)) {
      console.error('[Dollr] Validation details:');

      for (const item of responseData.detail) {
        console.error(
          `  Field: ${item.loc?.join('.') || 'unknown'}`
        );
        console.error(
          `  Message: ${item.msg || 'unknown'}`
        );
        console.error(
          `  Type: ${item.type || 'unknown'}`
        );
      }
    }

    const message = Array.isArray(responseData?.detail)
      ? responseData.detail
          .map((item) => {
            const field = item.loc?.slice(1).join('.') || 'unknown';
            return `${field}: ${item.msg}`;
          })
          .join('; ')
      : responseData?.message ||
        error.message ||
        `Dollr request failed with status ${status}`;

    const contextualError = new Error(
      `Dollr ${method} ${path} failed (HTTP ${status}): ${message}`
    );

    contextualError.cause = error;
    throw contextualError;
  }
};

const createCollection = async ({ fullName, email, phone, countryCode, amount, currency, provider, method, referenceId }) => {
  const party = await call('POST', '/v1/parties/create', {
    fullname: fullName,
    phone,
    email,
    country_code: countryCode,
  });
  const partyId = getValue(party, 'id');

  const counterparty = await call('POST', '/v1/counterparties/create', {
    relationship_type: 'CUSTOMER',
    party_id: partyId,
  });
  const counterpartyId = getValue(counterparty, 'id');

  const invoice = await call('POST', '/v1/invoices/create', {
    counterparty_id: counterpartyId,
    currency,
    note: 'Qureo health wallet funding',
    fee_bearer: process.env.DOLLR_FEE_BEARER || 'PAYER',
    as_payment_link: false,
  });
  const invoiceId = getValue(invoice, 'id');

  await call('POST', `/v1/invoices/${invoiceId}/items/add`, {
    name: 'Qureo health wallet funding',
    currency,
    qty: 1,
    amount: Number(amount),
  });
  await call('PUT', `/v1/invoices/publish/${invoiceId}`);

  const session = await call('POST', '/v1/sessions/checkout', {
    source_id: invoiceId,
    source_type: 'INVOICE',
  });
  const sessionId = getValue(session, 'id');

  const account = await call('POST', '/v1/payment-accounts/create', {
    account_name: `${fullName} mobile wallet`,
    provider,
    method,
    party_id: partyId,
    country_code: countryCode,
    insensitive_account_number: String(phone).replace(/^\+/, ''),
  }, { operation_type: 'COLLECTION' });
  const paymentAccountId = getValue(account, 'id');

  const execution = await call('POST', '/v1/executions/collection', {
    session_id: String(sessionId),
    payment_account_id: String(paymentAccountId),
    currency,
    reference_id: referenceId,
  });

  return {
    partyId,
    invoiceId,
    sessionId,
    paymentAccountId,
    execution,
  };
};

const getCollectionStatus = (referenceId) => call(
  'GET',
  `/v1/status/collection/${encodeURIComponent(referenceId)}`
);

module.exports = { createCollection, getCollectionStatus };