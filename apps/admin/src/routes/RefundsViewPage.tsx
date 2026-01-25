import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow
} from '@heroui/react';
import { publicApiFetch } from '../lib/api';

type RefundActivityRow = {
  id: string;
  created_at: string;
  payment_method: string;
  refund_money: string | number | null;
  provider?: string | null;
  status: 'pending' | 'succeeded' | 'failed';
};

type ActivityResponse = {
  items: RefundActivityRow[];
  limit: number;
};

const REFRESH_MS = 3000;
const LIMIT = 50;

export const RefundsViewPage = () => {
  const [items, setItems] = useState<RefundActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isRefreshingRef = useRef(false);

  const stats = useMemo(() => {
    const counts = { pending: 0, succeeded: 0, failed: 0 } as const;
    const next = { ...counts } as { pending: number; succeeded: number; failed: number };
    for (const row of items) {
      next[row.status] += 1;
    }
    return next;
  }, [items]);

  const refresh = useCallback(async () => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    try {
      const data = await publicApiFetch<ActivityResponse>(`/api/public/refunds/activity?limit=${LIMIT}`);
      setItems(Array.isArray(data.items) ? data.items : []);
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const formatMoney = (value: RefundActivityRow['refund_money']) => {
    if (value == null) return '-';
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return '-';
    return n.toFixed(2);
  };

  return (
    <div className="container">
      <Card>
        <CardHeader style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600 }}>退款动态（脱敏）</div>
            <div className="muted" style={{ marginTop: 6 }}>
              不展示订单号、用户ID等敏感信息；每 {Math.round(REFRESH_MS / 1000)}s 自动刷新
              {lastUpdatedAt ? ` · 最近更新：${lastUpdatedAt.toLocaleTimeString()}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Chip variant="flat" color="warning">
              pending {stats.pending}
            </Chip>
            <Chip variant="flat" color="success">
              succeeded {stats.succeeded}
            </Chip>
            <Chip variant="flat" color="danger">
              failed {stats.failed}
            </Chip>
            <Button variant="flat" isLoading={isRefreshing} onPress={refresh}>
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          {error ? <div style={{ color: '#b91c1c', marginBottom: 12 }}>{error}</div> : null}
          <Table aria-label="refund activity">
            <TableHeader>
              <TableColumn>时间</TableColumn>
              <TableColumn>通道</TableColumn>
              <TableColumn>支付方式</TableColumn>
              <TableColumn>退款金额(元)</TableColumn>
              <TableColumn>状态</TableColumn>
            </TableHeader>
            <TableBody items={items} emptyContent="暂无记录">
              {(item) => (
                <TableRow key={item.id}>
                  <TableCell>{new Date(item.created_at).toLocaleString()}</TableCell>
                  <TableCell>{item.provider ?? '-'}</TableCell>
                  <TableCell>{item.payment_method}</TableCell>
                  <TableCell>{formatMoney(item.refund_money)}</TableCell>
                  <TableCell>
                    <Chip
                      color={
                        item.status === 'succeeded' ? 'success' : item.status === 'failed' ? 'danger' : 'warning'
                      }
                      variant="flat"
                    >
                      {item.status}
                    </Chip>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
};

