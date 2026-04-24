import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO = "actuallyroy/chrome-mcp";
const MAX_MESSAGE_LEN = 8000;
const MAX_CONTEXT_BYTES = 16 * 1024;
const ALLOWED_PRODUCTS = new Set(["chrome", "android"]);
const ALLOWED_SEVERITIES = new Set(["bug", "missing", "idea", "praise"]);

type FeedbackBody = {
  message?: unknown;
  severity?: unknown;
  product?: unknown;
  version?: unknown;
  context?: unknown;
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  const token = process.env.GITHUB_FEEDBACK_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "feedback not configured (missing GITHUB_FEEDBACK_TOKEN)" },
      { status: 503, headers: corsHeaders() },
    );
  }

  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400, headers: corsHeaders() },
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json(
      { error: "message is required" },
      { status: 400, headers: corsHeaders() },
    );
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return NextResponse.json(
      { error: `message too long (max ${MAX_MESSAGE_LEN} chars)` },
      { status: 400, headers: corsHeaders() },
    );
  }

  const severity =
    typeof body.severity === "string" && ALLOWED_SEVERITIES.has(body.severity)
      ? body.severity
      : "idea";
  const product =
    typeof body.product === "string" && ALLOWED_PRODUCTS.has(body.product)
      ? body.product
      : "unknown";
  const version = typeof body.version === "string" ? body.version : "unknown";

  let contextStr = "";
  if (body.context !== undefined && body.context !== null) {
    try {
      contextStr = JSON.stringify(body.context, null, 2);
      if (Buffer.byteLength(contextStr, "utf8") > MAX_CONTEXT_BYTES) {
        contextStr = contextStr.slice(0, MAX_CONTEXT_BYTES) + "\n…[truncated]";
      }
    } catch {
      contextStr = "[unserializable context]";
    }
  }

  const firstLine = message.split("\n")[0].slice(0, 80);
  const title = `[feedback/${severity}] ${firstLine}${firstLine.length < message.length ? "…" : ""}`;
  const bodyMd = [
    `_Submitted via \`send_feedback\` MCP tool._`,
    "",
    `- **product**: \`${product}\``,
    `- **version**: \`${version}\``,
    `- **severity**: \`${severity}\``,
    `- **reported**: ${new Date().toISOString()}`,
    "",
    "## Message",
    "",
    message,
    ...(contextStr
      ? ["", "## Context", "", "```json", contextStr, "```"]
      : []),
  ].join("\n");

  const labels = ["feedback", `feedback:${severity}`, `product:${product}`];

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      "user-agent": "chrome-mcp-feedback",
    },
    body: JSON.stringify({ title, body: bodyMd, labels }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: "github API error", status: res.status, detail: text.slice(0, 500) },
      { status: 502, headers: corsHeaders() },
    );
  }

  const issue = (await res.json()) as { number?: number; html_url?: string };
  return NextResponse.json(
    { ok: true, issue_number: issue.number, url: issue.html_url },
    { headers: corsHeaders() },
  );
}
