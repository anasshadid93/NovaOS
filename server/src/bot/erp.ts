import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * GRERPS (the owner's company ERP) — read-only summaries for the assistant. The database is opened
 * read-only for each question (GRERPS keeps running and is never written to). Fixed queries only:
 * the model picks a topic, it never writes SQL. Invoice amounts in GRERPS include VAT.
 */

const DB = config.grerpsDb;
export const TOPICS = ['overview', 'projects', 'receivables', 'payables', 'approvals', 'lpos', 'petty_cash', 'wir', 'concrete', 'estimates', 'leave'] as const;
export type Topic = (typeof TOPICS)[number];

type Row = Record<string, unknown>;
const r2 = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

function open(path = DB) {
  if (!fs.existsSync(path)) throw new Error('erp_database_not_found');
  return new DatabaseSync(path, { readOnly: true });
}

export function erp(topic: string, path?: string): Row {
  const t = (TOPICS as readonly string[]).includes(topic) ? (topic as Topic) : 'overview';
  const db = open(path);
  try {
    const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[];
    const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as Row;
    const companies = all('SELECT id, short_name AS name, currency FROM companies WHERE archived_at IS NULL ORDER BY id');
    const live = "cancelled_at IS NULL";
    const perCompany = (fn: (id: number) => Row): Row[] => companies.map((c) => ({ company: c.name, ...fn(Number(c.id)) }));

    const receivables = () =>
      perCompany((id) => {
        const inv = one(`SELECT COALESCE(SUM(amount),0) gross, COALESCE(SUM(vat_total),0) vat, COUNT(*) n FROM invoices WHERE company_id = ? AND ${live} AND status <> 'Draft'`, id);
        const paid = one(`SELECT COALESCE(SUM(amount),0) p FROM payments WHERE company_id = ? AND ${live} AND status = 'Posted'`, id);
        return { invoices: inv.n, invoicedInclVat: r2(inv.gross), vatIncluded: r2(inv.vat), received: r2(paid.p), outstanding: r2(Number(inv.gross) - Number(paid.p)) };
      });
    const payables = () =>
      perCompany((id) => {
        const b = one(`SELECT COALESCE(SUM(total_amount),0) total, COALESCE(SUM(balance_amount),0) due, SUM(CASE WHEN payment_status <> 'Paid' THEN 1 ELSE 0 END) unpaid FROM vendor_bills WHERE company_id = ? AND ${live}`, id);
        const list = all(
          `SELECT b.bill_number AS bill, v.name AS vendor, b.balance_amount AS due, b.due_date FROM vendor_bills b LEFT JOIN vendors v ON v.id = b.vendor_id WHERE b.company_id = ? AND b.${live} AND b.payment_status <> 'Paid' ORDER BY b.due_date LIMIT 15`,
          id,
        );
        return { vendorBillsTotal: r2(b.total), unpaidBills: b.unpaid, amountDue: r2(b.due), unpaid: list };
      });
    const projects = () =>
      all(
        `SELECT p.name, c.short_name AS company, cl.name AS client, p.status, p.progress, p.contract_gross_value AS contractInclVat, p.contract_value, p.start_date, p.end_date,
           (SELECT COALESCE(SUM(amount),0) FROM invoices i WHERE i.project_id = p.id AND i.${live} AND i.status <> 'Draft') AS invoiced,
           (SELECT COALESCE(SUM(amount),0) FROM payments y WHERE y.project_id = p.id AND y.${live} AND y.status = 'Posted') AS received
         FROM projects p LEFT JOIN companies c ON c.id = p.company_id LEFT JOIN clients cl ON cl.id = p.client_id WHERE p.archived_at IS NULL ORDER BY p.status, p.name`,
      ).map((p): Row => ({ ...p, invoiced: r2(p.invoiced), received: r2(p.received) }));
    const approvals = () => all("SELECT request_title AS title, request_amount AS amount, entity_type AS type, requester, submitted_at FROM approval_requests WHERE status = 'Pending' ORDER BY submitted_at LIMIT 20");
    const lpos = () =>
      all(`SELECT l.lpo_number AS lpo, v.name AS vendor, l.amount, l.status, l.date, l.delivery_date FROM lpos l LEFT JOIN vendors v ON v.id = l.vendor_id ORDER BY l.date DESC LIMIT 15`);
    const pettyCash = () => ({
      funds: all('SELECT fund_name AS fund, current_balance AS balance, total_amount AS total, custodian_name AS custodian FROM petty_cash_fund ORDER BY id'),
      last30Days: one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) spent FROM petty_cash_transactions WHERE transaction_type = 'Withdrawal' AND created_at >= date('now','-30 day')"),
    });
    const wir = () => ({
      pending: one("SELECT COUNT(*) n FROM wir_requests WHERE status = 'Pending'").n,
      latest: all("SELECT wir_number AS wir, date, location, work_description AS work, status FROM wir_requests ORDER BY date DESC, id DESC LIMIT 10"),
    });
    const concrete = () => ({
      upcoming: all("SELECT order_number AS order_no, casting_date, location, supplier_name AS supplier, status FROM concrete_orders WHERE casting_date >= ? ORDER BY casting_date LIMIT 10", today()),
      recent: all('SELECT order_number AS order_no, casting_date, status FROM concrete_orders ORDER BY casting_date DESC LIMIT 5'),
    });
    const estimates = () => all("SELECT estimate_number AS estimate, title, status, grand_total, bid_due_date, win_probability FROM estimates WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 15");
    const leave = () => all("SELECT e.name AS employee, l.leave_type AS type, l.start_date, l.end_date, l.status FROM leave_requests l LEFT JOIN employees e ON e.id = l.employee_id WHERE l.status = 'Pending' OR l.end_date >= ? ORDER BY l.start_date LIMIT 15", today());

    const note = 'Amounts in AED; invoice amounts include VAT. Read-only snapshot of GRERPS.';
    switch (t) {
      case 'projects':
        return { projects: projects(), note };
      case 'receivables':
        return { receivables: receivables(), note };
      case 'payables':
        return { payables: payables(), note };
      case 'approvals':
        return { pendingApprovals: approvals(), note };
      case 'lpos':
        return { lpos: lpos(), note };
      case 'petty_cash':
        return { pettyCash: pettyCash(), note };
      case 'wir':
        return { wir: wir(), note };
      case 'concrete':
        return { concrete: concrete(), note };
      case 'estimates':
        return { estimates: estimates(), note };
      case 'leave':
        return { leave: leave(), note };
      default:
        return {
          date: today(),
          projects: projects().map((p) => ({ name: p.name, status: p.status, progress: p.progress })),
          receivables: receivables(),
          payables: payables().map(({ unpaid: _u, ...rest }) => rest),
          pendingApprovals: approvals().length,
          wirPending: wir().pending,
          upcomingConcrete: concrete().upcoming.length,
          pendingLeave: leave().filter((l) => l.status === 'Pending').length,
          note,
        };
    }
  } finally {
    db.close();
  }
}
