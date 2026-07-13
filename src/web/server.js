import fs from "node:fs";
import crypto from "node:crypto";
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
  listWebRequestTargets,
  listWebSessions,
  readWebSafety,
  readWebStatus,
} from "./read-model.js";
import { renderPage } from "./render.js";
import { handleWebAction, isWebActionPath } from "./actions.js";

const BIND_ADDRESS = "127.0.0.1";
const COOKIE_NAME = "agent_river_web";
const BODY_LIMIT = 16 * 1024;
const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function createWebServer({ agentHome, repoDir = process.cwd(), port = 4310 } = {}) {
  if (!agentHome) throw new Error("Missing agentHome");
  const actionSecurity = createWebActionSecurity();
  const readOptions = { repoDir, webPort: Number(port) > 0 ? Number(port) : 4310 };
  return http.createServer((request, response) => {
    void handleRequest({ agentHome, actionSecurity, readOptions, request, response });
  });
}

export async function startWebServer({ agentHome, repoDir = process.cwd(), port = 4310 } = {}) {
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new Error("Web port must be an integer between 0 and 65535");
  }
  const server = createWebServer({ agentHome, repoDir, port: listenPort });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, BIND_ADDRESS, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleRequest({ agentHome, actionSecurity, readOptions, request, response }) {
  try {
    if (!isAllowedHost(request.headers.host, request.socket.localPort)) return sendText(response, 421, "Misdirected Request");
    let url;
    try {
      url = new URL(request.url || "/", `http://${request.headers.host}`);
      decodeURIComponent(url.pathname);
    } catch {
      return sendText(response, 400, "Bad Request");
    }
    if (request.method === "POST") {
      if (!isWebActionPath(url.pathname)) {
        response.setHeader("allow", "GET");
        return sendText(response, 405, "Method Not Allowed");
      }
      const expectedOrigin = `http://${request.headers.host}`;
      const authorized = actionSecurity.authorize(request, expectedOrigin);
      if (!authorized.ok) return sendJson(response, 403, { error: authorized.error });
      let body;
      try {
        body = await readJsonActionBody(request);
      } catch (error) {
        return sendJson(response, error.status || 400, { error: error.code || "invalid_request" });
      }
      const result = await handleWebAction({ agentHome, pathname: url.pathname, body, repoDir: readOptions.repoDir });
      return sendJson(response, result.status, result.value);
    }
    if (request.method !== "GET") {
      response.setHeader("allow", "GET, POST");
      return sendText(response, 405, "Method Not Allowed");
    }
    const asset = assetRoute(url.pathname);
    if (asset) return sendAsset(response, asset);
    if (url.pathname.startsWith("/api/")) return sendApi({ agentHome, readOptions, pathname: url.pathname, response });
    const page = pageData(agentHome, readOptions, url.pathname);
    if (!page) return sendText(response, 404, "Not Found");
    response.setHeader("set-cookie", actionSecurity.cookie);
    return send(response, 200, renderPage({ ...page, csrfToken: actionSecurity.csrfToken }), "text/html; charset=utf-8");
  } catch {
    return sendText(response, 500, "Internal Server Error");
  }
}

function pageData(agentHome, readOptions, pathname) {
  if (pathname === "/") return { view: "dashboard", title: "Dashboard", data: readWebStatus(agentHome, readOptions) };
  if (pathname === "/compose") return { view: "compose", title: "New request", data: { targets: listWebRequestTargets(agentHome) } };
  if (pathname === "/inbox") return { view: "inbox", title: "Inbox", data: listInboxItems(agentHome) };
  if (pathname === "/dispatch") return { view: "dispatch", title: "Dispatch Gate", data: listDispatchItems(agentHome) };
  if (pathname === "/sessions") return { view: "sessions", title: "Sessions", data: listWebSessions(agentHome) };
  if (pathname === "/agents") return { view: "agents", title: "Agents", data: listWebAgents(agentHome) };
  if (pathname === "/safety") return { view: "safety", title: "Safety", data: readWebSafety(agentHome, readOptions) };
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

function sendApi({ agentHome, readOptions, pathname, response }) {
  let data;
  if (pathname === "/api/status") data = readWebStatus(agentHome, readOptions);
  else if (pathname === "/api/inbox") data = listInboxItems(agentHome);
  else if (pathname === "/api/dispatch") data = listDispatchItems(agentHome);
  else if (pathname === "/api/sessions") data = listWebSessions(agentHome);
  else if (pathname === "/api/agents") data = listWebAgents(agentHome);
  else if (pathname === "/api/safety") data = readWebSafety(agentHome, readOptions);
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

function createWebActionSecurity() {
  const secret = crypto.randomBytes(32);
  const session = crypto.randomBytes(24).toString("base64url");
  const signature = sign(secret, `cookie:${session}`);
  return {
    csrfToken: sign(secret, `csrf:${session}`),
    cookie: `${COOKIE_NAME}=${session}.${signature}; HttpOnly; SameSite=Strict; Path=/`,
    authorize(request, expectedOrigin) {
      if (request.headers.origin !== expectedOrigin) return { ok: false, error: "invalid_origin" };
      const value = readCookie(request.headers.cookie, COOKIE_NAME);
      const separator = value.lastIndexOf(".");
      if (separator < 1) return { ok: false, error: "invalid_session" };
      const candidateSession = value.slice(0, separator);
      if (!safeEqual(value.slice(separator + 1), sign(secret, `cookie:${candidateSession}`))) return { ok: false, error: "invalid_session" };
      if (!safeEqual(request.headers["x-csrf-token"], sign(secret, `csrf:${candidateSession}`))) return { ok: false, error: "invalid_csrf" };
      return { ok: true };
    },
  };
}

async function readJsonActionBody(request) {
  if (String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw httpError(415, "json_content_type_required");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw httpError(413, "body_too_large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw httpError(400, "invalid_json");
  }
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function sign(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function httpError(status, code) {
  return Object.assign(new Error(code), { status, code });
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
