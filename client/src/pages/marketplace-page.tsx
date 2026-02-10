import { useState } from "react";
import { useInventory } from "@/hooks/use-inventory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, Loader2, Heart, Filter } from "lucide-react";

export default function MarketplacePage() {
  const [filterType, setFilterType] = useState<string>("all");
  const { data: inventory, isLoading } = useInventory({
    type: filterType !== "all" ? filterType : undefined
  });

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      {/* Hero Search Section */}
      <div className="bg-primary -mx-4 -mt-4 md:-mx-8 md:-mt-8 lg:-mx-12 lg:-mt-12 p-8 md:p-16 text-center space-y-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&q=80')] bg-cover bg-center opacity-10 mix-blend-overlay" />
        <div className="relative z-10 max-w-2xl mx-auto space-y-6">
          <h1 className="font-display text-4xl md:text-5xl font-bold text-white">
            Find Your Future Family
          </h1>
          <p className="text-primary-foreground/80 text-lg">
            Browse verified profiles from top agencies worldwide.
          </p>
          
          <div className="flex gap-2 p-2 bg-white/10 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/70" />
              <Input 
                className="pl-12 bg-transparent border-none text-white placeholder:text-white/60 h-12 text-lg focus-visible:ring-0" 
                placeholder="Search by traits (e.g., 'Blue eyes')..." 
              />
            </div>
            <Button size="lg" className="h-12 px-8 bg-accent hover:bg-accent/90 text-white font-semibold shadow-lg shadow-accent/20">
              Search
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Filters Sidebar */}
        <div className="w-full md:w-64 space-y-6 shrink-0">
          <div className="bg-card rounded-xl p-6 border border-border/50 shadow-sm sticky top-24">
            <div className="flex items-center gap-2 mb-4 font-semibold text-lg">
              <Filter className="w-5 h-5" /> Filters
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Category</label>
                <div className="space-y-2">
                  {["all", "EGG_DONOR", "SURROGATE", "SPERM_VIAL"].map((type) => (
                    <Button
                      key={type}
                      variant={filterType === type ? "secondary" : "ghost"}
                      onClick={() => setFilterType(type)}
                      className="w-full justify-start capitalize"
                    >
                      {type === "all" ? "View All" : type.replace('_', ' ').toLowerCase()}
                    </Button>
                  ))}
                </div>
              </div>
              
              {/* Placeholder for more filters */}
              <div className="pt-4 border-t border-border/50">
                <label className="text-sm font-medium mb-2 block text-muted-foreground">Attributes</label>
                <div className="text-sm text-muted-foreground italic">
                  Eye color, Hair color, Height filters would go here.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Results Grid */}
        <div className="flex-1">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {inventory?.map((item) => (
              <Card key={item.id} className="group hover:shadow-xl transition-all duration-300 border-border/50 overflow-hidden flex flex-col">
                {/* Image Placeholder */}
                <div className="h-48 bg-secondary/30 relative overflow-hidden">
                  <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/30 font-display text-4xl font-bold opacity-20">
                    {item.type === 'SPERM_VIAL' ? 'VIAL' : 'PHOTO'}
                  </div>
                  <Badge className="absolute top-3 right-3 bg-white/90 text-primary hover:bg-white backdrop-blur shadow-sm">
                    {item.type.replace('_', ' ')}
                  </Badge>
                </div>
                
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-xl font-display font-bold text-primary truncate">
                      {item.name}
                    </CardTitle>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-red-500 hover:bg-red-50 -mr-2 -mt-2">
                      <Heart className="w-5 h-5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                    Provider #{item.providerId}
                  </p>
                </CardHeader>
                
                <CardContent className="space-y-3 flex-1">
                  <div className="flex flex-wrap gap-2">
                    {item.metadata && Object.entries(item.metadata as object).slice(0, 4).map(([key, val]) => (
                      <span key={key} className="inline-flex items-center px-2 py-1 rounded-md bg-secondary/40 border border-secondary text-xs">
                        <span className="opacity-70 mr-1 capitalize">{key}:</span> 
                        <span className="font-medium">{String(val)}</span>
                      </span>
                    ))}
                  </div>
                </CardContent>
                
                <CardFooter className="pt-4 border-t border-border/50">
                  <Button className="w-full bg-primary/5 hover:bg-primary text-primary hover:text-white transition-colors font-semibold">
                    View Profile
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
