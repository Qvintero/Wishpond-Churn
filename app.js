"use strict";

const CONFIG = Object.freeze({
  endpoint: "https://script.google.com/macros/s/AKfycbwTyNGC9SvJWqnstceylgb3O9mD9G2UysGsmJTbt4q47BY7xtSyq6m5G78tz1XFzMiNIw/exec",
  sheetName: "September Forecast",
  requestTimeoutMs: 15000,
});

const state = {
  clients: [],
  filtered: [],
  loadedAt: null,
  filters: { search: "", risk: "", csm: "", brand: "", preventable: "", sort: "risk" },
};
const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "connectionStatus", "connectionText", "lastUpdated", "errorNotice", "errorMessage",
    "refreshButton", "retryButton", "exportButton", "clearFilters", "searchInput",
    "riskFilter", "csmFilter", "brandFilter", "preventableFilter", "sortBy",
    "totalMrr", "totalMrrNote", "confirmedMrr", "confirmedNote", "highRiskMrr",
    "highRiskNote", "accountCount", "accountCountNote", "riskBreakdown",
    "reasonBreakdown", "resultCount", "accountRows",
  ].forEach((id) => { elements[id] = document.getElementById(id); });

  elements.refreshButton.addEventListener("click", loadForecast);
  elements.retryButton.addEventListener("click", loadForecast);
  elements.exportButton.addEventListener("click", exportCsv);
  elements.clearFilters.addEventListener("click", resetFilters);
  elements.searchInput.addEventListener("input", (event) => updateFilter("search", event.target.value));
  elements.riskFilter.addEventListener("change", (event) => updateFilter("risk", event.target.value));
  elements.csmFilter.addEventListener("change", (event) => updateFilter("csm", event.target.value));
  elements.brandFilter.addEventListener("change", (event) => updateFilter("brand", event.target.value));
  elements.preventableFilter.addEventListener("change", (event) => updateFilter("preventable", event.target.value));
  elements.sortBy.addEventListener("change", (event) => updateFilter("sort", event.target.value));
  elements.accountRows.addEventListener("toggle", handleDetailToggle, true);
  loadForecast();
});

async function loadForecast() {
  setConnection("loading", "Refreshing");
  elements.refreshButton.disabled = true;
  elements.errorNotice.hidden = true;

  try {
    const response = await jsonp(CONFIG.endpoint, { sheet: CONFIG.sheetName, t: Date.now() });
    if (!response || response.ok !== true || !response.data) {
      throw new Error(response && response.error ? response.error : "The data service returned an invalid response.");
    }
    state.clients = normalizeResponse(response.data);
    state.loadedAt = new Date();
    populateFilters();
    applyFilters();
    elements.exportButton.disabled = false;
    setConnection("online", "Live data");
    elements.lastUpdated.textContent = `Updated ${formatTime(state.loadedAt)}`;
  } catch (error) {
    console.error("Forecast load failed", error);
    setConnection("error", "Connection issue");
    elements.errorMessage.textContent = friendlyError(error);
    elements.errorNotice.hidden = false;
    if (!state.clients.length) renderEmptyState("No forecast data is available yet.");
  } finally {
    elements.refreshButton.disabled = false;
  }
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
  const groups = Array.isArray(data.clients) ? [data] : Array.isArray(data.months) ? data.months : [];
  return groups.flatMap((group) => Array.isArray(group.clients) ? group.clients : [])
    .filter((row) => clean(row.client || row.clientName))
    .map((row, index) => {
      const startDate = normalizeDate(row.startDate);
      const churnDate = normalizeDate(row.churnDate);
      const tenure = toNumber(row.tenureMonths || row.tenure) || calculateTenure(startDate, churnDate);
      return {
        id: `${clean(row.client || row.clientName)}-${index}`,
        client: clean(row.client || row.clientName),
        am: clean(row.am),
        csm: clean(row.csm),
        mrr: toNumber(row.mrr),
        brand: clean(row.brand),
        startDate,
        churnDate,
        tenure,
        risk: clean(row.risk) || "Not classified",
        reason: clean(row.mainReasonForChurn || row.reason),
        preventable: clean(row.preventable) || "Unclear",
        comments: clean(row.commentsFromCsm || row.comments),
      };
    });
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
  // The legacy endpoint stringifies Sheet dates late on the prior day.
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
  setOptions(elements.riskFilter, unique("risk"), "All risk levels");
  setOptions(elements.csmFilter, unique("csm"), "All CSMs");
  setOptions(elements.brandFilter, unique("brand"), "All brands");
  setOptions(elements.preventableFilter, unique("preventable"), "All answers");
}
function unique(field) { return [...new Set(state.clients.map((client) => client[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
function setOptions(select, values, firstLabel) {
  const previous = select.value;
  select.innerHTML = `<option value="">${escapeHtml(firstLabel)}</option>${values.map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`).join("")}`;
  if (values.includes(previous)) select.value = previous;
}

function updateFilter(key, value) { state.filters[key] = value; applyFilters(); }
function resetFilters() {
  state.filters = { search: "", risk: "", csm: "", brand: "", preventable: "", sort: "risk" };
  elements.searchInput.value = "";
  elements.riskFilter.value = "";
  elements.csmFilter.value = "";
  elements.brandFilter.value = "";
  elements.preventableFilter.value = "";
  elements.sortBy.value = "risk";
  applyFilters();
}

function applyFilters() {
  const query = state.filters.search.trim().toLocaleLowerCase();
  const matches = state.clients.filter((client) => {
    if (state.filters.risk && client.risk !== state.filters.risk) return false;
    if (state.filters.csm && client.csm !== state.filters.csm) return false;
    if (state.filters.brand && client.brand !== state.filters.brand) return false;
    if (state.filters.preventable && client.preventable !== state.filters.preventable) return false;
    if (!query) return true;
    return [client.client, client.am, client.csm, client.brand, client.risk, client.reason, client.comments]
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
  state.filtered = matches.sort(sortClients(state.filters.sort));
  renderDashboard();
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
  if (value.includes("confirmed")) return 0;
  if (value.includes("high")) return 1;
  if (value.includes("medium")) return 2;
  return 3;
}

function renderDashboard() { renderSummary(); renderRiskBreakdown(); renderReasonBreakdown(); renderRows(); }
function renderSummary() {
  const visible = state.filtered;
  const totalMrr = sumMrr(visible);
  const confirmed = visible.filter((client) => client.risk.toLocaleLowerCase().includes("confirmed"));
  const highRisk = visible.filter((client) => client.risk.toLocaleLowerCase().includes("high"));
  elements.totalMrr.textContent = formatMoney(totalMrr);
  elements.totalMrrNote.textContent = `Across ${plural(visible.length, "visible account")}`;
  elements.confirmedMrr.textContent = formatMoney(sumMrr(confirmed));
  elements.confirmedNote.textContent = `${plural(confirmed.length, "confirmed account")} · ${percent(sumMrr(confirmed), totalMrr)} of visible MRR`;
  elements.highRiskMrr.textContent = formatMoney(sumMrr(highRisk));
  elements.highRiskNote.textContent = `${plural(highRisk.length, "high-risk account")} · ${percent(sumMrr(highRisk), totalMrr)} of visible MRR`;
  elements.accountCount.textContent = String(visible.length);
  elements.accountCountNote.textContent = visible.length === state.clients.length ? "All forecast accounts" : `${state.clients.length - visible.length} filtered out`;
}

function renderRiskBreakdown() {
  const groups = [
    { label: "Confirmed churned", test: (risk) => risk.includes("confirmed"), color: "var(--danger)" },
    { label: "High risk", test: (risk) => risk.includes("high"), color: "var(--warning)" },
    { label: "Medium risk", test: (risk) => risk.includes("medium"), color: "#d6a91c" },
    { label: "Not classified", test: (risk) => !risk.includes("confirmed") && !risk.includes("high") && !risk.includes("medium"), color: "var(--faint)" },
  ];
  const max = Math.max(1, ...groups.map((group) => state.filtered.filter((client) => group.test(client.risk.toLocaleLowerCase())).length));
  elements.riskBreakdown.innerHTML = groups.map((group) => {
    const clients = state.filtered.filter((client) => group.test(client.risk.toLocaleLowerCase()));
    return `<div class="risk-row"><span class="risk-name"><span class="risk-swatch" style="background:${group.color}"></span>${escapeHtml(group.label)}</span><div class="risk-track"><div class="risk-fill" style="width:${(clients.length / max) * 100}%;background:${group.color}"></div></div><span class="risk-value">${clients.length} / ${formatMoney(sumMrr(clients))}</span></div>`;
  }).join("");
}

function renderReasonBreakdown() {
  const counts = new Map();
  state.filtered.forEach((client) => { const reason = client.reason || "No reason provided"; counts.set(reason, (counts.get(reason) || 0) + 1); });
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
    return `<tr class="data-row">
      <td><span class="account-name">${escapeHtml(client.client)}<small>${client.tenure ? `${client.tenure} month tenure` : "Tenure unavailable"}</small></span></td>
      <td><span class="owner">${escapeHtml(client.csm || "Unassigned")}<small>AM: ${escapeHtml(client.am || "—")}</small></span></td>
      <td class="money">${formatMoney(client.mrr)}</td>
      <td>${escapeHtml(client.brand || "—")}</td>
      <td><span class="pill ${riskClass(client.risk)}">${escapeHtml(client.risk)}</span></td>
      <td>${escapeHtml(formatDate(client.churnDate))}</td>
      <td class="reason-cell">${escapeHtml(client.reason || "—")}</td>
      <td><span class="pill ${preventableClass(client.preventable)}">${escapeHtml(client.preventable)}</span></td>
      <td><details class="details-toggle" data-target="${rowId}"><summary aria-label="Show details for ${escapeAttribute(client.client)}"></summary></details></td>
    </tr>
    <tr class="detail-row" id="${rowId}"><td colspan="9"><div class="detail-card">
      <div class="detail-item"><span>Start date</span><strong>${escapeHtml(formatDate(client.startDate))}</strong></div>
      <div class="detail-item"><span>Forecast date</span><strong>${escapeHtml(formatDate(client.churnDate))}</strong></div>
      <div class="detail-item"><span>Tenure</span><strong>${client.tenure ? `${client.tenure} months` : "—"}</strong></div>
      <div class="detail-item"><span>CSM comments</span><p>${escapeHtml(client.comments || "No comments provided.")}</p></div>
    </div></td></tr>`;
  }).join("");
}

function handleDetailToggle(event) {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement)) return;
  const row = document.getElementById(details.dataset.target);
  if (row) row.classList.toggle("visible", details.open);
}
function renderEmptyState(message) {
  elements.accountRows.innerHTML = `<tr><td class="empty-cell" colspan="9">${escapeHtml(message)}</td></tr>`;
  elements.resultCount.textContent = "0 accounts shown";
}

function exportCsv() {
  const headers = ["Client Name", "AM", "CSM", "MRR", "Brand", "Start date", "Churn Date", "Tenure (Months)", "Risk", "Main Reason for Churn", "Preventable?", "Comments from CSM"];
  const rows = state.filtered.map((client) => [client.client, client.am, client.csm, client.mrr, client.brand, client.startDate, client.churnDate, client.tenure || "", client.risk, client.reason, client.preventable, client.comments]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "wishpond-september-forecast.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value) { return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`; }
function sumMrr(clients) { return clients.reduce((total, client) => total + client.mrr, 0); }
function plural(value, word) { return `${value} ${word}${value === 1 ? "" : "s"}`; }
function percent(value, total) { return total ? `${Math.round((value / total) * 100)}%` : "0%"; }
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
  if (value.includes("confirmed")) return "pill-danger";
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
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#096;"); }
