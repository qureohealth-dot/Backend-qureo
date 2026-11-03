const NotificationEvent = require('../models/NotificationEvent');
const { notifyUser } = require('../utils/notifyUser');

const ORDER_STATUSES = new Map([
  ['pending', 'Pending'],
  ['processing', 'Processing'],
  ['shipped', 'Shipped'],
  ['delivered', 'Delivered'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
]);

function normalizeOrderStatus(status) {
  return ORDER_STATUSES.get(String(status || '').trim().toLowerCase()) || null;
}

async function notifyPatientOrderStatus(order) {
  if (!order?.user) return [];

  const status = String(order.status || '');
  const title = 'Pharmacy order updated';
  const body = `Your order status changed to ${status}.`;
  const data = { orderId: String(order._id), status };

  const results = await Promise.allSettled([
    NotificationEvent.create({
      userId: order.user,
      type: 'order_status_updated',
      title,
      body,
      icon: '📦',
      data: { ...data, route: '/orders' },
    }),
    notifyUser({
      userId: order.user,
      type: 'order_status_updated',
      title,
      body,
      balancedTitle: title,
      balancedBody: body,
      genericTitle: 'Your pharmacy order was updated',
      genericBody: 'Open Qureo to check your latest order update.',
      route: '/orders',
      data,
    }),
  ]);

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn(`[orders] patient status notification channel ${index + 1} failed:`, result.reason?.message || result.reason);
    }
  });
  return results;
}

module.exports = { normalizeOrderStatus, notifyPatientOrderStatus };