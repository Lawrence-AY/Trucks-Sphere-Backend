const {test} = require('node:test');
const assert = require('node:assert/strict');
const {syncPurchaseOrder} = require('../src/integrations/odooPurchaseOrders');
test('native PO creation maps quantities and preserves unspecified quantities as notes', async()=>{
 let saved;
 const call=async(model,method,args)=>{
  if(method==='search_read') return model==='uom.uom' ? [{id:7,name:'Units'}] : [];
  if(model==='purchase.order') saved=args.vals_list[0];
  return [42];
 };
 assert.equal(await syncPurchaseOrder(call,{id:'P1',vendorId:'V1',materials:[{materialId:'M1',quantity:3,unit:'Units'},{materialId:'M2'}]}),'created');
 assert.equal(saved.order_line[0][2].product_qty,3);
 assert.equal(saved.order_line[0][2].uom_id,7);
 assert.equal(saved.order_line[1][2].display_type,'line_note');
 assert.equal(saved.state,undefined);
});
test('confirmed PO updates metadata without altering financial lines',async()=>{
 let saved;
 const call=async(model,method,args)=>{
  assert.equal(model,'purchase.order');
  if(method==='search_read') return [{id:9,state:'purchase'}];
  saved=args.vals; return true;
 };
 await syncPurchaseOrder(call,{id:'P1',vendorId:'V1'});
 assert.equal(saved.order_line,undefined);
 assert.equal(saved.x_trucksphere_source_id,'P1');
});
test('editable note becomes product through replacement rather than forbidden type update',async()=>{
 let saved;
 const call=async(model,method,args)=>{
  if(method==='write'){saved=args.vals;return true;}
  if(model==='purchase.order')return [{id:9,state:'draft'}];
  if(model==='purchase.order.line')return [{id:10,x_trucksphere_line_id:'P1:0',display_type:'line_note'}];
  if(model==='uom.uom')return [{id:7,name:'Units'}];
  return [{id:42}];
 };
 await syncPurchaseOrder(call,{id:'P1',vendorId:'V1',materials:[{materialId:'M1',quantity:3}]});
 assert.deepEqual(saved.order_line.map(command=>command[0]),[2,0]);
});
