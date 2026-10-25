const twilio = require("twilio");
require("dotenv").config();
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

const hasTwilioConfig =
  !!ACCOUNT_SID &&
  !!AUTH_TOKEN &&
  !!VERIFY_SERVICE_SID;

const devOtpStore = new Map();
const DEV_OTP_TTL_MS = 10 * 60 * 1000;
const DEV_OTP_CODE = "123456";

const twilioClient = hasTwilioConfig
  ? twilio(ACCOUNT_SID, AUTH_TOKEN)
  : null;

function sanitizePhone(phone) {
  return String(phone || "")
    .replace(/\s+/g, "")
    .trim();
}

function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function getDevKey(phone, userId) {
  return `${userId || "anonymous"}::${phone}`;
}

/**
 * SEND OTP
 */
async function sendOtp({
  phone,
  userId,
  channel = "sms",
}) {
  const normalizedPhone = sanitizePhone(phone);

  if (!isValidE164(normalizedPhone)) {
    const err = new Error(
      "Phone number must be in E.164 format. Example: +231770123456"
    );
    err.code = "INVALID_PHONE";
    throw err;
  }

  /**
   * TWILIO VERIFY
   */
  if (hasTwilioConfig && twilioClient) {
    try {
      const verification =
        await twilioClient.verify.v2
          .services(VERIFY_SERVICE_SID)
          .verifications.create({
            to: normalizedPhone,
            channel,
          });

      return {
        provider: "twilio",
        sid: verification.sid,
        status: verification.status,
        channel: verification.channel,
        to: verification.to,
      };
    } catch (error) {
      console.error(
        "Twilio send OTP error:",
        error.message
      );

      const err = new Error(
        "Unable to send verification code."
      );
      err.code = "OTP_SEND_FAILED";
      throw err;
    }
  }

  /**
   * DEV FALLBACK
   */
  if (process.env.NODE_ENV === "production") {
    const err = new Error("Phone verification is not configured.");
    err.code = "OTP_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const key = getDevKey(
    normalizedPhone,
    userId
  );

  devOtpStore.set(key, {
    code: DEV_OTP_CODE,
    expiresAt: Date.now() + DEV_OTP_TTL_MS,
  });

  return {
    provider: "dev-fallback",
    sid: `dev-${Date.now()}`,
    status: "pending",
    channel,
    to: normalizedPhone,
    developmentCode: DEV_OTP_CODE,
  };
}

/**
 * VERIFY OTP
 */
async function verifyOtp({
  phone,
  userId,
  code,
}) {
  const normalizedPhone = sanitizePhone(phone);
  const normalizedCode = String(code || "").trim();

  if (!isValidE164(normalizedPhone)) {
    const err = new Error(
      "Phone number must be in E.164 format."
    );
    err.code = "INVALID_PHONE";
    throw err;
  }

  if (!/^\d{4,8}$/.test(normalizedCode)) {
    const err = new Error(
      "OTP code format is invalid."
    );
    err.code = "INVALID_OTP";
    throw err;
  }

  /**
   * TWILIO VERIFY
   */
  if (hasTwilioConfig && twilioClient) {
    try {
      const check =
        await twilioClient.verify.v2
          .services(VERIFY_SERVICE_SID)
          .verificationChecks.create({
            to: normalizedPhone,
            code: normalizedCode,
          });

      return {
        provider: "twilio",
        approved:
          check.status === "approved",
        status: check.status,
      };
    } catch (error) {
      console.error(
        "Twilio verify OTP error:",
        error.message
      );

      return {
        provider: "twilio",
        approved: false,
        status: "failed",
      };
    }
  }

  /**
   * DEV FALLBACK
   */
  if (process.env.NODE_ENV === "production") {
    const err = new Error("Phone verification is not configured.");
    err.code = "OTP_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const key = getDevKey(
    normalizedPhone,
    userId
  );

  const record = devOtpStore.get(key);

  if (!record) {
    return {
      provider: "dev-fallback",
      approved: false,
      status: "not_found",
    };
  }

  if (Date.now() > record.expiresAt) {
    devOtpStore.delete(key);

    return {
      provider: "dev-fallback",
      approved: false,
      status: "expired",
    };
  }

  const approved =
    record.code === normalizedCode;

  if (approved) {
    devOtpStore.delete(key);
  }

  return {
    provider: "dev-fallback",
    approved,
    status: approved
      ? "approved"
      : "invalid_code",
  };
}

module.exports = {
  hasTwilioConfig,
  sendOtp,
  verifyOtp,
};