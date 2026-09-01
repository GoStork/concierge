import { useState, useEffect, useRef } from "react";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { Button } from "@/components/ui/button";
import { SaveBar } from "@/components/ui/save-bar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Loader2, RefreshCw, User, UserCircle, Phone, MapPin, Building2, Video, Calendar, Link2, Copy, Check, AlertTriangle, Camera, Trash2, Eye, EyeOff, Mail, Shield, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import LocationAutocomplete from "@/components/location-autocomplete";
import ImageUploader from "@/components/image-uploader";
import { PhoneInput } from "@/components/ui/phone-input";
import { CopyButton } from "@/components/ui/copy-button";

const PROVIDER_ROLES = [
  { value: "PROVIDER_ADMIN", label: "Provider Admin" },
  { value: "IP_SURROGACY_COORDINATOR", label: "IP Surrogacy Coordinator" },
  { value: "IP_EGG_DONOR_COORDINATOR", label: "IP Egg Donor Coordinator" },
  { value: "IP_SPERM_DONOR_COORDINATOR", label: "IP Sperm Donor Coordinator" },
  { value: "IP_IVF_COORDINATOR", label: "IP IVF Coordinator" },
  { value: "SURROGATE_COORDINATOR", label: "Surrogate Coordinator" },
  { value: "EGG_DONOR_COORDINATOR", label: "Egg Donor Coordinator" },
  { value: "SPERM_DONOR_COORDINATOR", label: "Sperm Donor Coordinator" },
  { value: "SCHEDULER", label: "Scheduler" },
  { value: "DOCTOR", label: "Doctor" },
  { value: "LAWYER", label: "Lawyer" },
  { value: "LEGAL_ASSISTANT", label: "Legal Assistant" },
  { value: "BILLING_MANAGER", label: "Billing Manager" },
];

const GOSTORK_ROLES = [
  { value: "GOSTORK_ADMIN", label: "Admin" },
  { value: "GOSTORK_CONCIERGE", label: "Concierge" },
  { value: "GOSTORK_DEVELOPER", label: "Developer" },
];

const PARENT_ROLE_LABELS: Record<string, string> = {
  INTENDED_PARENT_1: "Intended Parent 1",
  INTENDED_PARENT_2: "Intended Parent 2",
  VIEWER: "Viewer",
};

function roleBadgeLabel(role: string): string {
  return PROVIDER_ROLES.find(r => r.value === role)?.label
    || GOSTORK_ROLES.find(r => r.value === role)?.label
    || PARENT_ROLE_LABELS[role]
    || role;
}

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

type ProviderLocationData = { id: string; address: string; city: string; state: string; zip: string };
type UserData = {
  id: string;
  name: string | null;
  email: string;
  roles: string[];
  photoUrl: string | null;
  mobileNumber: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  identification: string | null;
  providerId: string | null;
  allLocations: boolean;
  createdAt?: string;
  dailyRoomUrl?: string | null;
  calendarLink?: string | null;
  calendarConnections?: { id: string; provider: string; email: string | null; label: string | null; tokenValid?: boolean; connected?: boolean }[];
  scheduleConfig?: { bookingPageSlug: string | null } | null;
  parentAccountRole?: string;
  provider?: { id: string; name: string } | null;
  assignedLocations?: { id: string; locationId: string; location: ProviderLocationData }[];
};

import { getPhotoSrc } from "@/lib/profile-utils";

import { VideoRoomSection, ConnectedCalendarsSection, CalendarLinkSection } from "@/components/user-access-sections";

export default function AdminUserEditPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const editFormRef = useRef<HTMLFormElement | null>(null);

  const currentUserRoles: string[] = (currentUser as any)?.roles || [];
  const isGostorkAdmin = currentUserRoles.includes("GOSTORK_ADMIN");
  const currentUserProviderId = (currentUser as any)?.providerId;
  const providerIdFromUrl = searchParams.get("provider");
  const isParentAccountMode = searchParams.get("parentAccount") === "true";
  // Editing your own record: personal fields defer to My Account (single
  // self-service page); roles/access/locations stay editable here.
  const isSelf = !!id && (currentUser as any)?.id === id;

  const [isDirty, setIsDirty] = useState(false);
  const isInitializingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mobileE164, setMobileE164] = useState("");
  const [mobileDisplay, setMobileDisplay] = useState("");
  const [mobileIsoCode, setMobileIsoCode] = useState("");
  const [identification, setIdentification] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [parentAccountRole, setParentAccountRole] = useState("INTENDED_PARENT_2");
  const [personalLocation, setPersonalLocation] = useState({ address: "", city: "", state: "", zip: "", country: "" });
  const [allLocations, setAllLocations] = useState(true);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [localPhotoUrl, setLocalPhotoUrl] = useState<string | null>(null);

  const contextProviderId = providerIdFromUrl || currentUserProviderId;

  const getUserUrl = isParentAccountMode
    ? `/api/parent-account/members`
    : isGostorkAdmin
      ? `/api/users/${id}`
      : contextProviderId
        ? `/api/providers/${contextProviderId}/users/${id}`
        : `/api/users/${id}`;

  const { data: userData, isLoading } = useQuery<UserData>({
    queryKey: isParentAccountMode ? ["/api/parent-account/members", id] : ["/api/users", id, contextProviderId],
    queryFn: async () => {
      if (isParentAccountMode) {
        const res = await fetch("/api/parent-account/members", { credentials: "include" });
        if (!res.ok) throw new Error("Failed to fetch members");
        const members: UserData[] = await res.json();
        const member = members.find(m => m.id === id);
        if (!member) throw new Error("Member not found");
        return member;
      }
      const res = await fetch(getUserUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch user");
      return res.json();
    },
    enabled: !!id,
  });

  const isGostorkTeamContext = searchParams.get("team") === "gostork";
  const hasGostorkRoles = (userData?.roles || []).some((r: string) => ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"].includes(r));
  const isGostorkTeamUser = !isParentAccountMode && (isGostorkTeamContext || hasGostorkRoles);
  const isProviderUser = !isParentAccountMode && !!(userData?.providerId) && !isGostorkTeamUser;
  const isParent = isParentAccountMode || (userData?.roles || []).includes("PARENT");

  const { data: providerLocations } = useQuery<ProviderLocationData[]>({
    queryKey: ["/api/providers", userData?.providerId, "locations"],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${userData!.providerId}/locations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: !!userData?.providerId && isProviderUser,
  });

  useEffect(() => {
    if (userData) {
      isInitializingRef.current = true;
      setName(userData.name || "");
      setEmail(userData.email);
      const parsedPhone = userData.mobileNumber ? parsePhoneNumberFromString(userData.mobileNumber) : null;
      if (parsedPhone) {
        setMobileE164(parsedPhone.number);
        setMobileDisplay((userData as any).mobileNumberDisplay ?? parsedPhone.formatInternational());
        setMobileIsoCode(parsedPhone.country ?? "");
      } else {
        setMobileE164("");
        setMobileDisplay("");
        setMobileIsoCode("");
      }
      setRoles(userData.roles || []);
      setIdentification(userData.identification || "");
      setPersonalLocation({
        address: "",
        city: userData.city || "",
        state: userData.state || "",
        zip: "",
        country: userData.country || "",
      });
      setAllLocations(userData.allLocations);
      setLocationIds(userData.assignedLocations?.map(al => al.locationId) || []);
      setLocalPhotoUrl(userData.photoUrl);
      if (isParentAccountMode && userData.parentAccountRole) {
        setParentAccountRole(userData.parentAccountRole);
      }
      setEditing(true);
    }
  }, [userData]);

  useEffect(() => {
    if (!editing) { setIsDirty(false); return; }
    if (isInitializingRef.current) { isInitializingRef.current = false; setIsDirty(false); return; }
    setIsDirty(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, name, email, password, confirmPassword, mobileE164, identification, roles, parentAccountRole, personalLocation, allLocations, locationIds, localPhotoUrl]);

  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      if (isParentAccountMode) {
        const { parentAccountRole: newRole, ...memberData } = data;
        const hasDetailChanges = Object.keys(memberData).length > 0;
        let res: Response | undefined;
        if (hasDetailChanges) {
          res = await apiRequest("PATCH", `/api/parent-account/members/${id}`, memberData);
        }
        if (newRole && newRole !== userData?.parentAccountRole) {
          res = await apiRequest("PATCH", `/api/parent-account/members/${id}/role`, { parentAccountRole: newRole });
        }
        return res ? res.json() : {};
      }
      const putUrl = isGostorkAdmin
        ? `/api/users/${id}`
        : userData?.providerId
          ? `/api/providers/${userData.providerId}/users/${id}`
          : `/api/users/${id}`;
      const res = await apiRequest("PUT", putUrl, data);
      return res.json();
    },
    onSuccess: () => {
      if (isParentAccountMode) {
        queryClient.invalidateQueries({ queryKey: ["/api/parent-account/members"] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/users"] });
        queryClient.invalidateQueries({ queryKey: ["/api/gostork/users"] });
        if (userData?.providerId) {
          queryClient.invalidateQueries({ queryKey: ["/api/providers", userData.providerId, "users"] });
        }
      }
      if (id === currentUser?.id) {
        queryClient.invalidateQueries({ queryKey: [api.auth.me.path] });
      }
      toast({ title: isParentAccountMode ? "Member updated" : "User updated", variant: "success" });
      setIsDirty(false);
      navigate(-1);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function toggleRole(role: string) {
    if (roles.includes(role)) {
      if (roles.length > 1) setRoles(roles.filter(r => r !== role));
    } else {
      setRoles([...roles, role]);
    }
  }

  function toggleLocationId(locId: string) {
    if (locationIds.includes(locId)) setLocationIds(locationIds.filter(lid => lid !== locId));
    else setLocationIds([...locationIds, locId]);
  }


  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    if (password && password !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (password && password.length < 6) {
      toast({ title: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }

    if (isParentAccountMode) {
      const data: any = {
        name, email,
        mobileNumber: mobileE164 || null,
        mobileNumberDisplay: mobileDisplay || null,
        city: personalLocation.city || null,
        state: personalLocation.state || null,
        country: personalLocation.country || null,
        identification: identification || null,
        photoUrl: localPhotoUrl,
      };
      if (password) data.password = password;
      if (parentAccountRole !== userData?.parentAccountRole) {
        data.parentAccountRole = parentAccountRole;
      }
      updateMutation.mutate(data);
      return;
    }

    const data: any = {
      name, email,
      mobileNumber: mobileE164 || null,
      mobileNumberDisplay: mobileDisplay || null,
      photoUrl: localPhotoUrl,
    };
    if (isProviderUser) {
      data.roles = roles;
      data.allLocations = allLocations;
      data.locationIds = allLocations ? [] : locationIds;
    } else if (isGostorkTeamUser) {
      data.roles = roles;
      data.city = personalLocation.city || null;
      data.state = personalLocation.state || null;
      data.country = personalLocation.country || null;
    } else {
      data.roles = userData?.roles || ["PARENT"];
      data.city = personalLocation.city || null;
      data.state = personalLocation.state || null;
      data.country = personalLocation.country || null;
      data.identification = identification || null;
    }
    if (password) data.password = password;
    updateMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!userData) {
    return (
      <div className="space-y-6 w-full">
        <button onClick={() => navigate(-1)} className="t-helper flex items-center gap-1.5 hover:text-foreground transition-colors mb-6" data-testid="button-back">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <p className="text-muted-foreground">User not found.</p>
      </div>
    );
  }

  const roleBadges = isParentAccountMode && userData.parentAccountRole
    ? [userData.parentAccountRole]
    : (userData.roles || []);
  const roleDisplay = roleBadges.map(r => roleBadgeLabel(r)).join(", ");
  const locationDisplay = [userData.city, userData.state].filter(Boolean).join(", ") || null;

  return (
    <div className="space-y-6 w-full">
      <button onClick={() => navigate(-1)} className="t-helper flex items-center gap-1.5 hover:text-foreground transition-colors mb-6" data-testid="button-back">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      <Card className="p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-heading">Personal Information</h2>
        </div>

        {/* Editing yourself: personal details live on My Account (the single
            self-service page) - point there instead of duplicating the form.
            Roles, access, and locations below stay editable here. */}
        {isSelf && (
          <div className="mb-6 flex items-center gap-3 rounded-[var(--radius)] border border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.05)] p-3.5" data-testid="self-edit-pointer">
            <UserCircle className="w-5 h-5 text-primary shrink-0" />
            <p className="text-sm flex-1">
              This is you. Your name, mobile number, and password are edited on{" "}
              <Link to="/account" className="text-primary underline">My Account</Link>.
            </p>
          </div>
        )}

        <form ref={editFormRef} onSubmit={handleSubmit}>
          <div className="flex flex-col md:flex-row gap-8">
            <div className="shrink-0">
              <ImageUploader
                value={localPhotoUrl}
                onChange={(url) => setLocalPhotoUrl(url)}
                mode="avatar"
                variant="avatar"
                size={96}
                label="Profile photo"
                testId="profile-photo"
                fallback={<User className="w-10 h-10 text-primary" />}
              />
            </div>

            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Full Name</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Full name"
                  disabled={isSelf}
                  data-testid="input-edit-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <div className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border border-border/40 bg-muted/30">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <span className="t-helper" data-testid="text-account-email">{userData.email}</span>
                  <CopyButton value={userData.email} testId="btn-copy-account-email" />
                </div>
                <p className="t-helper">Email cannot be changed</p>
              </div>
              <div className="space-y-2">
                <Label>Mobile Number</Label>
                <PhoneInput
                  value={mobileE164}
                  displayValue={mobileDisplay}
                  defaultIsoCode={mobileIsoCode || null}
                  onChange={({ e164, display, isoCode }) => {
                    setMobileE164(e164);
                    setMobileDisplay(display);
                    setMobileIsoCode(isoCode);
                  }}
                  disabled={isSelf}
                  data-testid="input-edit-mobile"
                />
              </div>
              {!isProviderUser && (
                <div className="space-y-2">
                  <Label>Location</Label>
                  <LocationAutocomplete
                    value={personalLocation}
                    onChange={setPersonalLocation}
                    placeholder="e.g. New York, NY"
                    data-testid="input-edit-location"
                  />
                </div>
              )}
              {isParent && !isProviderUser && (
                <div className="space-y-2">
                  <Label>Identification</Label>
                  <Select value={identification} onValueChange={setIdentification}>
                    <SelectTrigger data-testid="select-identification">
                      <SelectValue placeholder="Select identification" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Straight">Straight</SelectItem>
                      <SelectItem value="Gay">Gay</SelectItem>
                      <SelectItem value="Lesbian">Lesbian</SelectItem>
                      <SelectItem value="Bi">Bi</SelectItem>
                      <SelectItem value="Queer">Queer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="edit-password">New Password</Label>
                <div className="relative">
                  <Input
                    id="edit-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Leave blank to keep current"
                    disabled={isSelf}
                    data-testid="input-edit-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword(!showPassword)}
                    data-testid="button-toggle-password"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {password && password.length < 6 && (
                  <p className="text-xs text-destructive">Minimum 6 characters</p>
                )}
                {password && (
                  <div className="space-y-2 mt-4">
                    <Label htmlFor="edit-confirm-password">Confirm Password</Label>
                    <Input
                      id="edit-confirm-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter new password"
                      data-testid="input-confirm-password"
                    />
                    {confirmPassword && password !== confirmPassword && (
                      <p className="text-xs text-destructive">Passwords do not match</p>
                    )}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <div className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border border-border/40 bg-muted/30">
                  <Shield className="w-4 h-4 text-muted-foreground" />
                  <span className="t-helper" data-testid="text-account-role">{roleDisplay}</span>
                </div>
              </div>
              {userData.provider && (
                <div className="space-y-2">
                  <Label>Organization</Label>
                  <div className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border border-border/40 bg-muted/30">
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <span className="t-helper" data-testid="text-account-provider">{userData.provider.name}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {isParentAccountMode && userData.parentAccountRole !== "INTENDED_PARENT_1" && id !== currentUser?.id && (
            <div className="mt-8 bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
              <h2 className="t-micro-label font-heading">Account Role</h2>
              <div className="space-y-2 border rounded-[var(--radius)] p-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="parentAccountRole" value="INTENDED_PARENT_2" checked={parentAccountRole === "INTENDED_PARENT_2"} onChange={() => setParentAccountRole("INTENDED_PARENT_2")} data-testid="radio-role-ip2" />
                  <div>
                    <span className="text-sm font-ui">Intended Parent 2</span>
                    <p className="t-helper">Full access - can book, view calendar, and receive all notifications.</p>
                  </div>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="parentAccountRole" value="VIEWER" checked={parentAccountRole === "VIEWER"} onChange={() => setParentAccountRole("VIEWER")} data-testid="radio-role-viewer" />
                  <div>
                    <span className="text-sm font-ui">Viewer</span>
                    <p className="t-helper">Browse-only - can view marketplace and provider profiles but cannot book.</p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {isGostorkTeamUser && (
            <div className="mt-8 bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
              <h2 className="t-micro-label font-heading">GoStork Role</h2>
              <div className="space-y-2 border rounded-[var(--radius)] p-3">
                {GOSTORK_ROLES.map(r => (
                  <label key={r.value} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={roles.includes(r.value)} onCheckedChange={() => toggleRole(r.value)} data-testid={`checkbox-edit-role-${r.value}`} />
                    <span className="text-sm">{r.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {isProviderUser && (
            <div className="mt-8 bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
              <h2 className="t-micro-label font-heading">Roles & Access</h2>

              <div className="space-y-2">
                <Label>Roles</Label>
                <div className="space-y-2 border rounded-[var(--radius)] p-3">
                  {PROVIDER_ROLES.map(r => (
                    <label key={r.value} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox checked={roles.includes(r.value)} onCheckedChange={() => toggleRole(r.value)} data-testid={`checkbox-edit-role-${r.value}`} />
                      <span className="text-sm">{r.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Location Access</Label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={allLocations} onCheckedChange={(checked) => setAllLocations(!!checked)} data-testid="checkbox-edit-all-locations" />
                  <span className="text-sm">All Locations</span>
                </label>
                {providerLocations && providerLocations.length > 0 && (
                  <div className={`space-y-2 border rounded-[var(--radius)] p-3 mt-2 ${allLocations ? "opacity-50" : ""}`}>
                    {providerLocations.map(loc => (
                      <label key={loc.id} className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={allLocations || locationIds.includes(loc.id)} onCheckedChange={() => { if (!allLocations) toggleLocationId(loc.id); }} disabled={allLocations} data-testid={`checkbox-edit-location-${loc.id}`} />
                        <span className="text-sm">{loc.city}, {loc.state} - {loc.address}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {userData.dailyRoomUrl && (
            <div className="mt-8">
              <VideoRoomSection url={userData.dailyRoomUrl} />
            </div>
          )}

          {!isParentAccountMode && (
            <div className="mt-8">
              <ConnectedCalendarsSection connections={userData.calendarConnections} />
            </div>
          )}

          {!isParentAccountMode && userData.scheduleConfig?.bookingPageSlug && (
            <div className="mt-8">
              <CalendarLinkSection slug={userData.scheduleConfig.bookingPageSlug} />
            </div>
          )}

          <SaveBar
            visible={isDirty}
            position="fixed"
            testId="user-edit-save-bar"
            discardLabel="Cancel"
            saveLabel="Save"
            saving={updateMutation.isPending}
            saveDisabled={!name.trim()}
            onDiscard={() => navigate(-1)}
            onSave={() => editFormRef.current?.requestSubmit()}
          />
        </form>
      </Card>
    </div>
  );
}
