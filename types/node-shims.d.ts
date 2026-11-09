declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: string): string;
  export function existsSync(path: string): boolean;
  export function writeFileSync(path: string, data: string, encoding: string): void;
  export function openSync(path: string, flags: string): number;
  export function readSync(
    fd: number,
    buffer: { length: number },
    offset: number,
    length: number,
    position: number | null,
  ): number;
  export function closeSync(fd: number): void;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};
