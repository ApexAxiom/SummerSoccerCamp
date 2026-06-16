(function () {
  const form = document.querySelector("#signup-form");
  const campIdInput = document.querySelector("#camp-id");
  const statusPanel = document.querySelector("#backend-status");
  const submitButton = document.querySelector("#submit-button");
  const message = document.querySelector("#form-message");
  const successState = document.querySelector("#success-state");
  const calendarRoot = document.querySelector("#camp-calendar");
  const selectedCampPanel = document.querySelector("#selected-camp");
  const childrenList = document.querySelector("#children-list");
  const addChildButton = document.querySelector("#add-child");
  const childRowTemplate = document.querySelector("#child-row-template");
  const contactInfo = document.querySelector("#contact-info");
  const faqContact = document.querySelector("#faq-contact");
  const MAX_CHILDREN = 8;
  const SUMMER_MONTHS = ["2026-06", "2026-07", "2026-08"];

  // The API lives at same-origin /api on the local Node server, or at the Lambda
  // Function URL in production. Amplify writes that URL into amplify_outputs.json,
  // which is served as a static file; if it's absent we're running locally.
  let API_BASE = "/api";
  async function resolveApiBase() {
    try {
      const res = await fetch("/amplify_outputs.json", { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const cfg = await res.json();
      const url = cfg && cfg.custom && cfg.custom.apiUrl;
      if (url) API_BASE = String(url).replace(/\/+$/, "");
    } catch (error) {
      // No outputs file (local dev) — keep the /api default.
    }
  }
  function apiUrl(path) {
    return `${API_BASE}${path}`;
  }

  let camps = [];
  let selectedCamp = null;

  function showMessage(text, type) {
    if (!message) return;
    message.hidden = false;
    message.textContent = text;
    message.dataset.type = type || "error";
  }

  function clearMessage() {
    if (!message) return;
    message.hidden = true;
    message.textContent = "";
  }

  function setStatus(text, ready) {
    if (!statusPanel) return;
    statusPanel.textContent = text;
    statusPanel.dataset.ready = ready ? "true" : "false";
  }

  function childrenPayload() {
    if (!childrenList) return [];
    return Array.from(childrenList.querySelectorAll("[data-child-row]")).map((row) => ({
      camperName: row.querySelector('[name="camperName"]')?.value || "",
      camperAge: row.querySelector('[name="camperAge"]')?.value || "",
    }));
  }

  function formPayload(formElement) {
    const data = new FormData(formElement);
    return {
      campId: data.get("campId"),
      children: childrenPayload(),
      parentName: data.get("parentName"),
      parentEmail: data.get("parentEmail"),
      parentPhone: data.get("parentPhone"),
      emergencyName: data.get("emergencyName"),
      emergencyPhone: data.get("emergencyPhone"),
      medicalNotes: data.get("medicalNotes"),
      goals: data.get("goals"),
      waiverAccepted: data.get("waiverAccepted") === "on",
      website: data.get("website"),
    };
  }

  function renumberChildren() {
    if (!childrenList) return;
    const rows = Array.from(childrenList.querySelectorAll("[data-child-row]"));
    rows.forEach((row, index) => {
      const title = row.querySelector(".child-row-title");
      if (title) title.textContent = `Player ${index + 1}`;
      const remove = row.querySelector("[data-remove-child]");
      if (remove) remove.hidden = rows.length === 1;
    });
    if (addChildButton) addChildButton.disabled = rows.length >= MAX_CHILDREN;
  }

  function addChildRow() {
    if (!childrenList || !childRowTemplate) return;
    if (childrenList.querySelectorAll("[data-child-row]").length >= MAX_CHILDREN) return;
    const row = childRowTemplate.content.cloneNode(true).querySelector("[data-child-row]");
    const remove = row.querySelector("[data-remove-child]");
    if (remove) {
      remove.addEventListener("click", () => {
        row.remove();
        renumberChildren();
      });
    }
    childrenList.appendChild(row);
    renumberChildren();
  }

  function applyContact(config) {
    const email = config && config.contactEmail ? config.contactEmail : "";
    const phone = config && config.contactPhone ? config.contactPhone : "";
    const parts = [];
    if (email) parts.push(`<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`);
    if (phone) parts.push(`<a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ""))}">${escapeHtml(phone)}</a>`);
    if (contactInfo) contactInfo.innerHTML = parts.join(" · ");
    if (faqContact) {
      faqContact.innerHTML = parts.length
        ? `Reach Noah at ${parts.join(" or ")}.`
        : "Contact details will appear here once Noah adds them.";
    }
  }

  function friendlyValidationErrors(details) {
    if (!details || typeof details !== "object") return "";
    return Object.values(details).join(" ");
  }

  function dateParts(dateString) {
    const [year, month, day] = String(dateString).split("-").map(Number);
    return { year, month, day };
  }

  function dateKey(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function localDate(dateString) {
    const parts = dateParts(dateString);
    return new Date(parts.year, parts.month - 1, parts.day);
  }

  function formatDate(dateString, options) {
    return localDate(dateString).toLocaleDateString("en-US", options);
  }

  function campDateRange(camp) {
    const startDate = camp.startDate || camp.campStartDate;
    const endDate = camp.endDate || camp.campEndDate;
    const start = formatDate(startDate, { month: "short", day: "numeric" });
    if (!endDate || endDate === startDate) return start;
    const end = formatDate(endDate, { month: "short", day: "numeric" });
    return `${start} to ${end}`;
  }

  function campEndDate(camp) {
    return camp.endDate || camp.startDate;
  }

  function dayDifference(startDate, endDate) {
    return Math.round((localDate(endDate).getTime() - localDate(startDate).getTime()) / 86_400_000);
  }

  function campDurationDays(camp) {
    return Math.max(dayDifference(camp.startDate, campEndDate(camp)) + 1, 1);
  }

  function campDayNumber(camp, date) {
    return Math.max(dayDifference(camp.startDate, date) + 1, 1);
  }

  function campRunsOnDate(camp, date) {
    return camp.startDate <= date && campEndDate(camp) >= date;
  }

  function campIntersectsMonth(camp, monthKey) {
    const [year, month] = monthKey.split("-").map(Number);
    const monthStart = `${monthKey}-01`;
    const monthEnd = dateKey(new Date(year, month, 0));
    return camp.startDate <= monthEnd && campEndDate(camp) >= monthStart;
  }

  function campDayPhase(camp, date) {
    if (camp.startDate === campEndDate(camp)) return "single";
    if (date === camp.startDate) return "start";
    if (date === campEndDate(camp)) return "end";
    return "middle";
  }

  function campDayLabel(camp, date) {
    const totalDays = campDurationDays(camp);
    if (totalDays === 1) return "One-day session";
    return `Day ${campDayNumber(camp, date)} of ${totalDays}`;
  }

  function monthLabel(monthKey) {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function campStatusText(camp) {
    if (camp.status !== "open") return "Closed";
    if (camp.spotsLeft <= 0) return "Full";
    return `${camp.spotsLeft} spot${camp.spotsLeft === 1 ? "" : "s"} left`;
  }

  function canSelectCamp(camp) {
    return camp.status === "open" && camp.spotsLeft > 0;
  }

  function canCheckoutCamp(camp) {
    return canSelectCamp(camp) && camp.checkoutEnabled;
  }

  function renderCalendar() {
    if (!calendarRoot) return;

    if (!camps.length) {
      calendarRoot.innerHTML = [
        '<div class="empty-state wide">',
        "<strong>No camp dates have been posted yet.</strong>",
        "<span>Noah can add summer camp weeks or single-day sessions from Coach view. Once a real camp is added, parents can pick it here and pay through Stripe.</span>",
        "</div>",
      ].join("");
      setStatus("No camp dates are published yet. Use Coach view to add the first camp.", false);
      updateSelectedCamp(null);
      return;
    }

    const missing = Array.from(new Set(camps.flatMap((camp) => camp.missingEnv || [])));
    if (missing.length) {
      setStatus(`Some payments are not live yet. Missing setup: ${missing.join(", ")}.`, false);
    } else {
      setStatus("Stripe checkout is connected for the published camp types.", true);
    }

    const monthKeys = Array.from(new Set([
      ...SUMMER_MONTHS,
      ...camps.map((camp) => camp.startDate.slice(0, 7)),
      ...camps.map((camp) => camp.endDate.slice(0, 7)),
    ])).sort();

    calendarRoot.innerHTML = monthKeys.map((key) => {
      const monthCamps = camps.filter((camp) => campIntersectsMonth(camp, key));
      return `
        <article class="month-card">
          <div class="month-title">${escapeHtml(monthLabel(key))}</div>
          ${renderMonthGrid(key, monthCamps)}
        </article>
      `;
    }).join("");

    calendarRoot.querySelectorAll("[data-camp-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const camp = camps.find((item) => item.id === button.dataset.campId);
        if (camp) updateSelectedCamp(camp);
      });
    });
  }

  function renderMonthGrid(monthKey, monthCamps) {
    const [year, month] = monthKey.split("-").map(Number);
    const firstDay = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const blanks = firstDay.getDay();
    const cells = [];

    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((day) => {
      cells.push(`<div class="weekday">${day}</div>`);
    });

    for (let i = 0; i < blanks; i += 1) {
      cells.push('<div class="calendar-day empty"></div>');
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dayCamps = monthCamps.filter((camp) => campRunsOnDate(camp, date));
      cells.push(`
        <div class="calendar-day">
          <span class="day-number">${day}</span>
          ${dayCamps.map((camp) => renderCampButton(camp, date)).join("")}
        </div>
      `);
    }

    return `<div class="calendar-grid">${cells.join("")}</div>`;
  }

  function renderCampButton(camp, date) {
    const disabled = canSelectCamp(camp) ? "" : "disabled";
    const selected = selectedCamp?.id === camp.id ? " selected" : "";
    const price = camp.displayPrice ? `<span>${escapeHtml(camp.displayPrice)}</span>` : "";
    const color = camp.color || "green";
    const phase = campDayPhase(camp, date);
    return `
      <button class="camp-chip${selected}" type="button" data-camp-id="${escapeHtml(camp.id)}" data-color="${escapeHtml(color)}" data-phase="${escapeHtml(phase)}" ${disabled}>
        <strong>${escapeHtml(camp.title)}</strong>
        <span>${escapeHtml(campDayLabel(camp, date))}</span>
        <span>${escapeHtml(camp.startTime)} to ${escapeHtml(camp.endTime)}</span>
        <span>${escapeHtml(campStatusText(camp))}</span>
        ${price}
      </button>
    `;
  }

  function updateSelectedCamp(camp) {
    selectedCamp = camp;
    if (campIdInput) campIdInput.value = camp ? camp.id : "";
    clearMessage();

    if (!selectedCampPanel) return;

    if (!camp) {
      selectedCampPanel.innerHTML = [
        "<strong>No camp selected yet.</strong>",
        "<span>Pick an open camp from the calendar to enable signup.</span>",
      ].join("");
      submitButton.disabled = true;
      submitButton.textContent = "Pick a camp to continue";
      return;
    }

    selectedCampPanel.innerHTML = [
      `<strong>${escapeHtml(camp.title)}</strong>`,
      `<span>${escapeHtml(campDateRange(camp))} · ${escapeHtml(camp.startTime)} to ${escapeHtml(camp.endTime)}</span>`,
      `<span>${escapeHtml(camp.location)} · ages ${escapeHtml(camp.ageMin)} to ${escapeHtml(camp.ageMax)}</span>`,
      `<span>${escapeHtml(campStatusText(camp))}${camp.displayPrice ? ` · ${escapeHtml(camp.displayPrice)}` : ""}</span>`,
      camp.notes ? `<span class="selected-camp-notes">${escapeHtml(camp.notes)}</span>` : "",
    ].join("");

    if (!camp.checkoutEnabled) {
      submitButton.disabled = true;
      submitButton.textContent = "Stripe setup needed";
      showMessage(`Stripe is not configured for this camp yet. Missing: ${(camp.missingEnv || []).join(", ")}.`, "error");
    } else if (!canSelectCamp(camp)) {
      submitButton.disabled = true;
      submitButton.textContent = camp.status === "open" ? "Camp is full" : "Camp is closed";
    } else {
      submitButton.disabled = false;
      submitButton.textContent = "Continue to Stripe";
    }

    renderCalendar();
    document.querySelector("#signup")?.scrollIntoView({ block: "start" });
  }

  async function loadContact() {
    if (!contactInfo && !faqContact) return;
    try {
      const response = await fetch(apiUrl("/config"), { headers: { accept: "application/json" } });
      if (!response.ok) return;
      applyContact(await response.json());
    } catch (error) {
      // Contact info is non-critical; leave the defaults in place.
    }
  }

  async function loadAll() {
    if (!form || !calendarRoot) return;

    try {
      const campsResponse = await fetch(apiUrl("/camps"), { headers: { accept: "application/json" } });
      if (!campsResponse.ok) throw new Error("Camp calendar endpoint is unavailable.");

      const campBody = await campsResponse.json();
      camps = (campBody.camps || []).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
      renderCalendar();
    } catch (error) {
      camps = [];
      calendarRoot.innerHTML = '<div class="empty-state wide"><strong>Calendar could not load.</strong><span>Start or restart the Node server, then refresh this page.</span></div>';
      setStatus("Backend is not running yet. Start the Node server to enable the calendar and Stripe checkout.", false);
      updateSelectedCamp(null);
    }
  }

  async function submitSignup(event) {
    event.preventDefault();
    clearMessage();
    await apiReady;

    if (!selectedCamp) {
      showMessage("Pick a camp from the calendar before continuing.", "error");
      document.querySelector("#calendar")?.scrollIntoView({ block: "start" });
      return;
    }

    if (!canCheckoutCamp(selectedCamp)) {
      showMessage("This camp is not ready for checkout yet.", "error");
      return;
    }

    if (!form.reportValidity()) return;

    submitButton.disabled = true;
    submitButton.textContent = "Creating Stripe checkout...";

    try {
      const response = await fetch(apiUrl("/create-checkout-session"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(formPayload(form)),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        const detail = friendlyValidationErrors(body.details);
        const missing = body.missingEnv ? ` Missing setup: ${body.missingEnv.join(", ")}.` : "";
        throw new Error(`${body.error || "Could not start checkout."} ${detail}${missing}`.trim());
      }

      if (!body.url) throw new Error("Stripe did not return a checkout URL.");
      window.location.assign(body.url);
    } catch (error) {
      submitButton.disabled = !canCheckoutCamp(selectedCamp);
      submitButton.textContent = canCheckoutCamp(selectedCamp) ? "Continue to Stripe" : "Stripe setup needed";
      showMessage(error.message, "error");
      await loadAll();
    }
  }

  function playersHeadline(status) {
    const names = status.camperNames || [];
    if (names.length > 1) return `${names.length} players are signed up!`;
    if (names.length === 1) return `${names[0]} is signed up!`;
    return "You are signed up!";
  }

  function successDetails(status) {
    const rows = [];
    if (status.campTitle) rows.push(`<li><strong>Camp:</strong> ${escapeHtml(status.campTitle)}</li>`);
    if (status.campStartDate) rows.push(`<li><strong>Dates:</strong> ${escapeHtml(campDateRange(status))}</li>`);
    if (status.campStartTime) {
      rows.push(`<li><strong>Time:</strong> ${escapeHtml(status.campStartTime)} to ${escapeHtml(status.campEndTime || "")}</li>`);
    }
    if (status.campLocation) rows.push(`<li><strong>Location:</strong> ${escapeHtml(status.campLocation)}</li>`);
    if (status.campNotes) rows.push(`<li><strong>What to bring:</strong> ${escapeHtml(status.campNotes)}</li>`);
    if ((status.camperNames || []).length > 1) {
      rows.push(`<li><strong>Players:</strong> ${escapeHtml(status.camperNames.join(", "))}</li>`);
    }
    if (!rows.length) return "";
    return `<ul class="success-details">${rows.join("")}</ul>`;
  }

  async function loadSuccessState() {
    if (!successState) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");

    if (!sessionId) {
      successState.innerHTML = [
        '<p class="section-kicker">Missing session</p>',
        "<h1>We could not find a Stripe session.</h1>",
        '<p class="muted">Please use the signup page again or check your Stripe receipt.</p>',
      ].join("");
      return;
    }

    try {
      const response = await fetch(apiUrl(`/session-status?session_id=${encodeURIComponent(sessionId)}`), {
        headers: { accept: "application/json" },
      });
      const status = await response.json();

      if (response.ok && status.status === "paid") {
        successState.innerHTML = [
          '<p class="section-kicker">Payment confirmed</p>',
          `<h1>${escapeHtml(playersHeadline(status))}</h1>`,
          '<p class="muted">Stripe confirmed your payment. A confirmation email is on its way, and Noah can see the registration in his coach view.</p>',
          successDetails(status),
        ].join("");
        return;
      }

      successState.innerHTML = [
        '<p class="section-kicker">Payment received by Stripe</p>',
        "<h1>Waiting for roster confirmation.</h1>",
        '<p class="muted">The success redirect returned, but the server has not seen the Stripe webhook yet. Refresh in a moment.</p>',
        successDetails(status),
      ].join("");
    } catch (error) {
      successState.innerHTML = [
        '<p class="section-kicker">Backend unavailable</p>',
        "<h1>We could not verify the roster yet.</h1>",
        '<p class="muted">Keep your Stripe receipt. The server must be running to show live confirmation here.</p>',
      ].join("");
    }
  }

  // Kick off API-base resolution immediately; everything that hits the backend
  // awaits it. The form controls wire up synchronously so the page is interactive.
  const apiReady = resolveApiBase();

  if (form) {
    if (addChildButton) addChildButton.addEventListener("click", addChildRow);
    addChildRow();
    form.addEventListener("submit", submitSignup);
  }

  (async function init() {
    await apiReady;
    loadContact();
    if (form) loadAll();
    loadSuccessState();
  })();
})();
