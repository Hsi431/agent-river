import { getMailConversation, reassignMail, stopMail, submitMail } from "../agent/mail.js";
import { getTelegramCodexPolicy } from "../agent/safety.js";
import { resolveRepo } from "../agent/v2/repo-resolver.js";

export function isMailAction(pathname) {
  return pathname === "/api/mail" || /^\/api\/mail\/[A-Za-z0-9_-]+\/(messages|stop)$/.test(pathname)
    || /^\/api\/mail\/letters\/[A-Za-z0-9_-]+\/reassign$/.test(pathname);
}

export async function handleMailAction({ agentHome, pathname, body }) {
  try {
    if (pathname.endsWith("/stop")) {
      if (body.confirm !== "stop") throw new Error("Confirmation required");
      return { status: 200, value: { ok: true, ...stopMail(agentHome, pathname.split("/")[3]) } };
    }
    if (pathname.endsWith("/reassign")) {
      if (Object.keys(body).some((key) => key !== "target")) throw new Error("Unknown field");
      const message = reassignMail({ agentHome, id: pathname.split("/")[4], to: body.target });
      return { status: 200, value: { ok: true, conversationId: message.thread_id } };
    }
    if (Object.keys(body).some((key) => !["target", "request", "subject", "repo", "capability", "model", "effort"].includes(key))) throw new Error("Unknown field");
    for (const [key, value] of Object.entries(body)) if (typeof value !== "string") throw new Error(`Invalid ${key}`);
    if ((body.subject || "").length > 120) throw new Error("Subject too long");
    const conversationId = pathname === "/api/mail" ? null : pathname.split("/")[3];
    const previous = conversationId ? getMailConversation(agentHome, conversationId) : null;
    let repo = previous?.repo || null;
    if (body.repo?.trim()) {
      const policy = getTelegramCodexPolicy(agentHome);
      const resolved = await resolveRepo({ workspaceRoot: policy.workspace_root, defaultRepo: policy.default_repo, input: `repo=${body.repo.trim()}` });
      if (!resolved.ok) throw new Error(`Invalid repository: ${resolved.reason}`);
      repo = resolved.toplevel;
    }
    const message = submitMail({ agentHome, from: "owner", to: body.target || "any", text: body.request,
      subject: body.subject, repo, model: body.model?.trim() || null, effort: body.effort?.trim() || null, capability: body.capability || "auto", conversationId });
    return { status: 201, value: { ok: true, conversationId: message.thread_id, messageId: message.id, target: message.to } };
  } catch (error) {
    return { status: 409, value: { error: "mail_failed", message: String(error.message) } };
  }
}
