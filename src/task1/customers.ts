import { randomBytes } from "node:crypto";

export type CustomerStatus = "active" | "past_due" | "closed";

export type Customer = {
  customer_id: string;
  name: string;
  email: string;
  plan: "free" | "pro" | "enterprise";
  status: CustomerStatus;
};

export type Refund = {
  refund_id: string;
  customer_id: string;
  amount: number;
  reason: string;
  status: "queued";
};

/** Fictional records used by the assessment server. */
export const CUSTOMERS: readonly Customer[] = [
  {
    customer_id: "CUST-10001",
    name: "Avery Chen",
    email: "avery.chen@example.com",
    plan: "enterprise",
    status: "active",
  },
  {
    customer_id: "CUST-10002",
    name: "Jordan Blake",
    email: "jordan.blake@example.com",
    plan: "pro",
    status: "past_due",
  },
  {
    customer_id: "CUST-10003",
    name: "Sam Okonkwo",
    email: "sam.okonkwo@example.com",
    plan: "free",
    status: "active",
  },
  {
    customer_id: "CUST-10004",
    name: "Riley Nguyen",
    email: "riley.nguyen@example.com",
    plan: "free",
    status: "closed",
  },
];

const refunds: Refund[] = [];

export function getCustomer(customerId: string): Customer | undefined {
  return CUSTOMERS.find((customer) => customer.customer_id === customerId);
}

export function listRefunds(): readonly Refund[] {
  return refunds;
}

export function triggerRefund(input: {
  customer_id: string;
  amount: number;
  reason: string;
}): { ok: true; refund: Refund } | { ok: false; error: string } {
  const customer = getCustomer(input.customer_id);
  if (!customer) {
    return { ok: false, error: `No customer found for ${input.customer_id}` };
  }
  if (customer.status === "closed") {
    return { ok: false, error: `Customer ${input.customer_id} is closed and cannot be refunded` };
  }
  const refund: Refund = {
    refund_id: `RFD-${randomBytes(4).toString("hex").toUpperCase()}`,
    customer_id: input.customer_id,
    amount: input.amount,
    reason: input.reason,
    status: "queued",
  };
  refunds.push(refund);
  return { ok: true, refund };
}
