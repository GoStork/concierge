import { pgTable, text, serial, integer, boolean, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === ENUMS ===
export const userTierEnum = pgEnum("user_tier", [
  "GOSTORK_ADMIN",
  "PROVIDER",
  "INTENDED_PARENT",
]);

export const userRoleEnum = pgEnum("user_role", [
  "SUPER_ADMIN",            // GOSTORK_ADMIN
  "ADMIN",                  // PROVIDER Admin
  "EGG_DONOR_COORDINATOR",  // PROVIDER Sub-role
  "SURROGACY_COORDINATOR",  // PROVIDER Sub-role
  "SPERM_COORDINATOR",      // PROVIDER Sub-role
  "CLINIC_COORDINATOR",     // PROVIDER Sub-role
  "PRIMARY",                // INTENDED_PARENT
  "PARTNER"                 // INTENDED_PARENT
]);

export const providerTypeEnum = pgEnum("provider_type", [
  "CLINIC",
  "EGG_DONOR_AGENCY",
  "SURROGACY_AGENCY",
  "EGG_BANK",
  "SPERM_BANK",
  "LEGAL_SERVICES"
]);

// === TABLE DEFINITIONS ===

export const providers = pgTable("providers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: providerTypeEnum("type").notNull(),
  description: text("description"),
  website: text("website"),
  logoUrl: text("logo_url"),
  isActive: boolean("is_active").default(true).notNull(),
  // Future-proof metadata: success rates, fees, vial availability, etc.
  metadata: jsonb("metadata").$type<Record<string, any>>().default({}), 
  createdAt: timestamp("created_at").defaultNow(),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  tier: userTierEnum("tier").notNull(),
  role: userRoleEnum("role").notNull(),
  providerId: integer("provider_id").references(() => providers.id), // Null for GOSTORK_ADMIN and INTENDED_PARENT (unless linked)
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const inventory = pgTable("inventory", {
  id: serial("id").primaryKey(),
  providerId: integer("provider_id").references(() => providers.id).notNull(),
  // E.g., 'EGG_DONOR', 'SURROGATE', 'SPERM_VIAL' - could be another enum, using text for flexibility as requested
  type: text("type").notNull(), 
  name: text("name").notNull(), // or Code/ID
  // Flexible attributes: traits, pricing, medical history, photos array
  metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
  isAvailable: boolean("is_available").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// === RELATIONS ===

export const providersRelations = relations(providers, ({ many }) => ({
  users: many(users),
  inventory: many(inventory),
}));

export const usersRelations = relations(users, ({ one }) => ({
  provider: one(providers, {
    fields: [users.providerId],
    references: [providers.id],
  }),
}));

export const inventoryRelations = relations(inventory, ({ one }) => ({
  provider: one(providers, {
    fields: [inventory.providerId],
    references: [providers.id],
  }),
}));

// === ZOD SCHEMAS ===

export const insertProviderSchema = createInsertSchema(providers).omit({ id: true, createdAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertInventorySchema = createInsertSchema(inventory).omit({ id: true, createdAt: true });

// === EXPLICIT TYPES ===

export type Provider = typeof providers.$inferSelect;
export type InsertProvider = z.infer<typeof insertProviderSchema>;

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type InventoryItem = typeof inventory.$inferSelect;
export type InsertInventoryItem = z.infer<typeof insertInventorySchema>;

// API Payloads
export type CreateProviderRequest = InsertProvider;
export type UpdateProviderRequest = Partial<InsertProvider>;

// User creation usually requires confirmation of password, done in route handler, but schema is same
export type CreateUserRequest = InsertUser; 
export type UpdateUserRequest = Partial<InsertUser>;

export type CreateInventoryRequest = InsertInventoryItem;
export type UpdateInventoryRequest = Partial<InsertInventoryItem>;
