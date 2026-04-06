import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tabs as ServiceTabs, TabsContent as ServiceTabsContent, TabsList as ServiceTabsList, TabsTrigger as ServiceTabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Upload,
  Download,
  Trash2,
  FileText,
  Plus,
  Send,
  Check,
  X,
  AlertTriangle,
  Loader2,
  DollarSign,
  Copy,
  ArrowRight,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Pencil,
  Globe,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { SingleCountryAutocompleteInput } from "@/components/ui/country-autocomplete-input";
import { getCountryFlag } from "@/lib/country-flag";

interface CostItemData {
  id?: string;
  templateFieldId?: string | null;
  category: string;
  key: string;
  minValue: number | null;
  maxValue: number | null;
  isCustom: boolean;
  comment: string | null;
  isIncluded: boolean;
  sortOrder: number;
  _isVariant?: boolean;
}

interface CostTemplate {
  id: string;
  category: string;
  fieldName: string;
  fieldDescription: string | null;
  isMandatory: boolean;
  isBaseCompensation: boolean;
  allowMultiple: boolean;
  sortOrder: number;
  subType?: string | null;
}

const NUMERIC_ONLY_FIELDS = new Set([
  "Number of Eggs in Egg Lot",
  "Number of Egg Retrievals Included",
  "Number of Sperm Collections Included",
  "Number of Transfers Included",
]);

function isNumericOnlyField(fieldName: string): boolean {
  return NUMERIC_ONLY_FIELDS.has(fieldName);
}

interface CostSheet {
  id: string;
  providerId: string;
  parentClientId: string | null;
  programId: string | null;
  fileUrl: string | null;
  filePath: string | null;
  originalFileName: string | null;
  status: string;
  adminFeedback: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: CostItemData[];
}

interface CostProgram {
  id: string;
  providerId: string;
  providerTypeId: string | null;
  subType: string | null;
  name: string;
  country: string;
  createdAt: string;
}

interface ServiceInfo {
  providerTypeId: string;
  providerTypeName: string;
}

interface SingleCostsTabProps {
  providerType: string;
  providerTypeId?: string;
  providerId: string;
  isAdminView: boolean;
  parentId?: string;
  subType?: string;
  programId?: string;
  programSubType?: string | null;
}

interface ProviderCostsTabProps {
  providerType: string;
  providerId: string;
  isAdminView: boolean;
  parentId?: string;
  providerServices?: ServiceInfo[];
}

function calculateTotalCost(
  costItems: CostItemData[],
  specificProfile?: { compensationValue?: number },
): { minTotal: number; maxTotal: number } {
  let minTotal = 0;
  let maxTotal = 0;

  for (const item of costItems) {
    if (!item.isIncluded) continue;

    const baseKey = item.key.replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
    if (isNumericOnlyField(baseKey)) continue;

    const min = item.minValue ?? 0;
    const max = item.maxValue ?? min;
    const effectiveMin = min;
    const effectiveMax = max === 0 && min > 0 ? min : max;

    if (
      specificProfile?.compensationValue !== undefined &&
      item.key &&
      (item.key.toLowerCase().includes("compensation") ||
        item.category.toLowerCase() === "compensation")
    ) {
      minTotal += specificProfile.compensationValue;
      maxTotal += specificProfile.compensationValue;
    } else {
      minTotal += effectiveMin;
      maxTotal += effectiveMax;
    }
  }

  return { minTotal, maxTotal };
}

function mergeSheetWithTemplate(
  sheetItems: CostItemData[],
  templateItems: CostItemData[],
): CostItemData[] {
  const usedTemplateIds = new Set<string>();
  const usedCatKeys = new Set<string>();
  const result: CostItemData[] = [];

  for (const si of sheetItems) {
    if (si.templateFieldId) {
      const tpl = templateItems.find((t) => t.templateFieldId === si.templateFieldId);
      if (tpl) {
        result.push({
          ...si,
          category: tpl.category,
          key: tpl.key,
          sortOrder: tpl.sortOrder,
        });
        usedTemplateIds.add(tpl.templateFieldId!);
        continue;
      }
    }
    const catKeyMatch = templateItems.find(
      (t) => t.category === si.category && t.key === si.key && !usedTemplateIds.has(t.templateFieldId!),
    );
    if (catKeyMatch) {
      result.push({ ...si, templateFieldId: catKeyMatch.templateFieldId, sortOrder: catKeyMatch.sortOrder });
      usedTemplateIds.add(catKeyMatch.templateFieldId!);
      usedCatKeys.add(`${si.category}::${si.key}`);
    } else if (si.isCustom || si._isVariant) {
      result.push(si);
    } else {
      result.push({ ...si, isCustom: true });
    }
  }

  for (const tpl of templateItems) {
    if (tpl.templateFieldId && !usedTemplateIds.has(tpl.templateFieldId)) {
      result.push({ ...tpl });
    }
  }

  result.sort((a, b) => {
    const aIdx = templateItems.findIndex((t) => t.templateFieldId && t.templateFieldId === a.templateFieldId);
    const bIdx = templateItems.findIndex((t) => t.templateFieldId && t.templateFieldId === b.templateFieldId);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.sortOrder - b.sortOrder;
  });

  return result.map((item, idx) => ({ ...item, sortOrder: idx }));
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function getStatusBadge(status: string) {
  switch (status) {
    case "APPROVED":
      return <Badge data-testid="badge-status-approved" className="bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success))]/30">Approved</Badge>;
    case "DRAFT":
      return <Badge data-testid="badge-status-draft" className="bg-muted text-muted-foreground border-border">Draft</Badge>;
    case "PENDING":
      return <Badge data-testid="badge-status-pending" className="bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">Pending Review</Badge>;
    case "REJECTED":
      return <Badge data-testid="badge-status-rejected" className="bg-destructive/10 text-destructive border-destructive/30">Rejected</Badge>;
    case "SENT_TO_PARENT":
      return <Badge data-testid="badge-status-sent" className="bg-[hsl(var(--accent))]/15 text-[hsl(var(--accent))] border-[hsl(var(--accent))]/30">Sent to Parent</Badge>;
    case "ARCHIVED":
      return <Badge data-testid="badge-status-archived" className="bg-muted text-muted-foreground border-border">Archived</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function DiffValueCell({ label, pendingVal, approvedVal, isCurrency = true }: { label: string; pendingVal: number | null; approvedVal: number | null; isCurrency?: boolean }) {
  const pv = pendingVal ?? 0;
  const av = approvedVal ?? 0;
  const changed = pv !== av;
  const fmt = (v: number) => isCurrency ? formatCurrency(v) : String(v);

  return (
    <div className="text-right">
      <span className={`text-sm font-medium tabular-nums ${changed ? "text-[hsl(var(--brand-warning))] font-bold" : ""}`}>
        {pendingVal != null ? fmt(pendingVal) : "-"}
      </span>
      {changed && approvedVal != null && (
        <div className="text-xs text-muted-foreground line-through">
          {fmt(approvedVal)}
        </div>
      )}
    </div>
  );
}

function SingleCostsTab({
  providerType,
  providerTypeId,
  providerId,
  isAdminView,
  parentId,
  subType,
  programId,
  programSubType,
}: SingleCostsTabProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFileRef = useRef<File | null>(null);
  const [editItems, setEditItems] = useState<CostItemData[]>([]);
  const [isEditing, setIsEditing] = useState(!isAdminView || !!programId);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState("");
  const [rejectSheetId, setRejectSheetId] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [parseStage, setParseStage] = useState("");
  const parseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [accordionValue, setAccordionValue] = useState<string[]>([]);

  // When inside an IVF program, use programSubType (ivf_cycle / shipping_embryos) for the template query.
  // For egg donation programs the existing subType prop (fresh/frozen) is used as-is.
  const effectiveSubType = programSubType !== undefined ? (programSubType ?? undefined) : subType;
  const subTypeParam = effectiveSubType ? `?subType=${encodeURIComponent(effectiveSubType)}` : "";
  const templatesQuery = useQuery<{ providerTypeId: string; templates: Record<string, CostTemplate[]> }>({
    queryKey: ["/api/costs/templates", providerType, effectiveSubType || "default"],
    queryFn: () => fetch(`/api/costs/templates/${encodeURIComponent(providerType)}${subTypeParam}`).then((r) => r.json()),
    enabled: !!providerType,
  });

  const sheetsParams = new URLSearchParams();
  if (programId) {
    sheetsParams.set("programId", programId);
  } else {
    if (providerTypeId) sheetsParams.set("providerTypeId", providerTypeId);
    if (subType) sheetsParams.set("subType", subType);
  }
  const sheetsQueryString = sheetsParams.toString() ? `?${sheetsParams.toString()}` : "";
  const sheetsQuery = useQuery<CostSheet[]>({
    queryKey: ["/api/costs/provider", providerId, "sheets", providerTypeId || "all", subType || "default", programId || "none"],
    queryFn: () => fetch(`/api/costs/provider/${providerId}${sheetsQueryString}`).then((r) => r.json()),
    enabled: !!providerId,
  });

  const approvedQuery = useQuery<CostSheet | null>({
    queryKey: ["/api/costs/provider", providerId, "approved", providerTypeId || "all", subType || "default", programId || "none"],
    queryFn: () => fetch(`/api/costs/provider/${providerId}/approved${sheetsQueryString}`).then((r) => r.json()),
    enabled: !!providerId,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId, "sheets", providerTypeId || "all", subType || "default", programId || "none"] });
    queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId, "approved", providerTypeId || "all", subType || "default", programId || "none"] });
  };

  const startParseProgress = useCallback(() => {
    setParseProgress(0);
    setParseStage("Reading document...");
    const stages = [
      { at: 10, label: "Analyzing document structure..." },
      { at: 25, label: "Extracting cost items..." },
      { at: 45, label: "Mapping to GoStork template..." },
      { at: 65, label: "Categorizing line items..." },
      { at: 80, label: "Validating amounts..." },
      { at: 90, label: "Finalizing..." },
    ];
    let current = 0;
    const timer = setInterval(() => {
      current += Math.random() * 3 + 0.5;
      if (current > 95) current = 95;
      const stage = [...stages].reverse().find((s) => current >= s.at);
      if (stage) setParseStage(stage.label);
      setParseProgress(Math.round(current));
    }, 400);
    parseTimerRef.current = timer;
  }, []);

  const stopParseProgress = useCallback((success: boolean) => {
    if (parseTimerRef.current) {
      clearInterval(parseTimerRef.current);
      parseTimerRef.current = null;
    }
    if (success) {
      setParseProgress(100);
      setParseStage("Complete!");
      setTimeout(() => {
        setParseProgress(0);
        setParseStage("");
      }, 600);
    } else {
      setParseProgress(0);
      setParseStage("");
    }
  }, []);

  const templateItems = useMemo((): CostItemData[] => {
    const templates = templatesQuery.data?.templates;
    if (!templates || typeof templates !== "object") return [];
    const items: CostItemData[] = [];
    let sortIdx = 0;
    for (const [category, fields] of Object.entries(templates)) {
      for (const field of fields) {
        items.push({
          templateFieldId: field.id,
          category,
          key: field.fieldName,
          minValue: null,
          maxValue: null,
          isCustom: false,
          comment: null,
          isIncluded: true,
          sortOrder: sortIdx++,
        });
      }
    }
    return items;
  }, [templatesQuery.data]);

  const handleAiParse = useCallback(
    async (file: File) => {
      setIsParsing(true);
      startParseProgress();
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("providerType", providerType);
        const res = await fetch("/api/costs/parse", { method: "POST", body: formData, credentials: "include" });
        if (!res.ok) throw new Error((await res.json()).message);
        const data = await res.json();

        const parsedItems: CostItemData[] = (data.items || []).map(
          (item: any, idx: number) => ({
            category: item.category,
            key: item.key,
            minValue: item.minValue,
            maxValue: item.maxValue,
            isCustom: item.isCustom || false,
            comment: item.comment || null,
            isIncluded: item.isIncluded !== false,
            sortOrder: idx,
          }),
        );

        const merged = templateItems.map((tpl) => {
          const match = parsedItems.find(
            (p) => p.category === tpl.category && p.key === tpl.key,
          );
          return match ? { ...tpl, minValue: match.minValue, maxValue: match.maxValue, comment: match.comment, isIncluded: match.isIncluded } : { ...tpl };
        });
        const customItems = parsedItems.filter(
          (p) => p.isCustom || !templateItems.some((t) => t.category === p.category && t.key === p.key),
        );
        const finalItems = [...merged, ...customItems].map((item, i) => ({ ...item, sortOrder: i }));

        stopParseProgress(true);
        setEditItems(finalItems);
        setIsEditing(true);
        setTimeout(() => {
          saveDraftMutationRef.current.mutate(finalItems);
        }, 100);
        const filledCount = parsedItems.length;
        toast({ title: "AI parsing complete", description: `${filledCount} items extracted and merged into template`, variant: "success" });
      } catch (err: any) {
        stopParseProgress(false);
        toast({ title: "AI parsing failed", description: err.message, variant: "destructive" });
      } finally {
        setIsParsing(false);
      }
    },
    [providerType, toast, startParseProgress, stopParseProgress, templateItems],
  );

  const startPollingForParse = useCallback((sheetId: string, resuming: boolean) => {
    setIsParsing(true);
    if (resuming) {
      setParseProgress(50);
      setParseStage("Analyzing document structure...");
      if (parseTimerRef.current) clearInterval(parseTimerRef.current);
      let current = 50;
      parseTimerRef.current = setInterval(() => {
        current += Math.random() * 2 + 0.3;
        if (current > 95) current = 95;
        const stages = [
          { at: 50, label: "Mapping to GoStork template..." },
          { at: 65, label: "Categorizing line items..." },
          { at: 80, label: "Validating amounts..." },
          { at: 90, label: "Finalizing..." },
        ];
        const stage = [...stages].reverse().find((s) => current >= s.at);
        if (stage) setParseStage(stage.label);
        setParseProgress(Math.round(current));
      }, 400);
    } else {
      startParseProgress();
    }
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/costs/sheet/${sheetId}`, { credentials: "include" });
        if (res.status === 404) { clearInterval(poll); stopParseProgress(false); setIsParsing(false); invalidateAll(); return; }
        if (!res.ok) return;
        const sheet = await res.json();
        if (sheet.status !== "PARSING") {
          clearInterval(poll);
          stopParseProgress(true);
          setIsParsing(false);
          invalidateAll();
          if (sheet.items && sheet.items.length > 0) {
            const items = sheet.items.map((item: any, idx: number) => ({
              id: item.id,
              templateFieldId: item.templateFieldId,
              category: item.category,
              key: item.key,
              minValue: item.minValue,
              maxValue: item.maxValue,
              isCustom: item.isCustom || false,
              comment: item.comment || null,
              isIncluded: item.isIncluded !== false,
              sortOrder: item.sortOrder ?? idx,
            }));
            setEditItems(items);
            setIsEditing(true);
            const filledCount = items.filter((i: CostItemData) => i.minValue !== null || i.maxValue !== null).length;
            toast({ title: "AI parsing complete", description: `${filledCount} cost items extracted`, variant: "success" });
          }
        }
      } catch {}
    }, 2000);
    return poll;
  }, [startParseProgress, stopParseProgress, invalidateAll, toast]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("providerId", providerId);
      formData.append("providerType", providerType);
      if (providerTypeId) formData.append("providerTypeId", providerTypeId);
      if (subType) formData.append("subType", subType);
      if (programId) formData.append("programId", programId);
      const res = await fetch("/api/costs/upload", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (sheet: any) => {
      invalidateAll();
      toast({ title: "File uploaded - parsing with AI..." });
      if (sheet.status === "PARSING") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = startPollingForParse(sheet.id, false);
      }
    },
    onError: (err: any) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (_sheetId: string) => {
      const resetParams = new URLSearchParams();
      if (providerTypeId) resetParams.set("providerTypeId", providerTypeId);
      if (subType) resetParams.set("subType", subType);
      const resetQs = resetParams.toString() ? `?${resetParams.toString()}` : "";
      await apiRequest("DELETE", `/api/costs/reset/${providerId}${resetQs}`);
    },
    onSuccess: () => {
      invalidateAll();
      setEditItems([...templateItems]);
      setIsEditing(true);
      toast({ title: "Cost sheet reset to default template", variant: "success" });
    },
  });

  const cancelUploadMutation = useMutation({
    mutationFn: async (sheetId: string) => {
      await apiRequest("DELETE", `/api/costs/${sheetId}/cancel`);
    },
    onSuccess: () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      stopParseProgress(false);
      setIsParsing(false);
      invalidateAll();
      toast({ title: "Upload cancelled", variant: "success" });
    },
  });

  const submitMutation = useMutation({
    mutationFn: async (data: { items: CostItemData[]; sheetId?: string }) => {
      return apiRequest("POST", "/api/costs/submit", {
        providerId,
        items: data.items,
        sheetId: data.sheetId,
        providerTypeId,
        subType,
        programId,
      });
    },
    onSuccess: () => {
      invalidateAll();
      if (isAdminView) setIsEditing(false);
      toast({ title: "Cost sheet submitted for review", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Submit failed", description: err.message, variant: "destructive" });
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (sheetId: string) => {
      return apiRequest("POST", `/api/costs/approve/${sheetId}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Cost sheet approved", variant: "success" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ sheetId, feedback }: { sheetId: string; feedback: string }) => {
      return apiRequest("POST", `/api/costs/reject/${sheetId}`, { feedback });
    },
    onSuccess: () => {
      invalidateAll();
      setRejectDialogOpen(false);
      setRejectFeedback("");
      toast({ title: "Cost sheet rejected", variant: "success" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ sheetId, items }: { sheetId: string; items: CostItemData[] }) => {
      return apiRequest("PATCH", `/api/costs/sheet/${sheetId}`, { items });
    },
    onSuccess: () => {
      invalidateAll();
      if (isAdminView) setIsEditing(false);
      toast({ title: "Cost items saved", variant: "success" });
    },
  });

  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSavePendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveDraftMutation = useMutation({
    mutationFn: async (items: CostItemData[]) => {
      return apiRequest("POST", "/api/costs/save-draft", {
        providerId,
        items,
        sheetId: latestMaster?.status === "APPROVED" ? undefined : latestMaster?.id,
        providerTypeId,
        subType,
        programId,
      });
    },
    onSuccess: () => {
      setAutoSaveStatus("saved");
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = setTimeout(() => setAutoSaveStatus("idle"), 2000);
      queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId, "sheets", providerTypeId || "all", subType || "default"] });
    },
    onError: () => {
      setAutoSaveStatus("idle");
    },
  });

  const saveDraftMutationRef = useRef(saveDraftMutation);
  saveDraftMutationRef.current = saveDraftMutation;

  const editItemsRef = useRef<CostItemData[]>(editItems);
  editItemsRef.current = editItems;

  const triggerAutoSave = useCallback(() => {
    if (!isEditing) return;
    const items = editItemsRef.current;
    if (!items || items.length === 0) return;
    if (autoSavePendingTimerRef.current) clearTimeout(autoSavePendingTimerRef.current);
    autoSavePendingTimerRef.current = setTimeout(() => {
      autoSavePendingTimerRef.current = null;
      setAutoSaveStatus("saving");
      saveDraftMutationRef.current.mutate(editItemsRef.current);
    }, 500);
  }, [isEditing]);

  const createQuoteMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/costs/custom-quote/${providerId}/${parentId}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Custom quote created", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const sendQuoteMutation = useMutation({
    mutationFn: async (sheetId: string) => {
      return apiRequest("POST", `/api/costs/send-quote/${sheetId}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Quote sent to parent", variant: "success" });
    },
  });

  const handleFileDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadMutation.mutate(file);
    },
    [uploadMutation],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadMutation.mutate(file);
    },
    [uploadMutation],
  );


  const allTemplatesFlat = useMemo(() => {
    if (!templatesQuery.data?.templates) return [];
    return Object.values(templatesQuery.data.templates).flat();
  }, [templatesQuery.data]);

  const isVariant = useCallback((key: string): boolean => {
    return /\s*\((?:Standard|Variant \d+)\)$/.test(key);
  }, []);

  const getBaseKey = useCallback((key: string): string => {
    return key.replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
  }, []);

  const getTemplateForItem = useCallback(
    (item: CostItemData): CostTemplate | undefined => {
      const baseKey = getBaseKey(item.key);
      return allTemplatesFlat.find(
        (t) => t.fieldName === baseKey && t.category === item.category,
      ) || allTemplatesFlat.find((t) => t.fieldName === baseKey);
    },
    [allTemplatesFlat, getBaseKey],
  );

  const startEditingFromTemplate = useCallback(() => {
    if (templateItems.length > 0) {
      setEditItems([...templateItems]);
    } else {
      setEditItems([{
        category: "General",
        key: "",
        minValue: null,
        maxValue: null,
        isCustom: true,
        comment: null,
        isIncluded: true,
        sortOrder: 0,
      }]);
    }
    setIsEditing(true);
  }, [templateItems]);

  const startEditingFromSheet = useCallback((sheet: CostSheet) => {
    setEditItems(
      sheet.items.map((item) => ({
        category: item.category,
        key: item.key,
        minValue: item.minValue,
        maxValue: item.maxValue,
        isCustom: item.isCustom,
        comment: item.comment,
        isIncluded: item.isIncluded,
        sortOrder: item.sortOrder,
      })),
    );
    setIsEditing(true);
  }, []);

  const updateEditItem = useCallback(
    (idx: number, field: keyof CostItemData, value: any) => {
      setEditItems((prev) => {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], [field]: value };
        return updated;
      });
    },
    [],
  );

  const addCustomItem = useCallback(() => {
    setEditItems((prev) => [
      ...prev,
      {
        category: "Other",
        key: "",
        minValue: null,
        maxValue: null,
        isCustom: true,
        comment: null,
        isIncluded: true,
        sortOrder: prev.length,
      },
    ]);
  }, []);

  const addVariant = useCallback(
    (sourceItem: CostItemData, insertAfterIdx: number) => {
      setEditItems((prev) => {
        const baseKey = sourceItem.key.replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
        const existingVariants = prev.filter(
          (it) => it.category === sourceItem.category &&
            (it.key === baseKey || it.key.startsWith(baseKey + " (")) &&
            !it.isCustom,
        );

        const updated = [...prev];

        const hasAnyRenamed = existingVariants.some((it) => it.key.includes("("));
        if (!hasAnyRenamed) {
          const originalIdx = updated.findIndex(
            (it) => it.key === baseKey && it.category === sourceItem.category,
          );
          if (originalIdx >= 0) {
            updated[originalIdx] = {
              ...updated[originalIdx],
              key: `${baseKey} (Standard)`,
              _isVariant: true,
            };
          }
        }

        const variantNum = existingVariants.length + 1;
        const newItem: CostItemData = {
          category: sourceItem.category,
          key: `${baseKey} (Variant ${variantNum})`,
          minValue: null,
          maxValue: null,
          isCustom: false,
          comment: null,
          isIncluded: true,
          sortOrder: insertAfterIdx + 1,
          _isVariant: true,
        };

        const lastSiblingIdx = updated.reduce((last, it, i) =>
          it.category === sourceItem.category &&
          (it.key === baseKey || it.key.startsWith(baseKey + " ("))
            ? i : last, insertAfterIdx);

        updated.splice(lastSiblingIdx + 1, 0, newItem);
        return updated.map((it, i) => ({ ...it, sortOrder: i }));
      });
    },
    [],
  );

  const removeVariant = useCallback(
    (idx: number) => {
      setEditItems((prev) => {
        const item = prev[idx];
        if (!item) return prev;
        const baseKey = getBaseKey(item.key);
        const updated = prev.filter((_, i) => i !== idx);
        const remainingSiblings = updated.filter(
          (it) => it.category === item.category && it._isVariant &&
            (it.key === baseKey || it.key.startsWith(baseKey + " (")),
        );
        if (remainingSiblings.length === 1) {
          const soloIdx = updated.findIndex(
            (it) => it.category === item.category && it._isVariant &&
              (it.key === baseKey || it.key.startsWith(baseKey + " (")),
          );
          if (soloIdx >= 0) {
            updated[soloIdx] = { ...updated[soloIdx], key: baseKey, _isVariant: false };
          }
        }
        return updated.map((it, i) => ({ ...it, sortOrder: i }));
      });
      setTimeout(triggerAutoSave, 50);
    },
    [getBaseKey, triggerAutoSave],
  );

  const removeItem = useCallback((idx: number) => {
    setEditItems((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const allSheets = Array.isArray(sheetsQuery.data) ? sheetsQuery.data : [];
  const masterSheets = allSheets.filter((s) => !s.parentClientId);
  const latestMaster = masterSheets[0];
  const approvedSheet = approvedQuery.data;
  const parsingSheet = masterSheets.find((s) => s.status === "PARSING");
  const draftSheet = masterSheets.find((s) => s.status === "DRAFT");
  const pendingSheet = masterSheets.find((s) => s.status === "PENDING");
  const customSheets = parentId ? allSheets.filter((s) => s.parentClientId === parentId) : [];
  const activeCustomSheet = customSheets[0];

  const displaySheet = parentId ? activeCustomSheet : latestMaster;

  useEffect(() => {
    if (parsingSheet && !isParsing) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = startPollingForParse(parsingSheet.id, true);
    }
  }, [parsingSheet?.id]);

  useEffect(() => {
    if ((isAdminView && !programId) || parentId) return;
    if (sheetsQuery.isLoading || templatesQuery.isLoading) return;
    if (isEditing && editItems.length > 0) return;

    const mapSheetItem = (item: any): CostItemData => ({
      templateFieldId: item.templateFieldId ?? null,
      category: item.category,
      key: item.key,
      minValue: item.minValue,
      maxValue: item.maxValue,
      isCustom: item.isCustom,
      comment: item.comment,
      isIncluded: item.isIncluded,
      sortOrder: item.sortOrder,
      _isVariant: isVariant(item.key),
    });

    const filterBySubType = (items: CostItemData[]): CostItemData[] => {
      if (!effectiveSubType) return items;
      const templateCategories = new Set(templateItems.map((t) => t.category));
      return items.filter((item) => templateCategories.has(item.category) || item.isCustom || item._isVariant);
    };

    const mergeWithTpl = (items: CostItemData[]) =>
      templateItems.length > 0 ? mergeSheetWithTemplate(items, templateItems) : items;

    if (draftSheet && draftSheet.items && draftSheet.items.length > 0) {
      setEditItems(mergeWithTpl(filterBySubType(draftSheet.items.map(mapSheetItem))));
      setIsEditing(true);
    } else if (pendingSheet && pendingSheet.items && pendingSheet.items.length > 0) {
      setEditItems(mergeWithTpl(filterBySubType(pendingSheet.items.map(mapSheetItem))));
      setIsEditing(true);
    } else if (latestMaster && latestMaster.items && latestMaster.items.length > 0) {
      setEditItems(mergeWithTpl(filterBySubType(latestMaster.items.map(mapSheetItem))));
      setIsEditing(true);
    } else if (templateItems.length > 0) {
      setEditItems([...templateItems]);
      setIsEditing(true);
    }
  }, [sheetsQuery.isLoading, templatesQuery.isLoading, draftSheet?.id, pendingSheet?.id, latestMaster?.id, latestMaster?.status, templateItems.length, isAdminView, parentId, programId]);

  const mergedDisplayItems = useMemo((): CostItemData[] => {
    const sheetItems = displaySheet?.items || [];
    if (sheetItems.length > 0) {
      const mapped = sheetItems.map((item: any): CostItemData => ({
        templateFieldId: item.templateFieldId ?? null,
        category: item.category,
        key: item.key,
        minValue: item.minValue,
        maxValue: item.maxValue,
        isCustom: item.isCustom,
        comment: item.comment,
        isIncluded: item.isIncluded,
        sortOrder: item.sortOrder,
        _isVariant: isVariant(item.key),
      }));
      if (templateItems.length > 0) {
        const merged = mergeSheetWithTemplate(mapped, templateItems);
        if (effectiveSubType) {
          const templateCategories = new Set(templateItems.map((t) => t.category));
          return merged.filter((item) => templateCategories.has(item.category) || item.isCustom || item._isVariant);
        }
        return merged;
      }
      if (effectiveSubType) {
        const templateCategories = new Set(templateItems.map((t) => t.category));
        return mapped.filter((item: CostItemData) => templateCategories.has(item.category) || item.isCustom || item._isVariant);
      }
      return mapped;
    }
    return templateItems;
  }, [displaySheet, templateItems, effectiveSubType]);

  const effectiveEditing = isAdminView ? isEditing : (isEditing || editItems.length > 0);
  const displayItems = effectiveEditing && editItems.length > 0 ? editItems : mergedDisplayItems;

  const showDiffView = isAdminView && !isEditing && pendingSheet?.status === "PENDING" && approvedSheet && pendingSheet.id !== approvedSheet.id;

  const approvedItemMap = useMemo(() => {
    if (!approvedSheet?.items) return new Map<string, CostItemData>();
    const map = new Map<string, CostItemData>();
    for (const item of approvedSheet.items) {
      map.set(`${item.category}::${item.key}`, item);
    }
    return map;
  }, [approvedSheet]);

  const templateCategoryOrder = useMemo(() => {
    const order: string[] = [];
    for (const item of templateItems) {
      if (!order.includes(item.category)) order.push(item.category);
    }
    return order;
  }, [templateItems]);

  const groupedItems: Record<string, (CostItemData & { _editIdx: number })[]> = {};
  displayItems.forEach((item, idx) => {
    const cat = item.category || "Other";
    if (!groupedItems[cat]) groupedItems[cat] = [];
    groupedItems[cat].push({ ...item, _editIdx: idx });
  });

  const sortedGroupedEntries = useMemo(() => {
    const entries = Object.entries(groupedItems);
    return entries.sort(([a], [b]) => {
      const ai = templateCategoryOrder.indexOf(a);
      const bi = templateCategoryOrder.indexOf(b);
      const aIdx = ai === -1 ? 999 : ai;
      const bIdx = bi === -1 ? 999 : bi;
      return aIdx - bIdx;
    });
  }, [displayItems, templateCategoryOrder]);

  useEffect(() => {
    const allCategories = Object.keys(groupedItems);
    if (allCategories.length > 0) {
      setAccordionValue(allCategories);
    }
  }, [displayItems]);

  const totals = calculateTotalCost(displayItems);

  const isLoading = templatesQuery.isLoading || sheetsQuery.isLoading;

  const mandatoryFields = templatesQuery.data?.templates
    ? Object.values(templatesQuery.data.templates)
        .flat()
        .filter((t) => t.isMandatory)
        .map((t) => t.fieldName)
    : [];

  const missingMandatory = effectiveEditing
    ? mandatoryFields.filter(
        (field) =>
          !editItems.some(
            (item) =>
              (item.key === field || item.key.startsWith(field + " (")) &&
              item.isIncluded &&
              (item.minValue !== null || item.maxValue !== null),
          ),
      )
    : [];

  const diffStats = useMemo(() => {
    if (!showDiffView || !pendingSheet) return null;
    let changed = 0;
    let added = 0;
    let removed = 0;
    for (const item of pendingSheet.items) {
      const key = `${item.category}::${item.key}`;
      const approved = approvedItemMap.get(key);
      if (!approved) {
        added++;
      } else if (approved.minValue !== item.minValue || approved.maxValue !== item.maxValue || approved.isIncluded !== item.isIncluded) {
        changed++;
      }
    }
    for (const item of approvedSheet!.items) {
      const key = `${item.category}::${item.key}`;
      if (!pendingSheet.items.some((p) => `${p.category}::${p.key}` === key)) {
        removed++;
      }
    }
    return { changed, added, removed };
  }, [showDiffView, pendingSheet, approvedSheet, approvedItemMap]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4" data-testid="costs-loading">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="provider-costs-tab">
      {displaySheet?.status === "REJECTED" && displaySheet.adminFeedback && (
        <Alert variant="destructive" data-testid="alert-rejection-feedback">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Rejection feedback:</strong> {displaySheet.adminFeedback}
          </AlertDescription>
        </Alert>
      )}

      {!parentId && (
        <Card data-testid="card-file-management">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Cost Sheet Document
            </CardTitle>
          </CardHeader>
          <CardContent>
            {displaySheet?.filePath ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 bg-muted rounded-[var(--radius)]" data-testid="file-info">
                  <FileText className="w-8 h-8 text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" data-testid="text-filename">
                      {displaySheet.originalFileName || "Cost Sheet"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Version {displaySheet.version}
                    </p>
                  </div>
                  {!isParsing && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                        data-testid="btn-download-file"
                      >
                        <a href={`/api/costs/${displaySheet.id}/download`} target="_blank" rel="noopener noreferrer">
                          <Download className="w-4 h-4 mr-1" />
                          Download
                        </a>
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="text-destructive" data-testid="btn-delete-file">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Reset cost sheet?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will remove all saved cost data and reset to the default template.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteMutation.mutate(displaySheet.id)}
                              data-testid="btn-confirm-delete-file"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  )}
                </div>
                {isParsing && (
                  <div className="px-1" data-testid="parse-progress-container">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                        <span className="text-xs font-medium text-primary" data-testid="text-parse-stage">
                          {parseStage || "AI is analyzing your document..."} {parseProgress > 0 ? `${parseProgress}%` : ""}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={cancelUploadMutation.isPending}
                        onClick={() => { const s = parsingSheet; if (s) cancelUploadMutation.mutate(s.id); }}
                      >
                        <X className="w-3 h-3 mr-1" /> Cancel
                      </Button>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 overflow-hidden" data-testid="parse-progress-bar">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${Math.max(parseProgress, 3)}%` }}
                        data-testid="parse-progress-fill"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1.5">
                      AI is reading your document and mapping costs to the GoStork template
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div
                className={`border-2 border-dashed rounded-[var(--radius)] p-8 text-center transition-colors ${
                  uploadMutation.isPending || isParsing
                    ? "border-primary/30 bg-primary/5 cursor-wait"
                    : isDragging
                      ? "border-primary bg-primary/5 cursor-pointer"
                      : "border-border hover:border-primary/50 cursor-pointer"
                }`}
                onDragOver={(e) => { e.preventDefault(); if (!uploadMutation.isPending && !isParsing) setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => { if (!uploadMutation.isPending && !isParsing) handleFileDrop(e); else e.preventDefault(); }}
                onClick={() => { if (!uploadMutation.isPending && !isParsing) fileInputRef.current?.click(); }}
                data-testid="dropzone-cost-sheet"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.xlsx,.xls"
                  onChange={handleFileSelect}
                />
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="w-8 h-8 mx-auto mb-2 text-primary animate-spin" />
                    <p className="text-sm font-medium">Uploading file...</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      This may take a moment
                    </p>
                  </>
                ) : isParsing ? (
                  <div className="w-full max-w-sm mx-auto" data-testid="parse-progress-container">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                        <span className="text-xs font-medium text-primary" data-testid="text-parse-stage">
                          {parseStage || "Starting..."} {parseProgress > 0 ? `${parseProgress}%` : ""}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={cancelUploadMutation.isPending}
                        onClick={(e) => { e.stopPropagation(); const s = parsingSheet; if (s) cancelUploadMutation.mutate(s.id); }}
                      >
                        <X className="w-3 h-3 mr-1" /> Cancel
                      </Button>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 overflow-hidden" data-testid="parse-progress-bar">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${Math.max(parseProgress, 3)}%` }}
                        data-testid="parse-progress-fill"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
                      AI is reading your document and mapping costs to the GoStork template
                    </p>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      Drop a PDF or Excel file here, or click to browse
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Supports PDF, XLS, XLSX (max 20MB) · AI will auto-parse your costs
                    </p>
                  </>
                )}
              </div>
            )}

          </CardContent>
        </Card>
      )}

      {displaySheet && (!effectiveEditing || !isAdminView) && (
        <div className="flex items-center gap-3 flex-wrap" data-testid="sheet-status-bar">
          {getStatusBadge(displaySheet.status)}
          <span className="text-xs text-muted-foreground">
            v{displaySheet.version} · Updated{" "}
            {new Date(displaySheet.updatedAt).toLocaleDateString()}
          </span>
          <div className="flex-1" />

          {isAdminView && !effectiveEditing && displaySheet.status === "PENDING" && (
            <>
              <Button
                size="sm"
                className="bg-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success))]/90 text-primary-foreground"
                onClick={() => approveMutation.mutate(displaySheet.id)}
                disabled={approveMutation.isPending}
                data-testid="btn-approve-sheet"
              >
                <Check className="w-4 h-4 mr-1" />
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setRejectSheetId(displaySheet.id);
                  setRejectDialogOpen(true);
                }}
                data-testid="btn-reject-sheet"
              >
                <X className="w-4 h-4 mr-1" />
                Reject
              </Button>
            </>
          )}

          {parentId && displaySheet.status !== "SENT_TO_PARENT" && (
            <Button
              size="sm"
              onClick={() => sendQuoteMutation.mutate(displaySheet.id)}
              disabled={sendQuoteMutation.isPending}
              data-testid="btn-send-quote"
            >
              <Send className="w-4 h-4 mr-1" />
              Send to Parent
            </Button>
          )}
        </div>
      )}

      {showDiffView && diffStats && (
        <Card className="border-[hsl(var(--brand-warning))]/30 bg-[hsl(var(--brand-warning))]/5" data-testid="card-diff-summary">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 text-sm">
              <ArrowUpDown className="w-4 h-4 text-[hsl(var(--brand-warning))]" />
              <span className="font-medium text-[hsl(var(--brand-warning))]">Changes from approved version:</span>
              {diffStats.changed > 0 && (
                <Badge variant="outline" className="bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">
                  {diffStats.changed} modified
                </Badge>
              )}
              {diffStats.added > 0 && (
                <Badge variant="outline" className="bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success))]/30">
                  {diffStats.added} added
                </Badge>
              )}
              {diffStats.removed > 0 && (
                <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">
                  {diffStats.removed} removed
                </Badge>
              )}
              {diffStats.changed === 0 && diffStats.added === 0 && diffStats.removed === 0 && (
                <span className="text-muted-foreground">No changes</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {!displaySheet && !effectiveEditing && !parentId && displayItems.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap" data-testid="sheet-status-bar-empty">
          <Badge className="bg-muted text-muted-foreground border-border">No submission yet</Badge>
        </div>
      )}

      {!activeCustomSheet && parentId && !effectiveEditing && (
        <Card data-testid="card-no-custom-quote">
          <CardContent className="py-8 text-center">
            <DollarSign className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-4">
              No custom cost sheet for this parent yet.
            </p>
            <Button
              onClick={() => createQuoteMutation.mutate()}
              disabled={createQuoteMutation.isPending || !approvedSheet}
              data-testid="btn-create-custom-quote"
            >
              <Plus className="w-4 h-4 mr-1" />
              Create Custom Cost Sheet
            </Button>
            {!approvedSheet && (
              <p className="text-xs text-muted-foreground mt-2">
                An approved master cost sheet is required first.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {displayItems.length > 0 && (
        <Accordion
          type="multiple"
          value={accordionValue}
          onValueChange={setAccordionValue}
          className="space-y-2"
          data-testid="cost-items-accordion"
        >
          {sortedGroupedEntries.map(([category, items]) => {
            const categoryHasChanges = showDiffView && items.some((item) => {
              const approved = approvedItemMap.get(`${item.category}::${item.key}`);
              return !approved || approved.minValue !== item.minValue || approved.maxValue !== item.maxValue || approved.isIncluded !== item.isIncluded;
            });

            return (
              <AccordionItem
                key={category}
                value={category}
                className={`border rounded-[var(--radius)] px-4 ${categoryHasChanges ? "border-[hsl(var(--brand-warning))]/30 bg-[hsl(var(--brand-warning))]/5" : ""}`}
                data-testid={`accordion-category-${category.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <AccordionTrigger className="text-sm font-semibold py-3">
                  <div className="flex items-center gap-2">
                    {category}
                    <span className="text-xs text-muted-foreground font-normal">
                      ({items.length} item{items.length !== 1 ? "s" : ""})
                    </span>
                    {categoryHasChanges && (
                      <Badge variant="outline" className="text-xs bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30 ml-1">
                        Changed
                      </Badge>
                    )}
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  {showDiffView && (
                    <div className="flex text-xs text-muted-foreground border-b pb-2 mb-2 px-3 gap-2">
                      <div className="flex-1">Item</div>
                      <div className="w-28 text-right">Pending</div>
                      <div className="w-4 shrink-0" />
                      <div className="w-28 text-right">Approved</div>
                      <div className="w-16 text-center">Status</div>
                    </div>
                  )}
                  <div className="space-y-3 pb-3">
                    {items.map((item) => {
                      const template = getTemplateForItem(item);
                      const approvedItem = approvedItemMap.get(`${item.category}::${item.key}`);
                      const itemChanged = showDiffView && approvedItem && (
                        approvedItem.minValue !== item.minValue ||
                        approvedItem.maxValue !== item.maxValue ||
                        approvedItem.isIncluded !== item.isIncluded
                      );
                      const isNewItem = showDiffView && !approvedItem;

                      return (
                        <div
                          key={item._editIdx}
                          className={`flex flex-col gap-2 p-3 rounded-[var(--radius)] border ${
                            item.isCustom
                              ? "border-l-4 border-l-[hsl(var(--brand-warning))]/60 bg-[hsl(var(--brand-warning))]/5"
                              : isNewItem
                                ? "border-l-4 border-l-[hsl(var(--brand-success))]/60 bg-[hsl(var(--brand-success))]/5"
                                : itemChanged
                                  ? "border-l-4 border-l-[hsl(var(--brand-warning))]/60 bg-[hsl(var(--brand-warning))]/3"
                                  : "bg-card"
                          } ${!item.isIncluded ? "opacity-50" : ""}`}
                          data-testid={`cost-item-row-${item._editIdx}`}
                        >
                          {showDiffView ? (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium" data-testid={`text-key-${item._editIdx}`}>
                                    {item.key}
                                  </span>
                                  {item.isCustom && (
                                    <Badge variant="outline" className="text-xs bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">
                                      Custom
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              <div className="w-28">
                                <DiffValueCell label="Min" pendingVal={item.minValue} approvedVal={approvedItem?.minValue ?? null} isCurrency={!isNumericOnlyField(getBaseKey(item.key))} />
                                {(item.maxValue !== item.minValue || (approvedItem && approvedItem.maxValue !== approvedItem.minValue)) && (
                                  <DiffValueCell label="Max" pendingVal={item.maxValue} approvedVal={approvedItem?.maxValue ?? null} isCurrency={!isNumericOnlyField(getBaseKey(item.key))} />
                                )}
                              </div>
                              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                              <div className="w-28 text-right">
                                {approvedItem ? (
                                  <>
                                    <span className="text-sm tabular-nums text-muted-foreground">
                                      {approvedItem.minValue != null
                                        ? (isNumericOnlyField(getBaseKey(item.key)) ? String(approvedItem.minValue) : formatCurrency(approvedItem.minValue))
                                        : "-"}
                                    </span>
                                    {approvedItem.maxValue !== approvedItem.minValue && approvedItem.maxValue != null && (
                                      <div className="text-xs text-muted-foreground">
                                        – {isNumericOnlyField(getBaseKey(item.key)) ? String(approvedItem.maxValue) : formatCurrency(approvedItem.maxValue)}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-xs text-muted-foreground italic">New</span>
                                )}
                              </div>
                              <div className="w-16 text-center">
                                {isNewItem ? (
                                  <Badge className="text-xs bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success))]/30">New</Badge>
                                ) : itemChanged ? (
                                  <Badge className="text-xs bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">Changed</Badge>
                                ) : (
                                  <span className="text-xs text-muted-foreground">-</span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                              <div className="flex-1 min-w-0">
                                {effectiveEditing && (item.isCustom || item._isVariant) ? (
                                  <Input
                                    value={item.key}
                                    onChange={(e) =>
                                      updateEditItem(item._editIdx, "key", e.target.value)
                                    }
                                    placeholder="Cost item name"
                                    className="h-8 text-sm"
                                    data-testid={`input-key-${item._editIdx}`}
                                  />
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium" data-testid={`text-key-${item._editIdx}`}>
                                      {item.key}
                                    </span>
                                    {item.isCustom && (
                                      <Badge variant="outline" className="text-xs bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">
                                        Custom
                                      </Badge>
                                    )}
                                  </div>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                {effectiveEditing ? (
                                  isNumericOnlyField(getBaseKey(item.key)) ? (
                                    <div className="flex items-center gap-1">
                                      <Input
                                        type="number"
                                        value={item.minValue ?? ""}
                                        onChange={(e) => {
                                          const val = e.target.value === "" ? null : Number(e.target.value);
                                          updateEditItem(item._editIdx, "minValue", val);
                                          updateEditItem(item._editIdx, "maxValue", val);
                                        }}
                                        onBlur={triggerAutoSave}
                                        onKeyDown={(e) => { if (e.key === "Enter") triggerAutoSave(); }}
                                        placeholder="Quantity"
                                        className="w-28 h-8 text-sm"
                                        min={0}
                                        data-testid={`input-numeric-${item._editIdx}`}
                                      />
                                    </div>
                                  ) : (
                                  <>
                                    <div className="flex items-center gap-1">
                                      <span className="text-xs text-muted-foreground">$</span>
                                      <Input
                                        type="number"
                                        value={item.minValue ?? ""}
                                        onChange={(e) =>
                                          updateEditItem(
                                            item._editIdx,
                                            "minValue",
                                            e.target.value === "" ? null : Number(e.target.value),
                                          )
                                        }
                                        onBlur={triggerAutoSave}
                                        onKeyDown={(e) => { if (e.key === "Enter") triggerAutoSave(); }}
                                        placeholder="Min"
                                        className="w-24 h-8 text-sm"
                                        data-testid={`input-min-${item._editIdx}`}
                                      />
                                    </div>
                                    <span className="text-muted-foreground">–</span>
                                    <div className="flex items-center gap-1">
                                      <span className="text-xs text-muted-foreground">$</span>
                                      <Input
                                        type="number"
                                        value={item.maxValue ?? ""}
                                        onChange={(e) =>
                                          updateEditItem(
                                            item._editIdx,
                                            "maxValue",
                                            e.target.value === "" ? null : Number(e.target.value),
                                          )
                                        }
                                        onBlur={triggerAutoSave}
                                        onKeyDown={(e) => { if (e.key === "Enter") triggerAutoSave(); }}
                                        placeholder="Max"
                                        className="w-24 h-8 text-sm"
                                        data-testid={`input-max-${item._editIdx}`}
                                      />
                                    </div>
                                  </>
                                  )
                                ) : (
                                  <span className="text-sm font-medium tabular-nums whitespace-nowrap" data-testid={`text-value-${item._editIdx}`}>
                                    {isNumericOnlyField(getBaseKey(item.key))
                                      ? (item.minValue != null ? String(item.minValue) : "-")
                                      : item.minValue != null || item.maxValue != null
                                        ? item.minValue === item.maxValue || item.maxValue == null
                                          ? formatCurrency(item.minValue ?? 0)
                                          : `${formatCurrency(item.minValue ?? 0)} – ${formatCurrency(item.maxValue)}`
                                        : item.isIncluded
                                          ? "Included"
                                          : "-"
                                    }
                                  </span>
                                )}

                                {effectiveEditing && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className={`h-8 px-2 text-xs ${item.isIncluded ? "text-[hsl(var(--brand-success))]" : "text-muted-foreground"}`}
                                      onClick={() => { updateEditItem(item._editIdx, "isIncluded", !item.isIncluded); setTimeout(triggerAutoSave, 50); }}
                                      data-testid={`btn-toggle-included-${item._editIdx}`}
                                    >
                                      {item.isIncluded ? "Included" : "Excluded"}
                                    </Button>
                                    {template?.allowMultiple && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 text-xs text-primary"
                                        onClick={() => addVariant(item, item._editIdx)}
                                        data-testid={`btn-add-variant-${item._editIdx}`}
                                      >
                                        <Copy className="w-3 h-3 mr-1" />
                                        Add Variant
                                      </Button>
                                    )}
                                    {item.isCustom && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 text-destructive"
                                        onClick={() => removeItem(item._editIdx)}
                                        data-testid={`btn-remove-item-${item._editIdx}`}
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </Button>
                                    )}
                                    {!item.isCustom && item._isVariant && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 text-destructive"
                                        onClick={() => removeVariant(item._editIdx)}
                                        data-testid={`btn-remove-variant-${item._editIdx}`}
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </Button>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          )}

                          {effectiveEditing && (
                            <Textarea
                              value={item.comment || ""}
                              onChange={(e) => updateEditItem(item._editIdx, "comment", e.target.value || null)}
                              onBlur={triggerAutoSave}
                              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); triggerAutoSave(); } }}
                              placeholder="Note (visible to parents)"
                              className="text-xs h-16 resize-none"
                              data-testid={`input-comment-${item._editIdx}`}
                            />
                          )}
                          {!effectiveEditing && item.comment && (
                            <p className="text-xs text-muted-foreground italic" data-testid={`text-comment-${item._editIdx}`}>
                              {item.comment}
                            </p>
                          )}
                        </div>
                      );
                    })}

                    {showDiffView && approvedSheet && (() => {
                      const removedItems = approvedSheet.items.filter(
                        (ai) => ai.category === category && !items.some((pi) => pi.key === ai.key),
                      );
                      if (removedItems.length === 0) return null;
                      return removedItems.map((ri, idx) => (
                        <div
                          key={`removed-${idx}`}
                          className="flex items-center gap-2 p-3 rounded-[var(--radius)] border border-l-4 border-l-destructive/60 bg-destructive/5 opacity-60"
                          data-testid={`cost-item-removed-${ri.key}`}
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium line-through text-destructive">{ri.key}</span>
                          </div>
                          <div className="w-28 text-right">
                            <span className="text-sm tabular-nums text-muted-foreground italic">-</span>
                          </div>
                          <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div className="w-28 text-right">
                            <span className="text-sm tabular-nums text-destructive/70 line-through">
                              {ri.minValue != null ? formatCurrency(ri.minValue) : "-"}
                            </span>
                          </div>
                          <div className="w-16 text-center">
                            <Badge className="text-xs bg-destructive/10 text-destructive border-destructive/30">Removed</Badge>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      )}

      {effectiveEditing && (
        <Button
          variant="outline"
          onClick={addCustomItem}
          className="w-full"
          data-testid="btn-add-custom-item"
        >
          <Plus className="w-4 h-4 mr-1" />
          Add Custom Cost Item
        </Button>
      )}

      {displayItems.length > 0 && (totals.minTotal > 0 || totals.maxTotal > 0 || effectiveEditing) && (
        <Card data-testid="card-total-cost">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Estimated Total</span>
              <span className="text-lg font-bold tabular-nums" data-testid="text-total-cost">
                {totals.minTotal > 0 && totals.minTotal !== totals.maxTotal
                  ? `${formatCurrency(totals.minTotal)} – ${formatCurrency(totals.maxTotal)}`
                  : formatCurrency(totals.maxTotal || totals.minTotal)}
              </span>
            </div>
            {showDiffView && approvedSheet && (
              <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
                <span>Previously approved total</span>
                <span className="tabular-nums">
                  {(() => {
                    const at = calculateTotalCost(approvedSheet.items);
                    return at.minTotal === at.maxTotal
                      ? formatCurrency(at.minTotal)
                      : `${formatCurrency(at.minTotal)} – ${formatCurrency(at.maxTotal)}`;
                  })()}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isAdminView && effectiveEditing && editItems.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-background px-6 py-4 border-t flex gap-2 justify-end items-center" data-testid="admin-edit-actions">
          {autoSaveStatus === "saving" && (
            <span className="text-xs text-muted-foreground flex items-center gap-1 mr-auto" data-testid="text-auto-save-status">
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving draft...
            </span>
          )}
          {autoSaveStatus === "saved" && (
            <span className="text-xs text-[hsl(var(--brand-success))] flex items-center gap-1 mr-auto" data-testid="text-auto-save-status">
              <Check className="w-3 h-3" />
              Draft saved
            </span>
          )}
          <Button
            variant="outline"
            onClick={() => {
              setIsEditing(false);
              setEditItems([]);
            }}
            data-testid="btn-cancel-edit"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (autoSavePendingTimerRef.current) { clearTimeout(autoSavePendingTimerRef.current); autoSavePendingTimerRef.current = null; }
              if (displaySheet && displaySheet.status !== "APPROVED") {
                updateMutation.mutate({ sheetId: displaySheet.id, items: editItems });
              } else {
                submitMutation.mutate({ items: editItems, sheetId: undefined });
              }
            }}
            disabled={updateMutation.isPending || submitMutation.isPending}
            data-testid="btn-admin-save"
          >
            {(updateMutation.isPending || submitMutation.isPending) ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : null}
            Save
          </Button>
        </div>
      )}

      {!isAdminView && editItems.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-background px-6 py-4 border-t flex gap-2 justify-end items-center" data-testid="edit-actions">
          {autoSaveStatus === "saving" && (
            <span className="text-xs text-muted-foreground flex items-center gap-1 mr-auto" data-testid="text-auto-save-status">
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving draft...
            </span>
          )}
          {autoSaveStatus === "saved" && (
            <span className="text-xs text-[hsl(var(--brand-success))] flex items-center gap-1 mr-auto" data-testid="text-auto-save-status">
              <Check className="w-3 h-3" />
              Draft saved
            </span>
          )}
          {missingMandatory.length > 0 && (
            <p className="text-xs text-destructive self-center mr-2" data-testid="text-missing-mandatory">
              Missing: {missingMandatory.join(", ")}
            </p>
          )}
          <Button
            onClick={() => {
              if (autoSavePendingTimerRef.current) { clearTimeout(autoSavePendingTimerRef.current); autoSavePendingTimerRef.current = null; }
              submitMutation.mutate({
                items: editItems,
                sheetId: displaySheet?.status === "APPROVED" ? undefined : displaySheet?.id,
              });
            }}
            disabled={submitMutation.isPending || missingMandatory.length > 0}
            data-testid="btn-submit-for-approval"
          >
            {submitMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : null}
            Submit for Approval
          </Button>
        </div>
      )}

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Cost Sheet</DialogTitle>
            <DialogDescription>Provide feedback for the provider.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectFeedback}
            onChange={(e) => setRejectFeedback(e.target.value)}
            placeholder="Explain why this cost sheet is being rejected..."
            className="min-h-[100px]"
            data-testid="input-reject-feedback"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                rejectMutation.mutate({
                  sheetId: rejectSheetId,
                  feedback: rejectFeedback,
                })
              }
              disabled={!rejectFeedback.trim() || rejectMutation.isPending}
              data-testid="btn-confirm-reject"
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SERVICE_LABELS: Record<string, string> = {
  "Egg Donor Agency": "Egg Donation",
  "Surrogacy Agency": "Surrogacy",
  "IVF Clinic": "IVF",
  "Egg Bank": "Egg Bank",
  "Sperm Bank": "Sperm Bank",
  "Legal Services": "Legal",
};

function getServiceLabel(name: string): string {
  return SERVICE_LABELS[name] || name;
}

function ProgramTotalBadge({ providerId, programId, isAdminView }: { providerId: string; programId: string; isAdminView?: boolean }) {
  const approvedQuery = useQuery<CostSheet | null>({
    queryKey: ["/api/costs/provider", providerId, "approved", "none", "none", programId],
    queryFn: () =>
      fetch(`/api/costs/provider/${providerId}/approved?programId=${programId}`).then((r) => r.json()),
  });

  const allSheetsQuery = useQuery<CostSheet[]>({
    queryKey: ["/api/costs/provider", providerId, "sheets", "none", "default", programId],
    queryFn: () =>
      fetch(`/api/costs/provider/${providerId}?programId=${programId}`).then((r) => r.json()),
    enabled: !!isAdminView,
  });

  let sheet: CostSheet | null | undefined = approvedQuery.data;
  if (isAdminView && !sheet?.items?.length) {
    const sheets = allSheetsQuery.data;
    if (sheets?.length) {
      sheet = sheets[sheets.length - 1];
    }
  }

  if (!sheet?.items?.length) return null;

  const totals = calculateTotalCost(sheet.items);
  if (!totals.maxTotal && !totals.minTotal) return null;

  const display =
    totals.minTotal > 0 && totals.minTotal !== totals.maxTotal
      ? `${formatCurrency(totals.minTotal)} - ${formatCurrency(totals.maxTotal)}`
      : formatCurrency(totals.maxTotal || totals.minTotal);

  return <span className="text-sm font-semibold tabular-nums">{display}</span>;
}

function ProgramsView({
  providerType,
  providerTypeId,
  providerId,
  isAdminView,
  parentId,
  subType,
}: {
  providerType: string;
  providerTypeId?: string;
  providerId: string;
  isAdminView: boolean;
  parentId?: string;
  subType?: string;
}) {
  const { toast } = useToast();
  const [expandedProgramId, setExpandedProgramId] = useState<string | null>(null);
  const [isAddingProgram, setIsAddingProgram] = useState(false);
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formCountry, setFormCountry] = useState("");

  const programsQueryKey = ["/api/costs/programs", providerId, providerTypeId || "all", subType || "none"];
  const programsQuery = useQuery<CostProgram[]>({
    queryKey: programsQueryKey,
    queryFn: () => {
      const params = new URLSearchParams({ providerId });
      if (providerTypeId) params.set("providerTypeId", providerTypeId);
      if (subType) params.set("subType", subType);
      return fetch(`/api/costs/programs?${params.toString()}`, { credentials: "include" }).then((r) => r.json());
    },
    enabled: !!providerId,
  });

  const invalidatePrograms = () => queryClient.invalidateQueries({ queryKey: programsQueryKey });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; country: string }) => {
      const res = await apiRequest("POST", "/api/costs/programs", { providerId, providerTypeId, subType, ...data });
      return res.json() as Promise<CostProgram>;
    },
    onSuccess: (newProgram: CostProgram) => {
      invalidatePrograms();
      setIsAddingProgram(false);
      setFormName("");
      setFormCountry("");
      setExpandedProgramId(newProgram.id);
      toast({ title: "Program created", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to create program", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, name, country }: { id: string; name: string; country: string }) =>
      apiRequest("PATCH", `/api/costs/programs/${id}`, { name, country }),
    onSuccess: () => {
      invalidatePrograms();
      setEditingProgramId(null);
      toast({ title: "Program updated", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update program", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/costs/programs/${id}`),
    onSuccess: () => {
      invalidatePrograms();
      toast({ title: "Program deleted", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to delete program", description: err.message, variant: "destructive" });
    },
  });

  const updateSubTypeMutation = useMutation({
    mutationFn: ({ id, subType }: { id: string; subType: string }) =>
      apiRequest("PATCH", `/api/costs/programs/${id}`, { subType }),
    onSuccess: () => invalidatePrograms(),
    onError: (err: any) => {
      toast({ title: "Failed to update program type", description: err.message, variant: "destructive" });
    },
  });

  const isIvfType = providerType.toLowerCase().includes("ivf");

  const programs = Array.isArray(programsQuery.data) ? programsQuery.data : [];

  function startEdit(program: CostProgram) {
    setEditingProgramId(program.id);
    setFormName(program.name);
    setFormCountry(program.country);
  }

  function cancelEdit() {
    setEditingProgramId(null);
    setFormName("");
    setFormCountry("");
  }

  function startAdd() {
    setIsAddingProgram(true);
    setFormName("");
    setFormCountry("");
    setEditingProgramId(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {programs.length === 0 ? "No programs yet" : `${programs.length} program${programs.length !== 1 ? "s" : ""}`}
        </p>
        {isAdminView && !isAddingProgram && (
          <Button size="sm" variant="outline" onClick={startAdd}>
            <Plus className="w-4 h-4 mr-1" />
            Add Program
          </Button>
        )}
      </div>

      {isAddingProgram && (
        <div className="border rounded-[var(--container-radius)] p-4 space-y-3 bg-muted/20">
          <p className="text-sm font-medium">New Program</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Program Name</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Standard Package"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Country</Label>
              <SingleCountryAutocompleteInput
                value={formCountry}
                onChange={setFormCountry}
                placeholder="Select country..."
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!formName.trim() || !formCountry.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate({ name: formName.trim(), country: formCountry.trim() })}
            >
              {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Check className="w-4 h-4 mr-1" />}
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIsAddingProgram(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {programsQuery.isLoading && (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-14 rounded-[var(--container-radius)] bg-muted animate-pulse" />)}
        </div>
      )}

      {programs.map((program) => {
        const isExpanded = expandedProgramId === program.id;
        const isEditing = editingProgramId === program.id;

        return (
          <div key={program.id} className="border rounded-[var(--container-radius)] overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 bg-muted/20">
              {isEditing ? (
                <>
                  <div className="flex-1 grid grid-cols-2 gap-3">
                    <Input
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="Program name"
                      className="h-8 text-sm"
                    />
                    <SingleCountryAutocompleteInput
                      value={formCountry}
                      onChange={setFormCountry}
                      placeholder="Country"
                    />
                  </div>
                  <Button
                    size="sm"
                    disabled={!formName.trim() || !formCountry.trim() || updateMutation.isPending}
                    onClick={() => updateMutation.mutate({ id: program.id, name: formName.trim(), country: formCountry.trim() })}
                  >
                    {updateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={cancelEdit}>
                    <X className="w-4 h-4" />
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex-1 flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{program.name}</span>
                    <Badge variant="outline" className="text-xs flex items-center gap-1">
                      {getCountryFlag(program.country)
                        ? <span>{getCountryFlag(program.country)}</span>
                        : <Globe className="w-3 h-3" />}
                      {program.country}
                    </Badge>
                    <ProgramTotalBadge providerId={providerId} programId={program.id} isAdminView={isAdminView} />
                  </div>
                  {isAdminView && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => startEdit(program)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Program</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete "{program.name}" and all its cost data. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => {
                                if (expandedProgramId === program.id) setExpandedProgramId(null);
                                deleteMutation.mutate(program.id);
                              }}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => setExpandedProgramId(isExpanded ? null : program.id)}
                  >
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </Button>
                </>
              )}
            </div>

            {isExpanded && (
              <div className="border-t">
                {isIvfType && (
                  <div className="px-4 pt-3 pb-1">
                    <div className="inline-flex gap-0.5 p-1 bg-muted rounded-[var(--radius)]">
                      {([{ value: "ivf_cycle", label: "IVF Cycle" }, { value: "shipping_embryos", label: "Shipping Embryos" }] as const).map((opt) => {
                        const active = (program.subType ?? "ivf_cycle") === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            className={cn(
                              "px-3 py-1 text-sm rounded-[var(--radius)] transition-colors",
                              active
                                ? "bg-background text-foreground shadow-sm font-medium"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                            onClick={() => {
                              if (!active) updateSubTypeMutation.mutate({ id: program.id, subType: opt.value });
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="p-4">
                  <SingleCostsTab
                    providerType={providerType}
                    providerTypeId={providerTypeId}
                    providerId={providerId}
                    isAdminView={isAdminView}
                    parentId={parentId}
                    subType={subType}
                    programId={program.id}
                    programSubType={isIvfType ? (program.subType ?? "ivf_cycle") : undefined}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}

      {programs.length === 0 && !programsQuery.isLoading && !isAddingProgram && (
        <div className="text-center py-8 border rounded-[var(--container-radius)] text-muted-foreground">
          <Globe className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No programs created yet.</p>
          {isAdminView && (
            <p className="text-xs mt-1">Click "Add Program" to create the first program.</p>
          )}
        </div>
      )}
    </div>
  );
}

function isEggDonationType(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("egg donor") || lower === "egg donation";
}

function EggDonationSubTabs({
  providerType,
  providerTypeId,
  providerId,
  isAdminView,
  parentId,
}: {
  providerType: string;
  providerTypeId?: string;
  providerId: string;
  isAdminView: boolean;
  parentId?: string;
}) {
  const [activeSubTab, setActiveSubTab] = useState("fresh");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4" data-testid="egg-donation-sub-tabs">
        <label className="flex items-center gap-2 cursor-pointer text-sm" data-testid="sub-tab-fresh">
          <input
            type="radio"
            name="egg-donation-sub"
            value="fresh"
            checked={activeSubTab === "fresh"}
            onChange={() => setActiveSubTab("fresh")}
            className="accent-primary w-4 h-4"
          />
          Fresh Donor Costs
        </label>
        <label className="flex items-center gap-2 cursor-pointer text-sm" data-testid="sub-tab-frozen">
          <input
            type="radio"
            name="egg-donation-sub"
            value="frozen"
            checked={activeSubTab === "frozen"}
            onChange={() => setActiveSubTab("frozen")}
            className="accent-primary w-4 h-4"
          />
          Frozen Eggs Costs
        </label>
      </div>
      {activeSubTab === "fresh" && (
        <ProgramsView
          providerType={providerType}
          providerTypeId={providerTypeId}
          providerId={providerId}
          isAdminView={isAdminView}
          parentId={parentId}
          subType="fresh"
        />
      )}
      {activeSubTab === "frozen" && (
        <ProgramsView
          providerType={providerType}
          providerTypeId={providerTypeId}
          providerId={providerId}
          isAdminView={isAdminView}
          parentId={parentId}
          subType="frozen"
        />
      )}
    </div>
  );
}

export default function ProviderCostsTab({
  providerType,
  providerId,
  isAdminView,
  parentId,
  providerServices,
}: ProviderCostsTabProps) {
  const services = providerServices && providerServices.length > 0 ? providerServices : null;
  const [selectedTypeId, setSelectedTypeId] = useState<string>(services?.[0]?.providerTypeId || "");

  useEffect(() => {
    if (services && services.length > 0 && !services.find(s => s.providerTypeId === selectedTypeId)) {
      setSelectedTypeId(services[0].providerTypeId);
    }
  }, [services, selectedTypeId]);

  if (!services || services.length <= 1) {
    const svcName = services?.[0]?.providerTypeName || providerType;
    const svcTypeId = services?.[0]?.providerTypeId;

    if (isEggDonationType(svcName)) {
      return (
        <EggDonationSubTabs
          providerType={svcName}
          providerTypeId={svcTypeId}
          providerId={providerId}
          isAdminView={isAdminView}
          parentId={parentId}
        />
      );
    }

    return (
      <ProgramsView
        providerType={svcName}
        providerTypeId={svcTypeId}
        providerId={providerId}
        isAdminView={isAdminView}
        parentId={parentId}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ServiceTabs value={selectedTypeId} onValueChange={setSelectedTypeId}>
        <ServiceTabsList data-testid="costs-service-tabs">
          {services.map((svc) => (
            <ServiceTabsTrigger
              key={svc.providerTypeId}
              value={svc.providerTypeId}
              data-testid={`costs-tab-${svc.providerTypeId}`}
            >
              <DollarSign className="w-4 h-4 mr-1" />
              {getServiceLabel(svc.providerTypeName)}
            </ServiceTabsTrigger>
          ))}
        </ServiceTabsList>
        {services.map((svc) => (
          <ServiceTabsContent key={svc.providerTypeId} value={svc.providerTypeId}>
            {isEggDonationType(svc.providerTypeName) ? (
              <EggDonationSubTabs
                providerType={svc.providerTypeName}
                providerTypeId={svc.providerTypeId}
                providerId={providerId}
                isAdminView={isAdminView}
                parentId={parentId}
              />
            ) : (
              <ProgramsView
                providerType={svc.providerTypeName}
                providerTypeId={svc.providerTypeId}
                providerId={providerId}
                isAdminView={isAdminView}
                parentId={parentId}
              />
            )}
          </ServiceTabsContent>
        ))}
      </ServiceTabs>
    </div>
  );
}
