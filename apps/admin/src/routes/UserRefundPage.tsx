import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
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
import { copyToClipboard } from '../lib/clipboard';
import { DEFAULT_FEE_PERCENT, applyFeeToCents, parsePercentToBps } from '../lib/fee';
import { centsToYuanString, tryYuanStringToCents } from '../lib/money';

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
    due_cents: string;
    plan: {
      stripe_yuan: string;
      stripe_cents: string;
      yipay_yuan: string;
      yipay_cents: string;
    };
  };
};

type RefundOperation = {
  id: string;
  provider: string;
  amount_yuan: string;
  warning?: string;
};

type RefundLogRow = {
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

export const UserRefundPage = () => {
  const { userId } = useParams();
  const navigate = useNavigate();

  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [amountYuan, setAmountYuan] = useState<string>('');
  const [feePercent, setFeePercent] = useState<string>(DEFAULT_FEE_PERCENT);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    refunded_yuan: string;
    refund_gross_yuan?: string;
    refund_fee_yuan?: string;
    fee_bps?: number;
    operations: RefundOperation[];
  } | null>(null);

  const [copyingHistory, setCopyingHistory] = useState(false);
  const [historyProgress, setHistoryProgress] = useState<{ done: number; total: number } | null>(null);
  const [historyCopiedAt, setHistoryCopiedAt] = useState<string | null>(null);
  const [historyCopyError, setHistoryCopyError] = useState<string | null>(null);

  const [copyingPreview, setCopyingPreview] = useState(false);
  const [previewCopiedAt, setPreviewCopiedAt] = useState<string | null>(null);
  const [previewCopyError, setPreviewCopyError] = useState<string | null>(null);

  const toBigInt = (value: unknown) => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return 0n;
      try {
        return BigInt(trimmed);
      } catch {
        return 0n;
      }
    }
    return 0n;
  };

  const feeBps = useMemo(() => {
    const parsed = parsePercentToBps(feePercent);
    if (parsed !== null) return parsed;
    return parsePercentToBps(DEFAULT_FEE_PERCENT) ?? 500;
  }, [feePercent]);

  const feeInputValid = useMemo(() => {
    if (!feePercent.trim()) return true;
    return parsePercentToBps(feePercent) !== null;
  }, [feePercent]);

  const amountCentsInput = useMemo(() => {
    if (!amountYuan.trim()) return null;
    return tryYuanStringToCents(amountYuan);
  }, [amountYuan]);

  const amountInputValid = useMemo(() => {
    if (!amountYuan.trim()) return true;
    return amountCentsInput !== null;
  }, [amountYuan, amountCentsInput]);

  const preview = useMemo(() => {
    if (!quote) {
      return {
        dueCents: 0n,
        grossCents: 0n,
        feeCents: 0n,
        netCents: 0n,
        plan: { stripeCents: 0n, yipayCents: 0n }
      };
    }

    const dueCents = toBigInt(quote.refund?.due_cents);
    const stripePlanCents = toBigInt(quote.refund?.plan?.stripe_cents);
    const yipayPlanCents = toBigInt(quote.refund?.plan?.yipay_cents);
    const stripeCapacityCents = yipayPlanCents > 0n ? stripePlanCents : dueCents;

    const grossCents = (() => {
      if (!amountYuan.trim()) return dueCents;
      const requested = amountCentsInput;
      if (requested === null) return dueCents;
      if (requested <= 0n) return 0n;
      return requested > dueCents ? dueCents : requested;
    })();

    const { feeCents, netCents } = applyFeeToCents(grossCents, feeBps);
    const stripeCents = netCents > stripeCapacityCents ? stripeCapacityCents : netCents;
    const yipayCents = netCents - stripeCents;
    return { dueCents, grossCents, feeCents, netCents, plan: { stripeCents, yipayCents } };
  }, [amountCentsInput, amountYuan, feeBps, quote]);

  const previewCalcDetail = useMemo(() => {
    if (!quote) return null;

    const qQuota = toBigInt(quote.user.quota);
    const qUsedQuota = toBigInt(quote.user.used_quota);
    const qTotalQuota = qQuota + qUsedQuota;

    const stripeNetPaidCents = tryYuanStringToCents(quote.amounts.stripe_net_paid_yuan) ?? 0n;
    const yipayNetPaidCents = tryYuanStringToCents(quote.amounts.yipay_net_paid_yuan) ?? 0n;
    const totalNetPaidCents = stripeNetPaidCents + yipayNetPaidCents;

    const requested = amountYuan.trim() ? amountYuan.trim() : null;
    const feePercentValue = feePercent.trim() ? feePercent.trim() : DEFAULT_FEE_PERCENT;

    return {
      version: 2,
      computed_at: new Date().toISOString(),
      mysql_user_id: userId ?? null,
      steps: [
        {
          i: 1,
          name: 'input',
          detail: {
            amount_yuan: requested,
            fee_percent: feePercentValue
          }
        },
        {
          i: 2,
          name: 'quote.inputs',
          detail: {
            quota: quote.user.quota,
            used_quota: quote.user.used_quota,
            total_quota: qTotalQuota.toString(),
            stripe_net_paid_yuan: quote.amounts.stripe_net_paid_yuan,
            stripe_net_paid_cents: stripeNetPaidCents.toString(),
            yipay_net_paid_yuan: quote.amounts.yipay_net_paid_yuan,
            yipay_net_paid_cents: yipayNetPaidCents.toString(),
            total_net_paid_yuan: quote.amounts.total_net_paid_yuan,
            total_net_paid_cents: totalNetPaidCents.toString(),
            formula: 'sum(max(0, p_i - u_i))',
            version: 2,
            sorting: 'r desc, g desc, created_at asc',
            r_definition: 'r = (g - p) / g (g>0 else 0)'
          }
        },
        {
          i: 3,
          name: 'quote.due',
          detail: {
            due_yuan: quote.refund.due_yuan,
            due_cents: quote.refund.due_cents,
            plan: {
              stripe_yuan: quote.refund.plan.stripe_yuan,
              stripe_cents: quote.refund.plan.stripe_cents,
              yipay_yuan: quote.refund.plan.yipay_yuan,
              yipay_cents: quote.refund.plan.yipay_cents
            }
          }
        },
        {
          i: 4,
          name: 'amount.override',
          detail: {
            gross_cents: preview.grossCents.toString(),
            gross_yuan: centsToYuanString(preview.grossCents)
          }
        },
        {
          i: 5,
          name: 'fee',
          detail: {
            fee_bps: feeBps,
            fee_cents: preview.feeCents.toString(),
            fee_yuan: centsToYuanString(preview.feeCents),
            net_cents: preview.netCents.toString(),
            net_yuan: centsToYuanString(preview.netCents)
          }
        },
        {
          i: 6,
          name: 'plan.after_fee',
          detail: {
            stripe_cents: preview.plan.stripeCents.toString(),
            stripe_yuan: centsToYuanString(preview.plan.stripeCents),
            yipay_cents: preview.plan.yipayCents.toString(),
            yipay_yuan: centsToYuanString(preview.plan.yipayCents)
          }
        }
      ]
    };
  }, [amountYuan, feeBps, feePercent, preview, quote, userId]);

  const canRefund = useMemo(() => {
    if (!quote) return false;
    if (!feeInputValid) return false;
    if (!amountInputValid) return false;
    if (preview.dueCents <= 0n) return false;
    if (preview.netCents <= 0n) return false;
    return true;
  }, [amountInputValid, feeInputValid, preview.dueCents, preview.netCents, quote]);

  const copyPreviewCalc = useCallback(async () => {
    setPreviewCopyError(null);
    setPreviewCopiedAt(null);
    if (!previewCalcDetail) {
      setPreviewCopyError('暂无可复制的计算详情');
      return;
    }
    setCopyingPreview(true);
    try {
      await copyToClipboard(JSON.stringify(previewCalcDetail, null, 2));
      setPreviewCopiedAt(new Date().toLocaleString());
    } catch (e) {
      setPreviewCopyError(e instanceof Error ? e.message : '复制失败');
    } finally {
      setCopyingPreview(false);
    }
  }, [previewCalcDetail]);

  const copyRefundHistory = useCallback(async () => {
    if (!userId) return;
    setHistoryCopyError(null);
    setHistoryCopiedAt(null);
    setHistoryProgress(null);
    setCopyingHistory(true);
    try {
      const limit = 200;
      const list = await apiFetch<any>(
        `/api/refunds?mysql_user_id=${encodeURIComponent(userId)}&limit=${limit}&offset=0`
      );
      const summaryItems: RefundLogRow[] = Array.isArray(list?.items) ? (list.items as RefundLogRow[]) : [];
      const total = typeof list?.total === 'number' ? list.total : null;

      const detailed: any[] = [];
      for (let i = 0; i < summaryItems.length; i += 1) {
        const row = summaryItems[i];
        setHistoryProgress({ done: i, total: summaryItems.length });
        try {
          const detail = await apiFetch(`/api/refunds/${encodeURIComponent(String(row.id))}`);
          detailed.push(detail);
        } catch (e) {
          detailed.push({
            id: row.id,
            error: e instanceof Error ? e.message : 'detail_fetch_failed',
            summary: row
          });
        }
      }
      setHistoryProgress({ done: summaryItems.length, total: summaryItems.length });

      const payload = {
        version: 1,
        fetched_at: new Date().toISOString(),
        mysql_user_id: userId,
        total,
        limit,
        truncated: total != null ? total > limit : null,
        items: detailed
      };

      await copyToClipboard(JSON.stringify(payload, null, 2));
      setHistoryCopiedAt(new Date().toLocaleString());
    } catch (e) {
      setHistoryCopyError(e instanceof Error ? e.message : '复制失败');
    } finally {
      setCopyingHistory(false);
    }
  }, [userId]);

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

  const submitRefund = async (clearBalance: boolean = false) => {
    if (!userId) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (amountYuan.trim()) body.amount_yuan = amountYuan.trim();
      if (feePercent.trim()) body.fee_percent = feePercent.trim();
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
              <Divider />
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button variant="flat" onPress={copyRefundHistory} isLoading={copyingHistory}>
                  复制历史退款（含详情）
                </Button>
                {historyProgress ? (
                  <div className="muted">
                    进度：{historyProgress.done}/{historyProgress.total}
                  </div>
                ) : null}
                {historyCopiedAt ? <div className="muted">已复制：{historyCopiedAt}</div> : null}
              </div>
              {historyCopyError ? <div style={{ color: '#b91c1c' }}>{historyCopyError}</div> : null}
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
                手续费：{centsToYuanString(preview.feeCents)}（{feePercent.trim() ? feePercent.trim() : DEFAULT_FEE_PERCENT}%）；
                实际退款：<strong>{centsToYuanString(preview.netCents)}</strong>
              </div>
              <div className="muted">
                总实付金额 P（Stripe 优先）：Stripe {quote.amounts.stripe_net_paid_yuan} + 易支付 {quote.amounts.yipay_net_paid_yuan} =
                {quote.amounts.total_net_paid_yuan}
              </div>
              <div className="muted">应退 = Σ max(0, p_i - u_i)，u_i 由已用额度 U 按 (r, g, 创建时间) 分配</div>
              <div className="muted">易支付历史退款：{quote.amounts.yipay_refunded_yuan}</div>
              <Divider />
              <div>
                <strong>自动退款计划（扣手续费后）：</strong>
                Stripe {centsToYuanString(preview.plan.stripeCents)} + 易支付 {centsToYuanString(preview.plan.yipayCents)}
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button variant="flat" size="sm" onPress={copyPreviewCalc} isLoading={copyingPreview}>
                  复制计算详情
                </Button>
                {previewCopiedAt ? <div className="muted">已复制：{previewCopiedAt}</div> : null}
              </div>
              {previewCopyError ? <div style={{ color: '#b91c1c' }}>{previewCopyError}</div> : null}
              <Input
                label="手续费(%)"
                value={feePercent}
                onValueChange={setFeePercent}
                isInvalid={!feeInputValid}
                errorMessage={!feeInputValid ? '请输入 0 ~ 100（最多两位小数）' : undefined}
                description={`默认 ${DEFAULT_FEE_PERCENT}%；留空则使用默认`}
              />
              <Input
                label="可选：手动指定退款基数(元，扣手续费前)"
                value={amountYuan}
                onValueChange={setAmountYuan}
                isInvalid={!amountInputValid}
                errorMessage={!amountInputValid ? '请输入合法金额，例如 12.34' : undefined}
                description="不填则按 应退金额 执行并清空余额；如需保留余额，请手动指定退款基数"
              />
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Button color="primary" onPress={load}>
                  重新计算
                </Button>
                <Button
                  color="danger"
                  onPress={() => submitRefund(amountYuan.trim() ? false : true)}
                  isDisabled={!canRefund}
                  isLoading={submitting}
                >
                  执行退款
                </Button>
                <Button color="warning" onPress={() => submitRefund(true)} isDisabled={!canRefund} isLoading={submitting}>
                  执行退款并清空余额
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
                  实际退款：<strong>{result.refunded_yuan}</strong>
                </div>
                {result.refund_gross_yuan || result.refund_fee_yuan ? (
                  <div className="muted">
                    退款基数：{result.refund_gross_yuan ?? '-'}；手续费：{result.refund_fee_yuan ?? '-'}
                  </div>
                ) : null}
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
