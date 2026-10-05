const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { notifyUser } = require('../utils/notifyUser');
const auth = require('../middleware/auth');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'qureo-local-dev-auth-secret');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function serializeUser(user) {
  return {
    id: user._id,
    fullName: user.fullName,
    email: user.email,
    authProvider: user.authProvider || 'password',
  };
}

function issueToken(user) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET or AUTH_SECRET is required');
  }

  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      authProvider: user.authProvider || 'password',
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function secureStringEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''));
  const right = Buffer.from(String(rightValue || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function sendPasswordResetEmail({ email, resetUrl }) {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    MAIL_FROM,
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn(`[auth] SMTP is not configured. Password reset URL for ${email}: ${resetUrl}`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_PORT || 587) === '465',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to: email,
    subject: 'Reset your Qureo password',
    text: `Reset your Qureo password using this link: ${resetUrl}\n\nThis link expires in 30 minutes.`,
    html: `<p>Reset your Qureo password using the link below.</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in 30 minutes.</p>`,
  });
  return true;
}

async function verifyGoogleToken(idToken) {
  const verifyOptions = { idToken };
  if (process.env.GOOGLE_CLIENT_ID) {
    verifyOptions.audience = process.env.GOOGLE_CLIENT_ID;
  }

  const ticket = await googleClient.verifyIdToken(verifyOptions);
  const payload = ticket.getPayload();

  if (!payload?.sub || !payload?.email) {
    throw new Error('Google token missing required identity claims');
  }

  if (!payload.email_verified) {
    throw new Error('Google account email is not verified');
  }

  return payload;
}

async function fetchGoogleProfileFromAccessToken(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Invalid Google access token');
  }

  const payload = await response.json();

  if (!payload?.sub || !payload?.email) {
    throw new Error('Google access token missing required identity claims');
  }

  if (!payload.email_verified) {
    throw new Error('Google account email is not verified');
  }

  return payload;
}

router.post('/signup', async (req, res) => {
  const { fullName, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

  try {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'User already exists' });

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const user = new User({ fullName: fullName || '', email: email.toLowerCase(), passwordHash: hash });
    await user.save();

    try {
      await notifyUser({
        userId: user._id,
        type: 'account_security_alert',
        title: 'Welcome to Qureo',
        body: 'Your account was created successfully.',
        balancedTitle: 'Account created',
        balancedBody: 'Your Qureo account is ready.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to finish setting up your account.',
        route: '/health-assessment',
        data: {
          event: 'signup',
          email: user.email,
        },
      });
    } catch (notifyError) {
      console.warn('[auth] push failed after signup:', notifyError?.message || notifyError);
    }

    res.json({
      user: serializeUser(user),
      token: issueToken(user),
    });

    try {
      await notifyUser({
        userId: user._id,
        type: 'account_security_alert',
        title: 'Signed in to Qureo',
        body: 'Your account was accessed successfully.',
        balancedTitle: 'Login successful',
        balancedBody: 'You just signed in to Qureo.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to continue.',
        route: '/home',
        data: {
          event: 'signin',
          email: user.email,
        },
      });
    } catch (notifyError) {
      console.warn('[auth] push failed after signin:', notifyError?.message || notifyError);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    if (!user.passwordHash) {
      return res.status(401).json({ message: 'This account uses Google sign-in' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return res.status(401).json({ message: 'Password not correct.' });

    res.json({
      user: serializeUser(user),
      token: issueToken(user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/admin-signin', (req, res) => {
  const configuredUsername = process.env.ADMIN_LOGIN_USERNAME;
  const configuredPassword = process.env.ADMIN_LOGIN_PASSWORD;

  if (!configuredUsername || !configuredPassword) {
    return res.status(503).json({ message: 'Admin console sign-in is not configured on the server' });
  }

  const usernameMatches = secureStringEqual(req.body?.username, configuredUsername);
  const passwordMatches = secureStringEqual(req.body?.password, configuredPassword);

  if (!usernameMatches || !passwordMatches) {
    return res.status(401).json({ message: 'Incorrect username or password' });
  }

  if (!JWT_SECRET) {
    return res.status(500).json({ message: 'Authentication is not configured on the server' });
  }

  const user = { _id: 'admin-console', email: configuredUsername };
  const token = jwt.sign(
    { sub: 'admin-console', role: 'admin-console' },
    JWT_SECRET,
    { expiresIn: '8h' },
  );

  return res.json({ user: serializeUser(user), token });
});

router.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const genericResponse = {
    message: 'If an account exists for that email, a password reset link has been sent.',
  };

  if (!email) return res.status(400).json({ message: 'Email is required' });

  try {
    const user = await User.findOne({ email });
    if (!user || !user.passwordHash) return res.json(genericResponse);

    const rawToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.passwordResetExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetUrl = `${frontendUrl.replace(/\/$/, '')}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail({ email, resetUrl });
    return res.json(genericResponse);
  } catch (err) {
    console.error('[auth] Password reset request failed:', err);
    return res.json(genericResponse);
  }
});

router.post('/reset-password', async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');

  if (!token || password.length < 8) {
    return res.status(400).json({ message: 'A valid reset token and password of at least 8 characters are required' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ message: 'This reset link is invalid or has expired' });

    user.passwordHash = await bcrypt.hash(password, await bcrypt.genSalt(10));
    user.authProvider = 'password';
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    return res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('[auth] Password reset failed:', err);
    return res.status(500).json({ message: 'Unable to reset password. Please try again.' });
  }
});

router.post('/google', async (req, res) => {
  const { idToken, credential, accessToken } = req.body || {};
  const effectiveIdToken = idToken || credential;
  if (!effectiveIdToken && !accessToken) {
    return res.status(400).json({ message: 'Google token required' });
  }

  try {
    const googleProfile = effectiveIdToken
      ? await verifyGoogleToken(effectiveIdToken)
      : await fetchGoogleProfileFromAccessToken(accessToken);
    const email = String(googleProfile.email || '').toLowerCase().trim();

    let user = await User.findOne({ email });
    let created = false;

    if (!user) {
      user = new User({
        fullName: googleProfile.name || email.split('@')[0] || '',
        email,
        passwordHash: null,
        googleId: googleProfile.sub,
        authProvider: 'google',
      });
      created = true;
    } else {
      if (!user.fullName && googleProfile.name) {
        user.fullName = googleProfile.name;
      }
      if (!user.googleId) {
        user.googleId = googleProfile.sub;
      }
      if (!user.authProvider) {
        user.authProvider = user.passwordHash ? 'password' : 'google';
      }
    }

    await user.save();

    try {
      await notifyUser({
        userId: user._id,
        type: 'account_security_alert',
        title: 'Google sign-in complete',
        body: 'You signed in with Google successfully.',
        balancedTitle: 'Google sign-in',
        balancedBody: 'Your Google account is connected to Qureo.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to continue.',
        route: '/home',
        data: {
          event: created ? 'google_signup' : 'google_signin',
          email,
        },
      });
    } catch (notifyError) {
      console.warn('[auth] push failed after google auth:', notifyError?.message || notifyError);
    }

    res.json({
      user: serializeUser(user),
      token: issueToken(user),
      created,
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ message: 'Google authentication failed' });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash -refreshToken');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({ user: serializeUser(user) });
  } catch (err) {
    console.error('Server error in /me:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Logout endpoint (no JWT needed)
router.post('/logout', async (req, res) => {
  try {
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});



module.exports = router;
