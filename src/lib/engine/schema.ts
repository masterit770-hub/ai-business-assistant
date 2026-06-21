// The structured-data schema: which CSV maps to which table, the columns, and
// how a row is interpreted. Each table gets a stable integer `id` (the citation
// anchor). Malformed cells (`error: undefined method ...`) are flagged, never
// crash the loader. See docs/architecture.md §data-model.

export type TableSpec = {
  table: string;
  csv: string;
  /** Human label for the source, used in answers/citations. */
  label: string;
  /** CSV header → SQLite column. Order defines column order. */
  columns: { csv: string; col: string; type: "TEXT" | "REAL" | "INTEGER" }[];
  /** Columns whose values are dates we want queryable as ISO (MM/DD/YYYY in source). */
  dateColumns?: string[];
};

export const MALFORMED_MARKER = "error: undefined method";

export const TABLES: TableSpec[] = [
  {
    table: "contracts",
    csv: "school data 1.csv",
    label: "Vendor contracts",
    columns: [
      { csv: "Contract ID", col: "contract_id", type: "TEXT" },
      { csv: "Vendor", col: "vendor", type: "TEXT" },
      { csv: "Start Date", col: "start_date", type: "TEXT" },
      { csv: "End Date", col: "end_date", type: "TEXT" },
      { csv: "Annual Cost", col: "annual_cost", type: "REAL" },
    ],
    dateColumns: ["start_date", "end_date"],
  },
  {
    table: "maintenance",
    csv: "school data 3.csv",
    label: "Maintenance invoices",
    columns: [
      { csv: "Ticket ID", col: "ticket_id", type: "TEXT" },
      { csv: "Vendor", col: "vendor", type: "TEXT" },
      { csv: "Invoice", col: "invoice", type: "REAL" },
      { csv: "Labor Cost", col: "labor_cost", type: "REAL" },
      { csv: "Parts Cost", col: "parts_cost", type: "REAL" },
      { csv: "Total Cost", col: "total_cost", type: "REAL" },
      { csv: "Completion Date", col: "completion_date", type: "TEXT" },
    ],
    dateColumns: ["completion_date"],
  },
  {
    table: "invoice_volume",
    csv: "school data 5.csv",
    label: "Invoice volume per student",
    columns: [
      { csv: "id", col: "source_id", type: "TEXT" },
      { csv: "students", col: "students", type: "INTEGER" },
      { csv: "invoices_per_student_per_year", col: "invoices_per_student_per_year", type: "INTEGER" },
      { csv: "total_invoices", col: "total_invoices", type: "INTEGER" },
    ],
  },
  {
    table: "payroll_v1",
    csv: "school data 4.csv",
    label: "Payroll (schema v1)",
    columns: [
      { csv: "employee_name", col: "employee_name", type: "TEXT" },
      { csv: "pay_period", col: "pay_period", type: "TEXT" },
      { csv: "department", col: "department", type: "TEXT" },
      { csv: "job_title", col: "job_title", type: "TEXT" },
      { csv: "base_salary_month", col: "base_salary_month", type: "REAL" },
      { csv: "gross_pay", col: "gross_pay", type: "REAL" },
      { csv: "net_pay", col: "net_pay", type: "REAL" },
      { csv: "taxes_withheld", col: "taxes_withheld", type: "REAL" },
    ],
    dateColumns: ["pay_period"],
  },
  {
    table: "payroll_v2",
    csv: "school data 6.csv",
    label: "Payroll (schema v2)",
    columns: [
      { csv: "employee_full_name", col: "employee_full_name", type: "TEXT" },
      { csv: "department", col: "department", type: "TEXT" },
      { csv: "job_title", col: "job_title", type: "TEXT" },
      { csv: "pay_month", col: "pay_month", type: "TEXT" },
      { csv: "base_salary_monthly", col: "base_salary_monthly", type: "REAL" },
      { csv: "net_pay", col: "net_pay", type: "REAL" },
      { csv: "pay_date", col: "pay_date", type: "TEXT" },
      { csv: "currency_code", col: "currency_code", type: "TEXT" },
    ],
    dateColumns: ["pay_date"],
  },
  {
    table: "enrollment",
    csv: "school data 2.csv",
    label: "Course enrollment",
    columns: [
      { csv: "term_name", col: "term_name", type: "TEXT" },
      { csv: "course_code", col: "course_code", type: "TEXT" },
      { csv: "student_full_name", col: "student_full_name", type: "TEXT" },
      { csv: "student_email", col: "student_email", type: "TEXT" },
      { csv: "enrollment_date", col: "enrollment_date", type: "TEXT" },
      { csv: "status", col: "status", type: "TEXT" },
      { csv: "credits", col: "credits", type: "INTEGER" },
    ],
    dateColumns: ["enrollment_date"],
  },
  {
    table: "people",
    csv: "school data .csv",
    label: "Directory",
    columns: [
      { csv: "first_name", col: "first_name", type: "TEXT" },
      { csv: "last_name", col: "last_name", type: "TEXT" },
      { csv: "email", col: "email", type: "TEXT" },
      { csv: "gender", col: "gender", type: "TEXT" },
    ],
  },
];

/** Is this cell value a malformed-source marker? */
export function isMalformedCell(v: string): boolean {
  return typeof v === "string" && v.startsWith(MALFORMED_MARKER);
}

/** MM/DD/YYYY → YYYY-MM-DD (ISO) so dates sort/compare in SQL. Null if unparseable. */
export function toISODate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}
