import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Chip,
  Divider,
  Input,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow
} from '@heroui/react';
import { apiFetch } from '../lib/api';

type RefundQuote = {
  user: {
    id: string;
    email?: string | null;
    stripe_customer?: string | null;
    quota: string;
    used_quota: string;
  };
  balance: {
    remaining_yuan: string;
    used_yuan: string;
    total_yuan: string;
  };
  amounts: {
    yipay_paid_yuan: string;
    yipay_refunded_yuan: string;
    yipay_net_paid_yuan: string;
    stripe_net_paid_yuan: string;
    total_net_paid_yuan: string;
  };
  refund: {
    due_yuan: string;
    plan: {
      stripe_yuan: string;
      yipay_yuan: string;
    };
  };
};

type RefundOperation = {
  id: string;
  provider: string;
  amount_yuan: string;
  warning?: string;
};

export const UserRefundPage = () => {
  const { userId } = useParams();
  const navigate = useNavigate();

  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [amountYuan, setAmountYuan] = useState<string>('');
  const [clearBalance, setClearBalance] = useState<boolean>(false);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    refunded_yuan: string;
    operations: RefundOperation[];
  } | null>(null);

  const canRefund = useMemo(() => {
    const due = quote?.refund?.due_yuan;
    if (!due) return false;
    return due !== '0.00' && due !== '0';
  }, [quote?.refund?.due_yuan]);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/api/users/${encodeURIComponent(userId)}/refund-quote`);
      setQuote(data);
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitRefund = async () => {
    if (!userId) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (amountYuan.trim()) body.amount_yuan = amountYuan.trim();
      body.clear_balance = clearBalance;
      const data = await apiFetch(`/api/users/${encodeURIComponent(userId)}/refund`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      setResult(data);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '退款失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (!userId) {
    return (
      <div className="container">
        <div className="muted">缺少用户ID</div>
      </div>
    );
  }

  return (
    <div className="container" style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Button variant="flat" onPress={() => navigate(-1)}>
          返回
        </Button>
        <div className="muted">用户整体退款</div>
      </div>

      {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}

      {loading || !quote ? (
        <div className="muted">加载中…</div>
      ) : (
        <>
          <Card>
            <CardHeader>用户信息</CardHeader>
            <CardBody style={{ display: 'grid', gap: 8 }}>
              <div>user_id: {quote.user.id}</div>
              <div>email: {quote.user.email ?? '-'}</div>
              <div>stripe_customer: {quote.user.stripe_customer ?? '-'}</div>
              <Divider />
              <div>
                余额：{quote.balance.remaining_yuan} / 总余额：{quote.balance.total_yuan}
                <span className="muted">（包含赠送）</span>
              </div>
              <div className="muted">已用：{quote.balance.used_yuan}</div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>应退计算</CardHeader>
            <CardBody style={{ display: 'grid', gap: 10 }}>
              <div>
                <strong>应退金额：</strong>
                <Chip color={canRefund ? 'warning' : 'default'} variant="flat">
                  {quote.refund.due_yuan}
                </Chip>
              </div>
              <div className="muted">
                总实付金额 P（Stripe 优先）：Stripe {quote.amounts.stripe_net_paid_yuan} + 易支付 {quote.amounts.yipay_net_paid_yuan} =
                {quote.amounts.total_net_paid_yuan}
              </div>
              <div className="muted">应退 = floor(P * R / T)，其中 T = 总额度（余额+已用，包含促销）</div>
              <div className="muted">勾选“清空用户余额”时，退款成功后余额为 0</div>
              <div className="muted">易支付历史退款：{quote.amounts.yipay_refunded_yuan}</div>
              <Divider />
              <div>
                <strong>自动退款计划：</strong>
                Stripe {quote.refund.plan.stripe_yuan} + 易支付 {quote.refund.plan.yipay_yuan}
              </div>
              <Input
                label="可选：手动指定退款金额(元)"
                value={amountYuan}
                onValueChange={setAmountYuan}
                description="不填则按“应退金额”执行；系统会优先从 Stripe 订单退款"
              />
              <Checkbox isSelected={clearBalance} onValueChange={setClearBalance}>
                清空用户余额（退款后余额为 0）
              </Checkbox>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Button color="primary" onPress={load}>
                  重新计算
                </Button>
                <Button color="danger" onPress={submitRefund} isDisabled={!canRefund} isLoading={submitting}>
                  执行退款
                </Button>
              </div>
              {!canRefund ? <div className="muted">当前无可退金额</div> : null}
            </CardBody>
          </Card>

          {result ? (
            <Card>
              <CardHeader>执行结果</CardHeader>
              <CardBody style={{ display: 'grid', gap: 12 }}>
                <div>
                  已退款：<strong>{result.refunded_yuan}</strong>
                </div>
                <Table aria-label="refund operations">
                  <TableHeader>
                    <TableColumn>Provider</TableColumn>
                    <TableColumn>金额(元)</TableColumn>
                    <TableColumn>日志ID</TableColumn>
                    <TableColumn>提示</TableColumn>
                  </TableHeader>
                  <TableBody items={result.operations ?? []} emptyContent="无明细">
                    {(op) => (
                      <TableRow key={op.id}>
                        <TableCell>{op.provider}</TableCell>
                        <TableCell>{op.amount_yuan}</TableCell>
                        <TableCell>{op.id}</TableCell>
                        <TableCell>{op.warning ?? ''}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardBody>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
};
