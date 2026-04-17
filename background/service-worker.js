import { GeminiClient } from '/lib/gemini.js';

const SCAN_TIMEOUT_PER_TAB_MS = 4000;
const LAST_SCAN_KEY = "lastScan";
const SESSIONS_KEY = "sessions";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error(e));

chrome.runtime.onInstalled.addListener(() => refreshBadge());
chrome.runtime.onStartup.addListener(() => refreshBadge());
chrome.tabs.onCreated.addListener(() => refreshBadge());
chrome.tabs.onRemoved.addListener(() => refreshBadge());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.url) refreshBadge();
});

async function refreshBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.length;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: count > 80 ? "#f85149" : "#58a6ff" });
  } catch (e) { /* ignore */ }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handlers = {
    scanTabs: () => handleScan(sender),
    clusterTabs: () => handleClustering(request.tabs, request.apiKey, request.options),
    queryRelevance: () => handleRelevance(request.tabs, request.focus, request.apiKey, request.options),
    bookmarkTabs: () => bookmarkTabs(request.tabs, request.folderName),
    exportSnapshot: () => exportSnapshot(request.tabs, request.clusters, request.format),
    saveSession: () => saveSession(request.name, request.tabs, request.clusters),
    listSessions: () => listSessions(),
    deleteSession: () => deleteSession(request.id),
    loadLastScan: () => loadLastScan(),
    persistLastScan: () => persistLastScan(request.payload),
  };
  const fn = handlers[request.action];
  if (!fn) return false;
  Promise.resolve(fn())
    .then(result => sendResponse({ success: true, result }))
    .catch(err => sendResponse({ success: false, error: err.message || String(err) }));
  return true;
});

async function handleScan(sender) {
  const tabs = await chrome.tabs.query({});
  const windowIds = [...new Set(tabs.map(t => t.windowId))];
  const windowIndex = Object.fromEntries(windowIds.map((id, i) => [id, i + 1]));
  const total = tabs.length;
  const results = [];

  const scriptable = (url) =>
    typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://")) && !url.endsWith(".pdf");

  let done = 0;
  const sendProgress = () => {
    try {
      chrome.runtime.sendMessage({ action: "scanProgress", done, total }).catch(() => {});
    } catch (_) {}
  };

  for (const tab of tabs) {
    let snippet = "[content unavailable]";
    if (scriptable(tab.url)) {
      try {
        const exec = chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/extractor.js'],
        });
        const timed = new Promise((_, rej) => setTimeout(() => rej(new Error("tab_timeout")), SCAN_TIMEOUT_PER_TAB_MS));
        const [{ result: content }] = await Promise.race([exec, timed]);
        snippet = (content || "[empty content]").slice(0, 500);
      } catch (e) {
        snippet = "[content unavailable]";
      }
    }

    results.push({
      id: tab.id,
      windowId: tab.windowId,
      windowLabel: `W${windowIndex[tab.windowId]}`,
      title: tab.title || "Untitled",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      pinned: !!tab.pinned,
      active: !!tab.active,
      snippet,
    });
    done++;
    sendProgress();
  }

  refreshBadge();
  return { tabs: results, windowCount: windowIds.length };
}

async function handleClustering(tabs, apiKey, options = {}) {
  const filtered = filterExcludedDomains(tabs, options.excludedDomains || []);

  if (!apiKey) {
    return { ...domainBasedFallback(filtered, "no_api_key"), noticeKey: "NO_API_KEY" };
  }

  const scriptable = filtered.filter(t => t.snippet && t.snippet !== "[content unavailable]" && t.snippet !== "[extraction failed]");
  if (scriptable.length === 0) {
    return { ...domainBasedFallback(filtered, "no_scriptable_tabs"), noticeKey: "NO_SCRIPTABLE" };
  }

  const client = new GeminiClient(apiKey);
  try {
    const result = await client.clusterTabs(filtered, options);
    return { ...result, modelUsed: client.lastModelUsed };
  } catch (err) {
    return domainBasedFallback(filtered, err.chain ? err.chain.join(" → ") : err.message);
  }
}

async function handleRelevance(tabs, focus, apiKey, options = {}) {
  if (!apiKey) throw new Error("API_KEY_MISSING");
  const filtered = filterExcludedDomains(tabs, options.excludedDomains || []);
  const client = new GeminiClient(apiKey);
  return client.queryRelevance(filtered, focus, options);
}

function filterExcludedDomains(tabs, excluded) {
  if (!excluded.length) return tabs;
  const set = new Set(excluded.map(d => d.trim().toLowerCase()).filter(Boolean));
  return tabs.filter(t => {
    try {
      const host = new URL(t.url).hostname.toLowerCase();
      for (const d of set) if (host === d || host.endsWith("." + d)) return false;
      return true;
    } catch (_) { return true; }
  });
}

function domainBasedFallback(tabs, errorMsg = "") {
  const byDomain = new Map();
  const uncategorised = [];
  for (const tab of tabs) {
    try {
      const host = new URL(tab.url).hostname.replace(/^www\./, "");
      if (!byDomain.has(host)) byDomain.set(host, []);
      byDomain.get(host).push(tab.id);
    } catch (_) {
      uncategorised.push(tab.id);
    }
  }
  const clusters = [];
  let i = 1;
  for (const [domain, ids] of byDomain.entries()) {
    if (ids.length > 1) clusters.push({ id: `fallback_${i++}`, label: domain, emoji: "🌐", tab_ids: ids });
    else uncategorised.push(ids[0]);
  }
  return { clusters, uncategorised_tab_ids: uncategorised, isFallback: true, error: errorMsg };
}

async function bookmarkTabs(tabs, folderName) {
  const parent = await ensureTabCemeteryFolder();
  const folder = await chrome.bookmarks.create({ parentId: parent.id, title: folderName });
  for (const t of tabs) {
    await chrome.bookmarks.create({ parentId: folder.id, title: t.title, url: t.url });
  }
  return { folderId: folder.id, count: tabs.length };
}

async function ensureTabCemeteryFolder() {
  const TAB_CEMETERY = "Tab Cemetery";
  const existing = await chrome.bookmarks.search({ title: TAB_CEMETERY });
  const match = existing.find(n => !n.url);
  if (match) return match;
  try {
    return await chrome.bookmarks.create({ parentId: "2", title: TAB_CEMETERY });
  } catch (_) {
    return chrome.bookmarks.create({ title: TAB_CEMETERY });
  }
}

async function exportSnapshot(tabs, clusters, format) {
  const filename = `tab-cemetery-${new Date().toISOString().replace(/[:.]/g, "-")}.${format === "md" ? "md" : "json"}`;
  let content, mime;
  if (format === "md") {
    const lines = [`# Tab Cemetery Snapshot — ${new Date().toLocaleString()}`, "", `**${tabs.length} tabs**`, ""];
    const grouped = groupByCluster(tabs, clusters);
    for (const g of grouped) {
      lines.push(`## ${g.emoji || "📂"} ${g.label} (${g.tabs.length})`);
      for (const t of g.tabs) lines.push(`- [${escapeMd(t.title)}](${t.url})`);
      lines.push("");
    }
    content = lines.join("\n");
    mime = "text/markdown";
  } else {
    content = JSON.stringify({ exportedAt: new Date().toISOString(), tabs, clusters }, null, 2);
    mime = "application/json";
  }
  const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
  return { filename };
}

function groupByCluster(tabs, clusters) {
  const tabMap = new Map(tabs.map(t => [String(t.id), t]));
  const used = new Set();
  const out = [];
  for (const c of clusters || []) {
    const ts = (c.tab_ids || []).map(id => tabMap.get(String(id))).filter(Boolean);
    ts.forEach(t => used.add(String(t.id)));
    out.push({ label: c.label, emoji: c.emoji, tabs: ts });
  }
  const leftovers = tabs.filter(t => !used.has(String(t.id)));
  if (leftovers.length) out.push({ label: "Uncategorised", emoji: "📂", tabs: leftovers });
  return out;
}

function escapeMd(s) { return String(s).replace(/([\[\]])/g, "\\$1"); }

async function saveSession(name, tabs, clusters) {
  const { [SESSIONS_KEY]: sessions = [] } = await chrome.storage.local.get(SESSIONS_KEY);
  const entry = {
    id: `s_${Date.now()}`,
    name,
    savedAt: Date.now(),
    tabCount: tabs.length,
    tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
    clusters,
  };
  sessions.unshift(entry);
  await chrome.storage.local.set({ [SESSIONS_KEY]: sessions.slice(0, 50) });
  return entry;
}

async function listSessions() {
  const { [SESSIONS_KEY]: sessions = [] } = await chrome.storage.local.get(SESSIONS_KEY);
  return sessions.map(s => ({ id: s.id, name: s.name, savedAt: s.savedAt, tabCount: s.tabCount, tabs: s.tabs, clusters: s.clusters }));
}

async function deleteSession(id) {
  const { [SESSIONS_KEY]: sessions = [] } = await chrome.storage.local.get(SESSIONS_KEY);
  await chrome.storage.local.set({ [SESSIONS_KEY]: sessions.filter(s => s.id !== id) });
  return { id };
}

async function loadLastScan() {
  const { [LAST_SCAN_KEY]: last } = await chrome.storage.local.get(LAST_SCAN_KEY);
  return last || null;
}

async function persistLastScan(payload) {
  await chrome.storage.local.set({ [LAST_SCAN_KEY]: { ...payload, savedAt: Date.now() } });
  return true;
}
