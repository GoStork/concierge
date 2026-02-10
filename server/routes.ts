import type { Express } from "express";
import { createServer, type Server } from "http";
import passport from "passport";
import { storage, DatabaseStorage } from "./storage";
import { setupAuth, requireAuth, requireTier, requireRole } from "./auth";
import { api } from "@shared/routes";
import { z } from "zod";
import { userTierEnum, userRoleEnum, providerTypeEnum } from "@shared/schema";

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // Initialize Auth
  const { hashPassword } = setupAuth(app);

  // Initialize Storage with Session Store (if needed, but already handled in db setup)
  // const dbStorage = new DatabaseStorage(sessionStore); 
  // storage is already exported as singleton in storage.ts, but we needed to pass session store there? 
  // Actually, standard pattern in this template is storage.ts exports a singleton.
  // We'll proceed assuming storage is ready.

  // === AUTH ROUTES ===

  app.post(api.auth.login.path, (req, res, next) => {
    passport.authenticate("local", (err: any, user: any) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ message: "Invalid credentials" });
      req.logIn(user, (err) => {
        if (err) return next(err);
        res.json(user);
      });
    })(req, res, next);
  });

  app.post(api.auth.logout.path, (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.json({ message: "Logged out" });
    });
  });

  app.get(api.auth.me.path, (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Not logged in" });
    res.json(req.user);
  });

  // === PROVIDER ROUTES ===

  // List: Public (with filters) or filtered for parents
  app.get(api.providers.list.path, async (req, res) => {
    const type = req.query.type as string | undefined;
    const providers = await storage.getAllProviders(type);
    res.json(providers);
  });

  // Get One
  app.get(api.providers.get.path, async (req, res) => {
    const provider = await storage.getProvider(Number(req.params.id));
    if (!provider) return res.status(404).json({ message: "Provider not found" });
    res.json(provider);
  });

  // Create: Admin Only
  app.post(api.providers.create.path, requireTier(["GOSTORK_ADMIN"]), async (req, res) => {
    try {
      const input = api.providers.create.input.parse(req.body);
      const provider = await storage.createProvider(input);
      res.status(201).json(provider);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  });

  // Update: Admin or The Provider Admin themselves
  app.put(api.providers.update.path, requireAuth, async (req, res) => {
    const user = req.user as any;
    const targetId = Number(req.params.id);

    // Permission Check: Must be GOSTORK_ADMIN or (PROVIDER with matching ID)
    const isSuperAdmin = user.tier === "GOSTORK_ADMIN";
    const isProviderAdmin = user.tier === "PROVIDER" && user.providerId === targetId && user.role === "ADMIN";

    if (!isSuperAdmin && !isProviderAdmin) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const input = api.providers.update.input.parse(req.body);
      const updated = await storage.updateProvider(targetId, input);
      res.json(updated);
    } catch (err) {
        if (err instanceof z.ZodError) return res.status(400).json(err);
        throw err;
    }
  });

  // === USER ROUTES ===

  // Create User (Registration/Admin creation)
  app.post(api.users.create.path, async (req, res) => {
    try {
      const input = api.users.create.input.parse(req.body);
      
      // Check existing
      const existing = await storage.getUserByUsername(input.username);
      if (existing) return res.status(400).json({ message: "Username exists" });

      // Hash password
      const hashedPassword = await hashPassword(input.password);
      
      // Create
      const user = await storage.createUser({ ...input, password: hashedPassword });
      res.status(201).json(user);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json(err);
      throw err;
    }
  });

  // List Users (Admin/Provider)
  app.get(api.users.list.path, requireAuth, async (req, res) => {
    // TODO: Implement user filtering logic based on requester role
    // For now, allow Admins to see all
    if ((req.user as any).tier !== 'GOSTORK_ADMIN') {
        return res.status(403).json({ message: "Only Admins for now" });
    }
    // Mock return empty for now as storage doesn't have getAllUsers yet
    res.json([]); 
  });

  // === INVENTORY ROUTES ===

  app.get(api.inventory.list.path, async (req, res) => {
    const providerId = req.query.providerId ? Number(req.query.providerId) : undefined;
    const type = req.query.type as string | undefined;
    const items = await storage.getInventory(providerId, type);
    res.json(items);
  });

  app.post(api.inventory.create.path, requireAuth, async (req, res) => {
    const user = req.user as any;
    
    try {
      const input = api.inventory.create.input.parse(req.body);

      // Verify ownership
      if (user.tier === "PROVIDER" && user.providerId !== input.providerId) {
        return res.status(403).json({ message: "Cannot create inventory for another provider" });
      }
      if (user.tier === "INTENDED_PARENT") {
        return res.status(403).json({ message: "Parents cannot create inventory" });
      }

      const item = await storage.createInventoryItem(input);
      res.status(201).json(item);
    } catch (err) {
       if (err instanceof z.ZodError) return res.status(400).json(err);
       throw err;
    }
  });

  // === SEED DATA ===
  // Only runs if no providers exist
  const existingProviders = await storage.getAllProviders();
  if (existingProviders.length === 0) {
    console.log("Seeding Database...");
    
    // 1. Create a Clinic
    const clinic = await storage.createProvider({
      name: "Fertility Hope Center",
      type: "CLINIC",
      description: "Leading IVF and Surrogacy Clinic in NY.",
      website: "https://hope.example.com",
      metadata: { successRate: "85%", yearsActive: 20 },
      isActive: true
    });

    // 2. Create an Agency
    const agency = await storage.createProvider({
      name: "Elite Egg Donors",
      type: "EGG_DONOR_AGENCY",
      description: "Premium egg donor matching.",
      isActive: true
    });

    // 3. Create Users
    // Super Admin
    const superAdminPass = await hashPassword("admin123");
    await storage.createUser({
      username: "admin",
      password: superAdminPass,
      tier: "GOSTORK_ADMIN",
      role: "SUPER_ADMIN",
      firstName: "GoStork",
      lastName: "Admin"
    });

    // Provider Admin (Clinic)
    const providerPass = await hashPassword("provider123");
    await storage.createUser({
      username: "clinic_admin",
      password: providerPass,
      tier: "PROVIDER",
      role: "ADMIN",
      providerId: clinic.id,
      firstName: "Dr.",
      lastName: "Smith"
    });

    // Parent
    const parentPass = await hashPassword("parent123");
    await storage.createUser({
      username: "parent",
      password: parentPass,
      tier: "INTENDED_PARENT",
      role: "PRIMARY",
      firstName: "Jane",
      lastName: "Doe"
    });

    // 4. Create Inventory
    await storage.createInventoryItem({
      providerId: clinic.id,
      type: "SURROGATE",
      name: "Surrogate #1042",
      metadata: { age: 29, location: "California", pregnancies: 2 },
      isAvailable: true
    });

    await storage.createInventoryItem({
      providerId: agency.id,
      type: "EGG_DONOR",
      name: "Donor #8821",
      metadata: { hairColor: "Blonde", eyeColor: "Blue", education: "Masters" },
      isAvailable: true
    });
    
    console.log("Seeding Complete.");
  }

  return httpServer;
}
