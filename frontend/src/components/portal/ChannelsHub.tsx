"use client";

import { useState } from "react";
import { ChannelsMatrix } from "@/components/portal/ChannelsMatrix";
import { CronReportsFeed } from "@/components/portal/CronReportsFeed";
import { SkillsMemoryVault } from "@/components/portal/SkillsMemoryVault";
import { Segmented } from "@/components/ui/Segmented";
import { useI18n } from "@/lib/i18n";
import type { PortalClient } from "@/lib/portal-api";

type View = "channels" | "briefings" | "vault";

/**
 * Channels, scheduled briefings and the memory vault in one tab. Each part mounts the first
 * time it is opened and then stays, so a half-finished WhatsApp pairing or an unsaved memory
 * edit survives a trip to another part.
 */
export function ChannelsHub({ client, onChanged }: { client: PortalClient; onChanged: () => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<View>("channels");
  const [visited, setVisited] = useState<Set<View>>(() => new Set<View>(["channels"]));

  function select(next: View) {
    setView(next);
    setVisited((current) => (current.has(next) ? current : new Set(current).add(next)));
  }

  return (
    <div>
      <Segmented<View>
        label={t("channelsHub.label")}
        value={view}
        onChange={select}
        className="max-w-full flex-wrap rounded-2xl"
        optionClassName="min-h-11 px-3 sm:px-4"
        options={[
          { value: "channels", label: t("channelsHub.channels") },
          { value: "briefings", label: t("channelsHub.briefings") },
          { value: "vault", label: t("channelsHub.vault") },
        ]}
      />
      <div className="mt-4">
        <div hidden={view !== "channels"}>{visited.has("channels") && <ChannelsMatrix client={client} />}</div>
        <div hidden={view !== "briefings"}>{visited.has("briefings") && <CronReportsFeed client={client} />}</div>
        <div hidden={view !== "vault"}>{visited.has("vault") && <SkillsMemoryVault client={client} onChanged={onChanged} />}</div>
      </div>
    </div>
  );
}
