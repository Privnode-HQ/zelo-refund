import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

type RefundsResponse = {
  items: RefundRow[];
  limit: number;
  offset: number;
  total?: number | null;
};

type StatusFilter = '' | RefundRow['status'];

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

export const RefundsPage = () => {
  const [items, setItems] = useState<RefundRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedRefundId, setSelectedRefundId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<RefundsResponse>(`/api/refunds?${queryString}`);
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(typeof data.total === 'number' ? data.total : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void load();
  }, [load]);

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
        const data = await apiFetch(`/api/refunds/${encodeURIComponent(id)}`);
        setDetail(data);
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : '加载详情失败');
      } finally {
        setDetailLoading(false);
      }
    },
    [selectedRefundId]
  );

  return (
    <div className="container">
      <Card>
        <CardHeader>退款记录</CardHeader>
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
                    onPress={() =>
                      setDraft((prev) => ({
                        ...prev,
                        paymentMethod: v
                      }))
                    }
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
              <Button color="primary" onPress={applyFilters} isLoading={loading}>
                查询
              </Button>
              <Button variant="flat" onPress={resetFilters} isDisabled={loading}>
                重置
              </Button>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button
                variant="flat"
                onPress={() => setPage((p) => Math.max(1, p - 1))}
                isDisabled={loading || page <= 1}
              >
                上一页
              </Button>
              <Button
                variant="flat"
                onPress={() => setPage((p) => p + 1)}
                isDisabled={loading || (lastPage != null && page >= lastPage)}
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
              <TableColumn>详情</TableColumn>
            </TableHeader>
            <TableBody items={items} emptyContent={loading ? '加载中…' : '暂无记录'}>
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
                  <div>退款详情</div>
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
                        id: {detail.id}
                      </div>
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
                          {formatJson((detail as any)?.raw_request?.calc_trace ?? null)}
                        </pre>
                      </details>

                      <details>
                        <summary style={{ cursor: 'pointer' }}>raw_request</summary>
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
                          {formatJson((detail as any)?.raw_request ?? null)}
                        </pre>
                      </details>

                      <details>
                        <summary style={{ cursor: 'pointer' }}>raw_response</summary>
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
                          {formatJson((detail as any)?.raw_response ?? null)}
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
