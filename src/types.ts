import type { CapturePolicy } from "./capture-policy.js";
import type { PayloadLimits } from "./limits.js";

export interface Config {
  publicKey: string;
  secretKey: string;
  host: string;
  capturePolicy?: CapturePolicy;
  limits?: PayloadLimits;
}

export interface LangfuseObservation {
  id?: string;
  traceId?: string;
  update(body?: ObservationUpdate): LangfuseObservation;
  end(body?: ObservationUpdate): void;
  startObservation?(
    name: string,
    body?: ObservationUpdate,
    options?: { asType?: "agent" | "generation" | "tool" | "span" },
  ): LangfuseObservation;
  setTraceIO?(body?: { input?: unknown; output?: unknown }): void;
}

export interface ObservationUpdate {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  usage?: Record<string, number>;
  costDetails?: Record<string, number>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  completionStartTime?: Date;
}

export interface LangfuseScoreClient {
  api?: {
    trace?: {
      get?: (traceId: string) => Promise<unknown>;
    };
    ingestion?: {
      batch?: (request: unknown) => Promise<unknown>;
    };
  };
  score?: {
    create(body: {
      traceId?: string;
      sessionId?: string;
      observationId?: string;
      name: string;
      value: number;
      dataType?: "NUMERIC" | "BOOLEAN";
    }): unknown;
  };
  flush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

export interface PendingScore {
  id?: string;
  traceId?: string;
  sessionId?: string;
  observationId?: string;
  name: string;
  value: number;
  dataType?: "NUMERIC" | "BOOLEAN";
  environment?: string;
}

export interface LangfuseRuntimeConfig {
  publicKey: string;
  secretKey: string;
  host: string;
}

export interface LangfuseRuntime {
  startObservation: (
    name: string,
    body?: ObservationUpdate,
    options?: { asType?: "agent" | "generation" | "tool" | "span" },
  ) => LangfuseObservation;
  propagateAttributes: (
    params: {
      sessionId?: string;
      traceName?: string;
      metadata?: Record<string, string>;
      tags?: string[];
    },
    fn: () => LangfuseObservation,
  ) => LangfuseObservation;
  scoreClient: LangfuseScoreClient;
  spanProcessor?: { forceFlush?: () => Promise<void>; shutdown?: () => Promise<void> };
  tracerProvider?: { forceFlush?: () => Promise<void>; shutdown?: () => Promise<void> };
  clearTracerProvider?: () => void;
  restFallback?: unknown;
  pendingScores?: PendingScore[];
  scoreFlushAt?: number;
  scoreFlushIntervalMs?: number;
  scoreRequestTimeoutMs?: number;
  scoreFlushTimer?: NodeJS.Timeout;
  scoreFlushPromise?: Promise<void>;
  scoreFlushController?: AbortController;
  scoreFlushStopped?: boolean;
  runtimeConfig?: LangfuseRuntimeConfig;
}

export interface GenerationState {
  observation: LangfuseObservation;
  requestKey: string;
  ended: boolean;
  metadata: Record<string, unknown>;
  modelParameters?: Record<string, string | number>;
  ttftRecorded?: boolean;
}

export interface ToolState {
  observation: LangfuseObservation;
  toolName: string;
  ended: boolean;
  startedAt: number;
  inputBytes: number;
}

export interface AgentState {
  root?: LangfuseObservation;
  activeTurn?: LangfuseObservation;
  traceId?: string;
  promptInput?: unknown;
  cwd?: string;
  generationSeq: number;
  activeGenerations: Map<string, GenerationState>;
  generationOrder: string[];
  activeTools: Map<string, ToolState>;
  latestAssistantOutput?: unknown;
  sourceMetadata?: Record<string, unknown>;
  providerMetadataByRequest: Map<string, Record<string, unknown>>;
}
