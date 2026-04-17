const state = {
  tabs: [],
  clusters: [],
  uncategorised: [],
  selectedTabIds: new Set(),
  lastClosedTabs: null,
  collapsed: new Set(),
  hasRelevance: false,
  apiKey: "",
  privacyMode: false,
  maxClusters: 8,
  maxSnippet: 500,
  excludedDomains: [],
  onboardingDone: false,
  isScanning: false,
};

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  initEventListeners();
  initRuntimeListeners();

  if (!state.onboardingDone) {
    showView("onboarding-view");
  } else if (!state.apiKey) {
    showView("settings-view");
  } else {
    showView("main-view");
    const cached = await send("loadLastScan");
    if (cached?.result) applyScanResult(cached.result, { fromCache: true });
    await performScan();
  }
});

async function loadSettings() {
  const s = await chrome.storage.sync.get(["apiKey", "privacyMode", "maxClusters", "maxSnippet", "excludedDomains", "onboardingDone"]);
  state.apiKey = s.apiKey || "";
  state.privacyMode = !!s.privacyMode;
  state.maxClusters = Number(s.maxClusters) || 8;
  state.maxSnippet = Number(s.maxSnippet) || 500;
  state.excludedDomains = Array.isArray(s.excludedDomains) ? s.excludedDomains : [];
  state.onboardingDone = !!s.onboardingDone;

  byId("api-key").value = state.apiKey;
  byId("privacy-mode").checked = state.privacyMode;
  byId("max-clusters").value = state.maxClusters;
  byId("max-snippet").value = state.maxSnippet;
  byId("excluded-domains").value = state.excludedDomains.join("\n");
}

function initEventListeners() {
  byId("settings-toggle").onclick = () => toggleView("settings-view");
  byId("sessions-toggle").onclick = openSessionsView;
  byId("onboarding-continue").onclick = async () => {
    await chrome.storage.sync.set({ onboardingDone: true });
    state.onboardingDone = true;
    showView("settings-view");
  };
  byId("save-settings").onclick = saveSettings;
  byId("cancel-settings").onclick = () => showView("main-view");
  byId("close-sessions").onclick = () => showView("main-view");

  byId("refresh-tabs").onclick = performScan;
  byId("submit-query").onclick = performQuery;
  byId("query-input").addEventListener("keydown", (e) => { if (e.key === "Enter") performQuery(); });
  byId("tab-search").oninput = renderTabs;
  byId("close-irrelevant").onclick = closeIrrelevant;
  byId("clear-relevance").onclick = clearRelevance;

  byId("bulk-close").onclick = () => bulkClose(Array.from(state.selectedTabIds));
  byId("bulk-bookmark").onclick = bulkBookmark;
  byId("bulk-open-window").onclick = bulkOpenInNewWindow;

  byId("save-session").onclick = handleSaveSession;
  byId("export-json").onclick = () => exportSnapshot("json");
  byId("export-md").onclick = () => exportSnapshot("md");

  byId("undo-btn").onclick = restoreLastClosed;

  byId("modal-cancel").onclick = closeModal;
  byId("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
}

function initRuntimeListeners() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "scanProgress") {
      const { done, total } = msg;
      byId("loading-progress").classList.remove("hidden");
      byId("loading-progress-fill").style.width = `${total ? (done / total) * 100 : 0}%`;
      byId("loading-text").innerText = `Scanning tabs… ${done}/${total}`;
    }
  });
}

function byId(id) { return document.getElementById(id); }
function send(action, payload = {}) { return chrome.runtime.sendMessage({ action, ...payload }); }

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  byId(id).classList.remove("hidden");
}

function toggleView(id) {
  byId(id).classList.contains("hidden") ? showView(id) : showView("main-view");
}

async function performScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  updateLoading(true, "Scanning tabs…");

  try {
    const res = await send("scanTabs");
    if (!res?.success) { showNotice(`Scan failed: ${res?.error || "unknown"}`); return; }

    state.tabs = res.result.tabs;
    updateTabCountPill(state.tabs.length);
    hideNotice();

    if (state.tabs.length === 0) {
      state.clusters = []; state.uncategorised = [];
      renderTabs(); return;
    }

    if (state.privacyMode) {
      await runDomainFallbackInline("Privacy mode — grouped by domain.");
    } else if (!state.apiKey) {
      await runDomainFallbackInline("No API key set. Grouped by domain.");
    } else {
      await performClustering();
    }

    await send("persistLastScan", {
      payload: { tabs: state.tabs, clusters: state.clusters, uncategorised: state.uncategorised },
    });
  } catch (err) {
    console.error(err);
    showNotice(`Error: ${err.message}`);
  } finally {
    state.isScanning = false;
    updateLoading(false);
  }
}

async function runDomainFallbackInline(message) {
  const res = await send("clusterTabs", {
    tabs: state.tabs,
    apiKey: "",
    options: { excludedDomains: state.excludedDomains },
  });
  if (res?.success) {
    state.clusters = res.result.clusters || [];
    state.uncategorised = res.result.uncategorised_tab_ids || [];
  } else {
    state.clusters = []; state.uncategorised = state.tabs.map(t => t.id);
  }
  showNotice(message);
  renderTabs();
}

async function performClustering() {
  updateLoading(true, "Clustering with Gemini…");
  const res = await send("clusterTabs", {
    tabs: state.tabs,
    apiKey: state.apiKey,
    options: {
      maxClusters: state.maxClusters,
      maxSnippetLength: state.maxSnippet,
      excludedDomains: state.excludedDomains,
    },
  });

  if (!res?.success) {
    showNotice(`Clustering error: ${res?.error}. Using domain fallback.`);
    await runDomainFallbackInline("Using domain fallback.");
    return;
  }

  state.clusters = res.result.clusters || [];
  state.uncategorised = res.result.uncategorised_tab_ids || [];

  if (res.result.isFallback) {
    const reason = res.result.noticeKey === "NO_SCRIPTABLE"
      ? "No scriptable tabs found — showing domain grouping."
      : `Gemini failed (${res.result.error || "unknown"}). Using domain fallback.`;
    showNotice(reason);
  } else if (res.result.modelUsed && !res.result.modelUsed.includes("flash")) {
    showNotice(`Clustered with ${res.result.modelUsed} (flash unavailable).`);
  } else {
    hideNotice();
  }
  renderTabs();
}

function applyScanResult(payload, { fromCache } = {}) {
  state.tabs = payload.tabs || [];
  state.clusters = payload.clusters || [];
  state.uncategorised = payload.uncategorised || [];
  updateTabCountPill(state.tabs.length);
  renderTabs();
  if (fromCache) showNotice(`Showing cached scan. Click 🔄 to refresh.`);
}

async function performQuery() {
  const focus = byId("query-input").value.trim();
  if (!focus) return;
  if (!state.apiKey) { showNotice("Set a Gemini API key first."); return; }
  if (state.tabs.length === 0) { showNotice("Scan tabs first."); return; }

  updateLoading(true, "Analyzing relevance…");
  try {
    const res = await send("queryRelevance", {
      tabs: state.tabs,
      focus,
      apiKey: state.apiKey,
      options: { maxSnippetLength: state.maxSnippet, excludedDomains: state.excludedDomains },
    });
    if (!res?.success) { showNotice(`Query failed: ${res?.error}`); return; }
    applyRelevance(res.result);
    state.hasRelevance = true;
    byId("relevance-actions").classList.remove("hidden");
    byId("query-summary").innerText = res.result.summary || "";
    byId("query-summary").classList.remove("hidden");
    renderTabs();
  } finally {
    updateLoading(false);
  }
}

function applyRelevance(result) {
  (result.tabs || []).forEach(item => {
    const tab = state.tabs.find(t => String(t.id) === String(item.tab_id));
    if (tab) { tab.relevance = item.relevance; tab.reason = item.reason; }
  });
}

function clearRelevance() {
  state.tabs.forEach(t => { delete t.relevance; delete t.reason; });
  state.hasRelevance = false;
  byId("relevance-actions").classList.add("hidden");
  byId("query-summary").classList.add("hidden");
  renderTabs();
}

async function closeIrrelevant() {
  const victims = state.tabs.filter(t => t.relevance === "low");
  if (victims.length === 0) { showNotice("No tabs rated as low relevance."); return; }
  const confirmed = await confirmModal({
    title: `Close ${victims.length} irrelevant tabs?`,
    body: buildTabList(victims),
  });
  if (!confirmed) return;
  await closeTabsWithUndo(victims);
}

async function goToTab(tabId, windowId) {
  await chrome.windows.update(windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
}

async function closeTab(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;
  await closeTabsWithUndo([tab]);
}

async function closeTabsWithUndo(tabs) {
  state.lastClosedTabs = tabs;
  const ids = tabs.map(t => t.id);
  try {
    await chrome.tabs.remove(ids);
  } catch (e) { console.warn(e); }
  showUndoToast(`${tabs.length} tab${tabs.length > 1 ? "s" : ""} closed.`);
  state.selectedTabIds.clear();
  await performScan();
}

async function bulkClose(ids) {
  if (!ids.length) return;
  const tabs = state.tabs.filter(t => ids.includes(t.id));
  if (tabs.length > 3) {
    const confirmed = await confirmModal({
      title: `Close ${tabs.length} tabs?`,
      body: tabs.length > 10 ? buildTabList(tabs) : `<p>This will close ${tabs.length} tabs.</p>`,
    });
    if (!confirmed) return;
  }
  await closeTabsWithUndo(tabs);
}

async function bulkBookmark() {
  const ids = Array.from(state.selectedTabIds);
  if (!ids.length) return;
  const folderName = prompt("Bookmark folder name:", `Tab Cemetery — ${new Date().toLocaleDateString()}`);
  if (!folderName) return;
  const tabs = state.tabs.filter(t => ids.includes(t.id));
  const res = await send("bookmarkTabs", { tabs, folderName });
  if (res?.success) showNotice(`Bookmarked ${res.result.count} tabs to "${folderName}".`);
  else showNotice(`Bookmark failed: ${res?.error}`);
}

async function bulkOpenInNewWindow() {
  const ids = Array.from(state.selectedTabIds);
  if (!ids.length) return;
  const tabs = state.tabs.filter(t => ids.includes(t.id));
  const win = await chrome.windows.create({ url: tabs[0].url });
  for (let i = 1; i < tabs.length; i++) {
    await chrome.tabs.create({ windowId: win.id, url: tabs[i].url });
  }
  state.selectedTabIds.clear();
  updateSelectionUI();
}

async function restoreLastClosed() {
  if (!state.lastClosedTabs) return;
  for (const tab of state.lastClosedTabs) {
    await chrome.tabs.create({ url: tab.url, pinned: tab.pinned });
  }
  state.lastClosedTabs = null;
  hideUndoToast();
  await performScan();
}

async function handleSaveSession() {
  if (!state.tabs.length) { showNotice("Nothing to save."); return; }
  const name = prompt("Session name:", `Session — ${new Date().toLocaleString()}`);
  if (!name) return;
  const res = await send("saveSession", { name, tabs: state.tabs, clusters: state.clusters });
  if (res?.success) showNotice(`Saved "${name}".`);
}

async function openSessionsView() {
  const res = await send("listSessions");
  const list = byId("sessions-list");
  list.innerHTML = "";
  const sessions = res?.result || [];
  if (!sessions.length) {
    list.innerHTML = `<p class="help">No saved sessions yet.</p>`;
  } else {
    for (const s of sessions) {
      const el = document.createElement("div");
      el.className = "session-card";
      el.innerHTML = `
        <div class="session-head">
          <strong>${escapeHtml(s.name)}</strong>
          <span class="tab-domain">${timeAgo(s.savedAt)} · ${s.tabCount} tab${s.tabCount !== 1 ? "s" : ""}</span>
        </div>
        <div class="row">
          <button class="btn secondary sm session-view">View</button>
          <button class="btn secondary sm session-bookmark">Bookmark all</button>
          <button class="btn danger sm session-delete">Delete</button>
        </div>
        <div class="session-tabs hidden"></div>
      `;
      el.querySelector(".session-view").onclick = () => {
        const box = el.querySelector(".session-tabs");
        box.classList.toggle("hidden");
        if (!box.dataset.rendered) {
          box.innerHTML = s.tabs.map(t => `<a href="${t.url}" target="_blank" rel="noreferrer" class="session-tab">${escapeHtml(t.title || t.url)}</a>`).join("");
          box.dataset.rendered = "1";
        }
      };
      el.querySelector(".session-bookmark").onclick = async () => {
        const r = await send("bookmarkTabs", { tabs: s.tabs, folderName: s.name });
        if (r?.success) showNotice(`Bookmarked ${r.result.count} tabs.`);
      };
      el.querySelector(".session-delete").onclick = async () => {
        const ok = await confirmModal({ title: "Delete session?", body: `<p>"${escapeHtml(s.name)}" will be removed.</p>` });
        if (!ok) return;
        await send("deleteSession", { id: s.id });
        openSessionsView();
      };
      list.appendChild(el);
    }
  }
  showView("sessions-view");
}

async function exportSnapshot(format) {
  if (!state.tabs.length) { showNotice("Nothing to export."); return; }
  const res = await send("exportSnapshot", { tabs: state.tabs, clusters: state.clusters, format });
  if (res?.success) showNotice(`Downloaded ${res.result.filename}.`);
  else showNotice(`Export failed: ${res?.error}`);
}

function renderTabs() {
  const container = byId("tabs-container");
  const query = byId("tab-search").value.toLowerCase();
  container.innerHTML = "";

  const allClusters = [...state.clusters];
  if (state.uncategorised.length > 0) {
    allClusters.push({ id: "uncategorised", label: "Uncategorised", emoji: "📂", tab_ids: state.uncategorised });
  }

  if (allClusters.length === 0 && state.tabs.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No tabs to manage.</p></div>`;
    return;
  }

  for (const cluster of allClusters) {
    const ids = cluster.tab_ids.map(String);
    const clusterTabs = state.tabs.filter(t => ids.includes(String(t.id)));
    const filtered = clusterTabs.filter(t =>
      !query || (t.title || "").toLowerCase().includes(query) || (t.url || "").toLowerCase().includes(query)
    );
    if (filtered.length === 0) continue;

    const collapsed = state.collapsed.has(cluster.id);
    const el = document.createElement("div");
    el.className = "cluster";
    el.innerHTML = `
      <div class="cluster-header">
        <div class="cluster-label">
          <span class="cluster-caret">${collapsed ? "▸" : "▾"}</span>
          <span>${cluster.emoji || "📁"}</span>
          <span class="cluster-title">${escapeHtml(cluster.label || "")}</span>
          <span class="cluster-count">${filtered.length}</span>
        </div>
        <button class="btn secondary sm close-cluster">Close all</button>
      </div>
      <div class="cluster-body ${collapsed ? "hidden" : ""}"></div>
    `;

    const body = el.querySelector(".cluster-body");
    filtered.forEach(tab => body.appendChild(createTabCard(tab)));

    el.querySelector(".cluster-header").onclick = (e) => {
      if (e.target.closest(".close-cluster")) return;
      if (collapsed) state.collapsed.delete(cluster.id);
      else state.collapsed.add(cluster.id);
      renderTabs();
    };

    el.querySelector(".close-cluster").onclick = async (e) => {
      e.stopPropagation();
      await bulkClose(filtered.map(t => t.id));
    };

    container.appendChild(el);
  }
  updateSelectionUI();
}

function createTabCard(tab) {
  const card = document.createElement("div");
  card.className = `tab-card ${tab.relevance ? "relevance-" + tab.relevance : ""} ${tab.pinned ? "pinned" : ""}`;
  const domain = safeDomain(tab.url);
  card.innerHTML = `
    <input type="checkbox" class="tab-select" ${state.selectedTabIds.has(tab.id) ? "checked" : ""}>
    <img class="tab-favicon" src="${tab.favIconUrl || "../icons/icon-16.png"}">
    <div class="tab-info">
      <span class="tab-title" title="${escapeAttr(tab.title)}">${tab.pinned ? "📌 " : ""}${escapeHtml(truncate(tab.title, 60))}</span>
      <span class="tab-domain">${escapeHtml(domain)} · <span class="window-tag">${tab.windowLabel || ""}</span></span>
      ${tab.reason ? `<p class="tab-reason">${escapeHtml(tab.reason)}</p>` : ""}
    </div>
    <div class="tab-actions">
      <span class="action-icon go-to" title="Focus tab">🎯</span>
      <span class="action-icon bookmark-one" title="Bookmark">★</span>
      <span class="action-icon close-one" title="Close tab">✕</span>
    </div>
  `;
  card.querySelector(".tab-favicon").addEventListener("error", (e) => { e.target.src = "../icons/icon-16.png"; });
  card.querySelector(".tab-select").onchange = (e) => {
    if (e.target.checked) state.selectedTabIds.add(tab.id);
    else state.selectedTabIds.delete(tab.id);
    updateSelectionUI();
  };
  card.onclick = (e) => {
    if (e.target.tagName === "INPUT" || e.target.classList.contains("action-icon")) return;
    goToTab(tab.id, tab.windowId);
  };
  card.querySelector(".go-to").onclick = () => goToTab(tab.id, tab.windowId);
  card.querySelector(".close-one").onclick = () => closeTab(tab.id);
  card.querySelector(".bookmark-one").onclick = async () => {
    const res = await send("bookmarkTabs", { tabs: [tab], folderName: "Singles" });
    if (res?.success) showNotice(`Bookmarked "${truncate(tab.title, 40)}".`);
  };
  return card;
}

function updateLoading(show, text = "") {
  const el = byId("loading-state");
  if (show) {
    el.classList.remove("hidden");
    byId("loading-text").innerText = text;
  } else {
    el.classList.add("hidden");
    byId("loading-progress").classList.add("hidden");
    byId("loading-progress-fill").style.width = "0%";
  }
}

function updateSelectionUI() {
  const footer = byId("panel-footer");
  const count = state.selectedTabIds.size;
  if (count > 0) {
    footer.classList.remove("hidden");
    byId("select-count").innerText = `${count} selected`;
  } else {
    footer.classList.add("hidden");
  }
}

function updateTabCountPill(n) {
  const pill = byId("tab-count-pill");
  if (n > 0) { pill.classList.remove("hidden"); pill.innerText = n; }
  else pill.classList.add("hidden");
}

function showNotice(text) {
  const n = byId("notice");
  n.innerText = text;
  n.classList.remove("hidden");
}
function hideNotice() { byId("notice").classList.add("hidden"); }

function showUndoToast(text) {
  byId("undo-text").innerText = text;
  byId("undo-toast").classList.remove("hidden");
  clearTimeout(showUndoToast._t);
  showUndoToast._t = setTimeout(hideUndoToast, 5000);
}
function hideUndoToast() { byId("undo-toast").classList.add("hidden"); }

async function saveSettings() {
  const apiKey = byId("api-key").value.trim();
  const privacyMode = byId("privacy-mode").checked;
  const maxClusters = clamp(Number(byId("max-clusters").value) || 8, 3, 10);
  const maxSnippet = clamp(Number(byId("max-snippet").value) || 500, 100, 1000);
  const excludedDomains = byId("excluded-domains").value.split("\n").map(s => s.trim()).filter(Boolean);

  await chrome.storage.sync.set({ apiKey, privacyMode, maxClusters, maxSnippet, excludedDomains });
  Object.assign(state, { apiKey, privacyMode, maxClusters, maxSnippet, excludedDomains });
  showView("main-view");
  if (!state.tabs.length) performScan();
}

function confirmModal({ title, body }) {
  return new Promise(resolve => {
    byId("modal-title").innerText = title;
    byId("modal-content").innerHTML = body;
    byId("modal").classList.remove("hidden");
    const confirmBtn = byId("modal-confirm");
    const cancel = () => { closeModal(); resolve(false); };
    const confirm = () => { closeModal(); resolve(true); };
    byId("modal-cancel").onclick = cancel;
    confirmBtn.onclick = confirm;
  });
}
function closeModal() { byId("modal").classList.add("hidden"); }

function buildTabList(tabs) {
  const items = tabs.slice(0, 50).map(t => `<li>${escapeHtml(truncate(t.title || t.url, 80))}</li>`).join("");
  const extra = tabs.length > 50 ? `<p class="help">… and ${tabs.length - 50} more</p>` : "";
  return `<ul class="tab-list">${items}</ul>${extra}`;
}

function safeDomain(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url || ""; } }
function truncate(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
