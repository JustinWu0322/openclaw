import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { findBundledPackageChannelMetadata } from "../../plugins/bundled-package-channel-metadata.js";
import type { PluginPackageChannelDoctorCapabilities } from "../../plugins/manifest.js";
import type { AllowFromMode } from "./shared/allow-from-mode.types.js";

export type DoctorGroupModel = "sender" | "route" | "hybrid";

export type DoctorChannelCapabilities = {
  dmAllowFromMode: AllowFromMode;
  groupModel: DoctorGroupModel;
  supportsGroupChats: boolean;
  groupAllowFromFallbackToAllowFrom: boolean;
  legacyDmAllowFromMigrationTarget?: "groupAllowFrom" | "groupSenderAllowFrom";
  groupOwnerAllowFromFallbackToAllowFrom: boolean;
  groupOwnerAllowFromFallbackToAllowFromExplicit?: boolean;
  legacyDmGroupOwnerAllowFromMigrationTarget?: "groupOwnerAllowFrom";
  commandGroupAllowFromFallbackToAllowFrom?: boolean;
  legacyDmCommandGroupAllowFromMigrationTarget?: "commandGroupAllowFrom";
  commandAllowFromFallbackToAllowFrom: boolean;
  legacyDmCommandAllowFromMigrationTarget?: "commands.allowFrom";
  elevatedAllowFromFallbackToAllowFrom: boolean;
  legacyDmElevatedAllowFromMigrationTarget?: "tools.elevated.allowFrom";
  warnOnEmptyGroupSenderAllowlist: boolean;
};

const DEFAULT_DOCTOR_CHANNEL_CAPABILITIES: DoctorChannelCapabilities = {
  dmAllowFromMode: "topOnly",
  groupModel: "sender",
  supportsGroupChats: true,
  groupAllowFromFallbackToAllowFrom: true,
  groupOwnerAllowFromFallbackToAllowFrom: true,
  commandAllowFromFallbackToAllowFrom: true,
  // Elevated fallback is implemented only by a channel runtime hook, so doctor
  // must not warn unless channel metadata explicitly declares it.
  elevatedAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: true,
};

export function mergeDoctorChannelCapabilities(
  capabilities?: PluginPackageChannelDoctorCapabilities,
  options: { supportsGroupChats?: boolean } = {},
): DoctorChannelCapabilities {
  return {
    dmAllowFromMode:
      capabilities?.dmAllowFromMode ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.dmAllowFromMode,
    groupModel: capabilities?.groupModel ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupModel,
    supportsGroupChats:
      options.supportsGroupChats ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.supportsGroupChats,
    groupAllowFromFallbackToAllowFrom:
      capabilities?.groupAllowFromFallbackToAllowFrom ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupAllowFromFallbackToAllowFrom,
    ...(capabilities?.legacyDmAllowFromMigrationTarget
      ? { legacyDmAllowFromMigrationTarget: capabilities.legacyDmAllowFromMigrationTarget }
      : {}),
    groupOwnerAllowFromFallbackToAllowFrom:
      capabilities?.groupOwnerAllowFromFallbackToAllowFrom ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupOwnerAllowFromFallbackToAllowFrom,
    ...(capabilities?.groupOwnerAllowFromFallbackToAllowFrom !== undefined
      ? { groupOwnerAllowFromFallbackToAllowFromExplicit: true }
      : {}),
    ...(capabilities?.legacyDmGroupOwnerAllowFromMigrationTarget
      ? {
          legacyDmGroupOwnerAllowFromMigrationTarget:
            capabilities.legacyDmGroupOwnerAllowFromMigrationTarget,
        }
      : {}),
    ...(capabilities?.commandGroupAllowFromFallbackToAllowFrom !== undefined
      ? {
          commandGroupAllowFromFallbackToAllowFrom:
            capabilities.commandGroupAllowFromFallbackToAllowFrom,
        }
      : {}),
    ...(capabilities?.legacyDmCommandGroupAllowFromMigrationTarget
      ? {
          legacyDmCommandGroupAllowFromMigrationTarget:
            capabilities.legacyDmCommandGroupAllowFromMigrationTarget,
        }
      : {}),
    commandAllowFromFallbackToAllowFrom:
      capabilities?.commandAllowFromFallbackToAllowFrom ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.commandAllowFromFallbackToAllowFrom,
    ...(capabilities?.legacyDmCommandAllowFromMigrationTarget
      ? {
          legacyDmCommandAllowFromMigrationTarget:
            capabilities.legacyDmCommandAllowFromMigrationTarget,
        }
      : {}),
    elevatedAllowFromFallbackToAllowFrom:
      capabilities?.elevatedAllowFromFallbackToAllowFrom ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.elevatedAllowFromFallbackToAllowFrom,
    ...(capabilities?.legacyDmElevatedAllowFromMigrationTarget
      ? {
          legacyDmElevatedAllowFromMigrationTarget:
            capabilities.legacyDmElevatedAllowFromMigrationTarget,
        }
      : {}),
    warnOnEmptyGroupSenderAllowlist:
      capabilities?.warnOnEmptyGroupSenderAllowlist ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.warnOnEmptyGroupSenderAllowlist,
  };
}

function resolveSupportsGroupChats(
  plugin:
    | {
        capabilities?: { chatTypes?: readonly string[] };
      }
    | undefined,
): boolean | undefined {
  const chatTypes = plugin?.capabilities?.chatTypes;
  return Array.isArray(chatTypes) ? chatTypes.some((chatType) => chatType !== "direct") : undefined;
}

function getManifestDoctorCapabilities(
  channelId: string,
): PluginPackageChannelDoctorCapabilities | undefined {
  return findBundledPackageChannelMetadata(channelId)?.doctorCapabilities;
}

export function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities {
  if (!channelName) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }

  const manifestCapabilities = getManifestDoctorCapabilities(channelName);
  if (manifestCapabilities) {
    return mergeDoctorChannelCapabilities(manifestCapabilities);
  }

  const channelId = normalizeAnyChannelId(channelName);
  if (!channelId) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }
  const plugin = getChannelPlugin(channelId) ?? getBundledChannelPlugin(channelId);
  if (plugin?.doctor) {
    return mergeDoctorChannelCapabilities(plugin.doctor, {
      supportsGroupChats: resolveSupportsGroupChats(plugin),
    });
  }
  return mergeDoctorChannelCapabilities(getManifestDoctorCapabilities(channelId));
}
