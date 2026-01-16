import { config } from '../config.js';
import { toFormBody } from '../utils/http.js';
import { createSignString, rsaSignBase64, rsaVerifyBase64 } from '../utils/sign.js';

export type YipayRefundRequest = {
  orderNoField: 'trade_no' | 'out_trade_no';
  orderNo: string;
  money: string;
  outRefundNo: string;
  timestamp: number;
};

export type YipayRefundResponse = {
  code: number;
  msg?: string;
  refund_no?: string;
  out_refund_no?: string;
  trade_no?: string;
  money?: string;
  reducemoney?: string;
  timestamp?: string;
  sign?: string;
  sign_type?: string;
  [k: string]: unknown;
};

export const yipayRefund = async (req: YipayRefundRequest) => {
  if (!config.YIPAY_PID) {
    throw new Error('Missing YIPAY_PID');
  }
  if (!config.YIPAY_PRIVATE_KEY) {
    throw new Error('Missing YIPAY_PRIVATE_KEY');
  }

  const params: Record<string, string | number | undefined> = {
    pid: config.YIPAY_PID,
    [req.orderNoField]: req.orderNo,
    money: req.money,
    out_refund_no: req.outRefundNo,
    timestamp: String(req.timestamp),
    sign_type: 'RSA'
  };

  const signStr = createSignString(params);
  const sign = rsaSignBase64(signStr, config.YIPAY_PRIVATE_KEY, config.YIPAY_SIGN_ALGO);

  const body = toFormBody({
    ...params,
    sign
  });

  const url = new URL('/api/pay/refund', config.YIPAY_BASE_URL);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const text = await resp.text();
  let data: YipayRefundResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Yipay non-JSON response (status ${resp.status}): ${text}`);
  }

  if (config.YIPAY_PUBLIC_KEY && data.sign) {
    const verifyParams = { ...data };
    delete (verifyParams as Record<string, unknown>).sign;
    const verifyStr = createSignString(verifyParams);
    const ok = rsaVerifyBase64(verifyStr, String(data.sign), config.YIPAY_PUBLIC_KEY, config.YIPAY_SIGN_ALGO);
    if (!ok) {
      throw new Error('Yipay signature verification failed');
    }
  }

  if (data.code !== 0) {
    throw new Error(`Yipay refund failed: ${data.code} ${data.msg ?? ''}`.trim());
  }

  return {
    request: {
      ...params,
      sign
    },
    response: data
  };
};
