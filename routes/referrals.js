const express = require('express');
const crypto = require('crypto');
const Referral = require('../models/Referral');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const sendEmail = require('../utils/email');

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmails = (emails = []) => {
  if (!Array.isArray(emails)) return [];
  return [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
};

const createInviteCode = () => {
  return `REF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

router.get('/admin', auth, requireAdmin, async (req, res) => {
  try {
    const referrals = await Referral.find({})
      .select('inviter inviteeEmail channel status emailSent acceptedAt createdAt updatedAt')
      .populate('inviter', 'fullName email')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    return res.json({ referrals });
  } catch (err) {
    console.error('referrals/admin list error:', err);
    return res.status(500).json({ message: 'Failed to fetch referrals' });
  }
});

router.post('/invite', auth, async (req, res) => {
  try {
    const inviterId = req.userId;
    const inviterName = req.user?.fullName || 'A friend';
    const inviterEmail = (req.user?.email || '').toLowerCase();

    const emails = normalizeEmails(req.body?.emails);
    const channel = ['email', 'share', 'copy', 'unknown'].includes(req.body?.channel) ? req.body.channel : 'email';

    if (emails.length === 0) {
      return res.status(400).json({ message: 'At least one email is required.' });
    }

    if (emails.length > 25) {
      return res.status(400).json({ message: 'You can invite up to 25 recipients at once.' });
    }

    const validEmails = [];
    const invalidEmails = [];

    for (const email of emails) {
      if (!EMAIL_REGEX.test(email) || email === inviterEmail) {
        invalidEmails.push(email);
      } else {
        validEmails.push(email);
      }
    }

    if (validEmails.length === 0) {
      return res.status(400).json({ message: 'No valid recipient emails found.', invalidEmails });
    }

    const appBase = process.env.APP_URL || 'https://app.qureohealth.com';
    const created = [];
    let delivered = 0;
    let failed = 0;

    for (const email of validEmails) {
      const inviteCode = createInviteCode();
      const inviteLink = `${appBase.replace(/\/$/, '')}/invite/${inviteCode}`;

      const referral = await Referral.create({
        inviter: inviterId,
        inviteeEmail: email,
        inviteCode,
        inviteLink,
        channel,
      });

      let emailSent = false;
      let emailError = '';

      try {
        const subject = `${inviterName} invited you to join Qureo`;
        const text = `${inviterName} invited you to join Qureo. Use this link to get started: ${inviteLink}`;
        emailSent = await sendEmail(email, subject, text);
      } catch (err) {
        emailError = err?.message || 'Unknown email error';
      }

      if (emailSent) {
        delivered += 1;
      } else {
        failed += 1;
      }

      referral.emailSent = Boolean(emailSent);
      referral.emailError = emailSent ? '' : (emailError || 'Delivery was not confirmed');
      await referral.save();

      created.push(referral);
    }

    return res.status(201).json({
      message: 'Invites processed',
      summary: {
        attempted: validEmails.length,
        delivered,
        failed,
        invalid: invalidEmails.length,
      },
      invalidEmails,
      invites: created.map((r) => ({
        id: r._id,
        inviteeEmail: r.inviteeEmail,
        inviteCode: r.inviteCode,
        inviteLink: r.inviteLink,
        emailSent: r.emailSent,
      })),
    });
  } catch (err) {
    console.error('referrals/invite error:', err);
    return res.status(500).json({ message: 'Failed to send invites' });
  }
});

router.get('/mine', auth, async (req, res) => {
  try {
    const inviterId = req.userId;

    const [recent, totalInvites, totalAccepted, totalDelivered] = await Promise.all([
      Referral.find({ inviter: inviterId }).sort({ createdAt: -1 }).limit(20).lean(),
      Referral.countDocuments({ inviter: inviterId }),
      Referral.countDocuments({ inviter: inviterId, status: 'accepted' }),
      Referral.countDocuments({ inviter: inviterId, emailSent: true }),
    ]);

    return res.json({
      stats: {
        totalInvites,
        totalAccepted,
        totalDelivered,
        pending: Math.max(totalInvites - totalAccepted, 0),
      },
      invites: recent,
    });
  } catch (err) {
    console.error('referrals/mine error:', err);
    return res.status(500).json({ message: 'Failed to fetch referrals' });
  }
});

router.post('/accept/:inviteCode', async (req, res) => {
  try {
    const inviteCode = String(req.params.inviteCode || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!inviteCode || !email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: 'Valid inviteCode and email are required.' });
    }

    const referral = await Referral.findOne({ inviteCode, inviteeEmail: email });
    if (!referral) return res.status(404).json({ message: 'Invite not found.' });

    if (referral.status !== 'accepted') {
      referral.status = 'accepted';
      referral.acceptedAt = new Date();
      await referral.save();
    }

    return res.json({ message: 'Invite accepted.', referralId: referral._id });
  } catch (err) {
    console.error('referrals/accept error:', err);
    return res.status(500).json({ message: 'Failed to accept invite' });
  }
});

module.exports = router;
