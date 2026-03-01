import { join } from "path";
import { mkdir } from "fs/promises";
import type { Config, XReaderOutput } from "./types";

export async function ensureDataDir(config: Config): Promise<void> {
  await mkdir(config.data_dir, { recursive: true });
}

export async function save(
  statusId: string,
  output: XReaderOutput,
  config: Config,
): Promise<string> {
  const filePath = join(config.data_dir, `${statusId}.json`);
  await Bun.write(filePath, JSON.stringify(output, null, 2));
  return filePath;
}

export function notifyWrench(msg: string): void {
  console.error(`[WRENCH] ${msg}`);
}
