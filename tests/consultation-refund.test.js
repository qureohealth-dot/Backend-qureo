jest.mock('../models/Transaction', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../models/Wallet', () => ({
  findOneAndUpdate: jest.fn(),
}));

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const { refundConsultationPayment } = require('../services/refundConsultationPayment');

describe('consultation payment refund', () => {
  let session;
  let patientWallet;
  let escrowWallet;
  let consultation;
  let payment;

  beforeEach(() => {
    jest.clearAllMocks();
    session = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      abortTransaction: jest.fn().mockResolvedValue(undefined),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);

    patientWallet = {
      _id: 'patient-wallet',
      balance: 10,
      totalDeposits: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    escrowWallet = {
      _id: 'escrow-wallet',
      balance: 5,
      totalWithdrawals: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    consultation = {
      _id: 'consultation-1',
      patient: 'patient-1',
      status: 'awaiting_confirmation',
      save: jest.fn().mockResolvedValue(undefined),
    };
    payment = {
      _id: 'payment-1',
      user: 'patient-1',
      provider: 'escrow-1',
      type: 'consultation',
      amount: 75,
      status: 'completed',
    };

    Transaction.findOne.mockImplementation((query) => ({
      session: jest.fn().mockResolvedValue(query.refundOf ? null : payment),
    }));
    Transaction.create.mockResolvedValue([]);
    Wallet.findOneAndUpdate.mockImplementation(({ user }) =>
      Promise.resolve(user === payment.user ? patientWallet : escrowWallet)
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fully refunds the patient when escrow balance is below the payment', async () => {
    await expect(refundConsultationPayment({ consultation, payment })).resolves.toBe('completed');

    expect(patientWallet.balance).toBe(85);
    expect(escrowWallet.balance).toBe(-70);
    expect(Transaction.create).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'refund', amount: 75, refundOf: payment._id })],
      { session }
    );
    expect(consultation.refundStatus).toBe('completed');
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not credit the patient again when a refund already exists', async () => {
    Transaction.findOne.mockImplementation((query) => ({
      session: jest.fn().mockResolvedValue(query.refundOf ? { _id: 'refund-1' } : payment),
    }));

    await expect(refundConsultationPayment({ consultation, payment })).resolves.toBe('completed');

    expect(Wallet.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(consultation.refundStatus).toBe('completed');
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
  });
});