import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useProvider } from "@/hooks/use-providers";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { hasProviderRole } from "@shared/roles";
import { Button } from "@/components/ui/button";
import { SaveBar } from "@/components/ui/save-bar";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";
import {
  Building2, Loader2, Globe, Phone, Calendar, Plus, MapPin,
  Check, X, Upload, Pencil, Save, ImageIcon, User, GripVertical, Eye, Settings, ScanFace,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import ImageUploader from "@/components/image-uploader";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import LocationAutocomplete from "@/components/location-autocomplete";
import { CountryAutocompleteInput } from "@/components/ui/country-autocomplete-input";
import ManageServicesDialog, { SERVICE_STATUS_STYLES } from "@/components/manage-services-dialog";
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
import { PartnerProvidersCard } from "@/components/partner-providers-card";

/**
 * Prisma hands back `Json?` columns as JsonValue, which is anything. These
 * three are string lists everywhere they are written; coerce on read rather
 * than let an unexpected shape reach a .map() in the render.
 */
function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

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
  // Doctor profile self-entry
  specialties?: string[];
  languagesSpoken?: string[];
  acceptingNewPatients?: boolean;
  offersVideoVisits?: boolean;
};

// Comma-separated <-> string[] helpers for the tag-style inputs.
function csvToArr(s: string): string[] {
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

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

export default function CompanyTab({ providerId: providerIdProp }: { providerId?: string } = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Admin-on-behalf-of mode: the admin provider edit page passes the target
  // provider's id so GoStork admins edit that company, not the house org.
  const providerId = providerIdProp || (user as any)?.providerId;
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
  const [lgbtqCare, setLgbtqCare] = useState(false);
  const [clinicOffersVideo, setClinicOffersVideo] = useState(false);
  const [biometricMatchingAuthorized, setBiometricMatchingAuthorized] = useState(false);
  const [locations, setLocations] = useState<LocationData[]>([]);
  const [teamMembers, setTeamMembers] = useState<MemberData[]>([]);
  const [editingMemberIdx, setEditingMemberIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  // IVF Parents Matching Requirements
  const [ivfTwinsAllowed, setIvfTwinsAllowed] = useState(false);
  const [ivfGenderSelectionAllowed, setIvfGenderSelectionAllowed] = useState(false);
  const [ivfTransferFromOtherClinics, setIvfTransferFromOtherClinics] = useState(false);
  const [ivfMaxAgeIp1, setIvfMaxAgeIp1] = useState("");
  const [ivfMaxAgeIp2, setIvfMaxAgeIp2] = useState("");
  const [ivfBiologicalConnection, setIvfBiologicalConnection] = useState("");
  const [ivfAcceptingPatients, setIvfAcceptingPatients] = useState<string[]>([]);
  const [ivfEggDonorType, setIvfEggDonorType] = useState("");
  const [surrogacyCitizensNotAllowed, setSurrogacyCitizensNotAllowed] = useState<string[]>([]);
  // Partner providers: an agency's partner IVF clinics, or a clinic's
  // exclusive partner surrogacy agencies (shared PartnerProvidersCard).
  const [partnerProviderIds, setPartnerProviderIds] = useState<string[]>([]);
  const [surrogacyTwinsAllowed, setSurrogacyTwinsAllowed] = useState(false);
  const [surrogacyStayAfterBirthMonths, setSurrogacyStayAfterBirthMonths] = useState("");
  const [surrogacyBirthCertificateListing, setSurrogacyBirthCertificateListing] = useState<string[]>([]);
  const [surrogacySurrogateRemovableFromCert, setSurrogacySurrogateRemovableFromCert] = useState(false);
  // IVF Surrogate Matching Requirements
  const [ivfSurrogateAgeRange, setIvfSurrogateAgeRange] = useState<[number, number]>([18, 45]);
  const [ivfSurrogateBmiRange, setIvfSurrogateBmiRange] = useState<[number, number]>([18, 35]);
  const [ivfSurrogateDeliveriesRange, setIvfSurrogateDeliveriesRange] = useState<[number, number]>([1, 5]);
  const [ivfSurrogateMaxCSections, setIvfSurrogateMaxCSections] = useState("");
  const [ivfSurrogateMaxMiscarriages, setIvfSurrogateMaxMiscarriages] = useState("");
  const [ivfSurrogateMaxAbortions, setIvfSurrogateMaxAbortions] = useState("");
  const [ivfSurrogateMaxYearsFromLastPregnancy, setIvfSurrogateMaxYearsFromLastPregnancy] = useState("");
  const [ivfSurrogateMonthsPostVaginal, setIvfSurrogateMonthsPostVaginal] = useState("");
  const [ivfSurrogateCovidVaccination, setIvfSurrogateCovidVaccination] = useState(false);
  const [ivfSurrogateGdDiet, setIvfSurrogateGdDiet] = useState(false);
  const [ivfSurrogateGdMedication, setIvfSurrogateGdMedication] = useState(false);
  const [ivfSurrogateHighBloodPressure, setIvfSurrogateHighBloodPressure] = useState(false);
  const [ivfSurrogatePlacentaPrevia, setIvfSurrogatePlacentaPrevia] = useState(false);
  const [ivfSurrogatePreeclampsia, setIvfSurrogatePreeclampsia] = useState(false);
  const [ivfSurrogateMentalHealthHistory, setIvfSurrogateMentalHealthHistory] = useState("");
  const isInitializingRef = useRef(false);
  const companyFormRef = useRef<HTMLFormElement | null>(null);
  const [manageServicesOpen, setManageServicesOpen] = useState(false);

  const services = provider?.services as any[] | undefined;

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

  // Track which provider snapshot the form was initialized from. Re-sync
  // whenever a NEWER row arrives (post-save refetch, cache -> fresh) so the
  // form never sticks on stale cached values - but never clobber in-flight
  // edits (isDirty guard).
  const lastInitStampRef = useRef<string | null>(null);
  useEffect(() => {
    if (provider) {
      const stamp = String((provider as any).updatedAt ?? provider.id);
      if (initialized && (lastInitStampRef.current === stamp || isDirty)) return;
      lastInitStampRef.current = stamp;
      isInitializingRef.current = true;
      setName(provider.name || "");
      setAbout(provider.about || "");
      setLogoUrl(provider.logoUrl || "");
      setWebsiteUrl(provider.websiteUrl || "");
      setPhone(provider.phone || "");
      setYearFounded(provider.yearFounded ? String(provider.yearFounded) : "");
      setLgbtqCare(provider.lgbtqCare || false);
      setClinicOffersVideo(provider.offersVideoVisits ?? true);
      setBiometricMatchingAuthorized((provider as any).biometricMatchingAuthorized ?? true);
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
          specialties: m.specialties || [],
          languagesSpoken: m.languagesSpoken || [],
          acceptingNewPatients: m.acceptingNewPatients ?? true,
          offersVideoVisits: m.offersVideoVisits ?? false,
        }))
      );
      // IVF Parents Matching Requirements
      setIvfTwinsAllowed(provider.ivfTwinsAllowed ?? false);
      setIvfGenderSelectionAllowed(provider.ivfGenderSelectionAllowed ?? false);
      setIvfTransferFromOtherClinics(provider.ivfTransferFromOtherClinics ?? false);
      setIvfMaxAgeIp1(provider.ivfMaxAgeIp1 != null ? String(provider.ivfMaxAgeIp1) : "");
      setIvfMaxAgeIp2(provider.ivfMaxAgeIp2 != null ? String(provider.ivfMaxAgeIp2) : "");
      setIvfBiologicalConnection(provider.ivfBiologicalConnection || "");
      setIvfAcceptingPatients(toStringArray(provider.ivfAcceptingPatients));
      setIvfEggDonorType(provider.ivfEggDonorType || "");
      setSurrogacyCitizensNotAllowed(toStringArray(provider.surrogacyCitizensNotAllowed));
      setSurrogacyTwinsAllowed(provider.surrogacyTwinsAllowed ?? false);
      setSurrogacyStayAfterBirthMonths(provider.surrogacyStayAfterBirthMonths != null ? String(provider.surrogacyStayAfterBirthMonths) : "");
      // Legacy rows stored a single string here before it became a list.
      setSurrogacyBirthCertificateListing(
        Array.isArray(provider.surrogacyBirthCertificateListing)
          ? toStringArray(provider.surrogacyBirthCertificateListing)
          : typeof provider.surrogacyBirthCertificateListing === "string" && provider.surrogacyBirthCertificateListing
            ? [provider.surrogacyBirthCertificateListing]
            : []
      );
      setSurrogacySurrogateRemovableFromCert(provider.surrogacySurrogateRemovableFromCert === true);
      // IVF Surrogate Matching Requirements
      setIvfSurrogateAgeRange([provider.ivfSurrogateMinAge ?? 18, provider.ivfSurrogateMaxAge ?? 45]);
      setIvfSurrogateBmiRange([provider.ivfSurrogateMinBmi ?? 18, provider.ivfSurrogateMaxBmi ?? 35]);
      setIvfSurrogateDeliveriesRange([provider.ivfSurrogateMinDeliveries ?? 1, provider.ivfSurrogateMaxDeliveries ?? 5]);
      setIvfSurrogateMaxCSections(provider.ivfSurrogateMaxCSections != null ? String(provider.ivfSurrogateMaxCSections) : "");
      setIvfSurrogateMaxMiscarriages(provider.ivfSurrogateMaxMiscarriages != null ? String(provider.ivfSurrogateMaxMiscarriages) : "");
      setIvfSurrogateMaxAbortions(provider.ivfSurrogateMaxAbortions != null ? String(provider.ivfSurrogateMaxAbortions) : "");
      setIvfSurrogateMaxYearsFromLastPregnancy(provider.ivfSurrogateMaxYearsFromLastPregnancy != null ? String(provider.ivfSurrogateMaxYearsFromLastPregnancy) : "");
      setIvfSurrogateMonthsPostVaginal(provider.ivfSurrogateMonthsPostVaginal != null ? String(provider.ivfSurrogateMonthsPostVaginal) : "");
      setIvfSurrogateCovidVaccination(provider.ivfSurrogateCovidVaccination ?? false);
      setIvfSurrogateGdDiet(provider.ivfSurrogateGdDiet ?? false);
      setIvfSurrogateGdMedication(provider.ivfSurrogateGdMedication ?? false);
      setIvfSurrogateHighBloodPressure(provider.ivfSurrogateHighBloodPressure ?? false);
      setIvfSurrogatePlacentaPrevia(provider.ivfSurrogatePlacentaPrevia ?? false);
      setIvfSurrogatePreeclampsia(provider.ivfSurrogatePreeclampsia ?? false);
      setIvfSurrogateMentalHealthHistory(provider.ivfSurrogateMentalHealthHistory || "");
      setPartnerProviderIds(Array.isArray((provider as any).partnerProviderIds) ? (provider as any).partnerProviderIds : []);
      setInitialized(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, initialized, isDirty]);

  useEffect(() => {
    if (!initialized) { setIsDirty(false); return; }
    if (isInitializingRef.current) { isInitializingRef.current = false; setIsDirty(false); return; }
    setIsDirty(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, name, about, logoUrl, websiteUrl, phone, yearFounded, locations, teamMembers, ivfSurrogateAgeRange, ivfSurrogateBmiRange, ivfSurrogateDeliveriesRange, ivfSurrogateMaxCSections, ivfSurrogateMaxMiscarriages, ivfSurrogateMaxAbortions, ivfSurrogateMaxYearsFromLastPregnancy, ivfSurrogateMonthsPostVaginal, ivfSurrogateCovidVaccination, ivfSurrogateGdDiet, ivfSurrogateGdMedication, ivfSurrogateHighBloodPressure, ivfSurrogatePlacentaPrevia, ivfSurrogatePreeclampsia, ivfSurrogateMentalHealthHistory, ivfTwinsAllowed, ivfGenderSelectionAllowed, ivfTransferFromOtherClinics, ivfMaxAgeIp1, ivfMaxAgeIp2, ivfBiologicalConnection, ivfAcceptingPatients, ivfEggDonorType, surrogacyCitizensNotAllowed, surrogacyTwinsAllowed, surrogacyStayAfterBirthMonths, surrogacyBirthCertificateListing, surrogacySurrogateRemovableFromCert, partnerProviderIds]);

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
        // Clinic marketplace self-entry
        offersVideoVisits: clinicOffersVideo,
        ...(hasDonorServices ? { biometricMatchingAuthorized } : {}),
        ...(isIvfClinic || isSurrogacyAgency ? { partnerProviderIds: partnerProviderIds.length > 0 ? partnerProviderIds : null } : {}),
        // IVF Parents Matching Requirements
        ivfTwinsAllowed,
        ivfGenderSelectionAllowed,
        ivfTransferFromOtherClinics,
        ivfMaxAgeIp1: ivfMaxAgeIp1 ? parseInt(ivfMaxAgeIp1) : null,
        ivfMaxAgeIp2: ivfMaxAgeIp2 ? parseInt(ivfMaxAgeIp2) : null,
        ivfBiologicalConnection: ivfBiologicalConnection || null,
        ivfAcceptingPatients: ivfAcceptingPatients.length > 0 ? ivfAcceptingPatients : null,
        ivfEggDonorType: ivfEggDonorType || null,
        surrogacyCitizensNotAllowed: surrogacyCitizensNotAllowed.length > 0 ? surrogacyCitizensNotAllowed : null,
        surrogacyTwinsAllowed,
        surrogacyStayAfterBirthMonths: surrogacyStayAfterBirthMonths ? parseInt(surrogacyStayAfterBirthMonths) : null,
        surrogacyBirthCertificateListing: surrogacyBirthCertificateListing.length > 0 ? surrogacyBirthCertificateListing : null,
        surrogacySurrogateRemovableFromCert,
        // IVF Surrogate Matching Requirements
        ivfSurrogateMinAge: ivfSurrogateAgeRange[0],
        ivfSurrogateMaxAge: ivfSurrogateAgeRange[1],
        ivfSurrogateMinBmi: ivfSurrogateBmiRange[0],
        ivfSurrogateMaxBmi: ivfSurrogateBmiRange[1],
        ivfSurrogateMinDeliveries: ivfSurrogateDeliveriesRange[0],
        ivfSurrogateMaxDeliveries: ivfSurrogateDeliveriesRange[1],
        ivfSurrogateMaxCSections: ivfSurrogateMaxCSections ? parseInt(ivfSurrogateMaxCSections) : null,
        ivfSurrogateMaxMiscarriages: ivfSurrogateMaxMiscarriages ? parseInt(ivfSurrogateMaxMiscarriages) : null,
        ivfSurrogateMaxAbortions: ivfSurrogateMaxAbortions ? parseInt(ivfSurrogateMaxAbortions) : null,
        ivfSurrogateMaxYearsFromLastPregnancy: ivfSurrogateMaxYearsFromLastPregnancy ? parseInt(ivfSurrogateMaxYearsFromLastPregnancy) : null,
        ivfSurrogateMonthsPostVaginal: ivfSurrogateMonthsPostVaginal ? parseInt(ivfSurrogateMonthsPostVaginal) : null,
        ivfSurrogateCovidVaccination,
        ivfSurrogateGdDiet,
        ivfSurrogateGdMedication,
        ivfSurrogateHighBloodPressure,
        ivfSurrogatePlacentaPrevia,
        ivfSurrogatePreeclampsia,
        ivfSurrogateMentalHealthHistory: ivfSurrogateMentalHealthHistory || null,
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
          try { await apiRequest("PUT", `/api/providers/${provider.id}/members/${member.id}`, { name: member.name, title: member.title || null, bio: member.bio || null, photoUrl: member.photoUrl || null, isMedicalDirector: member.isMedicalDirector || false, sortOrder: i, locationIds: member.locationIds || [], specialties: member.specialties || [], languagesSpoken: member.languagesSpoken || [], acceptingNewPatients: member.acceptingNewPatients ?? true, offersVideoVisits: member.offersVideoVisits ?? false }); } catch (e: any) { errors.push(`Update member "${member.name}": ${e.message}`); }
        } else if (!member.id || !existingMemberIds.has(member.id)) {
          try { await apiRequest("POST", `/api/providers/${provider.id}/members`, { name: member.name, title: member.title || null, bio: member.bio || null, photoUrl: member.photoUrl || null, isMedicalDirector: member.isMedicalDirector || false, sortOrder: i, locationIds: member.locationIds || [], specialties: member.specialties || [], languagesSpoken: member.languagesSpoken || [], acceptingNewPatients: member.acceptingNewPatients ?? true, offersVideoVisits: member.offersVideoVisits ?? false }); } catch (e: any) { errors.push(`Add member "${member.name}": ${e.message}`); }
        }
      }

      queryClient.invalidateQueries({ queryKey: [api.providers.get.path, provider.id] });
      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
      setInitialized(false);
      setIsDirty(false);
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
  const svcNames = (services || []).map((s: any) => s.providerType?.name?.toLowerCase() || "");
  const isIvfClinic = svcNames.some((n: string) => n.includes("ivf") || n.includes("in vitro"));
  const isSurrogacyAgency = svcNames.some((n: string) => n.includes("surrogacy"));
  // The GoStork house provider's Surrogate Matching Requirements define the
  // platform ASRM minimums; it never matches parents itself, so the Parents
  // Matching Requirements section is hidden for it only.
  const isGoStorkHouse = ((provider as any)?.name || "").trim().toLowerCase() === "gostork";
  const ivfOffersEggDonors = svcNames.some((n: string) => n.includes("egg donor") || n.includes("egg bank"));
  // Agencies that actually have donors/surrogates - the only ones for whom the
  // biometric face-matching authorization is relevant (hidden for pure clinics).
  const hasDonorServices = svcNames.some((n: string) =>
    n.includes("egg donor") || n.includes("egg bank") || n.includes("sperm") || n.includes("surrogacy"),
  );

  return (
    <>
    <form ref={companyFormRef} onSubmit={handleSave} className="space-y-8" data-testid="company-form">
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
              className="w-16 h-16 rounded-[var(--radius)] object-contain bg-background p-0.5 border border-border/30 shrink-0"
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
          <ImageUploader
            value={logoUrl || null}
            onChange={(url) => setLogoUrl(url || "")}
            mode="logo"
            variant="dropzone"
            disabled={readOnly}
            testId="company-logo"
          />
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

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <Checkbox checked={clinicOffersVideo} onCheckedChange={(v) => setClinicOffersVideo(!!v)} disabled={readOnly} data-testid="checkbox-company-video" />
          Offers video visits
        </label>

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
            {/* short date field (4-digit year), no commas needed */}
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
          <p className="t-helper py-2">No locations added yet.</p>
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

      {/* The GoStork house profile is the concierge team, not a provider -
          its "approved services" were only ever scaffolding and caused it to
          masquerade as an agency/clinic. Section hidden for the house. */}
      {!isGoStorkHouse && (
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-heading flex items-center gap-2">
            <Settings className="w-5 h-5 text-primary" /> Services
          </h2>
          {isGostorkAdmin && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setManageServicesOpen(true)}
              data-testid="button-manage-services"
            >
              <Plus className="w-3 h-3 mr-1" />
              {services && services.length > 0 ? "Manage Services" : "Add Service"}
            </Button>
          )}
        </div>
        {services && services.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {services.map((service: any) => (
              <Badge
                key={service.id}
                className={`text-xs ${SERVICE_STATUS_STYLES[service.status] || ""}`}
                data-testid={`badge-service-${service.id}`}
              >
                {service.providerType?.name || "Service"}: {service.status?.replace("_", " ")}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="t-helper py-2">No services registered yet.</p>
        )}
      </Card>
      )}

      {!isGoStorkHouse && (isIvfClinic || isSurrogacyAgency) && (
        <PartnerProvidersCard
          editingType={isSurrogacyAgency ? "surrogacy-agency" : "ivf-clinic"}
          selfId={providerId}
          value={partnerProviderIds}
          onChange={setPartnerProviderIds}
          readOnly={readOnly}
        />
      )}

      {hasDonorServices && (
        <Card className="p-6 space-y-4">
          <h2 className="text-lg font-heading flex items-center gap-2">
            <ScanFace className="w-5 h-5 text-primary" /> Look-Alike Face Matching
          </h2>
          <p className="t-helper">
            GoStork creates a faceprint from your donors' / surrogates' profile photos (processed via AWS Rekognition) so intended parents can find profiles that resemble them. This is biometric processing and is enabled by default under your agency agreement. If you have not obtained the necessary biometric consent from your donors and surrogates, turn it off - your profiles will then be excluded and their faceprints removed.
          </p>
          <label className="flex items-start gap-3 text-sm cursor-pointer rounded-[var(--radius)] bg-secondary p-4">
            <Checkbox
              className="mt-0.5"
              checked={biometricMatchingAuthorized}
              onCheckedChange={(v) => { if (!readOnly) setBiometricMatchingAuthorized(!!v); }}
              disabled={readOnly}
              data-testid="checkbox-biometric-authorized"
            />
            <span>
              {name || "Our agency"} has obtained the consents required for GoStork to generate and store faceprints of our donors and surrogates for look-alike matching.
              {biometricMatchingAuthorized
                ? " (Enabled) Turning this off removes all of our profiles' faceprints from the matching index."
                : " (Disabled) Our profiles are excluded from look-alike matching."}
            </span>
          </label>
        </Card>
      )}

      {!isGoStorkHouse && (isIvfClinic || isSurrogacyAgency) && (
        <Card className="p-6 space-y-6">
          <h2 className="text-lg font-heading flex items-center gap-2">
            <Check className="w-5 h-5 text-primary" /> Parents Matching Requirements
          </h2>

          {isIvfClinic && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Checkbox id="ivf-twins" checked={ivfTwinsAllowed} onCheckedChange={(v) => setIvfTwinsAllowed(!!v)} disabled={readOnly} />
                <label htmlFor="ivf-twins" className="text-sm cursor-pointer">Twins allowed</label>
              </div>
              <div className="flex items-center gap-3">
                <Checkbox id="ivf-gender-selection" checked={ivfGenderSelectionAllowed} onCheckedChange={(v) => setIvfGenderSelectionAllowed(!!v)} disabled={readOnly} />
                <label htmlFor="ivf-gender-selection" className="text-sm cursor-pointer">Gender selection allowed</label>
              </div>
              <div className="flex items-center gap-3">
                <Checkbox id="ivf-transfer" checked={ivfTransferFromOtherClinics} onCheckedChange={(v) => setIvfTransferFromOtherClinics(!!v)} disabled={readOnly} />
                <label htmlFor="ivf-transfer" className="text-sm cursor-pointer">Transferring embryos from other clinics allowed</label>
              </div>
              <div className="flex gap-8">
                <div className="space-y-2">
                  <Label>Max Age of IP 1</Label>
                  <NumberInput allowDecimal={false} value={ivfMaxAgeIp1} onChange={setIvfMaxAgeIp1} placeholder="e.g. 50" disabled={readOnly} />
                </div>
                <div className="space-y-2">
                  <Label>Max Age of IP 2</Label>
                  <NumberInput allowDecimal={false} value={ivfMaxAgeIp2} onChange={setIvfMaxAgeIp2} placeholder="e.g. 55" disabled={readOnly} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Biological connection to embryos</Label>
                <Select value={ivfBiologicalConnection} onValueChange={setIvfBiologicalConnection} disabled={readOnly}>
                  <SelectTrigger className="w-auto min-w-[220px]">
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No connection required</SelectItem>
                    <SelectItem value="at_least_one">At least one biological parent</SelectItem>
                    <SelectItem value="at_least_two">At least two biological parents</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Accepting patients that are</Label>
                <div className="flex flex-col gap-2">
                  {[
                    { value: "single_woman", label: "Single woman" },
                    { value: "single_man", label: "Single man" },
                    { value: "gay_couple", label: "Gay couple" },
                    { value: "straight_couple", label: "Straight couple" },
                    { value: "straight_married_couple", label: "Straight married couple" },
                  ].map(opt => (
                    <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={ivfAcceptingPatients.includes(opt.value)}
                        disabled={readOnly}
                        onCheckedChange={(v) => {
                          if (v) setIvfAcceptingPatients([...ivfAcceptingPatients, opt.value]);
                          else setIvfAcceptingPatients(ivfAcceptingPatients.filter(x => x !== opt.value));
                        }}
                      />
                      <span className="text-sm">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              {ivfOffersEggDonors && (
                <div className="space-y-2">
                  <Label>Egg donor type</Label>
                  <Select value={ivfEggDonorType} onValueChange={setIvfEggDonorType} disabled={readOnly}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anonymous">Anonymous</SelectItem>
                      <SelectItem value="known">Known</SelectItem>
                      <SelectItem value="both">Both</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {isSurrogacyAgency && (
            <div className="space-y-4">
              {isIvfClinic && <div className="border-t border-border pt-4" />}
              <div className="space-y-2">
                <Label>Citizens not allowed (countries)</Label>
                <div className="max-w-xs">
                  <CountryAutocompleteInput
                    value={surrogacyCitizensNotAllowed}
                    onChange={readOnly ? () => {} : setSurrogacyCitizensNotAllowed}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Checkbox id="surrogacy-twins" checked={surrogacyTwinsAllowed} onCheckedChange={(v) => setSurrogacyTwinsAllowed(!!v)} disabled={readOnly} />
                <label htmlFor="surrogacy-twins" className="text-sm cursor-pointer">Twins allowed</label>
              </div>
              <div className="flex items-center gap-3">
                <Checkbox id="surrogacy-removable-cert" checked={surrogacySurrogateRemovableFromCert} onCheckedChange={(v) => setSurrogacySurrogateRemovableFromCert(!!v)} disabled={readOnly} />
                <label htmlFor="surrogacy-removable-cert" className="text-sm cursor-pointer">Surrogate can be removed from birth certificate?</label>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm">How long do IPs need to stay after baby is born (months)</label>
                <NumberInput allowDecimal={false} value={surrogacyStayAfterBirthMonths} onChange={setSurrogacyStayAfterBirthMonths} placeholder="e.g. 2" className="w-24" disabled={readOnly} />
              </div>
              <div className="space-y-2">
                <Label>Who is listed on the birth certificate?</Label>
                <div className="space-y-2">
                  {[
                    { value: "surrogate", label: "Surrogate" },
                    { value: "biological_father", label: "Biological father" },
                    { value: "biological_mother", label: "Biological mother" },
                    { value: "both_biological_parents", label: "Both biological parents" },
                  ].map(({ value, label }) => {
                    const isBothSelected = surrogacyBirthCertificateListing.includes("both_biological_parents");
                    const isDisabled = readOnly || (isBothSelected && (value === "biological_father" || value === "biological_mother"));
                    return (
                      <div key={value} className="flex items-center gap-3">
                        <Checkbox
                          id={`birth-cert-${value}`}
                          checked={surrogacyBirthCertificateListing.includes(value)}
                          disabled={isDisabled}
                          onCheckedChange={(checked) => {
                            if (value === "both_biological_parents") {
                              setSurrogacyBirthCertificateListing(checked
                                ? [...surrogacyBirthCertificateListing.filter(v => v !== "biological_father" && v !== "biological_mother"), "both_biological_parents"]
                                : surrogacyBirthCertificateListing.filter(v => v !== "both_biological_parents")
                              );
                            } else {
                              setSurrogacyBirthCertificateListing(checked
                                ? [...surrogacyBirthCertificateListing, value]
                                : surrogacyBirthCertificateListing.filter(v => v !== value)
                              );
                            }
                          }}
                        />
                        <label htmlFor={`birth-cert-${value}`} className={`text-sm cursor-pointer${isDisabled ? " text-muted-foreground opacity-50" : ""}`}>{label}</label>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      {(isIvfClinic || isGoStorkHouse) && (
        <Card className="p-6 space-y-6">
          <div className="space-y-1">
            <h2 className="text-lg font-heading flex items-center gap-2">
              <Check className="w-5 h-5 text-primary" />
              {isGoStorkHouse ? "Platform Surrogate Minimums (ASRM)" : "Surrogate Matching Requirements"}
            </h2>
            {isGoStorkHouse && (
              <p className="t-helper">
                These values are the platform-wide ASRM minimums. Surrogates who fail them are
                automatically hidden from ALL parents across every agency - this is not a
                per-provider preference.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Age Range of Surrogate: <span className="text-primary font-ui">{ivfSurrogateAgeRange[0]} - {ivfSurrogateAgeRange[1]} years</span></Label>
            <Slider
              min={18} max={45} step={1}
              value={ivfSurrogateAgeRange}
              onValueChange={(v) => { if (!readOnly) setIvfSurrogateAgeRange(v as [number, number]); }}
              className="max-w-sm"
              disabled={readOnly}
            />
          </div>
          <div className="space-y-2">
            <Label>BMI Range of Surrogate: <span className="text-primary font-ui">{ivfSurrogateBmiRange[0]} - {ivfSurrogateBmiRange[1]}</span></Label>
            <Slider
              min={18} max={35} step={0.5}
              value={ivfSurrogateBmiRange}
              onValueChange={(v) => { if (!readOnly) setIvfSurrogateBmiRange(v as [number, number]); }}
              className="max-w-sm"
              disabled={readOnly}
            />
          </div>
          <div className="space-y-2">
            <Label>Deliveries Range of Surrogate: <span className="text-primary font-ui">{ivfSurrogateDeliveriesRange[0]} - {ivfSurrogateDeliveriesRange[1]}</span></Label>
            <Slider
              min={0} max={10} step={1}
              value={ivfSurrogateDeliveriesRange}
              onValueChange={(v) => { if (!readOnly) setIvfSurrogateDeliveriesRange(v as [number, number]); }}
              className="max-w-sm"
              disabled={readOnly}
            />
          </div>
          <div className="grid grid-cols-2 gap-4 max-w-lg">
            <div className="space-y-2">
              <Label>Max C-Sections</Label>
              <NumberInput allowDecimal={false} value={ivfSurrogateMaxCSections} onChange={setIvfSurrogateMaxCSections} placeholder="e.g. 3" disabled={readOnly} />
            </div>
            <div className="space-y-2">
              <Label>Max Miscarriages</Label>
              <NumberInput allowDecimal={false} value={ivfSurrogateMaxMiscarriages} onChange={setIvfSurrogateMaxMiscarriages} placeholder="e.g. 2" disabled={readOnly} />
            </div>
            <div className="space-y-2">
              <Label>Max Abortions</Label>
              <NumberInput allowDecimal={false} value={ivfSurrogateMaxAbortions} onChange={setIvfSurrogateMaxAbortions} placeholder="e.g. 2" disabled={readOnly} />
            </div>
            <div className="space-y-2">
              <Label className="whitespace-nowrap">Max Years from Last Pregnancy</Label>
              <NumberInput allowDecimal={false} value={ivfSurrogateMaxYearsFromLastPregnancy} onChange={setIvfSurrogateMaxYearsFromLastPregnancy} placeholder="e.g. 5" disabled={readOnly} />
            </div>
            <div className="space-y-2">
              <Label className="whitespace-nowrap">Months Post Vaginal Delivery</Label>
              <NumberInput allowDecimal={false} value={ivfSurrogateMonthsPostVaginal} onChange={setIvfSurrogateMonthsPostVaginal} placeholder="e.g. 6" disabled={readOnly} />
            </div>
          </div>
          <div className="space-y-3">
            <p className="t-helper font-ui">Accepted Surrogate Medical History</p>
            {[
              { label: "Covid Vaccination Required", value: ivfSurrogateCovidVaccination, set: setIvfSurrogateCovidVaccination },
              { label: "Gestational Diabetes (controlled by diet)", value: ivfSurrogateGdDiet, set: setIvfSurrogateGdDiet },
              { label: "Gestational Diabetes (controlled with medication)", value: ivfSurrogateGdMedication, set: setIvfSurrogateGdMedication },
              { label: "High Blood Pressure / Gestational Hypertension", value: ivfSurrogateHighBloodPressure, set: setIvfSurrogateHighBloodPressure },
              { label: "Placenta Previa", value: ivfSurrogatePlacentaPrevia, set: setIvfSurrogatePlacentaPrevia },
              { label: "Preeclampsia in Most Recent Pregnancy", value: ivfSurrogatePreeclampsia, set: setIvfSurrogatePreeclampsia },
            ].map(({ label, value, set }) => (
              <div key={label} className="flex items-center justify-between max-w-sm">
                <span className="text-sm">{label}</span>
                <div className="flex items-center gap-2">
                  <span className="t-helper w-6">{value ? "Yes" : "No"}</span>
                  <Switch checked={value} onCheckedChange={set} disabled={readOnly} />
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <Label>Mental Health History Notes</Label>
            <Textarea
              value={ivfSurrogateMentalHealthHistory}
              onChange={e => setIvfSurrogateMentalHealthHistory(e.target.value)}
              placeholder="Describe mental health history requirements or notes..."
              rows={4}
              disabled={readOnly}
            />
          </div>
        </Card>
      )}

      {/* The house profile's public page has no team display - GoStork staff
          live in the Team tab (login accounts). Real providers keep this: it
          feeds the team section parents see on clinic/agency public profiles. */}
      {!isGoStorkHouse && (
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
          <p className="t-helper py-2">No team members added yet.</p>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleMemberDragEnd}>
          <SortableContext items={teamMembers.map((m, idx) => getSortId(m, idx))} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {teamMembers.map((member, idx) => {
                const sortId = getSortId(member, idx);
                return (
                  <SortableItem key={sortId} id={sortId} disabled={editingMemberIdx === idx} readOnly={readOnly}>
                    <div className="border rounded-[var(--radius)] p-3" data-testid={`company-member-${idx}`}>
              {editingMemberIdx === idx && !readOnly ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="t-form-label-sm">Name</Label>
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
                      <Label className="t-form-label-sm">Title</Label>
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
                    <Label className="t-form-label-sm">Bio</Label>
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
                    <Label className="t-form-label-sm">Specialties <span className="text-muted-foreground">(comma-separated)</span></Label>
                    <Input
                      value={(member.specialties || []).join(", ")}
                      onChange={e => {
                        const updated = [...teamMembers];
                        updated[idx] = { ...updated[idx], specialties: csvToArr(e.target.value) };
                        setTeamMembers(updated);
                      }}
                      placeholder="e.g. Male Factor Infertility, LGBTQ+ Family Building, PCOS"
                      className="h-8 text-sm"
                      data-testid={`input-member-specialties-${idx}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="t-form-label-sm">Languages spoken <span className="text-muted-foreground">(comma-separated)</span></Label>
                    <Input
                      value={(member.languagesSpoken || []).join(", ")}
                      onChange={e => {
                        const updated = [...teamMembers];
                        updated[idx] = { ...updated[idx], languagesSpoken: csvToArr(e.target.value) };
                        setTeamMembers(updated);
                      }}
                      placeholder="e.g. English, Spanish"
                      className="h-8 text-sm"
                      data-testid={`input-member-languages-${idx}`}
                    />
                  </div>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <Checkbox
                        checked={member.acceptingNewPatients ?? true}
                        onCheckedChange={(v) => {
                          const updated = [...teamMembers];
                          updated[idx] = { ...updated[idx], acceptingNewPatients: !!v };
                          setTeamMembers(updated);
                        }}
                        data-testid={`checkbox-member-accepting-${idx}`}
                      />
                      Accepting new patients
                    </label>
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <Checkbox
                        checked={member.offersVideoVisits ?? false}
                        onCheckedChange={(v) => {
                          const updated = [...teamMembers];
                          updated[idx] = { ...updated[idx], offersVideoVisits: !!v };
                          setTeamMembers(updated);
                        }}
                        data-testid={`checkbox-member-video-${idx}`}
                      />
                      Offers video visits
                    </label>
                  </div>
                  <div className="space-y-1">
                    <Label className="t-form-label-sm">Photo</Label>
                    <ImageUploader
                      value={member.photoUrl}
                      onChange={(url) => {
                        const updated = [...teamMembers];
                        updated[idx] = { ...updated[idx], photoUrl: url };
                        setTeamMembers(updated);
                      }}
                      mode="avatar"
                      variant="avatar"
                      size={96}
                      testId={`member-photo-${idx}`}
                    />
                  </div>
                  {locations.length > 0 && (
                    <div className="space-y-1">
                      <Label className="t-form-label-sm">Assigned Locations</Label>
                      <div className="border rounded-[var(--radius)] p-2 space-y-1.5">
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
                            <span className="text-xs">{loc.city}, {loc.state}{loc.address ? ` - ${loc.address}` : ""}</span>
                          </label>
                        ))}
                      </div>
                      <p className="t-helper">Leave all unchecked = all locations</p>
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
                  <div className="t-helper w-12 h-12 rounded-full bg-secondary flex items-center justify-center shrink-0 font-ui relative overflow-hidden">
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
                    {member.title && <div className="t-helper" data-testid={`text-member-title-${idx}`}>{member.title}</div>}
                    {member.bio && <div className="t-helper mt-1 line-clamp-2">{member.bio}</div>}
                    {member.locationIds && member.locationIds.length > 0 ? (
                      <div className="text-xs text-accent-foreground mt-1 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {member.locationIds.map(lid => {
                          const loc = locations.find(l => l.id === lid);
                          return loc ? `${loc.city}, ${loc.state}` : "";
                        }).filter(Boolean).join(", ")}
                      </div>
                    ) : (
                      <div className="t-helper mt-1 flex items-center gap-1">
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
      )}

      <SaveBar
        visible={!readOnly && isDirty}
        position="fixed"
        testId="company-save-bar"
        discardLabel="Cancel"
        saveLabel="Save"
        saving={saving}
        onDiscard={() => setInitialized(false)}
        onSave={() => companyFormRef.current?.requestSubmit()}
      />
    </form>
    <ManageServicesDialog
      provider={provider ? { id: provider.id, name: provider.name, services: provider.services } : null}
      open={manageServicesOpen}
      onOpenChange={(open) => {
        setManageServicesOpen(open);
        if (!open) {
          queryClient.invalidateQueries({ queryKey: [api.providers.get.path, providerId] });
        }
      }}
    />
    </>
  );
}
