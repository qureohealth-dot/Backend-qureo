const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { randomUUID } = require('crypto');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const baseUrl = (process.env.MTN_MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com').replace(/\/$/, '');
const callbackHost = process.env.MTN_MOMO_CALLBACK_HOST || 'localhost';
const subscriptionKey = process.env.MTN_MOMO_SUBSCRIPTION_KEY;

const saveEnvValues = (updates) => {
  const contents = fs.readFileSync(envPath, 'utf8');
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.split(/\r?\n/);

  for (const [key, value] of Object.entries(updates)) {
    const lineIndex = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    const assignment = `${key}=${value}`;
    if (lineIndex >= 0) lines[lineIndex] = assignment;
    else lines.push(assignment);
  }

  const temporaryPath = `${envPath}.tmp`;
  fs.writeFileSync(temporaryPath, lines.join(newline), { mode: 0o600 });
  fs.renameSync(temporaryPath, envPath);
};

const main = async () => {
  const parsedBaseUrl = new URL(baseUrl);
  if (!parsedBaseUrl.hostname.includes('sandbox')) {
    throw new Error('Refusing to provision: MTN_MOMO_BASE_URL is not an MTN sandbox host');
  }
  if (!subscriptionKey) {
    throw new Error('MTN_MOMO_SUBSCRIPTION_KEY is missing from Backend-qureo/.env');
  }
  if (process.env.MTN_MOMO_API_KEY) {
    console.log('MTN sandbox API User and API Key are already configured; no request was sent.');
    return;
  }

  const headers = {
    'Ocp-Apim-Subscription-Key': subscriptionKey,
    'Content-Type': 'application/json',
  };
  let apiUser = process.env.MTN_MOMO_API_USER;

  if (!apiUser) {
    apiUser = randomUUID();
    try {
      await axios.post(`${baseUrl}/v1_0/apiuser`, { providerCallbackHost: callbackHost }, {
        headers: { ...headers, 'X-Reference-Id': apiUser },
        timeout: 20000,
      });
    } catch (error) {
      throw new Error(`MTN sandbox API User creation failed (HTTP ${error.response?.status || 'unknown'})`);
    }

    saveEnvValues({ MTN_MOMO_API_USER: apiUser, MTN_MOMO_CALLBACK_HOST: callbackHost });
    process.env.MTN_MOMO_API_USER = apiUser;
  }

  let response;
  try {
    response = await axios.post(`${baseUrl}/v1_0/apiuser/${encodeURIComponent(apiUser)}/apikey`, null, {
      headers,
      timeout: 20000,
    });
  } catch (error) {
    throw new Error(`MTN sandbox API Key creation failed (HTTP ${error.response?.status || 'unknown'}). The API User is saved for a safe retry.`);
  }

  const apiKey = response.data?.apiKey;
  if (!apiKey) throw new Error('MTN sandbox did not return an API Key; no key was saved');

  saveEnvValues({
    MTN_MOMO_API_USER: apiUser,
    MTN_MOMO_API_KEY: apiKey,
    MTN_MOMO_CALLBACK_HOST: callbackHost,
  });
  console.log('MTN sandbox API User and API Key were provisioned and saved to Backend-qureo/.env. The API Key was not printed.');
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});