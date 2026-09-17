/**
 * Two-factor enrollment for GoStork staff.
 *
 * Lives on /admin/security because every role that is required to enrol
 * (GOSTORK_ADMIN, GOSTORK_CONCIERGE, GOSTORK_DEVELOPER) already reaches that
 * page. Inline steps, never a dialog - the app is built with native mobile in
 * mind, where modals do not translate.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck, ShieldAlert, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  required: boolean;
  enforced: boolean;
  enforceAt: string | null;
  recoveryCodesRemaining: number;
}

export function TwoFactorCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [setupData, setSetupData] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const { data: status, isLoading } = useQuery<TwoFactorStatus>({
    queryKey: ["/api/auth/2fa/status"],
    queryFn: async () => (await apiRequest("GET", "/api/auth/2fa/status")).json(),
  });

  const startSetup = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/auth/2fa/setup")).json(),
    onSuccess: (d: any) => setSetupData({ qrDataUrl: d.qrDataUrl, secret: d.secret }),
    onError: (e: any) => toast({ title: "Could not start setup", description: e.message, variant: "destructive" }),
  });

  const enable = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/auth/2fa/enable", { code: code.trim() })).json(),
    onSuccess: (d: any) => {
      setRecoveryCodes(d.recoveryCodes || []);
      setSetupData(null);
      setCode("");
      qc.invalidateQueries({ queryKey: ["/api/auth/2fa/status"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/security/two-factor"] });
      toast({ title: "Two-factor authentication is on" });
    },
    onError: (e: any) => toast({ title: "That code did not work", description: e.message, variant: "destructive" }),
  });

  const disable = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/auth/2fa/disable", { code: code.trim() })).json(),
    onSuccess: () => {
      setCode("");
      setDisabling(false);
      qc.invalidateQueries({ queryKey: ["/api/auth/2fa/status"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/security/two-factor"] });
      toast({ title: "Two-factor authentication is off" });
    },
    onError: (e: any) => toast({ title: "Could not turn it off", description: e.message, variant: "destructive" }),
  });

  const copyCodes = () => {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (isLoading) {
    return (
      <div className="rounded-[var(--radius)] border bg-card p-4">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius)] border bg-card p-4 space-y-3" data-testid="card-two-factor">
      <div className="flex items-center gap-2">
        <h2 className="t-section-title font-heading mr-auto">Your two-factor authentication</h2>
        {status?.enabled ? (
          <span
            className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full"
            style={{ background: "hsl(var(--brand-success) / 0.15)", color: "hsl(var(--brand-success-text))" }}
            data-testid="badge-two-factor-on"
          >
            <ShieldCheck className="w-3 h-3" /> On
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full"
            style={{ background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning-text))" }}
            data-testid="badge-two-factor-off"
          >
            <ShieldAlert className="w-3 h-3" /> Off
          </span>
        )}
      </div>

      {recoveryCodes && (
        <div className="rounded-[var(--radius)] bg-secondary p-3 space-y-2" data-testid="panel-recovery-codes">
          <p className="t-helper">
            Save these recovery codes somewhere safe. Each one works once, and this is the only
            time they are shown. They are how you get in if you lose your phone.
          </p>
          <div className="grid grid-cols-2 gap-1 font-ui text-sm">
            {recoveryCodes.map((rc) => (
              <span key={rc}>{rc}</span>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={copyCodes} data-testid="button-copy-recovery">
              {copied ? <Check className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
              {copied ? "Copied" : "Copy all"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRecoveryCodes(null)} data-testid="button-dismiss-recovery">
              I have saved them
            </Button>
          </div>
        </div>
      )}

      {!status?.enabled && !setupData && !recoveryCodes && (
        <>
          <p className="t-helper">
            {status?.required
              ? "Your account can read every family's record and move money, so it needs a second factor. GoStork 1.0 lost its payment account to an attacker who defeated SMS codes, which is why this uses an authenticator app instead."
              : "Add an authenticator app as a second step when you sign in."}
            {/* A date that has already passed is not a deadline: "Required
                from 9/15" was still on screen on 9/17. */}
            {status?.enforceAt && !status?.enforced && new Date(status.enforceAt).getTime() > Date.now()
              ? ` Required from ${new Date(status.enforceAt).toLocaleDateString()}.`
              : ""}
          </p>
          <Button onClick={() => startSetup.mutate()} disabled={startSetup.isPending} data-testid="button-start-2fa">
            {startSetup.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Set up two-factor authentication
          </Button>
        </>
      )}

      {setupData && (
        <div className="space-y-3" data-testid="panel-2fa-setup">
          <p className="t-helper">
            Scan this with Google Authenticator, 1Password or any authenticator app, then enter the
            6-digit code it shows.
          </p>
          <img src={setupData.qrDataUrl} alt="Two-factor QR code" className="rounded-[var(--radius)] border" width={200} height={200} />
          <p className="t-helper">
            Cannot scan? Enter this key by hand: <span className="font-ui select-all">{setupData.secret}</span>
          </p>
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="enableCode">Code from your app</Label>
            <Input
              id="enableCode"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="tracking-[0.3em] text-center font-ui"
              data-testid="input-enable-code"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={() => enable.mutate()} disabled={enable.isPending || !code.trim()} data-testid="button-confirm-2fa">
              {enable.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Turn it on
            </Button>
            <Button variant="ghost" onClick={() => { setSetupData(null); setCode(""); }} data-testid="button-cancel-2fa">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {status?.enabled && !recoveryCodes && (
        <div className="space-y-2">
          <p className="t-helper">
            On since {status.enabledAt ? new Date(status.enabledAt).toLocaleDateString() : "recently"}.
            {" "}{status.recoveryCodesRemaining} recovery {status.recoveryCodesRemaining === 1 ? "code" : "codes"} left.
          </p>
          {status.enforced ? (
            <p className="t-helper">Required for GoStork staff accounts, so it cannot be turned off.</p>
          ) : disabling ? (
            <div className="space-y-2 max-w-xs">
              <Label htmlFor="disableCode">Enter a current code to confirm</Label>
              <Input
                id="disableCode"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="tracking-[0.3em] text-center font-ui"
                data-testid="input-disable-code"
              />
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" onClick={() => disable.mutate()} disabled={disable.isPending || !code.trim()} data-testid="button-confirm-disable-2fa">
                  Turn off
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setDisabling(false); setCode(""); }}>
                  Keep it on
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setDisabling(true)} data-testid="button-disable-2fa">
              Turn off two-factor authentication
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
