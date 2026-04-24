import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-static";

export function GET() {
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(
      readFileSync(join(process.cwd(), "public", "bundle", "manifest.json"), "utf8"),
    );
  } catch {
    return NextResponse.json(
      { error: "manifest not built yet" },
      { status: 503 },
    );
  }
  return NextResponse.json(manifest, {
    headers: {
      "cache-control": "public, max-age=60, s-maxage=60",
      "access-control-allow-origin": "*",
    },
  });
}
