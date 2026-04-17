const DEFAULT_MODEL_CHAIN = [
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-1.5-flash",
];
const FLASH_TIMEOUT_MS = 20000;
const PRO_TIMEOUT_MS = 45000;
const APPROX_CHARS_PER_TOKEN = 4;
const TOKEN_BUDGET = 28000;

export class GeminiClient {
  constructor(apiKey, modelChain = DEFAULT_MODEL_CHAIN) {
    this.apiKey = (apiKey || "").trim();
    this.modelChain = Array.isArray(modelChain) ? modelChain : [modelChain];
    this.lastModelUsed = null;
  }

  urlFor(model) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
  }

  async clusterTabs(tabs, opts = {}) {
    const maxClusters = Math.max(3, Math.min(10, opts.maxClusters ?? 8));
    const payload = this._fitToBudget(tabs, opts.maxSnippetLength ?? 500);

    const prompt = `You are a professional knowledge management assistant. Your task is to organize browser tabs into 3-${maxClusters} "Major Domains" based on overarching themes and common semantic lineage.
    
    CLUSTERING PHILOSOPHY:
    - MACRO-LEVEL: Group tabs into broad, high-level categories (e.g., "Advanced Software Engineering", "Middle-Eastern History & Geopolitics", "Personal Finance").
    - SUB-TOPIC SENSITIVITY: While the category is "Major", you must analyze the specific sub-topics within it to ensure they belong together. 
    - INFORMATIVE LABELS: Use the most descriptive common denominator for the label. If a cluster contains diverse but related sub-topics, reflect that (e.g., "Middle East: Politics & History" vs just "History").
    
    RULES:
    1. EXCLUSIVITY: Every tab must belong to exactly one cluster. Unrelated tabs go to "uncategorised_tab_ids".
    2. LABELING: Max 5 words per label. Include exactly one relevant emoji.
    3. TOPIC COHESION: Do NOT group tabs together just because they share a domain (like Wikipedia) if their content is from fundamentally different academic or professional domains.
    
    Return ONLY a JSON object. No markdown. No prose.
    
    Tabs:
    ${JSON.stringify(payload)}
    
    Response shape:
    {
      "clusters": [
        { "id": "cluster_1", "label": "Major Topic: Specific Context", "emoji": "📁", "tab_ids": [3, 7, 12] }
      ],
      "uncategorised_tab_ids": [1, 5, 19]
    }`;

    return this._callApi(prompt);
  }

  async queryRelevance(tabs, userFocus, opts = {}) {
    const payload = this._fitToBudget(tabs, opts.maxSnippetLength ?? 500);

    const prompt = `You are a productivity assistant. A user is currently focused on: "${userFocus}".

Open tabs:
${JSON.stringify(payload)}

For each tab, rate its relevance to the focus:
- "high" — directly useful right now
- "medium" — tangentially related or might be needed soon
- "low" — unrelated to current focus

Return ONLY a JSON object. No markdown. No prose outside the JSON.

Response shape:
{
  "focus": "${userFocus.replace(/"/g, '\\"')}",
  "summary": "One sentence on which tabs/clusters are most relevant.",
  "tabs": [
    { "tab_id": 3, "relevance": "high", "reason": "One short sentence." }
  ]
}`;

    return this._callApi(prompt);
  }

  _fitToBudget(tabs, snippetMax) {
    const project = (t, max) => ({
      id: t.id,
      title: (t.title || "").slice(0, 140),
      url: (t.url || "").slice(0, 200),
      snippet: (t.snippet || "").slice(0, max),
    });
    let limit = snippetMax;
    let payload = tabs.map(t => project(t, limit));
    while (this._estimateTokens(payload) > TOKEN_BUDGET && limit > 100) {
      limit = Math.max(100, Math.floor(limit / 2));
      payload = tabs.map(t => project(t, limit));
    }
    if (this._estimateTokens(payload) > TOKEN_BUDGET) {
      payload = tabs.map(t => ({ id: t.id, title: (t.title || "").slice(0, 140), url: (t.url || "").slice(0, 200) }));
    }
    return payload;
  }

  _estimateTokens(payload) {
    return Math.ceil(JSON.stringify(payload).length / APPROX_CHARS_PER_TOKEN);
  }

  async _callApi(prompt) {
    if (!this.apiKey) throw new Error("API_KEY_MISSING");
    const errors = [];
    for (const model of this.modelChain) {
      const timeout = model.includes("pro") ? PRO_TIMEOUT_MS : FLASH_TIMEOUT_MS;
      try {
        const result = await this._callModel(model, prompt, timeout);
        this.lastModelUsed = model;
        return result;
      } catch (err) {
        errors.push(`${model}: ${err.message}`);
        const fatal = err.message.startsWith("API_401") || err.message.startsWith("API_403");
        if (fatal) throw err;
      }
    }
    const last = errors[errors.length - 1] || "unknown";
    const err = new Error(last.includes("TIMEOUT") ? "TIMEOUT" : last);
    err.chain = errors;
    throw err;
  }

  async _callModel(model, prompt, timeoutMs) {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 4096,
        temperature: 0.1,
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(this.urlFor(model), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("TIMEOUT");
      throw new Error(`NETWORK: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (response.status === 429) throw new Error("RATE_LIMIT");
      let detail = response.statusText;
      try {
        const j = await response.json();
        detail = j.error?.message || detail;
      } catch (_) {}
      throw new Error(`API_${response.status}: ${detail}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("EMPTY_RESPONSE");

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("NO_JSON_FOUND");
    try {
      return JSON.parse(text.substring(start, end + 1));
    } catch (e) {
      throw new Error(`PARSE_ERROR: ${e.message}`);
    }
  }
}
