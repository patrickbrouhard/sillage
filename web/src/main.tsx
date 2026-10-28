import { StrictMode } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AuthGate } from './AuthGate'
import './style.css'

const router = createBrowserRouter([{ path: '*', element: <AuthGate><App /></AuthGate> }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
