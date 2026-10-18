import { createBrowserRouter, Outlet, ScrollRestoration } from 'react-router-dom';
import { Shell } from './components/Shell';
import { HomePage } from './pages/Home';
import { CoursePage } from './pages/Course';
import { UnitPage } from './pages/Unit';
import { TopicCheckPage } from './pages/TopicCheck';
import { LabPage } from './pages/Lab';
import { AccountPage } from './pages/Account';
import { SignInPage } from './pages/SignIn';
import { SignUpPage } from './pages/SignUp';
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
      { path: 'account', element: <AccountPage /> },
      { path: 'account/sign-in', element: <SignInPage /> },
      { path: 'account/sign-up', element: <SignUpPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
