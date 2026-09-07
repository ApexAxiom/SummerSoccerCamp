import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { importSql } from '../migrate.mjs';
import { createStore } from '../store.mjs';
import core from '../../shared/core.js';
import worker, { deliverPending } from '../worker.mjs';

// Wrangler is pinned; use the exact simulator it uses rather than a second
// runtime version. All provider calls are intercepted inside this local test.
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve('wrangler/package.json'))('miniflare');
const camp = { id:'camp_local', title:'Local acceptance camp', trainingType:'group', startDate:'2026-06-15', endDate:'2026-06-18', startTime:'9:00 AM', endTime:'11:00 AM', location:'Local test field', ageMin:5, ageMax:12, capacity:2, notes:'Local fixtures only', status:'open', color:'green', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z' };
const env = { BACKEND_ENABLED:'true', ADMIN_TOKEN:'local-test-admin-only', STRIPE_SECRET_KEY:'sk_test_local_only', STRIPE_WEBHOOK_SECRET:'whsec_local_only', STRIPE_GROUP_PRICE_ID:'price_test_group', RESEND_API_KEY:'re_test_only', MAIL_FROM:'Local <local@example.invalid>', COACH_EMAIL:'coach@example.invalid', APP_URL:'https://www.noahscompany.com', ALLOWED_ORIGINS:'https://noahscompany.com,https://www.noahscompany.com' };
let mf, db, sessionSequence = 0, mailCalls = [], createCalls = [], failCreate = false, failMail = false;
const sessions = new Map();
async function provider(request) {
  const url = new URL(request.url);
  if (url.origin === 'https://api.stripe.com' && request.method === 'POST') {
    const params = new URLSearchParams(await request.text());
    const key = request.headers.get('idempotency-key');
    createCalls.push({key,params});
    if (failCreate) return Response.json({error:{message:'temporary',type:'api_error'}},{status:503});
    let session = [...sessions.values()].find(value => value.key === key);
    if (!session) {
      const id = `cs_test_local_${++sessionSequence}`;
      const quantity = Number(params.get('line_items[0][quantity]'));
      session = { id,key,url:`https://checkout.stripe.com/c/pay/${id}`,livemode:false, mode:'payment',status:'open',payment_status:'unpaid',
        client_reference_id:params.get('client_reference_id'),metadata:{group_id:params.get('metadata[group_id]'),camp_id:params.get('metadata[camp_id]')},
        amount_total:quantity*1000,currency:'usd',line_items:{data:[{quantity,price:{id:params.get('line_items[0][price]')}}],has_more:false} };
      sessions.set(id,session);
    }
    return Response.json(session);
  }
  if (url.origin === 'https://api.stripe.com' && request.method === 'GET') return Response.json(sessions.get(url.pathname.split('/').pop()) || {}, {status:sessions.has(url.pathname.split('/').pop())?200:404});
  if (url.origin === 'https://api.resend.com') {
    mailCalls.push({key:request.headers.get('idempotency-key'),body:await request.json()});
    return failMail ? Response.json({error:'temporary'},{status:503}) : Response.json({id:`mail_${mailCalls.length}`});
  }
  throw new Error(`Unexpected outbound request: ${url.origin}`);
}
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules:true, script:readFileSync(new URL('../dist/worker.js',import.meta.url),'utf8'),
    compatibilityDate:'2026-09-06',compatibilityFlags:['nodejs_compat'],bindings:env,d1Databases:{DB:'local-noah-acceptance'}, outboundService:provider }));
  db = await mf.getD1Database('DB');
  const schema=readFileSync(new URL('../migrations/0001_camps.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'');
  for (const statement of schema.split(/;\s*(?=(?:CREATE|PRAGMA)\b)/)) if(statement.trim()) await db.prepare(statement).run();
});
after(async () => { await mf?.dispose(); });

async function reset(capacity = 2) {
  failCreate=false; failMail=false; mailCalls=[]; createCalls=[]; sessions.clear();
  await db.exec('DELETE FROM email_deliveries; DELETE FROM webhook_receipts; DELETE FROM registrations; DELETE FROM signup_groups; DELETE FROM camps;');
  await db.prepare('INSERT INTO camps(id,capacity,status,payload) VALUES(?,?,?,?)').bind(camp.id,capacity,'open',JSON.stringify({...camp,capacity})).run();
}
const signup = n => ({ campId:camp.id,children:Array.from({length:n},(_,i)=>({camperName:`Local Child ${i}`,camperAge:8})), parentName:'Local Parent',parentEmail:'parent@example.invalid',parentPhone:'2815550100',emergencyName:'Local Emergency',emergencyPhone:'2815550101',medicalNotes:'Private local fixture',waiverAccepted:true });
async function request(path, options={}) {
  const {body,admin,origin,...rest}=options;
  return mf.dispatchFetch(`https://local.invalid${path}`,{...rest,headers:{...(body?{'content-type':'application/json'}:{}),...(admin?{authorization:`Bearer ${env.ADMIN_TOKEN}`} : {}),...(origin?{origin}:{}),...rest.headers},...(body?{body:JSON.stringify(body)}:{})});
}
async function checkout(n=1) { return request('/create-checkout-session',{method:'POST',body:signup(n)}); }
async function sendEvent(session,type='checkout.session.completed',id=`evt_test_${Math.random().toString(16).slice(2)}`,change={}) {
  const raw=JSON.stringify({id,type,livemode:false,data:{object:{...session,...change}}});
  const timestamp=Math.floor(Date.now()/1000);
  const signature=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
  return mf.dispatchFetch('https://local.invalid/stripe/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},body:raw});
}
async function mailSettled() {
  for (let i=0;i<100;i++) {
    const sending=await db.prepare("SELECT COUNT(*) n FROM email_deliveries WHERE state='sending'").first();
    const pending=await db.prepare("SELECT COUNT(*) n FROM email_deliveries WHERE state='pending' AND lease_until=0").first();
    if (!sending.n && !pending.n) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Local mail processing did not finish.');
}
async function withLocalProvider(action) {
  const saved=globalThis.fetch;
  globalThis.fetch=async(input,init)=>provider(new Request(input,init));
  try { return await action(); } finally {globalThis.fetch=saved;}
}

test('empty production-style database returns honest empty camps without seeding',async()=>{
  const response=await request('/camps');
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{camps:[]});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM camps').first()).n,0);
});
test('coach authorization, both production origins and private roster boundary',async()=>{
  await reset();
  assert.equal((await request('/admin/dashboard')).status,401);
  for(const origin of ['https://noahscompany.com','https://www.noahscompany.com']) {
    const response=await request('/camps',{origin});assert.equal(response.headers.get('access-control-allow-origin'),origin);
    assert.equal(JSON.stringify(await response.json()).includes('parentEmail'),false);
  }
  assert.equal((await request('/camps',{origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await request('/admin/dashboard',{admin:true})).status,200);
});
test('last seat racing requests commit exactly one complete registration',async()=>{
  await reset(1);
  const responses=await Promise.all([checkout(),checkout()]);
  assert.equal(responses.filter(x=>x.status===200).length,1);
  assert.ok(responses.some(x=>[400,409].includes(x.status)));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM registrations').first()).n,1);
  assert.equal((await db.prepare('SELECT SUM(child_count) n FROM signup_groups').first()).n,1);
});
test('D1 enforces the final seat with two stale caller snapshots',async()=>{
  await reset(1);
  const store=createStore(db);
  const stale={...camp,capacity:1};
  const {children}=core.validateSignup(signup(1),stale,[]);
  const results=await Promise.allSettled([store.reserveGroup(stale,children),store.reserveGroup(stale,children)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.statusCode,409);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM registrations').first()).n,1);
});
test('D1 rolls back a reserved group when its child insert fails',async()=>{
  await reset();await checkout();
  const child=await db.prepare('SELECT * FROM registrations').first();
  await assert.rejects(()=>db.batch([
    db.prepare("INSERT INTO signup_groups(id,camp_id,child_count,status,created_at,updated_at) VALUES('grp_atomic',?,1,'pending_checkout','2026-01-01','2026-01-01')").bind(camp.id),
    db.prepare("INSERT INTO registrations(id,group_id,camp_id,payload) VALUES(?,'grp_atomic',?,?)").bind(child.id,camp.id,child.payload),
  ]));
  assert.equal(await db.prepare("SELECT id FROM signup_groups WHERE id='grp_atomic'").first(),null);
});
test('multi-child reservation failure rolls back the complete group',async()=>{
  await reset(1);
  assert.equal((await checkout(2)).status,400);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM signup_groups').first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM registrations').first()).n,0);
});
test('oversize and non-object JSON requests fail before reserving seats',async()=>{
  await reset();
  assert.equal((await request('/create-checkout-session',{method:'POST',body:{payload:'x'.repeat(33000)}})).status,413);
  assert.equal((await mf.dispatchFetch('https://local.invalid/create-checkout-session',{method:'POST',body:'null'})).status,400);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM signup_groups').first()).n,0);
});
test('paid callbacks are idempotent across duplicate and distinct Stripe events',async()=>{
  await reset();assert.equal((await checkout(2)).status,200);
  const session=[...sessions.values()][0];session.status='complete';session.payment_status='paid';
  const responses=await Promise.all([sendEvent(session,undefined,'evt_same'),sendEvent(session,undefined,'evt_same'),sendEvent(session,'checkout.session.async_payment_succeeded','evt_other')]);
  assert.deepEqual(responses.map(x=>x.status),[200,200,200]);await mailSettled();
  const camps=await (await request('/camps')).json();assert.equal(camps.camps[0].paidCount,2);assert.equal(camps.camps[0].spotsLeft,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM webhook_receipts').first()).n,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM email_deliveries').first()).n,2);
  assert.equal(mailCalls.length,2);assert.equal(new Set(mailCalls.map(call=>call.key)).size,2);
  const status=await (await request(`/session-status?session_id=${session.id}`)).json();assert.equal(status.status,'paid');assert.equal(status.childCount,2);assert.equal(status.parentEmail,undefined);assert.equal(status.medicalNotes,undefined);
});
test('unpaid completion does not fulfill and expiration cannot demote paid',async()=>{
  await reset();await checkout();const session=[...sessions.values()][0];
  assert.equal((await sendEvent(session)).status,200);assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'checkout_started');
  session.status='complete';session.payment_status='paid';await sendEvent(session);await mailSettled();
  session.status='expired';await sendEvent(session,'checkout.session.expired');
  assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'paid');assert.equal(mailCalls.length,2);
});
test('duplicate expirations release once; late payment cannot oversell a replacement reservation',async()=>{
  await reset(1);await checkout();const old=[...sessions.values()][0];old.status='expired';
  await Promise.all([sendEvent(old,'checkout.session.expired'),sendEvent(old,'checkout.session.expired')]);
  assert.equal((await (await request('/camps')).json()).camps[0].spotsLeft,1);
  assert.equal((await checkout()).status,200);
  old.status='complete';old.payment_status='paid';assert.equal((await sendEvent(old)).status,200);
  assert.equal((await db.prepare('SELECT status FROM signup_groups WHERE stripe_session_id=?').bind(old.id).first()).status,'payment_review');
  assert.equal((await (await request('/camps')).json()).camps[0].spotsLeft,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM email_deliveries').first()).n,0);
});
test('late payment reacquires its available seat and remains paid on later expiry',async()=>{
  await reset(1);await checkout();const session=[...sessions.values()][0];session.status='expired';await sendEvent(session,'checkout.session.expired');
  session.status='complete';session.payment_status='paid';await sendEvent(session);await mailSettled();
  assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'paid');
  assert.equal((await (await request('/camps')).json()).camps[0].spotsLeft,0);
});
test('raw signature, Stripe price and amount verification reject forged fulfillment',async()=>{
  await reset();await checkout();const session=[...sessions.values()][0];session.payment_status='paid';session.status='complete';
  assert.equal((await mf.dispatchFetch('https://local.invalid/stripe/webhook',{method:'POST',body:'{}',headers:{'stripe-signature':'bad'}})).status,400);
  assert.equal((await sendEvent(session,undefined,undefined,{amount_total:1})).status,409);
  session.line_items.data[0].price.id='price_wrong';assert.equal((await sendEvent(session)).status,409);
  assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'checkout_started');
});
test('unknown imported group is retryable rather than silently acknowledged',async()=>{
  await reset();await checkout();const session=[...sessions.values()][0];
  assert.equal((await sendEvent(session,undefined,undefined,{client_reference_id:'grp_missing'})).status,503);
});
test('coach changes preserve reservations and cannot lower capacity beneath them',async()=>{
  await reset();await checkout(2);
  const response=await request(`/admin/camps/${camp.id}`,{method:'PATCH',admin:true,body:{capacity:1}});assert.equal(response.status,409);
  assert.equal((await request(`/admin/camps/${camp.id}`,{method:'PATCH',admin:true,body:{title:'Changed local title',status:'closed'}})).status,200);
  assert.equal((await checkout()).status,400);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM registrations').first()).n,2);
});
test('ambiguous Stripe failure preserves reservation and stable idempotency key',async()=>{
  await reset();failCreate=true;assert.equal((await checkout()).status,502);
  const group=await db.prepare('SELECT * FROM signup_groups').first();assert.equal(group.status,'pending_checkout');
  assert.equal(createCalls[0].key,`noah-checkout-${group.id}`);
  assert.equal((await (await request('/camps')).json()).camps[0].spotsLeft,1);
  failCreate=false;
  await db.prepare('UPDATE signup_groups SET created_at=? WHERE id=?').bind(new Date(Date.now()-240000).toISOString(),group.id).run();
  await withLocalProvider(()=>worker.scheduled({}, {...env,DB:db,STRIPE_GROUP_PRICE_ID:'price_new_for_later_signups'}));
  assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'checkout_started');
  assert.equal(createCalls[1].key,createCalls[0].key);
  assert.equal(createCalls[1].params.get('line_items[0][price]'),'price_test_group');
});
test('mail failure preserves paid status and durable retry evidence',async()=>{
  await reset();await checkout();failMail=true;const session=[...sessions.values()][0];session.status='complete';session.payment_status='paid';
  await sendEvent(session);await mailSettled();
  assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'paid');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM email_deliveries WHERE state='pending' AND last_error='provider_503'").first()).n,2);
  const dashboard=await (await request('/admin/dashboard',{admin:true})).json();assert.equal(dashboard.delivery.emailPending,2);
  const originalKeys=mailCalls.map(call=>call.key).sort();
  failMail=false;await db.prepare('UPDATE email_deliveries SET lease_until=0').run();
  await withLocalProvider(()=>deliverPending(createStore(db),{...env,DB:db}));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM email_deliveries WHERE state='sent'").first()).n,2);
  assert.deepEqual(mailCalls.slice(2).map(call=>call.key).sort(),originalKeys);
});
test('mail beyond provider idempotency window requires review without resending',async()=>{
  await reset();await checkout();failMail=true;const session=[...sessions.values()][0];session.status='complete';session.payment_status='paid';
  await sendEvent(session);await mailSettled();const count=mailCalls.length;
  await db.prepare('UPDATE email_deliveries SET lease_until=0,created_at=?').bind(Date.now()-24*3600000).run();
  failMail=false;await withLocalProvider(()=>deliverPending(createStore(db),{...env,DB:db}));
  assert.equal(mailCalls.length,count);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM email_deliveries WHERE state='delivery_unknown'").first()).n,2);
});
test('coach message uses only distinct paid parents and reports provider acceptance',async()=>{
  await reset();await checkout(2);const session=[...sessions.values()][0];session.status='complete';session.payment_status='paid';
  await sendEvent(session);await mailSettled();mailCalls=[];
  const response=await request(`/admin/camps/${camp.id}/message`,{method:'POST',admin:true,body:{subject:'Local schedule update',message:'Local test only'}});
  assert.deepEqual(await response.json(),{sent:1,total:1});assert.equal(mailCalls.length,1);assert.deepEqual(mailCalls[0].body.to,['parent@example.invalid']);
});
test('historical pending checkout is retained for reconciliation and never recreated',async()=>{
  await reset();
  const store=createStore(db);const {children}=core.validateSignup(signup(1),camp,[]);
  const group=await store.reserveGroup(camp,children);
  await db.prepare('UPDATE signup_groups SET created_at=? WHERE id=?').bind(new Date(Date.now()-240000).toISOString(),group.id).run();
  await withLocalProvider(()=>worker.scheduled({}, {...env,DB:db}));
  assert.equal(createCalls.length,0);assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'pending_checkout');
});
test('imported paid groups do not resend historical confirmations on replay',async()=>{
  await reset();await checkout();const session=[...sessions.values()][0];session.status='complete';session.payment_status='paid';
  await db.prepare("UPDATE signup_groups SET status='paid',fulfillment_event_id=NULL").run();
  await sendEvent(session);await mailSettled();
  assert.equal(mailCalls.length,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM email_deliveries').first()).n,0);
});
test('verified asynchronous payment failure releases once and cannot demote paid',async()=>{
  await reset(1);await checkout();const session=[...sessions.values()][0];session.status='complete';
  await sendEvent(session,'checkout.session.async_payment_failed');await sendEvent(session,'checkout.session.async_payment_failed');
  assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'checkout_failed');
  assert.equal((await (await request('/camps')).json()).camps[0].spotsLeft,1);
  session.payment_status='paid';await sendEvent(session,'checkout.session.async_payment_succeeded');await mailSettled();
  await sendEvent(session,'checkout.session.async_payment_failed');
  assert.equal((await db.prepare('SELECT status FROM signup_groups').first()).status,'paid');
});
test('migration rejects duplicate and inconsistent records and preserves empty data',()=>{
  assert.deepEqual(importSql({camps:[],registrations:[]}).counts,{camps:0,groups:0,registrations:0});
  assert.throws(()=>importSql({camps:[camp,camp],registrations:[]}),/Duplicate/);
  assert.throws(()=>importSql({camps:[{...camp,reservedCount:1}],registrations:[]}),/counters/);
  const result=importSql({camps:[camp],registrations:[]});assert.equal(result.counts.camps,1);assert.match(result.sql,/INSERT INTO camps/);
});
test('private snapshot SQL restores closed camps and every paid registration field in D1',async()=>{
  await reset();
  await db.prepare('DELETE FROM camps').run();
  const {children}=core.validateSignup(signup(2),camp,[]);
  const registrations=children.map((child,i)=>({...child,id:`reg_import_${i}`,groupId:'grp_import',status:'paid',createdAt:camp.createdAt,updatedAt:camp.updatedAt,waiverAcceptedAt:camp.createdAt,paidAt:camp.createdAt,stripeCheckoutSessionId:'cs_import',stripePaymentIntentId:'pi_import',stripeCustomerId:'cus_import',amountTotal:1000,currency:'usd'}));
  const source={camps:[{...camp,status:'closed',reservedCount:2,paidCount:2}],registrations};
  const prepared=importSql(source);await db.exec(prepared.sql);
  assert.deepEqual((await db.prepare('SELECT payload FROM registrations ORDER BY id').all()).results.map(row=>JSON.parse(row.payload)),registrations);
  assert.deepEqual((await createStore(db).listAllRegistrations()).sort((a,b)=>a.id.localeCompare(b.id)),registrations);
  assert.equal((await createStore(db).listCamps())[0].paidCount,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM email_deliveries').first()).n,0);
});
test('disabled Worker has no camp, checkout, webhook, or admin mutation path',async()=>{
  const disabled = new Miniflare(convertV4MiniflareOptions({modules:true,script:readFileSync(new URL('../dist/worker.js',import.meta.url),'utf8'),compatibilityDate:'2026-09-06',compatibilityFlags:['nodejs_compat'],bindings:{...env,BACKEND_ENABLED:'false'},d1Databases:{DB:'inert-local-test'},outboundService:()=>{throw new Error('Inert backend made an outbound call.');}}));
  try {
    assert.equal((await disabled.dispatchFetch('https://local.invalid/health')).status,200);
    for(const [path,method] of [['/camps','GET'],['/create-checkout-session','POST'],['/stripe/webhook','POST'],['/admin/dashboard','GET']]) assert.equal((await disabled.dispatchFetch(`https://local.invalid${path}`,{method})).status,503);
  } finally {await disabled.dispose();}
});
