import { createBrowserRouter, Outlet, ScrollRestoration } from 'react-router-dom';
import { Shell } from './components/Shell';
import { HomePage } from './pages/Home';
import { CoursePage } from './pages/Course';
import { UnitPage } from './pages/Unit';
import { TopicCheckPage } from './pages/TopicCheck';
import { LabPage } from './pages/Lab';
import { ProfilePage } from './pages/Profile';
import { SignInPage } from './pages/SignIn';
import { SignUpPage } from './pages/SignUp';
import { ResearchNoticePage } from './pages/ResearchNotice';
import { YourDataPage } from './pages/YourData';
import { NotFoundPage } from './pages/NotFound';
import { CommunityPage } from './pages/Community';
import { GroupPage } from './pages/Group';
import { GroupJoinPage } from './pages/GroupJoin';
import { ForumPage, NewThreadPage, ThreadPage } from './pages/Forum';
import { MessagesPage } from './pages/Messages';
import { CompetitionPage, CompetitionsPage, NewCompetitionPage } from './pages/Competitions';
import { InboxPage } from './pages/Inbox';
import { PersonPage } from './pages/Person';
import { ProgrammePage } from './pages/Programme';

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
      { path: 'programmes/:slug', element: <ProgrammePage /> },
      { path: 'courses/:slug', element: <CoursePage /> },
      { path: 'courses/:slug/units/:unit', element: <UnitPage /> },
      { path: 'courses/:slug/units/:unit/topics/:topic/check', element: <TopicCheckPage /> },
      { path: 'labs/:id', element: <LabPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'sign-in', element: <SignInPage /> },
      { path: 'sign-up', element: <SignUpPage /> },
      { path: 'research-data', element: <ResearchNoticePage /> },
      { path: 'profile/data', element: <YourDataPage /> },
      { path: 'community', element: <CommunityPage /> },
      { path: 'groups/join/:code', element: <GroupJoinPage /> },
      { path: 'groups/:id', element: <GroupPage /> },
      { path: 'forum', element: <ForumPage /> },
      { path: 'forum/c/:category', element: <ForumPage /> },
      { path: 'forum/new', element: <NewThreadPage /> },
      { path: 'forum/threads/:id', element: <ThreadPage /> },
      { path: 'messages', element: <MessagesPage /> },
      { path: 'messages/:id', element: <MessagesPage /> },
      { path: 'competitions', element: <CompetitionsPage /> },
      { path: 'competitions/new', element: <NewCompetitionPage /> },
      { path: 'competitions/:id', element: <CompetitionPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'people/:username', element: <PersonPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
