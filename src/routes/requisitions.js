import { Hono } from 'hono';
import { all, first, run } from '../lib/db.js';
import { ok, fail, jsonBody, pageParams, numberValue } from '../lib/http.js';
import { requirePermission } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { ensurePartner, ensureItem, nextCode, normalizeText, normalizeSerial } from '../lib/codes.js';
import { isAvailable } from '../lib/inventory.js';

export const requisitionRoutes = new Hono();

const HOLDER_TYPES = new Set([
  'CUSTOMER','EMPLOYEE','DEMO','PILOT','DEPARTMENT','DEALER_RETAIL','PROJECT_SITE','LEASE_DEPLOYMENT',
]);
const REQUEST_TYPES = new Set([
  'SALE','LEASE','EMPLOYEE_USE','DEMO','PILOT','INTERNAL_USE','PROJECT_DEPLOYMENT','DEALER_RETAIL','REPLACEMENT',
]);

requisitionRoutes.get('/', requirePermission('REQUISITIONS','VIEW'), async c => {
  const {page,size,offset}=pageParams(c); const q=`%${normalizeText(c.req.query('q'))}%`; const status=normalizeText(c.req.query('status'));
  const where=[]; const args=[]; if(q!=='%%'){where.push('(r.requisition_no LIKE ? OR r.requestor_name LIKE ? OR r.purpose LIKE ? OR r.destination LIKE ? OR rc.holder_name LIKE ?)');args.push(q,q,q,q,q);} if(status){where.push('r.status=?');args.push(status);} const w=where.length?`WHERE ${where.join(' AND ')}`:'';
  const rows=await all(c.env.DB,`SELECT r.*,p.name partner_name,rc.request_type,rc.holder_type,rc.holder_name,rc.expected_return_date,
    (SELECT COUNT(*) FROM erp_requisition_lines l WHERE l.requisition_id=r.id) line_count,
    (SELECT COUNT(*) FROM erp_requisition_allocations x WHERE x.requisition_id=r.id AND x.asset_id IS NOT NULL) serial_count
    FROM erp_requisitions r
    LEFT JOIN erp_partners p ON p.id=r.partner_id
    LEFT JOIN erp_requisition_context rc ON rc.requisition_id=r.id
    ${w} ORDER BY COALESCE(r.required_date,r.request_date,r.created_at) DESC LIMIT ? OFFSET ?`,[...args,size,offset]);
  const total=await first(c.env.DB,`SELECT COUNT(*) n FROM erp_requisitions r LEFT JOIN erp_requisition_context rc ON rc.requisition_id=r.id ${w}`,args);
  return ok(c,{rows,page,size,total:total?.n||0});
});

requisitionRoutes.get('/lookups', requirePermission('REQUISITIONS','VIEW'), async c => {
  const [holders,items,assets,orders]=await Promise.all([
    all(c.env.DB,`SELECT id,partner_code,partner_type,name,email,phone,address,credit_status
      FROM erp_partners WHERE active=1 AND partner_type IN ('CUSTOMER','EMPLOYEE','DEALER','RETAIL')
      ORDER BY partner_type,name`),
    all(c.env.DB,`SELECT id,item_code,item_name,category,serialized,base_uom
      FROM erp_items WHERE active=1 ORDER BY category,item_name`),
    all(c.env.DB,`SELECT a.id,a.serial_no,a.item_id,a.item_code,a.item_name,a.category,a.current_location_code,a.current_status,
      i.base_uom FROM erp_assets a LEFT JOIN erp_items i ON i.id=a.item_id
      WHERE a.active=1 AND a.current_status IN ('AVAILABLE','IN_STOCK') AND a.reconciliation_status='CLEAR'
        AND NOT EXISTS(
          SELECT 1 FROM erp_requisition_allocations ra
          JOIN erp_requisitions r ON r.id=ra.requisition_id
          WHERE ra.asset_id=a.id AND ra.allocation_status IN ('SELECTED','RESERVED','ISSUED')
            AND r.status NOT IN ('CANCELLED','FULFILLED')
        )
      ORDER BY a.category,a.item_name,a.serial_no`),
    all(c.env.DB,`SELECT s.id,s.sales_order_no,s.transaction_type,s.customer_id,p.name customer_name,s.delivery_address
      FROM erp_sales_orders s JOIN erp_partners p ON p.id=s.customer_id
      WHERE s.status IN ('DRAFT','APPROVED') ORDER BY s.order_date DESC,s.id DESC LIMIT 300`),
  ]);
  return ok(c,{holders,items,assets,orders,holderTypes:[...HOLDER_TYPES],requestTypes:[...REQUEST_TYPES]});
});

requisitionRoutes.get('/outbound-workbench', requirePermission('REQUISITIONS','VIEW'), async c => {
  const [requisitions,allocations,deliveries,checks,returns,documentFlow]=await Promise.all([
    /*
     * source_order_id / source_order_no are what the screen uses to hide a sales
     * order that has already been requisitioned. They were never selected, so
     * the filter read undefined on every row and hid nothing.
     */
    all(c.env.DB,`SELECT r.*,rc.request_type,rc.holder_type,rc.holder_name,rc.expected_return_date,
      rc.source_order_id,rc.source_order_no,
      (SELECT COUNT(*) FROM erp_requisition_allocations ra WHERE ra.requisition_id=r.id AND ra.asset_id IS NOT NULL) serial_count,
      (SELECT SUM(ra.quantity) FROM erp_requisition_allocations ra WHERE ra.requisition_id=r.id) total_qty
      FROM erp_requisitions r LEFT JOIN erp_requisition_context rc ON rc.requisition_id=r.id
      ORDER BY COALESCE(r.required_date,r.request_date) DESC,r.id DESC LIMIT 500`),
    all(c.env.DB,`SELECT ra.*,a.item_name,a.category,a.current_status,a.current_location_code,
      r.requisition_no FROM erp_requisition_allocations ra
      JOIN erp_requisitions r ON r.id=ra.requisition_id
      LEFT JOIN erp_assets a ON a.id=ra.asset_id ORDER BY ra.requisition_id,ra.id`),
    all(c.env.DB,`SELECT d.*,r.requisition_no,a.assignment_no,
      (SELECT COUNT(*) FROM erp_delivery_assets da WHERE da.delivery_id=d.id AND da.asset_id IS NOT NULL) serial_count
      FROM erp_deliveries d LEFT JOIN erp_requisitions r ON r.id=d.requisition_id
      LEFT JOIN erp_assignments a ON a.id=d.assignment_id
      WHERE d.requisition_id IS NOT NULL ORDER BY d.created_at DESC,d.id DESC LIMIT 500`),
    all(c.env.DB,`SELECT pc.*,a.category,a.item_name FROM erp_pre_release_checks pc
      LEFT JOIN erp_assets a ON a.serial_no=pc.serial_no ORDER BY pc.check_date DESC,pc.id DESC LIMIT 1000`),
    all(c.env.DB,`SELECT ro.*,a.assignment_no,p.name holder_name,l.code return_location_code,
      (SELECT COUNT(*) FROM erp_return_lines rl WHERE rl.return_id=ro.id) line_count
      FROM erp_return_orders ro LEFT JOIN erp_assignments a ON a.id=ro.assignment_id
      LEFT JOIN erp_partners p ON p.id=ro.partner_id LEFT JOIN erp_locations l ON l.id=ro.return_location_id
      ORDER BY ro.created_at DESC,ro.id DESC LIMIT 500`),
    all(c.env.DB,`SELECT * FROM erp_document_flow_links ORDER BY created_at DESC,id DESC LIMIT 1000`),
  ]);
  return ok(c,{requisitions,allocations,deliveries,checks,returns,documentFlow});
});

requisitionRoutes.post('/', requirePermission('REQUISITIONS','CREATE'), async c => {
  const b=await jsonBody(c);
  const lines=(Array.isArray(b.lines)?b.lines:[]).filter(line=>{
    const serials=[...(Array.isArray(line.serials)?line.serials:[]),line.serialNo].filter(Boolean);
    return numberValue(line.qty)>0||serials.length>0;
  });
  if(!lines.length)return fail(c,'At least one unit or consumable line is required');
  const holderType=normalizeText(b.holderType||'DEPARTMENT').toUpperCase();
  const requestType=normalizeText(b.requestType||'INTERNAL_USE').toUpperCase();
  if(!HOLDER_TYPES.has(holderType))return fail(c,'Select a valid holder type.');
  if(!REQUEST_TYPES.has(requestType))return fail(c,'Select a valid request type.');

  let partner=null;
  const partnerId=Number(b.holderPartnerId||b.partnerId||0);
  if(partnerId)partner=await first(c.env.DB,`SELECT * FROM erp_partners WHERE id=? AND active=1`,[partnerId]);
  const holderName=normalizeText(b.holderName||b.companyName||partner?.name||b.department);
  if(!holderName)return fail(c,'Holder, employee, customer, department, demo, or project name is required.');
  if(!partner&&['CUSTOMER','EMPLOYEE','DEALER_RETAIL','LEASE_DEPLOYMENT'].includes(holderType)){
    partner=await ensurePartner(c.env.DB,{
      name:holderName,type:holderType==='EMPLOYEE'?'EMPLOYEE':'CUSTOMER',
      address:b.destination||'',email:b.holderEmail||'',sourceSystem:b.sourceSystem||'E88_FINSYS',
    });
  }

  const no=normalizeText(b.requisitionNo)||await nextCode(c.env.DB,'REQUISITION','REQ',8);
  const r=await run(c.env.DB,`INSERT INTO erp_requisitions(
    requisition_no,request_date,requestor_email,requestor_name,department,purpose,fulfillment_method,
    partner_id,destination,required_date,status,remarks,source_system,source_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,'SUBMITTED',?,?,?)`,[
    no,b.requestDate||new Date().toISOString(),b.requestorEmail||c.get('erpUser').email,
    b.requestorName||c.get('erpUser').display_name,b.department||c.get('erpUser').department||'',
    normalizeText(b.purpose||b.custodyPurpose),holderType,partner?.id||null,normalizeText(b.destination),
    b.requiredDate||'',normalizeText(b.remarks),normalizeText(b.sourceSystem||'E88_FINSYS'),normalizeText(b.sourceKey),
  ]);
  const requisitionId=r.meta.last_row_id;
  await run(c.env.DB,`INSERT INTO erp_requisition_context(
    requisition_id,request_type,holder_type,holder_partner_id,holder_name,holder_email,
    source_order_id,source_order_no,expected_return_date,custody_purpose)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,[
    requisitionId,requestType,holderType,partner?.id||null,holderName,normalizeText(b.holderEmail||partner?.email),
    Number(b.sourceOrderId||0)||null,normalizeText(b.sourceOrderNo),b.expectedReturnDate||'',
    normalizeText(b.custodyPurpose||b.purpose),
  ]);

  const selected=[];
  for(const line of lines){
    const serials=[...(Array.isArray(line.serials)?line.serials:[]),line.serialNo].map(normalizeSerial).filter(Boolean);
    let item=line.itemId?await first(c.env.DB,`SELECT * FROM erp_items WHERE id=? AND active=1`,[Number(line.itemId)]):null;
    const assets=[];
    for(const serial of [...new Set(serials)]){
      const asset=await first(c.env.DB,`SELECT * FROM erp_assets WHERE serial_no=? AND active=1`,[serial]);
      if(!asset)return fail(c,`Serial ${serial} is not registered.`);
      if(!isAvailable(asset))return fail(c,`Serial ${serial} is not available (${asset.current_status}/${asset.reconciliation_status}).`,409);
      const inUse=await first(c.env.DB,`SELECT r.requisition_no FROM erp_requisition_allocations ra
        JOIN erp_requisitions r ON r.id=ra.requisition_id
        WHERE ra.asset_id=? AND ra.allocation_status IN ('SELECTED','RESERVED','ISSUED')
          AND r.status NOT IN ('CANCELLED','FULFILLED') LIMIT 1`,[asset.id]);
      if(inUse)return fail(c,`Serial ${serial} is already selected on ${inUse.requisition_no}.`,409);
      assets.push(asset);
      if(!item)item=await first(c.env.DB,`SELECT * FROM erp_items WHERE id=?`,[asset.item_id]);
      if(item&&asset.item_id!==item.id)return fail(c,`Serial ${serial} does not match ${item.item_code}.`,409);
    }
    if(!item)item=await ensureItem(c.env.DB,{
      itemCode:line.itemCode,itemName:line.itemName||line.description,category:line.category,
      serialized:serials.length>0||!!line.serialRequired,sourceSystem:'REQUISITION',
      sourceKey:`${no}|${line.itemCode||line.description}`,
    });
    const serialized=!!item.serialized||serials.length>0||!!line.serialRequired;
    if(serialized&&!assets.length)return fail(c,`${item.item_code} is serialized. Select at least one available serial.`);
    const qty=serialized?assets.length:numberValue(line.qty);
    if(qty<=0)return fail(c,`Enter a quantity for ${item.item_code}.`);
    const lineResult=await run(c.env.DB,`INSERT INTO erp_requisition_lines(
      requisition_id,item_id,item_code,description,qty,serial_required)
      VALUES(?,?,?,?,?,?)`,[requisitionId,item.id,item.item_code,line.description||item.item_name,qty,serialized?1:0]);
    if(assets.length){
      for(const asset of assets){
        await run(c.env.DB,`INSERT INTO erp_requisition_allocations(
          requisition_id,requisition_line_id,asset_id,serial_no,item_id,item_code,quantity,selected_by)
          VALUES(?,?,?,?,?,?,1,?)`,[
          requisitionId,lineResult.meta.last_row_id,asset.id,asset.serial_no,item.id,item.item_code,c.get('erpUser').email,
        ]);
        selected.push({serialNo:asset.serial_no,itemCode:item.item_code,category:asset.category});
      }
    }else{
      await run(c.env.DB,`INSERT INTO erp_requisition_allocations(
        requisition_id,requisition_line_id,item_id,item_code,quantity,selected_by)
        VALUES(?,?,?,?,?,?)`,[
        requisitionId,lineResult.meta.last_row_id,item.id,item.item_code,qty,c.get('erpUser').email,
      ]);
    }
  }
  await audit(c,{action:'CREATE',module:'REQUISITIONS',recordType:'REQUISITION',recordId:requisitionId,recordNo:no,
    after:{...b,holderType,requestType,holderName,selected}});
  return ok(c,{id:requisitionId,requisitionNo:no,selectedSerials:selected},201);
});

requisitionRoutes.get('/:id', requirePermission('REQUISITIONS','VIEW'), async c => {
  const id=Number(c.req.param('id'));
  const header=await first(c.env.DB,`SELECT r.*,p.name partner_name,rc.request_type,rc.holder_type,rc.holder_name,
    rc.holder_email,rc.source_order_id,rc.source_order_no,rc.expected_return_date,rc.custody_purpose
    FROM erp_requisitions r LEFT JOIN erp_partners p ON p.id=r.partner_id
    LEFT JOIN erp_requisition_context rc ON rc.requisition_id=r.id WHERE r.id=?`,[id]);
  if(!header)return fail(c,'Requisition not found',404);
  const lines=await all(c.env.DB,`SELECT l.*,i.category,i.serialized,i.base_uom
    FROM erp_requisition_lines l LEFT JOIN erp_items i ON i.id=l.item_id
    WHERE l.requisition_id=? ORDER BY l.id`,[id]);
  const allocations=await all(c.env.DB,`SELECT ra.*,a.item_name,a.category,a.current_status,a.current_location_code,
    a.current_holder_type,a.current_holder_name FROM erp_requisition_allocations ra
    LEFT JOIN erp_assets a ON a.id=ra.asset_id WHERE ra.requisition_id=? ORDER BY ra.id`,[id]);
  const assignments=await all(c.env.DB,`SELECT * FROM erp_assignments WHERE source_request_no=? ORDER BY id`,[header.requisition_no]);
  const deliveries=await all(c.env.DB,`SELECT * FROM erp_deliveries WHERE requisition_id=? ORDER BY created_at DESC`,[id]);
  const documentFlow=await all(c.env.DB,`SELECT * FROM erp_document_flow_links
    WHERE source_no=? OR target_no=? ORDER BY created_at,id`,[header.requisition_no,header.requisition_no]);
  return ok(c,{header,lines,allocations,assignments,deliveries,documentFlow});
});

requisitionRoutes.post('/:id/approve', requirePermission('REQUISITIONS','APPROVE'), async c => {
  const id=Number(c.req.param('id'));
  const before=await first(c.env.DB,`SELECT r.*,rc.request_type,rc.holder_type,rc.holder_partner_id,rc.holder_name,
    rc.expected_return_date FROM erp_requisitions r JOIN erp_requisition_context rc ON rc.requisition_id=r.id WHERE r.id=?`,[id]);
  if(!before)return fail(c,'Requisition not found',404);
  if(!['SUBMITTED','DRAFT'].includes(before.status))return fail(c,'Requisition cannot be approved in its current status',409);
  const allocations=await all(c.env.DB,`SELECT ra.*,a.current_status,a.reconciliation_status,a.category
    FROM erp_requisition_allocations ra LEFT JOIN erp_assets a ON a.id=ra.asset_id
    WHERE ra.requisition_id=? ORDER BY ra.id`,[id]);
  for(const allocation of allocations.filter(row=>row.asset_id)){
    if(!['AVAILABLE','IN_STOCK'].includes(allocation.current_status)||allocation.reconciliation_status!=='CLEAR'){
      return fail(c,`Serial ${allocation.serial_no} is no longer available.`,409);
    }
  }

  const assignmentNo=await nextCode(c.env.DB,'ASSIGNMENT','ASG',8);
  const assignmentResult=await run(c.env.DB,`INSERT INTO erp_assignments(
    assignment_no,assignment_type,partner_id,holder_name,start_date,expected_return_date,status,
    purpose,source_request_no,created_by,approved_by,approved_at)
    VALUES(?,?,?,?,?,?,'APPROVED',?,?,?,?,datetime('now'))`,[
    assignmentNo,before.request_type,before.holder_partner_id||before.partner_id||null,before.holder_name,
    before.required_date||before.request_date,before.expected_return_date||'',before.purpose,before.requisition_no,
    c.get('erpUser').email,c.get('erpUser').email,
  ]);
  const assignmentId=assignmentResult.meta.last_row_id;
  for(const allocation of allocations.filter(row=>row.asset_id)){
    await run(c.env.DB,`INSERT INTO erp_assignment_assets(assignment_id,asset_id,serial_no,role_code)
      VALUES(?,?,?,?)`,[assignmentId,allocation.asset_id,allocation.serial_no,allocation.category||'UNIT']);
    await run(c.env.DB,`UPDATE erp_assets SET current_status='RESERVED_FOR_REQUISITION',
      current_holder_type=?,current_holder_id=?,current_holder_name=?,updated_at=datetime('now')
      WHERE id=? AND current_status IN ('AVAILABLE','IN_STOCK') AND reconciliation_status='CLEAR'`,[
      before.holder_type,before.holder_partner_id||null,before.holder_name,allocation.asset_id,
    ]);
  }

  const deliveryNo=await nextCode(c.env.DB,'DELIVERY','DLV',8);
  const deliveryResult=await run(c.env.DB,`INSERT INTO erp_deliveries(
    delivery_no,assignment_id,requisition_id,requested_date,scheduled_date,destination,recipient_name,
    status,source_system,source_key,created_by)
    VALUES(?,?,?,?,?,?,?,'PLANNED','REQUISITION',?,?)`,[
    deliveryNo,assignmentId,id,before.request_date,before.required_date,before.destination,before.holder_name,
    before.requisition_no,c.get('erpUser').email,
  ]);
  for(const allocation of allocations){
    await run(c.env.DB,`INSERT OR IGNORE INTO erp_delivery_assets(
      delivery_id,asset_id,serial_no,item_code,qty) VALUES(?,?,?,?,?)`,[
      deliveryResult.meta.last_row_id,allocation.asset_id||null,allocation.serial_no||null,
      allocation.item_code,allocation.quantity,
    ]);
  }
  await run(c.env.DB,`UPDATE erp_requisition_allocations SET allocation_status='RESERVED'
    WHERE requisition_id=?`,[id]);
  await run(c.env.DB,`UPDATE erp_requisitions SET status='APPROVED' WHERE id=?`,[id]);
  await run(c.env.DB,`INSERT INTO erp_document_flow_links(
    source_type,source_id,source_no,target_type,target_id,target_no,relation_type,created_by)
    VALUES('REQUISITION',?,?, 'ASSIGNMENT',?,?, 'CREATES',?)`,[
    id,before.requisition_no,assignmentId,assignmentNo,c.get('erpUser').email,
  ]);
  await run(c.env.DB,`INSERT INTO erp_document_flow_links(
    source_type,source_id,source_no,target_type,target_id,target_no,relation_type,created_by)
    VALUES('ASSIGNMENT',?,?, 'DELIVERY',?,?, 'FULFILLED_BY',?)`,[
    assignmentId,assignmentNo,deliveryResult.meta.last_row_id,deliveryNo,c.get('erpUser').email,
  ]);
  const after=await first(c.env.DB,`SELECT * FROM erp_requisitions WHERE id=?`,[id]);
  await audit(c,{action:'APPROVE',module:'REQUISITIONS',recordType:'REQUISITION',recordId:id,
    recordNo:after.requisition_no,before,after:{...after,assignmentNo,deliveryNo}});
  return ok(c,{requisition:after,assignmentId,assignmentNo,deliveryId:deliveryResult.meta.last_row_id,deliveryNo});
});

requisitionRoutes.post('/:id/allocate', requirePermission('REQUISITIONS','EDIT'), async c => {
  const id=Number(c.req.param('id'));
  const b=await jsonBody(c);
  const serials=[...new Set((Array.isArray(b.serials)?b.serials:[]).map(normalizeSerial).filter(Boolean))];
  if(!serials.length)return fail(c,'Select at least one available serial to allocate.');
  const req=await first(c.env.DB,`SELECT * FROM erp_requisitions WHERE id=?`,[id]);
  if(!req)return fail(c,'Requisition not found',404);
  if(['CANCELLED','FULFILLED','ISSUED','APPROVED'].includes(req.status))
    return fail(c,`Requisition ${req.requisition_no} is ${req.status} and can no longer be allocated.`,409);
  const selected=[];
  for(const serial of serials){
    const asset=await first(c.env.DB,`SELECT * FROM erp_assets WHERE serial_no=? AND active=1`,[serial]);
    if(!asset)return fail(c,`Serial ${serial} is not registered.`,404);
    if(!isAvailable(asset))return fail(c,`Serial ${serial} is not available (${asset.current_status}/${asset.reconciliation_status}).`,409);
    const inUse=await first(c.env.DB,`SELECT r.requisition_no FROM erp_requisition_allocations ra
      JOIN erp_requisitions r ON r.id=ra.requisition_id
      WHERE ra.asset_id=? AND ra.allocation_status IN ('SELECTED','RESERVED','ISSUED')
        AND r.status NOT IN ('CANCELLED','FULFILLED') LIMIT 1`,[asset.id]);
    if(inUse)return fail(c,`Serial ${serial} is already selected on ${inUse.requisition_no}.`,409);
    let line=await first(c.env.DB,`SELECT * FROM erp_requisition_lines WHERE requisition_id=? AND item_id=? ORDER BY id LIMIT 1`,[id,asset.item_id]);
    if(!line){
      const lr=await run(c.env.DB,`INSERT INTO erp_requisition_lines(requisition_id,item_id,item_code,description,qty,serial_required)
        VALUES(?,?,?,?,0,1)`,[id,asset.item_id,asset.item_code,asset.item_name]);
      line={id:lr.meta.last_row_id};
    }
    await run(c.env.DB,`INSERT INTO erp_requisition_allocations(
      requisition_id,requisition_line_id,asset_id,serial_no,item_id,item_code,quantity,selected_by)
      VALUES(?,?,?,?,?,?,1,?)`,[id,line.id,asset.id,asset.serial_no,asset.item_id,asset.item_code,c.get('erpUser').email]);
    selected.push({serialNo:asset.serial_no,itemCode:asset.item_code,category:asset.category});
  }
  await run(c.env.DB,`UPDATE erp_requisition_lines SET qty=(
    SELECT COUNT(*) FROM erp_requisition_allocations ra
    WHERE ra.requisition_line_id=erp_requisition_lines.id AND ra.asset_id IS NOT NULL)
    WHERE requisition_id=? AND serial_required=1`,[id]);
  if(!['SUBMITTED','DRAFT'].includes(req.status))
    await run(c.env.DB,`UPDATE erp_requisitions SET status='SUBMITTED' WHERE id=?`,[id]);
  await audit(c,{action:'ALLOCATE',module:'REQUISITIONS',recordType:'REQUISITION',recordId:id,
    recordNo:req.requisition_no,after:{selected}});
  return ok(c,{allocated:selected.length,selected,status:'SUBMITTED'});
});

requisitionRoutes.post('/:id/cancel', requirePermission('REQUISITIONS','EDIT'), async c => {
  const id=Number(c.req.param('id')); const b=await jsonBody(c); const before=await first(c.env.DB,`SELECT * FROM erp_requisitions WHERE id=?`,[id]); if(!before)return fail(c,'Requisition not found',404); if(['FULFILLED','CANCELLED'].includes(before.status))return fail(c,'Requisition cannot be cancelled',409);
  const allocations=await all(c.env.DB,`SELECT * FROM erp_requisition_allocations WHERE requisition_id=?`,[id]);
  for(const allocation of allocations.filter(row=>row.asset_id)){
    await run(c.env.DB,`UPDATE erp_assets SET current_status='AVAILABLE',current_holder_type=NULL,
      current_holder_id=NULL,current_holder_name=NULL,updated_at=datetime('now')
      WHERE id=? AND current_status='RESERVED_FOR_REQUISITION'`,[allocation.asset_id]);
  }
  await run(c.env.DB,`UPDATE erp_requisition_allocations SET allocation_status='CANCELLED',released_at=datetime('now')
    WHERE requisition_id=?`,[id]);
  await run(c.env.DB,`UPDATE erp_assignments SET status='CANCELLED'
    WHERE source_request_no=? AND status IN ('DRAFT','APPROVED')`,[before.requisition_no]);
  await run(c.env.DB,`UPDATE erp_deliveries SET status='CANCELLED'
    WHERE requisition_id=? AND status='PLANNED'`,[id]);
  await run(c.env.DB,`UPDATE erp_requisitions SET status='CANCELLED',
    remarks=trim(COALESCE(remarks,'')||' '||?) WHERE id=?`,[normalizeText(b.reason),id]);
  await audit(c,{action:'CANCEL',module:'REQUISITIONS',recordType:'REQUISITION',recordId:id,
    recordNo:before.requisition_no,before,after:{...before,status:'CANCELLED'}});
  return ok(c,{cancelled:true});
});
