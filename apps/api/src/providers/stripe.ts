import Stripe from 'stripe';
import { config } from '../config.js';

export type StripeRefundRequest = {
  paymentIntentId?: string;
  chargeId?: string;
  amountMinor?: number;
  idempotencyKey: string;
};

export const stripeClient = config.STRIPE_SECRET_KEY
  ? new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
  : null;

export const listCustomerCharges = async (customerId: string) => {
  if (!stripeClient) {
    throw new Error('Missing STRIPE_SECRET_KEY');
  }

  const charges: Stripe.Charge[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page = await stripeClient.charges.list({
      customer: customerId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });

    charges.push(...page.data);

    if (!page.has_more) break;
    const last = page.data.at(-1);
    if (!last) break;
    startingAfter = last.id;
  }

  return charges;
};

export const stripeRefund = async (req: StripeRefundRequest) => {
  if (!stripeClient) {
    throw new Error('Missing STRIPE_SECRET_KEY');
  }

  if (!req.paymentIntentId && !req.chargeId) {
    throw new Error('Missing Stripe payment_intent or charge id');
  }

  const refund = await stripeClient.refunds.create(
    {
      payment_intent: req.paymentIntentId,
      charge: req.chargeId,
      amount: req.amountMinor
    },
    {
      idempotencyKey: req.idempotencyKey
    }
  );

  return refund;
};
