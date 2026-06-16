"use strict";

// Email notifications shared by the local server and the Lambda functions.
// Sends through Resend's HTTP API when RESEND_API_KEY and MAIL_FROM are set, and
// otherwise logs and returns without throwing, so a missing email key never
// blocks a real payment from being recorded.

const { formatCampDates, escapeForEmail } = require("./core");

async function sendEmail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: "no_recipient" };

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from) {
    console.log(`[email skipped] to=${recipients.join(", ")} subject="${subject}" (set RESEND_API_KEY and MAIL_FROM to send)`);
    return { sent: false, reason: "not_configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: recipients, subject, text, html }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[email failed] ${response.status} ${body}`);
      return { sent: false, reason: "api_error" };
    }
    return { sent: true };
  } catch (error) {
    console.error(`[email error] ${error.message}`);
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

async function sendSignupEmails(groupRegistrations) {
  if (!groupRegistrations.length) return;
  const contactEmail = process.env.CONTACT_EMAIL || "";
  const contactPhone = process.env.CONTACT_PHONE || "";
  const coachEmail = process.env.COACH_EMAIL || contactEmail;
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

  await sendEmail({
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
      `Parent: ${first.parentName} — ${first.parentEmail} — ${first.parentPhone}`,
      first.emergencyName ? `Emergency contact: ${first.emergencyName} — ${first.emergencyPhone}` : "",
      first.medicalNotes ? `Allergies / medical: ${first.medicalNotes}` : "",
      first.goals ? `Goals: ${first.goals}` : "",
    ].filter(Boolean).join("\n");

    await sendEmail({
      to: coachEmail,
      subject: `New signup: ${camperNames.join(", ")} — ${first.campTitle}`,
      text: coachText,
      html: coachText.split("\n").map((line) => `<p>${escapeForEmail(line)}</p>`).join(""),
    });
  }
}

module.exports = {
  sendEmail,
  campSummaryLines,
  sendSignupEmails,
};
