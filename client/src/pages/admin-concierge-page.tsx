import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Matchmaker } from "@/hooks/use-brand-settings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Sparkles,
  Plus,
  Pencil,
  Trash2,
  Upload,
  X,
  Loader2,
  GripVertical,
  Eye,
  EyeOff,
  MessageSquare,
  Bot,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export default function AdminConciergePage() {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Matchmaker>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const matchmakersQuery = useQuery<Matchmaker[]>({
    queryKey: ["/api/brand/matchmakers"],
    queryFn: async () => {
      const res = await fetch("/api/brand/matchmakers", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Matchmaker>) => {
      const res = await apiRequest("POST", "/api/brand/matchmakers", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setShowAddForm(false);
      setEditForm({});
      toast({ title: "Matchmaker created", variant: "success" });
    },
    onError: () => toast({ title: "Failed to create matchmaker", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: Partial<Matchmaker> & { id: string }) => {
      const res = await apiRequest("PUT", `/api/brand/matchmakers/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setEditingId(null);
      setEditForm({});
      toast({ title: "Matchmaker updated", variant: "success" });
    },
    onError: () => toast({ title: "Failed to update matchmaker", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/brand/matchmakers/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      toast({ title: "Matchmaker deleted", variant: "success" });
    },
    onError: () => toast({ title: "Failed to delete matchmaker", variant: "destructive" }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await apiRequest("PUT", `/api/brand/matchmakers/${id}`, { isActive });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const handleAvatarUpload = async (file: File, callback: (url: string) => void) => {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      callback(data.url);
    } catch {
      toast({ title: "Failed to upload image", variant: "destructive" });
    }
  };

  const matchmakers = matchmakersQuery.data || [];
  const activeCount = matchmakers.filter(m => m.isActive).length;

  const renderForm = (isNew: boolean) => {
    const onSave = () => {
      if (!editForm.name || !editForm.title || !editForm.description || !editForm.personalityPrompt) {
        toast({ title: "Name, title, description, and personality prompt are required", variant: "destructive" });
        return;
      }
      if (isNew) {
        createMutation.mutate({ ...editForm, isActive: editForm.isActive !== false });
      } else if (editingId) {
        updateMutation.mutate({ id: editingId, ...editForm });
      }
    };

    return (
      <Card className="rounded-xl p-5 space-y-4 border-primary/20 border-2" data-testid={isNew ? "matchmaker-add-form" : `matchmaker-edit-form-${editingId}`}>
        <div className="flex items-center gap-2 pb-2 border-b">
          <Bot className="w-4 h-4 text-primary" />
          <span className="font-medium text-sm">{isNew ? "New Matchmaker" : "Edit Matchmaker"}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Name *</Label>
            <Input
              placeholder="e.g. Ariel"
              value={editForm.name || ""}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              data-testid="input-matchmaker-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Title *</Label>
            <Input
              placeholder="e.g. The Warm Guide"
              value={editForm.title || ""}
              onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              data-testid="input-matchmaker-title"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Description *</Label>
          <Textarea
            placeholder="Brief description of this matchmaker's personality..."
            value={editForm.description || ""}
            onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
            rows={2}
            data-testid="input-matchmaker-description"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Personality Prompt *</Label>
          <Textarea
            placeholder="System prompt that defines the AI's personality and behavior..."
            value={editForm.personalityPrompt || ""}
            onChange={(e) => setEditForm({ ...editForm, personalityPrompt: e.target.value })}
            rows={4}
            className="font-mono text-xs"
            data-testid="input-matchmaker-prompt"
          />
          <p className="text-xs text-muted-foreground">
            This prompt shapes how the AI persona communicates. It is never visible to parents.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Initial Greeting</Label>
          <Textarea
            placeholder="The first message parents see when they select this matchmaker..."
            value={editForm.initialGreeting || ""}
            onChange={(e) => setEditForm({ ...editForm, initialGreeting: e.target.value })}
            rows={2}
            data-testid="input-matchmaker-greeting"
          />
          <p className="text-xs text-muted-foreground">
            Optional. Displayed as the opening message when a parent selects this persona.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Avatar</Label>
            <div className="flex items-center gap-3">
              {editForm.avatarUrl && (
                <img
                  src={editForm.avatarUrl}
                  alt={editForm.name || "Avatar"}
                  className="w-10 h-10 rounded-full object-cover border"
                  data-testid="img-matchmaker-avatar-preview"
                />
              )}
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleAvatarUpload(file, (url) => setEditForm({ ...editForm, avatarUrl: url }));
                  }}
                  data-testid="input-matchmaker-avatar-upload"
                />
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-md hover:bg-muted transition-colors">
                  <Upload className="w-3.5 h-3.5" />
                  {editForm.avatarUrl ? "Change" : "Upload"}
                </span>
              </label>
              {editForm.avatarUrl && (
                <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setEditForm({ ...editForm, avatarUrl: null })} data-testid="btn-clear-matchmaker-avatar">
                  <X className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Status</Label>
            <div className="flex items-center gap-2 pt-1">
              <Switch
                checked={editForm.isActive !== false}
                onCheckedChange={(checked) => setEditForm({ ...editForm, isActive: checked })}
                data-testid="switch-matchmaker-active"
              />
              <span className="text-sm text-muted-foreground">
                {editForm.isActive !== false ? "Active — visible to parents" : "Inactive — hidden from parents"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setEditingId(null); setShowAddForm(false); setEditForm({}); }}
            data-testid="btn-matchmaker-cancel"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={createMutation.isPending || updateMutation.isPending}
            data-testid="btn-matchmaker-save"
          >
            {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
            {isNew ? "Create Matchmaker" : "Save Changes"}
          </Button>
        </div>
      </Card>
    );
  };

  return (
    <div className="space-y-6" data-testid="admin-concierge-page">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="font-display text-lg font-semibold">AI Concierge Personas</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Configure the AI matchmaker personas that intended parents can choose from during their concierge experience.
          </p>
        </div>
        {!showAddForm && !editingId && (
          <Button
            size="sm"
            onClick={() => { setShowAddForm(true); setEditForm({ isActive: true }); }}
            data-testid="btn-add-matchmaker"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Add Persona
          </Button>
        )}
      </div>

      {matchmakers.length > 0 && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground" data-testid="matchmaker-stats">
          <span>{matchmakers.length} persona{matchmakers.length !== 1 ? "s" : ""} total</span>
          <span className="text-green-600 dark:text-green-400">{activeCount} active</span>
          {matchmakers.length - activeCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400">{matchmakers.length - activeCount} inactive</span>
          )}
        </div>
      )}

      {matchmakersQuery.isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" data-testid="matchmakers-loading" />
        </div>
      )}

      {showAddForm && renderForm(true)}

      <div className="space-y-3">
        {matchmakers.map((m) => (
          editingId === m.id ? (
            <div key={m.id}>{renderForm(false)}</div>
          ) : (
            <Card
              key={m.id}
              className={`rounded-xl overflow-hidden transition-all ${!m.isActive ? "opacity-60" : ""}`}
              data-testid={`matchmaker-card-${m.id}`}
            >
              <div className="flex items-center gap-3 p-4">
                <div className="flex-shrink-0 text-muted-foreground/40">
                  <GripVertical className="w-4 h-4" />
                </div>
                <div className="flex-shrink-0">
                  {m.avatarUrl ? (
                    <img src={m.avatarUrl} alt={m.name} className="w-11 h-11 rounded-full object-cover border" />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-sm">
                      {m.name.charAt(0)}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{m.name}</span>
                    <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-muted rounded">
                      {m.title}
                    </span>
                    {!m.isActive && (
                      <span className="text-xs text-amber-600 dark:text-amber-400 px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 rounded" data-testid={`badge-inactive-${m.id}`}>
                        Inactive
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{m.description}</p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Switch
                    checked={m.isActive}
                    onCheckedChange={(checked) => toggleActiveMutation.mutate({ id: m.id, isActive: checked })}
                    data-testid={`switch-active-${m.id}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => setExpandedId(expandedId === m.id ? null : m.id)}
                    data-testid={`btn-expand-matchmaker-${m.id}`}
                  >
                    {expandedId === m.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => { setEditingId(m.id); setEditForm(m); setShowAddForm(false); setExpandedId(null); }}
                    data-testid={`btn-edit-matchmaker-${m.id}`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete matchmaker "${m.name}"?`)) {
                        deleteMutation.mutate(m.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    data-testid={`btn-delete-matchmaker-${m.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              {expandedId === m.id && (
                <div className="px-4 pb-4 pt-0 border-t space-y-3" data-testid={`matchmaker-details-${m.id}`}>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        <Bot className="w-3.5 h-3.5" />
                        Personality Prompt
                      </div>
                      <p className="text-sm bg-muted/50 rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                        {m.personalityPrompt}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        <MessageSquare className="w-3.5 h-3.5" />
                        Initial Greeting
                      </div>
                      {m.initialGreeting ? (
                        <p className="text-sm bg-muted/50 rounded-lg p-3 leading-relaxed">
                          {m.initialGreeting}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground italic p-3">No custom greeting set</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          )
        ))}
      </div>

      {!matchmakersQuery.isLoading && matchmakers.length === 0 && !showAddForm && (
        <Card className="rounded-xl p-12 text-center" data-testid="matchmakers-empty">
          <Sparkles className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No matchmaker personas configured yet.
          </p>
          <Button
            size="sm"
            className="mt-4"
            onClick={() => { setShowAddForm(true); setEditForm({ isActive: true }); }}
            data-testid="btn-add-first-matchmaker"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Create Your First Persona
          </Button>
        </Card>
      )}
    </div>
  );
}
