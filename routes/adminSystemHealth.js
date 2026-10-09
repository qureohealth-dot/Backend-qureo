const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { getPushServiceStatus } = require('../utils/pushService');

const router = express.Router();
const PROBE_TIMEOUT_MS = 5000;

async function probeService(name, category, request) {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    await request();
    return {
      name,
      category,
      status: 'connected',
      checkedAt,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name,
      category,
      status: 'error',
      checkedAt,
      latencyMs: Date.now() - startedAt,
    };
  }
}

function configuredService(name, category, configured, detail) {
  return {
    name,
    category,
    status: configured ? 'configured' : 'not_configured',
    checkedAt: new Date().toISOString(),
    detail,
  };
}

router.get('/', auth, requireAdmin, async (req, res) => {
  const checks = [Promise.resolve({
    name: 'Qureo Backend API',
    category: 'Core API',
    status: 'connected',
    checkedAt: new Date().toISOString(),
  })];

  if (process.env.STRIPE_SECRET_KEY) {
    checks.push(probeService('Stripe', 'Payment gateway', () => axios.get('https://api.stripe.com/v1/balance', {
      timeout: PROBE_TIMEOUT_MS,
      auth: { username: process.env.STRIPE_SECRET_KEY, password: '' },
    })));
  } else {
    checks.push(Promise.resolve(configuredService('Stripe', 'Payment gateway', false, 'Secret key is not configured')));
  }

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID) {
    checks.push(probeService('Twilio Verify', 'Messaging API', () => axios.get(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID)}.json`,
      {
        timeout: PROBE_TIMEOUT_MS,
        auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
      },
    )));
  } else {
    checks.push(Promise.resolve(configuredService('Twilio Verify', 'Messaging API', false, 'Account or Verify credentials are not configured')));
  }

  if (process.env.OPENAI_API_KEY) {
    checks.push(probeService('OpenAI', 'AI API', () => axios.get('https://api.openai.com/v1/models', {
      timeout: PROBE_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    })));
  } else {
    checks.push(Promise.resolve(configuredService('OpenAI', 'AI API', false, 'API key is not configured')));
  }

  if (process.env.SENDGRID_API_KEY) {
    checks.push(probeService('SendGrid', 'Email API', () => axios.get('https://api.sendgrid.com/v3/user/profile', {
      timeout: PROBE_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
    })));
  } else {
    checks.push(Promise.resolve(configuredService('SendGrid', 'Email API', false, 'API key is not configured')));
  }

  const firebaseStatus = getPushServiceStatus();
  checks.push(Promise.resolve(configuredService(
    'Firebase Cloud Messaging',
    'Push notifications',
    Boolean(firebaseStatus.initialized),
    firebaseStatus.initialized ? 'Admin SDK initialized' : firebaseStatus.error || 'Admin SDK is not initialized',
  )));

  const databaseState = mongoose.connection.readyState === 1 ? 'connected' : 'error';
  checks.push(Promise.resolve({
    name: 'MongoDB',
    category: 'Database',
    status: databaseState,
    checkedAt: new Date().toISOString(),
  }));

  const services = await Promise.all(checks);
  return res.json({ checkedAt: new Date().toISOString(), services });
});

module.exports = router;