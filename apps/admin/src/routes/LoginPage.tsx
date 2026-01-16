import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, CardHeader, Input } from '@heroui/react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../providers/AuthProvider';

export const LoginPage = () => {
  const navigate = useNavigate();
  const { mode, bearerToken, signInWithApiKey } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (bearerToken) {
      navigate('/topups', { replace: true });
    }
  }, [bearerToken, navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (mode === 'api_key') {
      try {
        signInWithApiKey(apiKey);
        navigate('/topups', { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : '登录失败');
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!supabase) {
      setLoading(false);
      setError('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    setLoading(false);

    if (signInError) {
      setError(signInError.message);
      return;
    }
    navigate('/topups', { replace: true });
  };

  return (
    <div className="container" style={{ maxWidth: 520 }}>
      <Card>
        <CardHeader>管理员登录</CardHeader>
        <CardBody>
          <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
            {mode === 'supabase' ? (
              <>
                <Input label="邮箱" value={email} onValueChange={setEmail} type="email" />
                <Input label="密码" value={password} onValueChange={setPassword} type="password" />
              </>
            ) : (
              <Input label="API Key" value={apiKey} onValueChange={setApiKey} type="password" />
            )}
            {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}
            <Button color="primary" type="submit" isLoading={loading}>
              登录
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
};
