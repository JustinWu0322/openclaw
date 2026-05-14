#!/usr/bin/env node

const PACKAGE_NAME = "@openclaw/security-gate";
const VERSION = "0.0.1";
const PACKAGE_LABEL = `${PACKAGE_NAME}@${VERSION}`;
const BASE_URL = "https://clawhub.ai";
const PACKAGE_PATH = `/plugins/${encodeScopedPackageForClawHubPath(PACKAGE_NAME)}`;
const LINKS = {
  plugin: `${BASE_URL}${PACKAGE_PATH}`,
  clawscan: `${BASE_URL}${PACKAGE_PATH}/security/clawscan`,
  staticAnalysis: `${BASE_URL}${PACKAGE_PATH}/security/static-analysis`,
  virustotal: `${BASE_URL}${PACKAGE_PATH}/security/virustotal`,
};

const args = new Set(process.argv.slice(2));
const scenario = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "suspicious";
const plain = args.has("--plain") || process.env.NO_COLOR === "1" || process.env.TERM === "dumb";
const useHyperlinks = !plain && process.stdout.isTTY && !args.has("--raw-links-only");
const showRawLinks = !args.has("--no-raw-links");
const columns = Math.max(72, Math.min(process.stdout.columns || 88, 104));

function encodeScopedPackageForClawHubPath(name) {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    return `${encodeURIComponent(scope)}/${encodeURIComponent(pkg ?? "")}`;
  }
  return encodeURIComponent(name);
}

function osc8(label, url) {
  if (!useHyperlinks) {
    return label;
  }
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

function color(code, value) {
  if (plain) {
    return value;
  }
  return `\u001b[${code}m${value}\u001b[0m`;
}

function red(value) {
  return color("31;1", value);
}

function yellow(value) {
  return color("33;1", value);
}

function dim(value) {
  return color("2", value);
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function stripAnsi(value) {
  return value
    .replace(/\u001b\]8;;.*?\u0007/g, "")
    .replace(/\u001b\]8;;\u0007/g, "")
    .replace(/\u001b\[[0-9;]*m/g, "");
}

function padRight(value, width) {
  const pad = Math.max(0, width - visibleLength(value));
  return `${value}${" ".repeat(pad)}`;
}

function wrapWords(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (visibleLength(next) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

function box(title, lines) {
  const maxInner = Math.max(54, Math.min(columns - 4, 78));
  const topTitle = ` ${title} `;
  const horizontalWidth = Math.max(maxInner, visibleLength(topTitle) + 2);
  const top = `╭─${topTitle}${"─".repeat(horizontalWidth - visibleLength(topTitle) - 1)}╮`;
  const bottom = `╰${"─".repeat(horizontalWidth + 1)}╯`;
  const body = lines.flatMap((line) => {
    if (line === "") {
      return [`│ ${" ".repeat(horizontalWidth)}│`];
    }
    return wrapWords(line, horizontalWidth - 2).map((wrapped) => {
      return `│ ${padRight(wrapped, horizontalWidth)}│`;
    });
  });
  return [top, ...body, bottom].join("\n");
}

function metadataBlock() {
  const rows = [
    ["Package", PACKAGE_LABEL],
    ["Channel", "community (not official)"],
    ["Type", "plugin"],
    ["Requires", "OpenClaw >=2026.3.26"],
    ["ClawHub", osc8("view plugin", LINKS.plugin)],
  ];
  return rows.map(([label, value]) => `  ${dim(padRight(label, 9))} ${value}`).join("\n");
}

function rawLinksBlock(kind) {
  if (!showRawLinks) {
    return "";
  }
  const pluginOnly = ["", dim("Links:"), `  Plugin           ${LINKS.plugin}`];
  if (kind === "plugin-only") {
    return pluginOnly.join("\n");
  }
  return [
    ...pluginOnly,
    `  Security scan    ${LINKS.clawscan}`,
    `  Static analysis  ${LINKS.staticAnalysis}`,
    `  VirusTotal       ${LINKS.virustotal}`,
  ].join("\n");
}

function malicious() {
  const title = red("⚠  BLOCKED — ClawHub flagged this release as malicious");
  const scan = osc8(red("malicious"), LINKS.clawscan);
  const staticAnalysis = osc8(red("malicious behavior detected"), LINKS.staticAnalysis);
  const lines = [
    `• Security scan:     ${scan}`,
    `• Scanner:           ${osc8("malicious behavior detected", LINKS.clawscan)}`,
    `• Static analysis:   ${staticAnalysis}`,
    "",
    "OpenClaw will not install this release from ClawHub.",
    "Choose a different version, review the ClawHub security details, or contact the package maintainer if you believe this is wrong.",
  ];
  return [
    `Resolving clawhub:${PACKAGE_LABEL}…`,
    "",
    metadataBlock(),
    "",
    box(title, lines),
    rawLinksBlock("security"),
  ].join("\n");
}

function suspicious() {
  const title = yellow("⚠  REVIEW REQUIRED — ClawHub flagged this release for security review");
  const lines = [
    `• Security scan:     ${osc8(yellow("suspicious"), LINKS.clawscan)}`,
    `• Finding:           ${osc8("suspicious payload strings", LINKS.staticAnalysis)}`,
    "",
    "Installing runs code on this machine and can access OpenClaw data, credentials, tools, and connected services.",
    "Review the ClawHub security details before installing.",
  ];
  return [
    `Resolving clawhub:${PACKAGE_LABEL}…`,
    "",
    metadataBlock(),
    "",
    box(title, lines),
    rawLinksBlock("security"),
    "",
    "To install anyway, type the package name:",
    `  ${PACKAGE_NAME}`,
    "> _",
  ].join("\n");
}

function community() {
  return [
    `Resolving clawhub:${PACKAGE_LABEL}…`,
    "",
    metadataBlock(),
    "",
    "Community packages are third-party code. Review the publisher, source, and permissions before installing.",
    rawLinksBlock("plugin-only"),
    "",
    `Install ${PACKAGE_LABEL}? [y/N] _`,
  ].join("\n");
}

switch (scenario) {
  case "malicious":
  case "blocked":
    console.log(malicious());
    break;
  case "community":
    console.log(community());
    break;
  case "suspicious":
  case "review":
    console.log(suspicious());
    break;
  default:
    console.error(
      "Usage: node scripts/dev/clawhub-warning-demo.mjs [suspicious|malicious|community] [--plain|--raw-links-only]",
    );
    process.exitCode = 2;
}
