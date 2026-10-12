import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleApi, reservationGuard } from '../lib/commerce/api.ts';
import { encrypt, decrypt, hmac } from '../lib/commerce/security.ts';
class Query {
    constructor(public database: DatabaseSync, public sql: string, public values: any[] = []) {
    }
    bind(...values: any[]) {
        return new Query(this.database, this.sql, values);
    }
    async first() {
        return this.database.prepare(this.sql).get(...this.values) || null;
    }
    async all() {
        return { results: this.database.prepare(this.sql).all(...this.values) };
    }
    async run() {
        const r = this.database.prepare(this.sql).run(...this.values);
        return { success: true, meta: { changes: Number(r.changes) } };
    }
    execute() {
        const statement = this.database.prepare(this.sql);
        if (statement.columns().length) {
            const results = statement.all(...this.values);
            return { results, meta: { changes: Number(this.database.prepare('SELECT changes() AS n').get()!.n) } };
        }
        const result = statement.run(...this.values);
        return { results: [], meta: { changes: Number(result.changes) } };
    }
}
class DB {
    raw = new DatabaseSync(':memory:');
    constructor() {
        this.raw.exec('PRAGMA foreign_keys=ON');
        for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort())
            this.raw.exec(readFileSync('drizzle/' + file, 'utf8'));
    }
    prepare(sql: string) {
        return new Query(this.raw, sql);
    }
    async batch(queries: Query[]) {
        this.raw.exec('BEGIN');
        try {
            const results = queries.map(q => q.execute());
            this.raw.exec('COMMIT');
            return results;
        }
        catch (e) {
            this.raw.exec('ROLLBACK');
            throw e;
        }
    }
}
async function setup(demo = true) {
    const db = new DB(), env: any = { DB: db, DEMO_MODE: demo ? 'true' : 'false', INVENTORY_KEY: 'a'.repeat(64), BOOTSTRAP_TOKEN: 'test-setup-token' };
    let cookie = '', csrf = '';
    async function req(path: string, b?: any, extra: Record<string, string> = {}) {
        const method = b === undefined ? 'GET' : 'POST';
        const r = await handleApi(new Request('https://store.test/api/' + path, { method, headers: { origin: 'https://store.test', ...(b === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...extra }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }), env);
        const d = await r.json() as any;
        if (r.headers.get('set-cookie'))
            cookie = r.headers.get('set-cookie')!.split(';')[0];
        if (d.csrf)
            csrf = d.csrf;
        return { r, d };
    }
    return { db, env, req };
}
const orderBody = (id: string, q = 1) => ({ contact: 'buyer@example.test', acceptedTerms: true, items: [{ id, quantity: q }], total: 1, price: 1 });
test('production setup is protected, one-time, and administrator sessions are secured', async () => {
    const { req } = await setup(false);
    assert.equal((await req('auth/setup', { username: 'owner', password: 'long-password-123', token: 'wrong' })).r.status, 403);
    const r = await req('auth/setup', { username: 'owner', password: 'long-password-123', token: 'test-setup-token' });
    assert.equal(r.r.status, 200);
    assert.match(r.r.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await req('auth/me')).d.role, 'owner');
    assert.equal((await req('auth/setup', { username: 'other', password: 'long-password-123', token: 'test-setup-token' })).r.status, 409);
    assert.equal((await req('auth/demo', {})).r.status, 403);
});
test('orders use server prices, reserve unique stock, and cancellation releases it', async () => {
    const { req, db } = await setup();
    const { d: catalog } = await req('catalog');
    const p = catalog.products[0];
    const a = await req('orders', orderBody(p.id));
    assert.equal(a.r.status, 201);
    assert.equal(a.d.total, p.price);
    const b = await req('orders', orderBody(p.id));
    assert.equal(b.r.status, 409);
    assert.equal(db.raw.prepare('SELECT count(*) AS n FROM orders').get()!.n, 1);
    assert.equal((await req('orders/lookup', { id: a.d.id, secret: 'incorrect' })).r.status, 404);
    assert.equal((await req('orders/cancel', { id: a.d.id, secret: a.d.secret })).r.status, 200);
    assert.equal((await req('orders', orderBody(p.id))).r.status, 201);
});
test('competing reservations fail atomically even after both requests read available stock', async () => {
    const { req, db } = await setup();
    const { d: catalog } = await req('catalog');
    const p = catalog.products[0];
    const create = (id: string) => [db.prepare("INSERT INTO orders(id,lookup_hash,contact,total,status,ready,demo,created_at,expires_at) VALUES(?,'hash','contact',?,'pending',0,1,1,9999999999999)").bind(id, p.price), db.prepare('INSERT INTO order_items VALUES(?,?,?,?,?,1)').bind(id + '-line', id, p.id, p.name, p.price), db.prepare("UPDATE inventory SET status='reserved',order_id=? WHERE id IN(SELECT id FROM inventory WHERE product_id=? AND status='available' LIMIT 1)").bind(id, p.id), ...reservationGuard(db as any, id) as unknown as Query[], db.prepare('UPDATE orders SET ready=1 WHERE id=?').bind(id)];
    await db.batch(create('FIRST'));
    await assert.rejects(db.batch(create('SECOND')), /CHECK constraint/);
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM orders WHERE id='SECOND'").get()!.n, 0);
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM inventory WHERE order_id='FIRST'").get()!.n, 1);
});
test('encrypted inventory, deduplication, fulfillment and idempotency work', async () => {
    const { req, db } = await setup();
    await req('auth/demo', {});
    const p = (await req('admin/products')).d.products[0];
    const imported = await req('admin/inventory', { product_id: p.id, codes: 'SECRET-ONE\nSECRET-ONE\nSECRET-TWO' });
    assert.equal(imported.d.imported, 2);
    assert.equal(imported.d.skipped, 1);
    const stored = db.raw.prepare('SELECT ciphertext FROM inventory WHERE product_id=?').all(p.id);
    assert.ok(stored.every(r => !String(r.ciphertext).includes('SECRET')));
    const order = await req('orders', orderBody(p.id, 2));
    assert.equal(order.r.status, 201);
    const confirm = { id: order.d.id, reference: 'payment-001', reason: '已核对真实到账记录' };
    assert.equal((await req('admin/orders', confirm)).r.status, 200);
    assert.equal((await req('admin/orders', confirm)).d.idempotent, true);
    assert.equal((await req('admin/orders', { ...confirm, reference: 'different' })).r.status, 409);
    const delivery = await req('orders/lookup', { id: order.d.id, secret: order.d.secret });
    assert.equal(delivery.d.status, 'fulfilled');
    assert.equal(delivery.d.delivery.length, 2);
    assert.equal((await req('payments/create', { id: order.d.id, secret: order.d.secret })).r.status, 503);
});
test('expired orders release stock and cannot be paid or fulfilled', async () => {
    const { req, db } = await setup();
    await req('auth/demo', {});
    const p = (await req('catalog')).d.products[0];
    const order = await req('orders', orderBody(p.id));
    db.raw.prepare('UPDATE orders SET expires_at=0 WHERE id=?').run(order.d.id);
    const result = await req('orders/lookup', { id: order.d.id, secret: order.d.secret });
    assert.equal(result.d.status, 'expired');
    assert.equal((await req('catalog')).d.products.find((x: any) => x.id === p.id).stock, 1);
    assert.equal((await req('admin/orders', { id: order.d.id, reference: 'expired-payment', reason: '已核对付款记录' })).r.status, 409);
});
test('authorization, CSRF and origin checks reject unauthorized writes', async () => {
    const { req } = await setup();
    assert.equal((await req('admin/settings')).r.status, 401);
    await req('auth/demo', {});
    assert.equal((await req('admin/settings', { brand: 'evil' }, { 'x-csrf-token': 'wrong' })).r.status, 403);
    assert.equal((await req('admin/settings', { brand: 'evil' }, { origin: 'https://attacker.test' })).r.status, 403);
    await req('admin/staff', { username: 'support1', password: 'secure-password-123', role: 'support' });
    await req('auth/logout', {});
    await req('auth/login', { username: 'support1', password: 'secure-password-123' });
    assert.equal((await req('admin/products')).r.status, 403);
    assert.equal((await req('admin/orders', { id: 'x', reference: 'x', reason: 'test reason' })).r.status, 403);
    assert.equal((await req('admin/orders')).r.status, 200);
});
test('refund records preserve delivered inventory and are audited', async () => {
    const { req, db } = await setup();
    await req('auth/demo', {});
    const p = (await req('catalog')).d.products[0];
    const o = (await req('orders', orderBody(p.id))).d;
    await req('admin/orders', { id: o.id, reference: 'pay', reason: '确认真实到账记录' });
    assert.equal((await req('admin/orders', { id: o.id, reference: 'refund', reason: '已在支付平台退款', action: 'refund' })).r.status, 200);
    assert.equal((await req('orders/lookup', { id: o.id, secret: o.secret })).d.status, 'refunded');
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM inventory WHERE order_id=? AND status='delivered'").get(o.id)!.n, 1);
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM audits WHERE action='order.refund'").get()!.n, 1);
});
test('tickets verify order ownership and persist support replies', async () => {
    const { req } = await setup();
    const p = (await req('catalog')).d.products[0];
    const o = (await req('orders', orderBody(p.id))).d;
    assert.equal((await req('tickets', { orderId: o.id, secret: 'wrong', subject: 'question', message: 'Need some help' })).r.status, 404);
    const t = await req('tickets', { orderId: o.id, secret: o.secret, subject: '使用问题', message: '请帮助我了解使用方法' });
    assert.equal(t.r.status, 201);
    await req('auth/demo', {});
    await req('admin/tickets', { id: t.d.id, reply: '已协助处理', closed: true });
    const result = await req('orders/lookup', { id: o.id, secret: o.secret });
    assert.equal(result.d.tickets[0].reply, '已协助处理');
    assert.equal(result.d.tickets[0].status, 'closed');
});
test('HMAC callbacks validate timestamp, currency, amount and transaction uniqueness', async () => {
    const { req, env } = await setup();
    await req('auth/demo', {});
    env.PAYMENT_PROVIDER = 'custom-hmac';
    env.PAYMENT_WEBHOOK_SECRET = 'test-payment-secret';
    const p = (await req('catalog')).d.products[0];
    await req('admin/inventory', { product_id: p.id, codes: 'SECOND-CODE' });
    const o = (await req('orders', orderBody(p.id))).d;
    const send = async (b: any, timestamp = String(Math.floor(Date.now() / 1000))) => req('payments/webhook', b, { 'x-payment-timestamp': timestamp, 'x-payment-signature': await hmac(timestamp + '.' + JSON.stringify(b), env.PAYMENT_WEBHOOK_SECRET) });
    const payload = { orderId: o.id, status: 'paid', currency: 'CNY', amount: o.total, transactionId: 'tx-unique' };
    assert.equal((await send(payload, '1000000000')).r.status, 401);
    assert.equal((await send({ ...payload, amount: 1 })).r.status, 400);
    assert.equal((await send(payload)).r.status, 200);
    assert.equal((await send(payload)).d.idempotent, true);
    const second = (await req('orders', orderBody(p.id))).d;
    assert.equal((await send({ ...payload, orderId: second.id })).r.status, 409);
    assert.equal((await req('orders/lookup', { id: second.id, secret: second.secret })).d.status, 'pending');
});
test('AES encryption authenticates each product context', async () => {
    const key = 'a'.repeat(64);
    const cipher = await encrypt('secret-code', key, 'sku-a');
    assert.equal(await decrypt(cipher, key, 'sku-a'), 'secret-code');
    await assert.rejects(decrypt(cipher, key, 'sku-b'));
});
