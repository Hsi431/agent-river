document.documentElement.dataset.agentRiver = "web";

const token = document.querySelector('meta[name="csrf-token"]')?.content || "";
const message = document.querySelector(".action-message");

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".action-button");
  if (!button || button.disabled) return;
  const label = button.textContent.trim();
  if (!window.confirm(`Confirm ${label}?`)) return;
  button.disabled = true;
  show(`Running ${label}…`, false);
  try {
    const response = await fetch(button.dataset.endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: JSON.stringify({ confirm: button.dataset.confirm }),
    });
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(result.message || result.error || `HTTP ${response.status}`);
    show(result.limitation || `${label} completed.`, false);
    window.setTimeout(() => window.location.reload(), 350);
  } catch (error) {
    button.disabled = false;
    show(error.message || "Action failed.", true);
  }
});

function show(text, failed) {
  if (!message) return;
  message.hidden = false;
  message.classList.toggle("failed", failed);
  message.textContent = text;
}
