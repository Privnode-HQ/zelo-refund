import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Chip, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@heroui/react';
import { apiFetch } from '../lib/api';

type RefundRow = {
  id: string;
  created_at: string;
  mysql_user_id?: string | null;
  topup_trade_no?: string | null;
  stripe_charge_id?: string | null;
  payment_method: string;
  refund_money: string | number | null;
  provider?: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  error_message?: string | null;
};

export const RefundsPage = () => {
  const [items, setItems] = useState<RefundRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/refunds')
      .then((data) => setItems(data.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, []);

  return (
    <div className="container">
      <Card>
        <CardHeader>退款记录</CardHeader>
        <CardBody>
          {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}
          <Table aria-label="refunds">
            <TableHeader>
              <TableColumn>时间</TableColumn>
              <TableColumn>用户ID</TableColumn>
              <TableColumn>目标</TableColumn>
              <TableColumn>通道</TableColumn>
              <TableColumn>支付方式</TableColumn>
              <TableColumn>退款金额(元)</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>错误</TableColumn>
            </TableHeader>
            <TableBody items={items} emptyContent="暂无记录">
              {(item) => (
                <TableRow key={item.id}>
                  <TableCell>{new Date(item.created_at).toLocaleString()}</TableCell>
                  <TableCell>{item.mysql_user_id ?? '-'}</TableCell>
                  <TableCell>{item.stripe_charge_id ?? item.topup_trade_no ?? '-'}</TableCell>
                  <TableCell>{item.provider ?? '-'}</TableCell>
                  <TableCell>{item.payment_method}</TableCell>
                  <TableCell>{item.refund_money == null ? '-' : Number(item.refund_money).toFixed(2)}</TableCell>
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
                  <TableCell>{item.error_message ?? ''}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
};
