document.addEventListener("DOMContentLoaded", () => {
  App.initMap();
  App.initStatusPanel();
  App.renderLayerList();

  const form = document.getElementById("search-form");
  const input = document.getElementById("address-input");
  const statusEl = document.getElementById("search-status");
  const button = form.querySelector("button");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    button.disabled = true;
    try {
      await Summary.search(text);
    } catch (err) {
      statusEl.className = "hint error";
      statusEl.textContent = err.message || "Search failed.";
      Utils.logStatus("search", "error", `Address search failed: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  });
});
