// Private, explicit operator tool. It never imports into a provider or enables a
// Worker. Export refuses to run unless both actual AWS writers are stopped.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'amplify-d3qcyohuot5wl5-mai-soccerapilambda5CC9263E-3Ndxyfv5paV5';
const WEBHOOK = 'amplify-d3qcyohuot5wl5-ma-soccerstripewebhooklambd-ti8c6vxJUySh';
const prefix = 'amplify-d3qcyohuot5wl5-main-branch-1d3cb71a12-soccercampdata89B98ED0-1OEZBIKPJG4VA-';
const CAMPS = `${prefix}CampsD65B441C-1G3FVAWHP6DVE`;
const REGISTRATIONS = `${prefix}RegistrationsA6F76D76-SBX1238F050K`;
const sha = text => createHash('sha256').update(text).digest('hex');
const quote = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));

function decimal(value) {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) throw new Error('Invalid source number.');
  const [coefficient, exponent='0'] = value.toLowerCase().split('e');
  let digits=coefficient.replace('.','');
  let power=Number(exponent)-(coefficient.split('.')[1]?.length || 0);
  digits=BigInt(digits).toString();
  if (digits === '0') return '0';
  while (digits.endsWith('0')) { digits=digits.slice(0,-1); power++; }
  return `${digits}e${power}`;
}
function attribute(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) throw new Error('Malformed DynamoDB attribute.');
  if ('S' in value && typeof value.S === 'string') return value.S;
  if ('N' in value) {
    const number = Number(value.N);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)) || decimal(value.N) !== decimal(String(number))) throw new Error('Unsupported numeric precision in source data.');
    return number;
  }
  if ('BOOL' in value && typeof value.BOOL === 'boolean') return value.BOOL;
  if (value.NULL === true) return null;
  if (Array.isArray(value.L)) return value.L.map(attribute);
  if (value.M && typeof value.M === 'object') return Object.fromEntries(Object.entries(value.M).map(([key,v]) => [key, attribute(v)]));
  throw new Error('Unsupported DynamoDB attribute type; preserve the source and review its schema.');
}

export function decodeSnapshot(snapshot) {
  if (!Array.isArray(snapshot.camps) || !Array.isArray(snapshot.registrations)) throw new Error('Snapshot must contain camps and registrations arrays.');
  if (snapshot.format == null) return snapshot; // Existing local acceptance fixtures.
  if (snapshot.format !== 'noah-dynamodb-v1') throw new Error('Unknown private snapshot format.');
  const decode = items => items.map(item => Object.fromEntries(Object.entries(item).map(([name,value]) => [name,attribute(value)])));
  return {...snapshot,camps:decode(snapshot.camps),registrations:decode(snapshot.registrations)};
}

export function importSql(snapshot) {
  snapshot=decodeSnapshot(snapshot);
  const camps = new Map(snapshot.camps.map(camp => [camp.id, camp]));
  if (camps.size !== snapshot.camps.length) throw new Error('Duplicate source camp ID.');
  const groups = new Map();
  const registrationIds = new Set();
  for (const row of snapshot.registrations) {
    if (!row.id || !row.groupId || !camps.has(row.campId) || registrationIds.has(row.id)) throw new Error('Registration identity or camp linkage is invalid.');
    registrationIds.add(row.id);
    if (!groups.has(row.groupId)) groups.set(row.groupId, []);
    groups.get(row.groupId).push(row);
  }
  const sql = [];
  for (const camp of camps.values()) {
    if (!camp.id || !Number.isSafeInteger(camp.capacity) || camp.capacity < 1 || !['open','closed','archived'].includes(camp.status)) throw new Error('Camp needs manual reconciliation before import.');
    sql.push(`INSERT INTO camps(id,capacity,status,payload) VALUES(${quote(camp.id)},${camp.capacity},${quote(camp.status)},${quote(stable(camp))});`);
  }
  for (const [id, rows] of groups) {
    const first = rows[0];
    if (rows.length > 8 || rows.some(row => row.campId !== first.campId || row.status !== first.status ||
      row.stripeCheckoutSessionId !== first.stripeCheckoutSessionId || row.parentEmail !== first.parentEmail || row.trainingType !== first.trainingType) ||
      !['pending_checkout','checkout_started','paid','expired','checkout_failed'].includes(first.status)) throw new Error('A registration group needs manual reconciliation before import.');
    const payment = {};
    for (const key of ['paidAt','stripePaymentIntentId','stripeCustomerId','amountTotal','currency']) {
      if (first[key] !== undefined) payment[key] = first[key];
      if (rows.some(row => stable(row[key]) !== stable(first[key]))) throw new Error('Mixed payment facts within a group.');
    }
    sql.push(`INSERT INTO signup_groups(id,camp_id,child_count,status,stripe_session_id,created_at,updated_at,payment) VALUES(${quote(id)},${quote(first.campId)},${rows.length},${quote(first.status)},${quote(first.stripeCheckoutSessionId)},${quote(first.createdAt)},${quote(first.updatedAt)},${quote(stable(payment))});`);
    for (const row of rows) sql.push(`INSERT INTO registrations(id,group_id,camp_id,payload) VALUES(${quote(row.id)},${quote(id)},${quote(row.campId)},${quote(stable(row))});`);
  }
  for (const camp of camps.values()) {
    const regs = snapshot.registrations.filter(row => row.campId === camp.id);
    const active = regs.filter(row => ['pending_checkout','checkout_started','paid'].includes(row.status)).length;
    const paid = regs.filter(row => row.status === 'paid').length;
    if (active > camp.capacity || (camp.reservedCount != null && camp.reservedCount !== active) ||
        (camp.paidCount != null && camp.paidCount !== paid)) throw new Error('Source capacity counters disagree with registrations; reconcile before import.');
  }
  return { sql: sql.join('\n')+'\n', counts: { camps: camps.size, groups: groups.size, registrations: registrationIds.size } };
}

// The caller supplies a local or private provider SELECT adapter. No writes.
export async function verifyD1(snapshot, query) {
  const expected=decodeSnapshot(snapshot);
  const {counts}=importSql(snapshot);
  const read=async table => {
    const all=[]; let page;
    do {
      page=await query(`SELECT * FROM ${table} ORDER BY id LIMIT 500 OFFSET ${all.length}`);
      all.push(...page);
    } while(page.length===500);
    return all;
  };
  for (const table of ['camps','registrations']) {
    const actual=await read(table);
    const source=[...expected[table]].sort((a,b)=>a.id.localeCompare(b.id));
    const payloads=actual.map(row=>JSON.parse(row.payload)).sort((a,b)=>a.id.localeCompare(b.id));
    if (stable(payloads)!==stable(source)) throw new Error(`D1 ${table} private payload read-back differs.`);
    for (const row of actual) {
      const payload=JSON.parse(row.payload);
      if (row.id!==payload.id || (table==='camps' && (row.capacity!==payload.capacity || row.status!==payload.status)) ||
          (table==='registrations' && (row.group_id!==payload.groupId || row.camp_id!==payload.campId))) throw new Error(`D1 ${table} indexed fields differ.`);
    }
  }
  const groups=await read('signup_groups');
  if (groups.length!==counts.groups) throw new Error('D1 group count differs.');
  for (const group of groups) {
    const rows=expected.registrations.filter(row=>row.groupId===group.id), first=rows[0];
    const payment=Object.fromEntries(['paidAt','stripePaymentIntentId','stripeCustomerId','amountTotal','currency'].filter(key=>first?.[key]!==undefined).map(key=>[key,first[key]]));
    if (!first || group.child_count!==rows.length || group.camp_id!==first.campId || group.status!==first.status ||
      group.stripe_session_id!==(first.stripeCheckoutSessionId??null) || group.created_at!==first.createdAt || group.updated_at!==first.updatedAt ||
      stable(JSON.parse(group.payment))!==stable(payment) || stable(JSON.parse(group.checkout_params))!=='{}' || group.fulfillment_event_id!==null) throw new Error('D1 group payment or lifecycle facts differ.');
  }
  for (const table of ['webhook_receipts','email_deliveries']) if ((await query(`SELECT COUNT(*) n FROM ${table}`))[0].n!==0) throw new Error('Imported snapshot unexpectedly contains new fulfillment activity.');
  return {counts,privatePayloadSha256:sha(stable({camps:expected.camps,registrations:expected.registrations})),verified:true};
}

async function exportFrozen(destination) {
  const aws = args => JSON.parse(execFileSync('aws', [...args, '--region','us-east-1','--output','json','--no-cli-pager'], { encoding: 'utf8', maxBuffer: 16*1024*1024, stdio: ['ignore','pipe','pipe'] }));
  const gh = args => JSON.parse(execFileSync('gh', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  if (aws(['sts','get-caller-identity']).Account!=='405894865970') throw new Error('Unexpected source AWS account.');
  const deploymentFence=()=>{
    const branch=aws(['amplify','get-branch','--app-id','d3qcyohuot5wl5','--branch-name','main']).branch;
    const jobs=aws(['amplify','list-jobs','--app-id','d3qcyohuot5wl5','--branch-name','main']).jobSummaries;
    if(branch.enableAutoBuild || branch.enablePullRequestPreview || jobs.some(job=>!['SUCCEED','FAILED','CANCELLED'].includes(job.status))) throw new Error('Amplify deployment consumer is not frozen.');
    for(const name of ['deploy-cloudflare-backend.yml','deploy-cloudflare-static.yml']) {
      const workflow=gh(['api',`repos/ApexAxiom/SummerSoccerCamp/actions/workflows/${name}`]);
      const pages=gh(['api','--paginate','--slurp',`repos/ApexAxiom/SummerSoccerCamp/actions/workflows/${name}/runs?per_page=100`]);
      if(workflow.state!=='disabled_manually' || pages.some(page=>page.workflow_runs.some(run=>run.status!=='completed'))) throw new Error('Cloudflare release consumers must be disabled and drained before export.');
    }
  };
  deploymentFence();
  const functions=[];
  const fence = () => {
    let longestTimeout = 0;
    for (const fn of [API,WEBHOOK]) {
      if (aws(['lambda','get-function-concurrency','--function-name',fn]).ReservedConcurrentExecutions !== 0) throw new Error('Both Noah Lambda writers must have reserved concurrency zero before export.');
      const config = aws(['lambda','get-function-configuration','--function-name',fn]);
      longestTimeout = Math.max(longestTimeout, Number(config.Timeout));
      const vars = config.Environment?.Variables;
      if (vars?.CAMPS_TABLE !== CAMPS || vars?.REGISTRATIONS_TABLE !== REGISTRATIONS) throw new Error('Source table mapping changed; stop and update the reviewed migration manifest.');
      const previous=functions.find(item=>item.name===fn);
      if(previous && previous.revisionId!==config.RevisionId) throw new Error('Source function configuration changed during export.');
      if(!previous) functions.push({name:fn,codeSha256:config.CodeSha256,revisionId:config.RevisionId,timeout:config.Timeout,reservedConcurrency:0});
    }
    return longestTimeout;
  };
  const timeout = fence();
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 900) throw new Error('Source function timeout could not be verified.');
  // Existing invocations can finish after concurrency becomes zero. Let the OS
  // wait once for their actual maximum timeout, then recheck before scanning.
  await new Promise(done => setTimeout(done, (timeout+2)*1000));
  fence();
  const startedAt = new Date().toISOString();
  function scan(table) {
    const items = [];
    let key;
    do {
      const page = aws(['dynamodb','scan','--table-name',table,'--consistent-read','--limit','500','--no-paginate',
        ...(key ? ['--exclusive-start-key', JSON.stringify(key)] : [])]);
      items.push(...(page.Items || []));
      key = page.LastEvaluatedKey;
    } while (key && Object.keys(key).length);
    return items.sort((a,b) => a.id.S.localeCompare(b.id.S));
  }
  const tables=[CAMPS,REGISTRATIONS].map(table=>aws(['dynamodb','describe-table','--table-name',table]).Table);
  const snapshot = { format:'noah-dynamodb-v1', source: { account:'405894865970',region:'us-east-1',fenced:true,api:API, webhook:WEBHOOK, camps:CAMPS, registrations:REGISTRATIONS,functions,tables, startedAt, capturedAt:new Date().toISOString() }, camps:scan(CAMPS), registrations:scan(REGISTRATIONS) };
  fence(); deploymentFence();
  snapshot.source.capturedAt = new Date().toISOString();
  const raw = stable(snapshot)+'\n';
  // Preserve original typed values even if conversion needs manual reconciliation.
  writeFileSync(destination, raw, { flag:'wx', mode:0o600 });
  const { counts } = importSql(snapshot);
  return { counts, sha256:sha(raw) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, input, output] = process.argv.slice(2);
    if (mode === 'export' && input && !output) console.log(JSON.stringify(await exportFrozen(resolve(input))));
    else if (mode === 'sql' && input && output) {
      const raw = readFileSync(input,'utf8');
      const { sql,counts } = importSql(JSON.parse(raw));
      writeFileSync(output,sql,{flag:'wx',mode:0o600});
      console.log(JSON.stringify({counts,sourceSha256:sha(raw),sqlSha256:sha(sql)}));
    } else if(mode==='verify' && input && output) {
      const readback=JSON.parse(readFileSync(output,'utf8'));
      const query=async sql=>{
        const table=sql.match(/ FROM (\w+)/)[1];
        if(!Array.isArray(readback[table])) throw new Error('Incomplete private D1 read-back.');
        return sql.includes('COUNT(*)') ? [{n:readback[table].length}] : readback[table].slice(Number(sql.match(/OFFSET (\d+)/)[1]),Number(sql.match(/OFFSET (\d+)/)[1])+500);
      };
      console.log(JSON.stringify(await verifyD1(JSON.parse(readFileSync(input,'utf8')),query)));
    } else throw new Error('Usage: node migrate.mjs export PRIVATE_SNAPSHOT.json | sql PRIVATE_SNAPSHOT.json PRIVATE_IMPORT.sql | verify PRIVATE_SNAPSHOT.json PRIVATE_D1_READBACK.json');
  } catch (error) {
    // Never print AWS error payloads or private source records.
    console.error(error.status != null ? 'Provider read failed; source was not changed.' : error instanceof SyntaxError || error instanceof TypeError ? 'Invalid private snapshot or provider response; no source was changed.' : error.message);
    process.exitCode=1;
  }
}
