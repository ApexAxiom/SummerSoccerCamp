(function () {
  const form = document.querySelector("#signup-form");
  const campIdInput = document.querySelector("#camp-id");
  const statusPanel = document.querySelector("#backend-status");
  const submitButton = document.querySelector("#submit-button");
  const message = document.querySelector("#form-message");
  const successState = document.querySelector("#success-state");
  const calendarRoot = document.querySelector("#camp-calendar");
  const selectedCampPanel = document.querySelector("#selected-camp");
  const SUMMER_MONTHS = ["2026-06", "2026-07", "2026-08"];

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

  function formPayload(formElement) {
    const data = new FormData(formElement);
    return {
      campId: data.get("campId"),
      camperName: data.get("camperName"),
      camperAge: data.get("camperAge"),
      parentName: data.get("parentName"),
      parentEmail: data.get("parentEmail"),
      parentPhone: data.get("parentPhone"),
      goals: data.get("goals"),
      waiverAccepted: data.get("waiverAccepted") === "on",
      website: data.get("website"),
    };
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

  async function loadAll() {
    if (!form || !calendarRoot) return;

    try {
      const [configResponse, campsResponse] = await Promise.all([
        fetch("/api/config", { headers: { accept: "application/json" } }),
        fetch("/api/camps", { headers: { accept: "application/json" } }),
      ]);
      if (!configResponse.ok) throw new Error("Config endpoint is unavailable.");
      if (!campsResponse.ok) throw new Error("Camp calendar endpoint is unavailable.");

      await configResponse.json();
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
      const response = await fetch("/api/create-checkout-session", {
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
      const response = await fetch(`/api/session-status?session_id=${encodeURIComponent(sessionId)}`, {
        headers: { accept: "application/json" },
      });
      const status = await response.json();
      const campText = status.campTitle ? `${status.campTitle} · ${campDateRange(status)}` : status.serviceName;

      if (response.ok && status.status === "paid") {
        successState.innerHTML = [
          '<p class="section-kicker">Payment confirmed</p>',
          "<h1>You are signed up.</h1>",
          `<p class="muted">Stripe confirmed payment for ${escapeHtml(campText)}. Noah can see the registration in his coach view.</p>`,
        ].join("");
        return;
      }

      successState.innerHTML = [
        '<p class="section-kicker">Payment received by Stripe</p>',
        "<h1>Waiting for roster confirmation.</h1>",
        '<p class="muted">The success redirect returned, but the server has not seen the Stripe webhook yet. Refresh in a moment.</p>',
      ].join("");
    } catch (error) {
      successState.innerHTML = [
        '<p class="section-kicker">Backend unavailable</p>',
        "<h1>We could not verify the roster yet.</h1>",
        '<p class="muted">Keep your Stripe receipt. The server must be running to show live confirmation here.</p>',
      ].join("");
    }
  }

  if (form) {
    form.addEventListener("submit", submitSignup);
    loadAll();
  }

  loadSuccessState();
})();
