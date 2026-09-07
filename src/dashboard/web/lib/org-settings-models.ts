/** Client-side preview of Frigg lite/thinking models for Org Settings forms. */

export type ModelMode = "use_default" | "override";

export interface ProviderDefaults {
  id: string;
  defaultLiteModel: string;
  defaultThinkingModel: string;
}

export function previewResolvedModels(args: {
  provider: ProviderDefaults | null | undefined;
  liteMode: ModelMode;
  liteModel: string;
  thinkingMode: ModelMode;
  thinkingModel: string;
  /** Server-resolved values as fallback when override field is empty. */
  serverLite?: string;
  serverThinking?: string;
}): { lite: string; thinking: string } {
  const liteDefault = args.provider?.defaultLiteModel ?? args.serverLite ?? "";
  const thinkingDefault = args.provider?.defaultThinkingModel ?? args.serverThinking ?? "";
  const lite =
    args.liteMode === "override"
      ? (args.liteModel.trim() || args.serverLite || liteDefault)
      : liteDefault;
  const thinking =
    args.thinkingMode === "override"
      ? (args.thinkingModel.trim() || args.serverThinking || thinkingDefault)
      : thinkingDefault;
  return { lite, thinking };
}
