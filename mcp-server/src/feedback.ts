// Open a feedback issue. Prefers the user's local `gh` CLI so the issue is
// authored under their account (issue #12); falls back to the shared-token
// endpoint when `gh` isn't installed/authenticated.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const REPO = process.env.CHROME_MCP_FEEDBACK_REPO || "actuallyroy/chrome-mcp";

type Severity = "bug" | "missing" | "idea" | "praise";

export type FileFeedbackInput = {
  message: string;
  severity: Severity;
  product: "chrome" | "android";
  version: string;
  context: Record<string, unknown>;
  endpoint: string; // fallback HTTP endpoint
};

export type FileFeedbackResult = {
  url: string;
  issue_number: number;
  authored_by: "user" | "shared-bot";
};

async function ghAuthenticated(): Promise<string | null> {
  try {
    // `gh auth status` exits 0 when at least one host is authenticated.
    await execFileP("gh", ["auth", "status"], { timeout: 4000 });
    // Capture the active account so we can report it back.
    const { stdout } = await execFileP("gh", ["api", "user", "-q", ".login"], { timeout: 4000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function buildIssueBody(input: FileFeedbackInput): string {
  const lines: string[] = [
    `_Filed via \`send_feedback\` MCP tool (gh CLI)._`,
    "",
    `- **product**: \`${input.product}\``,
    `- **version**: \`${input.version}\``,
    `- **severity**: \`${input.severity}\``,
    `- **reported**: ${new Date().toISOString()}`,
    "",
    "## Message",
    "",
    input.message,
    "",
  ];
  if (input.context && Object.keys(input.context).length) {
    lines.push("## Context", "", "```json", JSON.stringify(input.context, null, 2), "```");
  }
  return lines.join("\n");
}

function buildIssueTitle(input: FileFeedbackInput): string {
  const snippet = input.message.replace(/\s+/g, " ").trim().slice(0, 90);
  return `[feedback/${input.severity}] ${snippet}${input.message.length > 90 ? "…" : ""}`;
}

async function fileViaGh(input: FileFeedbackInput, login: string): Promise<FileFeedbackResult> {
  const labels = ["feedback", `feedback:${input.severity}`, `product:${input.product}`];
  const args = [
    "issue", "create",
    "--repo", REPO,
    "--title", buildIssueTitle(input),
    "--body", buildIssueBody(input),
  ];
  for (const l of labels) args.push("--label", l);
  // gh prints the issue URL on success.
  const { stdout } = await execFileP("gh", args, { timeout: 15_000, maxBuffer: 1_000_000 });
  const url = stdout.trim().split("\n").pop() || "";
  const m = url.match(/\/issues\/(\d+)/);
  if (!m) throw new Error(`gh issue create returned unexpected output: ${stdout.slice(0, 300)}`);
  return { url, issue_number: Number(m[1]), authored_by: "user" };
}

async function fileViaEndpoint(input: FileFeedbackInput): Promise<FileFeedbackResult> {
  const res = await fetch(`${input.endpoint.replace(/\/$/, "")}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      severity: input.severity,
      product: input.product,
      version: input.version,
      context: input.context,
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`feedback POST failed: ${res.status} ${bodyText.slice(0, 300)}`);
  }
  const parsed = JSON.parse(bodyText) as { url?: string; issue_number?: number };
  if (!parsed.url || !parsed.issue_number) {
    throw new Error(`feedback endpoint returned malformed response: ${bodyText.slice(0, 300)}`);
  }
  return { url: parsed.url, issue_number: parsed.issue_number, authored_by: "shared-bot" };
}

export async function fileFeedback(input: FileFeedbackInput): Promise<FileFeedbackResult> {
  // Allow explicit opt-out for users who prefer the shared-bot route or who
  // have a misconfigured `gh` install.
  if (process.env.CHROME_MCP_FEEDBACK_NO_GH) {
    return fileViaEndpoint(input);
  }
  const login = await ghAuthenticated();
  if (login) {
    try {
      return await fileViaGh(input, login);
    } catch (e) {
      // Fall through to the endpoint so feedback still gets filed.
      // eslint-disable-next-line no-console
      console.error(`[feedback] gh path failed (${(e as Error).message}); falling back to shared endpoint`);
    }
  }
  return fileViaEndpoint(input);
}
