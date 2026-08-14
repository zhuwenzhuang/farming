const statusLine = document.getElementById("status");
const retryButton = document.getElementById("retry");
const fallback = document.getElementById("fallback");
const farming = document.getElementById("farming");

function validFarmingUrl(raw) {
  try {
    const url = new URL(raw);
    return /^https?:$/u.test(url.protocol) && url.pathname.includes("/farming")
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function showFarming(raw) {
  const target = validFarmingUrl(raw);
  if (!target) return false;
  if (!farming.hidden && farming.src === target) return true;
  farming.src = target;
  farming.hidden = false;
  fallback.hidden = true;
  return true;
}

async function openFarming() {
  retryButton.hidden = true;
  statusLine.textContent = "Connecting to local Farming…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "openFarmingSidePanel" });
    if (!response?.ok) throw new Error("Local Farming is not open.");
    const remembered = await chrome.storage.session.get("farmingSidePanelUrl");
    if (showFarming(remembered.farmingSidePanelUrl)) return;
    statusLine.textContent = "Open Farming, then click this icon again.";
    retryButton.hidden = false;
  } catch {
    statusLine.textContent = "Open Farming, then click this icon again.";
    retryButton.hidden = false;
  }
}

retryButton.addEventListener("click", () => void openFarming());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.farmingSidePanelUrl?.newValue) {
    void showFarming(changes.farmingSidePanelUrl.newValue);
  }
});
void openFarming();
