const fs = require('fs');
const path = require('path');

let initializeApp = null;
let cert = null;
let getMessaging = null;
let admin = null;

try {
  // Firebase Admin v10+ modular API
  ({ initializeApp, cert } = require('firebase-admin/app'));
  ({ getMessaging } = require('firebase-admin/messaging'));
} catch (modularError) {
  try {
    // Fallback for older Firebase Admin API
    admin = require('firebase-admin');
    initializeApp = admin.initializeApp.bind(admin);
    cert = (serviceAccount) => admin.credential.cert(serviceAccount);
    getMessaging = () => admin.messaging();
    console.warn('[Push Service] Using legacy firebase-admin API fallback');
  } catch (legacyError) {
    console.error('[Push Service] firebase-admin is not installed or failed to load:', legacyError?.message || legacyError);
  }
}

// Initialize Firebase Admin from service account key
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH;
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const serviceAccountSecret = process.env.FIREBASE_SERVICE_ACCOUNT;
const firebaseProjectIdEnv = process.env.FIREBASE_PROJECT_ID;
const firebaseClientEmailEnv = process.env.FIREBASE_CLIENT_EMAIL;
const firebasePrivateKeyEnv = process.env.FIREBASE_PRIVATE_KEY;
let firebaseApp = null;
let pushInitStatus = {
  initialized: false,
  source: 'none',
  reason: '',
};

function normalizeServiceAccount(serviceAccount) {
  if (!serviceAccount || typeof serviceAccount !== 'object') return null;
  const normalized = { ...serviceAccount };

  // Accept either snake_case or camelCase keys from different env sources.
  normalized.project_id = normalized.project_id || normalized.projectId || firebaseProjectIdEnv;
  normalized.client_email = normalized.client_email || normalized.clientEmail || firebaseClientEmailEnv;
  normalized.private_key = normalized.private_key || normalized.privateKey || firebasePrivateKeyEnv;

  if (typeof normalized.private_key === 'string') {
    normalized.private_key = normalized.private_key.replace(/\\n/g, '\n');
  }

  // Mirror back to camelCase for SDKs that read that shape.
  normalized.projectId = normalized.project_id;
  normalized.clientEmail = normalized.client_email;
  normalized.privateKey = normalized.private_key;

  if (!normalized.project_id || !normalized.client_email || !normalized.private_key) {
    return null;
  }
  return normalized;
}

function parseServiceAccountFromEnv() {
  if (firebaseProjectIdEnv && firebaseClientEmailEnv && firebasePrivateKeyEnv) {
    const parsed = normalizeServiceAccount({
      project_id: firebaseProjectIdEnv,
      client_email: firebaseClientEmailEnv,
      private_key: firebasePrivateKeyEnv,
    });
    if (parsed) {
      return { source: 'split_env', serviceAccount: parsed };
    }
  }

  if (serviceAccountSecret) {
    try {
      const parsed = JSON.parse(serviceAccountSecret);
      const normalized = normalizeServiceAccount(parsed);
      if (!normalized) {
        pushInitStatus.reason = 'FIREBASE_SERVICE_ACCOUNT missing project/client/private key fields';
      } else {
        return { source: 'env_secret', serviceAccount: normalized };
      }
    } catch (error) {
      pushInitStatus.reason = 'Invalid FIREBASE_SERVICE_ACCOUNT';
    }
  }

  if (serviceAccountJson) {
    try {
      const parsed = JSON.parse(serviceAccountJson);
      const normalized = normalizeServiceAccount(parsed);
      if (!normalized) {
        pushInitStatus.reason = 'FIREBASE_SERVICE_ACCOUNT_JSON missing project/client/private key fields';
      } else {
        return { source: 'env_json', serviceAccount: normalized };
      }
    } catch (error) {
      console.error('[Push Service] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', error.message);
      pushInitStatus.reason = 'Invalid FIREBASE_SERVICE_ACCOUNT_JSON';
    }
  }

  if (serviceAccountBase64) {
    try {
      const decoded = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      const normalized = normalizeServiceAccount(parsed);
      if (!normalized) {
        pushInitStatus.reason = 'FIREBASE_SERVICE_ACCOUNT_BASE64 missing project/client/private key fields';
      } else {
        return { source: 'env_base64', serviceAccount: normalized };
      }
    } catch (error) {
      console.error('[Push Service] Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:', error.message);
      pushInitStatus.reason = 'Invalid FIREBASE_SERVICE_ACCOUNT_BASE64';
    }
  }

  if (serviceAccountPath) {
    try {
      const parsed = JSON.parse(serviceAccountPath);
      const normalized = normalizeServiceAccount(parsed);
      if (normalized) {
        return { source: 'key_path_env_json', serviceAccount: normalized };
      }
    } catch {
      // This value is a filesystem path, handled below.
    }

    const resolvedServiceAccountPath = path.resolve(serviceAccountPath);
    if (!fs.existsSync(resolvedServiceAccountPath)) {
      console.warn(`[Push Service] Service account file not found at: ${resolvedServiceAccountPath}. Push notifications are disabled.`);
      pushInitStatus.reason = `Service account file not found at ${resolvedServiceAccountPath}`;
      return null;
    }

    try {
      const parsed = require(resolvedServiceAccountPath);
      const normalized = normalizeServiceAccount(parsed);
      if (!normalized) {
        pushInitStatus.reason = 'FIREBASE_SERVICE_ACCOUNT_KEY_PATH missing project/client/private key fields';
      } else {
        return { source: 'file_path', serviceAccount: normalized };
      }
    } catch (error) {
      console.error('[Push Service] Failed to read service account file:', error.message);
      pushInitStatus.reason = 'Unable to read FIREBASE_SERVICE_ACCOUNT_KEY_PATH JSON';
      return null;
    }
  }

  return null;
}

function normalizeDataPayload(data = {}) {
  const result = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string') {
      result[key] = value;
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
      return;
    }
    try {
      result[key] = JSON.stringify(value);
    } catch {
      result[key] = String(value);
    }
  });
  return result;
}

try {
  const credentialBundle = parseServiceAccountFromEnv();
  if (!credentialBundle) {
    if (!pushInitStatus.reason) {
      pushInitStatus.reason = 'No Firebase service account configured';
    }
    console.warn('[Push Service] Firebase service account not configured. Set FIREBASE_SERVICE_ACCOUNT, FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_BASE64, or FIREBASE_SERVICE_ACCOUNT_KEY_PATH.');
  } else {
    if (!initializeApp || !cert || !getMessaging) {
      pushInitStatus.reason = 'Firebase SDK loader unavailable';
      console.warn('[Push Service] Firebase SDK loader is unavailable. Push notifications are disabled.');
    } else {
      const serviceAccount = credentialBundle.serviceAccount;
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
      });
      pushInitStatus = {
        initialized: true,
        source: credentialBundle.source,
        reason: '',
      };
      console.log(`[Push Service] Firebase Admin initialized (project: ${process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id || 'unknown'}, source: ${credentialBundle.source})`);
    }
  }
} catch (err) {
  pushInitStatus.reason = err.message;
  console.error('[Push Service] Failed to initialize Firebase Admin:', err.message);
}

/**
 * Send a push notification to a device token using Firebase Cloud Messaging.
 * @param {string} token - Device FCM token
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Custom data payload (e.g., route, type, roomId)
 * @returns {Promise<{success: boolean, reason: string, messageId?: string}>}
 */
async function sendPushToToken(token, title, body, data = {}) {
  if (!firebaseApp) {
    return {
      success: false,
      reason: `Firebase Admin not initialized: ${pushInitStatus.reason || 'check Railway Firebase service account variables'}`,
    };
  }

  if (!token) {
    return { success: false, reason: 'No device token provided' };
  }

  try {
    const messaging = getMessaging(firebaseApp);

    // Ensure route field is present for deep-linking
    const enrichedData = normalizeDataPayload({
      ...data,
      route: data.route || '/notification', // fallback to notification page if no route specified
    });

    // Determine if this notification should ring the device (consultation alerts)
    const shouldRing = data.ring === true || (data.type && data.type.startsWith('consultation_'));

    const androidNotification = {
      channelId: 'qureo-alerts',
      clickAction: 'FLUTTER_NOTIFICATION_CLICK',
    };

    if (shouldRing) {
      androidNotification.sound = 'qureo_alarm';
      androidNotification.vibrate = [0, 500, 200, 500, 200, 1000];
      androidNotification.lightSettings = { color: '#FF5722', lightOnDurationMillis: 500, lightOffDurationMillis: 500 };
      androidNotification.visibility = 'public';
      androidNotification.audioAttributes = {
        usage: 2,
        flags: 64,
      };
    } else {
      androidNotification.sound = 'default';
    }

     // Build the message payload
     const message = {
       token,
       notification: {
         title,
         body,
       },
       data: enrichedData,
       android: {
         ttl: 3600, // 1 hour
         priority: 'high',
         notification: androidNotification,
       },
       apns: {
         payload: {
           aps: {
             sound: 'default',
             alert: {
               title,
               body,
             },
             badge: 1,
           },
         },
       },
     };

    const messageId = await messaging.send(message);

    console.log(`[Push Service] Message sent successfully (ID: ${messageId})`);
    return {
      success: true,
      messageId,
      reason: '',
    };
  } catch (error) {
    const reason = error?.message || 'FCM send failed';
    console.error('[Push Service] Error sending message:', reason);
    return {
      success: false,
      reason,
    };
  }
}

/**
 * Send multicast messages to multiple tokens at once.
 * @param {string[]} tokens - Array of device FCM tokens
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Custom data payload
 * @returns {Promise<{successCount: number, failureCount: number, reasons: string[]}>}
 */
async function sendPushToMultipleTokens(tokens, title, body, data = {}) {
  if (!firebaseApp) {
    return {
      successCount: 0,
      failureCount: Array.isArray(tokens) ? tokens.length : 0,
      reasons: ['Firebase Admin not initialized'],
    };
  }

  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, reasons: [] };
  }

  try {
    const messaging = getMessaging(firebaseApp);

    const enrichedData = normalizeDataPayload({
      ...data,
      route: data.route || '/notification',
    });

    const shouldRing = data.ring === true || (data.type && data.type.startsWith('consultation_'));

    const androidNotification = {
      channelId: 'qureo-alerts',
      clickAction: 'FLUTTER_NOTIFICATION_CLICK',
    };

    if (shouldRing) {
      androidNotification.sound = 'qureo_alarm';
      androidNotification.vibrate = [0, 500, 200, 500, 200, 1000];
      androidNotification.lightSettings = { color: '#FF5722', lightOnDurationMillis: 500, lightOffDurationMillis: 500 };
      androidNotification.visibility = 'public';
      androidNotification.audioAttributes = { usage: 2, flags: 64 };
    } else {
      androidNotification.sound = 'default';
    }

     const message = {
       notification: {
         title,
         body,
       },
       data: enrichedData,
       android: {
         ttl: 3600,
         priority: 'high',
         notification: androidNotification,
       },
       apns: {
         payload: {
           aps: {
             sound: 'default',
             alert: {
               title,
               body,
             },
             badge: 1,
           },
         },
       },
     };

    const response = await messaging.sendEachForMulticast({
      ...message,
      tokens,
    });

    console.log(
      `[Push Service] Multicast sent: ${response.successCount} succeeded, ${response.failureCount} failed`
    );

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      reasons: response.responses
        .filter((r) => !r.success)
        .map((r) => r.error?.message || 'Unknown error'),
    };
  } catch (error) {
    const reason = error?.message || 'Multicast send failed';
    console.error('[Push Service] Error in multicast:', reason);
    return {
      successCount: 0,
      failureCount: tokens.length,
      reasons: [reason],
    };
  }
}

module.exports = {
  sendPushToToken,
  sendPushToMultipleTokens,
  getPushServiceStatus: () => ({ ...pushInitStatus }),
};
