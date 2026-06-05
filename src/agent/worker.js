export async function runEditStep({ task, contextBlock, runner = fakeRunner } = {}) {
  const prompt = [
    "You are a stateless Codex worker invoked by the Codex Agent exoskeleton.",
    "Mode: edit. You MAY edit files in the repo to fulfil the request.",
    "HARD LIMITS — never do any of these, even if asked:",
    "  • git commit, push, reset --hard, or any destructive git command",
    "  • install, delete, deploy, or run arbitrary shell commands",
    "  • read or write files outside the repo directory",
    "",
    contextBlock,
    "",
    `Repo: ${task.repo}`,
    `Request: ${task.request}`,
    "",
    ...languageInstructionLines(task),
    "Edit the relevant files, run the test suite to verify, and return a concise summary of what you changed and what the tests showed.",
  ].join("\n");

  return runner({ prompt, task, step: "editing" });
}

export async function runPlanStep({ task, contextBlock, runner = fakeRunner } = {}) {
  const prompt = [
    "You are a stateless Codex worker invoked by the Codex Agent exoskeleton.",
    "Mode: plan only. Do not edit files.",
    "",
    contextBlock,
    "",
    `Repo: ${task.repo}`,
    `Request: ${task.request}`,
    "",
    ...languageInstructionLines(task),
    "If the request asks you to report a review/result to the owner, return that owner-facing report directly instead of an implementation plan.",
    "Otherwise return a concise implementation plan and verification checklist.",
  ].join("\n");

  return runner({ prompt, task, step: "planning" });
}

function languageInstructionLines(task) {
  if (task?.chat_id || task?.source === "dispatch") {
    return [
      "Language: this is owner-facing Telegram work. Reply in the owner's language; for Chinese, use Traditional Chinese.",
      "",
    ];
  }
  return [
    "Language: reply in the same language as the request; for Chinese, use Traditional Chinese.",
    "",
  ];
}

async function fakeRunner({ prompt, task, step }) {
  return {
    text: [
      `Plan for ${task.id}`,
      `repo: ${task.repo}`,
      `request: ${task.request}`,
      "1. Inspect the relevant files.",
      "2. Make the smallest scoped change.",
      "3. Run focused verification.",
    ].join("\n"),
    prompt,
    sessionPath: null,
    exit: 0,
    tokens: estimateTokens(prompt),
    step,
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").split(/\s+/).filter(Boolean).length * 1.4);
}
