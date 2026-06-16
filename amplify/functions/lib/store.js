"use strict";

// DynamoDB data layer for the Lambda functions. This is the cloud equivalent of
// the JSON-file storage in server.js. The key difference is capacity safety:
// instead of an in-process lock, overselling is prevented with a DynamoDB
// conditional transaction on a per-camp reservedCount counter, which is correct
// even across many concurrent Lambda instances.
//
// Tables (created in amplify/backend.ts):
//   Camps           PK id
//   Registrations   PK id, GSIs: byCamp(campId,createdAt), byGroup(groupId),
//                                 bySession(stripeCheckoutSessionId)

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  QueryCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");

const {
  campColor,
  createStarterCamps,
  countCampRegistrations,
  createRegistrationId,
  createGroupId,
  createHttpError,
} = require("../../../shared/core");

const CAMPS_TABLE = process.env.CAMPS_TABLE;
const REGISTRATIONS_TABLE = process.env.REGISTRATIONS_TABLE;
const BY_CAMP_INDEX = process.env.REGISTRATIONS_BY_CAMP_INDEX || "byCamp";
const BY_GROUP_INDEX = process.env.REGISTRATIONS_BY_GROUP_INDEX || "byGroup";
const BY_SESSION_INDEX = process.env.REGISTRATIONS_BY_SESSION_INDEX || "bySession";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

async function scanAll(table) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function queryIndex(index, keyName, keyValue) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(new QueryCommand({
      TableName: REGISTRATIONS_TABLE,
      IndexName: index,
      KeyConditionExpression: "#k = :v",
      ExpressionAttributeNames: { "#k": keyName },
      ExpressionAttributeValues: { ":v": keyValue },
      ExclusiveStartKey,
    }));
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getCamp(id) {
  const out = await client.send(new GetCommand({ TableName: CAMPS_TABLE, Key: { id } }));
  return out.Item || null;
}

async function listCamps() {
  const camps = await scanAll(CAMPS_TABLE);
  return camps.map((camp) => ({ ...camp, color: campColor(camp.color) }));
}

async function putCamp(camp) {
  await client.send(new PutCommand({ TableName: CAMPS_TABLE, Item: camp }));
  return camp;
}

// Creates the starter summer schedule the first time the site runs, mirroring the
// local server. Conditional puts keep it idempotent if two cold-start Lambdas race.
async function ensureStarterCamps() {
  const existing = await client.send(new ScanCommand({ TableName: CAMPS_TABLE, Limit: 1 }));
  if ((existing.Items || []).length) return;

  for (const camp of createStarterCamps()) {
    try {
      await client.send(new PutCommand({
        TableName: CAMPS_TABLE,
        Item: { ...camp, reservedCount: 0, paidCount: 0 },
        ConditionExpression: "attribute_not_exists(id)",
      }));
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
}

// Atomically reserves a spot for every child in one transaction: it bumps the
// camp's reservedCount (guarded so it can never exceed capacity) and writes the
// registration rows together. If the camp is full or closed the whole thing is
// rejected and nothing is written.
async function reserveGroup(camp, children) {
  const n = children.length;
  const now = new Date().toISOString();
  const groupId = createGroupId();
  const reserved = children.map((child) => ({
    id: createRegistrationId(),
    groupId,
    status: "pending_checkout",
    createdAt: now,
    updatedAt: now,
    waiverAcceptedAt: now,
    ...child,
  }));

  // reservedCount may not exist yet; allow up to capacity - n before this group.
  const limit = Number(camp.capacity) - n;

  const transactItems = [
    {
      Update: {
        TableName: CAMPS_TABLE,
        Key: { id: camp.id },
        UpdateExpression: "SET reservedCount = if_not_exists(reservedCount, :z) + :n",
        ConditionExpression: "if_not_exists(reservedCount, :z) <= :limit AND #status = :open",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":z": 0, ":n": n, ":limit": limit, ":open": "open" },
      },
    },
    ...reserved.map((item) => ({
      Put: {
        TableName: REGISTRATIONS_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(id)",
      },
    })),
  ];

  try {
    await client.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    if (error.name === "TransactionCanceledException") {
      // The camp counter condition failed: it is full or no longer open.
      throw createHttpError("This camp is full or no longer open for signup.", 409, {
        details: { campId: "This camp is full or no longer open for signup." },
      });
    }
    throw error;
  }

  return { id: groupId, parentEmail: reserved[0].parentEmail, registrations: reserved };
}

// Marks every row in a group with a simple field patch (used for checkout_started).
async function patchGroup(groupId, patch) {
  const rows = await queryIndex(BY_GROUP_INDEX, "groupId", groupId);
  const now = new Date().toISOString();
  await Promise.all(rows.map((row) => client.send(new PutCommand({
    TableName: REGISTRATIONS_TABLE,
    Item: { ...row, ...patch, updatedAt: now },
  }))));
  return rows;
}

// Releases the spots a group reserved (checkout failed or session expired): sets
// the rows to a terminal status and decrements the camp's reservedCount by the
// number of rows that were still counting against capacity.
async function releaseGroup(groupId, status, extra = {}) {
  const rows = await queryIndex(BY_GROUP_INDEX, "groupId", groupId);
  const toRelease = rows.filter((row) => row.status !== "paid" && row.status !== "expired" && row.status !== "checkout_failed");
  if (!rows.length) return rows;

  const now = new Date().toISOString();
  const campId = rows[0].campId;
  const transactItems = rows.map((row) => ({
    Update: {
      TableName: REGISTRATIONS_TABLE,
      Key: { id: row.id },
      UpdateExpression: "SET #status = :s, updatedAt = :u" + (extra.stripeCheckoutSessionId ? ", stripeCheckoutSessionId = :sid" : "") + (extra.checkoutError ? ", checkoutError = :err" : ""),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":u": now,
        ...(extra.stripeCheckoutSessionId ? { ":sid": extra.stripeCheckoutSessionId } : {}),
        ...(extra.checkoutError ? { ":err": String(extra.checkoutError).slice(0, 500) } : {}),
      },
    },
  }));

  if (toRelease.length) {
    transactItems.push({
      Update: {
        TableName: CAMPS_TABLE,
        Key: { id: campId },
        UpdateExpression: "SET reservedCount = if_not_exists(reservedCount, :z) - :n",
        ConditionExpression: "if_not_exists(reservedCount, :z) >= :n",
        ExpressionAttributeValues: { ":z": 0, ":n": toRelease.length },
      },
    });
  }

  await client.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return rows;
}

// Marks a group paid and bumps the camp's paidCount. reservedCount is unchanged
// because paid rows still occupy their spots.
async function markGroupPaid(session, groupId) {
  const rows = await queryIndex(BY_GROUP_INDEX, "groupId", groupId);
  if (!rows.length) return [];

  const now = new Date().toISOString();
  const perChild = typeof session.amount_total === "number" ? Math.round(session.amount_total / rows.length) : null;
  const newlyPaid = rows.filter((row) => row.status !== "paid").length;
  const campId = rows[0].campId;

  const transactItems = rows.map((row) => ({
    Put: {
      TableName: REGISTRATIONS_TABLE,
      Item: {
        ...row,
        status: "paid",
        updatedAt: now,
        paidAt: now,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: session.payment_intent || row.stripePaymentIntentId || null,
        stripeCustomerId: session.customer || null,
        amountTotal: perChild,
        currency: session.currency || null,
      },
    },
  }));

  if (newlyPaid > 0) {
    transactItems.push({
      Update: {
        TableName: CAMPS_TABLE,
        Key: { id: campId },
        UpdateExpression: "SET paidCount = if_not_exists(paidCount, :z) + :n",
        ExpressionAttributeValues: { ":z": 0, ":n": newlyPaid },
      },
    });
  }

  await client.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return rows.map((row) => ({ ...row, status: "paid", amountTotal: perChild, currency: session.currency || null }));
}

async function findRegistrationsBySession(sessionId) {
  return queryIndex(BY_SESSION_INDEX, "stripeCheckoutSessionId", sessionId);
}

async function listRegistrationsByCamp(campId) {
  return queryIndex(BY_CAMP_INDEX, "campId", campId);
}

async function listAllRegistrations() {
  return scanAll(REGISTRATIONS_TABLE);
}

module.exports = {
  getCamp,
  listCamps,
  putCamp,
  ensureStarterCamps,
  reserveGroup,
  patchGroup,
  releaseGroup,
  markGroupPaid,
  findRegistrationsBySession,
  listRegistrationsByCamp,
  listAllRegistrations,
  countCampRegistrations,
};
