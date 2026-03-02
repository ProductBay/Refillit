import { test, expect } from '@playwright/test';

test('Ops can locate courier and toggle availability (mocked backend)', async ({ page, baseURL }) => {
  // Provide a mock auth token & user in localStorage so the app shows ops UI
  await page.addInitScript(() => {
    localStorage.setItem('refillit_auth', JSON.stringify({ token: 'tok', user: { id: 'admin1', role: 'admin', fullName: 'Admin' } }));
  });

  // Intercept API calls and provide deterministic mocked responses
  await page.route('**/api/dispatch/courier-workload', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        summary: { couriers: 1, activeJobs: 0, overdueJobs: 0 },
        couriers: [
          {
            courierId: 'courier-1',
            courierName: 'Courier One',
            zone: 'zone-1',
            loadBand: 'idle',
            activeJobs: 0,
            overdueJobs: 0,
            assignedTotal: 0,
            lastAssignedAt: null,
            online: true,
          },
        ],
      }),
    });
  });

  await page.route('**/api/dispatch/live-map', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ generatedAt: null, orders: [] }) });
  });

  let availabilityCalled = false;
  await page.route('**/api/dispatch/couriers/*/availability', async (route) => {
    availabilityCalled = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ courierId: 'courier-1', online: false, updatedAt: new Date().toISOString(), updatedBy: 'admin1' }),
    });
  });

  await page.goto('/dispatch');

  // Wait for the workload card to render
  await page.waitForSelector('text=Courier One');

  // Click the 'Set offline' button
  await page.click('text=Set offline');

  expect(availabilityCalled).toBeTruthy();
});
