import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getInboxItem,
  getWebSession,
  listArchiveItems,
  listDispatchItems,
  listInboxItems,
  listWebAgents,
  listWebSessions,
  readWebSafety,
  readWebStatus,
} from "./read-model.js";
import { renderPage } from "./render.js";

const BIND_ADDRESS = "127.0.0.1";
const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function createWebServer({ agentHome } = {}) {
  if (!agentHome) throw new Error("Missing agentHome");
  return http.createServer((request, response) => {
    void handleRequest({ agentHome, request, response });
  });
}

export async function startWebServer({ agentHome, port = 4310 } = {}) {
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new Error("Web port must be an integer between 0 and 65535");
  }
  const server = createWebServer({ agentHome });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, BIND_ADDRESS, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleRequest({ agentHome, request, response }) {
  try {
    if (!isAllowedHost(request.headers.host, request.socket.localPort)) return sendText(response, 421, "Misdirected Request");
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      return sendText(response, 405, "Method Not Allowed");
    }
    let url;
    try {
      url = new URL(request.url || "/", `http://${request.headers.host}`);
      decodeURIComponent(url.pathname);
    } catch {
      return sendText(response, 400, "Bad Request");
    }
    const asset = assetRoute(url.pathname);
    if (asset) return sendAsset(response, asset);
    if (url.pathname.startsWith("/api/")) return sendApi({ agentHome, pathname: url.pathname, response });
    const page = pageData(agentHome, url.pathname);
    if (!page) return sendText(response, 404, "Not Found");
    return send(response, 200, renderPage(page), "text/html; charset=utf-8");
  } catch {
    return sendText(response, 500, "Internal Server Error");
  }
}

function pageData(agentHome, pathname) {
  if (pathname === "/") return { view: "dashboard", title: "Dashboard", data: readWebStatus(agentHome) };
  if (pathname === "/inbox") return { view: "inbox", title: "Inbox", data: listInboxItems(agentHome) };
  if (pathname === "/dispatch") return { view: "dispatch", title: "Dispatch Gate", data: listDispatchItems(agentHome) };
  if (pathname === "/sessions") return { view: "sessions", title: "Sessions", data: listWebSessions(agentHome) };
  if (pathname === "/agents") return { view: "agents", title: "Agents", data: listWebAgents(agentHome) };
  if (pathname === "/safety") return { view: "safety", title: "Safety", data: readWebSafety(agentHome) };
  if (pathname === "/archive") return { view: "archive", title: "Archive", data: listArchiveItems(agentHome) };
  const inboxId = routeId(pathname, "/inbox/");
  if (inboxId !== null) {
    const item = getInboxItem(agentHome, inboxId);
    return item ? { view: "inbox-detail", title: item.title || "Inbox item", data: item } : null;
  }
  const sessionId = routeId(pathname, "/sessions/");
  if (sessionId !== null) {
    const session = getWebSession(agentHome, sessionId);
    return session ? { view: "session-detail", title: session.topic || "Session", data: session } : null;
  }
  return null;
}

function sendApi({ agentHome, pathname, response }) {
  let data;
  if (pathname === "/api/status") data = readWebStatus(agentHome);
  else if (pathname === "/api/inbox") data = listInboxItems(agentHome);
  else if (pathname === "/api/dispatch") data = listDispatchItems(agentHome);
  else if (pathname === "/api/sessions") data = listWebSessions(agentHome);
  else if (pathname === "/api/agents") data = listWebAgents(agentHome);
  else if (pathname === "/api/safety") data = readWebSafety(agentHome);
  else if (pathname === "/api/archive") data = listArchiveItems(agentHome);
  else {
    const inboxId = routeId(pathname, "/api/inbox/");
    const sessionId = routeId(pathname, "/api/sessions/");
    if (inboxId !== null) data = getInboxItem(agentHome, inboxId);
    else if (sessionId !== null) data = getWebSession(agentHome, sessionId);
    else return sendJson(response, 404, { error: "not_found" });
    if (!data) return sendJson(response, 404, { error: "not_found" });
  }
  return sendJson(response, 200, data);
}

function routeId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function assetRoute(pathname) {
  if (pathname === "/assets/styles.css") return { file: "styles.css", type: "text/css; charset=utf-8" };
  if (pathname === "/assets/app.js") return { file: "app.js", type: "text/javascript; charset=utf-8" };
  return null;
}

function sendAsset(response, asset) {
  try {
    return send(response, 200, fs.readFileSync(path.join(ASSET_DIR, asset.file)), asset.type);
  } catch {
    return sendText(response, 404, "Not Found");
  }
}

function isAllowedHost(host, localPort) {
  const value = String(host || "");
  const port = String(localPort || "");
  return Boolean(port) && (value === `127.0.0.1:${port}` || value === `localhost:${port}`);
}

function sendJson(response, status, value) {
  return send(response, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

function sendText(response, status, text) {
  return send(response, status, `${text}\n`, "text/plain; charset=utf-8");
}

function send(response, status, body, contentType) {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType });
  response.end(body);
}
