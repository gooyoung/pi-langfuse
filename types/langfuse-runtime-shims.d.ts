declare module "@opentelemetry/sdk-trace-base" {
  export class BasicTracerProvider {
    constructor(options?: { resource?: unknown; spanProcessors?: unknown[] });
    forceFlush?(): Promise<void>;
    shutdown?(): Promise<void>;
  }
}

declare module "@langfuse/otel" {
  export class LangfuseSpanProcessor {
    constructor(options: {
      publicKey: string;
      secretKey: string;
      baseUrl: string;
    });
    forceFlush?(): Promise<void>;
    shutdown?(): Promise<void>;
  }
}

declare module "@langfuse/tracing" {
  export function setLangfuseTracerProvider(provider: unknown): void;

  export function startObservation(
    name: string,
    body?: Record<string, unknown>,
    options?: { asType?: string },
  ): unknown;

  export function propagateAttributes<T>(
    params: {
      sessionId?: string;
      traceName?: string;
      metadata?: Record<string, string>;
      tags?: string[];
    },
    fn: () => T,
  ): T;
}

declare module "@langfuse/client" {
  export class LangfuseClient {
    constructor(options: {
      publicKey: string;
      secretKey: string;
      baseUrl: string;
    });
  }
}
