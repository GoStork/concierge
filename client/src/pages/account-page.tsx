import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Link, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatMoneyDollars } from "@/lib/format-money";
import { User, Building2, Users, Calendar, Camera, Loader2, Eye, EyeOff, Phone, Mail, Shield, CalendarPlus, AlertTriangle, Check, Pencil, Plus, Trash2, Palette, Egg, Baby, FlaskConical, Stethoscope, DollarSign, LogOut, Sparkles, Brain, RefreshCw, FileText, Wallet, FileSignature } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useQuery, useMutation } from "@tanstack/react-query";
import LocationAutocomplete from "@/components/location-autocomplete";
import { PhoneInput } from "@/components/ui/phone-input";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import MembersTable from "@/components/members-table";
import ImageUploader from "@/components/image-uploader";
import CompanyTab from "@/components/company-tab";
import ProfileDatabasePanel from "@/components/profile-database-panel";
import DoctorsDatabasePanel from "@/components/doctors-database-panel";
import ProviderCostsTab from "@/components/provider-costs-tab";
import { ProviderBillingTab } from "@/components/provider-billing-tab";
import { ProviderPayoutsTab } from "@/components/provider-payouts-tab";
import { SponsorshipDashboard } from "@/components/sponsorship/sponsorship-dashboard";
import { SponsorshipPlanManager } from "@/components/sponsorship/sponsorship-plan-manager";
import { ProviderLegalIdentityTab } from "@/components/provider-legal-identity-tab";
import { CalendarSettings as CalendarSettingsComponent } from "@/components/calendar/calendar-settings";
import BrandSettingsTab, { BrandSettingsForm } from "@/pages/admin-brand-settings-page";
import AdminConciergePage from "@/pages/admin-concierge-page";
import ProviderKnowledgeTab from "@/components/provider-knowledge-tab";
import ConciergeSettingsTab from "@/components/concierge-settings-tab";
import DocumentsTab from "@/components/documents-tab";
import ScrapersSummaryPage from "@/pages/scrapers-summary-page";
import { hasProviderRole, isParentAccountAdmin } from "@shared/roles";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InsurancePicker } from "@/components/ui/insurance-picker";
import { OptionPills } from "@/components/ui/option-pills";
import { Slider } from "@/components/ui/slider";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const GENDER_OPTIONS = [
  { value: "I'm a woman", label: "Woman" },
  { value: "I'm a man", label: "Man" },
  { value: "I'm non-binary", label: "Non-binary" },
];

const ORIENTATION_OPTIONS = [
  { value: "Straight", label: "Straight" },
  { value: "Gay", label: "Gay" },
  { value: "Lesbian", label: "Lesbian" },
  { value: "Bi", label: "Bi" },
  { value: "Queer", label: "Queer" },
];

const RELATIONSHIP_OPTIONS = [
  { value: "Single", label: "Single" },
  { value: "Partnered", label: "Partnered" },
  { value: "Married", label: "Married" },
  { value: "Separated/Divorced/Widowed", label: "Separated/Divorced/Widowed" },
];

const PARTNER_GENDER_OPTIONS = [
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
];

const allTabs = [
  { to: '/account', label: 'My Account', icon: User, end: true, roles: null },
  { to: '/account/company', label: 'Company', icon: Building2, roles: 'provider' as const },
  { to: '/account/documents', label: 'Documents', icon: FileText, roles: 'provider' as const },
  { to: '/account/team', label: 'Team', icon: Users, roles: 'provider' as const },
  { to: '/account/members', label: 'Members', icon: Users, roles: 'parent' as const },
  { to: '/account/calendar', label: 'Calendar', icon: Calendar, roles: null },
  { to: '/account/legal-identity', label: 'Legal Identity', icon: FileSignature, roles: 'provider' as const },
  { to: '/account/billing', label: 'Billing', icon: DollarSign, roles: 'billing' as const },
  { to: '/account/payouts', label: 'Payouts', icon: Wallet, roles: 'billing' as const },
  { to: '/account/sponsorship', label: 'Sponsorship', icon: Sparkles, roles: 'sponsorship' as const },
  { to: '/account/branding', label: 'Branding', icon: Palette, roles: 'branding' as const },
  { to: '/account/knowledge', label: 'Knowledge', icon: Brain, roles: 'knowledge' as const },
  { to: '/account/concierge', label: 'AI Concierge', icon: Sparkles, roles: 'concierge' as const },
  { to: '/account/scrapers', label: 'Scrapers', icon: RefreshCw, roles: 'admin' as const },
];

function AccountTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isInitializingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [sectionSaving, setSectionSaving] = useState(false);
  const [editName, setEditName] = useState("");
  const [editMobileE164, setEditMobileE164] = useState("");
  const [editMobileDisplay, setEditMobileDisplay] = useState("");
  const [editMobileIsoCode, setEditMobileIsoCode] = useState("");
  const [editMobileIsValid, setEditMobileIsValid] = useState(false);
  const [editPassword, setEditPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [editLocation, setEditLocation] = useState({ address: "", city: "", state: "", zip: "", country: "" });
  const [editGender, setEditGender] = useState("");
  // partnerGender lives on User in the DB and is read by the cost-sheet
  // subtype matcher. The AI persists it from the family-type chip during
  // intake, but if the parent never reached that step (or wants to fix it
  // manually) we need an explicit editor here. Values: "man" | "woman".
  const [editPartnerGender, setEditPartnerGender] = useState("");
  const [editOrientation, setEditOrientation] = useState("");
  const [editRelationship, setEditRelationship] = useState("");
  const [editAge, setEditAge] = useState("");
  const [editPartnerName, setEditPartnerName] = useState("");
  const [editPartnerAge, setEditPartnerAge] = useState("");
  const [editServices, setEditServices] = useState<string[]>([]);

  // Journey fields
  const [editJourneyStage, setEditJourneyStage] = useState("");
  const [editIsFirstIvf, setEditIsFirstIvf] = useState("");
  // Biological baseline
  const [editEggSource, setEditEggSource] = useState("");
  const [editSpermSource, setEditSpermSource] = useState("");
  const [editCarrier, setEditCarrier] = useState("");
  const [editHasEmbryos, setEditHasEmbryos] = useState("");
  const [editEmbryoCount, setEditEmbryoCount] = useState("");
  const [editEmbryosTested, setEditEmbryosTested] = useState("");
  // Clinic preferences
  const [editNeedsClinic, setEditNeedsClinic] = useState("");
  const [editCurrentClinicName, setEditCurrentClinicName] = useState("");
  const [editClinicPriority, setEditClinicPriority] = useState("");
  const [editInsurance, setEditInsurance] = useState<string[]>([]);
  // Surrogate preferences
  const [editSurrogateCountries, setEditSurrogateCountries] = useState("");
  const [editSurrogateTermination, setEditSurrogateTermination] = useState("");
  const [editSurrogateTwins, setEditSurrogateTwins] = useState("");
  const [editSurrogateAgeRange, setEditSurrogateAgeRange] = useState("");
  const [editSurrogateBudget, setEditSurrogateBudget] = useState("");
  const [editSurrogateExperience, setEditSurrogateExperience] = useState("");
  const [editSurrogateMedPrefs, setEditSurrogateMedPrefs] = useState("");
  const [editSameSexCouple, setEditSameSexCouple] = useState("");
  // Donor preferences
  const [editDonorPreferences, setEditDonorPreferences] = useState("");
  const [editDonorEyeColor, setEditDonorEyeColor] = useState("");
  const [editDonorHairColor, setEditDonorHairColor] = useState("");
  const [editDonorHeight, setEditDonorHeight] = useState("");
  const [editDonorEducation, setEditDonorEducation] = useState("");
  const [editDonorEthnicity, setEditDonorEthnicity] = useState("");
  const [editSpermDonorType, setEditSpermDonorType] = useState("");
  const [editSpermDonorPreferences, setEditSpermDonorPreferences] = useState("");
  const [editEggDonorAgeRange, setEditEggDonorAgeRange] = useState("");
  const [editEggDonorCompensationRange, setEditEggDonorCompensationRange] = useState("");
  const [editEggDonorTotalCostRange, setEditEggDonorTotalCostRange] = useState("");
  const [editEggDonorLotCostRange, setEditEggDonorLotCostRange] = useState("");
  const [editEggDonorEggType, setEditEggDonorEggType] = useState("");
  const [editEggDonorDonationType, setEditEggDonorDonationType] = useState("");
  const [editClinicAgeGroup, setEditClinicAgeGroup] = useState("");
  // Surrogate extended preferences
  const [editSurrogateRace, setEditSurrogateRace] = useState("");
  const [editSurrogateEthnicity, setEditSurrogateEthnicity] = useState("");
  const [editSurrogateRelationship, setEditSurrogateRelationship] = useState("");
  const [editSurrogateBmiRange, setEditSurrogateBmiRange] = useState("");
  const [editSurrogateTotalCostRange, setEditSurrogateTotalCostRange] = useState("");
  const [editSurrogateLiveBirthsRange, setEditSurrogateLiveBirthsRange] = useState("");
  const [editClinicPriorityTags, setEditClinicPriorityTags] = useState("");
  const [editSurrogateMaxCSections, setEditSurrogateMaxCSections] = useState("");
  const [editSurrogateMaxMiscarriages, setEditSurrogateMaxMiscarriages] = useState("");
  const [editSurrogateMaxAbortions, setEditSurrogateMaxAbortions] = useState("");
  const [editSurrogateLastDeliveryYear, setEditSurrogateLastDeliveryYear] = useState("");
  const [editSurrogateCovidVaccinated, setEditSurrogateCovidVaccinated] = useState("");
  const [editSurrogateSelectiveReduction, setEditSurrogateSelectiveReduction] = useState("");
  const [editSurrogateInternationalParents, setEditSurrogateInternationalParents] = useState("");
  // Sperm donor extended preferences
  const [editSpermDonorAgeRange, setEditSpermDonorAgeRange] = useState("");
  const [editSpermDonorEyeColor, setEditSpermDonorEyeColor] = useState("");
  const [editSpermDonorHairColor, setEditSpermDonorHairColor] = useState("");
  const [editSpermDonorHeightRange, setEditSpermDonorHeightRange] = useState("");
  const [editSpermDonorRace, setEditSpermDonorRace] = useState("");
  const [editSpermDonorEthnicity, setEditSpermDonorEthnicity] = useState("");
  const [editSpermDonorEducation, setEditSpermDonorEducation] = useState("");
  const [editSpermDonorMaxPrice, setEditSpermDonorMaxPrice] = useState("");
  const [editSpermDonorVialType, setEditSpermDonorVialType] = useState("");
  // Current providers
  const [editCurrentAgencyName, setEditCurrentAgencyName] = useState("");
  const [editCurrentAttorneyName, setEditCurrentAttorneyName] = useState("");

  const parentProfileQuery = useQuery<any>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!(user && ((user as any).roles || []).includes("PARENT")),
    refetchOnMount: "always",
    staleTime: 0,
  });

  const surrogateCountriesQuery = useQuery<string[]>({
    queryKey: ["/api/providers/marketplace/surrogate-countries"],
    queryFn: async () => {
      const res = await fetch("/api/providers/marketplace/surrogate-countries", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!(user && ((user as any).roles || []).includes("PARENT")),
    staleTime: 5 * 60 * 1000,
  });

  if (!user) return null;

  const roles = (user as any).roles || [];
  const roleDisplay = roles.map((r: string) => r.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())).join(', ');
  const photoUrl = (user as any).photoUrl as string | null;
  const mobileNumber = (user as any).mobileNumber as string | null;
  const mobileNumberDisplay = (user as any).mobileNumberDisplay as string | null;
  const providerName = (user as any).provider?.name as string | null | undefined;
  const isProviderUser = hasProviderRole(roles);
  const isParent = roles.includes("PARENT");
  const userCity = (user as any).city as string | null;
  const userState = (user as any).state as string | null;
  const userCountry = (user as any).country as string | null;
  const locationDisplay = [userCity, userState].filter(Boolean).join(", ") || null;


  const profileLoading = isParent && parentProfileQuery.isLoading;

  function startEditing() {
    isInitializingRef.current = true;
    setEditName(user!.name || "");
    const parsedPhone = mobileNumber ? parsePhoneNumberFromString(mobileNumber) : null;
    if (parsedPhone && parsedPhone.country) {
      setEditMobileE164(parsedPhone.number);
      setEditMobileDisplay(mobileNumberDisplay ?? parsedPhone.formatInternational());
      setEditMobileIsoCode(parsedPhone.country);
      setEditMobileIsValid(parsedPhone.isValid());
    } else {
      setEditMobileE164("");
      setEditMobileDisplay("");
      setEditMobileIsoCode("");
      setEditMobileIsValid(false);
    }
    setEditPassword("");
    setConfirmPassword("");
    setEditLocation({ address: "", city: userCity || "", state: userState || "", zip: "", country: userCountry || "" });
    setEditGender((user as any).gender || "");
    setEditPartnerGender((user as any).partnerGender || "");
    setEditOrientation((user as any).sexualOrientation || "");
    setEditRelationship((user as any).relationshipStatus || "");
    const dob = (user as any).dateOfBirth;
    setEditAge(dob ? String(new Date().getFullYear() - new Date(dob).getFullYear()) : "");
    setEditPartnerName((user as any).partnerFirstName || "");
    setEditPartnerAge((user as any).partnerAge ? String((user as any).partnerAge) : "");
    setEditServices(parentProfileQuery.data?.interestedServices || []);
    // Journey
    setEditJourneyStage(parentProfileQuery.data?.journeyStage || "");
    setEditIsFirstIvf(parentProfileQuery.data?.isFirstIvf != null ? String(parentProfileQuery.data.isFirstIvf) : "");
    // Biological
    setEditEggSource(parentProfileQuery.data?.eggSource || "");
    setEditSpermSource(parentProfileQuery.data?.spermSource || "");
    setEditCarrier(parentProfileQuery.data?.carrier || "");
    setEditHasEmbryos(parentProfileQuery.data?.hasEmbryos != null ? String(parentProfileQuery.data.hasEmbryos) : "");
    setEditEmbryoCount(parentProfileQuery.data?.embryoCount != null ? String(parentProfileQuery.data.embryoCount) : "");
    setEditEmbryosTested(parentProfileQuery.data?.embryosTested != null ? String(parentProfileQuery.data.embryosTested) : "");
    // Clinic
    setEditNeedsClinic(parentProfileQuery.data?.needsClinic != null ? String(parentProfileQuery.data.needsClinic) : "");
    setEditCurrentClinicName(parentProfileQuery.data?.currentClinicName || "");
    setEditClinicPriority(parentProfileQuery.data?.clinicPriority || "");
    setEditInsurance(parentProfileQuery.data?.insurance ? [parentProfileQuery.data.insurance] : []);
    // Surrogate
    setEditSurrogateCountries(parentProfileQuery.data?.surrogateCountries || "");
    setEditSurrogateTermination(parentProfileQuery.data?.surrogateTermination || "");
    setEditSurrogateTwins(parentProfileQuery.data?.surrogateTwins || "");
    setEditSurrogateAgeRange(parentProfileQuery.data?.surrogateAgeRange || "");
    setEditSurrogateBudget(parentProfileQuery.data?.surrogateBudget || "");
    setEditSurrogateExperience(parentProfileQuery.data?.surrogateExperience || "");
    setEditSurrogateMedPrefs(parentProfileQuery.data?.surrogateMedPrefs || "");
    const orientation = (user as any).sexualOrientation || "";
    const isNonStraight = orientation && orientation.toLowerCase() !== "straight";
    const savedSameSex = parentProfileQuery.data?.sameSexCouple;
    setEditSameSexCouple(isNonStraight ? "true" : savedSameSex != null ? String(savedSameSex) : "");
    // Donor
    setEditDonorPreferences(parentProfileQuery.data?.donorPreferences || "");
    setEditDonorEyeColor(parentProfileQuery.data?.donorEyeColor || "");
    setEditDonorHairColor(parentProfileQuery.data?.donorHairColor || "");
    setEditDonorHeight(parentProfileQuery.data?.donorHeight || "");
    setEditDonorEducation(parentProfileQuery.data?.donorEducation || "");
    setEditDonorEthnicity(parentProfileQuery.data?.donorEthnicity || "");
    setEditSpermDonorType(parentProfileQuery.data?.spermDonorType || "");
    setEditSpermDonorPreferences(parentProfileQuery.data?.spermDonorPreferences || "");
    setEditEggDonorAgeRange(parentProfileQuery.data?.eggDonorAgeRange || "");
    setEditEggDonorCompensationRange(parentProfileQuery.data?.eggDonorCompensationRange || "");
    setEditEggDonorTotalCostRange(parentProfileQuery.data?.eggDonorTotalCostRange || "");
    setEditEggDonorLotCostRange(parentProfileQuery.data?.eggDonorLotCostRange || "");
    setEditEggDonorEggType(parentProfileQuery.data?.eggDonorEggType || "");
    setEditEggDonorDonationType(parentProfileQuery.data?.eggDonorDonationType || "");
    setEditClinicAgeGroup(parentProfileQuery.data?.clinicAgeGroup || "");
    // Surrogate extended
    setEditSurrogateRace(parentProfileQuery.data?.surrogateRace || "");
    setEditSurrogateEthnicity(parentProfileQuery.data?.surrogateEthnicity || "");
    setEditSurrogateRelationship(parentProfileQuery.data?.surrogateRelationship || "");
    setEditSurrogateBmiRange(parentProfileQuery.data?.surrogateBmiRange || "");
    setEditSurrogateTotalCostRange(parentProfileQuery.data?.surrogateTotalCostRange || "");
    setEditSurrogateLiveBirthsRange(parentProfileQuery.data?.surrogateLiveBirthsRange || "");
    setEditClinicPriorityTags(parentProfileQuery.data?.clinicPriorityTags || "");
    setEditSurrogateMaxCSections(parentProfileQuery.data?.surrogateMaxCSections != null ? String(parentProfileQuery.data.surrogateMaxCSections) : "");
    setEditSurrogateMaxMiscarriages(parentProfileQuery.data?.surrogateMaxMiscarriages != null ? String(parentProfileQuery.data.surrogateMaxMiscarriages) : "");
    setEditSurrogateMaxAbortions(parentProfileQuery.data?.surrogateMaxAbortions != null ? String(parentProfileQuery.data.surrogateMaxAbortions) : "");
    setEditSurrogateLastDeliveryYear(parentProfileQuery.data?.surrogateLastDeliveryYear != null ? String(parentProfileQuery.data.surrogateLastDeliveryYear) : "");
    setEditSurrogateCovidVaccinated(parentProfileQuery.data?.surrogateCovidVaccinated != null ? String(parentProfileQuery.data.surrogateCovidVaccinated) : "");
    setEditSurrogateSelectiveReduction(parentProfileQuery.data?.surrogateSelectiveReduction != null ? String(parentProfileQuery.data.surrogateSelectiveReduction) : "");
    setEditSurrogateInternationalParents(parentProfileQuery.data?.surrogateInternationalParents != null ? String(parentProfileQuery.data.surrogateInternationalParents) : "");
    // Sperm donor extended
    setEditSpermDonorAgeRange(parentProfileQuery.data?.spermDonorAgeRange || "");
    setEditSpermDonorEyeColor(parentProfileQuery.data?.spermDonorEyeColor || "");
    setEditSpermDonorHairColor(parentProfileQuery.data?.spermDonorHairColor || "");
    setEditSpermDonorHeightRange(parentProfileQuery.data?.spermDonorHeightRange || "");
    setEditSpermDonorRace(parentProfileQuery.data?.spermDonorRace || "");
    setEditSpermDonorEthnicity(parentProfileQuery.data?.spermDonorEthnicity || "");
    setEditSpermDonorEducation(parentProfileQuery.data?.spermDonorEducation || "");
    setEditSpermDonorMaxPrice(parentProfileQuery.data?.spermDonorMaxPrice != null ? String(parentProfileQuery.data.spermDonorMaxPrice) : "");
    setEditSpermDonorVialType(parentProfileQuery.data?.spermDonorVialType || "");
    // Providers
    setEditCurrentAgencyName(parentProfileQuery.data?.currentAgencyName || "");
    setEditCurrentAttorneyName(parentProfileQuery.data?.currentAttorneyName || "");
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setEditPassword("");
    setConfirmPassword("");
  }

  // --- Per-section init functions ---

  function startEditingSection(section: string) {
    const d = parentProfileQuery.data;
    if (section === "journey") {
      setEditJourneyStage(d?.journeyStage || "");
      setEditCurrentClinicName(d?.currentClinicName || "");
    } else if (section === "biological") {
      setEditCurrentClinicName(d?.currentClinicName || "");
      setEditEggSource(d?.eggSource || "");
      setEditSpermSource(d?.spermSource || "");
      setEditCarrier(d?.carrier || "");
      setEditHasEmbryos(d?.hasEmbryos != null ? String(d.hasEmbryos) : "");
      setEditEmbryoCount(d?.embryoCount != null ? String(d.embryoCount) : "");
      setEditEmbryosTested(d?.embryosTested != null ? String(d.embryosTested) : "");
    } else if (section === "clinic") {
      setEditNeedsClinic(d?.needsClinic != null ? String(d.needsClinic) : "");
      setEditIsFirstIvf(d?.isFirstIvf != null ? String(d.isFirstIvf) : "");
      setEditClinicPriority(d?.clinicPriority || "");
      setEditInsurance(d?.insurance ? [d.insurance] : []);
      setEditClinicAgeGroup(d?.clinicAgeGroup || "");
      setEditClinicPriorityTags(d?.clinicPriorityTags || "");
    } else if (section === "surrogate") {
      setEditSurrogateCountries(d?.surrogateCountries || "");
      setEditSurrogateTermination(d?.surrogateTermination || "");
      setEditSurrogateTwins(d?.surrogateTwins || "");
      setEditSurrogateAgeRange(d?.surrogateAgeRange || "");
      setEditSurrogateBudget(d?.surrogateBudget || "");
      setEditSurrogateExperience(d?.surrogateExperience || "");
      setEditSurrogateMedPrefs(d?.surrogateMedPrefs || "");
      const orientation = (user as any).sexualOrientation || "";
      const isNonStraight = orientation && orientation.toLowerCase() !== "straight";
      const savedSameSex = d?.sameSexCouple;
      setEditSameSexCouple(isNonStraight ? "true" : savedSameSex != null ? String(savedSameSex) : "");
      setEditSurrogateRace(d?.surrogateRace || "");
      setEditSurrogateEthnicity(d?.surrogateEthnicity || "");
      setEditSurrogateRelationship(d?.surrogateRelationship || "");
      setEditSurrogateBmiRange(d?.surrogateBmiRange || "");
      setEditSurrogateTotalCostRange(d?.surrogateTotalCostRange || "");
      setEditSurrogateLiveBirthsRange(d?.surrogateLiveBirthsRange || "");
      setEditSurrogateMaxCSections(d?.surrogateMaxCSections != null ? String(d.surrogateMaxCSections) : "");
      setEditSurrogateMaxMiscarriages(d?.surrogateMaxMiscarriages != null ? String(d.surrogateMaxMiscarriages) : "");
      setEditSurrogateMaxAbortions(d?.surrogateMaxAbortions != null ? String(d.surrogateMaxAbortions) : "");
      setEditSurrogateLastDeliveryYear(d?.surrogateLastDeliveryYear != null ? String(d.surrogateLastDeliveryYear) : "");
      setEditSurrogateCovidVaccinated(d?.surrogateCovidVaccinated != null ? String(d.surrogateCovidVaccinated) : "");
      setEditSurrogateSelectiveReduction(d?.surrogateSelectiveReduction != null ? String(d.surrogateSelectiveReduction) : "");
      setEditSurrogateInternationalParents(d?.surrogateInternationalParents != null ? String(d.surrogateInternationalParents) : "");
    } else if (section === "eggDonor") {
      setEditDonorPreferences(d?.donorPreferences || "");
      setEditDonorEyeColor(d?.donorEyeColor || "");
      setEditDonorHairColor(d?.donorHairColor || "");
      setEditDonorHeight(d?.donorHeight || "");
      setEditDonorEducation(d?.donorEducation || "");
      setEditDonorEthnicity(d?.donorEthnicity || "");
      setEditEggDonorAgeRange(d?.eggDonorAgeRange || "");
      setEditEggDonorCompensationRange(d?.eggDonorCompensationRange || "");
      setEditEggDonorTotalCostRange(d?.eggDonorTotalCostRange || "");
      setEditEggDonorLotCostRange(d?.eggDonorLotCostRange || "");
      setEditEggDonorEggType(d?.eggDonorEggType || "");
      setEditEggDonorDonationType(d?.eggDonorDonationType || "");
    } else if (section === "spermDonor") {
      setEditSpermDonorType(d?.spermDonorType || "");
      setEditSpermDonorPreferences(d?.spermDonorPreferences || "");
      setEditSpermDonorAgeRange(d?.spermDonorAgeRange || "");
      setEditSpermDonorEyeColor(d?.spermDonorEyeColor || "");
      setEditSpermDonorHairColor(d?.spermDonorHairColor || "");
      setEditSpermDonorHeightRange(d?.spermDonorHeightRange || "");
      setEditSpermDonorRace(d?.spermDonorRace || "");
      setEditSpermDonorEthnicity(d?.spermDonorEthnicity || "");
      setEditSpermDonorEducation(d?.spermDonorEducation || "");
      setEditSpermDonorMaxPrice(d?.spermDonorMaxPrice != null ? String(d.spermDonorMaxPrice) : "");
      setEditSpermDonorVialType(d?.spermDonorVialType || "");
    } else if (section === "providers") {
      setEditCurrentAgencyName(d?.currentAgencyName || "");
      setEditCurrentAttorneyName(d?.currentAttorneyName || "");
    }
    setEditingSection(section);
  }

  // --- Per-section save functions ---

  async function saveSectionJourney() {
    setSectionSaving(true);
    try {
      const payload: any = {
        journeyStage: editJourneyStage || null,
        currentClinicName: editCurrentClinicName || null,
      };
      await apiRequest("PUT", "/api/user/profile", payload);
      await parentProfileQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({ title: "Journey updated", variant: "success" });
      setEditingSection(null);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSectionSaving(false);
    }
  }

  async function saveSectionBiological() {
    setSectionSaving(true);
    try {
      const payload: any = {
        currentClinicName: editCurrentClinicName || null,
        eggSource: editEggSource || null,
        spermSource: editSpermSource || null,
        carrier: editCarrier || null,
        hasEmbryos: editHasEmbryos !== "" ? editHasEmbryos === "true" : null,
        embryoCount: editEmbryoCount !== "" ? Number(editEmbryoCount) : null,
        embryosTested: editEmbryosTested !== "" ? editEmbryosTested === "true" : null,
      };
      await apiRequest("PUT", "/api/user/profile", payload);
      await parentProfileQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({ title: "Biological baseline updated", variant: "success" });
      setEditingSection(null);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSectionSaving(false);
    }
  }

  async function saveSectionClinic() {
    setSectionSaving(true);
    try {
      const payload: any = {
        needsClinic: editNeedsClinic !== "" ? editNeedsClinic === "true" : null,
        isFirstIvf: editIsFirstIvf !== "" ? editIsFirstIvf === "true" : null,
        clinicPriority: editClinicPriority || null,
        clinicAgeGroup: editClinicAgeGroup || null,
        clinicPriorityTags: editClinicPriorityTags || null,
        insurance: editInsurance[0] || null,
      };
      await apiRequest("PUT", "/api/user/profile", payload);
      await parentProfileQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({ title: "Clinic preferences updated", variant: "success" });
      setEditingSection(null);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSectionSaving(false);
    }
  }

  async function saveSectionSurrogate() {
    setSectionSaving(true);
    try {
      const payload: any = {
        surrogateCountries: editSurrogateCountries || null,
        surrogateTermination: editSurrogateTermination || null,
        surrogateTwins: editSurrogateTwins || null,
        surrogateAgeRange: editSurrogateAgeRange || null,
        surrogateBudget: editSurrogateBudget || null,
        surrogateExperience: editSurrogateExperience || null,
        surrogateMedPrefs: editSurrogateMedPrefs || null,
        sameSexCouple: editSameSexCouple !== "" ? editSameSexCouple === "true" : null,
        surrogateRace: editSurrogateRace || null,
        surrogateEthnicity: editSurrogateEthnicity || null,
        surrogateRelationship: editSurrogateRelationship || null,
        surrogateBmiRange: editSurrogateBmiRange || null,
        surrogateTotalCostRange: editSurrogateTotalCostRange || null,
        surrogateLiveBirthsRange: editSurrogateLiveBirthsRange || null,
        surrogateMaxCSections: editSurrogateMaxCSections !== "" ? Number(editSurrogateMaxCSections) : null,
        surrogateMaxMiscarriages: editSurrogateMaxMiscarriages !== "" ? Number(editSurrogateMaxMiscarriages) : null,
        surrogateMaxAbortions: editSurrogateMaxAbortions !== "" ? Number(editSurrogateMaxAbortions) : null,
        surrogateLastDeliveryYear: editSurrogateLastDeliveryYear !== "" ? Number(editSurrogateLastDeliveryYear) : null,
        surrogateCovidVaccinated: editSurrogateCovidVaccinated !== "" ? editSurrogateCovidVaccinated === "true" : null,
        surrogateSelectiveReduction: editSurrogateSelectiveReduction !== "" ? editSurrogateSelectiveReduction === "true" : null,
        surrogateInternationalParents: editSurrogateInternationalParents !== "" ? editSurrogateInternationalParents === "true" : null,
      };
      await apiRequest("PUT", "/api/user/profile", payload);
      await parentProfileQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({ title: "Surrogate preferences updated", variant: "success" });
      setEditingSection(null);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSectionSaving(false);
    }
  }

  async function saveSectionEggDonor() {
    setSectionSaving(true);
    try {
      const payload: any = {
        donorPreferences: editDonorPreferences || null,
        donorEyeColor: editDonorEyeColor || null,
        donorHairColor: editDonorHairColor || null,
        donorHeight: editDonorHeight || null,
        donorEducation: editDonorEducation || null,
        donorEthnicity: editDonorEthnicity || null,
        eggDonorAgeRange: editEggDonorAgeRange || null,
        eggDonorCompensationRange: editEggDonorCompensationRange || null,
        eggDonorTotalCostRange: editEggDonorTotalCostRange || null,
        eggDonorLotCostRange: editEggDonorLotCostRange || null,
        eggDonorEggType: editEggDonorEggType || null,
        eggDonorDonationType: editEggDonorDonationType || null,
      };
      await apiRequest("PUT", "/api/user/profile", payload);
      await parentProfileQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({ title: "Egg donor preferences updated", variant: "success" });
      setEditingSection(null);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSectionSaving(false);
    }
  }

  async function saveSectionSpermDonor() {
    setSectionSaving(true);
    try {
      const payload: any = {
        spermDonorType: editSpermDonorType || null,
        spermDonorPreferences: editSpermDonorPreferences || null,
        spermDonorAgeRange: editSpermDonorAgeRange || null,
        spermDonorEyeColor: editSpermDonorEyeColor || null,
        spermDonorHairColor: editSpermDonorHairColor || null,
        spermDonorHeightRange: editSpermDonorHeightRange || null,
        spermDonorRace: editSpermDonorRace || null,
        spermDonorEthnicity: editSpermDonorEthnicity || null,
        spermDonorEducation: editSpermDonorEducation || null,
        spermDonorMaxPrice: editSpermDonorMaxPrice !== "" ? Number(editSpermDonorMaxPrice) : null,
        spermDonorVialType: editSpermDonorVialType || null,
      };
      await apiRequest("PUT", "/api/user/profile", payload);
      await parentProfileQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({ title: "Sperm donor preferences updated", variant: "success" });
      setEditingSection(null);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSectionSaving(false);
    }
  }

  async function saveSectionProviders() {
    setSectionSaving(true);
    try {
      const payload: any = {
        currentAgencyName: editCurrentAgencyName || null,
        currentAttorneyName: editCurrentAttorneyName || null,
      };
      await apiRequest("PUT", "/api/user/profile", payload);
      await parentProfileQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({ title: "Current providers updated", variant: "success" });
      setEditingSection(null);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSectionSaving(false);
    }
  }

  async function handleSave() {
    if (!editName.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (editPassword && editPassword !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (editPassword && editPassword.length < 6) {
      toast({ title: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }
    // Partner's full name / age are never required at profile save time.
    // The AI concierge doesn't ask for the partner's name (Phase 1 only
    // captures family type), and PandaDoc prompts for it at send time when
    // it's actually needed for a 2-signer agreement (Case D in
    // pandadoc-service.ts). Leave both fields optional so single parents
    // and donor / surrogate / sperm-bank journeys aren't blocked.
    setSaving(true);
    try {
      const payload: any = {
        name: editName.trim(),
      };
      if (editMobileE164 === "") {
        payload.mobileNumber = null;
        payload.mobileNumberDisplay = null;
      } else if (editMobileIsValid) {
        payload.mobileNumber = editMobileE164;
        payload.mobileNumberDisplay = editMobileDisplay;
      }
      if (!isProviderUser) {
        payload.city = editLocation.city || null;
        payload.state = editLocation.state || null;
        payload.country = editLocation.country || null;
        if (isParent) {
          payload.gender = editGender || null;
          payload.sexualOrientation = editOrientation || null;
          payload.relationshipStatus = editRelationship || null;
          payload.dateOfBirth = editAge ? new Date(new Date().getFullYear() - Number(editAge), 0, 1).toISOString() : null;
          const hasPartner = editRelationship === "Partnered" || editRelationship === "Married";
          payload.partnerFirstName = hasPartner ? (editPartnerName || null) : null;
          payload.partnerAge = hasPartner && editPartnerAge ? Number(editPartnerAge) : null;
          // Only send partnerGender when partner is in the picture. Backend
          // accepts "man" / "woman" / null; setting to null when single
          // clears any stale value.
          payload.partnerGender = hasPartner ? (editPartnerGender || null) : null;
          payload.interestedServices = editServices;
          // Journey
          payload.journeyStage = editJourneyStage || null;
          payload.isFirstIvf = editIsFirstIvf !== "" ? editIsFirstIvf === "true" : null;
          // Biological
          payload.eggSource = editEggSource || null;
          payload.spermSource = editSpermSource || null;
          payload.carrier = editCarrier || null;
          payload.hasEmbryos = editHasEmbryos !== "" ? editHasEmbryos === "true" : null;
          payload.embryoCount = editEmbryoCount !== "" ? Number(editEmbryoCount) : null;
          payload.embryosTested = editEmbryosTested !== "" ? editEmbryosTested === "true" : null;
          // Clinic
          payload.needsClinic = editNeedsClinic !== "" ? editNeedsClinic === "true" : null;
          payload.currentClinicName = editCurrentClinicName || null;
          payload.clinicPriority = editClinicPriority || null;
          // Surrogate
          payload.surrogateCountries = editSurrogateCountries || null;
          payload.surrogateTermination = editSurrogateTermination || null;
          payload.surrogateTwins = editSurrogateTwins || null;
          payload.surrogateAgeRange = editSurrogateAgeRange || null;
          payload.surrogateBudget = editSurrogateBudget || null;
          payload.surrogateExperience = editSurrogateExperience || null;
          payload.surrogateMedPrefs = editSurrogateMedPrefs || null;
          payload.sameSexCouple = editSameSexCouple !== "" ? editSameSexCouple === "true" : null;
          // Donor
          payload.donorPreferences = editDonorPreferences || null;
          payload.donorEyeColor = editDonorEyeColor || null;
          payload.donorHairColor = editDonorHairColor || null;
          payload.donorHeight = editDonorHeight || null;
          payload.donorEducation = editDonorEducation || null;
          payload.donorEthnicity = editDonorEthnicity || null;
          payload.spermDonorType = editSpermDonorType || null;
          payload.spermDonorPreferences = editSpermDonorPreferences || null;
          payload.eggDonorAgeRange = editEggDonorAgeRange || null;
          payload.eggDonorCompensationRange = editEggDonorCompensationRange || null;
          payload.eggDonorTotalCostRange = editEggDonorTotalCostRange || null;
          payload.eggDonorLotCostRange = editEggDonorLotCostRange || null;
          payload.eggDonorEggType = editEggDonorEggType || null;
          payload.eggDonorDonationType = editEggDonorDonationType || null;
          payload.clinicAgeGroup = editClinicAgeGroup || null;
          // Surrogate extended
          payload.surrogateRace = editSurrogateRace || null;
          payload.surrogateEthnicity = editSurrogateEthnicity || null;
          payload.surrogateRelationship = editSurrogateRelationship || null;
          payload.surrogateBmiRange = editSurrogateBmiRange || null;
          payload.surrogateTotalCostRange = editSurrogateTotalCostRange || null;
          payload.surrogateLiveBirthsRange = editSurrogateLiveBirthsRange || null;
          payload.clinicPriorityTags = editClinicPriorityTags || null;
          payload.surrogateMaxCSections = editSurrogateMaxCSections !== "" ? Number(editSurrogateMaxCSections) : null;
          payload.surrogateMaxMiscarriages = editSurrogateMaxMiscarriages !== "" ? Number(editSurrogateMaxMiscarriages) : null;
          payload.surrogateMaxAbortions = editSurrogateMaxAbortions !== "" ? Number(editSurrogateMaxAbortions) : null;
          payload.surrogateLastDeliveryYear = editSurrogateLastDeliveryYear !== "" ? Number(editSurrogateLastDeliveryYear) : null;
          payload.surrogateCovidVaccinated = editSurrogateCovidVaccinated !== "" ? editSurrogateCovidVaccinated === "true" : null;
          payload.surrogateSelectiveReduction = editSurrogateSelectiveReduction !== "" ? editSurrogateSelectiveReduction === "true" : null;
          payload.surrogateInternationalParents = editSurrogateInternationalParents !== "" ? editSurrogateInternationalParents === "true" : null;
          // Sperm donor extended
          payload.spermDonorAgeRange = editSpermDonorAgeRange || null;
          payload.spermDonorEyeColor = editSpermDonorEyeColor || null;
          payload.spermDonorHairColor = editSpermDonorHairColor || null;
          payload.spermDonorHeightRange = editSpermDonorHeightRange || null;
          payload.spermDonorRace = editSpermDonorRace || null;
          payload.spermDonorEthnicity = editSpermDonorEthnicity || null;
          payload.spermDonorEducation = editSpermDonorEducation || null;
          payload.spermDonorMaxPrice = editSpermDonorMaxPrice !== "" ? Number(editSpermDonorMaxPrice) : null;
          payload.spermDonorVialType = editSpermDonorVialType || null;
          // Providers
          payload.currentAgencyName = editCurrentAgencyName || null;
          payload.currentAttorneyName = editCurrentAttorneyName || null;
        }
      }
      if (editPassword && editPassword.length >= 6) {
        payload.password = editPassword;
      }
      await apiRequest("PUT", "/api/user/profile", payload);
      await queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      queryClient.invalidateQueries({ queryKey: ["/api/parent-profile"] });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      if ((user as any).providerId) {
        queryClient.invalidateQueries({ queryKey: ["/api/providers", (user as any).providerId, "users"] });
      }
      toast({ title: "Profile updated", variant: "success" });
      setIsDirty(false);
      setEditing(false);
      setEditPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // <ImageUploader /> handles the file upload + cropping; we just persist the URL.
  async function persistPhoto(url: string | null) {
    setUploading(true);
    try {
      await apiRequest("PUT", "/api/user/photo", { photoUrl: url });
      await queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      if ((user as any).providerId) {
        queryClient.invalidateQueries({ queryKey: ["/api/providers", (user as any).providerId, "users"] });
      }
      toast({ title: url ? "Photo updated" : "Photo removed", variant: "success" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  // Keep "Open to Same-Sex Couple" in sync when orientation changes during editing
  useEffect(() => {
    if (!editing) return;
    if (editOrientation && editOrientation.toLowerCase() !== "straight") {
      setEditSameSexCouple("true");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOrientation]);

  useEffect(() => {
    if (!editing) { setIsDirty(false); return; }
    if (isInitializingRef.current) { isInitializingRef.current = false; setIsDirty(false); return; }
    setIsDirty(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, editName, editMobileE164, editMobileDisplay, editMobileIsoCode, editMobileIsValid, editPassword, confirmPassword, editLocation, editGender, editOrientation, editRelationship, editAge, editPartnerName, editPartnerAge, editPartnerGender, editServices, editJourneyStage, editIsFirstIvf, editEggSource, editSpermSource, editCarrier, editHasEmbryos, editEmbryoCount, editEmbryosTested, editNeedsClinic, editCurrentClinicName, editClinicPriority, editInsurance, editClinicPriorityTags, editSurrogateCountries, editSurrogateTermination, editSurrogateTwins, editSurrogateAgeRange, editSurrogateBudget, editSurrogateExperience, editSurrogateMedPrefs, editSameSexCouple, editSurrogateRace, editSurrogateEthnicity, editSurrogateRelationship, editSurrogateBmiRange, editSurrogateTotalCostRange, editSurrogateLiveBirthsRange, editSurrogateMaxCSections, editSurrogateMaxMiscarriages, editSurrogateMaxAbortions, editSurrogateLastDeliveryYear, editSurrogateCovidVaccinated, editSurrogateSelectiveReduction, editSurrogateInternationalParents, editDonorPreferences, editDonorEyeColor, editDonorHairColor, editDonorHeight, editDonorEducation, editDonorEthnicity, editSpermDonorType, editSpermDonorPreferences, editSpermDonorAgeRange, editSpermDonorEyeColor, editSpermDonorHairColor, editSpermDonorHeightRange, editSpermDonorRace, editSpermDonorEthnicity, editSpermDonorEducation, editSpermDonorMaxPrice, editSpermDonorVialType, editEggDonorAgeRange, editEggDonorCompensationRange, editEggDonorTotalCostRange, editEggDonorLotCostRange, editEggDonorEggType, editEggDonorDonationType, editClinicAgeGroup, editCurrentAgencyName, editCurrentAttorneyName]);

  // Derive gender-aware options for biological baseline fields
  // Gender is stored as "I'm a man" / "I'm a woman" / "I'm non-binary"
  const currentGender = (editing ? editGender : ((user as any).gender || "")).toLowerCase();
  const isMan = currentGender === "i'm a man" || currentGender === "man";

  const eggSourceOptions = isMan
    ? ["Partner eggs", "Egg donor", "Donated embryos"]
    : ["Own eggs", "Partner eggs", "Egg donor", "Donated embryos"];

  const spermSourceOptions = isMan
    ? ["My sperm", "Partner sperm", "Sperm donor", "Known donor"]
    : ["Partner/Spouse", "Sperm donor", "Known donor"];

  const carrierOptions = isMan
    ? ["Gestational surrogate"]
    : ["Self carrying", "Gestational surrogate"];

  // Egg donor cost slider visibility based on egg type selection
  const currentEggType = editingSection === "eggDonor" ? editEggDonorEggType : (parentProfileQuery.data?.eggDonorEggType || "");
  const showFreshCosts = currentEggType !== "Frozen";   // Fresh, Either, or unspecified
  const showFrozenCost = currentEggType !== "Fresh";    // Frozen, Either, or unspecified

  const SURROGACY_COUNTRIES = surrogateCountriesQuery.data ?? [];

  return (
    <>
    <Card className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-heading">Personal Information</h2>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={startEditing} disabled={profileLoading} data-testid="button-edit-profile">
            {profileLoading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5 mr-1.5" />} Edit
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={cancelEditing} disabled={saving} data-testid="button-cancel-edit">Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving || !editName.trim()} data-testid="button-save-profile">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}Save
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-8">
        <div className="shrink-0">
          <ImageUploader
            value={photoUrl}
            onChange={persistPhoto}
            mode="avatar"
            variant="avatar"
            size={96}
            label="Profile photo"
            testId="profile-photo"
            fallback={<User className="w-10 h-10 text-primary" />}
          />
        </div>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          {editing ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="edit-name">Full Name</Label>
                <Input
                  id="edit-name"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  placeholder="Your full name"
                  data-testid="input-edit-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <div className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border border-border/40 bg-muted/30">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground" data-testid="text-account-email">{user.email}</span>
                </div>
                <p className="text-xs text-muted-foreground">Email cannot be changed</p>
              </div>
              <div className="space-y-2">
                <Label>Mobile Number</Label>
                <PhoneInput
                  variant="default"
                  value={editMobileE164}
                  displayValue={editMobileDisplay}
                  defaultIsoCode={editMobileIsoCode || undefined}
                  onChange={({ e164, display, isValid, isoCode }) => {
                    setEditMobileE164(e164);
                    setEditMobileDisplay(display);
                    setEditMobileIsoCode(isoCode);
                    setEditMobileIsValid(isValid);
                  }}
                  data-testid="input-edit-mobile"
                />
              </div>
              {!isProviderUser && (
                <>
                  <div className="space-y-2">
                    <Label>Location</Label>
                    <LocationAutocomplete
                      value={editLocation}
                      onChange={setEditLocation}
                      placeholder="e.g. New York, NY"
                      data-testid="input-edit-location"
                    />
                  </div>
                  {isParent && (
                    <>
                      <div className="space-y-2">
                        <Label>Gender Identity</Label>
                        <OptionPills
                          options={GENDER_OPTIONS}
                          value={editGender}
                          onChange={setEditGender}
                          testIdPrefix="pill-gender"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Sexual Orientation</Label>
                        <OptionPills
                          options={ORIENTATION_OPTIONS}
                          value={editOrientation}
                          onChange={setEditOrientation}
                          testIdPrefix="pill-orientation"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label>Relationship Status</Label>
                        <OptionPills
                          options={RELATIONSHIP_OPTIONS}
                          value={editRelationship}
                          onChange={setEditRelationship}
                          testIdPrefix="pill-relationship"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-age">Your Age</Label>
                        <NumberInput
                          id="edit-age"
                          allowDecimal={false}
                          value={editAge}
                          onChange={setEditAge}
                          placeholder="e.g. 34"
                          data-testid="input-edit-age"
                        />
                      </div>
                      {(editRelationship === "Partnered" || editRelationship === "Married") && (
                        <>
                          <div className="space-y-2">
                            <Label htmlFor="edit-partner-name">
                              Partner's Full Name
                            </Label>
                            <Input
                              id="edit-partner-name"
                              value={editPartnerName}
                              onChange={e => setEditPartnerName(e.target.value)}
                              placeholder="Partner's full name"
                              data-testid="input-edit-partner-name"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="edit-partner-age">
                              Partner's Age
                            </Label>
                            <NumberInput
                              id="edit-partner-age"
                              allowDecimal={false}
                              value={editPartnerAge}
                              onChange={setEditPartnerAge}
                              placeholder="Partner's age"
                              data-testid="input-edit-partner-age"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Partner's Gender</Label>
                            <OptionPills
                              options={PARTNER_GENDER_OPTIONS}
                              value={editPartnerGender}
                              onChange={setEditPartnerGender}
                              testIdPrefix="pill-partner-gender"
                            />
                          </div>
                        </>
                      )}
                      <div className="space-y-2 md:col-span-2">
                        <Label>Services You're Looking For</Label>
                        <div className="flex flex-wrap gap-2" data-testid="edit-services">
                          {["Fertility Clinic", "Egg Donor", "Surrogate", "Sperm Donor"].map((svc) => (
                            <button
                              key={svc}
                              type="button"
                              onClick={() =>
                                setEditServices((prev) =>
                                  prev.includes(svc) ? prev.filter((s) => s !== svc) : [...prev, svc]
                                )
                              }
                              className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                                editServices.includes(svc)
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "bg-background text-foreground border-border hover:border-primary/50"
                              }`}
                              data-testid={`btn-service-${svc.toLowerCase().replace(/\s+/g, "-")}`}
                            >
                              {svc}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
              <div className="space-y-2">
                <Label htmlFor="edit-password">New Password</Label>
                <div className="relative">
                  <Input
                    id="edit-password"
                    type={showPassword ? "text" : "password"}
                    value={editPassword}
                    onChange={e => setEditPassword(e.target.value)}
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
                {editPassword && editPassword.length < 6 && (
                  <p className="text-xs text-destructive">Minimum 6 characters</p>
                )}
                {editPassword && (
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
                    {confirmPassword && editPassword !== confirmPassword && (
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
              {providerName && (
                <div className="space-y-2">
                  <Label>Organization</Label>
                  <div className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border border-border/40 bg-muted/30">
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground" data-testid="text-account-provider">{providerName}</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Full Name</Label>
                <Input disabled value={user.name || ""} placeholder="-- Not specified --" data-testid="text-account-name" />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <div className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border border-border/40 bg-muted/30">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground" data-testid="text-account-email">{user.email}</span>
                </div>
                <p className="text-xs text-muted-foreground">Email cannot be changed</p>
              </div>
              <div className="space-y-2">
                <Label>Mobile Number</Label>
                <Input disabled value={mobileNumberDisplay || formatPhoneDisplay(mobileNumber)} placeholder="-- Not specified --" data-testid="text-account-mobile" />
              </div>
              {!isProviderUser && (
                <>
                  <div className="space-y-2">
                    <Label>Location</Label>
                    <Input disabled value={locationDisplay || ""} placeholder="-- Not specified --" data-testid="text-account-location" />
                  </div>
                  {isParent && (
                    <>
                      <div className="space-y-2">
                        <Label>Gender Identity</Label>
                        <OptionPills
                          options={GENDER_OPTIONS}
                          value={(user as any).gender || ""}
                          onChange={() => {}}
                          disabled
                          testIdPrefix="pill-gender"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Sexual Orientation</Label>
                        <OptionPills
                          options={ORIENTATION_OPTIONS}
                          value={(user as any).sexualOrientation || ""}
                          onChange={() => {}}
                          disabled
                          testIdPrefix="pill-orientation"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label>Relationship Status</Label>
                        <OptionPills
                          options={RELATIONSHIP_OPTIONS}
                          value={(user as any).relationshipStatus || ""}
                          onChange={() => {}}
                          disabled
                          testIdPrefix="pill-relationship"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Your Age</Label>
                        {/* short age display, disabled, no commas needed */}
                        <Input
                          disabled
                          type="number"
                          value={(user as any).dateOfBirth ? String(new Date().getFullYear() - new Date((user as any).dateOfBirth).getFullYear()) : ""}
                          placeholder="-- Not specified --"
                          data-testid="text-account-age"
                        />
                      </div>
                      {((user as any).relationshipStatus === "Partnered" || (user as any).relationshipStatus === "Married") && (
                        <>
                          <div className="space-y-2">
                            <Label>Partner's Full Name</Label>
                            <Input disabled value={(user as any).partnerFirstName || ""} placeholder="-- Not specified --" data-testid="text-account-partner-name" />
                          </div>
                          <div className="space-y-2">
                            <Label>Partner's Age</Label>
                            {/* short age display, disabled, no commas needed */}
                            <Input disabled type="number" value={(user as any).partnerAge || ""} placeholder="-- Not specified --" data-testid="text-account-partner-age" />
                          </div>
                          <div className="space-y-2">
                            <Label>Partner's Gender</Label>
                            <OptionPills
                              options={PARTNER_GENDER_OPTIONS}
                              value={(user as any).partnerGender || ""}
                              onChange={() => {}}
                              disabled
                              testIdPrefix="pill-partner-gender"
                            />
                          </div>
                        </>
                      )}
                      <div className="space-y-2 md:col-span-2">
                        <Label>Services You're Looking For</Label>
                        <div className="flex flex-wrap gap-2" data-testid="text-account-services">
                          {["Fertility Clinic", "Egg Donor", "Surrogate", "Sperm Donor"].map((svc) => {
                            const selected = (parentProfileQuery.data?.interestedServices || []).includes(svc);
                            return (
                              <span key={svc} className={`px-3 py-1 text-sm rounded-full border font-ui ${selected ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground border-border opacity-50"}`}>
                                {svc}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
              <div className="space-y-2">
                <Label>Password</Label>
                <Input disabled type="password" value="placeholder" placeholder="••••••••" data-testid="text-account-password" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-ui text-muted-foreground uppercase tracking-wider">Role</label>
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-sm font-ui" data-testid="text-account-role">{roleDisplay}</p>
                </div>
              </div>
              {providerName && (
                <div className="space-y-1">
                  <label className="text-xs font-ui text-muted-foreground uppercase tracking-wider">Organization</label>
                  <div className="flex items-center gap-2">
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                    <p className="text-sm font-ui" data-testid="text-account-provider">{providerName}</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>

    {isParent && (() => {
      const services: string[] = editing ? editServices : (parentProfileQuery.data?.interestedServices || []);
      const hasClinic = services.includes("Fertility Clinic");
      const hasSurrogate = services.includes("Surrogate");
      const hasEggDonor = services.includes("Egg Donor");
      const hasSpermDonor = services.includes("Sperm Donor");
      return (
      <>
        {/* Biological Baseline */}
        <ProfileSection
          title="Biological Baseline"
          editing={editingSection === "biological"}
          forceShow
          data={parentProfileQuery.data}
          onEdit={() => startEditingSection("biological")}
          onSave={saveSectionBiological}
          onCancel={() => setEditingSection(null)}
          saving={sectionSaving}
          fields={[
            { label: "Current Clinic", key: "currentClinicName", value: editCurrentClinicName, setter: setEditCurrentClinicName, type: "text" },
            { label: "Egg Source", key: "eggSource", value: editEggSource, setter: setEditEggSource, type: "select",
              options: eggSourceOptions },
            { label: "Sperm Source", key: "spermSource", value: editSpermSource, setter: setEditSpermSource, type: "select",
              options: spermSourceOptions },
            { label: "Carrier", key: "carrier", value: editCarrier, setter: setEditCarrier, type: "select",
              options: carrierOptions },
            { label: "Has Embryos", key: "hasEmbryos", value: editHasEmbryos, setter: setEditHasEmbryos, type: "yesno" },
            { label: "Number of Frozen Embryos", key: "embryoCount", value: editEmbryoCount, setter: setEditEmbryoCount, type: "number",
              showIf: editingSection === "biological" ? (editHasEmbryos === "true" || editHasEmbryos === "") : (parentProfileQuery.data?.hasEmbryos === true),
              display: (v: any) => v != null && v !== "" && Number(v) > 0 ? String(v) : null },
            { label: "PGT-A Tested", key: "embryosTested", value: editEmbryosTested, setter: setEditEmbryosTested, type: "yesno",
              showIf: editingSection === "biological" ? (editHasEmbryos === "true" || editHasEmbryos === "") : (parentProfileQuery.data?.hasEmbryos === true),
              display: (v: any) => v === true || v === "true" ? "Yes" : v === false || v === "false" ? "No" : null },
          ]}
        />

        {/* Clinic Preferences - only if registered for Fertility Clinic */}
        {hasClinic && <ProfileSection
          title="IVF Clinic Preferences"
          editing={editingSection === "clinic"}
          forceShow
          data={parentProfileQuery.data}
          onEdit={() => startEditingSection("clinic")}
          onSave={saveSectionClinic}
          onCancel={() => setEditingSection(null)}
          saving={sectionSaving}
          fields={[
            { label: "Needs Clinic", key: "needsClinic", value: editNeedsClinic, setter: setEditNeedsClinic, type: "yesno",
              display: (v: any) => v === true || v === "true" ? "Yes - needs a clinic" : v === false || v === "false" ? "No - has one" : null },
            { label: "First IVF Journey", key: "isFirstIvf", value: editIsFirstIvf, setter: setEditIsFirstIvf, type: "yesno",
              display: (v: any) => v === true || v === "true" ? "Yes - first time" : v === false || v === "false" ? "No - done IVF before" : null },
            { label: "Patient Age Group", key: "clinicAgeGroup", value: editClinicAgeGroup, setter: setEditClinicAgeGroup, type: "select",
              options: ["Under 35", "35-37", "38-40", "Over 40"] },
            { label: "What matters most to you in a clinic?", key: "clinicPriorityTags", value: editClinicPriorityTags, setter: setEditClinicPriorityTags, type: "multiselect",
              options: ["Success rates", "Location", "Cost", "Volume of cycles", "Physician gender", "LGBTQ+ friendly", "Donor egg program", "Gestational carrier program", "Language support", "Personalized care"] },
            { label: "Your insurance", key: "insurance", value: editInsurance, setter: setEditInsurance, type: "insurance" },
            { label: "Additional notes", key: "clinicPriority", value: editClinicPriority, setter: setEditClinicPriority, type: "textarea" },
          ]}
        />}

        {/* Surrogate Preferences - only if registered for Surrogate */}
        {hasSurrogate && <ProfileSection
          title="Surrogate Preferences"
          editing={editingSection === "surrogate"}
          forceShow
          data={parentProfileQuery.data}
          onEdit={() => startEditingSection("surrogate")}
          onSave={saveSectionSurrogate}
          onCancel={() => setEditingSection(null)}
          saving={sectionSaving}
          fields={[
            // --- Asked in conversation (D1, D2, D3) ---
            { label: "Countries Open To", key: "surrogateCountries", value: editSurrogateCountries, setter: setEditSurrogateCountries, type: "multiselect",
              options: SURROGACY_COUNTRIES },
            { label: "Termination Preference", key: "surrogateTermination", value: editSurrogateTermination, setter: setEditSurrogateTermination, type: "select",
              options: ["Required", "Preferred", "Open to discuss", "No preference"] },
            { label: "Agrees to Twins", key: "surrogateTwins", value: editSurrogateTwins, setter: setEditSurrogateTwins, type: "select",
              options: ["Yes", "No"] },
            // --- Preference filters (set manually) ---
            { label: "Surrogate Age Range", key: "surrogateAgeRange", value: editSurrogateAgeRange, setter: setEditSurrogateAgeRange, type: "range",
              rangeMin: 18, rangeMax: 45, rangeStep: 1 },
            { label: "BMI Range", key: "surrogateBmiRange", value: editSurrogateBmiRange, setter: setEditSurrogateBmiRange, type: "range",
              rangeMin: 16, rangeMax: 40, rangeStep: 1 },
            { label: "Base Compensation", key: "surrogateBudget", value: editSurrogateBudget, setter: setEditSurrogateBudget, type: "range",
              rangeMin: 0, rangeMax: 200000, rangeStep: 5000, rangeUnit: "$" },
            { label: "Total Cost", key: "surrogateTotalCostRange", value: editSurrogateTotalCostRange, setter: setEditSurrogateTotalCostRange, type: "range",
              rangeMin: 0, rangeMax: 500000, rangeStep: 10000, rangeUnit: "$" },
            { label: "Race", key: "surrogateRace", value: editSurrogateRace, setter: setEditSurrogateRace, type: "multiselect",
              options: ["Asian", "Black", "Hispanic", "White", "Mixed", "Other"] },
            { label: "Ethnicity", key: "surrogateEthnicity", value: editSurrogateEthnicity, setter: setEditSurrogateEthnicity, type: "multiselect",
              options: ["Brazilian", "Chinese", "Colombian", "Cuban", "English", "Ethiopian", "Filipino", "French", "German", "Haitian",
                "Indian", "Irish", "Israeli", "Italian", "Jamaican", "Japanese", "Korean", "Mexican", "Middle Eastern",
                "Nigerian", "Persian", "Polish", "Puerto Rican", "Russian", "Turkish", "Vietnamese", "Other"] },
            { label: "Relationship Status", key: "surrogateRelationship", value: editSurrogateRelationship, setter: setEditSurrogateRelationship, type: "multiselect",
              options: ["Single", "Married", "Partnered", "Divorced"] },
            { label: "Live Births Range", key: "surrogateLiveBirthsRange", value: editSurrogateLiveBirthsRange, setter: setEditSurrogateLiveBirthsRange, type: "range",
              rangeMin: 0, rangeMax: 10, rangeStep: 1 },
            { label: "Max C-Sections", key: "surrogateMaxCSections", value: editSurrogateMaxCSections, setter: setEditSurrogateMaxCSections, type: "singleslider",
              rangeMin: 0, rangeMax: 5, rangeStep: 1 },
            { label: "Max Miscarriages", key: "surrogateMaxMiscarriages", value: editSurrogateMaxMiscarriages, setter: setEditSurrogateMaxMiscarriages, type: "singleslider",
              rangeMin: 0, rangeMax: 5, rangeStep: 1 },
            { label: "Max Abortions", key: "surrogateMaxAbortions", value: editSurrogateMaxAbortions, setter: setEditSurrogateMaxAbortions, type: "singleslider",
              rangeMin: 0, rangeMax: 5, rangeStep: 1 },
            { label: "Last Delivery Year (since)", key: "surrogateLastDeliveryYear", value: editSurrogateLastDeliveryYear, setter: setEditSurrogateLastDeliveryYear, type: "number" },
            { label: "Agrees to Selective Reduction", key: "surrogateSelectiveReduction", value: editSurrogateSelectiveReduction, setter: setEditSurrogateSelectiveReduction, type: "yesno",
              display: (v: any) => v === true || v === "true" ? "Yes" : v === false || v === "false" ? "No" : null },
            { label: "Open to International Parents", key: "surrogateInternationalParents", value: editSurrogateInternationalParents, setter: setEditSurrogateInternationalParents, type: "yesno",
              display: (v: any) => v === true || v === "true" ? "Yes" : v === false || v === "false" ? "No" : null },
            { label: "Open to Same-Sex Couple", key: "sameSexCouple", value: editSameSexCouple, setter: setEditSameSexCouple, type: "yesno",
              display: (v: any) => v === true || v === "true" ? "Yes" : v === false || v === "false" ? "No" : null },
            { label: "COVID Vaccinated Required", key: "surrogateCovidVaccinated", value: editSurrogateCovidVaccinated, setter: setEditSurrogateCovidVaccinated, type: "yesno",
              display: (v: any) => v === true || v === "true" ? "Yes" : v === false || v === "false" ? "No" : null },
            { label: "Experience Preference", key: "surrogateExperience", value: editSurrogateExperience, setter: setEditSurrogateExperience, type: "select",
              options: ["First-time ok", "Experienced preferred", "Experienced only", "No preference"] },
            { label: "Medical Preferences", key: "surrogateMedPrefs", value: editSurrogateMedPrefs, setter: setEditSurrogateMedPrefs, type: "textarea" },
          ]}
        />}

        {/* Egg Donor Preferences - only if registered for Egg Donor */}
        {hasEggDonor && <ProfileSection
          title="Egg Donor Preferences"
          editing={editingSection === "eggDonor"}
          forceShow
          data={parentProfileQuery.data}
          onEdit={() => startEditingSection("eggDonor")}
          onSave={saveSectionEggDonor}
          onCancel={() => setEditingSection(null)}
          saving={sectionSaving}
          fields={[
            { label: "Eye Color", key: "donorEyeColor", value: editDonorEyeColor, setter: setEditDonorEyeColor, type: "multiselect",
              options: ["Brown", "Blue", "Green", "Hazel", "Gray", "Amber"] },
            { label: "Hair Color", key: "donorHairColor", value: editDonorHairColor, setter: setEditDonorHairColor, type: "multiselect",
              options: ["Black", "Brown", "Blonde", "Red", "Auburn", "Gray"] },
            { label: "Height Range", key: "donorHeight", value: editDonorHeight, setter: setEditDonorHeight, type: "range",
              rangeMin: 48, rangeMax: 84, rangeStep: 1,
              formatValue: (v: number) => { const ft = Math.floor(v / 12); return `${ft}'${v % 12}"`; } },
            { label: "Ethnicity", key: "donorEthnicity", value: editDonorEthnicity, setter: setEditDonorEthnicity, type: "multiselect",
              options: ["Asian", "Black", "Hispanic", "White", "Mixed", "Other",
                "Chinese", "Japanese", "Korean", "Vietnamese", "Filipino", "Indian",
                "Mexican", "Puerto Rican", "Cuban", "Colombian",
                "Italian", "Irish", "German", "French", "English", "Polish", "Russian",
                "Nigerian", "Ethiopian", "Jamaican", "Haitian",
                "Middle Eastern", "Persian", "Turkish", "Brazilian"] },
            { label: "Education", key: "donorEducation", value: editDonorEducation, setter: setEditDonorEducation, type: "select",
              options: ["High School", "Some College", "Associate", "Bachelor", "Master", "Doctorate"] },
            { label: "Donation Type", key: "eggDonorDonationType", value: editEggDonorDonationType, setter: setEditEggDonorDonationType, type: "select",
              options: ["Anonymous", "Semi-Open", "Open ID", "Known"] },
            { label: "Donor Age Range", key: "eggDonorAgeRange", value: editEggDonorAgeRange, setter: setEditEggDonorAgeRange, type: "range",
              rangeMin: 18, rangeMax: 45, rangeStep: 1 },
            { label: "Egg Type", key: "eggDonorEggType", value: editEggDonorEggType, setter: setEditEggDonorEggType, type: "select",
              options: ["Fresh", "Frozen", "Either"] },
            { label: "Donor Compensation", key: "eggDonorCompensationRange", value: editEggDonorCompensationRange, setter: setEditEggDonorCompensationRange, type: "range",
              rangeMin: 0, rangeMax: 200000, rangeStep: 5000, rangeUnit: "$", showIf: showFreshCosts },
            { label: "Total Cost", key: "eggDonorTotalCostRange", value: editEggDonorTotalCostRange, setter: setEditEggDonorTotalCostRange, type: "range",
              rangeMin: 0, rangeMax: 200000, rangeStep: 5000, rangeUnit: "$", showIf: showFreshCosts },
            { label: "Egg Lot Cost", key: "eggDonorLotCostRange", value: editEggDonorLotCostRange, setter: setEditEggDonorLotCostRange, type: "range",
              rangeMin: 0, rangeMax: 50000, rangeStep: 500, rangeUnit: "$", showIf: showFrozenCost },
            { label: "Preferences Summary", key: "donorPreferences", value: editDonorPreferences, setter: setEditDonorPreferences, type: "textarea" },
          ]}
        />}

        {/* Sperm Donor Preferences - only if registered for Sperm Donor */}
        {hasSpermDonor && <ProfileSection
          title="Sperm Donor Preferences"
          editing={editingSection === "spermDonor"}
          forceShow
          data={parentProfileQuery.data}
          onEdit={() => startEditingSection("spermDonor")}
          onSave={saveSectionSpermDonor}
          onCancel={() => setEditingSection(null)}
          saving={sectionSaving}
          fields={[
            { label: "Eye Color", key: "spermDonorEyeColor", value: editSpermDonorEyeColor, setter: setEditSpermDonorEyeColor, type: "multiselect",
              options: ["Brown", "Blue", "Green", "Hazel", "Gray", "Amber"] },
            { label: "Hair Color", key: "spermDonorHairColor", value: editSpermDonorHairColor, setter: setEditSpermDonorHairColor, type: "multiselect",
              options: ["Black", "Brown", "Blonde", "Red", "Auburn", "Gray"] },
            { label: "Race", key: "spermDonorRace", value: editSpermDonorRace, setter: setEditSpermDonorRace, type: "multiselect",
              options: ["Asian", "Black", "Hispanic", "White", "Mixed", "Other"] },
            { label: "Ethnicity", key: "spermDonorEthnicity", value: editSpermDonorEthnicity, setter: setEditSpermDonorEthnicity, type: "multiselect",
              options: ["Brazilian", "Chinese", "Colombian", "Cuban", "English", "Ethiopian", "Filipino", "French", "German", "Haitian",
                "Indian", "Irish", "Israeli", "Italian", "Jamaican", "Japanese", "Korean", "Mexican", "Middle Eastern",
                "Nigerian", "Persian", "Polish", "Puerto Rican", "Russian", "Turkish", "Vietnamese", "Other"] },
            { label: "Education", key: "spermDonorEducation", value: editSpermDonorEducation, setter: setEditSpermDonorEducation, type: "select",
              options: ["High School", "Some College", "Associate", "Bachelor", "Master", "Doctorate"] },
            { label: "Donor Age Range", key: "spermDonorAgeRange", value: editSpermDonorAgeRange, setter: setEditSpermDonorAgeRange, type: "range",
              rangeMin: 18, rangeMax: 45, rangeStep: 1 },
            { label: "Height Range", key: "spermDonorHeightRange", value: editSpermDonorHeightRange, setter: setEditSpermDonorHeightRange, type: "range",
              rangeMin: 48, rangeMax: 84, rangeStep: 1,
              formatValue: (v: number) => { const ft = Math.floor(v / 12); return `${ft}'${v % 12}"`; } },
            { label: "Donor Type", key: "spermDonorType", value: editSpermDonorType, setter: setEditSpermDonorType, type: "select",
              options: ["Open", "Anonymous", "Exclusive"] },
            // --- Preference filters (set manually) ---
            { label: "Max Cost", key: "spermDonorMaxPrice", value: editSpermDonorMaxPrice, setter: setEditSpermDonorMaxPrice, type: "singleslider",
              rangeMin: 0, rangeMax: 5000, rangeStep: 100,
              formatValue: (v: number) => formatMoneyDollars(v) },
            { label: "Vial Type Availability", key: "spermDonorVialType", value: editSpermDonorVialType, setter: setEditSpermDonorVialType, type: "multiselect",
              options: ["ICI", "IUI", "IVF"] },
            { label: "Additional Preferences", key: "spermDonorPreferences", value: editSpermDonorPreferences, setter: setEditSpermDonorPreferences, type: "textarea" },
          ]}
        />}

        {/* Current Providers */}
        <ProfileSection
          title="Current Providers"
          editing={editingSection === "providers"}
          data={parentProfileQuery.data}
          onEdit={() => startEditingSection("providers")}
          onSave={saveSectionProviders}
          onCancel={() => setEditingSection(null)}
          saving={sectionSaving}
          fields={[
            { label: "Agency", key: "currentAgencyName", value: editCurrentAgencyName, setter: setEditCurrentAgencyName, type: "text" },
            { label: "Attorney", key: "currentAttorneyName", value: editCurrentAttorneyName, setter: setEditCurrentAttorneyName, type: "text" },
          ]}
        />
      </>
      );
    })()}
    </>
  );
}

type ProfileFieldDef = {
  label: string;
  key: string;
  value: string;
  setter: (v: string) => void;
  type: "text" | "textarea" | "number" | "yesno" | "select" | "multiselect" | "range" | "singleslider";
  options?: string[];
  // for range / singleslider types
  rangeMin?: number;
  rangeMax?: number;
  rangeStep?: number;
  rangeUnit?: string; // "$", "", etc.
  formatValue?: (v: number) => string;
  display?: (v: any, data?: any) => string | null;
  showIf?: boolean;
};

function ProfileSection({ title, editing, data, fields, forceShow, onEdit, onSave, onCancel, saving }: {
  title: string;
  editing: boolean;
  data: any;
  fields: ProfileFieldDef[];
  forceShow?: boolean;
  onEdit?: () => void;
  onSave?: () => void;
  onCancel?: () => void;
  saving?: boolean;
}) {
  const activeFields = fields.filter(f => f.showIf === undefined || f.showIf !== false);
  const hasAnyValue = activeFields.some(f => {
    const raw = data?.[f.key];
    if (raw == null || raw === "") return false;
    if (f.display) return f.display(raw, data) != null;
    return String(raw).trim() !== "";
  });

  if (!editing && !hasAnyValue && !forceShow) return null;

  return (
    <Card className="p-8 mt-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-heading">{title}</h2>
        {!editing && onEdit && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
          </Button>
        )}
        {editing && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving}>
              {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
        {activeFields.map((f) => {
          const raw = data?.[f.key];
          const isDisabled = !editing;

          // Unified value: f.value when editing, raw data converted to string when viewing
          const effectiveValue = editing
            ? f.value
            : (() => {
                if (raw == null || raw === "") return "";
                if (f.type === "yesno") return raw === true || raw === "true" ? "true" : raw === false || raw === "false" ? "false" : "";
                return String(raw);
              })();
          const effectiveSetter: (v: string) => void = editing ? f.setter : () => {};

          // In view mode, skip fields with no value unless forceShow is set
          if (isDisabled && !forceShow && (effectiveValue === "" || effectiveValue == null)) return null;

          if (f.type === "insurance") {
            const arr: string[] = editing ? (f.value || []) : (raw ? [raw] : []);
            return (
              <div key={f.key} className="space-y-2 md:col-span-2">
                <Label>{f.label}</Label>
                {editing ? (
                  <InsurancePicker value={arr} onChange={f.setter} mode="single" />
                ) : (
                  <p className="text-sm text-muted-foreground">{raw || "Not set"}</p>
                )}
              </div>
            );
          }
          if (f.type === "yesno") {
            return (
              <div key={f.key} className="space-y-2">
                <Label>{f.label}</Label>
                <Select value={effectiveValue} onValueChange={effectiveSetter} disabled={isDisabled}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Yes</SelectItem>
                    <SelectItem value="false">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            );
          }
          if (f.type === "select") {
            return (
              <div key={f.key} className="space-y-2">
                <Label>{f.label}</Label>
                <Select value={effectiveValue || "__none__"} onValueChange={v => effectiveSetter(v === "__none__" ? "" : v)} disabled={isDisabled}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">-- Not specified --</SelectItem>
                    {(f.options || []).map(opt => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          }
          if (f.type === "multiselect") {
            const selected = effectiveValue ? effectiveValue.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : [];
            const toggle = (opt: string) => {
              const key = opt.toLowerCase();
              const next = selected.includes(key)
                ? selected.filter(s => s !== key)
                : [...selected, key];
              effectiveSetter(next.join(","));
            };
            return (
              <div key={f.key} className="space-y-2 md:col-span-2">
                <Label>{f.label}</Label>
                <div className="flex flex-wrap gap-1.5">
                  {(f.options || []).map(opt => {
                    const isSelected = selected.includes(opt.toLowerCase());
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={isDisabled ? undefined : () => toggle(opt)}
                        disabled={isDisabled}
                        className={`px-3 py-1 text-sm rounded-full border transition-colors font-ui ${
                          isSelected
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-foreground border-border"
                        } ${isDisabled ? "opacity-60 cursor-default" : "hover:bg-secondary/60"}`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }
          if (f.type === "range") {
            const min = f.rangeMin ?? 0;
            const max = f.rangeMax ?? 100;
            const step = f.rangeStep ?? 1;
            const parts = effectiveValue ? effectiveValue.split(",") : [];
            const lo = parts[0] ? Number(parts[0]) : min;
            const hi = parts[1] ? Number(parts[1]) : max;
            const fmt = f.formatValue ?? ((v: number) => f.rangeUnit === "$" ? formatMoneyDollars(v) : String(v));
            return (
              <div key={f.key} className="space-y-3 md:col-span-2">
                <div className="flex items-center justify-between">
                  <Label>{f.label}</Label>
                  <span className="text-sm font-ui text-muted-foreground">{fmt(lo)} - {fmt(hi)}</span>
                </div>
                <Slider
                  min={min} max={max} step={step}
                  value={[lo, hi]}
                  onValueChange={isDisabled ? undefined : ([a, b]) => effectiveSetter(`${a},${b}`)}
                  disabled={isDisabled}
                />
              </div>
            );
          }
          if (f.type === "singleslider") {
            const min = f.rangeMin ?? 0;
            const max = f.rangeMax ?? 10;
            const step = f.rangeStep ?? 1;
            const current = effectiveValue !== "" ? Number(effectiveValue) : max;
            const fmt = f.formatValue ?? ((v: number) => String(v));
            const isAtMax = current >= max;
            return (
              <div key={f.key} className="space-y-3 md:col-span-2">
                <div className="flex items-center justify-between">
                  <Label>{f.label}</Label>
                  <span className="text-sm font-ui text-muted-foreground">
                    {isAtMax ? "Any" : `Up to ${fmt(current)}`}
                  </span>
                </div>
                <Slider
                  min={min} max={max} step={step}
                  value={[current]}
                  onValueChange={isDisabled ? undefined : ([v]) => effectiveSetter(v >= max ? "" : String(v))}
                  disabled={isDisabled}
                />
              </div>
            );
          }
          if (f.type === "textarea") {
            return (
              <div key={f.key} className="space-y-2 md:col-span-2">
                <Label>{f.label}</Label>
                <textarea
                  value={effectiveValue}
                  onChange={e => effectiveSetter(e.target.value)}
                  placeholder={`Enter ${f.label.toLowerCase()}`}
                  rows={3}
                  disabled={isDisabled}
                  className="w-full px-3 py-2 text-sm rounded-[var(--radius)] border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 disabled:cursor-default disabled:resize-none"
                />
              </div>
            );
          }
          return (
            <div key={f.key} className="space-y-2">
              <Label>{f.label}</Label>
              <Input
                type={f.type === "number" ? "number" : "text"}
                value={effectiveValue}
                onChange={e => effectiveSetter(e.target.value)}
                placeholder={`Enter ${f.label.toLowerCase()}`}
                min={f.type === "number" ? 0 : undefined}
                disabled={isDisabled}
              />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TeamTab() {
  const { user } = useAuth();
  if (!user) return null;

  const providerId = (user as any).providerId;
  const roles = (user as any).roles || [];
  const isProvider = hasProviderRole(roles);
  const gostorkRoles = ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"];
  const isGostorkTeam = roles.some((r: string) => gostorkRoles.includes(r));

  if (isProvider && providerId) {
    const canManage = roles.includes("PROVIDER_ADMIN") || roles.includes("GOSTORK_ADMIN");
    return <MembersTable context="provider" providerId={providerId} currentUserId={(user as any).id} canManage={canManage} />;
  }

  if (isGostorkTeam) {
    return <MembersTable context="gostork" currentUserId={(user as any).id} canManage={roles.includes("GOSTORK_ADMIN")} />;
  }

  return (
    <Card className="p-12 text-center text-muted-foreground" data-testid="team-placeholder">
      <Users className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
      <p>Team management coming soon.</p>
    </Card>
  );
}


function ParentCalendarTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [googleConnecting, setGoogleConnecting] = useState(false);
  const [deleteConnId, setDeleteConnId] = useState<string | null>(null);

  const { data: connections } = useQuery<{
    id: string; provider: string; label: string | null; email: string | null;
    isConflictCalendar: boolean; isBookingCalendar: boolean; color: string; connected: boolean; tokenValid?: boolean;
  }[]>({
    queryKey: ["/api/calendar/connections"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/connections", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch connections");
      return res.json();
    },
  });

  const { data: googleStatus } = useQuery<{ configured: boolean }>({
    queryKey: ["/api/calendar/google/status"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/google/status", { credentials: "include" });
      if (!res.ok) return { configured: false };
      return res.json();
    },
  });

  const { data: googleCalendars } = useQuery<any[]>({
    queryKey: ["/api/calendar/google/calendars", "parent-connect"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/google/calendars", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: false,
  });

  const [connectStep, setConnectStep] = useState<"idle" | "select-calendars">("idle");
  const [connectingEmail, setConnectingEmail] = useState<string | null>(null);
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);
  const [calendarList, setCalendarList] = useState<any[]>([]);
  const [loadingCalendars, setLoadingCalendars] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("google_connected") === "1") {
      const mode = params.get("mode");
      const returnedEmail = params.get("email") || null;
      if (mode === "existing") {
        toast({ title: `Google Calendar tokens refreshed${returnedEmail ? ` for ${returnedEmail}` : ""}!`, variant: "success" });
      } else {
        toast({ title: `Google account connected! Select calendars to sync.`, variant: "success" });
        setConnectingEmail(returnedEmail);
        setConnectStep("select-calendars");
        setLoadingCalendars(true);
        const emailParam = returnedEmail ? `?email=${encodeURIComponent(returnedEmail)}` : "";
        fetch(`/api/calendar/google/calendars${emailParam}`, { credentials: "include" })
          .then(r => r.json())
          .then(cals => { setCalendarList(cals || []); setSelectedCalendarIds((cals || []).map((c: any) => c.id)); })
          .catch(() => toast({ title: "Failed to load calendars", variant: "destructive" }))
          .finally(() => setLoadingCalendars(false));
      }
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("google_error")) {
      toast({ title: "Google Calendar Error", description: decodeURIComponent(params.get("google_error") || ""), variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const updateConnectionMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest("PATCH", `/api/calendar/connections/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
    },
  });

  const deleteConnectionMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/calendar/connections/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
      setDeleteConnId(null);
      toast({ title: "Calendar disconnected", variant: "success" });
    },
  });

  const addConnectionMutation = useMutation({
    mutationFn: async ({ calendarIds, email }: { calendarIds: string[]; email?: string | null }) => {
      const res = await apiRequest("POST", "/api/calendar/google/connect", {
        calendarIds,
        email: email || undefined,
        conflictCalendarIds: calendarIds,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
      setConnectStep("idle");
      setSelectedCalendarIds([]);
      setCalendarList([]);
      setConnectingEmail(null);
      toast({ title: "Calendars connected", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  async function startGoogleConnect() {
    if (!googleStatus?.configured) {
      toast({ title: "Google Calendar not configured", description: "Google OAuth credentials need to be set up by an administrator.", variant: "destructive" });
      return;
    }
    setGoogleConnecting(true);
    try {
      const res = await fetch("/api/calendar/google/auth-url", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to get auth URL");
      const { url } = await res.json();
      window.location.href = url;
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
      setGoogleConnecting(false);
    }
  }

  const hasConnections = connections && connections.length > 0;
  const expiredConnections = connections?.filter((c) => c.tokenValid === false) ?? [];

  if (connectStep === "select-calendars") {
    return (
      <Card className="p-6" data-testid="parent-calendar-select">
        <h2 className="text-lg font-heading mb-2">Select Calendars to Connect</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {connectingEmail && <span className="font-ui text-foreground">{connectingEmail} - </span>}
          Select which calendars to use for checking your availability when booking appointments.
        </p>
        {loadingCalendars ? (
          <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : calendarList.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No calendars found.</p>
        ) : (
          <div className="space-y-2 mb-4">
            {calendarList.map((cal: any) => {
              const isSelected = selectedCalendarIds.includes(cal.id);
              return (
                <button
                  key={cal.id}
                  onClick={() => setSelectedCalendarIds(prev => isSelected ? prev.filter(id => id !== cal.id) : [...prev, cal.id])}
                  className={`w-full flex items-center gap-3 p-3 rounded-[var(--radius)] border transition-colors cursor-pointer text-left ${
                    isSelected ? "border-primary/50 bg-primary/5" : "border-border/50 hover:bg-secondary/30"
                  }`}
                  data-testid={`button-gcal-${cal.id}`}
                >
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    isSelected ? "bg-primary border-primary" : "border-muted-foreground/30"
                  }`}>
                    {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                  </div>
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cal.backgroundColor || "#4285f4" }} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-ui truncate block">{cal.summary}</span>
                    <span className="text-xs text-muted-foreground truncate block">{cal.id}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <div className="flex gap-3">
          <Button
            onClick={() => addConnectionMutation.mutate({ calendarIds: selectedCalendarIds, email: connectingEmail })}
            disabled={selectedCalendarIds.length === 0 || addConnectionMutation.isPending}
            data-testid="button-connect-selected"
          >
            {addConnectionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
            Connect Selected ({selectedCalendarIds.length})
          </Button>
          <Button variant="outline" onClick={() => { setConnectStep("idle"); setCalendarList([]); setSelectedCalendarIds([]); }}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-6" data-testid="parent-calendar-connect-section">
        <div className="flex items-center gap-2 mb-2">
          <Calendar className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-heading">Google Calendar</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Connect your Google Calendar to automatically filter available booking slots based on your schedule, and sync confirmed appointments to your calendar.
        </p>

        {expiredConnections.length > 0 && (
          <div className="mb-4 rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.4)] bg-[hsl(var(--brand-warning)/0.08)] p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-[hsl(var(--brand-warning))] shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-ui font-medium text-foreground">
                  {expiredConnections.length === 1 ? "A calendar connection has expired" : `${expiredConnections.length} calendar connections have expired`}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  New bookings won't sync until you reconnect. Click below to fix this now.
                </p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {expiredConnections.map((conn) => (
                    <Button
                      key={conn.id}
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs font-ui border-[hsl(var(--brand-warning)/0.5)] text-foreground hover:bg-[hsl(var(--brand-warning)/0.1)]"
                      disabled={googleConnecting}
                      onClick={async () => {
                        setGoogleConnecting(true);
                        try {
                          const hint = conn.email ? `?login_hint=${encodeURIComponent(conn.email)}` : "";
                          const res = await fetch(`/api/calendar/google/auth-url${hint}`, { credentials: "include" });
                          const data = await res.json();
                          if (!res.ok) {
                            toast({ title: data.message || "Failed to start reconnection", variant: "destructive" });
                            setGoogleConnecting(false);
                            return;
                          }
                          if (data.url) window.location.href = data.url;
                          else {
                            toast({ title: "Failed to start reconnection", variant: "destructive" });
                            setGoogleConnecting(false);
                          }
                        } catch {
                          toast({ title: "Failed to start reconnection", variant: "destructive" });
                          setGoogleConnecting(false);
                        }
                      }}
                    >
                      {googleConnecting ? (
                        <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
                      ) : (
                        <Calendar className="w-3.5 h-3.5 mr-1.5" />
                      )}
                      Reconnect {conn.label || conn.email || "Google Calendar"}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {!hasConnections ? (
          <Button onClick={startGoogleConnect} disabled={googleConnecting} data-testid="button-connect-google">
            {googleConnecting ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <CalendarPlus className="w-4 h-4 mr-1.5" />}
            Connect Google Calendar
          </Button>
        ) : (
          <div className="space-y-4">
            {connections!.map((conn) => (
              <div key={conn.id} className="rounded-[var(--radius)] border border-border/30 bg-secondary/10 p-4" data-testid={`connection-${conn.id}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: conn.color }} />
                    <span className="text-sm font-ui">{conn.label || "Google Calendar"}</span>
                    {conn.email && <span className="text-xs text-muted-foreground">({conn.email})</span>}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                    onClick={() => setDeleteConnId(conn.id)}
                    data-testid={`button-disconnect-${conn.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>

                {(conn as any).tokenValid === false && (
                  <div className="flex items-center gap-1.5 mb-3 text-[hsl(var(--brand-warning))]">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span className="text-xs font-ui">Connection expired</span>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs text-[hsl(var(--brand-warning))] hover:text-[hsl(var(--brand-warning))] underline"
                      onClick={async () => {
                        setGoogleConnecting(true);
                        try {
                          const hint = conn.email ? `?login_hint=${encodeURIComponent(conn.email)}` : "";
                          const res = await fetch(`/api/calendar/google/auth-url${hint}`, { credentials: "include" });
                          const { url } = await res.json();
                          if (url) window.location.href = url;
                        } catch {
                          toast({ title: "Failed to start reconnection", variant: "destructive" });
                          setGoogleConnecting(false);
                        }
                      }}
                      disabled={googleConnecting}
                      data-testid={`button-reconnect-${conn.id}`}
                    >
                      Reconnect
                    </Button>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={conn.isConflictCalendar}
                      onCheckedChange={(v) => updateConnectionMutation.mutate({ id: conn.id, data: { isConflictCalendar: v } })}
                      data-testid={`switch-conflict-${conn.id}`}
                    />
                    <span className="text-sm text-muted-foreground">Filter booking slots by my availability</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={conn.isBookingCalendar}
                      onCheckedChange={(v) => updateConnectionMutation.mutate({ id: conn.id, data: { isBookingCalendar: v } })}
                      data-testid={`switch-booking-${conn.id}`}
                    />
                    <span className="text-sm text-muted-foreground">Add confirmed meetings to this calendar</span>
                  </div>
                </div>
              </div>
            ))}

            <Button variant="outline" size="sm" onClick={startGoogleConnect} disabled={googleConnecting} data-testid="button-add-another-calendar">
              {googleConnecting ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
              Add Another Calendar
            </Button>
          </div>
        )}
      </Card>

      <Dialog open={!!deleteConnId} onOpenChange={(open) => { if (!open) setDeleteConnId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Calendar</DialogTitle>
            <DialogDescription>Are you sure you want to disconnect this calendar? Your booking slots will no longer be filtered by this calendar's events.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConnId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteConnId && deleteConnectionMutation.mutate(deleteConnId)} disabled={deleteConnectionMutation.isPending} data-testid="button-confirm-disconnect">
              {deleteConnectionMutation.isPending ? "Disconnecting..." : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CalendarTab() {
  return <CalendarSettingsComponent />;
}


function ParentMembersTab() {
  const { user } = useAuth();
  if (!user) return null;
  const canManage = isParentAccountAdmin((user as any).parentAccountRole);
  return <MembersTable context="parent" currentUserId={(user as any).id} canManage={canManage} />;
}

export default function AccountPage() {
  const { user, logoutMutation } = useAuth();
  const location = useLocation();

  const providerId = (user as any)?.providerId;

  const roles = (user as any)?.roles || [];
  const isProvider = hasProviderRole(roles);

  const providerQuery = useQuery<any>({
    queryKey: ["/api/providers", providerId],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!providerId && isProvider,
    staleTime: 60_000,
  });

  if (!user) return null;

  const isParentOnly = roles.includes("PARENT") && roles.length === 1;
  const isProviderOrAdmin = isProvider || roles.some((r: string) => ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"].includes(r));
  const isParent = roles.includes("PARENT");
  const isViewer = (user as any).parentAccountRole === "VIEWER";

  const isAdmin = roles.includes("GOSTORK_ADMIN");
  const providerBrandingEnabled = providerQuery.data?.brandingEnabled === true;
  const showBranding = isAdmin || (isProvider && providerBrandingEnabled);

  const approvedSvcNames = (providerQuery.data?.services || [])
    .filter((s: any) => s.status === "APPROVED")
    .map((s: any) => s.providerType?.name?.toLowerCase() || "");
  const showEggDonors = isProvider && approvedSvcNames.some((n: string) => n.includes("egg donor") || n.includes("egg bank"));
  const showSurrogates = isProvider && approvedSvcNames.some((n: string) => n.includes("surrogacy"));
  const showSpermDonors = isProvider && approvedSvcNames.some((n: string) => n.includes("sperm"));
  const showDoctors = isProvider && approvedSvcNames.some((n: string) => n.includes("ivf") || n.includes("in vitro"));

  const showCosts = isProvider && approvedSvcNames.length > 0;
  const firstApprovedSvcName = (providerQuery.data?.services || [])
    .find((s: any) => s.status === "APPROVED")?.providerType?.name || "";
  const approvedServices = (providerQuery.data?.services || [])
    .filter((s: any) => s.status === "APPROVED" && s.providerType)
    .map((s: any) => ({
      providerTypeId: s.providerType.id || s.providerTypeId,
      providerTypeName: s.providerType.name,
    }));

  const donorTabs: { to: string; label: string; icon: any; roles: 'provider'; end?: boolean }[] = [];
  if (showEggDonors) donorTabs.push({ to: '/account/egg-donors', label: 'Egg Donors', icon: Egg, roles: 'provider' });
  if (showSurrogates) donorTabs.push({ to: '/account/surrogates', label: 'Surrogates', icon: Baby, roles: 'provider' });
  if (showSpermDonors) donorTabs.push({ to: '/account/sperm-donors', label: 'Sperm Donors', icon: FlaskConical, roles: 'provider' });
  if (showDoctors) donorTabs.push({ to: '/account/doctors', label: 'Doctors', icon: Stethoscope, roles: 'provider' });
  if (showCosts) donorTabs.push({ to: '/account/costs', label: 'Costs', icon: DollarSign, roles: 'provider' });

  const providerTabOrder = [
    '/account', '/account/company', '/account/team', '/account/members',
    '/account/calendar', '/account/costs', '/account/documents',
    '/account/egg-donors', '/account/surrogates', '/account/sperm-donors', '/account/doctors',
    '/account/knowledge', '/account/concierge', '/account/legal-identity', '/account/billing', '/account/payouts', '/account/branding', '/account/scrapers',
  ];

  const tabs = [...allTabs, ...donorTabs].filter(tab => {
    if (tab.roles === null) {
      if (tab.to === '/account/calendar' && isViewer) return false;
      return true;
    }
    if (tab.roles === 'provider') return isProviderOrAdmin;
    if (tab.roles === 'parent') return isParent;
    if (tab.roles === 'billing') return (isProvider || isAdmin) && !!providerId;
    // GoStork admins manage global sponsorship programs; providers buy (needs a providerId).
    if (tab.roles === 'sponsorship') return isAdmin || (isProvider && !!providerId);
    if (tab.roles === 'branding') return showBranding;
    if (tab.roles === 'knowledge') return isProvider && !isAdmin;
    if (tab.roles === 'concierge') return isAdmin || isParent || isProvider;
    if (tab.roles === 'admin') return isAdmin;
    return true;
  }).sort((a, b) => {
    const ai = providerTabOrder.indexOf(a.to);
    const bi = providerTabOrder.indexOf(b.to);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const isTabActive = (tab: typeof tabs[0]) => {
    if (tab.end) return location.pathname === tab.to;
    return location.pathname.startsWith(tab.to);
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <User className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-display font-heading text-primary" data-testid="text-page-title">Settings</h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto md:hidden flex items-center gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => logoutMutation.mutate()}
          data-testid="button-sign-out-mobile"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </Button>
      </div>

      <div className="border-b border-border/40 mb-6">
        <nav className="flex -mb-px overflow-x-auto scrollbar-hide" data-testid="account-tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isTabActive(tab);
            return (
              <Link
                key={tab.to}
                to={tab.to}
                data-testid={`tab-${tab.label.toLowerCase().replace(/\s+/g, '-')}`}
                className="flex items-center justify-center gap-2 shrink-0 sm:shrink sm:flex-1 whitespace-nowrap py-3 px-3 text-sm font-ui border-b-2 transition-colors duration-200"
                style={active
                  ? {
                      color: 'var(--tab-active-color, hsl(var(--primary)))',
                      borderBottomColor: 'var(--tab-active-color, hsl(var(--primary)))',
                    }
                  : {
                      color: 'var(--tab-color, hsl(var(--primary)))',
                      borderBottomColor: 'transparent',
                    }
                }
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.color = 'var(--tab-hover-color, hsl(var(--primary)))';
                    e.currentTarget.style.borderBottomColor = `color-mix(in srgb, var(--tab-hover-color, hsl(var(--primary))) 30%, transparent)`;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.color = 'var(--tab-color, hsl(var(--primary)))';
                    e.currentTarget.style.borderBottomColor = 'transparent';
                  }
                }}
              >
                <Icon className="w-4 h-4 hidden sm:block" />
                <span>{tab.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <Routes>
        <Route index element={<AccountTab />} />
        <Route path="company" element={<CompanyTab />} />
        <Route path="documents" element={<DocumentsTab />} />
        <Route path="team" element={<TeamTab />} />
        <Route path="members" element={<ParentMembersTab />} />
        <Route path="calendar" element={isParentOnly ? <ParentCalendarTab /> : <CalendarTab />} />
        {(isProvider || isAdmin) && providerId && (
          <Route path="billing" element={
            <ProviderBillingTab
              providerId={providerId}
              providerTypeName={firstApprovedSvcName}
              mode={isProvider && !isAdmin ? "provider" : "admin"}
            />
          } />
        )}
        {(isProvider || isAdmin) && providerId && (
          <Route path="payouts" element={<ProviderPayoutsTab />} />
        )}
        {(isAdmin || (isProvider && providerId)) && (
          <Route path="sponsorship" element={isAdmin ? <SponsorshipPlanManager /> : <SponsorshipDashboard mode="manage" />} />
        )}
        {(isProvider || isAdmin) && (
          <Route path="legal-identity" element={<ProviderLegalIdentityTab />} />
        )}
        <Route path="branding" element={
          isAdmin ? <BrandSettingsTab /> :
          isProvider && providerId ? <BrandSettingsForm
            getEndpoint={`/api/brand/provider/${providerId}`}
            putEndpoint={`/api/brand/provider/${providerId}`}
            resetEndpoint={`/api/brand/provider/${providerId}/reset`}
            disableLivePreview
          /> : <Navigate to="/account" replace />
        } />
        {isProvider && !isAdmin && (
          <Route path="knowledge" element={<ProviderKnowledgeTab />} />
        )}
        <Route path="concierge" element={
          isAdmin ? <AdminConciergePage /> : <ConciergeSettingsTab />
        } />
        {isAdmin && (
          <Route path="scrapers/*" element={<ScrapersSummaryPage />} />
        )}
        {showEggDonors && providerId && (
          <Route path="egg-donors" element={<ProfileDatabasePanel providerId={providerId} type="egg-donor" />} />
        )}
        {showSurrogates && providerId && (
          <Route path="surrogates" element={<ProfileDatabasePanel providerId={providerId} type="surrogate" />} />
        )}
        {showSpermDonors && providerId && (
          <Route path="sperm-donors" element={<ProfileDatabasePanel providerId={providerId} type="sperm-donor" />} />
        )}
        {showDoctors && providerId && (
          <Route path="doctors" element={<DoctorsDatabasePanel providerId={providerId} />} />
        )}
        {showCosts && providerId && (
          <Route path="costs" element={
            <ProviderCostsTab
              isAdminView={false}
              canManagePrograms={true}
              providerId={providerId}
              providerType={firstApprovedSvcName}
              providerServices={approvedServices}
            />
          } />
        )}
        <Route path="*" element={<Navigate to="/account" replace />} />
      </Routes>
    </div>
  );
}
