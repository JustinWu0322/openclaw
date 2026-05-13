import { theme } from "../terminal/theme.js";

type PluginUpdateCliOutcome = {
  status: string;
  message: string;
};

function isClawHubRiskAcknowledgementSkippedOutcome(outcome: PluginUpdateCliOutcome): boolean {
  return (
    outcome.status === "skipped" &&
    outcome.message.includes("ClawHub") &&
    outcome.message.includes("--acknowledge-clawhub-risk")
  );
}

export function logPluginUpdateOutcomes(params: {
  outcomes: readonly PluginUpdateCliOutcome[];
  log: (message: string) => void;
}): { hasErrors: boolean } {
  let hasErrors = false;
  for (const outcome of params.outcomes) {
    if (outcome.status === "error") {
      hasErrors = true;
      params.log(theme.error(outcome.message));
      continue;
    }
    if (outcome.status === "skipped") {
      if (isClawHubRiskAcknowledgementSkippedOutcome(outcome)) {
        hasErrors = true;
      }
      params.log(theme.warn(outcome.message));
      continue;
    }
    params.log(outcome.message);
  }
  return { hasErrors };
}
