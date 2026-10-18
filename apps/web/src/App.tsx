import { createBrowserRouter, Outlet, ScrollRestoration } from 'react-router-dom';
import { Shell } from './components/Shell';
import { HomePage } from './pages/Home';
import { CoursePage } from './pages/Course';
import { UnitPage } from './pages/Unit';
import { TopicCheckPage } from './pages/TopicCheck';
import { LabPage } from './pages/Lab';
import { ProfilePage } from './pages/Profile';
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
      { path: 'courses/:slug/units/:unit', element: <UnitPage /> },
      { path: 'courses/:slug/units/:unit/topics/:topic/check', element: <TopicCheckPage /> },
      { path: 'labs/:id', element: <LabPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
