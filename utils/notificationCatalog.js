const CATEGORY_CATALOG = {
  health_journey: {
    label: 'Health journey',
  },
  ai_assistant: {
    label: 'AI Assistant',
  },
  doctor_consultations: {
    label: 'Doctor consultations',
  },
  pharmacy: {
    label: 'Pharmacy',
  },
  lab_services: {
    label: 'Lab services',
  },
  health_wallet: {
    label: 'Health Wallet',
  },
  remote_monitoring: {
    label: 'Remote monitoring',
  },
  health_records: {
    label: 'Health records',
  },
  health_campaigns: {
    label: 'Health campaigns',
  },
  preventive_care: {
    label: 'Preventive care',
  },
  womens_health: {
    label: "Women's health",
  },
  sexual_reproductive_health: {
    label: 'Sexual and reproductive health',
  },
  emergency_urgent_care: {
    label: 'Emergency and urgent care',
  },
  education: {
    label: 'Education',
  },
  community_engagement: {
    label: 'Community and engagement',
  },
  account_security: {
    label: 'Account and security',
  },
  payments_subscriptions: {
    label: 'Payments and subscriptions',
  },
};

const NOTIFICATION_TYPE_MAP = {
  assessment_ready: { category: 'health_journey' },
  ai_follow_up: { category: 'ai_assistant' },
  ai_insight: { category: 'ai_assistant' },
  ai_recommendation: { category: 'ai_assistant' },

  consultation_booked: { category: 'doctor_consultations' },
  consultation_30min: { category: 'doctor_consultations' },
  consultation_starting_soon: { category: 'doctor_consultations' },
  consultation_started: { category: 'doctor_consultations' },
  in_person_pending: { category: 'doctor_consultations' },
  in_person_confirmed: { category: 'doctor_consultations' },
  consultation_summary: { category: 'doctor_consultations' },
  consultation_notes: { category: 'doctor_consultations' },
  consultation_message: { category: 'doctor_consultations' },

  pharmacy_prescription_approved: { category: 'pharmacy' },
  pharmacy_medicine_ready: { category: 'pharmacy' },
  pharmacy_delivery_update: { category: 'pharmacy' },
  pharmacy_medication_time: { category: 'pharmacy' },
  pharmacy_refill_reminder: { category: 'pharmacy' },

  lab_booking_created: { category: 'lab_services' },
  lab_booking_status_updated: { category: 'lab_services' },
  lab_sample_reminder: { category: 'lab_services' },
  lab_result_available: { category: 'lab_services' },

  medication_reminder: { category: 'remote_monitoring' },
  care_plan_step: { category: 'remote_monitoring' },
  hydration_reminder: { category: 'remote_monitoring' },
  vitals_check_due: { category: 'remote_monitoring' },
  vital_abnormal: { category: 'remote_monitoring' },
  vital_warning: { category: 'remote_monitoring' },
  remote_reviewed: { category: 'remote_monitoring' },
  daily_health_tip: { category: 'education' },
  health_insight: { category: 'education' },
  progress_update: { category: 'health_journey' },
  health_journey_update: { category: 'health_journey' },

  wallet_payment_completed: { category: 'health_wallet' },
  lab_result_status_updated: { category: 'lab_services' },
  wallet_funded: { category: 'health_wallet' },
  dependent_linked: { category: 'health_wallet' },
  wallet_low_balance: { category: 'health_wallet' },
  wallet_cashback: { category: 'health_wallet' },
  wallet_reward: { category: 'health_wallet' },

  health_record_added: { category: 'health_records' },
  health_record_shared: { category: 'health_records' },
  health_record_accessed: { category: 'health_records' },

  campaign_available: { category: 'health_campaigns' },
  campaign_follow_up: { category: 'health_campaigns' },
  campaign_certificate: { category: 'health_campaigns' },

  preventive_due: { category: 'preventive_care' },
  womens_health_update: { category: 'womens_health' },
  srh_update: { category: 'sexual_reproductive_health' },
  emergency_alert: { category: 'emergency_urgent_care' },

  community_milestone: { category: 'community_engagement' },
  account_security_alert: { category: 'account_security' },
  subscription_update: { category: 'payments_subscriptions' },

  test_push: { category: 'account_security' },
  test_broadcast: { category: 'account_security' },
};

function getNotificationTypeConfig(type) {
  const normalizedType = String(type || '').trim().toLowerCase();
  return NOTIFICATION_TYPE_MAP[normalizedType] || { category: 'health_journey' };
}

module.exports = {
  CATEGORY_CATALOG,
  NOTIFICATION_TYPE_MAP,
  getNotificationTypeConfig,
};
