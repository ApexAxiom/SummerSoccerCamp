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
      // No outputs file (local dev), so keep the /api default.
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
    if (ready || !text) {
      statusPanel.hidden = true;
      return;
    }
    statusPanel.hidden = false;
    statusPanel.textContent = text;
    statusPanel.dataset.ready = "false";
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
        "<strong>Camp dates are coming soon!</strong>",
        "<span>Check back shortly. Noah's lining up this summer's sessions.</span>",
        "</div>",
      ].join("");
      setStatus("Camp dates are coming soon. Check back shortly!", false);
      updateSelectedCamp(null);
      return;
    }

    const missing = Array.from(new Set(camps.flatMap((camp) => camp.missingEnv || [])));
    if (missing.length) {
      setStatus("Online signup is opening soon. You can browse the camps now.", false);
    } else {
      setStatus("", true);
    }

    const monthKeys = Array.from(new Set([
      ...SUMMER_MONTHS,
      ...camps.map((camp) => camp.startDate.slice(0, 7)),
      ...camps.map((camp) => camp.endDate.slice(0, 7)),
    ])).sort();

    const monthsHtml = monthKeys.map((key) => {
      const monthCamps = camps.filter((camp) => campIntersectsMonth(camp, key));
      return renderMonth(key, monthCamps);
    }).join("");

    calendarRoot.innerHTML = `<div class="calendar-months">${monthsHtml}</div>${renderAgenda()}`;

    calendarRoot.querySelectorAll("[data-camp-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const camp = camps.find((item) => item.id === button.dataset.campId);
        if (camp) updateSelectedCamp(camp);
      });
    });
  }

  function addDays(dateObj, n) {
    return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate() + n);
  }

  function compactTime(value) {
    return String(value || "").replace(/:00/g, "").replace(/\s+/g, " ").trim();
  }

  function timeRange(start, end) {
    const s = compactTime(start);
    const e = compactTime(end);
    if (!s) return e;
    if (!e) return s;
    const sm = (s.match(/[AP]M/i) || [])[0];
    const em = (e.match(/[AP]M/i) || [])[0];
    if (sm && em && sm.toUpperCase() === em.toUpperCase()) {
      return `${s.replace(/\s*[AP]M/i, "")}-${e}`;
    }
    return `${s}-${e}`;
  }

  function barMeta(camp) {
    return [timeRange(camp.startTime, camp.endTime), campStatusText(camp)].filter(Boolean).join(" · ");
  }

  // Greedy interval packing: place each camp segment in the first lane (row)
  // where it doesn't overlap an already-placed segment. Returns the lane count.
  function packLanes(segments) {
    const lanes = [];
    segments
      .slice()
      .sort((a, b) => a.colStart - b.colStart || b.span - a.span)
      .forEach((seg) => {
        let lane = lanes.findIndex((placed) => placed.every((s) => seg.colStart > s.colEnd || seg.colEnd < s.colStart));
        if (lane === -1) {
          lane = lanes.length;
          lanes.push([]);
        }
        lanes[lane].push(seg);
        seg.lane = lane;
      });
    return Math.max(lanes.length, 1);
  }

  function renderBar(seg) {
    const camp = seg.camp;
    const selectable = canSelectCamp(camp);
    const classes = ["bar"];
    if (selectedCamp?.id === camp.id) classes.push("is-selected");
    if (!selectable) classes.push("is-disabled");
    const attrs = [
      `class="${classes.join(" ")}"`,
      "type=\"button\"",
      `data-camp-id="${escapeHtml(camp.id)}"`,
      `data-color="${escapeHtml(camp.color || "green")}"`,
      seg.clipLeft ? "data-clip-left" : "",
      seg.clipRight ? "data-clip-right" : "",
      `style="grid-column:${seg.colStart + 1}/span ${seg.span};grid-row:${seg.lane + 1};"`,
      selectable ? "" : "disabled",
      `title="${escapeHtml(`${camp.title} · ${campDateRange(camp)} · ${barMeta(camp)}`)}"`,
    ].filter(Boolean).join(" ");
    return `<button ${attrs}>`
      + `<span class="bar__title">${escapeHtml(camp.title)}</span>`
      + `<span class="bar__meta">${escapeHtml(barMeta(camp))}</span>`
      + "</button>";
  }

  function renderWeek(cells, monthCamps) {
    const weekStart = cells[0].date;
    const weekEnd = cells[6].date;

    const segments = monthCamps
      .filter((camp) => camp.startDate <= weekEnd && campEndDate(camp) >= weekStart)
      .map((camp) => {
        const segStart = camp.startDate > weekStart ? camp.startDate : weekStart;
        const segEnd = campEndDate(camp) < weekEnd ? campEndDate(camp) : weekEnd;
        const colStart = dayDifference(weekStart, segStart);
        const colEnd = dayDifference(weekStart, segEnd);
        return {
          camp,
          colStart,
          colEnd,
          span: colEnd - colStart + 1,
          clipLeft: camp.startDate < weekStart,
          clipRight: campEndDate(camp) > weekEnd,
        };
      });

    const laneCount = packLanes(segments);
    const dayCells = cells
      .map((cell) => `<div class="day${cell.inMonth ? "" : " day--muted"}"><span class="day__num">${cell.day}</span></div>`)
      .join("");
    const bars = segments.map(renderBar).join("");

    return `
      <div class="week">
        <div class="week__days">${dayCells}</div>
        <div class="week__bars" style="grid-template-rows:repeat(${laneCount}, var(--bar-h));">${bars}</div>
      </div>`;
  }

  function renderMonth(monthKey, monthCamps) {
    const [year, month] = monthKey.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const firstSunday = new Date(year, month - 1, 1 - firstWeekday);
    const weekCount = Math.ceil((firstWeekday + daysInMonth) / 7);

    const weeks = [];
    for (let w = 0; w < weekCount; w += 1) {
      const cells = [];
      for (let c = 0; c < 7; c += 1) {
        const d = addDays(firstSunday, w * 7 + c);
        cells.push({ date: dateKey(d), day: d.getDate(), inMonth: d.getMonth() === month - 1 });
      }
      weeks.push(cells);
    }

    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<span>${d}</span>`).join("");
    const monthName = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long" });

    return `
      <article class="month">
        <header class="month__head">
          <span class="month__name">${escapeHtml(monthName)}</span>
          <span class="month__year">${year}</span>
        </header>
        <div class="month__weekdays">${weekdays}</div>
        <div class="month__weeks">${weeks.map((cells) => renderWeek(cells, monthCamps)).join("")}</div>
      </article>`;
  }

  function renderAgenda() {
    const items = camps
      .slice()
      .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
      .map((camp) => {
        const selectable = canSelectCamp(camp);
        const classes = ["agenda__item"];
        if (selectedCamp?.id === camp.id) classes.push("is-selected");
        if (!selectable) classes.push("is-disabled");
        return `<button class="${classes.join(" ")}" type="button" data-camp-id="${escapeHtml(camp.id)}" data-color="${escapeHtml(camp.color || "green")}"${selectable ? "" : " disabled"}>`
          + `<span class="agenda__date">${escapeHtml(campDateRange(camp))}</span>`
          + `<span class="agenda__title">${escapeHtml(camp.title)}</span>`
          + `<span class="agenda__meta">${escapeHtml(barMeta(camp))}</span>`
          + "</button>";
      }).join("");
    return `<div class="agenda">${items}</div>`;
  }

  function updateSelectedCamp(camp) {
    selectedCamp = camp;
    if (campIdInput) campIdInput.value = camp ? camp.id : "";
    clearMessage();

    if (!selectedCampPanel) return;

    if (!camp) {
      selectedCampPanel.innerHTML = [
        "<strong>No camp picked yet.</strong>",
        "<span>Tap a camp on the calendar above to get started.</span>",
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
      submitButton.textContent = "Signups opening soon";
      showMessage("Online signup for this camp is opening soon. Check back shortly.", "info");
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
      calendarRoot.innerHTML = '<div class="empty-state wide"><strong>We couldn\'t load the camps.</strong><span>Please refresh the page in a moment.</span></div>';
      setStatus("We couldn't load the camps right now. Please refresh in a moment.", false);
      updateSelectedCamp(null);
    }
  }

  async function submitSignup(event) {
    event.preventDefault();
    clearMessage();
    await apiReady;

    if (!selectedCamp) {
      showMessage("Please pick a camp from the calendar first.", "error");
      document.querySelector("#calendar")?.scrollIntoView({ block: "start" });
      return;
    }

    if (!canCheckoutCamp(selectedCamp)) {
      showMessage("This camp isn't open for signup right now.", "error");
      return;
    }

    if (!form.reportValidity()) return;

    submitButton.disabled = true;
    submitButton.textContent = "Taking you to checkout…";

    try {
      const response = await fetch(apiUrl("/create-checkout-session"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(formPayload(form)),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (body.missingEnv && body.missingEnv.length) {
          throw new Error("Online signup for this camp is opening soon. Check back shortly.");
        }
        const detail = friendlyValidationErrors(body.details);
        throw new Error(`${body.error || "Sorry, we couldn't start checkout."} ${detail}`.trim());
      }

      if (!body.url) throw new Error("Sorry, we couldn't reach checkout. Please try again.");
      window.location.assign(body.url);
    } catch (error) {
      submitButton.disabled = !canCheckoutCamp(selectedCamp);
      submitButton.textContent = canCheckoutCamp(selectedCamp) ? "Continue to Stripe" : "Signups opening soon";
      showMessage(error.message, "error");
      await loadAll();
    }
  }

  function playersHeadline(status) {
    const names = status.camperNames || [];
    if (names.length > 1) return `${names.length} players are signed up!`;
    if (names.length === 1) return `${names[0]} is signed up!`;
    return "You're signed up!";
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
        '<p class="section-kicker">Hmm</p>',
        "<h1>We couldn't find your signup.</h1>",
        '<p class="muted">Head back to the camps page and try again, or check your email for a Stripe receipt.</p>',
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
          '<p class="section-kicker">You\'re in!</p>',
          `<h1>${escapeHtml(playersHeadline(status))}</h1>`,
          '<p class="muted">Your payment went through and a confirmation email is on its way. See you on the field!</p>',
          successDetails(status),
        ].join("");
        return;
      }

      successState.innerHTML = [
        '<p class="section-kicker">Almost there</p>',
        "<h1>Confirming your spot…</h1>",
        '<p class="muted">Your payment went through, and we\'re just wrapping up. This page will update in a few seconds.</p>',
        successDetails(status),
      ].join("");
    } catch (error) {
      successState.innerHTML = [
        '<p class="section-kicker">Hang tight</p>',
        "<h1>We're confirming your signup.</h1>",
        '<p class="muted">Keep your Stripe receipt handy. If this doesn\'t update shortly, reach out to Noah and we\'ll sort it out.</p>',
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
