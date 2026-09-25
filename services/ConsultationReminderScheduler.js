const Consultation = require('../models/Consultations');
const NotificationToken = require('../models/NotificationToken');
const { sendPushToToken } = require('../utils/pushService');
const sendEmail = require('../utils/email');


console.log("page is alive")
/**
 * Runs every minute and fires two notifications per consultation:
 *  1. 5 minutes before appointmentTime  (notifiedBefore flag)
 *  2. At/past appointmentTime           (notifiedStart flag)
 */
class ConsultationReminderScheduler {
  constructor() {
    this.interval = null;
    this.isRunning = false;
    this.lastRun = null;
    this.stats = { runs: 0, pushSent: 0, emailSent: 0, failed: 0 };
  }

  start() {
    if (this.interval) return;
    console.log('[consultation-reminder] Scheduler started (1 min interval)');
    this.interval = setInterval(() => this.run(), 60 * 1000);
    this.run(); // run once immediately on start
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      stats: this.stats,
    };
  }

  async run() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastRun = new Date();
    this.stats.runs += 1;

    try {
      const now = new Date();

      // --- 30-min warning ---
      const in30 = new Date(now.getTime() + 30 * 60 * 1000);
      const in29 = new Date(now.getTime() + 29 * 60 * 1000);
      const coming30 = await Consultation.find({
        status: { $in: ['scheduled', 'confirmed'] },
        notified30min: { $ne: true },
        appointmentTime: { $gte: in29, $lte: in30 },
      }).lean();

      for (const c of coming30) {
        await this._notify(c, {
          title: '🗓️ Consultation in 30 minutes',
          body: `Your consultation with ${c.doctor_?.name || 'your doctor'} starts in 30 minutes. Tap to prepare.`,
          type: 'consultation_30min',
          flag: 'notified30min',
        });
      }

      // --- 5-min warning: appointmentTime is between now and now+5min ---
      const in5 = new Date(now.getTime() + 5 * 60 * 1000);
      const in4 = new Date(now.getTime() + 4 * 60 * 1000);
      const comingSoon = await Consultation.find({
        status: { $in: ['scheduled', 'confirmed'] },
        notifiedBefore: { $ne: true },
        appointmentTime: { $gte: in4, $lte: in5 },
      }).lean();

      for (const c of comingSoon) {
        await this._notify(c, {
          title: '📞 Your consultation starts in 5 minutes',
          body: `Your consultation with ${c.doctor_?.name || 'your doctor'} starts soon. Get ready!`,
          type: 'consultation_starting_soon',
          flag: 'notifiedBefore',
        });
      }

      // --- At start time: appointmentTime is in the past but within last 5 min ---
      const fiveAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const starting = await Consultation.find({
        status: { $in: ['scheduled', 'confirmed'] },
        notifiedStart: { $ne: true },
        appointmentTime: { $gte: fiveAgo, $lte: now },
      }).lean();

      for (const c of starting) {
        // Ring notification - device will ring with alarm sound and vibration
        await this._notify(c, {
          title: '🔔 Your consultation is starting now!',
          body: `Your consultation with ${c.doctor_?.name || 'your doctor'} is starting. Join now!`,
          type: 'consultation_started',
          flag: 'notifiedStart',
          ring: true,
        });
      }
    } catch (err) {
      console.error('[consultation-reminder] Run error:', err.message || err);
    } finally {
      this.isRunning = false;
    }
  }

  async _notify(consultation, { title, body, type, flag, ring }) {
    const patientId = String(consultation.patient);
    const roomId = consultation.roomId;
    let delivered = false;

    // --- Push notification ---
    const tokenDoc = await NotificationToken.findOne({ userId: patientId }).lean();
    if (tokenDoc?.token) {
      const result = await sendPushToToken(
        tokenDoc.token,
        title,
        body,
        {
          type,
          consultationId: String(consultation._id),
          roomId,
          route: `/call/${roomId}`,
          ring: ring !== false,
        }
      );

      if (result.success) {
        this.stats.pushSent += 1;
        delivered = true;
        console.log(`[consultation-reminder] Push sent to patient ${patientId} (${type})`);
      } else {
        this.stats.failed += 1;
        console.warn(`[consultation-reminder] Push failed for ${patientId}: ${result.reason}`);
      }
    }

    // --- Email fallback ---
    if (consultation.patientEmail) {
      try {
        const emailSent = await sendEmail(
          consultation.patientEmail,
          title,
          body,
          `<p>${body}</p><p><a href="https://app.qureohealth.com/call/${roomId}">Join consultation</a></p>`
        );
        if (emailSent) {
          delivered = true;
          this.stats.emailSent += 1;
          console.log(`[consultation-reminder] Email sent to ${consultation.patientEmail} (${type})`);
        }
      } catch (err) {
        console.warn(`[consultation-reminder] Email failed for ${consultation.patientEmail}: ${err.message}`);
      }
    }

    // Do not consume the reminder when every delivery channel failed.
    if (delivered) {
      await Consultation.updateOne(
        { _id: consultation._id },
        { $set: { [flag]: true } }
      );
    }
  }
}

module.exports = new ConsultationReminderScheduler();
