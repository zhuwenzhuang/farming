import { pairCurrentFarmingPage } from "./modules/farming-page-pairing.js";

const indicator = document.getElementById("indicator");
const statusLine = document.getElementById("status");
const detailLine = document.getElementById("detail");
const errorLine = document.getElementById("error");
const connect = document.getElementById("connect");
const disconnect = document.getElementById("disconnect");
let automaticPairingStarted = false;

function showState({ status, detail, state = "", canConnect = false, canDisconnect = false }) {
  statusLine.textContent = status;
  detailLine.textContent = detail;
  indicator.className = `dot${state ? ` ${state}` : ""}`;
  connect.classList.toggle("hidden", !canConnect);
  disconnect.classList.toggle("hidden", !canDisconnect);
}

function showError(error) {
  errorLine.textContent = error instanceof Error ? error.message : String(error);
  errorLine.classList.remove("hidden");
}

async function pairFromCurrentPage() {
  automaticPairingStarted = true;
  errorLine.classList.add("hidden");
  showState({ status: "Connecting…", detail: "Keep this Farming page open." });
  try {
    await pairCurrentFarmingPage();
    await refresh();
  } catch (error) {
    showState({
      status: "Not connected",
      detail: "Open Farming in this tab, then try again.",
      state: "error",
      canConnect: true,
    });
    showError(error);
  }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "getStatus" });
  if (status?.ok === false) {
    showState({ status: "Connection unavailable", detail: "Try again.", state: "error" });
    showError(status.error ?? "Could not read browser status.");
    return;
  }
  if (status.retiredCopilotCustodyBlocked === true) {
    showState({
      status: "Connection paused",
      detail: "Disconnect, then connect again.",
      state: "error",
      canDisconnect: true,
    });
    return;
  }
  if (!status.paired) {
    if (!automaticPairingStarted) {
      void pairFromCurrentPage();
      return;
    }
    showState({
      status: "Not connected",
      detail: "Open Farming in this tab, then connect.",
      canConnect: true,
    });
    return;
  }
  if (status.state === "on") {
    showState({
      status: "Connected",
      detail: "Farming can use this Chrome.",
      state: "connected",
      canDisconnect: true,
    });
    return;
  }
  showState({
    status: status.state === "connecting" ? "Connecting…" : "Connection unavailable",
    detail: "Farming will reconnect automatically.",
    state: status.state === "connecting" ? "" : "error",
    canDisconnect: true,
  });
}

connect.addEventListener("click", () => {
  void pairFromCurrentPage();
});

disconnect.addEventListener("click", () => {
  void (async () => {
    const result = await chrome.runtime.sendMessage({ type: "unpair" });
    if (result?.ok === false) {
      showError(result.error ?? "Could not disconnect.");
      return;
    }
    automaticPairingStarted = true;
    errorLine.classList.add("hidden");
    showState({
      status: "Not connected",
      detail: "Open Farming in this tab when you want to reconnect.",
      canConnect: true,
    });
  })();
});

void refresh();
