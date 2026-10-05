require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const axios = require('axios');
const { createServer } = require('http');
const { Server } = require('socket.io');
const Stripe = require("stripe")
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { notifyUser } = require("./utils/notifyUser");


//------------------------MODELS-----------------------//


const Transaction = require("./models/Transaction")
const Wallet = require("./models/Wallet")
const User = require("./models/User")
const Profile = require("./models/Profile")
const Activities = require("./models/Activities")
const BookingLabtest = require("./models/BookingLabtest")
const Cart = require("./models/Cart")
const Consultations = require("./models/Consultations")
const DailyHealthTip = require("./models/DailyHealthTip")
const Dependent = require("./models/Dependent")
const HabitReminderDispatch = require("./models/HabitReminderDispatch")
const HabitTrackerEntry = require("./models/HabitTrackerEntry")
const HealthAlert = require("./models/HealthAlert")
const HealthAssessment = require("./models/HealthAssessment")
const HealthGoal = require("./models/HealthGoal")
const HealthPlan = require("./models/HealthPlan")
const InsuranceClaim = require("./models/InsuranceClaim")
const InsuranceSubscription = require("./models/InsuranceSubscription")
const LinkedDevice = require("./models/LinkedDevice")
const Medication = require("./models/Medication")
const NotificationEvent = require("./models/NotificationEvent")
const NotificationToken = require("./models/NotificationToken")
const Order = require("./models/Order")
const PaymentCard = require("./models/PaymentCard")
const Prescription = require("./models/Prescription")
const ReminderDispatch = require("./models/ReminderDispatch")
const ScannedDocuments = require("./models/ScannedDocuments")
const SecuritySettings = require("./models/SecuritySettings")
const SupportTicket = require("./models/SupportTicket")
const SymptomChat = require("./models/SymptomChat")
const UserMedication = require("./models/UserMedication")
const Vitals = require("./models/Vitals")

// -------------------- Import existing routes --------------------
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const assessmentRoutes = require('./routes/assessment');
const earlyAccess = require('./routes/earlyAccess')
const medicineRoutes = require('./routes/medicine');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/order');
const pharmacyRoutes = require('./routes/pharmacy');
const consultationRoutes = require('./routes/consultations');
const dailyRoomRoutes = require('./routes/dailyRoom');
const doctorRoutes = require('./routes/doctor');
const gptRoutes = require('./routes/gpt');
const ashaRoutes = require('./routes/asha');
const authMiddleware = require('./middleware/auth');
const notificationTokenRoutes = require('./routes/notificationToken');
const doctorAuthRoutes = require('./routes/doctorAuth');
const blog = require('./routes/blogRoutes');
const labTestRoutes = require("./routes/labtest");
const booking = require("./routes/bookinglabtest");
const providerAuthRoutes = require("./routes/providerAuth");
const scanned_documents = require("./routes/scannedDocument");
const walletRoutes = require('./routes/wallet');
const insuranceRoutes = require('./routes/insurance');
const vision = require("./routes/scan-vision")
const prescription = require("./routes/prescription")
const providersRoutes = require('./routes/providerAuth');
//const benefitsRoutes = require('./routes/benefits');
//const providerRoutes = require('./routes/provider.routes');
//const notificationRoutes = require('./routes/notification.routes');
const activityRoutes = require('./routes/activityRoutes');
const searchRoutes = require('./routes/search');
const vitalsRoutes = require('./routes/vitals');
const healthAlertsRoutes = require('./routes/healthAlerts');
const medicationsRoutes = require('./routes/medications');
const medicationsManagementRoutes = require('./routes/medicationsManagement');
const healthPlansRoutes = require('./routes/healthPlans');
const remindersRoutes = require('./routes/reminders');
const metricsRoutes = require('./routes/metrics');
const referralRoutes = require('./routes/referrals');
const linkedDevicesRoutes = require('./routes/linkedDevices');
const paymentCardsRoutes = require('./routes/paymentCards');
const healthGoalsRoutes = require('./routes/healthGoals');
const healthTipsRoutes = require('./routes/healthTips');
const habitTrackerRoutes = require('./routes/habitTracker');
const securitySettingsRoutes = require('./routes/securitySettings');
const supportRoutes = require('./routes/support');
const adminProvidersRoutes = require('./routes/adminProviders');
const campaignsRoutes = require('./routes/campaigns');
const nearbyClinicsRoutes = require('./routes/nearbyClinics');
const newsLetter = require('./routes/newsletter');
// Health Monitoring Services
const HealthMonitoringScheduler = require('./services/HealthMonitoringScheduler');
const ReminderNotificationScheduler = require('./services/ReminderNotificationScheduler');
const DailyHealthTipScheduler = require('./services/DailyHealthTipScheduler');
const ConsultationReminderScheduler = require('./services/ConsultationReminderScheduler');
const TestPushBroadcastScheduler = require('./services/TestPushBroadcastScheduler');

// -------------------- Express app --------------------
const app = express();
const server = createServer(app);
const auth = authMiddleware;





app.use(express.json());
app.use(express.urlencoded({ extended: true }));








app.post(
  "/api/wallet/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("✅ Webhook verified:", event.type);

    // 🔥 Handle successful payment
    if (event.type === 'payment_intent.succeeded') {
   
         const paymentIntent = event.data.object;
         const userId = paymentIntent.metadata.userId;
         const amount = paymentIntent.amount / 100;
         console.log("payment succeed")
         // 🔥 Prevent duplicate credits
         const existingTransaction = await Transaction.findOne({
           stripePaymentIntentId: paymentIntent.id
         });
   
         if (existingTransaction) {
           return res.json({ received: true });
         }
   
         const session = await mongoose.startSession();
         session.startTransaction();
   
         try {
           let wallet = await Wallet.findOne({ user: userId }).session(session);
   
           if (!wallet) {
             wallet = new Wallet({
               user: userId,
               balance: 0,
               currency: 'USD',
               totalDeposits: 0
             });
           }
   
           const previousBalance = wallet.balance;
           const newBalance = previousBalance + amount;
   
           wallet.balance = newBalance;
           wallet.totalDeposits += amount;
           wallet.lastTransaction = new Date();
           await wallet.save({ session });
   
           const transaction = new Transaction({
             wallet: wallet._id,
             user: userId,
             type: 'deposit',
             amount,
             previousBalance,
             newBalance,
             status: 'completed',
             paymentMethod: 'stripe',
             stripePaymentIntentId: paymentIntent.id, // 🔐 critical
             description: `Stripe deposit of $${amount}`,
             reference: `STRIPE-${paymentIntent.id}`,
             completedAt: new Date()
           });
   
           await transaction.save({ session });
   
           await session.commitTransaction();
           session.endSession();
   
         } catch (error) {
           await session.abortTransaction();
           session.endSession();
           console.error(error);
         }
       }
   
       res.json({ received: true });

      }
);

// Webhook route ABOVE

app.use(express.json());
app.use(cookieParser());


// -------------------- CORS --------------------
const allowedOrigins = [
  'https://app.qureohealth.com',
  'https://qureo-pharmacies.vercel.app',
  'https://qureohealth.com',
  'https://qureo.vercel.app',
  'https://qureo-lab.vercel.app',
  'https://qureodoctor.vercel.app',
  'https://qureohealth.vercel.app',
  'https://qureodoctor.vercel.app',
  'http://192.168.208.23:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  "http://localhost:8005",
  'http://localhost:8088',
  "https://qureo-dashboard.lovable.app",
  "https://qureo-dashboard.vercel.app",
  "https://qureo-pharmacies.lovable.app",
  "https://app.qureohealth.com",
  "http://192.168.1.116:8080",
  "http://192.168.1.108:8080",
  "http://localhost:8081",
  "http://localhost:8005",
  "http://localhost:8080",
  "http://192.168.1.112:8080",
  "http://192.168.1.112:8082",
  "http://192.168.205.23:8080",
  "http://192.168.1.112:8080",
  "http://localhost:8070",

];

const allowedOriginPatterns = [
  /^https:\/\/([a-z0-9-]+\.)?qureohealth\.com$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^capacitor:\/\/localhost$/i,
  /^ionic:\/\/localhost$/i,
  /^http:\/\/10\.0\.2\.2(:\d+)?$/i,
];

function isAllowedOrigin(origin) {
  if (allowedOrigins.includes(origin)) return true;
  return allowedOriginPatterns.some((pattern) => pattern.test(origin));
}




app.use(cors({
  origin: (origin, callback) => {
    if (!origin || isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.delete("/api/delete-account", auth, async (req, res) => {
  try {
    const userId = req.userId || req.query.userId || req.body?.userId;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: "A valid user id is required to delete an account",
      });
    }

    const objectUserId = new mongoose.Types.ObjectId(userId);
    const user = await User.findById(objectUserId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const cleanupTasks = [
      Profile.deleteMany({ user: objectUserId }),
      HealthAssessment.deleteMany({ user: objectUserId }),
      Activities.deleteMany({ userId: objectUserId }),
      BookingLabtest.deleteMany({ user: objectUserId }),
      Cart.deleteMany({ user: objectUserId }),
      Consultations.deleteMany({ patient: objectUserId }),
      DailyHealthTip.deleteMany({ user: objectUserId }),
      Dependent.deleteMany({ owner: objectUserId }),
      HabitReminderDispatch.deleteMany({ user: objectUserId }),
      HabitTrackerEntry.deleteMany({ user: objectUserId }),
      HealthAlert.deleteMany({ user: objectUserId }),
      HealthGoal.deleteMany({ user: objectUserId }),
      HealthPlan.deleteMany({ user: objectUserId }),
      InsuranceClaim.deleteMany({ user: objectUserId }),
      InsuranceSubscription.deleteMany({ user: objectUserId }),
      LinkedDevice.deleteMany({ user: objectUserId }),
      Medication.deleteMany({ user: objectUserId }),
      NotificationEvent.deleteMany({ userId: objectUserId }),
      NotificationToken.deleteMany({ userId: objectUserId }),
      Order.deleteMany({ user: objectUserId }),
      PaymentCard.deleteMany({ user: objectUserId }),
      Prescription.deleteMany({
        $or: [
          { owner: String(userId) },
          { patientId: objectUserId },
        ],
      }),
      ReminderDispatch.deleteMany({ user: objectUserId }),
      ScannedDocuments.deleteMany({ user_id: objectUserId }),
      SecuritySettings.deleteMany({ user: objectUserId }),
      SupportTicket.deleteMany({ user: objectUserId }),
      SymptomChat.deleteMany({ user: objectUserId }),
      Transaction.deleteMany({ user: objectUserId }),
      UserMedication.deleteMany({ user: objectUserId }),
      Vitals.deleteMany({ user: objectUserId }),
      Wallet.deleteMany({
        $or: [
          { user: objectUserId },
          { user: String(userId) },
        ],
      }),
    ];

    const cleanupResults = await Promise.all(cleanupTasks);
    const deletedRecords = cleanupResults.reduce((sum, result) => sum + (result?.deletedCount || 0), 0);
    await User.findByIdAndDelete(objectUserId);

    return res.json({
      success: true,
      message: "Account deleted successfully",
      deletedRecords,
    });
  } catch (error) {
    console.error("Delete account error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete account",
    });
  }
});

// -------------------- Routes --------------------
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/vitals', vitalsRoutes);
app.use('/api/earlyaccess', earlyAccess)
app.use('/api/health-alerts', healthAlertsRoutes);
app.use('/api/health-plans', healthPlansRoutes);
app.use('/api/medications', medicationsRoutes);
app.use('/api/medications-management', medicationsManagementRoutes);
app.use('/api/reminders', remindersRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/linked-devices', linkedDevicesRoutes);
app.use('/api/payment-cards', paymentCardsRoutes);
app.use('/api/health-goals', healthGoalsRoutes);
app.use('/api/health-tips', healthTipsRoutes);
app.use('/api/habit-tracker', habitTrackerRoutes);
app.use('/api/security-settings', securitySettingsRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/admin/providers', adminProvidersRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/nearby-clinics', nearbyClinicsRoutes);
app.use('/api/medicines', medicineRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/consultations', consultationRoutes);
app.use('/api/daily-room', dailyRoomRoutes);
app.use('/api/doctor', doctorRoutes);
app.use('/api/doctor/auth', doctorAuthRoutes);
app.use('/api/gpt', gptRoutes);
app.use('/api/asha', ashaRoutes);
app.use('/api/notifications', notificationTokenRoutes);
app.use("/api/blogs", blog);
app.use("/api/labtests", labTestRoutes);
app.use("/api/lab-bookings", booking);
app.use("/api/providers", providerAuthRoutes);
app.use("/api/upload-health-records", scanned_documents);
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/insurance', insuranceRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/search', searchRoutes);
app.use("/api/prescriptions", vision);
app.use("/api/prescription", prescription)
app.use("/api/newsletter", newsLetter);
//app.use('/api/benefits', benefitsRoutes);
//app.use('/api/providers', providerRoutes);
//app.use('/api/notifications', notificationRoutes);
app.get('/', (req, res) => res.send('Auth & Signaling server running'));

// TEST ENDPOINT: Manually trigger health monitoring (for testing)
app.post('/api/test/trigger-health-check', async (req, res) => {
  try {
    console.log('🧪 Manual health check triggered via API');
    const result = await HealthMonitoringScheduler.runManually();
    res.json({
      success: true,
      message: 'Health check completed',
      result
    });
  } catch (error) {
    console.error('Error in manual health check:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run health check',
    error: error.message
    });
  }
});

// TEST ENDPOINT: Get scheduler status
app.get('/api/test/scheduler-status', (req, res) => {
  try {
    const status = HealthMonitoringScheduler.getStatus();
    res.json({
      success: true,
      status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/test/reminder-scheduler-status', (req, res) => {
  try {
    const status = ReminderNotificationScheduler.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test/daily-tip-scheduler-status', (req, res) => {
  try {
    const status = DailyHealthTipScheduler.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test/consultation-reminder-status', (req, res) => {
  try {
    const status = ConsultationReminderScheduler.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test/push-broadcast-status', (req, res) => {
  try {
    const status = TestPushBroadcastScheduler.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test/push-service-status', (req, res) => {
  try {
    const { getPushServiceStatus } = require('./utils/pushService');
    const status = getPushServiceStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// TEST ENDPOINT: Send a test push notification to the current user (authenticated)
app.post('/api/test/send-push-to-me', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID required' });
    }

    const { title, body, type, route } = req.body;
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'title and body are required' });
    }

    // Fetch the user's push token
    const NotificationToken = require('./models/NotificationToken');
    const tokenDoc = await NotificationToken.findOne({ userId }).lean();

    if (!tokenDoc?.token) {
      return res.status(404).json({
        success: false,
        message: 'No push token registered for this user. Please enable notifications in the app.',
      });
    }

    // Send push using the new service
    const { sendPushToToken } = require('./utils/pushService');
    const pushData = {
      type: type || 'test_push',
      route: route || '/notification',
      testSent: new Date().toISOString(),
    };

    const result = await sendPushToToken(tokenDoc.token, title, body, pushData);

    if (result.success) {
      return res.json({
        success: true,
        message: 'Push notification sent successfully',
        messageId: result.messageId,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Failed to send push notification',
        reason: result.reason,
      });
    }
  } catch (error) {
    console.error('Error sending test push:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while sending push',
      error: error.message,
    });
  }
});

// -------------------- MongoDB --------------------
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://edwardsyambasu_db_user:bxhuqJ83mhFQG78K@cluster0.nwnbuqt.mongodb.net/?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('✅ Connected to MongoDB');
  
  // Start Health Monitoring Scheduler after DB connection
  console.log('\n🏥 Initializing Health Monitoring System...');
  HealthMonitoringScheduler.start();

  // Start Reminder Notification Scheduler after DB connection
  console.log('🔔 Initializing Reminder Notification System...');
  ReminderNotificationScheduler.start();

  // Start Daily Health Tip Scheduler after DB connection
  console.log('💡 Initializing Daily Health Tip System...');
  DailyHealthTipScheduler.start();

  // Start Consultation Reminder Scheduler after DB connection
  console.log('📞 Initializing Consultation Reminder System...');
  ConsultationReminderScheduler.start();

  // Start Test Push Broadcast Scheduler after DB connection
  console.log('🧪 Initializing Test Push Broadcast System...');
  TestPushBroadcastScheduler.start();

  // Start the HTTP server only after MongoDB is ready so that
  // no incoming requests are handled before the database is available.
  const PORT = process.env.PORT || 5001;
  if (require.main === module) {
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  }
})
  .catch(err => console.error('❌ MongoDB connection error:', err));

// -------------------- ICE Servers (Cloudflare) --------------------
function getStaticTurnIceServers() {
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (!turnUrl || !turnUsername || !turnCredential) {
    return [];
  }

  return [
    {
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
    },
  ];
}

async function getCloudflareIceServers() {
  try {
    const username = process.env.XIRSYS_USER;
    const secret = process.env.XIRSYS_SECRET;
    const channel = process.env.XIRSYS_CHANNEL || "MyFirstApp";

    if (!username || !secret) {
      console.warn("❌ Xirsys TURN env is incomplete", {
        hasUser: !!username,
        hasSecret: !!secret,
      });
      return [];
    }

    const bodyString = JSON.stringify({ format: "urls" });
    const auth = Buffer.from(`${username}:${secret}`).toString("base64");

    console.log("🔐 Requesting Xirsys TURN credentials", { channel, username });

    const response = await axios.put(
      `https://global.xirsys.net/_turn/${channel}`,
      { format: "urls" },
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "Content-Length": bodyString.length,
        },
        timeout: 10000,
      }
    );

    const raw = response.data;

    console.log("✅ Xirsys TURN response received", response.data);

    // Xirsys returns iceServers as a single object, not an array
    const xirsysIce = raw?.v?.iceServers;
    let iceServers = [];
    if (Array.isArray(xirsysIce)) {
      iceServers = xirsysIce;
    } else if (xirsysIce && typeof xirsysIce === "object") {
      iceServers = [xirsysIce];
    }

    console.log("✅ Xirsys TURN parsed", {
      count: iceServers.length,
      urls: iceServers.map((s) => s.urls),
    });
    return iceServers;
  } catch (err) {
    console.error("❌ Failed to fetch Xirsys ICE servers", {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
    });
    return [];
  }
}

// -------------------- Socket.IO (WebRTC Signaling) --------------------
const io = new Server(server, { 
  cors: { 
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Socket CORS blocked for origin: ${origin}`));
    },
    credentials: true 
  } 
});

// Store active rooms
const activeRooms = new Map();

io.on("connection", (socket) => {
  console.log("🧠 Socket connected:", socket.id);

  // Join a room
  socket.on("webrtc-join-room", async (roomId) => {
    try {
      socket.join(roomId);
      console.log(`🔹 ${socket.id} joined room ${roomId}`);
      console.log("🔎 TURN/ICE join request:", {
        socketId: socket.id,
        roomId,
      });
      
      // Add socket to room tracking
      if (!activeRooms.has(roomId)) {
        activeRooms.set(roomId, new Set());
      }
      activeRooms.get(roomId).add(socket.id);

      // Send ICE servers (TURN/STUN)
      let iceServers = await getCloudflareIceServers();

      console.log("🔎 Cloudflare ICE servers before fallback:", {
        roomId,
        count: iceServers.length,
        serverTypes: iceServers.map((server) => server?.urls),
      });

      if (!iceServers.length) {
        const staticTurn = getStaticTurnIceServers();
        if (staticTurn.length) {
          iceServers = staticTurn;
          console.log("Using static TURN credentials from environment");
        }
      }

      if (iceServers.length === 0) {
        console.warn("TURN unavailable: falling back to STUN only");
        iceServers.push({ urls: "stun:stun.l.google.com:19302" });
      }

      console.log("📡 Emitting ICE servers to client:", {
        roomId,
        count: iceServers.length,
        serverTypes: iceServers.map((server) => server?.urls),
      });
      socket.emit("ice-servers", iceServers);

      // Get other users in the room
      const roomSockets = io.sockets.adapter.rooms.get(roomId);
      const otherUsers = Array.from(roomSockets || []).filter(id => id !== socket.id);

      if (otherUsers.length > 0) {
        // If there's already a user, notify both parties
        const existingUser = otherUsers[0];
        
        // Notify existing user about new user
        io.to(existingUser).emit("user-joined", { peerId: socket.id });
        
        // Notify new user about existing user
        socket.emit("user-joined", { peerId: existingUser });
        
        console.log(`🔁 Room ${roomId}: ${socket.id} joining ${existingUser}`);
      } else {
        console.log(`👤 First user in room ${roomId}: ${socket.id}`);
      }
    } catch (err) {
      console.error("Error on webrtc-join-room:", err);
    }
  });

  // Forward WebRTC offer
  socket.on("webrtc-offer", ({ offer, to }) => {
    console.log(`📤 Offer from ${socket.id} to ${to}`);
    if (to) {
      io.to(to).emit("webrtc-offer", { 
        offer, 
        from: socket.id 
      });
    }
  });

  // Forward WebRTC answer
  socket.on("webrtc-answer", ({ answer, to }) => {
    console.log(`📥 Answer from ${socket.id} to ${to}`);
    if (to) {
      io.to(to).emit("webrtc-answer", { 
        answer, 
        from: socket.id 
      });
    }
  });

  // Forward ICE candidates
  socket.on("webrtc-ice-candidate", ({ candidate, to }) => {
    if (to) {
      io.to(to).emit("webrtc-ice-candidate", { 
        candidate, 
        from: socket.id 
      });
    }
  });

  // Forward chat messages
  socket.on("chat-message", ({ room, message }) => {
    socket.to(room).emit("chat-message", { 
      message, 
      from: socket.id 
    });
  });

  // Allow user to join their personal notification room
  socket.on("joinRoom", (userId) => {
    if (userId) {
      socket.join(String(userId));
      console.log(`🔔 User ${userId} joined personal notification room`);
    }
  });

  // Forward doctor prescriptions to everyone else in the same consultation room
  socket.on("prescription-from-doctor", ({ room, prescription }) => {
    if (!room || !prescription) return;

    socket.to(room).emit("prescription-from-doctor", prescription);
    socket.emit("prescription-sent", { success: true, room });
  });

  // Handle user leaving
  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
    
    // Remove from active rooms
    activeRooms.forEach((sockets, roomId) => {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id);
        
        // Notify other users in the room
        sockets.forEach(otherSocketId => {
          io.to(otherSocketId).emit("user-left", { 
            peerId: socket.id 
          });
        });
        
        // Clean up empty rooms
        if (sockets.size === 0) {
          activeRooms.delete(roomId);
        }
      }
    });
  });
});



module.exports = { app, server, io };
