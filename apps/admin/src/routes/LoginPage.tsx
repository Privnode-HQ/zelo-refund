import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, CardHeader, Input } from '@heroui/react';
import { supabase } from '../lib/supabase';

export const LoginPage = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

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
            <Input label="邮箱" value={email} onValueChange={setEmail} type="email" />
            <Input label="密码" value={password} onValueChange={setPassword} type="password" />
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
