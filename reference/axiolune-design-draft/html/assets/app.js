(function () {
  "use strict";

  const root = document.documentElement;
  const stored = localStorage.getItem("finance-design-theme");
  const systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = stored || (systemDark ? "dark" : "light");
  root.dataset.theme = theme;

  const themeButton = document.querySelector("[data-theme-toggle]");
  if (themeButton) {
    themeButton.setAttribute("aria-label", theme === "dark" ? "切换到亮色" : "切换到暗色");
    themeButton.textContent = theme === "dark" ? "☀" : "☾";
    themeButton.addEventListener("click", function () {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("finance-design-theme", next);
      window.location.reload();
    });
  }

  const menuButton = document.querySelector("[data-menu-toggle]");
  const overlay = document.querySelector(".overlay");
  function closeNavigation() {
    document.body.classList.remove("nav-open");
    if (menuButton) menuButton.setAttribute("aria-expanded", "false");
  }
  if (menuButton) {
    menuButton.addEventListener("click", function () {
      const open = document.body.classList.toggle("nav-open");
      menuButton.setAttribute("aria-expanded", String(open));
    });
  }
  if (overlay) overlay.addEventListener("click", closeNavigation);
  document.querySelectorAll(".nav-link").forEach(function (link) {
    link.addEventListener("click", closeNavigation);
  });

  const progress = document.querySelector(".reading-progress");
  function updateProgress() {
    if (!progress) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = (max > 0 ? Math.min(100, window.scrollY / max * 100) : 0) + "%";
  }
  document.addEventListener("scroll", updateProgress, {passive: true});
  updateProgress();

  const input = document.querySelector("[data-search]");
  const results = document.querySelector("[data-search-results]");
  const index = window.SEARCH_INDEX || [];
  const siteRoot = window.SITE_ROOT || "";

  function normalized(value) {
    return String(value || "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[character];
    });
  }

  function runSearch() {
    if (!input || !results) return;
    const query = normalized(input.value);
    if (query.length < 2) {
      results.innerHTML = "";
      results.classList.remove("is-visible");
      return;
    }
    const terms = query.split(" ").filter(Boolean);
    const matches = index
      .map(function (item) {
        const haystack = normalized(item.title + " " + item.section + " " + item.text);
        let score = 0;
        terms.forEach(function (term) {
          if (normalized(item.title).includes(term)) score += 8;
          if (normalized(item.section).includes(term)) score += 3;
          if (haystack.includes(term)) score += 1;
        });
        return {item: item, score: score};
      })
      .filter(function (entry) { return entry.score >= terms.length; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 12);

    if (!matches.length) {
      results.innerHTML = '<span class="search-result"><span class="search-result-title">未找到匹配文档</span></span>';
    } else {
      results.innerHTML = matches.map(function (entry) {
        return '<a class="search-result" href="' + siteRoot + escapeHtml(entry.item.path) + '">' +
          '<span class="search-result-title">' + escapeHtml(entry.item.title) + '</span>' +
          '<span class="search-result-path">' + escapeHtml(entry.item.section) + '</span></a>';
      }).join("");
    }
    results.classList.add("is-visible");
  }

  if (input) {
    input.addEventListener("input", runSearch);
    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        input.focus();
        if (window.innerWidth <= 900) {
          document.body.classList.add("nav-open");
          if (menuButton) menuButton.setAttribute("aria-expanded", "true");
        }
      }
      if (event.key === "Escape") {
        input.value = "";
        runSearch();
        closeNavigation();
      }
    });
  }

  document.querySelectorAll('a[href^="http"]').forEach(function (link) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });

  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: true,
      securityLevel: "strict",
      theme: root.dataset.theme === "dark" ? "dark" : "neutral",
      flowchart: {htmlLabels: false, curve: "basis"},
      fontFamily: getComputedStyle(root).getPropertyValue("--sans")
    });
  }
}());

