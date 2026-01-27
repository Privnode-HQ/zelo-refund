import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Textarea
} from '@heroui/react';
import { apiFetch } from '../lib/api';
import { parseUserIds } from '../lib/userIds';

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

type RefundEstimateUsersResult = {
  computed_at: string;
  duration_ms: number;
  input: {
    user_ids_requested: number;
    user_ids_valid: number;
    user_ids_invalid: string[];
    users_found: number;
    users_not_found: number;
    user_ids_not_found: string[];
  };
  totals: {
    total_yuan: string;
    total_cents: string;
    stripe_yuan: string;
    stripe_cents: string;
    yipay_yuan: string;
    yipay_cents: string;
  };
  counts: {
    users_total: number;
    paying_users: number;
    refundable_users: number;
    users_with_stripe_customer: number;
    stripe_customers_total: number;
    stripe_customers_processed: number;
    stripe_customers_failed: number;
    stripe_customers_multi_currency: number;
    stripe_customers_non_cny: number;
  };
  items: Array<{
    user_id: string;
    due_yuan: string;
    due_cents: string;
    plan: {
      stripe_yuan: string;
      stripe_cents: string;
      yipay_yuan: string;
      yipay_cents: string;
    };
    warning?: string;
  }>;
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

  const [rawUserIds, setRawUserIds] = useState<string>('');
  const [subsetLoading, setSubsetLoading] = useState(false);
  const [subsetError, setSubsetError] = useState<string | null>(null);
  const [subsetResult, setSubsetResult] = useState<RefundEstimateUsersResult | null>(null);

  const parsed = useMemo(() => parseUserIds(rawUserIds), [rawUserIds]);

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

  const computeByUserIds = useCallback(async () => {
    setSubsetError(null);
    const { userIds } = parseUserIds(rawUserIds);
    if (!userIds.length) {
      setSubsetError('请输入用户ID（逗号或换行分割）');
      return;
    }

    setSubsetLoading(true);
    try {
      const resp = await apiFetch<RefundEstimateUsersResult>(`/api/refund-estimate/users`, {
        method: 'POST',
        body: JSON.stringify({ user_ids: userIds })
      });
      setSubsetResult(resp);
    } catch (e) {
      setSubsetError(e instanceof Error ? e.message : '测算失败');
    } finally {
      setSubsetLoading(false);
    }
  }, [rawUserIds]);

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
    <div className="container" style={{ display: 'grid', gap: 16 }}>
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

      <Card>
        <CardHeader>指定用户退款测算</CardHeader>
        <CardBody>
          <div style={{ display: 'grid', gap: 12 }}>
            <Textarea
              label="用户ID列表"
              placeholder="例如：123,456\n789"
              value={rawUserIds}
              onValueChange={setRawUserIds}
              minRows={6}
            />

            <div className="muted">
              已解析：{parsed.userIds.length} 个用户ID
              {parsed.invalid.length ? `；无效项：${parsed.invalid.length}（将被忽略）` : ''}
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button color="primary" onPress={computeByUserIds} isLoading={subsetLoading}>
                开始测算
              </Button>
              <Button variant="flat" onPress={() => setSubsetResult(null)} isDisabled={!subsetResult || subsetLoading}>
                清空结果
              </Button>
            </div>

            {subsetError ? <div style={{ color: '#b91c1c' }}>{subsetError}</div> : null}

            {subsetResult ? (
              <>
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8 }}>
                    <div className="muted">计算时间</div>
                    <div>{subsetResult.computed_at}</div>

                    <div className="muted">耗时</div>
                    <div>{formatDuration(subsetResult.duration_ms)}</div>

                    <div className="muted">需要退款总额（元）</div>
                    <div style={{ fontSize: 18, fontWeight: 600 }}>{subsetResult.totals.total_yuan}</div>

                    <div className="muted">其中 Stripe（元）</div>
                    <div>{subsetResult.totals.stripe_yuan}</div>

                    <div className="muted">其中 易支付（元）</div>
                    <div>{subsetResult.totals.yipay_yuan}</div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8 }}>
                    <div className="muted">用户数（找到 / 未找到）</div>
                    <div>
                      {subsetResult.input.users_found} / {subsetResult.input.users_not_found}
                    </div>

                    <div className="muted">付费用户数</div>
                    <div>{subsetResult.counts.paying_users}</div>

                    <div className="muted">可退款用户数</div>
                    <div>{subsetResult.counts.refundable_users}</div>

                    <div className="muted">Stripe Customer 用户数</div>
                    <div>{subsetResult.counts.users_with_stripe_customer}</div>

                    <div className="muted">Stripe 失败 / 多币种 / 非 CNY</div>
                    <div>
                      {subsetResult.counts.stripe_customers_failed} / {subsetResult.counts.stripe_customers_multi_currency} /
                      {` ${subsetResult.counts.stripe_customers_non_cny}`}
                    </div>
                  </div>

                  {subsetResult.input.user_ids_not_found.length ? (
                    <div style={{ color: '#b91c1c' }}>
                      未找到用户：{subsetResult.input.user_ids_not_found.join(', ')}
                    </div>
                  ) : null}
                </div>

                <Divider />

                <Table aria-label="refund estimate users">
                  <TableHeader>
                    <TableColumn>用户ID</TableColumn>
                    <TableColumn>应退(元)</TableColumn>
                    <TableColumn>Stripe(元)</TableColumn>
                    <TableColumn>易支付(元)</TableColumn>
                    <TableColumn>提示</TableColumn>
                  </TableHeader>
                  <TableBody items={subsetResult.items ?? []} emptyContent="无明细">
                    {(item) => (
                      <TableRow key={item.user_id}>
                        <TableCell>{item.user_id}</TableCell>
                        <TableCell>{item.due_yuan}</TableCell>
                        <TableCell>{item.plan.stripe_yuan}</TableCell>
                        <TableCell>{item.plan.yipay_yuan}</TableCell>
                        <TableCell style={{ color: item.warning ? '#b91c1c' : undefined }}>{item.warning ?? ''}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </>
            ) : (
              <div className="muted">粘贴用户ID后点击“开始测算”。</div>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
