import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MessageSquarePlus,
  Paperclip,
  Trash2,
  Loader2,
  Plus,
  X,
  Pencil,
  Eye,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ui/confirm-bar";
import { getFileTypeMeta, formatFileSize } from "@/lib/file-type-icon";
import { FileTypeGlyph } from "@/components/chat/file-type-glyph";
import { AUTO_REPLY_STARTERS, AUTO_REPLY_TOKENS, autoReplyStartersFor, bodyPromisesAttachment, type AutoReplyStarter } from "@shared/auto-reply-starters";

/**
 * Provider booking auto-reply settings.
 *
 * One organization-wide default, overridable per staff member, and scoped per
 * service line - a coordinator who takes both egg-donor and surrogacy calls
 * writes a different greeting for each. Mounted in two places (the provider's
 * own /account/auto-replies tab and the admin's provider edit page), so it
 * takes providerId as a prop rather than reading it from the session.
 */

const ANY_STAFF = "__org__";
const ANY_SERVICE = "__any__";

const TOKENS = AUTO_REPLY_TOKENS;

type AutoReply = {
  id: string;
  staffUserId: string | null;
  providerTypeId: string | null;
  body: string;
  attachments: Array<{ originalName?: string; url: string; mimeType?: string; size?: number }>;
  isEnabled: boolean;
  staffUser?: { id: string; name: string | null; email: string } | null;
  providerType?: { id: string; name: string } | null;
};

type DraftState = {
  id: string | null;
  staffUserId: string;
  providerTypeId: string;
  body: string;
  attachments: AutoReply["attachments"];
  isEnabled: boolean;
};

const EMPTY_DRAFT: DraftState = {
  id: null,
  staffUserId: ANY_STAFF,
  providerTypeId: ANY_SERVICE,
  // Prefilled with real, editable text. Defaults to the no-attachment variant
  // because that one is true the moment it is saved.
  body: AUTO_REPLY_STARTERS[0].body,
  attachments: [],
  isEnabled: true,
};

export default function ProviderAutoReplyTab({ providerId }: { providerId?: string }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const qs = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";

  const optionsQuery = useQuery<any>({
    queryKey: [`/api/provider-auto-replies/options${qs}`],
  });
  const listQuery = useQuery<{ autoReplies: AutoReply[] }>({
    queryKey: [`/api/provider-auto-replies${qs}`],
  });

  const staff = optionsQuery.data?.staff || [];
  const serviceTypes = optionsQuery.data?.serviceTypes || [];
  const rows = listQuery.data?.autoReplies || [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/provider-auto-replies${qs}`] });
  };

  const saveMutation = useMutation({
    mutationFn: async (d: DraftState) => {
      const payload = {
        providerId,
        body: d.body,
        attachments: d.attachments,
        isEnabled: d.isEnabled,
        staffUserId: d.staffUserId === ANY_STAFF ? null : d.staffUserId,
        providerTypeId: d.providerTypeId === ANY_SERVICE ? null : d.providerTypeId,
      };
      const res = d.id
        ? await apiRequest("PUT", `/api/provider-auto-replies/${d.id}`, payload)
        : await apiRequest("POST", "/api/provider-auto-replies", payload);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Auto-reply saved", description: "Parents who book from now on will receive it." });
      setDraft(null);
      setPreview(null);
      refresh();
    },
    onError: (err: any) => {
      toast({ title: "Could not save", description: err.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isEnabled }: { id: string; isEnabled: boolean }) => {
      const res = await apiRequest("PUT", `/api/provider-auto-replies/${id}`, { isEnabled });
      return res.json();
    },
    onSuccess: refresh,
    onError: (err: any) => {
      toast({ title: "Could not update", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/provider-auto-replies/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Auto-reply deleted" });
      setDraft(null);
      refresh();
    },
    onError: (err: any) => {
      toast({ title: "Could not delete", description: err.message, variant: "destructive" });
    },
  });

  const previewMutation = useMutation({
    mutationFn: async (d: DraftState) => {
      const res = await apiRequest("POST", "/api/provider-auto-replies/preview", {
        providerId,
        body: d.body,
        staffUserId: d.staffUserId === ANY_STAFF ? null : d.staffUserId,
      });
      return res.json();
    },
    onSuccess: (data: any) => setPreview(data.rendered || ""),
  });

  async function handleFiles(files: FileList | null) {
    if (!files?.length || !draft) return;
    setUploading(true);
    try {
      const uploaded: AutoReply["attachments"] = [];
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/chat-upload", {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || `Upload failed (${res.status})`);
        }
        uploaded.push(await res.json());
      }
      setDraft({ ...draft, attachments: [...draft.attachments, ...uploaded] });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  /** True when `text` is an untouched starter for ANY service line - the
   *  provider has not written anything of their own worth protecting. */
  function isAnyStarterBody(text: string): boolean {
    const all = [null, ...serviceTypes.map((t: any) => t.name)];
    return all.some((svc) => autoReplyStartersFor(svc).some((s) => s.body.trim() === text));
  }

  /**
   * Swap the body to a starter. Never silently discards writing: if the body
   * is neither empty nor an untouched starter, it is the provider's own text
   * and replacing it needs their say-so.
   */
  async function applyStarter(starter: AutoReplyStarter) {
    if (!draft) return;
    const current = draft.body.trim();
    const isUntouched = current === "" || isAnyStarterBody(current);
    if (!isUntouched) {
      const ok = await confirm({
        title: "Replace your message?",
        message: "You have written your own message. Starting from this template will discard it.",
        confirmLabel: "Replace",
        tone: "warning",
      });
      if (!ok) return;
    }
    setDraft({ ...draft, body: starter.body });
    setPreview(null);
  }

  // Starters follow the chosen service line, so an egg-donor template opens
  // with egg-donor copy. Resolved from the picker rather than the saved row so
  // it updates the moment the provider changes the dropdown.
  const activeServiceName: string | null =
    draft && draft.providerTypeId !== ANY_SERVICE
      ? (serviceTypes.find((t: any) => t.id === draft.providerTypeId)?.name ?? null)
      : null;
  const starters = autoReplyStartersFor(activeServiceName);

  // The attachment starter promises a file. Saying "I've attached..." with
  // nothing attached is worse than not mentioning it, so flag the mismatch.
  const promisesAttachment = !!draft && draft.attachments.length === 0 && bodyPromisesAttachment(draft.body);

  function insertToken(token: string) {
    if (!draft) return;
    setDraft({ ...draft, body: `${draft.body}${draft.body && !draft.body.endsWith(" ") ? " " : ""}${token}` });
  }

  function scopeLabel(r: AutoReply) {
    const who = r.staffUser ? (r.staffUser.name || r.staffUser.email) : "Everyone at your organization";
    const what = r.providerType ? r.providerType.name : "All services";
    return { who, what };
  }

  if (optionsQuery.isLoading || listQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="provider-auto-reply-tab">
      <div>
        <h2 className="t-section-title font-heading">Booking auto-reply</h2>
        <p className="t-helper mt-1 max-w-2xl">
          Your introduction. When a parent books their <strong>first consultation</strong> with
          you, this message is posted into your chat with them right away, under your name -
          so they hear from you immediately instead of waiting. Write it addressed to the parent.
          It is sent once per parent, so later calls with the same family stay quiet.
        </p>
      </div>

      {/* Existing templates */}
      {rows.length === 0 && !draft ? (
        <Card className="bg-secondary border-0 p-8 text-center">
          <MessageSquarePlus className="h-8 w-8 mx-auto text-primary/70" />
          <p className="t-card-heading font-heading mt-3">No auto-reply yet</p>
          <p className="t-helper mt-1 max-w-md mx-auto">
            A parent who books a consultation currently hears nothing from you until you
            open the chat yourself. A short introduction closes that gap. One is ready to
            use - open it, adjust the wording, save.
          </p>
          <Button className="mt-4" onClick={() => setDraft({ ...EMPTY_DRAFT })} data-testid="button-create-auto-reply">
            <Plus className="h-4 w-4 mr-1.5" />
            Create auto-reply
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const { who, what } = scopeLabel(r);
            return (
              <Card key={r.id} className="p-4" data-testid={`auto-reply-row-${r.id}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-accent text-accent-foreground">{who}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">{what}</span>
                      {!r.isEnabled && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">Off</span>
                      )}
                    </div>
                    <p className="t-helper mt-2 whitespace-pre-wrap line-clamp-3">{r.body}</p>
                    {r.attachments?.length > 0 && (
                      <p className="t-helper mt-2 flex items-center gap-1.5">
                        <Paperclip className="h-3.5 w-3.5" />
                        {r.attachments.length} attachment{r.attachments.length === 1 ? "" : "s"}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={r.isEnabled}
                      onCheckedChange={(v) => toggleMutation.mutate({ id: r.id, isEnabled: v })}
                      aria-label="Enable auto-reply"
                      data-testid={`switch-auto-reply-${r.id}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDraft({
                          id: r.id,
                          staffUserId: r.staffUserId || ANY_STAFF,
                          providerTypeId: r.providerTypeId || ANY_SERVICE,
                          body: r.body,
                          attachments: r.attachments || [],
                          isEnabled: r.isEnabled,
                        })
                      }
                      data-testid={`button-edit-auto-reply-${r.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete this auto-reply?",
                          message: `Parents booking their first consultation will stop receiving this introduction (${who} - ${what}). Your other templates are unaffected.`,
                          confirmLabel: "Delete",
                          tone: "destructive",
                        });
                        if (ok) deleteMutation.mutate(r.id);
                      }}
                      data-testid={`button-delete-auto-reply-${r.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}

          {!draft && (
            <Button variant="outline" onClick={() => setDraft({ ...EMPTY_DRAFT })} data-testid="button-add-auto-reply">
              <Plus className="h-4 w-4 mr-1.5" />
              Add another
            </Button>
          )}
        </div>
      )}

      {/* Inline editor - no modal, per the app's full-page/inline rule */}
      {draft && (
        <Card className="p-5 space-y-5 border-primary/30" data-testid="auto-reply-editor">
          <div className="flex items-center justify-between">
            <h3 className="t-card-heading font-heading">
              {draft.id ? "Edit auto-reply" : "New auto-reply"}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setPreview(null); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="t-form-label mb-1.5">Applies to</p>
              <Select
                value={draft.staffUserId}
                onValueChange={(v) => setDraft({ ...draft, staffUserId: v })}
              >
                <SelectTrigger data-testid="select-auto-reply-staff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_STAFF}>Everyone at your organization</SelectItem>
                  {staff.map((s: any) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name || s.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="t-helper mt-1">
                A staff member's own template wins over the organization default.
              </p>
            </div>

            <div>
              <p className="t-form-label mb-1.5">Service line</p>
              <Select
                value={draft.providerTypeId}
                onValueChange={(v) => {
                  // Retarget the copy at the new service line, but only while
                  // the body is still an untouched starter - never overwrite
                  // something the provider wrote.
                  const name = v === ANY_SERVICE
                    ? null
                    : (serviceTypes.find((t: any) => t.id === v)?.name ?? null);
                  const keepIndex = Math.max(
                    0,
                    starters.findIndex((s) => s.body.trim() === draft.body.trim()),
                  );
                  const swap = isAnyStarterBody(draft.body.trim());
                  setDraft({
                    ...draft,
                    providerTypeId: v,
                    body: swap ? autoReplyStartersFor(name)[keepIndex].body : draft.body,
                  });
                  setPreview(null);
                }}
              >
                <SelectTrigger data-testid="select-auto-reply-service">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_SERVICE}>All services</SelectItem>
                  {serviceTypes.map((t: any) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="t-helper mt-1">
                Pick a service to greet egg-donor and surrogacy parents differently.
              </p>
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <p className="t-form-label">Message</p>
              <div className="flex items-center gap-1.5">
                <span className="t-helper">Start from:</span>
                {starters.map((s) => {
                  const active = draft.body.trim() === s.body.trim();
                  return (
                    <button
                      key={s.key}
                      type="button"
                      title={s.hint}
                      onClick={() => applyStarter(s)}
                      className={`text-xs px-2 py-1 rounded-[var(--radius)] transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground"
                      }`}
                      data-testid={`button-starter-${s.key}`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <Textarea
              value={draft.body}
              onChange={(e) => { setDraft({ ...draft, body: e.target.value }); setPreview(null); }}
              rows={9}
              placeholder="Write the message the parent should get the moment they book."
              data-testid="input-auto-reply-body"
            />
            {promisesAttachment && (
              <p className="t-helper mt-1.5 text-[var(--brand-warning,inherit)]" data-testid="auto-reply-attachment-warning">
                This message mentions an attachment but none is added yet - add a file below, or switch to "Message only".
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {TOKENS.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  onClick={() => insertToken(t.token)}
                  title={t.hint}
                  className="text-xs px-2 py-1 rounded-[var(--radius)] bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                  data-testid={`button-token-${t.token.replace(/[{}]/g, "")}`}
                >
                  {t.token}
                </button>
              ))}
            </div>
          </div>

          {/* Attachments */}
          <div>
            <p className="t-form-label mb-1.5">Attachments</p>
            {draft.attachments.length > 0 && (
              <div className="space-y-2 mb-2">
                {draft.attachments.map((f, i) => {
                  const { kind } = getFileTypeMeta(f.originalName, f.mimeType);
                  return (
                    <div
                      key={`${f.url}-${i}`}
                      className="flex items-center gap-3 p-2 rounded-[var(--radius)] bg-secondary"
                      data-testid={`auto-reply-attachment-${i}`}
                    >
                      <FileTypeGlyph name={f.originalName} mimeType={f.mimeType} className="h-8 w-8 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{f.originalName || "Attachment"}</p>
                        <p className="t-helper">
                          {kind}
                          {f.size ? ` - ${formatFileSize(f.size)}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDraft({ ...draft, attachments: draft.attachments.filter((_, j) => j !== i) })
                        }
                        aria-label="Remove attachment"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept=".pdf,.doc,.docx,image/*"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-add-attachment"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4 mr-1.5" />
              )}
              {uploading ? "Uploading..." : "Add file"}
            </Button>
            <p className="t-helper mt-1">PDF, Word or image, up to 16MB each.</p>
          </div>

          {preview !== null && (
            <div className="p-3 rounded-[var(--radius)] bg-accent/15 border border-accent/30" data-testid="auto-reply-preview">
              <p className="t-form-label-sm mb-1">Preview</p>
              <p className="text-sm whitespace-pre-wrap">{preview}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              onClick={() => saveMutation.mutate(draft)}
              disabled={!draft.body.trim() || saveMutation.isPending}
              data-testid="button-save-auto-reply"
            >
              {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Save
            </Button>
            <Button
              variant="outline"
              onClick={() => previewMutation.mutate(draft)}
              disabled={!draft.body.trim() || previewMutation.isPending}
              data-testid="button-preview-auto-reply"
            >
              <Eye className="h-4 w-4 mr-1.5" />
              Preview
            </Button>
            <div className="flex items-center gap-2 ml-auto">
              <span className="t-helper">Active</span>
              <Switch
                checked={draft.isEnabled}
                onCheckedChange={(v) => setDraft({ ...draft, isEnabled: v })}
                data-testid="switch-draft-enabled"
              />
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
