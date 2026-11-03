const QUREO_CATALOG_SELLER = 'Qureo Pharmacy';

const normalizeSeller = (value) => String(value || '').trim().toLowerCase();

function isQureoGeneralCatalogOrder(pharmacyId, cartItems) {
  if (normalizeSeller(pharmacyId) !== normalizeSeller(QUREO_CATALOG_SELLER)) return false;
  if (!Array.isArray(cartItems) || cartItems.length === 0) return false;

  return cartItems.every((item) =>
    normalizeSeller(item?.medicine?.pharmacy) === normalizeSeller(QUREO_CATALOG_SELLER)
  );
}

module.exports = { QUREO_CATALOG_SELLER, isQureoGeneralCatalogOrder };