import { detectInlineEvalArgv } from "../command-analysis/risks.js";
import { explainShellCommand } from "../command-explainer/index.js";
import type { CommandExplanation, CommandRisk, CommandStep } from "../command-explainer/index.js";
import { analyzeArgvCommand, type ExecCommandSegment } from "../exec-approvals-analysis.js";
import { normalizeExecutableToken } from "../exec-wrapper-resolution.js";
import type {
  CommandAuthorizationChainOperator,
  CommandAuthorizationContext,
  CommandAuthorizationInput,
  CommandAuthorizationPlan,
  CommandAuthorizationRelationship,
  CommandAuthorizationTree,
  CommandAuthorizationUnit,
  CommandDialect,
  CommandPromptOnlyReason,
  CommandUnanalyzableReason,
} from "./types.js";

type PlannedTree = {
  tree: CommandAuthorizationTree;
  units: CommandAuthorizationUnit[];
  nextUnitIndex: number;
};

type UnsupportedWrapper = {
  dialect: "windows-cmd" | "powershell";
  reason: CommandPromptOnlyReason;
};

export async function planCommandForAuthorization(
  input: CommandAuthorizationInput,
  context: CommandAuthorizationContext = {},
): Promise<CommandAuthorizationPlan> {
  if (input.dialect === "argv") {
    return planArgvCommand(input.argv, input.command, context);
  }
  if (input.dialect === "windows-cmd" || input.dialect === "powershell") {
    return planUnsupportedShellDialect(input.command, input.dialect);
  }
  return planPosixShellCommand(input.command, context);
}

function planArgvCommand(
  argvInput: readonly string[],
  command: string | undefined,
  context: CommandAuthorizationContext,
): CommandAuthorizationPlan {
  const source = command ?? argvInput.join(" ");
  const argv = argvInput.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (argv.length === 0) {
    return unanalyzablePlan(source, "argv", ["empty-argv"]);
  }

  const unsupportedWrapper = classifyUnsupportedWrapper(argv);
  if (unsupportedWrapper) {
    const unit = createUnit({
      id: "unit-0",
      raw: source,
      argv,
      relationship: "wrapper-inline",
      promptOnlyReasons: [unsupportedWrapper.reason],
    });
    return promptOnlyPlan(source, unsupportedWrapper.dialect, { kind: "unit", unitId: unit.id }, [
      unit,
    ]);
  }

  const analysis = analyzeArgvCommand({
    argv,
    cwd: context.cwd,
    env: context.env,
  });
  if (!analysis.ok) {
    return unanalyzablePlan(source, "argv", ["empty-argv"]);
  }
  return finalizePlannedTree(source, "argv", buildTreeFromSegments(analysis.segments, 0, "simple"));
}

function planUnsupportedShellDialect(
  command: string,
  dialect: "windows-cmd" | "powershell",
): CommandAuthorizationPlan {
  const source = command.trim();
  if (!source) {
    return unanalyzablePlan(command, dialect, ["empty-command"]);
  }
  const reason: CommandPromptOnlyReason =
    dialect === "powershell" ? "unsupported-powershell-wrapper" : "unsupported-cmd-wrapper";
  const unit = createUnit({
    id: "unit-0",
    raw: source,
    argv: [],
    relationship: "wrapper-inline",
    promptOnlyReasons: [reason],
  });
  return promptOnlyPlan(command, dialect, { kind: "unit", unitId: unit.id }, [unit]);
}

async function planPosixShellCommand(
  command: string,
  _context: CommandAuthorizationContext,
): Promise<CommandAuthorizationPlan> {
  const source = command.trim();
  if (!source) {
    return unanalyzablePlan(command, "posix-shell", ["empty-command"]);
  }

  const explanation = await explainShellCommand(source);
  if (!explanation.ok) {
    return unanalyzablePlan(source, "posix-shell", ["malformed-shell"]);
  }

  const selectedSteps = selectPlanningSteps(explanation);
  const sourcePromptOnlyReasons = promptOnlyReasonsFromRisks(explanation.risks);
  if (selectedSteps.length === 0 && sourcePromptOnlyReasons.length > 0) {
    const unit = createUnit({
      id: "unit-0",
      raw: source,
      argv: [],
      relationship: "simple",
      promptOnlyReasons: sourcePromptOnlyReasons,
    });
    return promptOnlyPlan(source, "posix-shell", { kind: "unit", unitId: unit.id }, [unit]);
  }

  if (selectedSteps.length === 0) {
    return unanalyzablePlan(source, "posix-shell", ["empty-command"]);
  }

  return finalizePlannedTree(
    source,
    "posix-shell",
    buildTreeFromCommandSteps(source, selectedSteps, explanation.risks),
  );
}

function selectPlanningSteps(explanation: CommandExplanation): CommandStep[] {
  const selectedSteps: CommandStep[] = [];
  for (const step of explanation.topLevelCommands) {
    const wrapperPayloadSteps = explanation.nestedCommands.filter(
      (nestedStep) =>
        nestedStep.context === "wrapper-payload" &&
        stepContainsSpan(step, nestedStep.span.startIndex, nestedStep.span.endIndex),
    );
    const hasShellWrapperRisk = explanation.risks.some(
      (risk) =>
        risk.kind === "shell-wrapper" &&
        spansOverlap(step.span.startIndex, step.span.endIndex, risk),
    );
    if (hasShellWrapperRisk && wrapperPayloadSteps.length > 0) {
      selectedSteps.push(...wrapperPayloadSteps);
      continue;
    }
    selectedSteps.push(step);
  }
  return selectedSteps;
}

type StepGroup = {
  steps: CommandStep[];
  relationship: CommandAuthorizationRelationship;
};

function buildTreeFromCommandSteps(
  source: string,
  inputSteps: readonly CommandStep[],
  risks: readonly CommandRisk[],
): PlannedTree {
  const steps = inputSteps.toSorted((left, right) => left.span.startIndex - right.span.startIndex);
  const groups: StepGroup[] = [];
  const operators: CommandAuthorizationChainOperator[] = [];
  let currentSteps: CommandStep[] = [];
  let currentRelationship: CommandAuthorizationRelationship = "simple";

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) {
      continue;
    }
    currentSteps.push(step);
    const nextStep = steps[index + 1];
    if (!nextStep) {
      continue;
    }
    const separator = separatorBetweenSteps(source, step, nextStep);
    if (separator === "pipe") {
      continue;
    }
    groups.push({ steps: currentSteps, relationship: currentRelationship });
    currentSteps = [];
    if (separator) {
      operators.push(separator);
      currentRelationship = relationshipForOperator(separator);
    } else {
      operators.push(";");
      currentRelationship = "sequence";
    }
  }

  if (currentSteps.length > 0) {
    groups.push({
      steps: currentSteps,
      relationship:
        currentRelationship === "simple" && currentSteps.length > 1
          ? "pipeline"
          : currentRelationship,
    });
  }

  const units: CommandAuthorizationUnit[] = [];
  const children: CommandAuthorizationTree[] = [];
  let nextUnitIndex = 0;
  for (const group of groups) {
    const plannedGroup = buildTreeFromStepGroup(group, risks, nextUnitIndex);
    units.push(...plannedGroup.units);
    children.push(plannedGroup.tree);
    nextUnitIndex = plannedGroup.nextUnitIndex;
  }

  if (operators.length > 0) {
    return {
      tree: { kind: "chain", operators, children },
      units,
      nextUnitIndex,
    };
  }

  return {
    tree: children[0] ?? { kind: "pipeline", children: [] },
    units,
    nextUnitIndex,
  };
}

function buildTreeFromStepGroup(
  group: StepGroup,
  risks: readonly CommandRisk[],
  startUnitIndex: number,
): PlannedTree {
  const units = group.steps.map((step, offset) =>
    createUnitFromStep(step, `unit-${startUnitIndex + offset}`, group.relationship, risks),
  );
  const children = units.map(
    (unit): CommandAuthorizationTree => ({ kind: "unit", unitId: unit.id }),
  );
  return {
    tree: children.length === 1 ? children[0] : { kind: "pipeline", children },
    units,
    nextUnitIndex: startUnitIndex + units.length,
  };
}

type StepSeparator = "pipe" | CommandAuthorizationChainOperator;

function separatorBetweenSteps(
  source: string,
  left: CommandStep,
  right: CommandStep,
): StepSeparator | null {
  const separatorText = source.slice(left.span.endIndex, right.span.startIndex);
  for (let index = 0; index < separatorText.length; index += 1) {
    const current = separatorText[index];
    const next = separatorText[index + 1];
    if (current === "&" && next === "&") {
      return "&&";
    }
    if (current === "|" && next === "|") {
      return "||";
    }
    if (current === ";" || current === "\n") {
      return ";";
    }
    if (current === "|") {
      return "pipe";
    }
  }
  return null;
}

function buildTreeFromSegments(
  segments: readonly ExecCommandSegment[],
  startUnitIndex: number,
  relationship: CommandAuthorizationRelationship,
): PlannedTree {
  const units = segments.map((segment, offset) =>
    createUnitFromSegment(segment, `unit-${startUnitIndex + offset}`, relationship),
  );
  const children = units.map(
    (unit): CommandAuthorizationTree => ({ kind: "unit", unitId: unit.id }),
  );
  return {
    tree: children.length === 1 ? children[0] : { kind: "pipeline", children },
    units,
    nextUnitIndex: startUnitIndex + units.length,
  };
}

function createUnitFromSegment(
  segment: ExecCommandSegment,
  id: string,
  relationship: CommandAuthorizationRelationship,
): CommandAuthorizationUnit {
  const promptOnlyReasons: CommandPromptOnlyReason[] = [];
  if (detectInlineEvalArgv(segment.argv)) {
    promptOnlyReasons.push("interpreter-inline-eval");
  }
  return createUnit({
    id,
    raw: segment.raw,
    argv: segment.argv,
    relationship,
    promptOnlyReasons,
  });
}

function createUnitFromStep(
  step: CommandStep,
  id: string,
  relationship: CommandAuthorizationRelationship,
  risks: readonly CommandRisk[],
): CommandAuthorizationUnit {
  const promptOnlyReasons = promptOnlyReasonsForStep(step, risks);
  const unitRelationship =
    relationship === "simple" && step.context === "wrapper-payload"
      ? "wrapper-inline"
      : relationship;
  return createUnit({
    id,
    raw: step.text,
    argv: step.argv,
    relationship: unitRelationship,
    promptOnlyReasons,
  });
}

function createUnit(params: {
  id: string;
  raw: string;
  argv: string[];
  relationship: CommandAuthorizationRelationship;
  promptOnlyReasons: CommandPromptOnlyReason[];
}): CommandAuthorizationUnit {
  const executable = params.argv[0]?.trim() || null;
  const normalizedExecutable = executable ? normalizeExecutableToken(executable) : null;
  const allowAutomatically = params.promptOnlyReasons.length === 0;
  return {
    id: params.id,
    raw: params.raw,
    argv: params.argv,
    executable,
    normalizedExecutable,
    relationship: params.relationship,
    allowlistEligible: allowAutomatically,
    allowAlwaysEligible: allowAutomatically,
    promptOnlyReasons: params.promptOnlyReasons,
    blockReasons: [],
  };
}

function finalizePlannedTree(
  source: string,
  dialect: CommandDialect,
  planned: PlannedTree,
): CommandAuthorizationPlan {
  const promptOnlyReasons = uniquePromptOnlyReasons(
    planned.units.flatMap((unit) => unit.promptOnlyReasons),
  );
  if (promptOnlyReasons.length > 0) {
    return promptOnlyPlan(source, dialect, planned.tree, planned.units);
  }
  return {
    kind: "analyzable",
    source,
    dialect,
    tree: planned.tree,
    units: planned.units,
  };
}

function promptOnlyPlan(
  source: string,
  dialect: CommandDialect,
  tree: CommandAuthorizationTree,
  units: CommandAuthorizationUnit[],
): CommandAuthorizationPlan {
  return {
    kind: "prompt-only",
    source,
    dialect,
    tree,
    units,
    promptOnlyReasons: uniquePromptOnlyReasons(units.flatMap((unit) => unit.promptOnlyReasons)),
  };
}

function unanalyzablePlan(
  source: string,
  dialect: CommandDialect,
  reasons: CommandUnanalyzableReason[],
): CommandAuthorizationPlan {
  return {
    kind: "unanalyzable",
    source,
    dialect,
    reasons,
  };
}

function relationshipForOperator(
  operator: CommandAuthorizationChainOperator | null,
): CommandAuthorizationRelationship {
  if (operator === "&&") {
    return "and-conditional";
  }
  if (operator === "||") {
    return "or-conditional";
  }
  if (operator === ";") {
    return "sequence";
  }
  return "simple";
}

function uniquePromptOnlyReasons(
  reasons: readonly CommandPromptOnlyReason[],
): CommandPromptOnlyReason[] {
  return [...new Set(reasons)];
}

function classifyUnsupportedWrapper(argv: readonly string[]): UnsupportedWrapper | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "cmd" || executable === "cmd.exe") {
    return { dialect: "windows-cmd", reason: "unsupported-cmd-wrapper" };
  }
  if (executable === "powershell" || executable === "powershell.exe" || executable === "pwsh") {
    return { dialect: "powershell", reason: "unsupported-powershell-wrapper" };
  }
  return null;
}

function promptOnlyReasonsForStep(
  step: CommandStep,
  risks: readonly CommandRisk[],
): CommandPromptOnlyReason[] {
  return promptOnlyReasonsFromRisks(
    risks.filter((risk) => spansOverlap(step.span.startIndex, step.span.endIndex, risk)),
  );
}

function promptOnlyReasonsFromRisks(risks: readonly CommandRisk[]): CommandPromptOnlyReason[] {
  const reasonSet = new Set<CommandPromptOnlyReason>();
  for (const risk of risks) {
    if (risk.kind === "inline-eval") {
      reasonSet.add("interpreter-inline-eval");
    } else if (risk.kind === "command-substitution") {
      reasonSet.add("command-substitution");
    } else if (risk.kind === "dynamic-executable") {
      reasonSet.add("dynamic-executable");
    } else if (risk.kind === "line-continuation" || risk.kind === "syntax-error") {
      reasonSet.add("unsupported-shell-syntax");
    }
  }
  return (
    [
      "command-substitution",
      "dynamic-executable",
      "interpreter-inline-eval",
      "unsupported-shell-syntax",
    ] as const
  ).filter((reason) => reasonSet.has(reason));
}

function spansOverlap(startIndex: number, endIndex: number, risk: CommandRisk): boolean {
  return risk.span.startIndex < endIndex && risk.span.endIndex > startIndex;
}

function stepContainsSpan(step: CommandStep, startIndex: number, endIndex: number): boolean {
  return step.span.startIndex <= startIndex && step.span.endIndex >= endIndex;
}
