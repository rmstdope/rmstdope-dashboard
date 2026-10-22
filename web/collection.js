export function title(name) {
  return name === "atlantis-hud" ? "Atlantis HUD" :
    name === "retroquest" ? "RetroQuest" :
    name === "dashboard" ? "Dashboard" :
    name.split("-").filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
}

export function collection(onChange, category) {
  let filter = "all";
  const search = document.querySelector("#search");
  document.querySelectorAll("[data-filter]").forEach(button => {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach(item =>
        item.setAttribute("aria-pressed", String(item === button)));
      onChange();
    });
  });
  search.addEventListener("input", onChange);
  return apps => apps.filter(app =>
    (filter === "all" || category(app) === filter) &&
    `${title(app.name)} ${app.name} ${app.url}`.toLowerCase().includes(search.value.trim().toLowerCase()));
}
