import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Check, ChevronUp, CircleAlert, Laptop, Loader2, Server, Settings2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useClient } from "@/providers/ClientProvider";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/lib/types";
import type { HostAnchor, EmbeddedHost } from "./host-bridge";

export interface HostPicker {
  kind: "shell";
  name: string;
  hostname: string;
  localName: string;
  currentId: string | null;
  profiles: { id: string; name: string; host: string; ready: boolean }[];
  pending: { id: string; name: string } | null;
  error: string;
  offline: boolean;
  select: (id: string | null) => void;
  manage: () => void;
  cancel: () => void;
  clearError: () => void;
  restoreFocus: () => void;
}
interface EmbeddedPicker extends EmbeddedHost {
  kind: "embedded";
  open: (anchor: HostAnchor) => void;
}
export const HostNavigationContext = createContext<HostPicker | EmbeddedPicker | null>(null);

function HostMenuContent({ picker, portalContainer }: { picker: HostPicker; portalContainer?: HTMLElement | null }) {
  const { t } = useTranslation();
  return <DropdownMenuContent side="top" align="end" sideOffset={8} collisionPadding={12}
    portalContainer={portalContainer} className="w-64 max-w-[calc(100vw-1.5rem)]"
    onCloseAutoFocus={(event) => { event.preventDefault(); picker.restoreFocus(); }}>
    <DropdownMenuLabel>{t("remote.switchHost")}</DropdownMenuLabel>
    <DropdownMenuItem onSelect={() => picker.select(null)} className="gap-2.5">
      <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1"><span className="block">{t("remote.local")}</span><span className="block truncate text-xs text-muted-foreground">{picker.localName}</span></span>
      {!picker.currentId && <Check className="h-4 w-4" />}
    </DropdownMenuItem>
    {!!picker.profiles.length && <DropdownMenuSeparator />}
    {picker.profiles.map((profile) => <DropdownMenuItem key={profile.id} onSelect={() => picker.select(profile.id)} className="gap-2.5">
      <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1"><span className="block truncate">{profile.name}</span><span className="block truncate text-xs text-muted-foreground">{profile.host}</span></span>
      {picker.pending?.id === profile.id ? <Loader2 className="h-4 w-4 animate-spin" /> : picker.currentId === profile.id ? <Check className="h-4 w-4" />
        : profile.ready ? <span className="text-[11px] text-muted-foreground">{t("remote.ready")}</span> : null}
    </DropdownMenuItem>)}
    {picker.pending && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={picker.cancel} className="gap-2.5"><X className="h-4 w-4" />{t("remote.cancelSwitch")}</DropdownMenuItem></>}
    {picker.error && <div role="alert" className="px-2.5 py-2 text-xs leading-5 text-destructive">
      {picker.error}<button className="ml-2 underline underline-offset-2" onClick={picker.clearError}>{t("common.close")}</button>
    </div>}
    <DropdownMenuSeparator />
    <DropdownMenuItem className="gap-2.5" onSelect={picker.manage}><Settings2 className="h-4 w-4 text-muted-foreground" />{t("remote.manageConnections")}</DropdownMenuItem>
  </DropdownMenuContent>;
}

/** Shared sidebar control. Remote frames can only open the trusted shell's menu. */
export function HostSwitcher({ collapsed = false, portalContainer }: { collapsed?: boolean; portalContainer?: HTMLElement | null }) {
  const picker = useContext(HostNavigationContext);
  const { client } = useClient();
  const { t } = useTranslation();
  const [status, setStatus] = useState<ConnectionStatus>(client.status);
  useEffect(() => client.onStatus(setStatus), [client]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (!picker) return <ConnectionBadge />;
  const shell = picker.kind === "shell" ? picker : null;
  const remote = picker.kind === "embedded" || !!shell?.currentId;
  const pendingName = picker.kind === "shell" ? picker.pending?.name : picker.pendingName;
  const failed = !!picker.error || !!shell?.offline || status === "error" || status === "closed";
  const waiting = !!pendingName || status === "connecting" || status === "reconnecting";
  const label = pendingName ? t("remote.connecting") : picker.name;
  const detail = pendingName ? t("remote.preparing", { name: pendingName }) : `${picker.name} · ${picker.hostname}`;
  const title = picker.error || `${detail} — ${t(failed ? "remote.offline" : `connection.${status}`)}`;
  const button = <Button ref={buttonRef} variant="ghost" size="sm" aria-label={t("remote.switchHost")} title={title}
    data-host-switcher className={cn("host-no-drag h-8 min-w-0 gap-2 rounded-xl px-2 text-xs font-normal text-sidebar-content/75 hover:bg-sidebar-accent/65 hover:text-sidebar-content",
      collapsed ? "w-8 justify-center px-0" : "max-w-full flex-1 justify-start")}
    onClick={picker.kind === "embedded" ? () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) picker.open({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    } : undefined}>
    <span className="relative flex shrink-0 items-center justify-center">
      {waiting ? <Loader2 className="h-4 w-4 animate-spin" /> : failed ? <CircleAlert className="h-4 w-4 text-destructive" />
        : remote ? <Server className="h-4 w-4" /> : <Laptop className="h-4 w-4" />}
      {!waiting && !failed && <span aria-hidden className={cn("absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-sidebar", status === "open" ? "bg-emerald-500" : "bg-muted-foreground")} />}
    </span>
    {!collapsed && <><span className="truncate">{label}</span><ChevronUp className="ml-auto h-3 w-3 shrink-0 opacity-60" /></>}
    <span className="sr-only" role="status">{detail} · {t(failed ? "remote.offline" : `connection.${status}`)}</span>
  </Button>;
  if (!shell) return button;
  return <DropdownMenu><DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger><HostMenuContent picker={shell} portalContainer={portalContainer} /></DropdownMenu>;
}

/** Parent-owned menu anchored to the active remote sidebar, never inside its DOM. */
export function RemoteHostMenu({ picker, anchor, onClose }: { picker: HostPicker; anchor: HostAnchor | null; onClose: () => void }) {
  return <DropdownMenu open={!!anchor} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DropdownMenuTrigger asChild><button tabIndex={-1} aria-hidden className="pointer-events-none fixed opacity-0" style={anchor ? {
      left: Math.max(0, Math.min(anchor.left, window.innerWidth - 32)), top: Math.max(0, Math.min(anchor.top, window.innerHeight - 32)),
      width: Math.min(anchor.width, window.innerWidth), height: Math.min(anchor.height, 64),
    } : { width: 0, height: 0 }} /></DropdownMenuTrigger>
    <HostMenuContent picker={picker} />
  </DropdownMenu>;
}
