import { execFile } from "node:child_process";

export function createDashboardTelegramClient({ token, transport = "fetch", fetchImpl, execFileImpl } = {}) {
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }
  const request = transport === "curl"
    ? (method, body) => curlRequest({ token, method, body, execFileImpl: execFileImpl || execFile })
    : (transport === "fetch"
      ? (method, body) => fetchRequest({ token, method, body, fetchImpl: fetchImpl === undefined ? globalThis.fetch : fetchImpl })
      : null);
  if (!request) {
    throw new Error(`Unknown Telegram transport: ${transport}`);
  }
  return {
    getUpdates(body) {
      return request("getUpdates", body);
    },
    sendMessage({ chatId, text, replyMarkup }) {
      return request("sendMessage", {
        chat_id: chatId,
        text: String(text || ""),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    },
    answerCallback({ callbackQueryId, text }) {
      return request("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: String(text || ""),
        show_alert: false,
      });
    },
  };
}

async function fetchRequest({ token, method, body, fetchImpl }) {
  if (!fetchImpl) {
    throw new Error("Missing fetch implementation");
  }
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Telegram ${method} request failed`);
  }
  if (!response?.ok) {
    throw new Error(`Telegram ${method} request failed`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Telegram ${method} response failed`);
  }
  if (!payload?.ok) {
    throw new Error(`Telegram ${method} response failed`);
  }
  return payload.result || [];
}

function curlRequest({ token, method, body, execFileImpl }) {
  return new Promise((resolve, reject) => {
    const child = execFileImpl("curl", ["-sS", "--config", "-"], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`Telegram ${method} request failed`));
        return;
      }
      try {
        const payload = JSON.parse(stdout);
        if (!payload?.ok) {
          reject(new Error(`Telegram ${method} response failed`));
          return;
        }
        resolve(payload.result || []);
      } catch {
        reject(new Error(`Telegram ${method} response failed`));
      }
    });
    child.stdin.on("error", () => {});
    try {
      child.stdin.end([
        "request = POST",
        `header = ${curlQuote("content-type: application/json")}`,
        `url = ${curlQuote(`https://api.telegram.org/bot${token}/${method}`)}`,
        `data = ${curlQuote(JSON.stringify(body))}`,
        "",
      ].join("\n"));
    } catch {
      reject(new Error(`Telegram ${method} request failed`));
    }
  });
}

function curlQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
