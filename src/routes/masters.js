import { Hono } from 'hono';
import { all, first, run } from '../lib/db.js';
import { ok, fail, jsonBody, pageParams } from '../lib/http.js';
import { requireAnyPermission, requirePermission } from '../lib/auth.js';
import { ensureItem, ensureLocation, ensurePartner, normalizeText, nextCode } from '../lib/codes.js';
import { audit } from '../lib/audit.js';

export const masterRoutes = new Hono();

masterRoutes.get('/lookups', requireAnyPermission(['INVENTORY','PROCUREMENT','SALES','CUSTOMERS','RECEIVING','STATIONS'],'VIEW'), async (c) => {
  const [items, locations, customers, vendors, employees] = await Promise.all([
    all(c.env.DB, `SELECT id,item_code,item_name,category,serialized,standard_cost FROM erp_items WHERE active=1 ORDER BY category,item_name`),
    all(c.env.DB, `SELECT id,code,name,location_type,partner_name FROM erp_locations WHERE active=1 AND location_type<>'OTHER' AND name NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND COALESCE(code,'') NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' ORDER BY CASE location_type WHEN 'WAREHOUSE' THEN 1 WHEN 'RETAIL' THEN 2 WHEN 'PORT' THEN 3 WHEN 'QUARANTINE' THEN 4 WHEN 'CUSTOMER_SITE' THEN 5 ELSE 6 END,name`),
    all(c.env.DB, `SELECT id,partner_code,name,credit_status,overdue_balance FROM erp_partners WHERE partner_type='CUSTOMER' AND active=1 ORDER BY name`),
    all(c.env.DB, `SELECT id,partner_code,name FROM erp_partners WHERE partner_type='VENDOR' AND active=1 ORDER BY name`),
    all(c.env.DB, `SELECT id,partner_code,name FROM erp_partners WHERE partner_type='EMPLOYEE' AND active=1 ORDER BY name`),
  ]);
  return ok(c, { items, locations, customers, vendors, employees });
});

masterRoutes.get('/items', requirePermission('INVENTORY','VIEW'), async (c) => {
  const { page,size,offset } = pageParams(c);
  const q = `%${normalizeText(c.req.query('q'))}%`;
  const category = normalizeText(c.req.query('category'));
  const args=[]; const where=['active=1'];
  if (q !== '%%') { where.push('(item_code LIKE ? OR item_name LIKE ?)'); args.push(q,q); }
  if (category) { where.push('category=?'); args.push(category); }
  const rows = await all(c.env.DB, `SELECT * FROM erp_items WHERE ${where.join(' AND ')} ORDER BY category,item_name LIMIT ? OFFSET ?`, [...args,size,offset]);
  const total = await first(c.env.DB, `SELECT COUNT(*) n FROM erp_items WHERE ${where.join(' AND ')}`, args);
  return ok(c,{rows,page,size,total:total?.n||0});
});

masterRoutes.post('/items', requirePermission('INVENTORY','CREATE'), async (c) => {
  const b=await jsonBody(c);
  if (!b.itemName) return fail(c,'Item name is required');
  const item=await ensureItem(c.env.DB,{...b,autoCreated:!b.itemCode,sourceSystem:'E88_FINSYS'});
  await audit(c,{action:'CREATE',module:'INVENTORY',recordType:'ITEM',recordId:item.id,recordNo:item.item_code,after:item});
  return ok(c,{item},201);
});

masterRoutes.get('/partners', requirePermission('CUSTOMERS','VIEW'), async (c) => {
  const { page,size,offset }=pageParams(c); const type=normalizeText(c.req.query('type'));
  const q=`%${normalizeText(c.req.query('q'))}%`; const args=[]; const where=['active=1'];
  if(type){where.push('partner_type=?');args.push(type);} if(q!=='%%'){where.push('(partner_code LIKE ? OR name LIKE ?)');args.push(q,q);}
  const rows=await all(c.env.DB,`SELECT * FROM erp_partners WHERE ${where.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`,[...args,size,offset]);
  const total=await first(c.env.DB,`SELECT COUNT(*) n FROM erp_partners WHERE ${where.join(' AND ')}`,args);
  return ok(c,{rows,page,size,total:total?.n||0});
});

masterRoutes.post('/partners', requirePermission('CUSTOMERS','CREATE'), async(c)=>{
  const b=await jsonBody(c); if(!b.name)return fail(c,'Name is required');
  const partner=await ensurePartner(c.env.DB,{...b,type:b.partnerType||'CUSTOMER',sourceSystem:'E88_FINSYS'});
  await audit(c,{action:'CREATE',module:'SALES',recordType:'PARTNER',recordId:partner.id,recordNo:partner.partner_code,after:partner});
  return ok(c,{partner},201);
});

masterRoutes.post('/locations', requirePermission('INVENTORY','CREATE'), async(c)=>{
  const b=await jsonBody(c); if(!b.name)return fail(c,'Location name is required');
  const location=await ensureLocation(c.env.DB,b.name,b.locationType||'OTHER',b.code||'');
  await audit(c,{action:'CREATE',module:'INVENTORY',recordType:'LOCATION',recordId:location.id,recordNo:location.code,after:location});
  return ok(c,{location},201);
});

masterRoutes.post('/partners/:id/credit', requirePermission('CUSTOMERS','APPROVE'), async(c)=>{
  const id=Number(c.req.param('id')); const b=await jsonBody(c); const before=await first(c.env.DB,`SELECT * FROM erp_partners WHERE id=?`,[id]);
  if(!before)return fail(c,'Partner not found',404);
  const status=b.creditStatus||before.credit_status;
  await run(c.env.DB,`UPDATE erp_partners SET credit_status=?,hold_reason=?,overdue_balance=?,updated_at=datetime('now') WHERE id=?`,[status,b.holdReason||'',Number(b.overdueBalance||0),id]);
  const after=await first(c.env.DB,`SELECT * FROM erp_partners WHERE id=?`,[id]);
  await audit(c,{action:'CREDIT_UPDATE',module:'SALES',recordType:'PARTNER',recordId:id,recordNo:after.partner_code,before,after});
  return ok(c,{partner:after});
});


masterRoutes.get('/accredited-vendors', requireAnyPermission(['FINANCE','PROCUREMENT','ADMIN'],'VIEW'), async (c) => {
  /*
   * Accredited means accredited. The list was returning every row whatever its
   * status, so a vendor still going through accreditation, or one that had been
   * refused, appeared in the dropdown beside the ones that had passed.
   */
  const rows = await all(c.env.DB, `SELECT partner_code,vendor_name,status FROM erp_vendor_accreditation
     WHERE UPPER(COALESCE(status,''))IN('ACCREDITED','APPROVED','ACTIVE') ORDER BY vendor_name`);
  return ok(c,{rows});
});

/* ---------- Product Registration + media (free, D1-backed) ---------- */
function abToB64(buf){const b=new Uint8Array(buf);let s='';const c=0x8000;for(let i=0;i<b.length;i+=c)s+=String.fromCharCode.apply(null,b.subarray(i,i+c));return btoa(s);}
function b64ToBytes(x){const bin=atob(x);const n=bin.length;const a=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=bin.charCodeAt(i);return a;}

masterRoutes.post('/items/register', requirePermission('INVENTORY','CREATE'), async (c) => {
  const b = await jsonBody(c);
  if (!normalizeText(b.itemName)) return fail(c,'Product name is required');
  const productType = (normalizeText(b.productType)||'SERIALIZED').toUpperCase();
  const serialized = productType==='SERIALIZED' ? 1 : 0;
  const inventoriable = productType==='SERVICE' ? 0 : 1;
  const name = normalizeText(b.itemName);
  const category = normalizeText(b.category)||'GEN';
  const uom = normalizeText(b.uom)||'EA';
  const cost = Number(b.standardCost||0);
  let item;
  if (b.id) {
    item = await first(c.env.DB, `SELECT * FROM erp_items WHERE id=?`, [Number(b.id)]);
    if (!item) return fail(c,'Product not found',404);
    await run(c.env.DB, `UPDATE erp_items SET item_name=?,category=?,subcategory=?,model=?,serialized=?,base_uom=?,standard_cost=?,updated_at=datetime('now') WHERE id=?`,
      [name,category,normalizeText(b.subcategory),normalizeText(b.model),serialized,uom,cost,item.id]);
  } else {
    const code = normalizeText(b.itemCode) || await nextCode(c.env.DB,`ITEM_${category}`,category,6);
    const exists = await first(c.env.DB,`SELECT id FROM erp_items WHERE item_code=?`,[code]);
    if (exists) return fail(c,`Item code ${code} already exists.`,409);
    const r = await run(c.env.DB, `INSERT INTO erp_items(item_code,item_name,normalized_name,category,subcategory,model,serialized,base_uom,standard_cost,auto_created,source_system) VALUES(?,?,?,?,?,?,?,?,?,0,'E88_FINSYS')`,
      [code,name,name.toUpperCase(),category,normalizeText(b.subcategory),normalizeText(b.model),serialized,uom,cost]);
    item = await first(c.env.DB,`SELECT * FROM erp_items WHERE id=?`,[r.meta.last_row_id]);
  }
  await run(c.env.DB, `INSERT INTO erp_item_profile(item_id,product_type,inventoriable,description,sale_price,updated_at) VALUES(?,?,?,?,?,datetime('now'))
    ON CONFLICT(item_id) DO UPDATE SET product_type=excluded.product_type,inventoriable=excluded.inventoriable,description=excluded.description,sale_price=excluded.sale_price,updated_at=datetime('now')`,
    [item.id,productType,inventoriable,normalizeText(b.description),Number(b.salePrice||0)]);
  await audit(c,{action:b.id?'UPDATE':'CREATE',module:'INVENTORY',recordType:'ITEM',recordId:item.id,recordNo:item.item_code,after:{...item,productType,inventoriable}});
  return ok(c,{item,productType,inventoriable},b.id?200:201);
});

masterRoutes.get('/items/:id/full', requirePermission('INVENTORY','VIEW'), async (c) => {
  const id=Number(c.req.param('id'));
  const item=await first(c.env.DB,`SELECT * FROM erp_items WHERE id=?`,[id]);
  if(!item) return fail(c,'Product not found',404);
  const profile=await first(c.env.DB,`SELECT * FROM erp_item_profile WHERE item_id=?`,[id]);
  const media=await all(c.env.DB,`SELECT id,kind,file_name,content_type,sort_order FROM erp_item_media WHERE item_id=? ORDER BY kind,sort_order,id`,[id]);
  const onHand=await first(c.env.DB,`SELECT COUNT(*) n FROM erp_assets WHERE item_id=? AND active=1`,[id]);
  return ok(c,{item,profile,media,onHand:onHand?.n||0});
});

masterRoutes.post('/items/:id/media', requirePermission('INVENTORY','CREATE'), async (c) => {
  const id=Number(c.req.param('id'));
  const item=await first(c.env.DB,`SELECT * FROM erp_items WHERE id=?`,[id]);
  if(!item) return fail(c,'Product not found',404);
  const form=await c.req.raw.formData();
  const file=form.get('file');
  if(!(file instanceof File)) return fail(c,'Choose a photo or 3D model file.');
  if(file.size>4*1024*1024) return fail(c,'Each file must be 4 MB or smaller.');
  const kind=(normalizeText(form.get('kind'))||'photo').toLowerCase();
  const buf=await file.arrayBuffer();
  const r=await run(c.env.DB,`INSERT INTO erp_item_media(item_id,kind,file_name,content_type,data_base64,sort_order,created_by) VALUES(?,?,?,?,?,?,?)`,
    [id,kind,file.name,file.type||'application/octet-stream',abToB64(buf),Number(form.get('sortOrder')||0),c.get('erpUser').email]);
  await audit(c,{action:'UPLOAD_MEDIA',module:'INVENTORY',recordType:'ITEM',recordId:id,recordNo:item.item_code,after:{mediaId:r.meta.last_row_id,kind,fileName:file.name}});
  return ok(c,{id:r.meta.last_row_id,kind,fileName:file.name},201);
});

masterRoutes.get('/items/media/:mid/file', requirePermission('INVENTORY','VIEW'), async (c) => {
  const m=await first(c.env.DB,`SELECT * FROM erp_item_media WHERE id=?`,[Number(c.req.param('mid'))]);
  if(!m) return fail(c,'File not found',404);
  const headers=new Headers();
  headers.set('Content-Type',m.content_type||'application/octet-stream');
  headers.set('Content-Disposition',`inline; filename="${String(m.file_name||'file').replaceAll('"','')}"`);
  headers.set('Cache-Control','private, max-age=600');
  return new Response(b64ToBytes(m.data_base64),{headers});
});

masterRoutes.post('/items/media/:mid/delete', requirePermission('INVENTORY','EDIT'), async (c) => {
  const mid=Number(c.req.param('mid'));
  await run(c.env.DB,`DELETE FROM erp_item_media WHERE id=?`,[mid]);
  return ok(c,{deleted:true});
});
