import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow
} from '@heroui/react';
import { apiFetch } from '../lib/api';

type UserRow = {
  id: string;
  email?: string | null;
  quota: string;
  used_quota: string;
  stripe_customer?: string | null;
};

const formatBalance = (quota: string, usedQuota: string) => {
  const q = Number(quota || 0);
  const used = Number(usedQuota || 0);
  const remaining = q / 500000;
  const total = (q + used) / 500000;
  return `${remaining.toFixed(2)} / ${total.toFixed(2)}`;
};

export const UsersPage = () => {
  const [items, setItems] = useState<UserRow[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    return params.toString();
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/api/users?${queryString}`);
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="container">
      <Card>
        <CardHeader>用户</CardHeader>
        <CardBody>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Input
                label="搜索（邮箱/用户ID）"
                value={q}
                onValueChange={setQ}
                style={{ minWidth: 320 }}
              />
              <Button color="primary" onPress={load} isLoading={loading}>
                查询
              </Button>
              <Link to="/users/batch-refund">
                <Button variant="flat">批量退款</Button>
              </Link>
            </div>

            {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}

            <Table aria-label="users">
              <TableHeader>
                <TableColumn>ID</TableColumn>
                <TableColumn>邮箱</TableColumn>
                <TableColumn>Stripe Customer</TableColumn>
                <TableColumn>余额(剩余/总)</TableColumn>
                <TableColumn>操作</TableColumn>
              </TableHeader>
              <TableBody items={items} emptyContent={loading ? '加载中…' : '暂无数据'}>
                {(item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.id}</TableCell>
                    <TableCell>{item.email ?? '-'}</TableCell>
                    <TableCell>{item.stripe_customer ?? '-'}</TableCell>
                    <TableCell>{formatBalance(item.quota, item.used_quota)}</TableCell>
                    <TableCell>
                      <Link to={`/users/${encodeURIComponent(item.id)}`}>整体退款</Link>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
