import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getPhotoSrc } from "@/lib/profile-utils";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, RefreshCw, UserCircle, Users, Video } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import LocationAutocomplete from "@/components/location-autocomplete";

const PROVIDER_ROLES = [
  { value: "PROVIDER_ADMIN", label: "Provider Admin" },
  { value: "SURROGACY_COORDINATOR", label: "Surrogacy Coordinator" },
  { value: "EGG_DONOR_COORDINATOR", label: "Egg Donor Coordinator" },
  { value: "SPERM_DONOR_COORDINATOR", label: "Sperm Donor Coordinator" },
  { value: "IVF_CLINIC_COORDINATOR", label: "IVF Clinic Coordinator" },
  { value: "DOCTOR", label: "Doctor" },
  { value: "BILLING_MANAGER", label: "Billing Manager" },
];

const GOSTORK_ROLES = [
  { value: "GOSTORK_ADMIN", label: "GoStork Admin" },
  { value: "GOSTORK_CONCIERGE", label: "Concierge" },
  { value: "GOSTORK_DEVELOPER", label: "Developer" },
];

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function inferRolesFromTitle(title: string | null): string[] | null {
  if (!title) return null;
  const t = title.toLowerCase();
  const roles: string[] = [];
  if (t.includes("surrogacy") || t.includes("surrogate")) roles.push("SURROGACY_COORDINATOR");
  if (t.includes("egg donor") || t.includes("egg-donor") || t.includes("oocyte")) roles.push("EGG_DONOR_COORDINATOR");
  if (t.includes("sperm donor") || t.includes("sperm-donor")) roles.push("SPERM_DONOR_COORDINATOR");
  if (t.includes("patient") || t.includes("intake") || t.includes("ivf")) roles.push("IVF_CLINIC_COORDINATOR");
  if (t.includes("doctor") || t.includes("physician") || t.includes("md") || t.includes("dr.")) roles.push("DOCTOR");
  if (t.includes("billing") || t.includes("finance") || t.includes("accounting")) roles.push("BILLING_MANAGER");
  if (t.includes("admin") || t.includes("director") || t.includes("founder") || t.includes("ceo") || t.includes("owner") || t.includes("managing")) roles.push("PROVIDER_ADMIN");
  return roles.length > 0 ? roles : null;
}

type ProviderLocationData = { id: string; address: string; city: string; state: string; zip: string };
type TeamMember = { id: string; name: string; title: string | null; photoUrl: string | null };

export default function AdminUserAddPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const providerId = searchParams.get("provider");
  const teamContext = searchParams.get("team");
  const isProviderMode = !!providerId;
  const isGostorkTeamMode = teamContext === "gostork";
  const isParentAccountMode = searchParams.get("parentAccount") === "true";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [parentAccountRole, setParentAccountRole] = useState("INTENDED_PARENT_2");
  const [selectedRoles, setSelectedRoles] = useState<string[]>(isGostorkTeamMode ? ["GOSTORK_ADMIN"] : ["IVF_CLINIC_COORDINATOR"]);
  const [personalLocation, setPersonalLocation] = useState({ address: "", city: "", state: "", zip: "", country: "" });
  const [allLocations, setAllLocations] = useState(true);
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");

  const { data: providerLocations } = useQuery<ProviderLocationData[]>({
    queryKey: ["/api/providers", providerId, "locations"],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}/locations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: isProviderMode,
  });

  const { data: teamMembers } = useQuery<TeamMember[]>({
    queryKey: ["/api/providers", providerId, "members"],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}/members`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isProviderMode,
  });

  const { data: providerData } = useQuery<{ id: string; name: string }>({
    queryKey: ["/api/providers", providerId, "info"],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch provider");
      return res.json();
    },
    enabled: isProviderMode,
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const url = isParentAccountMode
        ? "/api/parent-account/members"
        : isProviderMode
          ? `/api/providers/${providerId}/users`
          : "/api/users/admin";
      const res = await apiRequest("POST", url, data);
      return res.json();
    },
    onSuccess: (newUser: any) => {
      if (isParentAccountMode) {
        queryClient.invalidateQueries({ queryKey: ["/api/parent-account/members"] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/users"] });
        if (providerId) {
          queryClient.invalidateQueries({ queryKey: ["/api/providers", providerId, "users"] });
        }
      }
      toast({ title: isParentAccountMode ? "Member invited" : "User created", description: `${newUser.name || newUser.email} has been added.`, variant: "success" });
      navigate(-1);
    },
    onError: (err: Error) => {
      if (err.message.toLowerCase().includes("email already in use")) {
        setEmailError("This email is already in use. Please use a different email.");
      } else {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    },
  });

  function toggleRole(role: string) {
    if (selectedRoles.includes(role)) {
      if (selectedRoles.length > 1) setSelectedRoles(selectedRoles.filter(r => r !== role));
    } else {
      setSelectedRoles([...selectedRoles, role]);
    }
  }

  function toggleLocationId(locId: string) {
    if (selectedLocationIds.includes(locId)) setSelectedLocationIds(selectedLocationIds.filter(lid => lid !== locId));
    else setSelectedLocationIds([...selectedLocationIds, locId]);
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast({ title: "Missing fields", description: "Email and password are required.", variant: "destructive" });
      return;
    }
    if (password !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (password.length < 6) {
      toast({ title: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }

    const selectedTeamMember = teamMembers?.find(m => m.id === selectedMemberId);

    const locationFields = {
      city: personalLocation.city || undefined,
      state: personalLocation.state || undefined,
      country: personalLocation.country || undefined,
    };

    if (isParentAccountMode) {
      createMutation.mutate({
        name, email, password, parentAccountRole,
        mobileNumber: mobileNumber || undefined,
        ...locationFields,
      });
    } else if (isProviderMode) {
      createMutation.mutate({
        name, email, password, roles: selectedRoles,
        mobileNumber: mobileNumber || undefined,
        photoUrl: selectedTeamMember?.photoUrl || undefined,
        allLocations, locationIds: allLocations ? [] : selectedLocationIds,
        ...locationFields,
      });
    } else if (isGostorkTeamMode) {
      createMutation.mutate({
        name, email, password, roles: selectedRoles,
        mobileNumber: mobileNumber || undefined,
        ...locationFields,
      });
    } else {
      createMutation.mutate({
        name, email, password, roles: ["PARENT"],
        mobileNumber: mobileNumber || undefined,
        ...locationFields,
      });
    }
  };

  return (
    <div className="space-y-6 w-full">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="button-back">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      <div className="mb-8">
        <h1 className="font-display text-2xl font-heading text-primary" data-testid="text-page-title">
          {isParentAccountMode ? "Invite Member" : isProviderMode ? "Add Team Member" : isGostorkTeamMode ? "Add Team Member" : "Add Parent"}
        </h1>
        <p className="text-muted-foreground">
          {isParentAccountMode
            ? "Add a new member to your account."
            : isProviderMode
              ? `Add a new team member for ${providerData?.name || "this provider"}.`
              : isGostorkTeamMode
                ? "Create a new GoStork team member account."
                : "Create a new intended parent account."}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {isProviderMode && teamMembers && teamMembers.length > 0 && (
          <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
            <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> Team Members
            </h2>
            <div className="space-y-2">
              <Label>Pre-fill from an existing team member</Label>
              <Select value={selectedMemberId} onValueChange={(val) => {
                setSelectedMemberId(val);
                if (val === "__new__") {
                  setName("");
                  setSelectedRoles(["IVF_CLINIC_COORDINATOR"]);
                  return;
                }
                const member = teamMembers.find(m => m.id === val);
                if (member) {
                  setName(member.name || "");
                  const inferred = inferRolesFromTitle(member.title);
                  if (inferred) setSelectedRoles(inferred);
                }
              }}>
                <SelectTrigger data-testid="select-team-member">
                  <SelectValue placeholder="Choose a team member or start fresh..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__new__">+ Start with a new user</SelectItem>
                  {teamMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id} data-testid={`select-member-${m.id}`}>
                      <span className="flex items-center gap-2">
                        {m.photoUrl ? (
                          <img src={getPhotoSrc(m.photoUrl)!} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                        ) : (
                          <UserCircle className="w-5 h-5 text-muted-foreground shrink-0" />
                        )}
                        <span>{m.name}{m.title ? ` - ${m.title}` : ""}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
          <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Account Details</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Full Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Jane Smith" data-testid="input-staff-name" />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={e => { setEmail(e.target.value); setEmailError(null); }} placeholder="e.g. jane@example.com" required data-testid="input-staff-email" className={emailError ? "border-destructive" : ""} />
              {emailError && <p className="text-xs text-destructive">{emailError}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Mobile Number</Label>
              <Input value={mobileNumber} onChange={e => setMobileNumber(e.target.value)} placeholder="e.g. +1 (555) 123-4567" data-testid="input-staff-mobile" />
            </div>
            {!isProviderMode && (
              <div className="space-y-2">
                <Label>Location</Label>
                <LocationAutocomplete value={personalLocation} onChange={setPersonalLocation} placeholder="e.g. New York, NY" data-testid="input-staff-location" />
              </div>
            )}
          </div>
        </div>

        <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
          <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Security</h2>

          <div className="space-y-2">
            <Label>Password</Label>
            <div className="flex gap-2">
              <Input type="text" value={password} onChange={e => setPassword(e.target.value)} placeholder="Minimum 6 characters" required minLength={6} data-testid="input-staff-password" className="flex-1" />
              <Button type="button" variant="outline" size="sm" onClick={() => { const p = generateTempPassword(); setPassword(p); setConfirmPassword(p); }} data-testid="button-generate-password" className="whitespace-nowrap">
                <RefreshCw className="w-3 h-3 mr-1" /> Generate
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Confirm Password</Label>
            <Input type="text" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter password" required minLength={6} data-testid="input-staff-confirm-password" />
            {confirmPassword && password !== confirmPassword && (
              <p className="text-xs text-destructive">Passwords do not match</p>
            )}
          </div>
        </div>

        {isParentAccountMode && (
          <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
            <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Role</h2>
            <div className="space-y-2">
              <Label>Account Role</Label>
              <div className="space-y-2 border rounded-[var(--radius)] p-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="parentAccountRole" value="INTENDED_PARENT_2" checked={parentAccountRole === "INTENDED_PARENT_2"} onChange={() => setParentAccountRole("INTENDED_PARENT_2")} data-testid="radio-role-ip2" />
                  <div>
                    <span className="text-sm font-ui">Intended Parent 2</span>
                    <p className="text-xs text-muted-foreground">Full access - can book, view calendar, and receive all notifications.</p>
                  </div>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="parentAccountRole" value="VIEWER" checked={parentAccountRole === "VIEWER"} onChange={() => setParentAccountRole("VIEWER")} data-testid="radio-role-viewer" />
                  <div>
                    <span className="text-sm font-ui">Viewer</span>
                    <p className="text-xs text-muted-foreground">Browse-only - can view marketplace and provider profiles but cannot book.</p>
                  </div>
                </label>
              </div>
            </div>
          </div>
        )}

        {isGostorkTeamMode && (
          <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
            <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Role</h2>
            <div className="space-y-2">
              <Label>Role</Label>
              <div className="space-y-2 border rounded-[var(--radius)] p-3">
                {GOSTORK_ROLES.map(r => (
                  <label key={r.value} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={selectedRoles.includes(r.value)} onCheckedChange={() => toggleRole(r.value)} data-testid={`checkbox-role-${r.value}`} />
                    <span className="text-sm">{r.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {isProviderMode && (
          <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
            <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Roles & Access</h2>

            <div className="space-y-2">
              <Label>Roles</Label>
              <div className="space-y-2 border rounded-[var(--radius)] p-3">
                {PROVIDER_ROLES.map(r => (
                  <label key={r.value} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={selectedRoles.includes(r.value)} onCheckedChange={() => toggleRole(r.value)} data-testid={`checkbox-role-${r.value}`} />
                    <span className="text-sm">{r.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Location Access</Label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={allLocations} onCheckedChange={(checked) => setAllLocations(!!checked)} data-testid="checkbox-all-locations" />
                <span className="text-sm">All Locations</span>
              </label>
              {providerLocations && providerLocations.length > 0 && (
                <div className={`space-y-2 border rounded-[var(--radius)] p-3 mt-2 ${allLocations ? "opacity-50" : ""}`}>
                  {providerLocations.map(loc => (
                    <label key={loc.id} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox checked={allLocations || selectedLocationIds.includes(loc.id)} onCheckedChange={() => { if (!allLocations) toggleLocationId(loc.id); }} disabled={allLocations} data-testid={`checkbox-location-${loc.id}`} />
                      <span className="text-sm">{loc.city}, {loc.state} - {loc.address}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {emailError && (
          <p className="text-sm text-destructive text-right">Please fix the errors above before submitting.</p>
        )}
        <div className="flex items-center justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => navigate(-1)} data-testid="button-cancel">Cancel</Button>
          <Button type="submit" disabled={createMutation.isPending} data-testid="button-create-user">
            {createMutation.isPending ? "Creating..." : isParentAccountMode ? "Invite Member" : (isProviderMode || isGostorkTeamMode ? "Add Team Member" : "Add Parent")}
          </Button>
        </div>
      </form>
    </div>
  );
}
