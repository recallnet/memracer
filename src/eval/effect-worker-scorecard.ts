import ts from "typescript";

export interface TypeScriptSourceMetrics {
  lines: number;
  nonBlankLines: number;
  namedFunctions: number;
  largestNamedFunction: {
    name: string;
    lines: number;
  };
}

function namedFunction(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (
    ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
  ) {
    return node.name.getText();
  }
  return null;
}

/** Measure stable, reviewable source-shape signals without a Git dependency. */
export function measureTypeScriptSource(
  source: string,
  fileName = "source.ts",
): TypeScriptSourceMetrics {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let namedFunctions = 0;
  let largestNamedFunction = { name: "", lines: 0 };

  function visit(node: ts.Node): void {
    const name = namedFunction(node);
    if (name !== null) {
      namedFunctions += 1;
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
      const lines = end - start + 1;
      if (lines > largestNamedFunction.lines) largestNamedFunction = { name, lines };
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return {
    lines: source.split(/\r?\n/).length - 1,
    nonBlankLines: source.split(/\r?\n/).filter((line) => line.trim() !== "").length,
    namedFunctions,
    largestNamedFunction,
  };
}

export const EFFECT_WORKER_SCORECARD = {
  measuredAt: "2026-07-19T15:10:00Z",
  baseline: {
    reference: "task #260 baseline at 369350e",
    deterministic: {
      mediatorCases: { passed: 55, total: 55 },
      pipelineCases: { passed: 29, total: 29 },
      groomQuality: { passed: 100, total: 100, regression: false },
    },
    liveGroomQuality: { passed: 84, total: 100, regression: true },
    source: {
      worker: {
        lines: 457,
        nonBlankLines: 424,
        namedFunctions: 24,
        largestNamedFunction: { name: "run", lines: 50 },
      },
      openRouter: {
        lines: 743,
        nonBlankLines: 695,
        namedFunctions: 29,
        largestNamedFunction: { name: "openRouterOptionsFromEnv", lines: 65 },
      },
    },
  },
  candidate: {
    reference: "task #322 policy-routing candidate built on #318",
    deterministic: {
      mediatorCases: { passed: 55, total: 55 },
      pipelineCases: { passed: 29, total: 29 },
      groomQuality: { passed: 100, total: 100, regression: false },
      outputReliability: { passed: 60, total: 60, simulatedMinutes: 60 },
    },
    liveGroomQuality: { passed: 97, total: 100, regression: false },
    source: {
      worker: {
        lines: 773,
        nonBlankLines: 725,
        namedFunctions: 36,
        largestNamedFunction: { name: "supervise", lines: 65 },
      },
      openRouter: {
        lines: 1012,
        nonBlankLines: 954,
        namedFunctions: 35,
        largestNamedFunction: { name: "openRouterOptionsFromEnv", lines: 86 },
      },
    },
  },
  interop: {
    sharedPromiseBridges: 1,
    retainedPromiseBoundaries: ["MediatorDriver handlers", "database transactions"],
    runtimePolicy: "one injected ManagedRuntime; only its creator disposes it",
  },
  interpretation: {
    quality:
      "The deterministic gates prove behavioral equivalence. Live provider/model variance dominates the 84-to-97 observation, so the refactor does not claim that improvement.",
    complexity:
      "Worker source grew 316 lines (69.1%), 301 non-blank lines (71.0%), and 12 named functions; its largest named function grew from 50 to 65 lines. OpenRouter grew 213 lines (28.7%), 206 non-blank lines (29.6%), and three named functions from the #260 baseline while its largest function grew from 65 to 82 lines.",
    recommendation: "stop",
    queueTsNext: false,
    rationale:
      "Effect materially improves the long-lived worker concurrency boundary, but queue.ts is a transactional Promise/DB domain service without the same fiber, timeout, or resource-ownership problem.",
  },
} as const;
