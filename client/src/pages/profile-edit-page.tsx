import { useState, useMemo, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { typeToUrlSlug, deriveTypeFromPath, getPhotoSrc } from "@/lib/profile-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Loader2,
  Save,
  ShieldAlert,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Upload,
  Star,
  RotateCw,
  FlipHorizontal2,
  X,
  EyeOff,
  Eye,
  Award,
} from "lucide-react";

const TYPE_ENDPOINTS: Record<string, string> = {
  "egg-donor": "egg-donors",
  surrogate: "surrogates",
  "sperm-donor": "sperm-donors",
};

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="bg-primary px-4 py-2 rounded-t-[var(--radius)]">
      <h3 className="text-sm font-heading text-primary-foreground" data-testid={`section-header-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        {title}
      </h3>
    </div>
  );
}

function ManualBadge() {
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-[hsl(var(--brand-warning)/0.08)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)] ml-1">
      <ShieldAlert className="w-2.5 h-2.5 mr-0.5" /> Protected
    </Badge>
  );
}

function FieldRow({
  label,
  field,
  value,
  onChange,
  isManual,
  type = "text",
}: {
  label: string;
  field: string;
  value: string;
  onChange: (field: string, value: string) => void;
  isManual: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-1" data-testid={`field-row-${field}`}>
      <div className="flex items-center">
        <Label className="text-xs font-ui text-foreground">{label}</Label>
        {isManual && <ManualBadge />}
      </div>
      {type === "textarea" ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          className="text-sm"
          rows={3}
          data-testid={`input-${field}`}
        />
      ) : type === "boolean" ? (
        <select
          value={value === "true" ? "true" : value === "false" ? "false" : ""}
          onChange={(e) => onChange(field, e.target.value)}
          className="flex h-10 w-full rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`input-${field}`}
        >
          <option value="">-</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : (
        <Input
          type={type}
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          className="text-sm"
          data-testid={`input-${field}`}
        />
      )}
    </div>
  );
}

export default function DonorEditPage() {
  const { providerId, type: paramType, donorId } = useParams<{ providerId: string; type?: string; donorId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const type = deriveTypeFromPath(location.pathname, paramType);
  const { user } = useAuth();
  const { toast } = useToast();
  const endpoint = TYPE_ENDPOINTS[type || ""] || "egg-donors";

  const { data: donor, isLoading } = useQuery<any>({
    queryKey: [`/api/providers/${providerId}/${endpoint}`, donorId],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}/${endpoint}/${donorId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Donor not found");
      return res.json();
    },
    enabled: !!providerId && !!donorId && !!type,
  });

  const { data: provider } = useQuery<any>({
    queryKey: ["/api/providers", providerId],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!providerId,
  });

  const [formData, setFormData] = useState<Record<string, any> | null>(null);
  const [profileDataEntries, setProfileDataEntries] = useState<[string, string][] | null>(null);
  const [profileDetailsSections, setProfileDetailsSections] = useState<Record<string, [string, string][]> | null>(null);
  const [originalProfileDetails, setOriginalProfileDetails] = useState<Record<string, [string, string][]> | null>(null);
  const [photos, setPhotos] = useState<string[] | null>(null);
  const [uploading, setUploading] = useState(false);

  const manualFields = useMemo(() => new Set(donor?.manuallyEditedFields || []), [donor]);

  const initForm = useCallback(() => {
    if (!donor || formData) return;
    const d: Record<string, any> = {};
    const basicFields = getFieldsForType(type || "egg-donor");
    for (const f of basicFields) {
      d[f.field] = donor[f.field] != null ? String(donor[f.field]) : "";
    }
    d.status = donor.status || "AVAILABLE";
    d.hiddenFromSearch = !!donor.hiddenFromSearch;
    d.isExperienced = !!donor.isExperienced;
    d.videoUrl = donor.videoUrl || "";
    d.donorType = donor.donorType || "";
    setFormData(d);

    const pd = donor.profileData || {};
    const skipKeys = new Set(["All Photos", "Video URL", "Genetic Report Images", "Profile Details"]);
    const entries = Object.entries(pd)
      .filter(([k]) => !skipKeys.has(k))
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => [k, String(v)] as [string, string]);
    setProfileDataEntries(entries);

    const pdSections = pd["Profile Details"] as Record<string, Record<string, any>> | undefined;
    if (pdSections && typeof pdSections === "object") {
      const sections: Record<string, [string, string][]> = {};
      for (const [sectionName, sectionData] of Object.entries(pdSections)) {
        if (typeof sectionData === "object" && sectionData !== null) {
          sections[sectionName] = Object.entries(sectionData).map(([q, a]) => {
            const aStr = Array.isArray(a) ? a.join(", ") : typeof a === "object" && a !== null
              ? Object.entries(a).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("; ")
              : String(a ?? "");
            return [q, aStr] as [string, string];
          });
        }
      }
      setProfileDetailsSections(sections);
      setOriginalProfileDetails(JSON.parse(JSON.stringify(sections)));
    } else {
      setProfileDetailsSections({});
      setOriginalProfileDetails({});
    }

    const photoList: string[] = [...(donor.photos || [])];
    if (donor.photoUrl && !photoList.includes(donor.photoUrl)) {
      photoList.unshift(donor.photoUrl);
    }
    const allPhotosFromPd = pd["All Photos"];
    if (Array.isArray(allPhotosFromPd)) {
      for (const url of allPhotosFromPd) {
        if (typeof url === "string" && url && !photoList.includes(url)) {
          photoList.push(url);
        }
      }
    }
    setPhotos(photoList);
  }, [donor, formData, type]);

  if (donor && !formData) initForm();

  const updateField = (field: string, value: string | boolean) => {
    setFormData((prev) => prev ? { ...prev, [field]: value } : prev);
  };

  const originalFormRef = useMemo(() => {
    if (!donor) return {};
    const d: Record<string, any> = {};
    const basicFields = getFieldsForType(type || "egg-donor");
    for (const f of basicFields) {
      d[f.field] = donor[f.field] != null ? String(donor[f.field]) : "";
    }
    d.status = donor.status || "AVAILABLE";
    d.hiddenFromSearch = !!donor.hiddenFromSearch;
    d.isExperienced = !!donor.isExperienced;
    d.videoUrl = donor.videoUrl || "";
    d.donorType = donor.donorType || "";
    return d;
  }, [donor, type]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!formData || !donor) return;
      const payload: Record<string, any> = {};

      const basicFields = getFieldsForType(type || "egg-donor");
      for (const f of basicFields) {
        const val = formData[f.field];
        const origVal = originalFormRef[f.field];
        if (val === origVal) continue;
        if (f.boolean) {
          payload[f.field] = val === "true" ? true : val === "false" ? false : null;
        } else if (f.numeric) {
          payload[f.field] = val ? parseFloat(val) || null : null;
        } else {
          payload[f.field] = val || null;
        }
      }
      if (formData.status !== originalFormRef.status) payload.status = formData.status;
      if (formData.hiddenFromSearch !== originalFormRef.hiddenFromSearch) payload.hiddenFromSearch = formData.hiddenFromSearch;
      if (formData.isExperienced !== originalFormRef.isExperienced) payload.isExperienced = formData.isExperienced;
      if (formData.videoUrl !== originalFormRef.videoUrl) payload.videoUrl = formData.videoUrl || null;
      if (formData.donorType !== originalFormRef.donorType) payload.donorType = formData.donorType || null;

      const origPhotos = [...(donor.photos || [])];
      if (donor.photoUrl && !origPhotos.includes(donor.photoUrl)) origPhotos.unshift(donor.photoUrl);
      const origPdPhotos = Array.isArray(donor?.profileData?.["All Photos"]) ? donor.profileData["All Photos"] : [];
      for (const url of origPdPhotos) {
        if (typeof url === "string" && url && !origPhotos.includes(url)) origPhotos.push(url);
      }
      const photosChanged = photos && JSON.stringify(photos) !== JSON.stringify(origPhotos);
      if (photosChanged) {
        payload.photos = photos;
        payload.photoUrl = photos![0] || donor.photoUrl || null;
      }

      const profileDetailsChanged = profileDetailsSections && originalProfileDetails
        && JSON.stringify(profileDetailsSections) !== JSON.stringify(originalProfileDetails);

      if (profileDataEntries || photosChanged || profileDetailsChanged) {
        const pd: Record<string, any> = {};
        if (profileDataEntries) {
          for (const [k, v] of profileDataEntries) {
            if (k.trim()) pd[k.trim()] = v;
          }
        }
        const existingPd = donor?.profileData || {};
        const skipKeys = new Set(["All Photos", "Video URL", "Genetic Report Images", "Profile Details"]);
        for (const [k, v] of Object.entries(existingPd)) {
          if (skipKeys.has(k) && !(k in pd)) {
            pd[k] = v as any;
          }
        }
        if (photosChanged && photos) {
          pd["All Photos"] = photos;
        }
        if (profileDetailsChanged) {
          const origDetails = existingPd["Profile Details"] || {};
          const detailsObj: Record<string, any> = { ...origDetails };
          for (const [sectionName, entries] of Object.entries(profileDetailsSections!)) {
            const origSection = originalProfileDetails![sectionName] || [];
            const sectionObj: Record<string, any> = { ...(origDetails[sectionName] || {}) };
            for (let i = 0; i < entries.length; i++) {
              const [q, a] = entries[i];
              const origAnswer = origSection[i]?.[1] ?? "";
              if (a !== origAnswer && q.trim()) {
                sectionObj[q.trim()] = a;
              }
            }
            detailsObj[sectionName] = sectionObj;
          }
          pd["Profile Details"] = detailsObj;
        } else if (existingPd["Profile Details"]) {
          pd["Profile Details"] = existingPd["Profile Details"];
        }
        payload.profileData = pd;
      }

      if (Object.keys(payload).length === 0) {
        return { noChanges: true };
      }

      const res = await apiRequest("PATCH", `/api/providers/${providerId}/donors/${type}/${donorId}`, payload);
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data?.noChanges) {
        toast({ title: "No changes", description: "No fields were modified.", variant: "warning" });
        return;
      }
      queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/${endpoint}`, donorId] });
      toast({ title: "Donor profile updated", description: "Changes saved successfully.", variant: "success" });
      navigate(`/admin/providers/${providerId}/${typeToUrlSlug(type || "egg-donor")}/${donorId}`);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/uploads", { method: "POST", body: fd, credentials: "include" });
        if (!res.ok) throw new Error("Upload failed");
        const data = await res.json();
        setPhotos((prev) => [...(prev || []), data.url]);
      }
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const roles = user?.roles || [];
  const isGostorkAdmin = roles.includes("GOSTORK_ADMIN");
  const isProviderStaff = roles.some((r: string) =>
    ["PROVIDER_ADMIN", "INTAKE_COORDINATOR", "MATCHING_COORDINATOR", "CASE_MANAGER", "PROVIDER_STAFF"].includes(r)
  );
  const canEdit = isGostorkAdmin || isProviderStaff;

  if (!canEdit) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">You don't have permission to edit donor profiles.</p>
      </div>
    );
  }

  if (isLoading || !donor) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const displayId = donor.externalId || donorId?.slice(0, 8);
  const basicFields = getFieldsForType(type || "egg-donor");

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto pb-12">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => navigate(`/admin/providers/${providerId}/${typeToUrlSlug(type || "egg-donor")}/${donorId}`)}
          data-testid="link-back-profile"
        >
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Profile
        </Button>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          data-testid="button-save-donor"
        >
          {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <div>
        <h1 className="font-display text-2xl font-heading text-foreground" data-testid="text-edit-title">
          Edit Donor #{displayId}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {provider?.name} &middot; {type?.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
        </p>
        {donor.externalId && (
          <p className="text-xs text-muted-foreground mt-1">
            External ID: <span className="font-mono">{donor.externalId}</span> (read-only)
          </p>
        )}
      </div>

      {formData && (
        <>
          <Card className="overflow-hidden" data-testid="section-status">
            <SectionHeader title="Status & Type" />
            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="flex items-center">
                  <Label className="text-xs font-ui">Status</Label>
                  {manualFields.has("status") && <ManualBadge />}
                </div>
                <Select value={formData.status} onValueChange={(v) => updateField("status", v)}>
                  <SelectTrigger data-testid="select-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AVAILABLE">Available</SelectItem>
                    <SelectItem value="MATCHED">Matched</SelectItem>
                    <SelectItem value="ON_HOLD">On Hold</SelectItem>
                    <SelectItem value="INACTIVE">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <FieldRow label="Donor Type" field="donorType" value={formData.donorType} onChange={updateField} isManual={manualFields.has("donorType")} />
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs font-ui">Search Visibility</Label>
                <button
                  type="button"
                  className={`flex items-center gap-2 w-full px-3 py-2 rounded-[var(--radius)] border text-sm transition-colors ${
                    formData.hiddenFromSearch
                      ? "bg-[hsl(var(--brand-warning)/0.08)] border-[hsl(var(--brand-warning)/0.3)] text-[hsl(var(--brand-warning))]"
                      : "bg-[hsl(var(--brand-success)/0.08)] border-[hsl(var(--brand-success)/0.3)] text-[hsl(var(--brand-success))]"
                  }`}
                  onClick={() => updateField("hiddenFromSearch", !formData.hiddenFromSearch)}
                  data-testid="btn-toggle-hidden"
                >
                  {formData.hiddenFromSearch ? (
                    <>
                      <EyeOff className="w-4 h-4" />
                      Hidden from parent search results
                    </>
                  ) : (
                    <>
                      <Eye className="w-4 h-4" />
                      Visible in parent search results
                    </>
                  )}
                </button>
                <p className="text-[11px] text-muted-foreground">
                  {formData.hiddenFromSearch
                    ? "This donor will not appear in search results for intended parents unless explicitly shared."
                    : "This donor is visible to all intended parents browsing the marketplace."}
                </p>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs font-ui">Experienced</Label>
                <button
                  type="button"
                  className={`flex items-center gap-2 w-full px-3 py-2 rounded-[var(--radius)] border text-sm transition-colors ${
                    formData.isExperienced
                      ? "bg-[hsl(var(--brand-accent)/0.08)] border-[hsl(var(--brand-accent)/0.3)] text-[hsl(var(--brand-accent))]"
                      : "bg-muted/30 border-border text-muted-foreground"
                  }`}
                  onClick={() => updateField("isExperienced", !formData.isExperienced)}
                  data-testid="btn-toggle-experienced"
                >
                  <Award className="w-4 h-4" />
                  {formData.isExperienced ? "Marked as Experienced" : "Not marked as Experienced"}
                </button>
                <p className="text-[11px] text-muted-foreground">
                  {formData.isExperienced
                    ? "This profile is flagged as experienced and will appear when filtering for experienced donors/surrogates."
                    : "Toggle to mark this profile as experienced. This is auto-detected from donation/pregnancy history during sync."}
                </p>
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden" data-testid="section-basic-info">
            <SectionHeader title="Basic Info" />
            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {basicFields.filter((f) => !f.isCompensation).map((f) => (
                <FieldRow
                  key={f.field}
                  label={f.label}
                  field={f.field}
                  value={formData[f.field] != null ? String(formData[f.field]) : ""}
                  onChange={updateField}
                  isManual={manualFields.has(f.field)}
                  type={f.boolean ? "boolean" : f.numeric ? "number" : "text"}
                />
              ))}
            </div>
          </Card>

          {basicFields.some((f) => f.isCompensation) && (
            <Card className="overflow-hidden" data-testid="section-compensation">
              <SectionHeader title="Compensation" />
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {basicFields.filter((f) => f.isCompensation).map((f) => (
                  <FieldRow
                    key={f.field}
                    label={f.label}
                    field={f.field}
                    value={formData[f.field] || ""}
                    onChange={updateField}
                    isManual={manualFields.has(f.field)}
                    type="number"
                  />
                ))}
              </div>
            </Card>
          )}

          <Card className="overflow-hidden" data-testid="section-media">
            <SectionHeader title="Media" />
            <div className="p-6 space-y-4">
              <FieldRow label="Video URL" field="videoUrl" value={formData.videoUrl || ""} onChange={updateField} isManual={manualFields.has("videoUrl")} />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <Label className="text-xs font-ui">Photos</Label>
                    {manualFields.has("photos") && <ManualBadge />}
                  </div>
                  <label className="cursor-pointer" data-testid="button-upload-photo">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handlePhotoUpload}
                      className="hidden"
                    />
                    <div className="flex items-center gap-1 text-xs text-primary hover:underline">
                      {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                      Upload Photos
                    </div>
                  </label>
                </div>

                {photos && photos.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {photos.map((url, idx) => (
                      <PhotoCard
                        key={`${url}-${idx}`}
                        url={url}
                        isPrimary={idx === 0}
                        index={idx}
                        total={photos.length}
                        onRemove={() => setPhotos((prev) => prev?.filter((_, i) => i !== idx) || [])}
                        onMoveUp={() => {
                          if (idx === 0) return;
                          setPhotos((prev) => {
                            if (!prev) return prev;
                            const next = [...prev];
                            [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                            return next;
                          });
                        }}
                        onMoveDown={() => {
                          if (idx === photos.length - 1) return;
                          setPhotos((prev) => {
                            if (!prev) return prev;
                            const next = [...prev];
                            [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                            return next;
                          });
                        }}
                        onSetPrimary={() => {
                          setPhotos((prev) => {
                            if (!prev) return prev;
                            const next = [...prev];
                            const [photo] = next.splice(idx, 1);
                            next.unshift(photo);
                            return next;
                          });
                        }}
                        onReplaceUrl={(newUrl) => {
                          setPhotos((prev) => {
                            if (!prev) return prev;
                            const next = [...prev];
                            next[idx] = newUrl;
                            return next;
                          });
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No photos uploaded.</p>
                )}
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden" data-testid="section-profile-data">
            <SectionHeader title="Profile Data" />
            <div className="p-6 space-y-3">
              <p className="text-xs text-muted-foreground">
                Key-value pairs from the donor's scraped profile. Changes here will be protected from future sync overwrites.
              </p>
              {profileDataEntries && profileDataEntries.map(([key, value], idx) => (
                <div key={idx} className="flex items-start gap-2" data-testid={`profile-data-row-${idx}`}>
                  <Input
                    value={key}
                    onChange={(e) => {
                      setProfileDataEntries((prev) => {
                        if (!prev) return prev;
                        const next = [...prev];
                        next[idx] = [e.target.value, next[idx][1]];
                        return next;
                      });
                    }}
                    placeholder="Field name"
                    className="text-sm w-1/3"
                    data-testid={`input-pd-key-${idx}`}
                  />
                  <Textarea
                    value={value}
                    onChange={(e) => {
                      setProfileDataEntries((prev) => {
                        if (!prev) return prev;
                        const next = [...prev];
                        next[idx] = [next[idx][0], e.target.value];
                        return next;
                      });
                    }}
                    placeholder="Value"
                    className="text-sm flex-1"
                    rows={value.length > 120 ? 3 : 1}
                    data-testid={`input-pd-value-${idx}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-destructive hover:text-destructive"
                    onClick={() => {
                      setProfileDataEntries((prev) => prev?.filter((_, i) => i !== idx) || []);
                    }}
                    data-testid={`button-remove-pd-${idx}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProfileDataEntries((prev) => [...(prev || []), ["", ""]])}
                data-testid="button-add-profile-field"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Field
              </Button>
            </div>
          </Card>

          {profileDetailsSections && Object.keys(profileDetailsSections).length > 0 && (
            Object.entries(profileDetailsSections).map(([sectionName, entries]) => (
              <Card key={sectionName} className="overflow-hidden" data-testid={`section-details-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
                <SectionHeader title={sectionName} />
                <div className="p-6 space-y-3">
                  {entries.map(([question, answer], idx) => (
                    <div key={idx} className="space-y-1" data-testid={`details-row-${sectionName.toLowerCase().replace(/\s+/g, "-")}-${idx}`}>
                      <Label className="text-xs font-ui text-foreground">{question}</Label>
                      <Textarea
                        value={answer}
                        onChange={(e) => {
                          setProfileDetailsSections((prev) => {
                            if (!prev) return prev;
                            const next = { ...prev };
                            const sectionEntries = [...next[sectionName]];
                            sectionEntries[idx] = [sectionEntries[idx][0], e.target.value];
                            next[sectionName] = sectionEntries;
                            return next;
                          });
                        }}
                        className="text-sm"
                        rows={answer.length > 100 ? 3 : 1}
                        data-testid={`input-details-${sectionName.toLowerCase().replace(/\s+/g, "-")}-${idx}`}
                      />
                    </div>
                  ))}
                </div>
              </Card>
            ))
          )}

          {donor.lastEditedBy && (
            <p className="text-xs text-muted-foreground">
              Last edited by {donor.lastEditedBy} on {new Date(donor.lastEditedAt).toLocaleString()}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <Button
              variant="outline"
              onClick={() => navigate(`/admin/providers/${providerId}/${typeToUrlSlug(type || "egg-donor")}/${donorId}`)}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              data-testid="button-save-donor-bottom"
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Changes
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function PhotoCard({
  url,
  isPrimary,
  index,
  total,
  onRemove,
  onMoveUp,
  onMoveDown,
  onSetPrimary,
  onReplaceUrl,
}: {
  url: string;
  isPrimary: boolean;
  index: number;
  total: number;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSetPrimary: () => void;
  onReplaceUrl: (newUrl: string) => void;
}) {
  const [transforming, setTransforming] = useState(false);
  const displayUrl = getPhotoSrc(url) || url;
  const isLocal = url.startsWith("/uploads/");

  const handleTransform = async (opts: { rotation?: number; flipH?: boolean }) => {
    if (!isLocal) return;
    setTransforming(true);
    try {
      const res = await fetch("/api/uploads/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imageUrl: url, ...opts }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Transform failed");
      }
      const { url: newUrl } = await res.json();
      onReplaceUrl(newUrl);
    } catch (err: any) {
      console.error("Transform error:", err);
    } finally {
      setTransforming(false);
    }
  };

  return (
    <div className="relative group border rounded-[var(--radius)] overflow-hidden bg-muted" data-testid={`photo-card-${index}`}>
      <img
        src={displayUrl}
        alt={`Photo ${index + 1}`}
        className="w-full h-32 object-cover"
        onError={(e) => { (e.target as HTMLImageElement).src = ""; }}
      />
      {transforming && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10">
          <Loader2 className="w-5 h-5 animate-spin text-white" />
        </div>
      )}
      {isPrimary && (
        <div className="absolute top-1 left-1">
          <Badge className="bg-[hsl(var(--brand-warning))] text-primary-foreground text-[10px] px-1">
            <Star className="w-2.5 h-2.5 mr-0.5" /> Primary
          </Badge>
        </div>
      )}
      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
        {!isPrimary && (
          <Button variant="ghost" size="icon" className="h-7 w-7 text-white hover:bg-white/20" onClick={onSetPrimary} title="Set as primary" data-testid={`button-primary-${index}`}>
            <Star className="w-3.5 h-3.5" />
          </Button>
        )}
        {index > 0 && (
          <Button variant="ghost" size="icon" className="h-7 w-7 text-white hover:bg-white/20" onClick={onMoveUp} title="Move up" data-testid={`button-move-up-${index}`}>
            <ArrowUp className="w-3.5 h-3.5" />
          </Button>
        )}
        {index < total - 1 && (
          <Button variant="ghost" size="icon" className="h-7 w-7 text-white hover:bg-white/20" onClick={onMoveDown} title="Move down" data-testid={`button-move-down-${index}`}>
            <ArrowDown className="w-3.5 h-3.5" />
          </Button>
        )}
        {isLocal && (
          <>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-white hover:bg-white/20" onClick={() => handleTransform({ rotation: 90 })} title="Rotate 90°" disabled={transforming} data-testid={`button-rotate-${index}`}>
              <RotateCw className="w-3.5 h-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-white hover:bg-white/20" onClick={() => handleTransform({ flipH: true })} title="Flip horizontal" disabled={transforming} data-testid={`button-flip-${index}`}>
              <FlipHorizontal2 className="w-3.5 h-3.5" />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7 text-white hover:bg-white/20 hover:text-destructive" onClick={onRemove} title="Remove" disabled={transforming} data-testid={`button-remove-photo-${index}`}>
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

type FieldDef = { field: string; label: string; numeric?: boolean; boolean?: boolean; isCompensation?: boolean };

function getFieldsForType(type: string): FieldDef[] {
  if (type === "egg-donor") {
    return [
      { field: "age", label: "Age", numeric: true },
      { field: "race", label: "Race" },
      { field: "ethnicity", label: "Ethnicity" },
      { field: "religion", label: "Religion" },
      { field: "height", label: "Height" },
      { field: "weight", label: "Weight" },
      { field: "eyeColor", label: "Eye Color" },
      { field: "hairColor", label: "Hair Color" },
      { field: "education", label: "Education" },
      { field: "location", label: "Location" },
      { field: "relationshipStatus", label: "Relationship Status" },
      { field: "occupation", label: "Occupation" },
      { field: "bloodType", label: "Blood Type" },
      { field: "donationTypes", label: "Donation Types" },
      { field: "donorCompensation", label: "Egg Donor Compensation", numeric: true, isCompensation: true },
      { field: "eggLotCost", label: "Egg Lot Cost", numeric: true, isCompensation: true },
      { field: "totalCost", label: "Total Cost", numeric: true, isCompensation: true },
    ];
  } else if (type === "surrogate") {
    return [
      { field: "age", label: "Age", numeric: true },
      { field: "location", label: "Location" },
      { field: "bmi", label: "BMI", numeric: true },
      { field: "race", label: "Race" },
      { field: "ethnicity", label: "Ethnicity" },
      { field: "religion", label: "Religion" },
      { field: "education", label: "Education" },
      { field: "occupation", label: "Occupation" },
      { field: "relationshipStatus", label: "Relationship Status" },
      { field: "covidVaccinated", label: "COVID Vaccinated", boolean: true },
      { field: "liveBirths", label: "Live Births", numeric: true },
      { field: "cSections", label: "C-Sections", numeric: true },
      { field: "miscarriages", label: "Miscarriages", numeric: true },
      { field: "agreesToAbortion", label: "Abortions", boolean: true },
      { field: "lastDeliveryYear", label: "Last Delivery Year", numeric: true },
      { field: "agreesToTwins", label: "Twins", boolean: true },
      { field: "agreesToSelectiveReduction", label: "Selective Reduction", boolean: true },
      { field: "openToSameSexCouple", label: "Same Sex Couple", boolean: true },
      { field: "agreesToInternationalParents", label: "International Parents", boolean: true },
      { field: "baseCompensation", label: "Base Compensation", numeric: true, isCompensation: true },
      { field: "totalCompensationMin", label: "Total Compensation (Min)", numeric: true, isCompensation: true },
      { field: "totalCompensationMax", label: "Total Compensation (Max)", numeric: true, isCompensation: true },
    ];
  } else {
    return [
      { field: "age", label: "Age", numeric: true },
      { field: "race", label: "Race" },
      { field: "ethnicity", label: "Ethnicity" },
      { field: "height", label: "Height" },
      { field: "weight", label: "Weight" },
      { field: "eyeColor", label: "Eye Color" },
      { field: "hairColor", label: "Hair Color" },
      { field: "education", label: "Education" },
      { field: "location", label: "Location" },
      { field: "relationshipStatus", label: "Relationship Status" },
      { field: "occupation", label: "Occupation" },
      { field: "compensation", label: "Compensation", numeric: true, isCompensation: true },
    ];
  }
}
