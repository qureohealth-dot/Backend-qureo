const axios = require('axios');

const BASE_URL = (process.env.MTN_MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com').replace(/\/$/, '');
const TARGET_ENVIRONMENT = process.env.MTN_MOMO_TARGET_ENVIRONMENT || 'sandbox';
let tokenCache = null;

const getProviderErrorDetail = (data) => {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data : '';
  const detail = data.error_description || data.message || data.reason || data.error || data.code;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') {
    return [detail.code, detail.message || detail.description].filter(Boolean).join(': ');
  }
  return '';
};

const getConfig = () => {
  const { MTN_MOMO_API_USER: apiUser, MTN_MOMO_API_KEY: apiKey, MTN_MOMO_SUBSCRIPTION_KEY: subscriptionKey } = process.env;
  if (!apiUser || !apiKey || !subscriptionKey) {
    throw new Error('MTN MoMo API user, API key, and subscription key must be configured');
  }
  return { apiUser, apiKey, subscriptionKey };
};

const getAccessToken = async () => {
  const config = getConfig();
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return { token: tokenCache.token, subscriptionKey: config.subscriptionKey };
  }

  let response;
  try {
    response = await axios.post(`${BASE_URL}/collection/token/`, null, {
      auth: { username: config.apiUser, password: config.apiKey },
      headers: { 'Ocp-Apim-Subscription-Key': config.subscriptionKey },
      timeout: 15000,
    });
  } catch (error) {
    const status = error.response?.status || 'unknown';
    const detail = getProviderErrorDetail(error.response?.data);
    throw new Error(`MTN MoMo token request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`);
  }

  const token = response.data?.access_token;
  const expiresIn = Number(response.data?.expires_in || 3600);
  if (!token) throw new Error('MTN MoMo did not return an access token');

  tokenCache = { token, expiresAt: Date.now() + Math.max(expiresIn - 60, 1) * 1000 };
  return { token, subscriptionKey: config.subscriptionKey };
};

const call = async (method, path, data, headers = {}) => {
  const { token, subscriptionKey } = await getAccessToken();
  try {
    const response = await axios({
      method,
      url: `${BASE_URL}${path}`,
      data,
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'X-Target-Environment': TARGET_ENVIRONMENT,
        'Content-Type': 'application/json',
        ...headers,
      },
    });
    return response.data;
  } catch (error) {
    const detail = getProviderErrorDetail(error.response?.data);
    throw new Error(`MTN MoMo ${method} ${path} failed (HTTP ${error.response?.status || 'unknown'})${detail ? `: ${detail}` : ''}`);
  }
};

const createRequestToPay = ({ amount, currency, phone, referenceId }) => call(
  'POST',
  '/collection/v1_0/requesttopay',
  {
    amount: String(Number(amount)),
    currency,
    externalId: referenceId,
    payer: {
      partyIdType: 'MSISDN',
      partyId: phone,
    },
    payerMessage: 'Qureo health wallet funding',
    payeeNote: 'Qureo health wallet funding',
  },
  { 'X-Reference-Id': referenceId }
);

const getRequestToPayStatus = (referenceId) => call(
  'GET',
  `/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`
);

module.exports = { createRequestToPay, getRequestToPayStatus };