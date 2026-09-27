import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, FileText, Loader2, RefreshCw, Search, Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsGroup, SettingsSectionTitle } from "@/components/settings/shared/SettingsControls";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { useClient } from "@/providers/ClientProvider";
import { remoteAction, type SSHDiscovery } from "@/lib/remote-instances";

export function SSHHostPicker({ disabled, onSelect }: {
  disabled: boolean;
  onSelect: (host: SSHDiscovery["hosts"][number]) => void;
}) {
  const { t } = useTranslation();
  const { client } = useClient();
  const [result, setResult] = useState<SSHDiscovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configFile, setConfigFile] = useState("");
  const [loadedFile, setLoadedFile] = useState("");
  const [query, setQuery] = useState("");
  const requestId = useRef(0);
  const mounted = useRef(true);
  const load = useCallback(async (file: string) => {
    const id = ++requestId.current;
    setBusy(true); setError("");
    try {
      const next = await remoteAction<SSHDiscovery>(client, "discover", { ssh_config: file.trim() });
      if (!next || !Array.isArray(next.hosts) || !Array.isArray(next.files)
        || typeof next.incomplete !== "boolean" || next.hosts.some((host) => !host
          || typeof host.host !== "string" || typeof host.source !== "string" || typeof host.ssh_config !== "string")) {
        throw new Error("discovery_failed");
      }
      if (mounted.current && id === requestId.current) {
        setResult(next); setLoadedFile(file.trim()); setQuery("");
      }
    } catch (reason) {
      if (mounted.current && id === requestId.current) {
        const code = reason instanceof Error ? reason.message : "unknown";
        setError(t(`remote.errors.${code}`, { defaultValue: t("remote.discoveryError") }));
      }
    } finally {
      if (mounted.current && id === requestId.current) setBusy(false);
    }
  }, [client, t]);

  useEffect(() => {
    mounted.current = true;
    let started = false;
    const unsubscribe = client.onStatus((status) => {
      if (status === "open" && !started) { started = true; void load(""); }
    });
    return () => { mounted.current = false; requestId.current += 1; unsubscribe(); };
  }, [client, load]);

  const hosts = (result?.hosts ?? []).filter(({ host }) => host.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="settings-stack" aria-label={t("remote.sshHosts")}>
    <div className="settings-section-heading">
      <SettingsSectionTitle>{t("remote.sshHosts")}</SettingsSectionTitle>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("remote.refreshHosts")} disabled={busy || disabled} onClick={() => { void load(loadedFile); }}>
        <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
      </Button>
    </div>
    <p className="settings-list-inset text-xs leading-5 text-muted-foreground">{t("remote.sshHostsHint")}</p>
    {!!result?.hosts.length && <div className="settings-list-inset relative">
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" aria-label={t("remote.searchHosts")} placeholder={t("remote.searchHosts")} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
    </div>}
    {hosts.length > 0 && <SettingsGroup>
      <div className="max-h-64 overflow-y-auto">
        {hosts.map((host) => <button key={host.host} type="button" disabled={disabled || busy}
          aria-label={t("remote.useHost", { host: host.host })}
          className="settings-list-row settings-hover flex w-full items-center gap-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
          onClick={() => onSelect(host)}>
          <Server className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{host.host}</span>
            <span title={host.source} className="mt-0.5 block truncate text-xs text-muted-foreground">{host.source}</span></span>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>)}
      </div>
    </SettingsGroup>}
    {!result && busy && <p role="status" className="settings-list-inset flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("remote.loadingHosts")}</p>}
    {result && !hosts.length && <p className="settings-list-inset text-[13px] leading-5 text-muted-foreground">{t(query ? "remote.noMatchingHosts" : "remote.noHosts")}</p>}
    {result?.incomplete && <p className="settings-list-inset text-xs text-muted-foreground">{t("remote.partialHosts")}</p>}
    <Disclosure summaryClassName="settings-list-inset flex min-h-10 items-center gap-2 rounded-xl text-xs text-muted-foreground settings-hover"
      summary={<><FileText className="h-3.5 w-3.5" />{t("remote.otherConfig")}</>}>
      <form className="settings-list-inset flex flex-wrap items-center gap-2 py-3" onSubmit={(event) => { event.preventDefault(); void load(configFile); }}>
        <Input className="min-w-40 flex-1" aria-label={t("remote.configToRead")} placeholder="~/.ssh/config" value={configFile} disabled={busy || disabled} onChange={(event) => setConfigFile(event.target.value)} />
        <Button type="submit" variant="outline" disabled={busy || disabled}>{t("remote.readConfig")}</Button>
      </form>
    </Disclosure>
    {error && <p role="alert" className="settings-list-inset text-[13px] leading-5 text-destructive">{error}</p>}
  </section>;
}
