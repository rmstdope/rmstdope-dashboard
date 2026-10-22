(() => {
  const key = "rmstdope-theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = null;
  try {
    const stored = localStorage.getItem(key);
    if (["light", "dark"].includes(stored)) preference = stored;
  } catch (error) {
    console.warn("Theme preference storage is unavailable.", error);
  }
  function apply() {
    const theme = preference || (system.matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    const button = document.querySelector("#theme-toggle");
    if (button) {
      button.textContent = theme === "dark" ? "Light theme" : "Dark theme";
      button.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
    }
  }
  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", event => {
    if (event.key !== key && event.key !== null) return;
    preference = ["light", "dark"].includes(event.newValue) ? event.newValue : null;
    apply();
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.querySelector("#theme-toggle").addEventListener("click", () => {
      preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(key, preference); }
      catch (error) { console.warn("Theme preference could not be saved.", error); }
      apply();
    });
  });
})();
