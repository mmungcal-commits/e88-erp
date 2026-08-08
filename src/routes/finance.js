import { Hono } from 'hono';
import { all, first, run } from '../lib/db.js';
import { ok, fail, jsonBody, numberValue } from '../lib/http.js';
import { permissionFor, requirePermission } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { saveAttachments, attachmentsFor } from '../lib/attachments.js';
import { sendMailQuiet, mailLayout, mailFacts, mailAttachments } from '../lib/mailer.js';
import { nextCode, normalizeText } from '../lib/codes.js';
import {
  ACTION_STAGE, STAGE_ROLE, STAGE_ROLE_ALIASES, checkApproval, isAdminRole, mancomMin, rfpFlag, rfpSetting,
  requiredStages, nextStage,
} from '../lib/rfp-rules.js';

// Finance checks every request before it reaches the head of Finance.
const financeReviewOn=db=>rfpFlag(db,'rfp_finance_review','1');
import { fixedAssetAccountsForCategory, inventoryAccountForCategory } from '../lib/transaction-rules.js';
import {
  approveJournal,
  calculateAgingBucket,
  captureFinanceEvent,
  createJournal,
  createSubledgerDocument,
  ensureAccountingPeriod,
  entityByCode,
  postJournal,
  postSubledgerDocument,
  retryFinanceEvent,
  registerPendingFixedAsset,
  reversePostedJournal,
  submitJournal,
} from '../lib/finance.js';

export const financeRoutes = new Hono();
const round = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

function filters(c, alias = 'h') {
  const entity = normalizeText(c.req.query('entity') || 'E88').toUpperCase();
  const dateFrom = normalizeText(c.req.query('dateFrom') || `${new Date().getFullYear()}-01-01`);
  const dateTo = normalizeText(c.req.query('dateTo') || new Date().toISOString().slice(0, 10));
  const department = normalizeText(c.req.query('department'));
  const costCenter = normalizeText(c.req.query('costCenter'));
  const businessLine = normalizeText(c.req.query('businessLine'));
  const where = ['e.entity_code=?', `${alias}.journal_date BETWEEN ? AND ?`];
  const args = [entity, dateFrom, dateTo];
  if (department) { where.push(`l.department=?`); args.push(department); }
  if (costCenter) { where.push(`l.cost_center=?`); args.push(costCenter); }
  if (businessLine) { where.push(`l.business_line=?`); args.push(businessLine); }
  return { entity, dateFrom, dateTo, department, costCenter, businessLine, where, args };
}

async function journalDetail(db, id) {
  const header = await first(db,
    `SELECT h.*,e.entity_code,e.entity_name,p.period_name,p.status period_status
       FROM erp_journal_headers h
       JOIN erp_legal_entities e ON e.id=h.entity_id
       LEFT JOIN erp_accounting_periods p ON p.id=h.period_id
      WHERE h.id=?`, [id]);
  if (!header) return null;
  const lines = await all(db,
    `SELECT l.*,a.account_code,a.account_name,a.account_type,p.name partner_name
       FROM erp_journal_lines l
       JOIN erp_chart_accounts a ON a.id=l.account_id
       LEFT JOIN erp_partners p ON p.id=l.partner_id
      WHERE l.journal_id=? ORDER BY l.line_no`, [id]);
  return { header, lines };
}

financeRoutes.get('/master-data', requirePermission('FINANCE', 'VIEW'), async c => {
  const [entities, accounts, periods, taxCodes, partners, bankAccounts] = await Promise.all([
    all(c.env.DB, `SELECT * FROM erp_legal_entities WHERE active=1 ORDER BY entity_code`),
    all(c.env.DB, `SELECT * FROM erp_chart_accounts WHERE active=1 ORDER BY account_code`),
    all(c.env.DB, `SELECT p.*,e.entity_code FROM erp_accounting_periods p
      JOIN erp_legal_entities e ON e.id=p.entity_id ORDER BY p.fiscal_year DESC,p.period_no DESC`),
    all(c.env.DB, `SELECT * FROM erp_tax_codes WHERE active=1 ORDER BY tax_type,tax_code`),
    all(c.env.DB, `SELECT id,partner_code,partner_type,name,credit_status FROM erp_partners
      WHERE active=1 ORDER BY partner_type,name LIMIT 5000`),
    all(c.env.DB, `SELECT b.*,e.entity_code,a.account_code,a.account_name FROM erp_bank_accounts b
      JOIN erp_legal_entities e ON e.id=b.entity_id
      JOIN erp_chart_accounts a ON a.id=b.gl_account_id WHERE b.active=1 ORDER BY b.bank_name`),
  ]);
  return ok(c, { entities, accounts, periods, taxCodes, partners, bankAccounts });
});

financeRoutes.get('/dashboard', requirePermission('FINANCE', 'VIEW'), async c => {
  const f = filters(c);
  const base = `
    FROM erp_journal_headers h
    JOIN erp_legal_entities e ON e.id=h.entity_id
    JOIN erp_journal_lines l ON l.journal_id=h.id
    JOIN erp_chart_accounts a ON a.id=l.account_id
    WHERE h.status='POSTED' AND ${f.where.join(' AND ')}`;
  const [balances, activity, worklist, events, bank, inventory, overdue] = await Promise.all([
    first(c.env.DB, `SELECT
      COALESCE(SUM(CASE WHEN a.control_type='BANK' THEN l.base_debit-l.base_credit ELSE 0 END),0) cash,
      COALESCE(SUM(CASE WHEN a.control_type='AR' THEN l.base_debit-l.base_credit ELSE 0 END),0) receivables,
      COALESCE(SUM(CASE WHEN a.control_type='AP' THEN l.base_credit-l.base_debit ELSE 0 END),0) payables,
      COALESCE(SUM(CASE WHEN a.account_type='REVENUE' THEN l.base_credit-l.base_debit ELSE 0 END),0) revenue,
      COALESCE(SUM(CASE WHEN a.account_type IN ('COGS','EXPENSE') THEN l.base_debit-l.base_credit ELSE 0 END),0) expenses
      ${base}`, f.args),
    all(c.env.DB, `SELECT strftime('%Y-%m',h.journal_date) period,
      COALESCE(SUM(CASE WHEN a.account_type='REVENUE' THEN l.base_credit-l.base_debit ELSE 0 END),0) revenue,
      COALESCE(SUM(CASE WHEN a.account_type IN ('COGS','EXPENSE') THEN l.base_debit-l.base_credit ELSE 0 END),0) expenses
      ${base} GROUP BY strftime('%Y-%m',h.journal_date) ORDER BY period`, f.args),
    first(c.env.DB, `SELECT
      SUM(CASE WHEN status='SUBMITTED' THEN 1 ELSE 0 END) submitted,
      SUM(CASE WHEN status='APPROVED' THEN 1 ELSE 0 END) approved,
      SUM(CASE WHEN status='DRAFT' THEN 1 ELSE 0 END) drafts
      FROM erp_journal_headers h JOIN erp_legal_entities e ON e.id=h.entity_id
      WHERE e.entity_code=?`, [f.entity]),
    first(c.env.DB, `SELECT
      SUM(CASE WHEN status='CAPTURED' THEN 1 ELSE 0 END) captured,
      SUM(CASE WHEN status='JOURNAL_PREPARED' THEN 1 ELSE 0 END) prepared,
      SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) errors,
      SUM(CASE WHEN status='NO_FINANCIAL_IMPACT' THEN 1 ELSE 0 END) no_effect
      FROM erp_finance_source_events WHERE entity_code=?`, [f.entity]),
    first(c.env.DB, `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0) statement_balance,
      SUM(CASE WHEN status='UNMATCHED' THEN 1 ELSE 0 END) unmatched
      FROM erp_bank_transactions bt JOIN erp_bank_accounts b ON b.id=bt.bank_account_id
      JOIN erp_legal_entities e ON e.id=b.entity_id WHERE e.entity_code=?`, [f.entity]),
    first(c.env.DB, `SELECT * FROM vw_erp_inventory_gl_reconciliation`),
    first(c.env.DB, `SELECT COALESCE(SUM(open_balance),0) amount,COUNT(*) documents
      FROM erp_subledger_documents d JOIN erp_legal_entities e ON e.id=d.entity_id
      WHERE e.entity_code=? AND d.open_balance>0 AND d.due_date<? AND d.status IN ('SUBMITTED','POSTED')`,
      [f.entity, f.dateTo]),
  ]);
  return ok(c, {
    filters:f,
    balances:{
      ...balances,
      profit:round(Number(balances?.revenue || 0) - Number(balances?.expenses || 0)),
    },
    activity, worklist, events, bank, inventory, overdue,
  });
});

financeRoutes.get('/accounts', requirePermission('FINANCE', 'VIEW'), async c => {
  const q = `%${normalizeText(c.req.query('q'))}%`;
  const rows = await all(c.env.DB,
    `SELECT * FROM erp_chart_accounts
      WHERE (?='%%' OR account_code LIKE ? OR account_name LIKE ?)
      ORDER BY account_code`, [q, q, q]);
  return ok(c, { rows });
});

financeRoutes.post('/accounts', requirePermission('FINANCE', 'MANAGE'), async c => {
  const b = await jsonBody(c);
  const code = normalizeText(b.accountCode);
  const name = normalizeText(b.accountName);
  if (!code || !name) return fail(c, 'Account code and name are required.');
  const type = normalizeText(b.accountType).toUpperCase();
  if (!['ASSET','CONTRA_ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE'].includes(type)) {
    return fail(c, 'Select a valid account type.');
  }
  await run(c.env.DB,
    `INSERT INTO erp_chart_accounts(
      account_code,account_name,account_type,financial_statement,normal_balance,parent_account_code,
      control_type,cash_flow_group,system_account,allow_manual_posting
    ) VALUES(?,?,?,?,?,?,?,?,0,?)`,
    [
      code, name, type, ['REVENUE','COGS','EXPENSE'].includes(type) ? 'INCOME_STATEMENT' : 'BALANCE_SHEET',
      ['LIABILITY','EQUITY','REVENUE'].includes(type) ? 'CREDIT' : 'DEBIT',
      normalizeText(b.parentAccountCode), normalizeText(b.controlType || 'NONE').toUpperCase(),
      normalizeText(b.cashFlowGroup), b.allowManualPosting === false ? 0 : 1,
    ]);
  const account = await first(c.env.DB, `SELECT * FROM erp_chart_accounts WHERE account_code=?`, [code]);
  await audit(c, { action:'CREATE', module:'FINANCE', recordType:'ACCOUNT', recordId:account.id, recordNo:code, after:account });
  return ok(c, { account }, 201);
});

financeRoutes.get('/periods', requirePermission('FINANCE', 'VIEW'), async c => {
  const entity = normalizeText(c.req.query('entity') || 'E88').toUpperCase();
  const year = Number(c.req.query('year') || new Date().getFullYear());
  const rows = await all(c.env.DB,
    `SELECT p.*,e.entity_code,e.entity_name FROM erp_accounting_periods p
      JOIN erp_legal_entities e ON e.id=p.entity_id
      WHERE e.entity_code=? AND p.fiscal_year=? ORDER BY p.period_no`,
    [entity, year]);
  return ok(c, { entity, year, rows });
});

financeRoutes.post('/periods/generate', requirePermission('FINANCE', 'MANAGE'), async c => {
  const b = await jsonBody(c);
  const entity = await entityByCode(c.env.DB, b.entityCode || 'E88');
  if (!entity) return fail(c, 'Entity not found.', 404);
  const year = Number(b.year || new Date().getFullYear());
  for (let month = 1; month <= 12; month += 1) {
    await ensureAccountingPeriod(c.env.DB, entity.id, `${year}-${String(month).padStart(2, '0')}-01`);
  }
  return ok(c, { generated:12, entityCode:entity.entity_code, year }, 201);
});

financeRoutes.post('/periods/:id/close-request', requirePermission('FINANCE', 'MANAGE'), async c => {
  const id = Number(c.req.param('id'));
  const b = await jsonBody(c);
  const period = await first(c.env.DB,
    `SELECT p.*,e.entity_code FROM erp_accounting_periods p
      JOIN erp_legal_entities e ON e.id=p.entity_id WHERE p.id=?`, [id]);
  if (!period) return fail(c, 'Period not found.', 404);
  if (period.status === 'CLOSED') return fail(c, 'Period is already closed.', 409);
  const requestNo = await nextCode(c.env.DB, 'FINANCE_CHANGE_REQUEST', 'FCR', 8);
  await run(c.env.DB,
    `INSERT INTO erp_finance_change_requests(
      request_no,target_type,target_id,target_no,action_type,reason,requested_by
    ) VALUES(?,?,?,?,?,?,?)`,
    [requestNo, 'ACCOUNTING_PERIOD', id, `${period.entity_code}-${period.period_name}`, 'CLOSE_PERIOD',
      normalizeText(b.reason) || 'Month-end close completed', c.get('erpUser').email]);
  return ok(c, { requestNo }, 201);
});

financeRoutes.get('/journals', requirePermission('FINANCE', 'VIEW'), async c => {
  const entity = normalizeText(c.req.query('entity') || 'E88').toUpperCase();
  const status = normalizeText(c.req.query('status')).toUpperCase();
  const q = `%${normalizeText(c.req.query('q'))}%`;
  const args = [entity, q, q, q];
  let statusSql = '';
  if (status) { statusSql = ' AND h.status=?'; args.push(status); }
  const rows = await all(c.env.DB,
    `SELECT h.*,e.entity_code,p.period_name,
      (SELECT COUNT(*) FROM erp_journal_lines l WHERE l.journal_id=h.id) line_count
      FROM erp_journal_headers h
      JOIN erp_legal_entities e ON e.id=h.entity_id
      LEFT JOIN erp_accounting_periods p ON p.id=h.period_id
      WHERE e.entity_code=? AND (?='%%' OR h.journal_no LIKE ? OR h.description LIKE ?)
      ${statusSql}
      ORDER BY h.journal_date DESC,h.id DESC LIMIT 1000`, args);
  return ok(c, { rows });
});

financeRoutes.post('/journals', requirePermission('FINANCE', 'CREATE'), async c => {
  const b = await jsonBody(c);
  try {
    const journal = await createJournal(c.env.DB, {
      entityCode:b.entityCode || 'E88', journalDate:b.journalDate, journalType:b.journalType || 'GENERAL',
      sourceModule:'FINANCE', sourceType:'MANUAL_JOURNAL', description:b.description,
      currency:b.currency || 'PHP', exchangeRate:numberValue(b.exchangeRate, 1),
      department:b.department, costCenter:b.costCenter, businessLine:b.businessLine,
      projectCode:b.projectCode, lines:b.lines,
    }, c.get('erpUser').email);
    await audit(c, { action:'CREATE', module:'FINANCE', recordType:'JOURNAL', recordId:journal.id, recordNo:journal.journal_no, after:journal });
    return ok(c, { journal }, 201);
  } catch (error) { return fail(c, error.message, 409); }
});

financeRoutes.get('/journals/:id', requirePermission('FINANCE', 'VIEW'), async c => {
  const data = await journalDetail(c.env.DB, Number(c.req.param('id')));
  if (!data) return fail(c, 'Journal not found.', 404);
  const changes = await all(c.env.DB,
    `SELECT * FROM erp_finance_change_requests WHERE target_type='JOURNAL' AND target_id=?
      ORDER BY requested_at DESC`, [data.header.id]);
  return ok(c, { ...data, changes });
});

financeRoutes.post('/journals/:id/action', requirePermission('FINANCE', 'EDIT'), async c => {
  const id = Number(c.req.param('id'));
  const b = await jsonBody(c);
  const action = normalizeText(b.action).toUpperCase();
  try {
    let journal;
    if (action === 'SUBMIT') journal = await submitJournal(c.env.DB, id, c.get('erpUser').email);
    else if (action === 'APPROVE') {
      const permission = await permissionFor(c.env.DB,c.get('erpUser'),'FINANCE');
      if (!permission.can_approve) return fail(c, 'Approval permission is required.', 403);
      journal = await approveJournal(c.env.DB, id, c.get('erpUser').email);
    } else if (action === 'POST') {
      const permission = await permissionFor(c.env.DB,c.get('erpUser'),'FINANCE');
      if (!permission.can_post) return fail(c, 'Posting permission is required.', 403);
      journal = await postJournal(c.env.DB, id, c.get('erpUser').email);
    } else return fail(c, 'Unsupported journal action.');
    await audit(c, { action, module:'FINANCE', recordType:'JOURNAL', recordId:id, recordNo:journal.journal_no, after:journal });
    return ok(c, { journal });
  } catch (error) { return fail(c, error.message, 409); }
});

financeRoutes.post('/journals/:id/change-request', requirePermission('FINANCE', 'EDIT'), async c => {
  const id = Number(c.req.param('id'));
  const b = await jsonBody(c);
  const journal = await first(c.env.DB, `SELECT * FROM erp_journal_headers WHERE id=?`, [id]);
  if (!journal) return fail(c, 'Journal not found.', 404);
  const action = normalizeText(b.actionType).toUpperCase();
  if (!['REVERSE','VOID'].includes(action)) return fail(c, 'Select reverse or void.');
  if (action === 'REVERSE' && journal.status !== 'POSTED') return fail(c, 'Only a posted journal can be reversed.', 409);
  if (action === 'VOID' && !['DRAFT','SUBMITTED','APPROVED'].includes(journal.status)) return fail(c, 'This journal cannot be voided.', 409);
  if (normalizeText(b.reason).length < 8) return fail(c, 'Provide a complete reason.');
  const pending = await first(c.env.DB,
    `SELECT * FROM erp_finance_change_requests
      WHERE target_type='JOURNAL' AND target_id=? AND action_type=? AND status='REQUESTED'`, [id, action]);
  if (pending) return fail(c, `${pending.request_no} is already awaiting approval.`, 409);
  const requestNo = await nextCode(c.env.DB, 'FINANCE_CHANGE_REQUEST', 'FCR', 8);
  await run(c.env.DB,
    `INSERT INTO erp_finance_change_requests(
      request_no,target_type,target_id,target_no,action_type,reason,requested_by
    ) VALUES(?,?,?,?,?,?,?)`,
    [requestNo, 'JOURNAL', id, journal.journal_no, action, normalizeText(b.reason), c.get('erpUser').email]);
  return ok(c, { requestNo }, 201);
});

financeRoutes.get('/change-requests', requirePermission('FINANCE', 'APPROVE'), async c => {
  const status = normalizeText(c.req.query('status') || 'REQUESTED').toUpperCase();
  const rows = await all(c.env.DB,
    `SELECT * FROM erp_finance_change_requests WHERE (?='' OR status=?)
      ORDER BY requested_at DESC,id DESC`, [status, status]);
  return ok(c, { rows });
});

financeRoutes.post('/change-requests/:id/decision', requirePermission('FINANCE', 'APPROVE'), async c => {
  const id = Number(c.req.param('id'));
  const b = await jsonBody(c);
  const decision = normalizeText(b.decision).toUpperCase();
  const request = await first(c.env.DB, `SELECT * FROM erp_finance_change_requests WHERE id=?`, [id]);
  if (!request) return fail(c, 'Change request not found.', 404);
  if (request.status !== 'REQUESTED') return fail(c, 'Change request was already decided.', 409);
  const user = c.get('erpUser').email;
  if (request.requested_by === user) return fail(c, 'The requester cannot approve the same change.', 409);
  if (!['APPROVE','REJECT'].includes(decision)) return fail(c, 'Decision must be approve or reject.');
  if (decision === 'REJECT') {
    await run(c.env.DB,
      `UPDATE erp_finance_change_requests
        SET status='REJECTED',decided_by=?,decided_at=datetime('now'),decision_notes=? WHERE id=?`,
      [user, normalizeText(b.notes), id]);
    return ok(c, { status:'REJECTED' });
  }
  try {
    if (request.target_type === 'JOURNAL') {
      if (request.action_type === 'REVERSE') {
        await reversePostedJournal(c.env.DB, request.target_id, user, request.request_no);
      } else {
        await run(c.env.DB,
          `UPDATE erp_journal_headers
            SET status='VOIDED',voided_by=?,voided_at=datetime('now'),updated_at=datetime('now')
            WHERE id=? AND status IN ('DRAFT','SUBMITTED','APPROVED')`, [user, request.target_id]);
      }
    } else if (request.target_type === 'ACCOUNTING_PERIOD' && request.action_type === 'CLOSE_PERIOD') {
      const unposted = await first(c.env.DB,
        `SELECT COUNT(*) n FROM erp_journal_headers
          WHERE period_id=? AND status IN ('DRAFT','SUBMITTED','APPROVED')`, [request.target_id]);
      if (Number(unposted?.n || 0) > 0) throw new Error('Post or void all journals before closing the period.');
      await run(c.env.DB,
        `UPDATE erp_accounting_periods
          SET status='CLOSED',closed_by=?,closed_at=datetime('now') WHERE id=?`, [user, request.target_id]);
    }
    await run(c.env.DB,
      `UPDATE erp_finance_change_requests
        SET status='APPROVED',decided_by=?,decided_at=datetime('now'),decision_notes=?,
            executed_at=datetime('now') WHERE id=?`,
      [user, normalizeText(b.notes), id]);
    await audit(c, { action:`APPROVE_${request.action_type}`, module:'FINANCE',
      recordType:request.target_type, recordId:request.target_id, recordNo:request.target_no, after:request });
    return ok(c, { status:'APPROVED' });
  } catch (error) { return fail(c, error.message, 409); }
});

financeRoutes.get('/source-events', requirePermission('FINANCE', 'VIEW'), async c => {
  const status = normalizeText(c.req.query('status')).toUpperCase();
  const eventType = normalizeText(c.req.query('eventType')).toUpperCase();
  const args = []; const where = [];
  if (status) { where.push('ev.status=?'); args.push(status); }
  if (eventType) { where.push('ev.event_type=?'); args.push(eventType); }
  const rows = await all(c.env.DB,
    `SELECT ev.*,h.journal_no,h.status journal_status
       FROM erp_finance_source_events ev
       LEFT JOIN erp_journal_headers h ON h.id=ev.journal_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ev.event_date DESC,ev.id DESC LIMIT 2000`, args);
  return ok(c, { rows });
});

financeRoutes.post('/source-events/:id/retry', requirePermission('FINANCE', 'MANAGE'), async c => {
  try {
    const event = await retryFinanceEvent(c.env.DB, Number(c.req.param('id')), c.get('erpUser').email);
    if (event.status === 'ERROR') return fail(c, event.error_message, 409);
    return ok(c, { event });
  } catch (error) { return fail(c, error.message, 409); }
});

financeRoutes.post('/sync-operational', requirePermission('FINANCE', 'MANAGE'), async c => {
  const user = c.get('erpUser').email;
  const cutover = (await first(c.env.DB,
    `SELECT value FROM erp_settings WHERE key='FINANCE_CUTOVER_TIMESTAMP'`))?.value || '9999-12-31';
  let captured = 0; let noEffect = 0; let errors = 0;
  const process = async event => {
    const result = await captureFinanceEvent(c.env.DB, event, user);
    if (result.status === 'ERROR') errors += 1;
    else if (result.status === 'NO_FINANCIAL_IMPACT') noEffect += 1;
    else captured += 1;
  };
  const receipts = await all(c.env.DB, `SELECT r.id,r.receipt_no,r.received_at,s.purchase_order_ref,
    p.vendor_id,p.currency,COALESCE(SUM(a.unit_cost),0) amount
    FROM erp_receipts r JOIN erp_shipments s ON s.id=r.shipment_id
    LEFT JOIN erp_purchase_orders p ON p.purchase_order_no=s.purchase_order_ref
    LEFT JOIN erp_assets a ON a.receipt_id=r.id
    WHERE r.receiving_status='POSTED' AND r.created_at>=? GROUP BY r.id`, [cutover]);
  for (const row of receipts) await process({
    eventKey:`RECEIPT:${row.id}`, eventType:'GOODS_RECEIPT', sourceModule:'RECEIVING',
    sourceType:'RECEIPT', sourceId:row.id, sourceNo:row.receipt_no, eventDate:row.received_at,
    partnerId:row.vendor_id, amount:row.amount, currency:row.currency || 'PHP',
    description:`Goods receipt ${row.receipt_no} against ${row.purchase_order_ref || 'unlinked PO'}`,
  });
  const landed = await all(c.env.DB,
    `SELECT * FROM erp_landed_cost_headers WHERE status='POSTED' AND created_at>=?`, [cutover]);
  for (const row of landed) await process({
    eventKey:`LANDED_COST:${row.id}`, eventType:'LANDED_COST', sourceModule:'PROCUREMENT',
    sourceType:'LANDED_COST', sourceId:row.id, sourceNo:row.landed_cost_no,
    eventDate:(row.posted_at || row.created_at || '').slice(0, 10), amount:row.total_cost,
    currency:row.currency || 'PHP', description:`Landed cost ${row.landed_cost_no}`,
  });
  const deliveries = await all(c.env.DB, `SELECT d.id,d.delivery_no,d.actual_delivery_date,
    s.id sales_order_id,s.sales_order_no,s.transaction_type,s.customer_id,s.gross_amount,
    COALESCE(SUM(a.unit_cost),0) cost
    FROM erp_deliveries d
    LEFT JOIN erp_sales_orders s ON s.id=d.sales_order_id
    LEFT JOIN erp_delivery_assets da ON da.delivery_id=d.id
    LEFT JOIN erp_assets a ON a.id=da.asset_id
    WHERE d.status='DELIVERED' AND d.created_at>=? GROUP BY d.id`, [cutover]);
  for (const row of deliveries) {
    const alreadyConnected = await first(c.env.DB,`SELECT COUNT(*) n FROM erp_finance_source_events
      WHERE source_type='DELIVERY' AND source_id=? AND event_type IN (
        'CUSTOMER_INVOICE','SALE_COGS','CAPITALIZATION','INVENTORY_CONSUMPTION','WARRANTY_ISSUE','DONATION_ISSUE'
      )`,[row.id]);
    if(Number(alreadyConnected?.n||0)>0)continue;
    if (row.transaction_type === 'SALE') {
      await process({
        eventKey:`DELIVERY_REVENUE:${row.id}`, eventType:'CUSTOMER_INVOICE', sourceModule:'SALES',
        sourceType:'DELIVERY', sourceId:row.id, sourceNo:row.delivery_no,
        eventDate:row.actual_delivery_date, partnerId:row.customer_id, amount:row.gross_amount,
        businessLine:'SALE', description:`Delivered sale ${row.sales_order_no}`,
        payload:{ grossAmount:row.gross_amount, netAmount:round(row.gross_amount / 1.12),
          taxAmount:round(row.gross_amount - row.gross_amount / 1.12), businessLine:'SALE' },
      });
      await process({
        eventKey:`DELIVERY_COGS:${row.id}`, eventType:'SALE_COGS', sourceModule:'INVENTORY',
        sourceType:'DELIVERY', sourceId:row.id, sourceNo:row.delivery_no,
        eventDate:row.actual_delivery_date, partnerId:row.customer_id, amount:row.cost,
        businessLine:'SALE', description:`Cost of delivered sale ${row.sales_order_no}`,
        payload:{ costAmount:row.cost, businessLine:'SALE' },
      });
    } else {
      await process({
        eventKey:`DELIVERY_CUSTODY:${row.id}`, eventType:'INVENTORY_CUSTODY', sourceModule:'INVENTORY',
        sourceType:'DELIVERY', sourceId:row.id, sourceNo:row.delivery_no,
        eventDate:row.actual_delivery_date, partnerId:row.customer_id, amount:row.cost,
        businessLine:row.transaction_type || 'INTERNAL', financialEffect:'NONE',
        description:`Custody movement ${row.delivery_no} - no immediate accounting effect`,
      });
    }
  }
  const movements = await all(c.env.DB, `SELECT l.*,a.unit_cost,a.category
    FROM erp_stock_ledger l LEFT JOIN erp_assets a ON a.id=l.asset_id
    WHERE l.movement_type IN ('TRANSFER','PLACEMENT','DELIVERED','RETURN','GOODS_ISSUANCE',
      'WRITE_OFF','LOSS','DAMAGE','STATUS_CHANGE') AND l.created_at>=?`, [cutover]);
  for (const row of movements) {
    const writeOff = ['WRITE_OFF','LOSS','DAMAGE'].includes(row.movement_type);
    await process({
      eventKey:`STOCK_MOVEMENT:${row.id}`, eventType:writeOff ? 'INVENTORY_WRITE_OFF' : 'INVENTORY_MOVEMENT',
      sourceModule:'INVENTORY', sourceType:'STOCK_MOVEMENT', sourceId:row.id,
      sourceNo:row.movement_no, eventDate:row.movement_date, amount:row.unit_cost,
      financialEffect:writeOff ? 'ACCOUNTING' : 'NONE',
      description:`${row.movement_type.replaceAll('_',' ')} ${row.serial_no}`,
      payload:{ costAmount:row.unit_cost,category:row.category,assetId:row.asset_id,
        serialNo:row.serial_no,itemId:row.item_id },
    });
  }
  return ok(c, { captured, noEffect, errors, cutover, scanned:{
    receipts:receipts.length, landedCosts:landed.length, deliveries:deliveries.length, movements:movements.length,
  }});
});

financeRoutes.get('/subledger', requirePermission('FINANCE', 'VIEW'), async c => {
  const type = normalizeText(c.req.query('type')).toUpperCase();
  const status = normalizeText(c.req.query('status')).toUpperCase();
  const where = []; const args = [];
  if (type) { where.push('d.document_type=?'); args.push(type); }
  if (status) { where.push('d.status=?'); args.push(status); }
  const rows = await all(c.env.DB,
    `SELECT d.*,e.entity_code,p.partner_code,p.name partner_name,p.partner_type,h.journal_no,h.status journal_status
       FROM erp_subledger_documents d
       JOIN erp_legal_entities e ON e.id=d.entity_id
       JOIN erp_partners p ON p.id=d.partner_id
       LEFT JOIN erp_journal_headers h ON h.id=d.journal_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY d.document_date DESC,d.id DESC LIMIT 2000`, args);
  return ok(c, { rows });
});

financeRoutes.post('/subledger', requirePermission('FINANCE', 'CREATE'), async c => {
  const b = await jsonBody(c);
  if (!b.documentDate || !b.partnerId || !b.documentType) return fail(c, 'Type, partner and document date are required.');
  try {
    const document = await createSubledgerDocument(c.env.DB, b, c.get('erpUser').email);
    await audit(c, { action:'CREATE', module:'FINANCE', recordType:'SUBLEDGER_DOCUMENT',
      recordId:document.id, recordNo:document.document_no, after:document });
    return ok(c, { document }, 201);
  } catch (error) { return fail(c, error.message, 409); }
});

financeRoutes.post('/subledger/:id/post', requirePermission('FINANCE', 'POST'), async c => {
  const id = Number(c.req.param('id')); const b = await jsonBody(c);
  try {
    const document = await postSubledgerDocument(c.env.DB, id, b, c.get('erpUser').email);
    return ok(c, { document });
  } catch (error) { return fail(c, error.message, 409); }
});

financeRoutes.post('/subledger/:id/apply', requirePermission('FINANCE', 'POST'), async c => {
  const paymentId = Number(c.req.param('id')); const b = await jsonBody(c);
  const payment = await first(c.env.DB, `SELECT * FROM erp_subledger_documents WHERE id=?`, [paymentId]);
  const target = await first(c.env.DB, `SELECT * FROM erp_subledger_documents WHERE id=?`, [Number(b.appliedDocumentId)]);
  if (!payment || !target) return fail(c, 'Payment or target document not found.', 404);
  if (payment.id === target.id) return fail(c, 'A document cannot be applied to itself.', 409);
  if (!['POSTED','CLOSED'].includes(payment.status) || !['POSTED','CLOSED'].includes(target.status)) {
    return fail(c, 'Post both accounting journals before applying the payment.', 409);
  }
  if (payment.partner_id !== target.partner_id) return fail(c, 'Payment and document must have the same customer or supplier.', 409);
  const validPair = (
    payment.document_type === 'CUSTOMER_RECEIPT'
      && ['CUSTOMER_INVOICE','LEASE_BILLING'].includes(target.document_type)
  ) || (
    payment.document_type === 'SUPPLIER_PAYMENT'
      && target.document_type === 'SUPPLIER_BILL'
  );
  if (!validPair) return fail(c, 'Select a receipt/payment and a compatible invoice/bill.', 409);
  const applied = await first(c.env.DB,
    `SELECT COALESCE(SUM(amount),0) total FROM erp_subledger_applications
      WHERE payment_document_id=?`, [paymentId]);
  const paymentRemaining = round(Number(payment.gross_amount || 0) - Number(applied?.total || 0));
  const amount = Math.min(numberValue(b.amount), Number(target.open_balance || 0), paymentRemaining);
  if (amount <= 0) return fail(c, 'Application amount must be greater than zero.');
  await run(c.env.DB,
    `INSERT INTO erp_subledger_applications(
      payment_document_id,applied_document_id,application_date,amount,created_by
    ) VALUES(?,?,?,?,?)`,
    [paymentId, target.id, b.applicationDate || new Date().toISOString().slice(0, 10), amount, c.get('erpUser').email]);
  await run(c.env.DB,
    `UPDATE erp_subledger_documents SET open_balance=MAX(0,open_balance-?),
      status=CASE WHEN open_balance-?<=0 THEN 'CLOSED' ELSE status END WHERE id=?`,
    [amount, amount, target.id]);
  if (round(paymentRemaining - amount) <= 0) {
    await run(c.env.DB, `UPDATE erp_subledger_documents SET status='CLOSED' WHERE id=?`, [paymentId]);
  }
  return ok(c, { applied:amount, paymentRemaining:round(paymentRemaining - amount) });
});

financeRoutes.get('/aging/:ledger', requirePermission('FINANCE', 'VIEW'), async c => {
  const ledger = normalizeText(c.req.param('ledger')).toUpperCase();
  const asOf = normalizeText(c.req.query('asOf') || new Date().toISOString().slice(0, 10));
  const customer = ledger === 'AR';
  const types = customer
    ? `('CUSTOMER_INVOICE','CUSTOMER_CREDIT','LEASE_BILLING')`
    : `('SUPPLIER_BILL','SUPPLIER_CREDIT')`;
  const rows = await all(c.env.DB,
    `SELECT d.*,p.partner_code,p.name partner_name,p.credit_status
       FROM erp_subledger_documents d JOIN erp_partners p ON p.id=d.partner_id
      WHERE d.document_type IN ${types} AND d.open_balance>0 AND d.document_date<=?
      ORDER BY p.name,d.due_date,d.document_date`, [asOf]);
  /*
   * Payables age from the register that holds them.
   *
   * This read erp_subledger_documents, which no route on this system ever
   * writes: the screen showed an empty table and a total of nought while ten
   * and a half million sat unpaid across thirty-seven requests. The payables
   * are the RFPs, so that is what is aged - net payable less whatever has been
   * settled against it, from the request date where nobody set a due date.
   */
  if (!customer && !rows.length) {
    const rfps = await all(c.env.DB, `
      SELECT r.request_no document_no, r.payee_name partner_name, r.department,
             r.request_date document_date,
             COALESCE(NULLIF(r.due_date,''),r.request_date) due_date,
             r.status,
             ROUND(r.net_payable - COALESCE((SELECT SUM(s.amount) FROM erp_payment_settlements s
               WHERE s.request_no=r.request_no AND s.status<>'VOID'),0), 2) open_balance
        FROM erp_payment_requests r
       WHERE r.status NOT IN ('REJECTED','CANCELLED')
         AND COALESCE(r.request_date,'') <= ?
      ORDER BY r.payee_name, due_date, r.request_date`, [asOf]);
    const open = rfps.filter(r => Number(r.open_balance) > 0.009)
      .map(r => ({ ...r, aging_bucket:calculateAgingBucket(r.due_date, asOf) }));
    const t = open.reduce((out, row) => {
      out.total = round(out.total + Number(row.open_balance || 0));
      out[row.aging_bucket] = round((out[row.aging_bucket] || 0) + Number(row.open_balance || 0));
      return out;
    }, { total:0, CURRENT:0, '1-30':0, '31-60':0, '61-90':0, OVER_90:0 });
    return ok(c, { ledger, asOf, rows:open, totals:t, source:'PAYMENT_REQUESTS' });
  }
  const enriched = rows.map(row => ({ ...row, aging_bucket:calculateAgingBucket(row.due_date, asOf) }));
  const totals = enriched.reduce((out, row) => {
    out.total = round(out.total + Number(row.open_balance || 0));
    out[row.aging_bucket] = round((out[row.aging_bucket] || 0) + Number(row.open_balance || 0));
    return out;
  }, { total:0, CURRENT:0, '1-30':0, '31-60':0, '61-90':0, OVER_90:0 });
  return ok(c, { ledger, asOf, rows:enriched, totals });
});

// Row-level privacy. A requestor only ever sees their own RFPs; a department
// manager/head sees their own department; only Finance and the CEO see everything.
// Controlled by erp_settings.RFP_PRIVACY_ENFORCED so it can be switched off for audit.
// Kept in step with STAGE_ROLE_ALIASES.DEPARTMENT in src/lib/rfp-rules.js: a role
// that may sign the DEPARTMENT stage must also be able to read that department.
const DEPARTMENT_APPROVER_ROLES=STAGE_ROLE_ALIASES.DEPARTMENT;

// Who heads which department (erp_department_heads, migration 0042). Being head
// of Finance is not the same as holding the FINANCE role: Mark validates
// payments as Finance AND approves his own department's requests as its head,
// and those are two different signatures on the same form.
async function departmentHeadEmail(db,department){
  if(!normalizeText(department))return '';
  try{
    const row=await first(db,`SELECT head_email FROM erp_department_heads
      WHERE upper(department)=upper(?)`,[normalizeText(department)]);
    return String(row?.head_email||'').toLowerCase();
  }catch(e){return '';}
}
async function departmentsHeadedBy(db,email){
  if(!email)return [];
  try{
    const rows=await all(db,`SELECT department FROM erp_department_heads WHERE lower(head_email)=lower(?)`,[email]);
    return rows.map(r=>r.department);
  }catch(e){return [];}
}

async function rfpVisibility(c){
  const user=c.get('erpUser')||{};
  const setting=await first(c.env.DB,`SELECT value FROM erp_settings WHERE key='RFP_PRIVACY_ENFORCED'`);
  if(String(setting?.value??'1')!=='1')return {where:'',args:[],level:'ALL'};
  const role=String(user.role_code||'').toUpperCase();
  // MANCOM is an approval tier for the whole company, so it sees everything it
  // may be asked to approve - same as Finance and the CEO.
  // FINANCE_REVIEWER checks every request before it reaches the head of Finance,
  // so like Finance, MANCOM and the CEO she has to be able to see them all.
  if(['FINANCE','FINANCE_REVIEWER','CEO','MANCOM','ADMIN','SUPER_ADMIN'].includes(role))return {where:'',args:[],level:'ALL'};
  // Anyone who approves at the DEPARTMENT stage must be able to SEE their
  // department's requests, or the approval screen shows them nothing and the
  // action endpoint answers "Payment request not found". SCM_HEAD was missing
  // here when the role was introduced, which silently stranded Supply Chain.
  const headed=await departmentsHeadedBy(c.env.DB,user.email);
  if(headed.length||DEPARTMENT_APPROVER_ROLES.includes(role)){
    const depts=[...new Set([...(headed||[]),user.department||''].filter(Boolean))];
    if(!depts.length)return {where:' AND r.requestor_email=?',args:[user.email],level:'OWN'};
    const placeholders=depts.map(()=>'?').join(',');
    return {where:` AND (r.requestor_email=? OR r.department IN (${placeholders}))`,
      args:[user.email,...depts],level:'DEPARTMENT'};
  }
  return {where:' AND r.requestor_email=?',args:[user.email],level:'OWN'};
}

financeRoutes.get('/payment-requests', requirePermission('FINANCE', 'VIEW'), async c => {
  const status=normalizeText(c.req.query('status')).toUpperCase();
  const vis=await rfpVisibility(c);
  const rows=await all(c.env.DB,`SELECT r.*,e.entity_code,p.partner_code,p.name partner_name,
    po.purchase_order_no,b.bank_name,b.account_name,
    (SELECT COUNT(*) FROM erp_attachments a WHERE a.record_type='PAYMENT_REQUEST' AND a.record_id=r.id AND a.active=1) attachment_count,
    (SELECT COUNT(*) FROM erp_payment_request_lines l WHERE l.rfp_ref=r.request_no) line_count,
    (SELECT COUNT(DISTINCT l.account_title) FROM erp_payment_request_lines l
      WHERE l.rfp_ref=r.request_no AND COALESCE(l.account_title,'')<>'') account_count,
    (SELECT l.account_title FROM erp_payment_request_lines l WHERE l.rfp_ref=r.request_no
      AND COALESCE(l.account_title,'')<>'' GROUP BY l.account_title
      ORDER BY SUM(l.gross_amount) DESC LIMIT 1) account_title,
    -- What has actually been paid against this request, and whether the money
    -- has a document behind it. A part payment shows as a balance, not as unpaid.
    (SELECT ROUND(COALESCE(SUM(s.amount),0),2) FROM erp_payment_settlements s
      WHERE s.request_no=r.request_no AND s.status<>'VOID') settled_amount,
    (SELECT COUNT(*) FROM erp_payment_settlements s
      WHERE s.request_no=r.request_no AND s.status<>'VOID') settlement_count,
    (SELECT COUNT(*) FROM erp_payment_settlements s
      WHERE s.request_no=r.request_no AND s.status<>'VOID'
        AND s.proof_attachment_id IS NULL AND COALESCE(s.proof_reference,'')='') settlements_without_proof,
    -- Sent to Monde Nissin, or still sitting fully signed on somebody's desk.
    (SELECT d.dispatched_at FROM erp_rfp_dispatches d
      WHERE d.rfp_ref=r.request_no AND d.status='SENT' ORDER BY d.id DESC LIMIT 1) dispatched_at,
    (SELECT d.dispatched_to FROM erp_rfp_dispatches d
      WHERE d.rfp_ref=r.request_no AND d.status='SENT' ORDER BY d.id DESC LIMIT 1) dispatched_to
    FROM erp_payment_requests r JOIN erp_legal_entities e ON e.id=r.entity_id
    LEFT JOIN erp_partners p ON p.id=r.payee_partner_id
    LEFT JOIN erp_purchase_orders po ON po.id=r.purchase_order_id
    LEFT JOIN erp_bank_accounts b ON b.id=r.bank_account_id
    WHERE (?='' OR r.status=?)${vis.where} ORDER BY r.request_date DESC,r.id DESC`,[status,status,...vis.args]);
  const purchaseOrders=await all(c.env.DB,`SELECT p.id,p.purchase_order_no,p.vendor_id,p.vendor_name,
    p.total_amount,p.tax_amount,p.payment_terms,p.status
    FROM erp_purchase_orders p WHERE p.status IN ('APPROVED','PARTIALLY_RECEIVED','RECEIVED')
    ORDER BY p.order_date DESC,p.id DESC LIMIT 1000`);
  // The screen needs the MANCOM threshold to know which requests get the extra tier.
  const min=await mancomMin(c.env.DB);
  /*
   * The queue this whole stage exists to produce: fully signed, nothing paid,
   * nothing sent. Counted here rather than derived on the screen so the list
   * and the badge cannot disagree.
   */
  const awaitingDispatch=rows.filter(r=>String(r.status||'').toUpperCase()==='APPROVED'
    && !r.dispatched_at && !Number(r.settlement_count||0));
  return ok(c,{rows,purchaseOrders,visibility:vis.level,
    mancomEnabled:Number.isFinite(min),mancomMin:Number.isFinite(min)?min:null,
    financeReview:await financeReviewOn(c.env.DB),
    dispatch:{required:await rfpFlag(c.env.DB,'rfp_require_dispatch','1'),
      defaultTo:await rfpSetting(c.env.DB,'mnc_dispatch_to',''),
      defaultCc:await rfpSetting(c.env.DB,'mnc_dispatch_cc',''),
      awaiting:awaitingDispatch.length,
      awaitingValue:Math.round(awaitingDispatch.reduce((t,r)=>t+Number(r.net_payable||0),0)*100)/100,
      awaitingRefs:awaitingDispatch.slice(0,50).map(r=>r.request_no)},
    roleGate:await rfpFlag(c.env.DB,'rfp_role_gate','0')});
});

// One RFP with its Drive attachments and approval trail.
/*
 * A draft is a working document, so it can be corrected: the header, and the
 * lines it is made of. Once it has been submitted somebody is being asked to
 * sign for a figure, and the figure cannot move underneath them - so anything
 * past DRAFT or RETURNED is refused.
 *
 * Lines are replaced wholesale and the header totals are re-derived from them,
 * because a half-applied line edit is how a total stops matching its rows.
 */
financeRoutes.patch('/payment-requests/:id', requirePermission('FINANCE','EDIT'), async c => {
  const id = Number(c.req.param('id'));
  const before = await first(c.env.DB, `SELECT * FROM erp_payment_requests WHERE id=?`, [id]);
  if (!before) return fail(c, 'Payment request not found.', 404);
  if (!['DRAFT','RETURNED'].includes(String(before.status).toUpperCase()))
    return fail(c, `${before.request_no} is ${String(before.status).toLowerCase().replace(/_/g,' ')} and can no longer be edited.`, 409);
  const b = await jsonBody(c);
  const pick = (k, fallback) => b[k] === undefined ? fallback : normalizeText(b[k]);

  let gross = Number(before.gross_amount || 0);
  let vat = Number(before.vat_amount || 0);
  let ewt = Number(before.withholding_amount || 0);
  let net = Number(before.net_payable || 0);

  if (Array.isArray(b.lines)) {
    const lines = b.lines.filter(l => normalizeText(l.accountTitle) || numberValue(l.grossAmount));
    if (!lines.length) return fail(c, 'A request needs at least one line.');
    await run(c.env.DB, `DELETE FROM erp_payment_request_lines WHERE rfp_ref=?`, [before.request_no]);
    gross = vat = ewt = net = 0;
    let lineNo = 0;
    for (const l of lines) {
      lineNo += 1;
      const lg = round(numberValue(l.grossAmount));
      const rate = numberValue(l.vatRate);
      const lnet = rate ? round(lg / (1 + rate)) : lg;
      const lvat = round(lg - lnet);
      const lewt = round(numberValue(l.ewtAmount));
      gross = round(gross + lg); vat = round(vat + lvat);
      ewt = round(ewt + lewt); net = round(net + (lg - lewt));
      await run(c.env.DB, `INSERT INTO erp_payment_request_lines(payment_request_id,rfp_ref,line_no,
          account_title,source_account_title,procurement_category,description,cost_center,department,
          gross_amount,vat_type,vat_rate,net_of_vat,input_vat,ewt_amount,net_payable)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, before.request_no, lineNo, normalizeText(l.accountTitle), normalizeText(l.sourceAccountTitle),
         normalizeText(l.procurementCategory), normalizeText(l.description),
         normalizeText(l.costCenter) || before.cost_center, normalizeText(l.department) || before.department,
         lg, normalizeText(l.vatType) || 'VATable', rate, lnet, lvat, lewt, round(lg - lewt)]);
    }
  }

  await run(c.env.DB, `UPDATE erp_payment_requests SET payee_name=?,department=?,cost_center=?,
      project_code=?,purpose=?,request_type=?,supplier_invoice_no=?,invoice_date=?,due_date=?,
      gross_amount=?,vat_amount=?,withholding_amount=?,net_payable=?,updated_at=datetime('now')
    WHERE id=?`,
    [pick('payeeName', before.payee_name), pick('department', before.department),
     pick('costCenter', before.cost_center), pick('projectCode', before.project_code),
     pick('purpose', before.purpose), pick('requestType', before.request_type),
     pick('supplierInvoiceNo', before.supplier_invoice_no), pick('invoiceDate', before.invoice_date),
     pick('dueDate', before.due_date), gross, vat, ewt, net, id]);
  const after = await first(c.env.DB, `SELECT * FROM erp_payment_requests WHERE id=?`, [id]);
  await audit(c, { action:'EDIT', module:'FINANCE', recordType:'PAYMENT_REQUEST',
    recordId:id, recordNo:after.request_no, before, after });
  const lines = await all(c.env.DB, `SELECT * FROM erp_payment_request_lines WHERE rfp_ref=? ORDER BY line_no`,
    [after.request_no]);
  return ok(c, { request: after, lines });
});

financeRoutes.get('/payment-requests/:id', requirePermission('FINANCE','VIEW'), async c=>{
  const id=Number(c.req.param('id'));
  const vis=await rfpVisibility(c);
  const row=await first(c.env.DB,`SELECT r.*,e.entity_code,p.name partner_name,po.purchase_order_no
    FROM erp_payment_requests r JOIN erp_legal_entities e ON e.id=r.entity_id
    LEFT JOIN erp_partners p ON p.id=r.payee_partner_id
    LEFT JOIN erp_purchase_orders po ON po.id=r.purchase_order_id
    WHERE r.id=?${vis.where}`,[id,...vis.args]);
  if(!row)return fail(c,'Payment request not found.',404);
  const attachments=await attachmentsFor(c.env.DB,'PAYMENT_REQUEST',id,row.request_no);
  /*
   * The lines a request was made of. One RFP routinely spans several account
   * titles, and the ledger posts each of them separately, so the detail screen
   * has to show the split rather than only the total on the header.
   */
  const lines=await all(c.env.DB,`SELECT * FROM erp_payment_request_lines
    WHERE payment_request_id=? OR rfp_ref=? ORDER BY line_no`,[id,row.request_no]);
  const byAccount=await all(c.env.DB,`SELECT COALESCE(NULLIF(account_title,''),'Unclassified') label,
      ROUND(SUM(gross_amount),2) value, COUNT(*) n
    FROM erp_payment_request_lines WHERE payment_request_id=? OR rfp_ref=?
    GROUP BY label ORDER BY value DESC`,[id,row.request_no]);
  const liquidation=await first(c.env.DB,`SELECT * FROM erp_rfp_liquidations WHERE payment_request_id=?`,[id]);
  const signatures=await all(c.env.DB,`SELECT stage,decision,actor,actor_name,reason,signature,created_at
    FROM erp_rfp_approvals WHERE rfp_ref=? ORDER BY id`,[row.request_no]);
  // Workflow position, so the screen knows whether MANCOM applies to this amount.
  const min=await mancomMin(c.env.DB);
  const review=await financeReviewOn(c.env.DB);
  const workflow={mancomEnabled:Number.isFinite(min),mancomMin:Number.isFinite(min)?min:null,
    mancomRequired:Number(row.net_payable||0)>=min,financeReview:review,
    stages:requiredStages(row.net_payable,min,review),
    nextStage:nextStage(row.net_payable,min,signatures,review),
    attachmentsEditable:['DRAFT','RETURNED'].includes(String(row.status||'').toUpperCase())};
  /*
   * Where this request stands with Monde Nissin. "due" is the screen's cue to
   * offer the dispatch button: fully approved, nothing sent, nothing paid.
   */
  const dispatches=await all(c.env.DB,`SELECT id,dispatched_to,dispatched_cc,subject,message,
      attachment_count,dispatched_by,dispatched_at,status,void_reason
    FROM erp_rfp_dispatches WHERE rfp_ref=? ORDER BY id DESC`,[row.request_no]).catch(()=>[]);
  const sentDispatch=dispatches.find(d=>String(d.status)==='SENT')||null;
  const docLink=await first(c.env.DB,`SELECT token,view_count,last_seen_at FROM erp_rfp_doc_tokens
     WHERE rfp_ref=? AND revoked=0`,[row.request_no]).catch(()=>null);
  workflow.dispatch={required:await rfpFlag(c.env.DB,'rfp_require_dispatch','1'),
    sent:sentDispatch,history:dispatches,
    /* Did they ever open it. The first question Finance ask when a payment goes quiet. */
    documentUrl:docLink?`/rfp.html?t=${docLink.token}`:null,
    documentViews:docLink?Number(docLink.view_count||0):0,
    documentLastSeen:docLink?docLink.last_seen_at:null,
    due:String(row.status||'').toUpperCase()==='APPROVED'&&!sentDispatch,
    canDispatch:canSettle(c.get('erpUser'))&&String(row.status||'').toUpperCase()==='APPROVED',
    defaultTo:await rfpSetting(c.env.DB,'mnc_dispatch_to',''),
    defaultCc:await rfpSetting(c.env.DB,'mnc_dispatch_cc','')};
  const encoder=await first(c.env.DB,`SELECT * FROM erp_rfp_encoders WHERE request_no=?`,[row.request_no])
    .catch(()=>null);
  const settlement=await settlementSummary(c.env.DB,row.request_no,row.net_payable);
  const banks=await all(c.env.DB,`SELECT id,bank_account_code,bank_name,account_name
    FROM erp_bank_accounts WHERE active=1 ORDER BY bank_name`);
  return ok(c,{request:row,attachments,lines,byAccount,liquidation:liquidation||null,signatures,workflow,
    encoder:encoder||null,
    settlement:{...settlement,banks,canSettle:canSettle(c.get('erpUser'))&&!(await paymentBlockedBecause(c.env.DB,row)),
      blockedBecause:await paymentBlockedBecause(c.env.DB,row),
      evidenceFrom:await evidenceFrom(c.env.DB),
      // A request raised on or after the cutoff is not called paid until the
      // bank advice is on the record, whatever the settlements add up to.
      proofRequired:String(row.request_date||'')>=String(await evidenceFrom(c.env.DB))}});
});

// RFP numbering, spec section 9: RFP-<DEPT><YEAR>-NNNN  e.g. RFP-OPS2026-0081.
// The department code comes from erp_departments; anything unmatched is reduced to
// its own letters so a free-typed department still produces a stable prefix.
async function rfpNumber(db,department,requestDate){
  const name=normalizeText(department);
  let code='';
  if(name){
    const row=await first(db,`SELECT code FROM erp_departments
      WHERE upper(code)=upper(?) OR upper(name)=upper(?) OR upper(name) LIKE upper(?)||'%'
      ORDER BY length(name) LIMIT 1`,[name,name,name]);
    code=normalizeText(row?.code);
  }
  if(!code){
    const words=name.replace(/[^A-Za-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);
    code=words.length>1?words.map(w=>w[0]).join('').slice(0,4):(words[0]||'GEN').slice(0,4);
  }
  code=code.toUpperCase().replace(/[^A-Z0-9]/g,'')||'GEN';
  const year=String(requestDate||'').slice(0,4).match(/^\d{4}$/)
    ?String(requestDate).slice(0,4):new Date().toISOString().slice(0,4);
  // One running sequence per department and year, so the NNNN restarts each year.
  return await nextCode(db,`PAYMENT_REQUEST_${code}${year}`,`RFP-${code}${year}`,4);
}

financeRoutes.post('/payment-requests', requirePermission('FINANCE','CREATE'), async c=>{
  const b=await jsonBody(c);
  const entity=await entityByCode(c.env.DB,b.entityCode||'E88');
  if(!entity)return fail(c,'Entity not found.',404);
  const po=b.purchaseOrderId?await first(c.env.DB,`SELECT * FROM erp_purchase_orders WHERE id=?`,[Number(b.purchaseOrderId)]):null;
  const landedCost=b.landedCostId?await first(c.env.DB,`SELECT * FROM erp_landed_cost_headers WHERE id=?`,[Number(b.landedCostId)]):null;
  const partner=b.payeePartnerId?await first(c.env.DB,`SELECT * FROM erp_partners WHERE id=?`,[Number(b.payeePartnerId)]):
    po?.vendor_id?await first(c.env.DB,`SELECT * FROM erp_partners WHERE id=?`,[po.vendor_id]):null;
  const payee=normalizeText(b.payeeName||partner?.name||po?.vendor_name);
  if(!payee||!b.department||!b.purpose)return fail(c,'Payee, department and purpose are required.');
  const gross=numberValue(b.grossAmount,landedCost?.invoice_total||po?.total_amount||0);
  const vat=numberValue(b.vatAmount,landedCost?.input_vat_amount||po?.tax_amount||0);
  const withholding=numberValue(b.withholdingAmount);
  const net=round(gross-withholding);
  if(gross<=0)return fail(c,'Gross amount must be greater than zero.');
  const rawType=normalizeText(b.requestType||'Payment to Vendor');
  const isCashAdvance=/cash\s*advance/i.test(rawType);
  const requestDate=b.requestDate||new Date().toISOString().slice(0,10);
  const requestNo=await rfpNumber(c.env.DB,b.department,requestDate);
  /*
   * Who asked, and who typed it in.
   *
   * Rucel encodes every request in the company. If the record says she is the
   * requestor then the separation-of-duties rule - which is right - refuses to
   * let her check it, on every request. So a Finance encoder may name the
   * person the request is actually for, and the record carries both.
   *
   * Anyone else raising their own request is the requestor, as before.
   */
  const creator=c.get('erpUser');
  const requestedFor=normalizeText(b.requestedFor||b.requestorEmail).toLowerCase();
  const encoding=!!requestedFor&&requestedFor!==String(creator.email||'').toLowerCase()
    &&canReclassify(creator);
  const requestorEmail=encoding?requestedFor:creator.email;
  const inserted=await run(c.env.DB,`INSERT INTO erp_payment_requests(
    request_no,entity_id,request_date,requestor_email,payee_partner_id,payee_name,department,
    cost_center,project_code,purpose,request_type,purchase_order_id,purchase_order_no,landed_cost_id,
    supplier_invoice_no,invoice_date,gross_amount,vat_amount,withholding_amount,net_payable,
    due_date,payment_method,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT')`,[
    requestNo,entity.id,requestDate,requestorEmail,
    partner?.id||null,payee,normalizeText(b.department),normalizeText(b.costCenter),
    normalizeText(b.projectCode),normalizeText(b.purpose),normalizeText(b.requestType||'SUPPLIER_PAYMENT'),
    po?.id||null,po?.purchase_order_no||normalizeText(b.purchaseOrderNo),landedCost?.id||null,
    normalizeText(b.supplierInvoiceNo),b.invoiceDate||'',gross,vat,withholding,net,
    b.dueDate||'',normalizeText(b.modeOfPayment||b.paymentMethod),
  ]);
  const rfpId=inserted.meta.last_row_id;
  // Who typed it in, kept beside who asked. On an encoded request the approval
  // trail would otherwise read as though Rucel wanted the money.
  await run(c.env.DB,`INSERT OR REPLACE INTO erp_rfp_encoders(request_no,encoded_by,encoded_for,note)
    VALUES(?,?,?,?)`,[requestNo,creator.email,requestorEmail,
    encoding?`Encoded by ${creator.display_name||creator.email} on behalf of ${requestorEmail}.`:null]);
  // Extra fields captured on the redesigned form live in the RFP settings-style
  // side table so no ALTER of erp_payment_requests is needed.
  const extras={requestorName:normalizeText(b.requestorName),requestorEmail:normalizeText(b.requestorEmail)||c.get('erpUser').email,
    contactNo:normalizeText(b.contactNo),paymentType:normalizeText(b.paymentType),modeOfPayment:normalizeText(b.modeOfPayment),
    bankName:normalizeText(b.bankName),accountName:normalizeText(b.accountName),accountNo:normalizeText(b.accountNo),
    payeeTin:normalizeText(b.payeeTin),payeeContact:normalizeText(b.payeeContact),payeeEmail:normalizeText(b.payeeEmail),
    glAccount:normalizeText(b.glAccount),currency:normalizeText(b.currency)||'PHP',remarks:normalizeText(b.remarks),
    requestType:rawType,cashAdvance:isCashAdvance?1:0,
    signature:normalizeText(b.requestorSignature),signatureType:normalizeText(b.signatureType)||'TYPE'};
  try{await run(c.env.DB,`INSERT OR REPLACE INTO erp_rfp_settings(key,value) VALUES(?,?)`,['rfp_doc:'+requestNo,JSON.stringify(extras)]);}catch(e){}
  // The requestor's e-signature opens the approval trail.
  if(normalizeText(b.requestorSignature)){
    await run(c.env.DB,`INSERT INTO erp_rfp_approvals(rfp_ref,stage,decision,actor,actor_name,signature,amount)
      VALUES(?,?,?,?,?,?,?)`,[requestNo,'REQUESTOR','SIGNED',requestorEmail,
      normalizeText(b.requestorName)||(encoding?requestedFor:creator.display_name)||'',
      String(b.requestorSignature).slice(0,300000),net]);
  }
  // Supporting documents -> Google Drive / Payables Management / <RFP no>
  const attach=await saveAttachments(c.env,c.env.DB,{moduleCode:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordId:rfpId,recordNo:requestNo,files:b.attachments,uploadedBy:c.get('erpUser').email});
  await audit(c,{action:'CREATE',module:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordId:rfpId,recordNo:requestNo,after:{gross,vat,withholding,net,cashAdvance:isCashAdvance}});
  return ok(c,{id:rfpId,requestNo,netPayable:net,cashAdvance:isCashAdvance,
    attachments:attach.saved,attachmentErrors:attach.failed},201);
});

// ---------------------------------------------------------------------------
// Supporting documents. Spec step 4: "attachments editable only while Draft."
// A returned request is back in the requestor's hands, so it counts as editable
// too - that is the whole point of returning it.
// ---------------------------------------------------------------------------
const RFP_EDITABLE=['DRAFT','RETURNED'];

async function rfpForEdit(c,id){
  const row=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  if(!row)return {error:'Payment request not found.',code:404};
  if(!RFP_EDITABLE.includes(String(row.status||'').toUpperCase())){
    return {error:`Supporting documents can only be changed while the request is a draft. This one is ${String(row.status).replace(/_/g,' ').toLowerCase()}.`,code:409};
  }
  const me=c.get('erpUser');
  const role=String(me.role_code||'').toUpperCase();
  if(row.requestor_email!==me.email&&!['FINANCE','CEO','ADMIN','SUPER_ADMIN'].includes(role)){
    return {error:'You can only change documents on your own request.',code:403};
  }
  return {row};
}

financeRoutes.post('/payment-requests/:id/attachments', requirePermission('FINANCE','CREATE'), async c=>{
  const id=Number(c.req.param('id'));
  const {row,error,code}=await rfpForEdit(c,id);
  if(error)return fail(c,error,code);
  const b=await jsonBody(c);
  if(!Array.isArray(b.attachments)||!b.attachments.length)return fail(c,'Choose at least one file to upload.');
  const attach=await saveAttachments(c.env,c.env.DB,{moduleCode:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordId:id,recordNo:row.request_no,files:b.attachments,uploadedBy:c.get('erpUser').email});
  await audit(c,{action:'ATTACH',module:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordId:id,recordNo:row.request_no,after:{files:attach.saved.length}});
  return ok(c,{attachments:attach.saved,attachmentErrors:attach.failed});
});

financeRoutes.delete('/payment-requests/:id/attachments/:attachmentId', requirePermission('FINANCE','EDIT'), async c=>{
  const id=Number(c.req.param('id'));
  const {row,error,code}=await rfpForEdit(c,id);
  if(error)return fail(c,error,code);
  const attachmentId=Number(c.req.param('attachmentId'));
  const att=await first(c.env.DB,`SELECT * FROM erp_attachments WHERE id=? AND record_type='PAYMENT_REQUEST' AND record_id=?`,
    [attachmentId,id]);
  if(!att)return fail(c,'Attachment not found on this request.',404);
  // Soft delete: the file stays in Drive, it is simply no longer part of the RFP.
  await run(c.env.DB,`UPDATE erp_attachments SET active=0 WHERE id=?`,[attachmentId]);
  await audit(c,{action:'DETACH',module:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordId:id,recordNo:row.request_no,before:{file:att.file_name}});
  return ok(c,{removed:att.file_name});
});

/* =====================================================================
 * Settling a payment request
 *
 * A payment is a row, not a flag. One request can be settled in several
 * goes - a 30% down payment against a nine million peso supply order is
 * the ordinary case, not the exception - so what is paid and what is
 * still owed are added up from the settlements rather than asserted on
 * the header.
 *
 * Each settlement carries its own proof of payment: the bank advice or
 * cheque image, who uploaded it and when. A settlement without proof is
 * a claim, and the screen says so.
 * ===================================================================== */

/*
 * Only Finance records a payment or uploads its proof - the same line the
 * receivables side draws, and the same one the RFP chain draws between
 * checking a request and approving it. The Finance checker is included: she
 * puts the paperwork straight, and a bank advice is paperwork.
 */
const FINANCE_SETTLE_ROLES=['FINANCE','FINANCE_MANAGER','CONTROLLER','ACCOUNTING',
  'FINANCE_REVIEWER','ADMIN'];
function canSettle(user){
  const role=String(user?.role_code||user?.role||'').toUpperCase();
  return FINANCE_SETTLE_ROLES.includes(role);
}

/*
 * Money only follows approval.
 *
 * canSettle asked who you are and never what the request is, so Finance could
 * record a payment - and upload a bank advice for it - against a request still
 * sitting in DRAFT, which nobody has approved and no bank has been told to pay.
 * The chain exists to stop exactly that, and a settlement recorded before it
 * runs makes the whole strip decorative.
 *
 * A request may be paid once the CEO has released it, and remains payable while
 * it is part paid or being proved. Everything earlier is still being decided;
 * everything else is closed.
 */
const SETTLEABLE_STATUSES=['APPROVED','PAYMENT_PREPARED','PARTIALLY_PAID','PAID_UNPROVEN','PAID'];
function settlementStage(row){
  const status=String(row?.status||'').toUpperCase();
  if(SETTLEABLE_STATUSES.includes(status))return null;
  if(['REJECTED','CANCELLED'].includes(status))
    return `${row.request_no} is ${status.toLowerCase()} and cannot be paid.`;
  return `${row.request_no} is ${status.replace(/_/g,' ').toLowerCase()} and has not been approved for `
    +'payment yet. It has to clear the approval chain before a payment can be recorded against it.';
}

/*
 * Putting the filing straight is the checker's job, and she commits nothing by
 * doing it: a department is not a figure. Rucel checks every request, so she is
 * the one who sees that a station rent came in under Admin.
 */
const canReclassify = canSettle;

/* ------------------------------------------------------------------ MNC dispatch
 *
 * The CEO's signature releases the request, not the money. On the Apps Script
 * that E88 run, final approval routes the request back to Finance at a stage
 * called MNC Dispatch, where Finance emails the signed RFP and its attachments
 * to Monde Nissin. Payment follows the dispatch, never precedes it.
 *
 * The state is the latest dispatch that was not voided. Kept as a row rather
 * than a status so a re-send is a second attempt with its own date and
 * recipient, and so the 252 requests imported already paid are left alone.
 */
async function latestDispatch(db,requestNo){
  try{
    return await first(db,`SELECT * FROM erp_rfp_dispatches
       WHERE rfp_ref=? AND status='SENT' ORDER BY id DESC LIMIT 1`,[requestNo]);
  }catch(e){ return null; }   // table not migrated yet
}

/**
 * Why this request may not be paid yet, or null if it may.
 *
 * Two reasons, in the order they bite: it has not cleared the chain, or it has
 * cleared the chain but has not been sent to MNC. The second is skipped for a
 * request that already carries a payment, because a request imported as paid
 * was dispatched on paper years before this table existed and blocking it now
 * would be the ERP inventing a rule about the past.
 */
async function paymentBlockedBecause(db,row){
  const stage=settlementStage(row);
  if(stage)return stage;
  if(!(await rfpFlag(db,'rfp_require_dispatch','1')))return null;
  if(String(row?.status||'').toUpperCase()!=='APPROVED')return null;  // already in payment
  /*
   * Any payment history at all, voided included. Money has been recorded against
   * this request before, which for an imported one means it was dispatched on
   * paper long before this table existed. Counting only live settlements made a
   * void look like a request that had never been paid, so voiding an import to
   * record the real figure demanded a dispatch for something already sent.
   *
   * This opens no hole for a new request: without a dispatch it can never take
   * its first settlement, so a settlement row is itself proof of a dispatch.
   */
  const settled=await first(db,`SELECT COUNT(*) n FROM erp_payment_settlements
     WHERE request_no=?`,[row.request_no]).catch(()=>null);
  if(Number(settled?.n||0)>0)return null;
  if(await latestDispatch(db,row.request_no))return null;
  return `${row.request_no} has been approved but not yet dispatched to Monde Nissin. `
    +'Send the signed RFP and its attachments first, then record the payment.';
}

const round2=v=>Math.round(Number(v||0)*100)/100;

/**
 * Everything the screens need to know about how far a request is settled.
 * Kept in one place so the list, the detail and the dashboard cannot drift.
 */
async function settlementSummary(db,requestNo,netPayable){
  const rows=await all(db,`SELECT s.*,b.bank_name,b.account_name,
      a.file_name proof_file_name,a.file_url proof_file_url
    FROM erp_payment_settlements s
    LEFT JOIN erp_bank_accounts b ON b.id=s.bank_account_id
    LEFT JOIN erp_attachments a ON a.id=s.proof_attachment_id
    WHERE s.request_no=? ORDER BY s.paid_date IS NULL, s.paid_date, s.id`,[requestNo]);
  const live=rows.filter(r=>String(r.status||'SETTLED').toUpperCase()!=='VOID');
  const settled=round2(live.reduce((s,r)=>s+Number(r.amount||0),0));
  const net=round2(netPayable);
  const balance=round2(Math.max(0,net-settled));
  const evidenced=live.filter(r=>r.proof_attachment_id||normalizeText(r.proof_reference)).length;
  return {
    settlements:rows,
    settled,balance,
    settledPct:net>0?round2((settled/net)*100):null,
    // FULLY when the balance is closed to the centavo, PART when some money
    // has moved, NONE when none has.
    coverage:settled<=0?'NONE':balance<=0.01?'FULLY':'PART',
    withProof:evidenced,
    withoutProof:live.length-evidenced,
    proofComplete:live.length>0&&evidenced===live.length,
  };
}

/** The date from which a payment needs its proof before it may be called paid. */
const evidenceFrom=db=>rfpSetting(db,'rfp_paid_evidence_from','2026-07-31');

/**
 * The status a request should be standing at, given what has been settled.
 * A request dated on or after the evidence cutoff is not called paid until a
 * proof of payment is on the record, however much money the settlements say
 * moved: the most recent requests have no bank advice behind them yet, and a
 * paid flag nobody can show is worse than an honest outstanding one.
 */
function statusForSettlement(request,summary,cutoff){
  if(summary.coverage==='NONE')return null;
  const needsProof=String(request.request_date||'')>=String(cutoff||'');
  if(summary.coverage==='FULLY'){
    // Settled to the centavo but nobody has shown the bank advice. That is not
    // "part paid" - the balance is nil - and it is not "paid" either, because
    // paid is a claim somebody has to be able to support. It is its own state,
    // and the only thing missing is a document.
    if(needsProof&&!summary.proofComplete)return 'PAID_UNPROVEN';
    return 'PAID';
  }
  return 'PARTIALLY_PAID';
}

async function applySettlementStatus(c,request){
  const summary=await settlementSummary(c.env.DB,request.request_no,request.net_payable);
  const cutoff=await evidenceFrom(c.env.DB);
  const want=statusForSettlement(request,summary,cutoff);
  if(want&&want!==request.status){
    const paidAt=want==='PAID'
      ?(summary.settlements.filter(s=>s.paid_date).map(s=>s.paid_date).sort().pop()
        ||new Date().toISOString().slice(0,10)):null;
    await run(c.env.DB,`UPDATE erp_payment_requests SET status=?,paid_at=?,
      paid_by=COALESCE(paid_by,?),updated_at=datetime('now') WHERE id=?`,
      [want,paidAt,c.get('erpUser').email,request.id]);
  }
  if(!want&&['PAID','PARTIALLY_PAID','PAID_UNPROVEN'].includes(String(request.status||''))){
    // Every settlement was voided: the request goes back to owing the money.
    await run(c.env.DB,`UPDATE erp_payment_requests SET status='APPROVED',paid_at=NULL,
      updated_at=datetime('now') WHERE id=?`,[request.id]);
  }
  return summary;
}

// The settlements on one request, with what is still owed.
financeRoutes.get('/payment-requests/:id/settlements', requirePermission('FINANCE','VIEW'), async c=>{
  const id=Number(c.req.param('id'));
  const row=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  if(!row)return fail(c,'Payment request not found.',404);
  const summary=await settlementSummary(c.env.DB,row.request_no,row.net_payable);
  return ok(c,{request:{id:row.id,requestNo:row.request_no,netPayable:row.net_payable,status:row.status},
    ...summary,canSettle:canSettle(c.get('erpUser'))&&!(await paymentBlockedBecause(c.env.DB,row)),
    settlementBlockedBecause:await paymentBlockedBecause(c.env.DB,row),
    evidenceFrom:await evidenceFrom(c.env.DB)});
});

/*
 * Record a payment against the request. Part or whole: the amount is what
 * actually left the bank, and it may not take the total past what is owed.
 *
 * The proof of payment may come with it or follow later; either way the
 * settlement records who put it there.
 */
financeRoutes.post('/payment-requests/:id/settlements', requirePermission('FINANCE','CREATE'), async c=>{
  const id=Number(c.req.param('id'));
  const user=c.get('erpUser');
  if(!canSettle(user))return fail(c,'Only Finance records a payment against a request.',403);
  const row=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  if(!row)return fail(c,'Payment request not found.',404);
  const stageBlock=await paymentBlockedBecause(c.env.DB,row);
  if(stageBlock)return fail(c,stageBlock,409);
  const b=await jsonBody(c);
  const amount=round2(numberValue(b.amount));
  if(!(amount>0))return fail(c,'Enter the amount that was paid.');
  const before=await settlementSummary(c.env.DB,row.request_no,row.net_payable);
  if(amount-before.balance>0.01)
    return fail(c,`Only ${rfpMoney(before.balance)} is still owed on ${row.request_no}. `
      +`Recording ${rfpMoney(amount)} would overpay it.`);
  let bankAccountId=null;
  if(b.bankAccountId){
    const bank=await first(c.env.DB,`SELECT id FROM erp_bank_accounts WHERE id=?`,[Number(b.bankAccountId)]);
    if(!bank)return fail(c,'Bank account not found.');
    bankAccountId=bank.id;
  }
  const paidDate=normalizeText(b.paidDate)||new Date().toISOString().slice(0,10);
  const r=await run(c.env.DB,`INSERT INTO erp_payment_settlements
    (request_no,payment_request_id,amount,paid_date,payment_reference,payment_method,
     bank_account_id,proof_reference,source,notes,recorded_by,natural_key)
    VALUES(?,?,?,?,?,?,?,?,'SYSTEM',?,?,?)`,[
    row.request_no,id,amount,paidDate,normalizeText(b.paymentReference)||null,
    normalizeText(b.paymentMethod)||null,bankAccountId,normalizeText(b.proofReference)||null,
    normalizeText(b.notes)||null,user.email,
    `MANUAL:${row.request_no}:${Date.now()}`,
  ]);
  const settlementId=r.meta.last_row_id;
  /*
   * A reference typed here counts as evidence, so it has to be written into the
   * proof trail as well. Without that the record says "proved" while the trail
   * says nothing, and the register loader reads the trail.
   */
  if(normalizeText(b.proofReference)){
    await run(c.env.DB,`INSERT INTO erp_rfp_proof_of_payment(rfp_ref,reference,paid_at,actor)
      VALUES(?,?,?,?)`,[row.request_no,normalizeText(b.proofReference),paidDate,user.email]);
    await run(c.env.DB,`UPDATE erp_payment_settlements SET proof_uploaded_by=?,
      proof_uploaded_at=datetime('now') WHERE id=?`,[user.email,settlementId]);
  }
  // Proof of payment, if it came with the entry.
  let attach={saved:[],failed:[]};
  if(Array.isArray(b.attachments)&&b.attachments.length){
    attach=await saveAttachments(c.env,c.env.DB,{moduleCode:'FINANCE',recordType:'PAYMENT_PROOF',
      recordId:settlementId,recordNo:row.request_no,files:b.attachments,uploadedBy:user.email});
    if(attach.saved.length){
      await run(c.env.DB,`UPDATE erp_payment_settlements SET proof_attachment_id=?,
        proof_uploaded_by=?,proof_uploaded_at=datetime('now') WHERE id=?`,
        [attach.saved[0].id,user.email,settlementId]);
    }
  }
  const summary=await applySettlementStatus(c,row);
  const after=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  await audit(c,{action:'SETTLE',module:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordId:id,recordNo:row.request_no,before:row,after:{...after,settled:summary.settled}});
  return ok(c,{settlementId,request:after,...await settlementSummary(c.env.DB,row.request_no,row.net_payable),
    attachments:attach.saved,attachmentErrors:attach.failed},201);
});

/*
 * The proof of payment uploader.
 *
 * It hangs off the settlement rather than the request, because a part-paid
 * order has one bank advice per instalment and filing them all in one pile
 * loses which document proves which payment. It works on any settlement,
 * including the ones the 2026 register was loaded with, which is the point:
 * those 318 payments have a reference from a spreadsheet and no document, and
 * this is how the document gets onto the record.
 */
financeRoutes.post('/payment-requests/:id/settlements/:settlementId/proof',
  requirePermission('FINANCE','CREATE'), async c=>{
  const id=Number(c.req.param('id'));
  const settlementId=Number(c.req.param('settlementId'));
  const user=c.get('erpUser');
  if(!canSettle(user))return fail(c,'Only Finance uploads the proof of payment.',403);
  const row=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  if(!row)return fail(c,'Payment request not found.',404);
  const settlement=await first(c.env.DB,`SELECT * FROM erp_payment_settlements WHERE id=? AND request_no=?`,
    [settlementId,row.request_no]);
  if(!settlement)return fail(c,'That payment is not on this request.',404);
  // Proving a payment on a request that was never approved is the same act as
  // making one, so it meets the same gate.
  const proofBlock=await paymentBlockedBecause(c.env.DB,row);
  if(proofBlock)return fail(c,proofBlock,409);
  if(String(settlement.status||'').toUpperCase()==='VOID')
    return fail(c,'That payment was voided. Record it again rather than proving a reversal.',409);
  const b=await jsonBody(c);
  const reference=normalizeText(b.proofReference);
  const files=Array.isArray(b.attachments)?b.attachments:[];
  if(!files.length&&!reference)
    return fail(c,'Attach the bank advice, or give the reference it can be found under.');
  let attach={saved:[],failed:[]};
  if(files.length){
    attach=await saveAttachments(c.env,c.env.DB,{moduleCode:'FINANCE',recordType:'PAYMENT_PROOF',
      recordId:settlementId,recordNo:row.request_no,files,uploadedBy:user.email});
    if(!attach.saved.length)
      return fail(c,`The document could not be stored. ${(attach.failed[0]||{}).error||''}`.trim());
  }
  await run(c.env.DB,`UPDATE erp_payment_settlements SET
      proof_attachment_id=COALESCE(?,proof_attachment_id),
      proof_reference=COALESCE(?,proof_reference),
      proof_uploaded_by=?,proof_uploaded_at=datetime('now') WHERE id=?`,
    [attach.saved.length?attach.saved[0].id:null,reference||null,user.email,settlementId]);
  // The proof may be what was holding the request out of paid.
  await applySettlementStatus(c,row);
  // And the trail the RFP screen already reads.
  await run(c.env.DB,`INSERT INTO erp_rfp_proof_of_payment(rfp_ref,reference,paid_at,actor)
    VALUES(?,?,?,?)`,[row.request_no,reference||(attach.saved[0]||{}).file_name||'',
    settlement.paid_date||new Date().toISOString().slice(0,10),user.email]);
  await audit(c,{action:'PROOF',module:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordId:id,recordNo:row.request_no,after:{settlementId,reference,files:attach.saved.length}});
  const after=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  return ok(c,{request:after,...await settlementSummary(c.env.DB,row.request_no,row.net_payable),
    attachments:attach.saved,attachmentErrors:attach.failed});
});

// A payment recorded in error. Voided, never deleted, and the request falls
// back to whatever the remaining settlements say it is.
financeRoutes.post('/payment-requests/:id/settlements/:settlementId/void',
  requirePermission('FINANCE','EDIT'), async c=>{
  const id=Number(c.req.param('id'));
  const settlementId=Number(c.req.param('settlementId'));
  const user=c.get('erpUser');
  if(!canSettle(user))return fail(c,'Only Finance voids a recorded payment.',403);
  const row=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  if(!row)return fail(c,'Payment request not found.',404);
  const b=await jsonBody(c);
  const reason=normalizeText(b.reason);
  if(!reason)return fail(c,'Say why this payment is being voided.');
  const settlement=await first(c.env.DB,`SELECT * FROM erp_payment_settlements WHERE id=? AND request_no=?`,
    [settlementId,row.request_no]);
  if(!settlement)return fail(c,'That payment is not on this request.',404);
  if(String(settlement.status||'').toUpperCase()==='VOID')return fail(c,'That payment is already void.',409);
  await run(c.env.DB,`UPDATE erp_payment_settlements SET status='VOID',voided_by=?,
    voided_at=datetime('now'),void_reason=? WHERE id=?`,[user.email,reason,settlementId]);
  await applySettlementStatus(c,row);
  await audit(c,{action:'VOID',module:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordId:id,recordNo:row.request_no,before:settlement,after:{reason}});
  const after=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  return ok(c,{request:after,...await settlementSummary(c.env.DB,row.request_no,row.net_payable)});
});

/* =====================================================================
 * Business lines, and who hosts a station
 *
 * Where a cost belongs is a judgement Finance makes, so it is held as
 * data and edited here rather than written into a query. The host list
 * is the sharp end of that: a vendor either has a station standing in
 * its premises or does not, and no amount of reading spreadsheet
 * descriptions will tell you which.
 * ===================================================================== */

/** One spelling of a name, so a vendor cannot appear twice in its own chart. */
const payeeKey = v => String(v||'').toUpperCase().replace(/[.,]/g,'').replace(/\s+/g,' ').trim();

financeRoutes.get('/business-lines', requirePermission('FINANCE','VIEW'), async c=>{
  const lines=await all(c.env.DB,`SELECT * FROM erp_business_lines WHERE active=1 ORDER BY sort_order,line_code`);
  const rules=await all(c.env.DB,`SELECT * FROM erp_business_line_rules ORDER BY line_code,priority,match_type,match_value`);
  /*
   * Every vendor that bills rent, a lease or a utility, with what it has cost
   * and how many requests it came on. This is the list Finance ticks: it is
   * the population a station host can possibly be drawn from, and the spend
   * beside each name is what makes the choice obvious.
   */
  const candidates=await all(c.env.DB,`SELECT
      TRIM(REPLACE(REPLACE(REPLACE(UPPER(TRIM(COALESCE(r.payee_name,''))),'.',''),',',''),'  ',' ')) payee_key,
      MIN(r.payee_name) payee_name,
      COUNT(DISTINCT r.request_no) requests,
      ROUND(SUM(l.gross_amount),2) amount,
      ROUND(AVG(l.gross_amount),2) average,
      MIN(r.department) department
    FROM erp_payment_request_lines l
    JOIN erp_payment_requests r ON r.request_no=l.rfp_ref
    WHERE r.status NOT IN ('REJECTED','CANCELLED')
      AND (UPPER(COALESCE(l.account_title,'')) LIKE '%RENT%'
        OR UPPER(COALESCE(l.account_title,'')) LIKE '%LEASE%'
        OR UPPER(COALESCE(l.account_title,'')) LIKE '%UTILIT%')
      AND COALESCE(r.payee_name,'')<>''
    GROUP BY payee_key ORDER BY amount DESC`);
  const chosen=new Set(rules.filter(r=>r.match_type==='PAYEE'&&r.line_code==='BSS')
    .map(r=>payeeKey(r.match_value)));
  return ok(c,{lines,rules,
    hosts:candidates.map(v=>({...v,chosen:chosen.has(v.payee_key)})),
    canEdit:canSettle(c.get('erpUser'))});
});

/*
 * Replace the host list wholesale. Wholesale because a half-applied edit is
 * how a vendor ends up counted in one screen and not the other, and because
 * "these are the hosts" is one decision rather than a series of them.
 */
financeRoutes.put('/business-lines/BSS/hosts', requirePermission('FINANCE','EDIT'), async c=>{
  const user=c.get('erpUser');
  if(!canSettle(user))return fail(c,'Only Finance decides which vendors host a station.',403);
  const b=await jsonBody(c);
  const wanted=[...new Set((Array.isArray(b.hosts)?b.hosts:[])
    .map(v=>payeeKey(typeof v==='string'?v:(v&&(v.payee_key||v.payee_name))))
    .filter(Boolean))];
  const before=await all(c.env.DB,`SELECT match_value FROM erp_business_line_rules
    WHERE line_code='BSS' AND match_type='PAYEE'`);
  await run(c.env.DB,`DELETE FROM erp_business_line_rules WHERE line_code='BSS' AND match_type='PAYEE'`);
  for(const v of wanted){
    await run(c.env.DB,`INSERT OR REPLACE INTO erp_business_line_rules
      (line_code,match_type,match_value,priority,note) VALUES('BSS','PAYEE',?,15,?)`,
      [v,`Chosen by ${user.email}.`]);
  }
  await audit(c,{action:'EDIT',module:'FINANCE',recordType:'BUSINESS_LINE',recordNo:'BSS',
    before:{hosts:before.map(r=>r.match_value)},after:{hosts:wanted}});
  return ok(c,{hosts:wanted});
});

/*
 * Correcting the department a cost was filed under.
 *
 * The station rents paid to Alfamart came into the register under Admin. They
 * are RideBox costs: the station stands in the shop and the shop is paid rent
 * for it. Nothing about that is a payment error, it is a filing error, and
 * putting the filing straight is exactly what a Finance checker does.
 *
 * So this is open to the checker as well as to Finance proper, and it works at
 * any status: a request approved and paid six months ago can still have been
 * filed under the wrong department, and refusing to correct it would leave the
 * business line wrong forever.
 *
 * What it will not do is touch a figure. Department, cost centre and project
 * are a classification; the amount, the payee and the evidence are not.
 */
async function reclassify(c, rows, want, reason){
  const user=c.get('erpUser');
  const changed=[];
  for(const row of rows){
    const before={department:row.department,cost_center:row.cost_center,project_code:row.project_code};
    const after={
      department:want.department!=null?want.department:row.department,
      cost_center:want.costCenter!=null?want.costCenter:row.cost_center,
      project_code:want.projectCode!=null?want.projectCode:row.project_code,
    };
    if(after.department===before.department&&after.cost_center===before.cost_center
      &&after.project_code===before.project_code)continue;
    await run(c.env.DB,`UPDATE erp_payment_requests SET department=?,cost_center=?,project_code=?,
      updated_at=datetime('now') WHERE id=?`,
      [after.department,after.cost_center,after.project_code,row.id]);
    // The lines carry the department too, and a chart that reads the lines
    // would otherwise disagree with one that reads the header.
    await run(c.env.DB,`UPDATE erp_payment_request_lines SET department=?,cost_center=?
      WHERE rfp_ref=?`,[after.department,after.cost_center,row.request_no]);
    await run(c.env.DB,`INSERT INTO erp_rfp_approvals(rfp_ref,stage,decision,actor,actor_name,reason,amount)
      VALUES(?,?,?,?,?,?,?)`,[row.request_no,'RECLASSIFY','CORRECTED',user.email,
      user.display_name||user.email,
      `${before.department||'(none)'} -> ${after.department||'(none)'}${reason?': '+reason:''}`,
      row.net_payable]);
    changed.push({requestNo:row.request_no,from:before.department,to:after.department});
  }
  await audit(c,{action:'RECLASSIFY',module:'FINANCE',recordType:'PAYMENT_REQUEST',
    recordNo:changed.map(x=>x.requestNo).slice(0,20).join(', '),
    before:{n:rows.length},after:{changed:changed.length,department:want.department,reason}});
  return changed;
}

// One request.
financeRoutes.patch('/payment-requests/:id/classification', requirePermission('FINANCE','EDIT'), async c=>{
  const user=c.get('erpUser');
  if(!canReclassify(user))return fail(c,'Only Finance corrects how a cost is filed.',403);
  const id=Number(c.req.param('id'));
  const row=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
  if(!row)return fail(c,'Payment request not found.',404);
  const b=await jsonBody(c);
  if(!normalizeText(b.department)&&b.costCenter==null&&b.projectCode==null)
    return fail(c,'Give a department, a cost centre or a project to move it to.');
  const changed=await reclassify(c,[row],{
    department:normalizeText(b.department)||null,
    costCenter:b.costCenter==null?null:normalizeText(b.costCenter),
    projectCode:b.projectCode==null?null:normalizeText(b.projectCode),
  },normalizeText(b.reason));
  return ok(c,{changed});
});

/*
 * Every request for one payee at once.
 *
 * Ten Alfamart requests were all filed the same wrong way, and correcting them
 * one at a time is how nine of them get corrected and the tenth does not.
 */
financeRoutes.post('/payees/reclassify', requirePermission('FINANCE','EDIT'), async c=>{
  const user=c.get('erpUser');
  if(!canReclassify(user))return fail(c,'Only Finance corrects how a cost is filed.',403);
  const b=await jsonBody(c);
  const key=payeeKey(b.payee||b.payeeKey);
  const department=normalizeText(b.department);
  if(!key)return fail(c,'Name the payee whose requests are being moved.');
  if(!department)return fail(c,'Name the department they belong to.');
  const rows=await all(c.env.DB,`SELECT r.* FROM erp_payment_requests r
    JOIN v_payee_normalised p ON p.request_no=r.request_no
    WHERE p.payee_key=? AND r.status NOT IN ('REJECTED','CANCELLED')`,[key]);
  if(!rows.length)return fail(c,'No request is on record for that payee.',404);
  const changed=await reclassify(c,rows,{
    department,
    costCenter:b.costCenter==null?null:normalizeText(b.costCenter),
    projectCode:null,
  },normalizeText(b.reason));
  return ok(c,{payee:key,department,requests:rows.length,changed});
});

// Who to email at each stage. Roles are resolved from erp_users so no addresses
// are hard-coded; APP_ADMIN_EMAIL is the safety net.
async function roleEmails(db,env,roles,department){
  const list=[];
  for(const role of roles){
    const rows=await all(db,`SELECT email FROM erp_users WHERE active=1 AND upper(role_code)=? AND (?='' OR department=? OR ?='ANY')`,
      [String(role).toUpperCase(),department||'',department||'',department?'':'ANY']);
    rows.forEach(r=>{if(r.email)list.push(String(r.email).toLowerCase());});
  }
  if(!list.length&&env.APP_ADMIN_EMAIL)list.push(String(env.APP_ADMIN_EMAIL).toLowerCase());
  return [...new Set(list)];
}

const rfpMoney=(v,cur)=>`${cur||'PHP'} ${Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2})}`;

async function notifyRfp(c,request,{to,cc,title,subject,intro,extraFacts,footer}){
  const recipients=(to||[]).filter(Boolean);
  if(!recipients.length)return {ok:false,skipped:true};
  const attachments=await attachmentsFor(c.env.DB,'PAYMENT_REQUEST',request.id,request.request_no);
  const facts=[['RFP',request.request_no],['Requestor',request.requestor_email],
    ['Department',request.department],['Payee',request.payee_name],
    ['Purpose',request.purpose],['Net payable',rfpMoney(request.net_payable)],
    ['Status',String(request.status||'').replace(/_/g,' ')]].concat(extraFacts||[]);
  const origin=new URL(c.req.url).origin;
  return await sendMailQuiet(c.env,{
    to:recipients,cc:(cc||[]).filter(Boolean),
    subject,
    html:mailLayout(title,
      `<p>${intro}</p>`+mailFacts(facts)+mailAttachments(attachments)
      +`<p style="margin-top:16px"><a href="${origin}/" style="color:#1669a7">Open Payables Management in Blitz - ERP</a></p>`,
      footer||'Request for payment workflow'),
  });
}

financeRoutes.post('/payment-requests/:id/action', requirePermission('FINANCE','EDIT'), async c=>{
  const id=Number(c.req.param('id'));const b=await jsonBody(c);
  const action=normalizeText(b.action).toUpperCase();const user=c.get('erpUser').email;
  // Row-level privacy applies to acting on a request, not only to listing them:
  // without this a requestor could act on someone else's RFP by guessing the id.
  const vis=await rfpVisibility(c);
  const request=await first(c.env.DB,`SELECT r.*,e.entity_code FROM erp_payment_requests r
    JOIN erp_legal_entities e ON e.id=r.entity_id WHERE r.id=?${vis.where}`,[id,...vis.args]);
  if(!request)return fail(c,'Payment request not found.',404);
  // Only the requestor (or Finance) puts a request into the chain.
  if(action==='SUBMIT'&&request.requestor_email!==user
     &&!['FINANCE','CEO','ADMIN','SUPER_ADMIN'].includes(String(c.get('erpUser').role_code||'').toUpperCase())){
    return fail(c,'Only the requestor can submit this request for payment.',403);
  }
  // Does this amount need the MANCOM tier? (spec section 4)
  const min=await mancomMin(c.env.DB);
  const mancomRequired=Number(request.net_payable||0)>=min;
  try{
    const permission=await permissionFor(c.env.DB,c.get('erpUser'),'FINANCE');
    // FINANCE_REVIEW is a check, not an approval: the whole point of the role is
    // that it carries no approval rights, so gating it on can_approve would make
    // the step impossible for the only people meant to perform it.
    if(Object.keys(ACTION_STAGE).includes(action)&&action!=='FINANCE_REVIEW'&&!permission.can_approve){
      return fail(c,'Approval permission is required.',403);
    }
    if(action==='FINANCE_REVIEW'&&!permission.can_edit){
      return fail(c,'Finance review permission is required.',403);
    }
    if(action==='MARK_PAID'&&!permission.can_post)return fail(c,'Posting permission is required.',403);

    // ---- spec section 5, enforced before anything is written -------------
    // e-signature mandatory, separation of duties, role gate, no double sign.
    if(ACTION_STAGE[action]){
      const stage=ACTION_STAGE[action];
      const trail=await all(c.env.DB,`SELECT stage,decision,actor FROM erp_rfp_approvals WHERE rfp_ref=?`,
        [request.request_no]);
      // An appointed department head satisfies the DEPARTMENT stage for their own
      // department whatever role code they carry - which is how the head of
      // Finance signs as a department head rather than as Finance.
      const headOfThis=stage==='DEPARTMENT'
        && (await departmentHeadEmail(c.env.DB,request.department))===String(user).toLowerCase();
      const refusal=checkApproval({
        stage,actorEmail:user,
        actorRole:headOfThis?'DEPT_HEAD':String(c.get('erpUser').role_code||'').toUpperCase(),
        submittedBy:request.requestor_email,amount:request.net_payable,min,
        signature:b.signature,trail,
        requireSignature:await rfpFlag(c.env.DB,'rfp_require_signature','1'),
        enforceRoleGate:await rfpFlag(c.env.DB,'rfp_role_gate','0'),
        enforceSod:await rfpFlag(c.env.DB,'rfp_separation_of_duties','1'),
      });
      if(refusal)return fail(c,refusal.msg,refusal.code);
    }

    if(action==='SUBMIT'){
      // A returned request goes back to the requestor and is resubmitted from here.
      if(!['DRAFT','RETURNED'].includes(request.status))throw new Error('Only a draft or returned request can be submitted.');
      /*
       * The paperwork is part of the request, and this is the moment it stops
       * being a draft and starts asking somebody to sign.
       *
       * The browser already refused, but a control that exists only in the
       * browser is not a control: anything posting to this endpoint walked
       * straight past it. Checked here rather than at creation, because a
       * request raised automatically from a completed purchase order is a
       * draft with nothing attached yet, and blocking that would break the
       * auto-raise the PO chain depends on.
       */
      if(await rfpFlag(c.env.DB,'rfp_require_document','0')){
        const files=await first(c.env.DB,`SELECT COUNT(*) n FROM erp_attachments
           WHERE record_type='PAYMENT_REQUEST' AND record_id=? AND active=1`,[id]).catch(()=>null);
        if(!Number(files?.n||0))
          throw new Error('Attach the billing, invoice or supporting document before submitting '
            +'this request for payment.');
      }
      await run(c.env.DB,`UPDATE erp_payment_requests SET status='SUBMITTED',updated_at=datetime('now') WHERE id=?`,[id]);
    }else if(action==='DEPARTMENT_APPROVE'){
      if(request.status!=='SUBMITTED')throw new Error('Request is not awaiting department approval.');
      if(request.requestor_email===user)throw new Error('The requester cannot approve the same request.');
      await run(c.env.DB,`UPDATE erp_payment_requests SET status='DEPARTMENT_APPROVED',
        department_approved_by=?,department_approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,[user,id]);
    }else if(action==='FINANCE_REVIEW'){
      // Finance checks the requestor's paperwork and the department head's
      // approval, then passes it to the head of Finance. A check, not an approval.
      if(!(await financeReviewOn(c.env.DB)))throw new Error('The Finance review step is switched off.');
      /*
       * The check is the checker's.
       *
       * Without this, the head of Finance could sign the check and then sign her
       * own approval on the same request, because FINANCE satisfied both stages
       * and the separation-of-duties rule lets an Admin sign twice. The split
       * was on the screen and not in the rules.
       *
       * Enforced here rather than through the global role gate on purpose: that
       * gate covers every stage, and switching it on locks out any department
       * head who is neither appointed nor holding an alias role.
       *
       * The Admin override survives, so a payment is never stuck while Rucel is
       * on leave, and it is written to the trail like any other signature.
       */
      if(await rfpFlag(c.env.DB,'rfp_review_role_only','1')){
        const r=String(c.get('erpUser').role_code||'').toUpperCase();
        if(!['FINANCE_REVIEWER'].includes(r)&&!isAdminRole(r))
          throw new Error('The Finance check belongs to the Finance Reviewer. '
            +'It has to be signed by whoever checks the paperwork, not by the approver.');
      }
      if(request.status!=='DEPARTMENT_APPROVED')throw new Error('Department approval is required first.');
      await run(c.env.DB,`UPDATE erp_payment_requests SET status='FINANCE_REVIEWED',updated_at=datetime('now') WHERE id=?`,[id]);
    }else if(action==='FINANCE_VALIDATE'){
      const reviewNeeded=await financeReviewOn(c.env.DB);
      if(reviewNeeded){
        if(request.status!=='FINANCE_REVIEWED')
          throw new Error('Finance has not checked this request yet. It must pass Finance review before the head of Finance approves it.');
      }else if(request.status!=='DEPARTMENT_APPROVED'){
        throw new Error('Department approval is required first.');
      }
      await run(c.env.DB,`UPDATE erp_payment_requests SET status='FINANCE_VALIDATED',
        finance_validated_by=?,finance_validated_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,[user,id]);
    }else if(action==='MANCOM_APPROVE'){
      // Spec section 4: this tier exists only at or above the threshold.
      if(!Number.isFinite(min))throw new Error('The MANCOM stage is switched off. High-value spend is agreed in the MANCOM meeting before it is recorded here.');
      if(!mancomRequired)throw new Error(`MANCOM approval only applies to requests of PHP ${min.toLocaleString('en-US')} or more.`);
      if(request.status!=='FINANCE_VALIDATED')throw new Error('Finance validation is required first.');
      await run(c.env.DB,`UPDATE erp_payment_requests SET status='MANCOM_APPROVED',updated_at=datetime('now') WHERE id=?`,[id]);
    }else if(action==='FINAL_APPROVE'){
      if(mancomRequired){
        if(request.status!=='MANCOM_APPROVED')
          throw new Error(`This request is PHP ${Number(request.net_payable).toLocaleString('en-US')} and needs MANCOM approval before final approval.`);
      }else if(request.status!=='FINANCE_VALIDATED'){
        throw new Error('Finance validation is required first.');
      }
      if(request.requestor_email===user||request.finance_validated_by===user){
        throw new Error('Final approval must be performed by a different authorized user.');
      }
      let billId=request.supplier_bill_id;
      const advanceRequest=/ADVANCE|PREPAYMENT/.test(normalizeText(request.request_type).toUpperCase());
      if(!advanceRequest&&!normalizeText(request.supplier_invoice_no)){
        throw new Error('Supplier invoice number is required before final approval.');
      }
      if(normalizeText(request.supplier_invoice_no)){
        const duplicate=await first(c.env.DB,`SELECT id,request_no FROM erp_payment_requests
          WHERE id<>? AND payee_partner_id=? AND supplier_invoice_no=?
            AND status NOT IN ('REJECTED','CANCELLED','REVERSED') LIMIT 1`,[
          id,request.payee_partner_id,normalizeText(request.supplier_invoice_no),
        ]);
        if(duplicate)throw new Error(`Supplier invoice is already recorded in ${duplicate.request_no}.`);
      }
      let debitAccount=normalizeText(b.accountCode)||'6990';
      if(request.landed_cost_id)debitAccount='2060';
      else if(request.purchase_order_id){
        if(advanceRequest)debitAccount='1250';
        else{
          const received=await first(c.env.DB,`SELECT COUNT(*) n FROM erp_receipts r
            JOIN erp_shipments s ON s.id=r.shipment_id
            JOIN erp_purchase_orders p ON p.purchase_order_no=s.purchase_order_ref
            WHERE p.id=?`,[request.purchase_order_id]);
          if(Number(received?.n||0)===0)throw new Error('Goods receipt is required before clearing the supplier invoice against GRNI. Use an advance request for prepayment.');
          debitAccount='2050';
        }
      }
      if(!billId&&request.payee_partner_id){
        const bill=await createSubledgerDocument(c.env.DB,{
          entityCode:request.entity_code,documentType:'SUPPLIER_BILL',partnerId:request.payee_partner_id,
          documentDate:request.invoice_date||request.request_date,dueDate:request.due_date,
          grossAmount:request.gross_amount,netAmount:round(request.gross_amount-request.vat_amount),
          taxAmount:request.vat_amount,withholdingAmount:request.withholding_amount,
          department:request.department,costCenter:request.cost_center,businessLine:'',
          sourceType:'PAYMENT_REQUEST',sourceId:id,sourceNo:request.request_no,
        },user);
        billId=bill.id;
        await postSubledgerDocument(c.env.DB,bill.id,{accountCode:debitAccount},user);
      }
      await run(c.env.DB,`UPDATE erp_payment_requests SET status='APPROVED',
        final_approved_by=?,final_approved_at=datetime('now'),supplier_bill_id=?,
        updated_at=datetime('now') WHERE id=?`,[user,billId||null,id]);
    }else if(action==='DISPATCH_MNC'){
      /*
       * Finance sends the fully signed RFP to Monde Nissin.
       *
       * This is the stage the old system calls MNC Dispatch, and it sits where
       * the old system puts it: after the CEO releases the request and before
       * anybody records a payment. Composing the mail is Finance's job, so the
       * gate is canSettle rather than can_approve - the CEO has already signed
       * and is not being asked to sign again.
       */
      if(!canSettle(c.get('erpUser')))throw new Error('Only Finance dispatches a request to Monde Nissin.');
      if(request.status!=='APPROVED')
        throw new Error('Only a fully approved request is dispatched. This one is '
          +String(request.status||'').replace(/_/g,' ').toLowerCase()+'.');
      const to=normalizeText(b.dispatchTo)||await rfpSetting(c.env.DB,'mnc_dispatch_to','');
      if(!to)throw new Error('Enter the Monde Nissin address to send this to. It is remembered for next time.');
      const cc=normalizeText(b.dispatchCc)||await rfpSetting(c.env.DB,'mnc_dispatch_cc','');
      const toList=to.split(/[,;]/).map(s=>s.trim()).filter(Boolean);
      const ccList=cc.split(/[,;]/).map(s=>s.trim()).filter(Boolean);
      const bad=toList.concat(ccList).find(a=>!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(a));
      if(bad)throw new Error(`"${bad}" is not a valid email address.`);
      const files=await attachmentsFor(c.env.DB,'PAYMENT_REQUEST',id,request.request_no);
      /*
       * A dispatch with nothing attached is an email saying a payment was
       * approved, which is not what MNC are being sent. The signed RFP and its
       * supporting documents are the point of the stage.
       */
      if(!files.length&&!b.force)
        throw new Error('This request has no documents attached, so there is nothing to dispatch. '
          +'Attach the signed RFP and its supporting papers first.');
      const note=normalizeText(b.message);
      /*
       * The signed form itself, which is the whole reason MNC are being written
       * to. Attachments carry the invoices and the quotations; none of them is
       * the request for payment with the four signatures on it, and that page
       * lives only inside Blitz. So the email carries a link to it.
       *
       * One token per request, reused on a re-dispatch, so re-sending does not
       * break the link already sitting in somebody's inbox.
       */
      let link=await first(c.env.DB,`SELECT * FROM erp_rfp_doc_tokens WHERE rfp_ref=? AND revoked=0`,
        [request.request_no]).catch(()=>null);
      if(!link){
        const token=(crypto.randomUUID()+crypto.randomUUID()).replace(/-/g,'');
        await run(c.env.DB,`INSERT INTO erp_rfp_doc_tokens(rfp_ref,token,created_by)
          VALUES(?,?,?)`,[request.request_no,token,user]);
        link={token};
      }
      const docUrl=`${new URL(c.req.url).origin}/rfp.html?t=${link.token}`;
      const subject=`[E88] Dispatch to MNC: ${request.request_no} (${request.payee_name||'payee'}) `
        +`- fully approved`;
      const mail=await notifyRfp(c,request,{to:toList,cc:ccList,
        title:'Fully approved request for payment',
        subject,
        intro:`This request has cleared the E88 approval chain and is released for payment.`
          +`<br><br><a href="${docUrl}" style="display:inline-block;background:#0a2239;color:#ffffff;`
          +`text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:bold">`
          +`Open the signed Request for Payment</a>`
          +`<br><span style="font-size:12px;color:#7a8194">Opens the signed form itself. `
          +`The supporting documents are linked below.</span>`
          +(note?`<br><br>${note.replace(/[<>]/g,'')}`:''),
        extraFacts:[['Approved by',request.final_approved_by||''],
          ['Approved on',String(request.final_approved_at||'').slice(0,10)]],
        footer:'Dispatched from Blitz - ERP by '+user});
      await run(c.env.DB,`INSERT INTO erp_rfp_dispatches
        (rfp_ref,payment_request_id,dispatched_to,dispatched_cc,subject,message,
         attachment_count,amount,dispatched_by,status,mail_result)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[
        request.request_no,id,toList.join(', '),ccList.join(', ')||null,subject,note||null,
        files.length,request.net_payable,user,
        (mail&&mail.ok===false&&!mail.skipped)?'FAILED':'SENT',
        JSON.stringify(mail||{}).slice(0,1000)]);
      // Remembered, so the next dispatch does not ask again. Same as setMncEmail().
      await run(c.env.DB,`INSERT INTO erp_rfp_settings(key,value) VALUES('mnc_dispatch_to',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[toList.join(', ')]);
      if(ccList.length){
        await run(c.env.DB,`INSERT INTO erp_rfp_settings(key,value) VALUES('mnc_dispatch_cc',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[ccList.join(', ')]);
      }
      await run(c.env.DB,`INSERT INTO erp_rfp_approvals(rfp_ref,stage,decision,actor,actor_name,reason,amount)
        VALUES(?,?,?,?,?,?,?)`,[request.request_no,'MNC_DISPATCH','DISPATCHED',user,
        c.get('erpUser').display_name||user,`Sent to ${toList.join(', ')}`,request.net_payable]);
      request.__dispatchedTo=toList.join(', ');
      request.__dispatchFiles=files.length;
    }else if(action==='MARK_PAID'){
      // Instructing the bank is a Finance act. FINANCE/EDIT alone is held by
      // department heads and by the requestor on their own request, which is
      // not who should be moving money.
      if(!canSettle(c.get('erpUser')))throw new Error('Only Finance prepares a payment.');
      if(request.status!=='APPROVED')throw new Error('Only an approved request can be paid.');
      // The old system has no payment stage before MNC Dispatch, so neither does
      // this one. Switch it off with rfp_require_dispatch if it ever gets in the way.
      const undispatched=await paymentBlockedBecause(c.env.DB,request);
      if(undispatched)throw new Error(undispatched);
      if(!b.bankAccountId||!normalizeText(b.paymentReference))throw new Error('Bank account and payment reference are required.');
      if(!request.payee_partner_id)throw new Error('A supplier master record is required before payment.');
      const supplierBill = request.supplier_bill_id ? await first(c.env.DB,
        `SELECT d.*,h.status journal_status FROM erp_subledger_documents d
          LEFT JOIN erp_journal_headers h ON h.id=d.journal_id WHERE d.id=?`,
        [request.supplier_bill_id]) : null;
      if (!supplierBill || supplierBill.journal_status !== 'POSTED') {
        throw new Error('Approve and post the supplier-bill journal before preparing payment.');
      }
      const bank=await first(c.env.DB,`SELECT b.*,a.account_code FROM erp_bank_accounts b
        JOIN erp_chart_accounts a ON a.id=b.gl_account_id WHERE b.id=?`,[Number(b.bankAccountId)]);
      if(!bank)throw new Error('Bank account not found.');
      const payment=await createSubledgerDocument(c.env.DB,{
        entityCode:request.entity_code,documentType:'SUPPLIER_PAYMENT',partnerId:request.payee_partner_id,
        documentDate:b.paymentDate||new Date().toISOString().slice(0,10),
        grossAmount:request.net_payable,netAmount:request.net_payable,taxAmount:0,withholdingAmount:0,
        department:request.department,costCenter:request.cost_center,sourceType:'PAYMENT_REQUEST',
        sourceId:id,sourceNo:request.request_no,
      },user);
      await postSubledgerDocument(c.env.DB,payment.id,{bankAccountCode:bank.account_code},user);
      await run(c.env.DB,`UPDATE erp_payment_requests SET status='PAYMENT_PREPARED',bank_account_id=?,
        payment_document_id=?,payment_reference=?,
        updated_at=datetime('now') WHERE id=?`,[
        bank.id,payment.id,normalizeText(b.paymentReference),id,
      ]);
    }else if(action==='CONFIRM_PAID'){
      if(!canSettle(c.get('erpUser')))throw new Error('Only Finance closes a payment.');
      if(request.status!=='PAYMENT_PREPARED')throw new Error('Payment journal has not been prepared.');
      const payment=await first(c.env.DB,
        `SELECT d.*,h.status journal_status FROM erp_subledger_documents d
          LEFT JOIN erp_journal_headers h ON h.id=d.journal_id WHERE d.id=?`,
        [request.payment_document_id]);
      if(!payment||payment.journal_status!=='POSTED'){
        throw new Error('Approve and post the supplier-payment journal before confirming payment.');
      }
      // Proof of payment goes to Drive and is linked on the record before closing.
      if(Array.isArray(b.attachments)&&b.attachments.length){
        await saveAttachments(c.env,c.env.DB,{moduleCode:'FINANCE',recordType:'PAYMENT_REQUEST',
          recordId:id,recordNo:request.request_no,files:b.attachments,uploadedBy:user});
      }
      // A request raised on or after the evidence cutoff cannot be closed on a
      // typed reference alone. Somebody has to show the bank advice.
      const proofFiles=Array.isArray(b.attachments)?b.attachments.length:0;
      const cutoff=await evidenceFrom(c.env.DB);
      if(String(request.request_date||'')>=String(cutoff)&&!proofFiles)
        throw new Error(`Attach the proof of payment. Requests raised from ${cutoff} are not `
          +`closed on a reference alone.`);
      await run(c.env.DB,`INSERT INTO erp_rfp_proof_of_payment(rfp_ref,reference,paid_at,actor)
        VALUES(?,?,datetime('now'),?)`,[request.request_no,normalizeText(b.proofReference),user]);
      /*
       * The payment itself, so this request reads the same way as one that was
       * settled in instalments: an amount that moved, on a date, with proof.
       */
      const proofAttachment=await first(c.env.DB,`SELECT id FROM erp_attachments
        WHERE record_type IN ('PAYMENT_PROOF','PAYMENT_REQUEST') AND record_no=? AND active=1
        ORDER BY id DESC LIMIT 1`,[request.request_no]);
      /*
       * The payment itself, for whatever is still owed rather than the whole
       * request: closing a request that was already part paid must not record
       * the full amount a second time.
       *
       * The key carries the moment, because a confirmation that was later
       * voided has to be able to happen again - a fixed key made the second
       * one a silent no-op that still flipped the request to paid.
       */
      const openBefore=await settlementSummary(c.env.DB,request.request_no,request.net_payable);
      if(openBefore.balance>0.01){
        await run(c.env.DB,`INSERT INTO erp_payment_settlements
          (request_no,payment_request_id,amount,paid_date,payment_reference,bank_account_id,
           proof_attachment_id,proof_reference,proof_uploaded_by,proof_uploaded_at,
           source,recorded_by,natural_key)
          VALUES(?,?,?,?,?,?,?,?,?,datetime('now'),'SYSTEM',?,?)`,[
          request.request_no,id,openBefore.balance,
          b.paymentDate||new Date().toISOString().slice(0,10),
          request.payment_reference||normalizeText(b.paymentReference)||null,
          request.bank_account_id||null,
          proofFiles?(proofAttachment?proofAttachment.id:null):null,
          normalizeText(b.proofReference)||null,user,user,
          `CONFIRM:${request.request_no}:${Date.now()}`,
        ]);
      }
      // Let the settlements decide the status rather than asserting it, so a
      // request can never stand as paid with nothing behind it.
      await applySettlementStatus(c,request);
      await run(c.env.DB,`UPDATE erp_payment_requests SET paid_by=COALESCE(paid_by,?),
        updated_at=datetime('now') WHERE id=?`,[user,id]);
    }else if(action==='RETURN'||action==='CANCEL'||action==='REJECT'){
      if(['PAID','REJECTED','CANCELLED'].includes(request.status))throw new Error('This request can no longer be returned.');
      // Spec section 6: the reason is mandatory and no signature is required.
      const reason=normalizeText(b.reason||b.notes);
      if(!reason)throw new Error('A reason is required. Pick a reason and add your remarks.');
      // RETURN sends it back to the requestor to correct and resubmit;
      // REJECT and CANCEL are terminal.
      const newStatus=action==='RETURN'?'RETURNED':action==='CANCEL'?'CANCELLED':'REJECTED';
      await run(c.env.DB,`UPDATE erp_payment_requests SET status=?,updated_at=datetime('now') WHERE id=?`,[newStatus,id]);
      await run(c.env.DB,`INSERT INTO erp_rfp_approvals(rfp_ref,stage,decision,actor,actor_name,reason,amount)
        VALUES(?,?,?,?,?,?,?)`,[request.request_no,String(request.status),'RETURNED',user,
        c.get('erpUser').display_name||user,reason,request.net_payable]);
      request.__returnReason=reason;
    }else return fail(c,'Unsupported payment-request action.');
    const after=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[id]);
    // ---- e-signature trail ---------------------------------------------
    // Draw or type: DRAW arrives as a PNG data URL, TYPE as the signer's name.
    if(normalizeText(b.signature)&&!['RETURN','CANCEL','REJECT'].includes(action)){
      const stageMap={SUBMIT:'REQUESTOR',DEPARTMENT_APPROVE:'DEPARTMENT',
        FINANCE_REVIEW:'FINANCE_REVIEW',FINANCE_VALIDATE:'FINANCE',
        MANCOM_APPROVE:'MANCOM',FINAL_APPROVE:'FINAL',MARK_PAID:'PAYMENT',CONFIRM_PAID:'PROOF'};
      await run(c.env.DB,`INSERT INTO erp_rfp_approvals(rfp_ref,stage,decision,actor,actor_name,reason,signature,amount)
        VALUES(?,?,?,?,?,?,?,?)`,[request.request_no,stageMap[action]||action,'APPROVED',user,
        c.get('erpUser').display_name||user,normalizeText(b.notes),
        String(b.signature).slice(0,300000),after.net_payable]);
    }

    // ---- notifications -------------------------------------------------
    const dept=after.department||'';
    const requestor=[after.requestor_email];
    // The appointed head of this department comes first; the role lookup is the
    // fallback for a department that has no head recorded yet.
    const namedHead=await departmentHeadEmail(c.env.DB,dept);
    const roleHeads=await roleEmails(c.env.DB,c.env,['DEPT_HEAD','DEPT_MANAGER','SCM_HEAD'],dept);
    const deptHeads=namedHead?[namedHead,...roleHeads.filter(e=>e!==namedHead)]:roleHeads;
    const finance=await roleEmails(c.env.DB,c.env,['FINANCE'],'');
    const financeReviewers=await roleEmails(c.env.DB,c.env,['FINANCE_REVIEWER'],'');
    const financeHead=await departmentHeadEmail(c.env.DB,'Finance and Accounting');
    const financeApprovers=financeHead?[financeHead]:finance;
    const ceo=await roleEmails(c.env.DB,c.env,['CEO'],'');
    const mancom=await roleEmails(c.env.DB,c.env,['MANCOM'],'');
    let notified=null;
    try{
      if(action==='SUBMIT'){
        notified=await notifyRfp(c,after,{to:normalizeText(b.departmentHeadEmail)?[normalizeText(b.departmentHeadEmail)]:deptHeads,cc:requestor,
          title:'Request for payment awaiting your approval',
          subject:`Approval needed: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
          intro:`${after.requestor_email} submitted a request for payment for your approval as Department Head. The supporting documents are linked below.`});
      }else if(action==='DEPARTMENT_APPROVE'){
        // Goes to whoever checks for Finance, not straight to the head of Finance.
        notified=await notifyRfp(c,after,{to:financeReviewers.length?financeReviewers:finance,cc:requestor,
          title:'Department approved - Finance check required',
          subject:`Finance check: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
          intro:`The Department Head approved this request. Finance now checks the supporting documents and the approval before it goes to the head of Finance.`});
      }else if(action==='FINANCE_REVIEW'){
        notified=await notifyRfp(c,after,{to:financeApprovers,cc:requestor,
          title:'Checked by Finance - your approval required',
          subject:`Finance approval: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
          intro:`${user} checked the requestor's documents and the department head's approval. It is now with you as head of Finance.`});
      }else if(action==='FINANCE_VALIDATE'){
        // Above the threshold the request goes to MANCOM first, not straight to the CEO.
        notified=mancomRequired
          ?await notifyRfp(c,after,{to:mancom.length?mancom:ceo,cc:[...finance,...requestor],
            title:'Finance validated - MANCOM approval required',
            subject:`MANCOM approval: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
            intro:`Finance validated this request. Because it is ${rfpMoney(after.net_payable)}, at or above the MANCOM threshold of ${rfpMoney(min)}, it needs MANCOM approval before it reaches the CEO.`,
            extraFacts:[['MANCOM threshold',rfpMoney(min)]]})
          :await notifyRfp(c,after,{to:ceo,cc:[...finance,...requestor],
            title:'Finance validated - CEO approval required',
            subject:`CEO approval: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
            intro:Number.isFinite(min)
              ?`Finance validated this request. It is below the MANCOM threshold of ${rfpMoney(min)}, so it now needs final CEO approval.`
              :`Finance validated this request. It now needs final CEO approval.`});
      }else if(action==='MANCOM_APPROVE'){
        notified=await notifyRfp(c,after,{to:ceo,cc:[...finance,...requestor],
          title:'MANCOM approved - CEO approval required',
          subject:`CEO approval: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
          intro:`MANCOM approved this request. It now needs final CEO approval.`});
      }else if(action==='FINAL_APPROVE'){
        notified=await notifyRfp(c,after,{to:finance,cc:[...requestor,...deptHeads],
          title:'CEO approved - dispatch to Monde Nissin',
          subject:`Approved, awaiting dispatch: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
          intro:`The CEO gave final approval with all documents signed. Finance: please dispatch the signed request and its attachments to Monde Nissin, then record the payment and upload the proof.`});
      }else if(action==='MARK_PAID'&&normalizeText(b.bankInstructionEmail)){
        notified=await notifyRfp(c,after,{to:[normalizeText(b.bankInstructionEmail)],cc:finance,
          title:'Payment instruction',
          subject:`Payment instruction: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
          intro:normalizeText(b.message)||`Please process the payment below in favour of ${after.payee_name}.`,
          extraFacts:[['Payment reference',after.payment_reference]]});
      }else if(action==='CONFIRM_PAID'){
        notified=await notifyRfp(c,after,{to:requestor,cc:[...deptHeads,...finance],
          title:'Payment completed',
          subject:`Paid: ${after.request_no} · ${rfpMoney(after.net_payable)}`,
          intro:`Payment has been released and the proof of payment is attached below.`,
          extraFacts:[['Payment reference',after.payment_reference],['Proof reference',normalizeText(b.proofReference)]]});
      }else if(['RETURN','CANCEL','REJECT'].includes(action)){
        const audience=[...new Set([...requestor,...deptHeads,...finance])];
        notified=await notifyRfp(c,after,{to:audience,
          title:'Request for payment returned',
          subject:`Returned: ${after.request_no}`,
          intro:`${user} returned this request for payment.`,
          extraFacts:[['Reason',request.__returnReason||normalizeText(b.reason)]]});
      }
    }catch(mailError){notified={ok:false,error:String(mailError)};}
    await audit(c,{action,module:'FINANCE',recordType:'PAYMENT_REQUEST',recordId:id,
      recordNo:request.request_no,before:request,after:{...after,notified}});
    return ok(c,{request:after,notified});
  }catch(error){return fail(c,error.message,409);}
});

financeRoutes.get('/lease-billing', requirePermission('FINANCE','VIEW'), async c=>{
  const contracts=await all(c.env.DB,`SELECT lc.*,p.partner_code,p.name customer_name,
    COUNT(u.id) linked_units,COALESCE(SUM(u.daily_rate_vat_ex),0) daily_contract_value
    FROM erp_lease_contracts lc LEFT JOIN erp_partners p ON p.id=lc.customer_id
    LEFT JOIN erp_lease_contract_units u ON u.lease_contract_id=lc.id
    WHERE lc.status NOT IN ('TERMINATED','EXPIRED','VOIDED','REVERSED')
    GROUP BY lc.id ORDER BY lc.end_of_term,lc.lease_no`);
  const billings=await all(c.env.DB,`SELECT d.*,p.name partner_name FROM erp_subledger_documents d
    JOIN erp_partners p ON p.id=d.partner_id WHERE d.document_type='LEASE_BILLING'
    ORDER BY d.document_date DESC,d.id DESC LIMIT 1000`);
  return ok(c,{contracts,billings});
});

financeRoutes.post('/lease-billing/generate', requirePermission('FINANCE','CREATE'), async c=>{
  const b=await jsonBody(c);const id=Number(b.leaseContractId);
  const lease=await first(c.env.DB,`SELECT lc.*,p.name partner_name FROM erp_lease_contracts lc
    JOIN erp_partners p ON p.id=lc.customer_id WHERE lc.id=?`,[id]);
  if(!lease)return fail(c,'Lease contract not found.',404);
  const periodStart=b.periodStart;const periodEnd=b.periodEnd;
  if(!periodStart||!periodEnd)return fail(c,'Billing start and end dates are required.');
  const start=new Date(`${periodStart}T00:00:00Z`);const end=new Date(`${periodEnd}T00:00:00Z`);
  const days=Math.floor((end-start)/86400000)+1;
  if(!Number.isFinite(days)||days<=0)return fail(c,'Billing period is invalid.');
  const units=await all(c.env.DB,`SELECT * FROM erp_lease_contract_units WHERE lease_contract_id=?
    AND status NOT IN ('RETURNED','TERMINATED')`,[id]);
  const daily=units.length?units.reduce((sum,row)=>sum+Number(row.daily_rate_vat_ex||lease.daily_rate_vat_ex||0),0):
    Number(lease.daily_rate_vat_ex||0)*Number(lease.unit_count||0);
  const net=round(daily*days);const vat=round(net*0.12);const gross=round(net+vat);
  if(gross<=0)return fail(c,'The lease has no billable daily rate or active units.');
  const duplicate=await first(c.env.DB,`SELECT * FROM erp_subledger_documents
    WHERE document_type='LEASE_BILLING' AND source_type='LEASE_CONTRACT' AND source_id=?
      AND document_date=? AND due_date=?`,[id,periodStart,periodEnd]);
  if(duplicate)return fail(c,`${duplicate.document_no} already covers this billing period.`,409);
  const document=await createSubledgerDocument(c.env.DB,{
    entityCode:b.entityCode||'E88',documentType:'LEASE_BILLING',partnerId:lease.customer_id,
    documentDate:periodStart,dueDate:b.dueDate||periodEnd,grossAmount:gross,netAmount:net,
    taxAmount:vat,withholdingAmount:0,businessLine:'LEASE',sourceType:'LEASE_CONTRACT',
    sourceId:id,sourceNo:lease.lease_no,
  },c.get('erpUser').email);
  await postSubledgerDocument(c.env.DB,document.id,{accountCode:'4010'},c.get('erpUser').email);
  return ok(c,{documentNo:document.document_no,days,units:units.length,net,vat,gross},201);
});

financeRoutes.get('/bank-accounts', requirePermission('FINANCE', 'VIEW'), async c => {
  const rows = await all(c.env.DB,
    `SELECT b.*,e.entity_code,a.account_code,a.account_name,
      COALESCE((SELECT SUM(CASE WHEN t.direction='CREDIT' THEN t.amount ELSE -t.amount END)
        FROM erp_bank_transactions t WHERE t.bank_account_id=b.id),0)+b.opening_balance statement_balance,
      (SELECT COUNT(*) FROM erp_bank_transactions t WHERE t.bank_account_id=b.id AND t.status='UNMATCHED') unmatched
      FROM erp_bank_accounts b JOIN erp_legal_entities e ON e.id=b.entity_id
      JOIN erp_chart_accounts a ON a.id=b.gl_account_id ORDER BY b.bank_name,b.account_name`);
  return ok(c, { rows });
});

financeRoutes.get('/bank-transactions', requirePermission('FINANCE','VIEW'), async c=>{
  const bankAccountId=Number(c.req.query('bankAccountId')||0);
  const status=normalizeText(c.req.query('status')).toUpperCase();
  const rows=await all(c.env.DB,`SELECT t.*,b.bank_account_code,b.bank_name,b.account_name,
    h.journal_no,a.account_code
    FROM erp_bank_transactions t JOIN erp_bank_accounts b ON b.id=t.bank_account_id
    LEFT JOIN erp_journal_lines l ON l.id=t.matched_journal_line_id
    LEFT JOIN erp_journal_headers h ON h.id=l.journal_id
    LEFT JOIN erp_chart_accounts a ON a.id=l.account_id
    WHERE (?=0 OR t.bank_account_id=?) AND (?='' OR t.status=?)
    ORDER BY t.transaction_date DESC,t.id DESC LIMIT 3000`,[
    bankAccountId,bankAccountId,status,status,
  ]);
  return ok(c,{rows});
});

financeRoutes.post('/bank-accounts', requirePermission('FINANCE', 'MANAGE'), async c => {
  const b = await jsonBody(c);
  const entity = await entityByCode(c.env.DB, b.entityCode || 'E88');
  const account = await first(c.env.DB, `SELECT * FROM erp_chart_accounts WHERE account_code=?`, [b.glAccountCode || '1010']);
  if (!entity || !account) return fail(c, 'Entity or bank GL account not found.');
  const code = normalizeText(b.bankAccountCode);
  if (!code || !b.bankName || !b.accountName) return fail(c, 'Bank code, bank name and account name are required.');
  const inserted = await run(c.env.DB,
    `INSERT INTO erp_bank_accounts(
      bank_account_code,entity_id,bank_name,account_name,account_number_masked,currency,
      gl_account_id,opening_balance
    ) VALUES(?,?,?,?,?,?,?,?)`,
    [code, entity.id, normalizeText(b.bankName), normalizeText(b.accountName),
      normalizeText(b.accountNumberMasked), b.currency || 'PHP', account.id, numberValue(b.openingBalance)]);
  const openingBalance = numberValue(b.openingBalance);
  let openingJournalId = null;
  if (openingBalance > 0) {
    const event = await captureFinanceEvent(c.env.DB, {
      eventKey:`BANK_OPENING_BALANCE:${inserted.meta.last_row_id}`,
      eventType:'OPENING_BANK_BALANCE',
      sourceModule:'TREASURY',
      sourceType:'BANK_ACCOUNT',
      sourceId:inserted.meta.last_row_id,
      sourceNo:code,
      eventDate:b.openingDate || new Date().toISOString().slice(0, 10),
      entityCode:entity.entity_code,
      amount:openingBalance,
      description:`Opening balance ${code} ${normalizeText(b.bankName)}`,
      payload:{ grossAmount:openingBalance, bankAccountCode:account.account_code },
    }, c.get('erpUser').email);
    if (event.status === 'ERROR') return fail(c, event.error_message, 409);
    openingJournalId = event.journal_id;
  }
  return ok(c, { created:true, openingJournalId }, 201);
});

financeRoutes.post('/bank-transactions', requirePermission('FINANCE', 'CREATE'), async c => {
  const b = await jsonBody(c);
  const rows = Array.isArray(b.rows) ? b.rows : [b];
  let imported = 0;
  for (const row of rows) {
    if (!row.bankAccountId || !row.transactionDate || !row.direction || numberValue(row.amount) <= 0) continue;
    await run(c.env.DB,
      `INSERT OR IGNORE INTO erp_bank_transactions(
        bank_account_id,transaction_date,value_date,bank_reference,description,direction,
        amount,running_balance,import_batch
      ) VALUES(?,?,?,?,?,?,?,?,?)`,
      [Number(row.bankAccountId), row.transactionDate, row.valueDate || '', normalizeText(row.bankReference),
        normalizeText(row.description), normalizeText(row.direction).toUpperCase(), numberValue(row.amount),
        row.runningBalance === undefined ? null : numberValue(row.runningBalance), normalizeText(b.importBatch)]);
    imported += 1;
  }
  return ok(c, { imported }, 201);
});

financeRoutes.post('/bank-transactions/:id/match', requirePermission('FINANCE', 'POST'), async c => {
  const id = Number(c.req.param('id')); const b = await jsonBody(c);
  const transaction = await first(c.env.DB,
    `SELECT t.*,b.gl_account_id FROM erp_bank_transactions t
      JOIN erp_bank_accounts b ON b.id=t.bank_account_id WHERE t.id=?`, [id]);
  const line = await first(c.env.DB,
    `SELECT l.*,h.status journal_status FROM erp_journal_lines l
      JOIN erp_journal_headers h ON h.id=l.journal_id
      WHERE l.id=?`, [Number(b.journalLineId)]);
  if (!transaction || !line) return fail(c, 'Bank transaction or journal line not found.', 404);
  if (transaction.status !== 'UNMATCHED') return fail(c, 'Only an unmatched bank transaction can be matched.', 409);
  if (line.journal_status !== 'POSTED' || Number(line.account_id) !== Number(transaction.gl_account_id)) {
    return fail(c, 'Match only to a posted journal line for the same bank GL account.', 409);
  }
  const existingMatch = await first(c.env.DB,
    `SELECT id FROM erp_bank_transactions WHERE matched_journal_line_id=? AND id<>?`, [line.id, id]);
  if (existingMatch) return fail(c, 'That journal line is already matched to another bank transaction.', 409);
  const lineAmount = Math.max(Number(line.base_debit || 0), Number(line.base_credit || 0));
  if (Math.abs(lineAmount - Number(transaction.amount || 0)) > 0.01) return fail(c, 'Bank amount does not match the journal line.', 409);
  await run(c.env.DB,
    `UPDATE erp_bank_transactions SET status='MATCHED',matched_journal_line_id=?,
      matched_by=?,matched_at=datetime('now') WHERE id=?`,
    [line.id, c.get('erpUser').email, id]);
  return ok(c, { matched:true });
});

financeRoutes.get('/bank-reconciliations', requirePermission('FINANCE', 'VIEW'), async c => {
  const rows = await all(c.env.DB,
    `SELECT r.*,b.bank_account_code,b.bank_name,b.account_name,e.entity_code
      FROM erp_bank_reconciliations r
      JOIN erp_bank_accounts b ON b.id=r.bank_account_id
      JOIN erp_legal_entities e ON e.id=b.entity_id
      ORDER BY r.statement_date DESC,r.id DESC LIMIT 1000`);
  return ok(c, { rows });
});

financeRoutes.post('/bank-reconciliations', requirePermission('FINANCE', 'CREATE'), async c => {
  const b = await jsonBody(c);
  const bank = await first(c.env.DB,
    `SELECT b.*,e.entity_code FROM erp_bank_accounts b
      JOIN erp_legal_entities e ON e.id=b.entity_id WHERE b.id=? AND b.active=1`,
    [Number(b.bankAccountId)]);
  if (!bank || !b.statementDate) return fail(c, 'Bank account and statement date are required.');
  const existing = await first(c.env.DB,
    `SELECT reconciliation_no FROM erp_bank_reconciliations
      WHERE bank_account_id=? AND statement_date=? AND status<>'REJECTED'`,
    [bank.id, b.statementDate]);
  if (existing) return fail(c, `${existing.reconciliation_no} already covers this statement date.`, 409);
  const book = await first(c.env.DB,
    `SELECT ?+COALESCE(SUM(l.base_debit-l.base_credit),0) balance
      FROM erp_journal_lines l
      JOIN erp_journal_headers h ON h.id=l.journal_id
      WHERE h.status='POSTED' AND h.entity_id=? AND h.journal_date<=? AND l.account_id=?`,
    [Number(bank.opening_balance || 0), bank.entity_id, b.statementDate, bank.gl_account_id]);
  const unmatched = await first(c.env.DB,
    `SELECT
      COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END),0) deposits,
      COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END),0) payments
      FROM erp_bank_transactions
      WHERE bank_account_id=? AND transaction_date<=? AND status='UNMATCHED'`,
    [bank.id, b.statementDate]);
  const statement = numberValue(b.statementEndingBalance);
  const bookBalance = round(Number(book?.balance || 0));
  const adjustments = numberValue(b.adjustments);
  const difference = round(statement - bookBalance - adjustments);
  const reconciliationNo = await nextCode(c.env.DB, 'BANK_RECON', 'BR', 8);
  const inserted = await run(c.env.DB,
    `INSERT INTO erp_bank_reconciliations(
      reconciliation_no,bank_account_id,statement_date,statement_ending_balance,
      book_ending_balance,outstanding_deposits,outstanding_payments,adjustments,difference,
      status,notes,prepared_by
    ) VALUES(?,?,?,?,?,?,?,?,?,'SUBMITTED',?,?)`,
    [reconciliationNo, bank.id, b.statementDate, statement, bookBalance,
      round(unmatched?.deposits), round(unmatched?.payments), adjustments, difference,
      normalizeText(b.notes), c.get('erpUser').email]);
  return ok(c, {
    id:inserted.meta.last_row_id, reconciliationNo, difference,
    status:'SUBMITTED',
  }, 201);
});

financeRoutes.post('/bank-reconciliations/:id/decision', requirePermission('FINANCE', 'APPROVE'), async c => {
  const id = Number(c.req.param('id')); const b = await jsonBody(c);
  const decision = normalizeText(b.decision).toUpperCase();
  const row = await first(c.env.DB, `SELECT * FROM erp_bank_reconciliations WHERE id=?`, [id]);
  if (!row) return fail(c, 'Bank reconciliation not found.', 404);
  if (row.status !== 'SUBMITTED') return fail(c, 'Only a submitted reconciliation can be decided.', 409);
  if (row.prepared_by === c.get('erpUser').email) return fail(c, 'The preparer cannot approve the same reconciliation.', 409);
  if (decision === 'APPROVE' && Math.abs(Number(row.difference || 0)) > 0.01) {
    return fail(c, 'Resolve the reconciliation difference before approval.', 409);
  }
  if (!['APPROVE','REJECT'].includes(decision)) return fail(c, 'Decision must be APPROVE or REJECT.');
  await run(c.env.DB,
    `UPDATE erp_bank_reconciliations
      SET status=?,approved_by=?,approved_at=datetime('now'),review_notes=?
      WHERE id=?`,
    [decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', c.get('erpUser').email,
      normalizeText(b.notes), id]);
  return ok(c, { status:decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' });
});

financeRoutes.get('/fixed-assets', requirePermission('FINANCE', 'VIEW'), async c => {
  const rows = await all(c.env.DB,
    `SELECT f.*,e.entity_code,a.asset_no,a.serial_no,a.item_code,a.item_name,a.category,
      a.current_location_code,a.current_status
      FROM erp_fixed_asset_books f JOIN erp_assets a ON a.id=f.asset_id
      JOIN erp_legal_entities e ON e.id=f.entity_id
      ORDER BY f.asset_class,a.item_name,a.serial_no`);
  const candidates = await all(c.env.DB,
    `SELECT a.* FROM erp_assets a WHERE a.active=1 AND a.current_status NOT IN ('SOLD','WRITTEN_OFF')
      AND NOT EXISTS(SELECT 1 FROM erp_fixed_asset_books f WHERE f.asset_id=a.id)
      ORDER BY a.category,a.item_name,a.serial_no LIMIT 5000`);
  const runs=await all(c.env.DB,`SELECT r.*,e.entity_code,p.period_name,h.journal_no
    FROM erp_depreciation_runs r JOIN erp_legal_entities e ON e.id=r.entity_id
    JOIN erp_accounting_periods p ON p.id=r.period_id
    LEFT JOIN erp_journal_headers h ON h.id=r.journal_id
    ORDER BY r.run_date DESC,r.id DESC LIMIT 500`);
  return ok(c, { rows, candidates, runs });
});

financeRoutes.post('/fixed-assets/capitalize', requirePermission('FINANCE', 'POST'), async c => {
  const b = await jsonBody(c);
  const entity = await entityByCode(c.env.DB, b.entityCode || 'E88');
  const asset = await first(c.env.DB, `SELECT * FROM erp_assets WHERE id=? AND active=1`, [Number(b.assetId)]);
  if (!entity || !asset) return fail(c, 'Entity or inventory asset not found.', 404);
  const existing=await first(c.env.DB,`SELECT * FROM erp_fixed_asset_books WHERE asset_id=? AND status<>'REVERSED'`,[asset.id]);
  if(existing)return fail(c,`Asset is already registered in fixed assets with status ${existing.status}.`,409);
  const cost = numberValue(b.acquisitionCost, asset.unit_cost);
  const life = Number(b.usefulLifeMonths || (asset.category==='BSS'?60:36));
  if (cost <= 0 || life <= 0) return fail(c, 'An approved cost and useful life are required before capitalization.');
  const classAccounts=fixedAssetAccountsForCategory(asset.category);
  const assetAccountCode = b.assetAccountCode || classAccounts.assetAccountCode;
  const date=b.capitalizationDate || new Date().toISOString().slice(0, 10);
  const event = await captureFinanceEvent(c.env.DB, {
    eventKey:`FIXED_ASSET_CAPITALIZATION:${asset.id}:${date}`,
    eventType:'CAPITALIZATION',sourceModule:'FIXED_ASSETS',sourceType:'ASSET',sourceId:asset.id,
    sourceNo:asset.asset_no,eventDate:date,entityCode:entity.entity_code,
    department:b.department || '',costCenter:b.costCenter || '',businessLine:b.businessLine || 'LEASE',
    amount:cost,description:`Capitalize ${asset.asset_no} / ${asset.serial_no}`,
    payload:{costAmount:cost,assetAccountCode,
      inventoryAccountCode:inventoryAccountForCategory(asset.category),
      assetId:asset.id,serialNo:asset.serial_no,itemId:asset.item_id,category:asset.category},
  }, c.get('erpUser').email);
  if (event.status === 'ERROR') return fail(c, event.error_message, 409);
  const book=await registerPendingFixedAsset(c.env.DB,{
    assetId:asset.id,entityCode:entity.entity_code,assetClass:b.assetClass||classAccounts.assetClass,
    capitalizationDate:date,acquisitionCost:cost,residualValue:numberValue(b.residualValue),
    usefulLifeMonths:life,depreciationMethod:b.depreciationMethod||'STRAIGHT_LINE',assetAccountCode,
    accumulatedDepreciationAccountCode:b.accumulatedDepreciationAccountCode||classAccounts.accumulatedDepreciationAccountCode,
    depreciationExpenseAccountCode:b.depreciationExpenseAccountCode||classAccounts.depreciationExpenseAccountCode,
    capitalizationEventId:event.id,capitalizationJournalId:event.journal_id,
  },c.get('erpUser').email);
  return ok(c,{capitalized:false,pendingApproval:true,bookId:book.id,journalId:event.journal_id},201);
});

financeRoutes.post('/depreciation-runs', requirePermission('FINANCE', 'CREATE'), async c => {
  const b = await jsonBody(c);
  const entity = await entityByCode(c.env.DB, b.entityCode || 'E88');
  if (!entity) return fail(c, 'Entity not found.', 404);
  const period = await ensureAccountingPeriod(c.env.DB, entity.id, b.runDate);
  if (period.status === 'CLOSED') return fail(c, 'The accounting period is closed.', 409);
  const existing = await first(c.env.DB, `SELECT * FROM erp_depreciation_runs WHERE entity_id=? AND period_id=?`, [entity.id, period.id]);
  if (existing) return fail(c, `${existing.run_no} already covers this period.`, 409);
  const assets = await all(c.env.DB,
    `SELECT * FROM erp_fixed_asset_books WHERE entity_id=? AND status='ACTIVE'
      AND capitalization_date<=? AND net_book_value>residual_value`, [entity.id, period.end_date]);
  const runNo = await nextCode(c.env.DB, 'DEPRECIATION_RUN', 'DEP', 8);
  const inserted = await run(c.env.DB,
    `INSERT INTO erp_depreciation_runs(run_no,entity_id,period_id,run_date,created_by)
      VALUES(?,?,?,?,?)`, [runNo, entity.id, period.id, b.runDate || period.end_date, c.get('erpUser').email]);
  let total = 0;
  for (const asset of assets) {
    const monthly = round((Number(asset.acquisition_cost) - Number(asset.residual_value)) / Number(asset.useful_life_months));
    const amount = Math.min(monthly, round(Number(asset.net_book_value) - Number(asset.residual_value)));
    if (amount <= 0) continue;
    total = round(total + amount);
    await run(c.env.DB,
      `INSERT INTO erp_depreciation_lines(
        depreciation_run_id,fixed_asset_book_id,asset_id,depreciation_amount,
        accumulated_after,net_book_value_after
      ) VALUES(?,?,?,?,?,?)`,
      [inserted.meta.last_row_id, asset.id, asset.asset_id, amount,
        round(Number(asset.accumulated_depreciation) + amount), round(Number(asset.net_book_value) - amount)]);
  }
  await run(c.env.DB, `UPDATE erp_depreciation_runs SET total_depreciation=? WHERE id=?`,
    [total, inserted.meta.last_row_id]);
  return ok(c, { id:inserted.meta.last_row_id, runNo, assets:assets.length, total }, 201);
});

financeRoutes.post('/depreciation-runs/:id/approve', requirePermission('FINANCE', 'APPROVE'), async c => {
  const id = Number(c.req.param('id'));
  const runHeader = await first(c.env.DB, `SELECT * FROM erp_depreciation_runs WHERE id=?`, [id]);
  if (!runHeader) return fail(c, 'Depreciation run not found.', 404);
  if (runHeader.status !== 'DRAFT') return fail(c, 'Only a draft run can be approved.', 409);
  if (runHeader.created_by === c.get('erpUser').email) return fail(c, 'The preparer cannot approve the same depreciation run.', 409);
  await run(c.env.DB,
    `UPDATE erp_depreciation_runs SET status='APPROVED',approved_by=?,approved_at=datetime('now') WHERE id=?`,
    [c.get('erpUser').email, id]);
  return ok(c, { status:'APPROVED' });
});

financeRoutes.post('/depreciation-runs/:id/post', requirePermission('FINANCE', 'POST'), async c => {
  const id = Number(c.req.param('id'));
  const header = await first(c.env.DB,
    `SELECT r.*,e.entity_code,p.end_date FROM erp_depreciation_runs r
      JOIN erp_legal_entities e ON e.id=r.entity_id
      JOIN erp_accounting_periods p ON p.id=r.period_id WHERE r.id=?`, [id]);
  if (!header) return fail(c, 'Depreciation run not found.', 404);
  if (header.status !== 'APPROVED') return fail(c, 'Only an approved run can be posted.', 409);
  const event = await captureFinanceEvent(c.env.DB, {
    eventKey:`DEPRECIATION:${id}`, eventType:'DEPRECIATION', sourceModule:'FINANCE',
    sourceType:'DEPRECIATION_RUN', sourceId:id, sourceNo:header.run_no, eventDate:header.end_date,
    entityCode:header.entity_code, amount:header.total_depreciation,
    description:`Depreciation ${header.run_no}`,
  }, c.get('erpUser').email);
  if (event.status === 'ERROR') return fail(c, event.error_message, 409);
  const journal = await first(c.env.DB, `SELECT * FROM erp_journal_headers WHERE id=?`, [event.journal_id]);
  await run(c.env.DB, `UPDATE erp_journal_headers SET status='APPROVED',approved_by=?,
    approved_at=datetime('now') WHERE id=?`, [header.approved_by, journal.id]);
  await postJournal(c.env.DB, journal.id, c.get('erpUser').email);
  const lines = await all(c.env.DB, `SELECT * FROM erp_depreciation_lines WHERE depreciation_run_id=?`, [id]);
  for (const line of lines) {
    await run(c.env.DB,
      `UPDATE erp_fixed_asset_books SET accumulated_depreciation=?,net_book_value=?,
        last_depreciation_date=? WHERE id=?`,
      [line.accumulated_after, line.net_book_value_after, header.end_date, line.fixed_asset_book_id]);
  }
  await run(c.env.DB,
    `UPDATE erp_depreciation_runs SET status='POSTED',journal_id=?,posted_by=?,
      posted_at=datetime('now') WHERE id=?`,
    [journal.id, c.get('erpUser').email, id]);
  return ok(c, { status:'POSTED', journalNo:journal.journal_no });
});

financeRoutes.get('/reports/general-ledger', requirePermission('FINANCE', 'VIEW'), async c => {
  const f = filters(c);
  const rows = await all(c.env.DB,
    `SELECT h.journal_no,h.journal_date,h.source_type,h.source_no,h.description,
      a.account_code,a.account_name,p.name partner_name,l.department,l.cost_center,l.business_line,
      l.description line_description,l.base_debit debit,l.base_credit credit,l.serial_no
      FROM erp_journal_headers h JOIN erp_legal_entities e ON e.id=h.entity_id
      JOIN erp_journal_lines l ON l.journal_id=h.id JOIN erp_chart_accounts a ON a.id=l.account_id
      LEFT JOIN erp_partners p ON p.id=l.partner_id
      WHERE h.status='POSTED' AND ${f.where.join(' AND ')}
      ORDER BY h.journal_date,h.journal_no,l.line_no`, f.args);
  return ok(c, { filters:f, rows });
});

/*
 * What actually governs a finance module.
 *
 * These screens used to be a list of sentences describing how the module was
 * supposed to work. A sentence is not a control: nobody can tell from it
 * whether the entities are set up, whether anything has been posted against a
 * dimension, or whether a budget exists for the year. So each one now answers
 * itself from the database, and every figure is a count of something real.
 */
financeRoutes.get('/module-setup/:code', requirePermission('FINANCE', 'VIEW'), async c => {
  const code = normalizeText(c.req.param('code'));
  const year = Number(normalizeText(c.req.query('year'))) || new Date().getFullYear();
  const out = { code, year, panels: [] };
  const panel = (title, columns, rows, note) => out.panels.push({ title, columns, rows, note });
  const attempt = async (fn) => { try { return await fn(); } catch { return []; } };

  const entities = await attempt(() => all(c.env.DB, `SELECT e.entity_code,e.entity_name,e.base_currency,
      (SELECT COUNT(*) FROM erp_journal_headers h WHERE h.entity_id=e.id AND h.status='POSTED') posted,
      (SELECT COUNT(*) FROM erp_accounting_periods p WHERE p.entity_id=e.id AND p.status='OPEN') openPeriods
    FROM erp_legal_entities e WHERE e.active=1 ORDER BY e.entity_code`));

  if (code === 'fa-management-accounting' || code === 'fa-consolidation-reporting') {
    panel('Legal entities', ['Entity', 'Name', 'Currency', 'Posted journals', 'Open periods'],
      entities.map(e => [e.entity_code, e.entity_name, e.base_currency, e.posted, e.openPeriods]),
      'Every entity that can be posted to, and how much has been.');
  }

  if (code === 'fa-management-accounting') {
    // A dimension is only real if something has been posted against it.
    for (const [label, column] of [['Department', 'department'], ['Cost centre', 'cost_center'], ['Business line', 'business_line']]) {
      const rows = await attempt(() => all(c.env.DB,
        `SELECT COALESCE(NULLIF(l.${column},''),'(not set)') label, COUNT(*) lines,
           ROUND(SUM(l.base_debit),2) debit, ROUND(SUM(l.base_credit),2) credit
         FROM erp_journal_lines l JOIN erp_journal_headers h ON h.id=l.journal_id AND h.status='POSTED'
         GROUP BY label ORDER BY lines DESC LIMIT 40`));
      panel(`${label}s carrying posted entries`, [label, 'Lines', 'Debit', 'Credit'],
        rows.map(r => [r.label, r.lines, r.debit, r.credit]),
        rows.some(r => r.label === '(not set)')
          ? 'Lines showing "(not set)" were posted without this dimension.' : '');
    }
  }

  if (code === 'fa-consolidation-reporting') {
    const rows = await attempt(() => all(c.env.DB,
      `SELECT e.entity_code label, p.period_name, p.status, p.start_date, p.end_date
       FROM erp_accounting_periods p JOIN erp_legal_entities e ON e.id=p.entity_id
       WHERE substr(p.start_date,1,4)=? ORDER BY e.entity_code, p.start_date`, [String(year)]));
    panel(`Period status, ${year}`, ['Entity', 'Period', 'Status', 'From', 'To'],
      rows.map(r => [r.label, r.period_name, r.status, r.start_date, r.end_date]),
      'Each entity closes on its own before the consolidated close.');
  }

  if (code === 'fa-financial-services') {
    const banks = await attempt(() => all(c.env.DB, `SELECT b.bank_account_code,b.bank_name,b.account_name,
        b.currency,a.account_code gl,
        (SELECT COUNT(*) FROM erp_bank_transactions t WHERE t.bank_account_id=b.id) movements,
        (SELECT COUNT(*) FROM erp_bank_transactions t WHERE t.bank_account_id=b.id AND t.status='UNMATCHED') unmatched,
        (SELECT running_balance FROM erp_bank_transactions t WHERE t.bank_account_id=b.id
          ORDER BY t.transaction_date DESC, t.id DESC LIMIT 1) balance
      FROM erp_bank_accounts b LEFT JOIN erp_chart_accounts a ON a.id=b.gl_account_id
      WHERE b.active=1 ORDER BY b.bank_account_code`));
    panel('Bank and wallet accounts', ['Account', 'Bank', 'Name', 'Currency', 'GL', 'Movements', 'Unmatched', 'Balance'],
      banks.map(b => [b.bank_account_code, b.bank_name, b.account_name, b.currency, b.gl || '-',
        b.movements, b.unmatched, b.balance == null ? 0 : b.balance]),
      'Each account maps to a control account in the chart of accounts.');
    const aliases = await attempt(() => all(c.env.DB,
      `SELECT alias, bank_account_code FROM erp_bank_aliases ORDER BY bank_account_code, alias`));
    panel('What the words on a receipt mean', ['Name used', 'Posts to'],
      aliases.map(a => [a.alias, a.bank_account_code]),
      'A collection naming a wallet posts to the account beside it here.');
  }

  if (code === 'fa-planning-budgeting') {
    const years = await attempt(() => all(c.env.DB, `SELECT year label, COUNT(*) lines,
        ROUND(SUM(amount),2) amount, COUNT(DISTINCT department) departments
      FROM erp_budget_plan GROUP BY year ORDER BY year DESC`));
    panel('Budget by year', ['Year', 'Lines', 'Departments', 'Amount'],
      years.map(y => [y.label, y.lines, y.departments, y.amount]),
      years.length ? '' : 'No budget has been loaded yet, so variance reporting has nothing to compare against.');
    const split = await attempt(() => all(c.env.DB, `SELECT COALESCE(NULLIF(capex_opex,''),'(not set)') label,
        ROUND(SUM(amount),2) amount, COUNT(*) lines FROM erp_budget_plan WHERE year=?
      GROUP BY label ORDER BY amount DESC`, [year]));
    panel(`Capital and operating, ${year}`, ['Class', 'Lines', 'Amount'],
      split.map(s => [s.label, s.lines, s.amount]));
    const depts = await attempt(() => all(c.env.DB, `SELECT COALESCE(NULLIF(department,''),'(not set)') label,
        ROUND(SUM(amount),2) amount FROM erp_budget_plan WHERE year=? GROUP BY label ORDER BY amount DESC LIMIT 30`, [year]));
    panel(`Budget by department, ${year}`, ['Department', 'Amount'], depts.map(d => [d.label, d.amount]));
  }

  if (code === 'fa-fixed-assets') {
    const classes = await attempt(() => all(c.env.DB, `SELECT COALESCE(NULLIF(category,''),'Unclassified') label,
        COUNT(*) units, ROUND(SUM(COALESCE(unit_cost,0)),2) cost,
        COUNT(CASE WHEN COALESCE(unit_cost,0)<=0 THEN 1 END) unvalued
      FROM erp_assets WHERE active=1 GROUP BY label ORDER BY cost DESC`));
    panel('Registered units by class', ['Class', 'Units', 'Cost', 'Without a cost'],
      classes.map(x => [x.label, x.units, x.cost, x.unvalued]),
      'A unit with no cost cannot be capitalised or depreciated.');
    const control = await attempt(() => all(c.env.DB, `SELECT account_code,account_name,control_type
      FROM erp_chart_accounts WHERE active=1 AND control_type IN ('FIXED_ASSET','INVENTORY')
      ORDER BY account_code`));
    panel('Asset and inventory control accounts', ['Code', 'Account', 'Control'],
      control.map(a => [a.account_code, a.account_name, a.control_type]));
  }

  if (code === 'fa-grants-funds' || code === 'ip-supplier-portal') {
    const partners = await attempt(() => all(c.env.DB, `SELECT partner_code,name,partner_type,credit_status,
        COALESCE(overdue_balance,0) overdue FROM erp_partners
      WHERE active=1 AND partner_type='VENDOR' ORDER BY name LIMIT 200`));
    panel('Accredited vendors', ['Code', 'Vendor', 'Type', 'Credit', 'Overdue'],
      partners.map(p => [p.partner_code, p.name, p.partner_type, p.credit_status, p.overdue]));
  }

  if (code === 'fa-receivables-payables') {
    const stages = await attempt(() => all(c.env.DB, `SELECT status label, COUNT(*) n,
        ROUND(SUM(net_payable),2) value FROM erp_payment_requests GROUP BY status ORDER BY n DESC`));
    panel('Requests by stage', ['Stage', 'Requests', 'Net payable'],
      stages.map(s => [String(s.label || '').replace(/_/g, ' '), s.n, s.value]));
    const settings = await attempt(() => all(c.env.DB, `SELECT key,value FROM erp_rfp_settings ORDER BY key`));
    panel('Approval controls', ['Setting', 'Value'],
      settings.filter(s => !String(s.key).startsWith('rfp_doc:')).map(s => [s.key, s.value]),
      'The chain is Requestor, Department Head, Finance check, Head of Finance, CEO.');
    const sla = await attempt(() => all(c.env.DB, `SELECT code,label,target_days,basis FROM erp_service_levels ORDER BY code`));
    panel('Service levels', ['Code', 'What is measured', 'Target', 'Basis'],
      sla.map(s => [s.code, s.label, s.target_days + ' days', s.basis]));
  }

  return ok(c, out);
});

/*
 * The chart of accounts with money against it.
 *
 * A chart of accounts on its own is a list of names; what people actually want
 * to know is what is sitting in each one and how it got there. Balances are
 * derived from posted journal lines rather than stored on the account, so a
 * balance can never drift from the entries that make it up - and every figure
 * on this screen opens the lines behind it.
 */
financeRoutes.get('/accounts/balances', requirePermission('FINANCE', 'VIEW'), async c => {
  const f = filters(c);
  const rows = await all(c.env.DB,
    `SELECT a.id,a.account_code,a.account_name,a.account_type,a.normal_balance,
       a.financial_statement,a.allow_manual_posting,
       ROUND(COALESCE(SUM(l.base_debit),0),2) debit,
       ROUND(COALESCE(SUM(l.base_credit),0),2) credit,
       COUNT(l.id) entries,
       ROUND(COALESCE(SUM(CASE WHEN a.normal_balance='DEBIT'
         THEN l.base_debit-l.base_credit ELSE l.base_credit-l.base_debit END),0),2) balance
     FROM erp_chart_accounts a
     LEFT JOIN erp_journal_lines l ON l.account_id=a.id
     LEFT JOIN erp_journal_headers h ON h.id=l.journal_id AND h.status='POSTED'
     LEFT JOIN erp_legal_entities e ON e.id=h.entity_id
     WHERE a.active=1 AND (h.id IS NULL OR (${f.where.join(' AND ')}))
     GROUP BY a.id ORDER BY a.account_code`, f.args);
  const byType = {};
  rows.forEach(r => {
    const k = r.account_type || 'OTHER';
    byType[k] = round((byType[k] || 0) + Number(r.balance || 0));
  });
  const totals = rows.reduce((out, r) => {
    out.debit = round(out.debit + Number(r.debit || 0));
    out.credit = round(out.credit + Number(r.credit || 0));
    return out;
  }, { debit: 0, credit: 0 });
  return ok(c, { filters: f, rows, totals,
    byType: Object.keys(byType).map(label => ({ label, value: byType[label] })),
    balanced: Math.abs(totals.debit - totals.credit) <= 0.005 });
});

// The entries behind one account, so a balance is never a number you have to take on trust.
financeRoutes.get('/accounts/:code/ledger', requirePermission('FINANCE', 'VIEW'), async c => {
  const code = normalizeText(c.req.param('code'));
  const f = filters(c);
  const account = await first(c.env.DB, `SELECT * FROM erp_chart_accounts WHERE account_code=?`, [code]);
  if (!account) return fail(c, 'Account not found.', 404);
  const rows = await all(c.env.DB,
    `SELECT h.journal_no,h.journal_date,h.journal_type,h.source_type,h.source_no,
       l.description,l.base_debit,l.base_credit,l.department,l.cost_center,l.business_line,h.id journal_id
     FROM erp_journal_lines l
     JOIN erp_journal_headers h ON h.id=l.journal_id AND h.status='POSTED'
     JOIN erp_legal_entities e ON e.id=h.entity_id
     WHERE l.account_id=? AND ${f.where.join(' AND ')}
     ORDER BY h.journal_date, h.id, l.id LIMIT 1000`, [account.id, ...f.args]);
  // A running balance is what makes a ledger readable rather than a list.
  let running = 0;
  const debitNormal = String(account.normal_balance) === 'DEBIT';
  const lines = rows.map(r => {
    running = round(running + (debitNormal
      ? Number(r.base_debit || 0) - Number(r.base_credit || 0)
      : Number(r.base_credit || 0) - Number(r.base_debit || 0)));
    return { ...r, running_balance: running };
  });
  return ok(c, { account, filters: f, rows: lines, closingBalance: running });
});

financeRoutes.get('/reports/trial-balance', requirePermission('FINANCE', 'VIEW'), async c => {
  const f = filters(c);
  const rows = await all(c.env.DB,
    `SELECT a.account_code,a.account_name,a.account_type,a.normal_balance,
      ROUND(COALESCE(SUM(l.base_debit),0),2) debit,
      ROUND(COALESCE(SUM(l.base_credit),0),2) credit,
      ROUND(COALESCE(SUM(CASE WHEN a.normal_balance='DEBIT'
        THEN l.base_debit-l.base_credit ELSE l.base_credit-l.base_debit END),0),2) balance
      FROM erp_chart_accounts a
      LEFT JOIN erp_journal_lines l ON l.account_id=a.id
      LEFT JOIN erp_journal_headers h ON h.id=l.journal_id AND h.status='POSTED'
      LEFT JOIN erp_legal_entities e ON e.id=h.entity_id
      WHERE a.active=1 AND (h.id IS NULL OR (${f.where.join(' AND ')}))
      GROUP BY a.id ORDER BY a.account_code`, f.args);
  const totals = rows.reduce((out, row) => {
    out.debit = round(out.debit + Number(row.debit || 0));
    out.credit = round(out.credit + Number(row.credit || 0));
    return out;
  }, { debit:0, credit:0 });
  return ok(c, { filters:f, rows, totals, balanced:Math.abs(totals.debit - totals.credit) <= 0.005 });
});

financeRoutes.get('/reports/financial-statements', requirePermission('FINANCE', 'VIEW'), async c => {
  const f = filters(c);
  const profitLossRows = await all(c.env.DB,
    `SELECT a.account_code,a.account_name,a.account_type,a.financial_statement,a.normal_balance,
      ROUND(COALESCE(SUM(CASE WHEN a.normal_balance='DEBIT'
        THEN l.base_debit-l.base_credit ELSE l.base_credit-l.base_debit END),0),2) balance
      FROM erp_chart_accounts a
      JOIN erp_journal_lines l ON l.account_id=a.id
      JOIN erp_journal_headers h ON h.id=l.journal_id
      JOIN erp_legal_entities e ON e.id=h.entity_id
      WHERE h.status='POSTED' AND a.account_type IN ('REVENUE','COGS','EXPENSE')
        AND ${f.where.join(' AND ')}
      GROUP BY a.id HAVING ABS(balance)>0.004 ORDER BY a.account_code`, f.args);
  const balanceWhere = ['e.entity_code=?', 'h.journal_date<=?'];
  const balanceArgs = [f.entity, f.dateTo];
  if (f.department) { balanceWhere.push('l.department=?'); balanceArgs.push(f.department); }
  if (f.costCenter) { balanceWhere.push('l.cost_center=?'); balanceArgs.push(f.costCenter); }
  if (f.businessLine) { balanceWhere.push('l.business_line=?'); balanceArgs.push(f.businessLine); }
  const balanceRows = await all(c.env.DB,
    `SELECT a.account_code,a.account_name,a.account_type,a.financial_statement,a.normal_balance,
      ROUND(COALESCE(SUM(CASE WHEN a.normal_balance='DEBIT'
        THEN l.base_debit-l.base_credit ELSE l.base_credit-l.base_debit END),0),2) balance
      FROM erp_chart_accounts a
      JOIN erp_journal_lines l ON l.account_id=a.id
      JOIN erp_journal_headers h ON h.id=l.journal_id
      JOIN erp_legal_entities e ON e.id=h.entity_id
      WHERE h.status='POSTED' AND ${balanceWhere.join(' AND ')}
      GROUP BY a.id HAVING ABS(balance)>0.004 ORDER BY a.account_code`, balanceArgs);
  const pnl = { revenue:0, cogs:0, operatingExpenses:0, netIncome:0 };
  const balanceSheet = { assets:0, liabilities:0, equity:0, currentYearEarnings:0, balanced:false };
  for (const row of profitLossRows) {
    const value = Number(row.balance || 0);
    if (row.account_type === 'REVENUE') pnl.revenue += value;
    else if (row.account_type === 'COGS') pnl.cogs += value;
    else if (row.account_type === 'EXPENSE') pnl.operatingExpenses += value;
  }
  let earningsToDate = 0;
  for (const row of balanceRows) {
    const value = Number(row.balance || 0);
    if (['ASSET','CONTRA_ASSET'].includes(row.account_type)) {
      balanceSheet.assets += row.account_type === 'CONTRA_ASSET' ? -value : value;
    } else if (row.account_type === 'LIABILITY') balanceSheet.liabilities += value;
    else if (row.account_type === 'EQUITY') balanceSheet.equity += value;
    else if (row.account_type === 'REVENUE') earningsToDate += value;
    else if (['COGS','EXPENSE'].includes(row.account_type)) earningsToDate -= value;
  }
  pnl.revenue = round(pnl.revenue); pnl.cogs = round(pnl.cogs);
  pnl.grossProfit = round(pnl.revenue - pnl.cogs);
  pnl.operatingExpenses = round(pnl.operatingExpenses);
  pnl.netIncome = round(pnl.grossProfit - pnl.operatingExpenses);
  balanceSheet.assets = round(balanceSheet.assets);
  balanceSheet.liabilities = round(balanceSheet.liabilities);
  balanceSheet.equity = round(balanceSheet.equity);
  balanceSheet.currentYearEarnings = round(earningsToDate);
  balanceSheet.totalLiabilitiesEquity = round(balanceSheet.liabilities + balanceSheet.equity + earningsToDate);
  balanceSheet.difference = round(balanceSheet.assets - balanceSheet.totalLiabilitiesEquity);
  balanceSheet.balanced = Math.abs(balanceSheet.difference) <= 0.01;
  const cashFlow = await all(c.env.DB,
    `SELECT COALESCE(a.cash_flow_group,'UNCLASSIFIED') cash_flow_group,
      ROUND(SUM(l.base_debit-l.base_credit),2) net_change
      FROM erp_journal_headers h JOIN erp_legal_entities e ON e.id=h.entity_id
      JOIN erp_journal_lines l ON l.journal_id=h.id JOIN erp_chart_accounts a ON a.id=l.account_id
      WHERE h.status='POSTED' AND a.control_type='BANK' AND ${f.where.join(' AND ')}
      GROUP BY a.cash_flow_group ORDER BY a.cash_flow_group`, f.args);
  return ok(c, { filters:f, accounts:profitLossRows, balanceAccounts:balanceRows, pnl, balanceSheet, cashFlow });
});

financeRoutes.get('/reports/tax-summary', requirePermission('FINANCE', 'VIEW'), async c => {
  const f = filters(c);
  const rows = await all(c.env.DB,
    `SELECT a.account_code,a.account_name,
      ROUND(SUM(l.base_debit),2) debit,ROUND(SUM(l.base_credit),2) credit,
      ROUND(SUM(l.base_debit-l.base_credit),2) net
      FROM erp_journal_headers h JOIN erp_legal_entities e ON e.id=h.entity_id
      JOIN erp_journal_lines l ON l.journal_id=h.id JOIN erp_chart_accounts a ON a.id=l.account_id
      WHERE h.status='POSTED' AND a.control_type='TAX' AND ${f.where.join(' AND ')}
      GROUP BY a.id ORDER BY a.account_code`, f.args);
  return ok(c, { filters:f, rows });
});

financeRoutes.get('/reports/inventory-reconciliation', requirePermission('FINANCE', 'VIEW'), async c => {
  const summary = await first(c.env.DB, `SELECT * FROM vw_erp_inventory_gl_reconciliation`);
  const byCategory = await all(c.env.DB,`
    SELECT class_code category,class_name,account_code,cogs_account_code,units,valued_units,unvalued_units,
      subledger_value,gl_value,difference,
      CASE WHEN ABS(difference)<=0.01 THEN 'RECONCILED' ELSE 'REVIEW_REQUIRED' END status
    FROM vw_erp_inventory_class_reconciliation
    ORDER BY CASE class_code WHEN 'MC' THEN 1 WHEN 'BAT' THEN 2 WHEN 'BSS' THEN 3 WHEN 'CHG' THEN 4 WHEN 'SP' THEN 5 ELSE 6 END`);
  const sourceEvents = await all(c.env.DB,
    `SELECT status,event_type,COUNT(*) events,ROUND(SUM(amount),2) amount
      FROM erp_finance_source_events
      WHERE event_type IN ('GOODS_RECEIPT','LANDED_COST','SALE_COGS','SALES_RETURN_INVENTORY','CAPITALIZATION',
        'INVENTORY_CONSUMPTION','WARRANTY_ISSUE','DONATION_ISSUE','INVENTORY_VALUATION_ADJUSTMENT',
        'INVENTORY_WRITE_OFF','CYCLE_COUNT_ADJUSTMENT')
      GROUP BY status,event_type ORDER BY status,event_type`);
  const difference = round(Number(summary?.inventory_subledger || 0) - Number(summary?.inventory_general_ledger || 0));
  // Reconciliation is judged PER CLASS against its own control account. A netted
  // total can hide an offsetting break (one class over, another under), so the
  // headline flag requires EVERY class to reconcile on its own.
  const reviewClasses = byCategory.filter(x => x.status !== 'RECONCILED');
  const reconciled = byCategory.length > 0 && reviewClasses.length === 0;
  return ok(c, {
    summary: {
      ...summary,
      netDifference: difference,
      reconciled,
      classesNeedingReview: reviewClasses.map(x => x.category),
    },
    byCategory, sourceEvents,
  });
});

financeRoutes.get('/reports/budget-actual', requirePermission('FINANCE', 'VIEW'), async c => {
  const year = Number(c.req.query('year') || new Date().getFullYear());
  const budget = await all(c.env.DB,
    `SELECT department,COALESCE(cost_center,'') cost_center,account_title,
      SUM(amount) budget_amount FROM erp_budget_plan WHERE year=?
      GROUP BY department,cost_center,account_title`, [year]);
  const actual = await all(c.env.DB,
    `SELECT l.department,COALESCE(l.cost_center,'') cost_center,a.account_name account_title,
      SUM(l.base_debit-l.base_credit) actual_amount
      FROM erp_journal_headers h JOIN erp_journal_lines l ON l.journal_id=h.id
      JOIN erp_chart_accounts a ON a.id=l.account_id
      WHERE h.status='POSTED' AND strftime('%Y',h.journal_date)=? AND a.account_type IN ('COGS','EXPENSE')
      GROUP BY l.department,l.cost_center,a.account_name`, [String(year)]);
  const key = row => `${row.department || ''}|${row.cost_center || ''}|${row.account_title || ''}`;
  const map = new Map();
  for (const row of budget) map.set(key(row), { ...row, actual_amount:0 });
  for (const row of actual) {
    const k = key(row);
    if (!map.has(k)) map.set(k, { ...row, budget_amount:0 });
    map.get(k).actual_amount = Number(row.actual_amount || 0);
  }
  const rows = [...map.values()].map(row => ({
    ...row, variance:round(Number(row.budget_amount || 0) - Number(row.actual_amount || 0)),
    utilizationPct:Number(row.budget_amount || 0)
      ? round(Number(row.actual_amount || 0) / Number(row.budget_amount || 0) * 100) : 0,
  })).sort((a, b) => String(a.department).localeCompare(String(b.department))
    || String(a.account_title).localeCompare(String(b.account_title)));
  return ok(c, { year, rows });
});


/* ===================================================================
 * Cash advance liquidation
 * A liquidation can only be opened against a Cash Advance RFP that is
 * fully approved (APPROVED / PAYMENT_PREPARED / PAID). The requestor adds
 * one line per expense with a receipt, the system totals them and shows the
 * variance against the advance, then Finance reviews.
 * =================================================================== */
async function rfpExtras(db,requestNo){
  const row=await first(db,`SELECT value FROM erp_rfp_settings WHERE key=?`,['rfp_doc:'+requestNo]);
  try{return row&&row.value?JSON.parse(row.value):{};}catch(e){return {};}
}
function liquidatable(status){
  return ['APPROVED','PAYMENT_PREPARED','PAID'].includes(String(status||'').toUpperCase());
}

// Cash-advance RFPs the signed-in user may liquidate.
financeRoutes.get('/liquidations/eligible', requirePermission('FINANCE','VIEW'), async c=>{
  const user=c.get('erpUser');
  const rows=await all(c.env.DB,`SELECT r.* FROM erp_payment_requests r
    WHERE r.requestor_email=? AND r.status IN ('APPROVED','PAYMENT_PREPARED','PAID')
    ORDER BY r.request_date DESC LIMIT 200`,[user.email]);
  const eligible=[];
  for(const row of rows){
    const extras=await rfpExtras(c.env.DB,row.request_no);
    const isAdvance=Number(extras.cashAdvance||0)===1||/ADVANCE/i.test(String(row.request_type||''));
    if(!isAdvance)continue;
    const existing=await first(c.env.DB,`SELECT id,liquidation_no,status FROM erp_rfp_liquidations WHERE payment_request_id=?`,[row.id]);
    eligible.push({id:row.id,requestNo:row.request_no,requestDate:row.request_date,purpose:row.purpose,
      amount:row.net_payable,status:row.status,liquidation:existing||null});
  }
  return ok(c,{rows:eligible});
});

financeRoutes.get('/liquidations', requirePermission('FINANCE','VIEW'), async c=>{
  const vis=await rfpVisibility(c);
  const where=vis.level==='ALL'?'':' WHERE l.requestor_email=?';
  const args=vis.level==='ALL'?[]:[c.get('erpUser').email];
  const rows=await all(c.env.DB,`SELECT l.*,r.purpose,r.department FROM erp_rfp_liquidations l
    LEFT JOIN erp_payment_requests r ON r.id=l.payment_request_id${where}
    ORDER BY l.id DESC LIMIT 300`,args);
  return ok(c,{rows});
});

financeRoutes.get('/liquidations/:id', requirePermission('FINANCE','VIEW'), async c=>{
  const id=Number(c.req.param('id'));
  const header=await first(c.env.DB,`SELECT * FROM erp_rfp_liquidations WHERE id=?`,[id]);
  if(!header)return fail(c,'Liquidation not found.',404);
  const user=c.get('erpUser');
  const role=String(user.role_code||'').toUpperCase();
  if(header.requestor_email!==user.email&&!['FINANCE','CEO'].includes(role))return fail(c,'You can only open your own liquidation.',403);
  const items=await all(c.env.DB,`SELECT * FROM erp_rfp_liquidation_items WHERE liquidation_id=? ORDER BY line_no`,[id]);
  const attachments=await attachmentsFor(c.env.DB,'LIQUIDATION',id,header.liquidation_no);
  return ok(c,{header,items,attachments});
});

// Open (or reopen) a liquidation for an approved cash advance.
financeRoutes.post('/liquidations', requirePermission('FINANCE','CREATE'), async c=>{
  const b=await jsonBody(c);
  const rfp=await first(c.env.DB,`SELECT * FROM erp_payment_requests WHERE id=?`,[Number(b.paymentRequestId)]);
  if(!rfp)return fail(c,'Select the cash-advance RFP to liquidate.',404);
  const user=c.get('erpUser');
  if(rfp.requestor_email!==user.email)return fail(c,'Only the requestor can liquidate their own cash advance.',403);
  const extras=await rfpExtras(c.env.DB,rfp.request_no);
  const isAdvance=Number(extras.cashAdvance||0)===1||/ADVANCE/i.test(String(rfp.request_type||''));
  if(!isAdvance)return fail(c,'This request is not tagged as a Cash Advance.',409);
  if(!liquidatable(rfp.status))return fail(c,'The cash advance must be fully approved before it can be liquidated.',409);
  const existing=await first(c.env.DB,`SELECT * FROM erp_rfp_liquidations WHERE payment_request_id=?`,[rfp.id]);
  if(existing)return ok(c,{id:existing.id,liquidationNo:existing.liquidation_no,reused:true});
  const no=await nextCode(c.env.DB,'LIQUIDATION','LIQ',6);
  const inserted=await run(c.env.DB,`INSERT INTO erp_rfp_liquidations(liquidation_no,payment_request_id,request_no,
    requestor_email,advance_amount,spent_amount,variance,status) VALUES(?,?,?,?,?,0,?, 'DRAFT')`,
    [no,rfp.id,rfp.request_no,user.email,rfp.net_payable,rfp.net_payable]);
  await audit(c,{action:'CREATE',module:'FINANCE',recordType:'LIQUIDATION',recordId:inserted.meta.last_row_id,recordNo:no,after:{rfp:rfp.request_no}});
  return ok(c,{id:inserted.meta.last_row_id,liquidationNo:no},201);
});

// Replace all lines and (optionally) attach receipts.
financeRoutes.post('/liquidations/:id/lines', requirePermission('FINANCE','CREATE'), async c=>{
  const id=Number(c.req.param('id'));const b=await jsonBody(c);
  const header=await first(c.env.DB,`SELECT * FROM erp_rfp_liquidations WHERE id=?`,[id]);
  if(!header)return fail(c,'Liquidation not found.',404);
  const user=c.get('erpUser');
  if(header.requestor_email!==user.email)return fail(c,'Only the requestor can edit this liquidation.',403);
  if(header.status!=='DRAFT')return fail(c,'This liquidation has already been submitted.',409);
  const lines=(Array.isArray(b.lines)?b.lines:[]).filter(x=>numberValue(x.amount)>0);
  await run(c.env.DB,`DELETE FROM erp_rfp_liquidation_items WHERE liquidation_id=?`,[id]);
  let lineNo=0,spent=0;
  for(const line of lines){
    lineNo+=1;spent+=numberValue(line.amount);
    await run(c.env.DB,`INSERT INTO erp_rfp_liquidation_items(liquidation_id,line_no,expense_date,particulars,amount,receipt_no)
      VALUES(?,?,?,?,?,?)`,[id,lineNo,normalizeText(line.expenseDate),normalizeText(line.particulars),numberValue(line.amount),normalizeText(line.receiptNo)]);
  }
  spent=round(spent);
  const variance=round(Number(header.advance_amount||0)-spent);
  await run(c.env.DB,`UPDATE erp_rfp_liquidations SET spent_amount=?,variance=?,updated_at=datetime('now') WHERE id=?`,[spent,variance,id]);
  let attach={saved:[],failed:[]};
  if(Array.isArray(b.attachments)&&b.attachments.length){
    attach=await saveAttachments(c.env,c.env.DB,{moduleCode:'LIQUIDATION',recordType:'LIQUIDATION',
      recordId:id,recordNo:header.liquidation_no,files:b.attachments,uploadedBy:user.email});
  }
  return ok(c,{lines:lineNo,spent,variance,advance:header.advance_amount,attachments:attach.saved,attachmentErrors:attach.failed});
});

financeRoutes.post('/liquidations/:id/submit', requirePermission('FINANCE','CREATE'), async c=>{
  const id=Number(c.req.param('id'));
  const header=await first(c.env.DB,`SELECT * FROM erp_rfp_liquidations WHERE id=?`,[id]);
  if(!header)return fail(c,'Liquidation not found.',404);
  const user=c.get('erpUser');
  if(header.requestor_email!==user.email)return fail(c,'Only the requestor can submit this liquidation.',403);
  if(header.status!=='DRAFT')return fail(c,'Already submitted.',409);
  const items=await all(c.env.DB,`SELECT COUNT(*) n FROM erp_rfp_liquidation_items WHERE liquidation_id=?`,[id]);
  if(!Number(items[0]?.n||0))return fail(c,'Add at least one liquidation line.',409);
  await run(c.env.DB,`UPDATE erp_rfp_liquidations SET status='SUBMITTED',submitted_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,[id]);
  const finance=await roleEmails(c.env.DB,c.env,['FINANCE'],'');
  const attachments=await attachmentsFor(c.env.DB,'LIQUIDATION',id,header.liquidation_no);
  await sendMailQuiet(c.env,{to:finance,cc:[user.email],
    subject:`Liquidation submitted: ${header.liquidation_no} (${header.request_no})`,
    html:mailLayout('Cash advance liquidation submitted',
      `<p>${user.email} submitted a liquidation for cash advance <b>${header.request_no}</b>.</p>`
      +mailFacts([['Liquidation',header.liquidation_no],['Cash advance',header.request_no],
        ['Advance amount',rfpMoney(header.advance_amount)],['Total spent',rfpMoney(header.spent_amount)],
        ['Variance',rfpMoney(header.variance)]])
      +mailAttachments(attachments),'Cash advance liquidation')});
  await audit(c,{action:'SUBMIT',module:'FINANCE',recordType:'LIQUIDATION',recordId:id,recordNo:header.liquidation_no,after:{spent:header.spent_amount,variance:header.variance}});
  return ok(c,{submitted:true,status:'SUBMITTED',liquidationNo:header.liquidation_no});
});

financeRoutes.post('/liquidations/:id/review', requirePermission('FINANCE','APPROVE'), async c=>{
  const id=Number(c.req.param('id'));const b=await jsonBody(c);
  const header=await first(c.env.DB,`SELECT * FROM erp_rfp_liquidations WHERE id=?`,[id]);
  if(!header)return fail(c,'Liquidation not found.',404);
  if(header.status!=='SUBMITTED')return fail(c,'Only a submitted liquidation can be reviewed.',409);
  const approve=String(b.decision||'APPROVE').toUpperCase()!=='REJECT';
  const user=c.get('erpUser').email;
  await run(c.env.DB,`UPDATE erp_rfp_liquidations SET status=?,reviewed_by=?,reviewed_at=datetime('now'),
    remarks=?,updated_at=datetime('now') WHERE id=?`,[approve?'APPROVED':'REJECTED',user,normalizeText(b.remarks),id]);
  await sendMailQuiet(c.env,{to:[header.requestor_email],
    subject:`Liquidation ${approve?'approved':'returned'}: ${header.liquidation_no}`,
    html:mailLayout(`Liquidation ${approve?'approved':'returned'}`,
      `<p>Finance ${approve?'approved':'returned'} your liquidation for cash advance <b>${header.request_no}</b>.</p>`
      +mailFacts([['Liquidation',header.liquidation_no],['Advance',rfpMoney(header.advance_amount)],
        ['Spent',rfpMoney(header.spent_amount)],['Variance',rfpMoney(header.variance)],
        ['Remarks',normalizeText(b.remarks)]]),'Cash advance liquidation')});
  await audit(c,{action:approve?'APPROVE':'REJECT',module:'FINANCE',recordType:'LIQUIDATION',recordId:id,recordNo:header.liquidation_no,after:{decision:approve}});
  return ok(c,{status:approve?'APPROVED':'REJECTED'});
});
