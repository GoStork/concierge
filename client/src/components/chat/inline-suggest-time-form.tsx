import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Check } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface InlineSuggestTimeFormProps {
  bookingId: string;
  onCancel: () => void;
  onSuccess: () => void;
}

export function InlineSuggestTimeForm({ bookingId, onCancel, onSuccess }: InlineSuggestTimeFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [suggestDate, setSuggestDate] = useState("");
  const [suggestTime, setSuggestTime] = useState("10:00");
  const [message, setMessage] = useState("");

  const suggestMutation = useMutation({
    mutationFn: async () => {
      if (!suggestDate || !suggestTime) throw new Error("Please select a date and time");
      await apiRequest("POST", `/api/calendar/bookings/${bookingId}/suggest-time`, {
        scheduledAt: new Date(`${suggestDate}T${suggestTime}:00`).toISOString(),
        message: message || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "New time suggested", description: "The parent has been notified.", variant: "success" as any });
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-2 pt-1">
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={suggestDate} onChange={(e) => setSuggestDate(e.target.value)} data-testid="input-suggest-date-inline" className="h-8 text-xs" />
        <Input type="time" value={suggestTime} onChange={(e) => setSuggestTime(e.target.value)} data-testid="input-suggest-time-inline" className="h-8 text-xs" />
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Add a message (optional)"
        className="w-full text-xs rounded-[var(--radius)] border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        data-testid="input-suggest-message-inline"
      />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-7 text-xs gap-1" onClick={() => suggestMutation.mutate()} disabled={suggestMutation.isPending || !suggestDate} data-testid="button-send-suggestion-inline">
          {suggestMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Send
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
