(function () {
  const login = document.querySelector("#admin-login");
  const message = document.querySelector("#admin-message");
  const dashboard = document.querySelector("#dashboard");
  const refreshButton = document.querySelector("#refresh-button");
  const exportButton = document.querySelector("#export-button");
  const printButton = document.querySelector("#print-button");
  const adminContent = document.querySelector("#admin-content");
  const campForm = document.querySelector("#camp-form");
  const saveCampButton = document.querySelector("#save-camp-button");
  const cancelEditButton = document.querySelector("#cancel-edit-button");
  const campFormTitle = document.querySelector("#camp-form-title");
  const campFormHelp = document.querySelector("#camp-form-help");
  let token = sessionStorage.getItem("noah_admin_token") || "";
  let editingCampId = "";
  let latestCamps = [];

  // Same-origin /api locally, or the Lambda Function URL in production (read from
  // amplify_outputs.json). resolveApiBase runs once at load; calls await it.
  let API_BASE = "/api";
  async function resolveApiBase() {
    try {
      const res = await fetch("/amplify_outputs.json", { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const cfg = await res.json();
      const url = cfg && cfg.custom && cfg.custom.apiUrl;
      if (url) API_BASE = String(url).replace(/\/+$/, "");
    } catch (error) {
      // No outputs file (local dev), so keep the /api default.
    }
  }
  function apiUrl(path) {
    return `${API_BASE}${path}`;
  }
  const apiReady = resolveApiBase();

  function setMessage(text, type) {
    message.hidden = !text;
    message.textContent = text || "";
    message.dataset.type = type || "error";
  }

  function money(cents, currency) {
    if (typeof cents !== "number") return "Not reported";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(cents / 100);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function localDate(dateString) {
    const [year, month, day] = String(dateString).split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function formatDate(dateString, options) {
    return localDate(dateString).toLocaleDateString("en-US", options);
  }

  function campDateRange(camp) {
    const start = formatDate(camp.startDate, { month: "short", day: "numeric" });
    if (!camp.endDate || camp.endDate === camp.startDate) return start;
    const end = formatDate(camp.endDate, { month: "short", day: "numeric" });
    return `${start} to ${end}`;
  }

  function statusLabel(status) {
    if (status === "paid") return "Paid";
    if (status === "checkout_started") return "Checkout started";
    if (status === "checkout_failed") return "Checkout failed";
    if (status === "expired") return "Expired";
    return "Pending";
  }

  function campPayload(form) {
    const data = new FormData(form);
    return {
      campId: data.get("campId"),
      title: data.get("title"),
      trainingType: data.get("trainingType"),
      startDate: data.get("startDate"),
      endDate: data.get("endDate"),
      startTime: data.get("startTime"),
      endTime: data.get("endTime"),
      ageMin: data.get("ageMin"),
      ageMax: data.get("ageMax"),
      capacity: data.get("capacity"),
      displayPrice: data.get("displayPrice"),
      color: data.get("color"),
      status: data.get("status"),
      location: data.get("location"),
      notes: data.get("notes"),
    };
  }

  function resetCampForm() {
    editingCampId = "";
    campForm.reset();
    campForm.elements.campId.value = "";
    campForm.elements.trainingType.value = "group";
    campForm.elements.ageMin.value = "5";
    campForm.elements.ageMax.value = "12";
    campForm.elements.capacity.value = "5";
    campForm.elements.color.value = "green";
    campForm.elements.status.value = "open";
    if (campFormTitle) campFormTitle.textContent = "Add a camp or day";
    if (campFormHelp) {
      campFormHelp.textContent = "Create real camp dates for parents to pick from. Use the same start and end date for a one-day session. Payment amount still comes from the Stripe Price ID.";
    }
    saveCampButton.textContent = "Add camp/day";
    if (cancelEditButton) cancelEditButton.hidden = true;
  }

  function startEdit(camp) {
    editingCampId = camp.id;
    campForm.elements.campId.value = camp.id;
    campForm.elements.title.value = camp.title || "";
    campForm.elements.trainingType.value = camp.trainingType || "group";
    campForm.elements.startDate.value = camp.startDate || "";
    campForm.elements.endDate.value = camp.endDate || camp.startDate || "";
    campForm.elements.startTime.value = camp.startTime || "";
    campForm.elements.endTime.value = camp.endTime || "";
    campForm.elements.ageMin.value = camp.ageMin || "5";
    campForm.elements.ageMax.value = camp.ageMax || "12";
    campForm.elements.capacity.value = camp.capacity || "20";
    campForm.elements.displayPrice.value = camp.displayPrice || "";
    campForm.elements.color.value = camp.color || "green";
    campForm.elements.status.value = camp.status || "open";
    campForm.elements.location.value = camp.location || "";
    campForm.elements.notes.value = camp.notes || "";
    if (campFormTitle) campFormTitle.textContent = "Edit this camp";
    if (campFormHelp) {
      campFormHelp.textContent = "Update the dates, times, capacity, price label, notes, or status. Save changes to update the public calendar.";
    }
    saveCampButton.textContent = "Save changes";
    if (cancelEditButton) cancelEditButton.hidden = false;
    campForm.scrollIntoView({ block: "start" });
    campForm.elements.title.focus();
  }

  function friendlyValidationErrors(details) {
    if (!details || typeof details !== "object") return "";
    return Object.values(details).join(" ");
  }

  function authHeaders() {
    return {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
  }

  function render(camps) {
    latestCamps = camps;
    if (!camps.length) {
      dashboard.innerHTML = '<div class="empty-state wide"><strong>No camps yet.</strong><span>Add a real summer camp above and it will appear on the public calendar.</span></div>';
      return;
    }

    dashboard.innerHTML = camps.map((camp) => {
      const roster = camp.roster || [];
      const counts = camp.counts || { active: 0, paid: 0, pending: 0 };
      return `
        <article class="camp-admin-card" data-camp-id="${escapeHtml(camp.id)}">
          <div class="camp-admin-top">
            <div>
              <span class="pill" data-status="${escapeHtml(camp.status)}">${escapeHtml(camp.status)}</span>
              <span class="calendar-color-pill" data-color="${escapeHtml(camp.color || "green")}">${escapeHtml(camp.color || "green")}</span>
              <h2>${escapeHtml(camp.title)}</h2>
              <p>${escapeHtml(campDateRange(camp))} · ${escapeHtml(camp.startTime)} to ${escapeHtml(camp.endTime)} · ages ${escapeHtml(camp.ageMin)} to ${escapeHtml(camp.ageMax)}</p>
              <p>${escapeHtml(camp.location)}</p>
              ${camp.notes ? `<p class="muted">${escapeHtml(camp.notes)}</p>` : ""}
            </div>
            <div class="camp-stats">
              <strong>${escapeHtml(counts.active)} / ${escapeHtml(camp.capacity)}</strong>
              <span>${escapeHtml(camp.spotsLeft)} spots left</span>
              <span>${escapeHtml(counts.paid)} paid · ${escapeHtml(counts.pending)} pending</span>
              <button class="button secondary compact" type="button" data-edit-camp="${escapeHtml(camp.id)}">Edit camp</button>
              <button class="button secondary compact" type="button" data-message-camp="${escapeHtml(camp.id)}">Message parents</button>
              <button class="button secondary compact" type="button" data-toggle-status="${escapeHtml(camp.id)}">
                ${camp.status === "open" ? "Close signup" : "Open signup"}
              </button>
              ${camp.status === "archived"
                ? '<button class="button secondary compact" type="button" data-restore-camp="' + escapeHtml(camp.id) + '">Restore closed</button>'
                : '<button class="button secondary compact danger" type="button" data-archive-camp="' + escapeHtml(camp.id) + '">Archive</button>'}
            </div>
          </div>
          <div class="camp-message" data-message-for="${escapeHtml(camp.id)}" hidden>
            <label>
              <span>Subject</span>
              <input class="msg-subject" type="text" maxlength="150" placeholder="Update about ${escapeHtml(camp.title)}">
            </label>
            <label>
              <span>Message to parents</span>
              <textarea class="msg-body" rows="4" maxlength="2000" placeholder="Hi! A quick note about this week..."></textarea>
            </label>
            <div class="msg-actions">
              <button class="button primary compact msg-send" type="button">Send to parents</button>
              <button class="button secondary compact msg-cancel" type="button">Cancel</button>
              <span class="msg-status muted small"></span>
            </div>
          </div>
          ${renderRoster(roster)}
        </article>
      `;
    }).join("");

    dashboard.querySelectorAll("[data-edit-camp]").forEach((button) => {
      button.addEventListener("click", () => {
        const camp = latestCamps.find((item) => item.id === button.dataset.editCamp);
        if (camp) startEdit(camp);
      });
    });

    dashboard.querySelectorAll("[data-toggle-status]").forEach((button) => {
      button.addEventListener("click", async () => {
        const campId = button.dataset.toggleStatus;
        const camp = latestCamps.find((item) => item.id === campId);
        await updateCampStatus(campId, camp?.status === "open" ? "closed" : "open");
      });
    });

    dashboard.querySelectorAll("[data-archive-camp]").forEach((button) => {
      button.addEventListener("click", async () => {
        await updateCampStatus(button.dataset.archiveCamp, "archived");
      });
    });

    dashboard.querySelectorAll("[data-restore-camp]").forEach((button) => {
      button.addEventListener("click", async () => {
        await updateCampStatus(button.dataset.restoreCamp, "closed");
      });
    });

    dashboard.querySelectorAll("[data-message-camp]").forEach((button) => {
      button.addEventListener("click", () => {
        const card = button.closest(".camp-admin-card");
        const panel = card && card.querySelector(".camp-message");
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) panel.querySelector(".msg-subject").focus();
      });
    });

    dashboard.querySelectorAll(".camp-message").forEach((panel) => {
      const campId = panel.dataset.messageFor;
      const cancel = panel.querySelector(".msg-cancel");
      const send = panel.querySelector(".msg-send");
      if (cancel) cancel.addEventListener("click", () => { panel.hidden = true; });
      if (send) send.addEventListener("click", () => sendCampMessage(campId, panel));
    });
  }

  async function sendCampMessage(campId, panel) {
    const subject = panel.querySelector(".msg-subject").value.trim();
    const body = panel.querySelector(".msg-body").value.trim();
    const statusEl = panel.querySelector(".msg-status");
    const sendBtn = panel.querySelector(".msg-send");
    if (!subject || !body) {
      statusEl.textContent = "Add a subject and a message first.";
      return;
    }
    sendBtn.disabled = true;
    statusEl.textContent = "Sending...";
    try {
      await apiReady;
      const response = await fetch(apiUrl(`/admin/camps/${encodeURIComponent(campId)}/message`), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ subject, message: body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not send the message.");
      if (result.sent > 0) {
        statusEl.textContent = `Sent to ${result.sent} parent${result.sent === 1 ? "" : "s"}.`;
        panel.querySelector(".msg-body").value = "";
      } else if (result.total > 0) {
        statusEl.textContent = "Couldn't send right now. Please try again.";
      } else {
        statusEl.textContent = "No paid parents to message yet.";
      }
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      sendBtn.disabled = false;
    }
  }

  function renderRoster(roster) {
    if (!roster.length) {
      return '<div class="empty-state roster-empty"><strong>No signups for this camp yet.</strong><span>When parents start checkout, they will appear here. Paid status updates after Stripe webhook confirmation.</span></div>';
    }

    return `
      <div class="roster-table">
        ${roster.map((item) => `
          <div class="roster-row">
            <div>
              <span class="pill" data-status="${escapeHtml(item.status)}">${statusLabel(item.status)}</span>
              <strong>${escapeHtml(item.camperName)}</strong>
              <span>Age ${escapeHtml(item.camperAge)}</span>
              ${item.medicalNotes ? `<span class="medical-flag">Medical: ${escapeHtml(item.medicalNotes)}</span>` : ""}
              ${item.goals ? `<span class="muted">${escapeHtml(item.goals)}</span>` : ""}
            </div>
            <div>
              <strong>${escapeHtml(item.parentName)}</strong>
              <a href="mailto:${escapeHtml(item.parentEmail)}">${escapeHtml(item.parentEmail)}</a>
              <a href="tel:${escapeHtml(String(item.parentPhone).replace(/[^\d+]/g, ""))}">${escapeHtml(item.parentPhone)}</a>
              ${item.emergencyName ? `<span class="muted">Emergency: ${escapeHtml(item.emergencyName)} · ${escapeHtml(item.emergencyPhone || "")}</span>` : ""}
              <span>${money(item.amountTotal, item.currency)}</span>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  async function loadDashboard() {
    if (!token) return;
    setMessage("", "info");
    dashboard.innerHTML = '<div class="empty-state wide"><strong>Loading camps...</strong></div>';

    try {
      await apiReady;
      const response = await fetch(apiUrl("/admin/dashboard"), { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load camps.");
      login.hidden = true;
      adminContent.hidden = false;
      render(body.camps || []);
    } catch (error) {
      dashboard.innerHTML = "";
      adminContent.hidden = true;
      login.hidden = false;
      setMessage(error.message, "error");
    }
  }

  async function saveCamp(event) {
    event.preventDefault();
    setMessage("", "info");
    if (!campForm.reportValidity()) return;

    saveCampButton.disabled = true;
    const campId = editingCampId;
    const wasEditing = Boolean(campId);
    saveCampButton.textContent = wasEditing ? "Saving changes..." : "Adding camp/day...";

    try {
      await apiReady;
      const response = await fetch(wasEditing ? apiUrl(`/admin/camps/${encodeURIComponent(campId)}`) : apiUrl("/admin/camps"), {
        method: wasEditing ? "PATCH" : "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify(campPayload(campForm)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = friendlyValidationErrors(body.details);
        throw new Error(`${body.error || "Could not save camp."} ${detail}`.trim());
      }
      resetCampForm();
      setMessage(wasEditing ? "Camp updated on the public calendar." : "Camp added to the public calendar.", "info");
      await loadDashboard();
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      saveCampButton.disabled = false;
      saveCampButton.textContent = editingCampId ? "Save changes" : "Add camp/day";
    }
  }

  async function updateCampStatus(campId, status) {
    try {
      await apiReady;
      const response = await fetch(apiUrl(`/admin/camps/${encodeURIComponent(campId)}`), {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ status }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not update camp.");
      setMessage(`Camp is now ${status}.`, "info");
      await loadDashboard();
    } catch (error) {
      setMessage(error.message, "error");
    }
  }

  function csvCell(value) {
    const str = String(value ?? "");
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function buildCsv() {
    const headers = ["Camp", "Dates", "Status", "Camper", "Age", "Parent", "Email", "Phone", "Emergency contact", "Emergency phone", "Allergies/Medical", "Goals", "Amount"];
    const rows = [headers];
    latestCamps.forEach((camp) => {
      (camp.roster || []).forEach((item) => {
        rows.push([
          camp.title,
          campDateRange(camp),
          statusLabel(item.status),
          item.camperName,
          item.camperAge,
          item.parentName,
          item.parentEmail,
          item.parentPhone,
          item.emergencyName || "",
          item.emergencyPhone || "",
          item.medicalNotes || "",
          item.goals || "",
          typeof item.amountTotal === "number" ? (item.amountTotal / 100).toFixed(2) : "",
        ]);
      });
    });
    return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  }

  function downloadCsv() {
    if (!latestCamps.some((camp) => (camp.roster || []).length)) {
      setMessage("No registrations to export yet.", "info");
      return;
    }
    const blob = new Blob([buildCsv()], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `noah-soccer-rosters-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  login.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(login);
    token = String(data.get("token") || "").trim();
    if (!token) return;
    sessionStorage.setItem("noah_admin_token", token);
    loadDashboard();
  });

  refreshButton.addEventListener("click", loadDashboard);
  if (exportButton) exportButton.addEventListener("click", downloadCsv);
  if (printButton) printButton.addEventListener("click", () => window.print());
  campForm.addEventListener("submit", saveCamp);
  if (cancelEditButton) cancelEditButton.addEventListener("click", resetCampForm);

  resetCampForm();
  if (token) loadDashboard();
})();
