import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@shared/routes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Building2, Loader2, Pencil, Globe, Phone, Calendar, Sparkles, MapPin, Check, X, Upload, User, Plus, GripVertical, Eye, Palette, DollarSign } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import LocationAutocomplete from "@/components/location-autocomplete";
import { CountryAutocompleteInput } from "@/components/ui/country-autocomplete-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import MembersTable from "@/components/members-table";
import ProfileDatabasePanel from "@/components/profile-database-panel";
import ProviderCostsTab from "@/components/provider-costs-tab";
import { BrandSettingsForm } from "@/pages/admin-brand-settings-page";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
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

type ScrapedTeamMember = {
  id?: string;
  _sortId?: string;
  name: string;
  title: string | null;
  bio: string | null;
  photoUrl: string | null;
  locationHints?: string[];
  locationIds?: string[];
  isMedicalDirector?: boolean;
};

let _sortCounter = 0;
function nextSortId() {
  return `sort_${++_sortCounter}_${Date.now()}`;
}

function getSortId(item: any, idx: number): string {
  return item._sortId || item.id || `idx_${idx}`;
}

function SortableItem({ id, children, disabled }: { id: string; children: React.ReactNode; disabled?: boolean }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 10 : "auto" as any,
  };

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

type ScrapedData = {
  name: string;
  about: string | null;
  logoUrl: string | null;
  logoWithNameUrl: string | null;
  faviconUrl: string | null;
  email: string | null;
  phone: string | null;
  yearFounded: number | null;
  websiteUrl: string;
  locations: Array<{ address: string | null; city: string | null; state: string | null; zip: string | null }>;
  suggestedServices: string[];
  teamMembers: ScrapedTeamMember[];
};

const VALID_TABS = ["profile", "users", "egg-donors", "surrogates", "sperm-donors", "costs", "branding"];

export default function AdminProviderEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isGostorkAdmin = user?.roles?.includes("GOSTORK_ADMIN") ?? false;

  const currentTab = VALID_TABS.includes(searchParams.get("tab") || "") ? searchParams.get("tab")! : "profile";
  const handleTabChange = (value: string) => setSearchParams({ tab: value }, { replace: true });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleLocationDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEditLocations((items) => {
      const oldIndex = items.findIndex((item, i) => getSortId(item, i) === active.id);
      const newIndex = items.findIndex((item, i) => getSortId(item, i) === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  function handleMemberDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEditTeamMembers((items) => {
      const oldIndex = items.findIndex((item, i) => getSortId(item, i) === active.id);
      const newIndex = items.findIndex((item, i) => getSortId(item, i) === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  const { data: provider, isLoading } = useQuery<any>({
    queryKey: ["/api/providers", id],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Provider not found");
      return res.json();
    },
    enabled: !!id,
  });

  const { data: providerTypes } = useQuery<any[]>({
    queryKey: ["/api/provider-types"],
  });

  const [editName, setEditName] = useState("");
  const [editAbout, setEditAbout] = useState("");
  const [editWebsite, setEditWebsite] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editYearFounded, setEditYearFounded] = useState("");
  const [editLogoUrl, setEditLogoUrl] = useState("");
  const [editLocations, setEditLocations] = useState<any[]>([]);
  const [editTeamMembers, setEditTeamMembers] = useState<ScrapedTeamMember[]>([]);
  const [editingEditMemberIdx, setEditingEditMemberIdx] = useState<number | null>(null);
  const [uploadingEditPhotoIdx, setUploadingEditPhotoIdx] = useState<number | null>(null);
  const [editScrapedData, setEditScrapedData] = useState<ScrapedData | null>(null);
  const [editMergeSelections, setEditMergeSelections] = useState<Record<string, "keep" | "scraped">>({});
  const [initialized, setInitialized] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const isInitializingRef = useRef(false);
  // IVF matching requirements
  const [ivfTwinsAllowed, setIvfTwinsAllowed] = useState(false);
  const [ivfTransferFromOtherClinics, setIvfTransferFromOtherClinics] = useState(false);
  const [ivfMaxAgeIp1, setIvfMaxAgeIp1] = useState("");
  const [ivfMaxAgeIp2, setIvfMaxAgeIp2] = useState("");
  const [ivfBiologicalConnection, setIvfBiologicalConnection] = useState("");
  const [ivfAcceptingPatients, setIvfAcceptingPatients] = useState<string[]>([]);
  const [ivfEggDonorType, setIvfEggDonorType] = useState("");
  // Surrogacy matching requirements
  const [surrogacyCitizensNotAllowed, setSurrogacyCitizensNotAllowed] = useState<string[]>([]);
  const [surrogacyTwinsAllowed, setSurrogacyTwinsAllowed] = useState(false);
  const [surrogacyStayAfterBirthMonths, setSurrogacyStayAfterBirthMonths] = useState("");
  const [surrogacyBirthCertificateListing, setSurrogacyBirthCertificateListing] = useState<string[]>([]);
  const [surrogacySurrogateRemovableFromCert, setSurrogacySurrogateRemovableFromCert] = useState(false);
  // IVF Clinic surrogate matching requirements
  const [ivfSurrogateAgeRange, setIvfSurrogateAgeRange] = useState<[number, number]>([18, 45]);
  const [ivfSurrogateBmiRange, setIvfSurrogateBmiRange] = useState<[number, number]>([18, 35]);
  const [ivfSurrogateMaxDeliveries, setIvfSurrogateMaxDeliveries] = useState("");
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

  useEffect(() => {
    if (provider && !initialized) {
      isInitializingRef.current = true;
      setEditName(provider.name);
      setEditAbout(provider.about || "");
      setEditWebsite(provider.websiteUrl || "");
      setEditEmail(provider.email || "");
      setEditPhone(provider.phone || "");
      setEditYearFounded(provider.yearFounded ? String(provider.yearFounded) : "");
      setEditLogoUrl(provider.logoUrl || "");
      setEditLocations(provider.locations?.map((l: any) => ({ ...l, _sortId: l.id || nextSortId() })) || []);
      setEditTeamMembers(provider.members?.map((d: any) => ({
        id: d.id,
        _sortId: d.id || nextSortId(),
        name: d.name,
        title: d.title || null,
        bio: d.bio || null,
        photoUrl: d.photoUrl || null,
        locationHints: d.locations?.map((l: any) => l.location?.city ? `${l.location.city}, ${l.location.state}` : "").filter(Boolean) || [],
        locationIds: d.locations?.map((l: any) => l.locationId) || [],
      })) || []);
      // IVF matching requirements
      setIvfTwinsAllowed(provider.ivfTwinsAllowed ?? false);
      setIvfTransferFromOtherClinics(provider.ivfTransferFromOtherClinics ?? false);
      setIvfMaxAgeIp1(provider.ivfMaxAgeIp1 != null ? String(provider.ivfMaxAgeIp1) : "");
      setIvfMaxAgeIp2(provider.ivfMaxAgeIp2 != null ? String(provider.ivfMaxAgeIp2) : "");
      setIvfBiologicalConnection(provider.ivfBiologicalConnection || "");
      setIvfAcceptingPatients(provider.ivfAcceptingPatients || []);
      setIvfEggDonorType(provider.ivfEggDonorType || "");
      // Surrogacy matching requirements
      setSurrogacyCitizensNotAllowed(provider.surrogacyCitizensNotAllowed || []);
      setSurrogacyTwinsAllowed(provider.surrogacyTwinsAllowed ?? false);
      setSurrogacyStayAfterBirthMonths(provider.surrogacyStayAfterBirthMonths != null ? String(provider.surrogacyStayAfterBirthMonths) : "");
      setSurrogacyBirthCertificateListing(Array.isArray(provider.surrogacyBirthCertificateListing) ? provider.surrogacyBirthCertificateListing : (provider.surrogacyBirthCertificateListing ? [provider.surrogacyBirthCertificateListing as string] : []));
      setSurrogacySurrogateRemovableFromCert(provider.surrogacySurrogateRemovableFromCert === true);
      // IVF Clinic surrogate matching requirements
      setIvfSurrogateAgeRange([provider.ivfSurrogateMinAge ?? 18, provider.ivfSurrogateMaxAge ?? 45]);
      setIvfSurrogateBmiRange([provider.ivfSurrogateMinBmi ?? 18, provider.ivfSurrogateMaxBmi ?? 35]);
      setIvfSurrogateMaxDeliveries(provider.ivfSurrogateMaxDeliveries != null ? String(provider.ivfSurrogateMaxDeliveries) : "");
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
      // Apply US surrogacy defaults if the provider is a US-based surrogacy agency and has never been configured
      const US_STATES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);
      const providerIsSurrogacyAgency = provider.services?.some((svc: any) => svc.providerType?.name?.toLowerCase().includes("surrogacy"));
      const providerIsUSBased = provider.locations?.some((loc: any) => {
        const s = (loc.state || "").trim().toUpperCase();
        const c = (loc.country || "").trim().toLowerCase();
        return US_STATES.has(s) || c === "us" || c === "usa" || c === "united states";
      });
      if (providerIsSurrogacyAgency && providerIsUSBased && provider.surrogacySurrogateRemovableFromCert == null) {
        setSurrogacyTwinsAllowed(true);
        setSurrogacySurrogateRemovableFromCert(true);
        setSurrogacyStayAfterBirthMonths("0");
        setSurrogacyBirthCertificateListing(["both_biological_parents"]);
      }
      setInitialized(true);
    }
  }, [provider, initialized]);

  useEffect(() => {
    if (!initialized) {
      setIsDirty(false);
      return;
    }
    if (isInitializingRef.current) {
      isInitializingRef.current = false;
      setIsDirty(false);
      return;
    }
    setIsDirty(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, editName, editAbout, editWebsite, editEmail, editPhone, editYearFounded, editLogoUrl, editLocations, editTeamMembers, ivfTwinsAllowed, ivfTransferFromOtherClinics, ivfMaxAgeIp1, ivfMaxAgeIp2, ivfBiologicalConnection, ivfAcceptingPatients, ivfEggDonorType, surrogacyCitizensNotAllowed, surrogacyTwinsAllowed, surrogacyStayAfterBirthMonths, surrogacyBirthCertificateListing, surrogacySurrogateRemovableFromCert]);

  const editScrapeMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/providers/scrape", { url });
      return res.json() as Promise<ScrapedData>;
    },
    onSuccess: (data) => {
      setEditScrapedData(data);
      const sel: Record<string, "keep" | "scraped"> = {};
      if (data.name && data.name !== editName) sel.name = editName ? "keep" : "scraped";
      if (data.about && data.about !== editAbout) sel.about = editAbout ? "keep" : "scraped";
      if (data.logoUrl && data.logoUrl !== editLogoUrl) sel.logoUrl = editLogoUrl ? "keep" : "scraped";
      if (data.email && data.email !== editEmail) sel.email = editEmail ? "keep" : "scraped";
      if (data.phone && data.phone !== editPhone) sel.phone = editPhone ? "keep" : "scraped";
      if (data.yearFounded && String(data.yearFounded) !== editYearFounded) sel.yearFounded = editYearFounded ? "keep" : "scraped";
      setEditMergeSelections(sel);
    },
    onError: (err: Error) => {
      toast({ title: "Scraping failed", description: "Could not extract information from this website.", variant: "destructive" });
    },
  });

  async function handleEditPhotoUpload(file: File, idx: number) {
    setUploadingEditPhotoIdx(idx);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message);
      }
      const { url } = await res.json();
      const updated = [...editTeamMembers];
      updated[idx] = { ...updated[idx], photoUrl: url };
      setEditTeamMembers(updated);
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploadingEditPhotoIdx(null);
    }
  }

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider) return;
    const data: any = {
      name: editName,
      about: editAbout || null,
      websiteUrl: editWebsite || null,
      email: editEmail || null,
      phone: editPhone || null,
      yearFounded: editYearFounded ? parseInt(editYearFounded) : null,
      logoUrl: editLogoUrl || null,
      ivfTwinsAllowed,
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
      surrogacySurrogateRemovableFromCert: surrogacySurrogateRemovableFromCert,
      ivfSurrogateMinAge: ivfSurrogateAgeRange[0],
      ivfSurrogateMaxAge: ivfSurrogateAgeRange[1],
      ivfSurrogateMinBmi: ivfSurrogateBmiRange[0],
      ivfSurrogateMaxBmi: ivfSurrogateBmiRange[1],
      ivfSurrogateMaxDeliveries: ivfSurrogateMaxDeliveries ? parseInt(ivfSurrogateMaxDeliveries) : null,
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
    };

    try {
      await apiRequest("PUT", `/api/providers/${provider.id}`, data);

      const errors: string[] = [];

      const existingLocIds = new Set((provider.locations || []).map((l: any) => l.id));
      const currentLocIds = new Set(editLocations.filter(l => l.id).map(l => l.id));

      const locPromises: Promise<void>[] = [];
      for (const loc of provider.locations || []) {
        if (!currentLocIds.has(loc.id)) {
          locPromises.push(apiRequest("DELETE", `/api/providers/${provider.id}/locations/${loc.id}`).catch((e: any) => { errors.push(`Delete location: ${e.message}`); }));
        }
      }
      for (let i = 0; i < editLocations.length; i++) {
        const loc = editLocations[i];
        if (loc.id && existingLocIds.has(loc.id)) {
          locPromises.push(apiRequest("PUT", `/api/providers/${provider.id}/locations/${loc.id}`, { address: loc.address, city: loc.city, state: loc.state, zip: loc.zip, sortOrder: i }).catch((e: any) => { errors.push(`Update location: ${e.message}`); }));
        } else if (!loc.id || !existingLocIds.has(loc.id)) {
          locPromises.push(apiRequest("POST", `/api/providers/${provider.id}/locations`, { address: loc.address || null, city: loc.city || null, state: loc.state || null, zip: loc.zip || null, sortOrder: i }).catch((e: any) => { errors.push(`Add location: ${e.message}`); }));
        }
      }

      const existingMemberIds = new Set((provider.members || []).map((d: any) => d.id));
      const currentMemberIds = new Set(editTeamMembers.filter((m: any) => m.id).map((m: any) => m.id));

      const memberPromises: Promise<void>[] = [];
      for (const doc of provider.members || []) {
        if (!currentMemberIds.has(doc.id)) {
          memberPromises.push(apiRequest("DELETE", `/api/providers/${provider.id}/members/${doc.id}`).catch((e: any) => { errors.push(`Delete member: ${e.message}`); }));
        }
      }
      for (let i = 0; i < editTeamMembers.length; i++) {
        const m = editTeamMembers[i] as any;
        if (m.id && existingMemberIds.has(m.id)) {
          memberPromises.push(apiRequest("PUT", `/api/providers/${provider.id}/members/${m.id}`, { name: m.name, title: m.title || null, bio: m.bio || null, photoUrl: m.photoUrl || null, isMedicalDirector: m.isMedicalDirector || false, sortOrder: i, locationIds: m.locationIds || [] }).catch((e: any) => { errors.push(`Update member "${m.name}": ${e.message}`); }));
        } else if (!m.id || !existingMemberIds.has(m.id)) {
          memberPromises.push(apiRequest("POST", `/api/providers/${provider.id}/members`, { name: m.name, title: m.title || null, bio: m.bio || null, photoUrl: m.photoUrl || null, isMedicalDirector: m.isMedicalDirector || false, sortOrder: i, locationIds: m.locationIds || [] }).catch((e: any) => { errors.push(`Add member "${m.name}": ${e.message}`); }));
        }
      }

      await Promise.all([...locPromises, ...memberPromises]);

      await queryClient.refetchQueries({ queryKey: ["/api/providers", id] });
      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
      setInitialized(false);
      if (errors.length > 0) {
        toast({ title: "Provider updated with errors", description: errors.join("; "), variant: "destructive" });
      } else {
        toast({ title: "Provider updated", variant: "success" });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleApplyMerge = async () => {
    if (!editScrapedData || !provider) return;
    const scrapedVals: Record<string, string> = {
      name: editScrapedData.name || "",
      about: editScrapedData.about || "",
      logoUrl: editScrapedData.logoUrl || "",
      email: editScrapedData.email || "",
      phone: editScrapedData.phone || "",
      yearFounded: editScrapedData.yearFounded ? String(editScrapedData.yearFounded) : "",
    };
    const setters: Record<string, (v: string) => void> = {
      name: setEditName,
      about: setEditAbout,
      logoUrl: setEditLogoUrl,
      email: setEditEmail,
      phone: setEditPhone,
      yearFounded: setEditYearFounded,
    };
    for (const [field, choice] of Object.entries(editMergeSelections)) {
      if (choice === "scraped" && setters[field]) {
        setters[field](scrapedVals[field]);
      }
    }
    for (const [field, val] of Object.entries(scrapedVals)) {
      if (!(field in editMergeSelections) && val) {
        setters[field]?.(val);
      }
    }
    const locs = editScrapedData.locations || [];
    if (locs.length > 0) {
      const existingKeys = new Set(editLocations.map((l: any) => `${l.city?.toLowerCase()}|${l.state?.toLowerCase()}`));
      const newLocs = locs.filter(l => !existingKeys.has(`${l.city?.toLowerCase()}|${l.state?.toLowerCase()}`))
        .map(l => ({ ...l, _sortId: nextSortId() }));
      if (newLocs.length > 0) setEditLocations([...editLocations, ...newLocs]);
    }
    if (editScrapedData.suggestedServices && editScrapedData.suggestedServices.length > 0 && providerTypes) {
      const existingSvcNames = new Set((provider.services || []).map((s: any) => s.providerType?.name));
      for (const svcName of editScrapedData.suggestedServices) {
        if (existingSvcNames.has(svcName)) continue;
        const matchedType = providerTypes.find((t: any) => t.name.toLowerCase() === svcName.toLowerCase());
        if (matchedType) {
          try {
            await apiRequest("POST", `/api/providers/${provider.id}/services`, { providerTypeId: matchedType.id, status: "NEW" });
          } catch (err) {}
        }
      }
    }
    if (editScrapedData.teamMembers && editScrapedData.teamMembers.length > 0) {
      const mappedMembers = editScrapedData.teamMembers.map((m: any) => {
        if (!m.locationHints || m.locationHints.length === 0) return m;
        const allLocs = [...editLocations, ...locs];
        const mappedHints: string[] = [];
        for (const hint of m.locationHints) {
          const matched = allLocs.find((loc: any) => hint.toLowerCase().includes((loc.city || "").toLowerCase()));
          if (matched) mappedHints.push(`${matched.city}|${matched.state}|${matched.address || ""}`);
        }
        return { ...m, locationHints: mappedHints };
      });
      const existingNames = new Set(editTeamMembers.map(m => m.name.toLowerCase()));
      const newMembers = mappedMembers.filter((m: any) => !existingNames.has(m.name.toLowerCase()))
        .map((m: any) => ({ ...m, _sortId: nextSortId() }));
      if (newMembers.length > 0) setEditTeamMembers([...editTeamMembers, ...newMembers]);
    }
    if (provider.brandingEnabled && editScrapedData) {
      const brandUpdates: Record<string, string | null> = {};
      if (editScrapedData.logoWithNameUrl) brandUpdates.logoWithNameUrl = editScrapedData.logoWithNameUrl;
      if (editScrapedData.logoUrl) brandUpdates.logoUrl = editScrapedData.logoUrl;
      if (editScrapedData.faviconUrl) brandUpdates.faviconUrl = editScrapedData.faviconUrl;
      if (editScrapedData.name) brandUpdates.companyName = editScrapedData.name;
      if (Object.keys(brandUpdates).length > 0) {
        try {
          const existing = await fetch(`/api/brand/provider/${provider.id}`, { credentials: "include" });
          if (existing.ok) {
            const current = await existing.json();
            const hasAnyBrandLogo = !!(current.logoUrl || current.logoWithNameUrl || current.faviconUrl || current.darkLogoUrl || current.darkLogoWithNameUrl);
            if (!hasAnyBrandLogo) {
              const filtered: Record<string, string | null> = {};
              for (const [k, v] of Object.entries(brandUpdates)) {
                if (!current[k]) filtered[k] = v;
              }
              if (Object.keys(filtered).length > 0) {
                await apiRequest("PUT", `/api/brand/provider/${provider.id}`, filtered);
              }
            }
          }
        } catch {}
      }
    }
    queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
    setEditScrapedData(null);
    setEditMergeSelections({});
    toast({ title: "Scraped data merged", variant: "success" });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={() => navigate("/admin/providers")} data-testid="link-back-providers">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Providers
        </Button>
        <p className="text-muted-foreground text-center py-8" data-testid="text-not-found">Provider not found.</p>
      </div>
    );
  }

  if (editScrapedData) {
    return (
      <div className="space-y-6 w-full">
        <Button variant="ghost" onClick={() => { setEditScrapedData(null); setEditMergeSelections({}); }} data-testid="link-back-edit">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Edit
        </Button>
        <div>
          <h1 className="font-display text-2xl font-heading text-primary" data-testid="text-merge-title">Review Scraped Data</h1>
          <p className="text-muted-foreground">The AI found new information for {provider.name}. Choose which values to keep.</p>
        </div>
        <div className="space-y-4">
          {Object.entries(editMergeSelections).map(([field, choice]) => {
            const labels: Record<string, string> = { name: "Provider Name", about: "About", logoUrl: "Logo URL", email: "Email", phone: "Phone", yearFounded: "Year Founded" };
            const currentValues: Record<string, string> = { name: editName, about: editAbout, logoUrl: editLogoUrl, email: editEmail, phone: editPhone, yearFounded: editYearFounded };
            const scrapedValues: Record<string, string> = {
              name: editScrapedData.name || "",
              about: editScrapedData.about || "",
              logoUrl: editScrapedData.logoUrl || "",
              email: editScrapedData.email || "",
              phone: editScrapedData.phone || "",
              yearFounded: editScrapedData.yearFounded ? String(editScrapedData.yearFounded) : "",
            };
            const current = currentValues[field] || "";
            const scraped = scrapedValues[field] || "";
            if (!current && scraped) return null;
            return (
              <div key={field} className="border rounded-[var(--radius)] p-3 space-y-2" data-testid={`edit-merge-field-${field}`}>
                <Label className="font-ui text-sm">{labels[field] || field}</Label>
                <div className="space-y-1.5">
                  <label className={`flex items-start gap-2 p-2 rounded-[var(--radius)] cursor-pointer text-sm ${choice === "keep" ? "bg-accent/10 border border-accent/30 dark:bg-accent/15 dark:border-accent/30" : "bg-secondary/30 hover:bg-secondary/50"}`}>
                    <input type="radio" name={`edit-merge-${field}`} checked={choice === "keep"} onChange={() => setEditMergeSelections(prev => ({ ...prev, [field]: "keep" }))} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-ui text-muted-foreground">Keep current:</span>
                      <p className={field === "about" ? "whitespace-pre-wrap break-words" : "truncate"}>{current}</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-2 p-2 rounded-[var(--radius)] cursor-pointer text-sm ${choice === "scraped" ? "bg-[hsl(var(--brand-success)/0.08)] border border-[hsl(var(--brand-success)/0.3)] dark:bg-[hsl(var(--brand-success)/0.15)] dark:border-[hsl(var(--brand-success)/0.3)]" : "bg-secondary/30 hover:bg-secondary/50"}`}>
                    <input type="radio" name={`edit-merge-${field}`} checked={choice === "scraped"} onChange={() => setEditMergeSelections(prev => ({ ...prev, [field]: "scraped" }))} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-ui text-muted-foreground">Use scraped:</span>
                      <p className={field === "about" ? "whitespace-pre-wrap break-words" : "truncate"}>{scraped}</p>
                    </div>
                  </label>
                </div>
              </div>
            );
          })}
          {editScrapedData.locations && editScrapedData.locations.length > 0 && (
            <div className="border rounded-[var(--radius)] p-3 space-y-2" data-testid="edit-merge-field-locations">
              <Label className="font-ui text-sm">Locations ({editScrapedData.locations.length} found by scraper)</Label>
              <p className="text-xs text-muted-foreground">Scraped locations will be added to any existing locations.</p>
              <div className="space-y-1">
                {editScrapedData.locations.map((loc, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm p-1.5 bg-[hsl(var(--brand-success)/0.08)] dark:bg-[hsl(var(--brand-success)/0.15)] rounded">
                    <MapPin className="w-3 h-3 text-[hsl(var(--brand-success))] shrink-0" />
                    <span className="truncate">{[loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(", ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {editScrapedData.suggestedServices && editScrapedData.suggestedServices.length > 0 && (
            <div className="border rounded-[var(--radius)] p-3 space-y-2" data-testid="edit-merge-field-services">
              <Label className="font-ui text-sm">Suggested Services</Label>
              <div className="flex flex-wrap gap-2">
                {editScrapedData.suggestedServices.map((svc, idx) => (
                  <Badge key={idx} variant="outline"><Check className="w-3 h-3 text-[hsl(var(--brand-success))] mr-1" />{svc}</Badge>
                ))}
              </div>
            </div>
          )}
          {editScrapedData.teamMembers && editScrapedData.teamMembers.length > 0 && (
            <div className="border rounded-[var(--radius)] p-3 space-y-2" data-testid="edit-merge-field-team">
              <Label className="font-ui text-sm">Team Members ({editScrapedData.teamMembers.length} found by scraper)</Label>
              <p className="text-xs text-muted-foreground">Scraped team members will be added to any existing ones.</p>
              <div className="space-y-1">
                {editScrapedData.teamMembers.map((m, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm p-1.5 bg-[hsl(var(--brand-success)/0.08)] dark:bg-[hsl(var(--brand-success)/0.15)] rounded">
                    {m.photoUrl && <img src={getPhotoSrc(m.photoUrl)!} alt={m.name} className="w-6 h-6 rounded-full object-cover shrink-0" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                    <span className="font-ui truncate">{m.name}</span>
                    {m.title && <span className="text-muted-foreground truncate">- {m.title}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2 justify-end fixed bottom-0 left-0 right-0 z-50 bg-background px-6 py-4 border-t">
          <Button variant="outline" onClick={() => { setEditScrapedData(null); setEditMergeSelections({}); }} data-testid="btn-edit-merge-dismiss">
            Cancel
          </Button>
          <Button onClick={handleApplyMerge} data-testid="btn-edit-merge-apply">
            <Check className="w-4 h-4 mr-2" />
            Apply Selections
          </Button>
        </div>
      </div>
    );
  }

  const svcNames = (provider.services || []).map((s: any) => s.providerType?.name?.toLowerCase() || "");
  const showEggDonors = svcNames.some((n: string) => n.includes("egg donor") || n.includes("egg bank"));
  const showSurrogates = svcNames.some((n: string) => n.includes("surrogacy"));
  const showSpermDonors = svcNames.some((n: string) => n.includes("sperm"));
  const isIvfClinic = svcNames.some((n: string) => n.includes("ivf") || n.includes("in vitro"));
  const isSurrogacyAgency = showSurrogates;
  const ivfOffersEggDonors = showEggDonors;
  const tabTriggerClass = "flex-1 h-full text-sm font-ui rounded-[var(--radius)] data-[state=active]:bg-background dark:data-[state=active]:bg-foreground/90 data-[state=active]:shadow data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground dark:data-[state=inactive]:text-muted-foreground";


  return (
    <div className="space-y-6 w-full">
      <Button variant="ghost" onClick={() => navigate("/admin/providers")} data-testid="link-back-providers">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back to Providers
      </Button>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-heading text-primary" data-testid="text-edit-title">Edit {provider.name}</h1>
        </div>
        <Button variant="outline" onClick={() => navigate(`/providers/${provider.id}`)} data-testid="button-profile-preview">
          <Eye className="w-4 h-4 mr-2" /> Profile Preview
        </Button>
      </div>

      <Tabs value={currentTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="w-full h-12 bg-muted dark:bg-muted p-1 rounded-[var(--radius)] border border-border dark:border-border">
          <TabsTrigger value="profile" className={tabTriggerClass} data-testid="tab-edit-profile">Profile</TabsTrigger>
          <TabsTrigger value="users" className={tabTriggerClass} data-testid="tab-edit-users">Team</TabsTrigger>
          {showEggDonors && <TabsTrigger value="egg-donors" className={tabTriggerClass} data-testid="tab-edit-egg-donors">Egg Donors</TabsTrigger>}
          {showSurrogates && <TabsTrigger value="surrogates" className={tabTriggerClass} data-testid="tab-edit-surrogates">Surrogates</TabsTrigger>}
          {showSpermDonors && <TabsTrigger value="sperm-donors" className={tabTriggerClass} data-testid="tab-edit-sperm-donors">Sperm Donors</TabsTrigger>}
          <TabsTrigger value="costs" className={tabTriggerClass} data-testid="tab-edit-costs">
            <DollarSign className="w-4 h-4 mr-1.5 inline" />
            Costs
          </TabsTrigger>
          <TabsTrigger value="branding" className={tabTriggerClass} data-testid="tab-edit-branding">
            <Palette className="w-4 h-4 mr-1.5 inline" />
            Branding
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <form onSubmit={handleEdit} className="space-y-6">
            <Card className="p-6 space-y-5">
              <h3 className="text-lg font-heading flex items-center gap-2">
                <Building2 className="w-5 h-5 text-primary" /> Company Profile
              </h3>
              <div className="flex items-start gap-4">
                <button
                  type="button"
                  className="relative w-16 h-16 rounded-[var(--radius)] bg-secondary shrink-0 overflow-hidden group cursor-pointer border border-border/40 hover:border-primary/40 transition-colors"
                  onClick={() => document.getElementById("edit-logo-upload")?.click()}
                  data-testid="btn-upload-logo"
                >
                  {editLogoUrl ? (
                    <img
                      src={getPhotoSrc(editLogoUrl) || editLogoUrl}
                      alt="Logo"
                      className="w-full h-full object-contain"
                      referrerPolicy="no-referrer"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                      <Building2 className="w-6 h-6" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <Upload className="w-4 h-4 text-white" />
                  </div>
                </button>
                <input id="edit-logo-upload" type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const formData = new FormData();
                  formData.append("file", file);
                  try {
                    const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
                    if (!res.ok) throw new Error("Upload failed");
                    const { url } = await res.json();
                    setEditLogoUrl(url);
                  } catch (err: any) {
                    toast({ title: "Upload failed", description: err.message, variant: "destructive" });
                  }
                  e.target.value = "";
                }} />
                <div className="flex-1 space-y-2">
                  <Label>Provider Name</Label>
                  <Input value={editName} onChange={e => setEditName(e.target.value)} required data-testid="input-edit-name" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Website URL</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input value={editWebsite} onChange={e => setEditWebsite(e.target.value)} placeholder="https://..." className="pl-9" data-testid="input-edit-website" />
                  </div>
                  {editWebsite && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={editScrapeMutation.isPending}
                      onClick={() => editScrapeMutation.mutate(editWebsite)}
                      data-testid="btn-edit-scrape"
                    >
                      {editScrapeMutation.isPending ? (
                        <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Scraping...</>
                      ) : (
                        <><Sparkles className="w-4 h-4 mr-1" /> Scrape</>
                      )}
                    </Button>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label>About</Label>
                <Textarea value={editAbout} onChange={e => setEditAbout(e.target.value)} placeholder="Brief description of the provider..." rows={3} data-testid="input-edit-about" />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="+1 (555) 123-4567" className="pl-9" data-testid="input-edit-phone" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Year Founded</Label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={editYearFounded}
                    onChange={e => setEditYearFounded(e.target.value)}
                    type="number"
                    placeholder="e.g. 2010"
                    min={1900}
                    max={new Date().getFullYear()}
                    className="pl-9"
                    data-testid="input-edit-year"
                  />
                </div>
              </div>
            </Card>

            <Card className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-heading flex items-center gap-2">
                  <MapPin className="w-5 h-5 text-primary" /> Locations ({editLocations.length})
                </h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const newLoc = { address: "", city: "", state: "", zip: "", _sortId: nextSortId() };
                    setEditLocations([newLoc, ...editLocations]);
                  }}
                  data-testid="button-edit-add-location"
                >
                  <Plus className="w-3 h-3 mr-1" /> Add
                </Button>
              </div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleLocationDragEnd}>
                <SortableContext items={editLocations.map((loc, idx) => getSortId(loc, idx))} strategy={verticalListSortingStrategy}>
                  {editLocations.map((loc, idx) => {
                    const sortId = getSortId(loc, idx);
                    return (
                      <SortableItem key={sortId} id={sortId}>
                        <div className="flex items-center gap-2 text-sm">
                          <LocationAutocomplete
                            value={loc}
                            onChange={newLoc => {
                              const updated = [...editLocations];
                              updated[idx] = { ...updated[idx], ...newLoc };
                              setEditLocations(updated);
                            }}
                            className="h-8 text-sm"
                            data-testid={`input-edit-location-${idx}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => setEditLocations(editLocations.filter((_, i) => i !== idx))}
                            data-testid={`button-edit-remove-location-${idx}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </SortableItem>
                    );
                  })}
                </SortableContext>
              </DndContext>
            </Card>

            <Card className="p-6 space-y-4">
              <Label>Services</Label>
              <div className="flex flex-wrap gap-2">
                {(provider.services || []).map((svc: any) => (
                  <Badge key={svc.id} variant="outline" className="flex items-center gap-1" data-testid={`edit-service-${svc.id}`}>
                    <Check className="w-3 h-3 text-[hsl(var(--brand-success))]" />
                    {svc.providerType?.name || "Service"}
                    <button
                      type="button"
                      className="ml-1 text-muted-foreground hover:text-destructive"
                      onClick={async () => {
                        try {
                          await apiRequest("POST", `/api/providers/${provider.id}/services/${svc.id}/delete`);
                          queryClient.invalidateQueries({ queryKey: ["/api/providers", id] });
                        } catch {}
                      }}
                      data-testid={`button-remove-service-${svc.id}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              {providerTypes && (() => {
                const existingNames = new Set((provider.services || []).map((s: any) => s.providerType?.name));
                const available = providerTypes.filter((t: any) => !existingNames.has(t.name));
                if (available.length === 0) return null;
                return (
                  <Select
                    onValueChange={async (typeId) => {
                      if (!typeId) return;
                      try {
                        await apiRequest("POST", `/api/providers/${provider.id}/services`, { providerTypeId: typeId, status: "APPROVED" });
                        queryClient.invalidateQueries({ queryKey: ["/api/providers", id] });
                      } catch {}
                    }}
                    value=""
                  >
                    <SelectTrigger className="w-full" data-testid="select-edit-add-service">
                      <SelectValue placeholder="Add a service type..." />
                    </SelectTrigger>
                    <SelectContent>
                      {available.map((t: any) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              })()}
            </Card>

            {(isIvfClinic || isSurrogacyAgency) && (
              <Card className="p-6 space-y-6">
                <h3 className="text-lg font-heading flex items-center gap-2">
                  <Check className="w-5 h-5 text-primary" /> Parents Matching Requirements
                </h3>

                {isIvfClinic && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <Checkbox id="ivf-twins" checked={ivfTwinsAllowed} onCheckedChange={(v) => setIvfTwinsAllowed(!!v)} data-testid="checkbox-ivf-twins" />
                      <label htmlFor="ivf-twins" className="text-sm cursor-pointer">Twins allowed</label>
                    </div>
                    <div className="flex items-center gap-3">
                      <Checkbox id="ivf-transfer" checked={ivfTransferFromOtherClinics} onCheckedChange={(v) => setIvfTransferFromOtherClinics(!!v)} data-testid="checkbox-ivf-transfer" />
                      <label htmlFor="ivf-transfer" className="text-sm cursor-pointer">Transferring embryos from other clinics allowed</label>
                    </div>
                    <div className="flex gap-8">
                      <div className="space-y-2">
                        <Label>Max Age of IP 1</Label>
                        <Input type="number" min={18} max={80} value={ivfMaxAgeIp1} onChange={e => setIvfMaxAgeIp1(e.target.value)} placeholder="e.g. 50" data-testid="input-ivf-max-age-ip1" />
                      </div>
                      <div className="space-y-2">
                        <Label>Max Age of IP 2</Label>
                        <Input type="number" min={18} max={80} value={ivfMaxAgeIp2} onChange={e => setIvfMaxAgeIp2(e.target.value)} placeholder="e.g. 55" data-testid="input-ivf-max-age-ip2" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Biological connection to embryos</Label>
                      <Select value={ivfBiologicalConnection} onValueChange={setIvfBiologicalConnection}>
                        <SelectTrigger data-testid="select-ivf-bio-connection" className="w-auto min-w-[220px]">
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
                              onCheckedChange={(v) => {
                                if (v) setIvfAcceptingPatients([...ivfAcceptingPatients, opt.value]);
                                else setIvfAcceptingPatients(ivfAcceptingPatients.filter(x => x !== opt.value));
                              }}
                              data-testid={`checkbox-ivf-accepting-${opt.value}`}
                            />
                            <span className="text-sm">{opt.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    {ivfOffersEggDonors && (
                      <div className="space-y-2">
                        <Label>Egg donor type</Label>
                        <Select value={ivfEggDonorType} onValueChange={setIvfEggDonorType}>
                          <SelectTrigger data-testid="select-ivf-egg-donor-type">
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
                          onChange={setSurrogacyCitizensNotAllowed}
                          data-testid="input-surrogacy-citizens-country"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Checkbox id="surrogacy-twins" checked={surrogacyTwinsAllowed} onCheckedChange={(v) => setSurrogacyTwinsAllowed(!!v)} data-testid="checkbox-surrogacy-twins" />
                      <label htmlFor="surrogacy-twins" className="text-sm cursor-pointer">Twins allowed</label>
                    </div>
                    <div className="flex items-center gap-3">
                      <Checkbox id="surrogacy-removable-cert" checked={surrogacySurrogateRemovableFromCert} onCheckedChange={(v) => setSurrogacySurrogateRemovableFromCert(!!v)} data-testid="checkbox-surrogacy-removable-cert" />
                      <label htmlFor="surrogacy-removable-cert" className="text-sm cursor-pointer">Surrogate can be removed from birth certificate?</label>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="text-sm">How long do IPs need to stay after baby is born (months)</label>
                      <Input type="number" min={0} max={24} value={surrogacyStayAfterBirthMonths} onChange={e => setSurrogacyStayAfterBirthMonths(e.target.value)} placeholder="e.g. 2" className="w-24" data-testid="input-surrogacy-stay-months" />
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
                          const isDisabled = isBothSelected && (value === "biological_father" || value === "biological_mother");
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

            {isIvfClinic && (
              <Card className="p-6 space-y-6">
                <h3 className="text-lg font-heading flex items-center gap-2">
                  <Check className="w-5 h-5 text-primary" /> Surrogate Matching Requirements
                </h3>
                <div className="space-y-2">
                  <Label>Age Range of Surrogate: <span className="text-primary font-ui">{ivfSurrogateAgeRange[0]} - {ivfSurrogateAgeRange[1]} years</span></Label>
                  <Slider
                    min={18} max={45} step={1}
                    value={ivfSurrogateAgeRange}
                    onValueChange={(v) => setIvfSurrogateAgeRange(v as [number, number])}
                    className="max-w-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>BMI Range of Surrogate: <span className="text-primary font-ui">{ivfSurrogateBmiRange[0]} - {ivfSurrogateBmiRange[1]}</span></Label>
                  <Slider
                    min={18} max={35} step={0.5}
                    value={ivfSurrogateBmiRange}
                    onValueChange={(v) => setIvfSurrogateBmiRange(v as [number, number])}
                    className="max-w-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4 max-w-sm">
                  <div className="space-y-2">
                    <Label>Max Deliveries</Label>
                    <Input type="number" min={0} value={ivfSurrogateMaxDeliveries} onChange={e => setIvfSurrogateMaxDeliveries(e.target.value)} placeholder="e.g. 5" />
                  </div>
                  <div className="space-y-2">
                    <Label>Max C-Sections</Label>
                    <Input type="number" min={0} value={ivfSurrogateMaxCSections} onChange={e => setIvfSurrogateMaxCSections(e.target.value)} placeholder="e.g. 3" />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Miscarriages</Label>
                    <Input type="number" min={0} value={ivfSurrogateMaxMiscarriages} onChange={e => setIvfSurrogateMaxMiscarriages(e.target.value)} placeholder="e.g. 2" />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Abortions</Label>
                    <Input type="number" min={0} value={ivfSurrogateMaxAbortions} onChange={e => setIvfSurrogateMaxAbortions(e.target.value)} placeholder="e.g. 2" />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Years from Last Pregnancy</Label>
                    <Input type="number" min={0} value={ivfSurrogateMaxYearsFromLastPregnancy} onChange={e => setIvfSurrogateMaxYearsFromLastPregnancy(e.target.value)} placeholder="e.g. 5" />
                  </div>
                  <div className="space-y-2">
                    <Label>Months Post Vaginal Delivery</Label>
                    <Input type="number" min={0} value={ivfSurrogateMonthsPostVaginal} onChange={e => setIvfSurrogateMonthsPostVaginal(e.target.value)} placeholder="e.g. 6" />
                  </div>
                </div>
                <div className="space-y-3">
                  <p className="text-sm font-ui text-muted-foreground">Accepted Surrogate Medical History</p>
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
                        <span className="text-xs text-muted-foreground w-6">{value ? "Yes" : "No"}</span>
                        <Switch checked={value} onCheckedChange={set} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <Label>Health History Notes</Label>
                  <Textarea
                    value={ivfSurrogateMentalHealthHistory}
                    onChange={e => setIvfSurrogateMentalHealthHistory(e.target.value)}
                    placeholder="Describe mental health history requirements or notes..."
                    rows={4}
                  />
                </div>
              </Card>
            )}

            <Card className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-heading flex items-center gap-2">
                  <User className="w-5 h-5 text-primary" /> Team Members ({editTeamMembers.length})
                </h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const newMember: ScrapedTeamMember = { name: "", title: null, bio: null, photoUrl: null, _sortId: nextSortId() };
                    setEditTeamMembers([newMember, ...editTeamMembers]);
                    setEditingEditMemberIdx(0);
                  }}
                  data-testid="button-edit-add-member"
                >
                  <Plus className="w-3 h-3 mr-1" /> Add Member
                </Button>
              </div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleMemberDragEnd}>
                <SortableContext items={editTeamMembers.map((m, idx) => getSortId(m, idx))} strategy={verticalListSortingStrategy}>
                  <div className="space-y-3">
                    {editTeamMembers.map((member, idx) => {
                      const sortId = getSortId(member, idx);
                      return (
                        <SortableItem key={sortId} id={sortId} disabled={editingEditMemberIdx === idx}>
                          <div className="border rounded-[var(--radius)] p-3" data-testid={`edit-team-member-${idx}`}>
                    {editingEditMemberIdx === idx ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Name</Label>
                            <Input
                              value={member.name}
                              onChange={e => {
                                const updated = [...editTeamMembers];
                                updated[idx] = { ...updated[idx], name: e.target.value };
                                setEditTeamMembers(updated);
                              }}
                              className="h-8 text-sm"
                              data-testid={`input-edit-member-name-${idx}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Title</Label>
                            <Input
                              value={member.title || ""}
                              onChange={e => {
                                const updated = [...editTeamMembers];
                                updated[idx] = { ...updated[idx], title: e.target.value || null };
                                setEditTeamMembers(updated);
                              }}
                              className="h-8 text-sm"
                              data-testid={`input-edit-member-title-${idx}`}
                            />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Bio</Label>
                          <Textarea
                            value={member.bio || ""}
                            onChange={e => {
                              const updated = [...editTeamMembers];
                              updated[idx] = { ...updated[idx], bio: e.target.value || null };
                              setEditTeamMembers(updated);
                            }}
                            rows={2}
                            className="text-sm"
                            data-testid={`input-edit-member-bio-${idx}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Photo</Label>
                          <div className="flex gap-2">
                            <Input
                              value={member.photoUrl || ""}
                              onChange={e => {
                                const updated = [...editTeamMembers];
                                updated[idx] = { ...updated[idx], photoUrl: e.target.value || null };
                                setEditTeamMembers(updated);
                              }}
                              placeholder="Photo URL or upload →"
                              className="h-8 text-sm flex-1"
                              data-testid={`input-edit-member-photo-${idx}`}
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 px-2 shrink-0"
                              disabled={uploadingEditPhotoIdx === idx}
                              onClick={() => {
                                const input = document.createElement("input");
                                input.type = "file";
                                input.accept = "image/jpeg,image/png,image/webp,image/gif";
                                input.onchange = (e) => {
                                  const file = (e.target as HTMLInputElement).files?.[0];
                                  if (file) handleEditPhotoUpload(file, idx);
                                };
                                input.click();
                              }}
                              data-testid={`button-edit-upload-photo-${idx}`}
                            >
                              {uploadingEditPhotoIdx === idx ? (
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
                                  const updated = [...editTeamMembers];
                                  updated[idx] = { ...updated[idx], photoUrl: null };
                                  setEditTeamMembers(updated);
                                }}
                                data-testid={`button-edit-remove-photo-${idx}`}
                              >
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                          )}
                        </div>
                        {provider && provider.locations && provider.locations.length > 0 && (
                          <div className="space-y-1">
                            <Label className="text-xs">Assigned Locations</Label>
                            <div className="border rounded-[var(--radius)] p-2 space-y-1.5">
                              {provider.locations.map((loc: any) => (
                                <label key={loc.id} className="flex items-center gap-2 cursor-pointer">
                                  <Checkbox
                                    checked={(member.locationIds || []).includes(loc.id)}
                                    onCheckedChange={(checked) => {
                                      const updated = [...editTeamMembers];
                                      const currentIds = updated[idx].locationIds || [];
                                      updated[idx] = {
                                        ...updated[idx],
                                        locationIds: checked
                                          ? [...currentIds, loc.id]
                                          : currentIds.filter((id: string) => id !== loc.id),
                                      };
                                      setEditTeamMembers(updated);
                                    }}
                                    data-testid={`checkbox-edit-member-loc-${idx}-${loc.id}`}
                                  />
                                  <span className="text-xs">{loc.city}, {loc.state}{loc.address ? ` - ${loc.address}` : ""}</span>
                                </label>
                              ))}
                            </div>
                            <p className="text-xs text-muted-foreground">Leave all unchecked = all locations</p>
                          </div>
                        )}
                        <div className="flex justify-end">
                          <Button type="button" size="sm" variant="outline" onClick={() => setEditingEditMemberIdx(null)} data-testid={`button-edit-done-member-${idx}`}>
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
                          <div className="font-ui text-sm">{member.name || "New Member"}</div>
                          {member.title && <div className="text-xs text-muted-foreground">{member.title}</div>}
                          {member.bio && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{member.bio}</div>}
                          {member.locationIds && member.locationIds.length > 0 && provider?.locations ? (
                            <div className="text-xs text-accent-foreground mt-1 flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              {member.locationIds.map((lid: string) => {
                                const loc = provider.locations.find((l: any) => l.id === lid);
                                return loc ? `${loc.city}, ${loc.state}` : "";
                              }).filter(Boolean).join(", ")}
                            </div>
                          ) : member.locationHints && member.locationHints.length > 0 ? (
                            <div className="text-xs text-accent-foreground mt-1 flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              {member.locationHints.join(", ")}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground/60 mt-1 flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              All locations
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => setEditingEditMemberIdx(idx)}
                            data-testid={`button-edit-edit-member-${idx}`}
                          >
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => setEditTeamMembers(editTeamMembers.filter((_, i) => i !== idx))}
                            data-testid={`button-edit-remove-member-${idx}`}
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
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

            {isDirty && (
              <div className="flex gap-2 justify-end fixed bottom-0 left-0 right-0 z-50 bg-background px-6 py-4 border-t">
                <Button type="button" variant="outline" onClick={() => navigate("/admin/providers")} data-testid="button-cancel-edit">Cancel</Button>
                <Button type="submit" data-testid="button-save-edit">Save</Button>
              </div>
            )}
          </form>
        </TabsContent>

        <TabsContent value="users">
          <MembersTable context="provider" providerId={provider.id} currentUserId="" canManage isAdmin compact />
        </TabsContent>

        {showEggDonors && (
          <TabsContent value="egg-donors">
            <ProfileDatabasePanel providerId={provider.id} type="egg-donor" />
          </TabsContent>
        )}
        {showSurrogates && (
          <TabsContent value="surrogates">
            <ProfileDatabasePanel providerId={provider.id} type="surrogate" />
          </TabsContent>
        )}
        {showSpermDonors && (
          <TabsContent value="sperm-donors">
            <ProfileDatabasePanel providerId={provider.id} type="sperm-donor" />
          </TabsContent>
        )}

        <TabsContent value="costs">
          <ProviderCostsTab
            isAdminView={isGostorkAdmin}
            providerId={provider.id}
            providerType={
              (provider.services || [])
                .find((s: any) => s.status === "APPROVED")?.providerType?.name || 
              (provider.services || [])[0]?.providerType?.name || ""
            }
            providerServices={
              (provider.services || [])
                .filter((s: any) => s.providerType)
                .map((s: any) => ({
                  providerTypeId: s.providerType.id || s.providerTypeId,
                  providerTypeName: s.providerType.name,
                }))
            }
          />
        </TabsContent>

        <TabsContent value="branding">
          <ProviderBrandingTab providerId={provider.id} brandingEnabled={provider.brandingEnabled ?? false} provider={provider} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProviderBrandingTab({ providerId, brandingEnabled: initialEnabled, provider }: { providerId: string; brandingEnabled: boolean; provider?: any }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(initialEnabled);

  useEffect(() => {
    setEnabled(initialEnabled);
  }, [initialEnabled]);

  const toggleMutation = useMutation({
    mutationFn: async (newEnabled: boolean) => {
      const res = await apiRequest("PUT", `/api/brand/provider/${providerId}/toggle`, { enabled: newEnabled });
      return res.json();
    },
    onSuccess: (data) => {
      setEnabled(data.brandingEnabled);
      queryClient.invalidateQueries({ queryKey: ["/api/providers", providerId] });
      toast({ title: data.brandingEnabled ? "Provider branding enabled" : "Provider branding disabled", variant: "success" });
    },
    onError: () => {
      toast({ title: "Failed to toggle branding", variant: "destructive" });
    },
  });

  const handleToggle = (checked: boolean) => {
    toggleMutation.mutate(checked);
  };

  const headerSlot = (
    <Card className="flex items-center justify-between p-4 rounded-[var(--container-radius)]">
      <div className="flex items-center gap-3">
        <Palette className="w-5 h-5 text-primary" />
        <div>
          <p className="text-sm font-heading">Allow Provider Branding</p>
          <p className="text-xs text-muted-foreground">
            {enabled
              ? "Provider can customize their own branding"
              : "Enable to let the provider customize their visual identity"}
          </p>
        </div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={toggleMutation.isPending}
        data-testid="switch-provider-branding"
      />
    </Card>
  );

  const handleOverrideLogos = async () => {
    if (!provider) return;
    const updates: Record<string, string | null> = {};
    if (provider.logoUrl) updates.logoUrl = provider.logoUrl;
    const logoWithNameUrl = provider.logoUrl;
    if (logoWithNameUrl) updates.logoWithNameUrl = logoWithNameUrl;
    if (Object.keys(updates).length === 0) {
      toast({ title: "No logos found", description: "The provider profile has no logos to sync.", variant: "destructive" });
      return;
    }
    try {
      await apiRequest("PUT", `/api/brand/provider/${providerId}`, updates);
      queryClient.invalidateQueries({ queryKey: [`/api/brand/provider/${providerId}`] });
      toast({ title: "Logos synced from provider profile", variant: "success" });
    } catch {
      toast({ title: "Failed to sync logos", variant: "destructive" });
    }
  };

  return (
    <BrandSettingsForm
      getEndpoint={`/api/brand/provider/${providerId}`}
      putEndpoint={`/api/brand/provider/${providerId}`}
      resetEndpoint={`/api/brand/provider/${providerId}/reset`}
      enabled={enabled}
      headerSlot={headerSlot}
      disableLivePreview
      overrideAction={provider ? {
        label: "Sync logos from Provider Profile",
        onOverride: handleOverrideLogos,
      } : undefined}
    />
  );
}
