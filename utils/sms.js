const twilio = require('twilio');

let client = null;

async function sendSMS(to, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  if (!to) {
    console.warn('[SMS] Consultation notification skipped: patient phone number is missing');
    return { sent: false, reason: 'Patient phone number is missing' };
  }
  if (!accountSid || !authToken || !from) {
    console.warn('[SMS] Consultation notification skipped: Twilio messaging is not configured');
    return { sent: false, reason: 'SMS is not configured' };
  }

  try {
    if (!client) client = twilio(accountSid, authToken);
    await client.messages.create({ body: message, from, to: String(to) });
    return { sent: true };
  } catch (error) {
    console.error('[SMS] Consultation notification failed:', error.message);
    return { sent: false, reason: error.message };
  }
}

module.exports = sendSMS;