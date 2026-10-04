const express = require('express');
const auth = require('../middleware/auth');
const SupportTicket = require('../models/SupportTicket');

const router = express.Router();

const FAQS = [
  {
    id: 'faq-1',
    question: 'How do I reset my password?',
    answer: 'Go to Sign In, tap "Forgot password", then follow the reset instructions sent to your email.',
  },
  {
    id: 'faq-2',
    question: 'How do I upload my health records?',
    answer: 'Open My Health Records, tap "Upload" and select an image or PDF. You can also scan directly from your phone.',
  },
  {
    id: 'faq-3',
    question: 'How do I contact a doctor quickly?',
    answer: 'Use Talk to a Doctor from Home or Doctor Directory to start chat/video consultation.',
  },
];

router.get('/faqs', auth, async (req, res) => {
  return res.json({ faqs: FAQS });
});

router.get('/tickets', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const tickets = await SupportTicket.find({ user: userId }).sort({ createdAt: -1 }).limit(20);
    return res.json({ tickets });
  } catch (err) {
    console.error('support/tickets get error:', err);
    return res.status(500).json({ message: 'Failed to fetch support tickets' });
  }
});

router.post('/tickets', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const { category, subject, message } = req.body || {};

    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ message: 'subject is required' });
    }

    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: 'message is required' });
    }

    const allowed = new Set(['account', 'billing', 'technical', 'medical-records', 'other']);

    const ticket = await SupportTicket.create({
      user: userId,
      category: allowed.has(category) ? category : 'other',
      subject: String(subject).trim(),
      message: String(message).trim(),
      status: 'open',
    });

    return res.status(201).json({
      message: 'Support ticket submitted',
      ticket,
    });
  } catch (err) {
    console.error('support/tickets post error:', err);
    return res.status(500).json({ message: 'Failed to submit support ticket' });
  }
});

/**
 * Support tickets carry personal health data, so admin-wide access is never
 * anonymous. The project has no role field on User, so authorisation is an
 * explicit id allowlist: SUPPORT_ADMIN_IDS=id1,id2 in the environment.
 */
function requireSupportAdmin(req, res, next) {
  const userId = req.userId || req.user?._id;
  const allowed = (process.env.SUPPORT_ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (userId && allowed.includes(String(userId))) {
    return next();
  }

  return res.status(403).json({ message: 'Support admin access required' });
}

// Admin: every ticket across all users, newest first.
router.get('/admin/tickets', auth, requireSupportAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const tickets = await SupportTicket.find()
      .sort({ createdAt: -1 })
      .limit(limit);
    return res.json({ tickets });
  } catch (err) {
    console.error('support/admin/tickets get error:', err);
    return res.status(500).json({ message: 'Failed to fetch support tickets' });
  }
});

// Admin: move a ticket through its workflow.
router.patch('/admin/tickets/:id', auth, requireSupportAdmin, async (req, res) => {
  try {
    const allowed = ['open', 'in_progress', 'resolved', 'closed'];
    const { status } = req.body || {};

    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${allowed.join(', ')}` });
    }

    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    return res.json({ message: 'Ticket updated', ticket });
  } catch (err) {
    console.error('support/admin/tickets patch error:', err);
    return res.status(500).json({ message: 'Failed to update support ticket' });
  }
});

module.exports = router;
