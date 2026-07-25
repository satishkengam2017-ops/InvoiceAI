export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "VIEWED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "VOID";

export type Plan = "FREE" | "STARTER" | "PRO";

export type Customer = {
  id: string;
  business_id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  address_line1?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  notes?: string | null;
  archived?: boolean;
  invoices?: Invoice[];
  lifetime_revenue_cents?: number;
};

export type CatalogItem = {
  id: string;
  business_id: string;
  name: string;
  description?: string | null;
  unit_price_cents: number;
  currency?: string;
  unit?: string | null;
  tax_percent: number;
  archived?: boolean;
};

export type LineItemDto = {
  name: string;
  description?: string | null;
  quantity: number;
  unit_price_cents: number;
  tax_percent?: number;
};

export type Invoice = {
  id: string;
  business_id: string;
  customer_id: string;
  customer?: Customer | null;
  number: string;
  status: InvoiceStatus;
  currency: string;
  issue_date: string;
  due_date: string;
  line_items: LineItemDto[];
  subtotal_cents: number;
  tax_total_cents: number;
  discount_cents: number;
  discount_type?: "PERCENT" | "FIXED" | null;
  discount_value?: number;
  total_cents: number;
  amount_paid_cents: number;
  notes?: string | null;
  terms?: string | null;
  stripe_payment_url?: string | null;
  ai_source_text?: string | null;
  sent_at?: string | null;
  paid_at?: string | null;
  created_at: string;
};

export type Business = {
  id: string;
  name: string;
  legal_name?: string | null;
  email?: string;
  phone?: string | null;
  website?: string | null;
  logo_url?: string | null;
  gst_hst_number?: string | null;
  address_line1?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string;
  currency: string;
  tax_numbers?: { label: string; value: string }[];
  invoice_prefix: string;
  next_invoice_no: number;
  default_terms?: string | null;
  default_due_days: number;
  plan: Plan;
  has_anthropic_key?: boolean;
  stripe_payment_url_default?: string | null;
  onboarded?: boolean;
};

export type DashboardSummary = {
  currency: string;
  revenue_this_month_cents: number;
  outstanding_cents: number;
  overdue_cents: number;
  total_paid_cents: number;
  invoice_count: number;
  chart_days: { range_label: string; total_cents: number; days: { day: number; revenue_cents: number }[] };
  chart_year: {
    range_label: string;
    total_cents: number;
    current_month: number;
    months: { year: number; month: number; revenue_cents: number; label: string }[];
  };
  plan: Plan;
  plan_usage: { used: number; limit: number; scope: string; over: boolean };
};
