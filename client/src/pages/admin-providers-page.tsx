import { useState } from "react";
import { useProviders, useCreateProvider } from "@/hooks/use-providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Building2, Loader2, Globe } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertProviderSchema, type InsertProvider } from "@shared/schema";

export default function AdminProvidersPage() {
  const { data: providers, isLoading } = useProviders();
  const createMutation = useCreateProvider();
  const [isOpen, setIsOpen] = useState(false);

  const form = useForm<InsertProvider>({
    resolver: zodResolver(insertProviderSchema),
    defaultValues: {
      name: "",
      type: "CLINIC",
      description: "",
      website: "",
      isActive: true,
      metadata: {},
    }
  });

  const onSubmit = (data: InsertProvider) => {
    createMutation.mutate(data, {
      onSuccess: () => {
        setIsOpen(false);
        form.reset();
      }
    });
  };

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold text-primary">Providers</h1>
          <p className="text-muted-foreground">Manage clinics, agencies, and banks.</p>
        </div>
        
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 shadow-lg shadow-primary/25">
              <Plus className="w-4 h-4 mr-2" /> Add Provider
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Provider</DialogTitle>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label>Provider Name</Label>
                <Input {...form.register("name")} placeholder="e.g. Hope Fertility Center" />
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select onValueChange={(val) => form.setValue("type", val as any)} defaultValue="CLINIC">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CLINIC">Clinic</SelectItem>
                    <SelectItem value="EGG_DONOR_AGENCY">Egg Donor Agency</SelectItem>
                    <SelectItem value="SURROGACY_AGENCY">Surrogacy Agency</SelectItem>
                    <SelectItem value="EGG_BANK">Egg Bank</SelectItem>
                    <SelectItem value="SPERM_BANK">Sperm Bank</SelectItem>
                    <SelectItem value="LEGAL_SERVICES">Legal Services</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Website</Label>
                <Input {...form.register("website")} placeholder="https://..." />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating..." : "Create Provider"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="bg-card rounded-xl border border-border/50 shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/30">
            <TableRow>
              <TableHead className="w-[300px]">Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Website</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers?.map((provider) => (
              <TableRow key={provider.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                      <Building2 className="w-4 h-4" />
                    </div>
                    {provider.name}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-xs">
                    {provider.type.replace(/_/g, " ")}
                  </Badge>
                </TableCell>
                <TableCell>
                  {provider.website ? (
                    <a href={provider.website} target="_blank" rel="noreferrer" className="text-sm text-blue-500 hover:underline flex items-center gap-1">
                      <Globe className="w-3 h-3" /> Visit
                    </a>
                  ) : (
                    <span className="text-muted-foreground text-sm">-</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge className={provider.isActive ? "bg-green-500/10 text-green-700 border-green-200" : "bg-red-500/10 text-red-700 border-red-200"}>
                    {provider.isActive ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm">Edit</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
