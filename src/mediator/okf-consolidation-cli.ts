export interface ConsolidationCliArgs {
  projectId: string;
  inputPath?: string;
  apply: boolean;
  restore: boolean;
  writersStopped: boolean;
}

/** Parse the mutually-exclusive plan-generation, apply, and restore modes. */
export function parseConsolidationCliArgs(argv: string[]): ConsolidationCliArgs {
  const [projectId, ...args] = argv;
  const apply = args.includes("--apply");
  const restore = args.includes("--restore");
  const positional = args.filter((value, index) => {
    if (value.startsWith("--")) return false;
    return index === 0 || !["--snapshot-out", "--plan-out"].includes(args[index - 1]);
  });
  const inputPath = positional[0];

  if (!projectId) throw new Error("project id is required");
  if (positional.length > 1) throw new Error("only one input file may be supplied");
  if (apply && restore) throw new Error("--apply and --restore are mutually exclusive");
  if ((apply || restore) && !inputPath) throw new Error(`${restore ? "--restore" : "--apply"} requires an explicit input file`);
  if (!inputPath) throw new Error("a plan/spec/snapshot input is required");

  return {
    projectId,
    inputPath,
    apply,
    restore,
    writersStopped: args.includes("--writers-stopped"),
  };
}
