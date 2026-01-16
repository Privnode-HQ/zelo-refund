import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';

export const RequireAuth = () => {
  const { bearerToken, loading } = useAuth();

  if (loading) {
    return (
      <div className="container">
        <div className="muted">加载中…</div>
      </div>
    );
  }

  if (!bearerToken) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};
