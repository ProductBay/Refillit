import React from 'react'
// Ensure React is available as a global for modules compiled without automatic runtime
globalThis.React = React
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import DispatchHub from '../DispatchHub'

// Mock Auth context provider
import { createContext } from 'react'
const AuthContext = createContext(null)
function MockAuthProvider({ children, user = { id: 'admin1', role: 'admin' }, token = 'tok' }) {
  return (
    <AuthContext.Provider value={{ apiBase: 'http://127.0.0.1:4000', token, user }}>
      {children}
    </AuthContext.Provider>
  )
}

// Mock the useAuth hook to read from our MockAuthProvider
vi.mock('../../context/AuthContext.jsx', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    useAuth: () => ({ apiBase: 'http://127.0.0.1:4000', token: 'tok', user: { id: 'admin1', role: 'admin' } }),
  }
})

vi.mock('../../utils/api.js', () => ({ apiFetch: vi.fn() }))

test('Ops see locate and availability buttons and calling availability API', async () => {
  const { apiFetch } = await import('../../utils/api.js')
  // initial courier workload response
  apiFetch.mockImplementation(async ({ path }) => {
    if (path === '/api/dispatch/courier-workload') {
      return {
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
      }
    }
    if (path === '/api/dispatch/live-map') return { generatedAt: null, orders: [] }
    // availability toggle
    if (path.includes('/api/dispatch/couriers/') && path.includes('/availability')) {
      return { courierId: 'courier-1', online: false, updatedAt: new Date().toISOString(), updatedBy: 'admin1' }
    }
    return {}
  })

  render(
    <MockAuthProvider>
      <DispatchHub mode="dispatch" />
    </MockAuthProvider>
  )

  // wait for workload item
  const locateBtn = await screen.findByText('Locate')
  expect(locateBtn).toBeInTheDocument()

  const toggleBtn = screen.getByText('Set offline')
  expect(toggleBtn).toBeInTheDocument()

  await userEvent.click(toggleBtn)

  // assert apiFetch was called for availability change
  expect(apiFetch).toHaveBeenCalled()
  const called = apiFetch.mock.calls.find((c) => String(c[0]?.path || '').includes('/availability'))
  expect(Boolean(called)).toBe(true)
})
