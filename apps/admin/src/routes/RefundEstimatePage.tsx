import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardBody, CardHeader } from '@heroui/react';
import { apiFetch } from '../lib/api';

type RefundEstimateState = {
  status: 'idle' | 'running' | 'ready' | 'error';
  started_at?: string;
  computed_at?: string;
  duration_ms?: number;
  progress?: {
    phase: 'loading' | 'stripe' | 'finalizing';
    users_total: number;
    stripe_customers_total: number;
    stripe_customers_done: number;
    stripe_customers_failed: number;
    stripe_customers_multi_currency: number;
    stripe_customers_non_cny: number;
  };
  result?: {
    computed_at: string;
    duration_ms: number;
    totals: {
      total_yuan: string;
      stripe_yuan: string;
      yipay_yuan: string;
    };
    counts: {
      users_total: number;
      paying_users: number;
      refundable_users: number;
      users_with_stripe_customer: number;
      stripe_customers_total: number;
      stripe_customers_failed: number;
      stripe_customers_multi_currency: number;
      stripe_customers_non_cny: number;
    };
  };
  last_result?: RefundEstimateState['result'];
  error?: string;
};

const formatDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const min = Math.floor(sec / 60);
  return `${min} min ${Math.round(sec - min * 60)} s`;
};

export const RefundEstimatePage = () => {
  const [data, setData] = useState<RefundEstimateState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const resp = await apiFetch<RefundEstimateState>(`/api/refund-estimate`);
      setData(resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  const recompute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/refund-estimate/recompute`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动计算失败');
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data || data.status !== 'running') return;
    const timer = window.setInterval(() => {
      void load({ silent: true });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [data, load]);

  const display = useMemo(() => {
    if (!data) return null;
    return data.status === 'ready' ? data.result ?? null : data.last_result ?? data.result ?? null;
  }, [data]);

  return (
    <div className="container">
      <Card>
        <CardHeader>全量退款测算</CardHeader>
        <CardBody>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button color="primary" onPress={recompute} isLoading={loading}>
                {data?.status === 'running' ? '计算中…' : data?.status === 'idle' ? '开始计算' : '重新计算'}
              </Button>
              <Button variant="flat" onPress={() => void load()} isLoading={loading}>
                刷新
              </Button>
              <div className="muted">
                状态：
                {data?.status === 'running'
                  ? '运行中'
                  : data?.status === 'ready'
                    ? '已完成'
                    : data?.status === 'error'
                      ? '失败'
                      : '未开始'}
              </div>
            </div>

            {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}
            {data?.status === 'error' && data.error ? <div style={{ color: '#b91c1c' }}>{data.error}</div> : null}

            {data?.status === 'running' && data.progress ? (
              <div className="muted">
                阶段：{data.progress.phase}；用户：{data.progress.users_total}；Stripe Customer：
                {data.progress.stripe_customers_done}/{data.progress.stripe_customers_total}；失败：
                {data.progress.stripe_customers_failed}；多币种：{data.progress.stripe_customers_multi_currency}；非 CNY：
                {data.progress.stripe_customers_non_cny}
              </div>
            ) : null}

            {display ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8 }}>
                  <div className="muted">计算时间</div>
                  <div>{display.computed_at}</div>

                  <div className="muted">耗时</div>
                  <div>{formatDuration(display.duration_ms)}</div>

                  <div className="muted">需要退款总额（元）</div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>{display.totals.total_yuan}</div>

                  <div className="muted">其中 Stripe（元）</div>
                  <div>{display.totals.stripe_yuan}</div>

                  <div className="muted">其中 易支付（元）</div>
                  <div>{display.totals.yipay_yuan}</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8 }}>
                  <div className="muted">用户总数</div>
                  <div>{display.counts.users_total}</div>

                  <div className="muted">付费用户数</div>
                  <div>{display.counts.paying_users}</div>

                  <div className="muted">可退款用户数</div>
                  <div>{display.counts.refundable_users}</div>

                  <div className="muted">Stripe Customer 用户数</div>
                  <div>{display.counts.users_with_stripe_customer}</div>

                  <div className="muted">Stripe Customer 总数</div>
                  <div>{display.counts.stripe_customers_total}</div>

                  <div className="muted">Stripe 失败 / 多币种 / 非 CNY</div>
                  <div>
                    {display.counts.stripe_customers_failed} / {display.counts.stripe_customers_multi_currency} /{' '}
                    {display.counts.stripe_customers_non_cny}
                  </div>
                </div>
              </div>
            ) : (
              <div className="muted">暂无测算结果，点击“开始计算”。</div>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
