import { z } from "zod";

/** CUST-XXXXX: the literal prefix plus exactly five digits. */
export const CUSTOMER_ID_PATTERN = /^CUST-\d{5}$/;

export const customerIdSchema = z
  .string()
  .regex(CUSTOMER_ID_PATTERN, "customer_id must match CUST-XXXXX (five digits)");

export const getCustomerInputSchema = z.strictObject({
  customer_id: customerIdSchema.describe(
    "Customer identifier formatted as CUST-XXXXX, where XXXXX is five digits.",
  ),
});

export const triggerRefundInputSchema = z.strictObject({
  customer_id: customerIdSchema.describe(
    "Customer identifier formatted as CUST-XXXXX, where XXXXX is five digits.",
  ),
  amount: z
    .number()
    .finite("amount must be a finite number")
    .positive("amount must be a positive number")
    .describe("Refund amount. Must be a positive finite number."),
  reason: z
    .string()
    .min(10, "reason must be at least 10 characters")
    .refine((value) => value.trim().length >= 10, {
      message: "reason must contain at least 10 non-whitespace characters",
    })
    .describe("Why the refund is being issued. Minimum length is 10 characters."),
});

export type GetCustomerInput = z.infer<typeof getCustomerInputSchema>;
export type TriggerRefundInput = z.infer<typeof triggerRefundInputSchema>;

export type FieldIssue = {
  path: string;
  code: string;
  message: string;
};

export type ParsedToolCall =
  | { ok: true; name: "get_customer_record"; data: GetCustomerInput }
  | { ok: true; name: "trigger_refund"; data: TriggerRefundInput }
  | { ok: false; message: string; issues: FieldIssue[] };

function issuesFrom(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    code: issue.code,
    message: issue.message,
  }));
}

function failure(name: string, error: z.ZodError): ParsedToolCall {
  const issues = issuesFrom(error);
  const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  return {
    ok: false,
    message: `Invalid arguments for tool ${name}: ${detail}`,
    issues,
  };
}

export function parseToolArguments(name: string, args: unknown): ParsedToolCall {
  if (name === "get_customer_record") {
    const parsed = getCustomerInputSchema.safeParse(args ?? {});
    if (!parsed.success) return failure(name, parsed.error);
    return { ok: true, name, data: parsed.data };
  }
  if (name === "trigger_refund") {
    const parsed = triggerRefundInputSchema.safeParse(args ?? {});
    if (!parsed.success) return failure(name, parsed.error);
    return { ok: true, name, data: { ...parsed.data, reason: parsed.data.reason.trim() } };
  }
  return {
    ok: false,
    message: `Unknown tool: ${name}`,
    issues: [{ path: "name", code: "unknown_tool", message: `Unknown tool: ${name}` }],
  };
}

export function toolInputSchema(schema: z.ZodType): {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
  additionalProperties?: boolean;
} {
  const json = z.toJSONSchema(schema) as {
    type?: string;
    properties?: Record<string, object>;
    required?: string[];
    additionalProperties?: boolean;
    $schema?: string;
  };
  delete json.$schema;
  if (json.type !== "object") {
    throw new Error("Tool input schema must be a JSON object schema");
  }
  return json as {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export const TOOL_DEFINITIONS = [
  {
    name: "get_customer_record" as const,
    title: "Get customer record",
    description:
      "Fetch a customer record by customer_id. The id must match CUST-XXXXX, where XXXXX is five digits.",
    inputSchema: toolInputSchema(getCustomerInputSchema),
    annotations: {
      title: "Get customer record",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "trigger_refund" as const,
    title: "Trigger refund",
    description:
      "Queue a refund for a customer. amount must be a positive number and reason must be at least 10 characters.",
    inputSchema: toolInputSchema(triggerRefundInputSchema),
    annotations: {
      title: "Trigger refund",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];
