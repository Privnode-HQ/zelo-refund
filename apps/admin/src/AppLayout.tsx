import React from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { Button } from '@heroui/react';
import { useAuth } from './providers/AuthProvider';

export const AppLayout = () => {
  const { session, signOut } = useAuth();
  const location = useLocation();

  return (
    <div>
      <div className="topbar">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <strong>退款后台</strong>
          <nav className="nav">
            <Link to="/topups" style={{ fontWeight: location.pathname.startsWith('/topups') ? 600 : 400 }}>
              订单
            </Link>
            <Link to="/users" style={{ fontWeight: location.pathname.startsWith('/users') ? 600 : 400 }}>
              用户退款
            </Link>
            <Link to="/refunds" style={{ fontWeight: location.pathname.startsWith('/refunds') ? 600 : 400 }}>
              退款记录
            </Link>
          </nav>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div className="muted">{session?.user?.email}</div>
          <Button variant="flat" onPress={signOut}>
            退出
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
};
