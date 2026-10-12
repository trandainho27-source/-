import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync,readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare}=wranglerRequire('miniflare');
const files=readdirSync('dist/server',{recursive:true}).filter(f=>f.endsWith('.js')||f.endsWith('.mjs'));
files.sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
const mf=new Miniflare({modules:files.map(f=>({type:'ESModule',path:resolve('dist/server',f)})),modulesRoot:resolve('dist/server'),compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'worker-test-db'},bindings:{DEMO_MODE:'true',INVENTORY_KEY:'b'.repeat(64)},assets:{directory:resolve('dist/client'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true}},cf:false});
try{
 const db=await mf.getD1Database('DB');
 for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()){
  for(const sql of readFileSync('drizzle/'+file,'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 }
 const request=async(path,body,cookie='',csrf='')=>mf.dispatchFetch('https://store.test'+path,{method:body===undefined?'GET':'POST',headers:{origin:'https://store.test',...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie,'x-csrf-token':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 for(const path of ['/','/orders','/help','/admin']){const response=await request(path);assert.equal(response.status,200,`${path} should render`);assert.match(await response.text(),/重启|RESTART/);}
 const catalogResponse=await request('/api/catalog');assert.equal(catalogResponse.status,200);const catalog=await catalogResponse.json();assert.equal(catalog.products.length,12);
 const login=await request('/api/auth/demo',{});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf;
 const ordered=await request('/api/orders',{contact:'workerd-smoke@test.invalid',acceptedTerms:true,items:[{id:catalog.products[0].id,quantity:1}]});assert.equal(ordered.status,201);const order=await ordered.json();
 const confirmed=await request('/api/admin/orders',{id:order.id,reference:'smoke-001',reason:'演示验证，非真实收款'},cookie,csrf);assert.equal(confirmed.status,200);
 const delivered=await request('/api/orders/lookup',{id:order.id,secret:order.secret});assert.equal(delivered.status,200);const result=await delivered.json();assert.equal(result.status,'fulfilled');assert.equal(result.delivery.length,1);
 console.log('Cloudflare workerd verification passed: 4 SSR routes, D1 migrations, catalog, session, order, encrypted fulfillment.');
}finally{await mf.dispose();}
