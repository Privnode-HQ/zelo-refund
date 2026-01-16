import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow
} from '@heroui/react';
import { apiFetch } from '../lib/api';

type TopupRow = {
  id: number;
  user_id: number;
  amount: number;
  money: number;
  trade_no: string;
  create_time: number;
  complete_time: number;
  status: string;
  payment_method: string;
  user_email?: string;
  user_quota?: number;
  user_used_quota?: number;
};

export const TopupsPage = () => {
  const [items, setItems] = useState<TopupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('success');
  const [paymentMethod, setPaymentMethod] = useState<string>('');

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (paymentMethod) params.set('payment_method', paymentMethod);
    return params.toString();
  }, [q, status, paymentMethod]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/api/topups?${queryString}`);
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="container">
      <Card>
        <CardHeader>订单列表</CardHeader>
        <CardBody>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Input
                label="搜索（订单号/用户邮箱/用户ID）"
                value={q}
                onValueChange={setQ}
                style={{ minWidth: 320 }}
              />
              <Select
                label="状态"
                selectedKeys={[status]}
                onSelectionChange={(keys) => setStatus(Array.from(keys)[0] as string)}
                style={{ minWidth: 160 }}
              >
                <SelectItem key="success">success</SelectItem>
                <SelectItem key="refund">refund</SelectItem>
              </Select>
              <Select
                label="支付方式"
                selectedKeys={[paymentMethod || 'all']}
                onSelectionChange={(keys) => {
                  const value = (Array.from(keys)[0] as string | undefined) ?? 'all';
                  setPaymentMethod(value === 'all' ? '' : value);
                }}
                style={{ minWidth: 160 }}
              >
                <SelectItem key="all">全部</SelectItem>
                <SelectItem key="alipay">alipay</SelectItem>
                <SelectItem key="wxpay">wxpay</SelectItem>
                <SelectItem key="stripe">stripe</SelectItem>
              </Select>
              <Button color="primary" onPress={load} isLoading={loading}>
                查询
              </Button>
            </div>

            {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}

            <Table aria-label="topups">
              <TableHeader>
                <TableColumn>订单号</TableColumn>
                <TableColumn>用户</TableColumn>
                <TableColumn>支付方式</TableColumn>
                <TableColumn>实付(元)</TableColumn>
                <TableColumn>到账</TableColumn>
                <TableColumn>状态</TableColumn>
                <TableColumn>操作</TableColumn>
              </TableHeader>
              <TableBody emptyContent={loading ? '加载中…' : '暂无数据'} items={items}>
                {(item) => (
                  <TableRow key={item.trade_no}>
                    <TableCell>{item.trade_no}</TableCell>
                    <TableCell>
                      <div>
                        <div>{item.user_email ?? `#${item.user_id}`}</div>
                        <div className="muted">ID: {item.user_id}</div>
                      </div>
                    </TableCell>
                    <TableCell>{item.payment_method}</TableCell>
                    <TableCell>{Number(item.money).toFixed(2)}</TableCell>
                    <TableCell>{item.amount}</TableCell>
                    <TableCell>{item.status}</TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <Link to={`/topups/${encodeURIComponent(item.trade_no)}`}>详情</Link>
                        <Link to={`/users/${encodeURIComponent(String(item.user_id))}`}>用户退款</Link>
                      </div>
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
