import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useProvider } from "@/hooks/use-providers";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { hasProviderRole } from "@shared/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";
import {
  Building2, Loader2, Globe, Phone, Calendar, Plus, MapPin, FileText,
  Check, X, Upload, Pencil, Save, ImageIcon, User, GripVertical, Eye, Settings,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import LocationAutocomplete from "@/components/location-autocomplete";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getPhotoSrc } from "@/lib/profile-utils";

type LocationData = {
  id?: string;
  _sortId?: string;
  address: string;
  city: string;
  state: string;
  zip: string;
};

type MemberData = {
  id?: string;
  _sortId?: string;
  name: string;
  title: string | null;
  bio: string | null;
  photoUrl: string | null;
  isMedicalDirector?: boolean;
  locationIds?: string[];
};

let _sortCounter = 0;
function nextSortId() {
  return `csort_${++_sortCounter}_${Date.now()}`;
}

function getSortId(item: any, idx: number): string {
  return item._sortId || item.id || `cidx_${idx}`;
}

function SortableItem({ id, children, disabled, readOnly }: { id: string; children: React.ReactNode; disabled?: boolean; readOnly?: boolean }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: disabled || readOnly });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 10 : "auto" as any,
  };

  if (readOnly) {
    return <div>{children}</div>;
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div className="flex items-start gap-1">
        <button
          type="button"
          className="mt-2 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition-colors shrink-0 touch-none"
          {...listeners}
          tabIndex={-1}
          data-testid={`drag-handle-${id}`}
        >
          <GripVertical className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

export default function CompanyTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const providerId = (user as any)?.providerId;
  const roles = (user as any)?.roles || [];
  const isGostorkAdmin = roles.includes("GOSTORK_ADMIN");
  const isProvider = hasProviderRole(roles) || isGostorkAdmin;
  const isProviderAdmin = roles.includes("PROVIDER_ADMIN") || isGostorkAdmin;

  const { data: provider, isLoading } = useProvider(providerId || "");

  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [phone, setPhone] = useState("");
  const [yearFounded, setYearFounded] = useState("");
  const [consultationBookingUrl, setConsultationBookingUrl] = useState("");
  const [consultationIframeEnabled, setConsultationIframeEnabled] = useState(false);
  const [pandaDocTemplateId, setPandaDocTemplateId] = useState("");
  const [locations, setLocations] = useState<LocationData[]>([]);
  const [teamMembers, setTeamMembers] = useState<MemberData[]>([]);
  const [editingMemberIdx, setEditingMemberIdx] = useState<number | null>(null);
  const [uploadingPhotoIdx, setUploadingPhotoIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedServiceTypeId, setSelectedServiceTypeId] = useState("");

  const { data: services } = useQuery<any[]>({
    queryKey: ["/api/providers", providerId, "services"],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}/services`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch services");
      return res.json();
    },
    enabled: !!providerId,
  });

  const { data: providerTypes } = useQuery<any[]>({
    queryKey: ["/api/provider-types"],
  });

  const requestServiceMutation = useMutation({
    mutationFn: async (providerTypeId: string) => {
      const res = await apiRequest("POST", `/api/providers/${providerId}/services`, {
        providerTypeId,
        status: "NEW",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/providers", providerId, "services"] });
      queryClient.invalidateQueries({ queryKey: ["/api/providers", providerId] });
      setSelectedServiceTypeId("");
      toast({ title: "Service requested", description: "Your service request has been submitted.", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const existingServiceTypeIds = new Set(services?.map((s: any) => s.providerTypeId) || []);
  const availableServiceTypes = providerTypes?.filter((t: any) => !existingServiceTypeIds.has(t.id)) || [];

  const SERVICE_STATUS_STYLES: Record<string, string> = {
    NEW: "bg-muted text-muted-foreground",
    IN_PROGRESS: "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]",
    APPROVED: "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]",
    DECLINED: "bg-destructive/15 text-destructive",
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleLocationDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setLocations((items) => {
      const oldIndex = items.findIndex((item, i) => getSortId(item, i) === active.id);
      const newIndex = items.findIndex((item, i) => getSortId(item, i) === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  function handleMemberDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setTeamMembers((items) => {
      const oldIndex = items.findIndex((item, i) => getSortId(item, i) === active.id);
      const newIndex = items.findIndex((item, i) => getSortId(item, i) === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  useEffect(() => {
    if (provider) {
      setName(provider.name || "");
      setAbout(provider.about || "");
      setLogoUrl(provider.logoUrl || "");
      setWebsiteUrl(provider.websiteUrl || "");
      setPhone(provider.phone || "");
      setYearFounded(provider.yearFounded ? String(provider.yearFounded) : "");
      setConsultationBookingUrl(provider.consultationBookingUrl || "");
      setConsultationIframeEnabled(provider.consultationIframeEnabled || false);
      setPandaDocTemplateId(provider.pandaDocTemplateId || "");
      setLocations(
        (provider.locations || []).map((l: any) => ({
          id: l.id,
          _sortId: l.id || nextSortId(),
          address: l.address || "",
          city: l.city || "",
          state: l.state || "",
          zip: l.zip || "",
        }))
      );
      setTeamMembers(
        (provider.members || []).map((m: any) => ({
          id: m.id,
          _sortId: m.id || nextSortId(),
          name: m.name,
          title: m.title || null,
          bio: m.bio || null,
          photoUrl: m.photoUrl || null,
          isMedicalDirector: m.isMedicalDirector || false,
          locationIds: m.locations?.map((ml: any) => ml.locationId) || [],
        }))
      );
    }
  }, [provider]);

  if ((!isProvider && !isGostorkAdmin) || !providerId) {
    return (
      <Card className="p-12 text-center text-muted-foreground" data-testid="company-no-provider">
        <Building2 className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
        <p>Company settings are only available for provider accounts.</p>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!provider) {
    return (
      <Card className="p-12 text-center text-muted-foreground">
        <p>Could not load provider data.</p>
      </Card>
    );
  }

  async function handlePhotoUpload(file: File, idx: number) {
    setUploadingPhotoIdx(idx);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/uploads", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message);
      }
      const { url } = await res.json();
      const updated = [...teamMembers];
      updated[idx] = { ...updated[idx], photoUrl: url };
      setTeamMembers(updated);
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploadingPhotoIdx(null);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!provider || !isProviderAdmin) return;
    setSaving(true);

    try {
      await apiRequest("PUT", `/api/providers/${provider.id}`, {
        name,
        about: about || null,
        websiteUrl: websiteUrl || null,
        phone: phone || null,
        yearFounded: yearFounded ? parseInt(yearFounded) : null,
        logoUrl: logoUrl || null,
        consultationBookingUrl: consultationBookingUrl || null,
        consultationIframeEnabled,
        pandaDocTemplateId: pandaDocTemplateId || null,
      });

      const errors: string[] = [];

      const existingLocIds = new Set((provider.locations || []).map((l: any) => l.id));
      const currentLocIds = new Set(locations.filter(l => l.id).map(l => l.id));

      for (const loc of provider.locations || []) {
        if (!currentLocIds.has(loc.id)) {
          try { await apiRequest("DELETE", `/api/providers/${provider.id}/locations/${loc.id}`); } catch (e: any) { errors.push(`Delete location: ${e.message}`); }
        }
      }
      for (let i = 0; i < locations.length; i++) {
        const loc = locations[i];
        if (loc.id && existingLocIds.has(loc.id)) {
          try { await apiRequest("PUT", `/api/providers/${provider.id}/locations/${loc.id}`, { address: loc.address, city: loc.city, state: loc.state, zip: loc.zip, sortOrder: i }); } catch (e: any) { errors.push(`Update location: ${e.message}`); }
        } else if (!loc.id || !existingLocIds.has(loc.id)) {
          try { await apiRequest("POST", `/api/providers/${provider.id}/locations`, { address: loc.address || null, city: loc.city || null, state: loc.state || null, zip: loc.zip || null, sortOrder: i }); } catch (e: any) { errors.push(`Add location: ${e.message}`); }
        }
      }

      const existingMemberIds = new Set((provider.members || []).map((d: any) => d.id));
      const currentMemberIds = new Set(teamMembers.filter(m => m.id).map(m => m.id));

      for (const mem of provider.members || []) {
        if (!currentMemberIds.has(mem.id)) {
          try { await apiRequest("DELETE", `/api/providers/${provider.id}/members/${mem.id}`); } catch (e: any) { errors.push(`Delete member: ${e.message}`); }
        }
      }
      for (let i = 0; i < teamMembers.length; i++) {
        const member = teamMembers[i];
        if (member.id && existingMemberIds.has(member.id)) {
          try { await apiRequest("PUT", `/api/providers/${provider.id}/members/${member.id}`, { name: member.name, title: member.title || null, bio: member.bio || null, photoUrl: member.photoUrl || null, isMedicalDirector: member.isMedicalDirector || false, sortOrder: i, locationIds: member.locationIds || [] }); } catch (e: any) { errors.push(`Update member "${member.name}": ${e.message}`); }
        } else if (!member.id || !existingMemberIds.has(member.id)) {
          try { await apiRequest("POST", `/api/providers/${provider.id}/members`, { name: member.name, title: member.title || null, bio: member.bio || null, photoUrl: member.photoUrl || null, isMedicalDirector: member.isMedicalDirector || false, sortOrder: i, locationIds: member.locationIds || [] }); } catch (e: any) { errors.push(`Add member "${member.name}": ${e.message}`); }
        }
      }

      queryClient.invalidateQueries({ queryKey: [api.providers.get.path, provider.id] });
      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
      if (errors.length > 0) {
        toast({ title: "Saved with errors", description: errors.join("; "), variant: "destructive" });
      } else {
        toast({ title: "Company profile updated", variant: "success" });
      }
    } catch (err: any) {
      toast({ title: "Error saving", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const readOnly = !isProviderAdmin;

  return (
    <form onSubmit={handleSave} className="space-y-8" data-testid="company-form">
      <Card className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-heading flex items-center gap-2" data-testid="text-company-heading">
            <Building2 className="w-5 h-5 text-primary" /> Company Profile
          </h2>
          <Button type="button" variant="outline" size="sm" onClick={() => navigate(`/providers/${provider.id}`)} data-testid="button-profile-preview">
            <Eye className="w-4 h-4 mr-1.5" /> Profile Preview
          </Button>
        </div>

        <div className="flex items-start gap-4">
          {logoUrl && (
            <img
              src={getPhotoSrc(logoUrl) || logoUrl}
              alt="Logo"
              className="w-16 h-16 rounded-lg object-contain bg-secondary shrink-0"
              referrerPolicy="no-referrer"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              data-testid="img-company-logo"
            />
          )}
          <div className="flex-1 space-y-2">
            <Label>Provider Name</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              required
              disabled={readOnly}
              data-testid="input-company-name"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Logo</Label>
          <div className="flex gap-2">
            <Input
              value={logoUrl}
              onChange={e => setLogoUrl(e.target.value)}
              placeholder="https://..."
              className="flex-1"
              disabled={readOnly}
              data-testid="input-company-logo"
            />
            {!readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => document.getElementById("company-logo-upload")?.click()}
                data-testid="btn-upload-company-logo"
              >
                <Upload className="w-4 h-4 mr-1" /> Upload
              </Button>
            )}
            <input
              id="company-logo-upload"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const formData = new FormData();
                formData.append("file", file);
                try {
                  const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
                  if (!res.ok) throw new Error("Upload failed");
                  const { url } = await res.json();
                  setLogoUrl(url);
                } catch (err: any) {
                  toast({ title: "Upload failed", description: err.message, variant: "destructive" });
                }
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Website URL</Label>
          <div className="relative">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={websiteUrl}
              onChange={e => setWebsiteUrl(e.target.value)}
              placeholder="https://..."
              className="pl-9"
              disabled={readOnly}
              data-testid="input-company-website"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>About</Label>
          <Textarea
            value={about}
            onChange={e => setAbout(e.target.value)}
            placeholder="Brief description of the provider..."
            rows={4}
            disabled={readOnly}
            data-testid="input-company-about"
          />
        </div>

        <div className="space-y-2">
          <Label>Phone</Label>
          <div className="relative">
            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+1 (555) 123-4567"
              className="pl-9"
              disabled={readOnly}
              data-testid="input-company-phone"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Year Founded</Label>
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={yearFounded}
              onChange={e => setYearFounded(e.target.value)}
              type="number"
              placeholder="e.g. 2010"
              min={1900}
              max={new Date().getFullYear()}
              className="pl-9"
              disabled={readOnly}
              data-testid="input-company-year"
            />
          </div>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-heading flex items-center gap-2">
          <Calendar className="w-5 h-5 text-primary" /> Scheduling & Consultations
        </h2>
        <p className="text-sm text-muted-foreground">
          Add your scheduling link so parents can book consultations directly through GoStork.
        </p>
        <div className="space-y-2">
          <Label>Consultation Booking Link</Label>
          <div className="relative">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={consultationBookingUrl}
              onChange={e => setConsultationBookingUrl(e.target.value)}
              placeholder="https://calendly.com/your-link or https://acuity.com/..."
              className="pl-9"
              disabled={readOnly}
              data-testid="input-consultation-booking-url"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Paste a Calendly, Acuity, or other scheduling link. Parents will be able to book directly.
          </p>
        </div>
        <div className="flex items-center gap-3 pt-2">
          <Checkbox
            id="consultation-iframe"
            checked={consultationIframeEnabled}
            onCheckedChange={(checked) => setConsultationIframeEnabled(checked === true)}
            disabled={readOnly || !consultationBookingUrl}
            data-testid="toggle-consultation-iframe"
          />
          <Label htmlFor="consultation-iframe" className="text-sm cursor-pointer">
            Enable in-app booking (load scheduling page within GoStork)
          </Label>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-heading flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" /> Document & Agreements
        </h2>
        <p className="text-sm text-muted-foreground">
          Connect your PandaDoc template to automatically generate and send agreements to parents after consultations.
        </p>
        <div className="space-y-2">
          <Label>PandaDoc Template ID</Label>
          <Input
            value={pandaDocTemplateId}
            onChange={e => setPandaDocTemplateId(e.target.value)}
            placeholder="e.g. abc123XYZ..."
            disabled={readOnly}
            data-testid="input-pandadoc-template-id"
          />
          <p className="text-xs text-muted-foreground">
            Find this in your PandaDoc account under Templates. The template will be used when generating agreements for parents.
          </p>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-heading flex items-center gap-2">
            <MapPin className="w-5 h-5 text-primary" /> Locations ({locations.length})
          </h2>
          {!readOnly && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const newLoc: LocationData = { address: "", city: "", state: "", zip: "", _sortId: nextSortId() };
                setLocations([newLoc, ...locations]);
              }}
              data-testid="btn-add-location"
            >
              <Plus className="w-3 h-3 mr-1" /> Add Location
            </Button>
          )}
        </div>
        {locations.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">No locations added yet.</p>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleLocationDragEnd}>
          <SortableContext items={locations.map((loc, idx) => getSortId(loc, idx))} strategy={verticalListSortingStrategy}>
            {locations.map((loc, idx) => {
              const sortId = getSortId(loc, idx);
              return (
                <SortableItem key={sortId} id={sortId} readOnly={readOnly}>
                  <div className="flex items-center gap-2" data-testid={`company-location-${idx}`}>
                    {readOnly ? (
                      <span className="text-sm">{[loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(", ")}</span>
                    ) : (
                      <>
                        <LocationAutocomplete
                          value={loc}
                          onChange={newLoc => {
                            const updated = [...locations];
                            updated[idx] = { ...updated[idx], ...newLoc };
                            setLocations(updated);
                          }}
                          className="h-8 text-sm"
                          data-testid={`input-company-location-${idx}`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setLocations(locations.filter((_, i) => i !== idx))}
                          data-testid={`btn-remove-location-${idx}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </SortableItem>
              );
            })}
          </SortableContext>
        </DndContext>
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-heading flex items-center gap-2">
          <Settings className="w-5 h-5 text-primary" /> Services
        </h2>
        {services && services.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {services.map((service: any) => (
              <Badge
                key={service.id}
                className={`${SERVICE_STATUS_STYLES[service.status] || ""} gap-1.5 py-1 px-2.5`}
                data-testid={`badge-service-${service.id}`}
              >
                <Check className="w-3 h-3" />
                {service.providerType?.name || "Service"}
                <span className="text-[10px] opacity-70 ml-1">{service.status?.replace("_", " ")}</span>
              </Badge>
            ))}
          </div>
        )}
        {!readOnly && availableServiceTypes.length > 0 && (
          <div className="flex items-end gap-3">
            <div className="flex-1 min-w-[200px]">
              <Select value={selectedServiceTypeId} onValueChange={setSelectedServiceTypeId}>
                <SelectTrigger data-testid="select-request-service-type">
                  <SelectValue placeholder="Add a service type..." />
                </SelectTrigger>
                <SelectContent>
                  {availableServiceTypes.map((t: any) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              onClick={() => selectedServiceTypeId && requestServiceMutation.mutate(selectedServiceTypeId)}
              disabled={!selectedServiceTypeId || requestServiceMutation.isPending}
              data-testid="button-submit-service-request"
            >
              {requestServiceMutation.isPending ? "Submitting..." : "Submit Request"}
            </Button>
          </div>
        )}
        {(!services || services.length === 0) && (readOnly || availableServiceTypes.length === 0) && (
          <p className="text-sm text-muted-foreground py-2">No services registered yet.</p>
        )}
      </Card>

      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-heading flex items-center gap-2">
            <User className="w-5 h-5 text-primary" /> Team Members ({teamMembers.length})
          </h2>
          {!readOnly && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const newMember: MemberData = { name: "", title: null, bio: null, photoUrl: null, _sortId: nextSortId() };
                setTeamMembers([newMember, ...teamMembers]);
                setEditingMemberIdx(0);
              }}
              data-testid="btn-add-member"
            >
              <Plus className="w-3 h-3 mr-1" /> Add Member
            </Button>
          )}
        </div>
        {teamMembers.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">No team members added yet.</p>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleMemberDragEnd}>
          <SortableContext items={teamMembers.map((m, idx) => getSortId(m, idx))} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {teamMembers.map((member, idx) => {
                const sortId = getSortId(member, idx);
                return (
                  <SortableItem key={sortId} id={sortId} disabled={editingMemberIdx === idx} readOnly={readOnly}>
                    <div className="border rounded-lg p-3" data-testid={`company-member-${idx}`}>
              {editingMemberIdx === idx && !readOnly ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={member.name}
                        onChange={e => {
                          const updated = [...teamMembers];
                          updated[idx] = { ...updated[idx], name: e.target.value };
                          setTeamMembers(updated);
                        }}
                        className="h-8 text-sm"
                        data-testid={`input-member-name-${idx}`}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Title</Label>
                      <Input
                        value={member.title || ""}
                        onChange={e => {
                          const updated = [...teamMembers];
                          updated[idx] = { ...updated[idx], title: e.target.value || null };
                          setTeamMembers(updated);
                        }}
                        className="h-8 text-sm"
                        data-testid={`input-member-title-${idx}`}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Bio</Label>
                    <Textarea
                      value={member.bio || ""}
                      onChange={e => {
                        const updated = [...teamMembers];
                        updated[idx] = { ...updated[idx], bio: e.target.value || null };
                        setTeamMembers(updated);
                      }}
                      rows={2}
                      className="text-sm"
                      data-testid={`input-member-bio-${idx}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Photo</Label>
                    <div className="flex gap-2">
                      <Input
                        value={member.photoUrl || ""}
                        onChange={e => {
                          const updated = [...teamMembers];
                          updated[idx] = { ...updated[idx], photoUrl: e.target.value || null };
                          setTeamMembers(updated);
                        }}
                        placeholder="Photo URL or upload →"
                        className="h-8 text-sm flex-1"
                        data-testid={`input-member-photo-${idx}`}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 px-2 shrink-0"
                        disabled={uploadingPhotoIdx === idx}
                        onClick={() => {
                          const input = document.createElement("input");
                          input.type = "file";
                          input.accept = "image/jpeg,image/png,image/webp,image/gif";
                          input.onchange = (e) => {
                            const file = (e.target as HTMLInputElement).files?.[0];
                            if (file) handlePhotoUpload(file, idx);
                          };
                          input.click();
                        }}
                        data-testid={`btn-upload-member-photo-${idx}`}
                      >
                        {uploadingPhotoIdx === idx ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Upload className="w-3.5 h-3.5" />
                        )}
                      </Button>
                    </div>
                    {member.photoUrl && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <img
                          src={getPhotoSrc(member.photoUrl)!}
                          alt={member.name}
                          className="w-10 h-10 rounded-full object-cover bg-secondary"
                          referrerPolicy="no-referrer"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                        <span className="text-xs text-muted-foreground truncate flex-1">{member.photoUrl.split("/").pop()}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            const updated = [...teamMembers];
                            updated[idx] = { ...updated[idx], photoUrl: null };
                            setTeamMembers(updated);
                          }}
                          data-testid={`btn-remove-member-photo-${idx}`}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {locations.length > 0 && (
                    <div className="space-y-1">
                      <Label className="text-xs">Assigned Locations</Label>
                      <div className="border rounded-lg p-2 space-y-1.5">
                        {locations.filter(l => l.id).map((loc) => (
                          <label key={loc.id} className="flex items-center gap-2 cursor-pointer">
                            <Checkbox
                              checked={(member.locationIds || []).includes(loc.id!)}
                              onCheckedChange={(checked) => {
                                const updated = [...teamMembers];
                                const currentIds = updated[idx].locationIds || [];
                                updated[idx] = {
                                  ...updated[idx],
                                  locationIds: checked
                                    ? [...currentIds, loc.id!]
                                    : currentIds.filter(id => id !== loc.id),
                                };
                                setTeamMembers(updated);
                              }}
                              data-testid={`checkbox-member-loc-${idx}-${loc.id}`}
                            />
                            <span className="text-xs">{loc.city}, {loc.state}{loc.address ? ` — ${loc.address}` : ""}</span>
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">Leave all unchecked = all locations</p>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditingMemberIdx(null)} data-testid={`btn-done-member-${idx}`}>
                      <Check className="w-3 h-3 mr-1" /> Done
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-muted-foreground shrink-0 text-sm font-ui relative overflow-hidden">
                    {member.name ? member.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() : "?"}
                    {member.photoUrl && (
                      <img
                        src={getPhotoSrc(member.photoUrl)!}
                        alt={member.name}
                        className="absolute inset-0 w-full h-full rounded-full object-cover"
                        referrerPolicy="no-referrer"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-ui text-sm" data-testid={`text-member-name-${idx}`}>{member.name || "New Member"}</div>
                    {member.title && <div className="text-xs text-muted-foreground" data-testid={`text-member-title-${idx}`}>{member.title}</div>}
                    {member.bio && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{member.bio}</div>}
                    {member.locationIds && member.locationIds.length > 0 ? (
                      <div className="text-xs text-accent-foreground mt-1 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {member.locationIds.map(lid => {
                          const loc = locations.find(l => l.id === lid);
                          return loc ? `${loc.city}, ${loc.state}` : "";
                        }).filter(Boolean).join(", ")}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground/60 mt-1 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        All locations
                      </div>
                    )}
                  </div>
                  {!readOnly && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => setEditingMemberIdx(idx)}
                        data-testid={`btn-edit-member-${idx}`}
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setTeamMembers(teamMembers.filter((_, i) => i !== idx))}
                        data-testid={`btn-remove-member-${idx}`}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                </div>
              )}
                    </div>
                  </SortableItem>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      </Card>

      {!readOnly && (
        <div className="flex justify-end">
          <Button type="submit" disabled={saving} className="px-8" data-testid="btn-save-company">
            {saving ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</>
            ) : (
              <><Save className="w-4 h-4 mr-2" /> Save</>
            )}
          </Button>
        </div>
      )}
    </form>
  );
}
