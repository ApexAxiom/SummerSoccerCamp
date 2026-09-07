import core from '../shared/core.js';

const ACTIVE = "'pending_checkout','checkout_started','paid'";
const nowIso = () => new Date().toISOString();
const decode = row => row ? JSON.parse(row.payload) : null;
const encode = JSON.stringify;

export function createStore(db) {
  const stmt = (sql, ...args) => db.prepare(sql).bind(...args);
  const rows = async (sql, ...args) => (await stmt(sql, ...args).all()).results;
  const shape = row => ({ ...decode(row), status: row.status, updatedAt: row.updated_at,
    ...(row.stripe_session_id ? { stripeCheckoutSessionId: row.stripe_session_id } : {}),
    ...JSON.parse(row.payment) });
  const joined = `SELECT r.payload,g.status,g.updated_at,g.stripe_session_id,g.payment
    FROM registrations r JOIN signup_groups g ON r.group_id=g.id`;
  const store = {
    async getCamp(id) { return decode(await stmt('SELECT payload FROM camps WHERE id=?', id).first()); },
    async listCamps() {
      return (await rows(`SELECT c.payload,
        COALESCE(SUM(CASE WHEN g.status IN (${ACTIVE}) THEN g.child_count ELSE 0 END),0) reserved_count,
        COALESCE(SUM(CASE WHEN g.status='paid' THEN g.child_count ELSE 0 END),0) paid_count
        FROM camps c LEFT JOIN signup_groups g ON g.camp_id=c.id GROUP BY c.id`))
        .map(row => ({ ...decode(row), reservedCount: row.reserved_count, paidCount: row.paid_count }));
    },
    async putCamp(camp, create = false) {
      try {
        if (create) await stmt('INSERT INTO camps(id,capacity,status,payload) VALUES(?,?,?,?)', camp.id, camp.capacity, camp.status, encode(camp)).run();
        else await stmt('UPDATE camps SET capacity=?,status=?,payload=? WHERE id=?', camp.capacity, camp.status, encode(camp), camp.id).run();
      } catch (error) { capacityError(error); }
      return camp;
    },
    async reserveGroup(camp, children, checkoutParams = {}) {
      const id = core.createGroupId();
      const now = nowIso();
      const registrations = children.map(child => ({ ...child, id: core.createRegistrationId(), groupId: id,
        status: 'pending_checkout', createdAt: now, updatedAt: now, waiverAcceptedAt: now }));
      try {
        await db.batch([
          stmt(`INSERT INTO signup_groups(id,camp_id,child_count,status,created_at,updated_at,checkout_params)
            SELECT ?,id,?,'pending_checkout',?,?,? FROM camps WHERE id=? AND status='open'`, id, children.length, now, now, encode(checkoutParams), camp.id),
          ...registrations.map(row => stmt('INSERT INTO registrations(id,group_id,camp_id,payload) VALUES(?,?,?,?)', row.id, id, camp.id, encode(row))),
        ]);
      } catch (error) {
        if (String(error?.message).includes('FOREIGN KEY')) throw core.createHttpError('This camp is no longer open for signup.', 409);
        capacityError(error);
      }
      return { id, parentEmail: registrations[0].parentEmail, registrations, checkout_params: encode(checkoutParams) };
    },
    async group(id) {
      const group = await stmt('SELECT * FROM signup_groups WHERE id=?', id).first();
      if (!group) return null;
      const registrations = await store.groupRows(id);
      return { ...group, id, registrations, parentEmail: registrations[0]?.parentEmail };
    },
    async groupRows(id) { return (await rows(`${joined} WHERE g.id=? ORDER BY r.id`, id)).map(shape); },
    async attachSession(groupId, session) {
      await stmt(`UPDATE signup_groups SET status=CASE WHEN status='pending_checkout' THEN 'checkout_started' ELSE status END,
        stripe_session_id=COALESCE(stripe_session_id,?), updated_at=?
        WHERE id=? AND (stripe_session_id IS NULL OR stripe_session_id=?)`, session.id, nowIso(), groupId, session.id).run();
      const group = await store.group(groupId);
      if (group?.stripe_session_id !== session.id) throw core.createHttpError('Checkout session conflict; contact the coach.', 409);
    },
    async releaseGroup(id, status, sessionId) {
      await stmt(`UPDATE signup_groups SET status=?,updated_at=? WHERE id=?
        AND status IN ('pending_checkout','checkout_started')
        AND (? IS NULL OR stripe_session_id IS NULL OR stripe_session_id=?)`, status, nowIso(), id, sessionId || null, sessionId || null).run();
    },
    async applyWebhook(event, group, messages) {
      const session = event.data.object;
      const paid = ['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type);
      const now = nowIso();
      const payment = { paidAt: now, stripePaymentIntentId: session.payment_intent || null,
        stripeCustomerId: session.customer || null, amountTotal: Math.round(session.amount_total / group.child_count), currency: session.currency };
      const statements = [stmt('INSERT OR IGNORE INTO webhook_receipts(id,session_id,event_type,received_at) VALUES(?,?,?,?)', event.id, session.id, event.type, now)];
      if (paid) {
        statements.push(stmt(`UPDATE signup_groups SET status=CASE WHEN child_count + COALESCE((SELECT SUM(child_count)
          FROM signup_groups other WHERE other.camp_id=signup_groups.camp_id AND other.id!=signup_groups.id
          AND other.status IN (${ACTIVE})),0) <= (SELECT capacity FROM camps WHERE id=camp_id)
          THEN 'paid' ELSE 'payment_review' END, stripe_session_id=?,payment=?,updated_at=?,fulfillment_event_id=?
          WHERE id=? AND status IN ('pending_checkout','checkout_started','expired','checkout_failed')
          AND (stripe_session_id IS NULL OR stripe_session_id=?)`, session.id, encode(payment), now, event.id, group.id, session.id));
        for (const message of messages) {
          statements.push(stmt(`INSERT OR IGNORE INTO email_deliveries(id,group_id,payload,created_at)
            SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM signup_groups WHERE id=? AND status='paid' AND fulfillment_event_id=?)`,
          `${group.id}:${message.kind}`, group.id, encode(message), Date.now(), group.id, event.id));
        }
      } else {
        statements.push(stmt(`UPDATE signup_groups SET status=?,updated_at=?,stripe_session_id=COALESCE(stripe_session_id,?)
          WHERE id=? AND status IN ('pending_checkout','checkout_started')
          AND (stripe_session_id IS NULL OR stripe_session_id=?)`, event.type === 'checkout.session.expired' ? 'expired' : 'checkout_failed', now, session.id, group.id, session.id));
      }
      await db.batch(statements);
    },
    async findRegistrationsBySession(id) { return (await rows(`${joined} WHERE g.stripe_session_id=? ORDER BY r.id`, id)).map(shape); },
    async listRegistrationsByCamp(id) { return (await rows(`${joined} WHERE r.camp_id=?`, id)).map(shape); },
    async listAllRegistrations() { return (await rows(joined)).map(shape); },
    async pendingGroups() { return rows(`SELECT id FROM signup_groups WHERE status='pending_checkout' AND created_at<? AND created_at>?
      AND json_extract(checkout_params,'$.priceId') IS NOT NULL ORDER BY created_at LIMIT 10`, new Date(Date.now()-180000).toISOString(), new Date(Date.now()-23*3600000).toISOString()); },
    async pendingMail() { return rows("SELECT id FROM email_deliveries WHERE state IN ('pending','sending') AND lease_until<? ORDER BY created_at LIMIT 20", Date.now()); },
    async claimMail(id, retryUncertain = true) {
      const now = Date.now();
      if (!retryUncertain) await stmt("UPDATE email_deliveries SET state='delivery_unknown',last_error='provider_result_unknown' WHERE id=? AND state='sending' AND lease_until<?", id, now).run();
      await stmt("UPDATE email_deliveries SET state='delivery_unknown',last_error='retry_window_elapsed' WHERE id=? AND state!='sent' AND created_at<?", id, now-23*3600000).run();
      return stmt(`UPDATE email_deliveries SET state='sending',lease_until=?,attempts=attempts+1
        WHERE id=? AND ${retryUncertain ? "state IN ('pending','sending')" : "state='pending'"} AND lease_until<? RETURNING *`, now+60000, id, now).first();
    },
    async finishMail(id, attempt, result) {
      await stmt(`UPDATE email_deliveries SET state=?,lease_until=?,provider_id=?,last_error=? WHERE id=? AND state='sending' AND attempts=?`,
        result.sent ? 'sent' : result.uncertain ? 'delivery_unknown' : 'pending', result.sent ? 0 : Date.now()+60000,
        result.id || null, result.sent ? null : (result.reason || 'unknown'), id, attempt).run();
    },
    async diagnostics() {
      return {
        paymentReview: (await stmt("SELECT COUNT(*) n FROM signup_groups WHERE status='payment_review'").first()).n,
        checkoutReview: (await stmt("SELECT COUNT(*) n FROM signup_groups WHERE status='pending_checkout' AND (created_at<? OR json_extract(checkout_params,'$.priceId') IS NULL)", new Date(Date.now()-23*3600000).toISOString()).first()).n,
        emailPending: (await stmt("SELECT COUNT(*) n FROM email_deliveries WHERE state IN ('pending','sending')").first()).n,
        emailUnknown: (await stmt("SELECT COUNT(*) n FROM email_deliveries WHERE state='delivery_unknown'").first()).n,
      };
    },
  };
  return store;
}

function capacityError(error) {
  if (String(error?.message).includes('camp_capacity')) throw core.createHttpError('This camp is full, closed, or has more reserved spots than the new capacity.', 409, { details: { campId: 'This camp is full or no longer open for signup.' } });
  throw error;
}
