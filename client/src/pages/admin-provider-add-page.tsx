import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, Building2, Loader2, Globe, Phone, Calendar, Sparkles, MapPin, Check, X, Upload, User, AlertCircle, Plus, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import LocationAutocomplete from "@/components/location-autocomplete";
import { IvfSuccessRatesSection } from "@/components/ivf-success-rates-section";
import { getPhotoSrc } from "@/lib/profile-utils";

type ScrapedTeamMember = {
  name: string;
  title: string | null;
  bio: string | null;
  photoUrl: string | null;
  isMedicalDirector?: boolean;
  locationHints?: string[];
  email?: string;
};

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

type AddStep = "url" | "scraping" | "preview" | "manual" | "merge";

export default function AdminProviderAddPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [addStep, setAddStep] = useState<AddStep>("url");
  const [addUrl, setAddUrl] = useState("");
  const [addManualName, setAddManualName] = useState("");
  const [scrapedData, setScrapedData] = useState<ScrapedData | null>(null);
  const [mergeSelections, setMergeSelections] = useState<Record<string, "keep" | "scraped">>({});
  const [scrapeError, setScrapeError] = useState<string | null>(null);

  const [previewName, setPreviewName] = useState("");
  const [previewAbout, setPreviewAbout] = useState("");
  const [previewLogoUrl, setPreviewLogoUrl] = useState("");
  const [previewEmail, setPreviewEmail] = useState("");
  const [previewPhone, setPreviewPhone] = useState("");
  const [previewTempPassword, setPreviewTempPassword] = useState("");
  const [previewConfirmPassword, setPreviewConfirmPassword] = useState("");
  const [previewAdminName, setPreviewAdminName] = useState("");
  const [previewAdminEmail, setPreviewAdminEmail] = useState("");
  const [previewYearFounded, setPreviewYearFounded] = useState("");
  const [previewWebsiteUrl, setPreviewWebsiteUrl] = useState("");
  const [previewLocations, setPreviewLocations] = useState<ScrapedData["locations"]>([]);
  const [previewServices, setPreviewServices] = useState<string[]>([]);
  const [previewTeamMembers, setPreviewTeamMembers] = useState<ScrapedTeamMember[]>([]);
  const [editingMemberIdx, setEditingMemberIdx] = useState<number | null>(null);
  const [uploadingPhotoIdx, setUploadingPhotoIdx] = useState<number | null>(null);

  const { data: providerTypes } = useQuery<any[]>({
    queryKey: ["/api/provider-types"],
  });

  const isIvfClinic = previewServices.some(
    (s) => s.toLowerCase().includes("ivf") || s.toLowerCase().includes("in vitro")
  );

  const firstLocation = previewLocations[0];
  const { data: ivfRatesData } = useQuery<{ found: boolean; matchedProvider?: { id: string; name: string }; rates: any[] }>({
    queryKey: ["/api/providers/lookup-success-rates", previewName, firstLocation?.city, firstLocation?.state],
    queryFn: async () => {
      const params = new URLSearchParams({ name: previewName });
      if (firstLocation?.city) params.set("city", firstLocation.city);
      if (firstLocation?.state) params.set("state", firstLocation.state);
      const res = await apiRequest("GET", `/api/providers/lookup-success-rates?${params}`);
      return res.json();
    },
    enabled: isIvfClinic && previewName.length > 3,
  });

  const scrapeMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/providers/scrape", { url });
      return res.json() as Promise<ScrapedData>;
    },
    onSuccess: (data) => {
      setScrapedData(data);
      setPreviewName(data.name || "");
      setPreviewAbout(data.about || "");
      setPreviewLogoUrl(data.logoUrl || "");
      setPreviewEmail(data.email || "");
      setPreviewPhone(data.phone || "");
      setPreviewYearFounded(data.yearFounded ? String(data.yearFounded) : "");
      setPreviewWebsiteUrl(data.websiteUrl || "");
      const locs = data.locations || [];
      setPreviewLocations(locs);
      const normalizedServices = (data.suggestedServices || []).map((svc: string) => {
        if (!providerTypes) return svc;
        const exact = providerTypes.find((t: any) => t.name.toLowerCase() === svc.toLowerCase());
        if (exact) return exact.name;
        const partial = providerTypes.find((t: any) =>
          t.name.toLowerCase().includes(svc.toLowerCase()) || svc.toLowerCase().includes(t.name.toLowerCase())
        );
        if (partial) return partial.name;
        const words = svc.toLowerCase().split(/[\s/]+/);
        const wordMatch = providerTypes.find((t: any) =>
          words.some((w: string) => w.length > 2 && t.name.toLowerCase().includes(w))
        );
        if (wordMatch) return wordMatch.name;
        return svc;
      }).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
      setPreviewServices(normalizedServices);
      const members = (data.teamMembers || []).map((m: any) => {
        if (!m.locationHints || m.locationHints.length === 0) return m;
        const mappedHints: string[] = [];
        for (const hint of m.locationHints) {
          const matched = locs.find((loc: any) =>
            hint.toLowerCase().includes((loc.city || "").toLowerCase())
          );
          if (matched) {
            mappedHints.push(`${matched.city}|${matched.state}|${matched.address || ""}`);
          }
        }
        return { ...m, locationHints: mappedHints };
      });
      setPreviewTeamMembers(members);
      setEditingMemberIdx(null);
      setAddStep("preview");
    },
    onError: (err: Error) => {
      const msg = err.message;
      if (msg.includes("403") || msg.includes("Forbidden")) {
        setScrapeError("This website blocked our request. Please check the URL or try adding this provider manually.");
      } else if (msg.includes("404") || msg.includes("Not Found")) {
        setScrapeError("Page not found. Please check the URL and try again.");
      } else if (msg.includes("timeout") || msg.includes("TIMEOUT") || msg.includes("aborted")) {
        setScrapeError("The website took too long to respond. Please try again or add the provider manually.");
      } else if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo") || msg.includes("DNS")) {
        setScrapeError("Website not found. Please check the URL is correct.");
      } else {
        setScrapeError("Could not extract information from this website. Please check the URL or try adding the provider manually.");
      }
      setAddStep("url");
    },
  });

  const manualScrapeMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/providers/scrape", { url });
      return res.json() as Promise<ScrapedData>;
    },
    onSuccess: (data) => {
      setScrapedData(data);
      const sel: Record<string, "keep" | "scraped"> = {};
      if (data.name && data.name !== previewName) sel.name = previewName ? "keep" : "scraped";
      if (data.about && data.about !== previewAbout) sel.about = previewAbout ? "keep" : "scraped";
      if (data.logoUrl && data.logoUrl !== previewLogoUrl) sel.logoUrl = previewLogoUrl ? "keep" : "scraped";
      if (data.phone && data.phone !== previewPhone) sel.phone = previewPhone ? "keep" : "scraped";
      if (data.yearFounded && String(data.yearFounded) !== previewYearFounded) sel.yearFounded = previewYearFounded ? "keep" : "scraped";
      setMergeSelections(sel);
      setAddStep("merge");
    },
    onError: (err: Error) => {
      toast({ title: "Scraping failed", description: "Could not extract information from this website. You can continue editing manually.", variant: "destructive" });
      setAddStep("manual");
    },
  });

  async function handlePhotoUpload(file: File, idx: number) {
    setUploadingPhotoIdx(idx);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message);
      }
      const { url } = await res.json();
      const updated = [...previewTeamMembers];
      updated[idx] = { ...updated[idx], photoUrl: url };
      setPreviewTeamMembers(updated);
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploadingPhotoIdx(null);
    }
  }

  const handleScrape = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addUrl) return;
    setScrapeError(null);
    setAddStep("scraping");
    scrapeMutation.mutate(addUrl);
  };

  const handleCreateManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addManualName) return;
    setPreviewName(addManualName);
    setPreviewAbout("");
    setPreviewLogoUrl("");
    setPreviewEmail("");
    setPreviewPhone("");
    setPreviewTempPassword("");
    setPreviewAdminName("");
    setPreviewAdminEmail("");
    setPreviewYearFounded("");
    setPreviewWebsiteUrl("");
    setPreviewLocations([]);
    setPreviewServices([]);
    setPreviewTeamMembers([]);
    setAddStep("manual");
  };

  const handleApproveProvider = async () => {
    const providerData: any = {
      name: previewName,
      websiteUrl: previewWebsiteUrl || null,
      about: previewAbout || null,
      logoUrl: previewLogoUrl || null,
      phone: previewPhone || null,
      yearFounded: previewYearFounded ? parseInt(previewYearFounded) : null,
    };

    try {
      const res = await apiRequest("POST", "/api/providers", providerData);
      const newProvider = await res.json();

      if (previewLocations.length > 0) {
        for (let i = 0; i < previewLocations.length; i++) {
          const loc = previewLocations[i];
          if (loc.city || loc.address || loc.state) {
            try {
              await apiRequest("POST", `/api/providers/${newProvider.id}/locations`, { ...loc, sortOrder: i });
            } catch {}
          }
        }
      }

      if (previewServices.length > 0 && providerTypes) {
        for (const serviceName of previewServices) {
          let matchedType = providerTypes.find((t: any) =>
            t.name.toLowerCase() === serviceName.toLowerCase()
          );
          if (!matchedType) {
            matchedType = providerTypes.find((t: any) =>
              t.name.toLowerCase().includes(serviceName.toLowerCase()) || serviceName.toLowerCase().includes(t.name.toLowerCase())
            );
          }
          if (!matchedType) {
            const words = serviceName.toLowerCase().split(/[\s/]+/);
            matchedType = providerTypes.find((t: any) =>
              words.some((w: string) => w.length > 2 && t.name.toLowerCase().includes(w))
            );
          }
          if (matchedType) {
            try {
              await apiRequest("POST", `/api/providers/${newProvider.id}/services`, {
                providerTypeId: matchedType.id,
                status: "NEW",
              });
            } catch {}
          }
        }
      }

      if (previewTeamMembers.length > 0) {
        let savedLocations: any[] = [];
        try {
          const locsRes = await fetch(`/api/providers/${newProvider.id}/locations`, { credentials: "include" });
          if (locsRes.ok) savedLocations = await locsRes.json();
        } catch {}

        for (let i = 0; i < previewTeamMembers.length; i++) {
          const member = previewTeamMembers[i];
          if (member.name) {
            let locationIds: string[] = [];
            if (member.locationHints && member.locationHints.length > 0 && savedLocations.length > 0) {
              for (const hint of member.locationHints) {
                if (hint.includes("|")) {
                  const [hCity, hState, hAddr] = hint.split("|");
                  const match = savedLocations.find((sl: any) =>
                    (sl.city || "").toLowerCase() === (hCity || "").toLowerCase() &&
                    (sl.state || "").toLowerCase() === (hState || "").toLowerCase() &&
                    (hAddr ? (sl.address || "").toLowerCase() === hAddr.toLowerCase() : true)
                  );
                  if (match) locationIds.push(match.id);
                } else {
                  const match = savedLocations.find((sl: any) =>
                    hint.toLowerCase().includes((sl.city || "").toLowerCase())
                  );
                  if (match) locationIds.push(match.id);
                }
              }
            }
            try {
              await apiRequest("POST", `/api/providers/${newProvider.id}/members`, {
                name: member.name,
                title: member.title || null,
                bio: member.bio || null,
                photoUrl: member.photoUrl || null,
                isMedicalDirector: member.isMedicalDirector || false,
                sortOrder: i,
                locationIds,
              });
            } catch {}
          }
        }
      }

      if (previewAdminEmail.trim() && previewTempPassword.trim()) {
        if (previewTempPassword !== previewConfirmPassword) {
          toast({ title: "Admin passwords do not match", variant: "destructive" });
          return;
        }
        try {
          await apiRequest("POST", `/api/providers/${newProvider.id}/users`, {
            email: previewAdminEmail.trim(),
            password: previewTempPassword.trim(),
            name: previewAdminName.trim() || null,
            roles: ["PROVIDER_ADMIN"],
            allLocations: true,
            mustCompleteProfile: false,
          });
          toast({ title: "Provider admin created", description: `Account created for ${previewAdminEmail.trim()}`, variant: "success" });
        } catch (userErr: any) {
          toast({ title: "Provider created, but admin account failed", description: userErr.message, variant: "destructive" });
        }
      }

      if (scrapedData) {
        try {
          await apiRequest("PUT", `/api/brand/provider/${newProvider.id}/toggle`, { enabled: true });
          const brandData: Record<string, string | null> = {};
          if (scrapedData.logoWithNameUrl) brandData.logoWithNameUrl = scrapedData.logoWithNameUrl;
          if (scrapedData.logoUrl) brandData.logoUrl = scrapedData.logoUrl;
          if (scrapedData.faviconUrl) brandData.faviconUrl = scrapedData.faviconUrl;
          if (scrapedData.name) brandData.companyName = scrapedData.name;
          if (Object.keys(brandData).length > 0) {
            await apiRequest("PUT", `/api/brand/provider/${newProvider.id}`, brandData);
          }
        } catch {}
      }

      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
      toast({ title: "Provider created", description: `${previewName} has been added successfully.`, variant: "success" });
      navigate(`/admin/providers/${newProvider.id}?tab=branding`);
    } catch (err: any) {
      toast({ title: "Error creating provider", description: err.message, variant: "destructive" });
    }
  };

  if (addStep === "url") {
    return (
      <div className="space-y-6 max-w-2xl mx-auto">
        <Button variant="ghost" onClick={() => navigate("/admin/providers")} data-testid="link-back-providers">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Providers
        </Button>

        <div>
          <h1 className="font-display text-2xl font-heading text-primary" data-testid="text-add-title">Add New Provider</h1>
          <p className="text-muted-foreground">Enter a website URL and our AI will extract the provider's profile information for you to review.</p>
        </div>

        <form onSubmit={handleScrape} className="space-y-4">
          <div className="space-y-2">
            <Label>Website URL</Label>
            <div className="relative">
              <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={addUrl}
                onChange={e => { setAddUrl(e.target.value); setScrapeError(null); }}
                placeholder="e.g. https://www.hopefertility.com"
                className={`pl-9 ${scrapeError ? "border-destructive/50 focus-visible:ring-destructive" : ""}`}
                data-testid="input-provider-website"
              />
            </div>
            {scrapeError && (
              <div className="flex items-start gap-2 text-sm text-destructive dark:text-destructive bg-destructive/10 dark:bg-destructive/10 border border-destructive/30 dark:border-destructive/30 rounded-md p-3" data-testid="text-scrape-error">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{scrapeError}</span>
              </div>
            )}
          </div>
          <Button type="submit" disabled={!addUrl.trim()} data-testid="button-scrape-website">
            <Sparkles className="w-4 h-4 mr-2" />
            Scrape &amp; Preview
          </Button>
        </form>

        <div className="relative my-2">
          <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
          <div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">or add manually</span></div>
        </div>

        <form onSubmit={handleCreateManual} className="space-y-4">
          <div className="space-y-2">
            <Label>Provider Name</Label>
            <Input
              value={addManualName}
              onChange={e => setAddManualName(e.target.value)}
              placeholder="e.g. Hope Fertility Center"
              data-testid="input-provider-name"
            />
          </div>
          <Button type="submit" variant="outline" disabled={!addManualName.trim()} data-testid="button-create-manual">
            Create Manually
          </Button>
        </form>
      </div>
    );
  }

  if (addStep === "scraping") {
    return (
      <div className="space-y-6 max-w-2xl mx-auto">
        <Button variant="ghost" onClick={() => navigate("/admin/providers")} data-testid="link-back-providers">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Providers
        </Button>
        <div className="flex flex-col items-center justify-center py-12 gap-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <div className="text-center">
            <p className="font-ui text-lg">Analyzing website...</p>
            <p className="text-sm text-muted-foreground mt-1">Our AI is extracting provider information from the website. This may take a few seconds.</p>
          </div>
        </div>
      </div>
    );
  }

  if (addStep === "merge" && scrapedData) {
    return (
      <div className="space-y-6 w-full">
        <Button variant="ghost" onClick={() => setAddStep("manual")} data-testid="link-back-manual">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Edit
        </Button>

        <div>
          <h1 className="font-display text-2xl font-heading text-primary">Review Scraped Data</h1>
          <p className="text-muted-foreground">The AI found new information. Choose which values to keep for each field.</p>
        </div>

        <div className="space-y-4">
          {Object.entries(mergeSelections).map(([field, choice]) => {
            const labels: Record<string, string> = { name: "Provider Name", about: "About", logoUrl: "Logo URL", phone: "Phone", yearFounded: "Year Founded" };
            const currentValues: Record<string, string> = { name: previewName, about: previewAbout, logoUrl: previewLogoUrl, phone: previewPhone, yearFounded: previewYearFounded };
            const scrapedValues: Record<string, string> = {
              name: scrapedData.name || "",
              about: scrapedData.about || "",
              logoUrl: scrapedData.logoUrl || "",
              email: scrapedData.email || "",
              phone: scrapedData.phone || "",
              yearFounded: scrapedData.yearFounded ? String(scrapedData.yearFounded) : "",
            };
            const current = currentValues[field] || "";
            const scraped = scrapedValues[field] || "";
            if (!current && scraped) return null;
            return (
              <div key={field} className="border rounded-lg p-3 space-y-2" data-testid={`merge-field-${field}`}>
                <Label className="font-ui text-sm">{labels[field] || field}</Label>
                <div className="space-y-1.5">
                  <label className={`flex items-start gap-2 p-2 rounded-md cursor-pointer text-sm ${choice === "keep" ? "bg-accent/10 border border-accent/30 dark:bg-accent/15 dark:border-accent/30" : "bg-secondary/30 hover:bg-secondary/50"}`}>
                    <input type="radio" name={`merge-${field}`} checked={choice === "keep"} onChange={() => setMergeSelections(prev => ({ ...prev, [field]: "keep" }))} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-ui text-muted-foreground">Keep current:</span>
                      <p className={field === "about" ? "whitespace-pre-wrap break-words" : "truncate"}>{current}</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-2 p-2 rounded-md cursor-pointer text-sm ${choice === "scraped" ? "bg-[hsl(var(--brand-success)/0.08)] border border-[hsl(var(--brand-success)/0.3)] dark:bg-[hsl(var(--brand-success)/0.15)] dark:border-[hsl(var(--brand-success)/0.3)]" : "bg-secondary/30 hover:bg-secondary/50"}`}>
                    <input type="radio" name={`merge-${field}`} checked={choice === "scraped"} onChange={() => setMergeSelections(prev => ({ ...prev, [field]: "scraped" }))} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-ui text-muted-foreground">Use scraped:</span>
                      <p className={field === "about" ? "whitespace-pre-wrap break-words" : "truncate"}>{scraped}</p>
                    </div>
                  </label>
                </div>
              </div>
            );
          })}

          {scrapedData.locations && scrapedData.locations.length > 0 && (
            <div className="border rounded-lg p-3 space-y-2" data-testid="merge-field-locations">
              <Label className="font-ui text-sm">Locations ({scrapedData.locations.length} found by scraper)</Label>
              <p className="text-xs text-muted-foreground">Scraped locations will be added to any existing locations.</p>
              <div className="space-y-1">
                {scrapedData.locations.map((loc, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm p-1.5 bg-[hsl(var(--brand-success)/0.08)] dark:bg-[hsl(var(--brand-success)/0.15)] rounded">
                    <MapPin className="w-3 h-3 text-[hsl(var(--brand-success))] shrink-0" />
                    {[loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(", ")}
                  </div>
                ))}
              </div>
            </div>
          )}

          {scrapedData.suggestedServices && scrapedData.suggestedServices.length > 0 && (
            <div className="border rounded-lg p-3 space-y-2" data-testid="merge-field-services">
              <Label className="font-ui text-sm">Suggested Services</Label>
              <div className="flex flex-wrap gap-2">
                {scrapedData.suggestedServices.map((svc, idx) => (
                  <Badge key={idx} variant="outline"><Check className="w-3 h-3 text-[hsl(var(--brand-success))] mr-1" />{svc}</Badge>
                ))}
              </div>
            </div>
          )}

          {scrapedData.teamMembers && scrapedData.teamMembers.length > 0 && (
            <div className="border rounded-lg p-3 space-y-2" data-testid="merge-field-team">
              <Label className="font-ui text-sm">Team Members ({scrapedData.teamMembers.length} found by scraper)</Label>
              <p className="text-xs text-muted-foreground">Scraped team members will be added to any existing ones.</p>
              <div className="space-y-1">
                {scrapedData.teamMembers.map((m, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm p-1.5 bg-[hsl(var(--brand-success)/0.08)] dark:bg-[hsl(var(--brand-success)/0.15)] rounded">
                    {m.photoUrl && <img src={getPhotoSrc(m.photoUrl)!} alt={m.name} className="w-6 h-6 rounded-full object-cover" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                    <span className="font-ui">{m.name}</span>
                    {m.title && <span className="text-muted-foreground">— {m.title}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end sticky bottom-0 bg-background py-4 border-t">
          <Button variant="outline" onClick={() => setAddStep("manual")} data-testid="button-merge-cancel">
            Cancel
          </Button>
          <Button onClick={() => {
            const scrapedVals: Record<string, string> = {
              name: scrapedData.name || "",
              about: scrapedData.about || "",
              logoUrl: scrapedData.logoUrl || "",
              email: scrapedData.email || "",
              phone: scrapedData.phone || "",
              yearFounded: scrapedData.yearFounded ? String(scrapedData.yearFounded) : "",
            };
            const setters: Record<string, (v: string) => void> = {
              name: setPreviewName,
              about: setPreviewAbout,
              logoUrl: setPreviewLogoUrl,
              phone: setPreviewPhone,
              yearFounded: setPreviewYearFounded,
            };
            for (const [field, choice] of Object.entries(mergeSelections)) {
              if (choice === "scraped" && setters[field]) {
                setters[field](scrapedVals[field]);
              }
            }
            for (const [field, val] of Object.entries(scrapedVals)) {
              if (!(field in mergeSelections) && val) {
                setters[field]?.(val);
              }
            }
            if (scrapedData.websiteUrl && !previewWebsiteUrl) {
              setPreviewWebsiteUrl(scrapedData.websiteUrl);
            }
            const locs = scrapedData.locations || [];
            if (locs.length > 0) {
              const existingKeys = new Set(previewLocations.map(l => `${l.address}|${l.city}|${l.state}`));
              const newLocs = locs.filter(l => !existingKeys.has(`${l.address}|${l.city}|${l.state}`));
              if (newLocs.length > 0) setPreviewLocations([...previewLocations, ...newLocs]);
            }
            if (scrapedData.suggestedServices && scrapedData.suggestedServices.length > 0) {
              const existingSvcs = new Set(previewServices);
              const newSvcs = scrapedData.suggestedServices.filter(s => !existingSvcs.has(s));
              if (newSvcs.length > 0) setPreviewServices([...previewServices, ...newSvcs]);
            }
            if (scrapedData.teamMembers && scrapedData.teamMembers.length > 0) {
              const mappedMembers = scrapedData.teamMembers.map((m: any) => {
                if (!m.locationHints || m.locationHints.length === 0) return m;
                const allLocs = [...previewLocations, ...locs];
                const mappedHints: string[] = [];
                for (const hint of m.locationHints) {
                  const matched = allLocs.find((loc: any) => hint.toLowerCase().includes((loc.city || "").toLowerCase()));
                  if (matched) mappedHints.push(`${matched.city}|${matched.state}|${matched.address || ""}`);
                }
                return { ...m, locationHints: mappedHints };
              });
              const existingNames = new Set(previewTeamMembers.map(m => m.name.toLowerCase()));
              const newMembers = mappedMembers.filter((m: any) => !existingNames.has(m.name.toLowerCase()));
              if (newMembers.length > 0) setPreviewTeamMembers([...previewTeamMembers, ...newMembers]);
            }
            setScrapedData(null);
            setAddStep("manual");
            toast({ title: "Scraped data merged", variant: "success" });
          }} data-testid="button-merge-apply">
            <Check className="w-4 h-4 mr-2" />
            Apply Selections
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 w-full">
      <Button variant="ghost" onClick={() => { setAddStep("url"); }} data-testid="link-back-url">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back
      </Button>

      <div>
        <h1 className="font-display text-2xl font-heading text-primary" data-testid="text-add-title">{addStep === "manual" ? "Add New Provider" : "Review Provider Profile"}</h1>
        <p className="text-muted-foreground">{addStep === "manual" ? "Fill in the provider's details. Add a website URL to auto-fill using AI." : "AI-extracted profile from the website. Review and edit any fields before approving."}</p>
      </div>

      <div className="space-y-6">
        <div className="bg-card rounded-xl border border-border/40 p-6 space-y-5">
          <h3 className="text-lg font-heading flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" /> Company Profile
          </h3>
          <div className="flex items-start gap-4">
            {previewLogoUrl && (
              <img
                src={getPhotoSrc(previewLogoUrl) || previewLogoUrl}
                alt="Provider logo"
                className="w-16 h-16 object-contain rounded-lg bg-secondary shrink-0"
                referrerPolicy="no-referrer"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                data-testid="img-preview-logo"
              />
            )}
            <div className="flex-1 min-w-0">
              <Label>Logo</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={previewLogoUrl}
                  onChange={e => setPreviewLogoUrl(e.target.value)}
                  className="flex-1"
                  placeholder="https://..."
                  data-testid="input-preview-logo"
                />
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => document.getElementById("preview-logo-upload")?.click()} data-testid="btn-upload-preview-logo">
                  <Upload className="w-4 h-4 mr-1" /> Upload
                </Button>
                <input id="preview-logo-upload" type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const formData = new FormData();
                  formData.append("file", file);
                  try {
                    const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
                    if (!res.ok) throw new Error("Upload failed");
                    const { url } = await res.json();
                    setPreviewLogoUrl(url);
                  } catch (err: any) {
                    toast({ title: "Upload failed", description: err.message, variant: "destructive" });
                  }
                  e.target.value = "";
                }} />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Provider Name</Label>
            <Input value={previewName} onChange={e => setPreviewName(e.target.value)} required data-testid="input-preview-name" />
          </div>

          <div className="space-y-2">
            <Label>Website URL</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input value={previewWebsiteUrl} onChange={e => setPreviewWebsiteUrl(e.target.value)} className="pl-9" placeholder="https://..." data-testid="input-preview-website" />
              </div>
              {previewWebsiteUrl.trim() && (
                <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={manualScrapeMutation.isPending} onClick={() => manualScrapeMutation.mutate(previewWebsiteUrl.trim())} data-testid="button-scrape-from-manual">
                  {manualScrapeMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                  Scrape
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>About</Label>
            <Textarea value={previewAbout} onChange={e => setPreviewAbout(e.target.value)} rows={3} data-testid="input-preview-about" />
          </div>

          <div className="space-y-2">
            <Label>Company's Phone</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={previewPhone} onChange={e => setPreviewPhone(e.target.value)} className="pl-9" data-testid="input-preview-phone" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Year Founded</Label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={previewYearFounded} onChange={e => setPreviewYearFounded(e.target.value)} type="number" min={1900} max={new Date().getFullYear()} className="pl-9" data-testid="input-preview-year" />
            </div>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border/40 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-heading flex items-center gap-2">
              <MapPin className="w-5 h-5 text-primary" /> Locations ({previewLocations.length})
            </h3>
            <Button type="button" variant="outline" size="sm" onClick={() => setPreviewLocations([...previewLocations, { address: "", city: "", state: "", zip: "" }])} data-testid="button-add-preview-location">
              <Plus className="w-3 h-3 mr-1" /> Add
            </Button>
          </div>
          {previewLocations.length > 0 && (
            <div className="space-y-2">
              {previewLocations.map((loc, idx) => (
                <div key={idx} className="flex items-center gap-2" data-testid={`preview-location-${idx}`}>
                  <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
                  <LocationAutocomplete
                    value={loc}
                    onChange={newLoc => {
                      const updated = [...previewLocations];
                      updated[idx] = newLoc;
                      setPreviewLocations(updated);
                    }}
                    className="text-sm"
                    data-testid={`input-preview-location-${idx}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setPreviewLocations(previewLocations.filter((_, i) => i !== idx))}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border/40 p-6 space-y-4">
          <Label>Services</Label>
          <div className="flex flex-wrap gap-2">
            {previewServices.map((svc, idx) => (
              <Badge key={idx} variant="outline" className="flex items-center gap-1" data-testid={`preview-service-${idx}`}>
                <Check className="w-3 h-3 text-[hsl(var(--brand-success))]" />
                {svc}
                <button
                  className="ml-1 text-muted-foreground hover:text-destructive"
                  onClick={() => setPreviewServices(previewServices.filter((_, i) => i !== idx))}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
          {providerTypes && (() => {
            const available = providerTypes.filter((t: any) => !previewServices.includes(t.name));
            if (available.length === 0) return null;
            return (
              <Select onValueChange={(val) => { if (val && !previewServices.includes(val)) setPreviewServices([...previewServices, val]); }} value="">
                <SelectTrigger className="w-full" data-testid="select-add-service">
                  <SelectValue placeholder="Add a service type..." />
                </SelectTrigger>
                <SelectContent>
                  {available.map((t: any) => (
                    <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          })()}
        </div>

        {isIvfClinic && ivfRatesData?.found && ivfRatesData.rates.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Matched CDC data from: <span className="font-ui text-foreground">{ivfRatesData.matchedProvider?.name}</span>
            </p>
            <IvfSuccessRatesSection rates={ivfRatesData.rates} />
          </div>
        )}

        <div className="bg-card rounded-xl border border-border/40 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-heading flex items-center gap-2">
              <User className="w-5 h-5 text-primary" /> Team Members ({previewTeamMembers.length})
            </h3>
            <Button type="button" variant="outline" size="sm" onClick={() => {
              setPreviewTeamMembers([...previewTeamMembers, { name: "", title: null, bio: null, photoUrl: null, isMedicalDirector: false, locationHints: [] }]);
              setEditingMemberIdx(previewTeamMembers.length);
            }} data-testid="button-add-preview-member">
              <Plus className="w-3 h-3 mr-1" /> Add Member
            </Button>
          </div>
          {previewTeamMembers.length > 0 && (
            <div className="space-y-3">
              {previewTeamMembers.map((member, idx) => (
                <div key={idx} className="border rounded-lg p-3" data-testid={`preview-team-member-${idx}`}>
                  {editingMemberIdx === idx ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Name</Label>
                          <Input
                            value={member.name}
                            onChange={e => {
                              const updated = [...previewTeamMembers];
                              updated[idx] = { ...updated[idx], name: e.target.value };
                              setPreviewTeamMembers(updated);
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
                              const updated = [...previewTeamMembers];
                              updated[idx] = { ...updated[idx], title: e.target.value || null };
                              setPreviewTeamMembers(updated);
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
                            const updated = [...previewTeamMembers];
                            updated[idx] = { ...updated[idx], bio: e.target.value || null };
                            setPreviewTeamMembers(updated);
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
                              const updated = [...previewTeamMembers];
                              updated[idx] = { ...updated[idx], photoUrl: e.target.value || null };
                              setPreviewTeamMembers(updated);
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
                            data-testid={`button-upload-photo-${idx}`}
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
                                const updated = [...previewTeamMembers];
                                updated[idx] = { ...updated[idx], photoUrl: null };
                                setPreviewTeamMembers(updated);
                              }}
                              data-testid={`button-remove-photo-${idx}`}
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </div>
                        )}
                      </div>
                      {previewLocations.length > 0 && (
                        <div className="space-y-1">
                          <Label className="text-xs">Assigned Locations</Label>
                          <div className="border rounded-lg p-2 space-y-1.5">
                            {previewLocations.map((loc, locIdx) => {
                              const locKey = `${loc.city}|${loc.state}|${loc.address || ""}`;
                              const selected = member.locationHints?.includes(locKey) || false;
                              return (
                                <label key={locIdx} className="flex items-center gap-2 cursor-pointer">
                                  <Checkbox
                                    checked={selected}
                                    onCheckedChange={(checked) => {
                                      const updated = [...previewTeamMembers];
                                      const hints = [...(updated[idx].locationHints || [])];
                                      if (checked) {
                                        hints.push(locKey);
                                      } else {
                                        const i = hints.indexOf(locKey);
                                        if (i >= 0) hints.splice(i, 1);
                                      }
                                      updated[idx] = { ...updated[idx], locationHints: hints };
                                      setPreviewTeamMembers(updated);
                                    }}
                                    data-testid={`checkbox-preview-member-loc-${idx}-${locIdx}`}
                                  />
                                  <span className="text-xs">{loc.city}, {loc.state}{loc.address ? ` — ${loc.address}` : ""}</span>
                                </label>
                              );
                            })}
                          </div>
                          <p className="text-xs text-muted-foreground">Leave all unchecked = all locations</p>
                        </div>
                      )}
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setEditingMemberIdx(null)} data-testid={`button-done-editing-${idx}`}>
                          <Check className="w-3 h-3 mr-1" /> Done
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-muted-foreground shrink-0 text-sm font-ui relative overflow-hidden">
                        {member.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
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
                        <div className="font-ui text-sm">{member.name}</div>
                        {member.title && <div className="text-xs text-muted-foreground">{member.title}</div>}
                        {member.bio && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{member.bio}</div>}
                        {member.locationHints && member.locationHints.length > 0 && (
                          <div className="text-xs text-accent-foreground mt-1 flex items-center gap-1">
                            <MapPin className="w-3 h-3" />
                            {member.locationHints.map(h => {
                              if (h.includes("|")) {
                                const [city, state] = h.split("|");
                                return `${city}, ${state}`;
                              }
                              return h;
                            }).join(", ")}
                          </div>
                        )}
                        {(!member.locationHints || member.locationHints.length === 0) && (
                          <div className="text-xs text-muted-foreground/60 mt-1 flex items-center gap-1">
                            <MapPin className="w-3 h-3" />
                            All locations
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => setEditingMemberIdx(idx)}
                          data-testid={`button-edit-member-${idx}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setPreviewTeamMembers(previewTeamMembers.filter((_, i) => i !== idx))}
                          data-testid={`button-delete-member-${idx}`}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 text-muted-foreground" />
          <Label className="text-sm font-heading">Create Provider's Admin User</Label>
        </div>
        {previewTeamMembers.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs">Select from team members</Label>
            <Select value="" onValueChange={(val) => {
              const member = previewTeamMembers[parseInt(val)];
              if (member) {
                setPreviewAdminName(member.name || "");
                if (member.email) setPreviewAdminEmail(member.email);
              }
            }}>
              <SelectTrigger data-testid="select-admin-member">
                <SelectValue placeholder="Choose a team member..." />
              </SelectTrigger>
              <SelectContent>
                {previewTeamMembers.map((m, idx) => (
                  <SelectItem key={idx} value={String(idx)}>{m.name}{m.title ? ` — ${m.title}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Full Name</Label>
            <Input value={previewAdminName} onChange={e => setPreviewAdminName(e.target.value)} placeholder="Admin name" data-testid="input-preview-admin-name" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Email</Label>
            <Input value={previewAdminEmail} onChange={e => setPreviewAdminEmail(e.target.value)} type="email" placeholder="admin@provider.com" data-testid="input-preview-admin-email" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Temp Password</Label>
            <div className="flex gap-1">
              <Input value={previewTempPassword} onChange={e => setPreviewTempPassword(e.target.value)} placeholder="Leave blank to skip" className="flex-1" data-testid="input-preview-temp-password" />
              <Button type="button" variant="outline" size="sm" className="shrink-0 px-2" onClick={() => { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%"; let pw = ""; for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)]; setPreviewTempPassword(pw); setPreviewConfirmPassword(pw); }} data-testid="button-generate-password">
                Generate
              </Button>
            </div>
          </div>
          {previewTempPassword && (
            <div className="space-y-1">
              <Label className="text-xs">Confirm Password</Label>
              <Input value={previewConfirmPassword} onChange={e => setPreviewConfirmPassword(e.target.value)} placeholder="Re-enter password" data-testid="input-preview-confirm-password" />
              {previewConfirmPassword && previewTempPassword !== previewConfirmPassword && (
                <p className="text-xs text-destructive">Passwords do not match</p>
              )}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Fill in email and password to auto-create a PROVIDER_ADMIN account. They will complete their profile on first login.</p>
      </div>

      <div className="flex gap-2 justify-end sticky bottom-0 bg-background py-4 border-t">
        <Button variant="outline" onClick={() => { setAddStep("url"); }} data-testid="button-back-to-url">
          Back
        </Button>
        {addStep === "preview" && (
          <Button variant="outline" onClick={() => scrapeMutation.mutate(previewWebsiteUrl || addUrl)} disabled={scrapeMutation.isPending} data-testid="button-rescrape">
            {scrapeMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            Re-scrape
          </Button>
        )}
        <Button onClick={handleApproveProvider} disabled={!previewName.trim()} data-testid="button-approve-provider">
          <Check className="w-4 h-4 mr-2" />
          Approve &amp; Create
        </Button>
      </div>
    </div>
  );
}
