const express = require("express");
const NotificationToken  = require("../models/NotificationToken.js");
const NotificationEvent = require("../models/NotificationEvent.js");
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');

const router = express.Router();

const resolveUserId = (req) => req.userId || req.body?.userId || req.query?.userId;

router.get('/admin', auth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 200);
    const [notifications, totalEvents, unreadEvents, registeredDevices, eventTypes] = await Promise.all([
      NotificationEvent.find({})
        .select('userId type title body read createdAt')
        .populate('userId', 'fullName email')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      NotificationEvent.countDocuments({}),
      NotificationEvent.countDocuments({ read: false }),
      NotificationToken.countDocuments({}),
      NotificationEvent.distinct('type'),
    ]);

    return res.json({
      notifications,
      summary: {
        totalEvents,
        unreadEvents,
        registeredDevices,
        eventTypes: eventTypes.length,
      },
    });
  } catch (err) {
    console.error('Error fetching admin notification feed:', err);
    return res.status(500).json({ message: 'Failed to fetch notification activity' });
  }
});

// 🔹 Save or update user's FCM token
router.post("/save-token", auth, async (req, res) => {
  try {
    const { token, platform = "unknown" } = req.body || {};
    const userId = resolveUserId(req);

    if (!token) {
      return res.status(400).json({ message: "token is required" });
    }

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    console.log("📱 Saving push token:", {
      userId,
      platform,
      tokenPreview: `${token.substring(0, 15)}...`,
    });

    const existing = await NotificationToken.findOne({ userId });

    if (existing) {
      existing.token = token;
      existing.platform = platform;
      existing.updatedAt = new Date();

      await existing.save();

      console.log("✅ Push token UPDATED:", {
        userId,
        platform,
      });

      return res.json({
        message: "Token updated",
        token,
        userId,
        platform,
      });
    }

    const newToken = await NotificationToken.create({
      userId,
      token,
      platform,
    });

    console.log("✅ Push token CREATED:", {
      userId,
      platform,
    });

    return res.json({
      message: "Token saved successfully",
      token,
      userId,
      platform,
    });

  } catch (err) {
    console.error("❌ Error saving token:", err);
    return res.status(500).json({
      message: "Server error",
    });
  }
});

// 🔹 Get current user's token status
router.get('/token', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ message: "userId is required" });
    const tokenData = await NotificationToken.findOne({ userId });
    if (!tokenData) return res.status(404).json({ message: "No token found" });
    res.json(tokenData);
  } catch (err) {
    console.error("Error fetching token:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// 🔹 Remove current user's token (disable push)
router.delete('/token', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ message: "userId is required" });
    await NotificationToken.deleteOne({ userId });
    res.json({ message: 'Token removed' });
  } catch (err) {
    console.error('Error deleting token:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// 🔹 Create notification event for current user
router.post('/events', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const { type = 'general', title, body = '', icon = '🔔', data = {}, read = false } = req.body || {};
    if (!title) {
      return res.status(400).json({ message: 'title is required' });
    }

    const created = await NotificationEvent.create({
      userId,
      type,
      title,
      body,
      icon,
      data,
      read: Boolean(read),
    });

    return res.status(201).json({
      notification: created,
    });
  } catch (err) {
    console.error('Error creating notification event:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// 🔹 Fetch notification feed for current user
router.get('/feed', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const limit = Math.min(Number(req.query?.limit) || 100, 200);
    const notifications = await NotificationEvent.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ notifications });
  } catch (err) {
    console.error('Error fetching notification feed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// 🔹 Mark one notification as read
router.patch('/events/:id/read', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const updated = await NotificationEvent.findOneAndUpdate(
      { _id: req.params.id, userId },
      { $set: { read: true } },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    return res.json({ notification: updated });
  } catch (err) {
    console.error('Error marking notification read:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// 🔹 Mark all notifications as read for current user
router.patch('/events/read-all', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const result = await NotificationEvent.updateMany(
      { userId, read: false },
      { $set: { read: true } }
    );

    return res.json({ updatedCount: result.modifiedCount || 0 });
  } catch (err) {
    console.error('Error marking all notifications read:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// 🔹 Dismiss one notification
router.delete('/events/:id', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const result = await NotificationEvent.deleteOne({ _id: req.params.id, userId });
    if (!result.deletedCount) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    return res.json({ message: 'Notification removed' });
  } catch (err) {
    console.error('Error deleting notification:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// 🔹 Clear current user's notifications
router.delete('/events', auth, async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const result = await NotificationEvent.deleteMany({ userId });
    return res.json({ deletedCount: result.deletedCount || 0 });
  } catch (err) {
    console.error('Error clearing notifications:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
