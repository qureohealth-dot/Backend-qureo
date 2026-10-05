const express = require('express');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const Pharmacy = require('../models/Pharmacy');
const Provider = require('../models/Provider');
const HealthcareProvider = require('../models/HealthcareProvider');

const router = express.Router();

const MAX_REASON_LENGTH = 500;

/**
 * The three provider directories are different collections with different
 * fields, so each is normalised into one record shape. The admin console then
 * renders a single table for all three instead of three near-identical ones.
 */
const RESOURCES = {
  pharmacy: { model: Pharmacy, collection: 'pharmacies' },
  lab: { model: HealthcareProvider, collection: 'labs', extraFilter: { type: 'lab' } },
  payment: { model: Provider, collection: 'providers' },
};

const normalise = (kind, doc) => {
  const base = {
    id: String(doc._id),
    kind,
    name: doc.name || 'Unnamed',
    email: doc.email || doc.contactEmail || '',
    phone: doc.phone || doc.contactPhone || '',
    address: [doc.address, doc.city].filter(Boolean).join(', '),
    logo: doc.logo || doc.icon || null,
    verified: Boolean(doc.verified ?? doc.isVerified),
    isSuspended: Boolean(doc.isSuspended),
    suspendedAt: doc.suspendedAt || null,
    suspendedReason: doc.suspendedReason || '',
    joinedAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };

  if (kind === 'pharmacy') {
    return {
      ...base,
      city: doc.city || '',
      rating: typeof doc.rating === 'number' ? doc.rating : null,
      reviews: typeof doc.reviews === 'number' ? doc.reviews : 0,
      featured: Boolean(doc.featured),
      deliveryAvailable: Boolean(doc.deliveryAvailable),
      categories: Array.isArray(doc.categories) ? doc.categories : [],
      description: doc.description || '',
    };
  }

  if (kind === 'lab') {
    return {
      ...base,
      category: doc.type || 'lab',
      rating: typeof doc.rating === 'number' ? doc.rating : null,
      services: Array.isArray(doc.services) ? doc.services : [],
      isActive: doc.isActive !== false,
    };
  }

  return {
    ...base,
    providerType: doc.providerType || 'Unspecified',
  };
};

// Every list route is admin-only: these directories expose partner contact
// details and moderation state to anyone who can reach the API otherwise.
Object.keys(RESOURCES).forEach((kind) => {
  router.get(`/${RESOURCES[kind].collection}`, auth, requireAdmin, async (req, res) => {
    try {
      const { model, collection, extraFilter } = RESOURCES[kind];
      const docs = await model
        .find(extraFilter || {})
        .select('-password -confirmPassword')
        .sort({ createdAt: -1 })
        .lean();

      return res.json({ items: docs.map((doc) => normalise(kind, doc)) });
    } catch (err) {
      console.error(`admin providers ${kind} list error:`, err);
      return res.status(500).json({ message: `Failed to fetch ${kind} providers` });
    }
  });
});

router.patch('/:kind/:id/suspend', auth, requireAdmin, async (req, res) => {
  const { kind } = req.params;
  const resource = RESOURCES[kind];

  if (!resource) {
    return res.status(400).json({ message: `Unknown provider type: ${kind}` });
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  if (reason.length > MAX_REASON_LENGTH) {
    return res.status(400).json({ message: `Reason must be under ${MAX_REASON_LENGTH} characters` });
  }

  try {
    const { model, extraFilter } = resource;
    const suspended = Boolean(req.body?.suspended);

    const update = {
      isSuspended: suspended,
      suspendedAt: suspended ? new Date() : null,
      suspendedReason: suspended ? reason : null,
    };

    const doc = await model
      .findOneAndUpdate({ _id: req.params.id, ...(extraFilter || {}) }, update, { new: true })
      .select('-password -confirmPassword')
      .lean();

    if (!doc) {
      return res.status(404).json({ message: `${kind} provider not found` });
    }

    return res.json({
      message: suspended ? 'Provider suspended' : 'Provider reinstated',
      item: normalise(kind, doc),
    });
  } catch (err) {
    if (err?.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid provider id' });
    }
    console.error(`admin providers ${kind} suspend error:`, err);
    return res.status(500).json({ message: `Failed to update ${kind} provider` });
  }
});

module.exports = router;