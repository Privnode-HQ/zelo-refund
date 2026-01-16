import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card, CardBody, CardHeader } from '@heroui/react';
import { apiFetch } from '../lib/api';

type TopupDetail = {
  id: number;
  user_id: number;
  amount: number;
  money: number;
  trade_no: string;
  status: string;
  payment_method: 'alipay' | 'wxpay' | 'stripe';
  user_email?: string;
  user_quota?: number;
  user_used_quota?: number;
  user_stripe_customer?: string;
};

export const TopupDetailPage = () => {
  const { tradeNo } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<TopupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const balances = useMemo(() => {
    const quota = Number(data?.user_quota ?? 0);
    const used = Number(data?.user_used_quota ?? 0);
    return {
      remaining: quota / 500000,
      total: (quota + used) / 500000
    };
  }, [data?.user_quota, data?.user_used_quota]);

  const load = async () => {
    if (!tradeNo) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/topups/${encodeURIComponent(tradeNo)}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [tradeNo]);

  if (!tradeNo) {
    return (
      <div className="container">
        <div className="muted">缺少订单号</div>
      </div>
    );
  }

  return (
    <div className="container" style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Button variant="flat" onPress={() => navigate(-1)}>
          返回
        </Button>
        <div className="muted">订单详情</div>
      </div>

      {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}
      {loading || !data ? (
        <div className="muted">加载中…</div>
      ) : (
        <>
          <Card>
            <CardHeader>订单信息</CardHeader>
            <CardBody style={{ display: 'grid', gap: 8 }}>
              <div>trade_no: {data.trade_no}</div>
              <div>status: {data.status}</div>
              <div>payment_method: {data.payment_method}</div>
              <div>money(元): {Number(data.money).toFixed(2)}</div>
              <div>amount: {data.amount}</div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>用户信息</CardHeader>
            <CardBody style={{ display: 'grid', gap: 8 }}>
              <div>user_id: {data.user_id}</div>
              <div>email: {data.user_email ?? '-'}</div>
              <div>stripe_customer: {data.user_stripe_customer ?? '-'}</div>
              <div>
                余额：{balances.remaining.toFixed(2)}（quota/500000） / 总余额：{balances.total.toFixed(2)}
                （(quota+used_quota)/500000）
              </div>
            </CardBody>
          </Card>

          <div>
            <Button color="primary" onPress={() => navigate(`/users/${encodeURIComponent(String(data.user_id))}`)}>
              用户整体退款（自动计算，应退优先 Stripe）
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
