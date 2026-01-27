import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Input,
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
  mysql_user_id?: string | null;
  payment_method: string;
  refund_money: string | number | null;
  provider?: string | null;
  status: 'pending' | 'succeeded' | 'failed';
};

type ActivityResponse = {
  items: RefundActivityRow[];
  limit: number;
  offset: number;
  total?: number | null;
};

type RefundActivityDetailResponse = {
  item: RefundActivityRow & { error_message?: string | null };
  calc_trace: unknown | null;
};

const REFRESH_MS = 3000;

type StatusFilter = '' | RefundActivityRow['status'];

type Filters = {
  mysqlUserId: string;
  status: StatusFilter;
  startAt: string;
  endAt: string;
  paymentMethod: string;
  limit: number;
};

const toIso = (value: string) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const RefundsViewPage = () => {
  const [items, setItems] = useState<RefundActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isRefreshingRef = useRef(false);

  const [selectedRefundId, setSelectedRefundId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RefundActivityDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Filters>({
    mysqlUserId: '',
    status: '',
    startAt: '',
    endAt: '',
    paymentMethod: '',
    limit: 50
  });
  const [applied, setApplied] = useState<Filters>(draft);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);

  const offset = (page - 1) * applied.limit;

  const queryString = useMemo(() => {
    const params = new URLSearchParams();

    const userId = applied.mysqlUserId.trim();
    if (userId) params.set('mysql_user_id', userId);

    if (applied.status) params.set('status', applied.status);

    const startIso = toIso(applied.startAt);
    if (startIso) params.set('start_at', startIso);

    const endIso = toIso(applied.endAt);
    if (endIso) params.set('end_at', endIso);

    const pm = applied.paymentMethod.trim();
    if (pm) params.set('payment_method', pm);

    params.set('limit', String(applied.limit));
    params.set('offset', String(offset));
    return params.toString();
  }, [applied, offset]);

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
      const data = await publicApiFetch<ActivityResponse>(`/api/public/refunds/activity?${queryString}`);
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(typeof data.total === 'number' ? data.total : null);
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, [queryString]);

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

  const formatJson = (value: unknown) => {
    if (value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const toggleDetail = useCallback(
    async (id: string) => {
      if (selectedRefundId === id) {
        setSelectedRefundId(null);
        setDetail(null);
        setDetailError(null);
        return;
      }

      setSelectedRefundId(id);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const data = await publicApiFetch<RefundActivityDetailResponse>(
          `/api/public/refunds/activity/${encodeURIComponent(id)}`
        );
        setDetail(data);
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : '加载详情失败');
      } finally {
        setDetailLoading(false);
      }
    },
    [selectedRefundId]
  );

  const lastPage = useMemo(() => {
    if (total == null) return null;
    return Math.max(1, Math.ceil(total / applied.limit));
  }, [applied.limit, total]);

  const applyFilters = () => {
    setPage(1);
    setApplied({
      ...draft,
      mysqlUserId: draft.mysqlUserId.trim(),
      paymentMethod: draft.paymentMethod.trim(),
      limit: clamp(Number(draft.limit) || 50, 1, 200)
    });
  };

  const resetFilters = () => {
    const next: Filters = {
      mysqlUserId: '',
      status: '',
      startAt: '',
      endAt: '',
      paymentMethod: '',
      limit: 50
    };
    setDraft(next);
    setApplied(next);
    setPage(1);
  };

  return (
    <div className="container">
      <Card>
        <CardHeader style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600 }}>退款动态（脱敏）</div>
            <div className="muted" style={{ marginTop: 6 }}>
              展示用户ID，不展示订单号等敏感信息；每 {Math.round(REFRESH_MS / 1000)}s 自动刷新
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
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Input
                label="用户ID"
                value={draft.mysqlUserId}
                onValueChange={(v) => setDraft((prev) => ({ ...prev, mysqlUserId: v }))}
                style={{ minWidth: 200 }}
              />
              <Input
                label="支付方式"
                placeholder="stripe / alipay / wxpay"
                value={draft.paymentMethod}
                onValueChange={(v) => setDraft((prev) => ({ ...prev, paymentMethod: v }))}
                style={{ minWidth: 220 }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  状态
                </div>
                {(['', 'pending', 'succeeded', 'failed'] as const).map((v) => (
                  <Button
                    key={v || 'all'}
                    size="sm"
                    variant={draft.status === v ? 'solid' : 'flat'}
                    color={
                      v === 'succeeded'
                        ? 'success'
                        : v === 'failed'
                          ? 'danger'
                          : v === 'pending'
                            ? 'warning'
                            : 'default'
                    }
                    onPress={() => setDraft((prev) => ({ ...prev, status: v }))}
                  >
                    {v || '全部'}
                  </Button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  快捷支付方式
                </div>
                {['', 'stripe', 'alipay', 'wxpay'].map((v) => (
                  <Button
                    key={v || 'all'}
                    size="sm"
                    variant={draft.paymentMethod.trim() === v ? 'solid' : 'flat'}
                    onPress={() => setDraft((prev) => ({ ...prev, paymentMethod: v }))}
                  >
                    {v || '全部'}
                  </Button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Input
                label="开始时间"
                type="datetime-local"
                value={draft.startAt}
                onValueChange={(v) => setDraft((prev) => ({ ...prev, startAt: v }))}
                style={{ minWidth: 240 }}
              />
              <Input
                label="结束时间"
                type="datetime-local"
                value={draft.endAt}
                onValueChange={(v) => setDraft((prev) => ({ ...prev, endAt: v }))}
                style={{ minWidth: 240 }}
              />
              <Input
                label="每页"
                type="number"
                value={String(draft.limit)}
                onValueChange={(v) =>
                  setDraft((prev) => ({
                    ...prev,
                    limit: clamp(Number(v) || 50, 1, 200)
                  }))
                }
                style={{ width: 120 }}
              />
              <Button color="primary" onPress={applyFilters} isDisabled={isRefreshing}>
                查询
              </Button>
              <Button variant="flat" onPress={resetFilters} isDisabled={isRefreshing}>
                重置
              </Button>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button
                variant="flat"
                onPress={() => setPage((p) => Math.max(1, p - 1))}
                isDisabled={isRefreshing || page <= 1}
              >
                上一页
              </Button>
              <Button
                variant="flat"
                onPress={() => setPage((p) => p + 1)}
                isDisabled={isRefreshing || (lastPage != null && page >= lastPage)}
              >
                下一页
              </Button>
              <Input
                label="页码"
                type="number"
                value={String(page)}
                onValueChange={(v) => {
                  const next = Math.max(1, Number(v) || 1);
                  setPage(lastPage != null ? clamp(next, 1, lastPage) : next);
                }}
                style={{ width: 140 }}
              />
              <div className="muted" style={{ fontSize: 12 }}>
                {total == null
                  ? '—'
                  : `共 ${total} 条 · 第 ${page}${lastPage != null ? ` / ${lastPage}` : ''} 页`}
              </div>
            </div>

            {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}

          <Table aria-label="refund activity">
            <TableHeader>
              <TableColumn>时间</TableColumn>
              <TableColumn>用户ID</TableColumn>
              <TableColumn>通道</TableColumn>
              <TableColumn>支付方式</TableColumn>
              <TableColumn>退款金额(元)</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>详情</TableColumn>
            </TableHeader>
            <TableBody items={items} emptyContent="暂无记录">
              {(item) => (
                <TableRow key={item.id}>
                  <TableCell>{new Date(item.created_at).toLocaleString()}</TableCell>
                  <TableCell>{item.mysql_user_id ?? '-'}</TableCell>
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
                  <TableCell>
                    <Button size="sm" variant="flat" onPress={() => void toggleDetail(item.id)}>
                      {selectedRefundId === item.id ? '收起' : '展开'}
                    </Button>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {selectedRefundId ? (
            <div style={{ marginTop: 16 }}>
              <Card>
                <CardHeader style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>退款详情（脱敏）</div>
                  <Button size="sm" variant="flat" onPress={() => setSelectedRefundId(null)}>
                    关闭
                  </Button>
                </CardHeader>
                <CardBody style={{ display: 'grid', gap: 12 }}>
                  {detailLoading ? <div className="muted">加载中…</div> : null}
                  {detailError ? <div style={{ color: '#b91c1c' }}>{detailError}</div> : null}
                  {detail ? (
                    <>
                      <div className="muted" style={{ fontSize: 12 }}>
                        id: {detail.item.id}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8 }}>
                        <div className="muted">时间</div>
                        <div>{new Date(detail.item.created_at).toLocaleString()}</div>

                        <div className="muted">用户ID</div>
                        <div>{detail.item.mysql_user_id ?? '-'}</div>

                        <div className="muted">通道</div>
                        <div>{detail.item.provider ?? '-'}</div>

                        <div className="muted">支付方式</div>
                        <div>{detail.item.payment_method}</div>

                        <div className="muted">退款金额(元)</div>
                        <div>{formatMoney(detail.item.refund_money)}</div>

                        <div className="muted">状态</div>
                        <div>{detail.item.status}</div>
                      </div>

                      {detail.item.error_message ? (
                        <div style={{ color: '#b91c1c' }}>错误：{detail.item.error_message}</div>
                      ) : null}

                      <details open>
                        <summary style={{ cursor: 'pointer' }}>退款计算过程（calc_trace）</summary>
                        <pre
                          style={{
                            marginTop: 8,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontSize: 12,
                            background: '#0b1020',
                            color: '#e5e7eb',
                            padding: 12,
                            borderRadius: 8
                          }}
                        >
                          {formatJson(detail.calc_trace)}
                        </pre>
                      </details>
                    </>
                  ) : null}
                </CardBody>
              </Card>
            </div>
          ) : null}
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
