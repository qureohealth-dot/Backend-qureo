const Consultation = require('../models/Consultations');
const Transaction = require('../models/Transaction');

describe('Consultation in-person model contract', () => {
  test('allows pending/confirmed/no_show statuses', () => {
    const doc = new Consultation({
      patient: '507f1f77bcf86cd799439011',
      doctor: '507f191e810c19729de860ea',
      patient_: { name: 'Patient One' },
      doctor_: { name: 'Doctor One' },
      mode: 'in-person',
      consultationType: 'in-person',
      appointmentTime: new Date('2026-06-10T09:00:00.000Z'),
      reason: 'Clinic checkup',
      roomId: 'room-test-1',
      patientEmail: 'patient@example.com',
      status: 'pending',
    });

    expect(doc.validateSync()).toBeUndefined();

    doc.status = 'confirmed';
    expect(doc.validateSync()).toBeUndefined();

    doc.status = 'no_show';
    expect(doc.validateSync()).toBeUndefined();
  });

  test('rejects invalid status', () => {
    const doc = new Consultation({
      patient: '507f1f77bcf86cd799439011',
      doctor: '507f191e810c19729de860ea',
      patient_: { name: 'Patient One' },
      doctor_: { name: 'Doctor One' },
      mode: 'in-person',
      consultationType: 'in-person',
      appointmentTime: new Date('2026-06-10T09:00:00.000Z'),
      reason: 'Clinic checkup',
      roomId: 'room-test-2',
      patientEmail: 'patient@example.com',
      status: 'unknown',
    });

    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.status).toBeDefined();
  });

  test('stores in-person detail fields', () => {
    const doc = new Consultation({
      patient: '507f1f77bcf86cd799439011',
      doctor: '507f191e810c19729de860ea',
      patient_: { name: 'Patient One' },
      doctor_: { name: 'Doctor One' },
      mode: 'in-person',
      consultationType: 'in-person',
      appointmentTime: new Date('2026-06-10T09:00:00.000Z'),
      reason: 'Clinic checkup',
      roomId: 'room-test-3',
      patientEmail: 'patient@example.com',
      patientName: 'Patient One',
      patientAge: 46,
      patientPhone: '+23100000000',
      reasonForVisit: 'Chest pain',
      familyMemberName: 'John',
      familyMemberRelation: 'Son',
      reports: [{ name: 'report.pdf', size: 2048, mimeType: 'application/pdf' }],
      clinicDetails: { clinicName: 'Qureo Clinic', address: 'Monrovia' },
    });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.patientName).toBe('Patient One');
    expect(doc.clinicDetails.clinicName).toBe('Qureo Clinic');
    expect(doc.reports).toHaveLength(1);
  });

  test('stores linked consultation payment and refund state', () => {
    const doc = new Consultation({
      patient: '507f1f77bcf86cd799439011',
      doctor: '507f191e810c19729de860ea',
      patient_: { name: 'Patient One' },
      doctor_: { name: 'Doctor One' },
      mode: 'video',
      appointmentTime: new Date('2026-06-10T09:00:00.000Z'),
      reason: 'Follow-up',
      roomId: 'room-payment-1',
      patientEmail: 'patient@example.com',
      paymentTransaction: '507f1f77bcf86cd799439012',
      paidAmount: 75,
      bookingPaymentReference: 'booking-ref-1',
      refundStatus: 'completed',
    });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.paidAmount).toBe(75);
    expect(doc.refundStatus).toBe('completed');
  });

  test('accepts ledger links for refunds and consultation earnings', () => {
    const transaction = new Transaction({
      wallet: '507f1f77bcf86cd799439013',
      user: '507f1f77bcf86cd799439011',
      type: 'consultation_earning',
      amount: 75,
      previousBalance: 0,
      newBalance: 75,
      status: 'completed',
      reference: 'CONSULTATION-EARNING-1',
      earningFor: '507f1f77bcf86cd799439014',
      refundOf: '507f1f77bcf86cd799439015',
    });

    expect(transaction.validateSync()).toBeUndefined();
  });
});
