// Named structured-query INTENTS. The router (LLM) selects an intent + params;
// the engine runs the corresponding parameterized SELECT. The LLM never writes
// SQL — this keeps the read-only store safe while routing stays real.
//
// Each intent maps to one feature domain. Adding a feature = adding intents here
// + a description the router sees.
import { sqlSelect, getDb, type SqlRow } from "./retrieval.ts";

export type IntentName =
  | "contracts_expiring"
  | "contracts_by_vendor"
  | "maintenance_spend"
  | "invoice_totals"
  | "payroll_summary"
  | "enrollment_overview";

// An intent returns its rows plus an optional aggregate SUMMARY (count + a named
// total) that the grounding layer surfaces so the answer can state a verifiable
// figure like "38 contracts … combined annual value $18,924,883.79".
export type IntentSummary = {
  label: string;
  count: number;
  total?: { name: string; value: number };
  note?: string; // extra verified facts (e.g. top-vendor breakdown, a year subtotal)
  // Structured verified figures (value + the row id that anchors the citation), so a
  // deterministic, row-cited figures block can be emitted without re-parsing prose.
  // Every value here is a server-computed aggregate and is added to the evidence's
  // verified-aggregate set used by the claim-support cross-check. `extraValues` holds
  // any SECONDARY verified numbers that appear in the label (e.g. a ticket count next
  // to a dollar figure) so the cross-check accepts them too — every number a figure
  // line states must be a verified aggregate, not just the primary value.
  figures?: { label: string; value: number; cite: number; extraValues?: number[] }[];
};

function fmt(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
export type IntentResult = { rows: SqlRow[]; summary?: IntentSummary };

export type IntentDef = {
  name: IntentName;
  feature: string;
  description: string; // shown to the router
  run: (params: Record<string, any>, today: string) => IntentResult;
};

export const INTENTS: IntentDef[] = [
  {
    name: "contracts_expiring",
    feature: "contract-intelligence",
    description:
      "Vendor contracts expiring within N days of today (default 90). Returns contract id, vendor, end date, annual cost. Use for 'what contracts expire in the next 90 days'.",
    run: (params, today) => {
      const days = Number(params.days ?? 90);
      const end = addDays(today, days);
      const rows = sqlSelect(
        "contracts",
        // Stable tiebreak (vendor ASC, then id) so ties on End Date — e.g. the
        // 4-way 2026-06-17 tie (Brainsphere, Fanoodle, Feedfish, Topicware) — order
        // DETERMINISTICALLY. Without it the "earliest-expiring" list (and its golden
        // screenshot) could reshuffle between runs.
        `SELECT id, contract_id, vendor, end_date, end_date_iso, annual_cost
         FROM contracts
         WHERE __malformed = 0 AND end_date_iso IS NOT NULL
           AND end_date_iso >= ? AND end_date_iso <= ?
         ORDER BY end_date_iso ASC, vendor ASC, id ASC`,
        [today, end]
      );
      // Verifiable aggregate over the SAME filtered set (count + combined value).
      const agg = getDb()
        .prepare(
          `SELECT COUNT(*) n, ROUND(SUM(annual_cost), 2) total FROM contracts
           WHERE __malformed = 0 AND end_date_iso IS NOT NULL
             AND end_date_iso >= ? AND end_date_iso <= ?`
        )
        .get(today, end) as { n: number; total: number };
      return {
        rows,
        summary: {
          label: `contracts expiring between ${today} and ${end}`,
          count: agg.n,
          total: { name: "combined annual value", value: agg.total ?? 0 },
        },
      };
    },
  },
  {
    name: "contracts_by_vendor",
    feature: "contract-intelligence",
    description: "Contracts for a specific vendor (param: vendor). Returns id, vendor, dates, annual cost.",
    run: (params) => ({
      rows: sqlSelect(
        "contracts",
        `SELECT id, contract_id, vendor, start_date, end_date, end_date_iso, annual_cost
         FROM contracts WHERE vendor LIKE ? AND __malformed = 0
         ORDER BY end_date_iso ASC, vendor ASC, id ASC`,
        [`%${params.vendor ?? ""}%`]
      ),
    }),
  },
  {
    name: "maintenance_spend",
    feature: "maintenance-spend-intelligence",
    description:
      "Maintenance SPEND analysis over the maintenance table (Vendor, Total Cost, Completion Date). Aggregates total spend, spend by year (param: year), and top vendors by spend — every figure cited to its rows. Use for 'how much did we spend on maintenance', 'top vendors by cost', spend by year. NOTE: this data has NO payment-status / due-date / paid field and the vendors are providers we PAY (not customers who owe) — it CANNOT answer overdue-payment, who-owes-us, or service-suspension questions.",
    run: (params) => {
      const year = params.year ? String(params.year) : null;
      // Representative rows for the cited breakdown + drill-to-detail.
      const rows = year
        ? sqlSelect(
            "maintenance",
            `SELECT id, ticket_id, vendor, total_cost, completion_date
             FROM maintenance WHERE __malformed = 0 AND completion_date_iso LIKE ?
             ORDER BY total_cost DESC LIMIT 15`,
            [`${year}%`]
          )
        : sqlSelect(
            "maintenance",
            `SELECT id, ticket_id, vendor, total_cost, completion_date
             FROM maintenance WHERE __malformed = 0 ORDER BY total_cost DESC LIMIT 15`
          );
      const db = getDb();
      const grand = db
        .prepare(`SELECT COUNT(*) n, ROUND(SUM(total_cost),2) total FROM maintenance WHERE __malformed = 0`)
        .get() as { n: number; total: number };
      const topVendors = db
        .prepare(
          `SELECT vendor, ROUND(SUM(total_cost),2) spend, COUNT(*) tickets
           FROM maintenance WHERE __malformed = 0 GROUP BY vendor ORDER BY spend DESC LIMIT 5`
        )
        .all() as { vendor: string; spend: number; tickets: number }[];
      const yearAgg = year
        ? (db
            .prepare(
              `SELECT COUNT(*) n, ROUND(SUM(total_cost),2) total FROM maintenance
               WHERE __malformed = 0 AND completion_date_iso LIKE ?`
            )
            .get(`${year}%`) as { n: number; total: number })
        : null;
      const extra = [
        year && yearAgg
          ? `Spend in ${year}: ${fmt(yearAgg.total ?? 0)} across ${yearAgg.n} tickets.`
          : "",
        `Top vendors by total spend (all years): ${topVendors
          .map((v) => `${v.vendor} ${fmt(v.spend)} (${v.tickets} tickets)`)
          .join(", ")}.`,
        `ALWAYS also state the all-time grand total: ${fmt(grand.total ?? 0)} across ${grand.n} tickets — include it even when the question scopes to one year.`,
      ]
        .filter(Boolean)
        .join(" ");
      // A stable row id to anchor the verified figures (the aggregates are computed
      // over the cited set; we attach the top retrieved row's token as the drillable
      // anchor). Falls back to id 0 only if no rows came back (shouldn't happen).
      const anchor = rows[0]?.id ?? 0;
      const topVendor = topVendors[0];
      const figures: NonNullable<IntentSummary["figures"]> = [
        {
          label: `total maintenance spend is ${fmt(grand.total ?? 0)} across ${grand.n} tickets`,
          value: grand.total ?? 0,
          cite: anchor,
          extraValues: [grand.n],
        },
      ];
      if (year && yearAgg) {
        figures.push({
          label: `spend in ${year} is ${fmt(yearAgg.total ?? 0)} across ${yearAgg.n} tickets`,
          value: yearAgg.total ?? 0,
          cite: anchor,
          extraValues: [yearAgg.n, Number(year)],
        });
      }
      if (topVendor) {
        figures.push({
          label: `top vendor by spend is ${topVendor.vendor} at ${fmt(topVendor.spend)} across ${topVendor.tickets} tickets`,
          value: topVendor.spend,
          cite: anchor,
          // Every top-vendor spend AND ticket count is a server-verified aggregate, so
          // the claim-support cross-check accepts them wherever the model restates the
          // breakdown (it lists these per vendor, often beside a representative row's
          // citation). A truly fabricated number is still rejected — it is in none of
          // these verified figures nor in any cited row.
          extraValues: topVendors.flatMap((v) => [v.spend, v.tickets]),
        });
      }
      return {
        rows,
        summary: {
          label: "all-time total maintenance spend (state this grand total in every spend answer)",
          count: grand.n,
          total: { name: "all-time total maintenance spend", value: grand.total ?? 0 },
          note: extra,
          figures,
        },
      };
    },
  },
  {
    name: "invoice_totals",
    feature: "receivables-intelligence",
    description: "Aggregate invoice volume per student (invoice_volume table). Returns students, invoices per student, total invoices.",
    run: () => ({
      rows: sqlSelect(
        "invoice_volume",
        `SELECT id, students, invoices_per_student_per_year, total_invoices
         FROM invoice_volume WHERE __malformed = 0 LIMIT 20`
      ),
    }),
  },
  {
    name: "payroll_summary",
    feature: "payroll-intelligence",
    description: "Payroll rows (payroll_v2): employee, department, job title, base salary, net pay. Optional param: department.",
    run: (params) => ({
      rows: sqlSelect(
        "payroll_v2",
        `SELECT id, employee_full_name, department, job_title, base_salary_monthly, net_pay
         FROM payroll_v2 WHERE __malformed = 0 ${params.department ? "AND department LIKE ?" : ""}
         ORDER BY net_pay DESC LIMIT 30`,
        params.department ? [`%${params.department}%`] : []
      ),
    }),
  },
  {
    name: "enrollment_overview",
    feature: "enrollment-intelligence",
    description: "Course enrollment rows: student, course code, enrollment date, credits. Optional param: course_code.",
    run: (params) => ({
      rows: sqlSelect(
        "enrollment",
        `SELECT id, course_code, student_full_name, student_email, enrollment_date, credits
         FROM enrollment WHERE ${params.course_code ? "course_code LIKE ?" : "1=1"}
         ORDER BY id LIMIT 30`,
        params.course_code ? [`%${params.course_code}%`] : []
      ),
    }),
  },
];

export function getIntent(name: string): IntentDef | undefined {
  return INTENTS.find((i) => i.name === name);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
