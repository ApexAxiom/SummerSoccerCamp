"use strict";

// Existing local/AWS consumers use Resend. The Cloudflare Worker explicitly
// selects its native binding. Missing mail never prevents recording payment.

const { formatCampDates, escapeForEmail } = require("./core");

async function sendEmail({ to, subject, text, html, idempotencyKey }, env = process.env) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: "no_recipient" };

  const apiKey = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;
  if (env.EMAIL_TRANSPORT === 'cloudflare') {
    if (!emailConfigured(env)) return { sent:false, reason:'not_configured' };
    try {
      const result = await env.EMAIL.send({ from, to:recipients, subject, text, html,
        ...(env.CONTACT_EMAIL ? {replyTo:env.CONTACT_EMAIL} : {}) });
      // Cloudflare documents acceptance IDs, not idempotent sends. Never assume
      // a custom header or a missing response permits a second attempt.
      return result?.messageId ? {sent:true,id:result.messageId} : {sent:false,reason:'provider_result_unknown',uncertain:true};
    } catch (error) {
      const rejected = new Set(['E_RATE_LIMIT_EXCEEDED','E_DAILY_LIMIT_EXCEEDED','E_SENDER_NOT_VERIFIED',
        'E_SENDER_DOMAIN_NOT_AVAILABLE','E_RECIPIENT_NOT_ALLOWED','E_VALIDATION_ERROR','E_FIELD_MISSING',
        'E_TOO_MANY_RECIPIENTS','E_CONTENT_TOO_LARGE','E_RECIPIENT_SUPPRESSED']);
      const explicitRejection = rejected.has(error?.code);
      return {sent:false,reason:explicitRejection ? error.code : 'provider_result_unknown',uncertain:!explicitRejection};
    }
  }
  if (!apiKey || !from) {
    return { sent: false, reason: "not_configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify({ from, to: recipients, subject, text, html }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return { sent: false, reason: `provider_${response.status}` };
    }
    const body = await response.json();
    return { sent: true, id: body.id || null };
  } catch (error) {
    return { sent: false, reason: "exception" };
  }
}

function campSummaryLines(registration) {
  const lines = [
    `Camp: ${registration.campTitle}`,
    `Dates: ${formatCampDates(registration.campStartDate, registration.campEndDate)}`,
  ];
  if (registration.campStartTime || registration.campEndTime) {
    lines.push(`Time: ${registration.campStartTime} to ${registration.campEndTime}`);
  }
  if (registration.campLocation) lines.push(`Location: ${registration.campLocation}`);
  if (registration.campNotes) lines.push(`What to bring / notes: ${registration.campNotes}`);
  return lines;
}

function signupMessages(groupRegistrations, env = process.env) {
  if (!groupRegistrations.length) return [];
  const messages = [];
  const contactEmail = env.CONTACT_EMAIL || "";
  const contactPhone = env.CONTACT_PHONE || "";
  const coachEmail = env.COACH_EMAIL || contactEmail;
  const first = groupRegistrations[0];
  const camperNames = groupRegistrations.map((item) => item.camperName);
  const summary = campSummaryLines(first);
  const contactLine = contactEmail || contactPhone
    ? `Questions? Reach Noah at ${[contactEmail, contactPhone].filter(Boolean).join(" or ")}.`
    : "";

  const parentText = [
    `Hi ${first.parentName},`,
    "",
    `You're signed up${camperNames.length > 1 ? ` for ${camperNames.length} players` : ""}: ${camperNames.join(", ")}.`,
    "",
    ...summary,
    "",
    contactLine,
    "See you on the field!",
  ].filter((line) => line !== null).join("\n");

  messages.push({
    kind: "parent",
    to: first.parentEmail,
    subject: `You're signed up: ${first.campTitle}`,
    text: parentText,
    html: `<p>Hi ${escapeForEmail(first.parentName)},</p>`
      + `<p>You're signed up${camperNames.length > 1 ? ` for ${camperNames.length} players` : ""}: <strong>${escapeForEmail(camperNames.join(", "))}</strong>.</p>`
      + `<ul>${summary.map((line) => `<li>${escapeForEmail(line)}</li>`).join("")}</ul>`
      + (contactLine ? `<p>${escapeForEmail(contactLine)}</p>` : "")
      + "<p>See you on the field!</p>",
  });

  if (coachEmail) {
    const coachText = [
      `New paid signup for ${first.campTitle} (${formatCampDates(first.campStartDate, first.campEndDate)}).`,
      "",
      `Players: ${camperNames.join(", ")}`,
      `Parent: ${first.parentName}, ${first.parentEmail}, ${first.parentPhone}`,
      first.emergencyName ? `Emergency contact: ${first.emergencyName}, ${first.emergencyPhone}` : "",
      first.medicalNotes ? `Allergies / medical: ${first.medicalNotes}` : "",
      first.goals ? `Goals: ${first.goals}` : "",
    ].filter(Boolean).join("\n");

    messages.push({
      kind: "coach",
      to: coachEmail,
      subject: `New signup: ${camperNames.join(", ")} for ${first.campTitle}`,
      text: coachText,
      html: coachText.split("\n").map((line) => `<p>${escapeForEmail(line)}</p>`).join(""),
    });
  }
  return messages;
}

async function sendSignupEmails(groupRegistrations, env = process.env) {
  for (const message of signupMessages(groupRegistrations, env)) await sendEmail(message, env);
}

function emailConfigured(env = process.env) {
  if (env.EMAIL_TRANSPORT === 'cloudflare') return Boolean(env.EMAIL_ENABLED === 'true' && env.EMAIL?.send && env.MAIL_FROM);
  return Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
}

// Sends a coach's message to each paid parent of a camp. Returns the count sent,
// or a reason ("no_recipients" / "not_configured") so the coach view can show a
// friendly result without anything failing loudly.
async function sendCampMessage(camp, parents, subject, message, env = process.env) {
  const recipients = Array.from(new Set((parents || []).map((p) => p.email).filter(Boolean)));
  if (!recipients.length) return { sent: 0, reason: "no_recipients" };
  if (!emailConfigured(env)) return { sent: 0, reason: "not_configured" };

  const contactEmail = env.CONTACT_EMAIL || "";
  const contactPhone = env.CONTACT_PHONE || "";
  const contactLine = contactEmail || contactPhone
    ? `Reach Noah at ${[contactEmail, contactPhone].filter(Boolean).join(" or ")}.`
    : "";
  const campLine = `Camp: ${camp.title} (${formatCampDates(camp.startDate, camp.endDate)})`;

  const parts = [message, "", campLine];
  if (contactLine) parts.push(contactLine);
  parts.push("Noah Westra Soccer Training");
  const text = parts.join("\n");
  const html = `<p>${escapeForEmail(message).replace(/\n/g, "<br>")}</p>`
    + `<p style="color:#6e6e73">${escapeForEmail(campLine)}</p>`
    + (contactLine ? `<p style="color:#6e6e73">${escapeForEmail(contactLine)}</p>` : "")
    + "<p>Noah Westra Soccer Training</p>";

  let sent = 0, uncertain = 0;
  for (const to of recipients) {
    const result = await sendEmail({ to, subject, text, html }, env);
    if (result.sent) sent += 1;
    if (result.uncertain) uncertain += 1;
  }
  return { sent, total: recipients.length, ...(uncertain ? {uncertain} : {}) };
}

module.exports = {
  sendEmail,
  emailConfigured,
  campSummaryLines,
  sendSignupEmails,
  signupMessages,
  sendCampMessage,
};
