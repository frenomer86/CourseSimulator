import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { router } from './App';
import { startSync } from './lib/sync';
import './index.css';

registerSW({ immediate: true });

// Accounts and progress sync. A no-op in offline guest mode (no Supabase env).
startSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
