jest.mock('../models/NotificationEvent', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn().mockResolvedValue({ success: true }) }));

const { normalizeOrderStatus } = require('../services/orderStatusNotifications');
const NotificationEvent = require('../models/NotificationEvent');
const { notifyUser } = require('../utils/notifyUser');
const { notifyPatientOrderStatus } = require('../services/orderStatusNotifications');

describe('order status normalization', () => {
  test.each([
    ['pending', 'Pending'],
    ['PROCESSING', 'Processing'],
    ['Shipped', 'Shipped'],
    ['delivered', 'Delivered'],
    ['completed', 'Completed'],
    ['cancelled', 'Cancelled'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeOrderStatus(input)).toBe(expected);
  });

  test('rejects unknown statuses', () => {
    expect(normalizeOrderStatus('returned')).toBeNull();
    expect(normalizeOrderStatus('')).toBeNull();
  });

  test('persists an in-app event and attempts a push notification', async () => {
    const order = { _id: 'order-1', user: 'patient-1', status: 'Processing' };

    await notifyPatientOrderStatus(order);

    expect(NotificationEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'patient-1',
      type: 'order_status_updated',
      data: expect.objectContaining({ orderId: 'order-1', status: 'Processing' }),
    }));
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'patient-1',
      type: 'order_status_updated',
      route: '/orders',
    }));
  });
});