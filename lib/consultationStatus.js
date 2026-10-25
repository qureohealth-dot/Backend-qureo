const DOCTOR_ACCEPTANCE_STATUSES = ["awaiting_confirmation", "pending", "scheduled"];

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function getDoctorAcceptanceStatuses() {
  return [...DOCTOR_ACCEPTANCE_STATUSES];
}

function canDoctorAcceptConsultation(status) {
  return getDoctorAcceptanceStatuses().includes(normalizeStatus(status));
}

function nextConsultationStatusAfterAcceptance(status) {
  return "pending";
}

function getDoctorStatusFilters() {
  return [
    "all",
    "awaiting_confirmation",
    "pending",
    "confirmed",
    "scheduled",
    "ongoing",
    "completed",
    "cancelled",
  ];
}

module.exports = {
  DOCTOR_ACCEPTANCE_STATUSES,
  normalizeStatus,
  getDoctorAcceptanceStatuses,
  canDoctorAcceptConsultation,
  nextConsultationStatusAfterAcceptance,
  getDoctorStatusFilters,
};
