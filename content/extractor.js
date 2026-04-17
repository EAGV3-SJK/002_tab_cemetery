(() => {
  try {
    const title = document.title || "";
    const h1 = document.querySelector("h1")?.innerText || "";
    const metaDesc = document.querySelector('meta[name="description"]')?.content || "";
    const bodyText = (document.body && document.body.innerText) || "";
    const combined = `${title} | ${h1} | ${metaDesc} | ${bodyText}`;
    const clean = combined.replace(/\s+/g, " ").trim();
    if (clean.length >= 10) return clean.slice(0, 500);
    const fallback = `${document.title || ""} ${document.location.href || ""}`.trim();
    return fallback.slice(0, 500) || "[empty content]";
  } catch (e) {
    return "[extraction failed]";
  }
})();
