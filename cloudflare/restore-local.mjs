// Rehearse the real private export in an isolated, nonpersistent D1 database.
// The simulator has no secrets, remote bindings, schedules or outbound access.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { importSql, verifyD1 } from './migrate.mjs';
const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler/package.json'))('miniflare');
let mf;
try {
  if(process.argv.length!==3) throw new Error('A private snapshot path is required.');
  const snapshot=JSON.parse(readFileSync(process.argv[2],'utf8'));
  if(snapshot.format!=='noah-dynamodb-v1') throw new Error('An original typed DynamoDB snapshot is required.');
  const prepared=importSql(snapshot);
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null,{status:503})}}',
    compatibilityDate:'2026-09-06',d1Databases:{DB:'noah-isolated-restore'},outboundService:()=>{throw new Error('Isolated restore cannot contact a provider.');}}));
  const db=await mf.getD1Database('DB');
  const schema=readFileSync(new URL('./migrations/0001_camps.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'');
  for(const statement of schema.split(/;\s*(?=(?:CREATE|PRAGMA)\b)/)) if(statement.trim()) await db.prepare(statement).run();
  const inserts=prepared.sql.split('\n').filter(Boolean).map(sql=>db.prepare(sql));
  if(inserts.length) await db.batch(inserts);
  console.log(JSON.stringify({...await verifyD1(snapshot,async sql=>(await db.prepare(sql).all()).results),isolated:true,providerWrites:false}));
} catch {
  console.error('Private isolated restore failed; no provider was contacted and no source was changed.');
  process.exitCode=1;
} finally {await mf?.dispose();}
