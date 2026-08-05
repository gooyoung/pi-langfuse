declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    sessionManager?: {
      getSessionId?: () => unknown;
      getSessionFile?: () => unknown;
    };
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: any) => unknown },
    ): void;
  }
}
