const {
  getDoctorAcceptanceStatuses,
  canDoctorAcceptConsultation,
  nextConsultationStatusAfterAcceptance,
  getDoctorStatusFilters,
} = require('../lib/consultationStatus');

describe('consultation status flow', () => {
  test('includes awaiting confirmation in doctor acceptance flow', () => {
    expect(getDoctorAcceptanceStatuses()).toContain('awaiting_confirmation');
    expect(canDoctorAcceptConsultation('awaiting_confirmation')).toBe(true);
    expect(nextConsultationStatusAfterAcceptance('awaiting_confirmation')).toBe('pending');
    expect(getDoctorStatusFilters()).toContain('awaiting_confirmation');
  });
});
