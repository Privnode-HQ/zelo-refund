import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Chip,
  Divider,
  Radio,
  RadioGroup,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Textarea
} from '@heroui/react';
import { apiFetch } from '../lib/api';

type BatchRefundResult = {
  userId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  refunded_yuan?: string;
  operations_count?: number;
  error?: string;
};

type RefundScope = 'all' | 'stripe_only' | 'yipay_only';

const parseUserIds = (input: string) => {
  const rawParts = input
    .split(/[\n\r,，]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const userIds: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const part of rawParts) {
    if (!/^\d+$/.test(part)) {
      invalid.push(part);
      continue;
    }
    if (seen.has(part)) continue;
    seen.add(part);
    userIds.push(part);
  }

  return { userIds, invalid };
};

const chipColor = (
  status: BatchRefundResult['status']
): 'default' | 'primary' | 'success' | 'warning' | 'danger' => {
  switch (status) {
    case 'running':
      return 'primary';
    case 'succeeded':
      return 'success';
    case 'skipped':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'default';
  }
};

const chipLabel = (status: BatchRefundResult['status']) => {
  switch (status) {
    case 'pending':
      return '等待';
    case 'running':
      return '执行中';
    case 'succeeded':
      return '成功';
    case 'skipped':
      return '跳过';
    case 'failed':
      return '失败';
  }
};

const scopeLabel = (scope: RefundScope) => {
  switch (scope) {
    case 'stripe_only':
      return '纯Stripe';
    case 'yipay_only':
      return '纯易支付';
    default:
      return '所有';
  }
};

const toBigInt = (value: unknown) => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    return BigInt(trimmed);
  }
  return 0n;
};

export const BatchRefundPage = () => {
  const [rawUserIds, setRawUserIds] = useState<string>('');
  const [clearBalance, setClearBalance] = useState<boolean>(true);
  const [dryRun, setDryRun] = useState<boolean>(false);
  const [scope, setScope] = useState<RefundScope>('all');

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BatchRefundResult[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  const parsed = useMemo(() => parseUserIds(rawUserIds), [rawUserIds]);

  const summary = useMemo(() => {
    const total = results.length;
    const succeeded = results.filter((r) => r.status === 'succeeded').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const runningCount = results.filter((r) => r.status === 'running').length;
    return { total, succeeded, failed, skipped, running: runningCount };
  }, [results]);

  const start = useCallback(async () => {
    if (running) return;
    setError(null);

    const { userIds } = parseUserIds(rawUserIds);
    if (!userIds.length) {
      setError('请输入用户ID（逗号或换行分割）');
      return;
    }

    const confirmed = window.confirm(
      `即将对 ${userIds.length} 个用户执行${dryRun ? '模拟退款' : '退款'}（范围：${scopeLabel(scope)}），是否继续？`
    );
    if (!confirmed) return;

    setRunning(true);
    setResults(userIds.map((userId) => ({ userId, status: 'pending' })));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for (const userId of userIds) {
        if (controller.signal.aborted) break;

        setResults((prev) =>
          prev.map((r) => (r.userId === userId ? { ...r, status: 'running', error: undefined } : r))
        );

        if (scope !== 'all') {
          try {
            const quote = await apiFetch<any>(`/api/users/${encodeURIComponent(userId)}/refund-quote`, {
              signal: controller.signal
            });

            const dueCents = toBigInt(quote?.refund?.due_cents);
            const stripePlanCents = toBigInt(quote?.refund?.plan?.stripe_cents);
            const yipayPlanCents = toBigInt(quote?.refund?.plan?.yipay_cents);

            if (dueCents <= 0n) {
              setResults((prev) =>
                prev.map((r) => (r.userId === userId ? { ...r, status: 'skipped', error: '无可退金额' } : r))
              );
              continue;
            }

            if (scope === 'stripe_only' && yipayPlanCents > 0n) {
              setResults((prev) =>
                prev.map((r) =>
                  r.userId === userId ? { ...r, status: 'skipped', error: '不符合条件：需要易支付退款' } : r
                )
              );
              continue;
            }

            if (scope === 'yipay_only' && stripePlanCents > 0n) {
              setResults((prev) =>
                prev.map((r) =>
                  r.userId === userId ? { ...r, status: 'skipped', error: '不符合条件：需要Stripe退款' } : r
                )
              );
              continue;
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : '加载退款测算失败';
            setResults((prev) =>
              prev.map((r) => (r.userId === userId ? { ...r, status: 'failed', error: message } : r))
            );
            continue;
          }
        }

        try {
          const resp = await apiFetch<any>(`/api/users/${encodeURIComponent(userId)}/refund`, {
            method: 'POST',
            body: JSON.stringify({
              clear_balance: clearBalance,
              dry_run: dryRun
            }),
            signal: controller.signal
          });

          const refundedYuan =
            (resp && typeof resp === 'object' && ('refunded_yuan' in resp || 'refund_yuan' in resp)
              ? (resp as any).refunded_yuan ?? (resp as any).refund_yuan
              : undefined) ?? '-';
          const operationsCount = Array.isArray((resp as any)?.operations) ? (resp as any).operations.length : undefined;

          setResults((prev) =>
            prev.map((r) =>
              r.userId === userId
                ? {
                    ...r,
                    status: 'succeeded',
                    refunded_yuan: String(refundedYuan),
                    ...(typeof operationsCount === 'number' ? { operations_count: operationsCount } : {})
                  }
                : r
            )
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : '退款失败';
          const status: BatchRefundResult['status'] = message === 'nothing_to_refund' ? 'skipped' : 'failed';
          const displayMessage = message === 'nothing_to_refund' ? '无可退金额' : message;
          setResults((prev) =>
            prev.map((r) => (r.userId === userId ? { ...r, status, error: displayMessage } : r))
          );
        }
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }, [clearBalance, dryRun, rawUserIds, running, scope]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const fillFailed = useCallback(() => {
    const failedIds = results.filter((r) => r.status === 'failed').map((r) => r.userId);
    setRawUserIds(failedIds.join('\n'));
  }, [results]);

  return (
    <div className="container">
      <Card>
        <CardHeader>批量整体退款</CardHeader>
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

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <Checkbox isSelected={clearBalance} onValueChange={setClearBalance}>
                退款后清空余额（clear_balance）
              </Checkbox>
              <Checkbox isSelected={dryRun} onValueChange={setDryRun}>
                仅模拟（dry_run，不会真实退款）
              </Checkbox>
            </div>

            <RadioGroup
              label="退款范围"
              value={scope}
              onValueChange={(v) => setScope(v as RefundScope)}
              orientation="horizontal"
            >
              <Radio value="all">所有</Radio>
              <Radio value="stripe_only">纯Stripe</Radio>
              <Radio value="yipay_only">纯易支付</Radio>
            </RadioGroup>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button color="danger" onPress={start} isDisabled={running}>
                {dryRun ? '开始模拟' : '开始退款'}
              </Button>
              <Button variant="flat" onPress={stop} isDisabled={!running}>
                停止
              </Button>
              <Button variant="flat" onPress={fillFailed} isDisabled={running || !results.some((r) => r.status === 'failed')}>
                填入失败用户ID
              </Button>

              <div className="muted">
                进度：{summary.succeeded + summary.failed + summary.skipped}/{summary.total}
                {summary.running ? `（执行中：${summary.running}）` : ''}；成功：{summary.succeeded}；失败：
                {summary.failed}；跳过：{summary.skipped}
              </div>
            </div>

            {error ? <div style={{ color: '#b91c1c' }}>{error}</div> : null}

            <Divider />

            <Table aria-label="batch refund results">
              <TableHeader>
                <TableColumn>用户ID</TableColumn>
                <TableColumn>状态</TableColumn>
                <TableColumn>退款金额(元)</TableColumn>
                <TableColumn>明细条数</TableColumn>
                <TableColumn>错误</TableColumn>
              </TableHeader>
              <TableBody items={results} emptyContent="暂无执行记录">
                {(item) => (
                  <TableRow key={item.userId}>
                    <TableCell>{item.userId}</TableCell>
                    <TableCell>
                      <Chip color={chipColor(item.status)} variant="flat">
                        {chipLabel(item.status)}
                      </Chip>
                    </TableCell>
                    <TableCell>{item.refunded_yuan ?? '-'}</TableCell>
                    <TableCell>
                      {typeof item.operations_count === 'number' ? String(item.operations_count) : item.status === 'succeeded' ? '0' :
                        '-'}
                    </TableCell>
                    <TableCell style={{ color: item.error ? '#b91c1c' : undefined }}>
                      {item.error ?? ''}
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
