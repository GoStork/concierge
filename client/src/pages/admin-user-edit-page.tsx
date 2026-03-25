import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Loader2, RefreshCw, User, UserCircle, Phone, MapPin, Building2, Video, Calendar, Link2, Copy, Check, AlertTriangle, Camera, Trash2, Eye, EyeOff, Mail, Shield, Pencil } from "lucide-react";
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

function CalendarLinkSection({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const bookingUrl = `${window.location.origin}/book/${slug}`;
  const handleCopy = () => {
    navigator.clipboard.writeText(bookingUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Link2 className="w-5 h-5 text-primary" />
        <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Your Calendar Link</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Share this link with anyone to let them book time with you. It can be embedded on websites or shared via email.
      </p>
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center bg-secondary/30 border border-border/50 rounded-[var(--radius)] px-3 py-2">
          <span className="text-sm text-muted-foreground mr-1 shrink-0">/book/</span>
          <span className="text-sm font-ui font-heading" data-testid="text-calendar-slug">{slug}</span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy} data-testid="button-copy-calendar-link">
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>
      <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline break-all" data-testid="link-calendar-booking-url">{bookingUrl}</a>
    </div>
  );
}

export default function AdminUserEditPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentUserRoles: string[] = (currentUser as any)?.roles || [];
  const isGostorkAdmin = currentUserRoles.includes("GOSTORK_ADMIN");
  const currentUserProviderId = (currentUser as any)?.providerId;
  const providerIdFromUrl = searchParams.get("provider");
  const isParentAccountMode = searchParams.get("parentAccount") === "true";

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mobileNumber, setMobileNumber] = useState("");
  const [identification, setIdentification] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [parentAccountRole, setParentAccountRole] = useState("INTENDED_PARENT_2");
  const [personalLocation, setPersonalLocation] = useState({ address: "", city: "", state: "", zip: "", country: "" });
  const [allLocations, setAllLocations] = useState(true);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
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
      setName(userData.name || "");
      setEmail(userData.email);
      setMobileNumber(userData.mobileNumber || "");
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
        if (userData?.providerId) {
          queryClient.invalidateQueries({ queryKey: ["/api/providers", userData.providerId, "users"] });
        }
      }
      if (id === currentUser?.id) {
        queryClient.invalidateQueries({ queryKey: [api.auth.me.path] });
      }
      toast({ title: isParentAccountMode ? "Member updated" : "User updated", variant: "success" });
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

  async function handlePhotoUpload(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const { url } = await uploadRes.json();
      setLocalPhotoUrl(url);
      toast({ title: "Photo uploaded", variant: "success" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function handlePhotoDelete() {
    setLocalPhotoUrl(null);
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
        name, email, mobileNumber,
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
      name, email, mobileNumber,
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
        <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6" data-testid="button-back">
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
  const photoSrc = getPhotoSrc(localPhotoUrl);
  const locationDisplay = [userData.city, userData.state].filter(Boolean).join(", ") || null;

  return (
    <div className="space-y-6 w-full">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6" data-testid="button-back">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      <Card className="p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-heading">Personal Information</h2>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="flex flex-col md:flex-row gap-8">
            <div className="shrink-0 flex flex-col items-center gap-2">
              <div className="relative group">
                {photoSrc ? (
                  <img src={photoSrc} alt="Profile" className="w-24 h-24 rounded-full object-cover border-2 border-border/40" data-testid="img-profile-photo" />
                ) : (
                  <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center border-2 border-border/40" data-testid="img-profile-photo-placeholder">
                    <User className="w-10 h-10 text-primary" />
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  data-testid="input-profile-photo"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handlePhotoUpload(file);
                    e.target.value = "";
                  }}
                />
                <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                  {uploading ? (
                    <Loader2 className="w-5 h-5 text-white animate-spin" />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="p-1.5 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                        data-testid="button-upload-photo"
                        title={photoSrc ? "Change photo" : "Upload photo"}
                      >
                        <Camera className="w-4 h-4 text-white" />
                      </button>
                      {photoSrc && (
                        <button
                          type="button"
                          onClick={handlePhotoDelete}
                          className="p-1.5 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                          data-testid="button-delete-photo"
                          title="Remove photo"
                        >
                          <Trash2 className="w-4 h-4 text-white" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Profile photo</p>
            </div>

            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Full Name</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Full name"
                  data-testid="input-edit-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <div className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border border-border/40 bg-muted/30">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground" data-testid="text-account-email">{userData.email}</span>
                </div>
                <p className="text-xs text-muted-foreground">Email cannot be changed</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-mobile">Mobile Number</Label>
                <Input
                  id="edit-mobile"
                  value={mobileNumber}
                  onChange={e => setMobileNumber(e.target.value)}
                  placeholder="e.g. +1 (555) 123-4567"
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
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Leave blank to keep current"
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
                  <span className="text-sm text-muted-foreground" data-testid="text-account-role">{roleDisplay}</span>
                </div>
              </div>
              {userData.provider && (
                <div className="space-y-2">
                  <Label>Organization</Label>
                  <div className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border border-border/40 bg-muted/30">
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground" data-testid="text-account-provider">{userData.provider.name}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {isParentAccountMode && userData.parentAccountRole !== "INTENDED_PARENT_1" && id !== currentUser?.id && (
            <div className="mt-8 bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
              <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Account Role</h2>
              <div className="space-y-2 border rounded-[var(--radius)] p-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="parentAccountRole" value="INTENDED_PARENT_2" checked={parentAccountRole === "INTENDED_PARENT_2"} onChange={() => setParentAccountRole("INTENDED_PARENT_2")} data-testid="radio-role-ip2" />
                  <div>
                    <span className="text-sm font-ui">Intended Parent 2</span>
                    <p className="text-xs text-muted-foreground">Full access — can book, view calendar, and receive all notifications.</p>
                  </div>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="parentAccountRole" value="VIEWER" checked={parentAccountRole === "VIEWER"} onChange={() => setParentAccountRole("VIEWER")} data-testid="radio-role-viewer" />
                  <div>
                    <span className="text-sm font-ui">Viewer</span>
                    <p className="text-xs text-muted-foreground">Browse-only — can view marketplace and provider profiles but cannot book.</p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {isGostorkTeamUser && (
            <div className="mt-8 bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
              <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">GoStork Role</h2>
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
              <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Roles & Access</h2>

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
            <div className="mt-8 bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
              <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Video Room</h2>
              <div className="flex items-center gap-2">
                <Video className="w-4 h-4 text-primary shrink-0" />
                <a href={userData.dailyRoomUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline truncate" data-testid="link-video-room-url">
                  {userData.dailyRoomUrl}
                </a>
              </div>
            </div>
          )}

          {!isParentAccountMode && (
            <div className="mt-8 bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
              <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Connected Calendars</h2>
              {userData.calendarConnections && userData.calendarConnections.length > 0 ? (
                <div className="space-y-2">
                  {userData.calendarConnections.map((conn) => {
                    const isHealthy = conn.tokenValid !== false && conn.connected !== false;
                    return (
                      <div key={conn.id} className="flex items-center gap-2 text-sm" data-testid={`text-calendar-connection-${conn.id}`}>
                        <Calendar className="w-4 h-4 text-primary shrink-0" />
                        <span className="font-ui">{conn.label || conn.provider}</span>
                        {conn.email && <span className="text-muted-foreground">({conn.email})</span>}
                        {isHealthy ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-ui bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]" data-testid={`badge-calendar-status-${conn.id}`}>Connected</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-ui bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))]" data-testid={`badge-calendar-status-${conn.id}`}>
                            <AlertTriangle className="w-3 h-3" />Needs Renewal
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">No calendar connected yet.</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => navigate("/account/calendar?connect=true")} data-testid="button-connect-calendar">
                    <Calendar className="w-4 h-4 mr-1.5" />
                    Connect Your Calendar
                  </Button>
                </div>
              )}
            </div>
          )}

          {!isParentAccountMode && userData.scheduleConfig?.bookingPageSlug && (
            <CalendarLinkSection slug={userData.scheduleConfig.bookingPageSlug} />
          )}

          <div className="flex gap-3 pt-6">
            <Button type="submit" disabled={updateMutation.isPending || !name.trim()} data-testid="button-save-edit">
              {updateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              Save
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate(-1)} data-testid="button-cancel">Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
