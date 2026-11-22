import { describe, expect, it, vi } from "vitest";
import { checkDomainMx, createMxCache, emailDomain, type MxResolver } from "../src/core/enrich/mx.js";

function dnsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("emailDomain", () => {
  it("extracts and normalizes the domain part of an email", () => {
    expect(emailDomain("Info@Shop-A.TEST")).toBe("shop-a.test");
    expect(emailDomain("  alice@sub.example.com.  ")).toBe("sub.example.com");
    expect(emailDomain("not-an-email")).toBe("");
    expect(emailDomain("alice@")).toBe("");
  });
});

describe("checkDomainMx", () => {
  it("returns ok when MX records exist", async () => {
    const resolver: MxResolver = {
      resolveMx: vi.fn(async () => [{ exchange: "mx1.shop.test", priority: 10 }]),
      resolve4: vi.fn(async () => []),
    };
    expect(await checkDomainMx("shop.test", { resolver })).toBe("ok");
    expect(resolver.resolveMx).toHaveBeenCalledWith("shop.test");
    expect(resolver.resolve4).not.toHaveBeenCalled();
  });

  it("falls back to A record lookup when there is no MX record", async () => {
    const resolverEmpty: MxResolver = {
      resolveMx: vi.fn(async () => []),
      resolve4: vi.fn(async () => ["93.184.216.34"]),
    };
    expect(await checkDomainMx("shop.test", { resolver: resolverEmpty })).toBe("ok");
    expect(resolverEmpty.resolve4).toHaveBeenCalledWith("shop.test");

    const resolverEnodata: MxResolver = {
      resolveMx: vi.fn(async () => {
        throw dnsError("ENODATA");
      }),
      resolve4: vi.fn(async () => ["93.184.216.34"]),
    };
    expect(await checkDomainMx("shop.test", { resolver: resolverEnodata })).toBe("ok");
  });

  it("returns no mail server when neither MX nor A records exist", async () => {
    const resolver: MxResolver = {
      resolveMx: vi.fn(async () => {
        throw dnsError("ENODATA");
      }),
      resolve4: vi.fn(async () => {
        throw dnsError("ENOTFOUND");
      }),
    };
    expect(await checkDomainMx("missing.test", { resolver })).toBe("no mail server");
  });

  it("treats RFC 7505 null MX (empty or dot exchange) as no mail server without A fallback", async () => {
    const resolver: MxResolver = {
      resolveMx: vi.fn(async () => [{ exchange: ".", priority: 0 }]),
      resolve4: vi.fn(async () => ["93.184.216.34"]),
    };
    expect(await checkDomainMx("nomail.test", { resolver })).toBe("no mail server");
    expect(resolver.resolve4).not.toHaveBeenCalled();
  });

  it("returns unknown when MX lookup times out", async () => {
    const resolver: MxResolver = {
      resolveMx: () => new Promise(() => {}),
      resolve4: vi.fn(async () => ["93.184.216.34"]),
    };
    expect(await checkDomainMx("slow.test", { resolver, timeoutMs: 20 })).toBe("unknown");
    expect(resolver.resolve4).not.toHaveBeenCalled();
  });

  it("returns unknown on transient DNS errors such as ETIMEOUT or ESERVFAIL", async () => {
    const resolver: MxResolver = {
      resolveMx: vi.fn(async () => {
        throw dnsError("ESERVFAIL");
      }),
      resolve4: vi.fn(async () => ["93.184.216.34"]),
    };
    expect(await checkDomainMx("flaky.test", { resolver })).toBe("unknown");
  });

  it("returns unknown immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const resolver: MxResolver = {
      resolveMx: vi.fn(async () => [{ exchange: "mx.test", priority: 10 }]),
      resolve4: vi.fn(async () => []),
    };
    expect(await checkDomainMx("shop.test", { resolver, signal: controller.signal })).toBe("unknown");
    expect(resolver.resolveMx).not.toHaveBeenCalled();
  });
});

describe("createMxCache", () => {
  it("resolves each domain at most once per run, even across concurrent calls", async () => {
    let calls = 0;
    const resolver: MxResolver = {
      resolveMx: vi.fn(async (domain) => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return domain === "dead.test" ? [] : [{ exchange: `mx.${domain}`, priority: 10 }];
      }),
      resolve4: vi.fn(async () => []),
    };

    const check = createMxCache({ resolver });
    const results = await Promise.all([
      check("Shop.test"),
      check("shop.test"),
      check("dead.test"),
      check("dead.test"),
    ]);

    expect(results).toEqual(["ok", "ok", "no mail server", "no mail server"]);
    expect(calls).toBe(2);
    expect(resolver.resolve4).toHaveBeenCalledTimes(1);
  });
});
