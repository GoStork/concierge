import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { format } from "date-fns";
import {
  ArrowLeft,
  Download,
  Trash2,
  Loader2,
  Video,
  FileText,
  Clock,
  User,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { hasProviderRole } from "../../../shared/roles";
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

export default function RecordingPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();

  const isAdmin = user?.roles?.includes("GOSTORK_ADMIN");
  const isProvider = hasProviderRole(user?.roles || []);
  const canDelete = isAdmin || isProvider;

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/video/retry-recording/${bookingId}`);
      return res.json();
    },
    onSuccess: (result: any) => {
      if (result.found) {
        toast({ title: "Recording found - processing started", variant: "success" });
        queryClient.invalidateQueries({ queryKey: ["/api/video/recordings", bookingId] });
      } else {
        toast({ title: "No recording available", description: result.message || "The recording may have expired on Daily.co.", variant: "destructive" });
      }
    },
    onError: () => {
      toast({ title: "Retry failed", description: "Could not check for recordings.", variant: "destructive" });
    },
  });

  const { data, isLoading, error, refetch } = useQuery<{
    booking: {
      id: string;
      scheduledAt: string;
      duration: number;
      subject: string | null;
      consentGiven: boolean;
      actualEndedAt: string | null;
      providerUser: { id: string; name: string; email: string } | null;
      parentUser: { id: string; name: string; email: string } | null;
      parentAccountMembers?: { id: string; name: string | null; email: string }[];
    };
    recordings: Array<{
      id: string;
      bookingId: string;
      status: string;
      duration: number | null;
      fileSize: number | null;
      transcriptText: string | null;
      transcriptStatus: string | null;
      playbackUrl: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
  }>({
    queryKey: ["/api/video/recordings", bookingId],
    queryFn: async () => {
      const res = await fetch(`/api/video/recordings/${bookingId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load recordings");
      return res.json();
    },
    enabled: !!bookingId,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      const hasProcessing = d.recordings.some(
        (r) => r.status === "processing" || r.transcriptStatus === "processing",
      );
      const awaitingRecording = d.recordings.length === 0 && d.booking.consentGiven && d.booking.actualEndedAt;
      if (awaitingRecording) {
        const endedAgo = Date.now() - new Date(d.booking.actualEndedAt!).getTime();
        if (endedAgo > 30 * 60 * 1000) return false;
      }
      return hasProcessing || awaitingRecording ? 5000 : false;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (recordingId: string) => {
      await apiRequest("DELETE", `/api/video/recordings/${recordingId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/video/recordings", bookingId],
      });
      toast({ title: "Recording deleted", variant: "success" });
    },
    onError: () => {
      toast({
        title: "Failed to delete recording",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 mb-4"
          onClick={() => navigate(-1)}
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <AlertCircle className="w-10 h-10 text-muted-foreground mb-3" />
          <h2 className="text-lg font-heading">Unable to load recordings</h2>
          <p className="text-sm text-muted-foreground mt-1">
            The recording may not exist or you may not have access.
          </p>
        </div>
      </div>
    );
  }

  const { booking, recordings } = data;
  const scheduledDate = new Date(booking.scheduledAt);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1 mb-6"
        onClick={() => navigate(-1)}
        data-testid="button-back"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </Button>

      <div className="mb-8">
        <h1 className="text-2xl font-heading" data-testid="text-page-title">
          Recording & Transcript
        </h1>
        <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Clock className="w-4 h-4" />
            <span data-testid="text-booking-date">
              {format(scheduledDate, "EEEE, MMMM d, yyyy")} at{" "}
              {format(scheduledDate, "h:mm a")}
            </span>
            <span>({booking.duration} min)</span>
          </div>
          {booking.providerUser && (
            <div className="flex items-center gap-1.5">
              <User className="w-4 h-4" />
              <span data-testid="text-provider-name">
                {booking.providerUser.name}
              </span>
            </div>
          )}
          {booking.parentAccountMembers && booking.parentAccountMembers.length > 0 ? (
            booking.parentAccountMembers.map((m) => (
              <div key={m.id} className="flex items-center gap-1.5">
                <User className="w-4 h-4" />
                <span data-testid={`text-parent-name-${m.id}`}>
                  {m.name || m.email}
                </span>
              </div>
            ))
          ) : booking.parentUser ? (
            <div className="flex items-center gap-1.5">
              <User className="w-4 h-4" />
              <span data-testid="text-parent-name">
                {booking.parentUser.name}
              </span>
            </div>
          ) : null}
        </div>
        {booking.subject && (
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-booking-subject">
            {booking.subject}
          </p>
        )}
      </div>

      {recordings.length === 0 && (() => {
        const callEnded = !!booking.actualEndedAt;
        const consented = !!booking.consentGiven;
        const endedAgo = callEnded ? Date.now() - new Date(booking.actualEndedAt!).getTime() : 0;
        const isStale = callEnded && consented && endedAgo > 30 * 60 * 1000;

        if (!consented) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-center border rounded-[var(--radius)] bg-secondary/20">
              <Video className="w-10 h-10 text-muted-foreground mb-3" />
              <h2 className="text-lg font-heading" data-testid="text-no-recording">No recording for this call</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Recording consent was not given for this consultation.
              </p>
            </div>
          );
        }

        if (isStale) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-center border rounded-[var(--radius)] bg-secondary/20" data-testid="recording-unavailable">
              <AlertCircle className="w-10 h-10 text-muted-foreground mb-3" />
              <h2 className="text-lg font-heading" data-testid="text-recording-unavailable">Recording Unavailable</h2>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                We weren't able to process the recording for this call. This can happen if there was a connection issue during processing.
                Recordings from future calls will be captured automatically.
              </p>
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 mt-4"
                  onClick={() => retryMutation.mutate()}
                  disabled={retryMutation.isPending}
                  data-testid="button-retry-recording"
                >
                  {retryMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Retry Processing
                </Button>
              )}
            </div>
          );
        }

        const steps = [
          { label: "Call Ended", done: callEnded },
          { label: "Uploading Recording", done: false },
          { label: "Transcribing", done: false },
          { label: "Ready", done: false },
        ];
        const activeStep = callEnded && consented ? 1 : 0;

        return (
          <div className="border rounded-[var(--radius)] p-6" data-testid="recording-progress">
            <div className="flex items-center gap-2 mb-6">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <p className="text-sm font-ui">Processing your recording...</p>
            </div>
            <div className="flex items-center gap-0 mb-3">
              {steps.map((step, i) => {
                const isActive = i === activeStep;
                const isDone = i < activeStep || step.done;
                return (
                  <div key={step.label} className="flex-1 flex items-center">
                    <div className="flex flex-col items-center flex-1">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-ui border-2 transition-all ${
                        isDone ? "bg-primary border-primary text-primary-foreground" :
                        isActive ? "border-primary text-primary bg-primary/10 animate-pulse" :
                        "border-muted-foreground/30 text-muted-foreground/50 bg-muted/30"
                      }`} data-testid={`step-circle-${i}`}>
                        {isDone ? "✓" : i + 1}
                      </div>
                      <span className={`text-[11px] mt-1.5 text-center leading-tight ${
                        isDone ? "text-primary font-ui" :
                        isActive ? "text-foreground font-ui" :
                        "text-muted-foreground/60"
                      }`}>{step.label}</span>
                    </div>
                    {i < steps.length - 1 && (
                      <div className={`h-0.5 flex-1 -mt-4 mx-1 rounded ${
                        isDone ? "bg-primary" : "bg-muted-foreground/15"
                      }`} />
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground text-center mt-4">
              This page updates automatically - your recording will appear here once processing is complete.
            </p>
          </div>
        );
      })()}

      {recordings.map((recording) => {
        const steps = [
          { label: "Call Ended", done: true },
          { label: "Uploading", done: recording.status === "ready" || recording.status === "failed" },
          { label: "Transcribing", done: recording.transcriptStatus === "ready" || recording.transcriptStatus === "failed" || recording.transcriptStatus === "none" },
          { label: "Ready", done: recording.status === "ready" && (recording.transcriptStatus === "ready" || recording.transcriptStatus === "failed" || recording.transcriptStatus === "none") },
        ];
        const activeStep = steps.findIndex(s => !s.done);
        const allDone = steps.every(s => s.done);
        const hasFailed = recording.status === "failed";

        return (
        <Card
          key={recording.id}
          className="overflow-hidden mb-6"
          data-testid={`recording-card-${recording.id}`}
        >
          {!allDone && !hasFailed && (
            <div className="p-4 bg-secondary/20 border-b" data-testid="recording-progress-bar">
              <div className="flex items-center gap-2 mb-4">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <p className="text-sm font-ui">Processing your recording...</p>
              </div>
              <div className="flex items-center gap-0">
                {steps.map((step, i) => {
                  const isActive = i === activeStep;
                  const isDone = step.done;
                  return (
                    <div key={step.label} className="flex-1 flex items-center">
                      <div className="flex flex-col items-center flex-1">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-ui border-2 transition-all ${
                          isDone ? "bg-primary border-primary text-primary-foreground" :
                          isActive ? "border-primary text-primary bg-primary/10 animate-pulse" :
                          "border-muted-foreground/30 text-muted-foreground/50 bg-muted/30"
                        }`}>
                          {isDone ? "✓" : i + 1}
                        </div>
                        <span className={`text-[10px] mt-1 text-center leading-tight ${
                          isDone ? "text-primary font-ui" :
                          isActive ? "text-foreground font-ui" :
                          "text-muted-foreground/60"
                        }`}>{step.label}</span>
                      </div>
                      {i < steps.length - 1 && (
                        <div className={`h-0.5 flex-1 -mt-4 mx-1 rounded ${
                          isDone ? "bg-primary" : "bg-muted-foreground/15"
                        }`} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {recording.status === "processing" && (
            <div className="flex items-center gap-3 p-4 bg-secondary/10">
              <div>
                <p className="text-sm text-muted-foreground">
                  The recording is being uploaded and will be available shortly.
                </p>
              </div>
            </div>
          )}

          {recording.status === "failed" && (
            <div className="flex items-center gap-3 p-6 bg-destructive/10">
              <AlertCircle className="w-5 h-5 text-destructive" />
              <div>
                <p className="font-ui text-destructive">
                  Recording processing failed
                </p>
                <p className="text-sm text-destructive">
                  There was an error processing this recording.
                </p>
              </div>
            </div>
          )}

          {recording.status === "ready" && recording.playbackUrl && (
            <div className="bg-black">
              <video
                controls
                className="w-full max-h-[500px]"
                src={recording.playbackUrl}
                data-testid="video-player"
              >
                Your browser does not support video playback.
              </video>
            </div>
          )}

          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                {recording.duration && (
                  <span data-testid="text-recording-duration">
                    {Math.floor(recording.duration / 60)}m{" "}
                    {recording.duration % 60}s
                  </span>
                )}
                {recording.fileSize && (
                  <span data-testid="text-recording-size">
                    {(recording.fileSize / (1024 * 1024)).toFixed(1)} MB
                  </span>
                )}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-ui ${
                    recording.status === "ready"
                      ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]"
                      : recording.status === "processing"
                        ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]"
                        : "bg-destructive/15 text-destructive"
                  }`}
                  data-testid="badge-recording-status"
                >
                  {recording.status}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {recording.status === "ready" && recording.playbackUrl && (
                  <a
                    href={recording.playbackUrl}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      data-testid="button-download-recording"
                    >
                      <Download className="w-4 h-4" /> Download
                    </Button>
                  </a>
                )}

                {canDelete && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1 text-destructive"
                        disabled={deleteMutation.isPending}
                        data-testid="button-delete-recording"
                      >
                        <Trash2 className="w-4 h-4" /> Delete
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Recording</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete the recording and its
                          transcript. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => deleteMutation.mutate(recording.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          data-testid="button-confirm-delete"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>

            {recording.transcriptStatus === "processing" && (
              <div className="flex items-center gap-2 p-3 bg-secondary/30 rounded-[var(--radius)]">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Transcribing recording...
                </span>
              </div>
            )}

            {recording.transcriptStatus === "failed" && (
              <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-[var(--radius)]">
                <AlertCircle className="w-4 h-4 text-destructive" />
                <span className="text-sm text-destructive">
                  Transcription failed
                </span>
                <button
                  data-testid="button-retry-transcription"
                  className="ml-auto text-sm text-primary underline hover:no-underline"
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/video/retry-transcription/${recording.id}`, {
                        method: "POST",
                        credentials: "include",
                      });
                      if (res.ok) {
                        queryClient.invalidateQueries({ queryKey: ["/api/video/recordings", bookingId] });
                      }
                    } catch {}
                  }}
                >
                  Retry
                </button>
              </div>
            )}

            {recording.transcriptStatus === "ready" &&
              recording.transcriptText && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <h3 className="text-sm font-ui">Transcript</h3>
                  </div>
                  <div
                    className="bg-secondary/30 rounded-[var(--radius)] p-4"
                    data-testid="transcript-content"
                  >
                    <pre className="text-sm whitespace-pre-wrap font-sans leading-body">
                      {recording.transcriptText}
                    </pre>
                  </div>
                </div>
              )}
          </div>
        </Card>
      );
      })}
    </div>
  );
}
