document.documentElement.dataset.agentRiver = "web";

const token = document.querySelector('meta[name="csrf-token"]')?.content || "";
const message = document.querySelector(".action-message");
const autoRefreshMs = Number(document.body.dataset.autoRefresh) || 0;
let formDirty = false;

if (autoRefreshMs > 0) {
  document.addEventListener("input", markFormDirty);
  document.addEventListener("change", markFormDirty);
  window.setInterval(() => {
    if (!formDirty && !focusedFormControl() && !document.querySelector(".postal-reader details[open]")) {
      if (document.body.classList?.contains("postal-page")) sessionStorage.setItem("postal-scroll", String(window.scrollY));
      window.location.reload();
    }
  }, autoRefreshMs);
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".action-button");
  if (!button || button.disabled) return;
  const label = button.textContent.trim();
  if (!window.confirm(clientMessage("confirm", { label }))) return;
  button.disabled = true;
  show(clientMessage("running", { label }), false);
  try {
    const response = await fetch(button.dataset.endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: JSON.stringify({ confirm: button.dataset.confirm }),
    });
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(result.message || result.error || `HTTP ${response.status}`);
    show(result.limitation || clientMessage("completed", { label }), false);
    window.setTimeout(() => window.location.reload(), 350);
  } catch (error) {
    button.disabled = false;
    show(error.message || clientMessage("action-failed"), true);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest(".request-form");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const values = formValues(form);
  button.disabled = true;
  show(clientMessage("submitting"), false);
  try {
    const response = await fetch(form.action, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: JSON.stringify(values),
    });
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(result.message || result.error || `HTTP ${response.status}`);
    if (form.dataset.success === "mail") {
      window.location.assign(`/mail/${encodeURIComponent(result.conversationId)}`);
    } else if (form.dataset.success === "session") {
      window.location.assign(`/sessions/${encodeURIComponent(result.sessionId)}`);
    } else if (form.dataset.success === "reload") {
      window.location.reload();
    } else {
      window.location.assign("/inbox");
    }
  } catch (error) {
    button.disabled = false;
    show(error.message || clientMessage("request-failed"), true);
  }
});

function formValues(form) {
  const values = {};
  for (const [key, value] of new FormData(form)) {
    if (Object.hasOwn(values, key)) {
      values[key] = Array.isArray(values[key]) ? [...values[key], value] : [values[key], value];
    } else {
      values[key] = value;
    }
  }
  if (form.action.endsWith("/api/sessions") && !Object.hasOwn(values, "participants")) values.participants = [];
  const group = form.querySelector("[data-group-fields]");
  if (group && !group.disabled) values.targets = [...new FormData(form).getAll("targets")];
  return values;
}

function markFormDirty(event) {
  if (event.target.matches("input, textarea, select") && event.target.closest("form")) formDirty = true;
}

function focusedFormControl() {
  const control = document.activeElement;
  return Boolean(control?.matches("[data-mail-search]") || (control?.matches("input, textarea, select, button") && control.closest("form")));
}

function clientMessage(name, placeholders = {}) {
  const template = document.querySelector(`meta[name="client-i18n-${name}"]`)?.content || "";
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => Object.hasOwn(placeholders, key) ? String(placeholders[key]) : match);
}

function show(text, failed) {
  if (!message) return;
  message.hidden = false;
  message.classList.toggle("failed", failed);
  message.textContent = text;
}

const mailSearch = document.querySelector("[data-mail-search]");
const mailStorage = mailSearch ? window.sessionStorage : null;
let mailFilter = mailStorage?.getItem("postal-filter") || "all";
if (mailSearch) {
  mailSearch.value = mailStorage?.getItem("postal-search") || "";
  window.scrollTo(0, Number(mailStorage?.getItem("postal-scroll")) || 0);
}
function filterMail() {
  const query = (mailSearch?.value || "").toLowerCase();
  mailStorage?.setItem("postal-search", query);
  mailStorage?.setItem("postal-filter", mailFilter);
  for (const button of document.querySelectorAll("[data-mail-filter]")) button.setAttribute("aria-pressed", String(button.dataset.mailFilter === mailFilter));
  for (const row of document.querySelectorAll("[data-mail-status]")) {
    row.hidden = (mailFilter !== "all" && row.dataset.mailStatus !== mailFilter)
      || !row.dataset.mailSearchText.includes(query);
  }
}
mailSearch?.addEventListener("input", filterMail);
document.addEventListener("click", (event) => {
  const filter = event.target.closest("[data-mail-filter]");
  if (!filter) return;
  mailFilter = filter.dataset.mailFilter;
  for (const button of document.querySelectorAll("[data-mail-filter]")) button.setAttribute("aria-pressed", String(button === filter));
  filterMail();
});

if (mailSearch) filterMail();

document.addEventListener("change", (event) => {
  const select = event.target;
  if (!select.matches("[data-mail-mode]")) return;
  const form = select.closest("form");
  const group = select.value === "group";
  const recipients = form.querySelector("[data-group-fields]");
  const single = form.querySelector("[data-single-fields]");
  recipients.hidden = recipients.disabled = !group;
  single.hidden = single.disabled = group;
});
