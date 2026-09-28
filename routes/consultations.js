const express = require("express");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const Consultation = require("../models/Consultations");
const Doctor = require("../models/Doctor");
const Profile = require("../models/Profile");
const Prescription = require("../models/Prescription");
const auth = require("../middleware/auth");
const doctorAuth = require('../middleware/doctorAuth');
const moment = require("moment-timezone");
const sendEmail = require("../utils/email");
const sendSMS = require("../utils/sms");
const { notifyUser } = require("../utils/notifyUser");

const STATUS_ACTIVE_FOR_CONFLICT = ["scheduled", "ongoing", "pending", "confirmed"];
const STATUS_ACTIVE_FOR_REMINDERS = ["scheduled", "ongoing", "confirmed"];

const weekdayKeyForDate = (dateInput) => {
  const date = new Date(dateInput);
  return date.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
};

const isWithinRange = (dateInput, range) => {
  const [start, end] = String(range || "").split("-");
  if (!start || !end) return false;

  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;

  const date = new Date(dateInput);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  return minutes >= startMinutes && minutes < endMinutes;
};

const isSlotAvailableFromDoctorSchedule = (doctor, appointmentTime) => {
  const key = weekdayKeyForDate(appointmentTime);
  const ranges = doctor?.availability?.[key] || [];
  return ranges.some((range) => isWithinRange(appointmentTime, range));
};

const notifyViaAllChannels = async ({
  ownerId,
  email,
  phone,
  subject,
  text,
  pushTitle,
  pushBody,
  pushData = {}
}) => {

  console.log("🔥 notifyViaAllChannels CALLED");
  console.log("ownerId:", ownerId);
  console.log("pushData:", pushData);

  const results = await Promise.allSettled([
    sendEmail(email, subject, text),
    sendSMS(phone, text),
    sendSMS.sendWhatsApp
      ? sendSMS.sendWhatsApp(phone, text)
      : Promise.resolve(false),

    (async () => {
      console.log("🔥 ABOUT TO CALL notifyUser()");

      const result = await notifyUser({
        userId: ownerId,
        type: pushData.type,
        title: pushTitle,
        body: pushBody,
        data: pushData,
      });

      console.log("🔥 notifyUser() FINISHED:", result);

      return result;
    })(),
  ]);

  console.log("🔥 notifyViaAllChannels RESULTS:", results);

  return results;
};

const resolveDurationMinutes = (duration, durationMinutes) => {
  const directDuration = Number(durationMinutes);
  if (Number.isFinite(directDuration) && directDuration > 0) {
    return Math.round(directDuration);
  }

  const fallbackDuration = Number(duration);
  if (Number.isFinite(fallbackDuration) && fallbackDuration > 0) {
    return Math.round(fallbackDuration);
  }

  return 30;
};

  const router = express.Router();
  // start background checker once
  if (!global.__consultationCheckerStarted) {
    global.__consultationCheckerStarted = true;

    const CHECK_INTERVAL_MS = 10 * 1000; // 10 seconds

    async function checkConsultations() {

      console.log("[consultation-check] Running consultation status check...");
      try {
        const now = new Date();
        // fetch scheduled consultations that are near (within next 31 minutes) or already due
        const windowAhead = new Date(now.getTime() + 31 * 60 * 1000);
        const candidates = await Consultation.find({ status: { $in: STATUS_ACTIVE_FOR_REMINDERS }, appointmentTime: { $lte: windowAhead } });

        for (const c of candidates) {
          const diffMs = c.appointmentTime.getTime() - now.getTime();
          const diffMinutes = Math.floor(diffMs / 60000);

          // 30 minutes before — send booking reminder once
          if (diffMs <= 30 * 60 * 1000 && diffMs > 0 && !c.notified30min) {
            console.log(`[consultation-check] Consultation ${c._id} for patient ${c.patient} scheduled in ${diffMinutes} minutes — sending 30-min notification`);
            try {
              const patientEmail = c.patientEmail || (c.patient_ && c.patient_.email);
              const doctorName = (c.doctor_ && (c.doctor_.name || c.doctor_.fullName)) || 'your doctor';
              const apptTime = new Date(c.appointmentTime).toLocaleString();
              const subject = `Upcoming consultation with ${doctorName} in 30 minutes`;
              const text = `Hi,\n\nThis is a reminder that your consultation with ${doctorName} is scheduled to start at ${apptTime}. Please be ready and join on time.\n\nThanks.`;
              await sendEmail(patientEmail, subject, text);
            } catch (errEmail) {
              console.error('[consultation-check] Failed to send 30-min email:', errEmail);
            }

            try {
              const doctorName = (c.doctor_ && (c.doctor_.name || c.doctor_.fullName)) || 'your doctor';
              const pushMessage = `Your consultation with ${doctorName} starts in about 30 minutes. Please get ready.`;
              await notifyViaAllChannels({
                ownerId: c.patient,
                email: c.patientEmail || c.patient_?.email,
                phone: c.patientPhone || c.patient_?.phone,
                subject: 'Consultation in 30 minutes',
                text: pushMessage,
                pushTitle: '🗓️ Consultation in 30 minutes',
                pushBody: pushMessage,
                pushData: {
                  consultationId: String(c._id),
                  roomId: c.roomId,
                  type: 'consultation_30min',
                  route: `/call/${c.roomId}`,
                  ring: true,
                },
              });
              console.log(`[consultation-check] Sent 30-min push to patient ${c.patient}`);
            } catch (errPush) {
              console.error('[consultation-check] Failed to send 30-min push:', errPush);
            }

            // also notify the doctor
            try {
              let doctorContact = c.doctor_ || null;
              if (!doctorContact) {
                try { doctorContact = await Doctor.findById(c.doctor).lean(); } catch (e) { doctorContact = null; }
              }
              const doctorEmail = doctorContact && (doctorContact.email || doctorContact.emailAddress);
              const doctorPhone = doctorContact && (doctorContact.phone || doctorContact.mobile || doctorContact.phoneNumber);
              const docName = doctorContact && (doctorContact.name || doctorContact.fullName) || 'Doctor';
              if (doctorEmail) {
                const subjectDoc = `Upcoming consultation with ${c.patient_?.name || 'a patient'} in 30 minutes`;
                const textDoc = `Hi ${docName},\n\nYou have a consultation scheduled with ${c.patient_?.name || 'a patient'} at ${new Date(c.appointmentTime).toLocaleString()}. This is a 30-minute reminder.\n\nThanks.`;
                await sendEmail(doctorEmail, subjectDoc, textDoc);
              }
              if (doctorPhone) {
                const sms = `Reminder: consultation with ${c.patient_?.name || 'a patient'} in 30 minutes at ${new Date(c.appointmentTime).toLocaleTimeString()}`;
                await sendSMS(doctorPhone, sms);
              }
              
            } catch (errDocNotify) {
              console.error('[consultation-check] Failed to notify doctor (30-min):', errDocNotify);
            }

            await Consultation.findByIdAndUpdate(c._id, { notified30min: true, updatedAt: new Date() });
          }

          // time to start (or already started)
          if (diffMs <= 0 && (c.status === 'scheduled' || c.status === 'confirmed')) {
            console.log(`[consultation-check] Consultation ${c._id} is starting now. Updating status -> ongoing`);
            // send start email then mark ongoing
            try {
              console.log("found for email")
              const patientEmail = c.patientEmail || (c.patient_ && c.patient_.email);
              const doctorName = (c.doctor_ && (c.doctor_.name || c.doctor_.fullName)) || 'your doctor';
              const apptTime = new Date(c.appointmentTime).toLocaleString();
              const subject = `Your consultation with ${doctorName} is starting now`;
              const text = `Hi,\n\nYour consultation with ${doctorName} scheduled for ${apptTime} is starting now. Please join the session.\n\nThanks. \n\n Join here: https://qureo.vercel.app/call/${c.roomId}`;
              await sendEmail(patientEmail, subject, text);
            } catch (errEmail) {
              console.error('[consultation-check] Failed to send start email:', errEmail);
            }

            try {
              const doctorName = (c.doctor_ && (c.doctor_.name || c.doctor_.fullName)) || 'your doctor';
              const pushMessage = `Your consultation with ${doctorName} is starting now. Tap to join.`;
              await notifyViaAllChannels({
                ownerId: c.patient,
                email: c.patientEmail || c.patient_?.email,
                phone: c.patientPhone || c.patient_?.phone,
                subject: 'Consultation is starting now',
                text: pushMessage,
                pushTitle: '🔔 Consultation is starting now',
                pushBody: pushMessage,
                pushData: {
                  consultationId: String(c._id),
                  roomId: c.roomId,
                  type: 'consultation_started',
                  route: `/call/${c.roomId}`,
                  ring: true,
                },
              });
              console.log(`[consultation-check] Sent start push to patient ${c.patient}`);
            } catch (errPush) {
              console.error('[consultation-check] Failed to send start push:', errPush);
            }

            // notify doctor at start (email + SMS)
            try {
              let doctorContact = c.doctor_ || null;
              if (!doctorContact) {
                try { doctorContact = await Doctor.findById(c.doctor).lean(); } catch (e) { doctorContact = null; }
              }
              const doctorEmail = doctorContact && (doctorContact.email || doctorContact.emailAddress);
              const doctorPhone = doctorContact && (doctorContact.phone || doctorContact.mobile || doctorContact.phoneNumber);
              const docName = doctorContact && (doctorContact.name || doctorContact.fullName) || 'Doctor';
              if (doctorEmail) {
                const subjectDoc = `Consultation starting now with ${c.patient_?.name || 'a patient'}`;
                const textDoc = `Hi ${docName},\n\nYour consultation with ${c.patient_?.name || 'a patient'} scheduled for ${new Date(c.appointmentTime).toLocaleString()} is starting now. Please join the session.\n\nJoin here: https://qureo.vercel.app/call/${c.roomId}`;
                await sendEmail(doctorEmail, subjectDoc, textDoc);
                console.log(`[consultation-check] Sent start email to doctor ${doctorEmail}`);
              }
              if (doctorPhone) {
                const sms = `Call starting: consultation with ${c.patient_?.name || 'a patient'} now — join room ${c.roomId}`;
                await sendSMS(doctorPhone, sms);
                console.log(`[consultation-check] Sent start SMS to doctor ${doctorPhone}`);
              }
            } catch (errDocNotify) {
              console.error('[consultation-check] Failed to notify doctor (start):', errDocNotify);
            }

            await Consultation.findByIdAndUpdate(c._id, { status: 'ongoing', notifiedStart: true, updatedAt: new Date() });
            // optionally emit socket event if io provided
            try { if (io && io.emit) io.emit('consultation_started', { consultationId: c._id }); } catch (e) { /* ignore */ }
          }
        }

        // COMPLETE: mark consultations as completed when now is 2 hours after appointmentTime
        try {
          const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
          // find consultations that are still scheduled or ongoing but are at least 2 hours past their appointmentTime
          const toComplete = await Consultation.find({ status: { $in: ['scheduled', 'ongoing', 'confirmed'] }, appointmentTime: { $lte: twoHoursAgo } });
          for (const tc of toComplete) {
            console.log(`[consultation-check] Consultation ${tc._id} appointment was at ${tc.appointmentTime}. Marking as completed.`);
            await Consultation.findByIdAndUpdate(tc._id, { status: 'completed', updatedAt: new Date() });
            try { if (io && io.emit) io.emit('consultation_completed', { consultationId: tc._id }); } catch (e) { /* ignore */ }
          }
        } catch (errComplete) {
          console.error('[consultation-check] Error while marking consultations completed:', errComplete);
        }
      } catch (err) {
        console.error('[consultation-check] Error during checkConsultations:', err);
      }
    }

    // run immediately then every interval
   checkConsultations();
    setInterval(checkConsultations, CHECK_INTERVAL_MS);
  }

  // ------------------ Routes ------------------
  router.get("/", async (req, res) => {
    const result = await Consultation.find();
    res.json(result);
  });

  // Create a new consultation
  router.post("/", async (req, res) => {
    try {
      const {
        patient,
        doctor,
        mode,
        consultationType,
        appointmentTime,
        reason,
        patient_,
        patientEmail,
        doctor_,
        duration,
        durationMinutes,
        inPersonDetails = {},
        clinicDetails = {},
      } = req.body;

      console.log(req.body, "consultation")

      const resolvedDurationMinutes = resolveDurationMinutes(duration, durationMinutes);
      const roomId = `room-${uuidv4()}`;
      const isInPerson = mode === "in-person" || consultationType === "in-person";

      if (!patient || !doctor || !appointmentTime || !reason) {
        return res.status(400).json({ message: "Missing required booking details" });
      }

      const doctorDoc = await Doctor.findById(doctor).lean();
      if (!doctorDoc) {
        return res.status(404).json({ message: "Doctor not found" });
      }

      if (isInPerson && !isSlotAvailableFromDoctorSchedule(doctorDoc, appointmentTime)) {
        return res.status(400).json({ message: "Selected slot is outside doctor availability" });
      }

      const conflict = await Consultation.findOne({
        doctor,
        appointmentTime: new Date(appointmentTime),
        status: { $in: STATUS_ACTIVE_FOR_CONFLICT },
      }).lean();

      if (conflict) {
        return res.status(409).json({ message: "Selected slot is already booked" });
      }

      const createdStatus = isInPerson ? "pending" : "scheduled";
      const resolvedConsultationType = isInPerson ? "in-person" : "online";

      const consultation = await Consultation.create({
        patient,
        doctor,
        mode: isInPerson ? "in-person" : mode,
        consultationType: resolvedConsultationType,
        appointmentTime,
        durationMinutes: resolvedDurationMinutes,
        reason,
        roomId,
        status: createdStatus,
        patientEmail,
        patient_,
        doctor_,
        patientName: inPersonDetails.patientName || patient_?.fullName || patient_?.name || "",
        patientAge: Number.isFinite(Number(inPersonDetails.patientAge)) ? Number(inPersonDetails.patientAge) : null,
        patientPhone: inPersonDetails.patientPhone || patient_?.phone || "",
        reasonForVisit: inPersonDetails.reasonForVisit || reason,
        familyMemberName: inPersonDetails.familyMemberName || "",
        familyMemberRelation: inPersonDetails.familyMemberRelation || "",
        reports: Array.isArray(inPersonDetails.reports) ? inPersonDetails.reports : [],
        clinicDetails: {
          clinicName: clinicDetails.clinicName || doctorDoc.clinicName || "",
          address: clinicDetails.address || doctorDoc.city || doctorDoc.clinicName || "",
        },
      });

      if (isInPerson) {
        const doctorMessage = `New clinic visit request from ${consultation.patientName || "a patient"} for ${new Date(consultation.appointmentTime).toLocaleString()}.`;
        await notifyViaAllChannels({
          ownerId: doctor,
          email: doctorDoc.email,
          phone: doctorDoc.phone,
          subject: "New clinic visit request pending confirmation",
          text: doctorMessage,
          pushTitle: "Clinic booking request",
          pushBody: doctorMessage,
          pushData: { 
            consultationId: String(consultation._id), 
            status: consultation.status, 
            type: "in_person_pending",
            route: '/notification',
          },
        });
      } else {
        // Online consultation — notify the patient that their booking is confirmed
        const doctorName = doctorDoc.name || doctorDoc.fullName || 'your doctor';
        const apptStr = new Date(consultation.appointmentTime).toLocaleString();
        const patientBookingMsg = `Your consultation with ${doctorName} is booked for ${apptStr}. We'll remind you 30 minutes and 5 minutes before it starts.`;
        await notifyViaAllChannels({
          ownerId: patient,
          email: patientEmail || patient_?.email,
          phone: patient_?.phone || '',
          subject: 'Consultation booking confirmed',
          text: patientBookingMsg,
          pushTitle: '✅ Consultation Booked',
          pushBody: patientBookingMsg,
          pushData: {
            consultationId: String(consultation._id),
            roomId: consultation.roomId,
            type: 'consultation_booked',
            route: '/appoint',
          },
        });
      }

      res.status(201).json(consultation);
    } catch (err) {
      console.log(err.message);
      res.status(500).json({ message: "Failed to create consultation", error: err.message });
    }
  });

  router.get("/delete", async(req, res)=>{

  await Consultation.deleteMany();
  res.json("deleted every thing")
})
// Get consultations for a doctor (by id) - existing
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const consultations = await Consultation.find({ doctor: req.params.doctorId }).sort({ appointmentTime: 1 });
    res.json(consultations);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch consultations", error: err.message });
  }
});

// Get consultations for the authenticated doctor (protected via doctorAuth)
router.get('/doctor', doctorAuth, async (req, res) => {
  try {
    if (!req.doctorId) {
      return res.status(400).json({ message: 'doctorId is required' });
    }
    const consultations = await Consultation.find({ doctor: req.doctorId }).sort({ appointmentTime: 1 });
    res.json(consultations);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch consultations for doctor', error: err.message });
  }
});

// Get consultations for a patient
router.get("/patient/:patientId", auth, async (req, res) => {
  try {
    const consultations = await Consultation.find({ patient: req.params.patientId }).sort({ appointmentTime: 1 });
    res.json(consultations);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch consultations", error: err.message });
  }
});

// Get all chat sessions for a user (patient or doctor)
router.get('/chat-sessions', auth, async (req, res) => {
  console.log('🔥🔥 CHAT-SESSIONS ROUTE REACHED');

  try {
    console.log('🔥 req.userId:', req.userId);
    console.log('🔥 req.query:', req.query);

    const requestedUserId =
      req.query.userId ||
      req.query.patientId ||
      req.query.doctorId;

    const userId = req.userId || requestedUserId;

    console.log('🔥 resolved userId:', userId);

    if (!userId) {
      return res.status(400).json({
        message: 'userId is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        message: 'userId must be a valid MongoDB ObjectId',
      });
    }

    console.log('🔥 ObjectId valid');

    const objectUserId = new mongoose.Types.ObjectId(userId);

    console.log('🔥 About to query Consultation');

    const consultations = await Consultation.find({
      $and: [
        {
          $or: [
            { patient: objectUserId },
            { doctor: objectUserId },
          ],
        },
        {
          $or: [
            { mode: 'chat' },
            { chatSaved: true },
          ],
        },
      ],
    })
      .sort({ updatedAt: -1 })
      .lean();

    console.log('🔥 Consultation query completed:', consultations.length);

    const normalized = consultations.map((consultation) => ({
      ...consultation,
      lastMessage:
        Array.isArray(consultation.chat) && consultation.chat.length > 0
          ? consultation.chat[consultation.chat.length - 1]
          : null,
    }));

    console.log('🔥 Sending chat sessions response');

    return res.json({
      consultations: normalized,
    });

  } catch (err) {
    console.error('🔥🔥 CHAT-SESSIONS ERROR:', err);
    console.error('Stack:', err?.stack);

    return res.status(500).json({
      message: 'Failed to fetch consultation chats',
      error: err.message,
    });
  }
});
router.post('/room/:roomId/save-chat', auth, async (req, res) => {
  try {
    const consultation = await Consultation.findOne({ roomId: req.params.roomId });
    if (!consultation) {
      return res.status(404).json({ message: 'Consultation not found' });
    }

    const userId = String(req.userId || '');
    const patientId = String(consultation.patient);
    const doctorId = String(consultation.doctor);
    if (userId !== patientId && userId !== doctorId) {
      return res.status(403).json({ message: 'You are not allowed to save this consultation chat.' });
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 500) : [];
    if (!messages.length) {
      return res.status(400).json({ message: 'There are no chat messages to save.' });
    }

    const chat = messages.map((message) => {
      const requestedRole = String(message?.sender || '').toLowerCase();
      const senderRole = requestedRole === 'doctor' || requestedRole === 'patient'
        ? requestedRole
        : userId === patientId ? 'patient' : 'doctor';
      const timestamp = new Date(message?.timestamp || message?.sentAt || Date.now());

      return {
        text: typeof message?.text === 'string' ? message.text : '',
        attachments: [],
        senderId: senderRole === 'patient' ? patientId : doctorId,
        senderName: typeof message?.senderName === 'string' ? message.senderName : senderRole,
        senderRole,
        sentAt: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
      };
    });

    const mergedChat = [...(Array.isArray(consultation.chat) ? consultation.chat : [])];
    const existingMessageKeys = new Set(mergedChat.map((message) => [
      String(message.senderRole || ''),
      String(message.text || ''),
      new Date(message.sentAt || 0).getTime(),
    ].join('|')));

    for (const message of chat) {
      const messageKey = [message.senderRole, message.text, message.sentAt.getTime()].join('|');
      if (!existingMessageKeys.has(messageKey)) {
        mergedChat.push(message);
        existingMessageKeys.add(messageKey);
      }
    }

    consultation.chat = mergedChat.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
    consultation.chatSaved = true;
    consultation.updatedAt = new Date();
    await consultation.save();

    return res.json({ success: true, consultationId: String(consultation._id), savedCount: chat.length });
  } catch (err) {
    console.error('[consultation-chat] Failed to save call transcript:', err);
    return res.status(500).json({ message: 'Failed to save consultation chat.' });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const consultation = await Consultation.findById(req.params.id).lean();
    if (!consultation) return res.status(404).json({ message: "Consultation not found" });
    res.json(consultation);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch consultation", error: err.message });
  }
});

router.get('/:id/chat', auth, async (req, res) => {
  try {
    const consultation = await Consultation.findById(req.params.id).lean();
    if (!consultation) {
      return res.status(404).json({ message: 'Consultation not found' });
    }

    const participantIds = [String(consultation.patient), String(consultation.doctor)];
    const authUserId = req.userId ? String(req.userId) : '';
    const isParticipant = authUserId && participantIds.includes(authUserId);

    if (!isParticipant && (!req.query.userId || !participantIds.includes(String(req.query.userId)))) {
      return res.status(403).json({ message: 'You are not allowed to access this consultation chat.' });
    }

    const chatExpiresAt = new Date(new Date(consultation.appointmentTime).getTime() + 48 * 60 * 60 * 1000);
    const chatExpired = new Date() > chatExpiresAt;

    const chat = Array.isArray(consultation.chat)
      ? consultation.chat
          .slice()
          .sort((a, b) => new Date(a.sentAt || 0) - new Date(b.sentAt || 0))
          .map((message) => ({
            ...message,
            attachments: Array.isArray(message.attachments) ? message.attachments : [],
            text: typeof message.text === 'string' ? message.text : '',
          }))
      : [];

    return res.json({ chat, chatExpiresAt, chatExpired });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch chat messages', error: err.message });
  }
});

router.post('/:id/chat', auth, async (req, res) => {
  try {
    const { text = '', senderName = '', attachments = [] } = req.body || {};
    const consultation = await Consultation.findById(req.params.id).lean();

    if (!consultation) {
      return res.status(404).json({ message: 'Consultation not found' });
    }

    const chatExpiresAt = new Date(new Date(consultation.appointmentTime).getTime() + 48 * 60 * 60 * 1000);
    if (new Date() > chatExpiresAt) {
      return res.status(403).json({ message: 'Chat session has expired. You can only view messages now.', chatExpired: true });
    }

    console.log("consultation details", consultation)
    const authUserId = req.userId ? String(req.userId) : '';
    const patientId = consultation.patient ? String(consultation.patient) : '';
    const doctorId = consultation.doctor ? String(consultation.doctor) : '';
    const allowedParticipantIds = [patientId, doctorId].filter(Boolean);
    const userIsParticipant = authUserId && allowedParticipantIds.includes(authUserId);

    console.log('[CHAT DEBUG]', {
      authUserId,
      patientId,
      doctorId,
      allowedParticipantIds,
      userIsParticipant,
      consultationId: consultation._id,
      consultationPatientType: typeof consultation.patient,
      consultationDoctorType: typeof consultation.doctor,
    });

    if (!userIsParticipant) {
      return res.status(403).json({ 
        message: 'You are not allowed to send messages in this consultation chat.',
        debug: { authUserId, patientId, doctorId, allowedParticipantIds, consultationId: String(consultation._id) }
      });
    }

    const normalizedText = typeof text === 'string' ? text.trim() : '';
    const normalizedAttachments = Array.isArray(attachments)
      ? attachments
          .filter((file) => file && typeof file.url === 'string' && file.url.trim())
          .slice(0, 5)
          .map((file) => ({
            name: typeof file.name === 'string' ? file.name : 'Shared file',
            url: file.url,
            mimeType: typeof file.mimeType === 'string' ? file.mimeType : '',
            size: Number(file.size) || 0,
            type: typeof file.type === 'string' ? file.type : 'file',
          }))
      : [];

    if (!normalizedText && normalizedAttachments.length === 0) {
      return res.status(400).json({ message: 'Message or file attachment is required' });
    }

    const resolvedSenderRole = authUserId === patientId ? 'patient' : 'doctor';

    const message = {
      text: normalizedText,
      attachments: normalizedAttachments,
      senderId: authUserId,
      senderName: typeof senderName === 'string' && senderName.trim() ? senderName.trim() : resolvedSenderRole === 'patient' ? 'Patient' : 'Doctor',
      senderRole: resolvedSenderRole,
      sentAt: new Date(),
    };

    await Consultation.findByIdAndUpdate(req.params.id, { $push: { chat: message }, updatedAt: new Date() });

    return res.status(201).json({ message });
  } catch (err) {
    console.error('[CHAT ERROR]', err);
    return res.status(500).json({ message: 'Failed to send chat message', error: err.message });
  }
});


// Cancel consultation
router.put("/:id/cancel", auth, async (req, res) => {
  try {
    const consultation = await Consultation.findByIdAndUpdate(
      req.params.id,
      { status: "cancelled", updatedAt: new Date() },
      { new: true }
    );
    if (!consultation) {
      return res.status(404).json({ message: "Consultation not found" });
    }
    res.json(consultation);
  } catch (err) {
    res.status(500).json({ message: "Failed to cancel consultation", error: err.message });
  }
});

// Doctor confirms in-person consultation
router.put('/:id/confirm', doctorAuth, async (req, res) => {
  try {
    if (!req.doctorId) {
      return res.status(400).json({ message: 'doctorId is required' });
    }

    const consultation = await Consultation.findById(req.params.id);
    if (!consultation) {
      return res.status(404).json({ message: 'Consultation not found' });
    }

    if (String(consultation.doctor) !== String(req.doctorId)) {
      return res.status(403).json({ message: 'Only assigned doctor can confirm this booking' });
    }

    if (consultation.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending consultation can be confirmed' });
    }

    consultation.status = 'confirmed';
    consultation.confirmedByDoctorId = req.doctorId;
    consultation.confirmedAt = new Date();
    consultation.updatedAt = new Date();
    await consultation.save();

    const patientMessage = `Your clinic visit with ${consultation?.doctor_?.name || 'doctor'} is confirmed for ${new Date(consultation.appointmentTime).toLocaleString()}.`;
    await notifyViaAllChannels({
      ownerId: consultation.patient,
      email: consultation.patientEmail || consultation?.patient_?.email,
      phone: consultation.patientPhone || consultation?.patient_?.phone,
      subject: 'Clinic visit confirmed',
      text: patientMessage,
      pushTitle: 'Clinic visit confirmed',
      pushBody: patientMessage,
      pushData: { 
        consultationId: String(consultation._id), 
        status: consultation.status, 
        type: 'in_person_confirmed',
        route: '/notification', // Links to notifications page for consultation details
      },
    });

    res.json(consultation);
  } catch (err) {
    res.status(500).json({ message: 'Failed to confirm consultation', error: err.message });
  }
});

// Doctor marks no-show for in-person consultation
router.put('/:id/no-show', doctorAuth, async (req, res) => {
  try {
    if (!req.doctorId) {
      return res.status(400).json({ message: 'doctorId is required' });
    }

    const consultation = await Consultation.findById(req.params.id);
    if (!consultation) {
      return res.status(404).json({ message: 'Consultation not found' });
    }

    if (String(consultation.doctor) !== String(req.doctorId)) {
      return res.status(403).json({ message: 'Only assigned doctor can update this booking' });
    }

    if (!["pending", "confirmed"].includes(consultation.status)) {
      return res.status(400).json({ message: 'Only pending or confirmed bookings can be marked no_show' });
    }

    consultation.status = 'no_show';
    consultation.updatedAt = new Date();
    await consultation.save();

    res.json(consultation);
  } catch (err) {
    res.status(500).json({ message: 'Failed to mark no_show', error: err.message });
  }
});

// Reschedule consultation
router.put("/:id/reschedule", auth, async (req, res) => {
  try {
    const { appointmentTime } = req.body;
    const existing = await Consultation.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ message: "Consultation not found" });
    }

    const nextStatus = existing.consultationType === 'in-person' || existing.mode === 'in-person'
      ? 'pending'
      : 'scheduled';

    const consultation = await Consultation.findByIdAndUpdate(
      req.params.id,
      { appointmentTime, status: nextStatus, updatedAt: new Date(), notifiedBefore: false, notifiedStart: false },
      { new: true }
    );
    res.json(consultation);
  } catch (err) {
    res.status(500).json({ message: "Failed to reschedule consultation", error: err.message });
  }
});

// Mark consultation completed (used when paid time expires in call room)
router.put("/:id/complete", async (req, res) => {
  try {
    const { reason = "time_elapsed", endedAt = new Date().toISOString(), callDuration } = req.body || {};
    const update = {
      status: "completed",
      updatedAt: new Date(),
      endedAt: new Date(endedAt),
      completionReason: reason,
    };

    if (Number.isFinite(Number(callDuration)) && Number(callDuration) >= 0) {
      update.callDuration = Number(callDuration);
    }

    const consultation = await Consultation.findByIdAndUpdate(req.params.id, update, { new: true });

    if (!consultation) {
      return res.status(404).json({ message: "Consultation not found" });
    }

    try {
      await notifyUser({
        userId: consultation.patient,
        type: 'consultation_summary',
        title: 'Consultation summary available',
        body: 'Your consultation has been completed and the summary is ready.',
        balancedTitle: 'Consultation completed',
        balancedBody: 'Your consultation summary is ready.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to view your consultation summary.',
        route: '/notification',
        data: {
          consultationId: String(consultation._id),
          status: 'completed',
          endedAt: update.endedAt.toISOString(),
        },
      });
    } catch (notifyError) {
      console.warn('[consultations] push failed on consultation complete:', notifyError?.message || notifyError);
    }

    res.json({ success: true, consultation });
  } catch (err) {
    res.status(500).json({ message: "Failed to complete consultation", error: err.message });
  }
});

// Create doctor-issued prescription records for the consultation patient
router.post("/:id/prescription/create", async (req, res) => {
  try {
    const consultation = await Consultation.findById(req.params.id);
    if (!consultation) {
      return res.status(404).json({ success: false, error: "Consultation not found" });
    }

    const medicines = Array.isArray(req.body?.medicines)
      ? req.body.medicines.filter((med) => med && String(med.name || "").trim())
      : [];

    if (!medicines.length) {
      return res.status(400).json({ success: false, error: "At least one medicine is required" });
    }

    const sharedData = {
      source: "doctor_consultation",
      consultationId: consultation._id,
      patientId: consultation.patient,
      doctorId: consultation.doctor,
      doctorName: consultation?.doctor_?.name || "Doctor",
      instructions: req.body?.instructions || "",
      followUpDate: req.body?.followUpDate || null,
      diagnosis: req.body?.diagnosis || "",
      doctorNotes: req.body?.doctorNotes || "",
      labTests: Array.isArray(req.body?.labTests) ? req.body.labTests.filter(Boolean) : [],
      issuedDate: new Date(),
      requiresPharmacistReview: false,
      owner: String(consultation.patient || ""),
    };

    const docs = medicines.map((med) => ({
      ...sharedData,
      medicineName: med.name,
      dosage: med.dosage || "",
      frequency: med.frequency || "",
      duration: med.duration || "",
    }));

    const saved = await Prescription.insertMany(docs);

    try {
      await notifyUser({
        userId: consultation.patient,
        type: 'consultation_notes',
        title: 'Doctor shared notes or a prescription',
        body: 'Your consultation notes are ready in Qureo.',
        balancedTitle: 'Prescription available',
        balancedBody: 'Your doctor shared consultation notes or a prescription.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to view your consultation notes.',
        route: '/my-health-records',
        data: {
          consultationId: String(consultation._id),
          prescriptionIds: saved.map((item) => String(item._id)),
        },
      });
    } catch (notifyError) {
      console.warn('[consultations] push failed on prescription create:', notifyError?.message || notifyError);
    }

    return res.status(201).json({
      success: true,
      data: {
        prescription: {
          consultationId: consultation._id,
          patientId: consultation.patient,
          doctorId: consultation.doctor,
          doctorName: consultation?.doctor_?.name || "Doctor",
          medicines,
          instructions: sharedData.instructions,
          followUpDate: sharedData.followUpDate,
          diagnosis: sharedData.diagnosis,
          doctorNotes: sharedData.doctorNotes,
          labTests: sharedData.labTests,
          issuedDate: sharedData.issuedDate,
          ids: saved.map((item) => item._id),
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || "Failed to save prescription" });
  }
});

// Delete consultation
router.delete("/:id", auth, async (req, res) => {
  try {
    await Consultation.findByIdAndDelete(req.params.id);
    res.json({ message: "Consultation deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete consultation", error: err.message });
  }
});

  // Add other routes as needed...

 


module.exports = router;

