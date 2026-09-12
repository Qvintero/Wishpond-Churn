"use strict";

const CONFIG = Object.freeze({
  endpoint: "https://script.google.com/macros/s/AKfycbwTyNGC9SvJWqnstceylgb3O9mD9G2UysGsmJTbt4q47BY7xtSyq6m5G78tz1XFzMiNIw/exec",
  requestTimeoutMs: 20000,
  saveVerificationDelayMs: 1800,
});

const state = {
  allClients: [],
  filtered: [],
  months: [],
  assignees: { ams: [], csms: [] },
  pending: new Map(),
  writeSecret: "",
  isSaving: false,
  loadedAt: null,
  filters: {
    search: "",
    month: "",
    am: "",
    csm: "",
    risk: "",
    brand: "",
    preventable: "",
    sort: "risk",
  },
};

const elements = {};
let passwordResolver = null;

document.addEventListener("DOMContentLoaded", () => {
  [
    "connectionStatus", "connectionText", "lastUpdated", "sourceLabel", "errorNotice",
    "errorMessage", "refreshButton", "retryButton", "exportButton", "saveAssignmentsButton",
    "changeCount", "clearFilters", "searchInput", "monthFilter", "amFilter", "csmFilter",
    "riskFilter", "brandFilter", "preventableFilter", "sortBy", "totalMrr", "totalMrrNote",
    "confirmedMrr", "confirmedNote", "highRiskMrr", "highRiskNote", "accountCount",
    "accountCountNote", "riskBreakdown", "reasonBreakdown", "resultCount", "accountRows",
    "accountsTitle", "toast", "passwordDialog", "passwordForm", "passwordInput",
  ].forEach((id) => { elements[id] = document.getElementById(id); });

  elements.refreshButton.addEventListener("click", requestRefresh);
  elements.retryButton.addEventListener("click", requestRefresh);
  elements.exportButton.addEventListener("click", exportCsv);
  elements.saveAssignmentsButton.addEventListener("click", saveAssignments);
  elements.clearFilters.addEventListener("click", resetFilters);
  elements.searchInput.addEventListener("input", (event) => updateFilter("search", event.target.value));
  elements.monthFilter.addEventListener("change", (event) => updateFilter("month", event.target.value));
  elements.amFilter.addEventListener("change", (event) => updateFilter("am", event.target.value));
  elements.csmFilter.addEventListener("change", (event) => updateFilter("csm", event.target.value));
  elements.riskFilter.addEventListener("change", (event) => updateFilter("risk", event.target.value));
  elements.brandFilter.addEventListener("change", (event) => updateFilter("brand", event.target.value));
  elements.preventableFilter.addEventListener("change", (event) => updateFilter("preventable", event.target.value));
  elements.sortBy.addEventListener("change", (event) => updateFilter("sort", event.target.value));
  elements.accountRows.addEventListener("change", handleAssignmentChange);
  elements.accountRows.addEventListener("toggle", handleDetailToggle, true);
  elements.passwordForm.addEventListener("submit", handlePasswordSubmit);
  elements.passwordDialog.addEventListener("cancel", handlePasswordCancel);
  window.addEventListener("beforeunload", warnAboutUnsavedChanges);

  loadForecast();
});

async function requestRefresh() {
  if (state.isSaving) return;
  if (state.pending.size && !window.confirm("Refresh and discard the unsaved AM/CSM changes?")) return;
  await loadForecast();
}

async function loadForecast() {
  setConnection("loading", "Refreshing");
  elements.refreshButton.disabled = true;
  elements.errorNotice.hidden = true;

  try {
    const response = await fetchForecast();
    installResponse(response.data, true);
    state.loadedAt = new Date();
    elements.exportButton.disabled = false;
    setConnection("online", "Live data");
    elements.lastUpdated.textContent = `Updated ${formatTime(state.loadedAt)}`;
  } catch (error) {
    console.error("Forecast load failed", error);
    setConnection("error", "Connection issue");
    showError(friendlyError(error));
    if (!state.allClients.length) renderEmptyState("No forecast data is available yet.");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function fetchForecast() {
  const response = await jsonp(CONFIG.endpoint, { t: Date.now() });
  if (!response || response.ok !== true || !response.data) {
    throw new Error(response && response.error ? response.error : "The data service returned an invalid response.");
  }
  return response;
}

function installResponse(data, clearPending) {
  const normalized = normalizeResponse(data);
  state.allClients = normalized.clients;
  state.months = normalized.months;
  state.assignees = {
    ams: sortedUnique([...(data.assignees && data.assignees.ams || []), ...state.allClients.map((client) => client.am)]),
    csms: sortedUnique([...(data.assignees && data.assignees.csms || []), ...state.allClients.map((client) => client.csm)]),
  };
  if (clearPending) state.pending.clear();
  populateFilters();
  updatePendingUi();
  applyFilters();
}

function jsonp(url, params = {}) {
  return new Promise((resolve, reject) => {
    const callbackName = `__wishpondCb${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => finish(new Error("The Google Sheets request timed out.")), CONFIG.requestTimeoutMs);
    const query = new URLSearchParams({ ...params, callback: callbackName });

    function finish(error, value) {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
      if (error) reject(error); else resolve(value);
    }

    window[callbackName] = (value) => finish(null, value);
    script.onerror = () => finish(new Error("The browser could not reach the Google Apps Script deployment."));
    script.src = `${url}?${query.toString()}`;
    document.head.appendChild(script);
  });
}

function normalizeResponse(data) {
  const groups = Array.isArray(data.months)
    ? data.months
    : Array.isArray(data.clients)
      ? [{ name: data.month || "Forecast", sheetName: data.sheetName || "", clients: data.clients }]
      : [];

  const months = groups
    .filter((group) => Array.isArray(group.clients) && group.clients.length)
    .map((group) => ({ name: clean(group.name || group.month || group.sheetName), sheetName: clean(group.sheetName) }));

  const clients = groups.flatMap((group) => {
    const month = clean(group.name || group.month || group.sheetName.replace(/ Forecast$/i, ""));
    const sheetName = clean(group.sheetName || `${month} Forecast`);
    return (Array.isArray(group.clients) ? group.clients : [])
      .filter((row) => clean(row.client || row.clientName))
      .map((row, index) => normalizeClient(row, { month, sheetName, index }));
  });

  return { clients, months };
}

function normalizeClient(row, context) {
  const startDate = normalizeDate(row.startDate);
  const churnDate = normalizeDate(row.churnDate);
  const tenure = toNumber(row.tenureMonths || row.tenure) || calculateTenure(startDate, churnDate);
  const rowNumber = Number(row.rowNumber) || 0;
  return {
    id: rowNumber ? `${context.sheetName}:${rowNumber}` : `${context.sheetName}:${clean(row.client || row.clientName)}:${context.index}`,
    sheetName: context.sheetName,
    month: context.month,
    rowNumber,
    client: clean(row.client || row.clientName),
    am: clean(row.am),
    csm: clean(row.csm),
    mrr: toNumber(row.mrr),
    brand: clean(row.brand),
    startDate,
    churnDate,
    tenure,
    risk: clean(row.risk || row.status) || "Not classified",
    reason: clean(row.mainReasonForChurn || row.reason),
    preventable: clean(row.preventable) || "Unclear",
    comments: clean(row.commentsFromCsm || row.comments),
  };
}

function clean(value) { return String(value == null ? "" : value).trim().replace(/[ \t]+/g, " "); }
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDate(value) {
  const text = clean(value);
  if (!text) return "";
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  if (/\bGMT[+-]\d{4}\b/.test(text)) parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function calculateTenure(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return 0;
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  let months = (ey - sy) * 12 + (em - sm);
  if (ed < sd) months -= 1;
  return Math.max(0, months);
}

function populateFilters() {
  const previousMonth = state.filters.month;
  setMonthOptions(elements.monthFilter, state.months, "All months");
  if (!state.months.some((month) => month.sheetName === previousMonth)) state.filters.month = "";
  setOptions(elements.amFilter, unique("am"), "All AMs");
  setOptions(elements.csmFilter, unique("csm"), "All CSMs");
  setOptions(elements.riskFilter, unique("risk"), "All risk levels");
  setOptions(elements.brandFilter, unique("brand"), "All brands");
  setOptions(elements.preventableFilter, unique("preventable"), "All answers");
}

function unique(field) { return sortedUnique(state.allClients.map((client) => client[field])); }
function sortedUnique(values) { return [...new Set(values.map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }

function setOptions(select, values, firstLabel) {
  const previous = select.value;
  select.innerHTML = `<option value="">${escapeHtml(firstLabel)}</option>${values.map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`).join("")}`;
  if (values.includes(previous)) select.value = previous;
}

function setMonthOptions(select, months, firstLabel) {
  const previous = select.value;
  select.innerHTML = `<option value="">${escapeHtml(firstLabel)}</option>${months.map((month) => `<option value="${escapeAttribute(month.sheetName)}">${escapeHtml(month.name)}</option>`).join("")}`;
  if (months.some((month) => month.sheetName === previous)) select.value = previous;
}

function updateFilter(key, value) { state.filters[key] = value; applyFilters(); }
function resetFilters() {
  state.filters = { search: "", month: "", am: "", csm: "", risk: "", brand: "", preventable: "", sort: "risk" };
  elements.searchInput.value = "";
  elements.monthFilter.value = "";
  elements.amFilter.value = "";
  elements.csmFilter.value = "";
  elements.riskFilter.value = "";
  elements.brandFilter.value = "";
  elements.preventableFilter.value = "";
  elements.sortBy.value = "risk";
  applyFilters();
}

function applyFilters() {
  const query = state.filters.search.trim().toLocaleLowerCase();
  const matches = state.allClients.filter((client) => {
    if (state.filters.month && client.sheetName !== state.filters.month) return false;
    if (state.filters.am && client.am !== state.filters.am) return false;
    if (state.filters.csm && client.csm !== state.filters.csm) return false;
    if (state.filters.risk && client.risk !== state.filters.risk) return false;
    if (state.filters.brand && client.brand !== state.filters.brand) return false;
    if (state.filters.preventable && client.preventable !== state.filters.preventable) return false;
    if (!query) return true;
    return [client.client, client.month, client.am, client.csm, client.brand, client.risk, client.reason, client.comments]
      .some((value) => value.toLocaleLowerCase().includes(query));
  });

  state.filtered = matches.sort(sortClients(state.filters.sort));
  updateViewLabels();
  renderDashboard();
}

function updateViewLabels() {
  const selectedMonth = state.months.find((month) => month.sheetName === state.filters.month);
  elements.sourceLabel.textContent = selectedMonth ? selectedMonth.sheetName : plural(state.months.length, "forecast tab");
  elements.accountsTitle.textContent = selectedMonth ? `${selectedMonth.name} accounts` : "Forecast accounts";
}

function sortClients(sort) {
  const byClient = (a, b) => a.client.localeCompare(b.client);
  if (sort === "mrr") return (a, b) => b.mrr - a.mrr || byClient(a, b);
  if (sort === "date") return (a, b) => (a.churnDate || "9999").localeCompare(b.churnDate || "9999") || byClient(a, b);
  if (sort === "client") return byClient;
  return (a, b) => riskOrder(a.risk) - riskOrder(b.risk) || b.mrr - a.mrr || byClient(a, b);
}

function riskOrder(risk) {
  const value = risk.toLocaleLowerCase();
  if (value.includes("confirmed") || value.includes("cancelled")) return 0;
  if (value.includes("high")) return 1;
  if (value.includes("medium")) return 2;
  return 3;
}

function renderDashboard() { renderSummary(); renderRiskBreakdown(); renderReasonBreakdown(); renderRows(); }

function renderSummary() {
  const visible = state.filtered;
  const totalMrr = sumMrr(visible);
  const confirmed = visible.filter((client) => isConfirmed(client.risk));
  const highRisk = visible.filter((client) => client.risk.toLocaleLowerCase().includes("high"));
  elements.totalMrr.textContent = formatMoney(totalMrr);
  elements.totalMrrNote.textContent = `Across ${plural(visible.length, "visible account")}`;
  elements.confirmedMrr.textContent = formatMoney(sumMrr(confirmed));
  elements.confirmedNote.textContent = `${plural(confirmed.length, "confirmed account")} · ${percent(sumMrr(confirmed), totalMrr)} of visible MRR`;
  elements.highRiskMrr.textContent = formatMoney(sumMrr(highRisk));
  elements.highRiskNote.textContent = `${plural(highRisk.length, "high-risk account")} · ${percent(sumMrr(highRisk), totalMrr)} of visible MRR`;
  elements.accountCount.textContent = String(visible.length);
  elements.accountCountNote.textContent = visible.length === state.allClients.length ? "All forecast accounts" : `${state.allClients.length - visible.length} filtered out`;
}

function renderRiskBreakdown() {
  const groups = [
    { label: "Confirmed churned", test: isConfirmed, color: "var(--danger)" },
    { label: "High risk", test: (risk) => risk.toLocaleLowerCase().includes("high"), color: "var(--warning)" },
    { label: "Medium risk", test: (risk) => risk.toLocaleLowerCase().includes("medium"), color: "#d6a91c" },
    { label: "Other / not classified", test: (risk) => riskOrder(risk) === 3, color: "var(--faint)" },
  ];
  const max = Math.max(1, ...groups.map((group) => state.filtered.filter((client) => group.test(client.risk)).length));
  elements.riskBreakdown.innerHTML = groups.map((group) => {
    const clients = state.filtered.filter((client) => group.test(client.risk));
    return `<div class="risk-row"><span class="risk-name"><span class="risk-swatch" style="background:${group.color}"></span>${escapeHtml(group.label)}</span><div class="risk-track"><div class="risk-fill" style="width:${(clients.length / max) * 100}%;background:${group.color}"></div></div><span class="risk-value">${clients.length} / ${formatMoney(sumMrr(clients))}</span></div>`;
  }).join("");
}

function renderReasonBreakdown() {
  const counts = new Map();
  state.filtered.forEach((client) => {
    const reason = client.reason || "No reason provided";
    counts.set(reason, (counts.get(reason) || 0) + 1);
  });
  const reasons = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6);
  const max = Math.max(1, ...reasons.map(([, count]) => count));
  elements.reasonBreakdown.innerHTML = reasons.length
    ? reasons.map(([reason, count]) => `<div class="reason-row"><div class="reason-topline"><strong title="${escapeAttribute(reason)}">${escapeHtml(reason)}</strong><span>${count}</span></div><div class="reason-track"><div class="reason-fill" style="width:${(count / max) * 100}%"></div></div></div>`).join("")
    : '<p class="empty-cell">No reasons match the current filters.</p>';
}

function renderRows() {
  elements.resultCount.textContent = `${plural(state.filtered.length, "account")} shown`;
  if (!state.filtered.length) { renderEmptyState("No accounts match the current filters."); return; }

  elements.accountRows.innerHTML = state.filtered.map((client, index) => {
    const rowId = `detail-${index}`;
    const pending = state.pending.get(client.id);
    const amChanged = pending && pending.am !== pending.originalAm;
    const csmChanged = pending && pending.csm !== pending.originalCsm;
    const canEdit = Boolean(client.rowNumber) && !state.isSaving;
    return `<tr class="data-row${pending ? " dirty" : ""}">
      <td><span class="account-name">${escapeHtml(client.client)}<small>${client.tenure ? `${client.tenure} month tenure` : "Tenure unavailable"}</small></span></td>
      <td><span class="month-pill">${escapeHtml(client.month)}</span></td>
      <td>${assignmentSelect(client, "am", state.assignees.ams, amChanged, canEdit)}</td>
      <td>${assignmentSelect(client, "csm", state.assignees.csms, csmChanged, canEdit)}</td>
      <td class="money">${formatMoney(client.mrr)}</td>
      <td>${escapeHtml(client.brand || "—")}</td>
      <td><span class="pill ${riskClass(client.risk)}">${escapeHtml(client.risk)}</span></td>
      <td>${escapeHtml(formatDate(client.churnDate))}</td>
      <td class="reason-cell">${escapeHtml(client.reason || "—")}</td>
      <td><span class="pill ${preventableClass(client.preventable)}">${escapeHtml(client.preventable)}</span></td>
      <td><details class="details-toggle" data-target="${rowId}"><summary aria-label="Show details for ${escapeAttribute(client.client)}"></summary></details></td>
    </tr>
    <tr class="detail-row" id="${rowId}"><td colspan="11"><div class="detail-card">
      <div class="detail-item"><span>Start date</span><strong>${escapeHtml(formatDate(client.startDate))}</strong></div>
      <div class="detail-item"><span>Forecast date</span><strong>${escapeHtml(formatDate(client.churnDate))}</strong></div>
      <div class="detail-item"><span>Tenure</span><strong>${client.tenure ? `${client.tenure} months` : "—"}</strong></div>
      <div class="detail-item"><span>CSM comments</span><p>${escapeHtml(client.comments || "No comments provided.")}</p></div>
    </div></td></tr>`;
  }).join("");
}

function assignmentSelect(client, field, values, changed, canEdit) {
  const current = client[field];
  const options = sortedUnique([...values, current]);
  return `<select class="assignment-select${changed ? " changed" : ""}" data-client-id="${escapeAttribute(client.id)}" data-field="${field}" aria-label="${field.toUpperCase()} for ${escapeAttribute(client.client)}"${canEdit ? "" : " disabled title=\"Update Apps Script before editing assignments\""}>
    <option value="">Unassigned</option>
    ${options.map((value) => `<option value="${escapeAttribute(value)}"${value === current ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}
  </select>`;
}

function handleAssignmentChange(event) {
  if (state.isSaving) return;
  const select = event.target.closest(".assignment-select");
  if (!select) return;
  const client = state.allClients.find((item) => item.id === select.dataset.clientId);
  if (!client) return;

  const field = select.dataset.field;
  let pending = state.pending.get(client.id);
  if (!pending) {
    pending = {
      id: client.id,
      sheetName: client.sheetName,
      rowNumber: client.rowNumber,
      client: client.client,
      originalAm: client.am,
      originalCsm: client.csm,
      am: client.am,
      csm: client.csm,
    };
  }

  pending[field] = select.value;
  client[field] = select.value;
  if (pending.am === pending.originalAm && pending.csm === pending.originalCsm) state.pending.delete(client.id);
  else state.pending.set(client.id, pending);
  updatePendingUi();
  applyFilters();
}

function updatePendingUi() {
  const count = state.pending.size;
  elements.saveAssignmentsButton.disabled = count === 0;
  elements.changeCount.hidden = count === 0;
  elements.changeCount.textContent = String(count);
}

async function saveAssignments() {
  if (!state.pending.size) return;
  const secret = state.writeSecret || await requestPassword();
  if (!secret) return;
  state.writeSecret = secret;
  const updates = [...state.pending.values()].map((item) => ({
    sheetName: item.sheetName,
    rowNumber: item.rowNumber,
    client: item.client,
    am: item.am,
    csm: item.csm,
  }));

  elements.saveAssignmentsButton.disabled = true;
  elements.refreshButton.disabled = true;
  state.isSaving = true;
  renderRows();
  setConnection("loading", "Saving changes");
  elements.errorNotice.hidden = true;

  try {
    await fetch(CONFIG.endpoint, {
      method: "POST",
      mode: "no-cors",
      cache: "no-store",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ writeSecret: secret, updates }),
    });
    await delay(CONFIG.saveVerificationDelayMs);
    const response = await fetchForecast();
    verifySavedUpdates(updates, normalizeResponse(response.data).clients);
    installResponse(response.data, true);
    state.loadedAt = new Date();
    elements.lastUpdated.textContent = `Updated ${formatTime(state.loadedAt)}`;
    setConnection("online", "Changes saved");
    toast(`${plural(updates.length, "assignment")} saved to Google Sheets.`, "success");
  } catch (error) {
    console.error("Assignment save failed", error);
    state.writeSecret = "";
    setConnection("error", "Save failed");
    showError(friendlySaveError(error));
    toast("The assignment changes were not saved.", "error");
  } finally {
    state.isSaving = false;
    elements.refreshButton.disabled = false;
    updatePendingUi();
    renderRows();
  }
}

function verifySavedUpdates(updates, freshClients) {
  const failures = updates.filter((update) => {
    const saved = freshClients.find((client) => client.sheetName === update.sheetName && client.rowNumber === update.rowNumber && client.client === update.client);
    return !saved || saved.am !== update.am || saved.csm !== update.csm;
  });
  if (failures.length) throw new Error("The server did not confirm the changes. The editing password may be incorrect, or Apps Script may need to be redeployed.");
}

function requestPassword() {
  return new Promise((resolve) => {
    passwordResolver = resolve;
    elements.passwordInput.value = "";
    elements.passwordDialog.showModal();
    window.setTimeout(() => elements.passwordInput.focus(), 0);
  });
}

function handlePasswordSubmit(event) {
  event.preventDefault();
  const confirmed = event.submitter && event.submitter.value === "confirm";
  const value = confirmed ? elements.passwordInput.value : "";
  elements.passwordDialog.close();
  if (passwordResolver) passwordResolver(value);
  passwordResolver = null;
}

function handlePasswordCancel(event) {
  event.preventDefault();
  elements.passwordDialog.close();
  if (passwordResolver) passwordResolver("");
  passwordResolver = null;
}

function handleDetailToggle(event) {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement)) return;
  const row = document.getElementById(details.dataset.target);
  if (row) row.classList.toggle("visible", details.open);
}

function warnAboutUnsavedChanges(event) {
  if (!state.pending.size) return;
  event.preventDefault();
  event.returnValue = "";
}

function renderEmptyState(message) {
  elements.accountRows.innerHTML = `<tr><td class="empty-cell" colspan="11">${escapeHtml(message)}</td></tr>`;
  elements.resultCount.textContent = "0 accounts shown";
}

function exportCsv() {
  const headers = ["Month", "Client Name", "AM", "CSM", "MRR", "Brand", "Start date", "Churn Date", "Tenure (Months)", "Risk", "Main Reason for Churn", "Preventable?", "Comments from CSM"];
  const rows = state.filtered.map((client) => [client.month, client.client, client.am, client.csm, client.mrr, client.brand, client.startDate, client.churnDate, client.tenure || "", client.risk, client.reason, client.preventable, client.comments]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `wishpond-churn-forecast${state.filters.month ? `-${slugify(elements.monthFilter.selectedOptions[0].textContent)}` : ""}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function showError(message) { elements.errorMessage.textContent = message; elements.errorNotice.hidden = false; }
function toast(message, type) {
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type || ""}`;
  window.clearTimeout(elements.toast.timeout);
  elements.toast.timeout = window.setTimeout(() => { elements.toast.className = "toast"; }, 3500);
}
function delay(milliseconds) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }
function csvCell(value) { return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`; }
function sumMrr(clients) { return clients.reduce((total, client) => total + client.mrr, 0); }
function plural(value, word) { return `${value} ${word}${value === 1 ? "" : "s"}`; }
function percent(value, total) { return total ? `${Math.round((value / total) * 100)}%` : "0%"; }
function isConfirmed(risk) { const value = risk.toLocaleLowerCase(); return value.includes("confirmed") || value.includes("cancelled"); }
function formatMoney(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value % 1 ? 2 : 0 }).format(value || 0); }
function formatTime(date) { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date); }
function formatDate(value) {
  if (!value) return "—";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}
function riskClass(risk) {
  const value = risk.toLocaleLowerCase();
  if (value.includes("confirmed") || value.includes("cancelled")) return "pill-danger";
  if (value.includes("high")) return "pill-warning";
  if (value.includes("medium")) return "pill-medium";
  return "pill-neutral";
}
function preventableClass(value) {
  const answer = value.toLocaleLowerCase();
  if (answer === "yes") return "pill-danger";
  if (answer === "no") return "pill-success";
  return "pill-neutral";
}
function setConnection(mode, text) { elements.connectionStatus.className = `connection-status ${mode}`; elements.connectionText.textContent = text; }
function friendlyError(error) {
  const message = error && error.message ? error.message : "Unknown connection error.";
  if (/timed out/i.test(message)) return "The data service took too long to respond. Confirm the Apps Script web app is deployed for Anyone, then retry.";
  if (/reach/i.test(message)) return "Confirm the Apps Script deployment URL is current and its access is set to Anyone.";
  return message;
}
function friendlySaveError(error) {
  const message = error && error.message ? error.message : "Unknown save error.";
  if (/server did not confirm/i.test(message)) return message;
  return `Could not save the assignments: ${message}`;
}
function slugify(value) { return clean(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function escapeHtml(value) { return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#096;"); }
