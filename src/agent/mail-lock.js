import fs from "node:fs";
import path from "node:path";

const held = new Set();

// Short synchronous ledger operations only; never hold across a provider turn.
export function withMailLock(agentHome, operation) {
  const file = path.join(agentHome, "mail.lock");
  if (held.has(file)) return operation();
  fs.mkdirSync(agentHome, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (probe) { stale = probe.code === "ESRCH"; }
      } else stale = Date.now() - fs.statSync(file).mtimeMs > 5000;
    } catch (probe) { if (probe.code === "ENOENT") return withMailLock(agentHome, operation); }
    if (!stale) throw new Error("Post office busy; retry shortly");
    // Recheck ownership before recovering an abandoned lock.
    const stat = fs.statSync(file);
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (pid > 0) {
      try { process.kill(pid, 0); throw new Error("Post office busy; retry shortly"); }
      catch (probe) { if (probe.code !== "ESRCH") throw probe; }
    }
    if (fs.statSync(file).ino !== stat.ino) throw new Error("Post office busy; retry shortly");
    fs.unlinkSync(file);
    fd = fs.openSync(file, "wx", 0o600);
  }
  fs.writeFileSync(fd, String(process.pid));
  held.add(file);
  try { return operation(); }
  finally { held.delete(file); fs.closeSync(fd); fs.unlinkSync(file); }
}
