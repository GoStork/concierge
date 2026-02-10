import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useInventory, useCreateInventory, useUpdateInventory } from "@/hooks/use-inventory";
import { useProviders } from "@/hooks/use-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Search, Loader2, Tag, Edit, Archive } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { insertInventorySchema } from "@shared/schema";

const formSchema = insertInventorySchema;
type FormData = z.infer<typeof formSchema>;

export default function InventoryPage() {
  const { user } = useAuth();
  const [filterType, setFilterType] = useState<string>("all");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);

  // If user is provider, force providerId. If admin, allow seeing all (or select provider).
  const providerId = user?.tier === 'PROVIDER' ? user.providerId : undefined;

  const { data: inventory, isLoading } = useInventory({ 
    providerId: providerId || undefined,
    type: filterType !== "all" ? filterType : undefined
  });
  
  const createMutation = useCreateInventory();
  const updateMutation = useUpdateInventory();

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      type: "EGG_DONOR",
      providerId: providerId || 1, // Default fallback if admin
      isAvailable: true,
      metadata: {},
    },
  });

  const onSubmit = (data: FormData) => {
    if (editingItem) {
      updateMutation.mutate({ id: editingItem.id, ...data }, {
        onSuccess: () => {
          setEditingItem(null);
          setIsCreateOpen(false);
          form.reset();
        }
      });
    } else {
      createMutation.mutate(data, {
        onSuccess: () => {
          setIsCreateOpen(false);
          form.reset();
        }
      });
    }
  };

  const handleEdit = (item: any) => {
    setEditingItem(item);
    form.reset({
      name: item.name,
      type: item.type,
      providerId: item.providerId,
      isAvailable: item.isAvailable,
      metadata: item.metadata,
    });
    setIsCreateOpen(true);
  };

  const handleCreateOpen = () => {
    setEditingItem(null);
    form.reset({
      name: "",
      type: "EGG_DONOR",
      providerId: providerId || 1,
      isAvailable: true,
      metadata: {},
    });
    setIsCreateOpen(true);
  };

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-primary">Inventory Management</h1>
          <p className="text-muted-foreground">Manage your donors, surrogates, and vials.</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button onClick={handleCreateOpen} className="bg-primary hover:bg-primary/90 shadow-lg shadow-primary/25">
              <Plus className="w-4 h-4 mr-2" /> Add New Item
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>{editingItem ? "Edit Item" : "Add Inventory Item"}</DialogTitle>
              <DialogDescription>
                Fill in the details for the new inventory unit.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid gap-4 py-4">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="name" className="text-right">Name/Code</Label>
                  <Input id="name" className="col-span-3" {...form.register("name")} />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="type" className="text-right">Type</Label>
                  <Select 
                    defaultValue={form.getValues("type")} 
                    onValueChange={(val) => form.setValue("type", val)}
                  >
                    <SelectTrigger className="col-span-3">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="EGG_DONOR">Egg Donor</SelectItem>
                      <SelectItem value="SURROGATE">Surrogate</SelectItem>
                      <SelectItem value="SPERM_VIAL">Sperm Vial</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* Simplified Metadata Input for MVP */}
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label className="text-right">Traits (JSON)</Label>
                  <Textarea 
                    className="col-span-3 h-24 font-mono text-xs" 
                    placeholder='{"hairColor": "Brown", "eyeColor": "Blue"}'
                    {...form.register("metadata", {
                      setValueAs: (v) => {
                        try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return {} }
                      }
                    })}
                    defaultValue={JSON.stringify(form.getValues("metadata"), null, 2)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {createMutation.isPending || updateMutation.isPending ? "Saving..." : "Save Item"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex gap-4 items-center pb-4 border-b border-border/50">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search by name or ID..." className="pl-9 bg-white" />
        </div>
        <div className="flex gap-2">
          {["all", "EGG_DONOR", "SURROGATE", "SPERM_VIAL"].map((type) => (
            <Button
              key={type}
              variant={filterType === type ? "default" : "outline"}
              onClick={() => setFilterType(type)}
              size="sm"
              className="capitalize"
            >
              {type.replace('_', ' ').toLowerCase()}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {inventory?.map((item) => (
          <Card key={item.id} className="group hover:shadow-lg transition-all duration-300 border-border/50">
            <CardHeader className="flex flex-row items-start justify-between pb-2">
              <div>
                <Badge variant="secondary" className="mb-2 font-mono text-xs tracking-wider">
                  {item.type.replace('_', ' ')}
                </Badge>
                <CardTitle className="text-lg font-bold text-primary">{item.name}</CardTitle>
              </div>
              <div className={`w-3 h-3 rounded-full ${item.isAvailable ? 'bg-green-500' : 'bg-red-500'}`} />
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-2">
              <div className="flex flex-wrap gap-2">
                {item.metadata && Object.entries(item.metadata as object).slice(0, 3).map(([key, val]) => (
                  <span key={key} className="inline-flex items-center px-2 py-1 rounded-md bg-secondary/50 text-xs">
                    <span className="opacity-70 mr-1 capitalize">{key}:</span> 
                    <span className="font-medium">{String(val)}</span>
                  </span>
                ))}
              </div>
            </CardContent>
            <CardFooter className="pt-2 border-t border-border/50 flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button variant="ghost" size="sm" onClick={() => handleEdit(item)}>
                <Edit className="w-4 h-4 mr-2" /> Edit
              </Button>
            </CardFooter>
          </Card>
        ))}
        
        {inventory?.length === 0 && (
          <div className="col-span-full py-16 text-center text-muted-foreground">
            <div className="w-16 h-16 bg-secondary/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <Tag className="w-8 h-8 opacity-50" />
            </div>
            <p className="text-lg font-medium">No inventory found</p>
            <p className="text-sm">Try adjusting your filters or add a new item.</p>
          </div>
        )}
      </div>
    </div>
  );
}
