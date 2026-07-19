import { describe, expect, it } from "vitest";

import {
  inspectLocalAppRequest,
  inspectLocalJobsApiRequest,
} from "./local-api-boundary";

function request(input: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
} = {}): Request {
  return new Request(input.url ?? "http://127.0.0.1:3000/api/jobs", {
    method: input.method ?? "GET",
    headers: input.headers,
  });
}

describe("loopback jobs API boundary", () => {
  it("guards rendered application metadata from DNS-rebinding hosts", () => {
    expect(
      inspectLocalAppRequest(
        request({
          url: "http://127.0.0.1:3000/",
          headers: { host: "127.0.0.1:3000" },
        }),
      ),
    ).toBeNull();
    expect(
      inspectLocalAppRequest(
        request({
          url: "http://127.0.0.1:3000/",
          headers: { host: "rebound.example:3000" },
        }),
      ),
    ).toEqual({ code: "LOCAL_API_HOST_REJECTED", status: 403 });
  });

  it.each(["127.0.0.1:3000", "localhost:3000", "127.0.0.1"])(
    "allows a read from local authority %s",
    (host) => {
      expect(
        inspectLocalJobsApiRequest(
          request({ url: `http://${host}/api/jobs`, headers: { host } }),
        ),
      ).toBeNull();
    },
  );

  it("uses the guarded Host when Next normalizes its internal request URL", () => {
    expect(
      inspectLocalJobsApiRequest(
        request({
          url: "http://localhost:3000/api/jobs",
          headers: { host: "127.0.0.1:3000" },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    "evil.example:3000",
    "localhost.evil.example:3000",
    "127.0.0.1.evil.example:3000",
    "127.0.0.1:3000, evil.example",
  ])("rejects a DNS-rebinding authority %s before any API read", (host) => {
    expect(
      inspectLocalJobsApiRequest(request({ headers: { host } })),
    ).toEqual({ code: "LOCAL_API_HOST_REJECTED", status: 403 });
  });

  it("allows a same-origin JSON paid-run request", () => {
    expect(
      inspectLocalJobsApiRequest(
        request({
          url: "http://127.0.0.1:3000/api/jobs/job-1/run",
          method: "POST",
          headers: {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:3000",
            "content-type": "application/json; charset=utf-8",
            "sec-fetch-site": "same-origin",
          },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [undefined, "LOCAL_API_ORIGIN_REQUIRED"],
    ["https://evil.example", "LOCAL_API_ORIGIN_REJECTED"],
    ["http://localhost:3000", "LOCAL_API_ORIGIN_REJECTED"],
    ["null", "LOCAL_API_ORIGIN_REJECTED"],
  ] as const)(
    "rejects missing or mismatched mutation origin %s",
    (origin, code) => {
      const headers: Record<string, string> = {
        host: "127.0.0.1:3000",
        "content-type": "application/json",
      };
      if (origin) headers.origin = origin;
      expect(
        inspectLocalJobsApiRequest(
          request({
            url: "http://127.0.0.1:3000/api/jobs/job-1/run",
            method: "POST",
            headers,
          }),
        ),
      ).toEqual({ code, status: 403 });
    },
  );

  it("rejects cross-site browser metadata even with forged local headers", () => {
    expect(
      inspectLocalJobsApiRequest(
        request({
          url: "http://127.0.0.1:3000/api/jobs/job-1/pricing",
          method: "POST",
          headers: {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:3000",
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ).toEqual({ code: "LOCAL_API_CROSS_SITE_REJECTED", status: 403 });
  });

  it.each([undefined, "text/plain", "multipart/form-data"])(
    "requires application/json on the paid run route, received %s",
    (contentType) => {
      const headers: Record<string, string> = {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      };
      if (contentType) headers["content-type"] = contentType;
      expect(
        inspectLocalJobsApiRequest(
          request({
            url: "http://127.0.0.1:3000/api/jobs/job-1/run",
            method: "POST",
            headers,
          }),
        ),
      ).toEqual({ code: "PAID_RUN_JSON_REQUIRED", status: 415 });
    },
  );

  it("allows same-origin bodyless pricing and multipart intake actions", () => {
    expect(
      inspectLocalJobsApiRequest(
        request({
          url: "http://localhost:3000/api/jobs/job-1/pricing",
          method: "POST",
          headers: {
            host: "localhost:3000",
            origin: "http://localhost:3000",
          },
        }),
      ),
    ).toBeNull();
    expect(
      inspectLocalJobsApiRequest(
        request({
          url: "http://localhost:3000/api/jobs",
          method: "POST",
          headers: {
            host: "localhost:3000",
            origin: "http://localhost:3000",
            "content-type": "multipart/form-data; boundary=test",
          },
        }),
      ),
    ).toBeNull();
  });
});
