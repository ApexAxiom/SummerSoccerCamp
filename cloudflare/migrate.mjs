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

function attribute(value) {
  if ('S' in value) return value.S;
  if ('N' in value) {
    const number = Number(value.N);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) throw new Error('Unsupported numeric precision in source data.');
    return number;
  }
  if ('BOOL' in value) return value.BOOL;
  if ('NULL' in value) return null;
  if ('L' in value) return value.L.map(attribute);
  if ('M' in value) return Object.fromEntries(Object.entries(value.M).map(([key,v]) => [key, attribute(v)]));
  throw new Error('Unsupported DynamoDB attribute type; preserve the source and review its schema.');
}

export function importSql(snapshot) {
  if (!Array.isArray(snapshot.camps) || !Array.isArray(snapshot.registrations)) throw new Error('Snapshot must contain camps and registrations arrays.');
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

async function exportFrozen(destination) {
  const aws = args => JSON.parse(execFileSync('aws', [...args, '--region','us-east-1','--output','json','--no-cli-pager'], { encoding: 'utf8', maxBuffer: 16*1024*1024, stdio: ['ignore','pipe','pipe'] }));
  const fence = () => {
    let longestTimeout = 0;
    for (const fn of [API,WEBHOOK]) {
      if (aws(['lambda','get-function-concurrency','--function-name',fn]).ReservedConcurrentExecutions !== 0) throw new Error('Both Noah Lambda writers must have reserved concurrency zero before export.');
      const config = aws(['lambda','get-function-configuration','--function-name',fn]);
      longestTimeout = Math.max(longestTimeout, Number(config.Timeout));
      const vars = config.Environment?.Variables;
      if (vars?.CAMPS_TABLE !== CAMPS || vars?.REGISTRATIONS_TABLE !== REGISTRATIONS) throw new Error('Source table mapping changed; stop and update the reviewed migration manifest.');
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
    return items.map(item => Object.fromEntries(Object.entries(item).map(([name,v]) => [name,attribute(v)]))).sort((a,b) => a.id.localeCompare(b.id));
  }
  const snapshot = { source: { api:API, webhook:WEBHOOK, camps:CAMPS, registrations:REGISTRATIONS, startedAt, capturedAt:new Date().toISOString() }, camps:scan(CAMPS), registrations:scan(REGISTRATIONS) };
  fence();
  snapshot.source.capturedAt = new Date().toISOString();
  const { counts } = importSql(snapshot);
  const raw = stable(snapshot)+'\n';
  writeFileSync(destination, raw, { flag:'wx', mode:0o600 });
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
    } else throw new Error('Usage: node migrate.mjs export PRIVATE_SNAPSHOT.json | sql PRIVATE_SNAPSHOT.json PRIVATE_IMPORT.sql');
  } catch (error) {
    // Never print AWS error payloads or private source records.
    console.error(error.status != null ? 'AWS export failed; source was not changed.' : error.message);
    process.exitCode=1;
  }
}
