export type LocalApiBoundaryDenial = Readonly<{
  code:
    | "LOCAL_API_HOST_REJECTED"
    | "LOCAL_API_ORIGIN_REQUIRED"
    | "LOCAL_API_ORIGIN_REJECTED"
    | "LOCAL_API_CROSS_SITE_REJECTED"
    | "PAID_RUN_JSON_REQUIRED";
  status: 403 | 415;
}>;

const loopbackAuthorityPattern = /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;
const readMethods = new Set(["GET", "HEAD"]);

function localAuthority(value: string | null): string | undefined {
  const authority = value?.trim().toLowerCase();
  if (!authority || !loopbackAuthorityPattern.test(authority)) {
    return undefined;
  }
  const port = authority.includes(":")
    ? Number(authority.slice(authority.lastIndexOf(":") + 1))
    : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    return undefined;
  }
  return authority;
}

/**
 * Protects the loopback-only jobs API from DNS rebinding and browser CSRF.
 * Route handlers retain their own schema, state and paid-call authorization
 * checks; this guard rejects hostile transport context before they are reached.
 */
export function inspectLocalAppRequest(
  request: Pick<Request, "headers" | "method" | "url">,
): LocalApiBoundaryDenial | null {
  const authority = localAuthority(request.headers.get("host"));
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return { code: "LOCAL_API_HOST_REJECTED", status: 403 };
  }
  if (
    !authority ||
    !["http:", "https:"].includes(requestUrl.protocol)
  ) {
    return { code: "LOCAL_API_HOST_REJECTED", status: 403 };
  }
  return null;
}

export function inspectLocalJobsApiRequest(
  request: Pick<Request, "headers" | "method" | "url">,
): LocalApiBoundaryDenial | null {
  const appDenial = inspectLocalAppRequest(request);
  if (appDenial) {
    return appDenial;
  }
  const authority = localAuthority(request.headers.get("host"));
  const requestUrl = new URL(request.url);
  if (!authority) {
    return { code: "LOCAL_API_HOST_REJECTED", status: 403 };
  }

  if (readMethods.has(request.method.toUpperCase())) {
    return null;
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return { code: "LOCAL_API_CROSS_SITE_REJECTED", status: 403 };
  }

  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) {
    return { code: "LOCAL_API_ORIGIN_REQUIRED", status: 403 };
  }
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return { code: "LOCAL_API_ORIGIN_REJECTED", status: 403 };
  }
  if (
    origin.origin !== rawOrigin ||
    origin.origin !== `${requestUrl.protocol}//${authority}` ||
    localAuthority(origin.host) !== authority
  ) {
    return { code: "LOCAL_API_ORIGIN_REJECTED", status: 403 };
  }

  if (
    request.method.toUpperCase() === "POST" &&
    /^\/api\/jobs\/[^/]+\/run\/?$/.test(requestUrl.pathname) &&
    request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json"
  ) {
    return { code: "PAID_RUN_JSON_REQUIRED", status: 415 };
  }
  return null;
}
