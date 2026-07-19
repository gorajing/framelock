import { type NextRequest, NextResponse } from "next/server";

import {
  inspectLocalAppRequest,
  inspectLocalJobsApiRequest,
} from "./lib/security/local-api-boundary";

export function proxy(request: NextRequest) {
  const appDenial = inspectLocalAppRequest(request);
  const denial =
    appDenial ??
    (request.nextUrl.pathname.startsWith("/api/jobs")
      ? inspectLocalJobsApiRequest(request)
      : null);
  if (!denial) {
    return NextResponse.next();
  }
  return NextResponse.json(
    { error: { code: denial.code } },
    {
      status: denial.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export const config = {
  matcher: ["/:path*"],
};
