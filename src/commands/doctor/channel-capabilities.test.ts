import { describe, expect, it } from "vitest";
import {
  getDoctorChannelCapabilities,
  mergeDoctorChannelCapabilities,
} from "./channel-capabilities.js";

describe("doctor channel capabilities", () => {
  it("returns nested route semantics from googlechat plugin metadata", () => {
    expect(getDoctorChannelCapabilities("googlechat")).toEqual({
      dmAllowFromMode: "nestedOnly",
      groupModel: "route",
      supportsGroupChats: true,
      groupAllowFromFallbackToAllowFrom: false,
      groupOwnerAllowFromFallbackToAllowFrom: true,
      commandAllowFromFallbackToAllowFrom: true,
      elevatedAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    });
  });

  it("returns capability overrides from matrix plugin metadata", () => {
    expect(getDoctorChannelCapabilities("matrix")).toEqual({
      dmAllowFromMode: "nestedOnly",
      groupModel: "sender",
      supportsGroupChats: true,
      groupAllowFromFallbackToAllowFrom: false,
      groupOwnerAllowFromFallbackToAllowFrom: true,
      commandAllowFromFallbackToAllowFrom: true,
      elevatedAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("returns command-owner fallback overrides from line plugin metadata", () => {
    expect(getDoctorChannelCapabilities("line")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "sender",
      supportsGroupChats: true,
      groupAllowFromFallbackToAllowFrom: true,
      groupOwnerAllowFromFallbackToAllowFrom: true,
      commandAllowFromFallbackToAllowFrom: true,
      elevatedAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("returns hybrid group semantics for zalouser", () => {
    expect(getDoctorChannelCapabilities("zalouser")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      supportsGroupChats: true,
      groupAllowFromFallbackToAllowFrom: false,
      groupOwnerAllowFromFallbackToAllowFrom: true,
      commandAllowFromFallbackToAllowFrom: true,
      elevatedAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    });
  });

  it("preserves empty sender allowlist warnings for msteams hybrid routing", () => {
    expect(getDoctorChannelCapabilities("msteams")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      supportsGroupChats: true,
      groupAllowFromFallbackToAllowFrom: false,
      groupOwnerAllowFromFallbackToAllowFrom: true,
      commandAllowFromFallbackToAllowFrom: true,
      elevatedAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("falls back conservatively for unknown external channels", () => {
    expect(getDoctorChannelCapabilities("external-demo")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "sender",
      supportsGroupChats: true,
      groupAllowFromFallbackToAllowFrom: true,
      groupOwnerAllowFromFallbackToAllowFrom: true,
      commandAllowFromFallbackToAllowFrom: true,
      elevatedAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("preserves explicitly declared elevated allowFrom fallback support", () => {
    expect(
      mergeDoctorChannelCapabilities({
        elevatedAllowFromFallbackToAllowFrom: true,
      }).elevatedAllowFromFallbackToAllowFrom,
    ).toBe(true);
  });

  it("preserves explicit command fallback disable metadata", () => {
    const capabilities = mergeDoctorChannelCapabilities({
      groupOwnerAllowFromFallbackToAllowFrom: false,
      commandGroupAllowFromFallbackToAllowFrom: false,
    });

    expect(capabilities.groupOwnerAllowFromFallbackToAllowFrom).toBe(false);
    expect(capabilities.groupOwnerAllowFromFallbackToAllowFromExplicit).toBe(true);
    expect(capabilities.commandGroupAllowFromFallbackToAllowFrom).toBe(false);
  });

  it("does not mark defaulted group-owner fallback as explicit metadata", () => {
    expect(
      mergeDoctorChannelCapabilities({}).groupOwnerAllowFromFallbackToAllowFromExplicit,
    ).toBeUndefined();
  });

  it("preserves direct-only chat metadata supplied by the capability resolver", () => {
    expect(
      mergeDoctorChannelCapabilities(undefined, {
        supportsGroupChats: false,
      }).supportsGroupChats,
    ).toBe(false);
  });
});
