import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { router } from './App';
import { initAuth } from './store/auth';
import { startSync } from './lib/sync';
import { startTelemetry } from './lib/telemetry';
import './index.css';

registerSW({ immediate: true });

// Accounts, progress sync and learning events against the app's own API. Harmless on a copy with no API.
startSync();
startTelemetry();
void initAuth();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
