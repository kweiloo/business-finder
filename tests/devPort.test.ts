import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_API_PORT, DEV_WEB_PORT, firstBindablePort, type PortState } from "../web/devPort.js";

/** A probe that reports the given state for listed ports and `free` for the rest. */
function fakeProbe(states: Record<number, PortState>) {
  const asked: number[] = [];
  const probe = async (port: number): Promise<PortState> => {
    asked.push(port);
    return states[port] ?? "free";
  };
  return { probe, asked };
}

describe("dev ports", () => {
  it("sit outside the Windows dynamic port ranges", () => {
    for (const port of [DEV_WEB_PORT, DEV_API_PORT]) {
      expect(port).toBeGreaterThan(15_000);
      expect(port).toBeLessThan(49_152);
    }
    expect(DEV_WEB_PORT).toBe(15_173);
    expect(DEV_API_PORT).toBe(18_080);
  });
});

describe("firstBindablePort", () => {
  it("skips a run of ports reserved by Windows", async () => {
    const states: Record<number, PortState> = {};
    for (let p = 15_173; p <= 15_180; p++) states[p] = "reserved";
    const { probe } = fakeProbe(states);
    expect(await firstBindablePort(15_173, probe)).toBe(15_181);
  });

  it("skips a port in use", async () => {
    const { probe, asked } = fakeProbe({ 15_173: "in_use" });
    expect(await firstBindablePort(15_173, probe)).toBe(15_174);
    expect(asked).toEqual([15_173, 15_174]);
  });

  it("returns the start port when it is free, probing nothing else", async () => {
    const { probe, asked } = fakeProbe({});
    expect(await firstBindablePort(15_173, probe)).toBe(15_173);
    expect(asked).toEqual([15_173]);
  });

  it("gives up after fifty taken ports and names the start port", async () => {
    const { probe, asked } = fakeProbe(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [15_173 + i, "reserved"])));
    await expect(firstBindablePort(15_173, probe)).rejects.toThrow(/15173/);
    expect(asked).toHaveLength(50);
  });

  describe("with the real probe", () => {
    let held: Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) => (held ? held.close(() => resolve()) : resolve()));
      held = undefined;
    });

    it("moves past a port another program holds", async () => {
      const start = await firstBindablePort(18_900);
      held = createServer();
      await new Promise<void>((resolve) => held!.listen(start, "127.0.0.1", resolve));
      expect(await firstBindablePort(start)).toBeGreaterThan(start);
    });
  });
});
