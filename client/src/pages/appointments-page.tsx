import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, Calendar, Clock, Video, User, Check, X, RefreshCw, CalendarDays
} from "lucide-react";
import { format, isPast } from "date-fns";

const VALID_TABS = ["upcoming", "past"] as const;
type AppointmentTab = typeof VALID_TABS[number];

export default function AppointmentsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cancelBookingId, setCancelBookingId] = useState<string | null>(null);
  const activeTab: AppointmentTab = VALID_TABS.includes(searchParams.get("tab") as AppointmentTab) ? (searchParams.get("tab") as AppointmentTab) : "upcoming";
  const setActiveTab = (tab: AppointmentTab) => setSearchParams({ tab }, { replace: true });

  const { data: bookings, isLoading } = useQuery({
    queryKey: ["/api/calendar/bookings"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/bookings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("PATCH", `/api/calendar/bookings/${id}`, { status: "CANCELLED" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      setCancelBookingId(null);
      toast({ title: "Booking cancelled", variant: "success" });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/calendar/bookings/${id}/confirm`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting confirmed", description: "The parent has been notified.", variant: "success" });
    },
  });

  const declineMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/calendar/bookings/${id}/decline`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting declined", description: "The parent has been notified.", variant: "success" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const now = new Date();
  const allBookings = bookings || [];
  const upcoming = allBookings.filter((b: any) => new Date(b.scheduledAt) >= now && b.status !== "CANCELLED" && b.status !== "RESCHEDULED");
  const past = allBookings.filter((b: any) => new Date(b.scheduledAt) < now || b.status === "CANCELLED" || b.status === "RESCHEDULED");

  const displayBookings = activeTab === "upcoming" ? upcoming : past;

  return (
    <div className="w-full space-y-6">
      <h1 className="text-3xl font-display font-heading text-primary" data-testid="text-appointments-title">My Appointments</h1>

      <div className="flex gap-2">
        <Button
          variant={activeTab === "upcoming" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveTab("upcoming")}
          data-testid="button-tab-upcoming"
        >
          Upcoming ({upcoming.length})
        </Button>
        <Button
          variant={activeTab === "past" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveTab("past")}
          data-testid="button-tab-past"
        >
          Past ({past.length})
        </Button>
      </div>

      {displayBookings.length === 0 ? (
        <div className="bg-card rounded-xl border border-border/50 shadow-sm p-12 text-center">
          <CalendarDays className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-muted-foreground">
            {activeTab === "upcoming" ? "No upcoming appointments." : "No past appointments."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {displayBookings.map((booking: any) => {
            const start = new Date(booking.scheduledAt);
            const isUpcoming = start >= now && booking.status !== "CANCELLED" && booking.status !== "RESCHEDULED";
            const otherParty = booking.providerUserId === user?.id ? booking.parentUser : booking.providerUser;
            const otherPhotoSrc = otherParty?.photoUrl
              ? otherParty.photoUrl.startsWith("/uploads")
                ? otherParty.photoUrl
                : `/api/uploads/proxy?url=${encodeURIComponent(otherParty.photoUrl)}`
              : null;

            return (
              <div
                key={booking.id}
                className="bg-card rounded-xl border border-border/50 shadow-sm p-5 flex items-start gap-4"
                data-testid={`appointment-${booking.id}`}
              >
                <div className="shrink-0">
                  {otherPhotoSrc ? (
                    <img src={otherPhotoSrc} alt="" className="w-12 h-12 rounded-full object-cover" />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                      <User className="w-6 h-6" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-ui text-sm">{booking.subject || booking.attendeeName || otherParty?.name || "Appointment"}</h3>
                      <p className="text-xs text-muted-foreground">
                        with {otherParty?.name || booking.attendeeName || booking.attendeeEmails?.[0] || "Unknown"}
                      </p>
                    </div>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-ui shrink-0 ${
                      booking.status === "CONFIRMED" ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]" :
                      booking.status === "CANCELLED" ? "bg-destructive/15 text-destructive" :
                      booking.status === "PENDING" ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]" :
                      booking.status === "RESCHEDULED" ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]" :
                      "bg-muted text-foreground"
                    }`}>
                      {booking.status === "PENDING" ? "Awaiting Confirmation" : booking.status}
                    </span>
                  </div>

                  <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" />
                      {format(start, "MMM d, yyyy")}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {format(start, "h:mm a")} ({booking.duration} min)
                    </span>
                  </div>

                  {booking.meetingUrl && isUpcoming && (
                    <a href={booking.meetingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 text-sm text-primary hover:underline" data-testid={`link-meeting-${booking.id}`}>
                      <Video className="w-3.5 h-3.5" /> Join Meeting
                    </a>
                  )}
                  {booking.status === "CONFIRMED" && isUpcoming && booking.providerUser?.dailyRoomUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 gap-1.5 text-primary border-primary/30 hover:bg-primary/5"
                      onClick={() => navigate(`/room/${booking.id}`)}
                      data-testid={`button-join-video-${booking.id}`}
                    >
                      <Video className="w-3.5 h-3.5" /> {booking.providerUserId === user?.id ? "Start" : "Join"} Video Call
                    </Button>
                  )}
                </div>

                {isUpcoming && (
                  <div className="shrink-0 flex gap-1">
                    {booking.status === "PENDING" && booking.providerUserId === user?.id && (
                      <>
                        <Button variant="ghost" size="sm" className="text-[hsl(var(--brand-success))] hover:text-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success)/0.08)] h-8 gap-1" onClick={() => confirmMutation.mutate(booking.id)} disabled={confirmMutation.isPending} data-testid={`button-confirm-${booking.id}`}>
                          <Check className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10 h-8 gap-1" onClick={() => declineMutation.mutate(booking.id)} disabled={declineMutation.isPending} data-testid={`button-decline-${booking.id}`}>
                          <X className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                    {booking.status !== "PENDING" && (
                      <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive h-8" onClick={() => setCancelBookingId(booking.id)} data-testid={`button-cancel-${booking.id}`}>
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!cancelBookingId} onOpenChange={(o) => { if (!o) setCancelBookingId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Appointment</DialogTitle>
            <DialogDescription>Are you sure you want to cancel this appointment?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelBookingId(null)}>Keep</Button>
            <Button variant="destructive" onClick={() => cancelBookingId && cancelMutation.mutate(cancelBookingId)} disabled={cancelMutation.isPending} data-testid="button-confirm-cancel-appt">
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Appointment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
