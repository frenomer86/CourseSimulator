import { createBrowserRouter, Outlet, ScrollRestoration } from 'react-router-dom';
import { Shell } from './components/Shell';
import { HomePage } from './pages/Home';
import { CoursePage } from './pages/Course';
import { LabPage } from './pages/Lab';
import { NotFoundPage } from './pages/NotFound';

function Root() {
  return (
    <Shell>
      <ScrollRestoration />
      <Outlet />
    </Shell>
  );
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    errorElement: (
      <Shell>
        <NotFoundPage />
      </Shell>
    ),
    children: [
      { index: true, element: <HomePage /> },
      { path: 'courses/:slug', element: <CoursePage /> },
      { path: 'labs/:id', element: <LabPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
