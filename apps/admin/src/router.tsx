import React from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { LoginPage } from './routes/LoginPage';
import { RefundsPage } from './routes/RefundsPage';
import { RefundsViewPage } from './routes/RefundsViewPage';
import { RequireAuth } from './routes/RequireAuth';
import { TopupDetailPage } from './routes/TopupDetailPage';
import { TopupsPage } from './routes/TopupsPage';
import { UsersPage } from './routes/UsersPage';
import { UserRefundPage } from './routes/UserRefundPage';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />
  },
  {
    path: '/dashboard/index/Viewer/refundsView',
    element: <RefundsViewPage />
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <TopupsPage /> },
          { path: '/topups', element: <TopupsPage /> },
          { path: '/topups/:tradeNo', element: <TopupDetailPage /> },
          { path: '/users', element: <UsersPage /> },
          { path: '/users/:userId', element: <UserRefundPage /> },
          { path: '/refunds', element: <RefundsPage /> }
        ]
      }
    ]
  }
]);
