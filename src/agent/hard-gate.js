export function isDangerousActionRequest(text) {
  return hasEnglishActionWord(text, ["commit", "push", "deploy", "install", "delete", "rm", "drop", "destroy", "rollback", "rebase", "reset"])
    || /(提交|推送|部署|安裝|刪除|還原|重置|移除套件)/.test(String(text || ""));
}

export function hasEnglishActionWord(text, words) {
  const pattern = words.map(escapeRegex).join("|");
  return new RegExp(`(^|[^A-Za-z0-9_-])(?:${pattern})(?=$|[^A-Za-z0-9_-])`, "i").test(String(text || ""));
}

export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
