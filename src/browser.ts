import type { Config } from "./types";

let connectFlags: string[] = ["--auto-connect"];

export function configure(config: Config): void {
  if (config.cdp_port) {
    connectFlags = ["--cdp", String(config.cdp_port)];
  } else {
    connectFlags = ["--auto-connect"];
  }
}

async function run(...args: string[]): Promise<string> {
  const proc = Bun.spawn(
    ["agent-browser", ...connectFlags, ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `agent-browser ${args[0]} failed (exit ${exitCode}): ${stderr || stdout}`,
    );
  }

  return stdout;
}

export async function open(url: string): Promise<void> {
  await run("open", url);
}

export async function waitForLoad(): Promise<void> {
  await run("wait", "--load", "domcontentloaded");
  await run("wait", "3000");
}

export async function snapshot(selector?: string): Promise<string> {
  const args = ["snapshot", "--compact"];
  if (selector) args.push("-s", selector);
  return run(...args);
}

export async function click(ref: string): Promise<void> {
  await run("click", ref);
}

export async function scroll(
  direction: "down" | "up",
  amount: number,
): Promise<void> {
  await run("scroll", direction, String(amount));
}

export async function wait(ms: number): Promise<void> {
  await run("wait", String(ms));
}

export async function screenshot(path: string): Promise<void> {
  await run("screenshot", path);
}

export async function close(): Promise<void> {
  await run("close");
}
