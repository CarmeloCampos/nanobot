import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronLeft, Laptop, Loader2, MoreHorizontal, Plus, Server, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsGroup, SettingsRow, SettingsSectionTitle } from "@/components/settings/shared/SettingsControls";
import { SettingsAdvancedOptions } from "@/components/settings/shared/SettingsFeature";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useClient } from "@/providers/ClientProvider";
import { remoteAction, type RemoteProfile } from "@/lib/remote-instances";
import { cn } from "@/lib/utils";
import { useRemoteConnections } from "./RemoteInstances";
import { SSHHostPicker } from "./SSHHostPicker";

const emptyProfile = (): Omit<RemoteProfile, "id" | "connected"> => ({
  name: "", host: "", port: null, ssh_config: "", identity_file: "",
  config_path: "~/.nanobot/config.json", runtime_user: "",
});

/** A shell destination, not a dialog. Only verification and removal need confirmation. */
export function RemoteConnectionsPage({ mainNavigationExpanded = false, hostChromeInset = false, onBackToChat }: {
  mainNavigationExpanded?: boolean;
  hostChromeInset?: boolean;
  onBackToChat: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useClient();
  const connections = useRemoteConnections();
  const [form, setForm] = useState(emptyProfile);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<RemoteProfile | null>(null);
  const [disconnecting, setDisconnecting] = useState<RemoteProfile | null>(null);
  const [fingerprint, setFingerprint] = useState<{ id: string; fingerprint: string; challenge: string } | null>(null);
  const mounted = useRef(true);
  const refresh = connections?.refresh;

  useEffect(() => {
    mounted.current = true;
    // Keep cached rows visible while refreshing in the background.
    void refresh?.().catch(() => {});
    return () => { mounted.current = false; };
  }, [refresh]);

  if (!connections) return null;
  const { directory, directoryError, connect: connectHost, disconnect: disconnectHost } = connections;
  const showForm = editorOpen;
  const pageError = error || (directoryError ? t("remote.errors.directory_unavailable") : "");
  const showError = (reason: unknown) => {
    if (!mounted.current) return;
    const code = reason instanceof Error ? reason.message : "unknown";
    setError(t(`remote.errors.${code}`, { defaultValue: t("remote.errors.unknown") }));
  };

  const connect = async (id: string) => {
    setBusy(id); setError("");
    try {
      await connectHost(id, () => mounted.current);
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof Error && reason.message === "host_key_unknown") {
        try {
          const result = await remoteAction<{ fingerprint: string; challenge: string }>(client, "fingerprint", { id });
          if (mounted.current) setFingerprint({ id, ...result });
        } catch (scanError) { showError(scanError); }
      } else { showError(reason); }
    } finally {
      if (mounted.current) setBusy("");
    }
  };

  const trustHost = async () => {
    if (!fingerprint) return;
    setBusy("trust"); setError("");
    try {
      await remoteAction(client, "trust", { id: fingerprint.id, challenge: fingerprint.challenge });
      if (!mounted.current) return;
      const id = fingerprint.id;
      setFingerprint(null);
      await connect(id);
    } catch (reason) { showError(reason); }
    finally { if (mounted.current) setBusy(""); }
  };

  const save = async () => {
    setEditorOpen(true); setBusy("save"); setError("");
    try {
      const result = await remoteAction<{ id: string }>(client, "save", {
        id: editingId, profile: { ...form, name: form.name.trim() || form.host.trim() },
      });
      if (!mounted.current) return;
      setEditingId(result.id);
      await refresh?.();
      if (mounted.current) await connect(result.id);
    } catch (reason) { showError(reason); }
    finally { if (mounted.current) setBusy(""); }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy("remove"); setError("");
    try {
      await disconnectHost(removing.id);
      await remoteAction(client, "remove", { id: removing.id });
      if (mounted.current) setRemoving(null);
      await refresh?.();
    } catch (reason) { showError(reason); }
    finally { if (mounted.current) setBusy(""); }
  };

  const disconnect = async (id: string) => {
    setBusy(id); setError("");
    try { await disconnectHost(id); if (mounted.current) setDisconnecting(null); }
    catch (reason) { showError(reason); }
    finally { if (mounted.current) setBusy(""); }
  };

  const closeEditor = () => {
    setEditorOpen(false); setEditingId(""); setForm(emptyProfile()); setError("");
  };

  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-settings-canvas">
    <div className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div data-settings-section="remote" data-main-navigation-expanded={mainNavigationExpanded}
        className={cn("settings-grid settings-feature-page mx-auto w-full animate-in fade-in-0 slide-in-from-bottom-1 py-6 duration-200 ease-out motion-reduce:animate-none sm:py-8 lg:py-12",
          hostChromeInset && "pt-[4.25rem] sm:pt-[4.25rem] lg:pt-[4.75rem]")}>
        <div className="settings-feature-header mb-7">
          <Button variant="ghost" size="sm" className="touch-target mb-4 gap-1 lg:hidden" onClick={onBackToChat}>
            <ChevronLeft className="h-4 w-4" />{t("settings.backToChat")}
          </Button>
          <h1 className="text-[24px] font-normal leading-tight tracking-normal text-foreground sm:text-[28px]">{t("remote.title")}</h1>
        </div>
        <div className="settings-stack">
          <p className="settings-list-inset text-[13px] leading-6 text-muted-foreground">{t(showForm ? "remote.addDescription" : "remote.description")}</p>
          {directory?.available && <>
            <SettingsGroup>
              <div className="settings-list-row flex items-center gap-3 py-3">
                <Laptop className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{t("remote.local")}</span>
                  {directory.machine_name && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{directory.machine_name}</span>}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5" />{t("remote.current")}</span>
              </div>
            </SettingsGroup>
            {showForm ? <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="settings-stack">
              <div className="settings-section-heading">
                <SettingsSectionTitle>{t(editingId ? "remote.edit" : "remote.addTitle")}</SettingsSectionTitle>
                <Button type="button" variant="ghost" size="sm" className="gap-1.5" disabled={!!busy} onClick={closeEditor}>
                  <ArrowLeft className="h-3.5 w-3.5" />{t("remote.back")}
                </Button>
              </div>
              <SettingsGroup>
                <RemoteField label={t("remote.host")} value={form.host} placeholder="ubuntu@192.0.2.10" required disabled={!!busy}
                  onChange={(host) => setForm({ ...form, host })} />
                <RemoteField label={t("remote.name")} value={form.name} placeholder={t("remote.namePlaceholder")} disabled={!!busy}
                  onChange={(name) => setForm({ ...form, name })} />
              </SettingsGroup>
              <SettingsAdvancedOptions>
                <SettingsGroup>
                  <RemoteField label={t("remote.sshPort")} value={form.port == null ? "" : String(form.port)} placeholder={t("remote.portPlaceholder")} type="number" min={1} max={65535} disabled={!!busy}
                    onChange={(port) => setForm({ ...form, port: port === "" ? null : Number(port) })} />
                  {(["ssh_config", "identity_file", "config_path", "runtime_user"] as const).map((key) =>
                    <RemoteField key={key} label={t(`remote.${key}`)} value={form[key]} disabled={!!busy}
                      onChange={(value) => setForm({ ...form, [key]: value })} />)}
                </SettingsGroup>
              </SettingsAdvancedOptions>
              <div className="settings-list-inset flex flex-wrap items-start justify-between gap-4">
                <p className="flex max-w-sm flex-1 items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t("remote.keyHint")}</p>
                <Button type="submit" disabled={!!busy || !form.host.trim()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t(busy ? "remote.connecting" : "remote.saveConnect")}</Button>
              </div>
            </form> : null}
            <div hidden={showForm} className={cn("settings-stack", showForm && "hidden")}>
              {directory.profiles.length > 0 && <SettingsGroup>
                {directory.profiles.map((profile) => <div key={profile.id} className="settings-list-row settings-hover flex items-center gap-2 transition-colors">
                  <button type="button" className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 rounded-xl py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={!!busy} onClick={() => { void connect(profile.id); }}>
                    {busy === profile.id ? <Loader2 className="h-[18px] w-[18px] shrink-0 animate-spin text-muted-foreground" /> : <Server className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{profile.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{profile.host}</span></span>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={!!busy} aria-label={t("remote.manage", { name: profile.name })}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {(profile.connected || connections.openHostIds.includes(profile.id)) && <DropdownMenuItem onSelect={() => setDisconnecting(profile)}>{t("remote.disconnect")}</DropdownMenuItem>}
                      <DropdownMenuItem disabled={profile.connected || connections.openHostIds.includes(profile.id)} onSelect={() => {
                        const { name, host, port, ssh_config, identity_file, config_path, runtime_user } = profile;
                        setEditingId(profile.id); setForm({ name, host, port, ssh_config, identity_file, config_path, runtime_user }); setEditorOpen(true); setError("");
                      }}>{t("remote.edit")}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setRemoving(profile)}>{t("remote.forget")}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>)}
              </SettingsGroup>}
              <SSHHostPicker disabled={!!busy} onSelect={({ host, ssh_config }) => {
                setEditingId(""); setForm({ ...emptyProfile(), name: host, host, ssh_config }); setEditorOpen(true); setError("");
              }} />
              <div className="settings-list-inset"><Button variant="ghost" className="gap-2" disabled={!!busy} onClick={() => { setEditingId(""); setForm(emptyProfile()); setEditorOpen(true); setError(""); }}>
                <Plus className="h-4 w-4" />{t("remote.add")}
              </Button></div>
            </div>
          </>}
          {!directory && !directoryError && <div role="status" className="settings-list-inset flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("remote.loading")}</div>}
          {directory && !directory.available && <p className="settings-list-inset text-sm text-muted-foreground">{t("remote.unavailable")}</p>}
          {pageError && !fingerprint && <div className="settings-list-inset space-y-2">
            <p role="alert" className="text-[13px] leading-5 text-destructive">{pageError}</p>
            {directoryError && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => {
              setBusy("refresh"); setError(""); void refresh?.().catch(showError).finally(() => { if (mounted.current) setBusy(""); });
            }}>{t("remote.retry")}</Button>}
          </div>}
        </div>
      </div>
    </div>
    <Dialog open={!!disconnecting} onOpenChange={(value) => { if (!value && !busy) setDisconnecting(null); }}>
      <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>{t("remote.disconnectTitle", { name: disconnecting?.name })}</DialogTitle><DialogDescription>{t("remote.disconnectDescription")}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={!!busy} onClick={() => setDisconnecting(null)}>{t("common.cancel")}</Button><Button variant="destructive" disabled={!!busy} onClick={() => { if (disconnecting) void disconnect(disconnecting.id); }}>{t("remote.disconnect")}</Button></div>
      </DialogContent>
    </Dialog>
    <Dialog open={!!removing} onOpenChange={(value) => { if (!value && !busy) setRemoving(null); }}>
      <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>{t("remote.forgetTitle", { name: removing?.name })}</DialogTitle><DialogDescription>{t("remote.forgetDescription")}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={!!busy} onClick={() => setRemoving(null)}>{t("common.cancel")}</Button><Button variant="destructive" disabled={!!busy} onClick={() => { void remove(); }}>{t("remote.forget")}</Button></div>
      </DialogContent>
    </Dialog>
    <Dialog open={!!fingerprint} onOpenChange={(value) => { if (!value && !busy) setFingerprint(null); }}>
      <DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t("remote.verifyTitle")}</DialogTitle><DialogDescription>{t("remote.verifyDescription")}</DialogDescription></DialogHeader>
        <code className="break-all rounded-xl bg-muted p-3 text-xs">{fingerprint?.fingerprint}</code>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("remote.verifyHint")}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={!!busy} onClick={() => setFingerprint(null)}>{t("common.cancel")}</Button><Button disabled={!!busy} onClick={() => { void trustHost(); }}>{t("remote.verifyConnect")}</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}

function RemoteField({ label, onChange, ...props }: {
  label: string; value: string; onChange: (value: string) => void;
  placeholder?: string; required?: boolean; disabled?: boolean; type?: string; min?: number; max?: number;
}) {
  const id = useId();
  return <SettingsRow title={<label htmlFor={id}>{label}</label>}>
    <Input id={id} {...props} onChange={(event) => onChange(event.target.value)} autoComplete="off" spellCheck={false} />
  </SettingsRow>;
}
