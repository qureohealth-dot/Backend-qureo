const { isQureoGeneralCatalogOrder } = require('../lib/catalogMerchant');

describe('Qureo catalog merchant routing', () => {
  test('routes only Qureo-owned cart items to the general dashboard provider', () => {
    const items = [
      { medicine: { pharmacy: 'Qureo Pharmacy' } },
      { medicine: { pharmacy: ' qureo pharmacy ' } },
    ];

    expect(isQureoGeneralCatalogOrder('Qureo Pharmacy', items)).toBe(true);
  });

  test('does not route registered pharmacy items or mixed carts to Qureo', () => {
    expect(isQureoGeneralCatalogOrder('Good Life Pharmacy', [
      { medicine: { pharmacy: 'Good Life Pharmacy' } },
    ])).toBe(false);
    expect(isQureoGeneralCatalogOrder('Qureo Pharmacy', [
      { medicine: { pharmacy: 'Qureo Pharmacy' } },
      { medicine: { pharmacy: 'Good Life Pharmacy' } },
    ])).toBe(false);
    expect(isQureoGeneralCatalogOrder('Qureo Pharmacy', [])).toBe(false);
  });
});